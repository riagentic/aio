/**
 * AIO-167 reproduction test: useLocal signal freeze after round-trip tab switch.
 *
 * Scenario: Component created via type-mismatch createDom (simulating router
 * navigation), uses useLocal for tab switching, freezes after A→B→A→B.
 */
import { assertEquals, assertNotEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/signal.ts";
import { h } from "../src/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  type MountHandle,
  useRef,
} from "../src/aio-renderer.ts";

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

/** Inline useLocal (same logic as adapters/air.ts) to avoid adapter import complications */
function useLocal<T>(initial: T) {
  const ref = useRef<ReturnType<typeof signal<T>> | null>(null);
  if (!ref.current) ref.current = signal(initial);
  const sig = ref.current;
  return {
    get local(): T {
      return sig.value;
    },
    set: (next: T) => {
      sig.set(next);
    },
  };
}

// ── Test 1: Direct signal-triggered re-render with useLocal ──────────

Deno.test({
  name:
    "AIO-167: useLocal tab switch works after multiple round-trips (direct mount)",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    let tabSetter: (v: "a" | "b") => void;
    const Page = () => {
      const { local: tab, set: setTab } = useLocal<"a" | "b">("a");
      tabSetter = setTab;
      return h("div", { id: "page" }, h("span", null, `Tab: ${tab}`));
    };

    const App = () => h(Page, null);
    const handle = mount(root, App);
    assertEquals(root.querySelector("#page span")!.textContent, "Tab: a");

    // Round-trip 1: A→B
    tabSetter!("b");
    handle._flush();
    assertEquals(root.querySelector("#page span")!.textContent, "Tab: b");

    // Round-trip 1: B→A
    tabSetter!("a");
    handle._flush();
    assertEquals(root.querySelector("#page span")!.textContent, "Tab: a");

    // Round-trip 2: A→B — THIS IS WHERE AIO-167 FREEZES
    tabSetter!("b");
    handle._flush();
    assertEquals(root.querySelector("#page span")!.textContent, "Tab: b");

    // Round-trip 2: B→A
    tabSetter!("a");
    handle._flush();
    assertEquals(root.querySelector("#page span")!.textContent, "Tab: a");

    // Round-trip 3 (extra safety): A→B
    tabSetter!("b");
    handle._flush();
    assertEquals(root.querySelector("#page span")!.textContent, "Tab: b");

    _unmount(handle);
    await cleanup();
  },
});

// ── Test 2: useLocal after type-mismatch createDom (simulated router) ───

Deno.test({
  name:
    "AIO-167: useLocal survives type-mismatch createDom (simulated router switch)",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    // Simulate router: signal controls which "page" is shown
    const route = signal<"home" | "tabs">("home");

    let tabSetter: ((v: "a" | "b") => void) | null = null;

    const HomePage = () => h("div", { id: "home" }, "Home Page");

    const TabbedPage = () => {
      const { local: tab, set: setTab } = useLocal<"a" | "b">("a");
      tabSetter = setTab;
      return h(
        "div",
        { id: "tabbed" },
        h("span", { className: "tab-label" }, `Tab: ${tab}`),
      );
    };

    // Router-like component: different tags based on route → type-mismatch createDom
    const Router = () => {
      const r = route.value;
      return r === "home" ? h(HomePage, null) : h(TabbedPage, null);
    };

    const App = () => h("div", { id: "app" }, h(Router, null));
    const handle = mount(root, App);
    assertEquals(root.querySelector("#home")!.textContent, "Home Page");

    // Navigate to tabbed page (type-mismatch: HomePage→TabbedPage)
    route.set("tabs");
    handle._flush();
    assertEquals(root.querySelector(".tab-label")!.textContent, "Tab: a");

    // Tab A→B
    tabSetter!("b");
    handle._flush();
    assertEquals(root.querySelector(".tab-label")!.textContent, "Tab: b");

    // Tab B→A
    tabSetter!("a");
    handle._flush();
    assertEquals(root.querySelector(".tab-label")!.textContent, "Tab: a");

    // Tab A→B — THE CRITICAL THIRD SWITCH
    tabSetter!("b");
    handle._flush();
    assertEquals(
      root.querySelector(".tab-label")!.textContent,
      "Tab: b",
      "AIO-167: Third tab switch should update content but component is frozen",
    );

    // Tab B→A (fourth switch for good measure)
    tabSetter!("a");
    handle._flush();
    assertEquals(root.querySelector(".tab-label")!.textContent, "Tab: a");

    _unmount(handle);
    await cleanup();
  },
});

