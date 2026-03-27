// Phase 4 Tests — 12 features: exports, lifecycle, context, JSX, useRef, Portal,
// Suspense/lazy, dev warnings, forms, animations, virtual scrolling, devtools.

import { assert, assertEquals, assertExists } from "@std/assert";
import { Window } from "happy-dom";
import { batch, computed, signal } from "../src/signal.ts";
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
} from "../src/vdom.ts";
import type { VNode } from "../src/vdom.ts";
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
  useRef,
} from "../src/aio-renderer.ts";
import type { MountHandle } from "../src/aio-renderer.ts";
import { useFieldArray, useForm } from "../src/form.ts";
import { useSpring, useTransition } from "../src/animation.ts";
import { useVirtualList } from "../src/virtual-list.ts";
import {
  _isDevToolsConnected,
  _recordRender,
  connectAioDevTools,
} from "../src/devtools.ts";

// happy-dom creates internal timers, disable Deno's leak detection for DOM tests
const S = { sanitizeOps: false, sanitizeResources: false } as const;

function createDOM(): { document: Document; cleanup: () => void } {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  return { document: doc, cleanup: () => win.close() };
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
    cleanup();
  },
});

Deno.test({
  name: "lifecycle: onCleanup fires on unmount",
  ...S,
  fn() {
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
    cleanup();
  },
});

Deno.test({
  name: "lifecycle: onCleanup fires before signal re-render",
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 3. Context / Provider
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "context: Provider passes value to children",
  ...S,
  fn() {
    const { root, cleanup, mount: m } = setupMount();
    const ThemeCtx = createContext("light");
    const Child = () => h("span", null, useContext(ThemeCtx));
    const App = () => h(ThemeCtx.Provider, { value: "dark" }, h(Child, null));
    m(App);
    assertEquals(root.innerHTML, "<span>dark</span>");
    cleanup();
  },
});

Deno.test({
  name: "context: default value when no Provider",
  ...S,
  fn() {
    const { root, cleanup, mount: m } = setupMount();
    const Ctx = createContext(42);
    const Child = () => h("span", null, String(useContext(Ctx)));
    const App = () => h(Child, null);
    m(App);
    assertEquals(root.innerHTML, "<span>42</span>");
    cleanup();
  },
});

Deno.test({
  name: "context: nested Providers override",
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 4. JSX config (tested by checking jsx-runtime exports)
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "jsx-runtime: exports jsx, jsxs, Fragment",
  ...S,
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
  ...S,
  fn() {
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
    cleanup();
  },
});

Deno.test({
  name: "useRef: does not trigger re-render on mutation",
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 6. Portals
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "portal: renders children into target DOM node",
  ...S,
  fn() {
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
    cleanup();
  },
});

Deno.test({
  name: "portal: SSR skips portal content",
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
    cleanup();
  },
});

Deno.test({
  name: "suspense: renders children when not lazy",
  ...S,
  fn() {
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
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 9. Form utilities
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useForm: initial values and validation",
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  name: "useTransition: enter/exit lifecycle",
  ...S,
  async fn() {
    const fade = useTransition({ name: "fade", duration: 50 });

    assertEquals(fade.stage, "idle");
    assertEquals(fade.mounted, false);
    assertEquals(fade.className, "");

    fade.enter();
    assertEquals(fade.stage, "enter");
    assertEquals(fade.mounted, true);
    assertEquals(fade.className, "fade-enter");

    // Wait for enter → active transition
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(fade.stage, "active");
    assertEquals(fade.className, "fade-active");

    fade.exit();
    assertEquals(fade.stage, "exit");
    assertEquals(fade.className, "fade-exit");

    // Wait for exit → idle
    await new Promise((r) => setTimeout(r, 60));
    assertEquals(fade.stage, "idle");
    assertEquals(fade.mounted, false);
  },
});

Deno.test({
  name: "useTransition: initial=true starts as active",
  ...S,
  fn() {
    const t = useTransition({ name: "slide", initial: true });
    assertEquals(t.stage, "active");
    assertEquals(t.mounted, true);
  },
});

Deno.test({
  name: "useSpring: immediate set",
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 14. Portal cleanup on unmount
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "portal: content removed on unmount",
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 15. Context update on signal-triggered re-render
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "context: updates when Provider value changes via signal",
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 16. Multiple useRef in same component
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useRef: multiple refs in same component persist independently",
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 17. Cleanup exception safety
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "lifecycle: throwing cleanup does not break subsequent cleanups",
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 18. devWarned clears on setDevMode(false)
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "dev: setDevMode(false) clears warning dedup",
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 19. Form bind() returns live value (getter, not snapshot)
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useForm: bind() value tracks signal changes",
  ...S,
  fn() {
    const form = useForm({
      name: { initial: "Alice" },
    });
    const bound = form.bind("name");
    assertEquals(bound.value, "Alice");
    form.fields.name.set("Bob");
    assertEquals(bound.value, "Bob"); // Should be live, not stale
  },
});

// ════════════════════════════════════════════════════════════════════
// 20. Hydration with context Provider
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "hydrate: context Provider passes value to children",
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 21. Hydration with nested components (instanceStack cleanup)
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "hydrate: nested components — instanceStack cleaned up",
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// 22. Lazy load error propagates to ErrorBoundary
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "suspense: lazy error propagates to ErrorBoundary",
  ...S,
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
    cleanup();
  },
});
