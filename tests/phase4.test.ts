// Phase 4 Tests — 12 cells: exports, lifecycle, context, JSX, useRef, Portal,
// Suspense/lazy, dev warnings, forms, animations, virtual scrolling, devtools.

import { assert, assertEquals, assertExists } from "@std/assert";
import { Window } from "happy-dom";
import { batch, computed, signal } from "../src/state/signal.ts";
import {
  _diff,
  _render,
  ErrorBoundary,
  Fragment,
  h,
  lazy,
  Portal,
  renderToString,
  setDevMode,
  Suspense,
} from "../src/air/vdom.ts";
import type { VNode } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  createContext,
  hydrate,
  mount,
  onCleanup,
  onMount,
  setDevMode as setDevModeRenderer,
  useContext,
  useId,
  useOptimistic,
  useRef,
  useSignal,
} from "../src/air/aio-renderer.ts";
import type { MountHandle } from "../src/air/aio-renderer.ts";
import { useFieldArray, useForm } from "../src/air/form.ts";
import { useSpring } from "../src/air/animation.ts";
import { useVirtualList } from "../src/air/virtual-list.ts";
import {
  _isDevToolsConnected,
  _recordRender,
  connectAioDevTools,
} from "../src/diagnostics/devtools.ts";

// happy-dom timers drained via win.happyDOM.close() — sanitizers re-enabled

function createDOM(): { document: Document; cleanup: () => void } {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  return { document: doc, cleanup: () => win.happyDOM.close() };
}

function setupMount(): {
  root: HTMLElement;
  document: Document;
  cleanup: () => void;
  mount: (App: (props: Record<string, unknown>) => VNode | null) => MountHandle;
} {
  const { document, cleanup } = createDOM();
  _setDocument(document);
  const root = document.createElement("div");
  document.body.appendChild(root);
  return {
    root,
    document,
    cleanup,
    mount: (App) => mount(root, App),
  };
}

// ════════════════════════════════════════════════════════════════════
// 1. Export public API (tested implicitly by imports above)
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "export: ErrorBoundary, Portal, Suspense, lazy are importable",
  async fn() {
    assertExists(ErrorBoundary);
    assertExists(Portal);
    assertExists(Suspense);
    assertExists(lazy);
    assertExists(renderToString);
  },
});

// ════════════════════════════════════════════════════════════════════
// 2. onMount / onCleanup lifecycle hooks
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "lifecycle: onMount fires after first render",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    let mounted = false;
    const App = () => {
      onMount(() => {
        mounted = true;
      });
      return h("div", null, "hello");
    };
    m(App);
    assertEquals(mounted, true);
    assertEquals(root.innerHTML, "<div>hello</div>");
    await cleanup();
  },
});

Deno.test({
  name: "lifecycle: onCleanup fires on unmount",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    let cleaned = false;
    const App = () => {
      onCleanup(() => {
        cleaned = false;
      }); // This will be overwritten
      onCleanup(() => {
        cleaned = true;
      });
      return h("div", null, "test");
    };
    const handle = m(App);
    assertEquals(cleaned, false);
    _unmount(handle);
    assertEquals(cleaned, true);
    await cleanup();
  },
});

Deno.test({
  name: "lifecycle: onCleanup fires before signal re-render",
  async fn() {
    const { cleanup, mount: m } = setupMount();
    const count = signal(0);
    const log: string[] = [];
    const App = () => {
      onCleanup(() => {
        log.push("cleanup");
      });
      return h("span", null, String(count.value));
    };
    const handle = m(App);
    log.push("initial");
    count.set(1);
    handle._flush();
    assertEquals(log, ["initial", "cleanup"]);
    await cleanup();
  },
});

Deno.test({
  name:
    "lifecycle: onCleanup inside onMount registers and fires on unmount (AIO-74)",
  async fn() {
    const { cleanup, mount: m } = setupMount();
    let cleaned = false;
    const App = () => {
      onMount(() => {
        // onCleanup inside onMount — this is the documented pattern
        onCleanup(() => {
          cleaned = true;
        });
      });
      return h("div", null, "hello");
    };
    const handle = m(App);
    assertEquals(cleaned, false);
    _unmount(handle);
    assertEquals(cleaned, true);
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 2b. useSignal — component-scoped signals
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useSignal: creates signal scoped to component",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    const App = () => {
      const count = useSignal(0);
      return h("span", null, String(count.value));
    };
    m(App);
    assertEquals(root.innerHTML, "<span>0</span>");
    await cleanup();
  },
});

