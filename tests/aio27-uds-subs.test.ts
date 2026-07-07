// tests/aio27-uds-subs.test.ts
// AIO-27: UDS __subs: handling — subscription filtering for Electron clients
//
// Tests verify:
// 1. __subs: messages are parsed (not dropped as "malformed")
// 2. Filtered state is sent back immediately on subscription change
// 3. broadcastState() respects per-client subscriptions
// 4. "*" subscription means subscribe-all (no filtering)
// 5. Per-client delta tracking works with subscriptions

import { assertEquals } from "@std/assert";
import { createUDSListener } from "../src/aio.ts";
import { join } from "@std/path";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Helper: connect to UDS and read all NDJSON lines
async function connectAndRead(
  socketPath: string,
): Promise<{ conn: Deno.Conn; lines: string[]; reader: () => string[] }> {
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let buf = "";

  // Read in background
  const readable = conn.readable;
  const r = readable.getReader();
  (async () => {
    try {
      while (true) {
        const { value, done } = await r.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop()!;
        for (const part of parts) {
          // Skip the A3 version hello — these tests assert on state frames.
          if (part && !part.startsWith("__proto:")) lines.push(part);
        }
      }
    } catch { /* closed */ }
  })();

  return { conn, lines, reader: () => lines };
}

// Helper: write NDJSON to conn
function send(conn: Deno.Conn, msg: string): void {
  const w = conn.writable.getWriter();
  w.write(new TextEncoder().encode(msg + "\n")).catch(() => {});
  w.releaseLock();
}

// ── AIO-27: __subs: not dropped ──────────────────────────────────

Deno.test("aio27: __subs: message is handled (not dropped as malformed)", async () => {
  const socketPath = join(await Deno.makeTempDir(), "aio27-subs.sock");
  const debugMsgs: string[] = [];
  const uds = createUDSListener(
    socketPath,
    () => ({ counter: { value: 42 }, status: { ok: true } }),
    () => {},
    (msg) => debugMsgs.push(msg),
  );
  await wait(50);

  const { conn, lines } = await connectAndRead(socketPath);
  await wait(50);

  // Initial state should arrive
  assertEquals(lines.length, 1, "should receive initial state");
  const initial = JSON.parse(lines[0]!);
  assertEquals(initial.counter.value, 42);

  // Send __subs: — this used to cause "uds: malformed message"
  send(conn, '__subs:["counter"]');
  await wait(100);

  // Should NOT have "malformed message" in debug
  const hasMalformed = debugMsgs.some((m) => m.includes("malformed"));
  assertEquals(hasMalformed, false, "__subs: must not be logged as malformed");

  conn.close();
  await wait(50);
  uds.shutdown();
});

// ── AIO-27: filtered state sent on subscription change ───────────

Deno.test("aio27: __subs: sends filtered state immediately", async () => {
  const socketPath = join(await Deno.makeTempDir(), "aio27-filter.sock");
  const uds = createUDSListener(
    socketPath,
    () => ({
      counter: { value: 42 },
      status: { ok: true },
      extra: { data: 99 },
    }),
    () => {},
    () => {},
  );
  await wait(50);

  const { conn, lines } = await connectAndRead(socketPath);
  await wait(50);

  // Initial: full state (unfiltered)
  assertEquals(lines.length, 1);
  const initial = JSON.parse(lines[0]!);
  assertEquals(initial.counter.value, 42);
  assertEquals(initial.status.ok, true);
  assertEquals(initial.extra.data, 99);

  // Subscribe to only "counter"
  send(conn, '__subs:["counter"]');
  await wait(100);

  // Should receive filtered state (only counter)
  assertEquals(
    lines.length >= 2,
    true,
    "should receive filtered state after __subs:",
  );
  const filtered = JSON.parse(lines[1]!);
  assertEquals(
    filtered.counter.value,
    42,
    "counter must be present in filtered state",
  );
  assertEquals(
    filtered.status,
    undefined,
    "status must be excluded from filtered state",
  );
  assertEquals(
    filtered.extra,
    undefined,
    "extra must be excluded from filtered state",
  );

  conn.close();
  await wait(50);
  uds.shutdown();
});

// ── AIO-27: * subscription = subscribe-all ───────────────────────

