// Two documented public APIs that did nothing (measured):
//
//  • `client.subscribe(fn)` (docs/basics/api-reference.md) registered a
//    listener nobody ever notified — `_notify()` had ZERO call sites in
//    src/browser/, so a full state frame AND a patch produced 0 callbacks. The
//    AIR renderer reads through signals, which is why only the
//    framework-agnostic client was dead.
//  • `connectReduxDevTools()` sent one `init` and nothing else: `_sendDevTools` was
//    likewise never called, so the extension's action log stayed empty.
//
// Both are now driven from the ONE place a state is applied
// (`_incStateVersion`, the transport's state seam) — the same shape as the
// standalone renderer's twin (`src/standalone-air.ts`).
import { assert, assertEquals } from "@std/assert";
import {
  _coreReset,
  _incStateVersion,
  _resetDevTools,
  client,
  connectReduxDevTools,
  disconnectReduxDevTools,
} from "../src/browser/browser-protocol.ts";
import { handleMessage } from "../src/state-core.ts";
import { _resetSignals } from "../src/state/state-signals.ts";

type DevToolsMsg = { action: { type: string }; state: unknown };

function installFakeDevTools(): {
  sent: DevToolsMsg[];
  inits: unknown[];
  restore: () => void;
} {
  const sent: DevToolsMsg[] = [];
  const inits: unknown[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = g.__REDUX_DEVTOOLS_EXTENSION__;
  g.__REDUX_DEVTOOLS_EXTENSION__ = {
    connect: () => ({
      subscribe: () => {},
      init: (s: unknown) => void inits.push(s),
      send: (action: { type: string }, state: unknown) =>
        void sent.push({ action, state }),
      disconnect: () => {},
    }),
  };
  return {
    sent,
    inits,
    restore: () => {
      if (prev === undefined) delete g.__REDUX_DEVTOOLS_EXTENSION__;
      else g.__REDUX_DEVTOOLS_EXTENSION__ = prev;
    },
  };
}

Deno.test("client.subscribe fires on a full state frame and on a patch", () => {
  _coreReset();
  _resetSignals();
  const seen: unknown[] = [];
  const off = client.subscribe((s) => seen.push(s));
  try {
    handleMessage({ counter: { n: 1 } });
    _incStateVersion(); // what the transport calls once a state is applied
    assertEquals(seen.length, 1, "a full state frame must reach subscribers");
    assertEquals((seen[0] as { counter: { n: number } }).counter.n, 1);

    handleMessage({
      $patches: [{ op: "replace", path: ["counter", "n"], value: 2 }],
    });
    _incStateVersion();
    assertEquals(seen.length, 2, "a patch must reach subscribers too");
    assertEquals(client.getCellState("counter"), { n: 2 });
  } finally {
    off();
  }
});

Deno.test("client.subscribe returns a working unsubscribe", () => {
  _coreReset();
  _resetSignals();
  let calls = 0;
  const off = client.subscribe(() => calls++);
  handleMessage({ a: { v: 1 } });
  _incStateVersion();
  assertEquals(calls, 1);
  off();
  handleMessage({ $patches: [{ op: "replace", path: ["a", "v"], value: 2 }] });
  _incStateVersion();
  assertEquals(calls, 1, "an unsubscribed listener must stop being called");
});

Deno.test("connectReduxDevTools streams every state change, not just init", () => {
  _coreReset();
  _resetSignals();
  _resetDevTools();
  const fake = installFakeDevTools();
  try {
    handleMessage({ counter: { n: 1 } });
    connectReduxDevTools();
    assertEquals(fake.inits.length >= 1, true, "init on connect");
    client.send({ type: "counter:inc" });
    handleMessage({
      $patches: [{ op: "replace", path: ["counter", "n"], value: 2 }],
    });
    _incStateVersion();
    assertEquals(fake.sent.length, 1, "the state change must reach DevTools");
    assertEquals(
      fake.sent[0]!.action.type,
      "counter:inc",
      "…paired with the action this client dispatched",
    );
    // A state that arrives on its own (another client, a server effect) is
    // still traced — named for what it is rather than attributed to a caller.
    handleMessage({
      $patches: [{ op: "replace", path: ["counter", "n"], value: 3 }],
    });
    _incStateVersion();
    assertEquals(fake.sent.length, 2);
    assertEquals(fake.sent[1]!.action.type, "@@aio/state");
  } finally {
    disconnectReduxDevTools();
    _resetDevTools();
    fake.restore();
  }
});

Deno.test("connectReduxDevTools off-browser is a no-op, never a ReferenceError", () => {
  _resetDevTools();
  const g = globalThis as unknown as Record<string, unknown>;
  const hadWindow = "window" in g;
  const prevWindow = g.window;
  // The extension lookup used to read a BARE `window`, outside the try that
  // makes this function a no-op — so with no `window` binding at all it threw
  // a ReferenceError instead of doing nothing.
  if (hadWindow) delete g.window;
  try {
    assert(!("window" in g), "the guard is meaningless with a window present");
    connectReduxDevTools(); // no extension installed → must simply do nothing
    disconnectReduxDevTools();
  } finally {
    if (hadWindow) g.window = prevWindow;
  }
});