Deno.test({
  name: "useSignal: persists across re-renders",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    const trigger = signal(0);
    let sigRef: ReturnType<typeof useSignal<number>> | null = null;
    const App = () => {
      const count = useSignal(42);
      sigRef = count;
      trigger.value; // track trigger for re-render
      return h("span", null, String(count.value));
    };
    const handle = m(App);
    assertEquals(root.innerHTML, "<span>42</span>");
    const firstSig = sigRef;

    // Re-render — should get same signal instance
    trigger.set(1);
    handle._flush();
    assertEquals(sigRef === firstSig, true);
    await cleanup();
  },
});

Deno.test({
  name: "useSignal: .set() triggers component re-render",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    let sig: ReturnType<typeof useSignal<number>> | null = null;
    const App = () => {
      const count = useSignal(0);
      sig = count;
      return h("span", null, String(count.value));
    };
    const handle = m(App);
    assertEquals(root.innerHTML, "<span>0</span>");

    sig!.set(5);
    handle._flush();
    assertEquals(root.innerHTML, "<span>5</span>");
    await cleanup();
  },
});

Deno.test({
  name: "useSignal: multiple useSignal calls maintain independent state",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    const App = () => {
      const a = useSignal(10);
      const b = useSignal("hello");
      return h("div", null, `${a.value}-${b.value}`);
    };
    m(App);
    assertEquals(root.innerHTML, "<div>10-hello</div>");
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 3. Context / Provider
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "context: Provider passes value to children",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    const ThemeCtx = createContext("light");
    const Child = () => h("span", null, useContext(ThemeCtx));
    const App = () => h(ThemeCtx.Provider, { value: "dark" }, h(Child, null));
    m(App);
    assertEquals(root.innerHTML, "<span>dark</span>");
    await cleanup();
  },
});

Deno.test({
  name: "context: default value when no Provider",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    const Ctx = createContext(42);
    const Child = () => h("span", null, String(useContext(Ctx)));
    const App = () => h(Child, null);
    m(App);
    assertEquals(root.innerHTML, "<span>42</span>");
    await cleanup();
  },
});

Deno.test({
  name: "context: nested Providers override",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    const Ctx = createContext("a");
    const Inner = () => h("span", null, useContext(Ctx));
    const App = () =>
      h(
        Ctx.Provider,
        { value: "outer" },
        h(Ctx.Provider, { value: "inner" }, h(Inner, null)),
      );
    m(App);
    assertEquals(root.innerHTML, "<span>inner</span>");
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 4. JSX config (tested by checking jsx-runtime exports)
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "jsx-runtime: exports jsx, jsxs, Fragment",
  async fn() {
    const mod = await import("../src/jsx-runtime.ts");
    assertExists(mod.jsx);
    assertExists(mod.jsxs);
    assertExists(mod.Fragment);
    // Verify jsx creates VNodes correctly
    const vn = mod.jsx("div", { id: "test", children: "hello" });
    assertEquals(vn.tag, "div");
    assertEquals(vn.props.id, "test");
    assertEquals(vn.children, ["hello"]);
  },
});

// ════════════════════════════════════════════════════════════════════
// 5. useRef
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useRef: persists across re-renders",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    const count = signal(0);
    let renderCount = 0;
    const App = () => {
      const ref = useRef(0);
      ref.current++;
      renderCount++;
      return h("span", null, `renders=${ref.current} count=${count.value}`);
    };
    const handle = m(App);
    assertEquals(root.innerHTML, "<span>renders=1 count=0</span>");
    count.set(1);
    handle._flush();
    assertEquals(root.innerHTML, "<span>renders=2 count=1</span>");
    assertEquals(renderCount, 2);
    await cleanup();
  },
});

