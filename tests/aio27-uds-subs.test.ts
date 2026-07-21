// tests/aio27-uds-subs.test.ts
// AIO-27: UDS "subs" frame handling — subscription filtering for Electron clients
//
// Tests verify:
// 1. "subs" frames are parsed (not dropped as "malformed")
// 2. Filtered state is sent back immediately on subscription change
// 3. broadcastState() respects per-client subscriptions
// 4. "*" subscription means subscribe-all (no filtering)
// 5. Per-client delta tracking works with subscriptions

import { assertEquals } from "@std/assert";
import { createUDSListener } from "../src/server/aio.ts";
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
          if (part && !part.includes('"t":"proto"')) lines.push(part);
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

// ── AIO-27: subs frame not dropped ───────────────────────────────

Deno.test("aio27: subs frame is handled (not dropped as malformed)", async () => {
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
  assertEquals(initial.t, "state");
  assertEquals(initial.d.counter.value, 42);

  // Send a subs frame — this used to cause "uds: malformed message"
  send(conn, '{"v":2,"t":"subs","d":{"subs":["counter"]}}');
  await wait(100);

  // Should NOT have "malformed message" in debug
  const hasMalformed = debugMsgs.some((m) => m.includes("malformed"));
  assertEquals(hasMalformed, false, "subs must not be logged as malformed");

  conn.close();
  await wait(50);
  uds.shutdown();
});

// ── AIO-27: filtered state sent on subscription change ───────────

Deno.test("aio27: subs frame sends filtered state immediately", async () => {
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
  assertEquals(initial.t, "state");
  assertEquals(initial.d.counter.value, 42);
  assertEquals(initial.d.status.ok, true);
  assertEquals(initial.d.extra.data, 99);

  // Subscribe to only "counter"
  send(conn, '{"v":2,"t":"subs","d":{"subs":["counter"]}}');
  await wait(100);

  // Should receive filtered state (only counter)
  assertEquals(
    lines.length >= 2,
    true,
    "should receive filtered state after subs",
  );
  const filtered = JSON.parse(lines[1]!).d;
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

Deno.test("aio27: subs with '*' means subscribe-all (no filtering)", async () => {
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
  send(conn, '{"v":2,"t":"subs","d":{"subs":["a"]}}');
  await wait(100);

  const filtered = JSON.parse(lines[1]!).d;
  assertEquals(filtered.a, 1);
  assertEquals(filtered.b, undefined);

  // Now subscribe to "*" — should get full state
  send(conn, '{"v":2,"t":"subs","d":{"subs":["*"]}}');
  await wait(100);

  const full = JSON.parse(lines[2]!).d;
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
  send(conn, '{"v":2,"t":"subs","d":{"subs":["counter"]}}');
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

  // Broadcast should be filtered — only counter, no status.
  // Could be a "patches" delta or a "state" frame depending on threshold.
  if (broadcast.t === "patches") {
    // Delta — check it only contains counter paths
    const touchesStatus = (broadcast.d as { path: unknown[] }[]).some(
      (op) => op.path[0] === "status",
    );
    assertEquals(touchesStatus, false, "delta must not contain status");
  } else {
    // Full state — check only counter present
    assertEquals(broadcast.t, "state");
    assertEquals(
      broadcast.d.counter !== undefined,
      true,
      "counter must be present",
    );
    assertEquals(
      broadcast.d.status,
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

  // Force broadcast — should send a full "state" frame (not patches)
  stateVal = 3;
  uds.broadcastState(true);
  await wait(100);

  const last = JSON.parse(lines[lines.length - 1]!);
  assertEquals(
    last.t,
    "state",
    "force broadcast must send a full-state frame (not patches)",
  );
  assertEquals(
    last.d.counter.value,
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
  send(conn, '{"v":2,"t":"subs","d":{"subs":["a"]}}');
  await wait(100);
  const sub1 = JSON.parse(lines[lines.length - 1]!).d;
  assertEquals(sub1.a.x, 1);
  assertEquals(sub1.b, undefined);
  assertEquals(sub1.c, undefined);

  // Change to "b", "c"
  send(conn, '{"v":2,"t":"subs","d":{"subs":["b","c"]}}');
  await wait(100);
  const sub2 = JSON.parse(lines[lines.length - 1]!).d;
  assertEquals(sub2.a, undefined, "a must be excluded after re-subscription");
  assertEquals(sub2.b.y, 2);
  assertEquals(sub2.c.z, 3);

  conn.close();
  await wait(50);
  uds.shutdown();
});
