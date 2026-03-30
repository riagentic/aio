# AIR Evolution Phase 2: Animation System

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deferred DOM removal, CSS-first transition functions, and declarative `<Transition>` / `<TransitionGroup>` components to AIR.

**Architecture:** Deferred removal intercepts `removeDom()` when a transition is active, keeping the DOM node alive until the exit animation completes. Transition functions generate dynamic `@keyframes` or run JS-tick callbacks. `<Transition>` detects child enter/exit via VDOM diff and applies transition functions automatically.

**Tech Stack:** TypeScript, happy-dom (tests), CSS @keyframes generation, FLIP algorithm

---

### Task 1: Transition Function Types & Built-in Presets

**Files:**
- Create: `src/transition.ts`
- Test: `tests/transition.test.ts`

Define the transition function contract and provide `fade`, `slide`, `scale` presets.

- [ ] **Step 1: Write failing tests for transition function contract**

```ts
// tests/transition.test.ts
import { assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { fade, scale, slide, type TransitionFn } from "../src/transition.ts";

Deno.test("fade: returns css function with correct duration", () => {
  const win = new Window({ url: "https://localhost" });
  const el = win.document.createElement("div") as unknown as HTMLElement;
  const result = fade(el, { duration: 200 });
  assertEquals(result.duration, 200);
  assertEquals(typeof result.css, "function");
  assertStringIncludes(result.css!(0), "opacity");
  assertStringIncludes(result.css!(1), "opacity");
  win.close();
});

Deno.test("fade: default duration is 300ms", () => {
  const win = new Window({ url: "https://localhost" });
  const el = win.document.createElement("div") as unknown as HTMLElement;
  const result = fade(el, {});
  assertEquals(result.duration, 300);
  win.close();
});

Deno.test("slide: returns css with transform translateY", () => {
  const win = new Window({ url: "https://localhost" });
  const el = win.document.createElement("div") as unknown as HTMLElement;
  const result = slide(el, { duration: 250 });
  assertEquals(result.duration, 250);
  assertStringIncludes(result.css!(0), "translateY");
  win.close();
});

Deno.test("scale: returns css with transform scale", () => {
  const win = new Window({ url: "https://localhost" });
  const el = win.document.createElement("div") as unknown as HTMLElement;
  const result = scale(el, { duration: 200 });
  assertEquals(result.duration, 200);
  assertStringIncludes(result.css!(0), "scale");
  win.close();
});

Deno.test("transition fn: tick alternative to css", () => {
  const ticks: number[] = [];
  const result: TransitionResult = {
    duration: 100,
    tick: (t: number) => { ticks.push(t); },
  };
  result.tick!(0);
  result.tick!(0.5);
  result.tick!(1);
  assertEquals(ticks, [0, 0.5, 1]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/transition.test.ts -v`
Expected: FAIL — module not found

- [ ] **Step 3: Implement transition types and presets**

```ts
// src/transition.ts
// Transition functions — CSS-first animation primitives.
// Each function receives a DOM element and options, returns a TransitionResult
// describing how to animate. The `css` callback generates keyframe strings;
// `tick` is the JS fallback for effects CSS can't express.

/** Result returned by a transition function. */
export interface TransitionResult {
  /** Duration in ms. */
  duration: number;
  /** Optional delay in ms before the transition starts. */
  delay?: number;
  /** Optional easing (CSS easing string). Default "ease". */
  easing?: string;
  /** CSS keyframe generator. `t` goes 0→1 on enter, 1→0 on exit.
   *  Return a CSS string (e.g., `opacity: ${t}; transform: scale(${t})`). */
  css?: (t: number, u: number) => string;
  /** JS per-frame callback (fallback when CSS can't express the effect).
   *  `t` goes 0→1 on enter, 1→0 on exit. */
  tick?: (t: number, u: number) => void;
}

/** Options passed to transition functions. */
export interface TransitionOptions {
  duration?: number;
  delay?: number;
  easing?: string;
}

/** A transition function signature. */
export type TransitionFn = (
  node: HTMLElement,
  opts: TransitionOptions,
) => TransitionResult;

// ── Built-in presets ────────────────────────────────────────────────

/** Fade opacity 0↔1. */
export const fade: TransitionFn = (_node, opts) => ({
  duration: opts.duration ?? 300,
  delay: opts.delay,
  easing: opts.easing,
  css: (t) => `opacity: ${t}`,
});

/** Slide vertically via translateY. */
export const slide: TransitionFn = (_node, opts) => ({
  duration: opts.duration ?? 300,
  delay: opts.delay,
  easing: opts.easing,
  css: (t) => `transform: translateY(${(1 - t) * 100}%); opacity: ${t}`,
});

/** Scale from 0 to 1. */
export const scale: TransitionFn = (_node, opts) => ({
  duration: opts.duration ?? 300,
  delay: opts.delay,
  easing: opts.easing,
  css: (t) => `transform: scale(${t}); opacity: ${t}`,
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/transition.test.ts -v`
Expected: PASS

