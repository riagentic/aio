// Phase 4 Extras — renderer correctness tests + satellite module tests.
// Covers: rerender error recovery, onCleanup before re-render, useRef persistence,
// useSpring, useVirtualList, useForm, useFieldArray, devtools, dev warnings.

import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
} from "@std/assert";
import { Window } from "happy-dom";
import { computed, signal } from "../src/state/signal.ts";
import { Fragment, h } from "../src/air/vdom.ts";
import type { VNode } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  createContext,
  mount,
  onCleanup,
  onMount,
  setDevMode as setDevModeRenderer,
  useContext,
  useRef,
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
// P2-1: Signal-triggered rerender error recovery
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "rerender: error keeps old output and re-subscribes",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    const count = signal(0);
    let shouldThrow = false;

    const App = () => {
      const v = count.value;
      if (shouldThrow) throw new Error("render boom");
      return h("span", null, `count:${v}`);
    };

    const handle = m(App);
    assertEquals(root.innerHTML, "<span>count:0</span>");

    // Normal update
    count.set(1);
    handle._flush();
    assertEquals(root.innerHTML, "<span>count:1</span>");

    // Error during rerender — should keep old output
    shouldThrow = true;
    count.set(2);
    handle._flush();
    assertEquals(root.innerHTML, "<span>count:1</span>"); // old output preserved

    // Recovery — component should still be subscribed
    shouldThrow = false;
    count.set(3);
    handle._flush();
    assertEquals(root.innerHTML, "<span>count:3</span>"); // recovered
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// P2-2: onCleanup fires before re-render (not just unmount)
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "onCleanup: fires before each re-render",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    const count = signal(0);
    const cleanupLog: number[] = [];

    const App = () => {
      const v = count.value;
      onCleanup(() => cleanupLog.push(v));
      return h("span", null, `${v}`);
    };

    const handle = m(App);
    assertEquals(cleanupLog, []);

    // First re-render: cleanup from render-0 fires
    count.set(1);
    handle._flush();
    assertEquals(cleanupLog, [0]);

    // Second re-render: cleanup from render-1 fires
    count.set(2);
    handle._flush();
    assertEquals(cleanupLog, [0, 1]);

    // Unmount: cleanup from render-2 fires
    _unmount(handle);
    assertEquals(cleanupLog, [0, 1, 2]);
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// P2-3: useRef persists across re-renders
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useRef: persists same object across re-renders",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    const count = signal(0);
    const refValues: unknown[] = [];

    const App = () => {
      const ref = useRef({ data: "initial" });
      refValues.push(ref);
      const v = count.value;
      return h("span", null, `${v}-${ref.current.data}`);
    };

    const handle = m(App);
    assertEquals(root.innerHTML, "<span>0-initial</span>");

    // Mutate ref
    (refValues[0] as { current: { data: string } }).current.data = "mutated";

    count.set(1);
    handle._flush();
    assertEquals(root.innerHTML, "<span>1-mutated</span>");

    // Same ref object identity
    assert(
      refValues[0] === refValues[1],
      "useRef should return same object across renders",
    );
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// useSpring tests
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useSpring: initial value and immediate set",
  async fn() {
    const s = useSpring({ initial: 10 });
    assertEquals(s.value, 10);
    assertEquals(s.animating, false);

    s.set(50);
    assertEquals(s.value, 50);
    assertEquals(s.animating, false); // set() is immediate, no animation
  },
});

Deno.test({
  name: "useSpring: .to() in non-RAF env resolves immediately",
  async fn() {
    // In Deno test env there's no requestAnimationFrame, so .to() falls back to immediate
    const s = useSpring({ initial: 0 });
    s.to(100);
    assertEquals(s.value, 100);
    assertEquals(s.animating, false); // immediate fallback
  },
});

// ════════════════════════════════════════════════════════════════════
// useVirtualList tests
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useVirtualList: renders visible window with overscan",
  async fn() {
    const items = Array.from(
      { length: 100 },
      (_, i) => ({ id: i, name: `Item ${i}` }),
    );
    const vl = useVirtualList({
      items,
      itemHeight: 40,
      containerHeight: 200,
      overscan: 2,
    });

    // At scrollTop=0: visible = ceil(200/40) + 2*2 = 9 items, startIndex = max(0, 0-2) = 0
    assertEquals(vl.scrollTop, 0);
    assertEquals(vl.totalHeight, 4000); // 100 * 40
    assertEquals(vl.visible.length, 9); // 5 visible + 2*2 overscan
    assertEquals(vl.visible[0]!.index, 0);
    assertEquals(vl.visible[0]!.offset, 0);
    assertEquals(vl.visible[8]!.index, 8);
  },
});

