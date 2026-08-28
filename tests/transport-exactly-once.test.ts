// Exactly-once, as a promise contract: ONE user intent produces ONE outcome.
//
// The defect this file exists to make unshippable: a queued action was
// REJECTED to its caller by a disconnect, and then DELIVERED anyway by the
// very queue that survived that disconnect. All three clients did it (browser
// AIR transport, connectCli, connectCliUDS), and the rejection text even
// promised "the action is not resent automatically" — so an app that did what
// the message invited (retry) had its single intent applied twice.
//
// The rule, now enforced by the shared ack registry: a call may only be
// settled by something that is TRUE OF ITS FRAME.
//   • frame written, connection lost  → reject (fate genuinely unknown)
//   • frame still queued, connection lost → keep waiting (the queue flushes)
//   • frame discarded (close/teardown/protocol gap) → reject, and say so
//   • the ack clock starts at the WRITE, never at dispatch
//
// Sockets here are fakes so the sequencing is exact rather than raced; the
// client code under test is the real one.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { connectCli, connectCliUDS } from "../src/server/cli-client.ts";
import { cell } from "../src/state/cell-create.ts";
import type { CellDef } from "../src/state/cell-types.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import {
  FakeWS,
  fastBackoff,
  installFakeWS,
  tick,
  track,
  waitFor,
} from "./fake-ws.ts";

let _n = 0;
function counterCell() {
  const name = `xo_${_n++}`;
  const def = cell(name, {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }, by = 1) {
        s.n += by;
      },
    },
  });
  return def as unknown as CellDef & {
    bump: (by?: number) => Promise<unknown>;
  };
}

// ── connectCli (WS) ──────────────────────────────────────────────────

Deno.test({
  name:
    "exactly-once (WS): a disconnect does NOT reject an action still in the queue",
  async fn() {
    const restoreWS = installFakeWS();
    const restoreT = fastBackoff();
    const cli = connectCli<{ n: number }>("http://localhost:1/x");
    const box = counterCell();
    try {
      const s1 = await waitFor(() => FakeWS.live[0], "first socket");
      s1.open();
      s1.close(); // down before the call — the action can only queue

      cli.bind(box);
      const call = track(box.bump(1));
      await tick(20);
      assertEquals(call.done, false, "a queued call must not settle yet");

      // A second disconnect while it waits: the queue survives BOTH.
      const s2 = await waitFor(() => FakeWS.live[1], "reconnect socket");
      s2.close();
      await tick(20);
      assertEquals(
        call.done,
        false,
        "the disconnect rejected a call whose frame it never carried — " +
          "the queue then sends it anyway (one intent, two outcomes)",
      );

      const s3 = await waitFor(() => FakeWS.live[2], "second reconnect");
      s3.open();
      const written = s3.actions();
      assertEquals(written.length, 1, "the queued frame flushes exactly once");
      s3.deliver(enc("ack", { cid: written[0]!.cid, ok: true, value: 7 }));
      await tick(10);
      assert(call.done && call.ok, "the flushed call resolves on its ack");
      assertEquals(call.value, 7, "and carries the server's return value");
    } finally {
      cli.close();
      restoreT();
      restoreWS();
    }
  },
});

Deno.test({
  name: "exactly-once (WS): the ack clock starts at the WRITE, not at dispatch",
  async fn() {
    const restoreWS = installFakeWS();
    const restoreT = fastBackoff();
    // 60ms ceiling: far shorter than the time this action spends queued.
    const cli = connectCli<{ n: number }>("http://localhost:1/x", {
      ackTimeoutMs: 60,
    });
    const box = counterCell();
    try {
      const s1 = await waitFor(() => FakeWS.live[0], "first socket");
      s1.open();
      s1.close();
      cli.bind(box);
      const call = track(box.bump(1));
      await tick(200); // 3× the ceiling, entirely offline
      assertEquals(
        call.done,
        false,
        "a queued action timed out while it was still queued — its caller " +
          "was told the server never confirmed a call that was never sent",
      );
      const s = await waitFor(
        () => FakeWS.live.find((w) => w !== s1),
        "reconnect socket",
      );
      s.open();
      const written = s.actions();
      assertEquals(written.length, 1);
      s.deliver(enc("ack", { cid: written[0]!.cid, ok: true }));
      await tick(10);
      assert(call.done && call.ok, "and it resolves once acked");
    } finally {
      cli.close();
      restoreT();
      restoreWS();
    }
  },
});

