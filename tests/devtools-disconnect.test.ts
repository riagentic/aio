// tests/devtools-disconnect.test.ts
// Behavior tests for disconnectDevTools (src/protocol/protocol-devtools.ts,
// public via src/air.ts `connectDevTools, disconnectDevTools`).
//
// Strategy: stub window.__REDUX_DEVTOOLS_EXTENSION__ with a fake extension
// that records calls. connectDevTools() must wire connect + subscribe;
// disconnectDevTools() must call connection.disconnect(), null the module
// connection, and make _sendDevTools inert. _resetDevTools() isolates tests
// (same reset used by tests/browser-air.test.ts); _coreReset() keeps
// state-core's "initial state received" flag out of the picture.

import { assertEquals } from "@std/assert";
import {
  _devtools,
  _devtoolsConnected,
  _resetDevTools,
  _sendDevTools,
  connectDevTools,
  disconnectDevTools,
} from "../src/protocol/protocol-devtools.ts";
import type { DevToolsConnection } from "../src/protocol/protocol-types.ts";
import { _reset as _coreReset } from "../src/state-core.ts";

// ── Fake Redux DevTools extension ───────────────────────────────────

type DevToolsMsg = { type: string; payload?: unknown; state?: string };

function fakeExtension() {
  const calls = { connect: 0, init: 0, send: 0, disconnect: 0, subscribe: 0 };
  const sent: {
    action: { type: string; payload?: unknown };
    state: unknown;
  }[] = [];
  let listener: ((msg: DevToolsMsg) => void) | null = null;
  let disconnectThrows = false;

  const connection: DevToolsConnection = {
    init: () => {
      calls.init++;
    },
    send: (action, state) => {
      calls.send++;
      sent.push({ action, state });
    },
    subscribe: (l) => {
      calls.subscribe++;
      listener = l;
      return () => {
        listener = null;
      };
    },
    disconnect: () => {
      calls.disconnect++;
      listener = null;
      if (disconnectThrows) throw new Error("extension gone");
    },
  };

  return {
    ext: { connect: () => (calls.connect++, connection) },
    calls,
    sent,
    hasListener: () => listener !== null,
    makeDisconnectThrow: () => {
      disconnectThrows = true;
    },
  };
}

// window does not exist in Deno — install a stub carrying the extension.
function withWindow(ext: unknown, fn: () => void): void {
  _coreReset();
  _resetDevTools();
  // deno-lint-ignore no-explicit-any
  const orig = (globalThis as any).window;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).window = { __REDUX_DEVTOOLS_EXTENSION__: ext };
  try {
    fn();
  } finally {
    if (orig === undefined) {
      // deno-lint-ignore no-explicit-any
      delete (globalThis as any).window;
    } else {
      // deno-lint-ignore no-explicit-any
      (globalThis as any).window = orig;
    }
    _resetDevTools();
    _coreReset();
  }
}

// ── connect → disconnect lifecycle ──────────────────────────────────

Deno.test("devtools: connectDevTools wires the extension (connect + subscribe, forwards sends)", () => {
  const fake = fakeExtension();
  withWindow(fake.ext, () => {
    connectDevTools();

    assertEquals(fake.calls.connect, 1, "must connect to the extension");
    assertEquals(fake.calls.subscribe, 1, "must register a message listener");
    assertEquals(fake.hasListener(), true);
    assertEquals(_devtoolsConnected, true);

    _sendDevTools({ type: "counter:inc", payload: { by: 1 } }, { counter: 1 });
    assertEquals(fake.calls.send, 1, "connected devtools forwards actions");
    assertEquals(fake.sent[0]?.action.type, "counter:inc");
    assertEquals(fake.sent[0]?.state, { counter: 1 });
  });
});

Deno.test("devtools: disconnectDevTools calls connection.disconnect and resets module state", () => {
  const fake = fakeExtension();
  withWindow(fake.ext, () => {
    connectDevTools();
    assertEquals(_devtoolsConnected, true);

    disconnectDevTools();

    assertEquals(
      fake.calls.disconnect,
      1,
      "extension connection must be disconnected",
    );
    assertEquals(
      fake.hasListener(),
      false,
      "extension listener must be released",
    );
    assertEquals(_devtools, null, "module connection must be cleared");
    assertEquals(_devtoolsConnected, false, "connected flag must be cleared");
  });
});

Deno.test("devtools: after disconnect, _sendDevTools no longer reaches the extension", () => {
  const fake = fakeExtension();
  withWindow(fake.ext, () => {
    connectDevTools();
    _sendDevTools({ type: "a" }, {});
    assertEquals(fake.calls.send, 1);

    disconnectDevTools();
    _sendDevTools({ type: "b" }, {});

    assertEquals(fake.calls.send, 1, "post-disconnect sends must be dropped");
  });
});

Deno.test("devtools: disconnectDevTools without a prior connect is a safe no-op", () => {
  _resetDevTools();
  // No window stub at all — disconnect must not touch globals or throw.
  disconnectDevTools();
  assertEquals(_devtools, null);
  assertEquals(_devtoolsConnected, false);
});

Deno.test("devtools: connectDevTools is idempotent while connected (single extension connection)", () => {
  const fake = fakeExtension();
  withWindow(fake.ext, () => {
    connectDevTools();
    connectDevTools();

    assertEquals(
      fake.calls.connect,
      1,
      "second connect must not open a new connection",
    );
    assertEquals(fake.calls.subscribe, 1);
  });
});

Deno.test("devtools: reconnect after disconnect opens a fresh extension connection", () => {
  const fake = fakeExtension();
  withWindow(fake.ext, () => {
    connectDevTools();
    disconnectDevTools();
    connectDevTools();

    assertEquals(fake.calls.connect, 2, "must reconnect after a disconnect");
    assertEquals(_devtoolsConnected, true);
  });
});

Deno.test("devtools: disconnectDevTools swallows a throwing extension and still resets state", () => {
  const fake = fakeExtension();
  withWindow(fake.ext, () => {
    connectDevTools();
    fake.makeDisconnectThrow();

    disconnectDevTools(); // must not throw

    assertEquals(fake.calls.disconnect, 1);
    assertEquals(
      _devtools,
      null,
      "state must reset even when the extension throws",
    );
    assertEquals(_devtoolsConnected, false);
  });
});