- [ ] **Step 5: Lint and type-check**

Run: `deno lint src/transition.ts && deno check src/transition.ts`

- [ ] **Step 6: Commit**

```bash
git add src/transition.ts tests/transition.test.ts
git commit -m "feat: transition function types and fade/slide/scale presets"
```

---

### Task 2: CSS @keyframes Generator

**Files:**
- Modify: `src/transition.ts` (add `_generateKeyframes`, `_applyTransition`, `_removeTransition`)
- Test: `tests/transition.test.ts` (add keyframe generation tests)

Generate dynamic `@keyframes` from transition `css()` functions and apply them as CSS animations.

- [ ] **Step 1: Write failing tests for keyframe generation**

```ts
Deno.test("_generateKeyframes: creates @keyframes with sampled steps", () => {
  const { name, rule } = _generateKeyframes((t) => `opacity: ${t}`, 10);
  assertEquals(typeof name, "string");
  assertStringIncludes(rule, "@keyframes");
  assertStringIncludes(rule, "opacity: 0");
  assertStringIncludes(rule, "opacity: 1");
});

Deno.test("_applyTransition: applies animation style to element", () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const el = doc.createElement("div");
  const style = doc.createElement("style");
  doc.head.appendChild(style);
  const handle = _applyTransition(el, {
    duration: 200,
    css: (t) => `opacity: ${t}`,
  }, "in", doc);
  assertStringIncludes(el.style.animation, "200ms");
  _removeTransition(handle, doc);
  win.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/transition.test.ts -v`
Expected: FAIL

- [ ] **Step 3: Implement keyframe generation and application**

Add to `src/transition.ts`:

```ts
// ── Keyframe generation ─────────────────────────────────────────────

let _counter = 0;
const KEYFRAME_STEPS = 20; // Sample points for CSS generation

/** Generate a unique @keyframes rule from a css() function.
 *  @internal */
export function _generateKeyframes(
  cssFn: (t: number, u: number) => string,
  steps = KEYFRAME_STEPS,
): { name: string; rule: string } {
  const name = `__aio_t_${++_counter}`;
  const frames: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const pct = (t * 100).toFixed(1);
    frames.push(`${pct}% { ${cssFn(t, 1 - t)} }`);
  }
  return { name, rule: `@keyframes ${name} { ${frames.join(" ")} }` };
}

/** Active transition handle for cleanup. */
export interface TransitionHandle {
  /** The generated keyframes name. */
  name: string;
  /** The <style> element injected into the document. */
  styleEl: HTMLStyleElement;
  /** The animated element. */
  el: HTMLElement;
  /** Saved inline animation style (to restore on cleanup). */
  prevAnimation: string;
}

/** Apply a CSS transition to an element.
 *  @param direction "in" = t goes 0→1, "out" = t goes 1→0
 *  @internal */
export function _applyTransition(
  el: HTMLElement,
  result: TransitionResult,
  direction: "in" | "out",
  doc: Document,
): TransitionHandle {
  const cssFn = result.css!;
  const fn = direction === "in"
    ? cssFn
    : (t: number, u: number) => cssFn(1 - t, 1 - u);
  const { name, rule } = _generateKeyframes(fn);
  const styleEl = doc.createElement("style");
  styleEl.textContent = rule;
  doc.head.appendChild(styleEl);

  const prevAnimation = el.style.animation;
  const easing = result.easing ?? "ease";
  const delay = result.delay ?? 0;
  el.style.animation = `${name} ${result.duration}ms ${easing} ${delay}ms both`;

  return { name, styleEl, el, prevAnimation };
}

/** Remove a CSS transition and clean up injected styles.
 *  @internal */
export function _removeTransition(
  handle: TransitionHandle,
  _doc: Document,
): void {
  handle.el.style.animation = handle.prevAnimation;
  handle.styleEl.remove();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/transition.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/transition.ts tests/transition.test.ts
git commit -m "feat: CSS @keyframes generation and transition application"
```