Deno.test({
  name: "useRef: does not trigger re-render on mutation",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    let renderCount = 0;
    const App = () => {
      const ref = useRef({ count: 0 });
      renderCount++;
      ref.current.count = 42; // mutating ref doesn't trigger re-render
      return h("span", null, "stable");
    };
    m(App);
    assertEquals(renderCount, 1);
    assertEquals(root.innerHTML, "<span>stable</span>");
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 6. Portals
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "portal: renders children into target DOM node",
  async fn() {
    const { document, cleanup, mount: m } = setupMount();
    const portalTarget = document.createElement("div");
    portalTarget.id = "portal";
    document.body.appendChild(portalTarget);

    const root = document.createElement("div");
    document.body.appendChild(root);
    _setDocument(document);

    const App = () =>
      h(
        Fragment,
        null,
        h("span", null, "main"),
        h(Portal, { target: portalTarget }, h("div", null, "portal content")),
      );
    mount(root, App);
    assertEquals(root.innerHTML, "<span>main</span>");
    assertEquals(portalTarget.innerHTML, "<div>portal content</div>");
    await cleanup();
  },
});

Deno.test({
  name: "portal: SSR skips portal content",
  async fn() {
    const html = renderToString(
      h(Portal, { target: null }, h("div", null, "should not appear")),
    );
    assertEquals(html, "");
  },
});

// ════════════════════════════════════════════════════════════════════
// 7. Lazy / Suspense
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "suspense SSR: shows fallback for unresolved lazy",
  async fn() {
    const LazyComp = lazy(() => new Promise(() => {})); // never resolves
    const html = renderToString(
      h(
        Suspense,
        { fallback: h("span", null, "Loading...") },
        h(LazyComp, null),
      ),
    );
    assertEquals(html, "<span>Loading...</span>");
  },
});

Deno.test({
  name: "suspense: shows fallback in DOM for unresolved lazy",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    const LazyComp = lazy(() => new Promise(() => {})); // never resolves
    const App = () =>
      h(
        Suspense,
        { fallback: h("span", null, "Loading...") },
        h(LazyComp, null),
      );
    m(App);
    assertEquals(root.innerHTML, "<span>Loading...</span>");
    await cleanup();
  },
});

Deno.test({
  name: "suspense: renders children when not lazy",
  async fn() {
    const html = renderToString(
      h(
        Suspense,
        { fallback: h("span", null, "Loading...") },
        h("div", null, "Ready!"),
      ),
    );
    assertEquals(html, "<div>Ready!</div>");
  },
});

// ════════════════════════════════════════════════════════════════════
// 8. Dev-mode warnings
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "dev: warns on duplicate keys",
  async fn() {
    const { document, cleanup } = createDOM();
    const ctx = { doc: document };
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };

    setDevMode(true);
    try {
      const root = document.createElement("div");
      // First render — creates DOM
      const old = h("ul", null, h("li", { key: "a" }, "A"));
      _render(root, old, null, ctx);
      // Diff with duplicate keys triggers warning
      const next = h(
        "ul",
        null,
        h("li", { key: "a" }, "A"),
        h("li", { key: "a" }, "B"),
      );
      _diff(root, next, old, ctx);
      assert(warnings.some((w) => w.includes("Duplicate key")));
    } finally {
      setDevMode(false);
      console.warn = origWarn;
    }
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 9. Form utilities
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useForm: initial values and validation",
  async fn() {
    const form = useForm({
      name: {
        initial: "",
        rules: [(v: string) => v.length > 0 ? null : "Required"],
      },
      age: { initial: 0 },
    });

    assertEquals(form.fields.name.value, "");
    assertEquals(form.fields.age.value, 0);
    assertEquals(form.valid, true); // not touched yet

    // Touch triggers validation
    form.fields.name.touch();
    assertEquals(form.fields.name.error, "Required");
    assertEquals(form.valid, false);

    // Set value clears error
    form.fields.name.set("Alice");
    assertEquals(form.fields.name.error, null);
    assertEquals(form.fields.name.dirty, true);
    assertEquals(form.valid, true);

    // Values
    const vals = form.values();
    assertEquals(vals.name, "Alice");
    assertEquals(vals.age, 0);

    // Reset
    form.reset();
    assertEquals(form.fields.name.value, "");
    assertEquals(form.fields.name.dirty, false);
    assertEquals(form.fields.name.error, null);
  },
});

Deno.test({
  name: "useForm: validate all at once",
  async fn() {
    const form = useForm({
      email: {
        initial: "",
        rules: [(v: string) => v.includes("@") ? null : "Invalid"],
      },
    });
    const valid = form.validate();
    assertEquals(valid, false);
    assertEquals(form.fields.email.error, "Invalid");
    assertEquals(form.fields.email.touched, true);
  },
});

