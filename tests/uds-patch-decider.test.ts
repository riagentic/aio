// ONE patch-vs-full decider for both transports (src/server/patch-or-full.ts).
//
// The UDS router — every desktop client's transport — serialized the WHOLE
// view on every patch round just to compare its length with the patch: 16 ms a
// round at 12.5 MB of state, to send a 50-byte patch. The WS broadcaster had
// long used the last full text's length as an estimate instead. Both now call
// the same function, so the two cannot drift into two answers again.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createUDSListener } from "../src/server/aio.ts";
import { decidePatchOrFull } from "../src/server/patch-or-full.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("patch-or-full: the estimate answers a clearly-small patch without serializing", () => {
  let snaps = 0;
  const snap = () => (snaps++, "x".repeat(1000));
  // No estimate yet → measure.
  assertEquals(decidePatchOrFull(10, undefined, 0.5, snap), {
    sendFull: false,
    fullJson: "x".repeat(1000),
  });
  assertEquals(snaps, 1);
  // Clearly under 50% of the estimate → patch, no serialization.
  assertEquals(decidePatchOrFull(10, 1000, 0.5, snap), {
    sendFull: false,
    fullJson: undefined,
  });
  assertEquals(snaps, 1);
  // Over 50% of the estimate → measure, and the MEASURED size decides.
  assertEquals(decidePatchOrFull(600, 1000, 0.5, snap).sendFull, true);
  assertEquals(snaps, 2);
  assertEquals(
    decidePatchOrFull(600, 100, 0.5, snap).sendFull,
    true,
    "a stale estimate that says full is checked against the real size",
  );
  assertEquals(decidePatchOrFull(400, 100, 0.5, snap).sendFull, false);
  // A snapshot that failed never chooses full (there is nothing to send).
  assertEquals(decidePatchOrFull(600, undefined, 0.5, () => undefined), {
    sendFull: false,
    fullJson: undefined,
  });
});

async function connectAndRead(socketPath: string) {
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let buf = "";
  const r = conn.readable.getReader();
  (async () => {
    try {
      while (true) {
        const { value, done } = await r.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop()!;
        for (const p of parts) if (p) lines.push(p);
      }
    } catch { /* closed */ }
  })();
  return { conn, lines };
}

function send(conn: Deno.Conn, msg: string): void {
  const w = conn.writable.getWriter();
  w.write(new TextEncoder().encode(msg + "\n")).catch(() => {});
  w.releaseLock();
}

const decoded = (lines: string[]) =>
  lines.map((l) => JSON.parse(l) as { t: string; d: unknown });

/** Poll until `pred` holds (bounded), so a loaded box waits instead of flaking. */
async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await wait(10);
}

Deno.test("uds: a small patch round on a big state does not serialize the view", async () => {
  const socketPath = join(await tempDir("aio-uds-dec-"), "uds-decider.sock");
  const state = {
    c: {
      v: 0,
      rows: Array.from({ length: 20_000 }, (_, i) => ({ id: i, s: "row" })),
    },
  };
  let reads = 0;
  const uds = createUDSListener(
    socketPath,
    () => (reads++, state),
    () => {},
    () => {},
  );
  try {
    await wait(30);
    const { conn, lines } = await connectAndRead(socketPath);
    try {
      await until(() => decoded(lines).some((f) => f.t === "state"));
      const before = reads;
      for (let v = 1; v <= 20; v++) {
        state.c = { ...state.c, v };
        uds.broadcastState([
          { cell: "c", ops: [{ op: "replace", path: ["v"], value: v }] },
        ]);
      }
      await until(() =>
        decoded(lines).filter((f) => f.t === "patches").length >= 20
      );
      const kinds = decoded(lines).map((f) => f.t).filter((t) =>
        t === "state" || t === "patches"
      );
      assertEquals(kinds.slice(1), Array(20).fill("patches"));
      assertEquals(
        reads - before,
        0,
        `20 patch rounds read (and serialized) the whole view ${
          reads - before
        } times — the estimate should have answered every one`,
      );
    } finally {
      conn.close();
    }
  } finally {
    await wait(20);
    uds.shutdown();
  }
});

Deno.test("uds: after an unmeasured patch, a state that reverts to the last FULL text is still delivered", async () => {
  // The stale-memo loss the WS path already paid for: a patch round that did
  // not serialize leaves the last full text describing an OLDER state. A later
  // fallback round whose view serializes back to that older text must not be
  // read as "already delivered" — the peer holds the patched state.
  const socketPath = join(
    await tempDir("aio-uds-memo-"),
    "uds-decider-memo.sock",
  );
  const state: Record<string, { v: number; pad?: string }> = {
    c: { v: 1, pad: "p".repeat(2000) },
    d: { v: 0 },
  };
  const uds = createUDSListener(socketPath, () => state, () => {}, () => {});
  try {
    await wait(30);
    const { conn, lines } = await connectAndRead(socketPath);
    try {
      send(conn, JSON.stringify({ v: 2, t: "subs", d: { subs: ["c"] } }));
      await until(() => uds.clients()[0]?.subscriptions?.has("c") === true);
      await wait(50);
      lines.length = 0;
      // Patch c.v 1 → 2: small, sent as a patch without measuring.
      state.c = { ...state.c, v: 2 };
      uds.broadcastState([
        { cell: "c", ops: [{ op: "replace", path: ["v"], value: 2 }] },
      ]);
      await until(() => lines.length >= 1);
      assertEquals(decoded(lines).map((f) => f.t), ["patches"]);
      // c reverts to v:1 — its text now equals the last FULL one — and a
      // round with no patches (a trailing flush) takes the full-state
      // fallback. (A round whose patches are all outside this client's
      // subscriptions sends it nothing at all — its view did not change;
      // tests/uds-unmatched-subs-sends-nothing.test.ts.)
      state.c = { ...state.c, v: 1 };
      uds.broadcastState();
      await until(() => lines.length >= 2);
      const last = decoded(lines).at(-1);
      assert(
        last?.t === "state" &&
          (last.d as { c: { v: number } }).c.v === 1,
        `the reverted state was skipped as already delivered: ${
          JSON.stringify(decoded(lines).map((f) => f.t))
        }`,
      );
    } finally {
      conn.close();
    }
  } finally {
    await wait(20);
    uds.shutdown();
  }
});
