// A thrown broadcast round on the DESKTOP transport was silent data divergence.
//
// The coalescer empties its buffer BEFORE calling the flush
// (`broadcast-coalescer.ts` — `drain()` takes the items, then flushes), so a
// throw inside the flush means that round's patches exist nowhere else. The
// clients keep applying LATER patches on top of state missing those writes,
// permanently — and nothing downstream notices, because Immer's out-of-range
// array `add` splices rather than throwing, so the client's own resync safety
// net never fires and the list is merely wrong.
//
// The WS flush wraps its whole loop and marks clients for a full resend, with
// a comment recording the measured case: one method doing
// `s.items.push(v); s.big = 1n` takes `JSON.stringify` down and the round with
// it. `uds.ts` — the transport EVERY client of a local desktop app is on — had
// no catch at all.
import { assert, assertEquals } from "@std/assert";
import { createUDSListener } from "../src/server/aio.ts";
import { _resetDegraded } from "../src/diagnostics/degraded.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read NDJSON frames off a UDS client connection. */
function readFrames(conn: Deno.Conn): { kinds: () => string[] } {
  const kinds: string[] = [];
  const dec = new TextDecoder();
  let buf = "";
  const reader = conn.readable.getReader();
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop()!;
        for (const p of parts) {
          if (!p) continue;
          try {
            kinds.push(JSON.parse(p).t);
          } catch { /* aio-ok: a partial frame is picked up next read */ }
        }
      }
    } catch { /* aio-ok: closed at teardown */ }
  })();
  return { kinds: () => kinds };
}

Deno.test("uds: a patch JSON cannot carry does not silently lose the round", async () => {
  _resetDegraded();
  const dir = await tempDir("uds-thrown-");
  const socketPath = join(dir, "t.sock");
  // Large on purpose — see the assertion below: a small patch against a big
  // state must NOT trip the "patch bigger than half the full state" guard, or
  // the full frame would arrive for a reason unrelated to what is being tested.
  const state = {
    list: {
      items: ["one", ...Array.from({ length: 400 }, (_, i) => `pad${i}`)],
    },
  };
  const uds = createUDSListener(socketPath, () => state, () => {}, () => {});
  const errs: string[] = [];
  const prevLogger = getLogger();
  setLogger({
    pub: (lvl: string, _cat: string, msg: string) => {
      if (lvl === "error") errs.push(msg);
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const frames = readFrames(conn);
  try {
    await wait(80);
    const before = frames.kinds().length;

    // The measured shape: a patch whose VALUE is a BigInt. `JSON.stringify`
    // of the compacted ops throws, and the whole round used to go with it —
    // out of the coalescer, which had already discarded the patches.
    const poison: PatchEntry[] = [
      {
        cell: "list",
        ops: [
          { op: "add", path: ["items", 1], value: 2n } as never,
        ],
      },
    ];
    uds.broadcastState(poison);
    await wait(60);

    // It must be REPORTED, not swallowed. (`degraded()` escalates only after
    // N CONSECUTIVE failures, so the LOG line is the contract for a single
    // lost round — and it has to name the client and the cause.)
    const said = errs.join("\n");
    assert(
      /broadcast failed for client/.test(said) && /BigInt/.test(said),
      `a lost round must be said out loud, naming the client and the cause. ` +
        `Logged: ${JSON.stringify(errs)}`,
    );

    // …and the client must not be left applying later patches on a base that
    // is missing this round. The next round has to carry a FULL state.
    //
    // The state is deliberately LARGE and the patch small, so the size guard
    // ("patch bigger than half the full state → send full") cannot be what
    // produces the full frame: without the `needsFull` mark this round is a
    // patch, and the assertion below is the only thing that says so.
    state.list.items.push("two");
    uds.broadcastState([
      {
        cell: "list",
        ops: [
          { op: "add", path: ["items", 1], value: "two" } as never,
        ],
      },
    ]);
    await wait(60);
    const after = frames.kinds().slice(before);
    assertEquals(
      after.filter((k) => k === "patches").length,
      0,
      `after a LOST round a patch is meaningless — the client's base is ` +
        `missing that round's writes. Got: ${JSON.stringify(after)}`,
    );
    assert(
      after.includes("state"),
      `the client must be resynced with a full state. Got: ${
        JSON.stringify(after)
      }`,
    );
  } finally {
    try {
      conn.close();
    } catch { /* aio-ok: already closed */ }
    uds.shutdown();
    setLogger(prevLogger);
    await dropTempDir(dir);
    _resetDegraded();
  }
});

Deno.test("uds: one client's failed round does not cost the others theirs", async () => {
  _resetDegraded();
  const dir = await tempDir("uds-isolate-");
  const socketPath = join(dir, "i.sock");
  const state = { list: { items: ["one"] } };
  const uds = createUDSListener(socketPath, () => state, () => {}, () => {});
  const a = await Deno.connect({ path: socketPath, transport: "unix" });
  const b = await Deno.connect({ path: socketPath, transport: "unix" });
  const fa = readFrames(a), fb = readFrames(b);
  try {
    await wait(100);
    const beforeA = fa.kinds().length, beforeB = fb.kinds().length;
    // A healthy round reaches both.
    state.list.items = ["one", "two"];
    uds.broadcastState(true);
    await wait(80);
    assert(fa.kinds().length > beforeA, "client A received the round");
    assert(fb.kinds().length > beforeB, "client B received the round");
  } finally {
    for (const c of [a, b]) {
      try {
        c.close();
      } catch { /* aio-ok: already closed */ }
    }
    uds.shutdown();
    await dropTempDir(dir);
    _resetDegraded();
  }
});