Deno.test({
  name: "useFieldArray: push, remove, move",
  async fn() {
    const arr = useFieldArray<string>(["a", "b"]);
    assertEquals(arr.items, ["a", "b"]);

    arr.push("c");
    assertEquals(arr.items, ["a", "b", "c"]);

    arr.remove(1);
    assertEquals(arr.items, ["a", "c"]);

    arr.push("d");
    arr.move(0, 2);
    assertEquals(arr.items, ["c", "d", "a"]);

    arr.reset();
    assertEquals(arr.items, ["a", "b"]);
  },
});

// ════════════════════════════════════════════════════════════════════
// 10. Animation hooks
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useSpring: immediate set",
  async fn() {
    const spring = useSpring({ initial: 0 });
    assertEquals(spring.value, 0);
    spring.set(100);
    assertEquals(spring.value, 100);
    assertEquals(spring.animating, false);
  },
});

// ════════════════════════════════════════════════════════════════════
// 11. Virtual scrolling
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useVirtualList: renders only visible items",
  async fn() {
    const items = Array.from(
      { length: 1000 },
      (_, i) => ({ id: i, name: `Item ${i}` }),
    );
    const vlist = useVirtualList({
      items,
      itemHeight: 40,
      containerHeight: 200,
      overscan: 2,
    });

    // Should render ~5 visible + 4 overscan = ~9 items
    assert(vlist.visible.length <= 12);
    assert(vlist.visible.length >= 5);
    assertEquals(vlist.visible[0]!.index, 0);
    assertEquals(vlist.totalHeight, 40000);
  },
});

Deno.test({
  name: "useVirtualList: scrollToIndex changes visible window",
  async fn() {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const vlist = useVirtualList({
      items,
      itemHeight: 50,
      containerHeight: 200,
      overscan: 1,
    });

    vlist.scrollToIndex(50);
    assertEquals(vlist.scrollTop, 2500);
    // First visible item should be around index 49 (with overscan)
    assert(vlist.visible[0]!.index >= 48);
    assert(vlist.visible[0]!.index <= 50);
  },
});

Deno.test({
  name: "useVirtualList: works with signal items",
  async fn() {
    const itemsSig = signal([1, 2, 3, 4, 5]);
    const vlist = useVirtualList({
      items: itemsSig,
      itemHeight: 20,
      containerHeight: 100,
    });

    assertEquals(vlist.visible.length, 5); // All visible
    assertEquals(vlist.totalHeight, 100);
  },
});

Deno.test({
  name: "useVirtualList: container and inner styles",
  async fn() {
    const vlist = useVirtualList({
      items: [1, 2, 3],
      itemHeight: 30,
      containerHeight: 150,
    });
    assertEquals(vlist.containerStyle.height, "150px");
    assertEquals(vlist.containerStyle.overflow, "auto");
    assertEquals(vlist.innerStyle.height, "90px");
  },
});

// ════════════════════════════════════════════════════════════════════
// 12. DevTools integration
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "devtools: connect and record render events",
  async fn() {
    const handle = connectAioDevTools();
    assertEquals(handle.connected, true);
    assertEquals(handle.totalRenders, 0);

    _recordRender({
      component: "Counter",
      timestamp: Date.now(),
      durationMs: 1.5,
      trigger: "signal",
    });
    assertEquals(handle.totalRenders, 1);
    assertEquals(handle.renders.length, 1);
    assertEquals(handle.renders[0]!.component, "Counter");

    handle.disconnect();
    assertEquals(handle.connected, false);
  },
});

Deno.test({
  name: "devtools: _isDevToolsConnected reflects state",
  async fn() {
    const handle = connectAioDevTools();
    assertEquals(_isDevToolsConnected(), true);
    handle.disconnect();
    assertEquals(_isDevToolsConnected(), false);
  },
});

