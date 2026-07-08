// Regression: blank render when a UI uses direct cell access without any hook.
//
// The bug: ensureConnected() (which installs reactive getters via
// bindAllCellsReactive) was only triggered by UI hooks. A minimal App that
// reads counter.count directly and uses no hooks never bound, so cell getters
// returned undefined and nothing rendered. Fix landed in server-html-gen.ts:
// the dev HTML bootstrap now calls ensureConnected() before mount.
//
// This test locks in the contract the bootstrap depends on: after cells are
// reactively bound, a no-hook component rendering counter.count shows the
// initial state and updates when state changes.

import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { cell } from "aio";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import {
  _resetCellRegistry,
  bindAllCellsReactive,
} from "../src/state/cell-reactive.ts";
import {
  _applyFullState,
  _resetSignals,
  getCellSignal,
} from "../src/state/state-signals.ts";

function setup() {
  _resetCellRegistry();
  _resetSignals();
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return {
    root,
    cleanup: async () => {
      await win.happyDOM.close();
      _resetCellRegistry();
      _resetSignals();
    },
  };
}

Deno.test({
  name: "boot: direct cell access renders after bindAllCellsReactive",
  async fn() {
    const { root, cleanup } = setup();

    const counter = cell("counter", {
      state: { count: 7 },
      methods: {
        increment(s: { count: number }) {
          s.count += 1;
        },
      },
    });

    // Simulate the dev boot sequence: server state arrives, then cells are
    // reactively bound before mount.
    _applyFullState({ counter: { count: 7 } });
    bindAllCellsReactive();

    const handle = mount(
      root,
      () =>
        h("h1", {}, String((counter as unknown as { count: number }).count)),
    );

    assertEquals(root.textContent, "7");

    // Simulate server-side state update pushing a new cell slice.
    getCellSignal("counter").set({ count: 8 });
    // Renderer flushes synchronously on signal set via queueMicrotask;
    // drain it.
    await Promise.resolve();

    assertEquals(root.textContent, "8");

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "boot: direct access WITHOUT binding returns the declared default " +
    "(AIO-391) — creation-time getters avoid the blank-render/NaN footgun",
  async fn() {
    const { cleanup } = setup();

    const counter = cell("counter", {
      state: { count: 42 },
      methods: { noop(_s: { count: number }) {} },
    });

    // No bindAllCellsReactive(), no _applyFullState(). installDefaultStateGetters
    // (run at cell() creation) makes pre-bind reads return the declared default
    // instead of `undefined` — so components render sane values in SSR/tests/
    // isolation (previously this rendered an empty h1 / produced NaN). Binding
    // later overrides these with the live signal-backed getters.
    assertEquals(
      (counter as unknown as { count: number | undefined }).count,
      42,
    );

    await cleanup();
  },
});

Deno.test({
  name: "boot: bindAllCellsReactive alone (no state applied) returns initial",
  async fn() {
    const { cleanup } = setup();

    const counter = cell("counter", {
      state: { count: 99 },
      methods: { noop(_s: { count: number }) {} },
    });

    bindAllCellsReactive();

    // getCellSignal seeded with initialState in bindCellReactive; even
    // before _applyFullState, the signal holds the initial state so the
    // fallback path in the getter is effectively the same as the tracked
    // path. This guards against a regression where bindAllCellsReactive
    // starts requiring state to be applied first.
    assertEquals(
      (counter as unknown as { count: number }).count,
      99,
    );

    await cleanup();
  },
});
