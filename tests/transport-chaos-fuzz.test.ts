// Seeded transport chaos: the exactly-once gate.
//
// Sibling of proxy-differential — same idea, different surface. Instead of
// checking one known sequence, it generates thousands of interleavings of the
// things a network actually does (a frame is dropped, a socket dies mid-write,
// a reconnect flushes a queue, an ack never comes back) and holds the client
// to four invariants that must survive all of them:
//
//   I1 every promise settles — no call may hang forever
//   I2 resolved ⊆ applied — a resolve means the server really ran it
//   I3 no double-apply — one user intent is applied at most once
//   I4 a rejection is FINAL — nothing may be applied after its caller was
//      told it failed
//
// I4 is the one that caught the shipped bug: `rejectAll` on disconnect settled
// calls whose frames were still sitting in the transport's own offline queue,
// and that queue survived the close and flushed on the next open. One intent →
// one rejection → one application. The chaos loop reproduces it in a handful
// of rounds; a fixed test had to know to look.
import { assert, assertEquals } from "@std/assert";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { connectCli } from "../src/server/cli-client.ts";
import { cell } from "../src/state/cell-create.ts";
import type { CellDef } from "../src/state/cell-types.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import {
  FakeWS,
  fastBackoff,
  installFakeWS,
  tick,
  track,
  type Tracked,
  waitFor,
} from "./fake-ws.ts";

// Fixed by default so CI is reproducible from its own commit; FUZZ_SEED /
// FUZZ_ROUNDS let a sweep explore past it (see proxy-differential).
const SEED = fuzzEnvInt("FUZZ_SEED", 0x0acc0de) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 24, 1);
const STEPS = fuzzEnvInt("FUZZ_STEPS", 40, 4);

type Call = { cid: string; t: Tracked };