---

### Task 3: Deferred DOM Removal in VDOM Reconciler

**Files:**
- Modify: `src/vdom.ts` (intercept `removeDom` for deferred removal)
- Modify: `src/vdom.ts` (add `onRemove` hook to `VDomHooks`)
- Test: `tests/transition.test.ts` (add deferred removal tests)

The `removeDom()` function currently calls `parent.removeChild(dom)` immediately. Add a hook that can defer this removal.

- [ ] **Step 1: Write failing tests for deferred removal**

```ts
import { _diff, _render, getDom, h, Fragment } from "../src/vdom.ts";

Deno.test("deferred removal: onBeforeRemove hook delays DOM removal", () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);

  let removeDone: (() => void) | null = null;
  const ctx = {
    doc,
    hooks: undefined,
    onBeforeRemove: (el: Node): Promise<void> | void => {
      return new Promise<void>((resolve) => { removeDone = resolve; });
    },
  };

  // Render a div
  const old = h("div", { id: "target" }, "hello");
  _render(root, old, null, ctx);
  assertEquals(root.childNodes.length, 1);

  // Diff to null — should NOT remove immediately because hook returns promise
  _diff(root, null, old, ctx);
  assertEquals(root.childNodes.length, 1); // still in DOM (deferred)

  // Complete the removal
  removeDone!();
  // After microtask, node should be gone
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(root.childNodes.length, 0);

  win.close();
});

Deno.test("deferred removal: safety timeout removes after max wait", () => {
  // ... test that even if promise never resolves, node is removed after timeout
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/transition.test.ts -v`
Expected: FAIL

- [ ] **Step 3: Add onBeforeRemove to RenderCtx and intercept removeDom**

In `src/vdom.ts`, add to `RenderCtx`:

```ts
export interface RenderCtx {
  doc: Document;
  hooks?: VDomHooks;
  onLazyResolve?: () => void;
  /** Called before a DOM element is removed. Return a Promise to defer removal
   *  (e.g., for exit animations). The element stays in DOM until the promise resolves.
   *  A safety timeout (default 5s) removes the element if the promise stalls. */
  onBeforeRemove?: (el: HTMLElement, vnode: VNode) => Promise<void> | void;
}
```

Modify `removeDom()` — at the point where `parent.removeChild(dom)` is called, check `ctx.onBeforeRemove`:

```ts
// In removeDom(), replace the final removeChild block:
const dom = getDom(vnode);
if (dom && dom.parentNode === parent) {
  if (ctx.onBeforeRemove && dom instanceof (ctx.doc.defaultView?.HTMLElement ?? HTMLElement)) {
    const promise = ctx.onBeforeRemove(dom as HTMLElement, vnode as VNode);
    if (promise && typeof promise.then === "function") {
      // Deferred removal
      const timeout = setTimeout(() => {
        if (dom.parentNode === parent) parent.removeChild(dom);
      }, 5000);
      promise.then(() => {
        clearTimeout(timeout);
        if (dom.parentNode === parent) parent.removeChild(dom);
      });
      return;
    }
  }
  parent.removeChild(dom);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/transition.test.ts -v`
Expected: PASS

- [ ] **Step 5: Run existing renderer tests to verify no regressions**

Run: `deno test tests/renderer.test.ts tests/signal.test.ts tests/watch.test.ts tests/signal-evolution.test.ts -v`
Expected: 83 PASS, 0 FAIL

- [ ] **Step 6: Commit**

```bash
git add src/vdom.ts tests/transition.test.ts
git commit -m "feat: deferred DOM removal via onBeforeRemove hook"
```

---

### Task 4: `<Transition>` Component

**Files:**
- Create: `src/transition-component.ts`
- Test: `tests/transition-component.test.ts`

Declarative component that detects child enter/exit and applies transition functions.

- [ ] **Step 1: Write failing tests**

