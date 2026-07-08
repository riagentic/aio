import { assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import {
  _applyTransition,
  _generateKeyframes,
  _removeTransition,
  fade,
  scale,
  slide,
  type TransitionFn,
  type TransitionResult,
} from "../src/air/transition.ts";
import { Transition } from "../src/air/transition-component.ts";
import { TransitionGroup } from "../src/air/transition-group.ts";

// happy-dom timers drained via win.happyDOM.close() — sanitizers re-enabled

Deno.test({
  name: "fade: returns css function with correct duration",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const el = win.document.createElement("div") as unknown as HTMLElement;
    const result = fade(el, { duration: 200 });
    assertEquals(result.duration, 200);
    assertEquals(typeof result.css, "function");
    assertStringIncludes(result.css!(0, 1), "opacity");
    assertStringIncludes(result.css!(1, 0), "opacity");
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "fade: default duration is 300ms",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const el = win.document.createElement("div") as unknown as HTMLElement;
    const result = fade(el, {});
    assertEquals(result.duration, 300);
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "fade: css(0) returns opacity 0, css(1) returns opacity 1",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const el = win.document.createElement("div") as unknown as HTMLElement;
    const result = fade(el, {});
    assertEquals(result.css!(0, 1), "opacity: 0");
    assertEquals(result.css!(1, 0), "opacity: 1");
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "slide: returns css with transform translateY",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const el = win.document.createElement("div") as unknown as HTMLElement;
    const result = slide(el, { duration: 250 });
    assertEquals(result.duration, 250);
    assertStringIncludes(result.css!(0, 1), "translateY");
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "scale: returns css with transform scale",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const el = win.document.createElement("div") as unknown as HTMLElement;
    const result = scale(el, { duration: 200 });
    assertEquals(result.duration, 200);
    assertStringIncludes(result.css!(0, 1), "scale");
    await win.happyDOM.close();
  },
});

Deno.test("transition fn: tick alternative to css", () => {
  const ticks: number[] = [];
  const result: TransitionResult = {
    duration: 100,
    tick: (t: number) => {
      ticks.push(t);
    },
  };
  result.tick!(0, 1);
  result.tick!(0.5, 0.5);
  result.tick!(1, 0);
  assertEquals(ticks, [0, 0.5, 1]);
});

Deno.test({
  name: "fade: passes through delay and easing options",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const el = win.document.createElement("div") as unknown as HTMLElement;
    const result = fade(el, { duration: 200, delay: 50, easing: "linear" });
    assertEquals(result.delay, 50);
    assertEquals(result.easing, "linear");
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "slide: at t=1 has no translateY offset",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const el = win.document.createElement("div") as unknown as HTMLElement;
    const result = slide(el, {});
    assertStringIncludes(result.css!(1, 0), "translateY(0%");
    await win.happyDOM.close();
  },
});

// Type-level smoke test — ensures TransitionFn is assignable from each preset
const _typeFade: TransitionFn = fade;
const _typeSlide: TransitionFn = slide;
const _typeScale: TransitionFn = scale;
void _typeFade, _typeSlide, _typeScale;

// ── _generateKeyframes ───────────────────────────────────────────────

Deno.test({
  name: "_generateKeyframes: creates @keyframes with sampled steps",
  async fn() {
    const { name, rule } = _generateKeyframes((t) => `opacity: ${t}`, 10);
    assertEquals(typeof name, "string");
    assertStringIncludes(rule, "@keyframes");
    assertStringIncludes(rule, "opacity: 0");
    assertStringIncludes(rule, "opacity: 1");
    // Should have 11 frames (0% through 100%)
    const frameCount = (rule.match(/%/g) || []).length;
    assertEquals(frameCount, 11);
  },
});

Deno.test({
  name: "_generateKeyframes: names are unique",
  async fn() {
    const a = _generateKeyframes((t) => `opacity: ${t}`);
    const b = _generateKeyframes((t) => `opacity: ${t}`);
    assertEquals(a.name !== b.name, true);
  },
});

Deno.test({
  name: "_generateKeyframes: default 20 steps produces 21 frames",
  async fn() {
    const { rule } = _generateKeyframes((t) => `opacity: ${t}`);
    const frameCount = (rule.match(/%/g) || []).length;
    assertEquals(frameCount, 21);
  },
});

// ── _applyTransition / _removeTransition ────────────────────────────