Deno.test({
  name: "chaos: one intent, one outcome — under drop / kill / reconnect",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    let seed = SEED;
    const rnd = () =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const chance = (p: number) => rnd() < p;

    for (let round = 0; round < ROUNDS; round++) {
      const restoreWS = installFakeWS();
      const restoreT = fastBackoff();
      const log: string[] = [];
      let clock = 0;
      const now = () => ++clock;

      // The server model. `applied` counts how many times each intent was
      // executed; `appliedAt` is when the FIRST execution happened.
      const applied = new Map<string, number>();
      const appliedAt = new Map<string, number>();
      const consumed = new WeakMap<FakeWS, number>();

      const cli = connectCli<{ n: number }>("http://localhost:1/x", {
        ackTimeoutMs: 0, // no ceiling: this suite is about settlement, not timeouts
      });
      const name = `chaos_${round}`;
      const box = cell(name, {
        state: { n: 0 },
        methods: {
          bump(s: { n: number }, by = 1) {
            s.n += by;
          },
        },
      }) as unknown as CellDef & { bump: (by?: number) => Promise<unknown> };
      cli.bind(box);
      const calls: Call[] = [];

      /** Drain what the live socket has written: apply, ack, or lose it. */
      const serve = (ws: FakeWS) => {
        const from = consumed.get(ws) ?? 0;
        for (let i = from; i < ws.sent.length; i++) {
          const f = dec(ws.sent[i]!);
          if (f?.t !== "action") continue;
          const d = f.d as { cid?: string };
          if (!d.cid) continue;
          if (chance(0.12)) {
            log.push(`drop ${d.cid.slice(0, 4)}`);
            continue; // the frame never reached the server
          }
          applied.set(d.cid, (applied.get(d.cid) ?? 0) + 1);
          if (!appliedAt.has(d.cid)) appliedAt.set(d.cid, now());
          log.push(`apply ${d.cid.slice(0, 4)}`);
          if (chance(0.75) && ws.readyState === FakeWS.OPEN) {
            ws.deliver(enc("ack", { cid: d.cid, ok: true, value: 1 }));
          } // else: applied, but the ack is lost
        }
        consumed.set(ws, ws.sent.length);
      };

      try {
        for (let step = 0; step < STEPS; step++) {
          const ws = FakeWS.live[FakeWS.live.length - 1];
          if (ws && ws.readyState === FakeWS.CONNECTING) {
            if (chance(0.6)) {
              ws.open();
              log.push("open");
            } else if (chance(0.5)) {
              // A connect attempt that never establishes (server still down).
              // This is the interleaving that exposes the shipped bug: the
              // close fires while the queue is NON-empty, so a client that
              // rejects everything pending settles calls it is about to send.
              ws.close();
              log.push("failed-connect");
            }
          }
          if (ws && ws.readyState === FakeWS.OPEN) serve(ws);
          if (chance(0.45)) {
            const cid = `call${calls.length}`;
            calls.push({ cid, t: track(box.bump(1), now) });
            log.push(`call ${calls.length - 1}`);
          }
          if (ws && ws.readyState === FakeWS.OPEN && chance(0.3)) {
            ws.close();
            log.push("kill");
          }
          await tick(2);
        }

        // Calm down: let the client reconnect and drain everything it still
        // holds, so I1 is about hangs and not about the test giving up early.
        for (let i = 0; i < 60; i++) {
          const ws = FakeWS.live[FakeWS.live.length - 1];
          if (ws && ws.readyState === FakeWS.CONNECTING) ws.open();
          if (ws && ws.readyState === FakeWS.OPEN) {
            const from = consumed.get(ws) ?? 0;
            for (let j = from; j < ws.sent.length; j++) {
              const f = dec(ws.sent[j]!);
              if (f?.t !== "action") continue;
              const d = f.d as { cid?: string };
              if (!d.cid) continue;
              applied.set(d.cid, (applied.get(d.cid) ?? 0) + 1);
              if (!appliedAt.has(d.cid)) appliedAt.set(d.cid, now());
              ws.deliver(enc("ack", { cid: d.cid, ok: true, value: 1 }));
            }
            consumed.set(ws, ws.sent.length);
          }
          if (calls.every((c) => c.t.done)) break;
          await tick(5);
        }
        // Anything still outstanding is settled by close() — which is honest
        // only because close() also throws the queue away.
        cli.close();
        await tick(20);

        const repro = `FUZZ_SEED=${SEED} round ${round}: ${log.join(" · ")}`;

        // I1 — every promise settles.
        for (const [i, c] of calls.entries()) {
          assert(c.t.done, `call ${i} never settled — ${repro}`);
        }
        // The client owns the cids, so recover them from the wire. Frames go
        // out in call order (the queue is FIFO), and a call is written at most
        // once, so wireCids[i] belongs to calls[i]; any tail beyond
        // wireCids.length are the calls close() discarded unsent.
        const wireCids = FakeWS.live
          .flatMap((w) => w.sent)
          .map((l) => dec(l))
          .filter((f) => f?.t === "action")
          .map((f) => (f!.d as { cid: string }).cid);
        assertEquals(
          new Set(wireCids).size,
          wireCids.length,
          `the same intent was written to the wire twice — ${repro}`,
        );
        assert(
          wireCids.length <= calls.length,
          `more frames than intents — ${repro}`,
        );
        // I3 — one intent, at most one application.
        for (const [cid, n] of applied) {
          assert(n <= 1, `I3: cid ${cid} applied ${n}× — ${repro}`);
        }
        for (const [i, c] of calls.entries()) {
          const cid = wireCids[i];
          if (cid === undefined) {
            assert(
              !c.t.ok,
              `I2: call ${i} resolved without ever reaching the wire — ${repro}`,
            );
            continue;
          }
          if (c.t.ok) {
            // I2 — a resolve means the server really ran it.
            assertEquals(
              applied.get(cid) ?? 0,
              1,
              `I2: resolved a call the server never applied — ${repro}`,
            );
          } else if (appliedAt.has(cid)) {
            // I4 — a rejection is final: nothing may be applied after it.
            assert(
              appliedAt.get(cid)! < c.t.at,
              `I4: cid ${cid} was applied AFTER its caller was told it ` +
                `failed — one intent, a rejection AND an application — ${repro}`,
            );
          }
        }
      } finally {
        try {
          cli.close();
        } catch { /* already closed */ }
        restoreT();
        restoreWS();
      }
    }
  },
});
