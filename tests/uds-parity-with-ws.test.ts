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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const frames = (lines: string[]) =>
  lines.map((l) => {
    try {
      return JSON.parse(l).t as string;
    } catch {
      return "?";
    }
  });

Deno.test("uds: a subs frame past the cap is refused, not held per connection", async () => {
  const socketPath = join(await Deno.makeTempDir(), "uds-subs-cap.sock");
  const uds = createUDSListener(
    socketPath,
    () => ({ a: { v: 1 }, b: { v: 2 } }),
    () => {},
    () => {},
  );
  await wait(50);
  const { conn } = await connectAndRead(socketPath);
  await wait(50);

  const many = Array.from({ length: MAX_SUBS + 1 }, (_, i) => `c${i}`);
  send(conn, JSON.stringify({ v: 2, t: "subs", d: { subs: many } }));
  await wait(80);
  assertEquals(
    uds.clients()[0]?.subscriptions,
    null,
    `${MAX_SUBS + 1} paths were kept — the cap is ${MAX_SUBS}`,
  );

  send(
    conn,
    JSON.stringify({
      v: 2,
      t: "subs",
      d: { subs: ["x".repeat(MAX_SUB_LEN + 1)] },
    }),
  );
  await wait(80);
  assertEquals(
    uds.clients()[0]?.subscriptions,
    null,
    "an over-long path was kept",
  );

  // …and an honest frame still lands.
  send(conn, JSON.stringify({ v: 2, t: "subs", d: { subs: ["a"] } }));
  await wait(80);
  assertEquals([...(uds.clients()[0]?.subscriptions ?? [])], ["a"]);

  conn.close();
  await wait(50);
  uds.shutdown();
});

Deno.test("uds: fullStateThreshold decides patch-vs-full, as it does on WS", async () => {
  const socketPath = join(await Deno.makeTempDir(), "uds-threshold.sock");
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
  await wait(50);
  const { conn, lines } = await connectAndRead(socketPath);
  await wait(80);
  lines.length = 0;

  // One big op — its JSON is well over half the full state's.
  state.c.items = [1];
  const big = "v".repeat(100); // > 50% of full state, < 100% of it
  uds.broadcastState([
    { cell: "c", ops: [{ op: "add", path: ["items", 0], value: big }] },
  ]);
  await wait(80);
  assertEquals(
    frames(lines),
    ["state"],
    "a patch above the threshold must go out as full state",
  );

  conn.close();
  await wait(50);
  uds.shutdown();
});

Deno.test("uds: a threshold of 1 keeps the old behaviour (patch unless bigger than full)", async () => {
  const socketPath = join(await Deno.makeTempDir(), "uds-threshold-1.sock");
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
  await wait(50);
  const { conn, lines } = await connectAndRead(socketPath);
  await wait(80);
  lines.length = 0;

  state.c.items = [1];
  uds.broadcastState([
    { cell: "c", ops: [{ op: "add", path: ["items", 0], value: "v" }] },
  ]);
  await wait(80);
  assertEquals(frames(lines), ["patches"]);

  conn.close();
  await wait(50);
  uds.shutdown();
});