// ── Test 3: Full navigation round-trip then tab switch ──────────────

Deno.test({
  name:
    "AIO-167: useLocal works after navigate away and back (full round-trip)",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const route = signal<"home" | "tabs">("home");
    let tabSetter: ((v: "a" | "b") => void) | null = null;

    const HomePage = () => h("div", { id: "home" }, "Home");
    const TabbedPage = () => {
      const { local: tab, set: setTab } = useLocal<"a" | "b">("a");
      tabSetter = setTab;
      return h(
        "div",
        { id: "tabbed" },
        h("span", { className: "label" }, `Tab: ${tab}`),
      );
    };

    const Router = () => {
      const r = route.value;
      return r === "home" ? h(HomePage, null) : h(TabbedPage, null);
    };

    const App = () => h("div", null, h(Router, null));
    const handle = mount(root, App);

    // Navigate to tabs
    route.set("tabs");
    handle._flush();
    assertEquals(root.querySelector(".label")!.textContent, "Tab: a");

    // Switch tabs: A→B→A
    tabSetter!("b");
    handle._flush();
    assertEquals(root.querySelector(".label")!.textContent, "Tab: b");
    tabSetter!("a");
    handle._flush();
    assertEquals(root.querySelector(".label")!.textContent, "Tab: a");

    // Navigate away (destroys TabbedPage)
    route.set("home");
    handle._flush();
    assertEquals(root.querySelector("#home")!.textContent, "Home");

    // Navigate back (fresh TabbedPage via type-mismatch createDom)
    route.set("tabs");
    handle._flush();
    assertEquals(root.querySelector(".label")!.textContent, "Tab: a");

    // Now do the critical round-trip: A→B→A→B
    tabSetter!("b");
    handle._flush();
    assertEquals(root.querySelector(".label")!.textContent, "Tab: b");

    tabSetter!("a");
    handle._flush();
    assertEquals(root.querySelector(".label")!.textContent, "Tab: a");

    tabSetter!("b");
    handle._flush();
    assertEquals(
      root.querySelector(".label")!.textContent,
      "Tab: b",
      "AIO-167: useLocal frozen after navigate-back + round-trip tab switch",
    );

    tabSetter!("a");
    handle._flush();
    assertEquals(root.querySelector(".label")!.textContent, "Tab: a");

    _unmount(handle);
    await cleanup();
  },
});

// ── Test 4: Conditional component children (ternary on components) ───

Deno.test({
  name: "AIO-167: ternary component children survive round-trip tab switch",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const route = signal<"home" | "tabs">("home");
    let tabSetter: ((v: "a" | "b") => void) | null = null;

    const HomePage = () => h("div", { id: "home" }, "Home");
    const TableA = () =>
      h("table", { id: "tableA" }, h("tr", null, h("td", null, "A data")));
    const TableB = () =>
      h("table", { id: "tableB" }, h("tr", null, h("td", null, "B data")));

    const TabbedPage = () => {
      const { local: tab, set: setTab } = useLocal<"a" | "b">("a");
      tabSetter = setTab;
      const isA = tab === "a";
      return h(
        "div",
        { id: "tabbed" },
        h("span", null, `Active: ${tab}`),
        // Ternary on components — type mismatch each switch
        isA ? h(TableA, null) : h(TableB, null),
      );
    };

    const Router = () => {
      const r = route.value;
      return r === "home" ? h(HomePage, null) : h(TabbedPage, null);
    };

    const App = () => h("div", null, h(Router, null));
    const handle = mount(root, App);

    // Navigate to tabs
    route.set("tabs");
    handle._flush();
    assertEquals(
      !!root.querySelector("#tableA"),
      true,
      "TableA should be rendered",
    );
    assertEquals(
      root.querySelector("#tableB"),
      null,
      "TableB should not exist",
    );

    // A→B: type mismatch TableA→TableB
    tabSetter!("b");
    handle._flush();
    assertEquals(root.querySelector("#tableA"), null, "TableA should be gone");
    assertEquals(
      !!root.querySelector("#tableB"),
      true,
      "TableB should be rendered",
    );

    // B→A: type mismatch TableB→TableA
    tabSetter!("a");
    handle._flush();
    assertEquals(
      !!root.querySelector("#tableA"),
      true,
      "TableA should be back",
    );
    assertEquals(root.querySelector("#tableB"), null, "TableB should be gone");

    // A→B again — THE BUG: component frozen, TableA stays, TableB never appears
    tabSetter!("b");
    handle._flush();
    assertEquals(
      root.querySelector("#tableA"),
      null,
      "AIO-167: TableA should be gone but component is frozen",
    );
    assertEquals(
      !!root.querySelector("#tableB"),
      true,
      "AIO-167: TableB should appear but component is frozen",
    );

    // B→A again
    tabSetter!("a");
    handle._flush();
    assertEquals(!!root.querySelector("#tableA"), true);
    assertEquals(root.querySelector("#tableB"), null);

    _unmount(handle);
    await cleanup();
  },
});

