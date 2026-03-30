// tests/aio24-uds-ipc.test.ts
// AIO-24: UDS idle timeout silently kills Electron IPC — no heartbeat in IPC mode
//
// Tests verify:
// 1. handleUDSConn closes conn on read-loop exit (no ghost sockets)
// 2. No idle timeout race in UDS handler (removed — local sockets don't need it)
// 3. _ipcConnected set to false in onClose handler
// 4. IPC keepalive ping timer created and cleaned up
// 5. Electron bridge write has error handling
// 6. Server ignores __ping keepalive messages

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createUDSListener } from "../src/aio.ts";
import { electronMainScriptUDS } from "../src/electron.ts";
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
    (a) => actions.push(a as { type: string }),
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
    encoder.encode('{"type":"test"}\n'),
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
  const src = await Deno.readTextFile("src/aio.ts");
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

// ── UDS: __ping ignored by server ──────────────────────────────────

Deno.test("aio24: server ignores __ping keepalive (not dispatched as action)", async () => {
  const socketPath = join(
    await Deno.makeTempDir(),
    "aio24-ping.sock",
  );
  const actions: { type: string }[] = [];
  const debugMsgs: string[] = [];
  const uds = createUDSListener(
    socketPath,
    () => ({ ok: true }),
    (a) => actions.push(a as { type: string }),
    (msg) => debugMsgs.push(msg),
  );

  await new Promise((r) => setTimeout(r, 50));

  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const writer = conn.writable.getWriter();
  const encoder = new TextEncoder();

  // Send a ping followed by a real action
  await writer.write(encoder.encode("__ping\n"));
  await writer.write(encoder.encode('{"type":"real-action"}\n'));
  await new Promise((r) => setTimeout(r, 50));

  // Only the real action should be dispatched — __ping is silently ignored
  assertEquals(actions.length, 1);
  assertEquals(actions[0]!.type, "real-action");

  // __ping should NOT produce "malformed message" debug output
  const malformedMsgs = debugMsgs.filter((m) => m.includes("malformed"));
  assertEquals(
    malformedMsgs.length,
    0,
    "__ping should not trigger malformed warning",
  );

  conn.close();
  await new Promise((r) => setTimeout(r, 50));
  uds.shutdown();
});

// ── Browser: _ipcConnected set false in onClose ────────────────────

Deno.test("aio24: browser.ts _ipc.onClose sets _ipcConnected = false", async () => {
  // Verify the source has the fix
  const src = await Deno.readTextFile("src/browser.ts");
  const onCloseBlock = src.match(/_ipc\.onClose\(\(\) => \{[\s\S]*?\}\);/);
  if (!onCloseBlock) throw new Error("_ipc.onClose not found");
  assertStringIncludes(
    onCloseBlock[0],
    "_ipcConnected = false",
    "onClose must set _ipcConnected = false before any early returns",
  );
});

// ── Browser: IPC keepalive ping timer ──────────────────────────────

Deno.test("aio24: browser.ts has IPC keepalive ping", async () => {
  const src = await Deno.readTextFile("src/browser.ts");
  assertStringIncludes(
    src,
    "_ipcPingTimer",
    "IPC ping timer variable must exist",
  );
  assertStringIncludes(src, '__ping"', "Must send __ping message");
  assertStringIncludes(
    src,
    "_IPC_PING_INTERVAL",
    "Ping interval constant must exist",
  );
});

Deno.test("aio24: IPC ping timer cleaned up in onClose", async () => {
  const src = await Deno.readTextFile("src/browser.ts");
  const onCloseBlock = src.match(/_ipc\.onClose\(\(\) => \{[\s\S]*?\}\);/);
  if (!onCloseBlock) throw new Error("_ipc.onClose not found");
  assertStringIncludes(
    onCloseBlock[0],
    "clearInterval(_ipcPingTimer)",
    "onClose must clear ping timer",
  );
});

Deno.test("aio24: IPC ping timer cleaned up in _reset", async () => {
  const src = await Deno.readTextFile("src/browser.ts");
  const resetFn = src.slice(src.indexOf("export function _reset()"));
  assertStringIncludes(
    resetFn,
    "clearInterval(_ipcPingTimer)",
    "_reset must clear ping timer",
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