Deno.test({
  name: "useVirtualList: scrollToIndex updates visible window",
  async fn() {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const vl = useVirtualList({
      items,
      itemHeight: 40,
      containerHeight: 200,
      overscan: 1,
    });

    vl.scrollToIndex(50); // scrollTop = 2000
    assertEquals(vl.scrollTop, 2000);
    // startIndex = max(0, floor(2000/40) - 1) = 49
    // visibleCount = ceil(200/40) + 2 = 7
    // endIndex = min(100, 49 + 7) = 56
    assertEquals(vl.visible[0]!.index, 49);
    assertEquals(vl.visible.length, 7);
  },
});

Deno.test({
  name: "useVirtualList: signal-backed items reactive",
  async fn() {
    const itemsSig = signal([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const vl = useVirtualList({
      items: itemsSig,
      itemHeight: 40,
      containerHeight: 200,
    });

    assertEquals(vl.visible.length, 3);
    assertEquals(vl.totalHeight, 120);

    // Add items
    itemsSig.set([...itemsSig.peek(), { id: 4 }, { id: 5 }]);
    assertEquals(vl.visible.length, 5);
    assertEquals(vl.totalHeight, 200);
  },
});

Deno.test({
  name: "useVirtualList: container and inner styles",
  async fn() {
    const items = [{ id: 1 }];
    const vl = useVirtualList({ items, itemHeight: 40, containerHeight: 300 });

    assertEquals(vl.containerStyle.overflow, "auto");
    assertEquals(vl.containerStyle.height, "300px");
    assertEquals(vl.innerStyle.height, "40px");
    assertEquals(vl.innerStyle.position, "relative");
  },
});

// ════════════════════════════════════════════════════════════════════
// useForm tests
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useForm: initial values and field state",
  async fn() {
    const form = useForm({
      name: { initial: "", rules: [(v: string) => v ? null : "Required"] },
      age: { initial: 0 },
    });

    assertEquals(form.fields.name.value, "");
    assertEquals(form.fields.name.dirty, false);
    assertEquals(form.fields.name.touched, false);
    assertEquals(form.fields.name.error, null);
    assertEquals(form.fields.age.value, 0);
  },
});

Deno.test({
  name: "useForm: set triggers dirty and validation on touched",
  async fn() {
    const form = useForm({
      email: {
        initial: "",
        rules: [(v: string) => v.includes("@") ? null : "Invalid email"],
      },
    });

    // Set value — dirty but no error yet (not touched)
    form.fields.email.set("hello");
    assertEquals(form.fields.email.dirty, true);
    assertEquals(form.fields.email.error, null);

    // Touch — triggers validation
    form.fields.email.touch();
    assertEquals(form.fields.email.touched, true);
    assertEquals(form.fields.email.error, "Invalid email");

    // Fix value — error clears on next set (since touched)
    form.fields.email.set("hello@example.com");
    assertEquals(form.fields.email.error, null);
  },
});

Deno.test({
  name: "useForm: validate() touches all and returns validity",
  async fn() {
    const form = useForm({
      a: { initial: "", rules: [(v: string) => v ? null : "Required"] },
      b: { initial: "ok" },
    });

    assertEquals(form.valid, true); // no errors yet (not touched)
    const result = form.validate();
    assertEquals(result, false);
    assertEquals(form.fields.a.error, "Required");
    assertEquals(form.fields.a.touched, true);
    assertEquals(form.valid, false);
  },
});

Deno.test({
  name: "useForm: reset clears all state",
  async fn() {
    const form = useForm({
      name: {
        initial: "default",
        rules: [(v: string) => v ? null : "Required"],
      },
    });

    form.fields.name.set("changed");
    form.fields.name.touch();
    assertEquals(form.fields.name.dirty, true);
    assertEquals(form.fields.name.touched, true);

    form.reset();
    assertEquals(form.fields.name.value, "default");
    assertEquals(form.fields.name.dirty, false);
    assertEquals(form.fields.name.touched, false);
    assertEquals(form.fields.name.error, null);
  },
});

Deno.test({
  name: "useForm: values() returns plain object",
  async fn() {
    const form = useForm({ x: { initial: 1 }, y: { initial: "hi" } });
    form.fields.x.set(42);
    assertEquals(form.values(), { x: 42, y: "hi" });
  },
});

