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

Deno.test("aio26: a reloading renderer is re-seeded with the last full state", () => {
  // A new document has no base state, so the snapshot — never a queued delta —
  // is what it must be handed. The replay used to live in the __aio:ready
  // handler; it now seeds the delivery queue at `did-start-navigation`, which
  // is the same guarantee expressed once (the queue is the only path to the
  // renderer). tests/electron-main-relay.test.ts proves the behaviour.
  const navIdx = script.indexOf("'did-start-navigation'");
  assertEquals(navIdx > -1, true, "script must handle did-start-navigation");
  const afterNav = script.slice(navIdx, navIdx + 700);
  assertEquals(
    afterNav.includes("rendererReady = false") &&
      afterNav.includes("_pending.push({ k: 'state', line: lastFullState })"),
    true,
    "a main-frame navigation must re-seed the queue with the last snapshot",
  );
  // And a stale DELTA must never survive into the new document.
  assertEquals(
    afterNav.includes("pk === 'state' || pk === 'patches'") &&
      afterNav.includes("_pending.splice(i, 1)"),
    true,
    "queued state/patches must be dropped for a fresh document",
  );
});

// ── AIO-26: no per-connection residue leaks across a reconnect ────

Deno.test("aio26: connection-scoped state is reset when the socket reconnects", () => {
  const connectIdx = script.indexOf("'connect'");
  assertEquals(connectIdx > -1, true, "script must contain connect handler");

  const afterConnect = script.slice(connectIdx, connectIdx + 300);
  assertEquals(
    afterConnect.includes("lastFullState = null"),
    true,
    "UDS reconnect must reset lastFullState to null",
  );
  // The read buffer is connection-scoped too: a server that died mid-frame
  // leaves half a line, and carrying it over glued it onto the NEXT
  // connection's first frame (the proto hello).
  const fnIdx = script.indexOf("function connectUDS()");
  assertEquals(fnIdx > -1, true, "script must define connectUDS");
  assertEquals(
    script.slice(fnIdx, connectIdx).includes("buf = ''"),
    true,
    "connectUDS must reset the read buffer before connecting",
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
      script.includes("if (kind === 'state') lastFullState = line;"),
    true,
    "Data handler must classify by the decoded frame kind",
  );
  // The snapshot cache takes "state" frames ONLY — a "patches" delta is never
  // a replayable base.
  assertEquals(
    script.includes("if (kind === 'patches') lastFullState"),
    false,
    'a "patches" frame must never become the replayable snapshot',
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