Deno.test({
  name: "exactly-once (WS): an IN-FLIGHT call still rejects on disconnect",
  async fn() {
    const restoreWS = installFakeWS();
    const restoreT = fastBackoff();
    const cli = connectCli<{ n: number }>("http://localhost:1/x");
    const box = counterCell();
    try {
      const s1 = await waitFor(() => FakeWS.live[0], "first socket");
      s1.open();
      cli.bind(box);
      const call = track(box.bump(1));
      await waitFor(() => s1.actions().length === 1, "frame written");
      s1.close(); // written, never acked → fate unknown → reject
      await tick(20);
      assert(call.done && !call.ok, "a written-but-unacked call must reject");
      assert(
        /connection lost/.test(String((call.value as Error).message)),
        `honest reason, got: ${(call.value as Error).message}`,
      );
      // And it is NOT resent: the queue never held it.
      const s2 = await waitFor(() => FakeWS.live[1], "reconnect socket");
      s2.open();
      assertEquals(
        s2.actions().length,
        0,
        "a rejected in-flight action must not be replayed",
      );
    } finally {
      cli.close();
      restoreT();
      restoreWS();
    }
  },
});

Deno.test({
  name:
    "exactly-once (WS): close() rejects queued calls — their frames are gone",
  async fn() {
    const restoreWS = installFakeWS();
    const restoreT = fastBackoff();
    const cli = connectCli<{ n: number }>("http://localhost:1/x");
    const box = counterCell();
    try {
      const s1 = await waitFor(() => FakeWS.live[0], "first socket");
      s1.open();
      s1.close();
      cli.bind(box);
      const call = track(box.bump(1));
      await tick(20);
      assertEquals(call.done, false);
      cli.close(); // discards the queue → the rejection is now the truth
      await tick(10);
      assert(call.done && !call.ok, "close() must settle a queued call");
    } finally {
      restoreT();
      restoreWS();
    }
  },
});

// ── connectCliUDS ────────────────────────────────────────────────────

Deno.test({
  name: "uds: destructured bind() works — no `this`, no synchronous throw",
  async fn() {
    // A socket path that will never exist: the client stays offline and every
    // action queues, which is exactly the path `this.send` used to explode on.
    const { bind, close } = connectCliUDS<{ n: number }>(
      `/tmp/aio-nonexistent-${crypto.randomUUID()}.sock`,
    );
    const box = counterCell();
    bind(box);
    // Pre-fix this threw SYNCHRONOUSLY (uncatchable through the promise) and
    // left a registered ack that became an unhandled rejection at close().
    const call = track(box.bump(1));
    await tick(20);
    assertEquals(call.done, false, "the call queues, pending");
    close();
    await tick(10);
    assert(call.done && !call.ok, "close() settles it honestly");
  },
});

Deno.test({
  name: "uds: an over-cap action is rejected IMMEDIATELY with the real reason",
  async fn() {
    const cli = connectCliUDS<{ n: number }>(
      `/tmp/aio-nonexistent-${crypto.randomUUID()}.sock`,
      // A 30s ceiling: if the over-cap calls were left to the ack timer this
      // test would hang rather than fail fast, which is the point — the wrong
      // answer arrived 15s late and blamed the server.
      { ackTimeoutMs: 30_000 },
    );
    const box = counterCell();
    cli.bind(box);
    const calls = Array.from({ length: 105 }, () => track(box.bump(1)));
    await tick(50);
    const settled = calls.filter((c) => c.done);
    assertEquals(
      settled.length,
      5,
      "exactly the 5 past the 100-deep queue must settle at once",
    );
    for (const c of settled) {
      assert(!c.ok);
      assert(
        /NOT sent|queue is full/i.test(String((c.value as Error).message)),
        `the reason must be the discard, not a server timeout: ${
          (c.value as Error).message
        }`,
      );
    }
    cli.close();
    await tick(10);
  },
});

Deno.test({
  name: "uds: a patch that fails to apply asks the server to resync",
  async fn() {
    // A bare UDS server: send a snapshot, then a patch that cannot apply.
    // Pre-fix the client swallowed the failure and froze at its last good
    // state — no log, no request, permanent silent divergence.
    const path = `/tmp/aio-uds-resync-${crypto.randomUUID()}.sock`;
    const listener = Deno.listen({ transport: "unix", path });
    const fromClient: string[] = [];
    const served = (async () => {
      const conn = await listener.accept();
      const w = conn.writable.getWriter();
      const enc8 = new TextEncoder();
      await w.write(enc8.encode(enc("state", { n: 1 }) + "\n"));
      // A "replace" into a path that does not exist throws inside applyPatches.
      await w.write(
        enc8.encode(
          enc("patches", [
            { op: "replace", path: ["nope", "deeper", 3], value: 1 },
          ]) + "\n",
        ),
      );
      const dec8 = new TextDecoder();
      const reader = conn.readable.getReader();
      const deadline = Date.now() + 4000;
      let buf = "";
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec8.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const l of lines) if (l) fromClient.push(l);
        if (fromClient.some((l) => dec(l)?.t === "resync")) break;
      }
      try {
        conn.close();
      } catch { /* client gone */ }
    })();

    const cli = connectCliUDS<{ n: number }>(path);
    try {
      await waitFor(
        () => fromClient.some((l) => dec(l)?.t === "resync"),
        "a resync request from the UDS client",
      );
    } finally {
      cli.close();
      try {
        listener.close();
      } catch { /* already closed */ }
      await served.catch(() => {});
      await Deno.remove(path).catch(() => {});
    }
  },
});