```ts
// tests/transition-component.test.ts
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/signal.ts";
import { h } from "../src/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/aio-renderer.ts";
import { Transition } from "../src/transition-component.ts";
import { fade } from "../src/transition.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { win, doc, root };
}

Deno.test({
  name: "Transition: enter animation applies on mount",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const show = signal(true);
    const App = () =>
      h(Transition, { enter: fade, exit: fade },
        show.value ? h("div", { id: "box" }, "hello") : null);
    const handle = mount(root, App);
    const box = root.querySelector("#box");
    assertEquals(box !== null, true);
    // Verify animation was applied
    assertEquals(box!.style.animation !== "", true);
    _unmount(handle);
    win.close();
  },
});

Deno.test({
  name: "Transition: child removal is deferred during exit",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const show = signal(true);
    const App = () =>
      h(Transition, { enter: fade, exit: fade },
        show.value ? h("div", { id: "box" }, "hello") : null);
    const handle = mount(root, App);
    assertEquals(root.querySelector("#box") !== null, true);
    // Trigger exit
    show.set(false);
    handle._flush();
    // Element should still be in DOM (deferred removal for exit animation)
    assertEquals(root.querySelector("#box") !== null, true);
    // After animation duration, element removed
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(root.querySelector("#box"), null);
    _unmount(handle);
    win.close();
  },
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test tests/transition-component.test.ts -v`
Expected: FAIL

- [ ] **Step 3: Implement `<Transition>` component**

```ts
// src/transition-component.ts
// <Transition> — declarative enter/exit animations for a single child.
// Detects when child appears/disappears in the VDOM and applies transition functions.

import type { VNode } from "./vdom.ts";
import { h } from "./vdom.ts";
import {
  _applyTransition,
  _removeTransition,
  type TransitionFn,
  type TransitionHandle,
  type TransitionOptions,
  type TransitionResult,
} from "./transition.ts";

/** Props for the <Transition> component. */
export interface TransitionProps {
  /** Transition function for entering. */
  enter?: TransitionFn;
  /** Transition function for exiting. */
  exit?: TransitionFn;
  /** Transition options (duration, delay, easing). */
  options?: TransitionOptions;
  /** Sequencing mode: "out-in" exits old before entering new. Default: simultaneous. */
  mode?: "out-in" | "in-out";
  /** Children — should be a single conditional child. */
  children: (VNode | string | number | null | undefined)[];
}

export function Transition(props: TransitionProps): VNode | null {
  // Implementation: wrapper that sets up onBeforeRemove on the render context
  // to intercept child removal and apply exit transitions.
  // Enter transitions are applied via afterRender + onMount.

  const child = props.children.find((c) => c != null) ?? null;
  if (child == null) return null;
  if (typeof child !== "object") return child as unknown as VNode;

  // Wrap child to inject transition behavior
  return h(_TransitionWrapper, {
    enter: props.enter,
    exit: props.exit,
    options: props.options ?? {},
    mode: props.mode,
  }, child);
}
```

The `_TransitionWrapper` is an internal component that uses `onMount` to apply enter transitions and registers deferred removal for exit transitions via the renderer's `onBeforeRemove` hook.

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test tests/transition-component.test.ts -v`
Expected: PASS

- [ ] **Step 5: Run full test suite for regressions**

Run: `deno test tests/renderer.test.ts tests/transition.test.ts tests/transition-component.test.ts -v`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/transition-component.ts tests/transition-component.test.ts
git commit -m "feat: <Transition> component with enter/exit animations"
```

---

### Task 5: Wire onBeforeRemove into AIO Renderer

**Files:**
- Modify: `src/aio-renderer.ts` (set `onBeforeRemove` on render context when `<Transition>` is in tree)
- Modify: `src/transition-component.ts` (complete integration)
- Test: `tests/transition-component.test.ts` (add more integration tests)

Connect the `<Transition>` component to the deferred removal system. When a `<Transition>` wraps a child that disappears, the exit transition function runs and defers DOM removal until complete.

- [ ] **Step 1: Write failing integration tests**

```ts
Deno.test({
  name: "Transition: mode out-in sequences exit before enter",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const which = signal<"a" | "b">("a");
    const App = () =>
      h(Transition, { enter: fade, exit: fade, mode: "out-in" },
        which.value === "a"
          ? h("div", { id: "a" }, "A")
          : h("div", { id: "b" }, "B"));
    const handle = mount(root, App);
    assertEquals(root.querySelector("#a") !== null, true);
    // Switch to B
    which.set("b");
    handle._flush();
    // A should still be visible (exiting), B not yet
    assertEquals(root.querySelector("#a") !== null, true);
    // After exit duration, A gone and B enters
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(root.querySelector("#a"), null);
    assertEquals(root.querySelector("#b") !== null, true);
    _unmount(handle);
    win.close();
  },
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Complete the integration**

In `src/aio-renderer.ts`, when creating the render context, set `onBeforeRemove` to check if the element is wrapped in a `<Transition>` and run the exit transition:

The `<Transition>` component registers its exit function on the VDOM node it wraps. The renderer's `onBeforeRemove` hook checks for this registration and applies the exit transition, returning a promise that resolves when the animation completes.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/aio-renderer.ts src/transition-component.ts tests/transition-component.test.ts
git commit -m "feat: wire <Transition> exit animations to deferred DOM removal"
```

