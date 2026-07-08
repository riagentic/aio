// tests/aio26-electron-replay.test.ts
// AIO-26: Electron first render — delta mismatch in __aio:ready replay
//
// Tests verify:
// 1. Generated electron script only replays lastFullState (no delta on top)
// 2. lastState is reset on reconnect alongside lastFullState
// 3. No else-if fallback that sends stale delta without full state base

import { assertEquals } from "@std/assert";
import { electronMainScriptUDS } from "../src/electron/electron.ts";

const script = electronMainScriptUDS(
  "http://localhost:3000",
  "/tmp/test.sock",
  {
    title: "test",
  },
);

// ── AIO-26: __aio:ready only replays lastFullState ───────────────

Deno.test("aio26: __aio:ready handler sends only lastFullState (no delta replay)", () => {
  // The handler should send lastFullState but NOT send lastState when it differs.
  // Previously: if (lastState && lastState !== lastFullState) { send(lastState) }
  // Fixed: removed — a delta computed against intermediate state corrupts renderer.

  // Verify the unsafe pattern is gone
  const hasUnsafeDeltaReplay = script.includes("lastState !== lastFullState");
  assertEquals(
    hasUnsafeDeltaReplay,
    false,
    "__aio:ready must NOT replay lastState when it differs from lastFullState (delta mismatch)",
  );
});

Deno.test("aio26: __aio:ready has no else-if lastState fallback", () => {
  // Previously: else if (lastState) { send(lastState) }
  // This sent a stale delta with no full-state base — browser would drop it anyway.

  const readyIdx = script.indexOf("ipcMain.on('__aio:ready'");
  assertEquals(
    readyIdx > -1,
    true,
    "script must contain ipcMain.on __aio:ready handler",
  );

  const afterReady = script.slice(readyIdx, readyIdx + 500);
  const hasElseIfLastState = afterReady.includes("else if (lastState)");
  assertEquals(
    hasElseIfLastState,
    false,
    "__aio:ready must NOT have else-if fallback sending lastState without full state",
  );
});

Deno.test("aio26: lastFullState replayed in __aio:ready handler", () => {
  // Verify the correct pattern IS present: send lastFullState
  // Use ipcMain.on to find the actual handler (not the preload script reference)
  const readyIdx = script.indexOf("ipcMain.on('__aio:ready'");
  assertEquals(
    readyIdx > -1,
    true,
    "script must contain ipcMain.on __aio:ready handler",
  );
  const afterReady = script.slice(readyIdx, readyIdx + 500);
  const sendsFullState = afterReady.includes("lastFullState");
  assertEquals(
    sendsFullState,
    true,
    "__aio:ready must replay lastFullState to renderer",
  );
});

// ── AIO-26: lastState reset on reconnect ─────────────────────────

Deno.test("aio26: lastState reset to null on UDS reconnect", () => {
  // On sock.connect, both lastFullState and lastState must be reset.
  // Previously only lastFullState was reset — stale lastState leaked across connections.
  const connectIdx = script.indexOf("'connect'");
  assertEquals(connectIdx > -1, true, "script must contain connect handler");

  const afterConnect = script.slice(connectIdx, connectIdx + 300);
  const resetsLastState = afterConnect.includes("lastState = null");
  assertEquals(
    resetsLastState,
    true,
    "UDS reconnect must reset lastState to null (prevents stale state across connections)",
  );

  const resetsLastFullState = afterConnect.includes("lastFullState = null");
  assertEquals(
    resetsLastFullState,
    true,
    "UDS reconnect must reset lastFullState to null",
  );
});

// ── AIO-29: __aio:ready requests fresh state from server ─────────

Deno.test("aio29: __aio:ready sends __subs:* to request fresh state from server", () => {
  const readyIdx = script.indexOf("ipcMain.on('__aio:ready'");
  assertEquals(
    readyIdx > -1,
    true,
    "script must contain ipcMain.on __aio:ready handler",
  );
  const afterReady = script.slice(readyIdx, readyIdx + 600);
  // Must send __subs:["*"] to request fresh unfiltered state from server
  const requestsFresh = afterReady.includes('__subs:["*"]');
  assertEquals(
    requestsFresh,
    true,
    '__aio:ready must send __subs:["*"] to UDS server for fresh state',
  );
});

// ── AIO-26: full state detection still works ─────────────────────

Deno.test("aio26: full state detected by absence of $p key", () => {
  // Non-delta messages (no "$p" key) should update lastFullState
  const hasFullStateDetection = script.includes('"$p"') &&
    script.includes("lastFullState = line");
  assertEquals(
    hasFullStateDetection,
    true,
    "Data handler must detect full state by absence of $p and update lastFullState",
  );
});