Deno.test({
  name: "useForm: bind returns a SNAPSHOT of the field, plus its handlers",
  async fn() {
    // `bind()` used to return a live `get value()`. Its result goes straight to
    // `h()` as props, so the getter moved the read out of the render pass: the
    // component never SUBSCRIBED to the field, and `prev.value === next.value`
    // was unconditionally true (both getters read the same live field), so the
    // DOM value was never rewritten — `form.reset()` left the typed text on
    // screen. Each render calls `bind()` again; that call is the read.
    const form = useForm({ name: { initial: "" } });
    const bound = form.bind("name");
    assertEquals(bound.value, "");
    assertEquals(
      Object.getOwnPropertyDescriptor(bound, "value")?.get,
      undefined,
      "plain data, not a getter",
    );

    // Simulate input event
    const fakeEvent = { target: { value: "typed" } } as unknown as Event;
    bound.onInput(fakeEvent);
    assertEquals(form.fields.name.value, "typed");
    assertEquals(
      bound.value,
      "",
      "the OLD props still describe the old render",
    );
    assertEquals(form.bind("name").value, "typed", "the next render sees it");

    // Simulate blur
    bound.onBlur();
    assertEquals(form.fields.name.touched, true);
  },
});

// ════════════════════════════════════════════════════════════════════
// useFieldArray tests
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useFieldArray: push, remove, set, move, reset",
  async fn() {
    const arr = useFieldArray([{ name: "A" }, { name: "B" }]);

    assertEquals(arr.items.length, 2);
    assertEquals(arr.items[0]!.name, "A");

    // push
    arr.push({ name: "C" });
    assertEquals(arr.items.length, 3);
    assertEquals(arr.items[2]!.name, "C");

    // set
    arr.set(1, { name: "B2" });
    assertEquals(arr.items[1]!.name, "B2");

    // move
    arr.move(0, 2);
    assertEquals(arr.items[0]!.name, "B2");
    assertEquals(arr.items[2]!.name, "A");

    // remove
    arr.remove(1);
    assertEquals(arr.items.length, 2);

    // reset
    arr.reset();
    assertEquals(arr.items.length, 2);
    assertEquals(arr.items[0]!.name, "A");
    assertEquals(arr.items[1]!.name, "B");
  },
});

// ════════════════════════════════════════════════════════════════════
// DevTools tests
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "devtools: connect and disconnect",
  async fn() {
    const dt = connectAioDevTools();
    assertEquals(dt.connected, true);
    assertEquals(dt.totalRenders, 0);
    assertEquals(dt.renders.length, 0);
    // `tree` is no longer a per-handle buffer that starts empty: it is walked
    // from the LIVE AIR roots on demand (it used to be a signal nothing ever
    // wrote, so "empty" was the only value it could have). It reports whatever
    // this process has mounted, which this test does not own.
    assert(Array.isArray(dt.tree));

    _recordRender({
      component: "TestComp",
      timestamp: Date.now(),
      durationMs: 1.5,
      trigger: "signal",
    });
    assertEquals(dt.totalRenders, 1);
    assertEquals(dt.renders.length, 1);
    assertEquals(dt.renders[0]!.component, "TestComp");

    dt.disconnect();
    assertEquals(dt.connected, false);

    // After disconnect, recording is a no-op
    _recordRender({
      component: "IgnoredComp",
      timestamp: Date.now(),
      durationMs: 0.5,
      trigger: "mount",
    });
    assertEquals(dt.totalRenders, 1); // unchanged
  },
});

// ════════════════════════════════════════════════════════════════════
// Dev mode: excessive re-render warning
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "devMode: excessive re-render warning fires at limit",
  // sanitizers disabled: dev-mode uses a 1s debounce timer (_devRenderResetTimer)
  // that intentionally outlives the test — cannot be drained without breaking the API
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    setDevModeRenderer(true);

    const count = signal(0);
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => {
      if (msg.includes("[aio-dev]")) warnings.push(msg);
    };

    const Spinner = () => {
      const v = count.value;
      return h("span", null, `${v}`);
    };

    const handle = m(Spinner);

    // Trigger 50 rapid re-renders (DEV_RENDER_LIMIT = 50)
    for (let i = 1; i <= 50; i++) {
      count.set(i);
      handle._flush();
    }

    assert(
      warnings.some((w) => w.includes("re-rendered 50 times")),
      "Should warn about excessive re-renders",
    );

    console.warn = origWarn;
    setDevModeRenderer(false);
    _unmount(handle);
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// Multiple useRef calls in same component
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useRef: multiple refs in same component maintain identity",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    const trigger = signal(0);
    const refs: { a: unknown; b: unknown }[] = [];

    const App = () => {
      const a = useRef(0);
      const b = useRef("hello");
      refs.push({ a, b });
      const _ = trigger.value;
      return h("span", null, `${a.current}-${b.current}`);
    };

    const handle = m(App);
    assertEquals(root.innerHTML, "<span>0-hello</span>");

    // Mutate refs
    (refs[0]!.a as { current: number }).current = 42;
    (refs[0]!.b as { current: string }).current = "world";

    trigger.set(1);
    handle._flush();
    assertEquals(root.innerHTML, "<span>42-world</span>");

    // Same identity
    assert(refs[0]!.a === refs[1]!.a, "ref a should be same object");
    assert(refs[0]!.b === refs[1]!.b, "ref b should be same object");
    await cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// onMount fires only once
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "onMount: fires only on first render, not on re-render",
  async fn() {
    const { root, cleanup, mount: m } = setupMount();
    const count = signal(0);
    const mountLog: string[] = [];

    const App = () => {
      onMount(() => mountLog.push("mounted"));
      const v = count.value;
      return h("span", null, `${v}`);
    };

    const handle = m(App);
    assertEquals(mountLog, ["mounted"]);

    count.set(1);
    handle._flush();
    assertEquals(mountLog, ["mounted"]); // still just one

    count.set(2);
    handle._flush();
    assertEquals(mountLog, ["mounted"]); // still just one
    await cleanup();
  },
});

