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

Deno.test("aio29: __aio:ready sends subs:* to request fresh state from server", () => {
  const readyIdx = script.indexOf("ipcMain.on('__aio:ready'");
  assertEquals(
    readyIdx > -1,
    true,
    "script must contain ipcMain.on __aio:ready handler",
  );
  const afterReady = script.slice(readyIdx, readyIdx + 600);
  // Must send a wildcard "subs" frame to request fresh unfiltered state
  const requestsFresh = afterReady.includes(
    '{"v":2,"t":"subs","d":{"subs":["*"]}}',
  );
  assertEquals(
    requestsFresh,
    true,
    '__aio:ready must send a subs:["*"] frame to the UDS server for fresh state',
  );
});

// ── AIO-26: full state detection still works ─────────────────────

Deno.test("aio26: full state detected by the DECODED v2 frame kind", () => {
  // Only "state" frames may become lastFullState — never "patches" deltas.
  assertEquals(
    script.includes("const kind = frameKind(line)") &&
      script.includes(
        "if (kind === 'state') { lastState = line; lastFullState = line; }",
      ),
    true,
    "Data handler must classify by the decoded frame kind",
  );
  assertEquals(
    script.includes("else if (kind === 'patches') lastState = line"),
    true,
    '"patches" frames must be tracked as lastState only',
  );
  // The class this replaced: classification by SUBSTRING. A frame whose
  // payload merely contains the text of another kind must not be misread.
  assertEquals(
    script.includes('line.indexOf(\'"t":"state"\')'),
    false,
    "frames must never be classified by substring search",
  );
});

Deno.test("aio26: a patches frame CONTAINING the text of a state frame is not cached as full state", () => {
  // Run the generated classifier for real — the bug was invisible to any test
  // that only read the source.
  const src = script.match(/const frameKind = (\(line\) => \{[\s\S]*?\n  \});/);
  assertEquals(src !== null, true, "generated script must define frameKind");
  const frameKind = eval(`(${src![1]})`) as (line: string) => string | null;

  const patchesWithStateText = JSON.stringify({
    v: 2,
    t: "patches",
    d: [{ op: "replace", path: "/last", value: '{"v":2,"t":"state","d":{}}' }],
  });
  assertEquals(frameKind(patchesWithStateText), "patches");
  assertEquals(
    frameKind(JSON.stringify({ v: 2, t: "state", d: { n: 1 } })),
    "state",
  );
  assertEquals(frameKind('{"v":2,"t":"ack","d":{"cid":"x","ok":true}}'), "ack");
  // Key order the fast path does not expect still classifies correctly.
  assertEquals(frameKind('{"t":"state","v":2,"d":{}}'), "state");
  assertEquals(frameKind("not json"), null);
});
