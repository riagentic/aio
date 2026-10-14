// The UDS router is not a lesser transport — on a desktop app it is the ONLY
// one (no TCP port is open at all, so `connections` is empty and every client
// is on this socket). Three things the WS path had and this one did not:
//
//  1. a BOUND on the `subs` frame. `parseSubs` exists because the parsed Set
//     is held per connection and walked on EVERY broadcast; this router did
//     `new Set(paths.filter(isString))` inline — no cap on the count, none on
//     the length — behind a frame ceiling ten times the WS one.
//  2. the user's `fullStateThreshold`. The WS path stopped comparing against
//     100% of full state ("so the user-set fullStateThreshold had no effect");
//     that fix landed on WS only, so a documented public knob did nothing
//     where every desktop client lives.
//  3. the `proto-err` frame on a version mismatch — declared, routed by
//     `cli-client.ts`, and sent by nobody.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createUDSListener } from "../src/server/aio.ts";
import { MAX_SUB_LEN, MAX_SUBS } from "../src/protocol/broadcast-utils.ts";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";
import { connectLocal, type LocalConn } from "../src/server/local-listen.ts";

/** Poll `fn` until it answers truthy — bounded, and the failure names what
 *  never happened. Every wait here is on an observable event: the fixed
 *  80 ms these tests slept were a deadline on a slow machine (a throttled
 *  Mac failed the threshold case with the frame still on its way), and a
 *  vacuous pass for "the frame was refused" when it had not been read yet. */
async function until<T>(
  what: string,
  fn: () => T | null | undefined | false,
): Promise<T> {
  const deadline = performance.now() + 20_000;
  while (true) {
    const v = fn();
    if (v) return v;
    if (performance.now() > deadline) throw new Error(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function connectAndRead(socketPath: string) {
  const conn = await connectLocal(socketPath);
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

/** A connection whose handshake is over: the listener counts it and its
 *  first `state` frame has arrived. `lines` starts empty after that. */
async function connected(
  uds: { clients(): unknown[] },
  socketPath: string,
) {
  const c = await connectAndRead(socketPath);
  await until(
    "the handshake's state frame",
    () => uds.clients().length === 1 && frames(c.lines).includes("state"),
  );
  c.lines.length = 0;
  return c;
}

/** Close `conn`, wait until the listener has let go of it, shut down. */
async function finish(
  uds: { clients(): unknown[]; shutdown(): void },
  conn: LocalConn,
) {
  conn.close();
  await until(
    "the listener dropped the client",
    () => uds.clients().length === 0,
  );
  uds.shutdown();
  await localIdle();
}

function send(conn: LocalConn, msg: string): void {
  const w = conn.writable.getWriter();
  w.write(new TextEncoder().encode(msg + "\n")).catch(() => {});
  w.releaseLock();
}

const frames = (lines: string[]) =>
  lines.map((l) => {
    try {
      return JSON.parse(l).t as string;
    } catch {
      return "?";
    }
  });

Deno.test("uds: a subs frame past the cap is refused, not held per connection", async () => {
  const socketPath = localEndpoint(
    join(await Deno.makeTempDir(), "uds-subs-cap.sock"),
  );
  const uds = createUDSListener(
    socketPath,
    () => ({ a: { v: 1 }, b: { v: 2 } }),
    () => {},
    () => {},
  );
  const { conn, lines } = await connected(uds, socketPath);
  const cells = () =>
    lines.map((l) => Object.keys(JSON.parse(l).d ?? {}).join(","));

  // A frame that is taken answers with the state it now filters to; a refused
  // one answers nothing. Frames are read in order, so the honest frame's
  // answer arriving ALONE says the one before it was refused.
  const many = Array.from({ length: MAX_SUBS + 1 }, (_, i) => `c${i}`);
  send(conn, JSON.stringify({ v: 2, t: "subs", d: { subs: many } }));
  send(conn, JSON.stringify({ v: 2, t: "subs", d: { subs: ["a"] } }));
  await until("the answer to subs [a]", () => cells().includes("a"));
  assertEquals(
    cells(),
    ["a"],
    `${MAX_SUBS + 1} paths were kept — the cap is ${MAX_SUBS}`,
  );
  assertEquals([...(uds.clients()[0]?.subscriptions ?? [])], ["a"]);

  lines.length = 0;
  send(
    conn,
    JSON.stringify({
      v: 2,
      t: "subs",
      d: { subs: ["x".repeat(MAX_SUB_LEN + 1)] },
    }),
  );
  // …and an honest frame still lands.
  send(conn, JSON.stringify({ v: 2, t: "subs", d: { subs: ["b"] } }));
  await until("the answer to subs [b]", () => cells().includes("b"));
  assertEquals(cells(), ["b"], "an over-long path was kept");
  assertEquals([...(uds.clients()[0]?.subscriptions ?? [])], ["b"]);

  await finish(uds, conn);
});

Deno.test("uds: fullStateThreshold decides patch-vs-full, as it does on WS", async () => {
  const socketPath = localEndpoint(
    join(await Deno.makeTempDir(), "uds-threshold.sock"),
  );
  // A patch worth ~60% of full state: above the 0.5 default, below 1.0.
  const state = { c: { pad: "p".repeat(200), items: [] as number[] } };
  const uds = createUDSListener(
    socketPath,
    () => state,
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    0.5,
  );
  const { conn, lines } = await connected(uds, socketPath);

  // One big op — its JSON is well over half the full state's.
  state.c.items = [1];
  const big = "v".repeat(100); // > 50% of full state, < 100% of it
  uds.broadcastState([
    { cell: "c", ops: [{ op: "add", path: ["items", 0], value: big }] },
  ]);
  await until("the broadcast's frame", () => lines.length > 0);
  assertEquals(
    frames(lines),
    ["state"],
    "a patch above the threshold must go out as full state",
  );

  await finish(uds, conn);
});

Deno.test("uds: a threshold of 1 keeps the old behaviour (patch unless bigger than full)", async () => {
  const socketPath = localEndpoint(
    join(await Deno.makeTempDir(), "uds-threshold-1.sock"),
  );
  const state = { c: { pad: "p".repeat(200), items: [] as number[] } };
  const uds = createUDSListener(
    socketPath,
    () => state,
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    1,
  );
  const { conn, lines } = await connected(uds, socketPath);

  state.c.items = [1];
  uds.broadcastState([
    { cell: "c", ops: [{ op: "add", path: ["items", 0], value: "v" }] },
  ]);
  await until("the broadcast's frame", () => lines.length > 0);
  assertEquals(frames(lines), ["patches"]);

  await finish(uds, conn);
});