Deno.test({
  name: "_applyTransition: applies animation style to element",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const doc = win.document as unknown as Document;
    const el = doc.createElement("div") as unknown as HTMLElement;
    doc.body.appendChild(el);
    const result = fade(el, { duration: 200 });
    const handle = _applyTransition(el, result, "in", doc);
    assertStringIncludes(el.style.animation, "200ms");
    assertStringIncludes(el.style.animation, "ease");
    _removeTransition(handle);
    assertEquals(el.style.animation, "");
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "_applyTransition: out direction reverses css function",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const doc = win.document as unknown as Document;
    const el = doc.createElement("div") as unknown as HTMLElement;
    doc.body.appendChild(el);
    const result = fade(el, { duration: 300 });
    const handle = _applyTransition(el, result, "out", doc);
    // The injected @keyframes should have reversed values (opacity starts at 1 for "out")
    assertStringIncludes(handle.styleEl.textContent!, "opacity: 1");
    _removeTransition(handle);
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "_applyTransition: injects style element into document head",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const doc = win.document as unknown as Document;
    const el = doc.createElement("div") as unknown as HTMLElement;
    doc.body.appendChild(el);
    const result = fade(el, { duration: 200 });
    const stylesBefore = doc.querySelectorAll("style").length;
    const handle = _applyTransition(el, result, "in", doc);
    const stylesAfter = doc.querySelectorAll("style").length;
    assertEquals(stylesAfter, stylesBefore + 1);
    _removeTransition(handle);
    // Style element should be removed
    assertEquals(doc.querySelectorAll("style").length, stylesBefore);
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "_applyTransition: preserves and restores previous animation",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const doc = win.document as unknown as Document;
    const el = doc.createElement("div") as unknown as HTMLElement;
    el.style.animation = "existing 1s linear";
    doc.body.appendChild(el);
    const result = fade(el, { duration: 200 });
    const handle = _applyTransition(el, result, "in", doc);
    assertEquals(handle.prevAnimation, "existing 1s linear");
    _removeTransition(handle);
    assertEquals(el.style.animation, "existing 1s linear");
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "_applyTransition: includes delay in animation shorthand",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const doc = win.document as unknown as Document;
    const el = doc.createElement("div") as unknown as HTMLElement;
    doc.body.appendChild(el);
    const result = fade(el, { duration: 200, delay: 100 });
    const handle = _applyTransition(el, result, "in", doc);
    assertStringIncludes(el.style.animation, "100ms");
    _removeTransition(handle);
    await win.happyDOM.close();
  },
});

// ── Deferred DOM removal (onBeforeRemove) ──────────────────────────

import { _diff, _render, getDom, h } from "../src/air/vdom.ts";
import type { RenderCtx } from "../src/air/vdom.ts";

Deno.test({
  name: "deferred removal: onBeforeRemove delays DOM removal",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const doc = win.document as unknown as Document;
    const root = doc.createElement("div");
    doc.body.appendChild(root);

    let removeDone: (() => void) | null = null;
    const ctx: RenderCtx = {
      doc,
      onBeforeRemove: () => {
        return new Promise<void>((resolve) => {
          removeDone = resolve;
        });
      },
    };

    const old = h("div", { id: "target" }, "hello");
    _render(root, old, null, ctx);
    assertEquals(root.childNodes.length, 1);

    // Diff to null — should NOT remove immediately
    _diff(root, null, old, ctx);
    assertEquals(root.childNodes.length, 1); // still in DOM

    // Resolve the promise
    removeDone!();
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(root.childNodes.length, 0); // now removed

    await win.happyDOM.close();
  },
});

Deno.test({
  name: "deferred removal: no hook means immediate removal",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const doc = win.document as unknown as Document;
    const root = doc.createElement("div");
    doc.body.appendChild(root);

    const ctx: RenderCtx = { doc };
    const old = h("div", { id: "target" }, "hello");
    _render(root, old, null, ctx);
    assertEquals(root.childNodes.length, 1);

    _diff(root, null, old, ctx);
    assertEquals(root.childNodes.length, 0); // immediately removed

    await win.happyDOM.close();
  },
});

Deno.test({
  name: "deferred removal: void return from hook means immediate removal",
  async fn() {
    const win = new Window({ url: "https://localhost" });
    const doc = win.document as unknown as Document;
    const root = doc.createElement("div");
    doc.body.appendChild(root);

    const ctx: RenderCtx = {
      doc,
      onBeforeRemove: () => {/* void — no promise */},
    };
    const old = h("div", { id: "target" }, "hello");
    _render(root, old, null, ctx);
    assertEquals(root.childNodes.length, 1);

    _diff(root, null, old, ctx);
    assertEquals(root.childNodes.length, 0); // immediately removed

    await win.happyDOM.close();
  },
});

Deno.test({
  name: "exports: transition API available from air modules",
  async fn() {
    // Verify transition exports directly (avoids full barrel → immer env dep)
    assertEquals(typeof fade, "function");
    assertEquals(typeof slide, "function");
    assertEquals(typeof scale, "function");
    assertEquals(typeof Transition, "function");
    assertEquals(typeof TransitionGroup, "function");
  },
});
