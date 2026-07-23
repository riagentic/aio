// AIO-7.1: useEffect non-empty deps get real React semantics.
// deps [a] → runs after mount, re-runs only when a changes (Object.is),
// cleanup before re-run, NO signal auto-tracking inside deps-driven effects.

import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/state/signal.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { _resetEventWarnings } from "../src/air/vdom-events.ts";
import { _resetHints, useEffect } from "../src/air/compat.ts";

function createDOM(): {
  document: Document;
  root: HTMLElement;
  cleanup: () => void;
} {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.happyDOM.close() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

Deno.test({
  name: "7.1: deps [a] — runs after mount, re-runs ONLY when a changes",
  async fn() {
    _resetHints();
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const sig = signal(0); // drives re-render
    let runs = 0;
    const App = () => {
      const rendered = sig.value; // re-render on every sig change
      const dep = rendered >= 2 ? "high" : "low"; // dep changes only at 2
      useEffect(() => {
        runs++;
      }, [dep]);
      return h("div", null, String(rendered));
    };
    const handle = mount(root, App);
    await flush();
    assertEquals(runs, 1, "runs once after mount");

    sig.set(1); // re-render, dep still "low"
    await flush();
    assertEquals(runs, 1, "no re-run when dep unchanged");

    sig.set(2); // re-render, dep → "high"
    await flush();
    assertEquals(runs, 2, "re-runs when dep changes");

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "7.1: cleanup runs before re-run and on unmount",
  async fn() {
    _resetHints();
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const sig = signal(0);
    const log: string[] = [];
    const App = () => {
      const v = sig.value;
      useEffect(() => {
        log.push(`run:${v}`);
        return () => log.push(`clean:${v}`);
      }, [v]);
      return h("div", null, String(v));
    };
    const handle = mount(root, App);
    await flush();
    sig.set(1);
    await flush();
    assertEquals(log, ["run:0", "clean:0", "run:1"]);
    _unmount(handle);
    await flush();
    assertEquals(log, ["run:0", "clean:0", "run:1", "clean:1"]);
    await cleanup();
  },
});

Deno.test({
  name: "7.1: signal auto-tracking is DISABLED inside deps-driven effects",
  async fn() {
    _resetHints();
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const tracked = signal(0); // read INSIDE the effect, not in deps
    const render = signal(0); // drives re-render
    let runs = 0;
    const App = () => {
      const _r = render.value;
      useEffect(() => {
        const _v = tracked.value; // must NOT subscribe
        runs++;
      }, ["constant"]);
      return h("div", null, "x");
    };
    const handle = mount(root, App);
    await flush();
    assertEquals(runs, 1);

    tracked.set(99); // signal changes — deps didn't — must NOT re-fire
    await flush();
    assertEquals(runs, 1, "signal change must not re-fire deps-driven effect");

    render.set(1); // re-render with same deps — still no re-fire
    await flush();
    assertEquals(runs, 1);

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "7.1: no deps array — runs after every render",
  async fn() {
    _resetHints();
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const sig = signal(0);
    let runs = 0;
    const App = () => {
      const v = sig.value;
      useEffect(() => {
        runs++;
      });
      return h("div", null, String(v));
    };
    const handle = mount(root, App);
    await flush();
    const after_mount = runs;
    assertEquals(after_mount >= 1, true, "runs after mount");

    sig.set(1);
    await flush();
    assertEquals(runs > after_mount, true, "runs again after re-render");

    _unmount(handle);
    await cleanup();
  },
});

// ── AIO-7.2: React event-name aliases + unknown-event guard ─────────

Deno.test({
  name: "7.2: onDoubleClick fires on dblclick",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    let fired = 0;
    const App = () => h("button", { onDoubleClick: () => fired++ }, "dbl");
    const handle = mount(root, App);
    const btn = root.querySelector("button")!;
    const win = document.defaultView as unknown as { Event: typeof Event };
    btn.dispatchEvent(new win.Event("dblclick", { bubbles: true }));
    assertEquals(fired, 1, "onDoubleClick handler fires for dblclick");
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "7.2: unknown event name warns exactly once in dev",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    _resetEventWarnings();
    (globalThis as Record<string, unknown>).__aioDev = true;
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
    try {
      const App = () =>
        h("div", null, [
          h("button", { key: "a", onFoobar: () => {} }, "typo1"),
          h("button", { key: "b", onFoobar: () => {} }, "typo2"),
        ]);
      const handle = mount(root, App);
      _unmount(handle);
    } finally {
      console.warn = origWarn;
      delete (globalThis as Record<string, unknown>).__aioDev;
    }
    const hits = warnings.filter((w) => w.includes('unknown event "foobar"'));
    assertEquals(hits.length, 1, "warns exactly once per event name");
    await cleanup();
  },
});

// ── AIO-8.2: async-misclassification guard ──────────────────────────

Deno.test("8.2: sync-classified method returning a Promise throws in dev", async () => {
  const { cell } = await import("../src/state/cell-create.ts");
  const { composeCells } = await import("../src/state/cell-compose.ts");
  const { _resetCellRegistry } = await import("../src/state/cell-reactive.ts");
  _resetCellRegistry();
  (globalThis as Record<string, unknown>).__aioDev = true;
  try {
    const sneaky = cell("sneaky", {
      state: { n: 0 },
      methods: {
        // Simulates a transpiled async fn: plain function returning a Promise
        save(_s: { n: number }) {
          return Promise.resolve() as unknown as void;
        },
      },
    });
    const composed = composeCells([sneaky]);
    let threw = "";
    try {
      composed.reduce({ n: 0 } as never, {
        type: "sneaky:save",
        payload: { args: [] },
      } as never);
    } catch (e) {
      threw = (e as Error).message;
    }
    assertEquals(threw.includes("classified sync"), true, `got: ${threw}`);
    assertEquals(threw.includes("markAsync"), true);
  } finally {
    delete (globalThis as Record<string, unknown>).__aioDev;
    const { _resetCellRegistry: reset } = await import(
      "../src/state/cell-reactive.ts"
    );
    reset();
  }
});

Deno.test("8.2: in PROD it ALSO throws — never commits the half-applied draft", async () => {
  const { cell } = await import("../src/state/cell-create.ts");
  const { composeCells } = await import("../src/state/cell-compose.ts");
  const { _resetCellRegistry } = await import("../src/state/cell-reactive.ts");
  _resetCellRegistry();
  // PROD path: __aioDev unset. Before the fix, prod log.error'd and returned
  // undefined, so Immer FINALIZED the partial mutation (n=1) and broadcast
  // corrupt state — a silent prod-only divergence. Now it throws in both modes
  // so dispatch discards the draft either way.
  delete (globalThis as Record<string, unknown>).__aioDev;
  try {
    const sneaky = cell("sneaky", {
      state: { n: 0 },
      methods: {
        save(s: { n: number }) {
          s.n = 1; // synchronous prefix mutates the draft…
          return Promise.resolve() as unknown as void; // …then returns a thenable
        },
      },
    });
    const composed = composeCells([sneaky]);
    let threw = "";
    let returned: unknown;
    try {
      returned = composed.reduce({ sneaky: { n: 0 } } as never, {
        type: "sneaky:save",
        payload: { args: [] },
      } as never);
    } catch (e) {
      threw = (e as Error).message;
    }
    assertEquals(
      threw.includes("classified sync"),
      true,
      `prod must throw and discard the partial draft, got: ${
        threw ||
        JSON.stringify(returned)
      }`,
    );
  } finally {
    _resetCellRegistry();
  }
});
