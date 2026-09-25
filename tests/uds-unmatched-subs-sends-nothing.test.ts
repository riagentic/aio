/**
 * The desktop socket (UDS) twin of
 * tests/broadcast-unmatched-subs-sends-nothing.test.ts: a client subscribed
 * to ONE cell is sent nothing when a round changes only another cell. The
 * flush fell through to its full-state fallback, and after any patch round
 * the memo is unknown, so every unrelated change re-sent the whole view.
 */
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createUDSListener } from "../src/server/aio.ts";
import type { PatchEntry } from "../src/protocol/broadcast-utils.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("uds: a round with no patch in a client's subscriptions sends it nothing", async () => {
  const dir = await tempDir("aio-uds-subs-");
  const socketPath = join(dir, "s.sock");
  const state = { a: { pad: "p".repeat(5000), v: 1 }, b: { v: 1 } };
  const uds = createUDSListener(socketPath, () => state, () => {}, () => {});
  let conn: Deno.Conn | undefined;
  try {
    await wait(50);
    conn = await Deno.connect({ path: socketPath, transport: "unix" });
    const frames: string[] = [];
    const r = conn.readable.getReader();
    const dec = new TextDecoder();
    let buf = "";
    (async () => {
      try {
        while (true) {
          const { value, done } = await r.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n");
          buf = parts.pop()!;
          for (const p of parts) {
            if (p && !p.includes('"t":"proto"')) frames.push(p);
          }
        }
      } catch { /* closed */ }
    })();
    const w = conn.writable.getWriter();
    await w.write(
      new TextEncoder().encode('{"v":2,"t":"subs","d":{"subs":["a"]}}\n'),
    );
    w.releaseLock();
    await wait(150);
    const before = frames.length;
    const kinds: string[] = [];
    for (let i = 0; i < 5; i++) {
      state.a.v++;
      uds.broadcastState([
        { cell: "a", ops: [{ op: "replace", path: ["v"], value: state.a.v }] },
      ] as PatchEntry[]);
      await wait(40);
      state.b.v++;
      uds.broadcastState([
        { cell: "b", ops: [{ op: "replace", path: ["v"], value: state.b.v }] },
      ] as PatchEntry[]);
      await wait(40);
    }
    await wait(100);
    for (const f of frames.slice(before)) kinds.push(JSON.parse(f).t);
    // Exactly one patch per change to `a`; the changes to `b` send nothing.
    assertEquals(kinds, Array(5).fill("patches"));
  } finally {
    try {
      conn?.close();
    } catch { /* closed */ }
    uds.shutdown();
    await wait(20);
    await dropTempDir(dir);
  }
});