Deno.test("aio27: __subs: with '*' means subscribe-all (no filtering)", async () => {
  const socketPath = join(await Deno.makeTempDir(), "aio27-star.sock");
  const uds = createUDSListener(
    socketPath,
    () => ({ a: 1, b: 2, c: 3 }),
    () => {},
    () => {},
  );
  await wait(50);

  const { conn, lines } = await connectAndRead(socketPath);
  await wait(50);

  // First subscribe to subset
  send(conn, '__subs:["a"]');
  await wait(100);

  const filtered = JSON.parse(lines[1]!);
  assertEquals(filtered.a, 1);
  assertEquals(filtered.b, undefined);

  // Now subscribe to "*" — should get full state
  send(conn, '__subs:["*"]');
  await wait(100);

  const full = JSON.parse(lines[2]!);
  assertEquals(full.a, 1);
  assertEquals(full.b, 2);
  assertEquals(full.c, 3);

  conn.close();
  await wait(50);
  uds.shutdown();
});

// ── AIO-27: broadcastState respects subscriptions ────────────────

Deno.test("aio27: broadcastState sends filtered state per client subscription", async () => {
  const socketPath = join(await Deno.makeTempDir(), "aio27-bcast.sock");
  let stateVal = 1;
  const uds = createUDSListener(
    socketPath,
    () => ({ counter: { value: stateVal }, status: { ok: true } }),
    () => {},
    () => {},
  );
  await wait(50);

  const { conn, lines } = await connectAndRead(socketPath);
  await wait(50);

  // Subscribe to only "counter"
  send(conn, '__subs:["counter"]');
  await wait(100);

  // Record line count after subscription response
  const beforeBroadcast = lines.length;

  // Change state and broadcast
  stateVal = 2;
  uds.broadcastState();
  await wait(100);

  // Should have received a new message
  assertEquals(
    lines.length > beforeBroadcast,
    true,
    "should receive broadcast",
  );
  const broadcast = JSON.parse(lines[lines.length - 1]!);

  // Broadcast should be filtered — only counter, no status
  // Could be a delta ($p) or full state depending on threshold
  if (broadcast.$p) {
    // Delta — check it only contains counter paths
    assertEquals(
      broadcast.$p.status,
      undefined,
      "delta must not contain status",
    );
  } else {
    // Full state — check only counter present
    assertEquals(
      broadcast.counter !== undefined,
      true,
      "counter must be present",
    );
    assertEquals(
      broadcast.status,
      undefined,
      "status must be excluded from broadcast",
    );
  }

  conn.close();
  await wait(50);
  uds.shutdown();
});

// ── AIO-27: broadcastState force resets delta tracking ───────────

Deno.test("aio27: broadcastState(true) forces full state (resets delta tracking)", async () => {
  const socketPath = join(await Deno.makeTempDir(), "aio27-force.sock");
  let stateVal = 1;
  const uds = createUDSListener(
    socketPath,
    () => ({ counter: { value: stateVal } }),
    () => {},
    () => {},
  );
  await wait(50);

  const { conn, lines } = await connectAndRead(socketPath);
  await wait(100);

  // First broadcast (after initial) — should be delta or skip
  stateVal = 2;
  uds.broadcastState();
  await wait(100);

  // Force broadcast — should send full state (no $p key)
  stateVal = 3;
  uds.broadcastState(true);
  await wait(100);

  const last = JSON.parse(lines[lines.length - 1]!);
  assertEquals(
    last.$p,
    undefined,
    "force broadcast must send full state (no $p)",
  );
  assertEquals(
    last.counter.value,
    3,
    "force broadcast must contain current state",
  );

  conn.close();
  await wait(50);
  uds.shutdown();
});

// ── AIO-27: multiple subscriptions changes accumulate correctly ──

Deno.test("aio27: changing subscriptions updates filter correctly", async () => {
  const socketPath = join(await Deno.makeTempDir(), "aio27-resub.sock");
  const uds = createUDSListener(
    socketPath,
    () => ({ a: { x: 1 }, b: { y: 2 }, c: { z: 3 } }),
    () => {},
    () => {},
  );
  await wait(50);

  const { conn, lines } = await connectAndRead(socketPath);
  await wait(50);

  // Subscribe to "a"
  send(conn, '__subs:["a"]');
  await wait(100);
  const sub1 = JSON.parse(lines[lines.length - 1]!);
  assertEquals(sub1.a.x, 1);
  assertEquals(sub1.b, undefined);
  assertEquals(sub1.c, undefined);

  // Change to "b", "c"
  send(conn, '__subs:["b","c"]');
  await wait(100);
  const sub2 = JSON.parse(lines[lines.length - 1]!);
  assertEquals(sub2.a, undefined, "a must be excluded after re-subscription");
  assertEquals(sub2.b.y, 2);
  assertEquals(sub2.c.z, 3);

  conn.close();
  await wait(50);
  uds.shutdown();
});