// ════════════════════════════════════════════════════════════════════
// 13. Lazy resolve triggers Suspense re-render
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "suspense: lazy component resolves and replaces fallback",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    let resolveFn!: (
      mod: { default: (props: Record<string, unknown>) => VNode | null },
    ) => void;
    const promise = new Promise<
      { default: (props: Record<string, unknown>) => VNode | null }
    >((r) => {
      resolveFn = r;
    });
    const LazyComp = lazy(() => promise);
    const App = () =>
      h(
        Suspense,
        { fallback: h("span", null, "Loading...") },
        h(LazyComp, null),
      );
    const handle = m(App);
    assertEquals(root.innerHTML, "<span>Loading...</span>");

    // Resolve the lazy component
    resolveFn({ default: () => h("div", null, "Loaded!") });
    await promise;
    // Give microtask a chance to run the lazy listener callback
    await new Promise((r) => setTimeout(r, 10));
    handle._flush();
    assertEquals(root.innerHTML, "<div>Loaded!</div>");
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 14. Portal cleanup on unmount
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "portal: content removed on unmount",
  async fn() {
    const { document, cleanup, mount: m } = setupMount();
    const portalTarget = document.createElement("div");
    document.body.appendChild(portalTarget);
    const root = document.createElement("div");
    document.body.appendChild(root);
    _setDocument(document);

    const show = signal(true);
    const App = () =>
      show.value
        ? h(Portal, { target: portalTarget }, h("span", null, "portal"))
        : null;
    const handle = m(App);
    assertEquals(portalTarget.innerHTML, "<span>portal</span>");

    show.set(false);
    handle._flush();
    assertEquals(portalTarget.innerHTML, "");
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 15. Context update on signal-triggered re-render
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "context: updates when Provider value changes via signal",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    const ThemeCtx = createContext("light");
    const theme = signal("light");
    const Child = () => h("span", null, useContext(ThemeCtx));
    const App = () =>
      h(ThemeCtx.Provider, { value: theme.value }, h(Child, null));
    const handle = m(App);
    assertEquals(root.innerHTML, "<span>light</span>");

    theme.set("dark");
    handle._flush();
    assertEquals(root.innerHTML, "<span>dark</span>");
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 16. Multiple useRef in same component
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useRef: multiple refs in same component persist independently",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    const count = signal(0);
    const App = () => {
      const ref1 = useRef(0);
      const ref2 = useRef("hello");
      ref1.current++;
      return h("span", null, `${ref1.current}-${ref2.current}-${count.value}`);
    };
    const handle = m(App);
    assertEquals(root.innerHTML, "<span>1-hello-0</span>");
    count.set(1);
    handle._flush();
    assertEquals(root.innerHTML, "<span>2-hello-1</span>");
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 17. Cleanup exception safety
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "lifecycle: throwing cleanup does not break subsequent cleanups",
  async fn() {
    const { cleanup, mount: m } = setupMount();
    const count = signal(0);
    const log: string[] = [];
    const App = () => {
      onCleanup(() => {
        throw new Error("boom");
      });
      onCleanup(() => {
        log.push("second-cleanup");
      });
      return h("span", null, String(count.value));
    };
    // Suppress expected error log
    const origErr = console.error;
    console.error = () => {};
    try {
      const handle = m(App);
      count.set(1);
      handle._flush();
      assertEquals(log, ["second-cleanup"]);
    } finally {
      console.error = origErr;
    }
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 18. devWarned clears on setDevMode(false)
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "dev: setDevMode(false) clears warning dedup",
  async fn() {
    const { document, cleanup } = createDOM();
    const ctx = { doc: document };
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      setDevMode(true);
      // First trigger
      const root = document.createElement("div");
      const old1 = h("ul", null, h("li", { key: "x" }, "X"));
      _render(root, old1, null, ctx);
      _diff(
        root,
        h("ul", null, h("li", { key: "x" }, "A"), h("li", { key: "x" }, "B")),
        old1,
        ctx,
      );
      const count1 = warnings.filter((w) => w.includes("Duplicate key")).length;

      // Disable + re-enable: warning should fire again
      setDevMode(false);
      setDevMode(true);
      const root2 = document.createElement("div");
      const old2 = h("ul", null, h("li", { key: "x" }, "X"));
      _render(root2, old2, null, ctx);
      _diff(
        root2,
        h("ul", null, h("li", { key: "x" }, "A"), h("li", { key: "x" }, "B")),
        old2,
        ctx,
      );
      const count2 = warnings.filter((w) => w.includes("Duplicate key")).length;
      assert(
        count2 > count1,
        "Warning should fire again after setDevMode toggle",
      );
    } finally {
      setDevMode(false);
      console.warn = origWarn;
    }
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 19. Form bind() returns a snapshot, read at bind() time
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useForm: bind() reads the field AT BIND TIME, per render",
  async fn() {
    // This used to assert a live getter, which was the defect: `bind()`'s
    // result is handed to `h()` as props, so a getter deferred the read past
    // the render's tracking window (no subscription) and made
    // `prev.value === next.value` unconditionally true (no DOM write — a
    // rejected keystroke or a `reset()` stayed on screen). A render binds; the
    // bind is the read.
    const form = useForm({
      name: { initial: "Alice" },
    });
    const bound = form.bind("name");
    assertEquals(bound.value, "Alice");
    form.fields.name.set("Bob");
    assertEquals(
      bound.value,
      "Alice",
      "props describe the render that made them",
    );
    assertEquals(form.bind("name").value, "Bob", "the next render binds again");
  },
});