// ── Test 5b: Async microtask-based flush (real browser timing) ───────

Deno.test({
  name: "AIO-167: useLocal round-trip with microtask flush (async scheduling)",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const route = signal<"home" | "tabs">("home");
    let tabSetter: ((v: "a" | "b") => void) | null = null;

    const HomePage = () => h("div", { id: "home" }, "Home");
    const TabbedPage = () => {
      const { local: tab, set: setTab } = useLocal<"a" | "b">("a");
      tabSetter = setTab;
      return h(
        "div",
        { id: "tabbed" },
        h("span", { className: "label" }, `Tab: ${tab}`),
      );
    };

    const Router = () => {
      const r = route.value;
      return r === "home" ? h(HomePage, null) : h(TabbedPage, null);
    };

    const App = () => h("div", null, h(Router, null));
    const handle = mount(root, App);

    // Helper: let microtask queue drain
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    // Navigate to tabs
    route.set("tabs");
    await tick();
    assertEquals(root.querySelector(".label")!.textContent, "Tab: a");

    // A→B
    tabSetter!("b");
    await tick();
    assertEquals(root.querySelector(".label")!.textContent, "Tab: b");

    // B→A
    tabSetter!("a");
    await tick();
    assertEquals(root.querySelector(".label")!.textContent, "Tab: a");

    // A→B — critical third switch
    tabSetter!("b");
    await tick();
    assertEquals(
      root.querySelector(".label")!.textContent,
      "Tab: b",
      "AIO-167: Third tab switch frozen (async)",
    );

    // B→A
    tabSetter!("a");
    await tick();
    assertEquals(
      root.querySelector(".label")!.textContent,
      "Tab: a",
      "AIO-167: Fourth tab switch frozen (async)",
    );

    // Navigate away and back, then try again
    route.set("home");
    await tick();
    route.set("tabs");
    await tick();
    assertEquals(root.querySelector(".label")!.textContent, "Tab: a");

    tabSetter!("b");
    await tick();
    assertEquals(root.querySelector(".label")!.textContent, "Tab: b");
    tabSetter!("a");
    await tick();
    assertEquals(root.querySelector(".label")!.textContent, "Tab: a");
    tabSetter!("b");
    await tick();
    assertEquals(
      root.querySelector(".label")!.textContent,
      "Tab: b",
      "AIO-167: Tab switch frozen after nav round-trip (async)",
    );

    _unmount(handle);
    await cleanup();
  },
});

// ── Test 5c: Multiple signals + ternary component children (async) ──

