// Cross-transport differential: a REFUSED action frame that carries a `cid`.
//
// The WS door already knows this: "A refused frame that carries a cid is TOLD.
// The client registered an ack for it, so a silent return left
// `await cell.method()` waiting to its ceiling for a method that was never
// dispatched — then blaming a server that never confirmed the call."
// (server-ws.ts `refuseAction`).
//
// The UDS door — which on a desktop app is the ONLY door; no TCP port is open
// at all — did `log.warn(); continue;` for the same three refusals, so the
// identical frame is an instant `ok:false` on WS and a full ack-timeout hang
// on UDS. It was also MORE PERMISSIVE than WS and the trojan: the
// "payload must be a plain object" gate existed on both of those doors and on
// neither this one, so `payload: [1,2]` / `payload: "s"` was dispatched here
// and refused everywhere else.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createUDSListener } from "../src/server/aio.ts";
import { enc } from "../src/protocol/envelope.ts";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type Ack = { cid: string; ok: boolean; error?: string; code?: string };

/** The one ack a refusal must produce. */
function one(acks: Ack[], what: string): Ack {
  assertEquals(acks.length, 1, `${what}: expected exactly one ack`);
  return acks[0]!;
}

/** Send one frame, collect every ack that arrives within `ms`. */
async function udsSend(
  socketPath: string,
  frame: string,
  ms = 250,
): Promise<Ack[]> {
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const w = conn.writable.getWriter();
  await w.write(new TextEncoder().encode(frame + "\n"));
  w.releaseLock();
  const acks: Ack[] = [];
  // Read to EOF, and close the socket on a timer so EOF always arrives — a
  // racing `read()` left pending is what the op sanitizer calls a leak.
  const reading = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of conn.readable) {
      buf += dec.decode(chunk, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop()!;
      for (const p of parts) {
        if (!p.trim()) continue;
        try {
          const m = JSON.parse(p);
          if (m.t === "ack") acks.push(m.d as Ack);
        } catch { /* partial */ }
      }
    }
  })().catch(() => {/* closed under us — that is the stop signal */});
  await new Promise((res) => setTimeout(res, ms));
  try {
    conn.close();
  } catch { /* already gone */ }
  await reading;
  return acks;
}

Deno.test("uds: a refused action carrying a cid is answered, never dropped", async () => {
  const dir = await tempDir("uds-refused-");
  const sock = join(dir, "r.sock");
  const dispatched: unknown[] = [];
  const uds = createUDSListener(
    sock,
    () => ({ ok: true }),
    (action) => {
      dispatched.push(action);
      return Promise.resolve(undefined);
    },
    () => {},
  );
  await new Promise((r) => setTimeout(r, 40));
  try {
    // 1. missing `type` — WS: `ws: invalid action — missing type field`.
    const a1 = one(
      await udsSend(sock, enc("action", { payload: {}, cid: "u1" })),
      "a type-less action with a cid must be acked",
    );
    assertEquals(a1.ok, false);
    assertStringIncludes(a1.error ?? "", "missing type field");

    // 2. framework-internal type — WS refuses AND acks.
    const a2 = one(
      await udsSend(
        sock,
        enc("action", { type: "x:__setSecret", payload: {}, cid: "u2" }),
      ),
      "a framework-internal action must be acked",
    );
    assertEquals(a2.ok, false);
    assertStringIncludes(a2.error ?? "", "framework-internal");

    // 3. a non-plain-object payload — refused by WS AND by the trojan, and
    //    silently DISPATCHED here.
    const before = dispatched.length;
    const a3 = one(
      await udsSend(
        sock,
        enc("action", { type: "x:m", payload: [1, 2], cid: "u3" }),
      ),
      "a bad-payload action must be acked",
    );
    assertEquals(
      dispatched.length,
      before,
      "an array payload must not reach dispatch — WS and the trojan refuse it",
    );
    assertEquals(a3.ok, false);
    assertStringIncludes(a3.error ?? "", "plain object");

    // 4. a legitimate frame still runs and acks ok — nothing was narrowed.
    const ok = one(
      await udsSend(
        sock,
        enc("action", { type: "x:m", payload: { args: [1] }, cid: "u4" }),
      ),
      "a legitimate frame",
    );
    assertEquals(ok.ok, true);
    assert(dispatched.length === before + 1, "the good frame was dispatched");
  } finally {
    uds.shutdown();
    await dropTempDir(dir);
  }
});

Deno.test("uds: a refused action WITHOUT a cid stays quiet (no ack noise)", async () => {
  const dir = await tempDir("uds-refused-nocid-");
  const sock = join(dir, "q.sock");
  const uds = createUDSListener(
    sock,
    () => ({ ok: true }),
    () => Promise.resolve(undefined),
    () => {},
  );
  await new Promise((r) => setTimeout(r, 40));
  try {
    const acks = await udsSend(
      sock,
      enc("action", { type: "x:__setSecret", payload: {} }),
      300,
    );
    assertEquals(acks.length, 0, "no cid registered, so nothing to settle");
  } finally {
    uds.shutdown();
    await dropTempDir(dir);
  }
});
