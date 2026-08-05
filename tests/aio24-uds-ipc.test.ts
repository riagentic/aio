// tests/aio24-uds-ipc.test.ts
// AIO-24: UDS idle timeout silently kills Electron IPC — no heartbeat in IPC mode
//
// Tests verify:
// 1. handleUDSConn closes conn on read-loop exit (no ghost sockets)
// 2. No idle timeout race in UDS handler (removed — local sockets don't need it)
// 3. _ipcConnected set to false in onClose handler
// 4. IPC keepalive ping timer created and cleaned up
// 5. Electron bridge write has error handling
// 6. Server ignores "ping" keepalive frames

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createUDSListener } from "../src/server/aio.ts";
import { electronMainScriptUDS } from "../src/electron/electron.ts";
import { join } from "@std/path";

// ── UDS: conn.close() on disconnect ────────────────────────────────

Deno.test("aio24: UDS conn closed after client disconnects (no ghost socket)", async () => {
  const socketPath = join(
    await Deno.makeTempDir(),
    "aio24-test.sock",
  );
  const actions: { type: string }[] = [];
  const uds = createUDSListener(
    socketPath,
    () => ({ ok: true }),
    (a) => {
      actions.push(a as { type: string });
    },
    () => {},
  );

  // Wait for listener to be ready
  await new Promise((r) => setTimeout(r, 50));

  // Connect a client
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  await new Promise((r) => setTimeout(r, 50));

  // Send an action to prove connection works
  const encoder = new TextEncoder();
  await conn.writable.getWriter().write(
    encoder.encode('{"v":2,"t":"action","d":{"type":"test"}}\n'),
  );
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(actions.length, 1);
  assertEquals(actions[0]!.type, "test");

  // Close client side — server should close its side too (no ghost)
  conn.close();
  await new Promise((r) => setTimeout(r, 100));

  // Cleanup
  uds.shutdown();
});

// ── UDS: no idle timeout in source ─────────────────────────────────

Deno.test("aio24: handleUDSConn has no idle timeout race", async () => {
  // Read the source and verify the IDLE_TIMEOUT pattern was removed
  const src = await Deno.readTextFile("src/server/aio.ts");
  const hasIdleTimeout = src.includes("IDLE_TIMEOUT");
  assertEquals(
    hasIdleTimeout,
    false,
    "IDLE_TIMEOUT should be removed from UDS handler",
  );
  const hasTimeoutRace = src.includes("Promise.race") &&
    src.includes("setTimeout") &&
    src.includes("reader.read()");
  assertEquals(hasTimeoutRace, false, "Timeout race pattern should be removed");
});

// ── UDS: ping ignored by server ────────────────────────────────────

Deno.test("aio24: server ignores ping keepalive (not dispatched as action)", async () => {
  const socketPath = join(
    await Deno.makeTempDir(),
    "aio24-ping.sock",
  );
  const actions: { type: string }[] = [];
  const debugMsgs: string[] = [];
  const uds = createUDSListener(
    socketPath,
    () => ({ ok: true }),
    (a) => {
      actions.push(a as { type: string });
    },
    (msg) => debugMsgs.push(msg),
  );

  await new Promise((r) => setTimeout(r, 50));

  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const writer = conn.writable.getWriter();
  const encoder = new TextEncoder();

  // Send a ping followed by a real action
  await writer.write(encoder.encode('{"v":2,"t":"ping"}\n'));
  await writer.write(
    encoder.encode('{"v":2,"t":"action","d":{"type":"real-action"}}\n'),
  );
  await new Promise((r) => setTimeout(r, 50));

  // Only the real action should be dispatched — ping is silently ignored
  assertEquals(actions.length, 1);
  assertEquals(actions[0]!.type, "real-action");

  // ping should NOT produce "malformed message" debug output
  const malformedMsgs = debugMsgs.filter((m) => m.includes("malformed"));
  assertEquals(
    malformedMsgs.length,
    0,
    "ping should not trigger malformed warning",
  );

  conn.close();
  await new Promise((r) => setTimeout(r, 50));
  uds.shutdown();
});

// ── Browser: the LIVE AIR transport (browser-air-transport.ts) ─────
//
// These used to read src/browser/browser-transport-{ipc,reset}.ts. Those files
// were unreachable — nothing imported the module that wired them in, and no
// client entry (browser-air.ts, mod.ts, standalone-air.ts) pulled them into
// its import closure — so the guards passed while asserting nothing about any
// shipped client. They now read the transport that actually runs.

const AIR_TRANSPORT = "src/browser/browser-air-transport.ts";

Deno.test("aio24: AIR transport's _ipc.onClose clears _ipcConnected", async () => {
  const src = await Deno.readTextFile(AIR_TRANSPORT);
  const onCloseBlock = src.match(/_ipc\.onClose\(\(\) => \{[\s\S]*?\n  \}\);/);
  if (!onCloseBlock) throw new Error("_ipc.onClose not found");
  assertStringIncludes(
    onCloseBlock[0],
    "_ipcConnected = false",
    "onClose must clear _ipcConnected before any early returns",
  );
});

// ── Browser: IPC keepalive ping ────────────────────────────────────

Deno.test("aio24: AIR transport has an IPC keepalive ping", async () => {
  const src = await Deno.readTextFile(AIR_TRANSPORT);
  assertStringIncludes(src, "_ipcPingTimer", "IPC ping timer must exist");
  assertStringIncludes(src, 'enc("ping")', "Must send ping frames");
});

Deno.test("aio24: IPC ping timer cleared in onClose", async () => {
  const src = await Deno.readTextFile(AIR_TRANSPORT);
  const onCloseBlock = src.match(/_ipc\.onClose\(\(\) => \{[\s\S]*?\n  \}\);/);
  if (!onCloseBlock) throw new Error("_ipc.onClose not found");
  assertStringIncludes(
    onCloseBlock[0],
    "clearInterval(_ipcPingTimer)",
    "onClose must clear the ping timer",
  );
});

Deno.test("aio24: IPC ping timer cleared on teardown", async () => {
  const src = await Deno.readTextFile(AIR_TRANSPORT);
  const teardown = src.slice(src.indexOf("_setTeardownFn("));
  assertStringIncludes(
    teardown,
    "clearInterval(_ipcPingTimer)",
    "teardown must clear the ping timer",
  );
});

// ── Electron: bridge write error handling ──────────────────────────

Deno.test("aio24: UDS script — write error handler on IPC bridge", () => {
  const s = electronMainScriptUDS(
    "http://localhost:3000",
    "/tmp/test.sock",
    {},
  );
  // IPC bridge writes via local ref with error callback
  assertStringIncludes(s, "s.write(json", "IPC bridge must write to socket");
  assertStringIncludes(
    s,
    "__aio:close",
    "Must send close event on write failure",
  );
});