---

### Task 6: `<TransitionGroup>` with FLIP

**Files:**
- Create: `src/transition-group.ts`
- Test: `tests/transition-group.test.ts`

Animate list additions, removals, and reordering using FLIP algorithm.

- [ ] **Step 1: Write failing tests**

```ts
Deno.test({
  name: "TransitionGroup: enter animation on new items",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const items = signal(["a", "b"]);
    const App = () =>
      h(TransitionGroup, { enter: fade, exit: fade },
        ...items.value.map((id) => h("div", { key: id, id }, id)));
    const handle = mount(root, App);
    assertEquals(root.querySelectorAll("div").length, 2);
    // Add item
    items.set(["a", "b", "c"]);
    handle._flush();
    assertEquals(root.querySelectorAll("div").length, 3);
    const c = root.querySelector("#c");
    assertEquals(c !== null, true);
    // c should have enter animation
    assertEquals(c!.style.animation !== "", true);
    _unmount(handle);
    win.close();
  },
});

Deno.test({
  name: "TransitionGroup: exit animation defers removal",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const items = signal(["a", "b", "c"]);
    const App = () =>
      h(TransitionGroup, { enter: fade, exit: fade },
        ...items.value.map((id) => h("div", { key: id, id }, id)));
    const handle = mount(root, App);
    assertEquals(root.querySelectorAll("div").length, 3);
    // Remove middle item
    items.set(["a", "c"]);
    handle._flush();
    // b should still be in DOM (exit animation in progress)
    assertEquals(root.querySelector("#b") !== null, true);
    // After animation
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(root.querySelector("#b"), null);
    _unmount(handle);
    win.close();
  },
});

Deno.test({
  name: "TransitionGroup: FLIP reorders smoothly",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const items = signal(["a", "b", "c"]);
    const App = () =>
      h(TransitionGroup, { enter: fade, exit: fade, flip: true },
        ...items.value.map((id) => h("div", { key: id, id }, id)));
    const handle = mount(root, App);
    // Reorder
    items.set(["c", "a", "b"]);
    handle._flush();
    // All items still present
    assertEquals(root.querySelectorAll("div").length, 3);
    // First child is now "c"
    assertEquals(root.querySelector("div")!.id, "c");
    _unmount(handle);
    win.close();
  },
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement TransitionGroup**

```ts
// src/transition-group.ts
// <TransitionGroup> — animate list enter/exit/reorder with FLIP.

import type { VNode } from "./vdom.ts";
import { h } from "./vdom.ts";
import type { TransitionFn, TransitionOptions } from "./transition.ts";

export interface TransitionGroupProps {
  enter?: TransitionFn;
  exit?: TransitionFn;
  options?: TransitionOptions;
  /** Enable FLIP animation for reordering. Default false. */
  flip?: boolean;
  /** FLIP transition duration in ms. Default 300. */
  flipDuration?: number;
  children: (VNode | string | number)[];
}