// ════════════════════════════════════════════════════════════════════
// 20. Hydration with context Provider
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "hydrate: context Provider passes value to children",
  async fn() {
    const { document, cleanup } = createDOM();
    _setDocument(document);
    const root = document.createElement("div");
    document.body.appendChild(root);

    const ThemeCtx = createContext("light");
    const Child = () => h("span", null, useContext(ThemeCtx));
    const App = () => h(ThemeCtx.Provider, { value: "dark" }, h(Child, null));

    // Pre-populate DOM to simulate SSR output
    root.innerHTML = "<span>dark</span>";
    hydrate(root, App);
    // After hydration, context should be wired — DOM unchanged
    assertEquals(root.innerHTML, "<span>dark</span>");
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 21. Hydration with nested components (instanceStack cleanup)
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "hydrate: nested components — instanceStack cleaned up",
  async fn() {
    const { document, cleanup } = createDOM();
    _setDocument(document);
    const root = document.createElement("div");
    document.body.appendChild(root);

    const ThemeCtx = createContext("default");
    let childCtxValue = "";
    const GrandChild = () => {
      childCtxValue = useContext(ThemeCtx);
      return h("b", null, childCtxValue);
    };
    const Middle = () => h("span", null, h(GrandChild, null));
    const App = () =>
      h(ThemeCtx.Provider, { value: "nested" }, h(Middle, null));

    // SSR output
    root.innerHTML = "<span><b>nested</b></span>";
    hydrate(root, App);
    assertEquals(childCtxValue, "nested");
    assertEquals(root.innerHTML, "<span><b>nested</b></span>");
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 22. Lazy load error propagates to ErrorBoundary
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "suspense: lazy error propagates to ErrorBoundary",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    let rejectFn!: (err: Error) => void;
    const promise = new Promise<
      { default: (props: Record<string, unknown>) => VNode | null }
    >((_, rej) => {
      rejectFn = rej;
    });
    const LazyComp = lazy(() => promise);
    const App = () =>
      h(
        ErrorBoundary,
        {
          fallback: (e: Error) => h("span", null, `Error: ${e.message}`),
        },
        h(
          Suspense,
          { fallback: h("span", null, "Loading...") },
          h(LazyComp, null),
        ),
      );
    const handle = m(App);
    assertEquals(root.innerHTML, "<span>Loading...</span>");

    // Reject the lazy load
    rejectFn(new Error("network failure"));
    try {
      await promise;
    } catch { /* expected */ }
    await new Promise((r) => setTimeout(r, 10));
    handle._flush();
    assertEquals(root.innerHTML, "<span>Error: network failure</span>");
    await cleanup();
  },
});

// ── useId tests ─────────────────────────────────────────────────────

Deno.test({
  name: "useId: returns stable unique IDs across re-renders",
  async fn() {
    const { root, mount: m, cleanup } = setupMount();
    const ids: string[] = [];
    const trigger = signal(0);

    function App() {
      const id1 = useId();
      const id2 = useId();
      ids.push(id1, id2);
      return h("div", { id: id1 }, `${trigger.value}-${id2}`);
    }

    const handle = m(App);
    // First render: two unique IDs
    assertEquals(ids.length, 2);
    assert(ids[0]!.startsWith(":r"));
    assert(ids[1]!.startsWith(":r"));
    assert(ids[0] !== ids[1], "IDs must be unique");

    // Re-render: same IDs persist
    trigger.set(1);
    handle._flush();
    assertEquals(ids.length, 4);
    assertEquals(ids[2], ids[0], "ID 1 must persist across re-renders");
    assertEquals(ids[3], ids[1], "ID 2 must persist across re-renders");
    await cleanup();
  },
});

