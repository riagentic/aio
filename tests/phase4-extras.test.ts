// Phase 4 Extras — renderer correctness tests + satellite module tests.
// Covers: rerender error recovery, onCleanup before re-render, useRef persistence,
// useTransition, useSpring, useVirtualList, useForm, useFieldArray, devtools, dev warnings.

import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
} from "@std/assert";
import { Window } from "happy-dom";
import { computed, signal } from "../src/signal.ts";
import { Fragment, h } from "../src/vdom.ts";
import type { VNode } from "../src/vdom.ts";
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
// P2-1: Signal-triggered rerender error recovery
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "rerender: error keeps old output and re-subscribes",
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// P2-2: onCleanup fires before re-render (not just unmount)
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "onCleanup: fires before each re-render",
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// P2-3: useRef persists across re-renders
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useRef: persists same object across re-renders",
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// useTransition tests
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useTransition: starts idle, enter→active→exit→idle",
  ...S,
  async fn() {
    const t = useTransition({ name: "fade", duration: 50 });

    assertEquals(t.stage, "idle");
    assertEquals(t.mounted, false);
    assertEquals(t.className, "");

    // Enter
    t.enter();
    assertEquals(t.stage, "enter");
    assertEquals(t.mounted, true);
    assertEquals(t.className, "fade-enter");

    // Wait for enter→active transition (16ms setTimeout)
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(t.stage, "active");
    assertEquals(t.className, "fade-active");

    // Exit
    t.exit();
    assertEquals(t.stage, "exit");
    assertEquals(t.mounted, true);
    assertEquals(t.className, "fade-exit");

    // Wait for exit→idle (50ms duration)
    await new Promise((r) => setTimeout(r, 70));
    assertEquals(t.stage, "idle");
    assertEquals(t.mounted, false);
  },
});

Deno.test({
  name: "useTransition: toggle flips between enter and exit",
  ...S,
  async fn() {
    const t = useTransition({ name: "slide", duration: 50 });

    t.toggle(); // idle → enter
    assertEquals(t.stage, "enter");
    assertEquals(t.mounted, true);

    await new Promise((r) => setTimeout(r, 30));
    assertEquals(t.stage, "active");

    t.toggle(); // active → exit
    assertEquals(t.stage, "exit");

    await new Promise((r) => setTimeout(r, 70));
    assertEquals(t.stage, "idle");
    assertEquals(t.mounted, false);
  },
});

Deno.test({
  name: "useTransition: initial=true starts active",
  ...S,
  fn() {
    const t = useTransition({ name: "fade", duration: 300, initial: true });
    assertEquals(t.stage, "active");
    assertEquals(t.mounted, true);
    assertEquals(t.className, "fade-active");
  },
});

// ════════════════════════════════════════════════════════════════════
// useSpring tests
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useSpring: initial value and immediate set",
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
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
  ...S,
  fn() {
    const form = useForm({ x: { initial: 1 }, y: { initial: "hi" } });
    form.fields.x.set(42);
    assertEquals(form.values(), { x: 42, y: "hi" });
  },
});

Deno.test({
  name: "useForm: bind returns reactive props",
  ...S,
  fn() {
    const form = useForm({ name: { initial: "" } });
    const bound = form.bind("name");
    assertEquals(bound.value, "");

    // Simulate input event
    const fakeEvent = { target: { value: "typed" } } as unknown as Event;
    bound.onInput(fakeEvent);
    assertEquals(form.fields.name.value, "typed");
    assertEquals(bound.value, "typed");

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
  ...S,
  fn() {
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
  ...S,
  fn() {
    const dt = connectAioDevTools();
    assertEquals(dt.connected, true);
    assertEquals(dt.totalRenders, 0);
    assertEquals(dt.tree.length, 0);
    assertEquals(dt.renders.length, 0);

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
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// Multiple useRef calls in same component
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "useRef: multiple refs in same component maintain identity",
  ...S,
  fn() {
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
    cleanup();
  },
});

// ════════════════════════════════════════════════════════════════════
// onMount fires only once
// ════════════════════════════════════════════════════════════════════

Deno.test({
  name: "onMount: fires only on first render, not on re-render",
  ...S,
  fn() {
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
    cleanup();
  },
});