export function TransitionGroup(props: TransitionGroupProps): VNode {
  // Track previous children keys and their DOM positions (for FLIP).
  // On diff:
  //   - New keys → apply enter transition
  //   - Removed keys → apply exit transition (deferred removal)
  //   - Moved keys → FLIP: record old rect, let DOM update, apply inverse transform, animate to zero
  // ... implementation
}
```

FLIP algorithm implementation:
1. Before DOM update: `getBoundingClientRect()` for each keyed child
2. After DOM update: get new rects
3. For each moved child: apply `transform: translate(dx, dy)` (inverse delta)
4. Next frame: remove transform, let CSS transition animate to final position

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Run full test suite**

Run: `deno test tests/transition.test.ts tests/transition-component.test.ts tests/transition-group.test.ts tests/renderer.test.ts -v`

- [ ] **Step 6: Commit**

```bash
git add src/transition-group.ts tests/transition-group.test.ts
git commit -m "feat: <TransitionGroup> with FLIP reorder animation"
```

---

### Task 7: Export Wiring & Existing Animation API Cleanup

**Files:**
- Modify: `src/animation.ts` (keep useSpring, deprecate old useTransition)
- Modify: `src/air.ts` (export new transition API)
- Modify: `src/browser-air.ts` (re-export)
- Test: `tests/transition.test.ts` (add export verification)

Wire new APIs through barrel exports and clean up the old `useTransition` which is superseded by `<Transition>`.

- [ ] **Step 1: Write export verification test**

```ts
Deno.test("exports: transition API available from air barrel", async () => {
  const air = await import("../src/air.ts");
  assertEquals(typeof air.fade, "function");
  assertEquals(typeof air.slide, "function");
  assertEquals(typeof air.scale, "function");
  assertEquals(typeof air.Transition, "function");
  assertEquals(typeof air.TransitionGroup, "function");
  // useSpring should still be available
  assertEquals(typeof air.useSpring, "function");
});
```

- [ ] **Step 2: Add exports to air.ts and browser-air.ts**

In `src/air.ts`:
```ts
// ── Transitions ─────────────────────────────────────────────────────
export { fade, scale, slide, Transition, TransitionGroup } from "./transition.ts";
export type { TransitionFn, TransitionOptions, TransitionResult } from "./transition.ts";
export { Transition } from "./transition-component.ts";
export type { TransitionProps } from "./transition-component.ts";
export { TransitionGroup } from "./transition-group.ts";
export type { TransitionGroupProps } from "./transition-group.ts";
```

- [ ] **Step 3: Deprecate old useTransition**

In `src/animation.ts`, add deprecation notice to `useTransition`:
```ts
/** @deprecated Use `<Transition>` component with transition functions instead. */
export function useTransition(config: TransitionConfig): TransitionState {
```

- [ ] **Step 4: Run all tests**

Run: `deno test tests/transition.test.ts tests/transition-component.test.ts tests/transition-group.test.ts tests/renderer.test.ts tests/signal.test.ts tests/watch.test.ts tests/signal-evolution.test.ts -v`

- [ ] **Step 5: Lint and type-check all modified files**

Run: `deno check src/air.ts src/transition.ts src/transition-component.ts src/transition-group.ts && deno lint src/transition.ts src/transition-component.ts src/transition-group.ts`

- [ ] **Step 6: Commit**

```bash
git add src/air.ts src/browser-air.ts src/animation.ts src/transition.ts src/transition-component.ts src/transition-group.ts tests/transition.test.ts
git commit -m "feat: export transition API, deprecate old useTransition"
```

---

### Task 8: Integration Tests & Edge Cases

**Files:**
- Create: `tests/transition-integration.test.ts`

End-to-end tests for combined scenarios.

- [ ] **Step 1: Write integration tests**

```ts
Deno.test("integration: Transition inside conditional rendering", ...);
Deno.test("integration: nested Transitions", ...);
Deno.test("integration: TransitionGroup + signal-driven list", ...);
Deno.test("integration: Transition with tick (JS) fallback", ...);
Deno.test("integration: safety timeout removes element if animation stalls", ...);
Deno.test("integration: Transition enter + immediate exit (rapid toggle)", ...);
```

Key scenarios:
- Rapid show/hide toggling (cancel in-progress animation, start new one)
- Nested transitions (outer exits while inner is animating)
- TransitionGroup with simultaneous add+remove+reorder
- JS tick fallback when `css` is not provided
- Safety timeout (5s) removes element even if promise never resolves
- `mode="out-in"` with rapid switching

- [ ] **Step 2: Run tests**

- [ ] **Step 3: Fix any issues found**

- [ ] **Step 4: Final lint + type-check + full test suite**

Run: `deno check mod.ts && deno lint src/transition.ts src/transition-component.ts src/transition-group.ts`
Run: `deno test tests/transition.test.ts tests/transition-component.test.ts tests/transition-group.test.ts tests/transition-integration.test.ts tests/renderer.test.ts tests/signal.test.ts tests/watch.test.ts tests/signal-evolution.test.ts`

- [ ] **Step 5: Commit**

```bash
git add tests/transition-integration.test.ts
git commit -m "test: transition integration tests and edge cases"
```