Deno.test({
  name: "AIO-167: ternary components + async flush after router navigation",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const route = signal<"home" | "tabs">("home");
    let tabSetter: ((v: "a" | "b") => void) | null = null;

    const HomePage = () => h("div", { id: "home" }, "Home");
    const CompA = () =>
      h("div", { className: "comp-a" }, "Component A content");
    const CompB = () =>
      h("div", { className: "comp-b" }, "Component B content");

    const TabbedPage = () => {
      const { local: tab, set: setTab } = useLocal<"a" | "b">("a");
      tabSetter = setTab;
      const isA = tab === "a";
      return h(
        "div",
        { id: "tabbed" },
        h("button", { onClick: () => setTab("a") }, "Tab A"),
        h("button", { onClick: () => setTab("b") }, "Tab B"),
        h("div", { className: "content" }, isA ? "Text A" : "Text B"),
        // Type-mismatch children (different component functions)
        isA ? h(CompA, null) : h(CompB, null),
      );
    };

    const Router = () =>
      route.value === "home" ? h(HomePage, null) : h(TabbedPage, null);
    const App = () => h("div", null, h(Router, null));
    const handle = mount(root, App);

    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    route.set("tabs");
    await tick();
    assertEquals(!!root.querySelector(".comp-a"), true);
    assertEquals(root.querySelector(".comp-b"), null);

    // 5 full round-trips
    for (let i = 0; i < 5; i++) {
      tabSetter!("b");
      await tick();
      assertEquals(
        root.querySelector(".comp-a"),
        null,
        `Round ${i + 1} A→B: CompA should be gone`,
      );
      assertEquals(
        !!root.querySelector(".comp-b"),
        true,
        `Round ${i + 1} A→B: CompB should exist`,
      );
      assertEquals(root.querySelector(".content")!.textContent, "Text B");

      tabSetter!("a");
      await tick();
      assertEquals(
        !!root.querySelector(".comp-a"),
        true,
        `Round ${i + 1} B→A: CompA should exist`,
      );
      assertEquals(
        root.querySelector(".comp-b"),
        null,
        `Round ${i + 1} B→A: CompB should be gone`,
      );
      assertEquals(root.querySelector(".content")!.textContent, "Text A");
    }

    _unmount(handle);
    await cleanup();
  },
});

// ── Test 6: Cycle detection doesn't create zombies ──────────────────

Deno.test({
  name: "AIO-167: cycle detection resets pendingRender (no zombie components)",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    // Create a component that writes to a signal during render (bad pattern)
    // This triggers the cycle detection. After the cycle is broken, the
    // component should NOT be permanently frozen — it should still respond
    // to user-initiated signal changes.
    const trigger = signal(0);
    const badWrite = signal(0);
    let renderCount = 0;

    const BadComponent = () => {
      renderCount++;
      const t = trigger.value;
      // Write to a signal during render on first few triggers (bad!)
      if (t > 0 && t <= 2) {
        badWrite.set(t); // This would cascade if something subscribes to badWrite
      }
      return h("div", { id: "bad" }, `render: ${renderCount}, trigger: ${t}`);
    };

    const App = () => h(BadComponent, null);
    const handle = mount(root, App);
    assertEquals(renderCount, 1);

    // Trigger re-render (doesn't cause cycle since t=1 sets badWrite but
    // nothing subscribes to badWrite from within the component tree)
    trigger.set(1);
    handle._flush();

    // After the cycle detection (if it fires) or normal processing,
    // the component should still be alive — not a zombie
    trigger.set(3); // t=3 doesn't trigger the bad write
    handle._flush();
    const content = root.querySelector("#bad")!.textContent!;
    assertEquals(
      content.includes("trigger: 3"),
      true,
      "Component should still respond to signals after cycle detection",
    );

    _unmount(handle);
    await cleanup();
  },
});

// ── Test 5: Verify signal subscription persists across re-renders ───

Deno.test({
  name: "AIO-167: signal subscription count stays correct across re-renders",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const sig = signal<"a" | "b">("a");
    let renderCount = 0;

    const Page = () => {
      renderCount++;
      const tab = sig.value; // Direct signal read (tracked)
      return h("div", null, `Tab: ${tab} (render #${renderCount})`);
    };

    const App = () => h(Page, null);
    const handle = mount(root, App);
    assertEquals(renderCount, 1);
    const subsBefore =
      (sig as unknown as { _subscribers: Set<unknown> })._subscribers.size;

    // Round-trip 1
    sig.set("b");
    handle._flush();
    assertEquals(renderCount, 2);
    sig.set("a");
    handle._flush();
    assertEquals(renderCount, 3);

    // Round-trip 2 — check subscription is still alive
    sig.set("b");
    handle._flush();
    assertEquals(
      renderCount,
      4,
      "AIO-167: component should re-render on 4th signal change",
    );
    sig.set("a");
    handle._flush();
    assertEquals(renderCount, 5);

    // Verify subscriber count hasn't leaked
    const subsAfter =
      (sig as unknown as { _subscribers: Set<unknown> })._subscribers.size;
    assertEquals(
      subsAfter,
      subsBefore,
      "Signal subscriber count should remain stable (no leaks)",
    );

    _unmount(handle);
    await cleanup();
  },
});