// ── AIO-76: onCleanup inside onMount must survive re-renders ────────

Deno.test({
  name: "AIO-76: onCleanup inside onMount runs only on unmount, not re-render",
  async fn() {
    const { root, mount: m, cleanup } = setupMount();

    const count = signal(0);
    let listenerActive = false;
    let cleanupCalls = 0;

    function App() {
      const c = count.value;
      onMount(() => {
        listenerActive = true;
        onCleanup(() => {
          listenerActive = false;
          cleanupCalls++;
        });
      });
      return h("div", null, String(c));
    }

    const handle = m(App);
    assertEquals(listenerActive, true);
    assertEquals(cleanupCalls, 0);

    // Re-render — mount cleanup must NOT fire
    count.set(1);
    handle._flush();
    assertEquals(listenerActive, true, "listener should survive re-render");
    assertEquals(cleanupCalls, 0, "mount cleanup should not fire on re-render");

    // Another re-render
    count.set(2);
    handle._flush();
    assertEquals(
      listenerActive,
      true,
      "listener should survive second re-render",
    );
    assertEquals(cleanupCalls, 0);

    // Unmount — NOW mount cleanup fires
    _unmount(handle);
    assertEquals(
      listenerActive,
      false,
      "listener should be cleaned up on unmount",
    );
    assertEquals(
      cleanupCalls,
      1,
      "mount cleanup should fire exactly once on unmount",
    );
    await cleanup();
  },
});

Deno.test({
  name: "AIO-76: body-level onCleanup still fires on re-render",
  async fn() {
    const { root, mount: m, cleanup } = setupMount();

    const count = signal(0);
    let bodyCleanupCalls = 0;

    function App() {
      const c = count.value;
      onCleanup(() => {
        bodyCleanupCalls++;
      });
      return h("div", null, String(c));
    }

    const handle = m(App);
    assertEquals(bodyCleanupCalls, 0);

    count.set(1);
    handle._flush();
    assertEquals(bodyCleanupCalls, 1, "body cleanup should fire on re-render");

    count.set(2);
    handle._flush();
    assertEquals(bodyCleanupCalls, 2, "body cleanup fires each re-render");

    _unmount(handle);
    assertEquals(bodyCleanupCalls, 3, "body cleanup also fires on unmount");
    await cleanup();
  },
});

Deno.test({
  name:
    "AIO-76: real pattern — addEventListener in onMount survives re-renders",
  async fn() {
    const { root, mount: m, cleanup, document: doc } = setupMount();

    const count = signal(0);
    const events: string[] = [];

    function App() {
      const c = count.value;
      onMount(() => {
        const handler = () => events.push("click");
        doc.addEventListener("click", handler);
        onCleanup(() => doc.removeEventListener("click", handler));
      });
      return h("div", null, String(c));
    }

    const handle = m(App);

    // Simulate click
    doc.dispatchEvent(new Event("click"));
    assertEquals(events, ["click"]);

    // Re-render — listener must survive
    count.set(1);
    handle._flush();
    doc.dispatchEvent(new Event("click"));
    assertEquals(events, ["click", "click"], "listener survived re-render");

    // Unmount — listener removed
    _unmount(handle);
    doc.dispatchEvent(new Event("click"));
    assertEquals(events, ["click", "click"], "listener removed after unmount");
    await cleanup();
  },
});