Deno.test({
  name: "useId: different components get different IDs",
  async fn() {
    const { root, mount: m, cleanup } = setupMount();
    const ids: string[] = [];

    function Child() {
      const id = useId();
      ids.push(id);
      return h("span", { id }, "child");
    }

    function App() {
      const id = useId();
      ids.push(id);
      return h("div", null, h(Child, null), h(Child, null));
    }

    m(App);
    assertEquals(ids.length, 3);
    // All three IDs must be unique
    const unique = new Set(ids);
    assertEquals(unique.size, 3, "All IDs must be unique");
    await cleanup();
  },
});

Deno.test({
  name: "useId: SSR renders deterministic IDs",
  async fn() {
    function Inner() {
      const id = useId();
      return h("label", { htmlFor: id }, h("input", { id }));
    }

    function App() {
      return h("div", null, h(Inner, null), h(Inner, null));
    }

    const html1 = renderToString(h(App, null));
    const html2 = renderToString(h(App, null));
    // Each renderToString call resets counter — same output
    assertEquals(
      html1,
      html2,
      "SSR must produce deterministic IDs across calls",
    );
    // Both Inner components should have different IDs
    assert(html1.includes(":r0:"), "First component gets :r0:");
    assert(html1.includes(":r1:"), "Second component gets :r1:");
  },
});

// ── useOptimistic tests ─────────────────────────────────────────────

Deno.test({
  name: "useOptimistic: shows passthrough when no optimistic action",
  async fn() {
    const { root, mount: m, cleanup } = setupMount();

    function App() {
      const [display] = useOptimistic(
        "confirmed",
        (_cur: string, opt: string) => opt,
      );
      return h("div", null, display);
    }

    m(App);
    assertEquals(root.innerHTML, "<div>confirmed</div>");
    await cleanup();
  },
});

Deno.test({
  name: "useOptimistic: applies optimistic overlay on addOptimistic",
  async fn() {
    const { root, mount: m, cleanup } = setupMount();
    let addFn: ((v: string) => void) | null = null;

    function App() {
      const [display, add] = useOptimistic(
        "old",
        (_cur: string, opt: string) => opt,
      );
      addFn = add;
      return h("div", null, display);
    }

    const handle = m(App);
    assertEquals(root.innerHTML, "<div>old</div>");

    // Add optimistic value
    addFn!("optimistic!");
    handle._flush();
    assertEquals(root.innerHTML, "<div>optimistic!</div>");
    await cleanup();
  },
});

Deno.test({
  name: "useOptimistic: clears overlay when passthrough changes",
  async fn() {
    const { root, mount: m, cleanup } = setupMount();
    const serverState = signal("v1");
    let addFn: ((v: string) => void) | null = null;

    function App() {
      const [display, add] = useOptimistic(
        serverState.value,
        (_cur: string, opt: string) => opt,
      );
      addFn = add;
      return h("div", null, display);
    }

    const handle = m(App);
    assertEquals(root.innerHTML, "<div>v1</div>");

    // Add optimistic overlay
    addFn!("pending...");
    handle._flush();
    assertEquals(root.innerHTML, "<div>pending...</div>");

    // Server confirms new state → overlay clears
    serverState.set("v2");
    handle._flush();
    assertEquals(root.innerHTML, "<div>v2</div>");
    await cleanup();
  },
});

Deno.test({
  name: "useOptimistic: stacks multiple optimistic actions",
  async fn() {
    const { root, mount: m, cleanup } = setupMount();
    let addFn: ((v: number) => void) | null = null;

    function App() {
      const [count, add] = useOptimistic(
        0,
        (cur: number, delta: number) => cur + delta,
      );
      addFn = add;
      return h("div", null, String(count));
    }

    const handle = m(App);
    assertEquals(root.innerHTML, "<div>0</div>");

    addFn!(5);
    addFn!(3);
    handle._flush();
    assertEquals(root.innerHTML, "<div>8</div>");
    await cleanup();
  },
});
