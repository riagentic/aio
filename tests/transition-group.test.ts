import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/state/signal.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { TransitionGroup } from "../src/air/transition-group.ts";
import { fade } from "../src/air/transition.ts";

// happy-dom timers drained via win.happyDOM.close() — sanitizers enabled

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { win, doc, root };
}

Deno.test({
  name: "TransitionGroup: renders keyed children",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const items = signal(["a", "b", "c"]);
    const App = () =>
      h(
        TransitionGroup,
        { enter: fade, exit: fade },
        ...items.value.map((id) => h("div", { key: id, id }, id)),
      );
    const handle = mount(root, App);
    // Should render all 3 items inside wrapper span
    const wrapper = root.querySelector("span");
    assertEquals(wrapper !== null, true);
    assertEquals(wrapper!.querySelectorAll("div").length, 3);
    // Wait for enter animation timers to complete before unmount
    await new Promise((r) => setTimeout(r, 350));
    _unmount(handle);
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "TransitionGroup: new items get enter animation",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const items = signal(["a", "b"]);
    const App = () =>
      h(
        TransitionGroup,
        { enter: fade, exit: fade },
        ...items.value.map((id) => h("div", { key: id, id }, id)),
      );
    const handle = mount(root, App);
    assertEquals(root.querySelectorAll("div").length, 2);

    // Add item
    items.set(["a", "b", "c"]);
    handle._flush();
    assertEquals(root.querySelectorAll("div").length, 3);

    // New item "c" should have enter animation
    const c = root.querySelector("#c") as HTMLElement;
    assertEquals(c !== null, true);
    assertEquals(c.style.animation !== "", true);

    // Wait for enter animation timers to complete before unmount
    await new Promise((r) => setTimeout(r, 350));
    _unmount(handle);
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "TransitionGroup: removed items have deferred exit",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const items = signal(["a", "b", "c"]);
    const App = () =>
      h(
        TransitionGroup,
        { enter: fade, exit: fade },
        ...items.value.map((id) => h("div", { key: id, id }, id)),
      );
    const handle = mount(root, App);
    assertEquals(root.querySelectorAll("div").length, 3);

    // Remove middle item
    items.set(["a", "c"]);
    handle._flush();

    // "b" should still be in DOM (exit animation in progress)
    assertEquals(root.querySelector("#b") !== null, true);

    // After animation duration
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(root.querySelector("#b"), null);

    _unmount(handle);
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "TransitionGroup: reorder preserves all items",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const items = signal(["a", "b", "c"]);
    const App = () =>
      h(
        TransitionGroup,
        { enter: fade, exit: fade },
        ...items.value.map((id) => h("div", { key: id, id }, id)),
      );
    const handle = mount(root, App);

    // Reorder
    items.set(["c", "a", "b"]);
    handle._flush();

    // All items still present
    assertEquals(root.querySelectorAll("div").length, 3);
    assertEquals(root.querySelector("#a") !== null, true);
    assertEquals(root.querySelector("#b") !== null, true);
    assertEquals(root.querySelector("#c") !== null, true);

    // Wait for FLIP animation timers to complete before unmount
    await new Promise((r) => setTimeout(r, 400));
    _unmount(handle);
    await win.happyDOM.close();
  },
});

Deno.test({
  name: "TransitionGroup: works with empty list",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const items = signal<string[]>([]);
    const App = () =>
      h(
        TransitionGroup,
        { enter: fade, exit: fade },
        ...items.value.map((id) => h("div", { key: id, id }, id)),
      );
    const handle = mount(root, App);
    assertEquals(root.querySelectorAll("div").length, 0);
    _unmount(handle);
    // No animations started — no wait needed
    await win.happyDOM.close();
  },
});

// ── FLIP: measure the LAYOUT, and let the transition end only when it ends ──
//
// These drive FLIP through a fake layout whose `getBoundingClientRect()`
// INCLUDES the element's current transform — which is what a real browser
// does, and the property every defect below turns on. happy-dom's default
// rect is 0×0 at 0,0 and ignores transforms, so without this model a test here
// passes with the defects restored (verified).
function fakeLayout(win: Window, doc: Document) {
  const tops = new Map<string, number>();
  // deno-lint-ignore no-explicit-any
  (win as any).Element.prototype.getBoundingClientRect = function (
    // deno-lint-ignore no-explicit-any
    this: any,
  ) {
    const base = tops.get(this.id) ?? 0;
    const m = /translate\(\s*[-\d.]+px\s*,\s*([-\d.]+)px\s*\)/.exec(
      this.style?.transform ?? "",
    );
    const top = base + (m ? parseFloat(m[1]!) : 0);
    return {
      top,
      left: 0,
      bottom: top + 20,
      right: 100,
      width: 100,
      height: 20,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return {
    set: (layout: Record<string, number>) => {
      for (const [id, top] of Object.entries(layout)) tops.set(id, top);
    },
    doc,
  };
}

const raf = () => new Promise((r) => setTimeout(r, 30));

Deno.test({
  name:
    "TransitionGroup: FLIP remembers where an item LANDED, not where it looked",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const layout = fakeLayout(win, doc);
    layout.set({ a: 0, b: 20 });
    const items = signal(["a", "b"]);
    const App = () =>
      h(
        TransitionGroup,
        { flip: true, flipDuration: 50 },
        ...items.value.map((id) => h("div", { key: id, id }, id)),
      );
    const handle = mount(root, App);

    // Reorder: a and b swap places.
    items.set(["b", "a"]);
    layout.set({ a: 20, b: 0 });
    handle._flush();
    const a = root.querySelector("#a") as HTMLElement;
    assertEquals(
      a.style.transform,
      "translate(0px, -20px)",
      "FLIP starts the moved item at its old position",
    );
    await raf();

    // Swap back. The reference rect saved by the pass above must be a's NEW
    // LAYOUT position (20), not the pre-move position it was still visually
    // sitting at when the old code re-measured after applying the transform.
    // With the stale rect, dy is 0 and the second reorder does not animate at
    // all — the list jumps.
    items.set(["a", "b"]);
    layout.set({ a: 0, b: 20 });
    handle._flush();
    assertEquals(
      a.style.transform,
      "translate(0px, 20px)",
      "the second reorder animates from where the item actually was",
    );

    await new Promise((r) => setTimeout(r, 150));
    _unmount(handle);
    await win.happyDOM.close();
  },
});

Deno.test({
  name:
    "TransitionGroup: a descendant's transitionend does not end the item's FLIP",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const layout = fakeLayout(win, doc);
    layout.set({ a: 0, b: 20 });
    const items = signal(["a", "b"]);
    const App = () =>
      h(
        TransitionGroup,
        { flip: true, flipDuration: 200 },
        ...items.value.map((id) =>
          h("div", { key: id, id }, h("button", { id: `${id}-btn` }, id))
        ),
      );
    const handle = mount(root, App);
    items.set(["b", "a"]);
    layout.set({ a: 20, b: 0 });
    handle._flush();
    await raf(); // the play frame attaches the transitionend listener

    const a = root.querySelector("#a") as HTMLElement;
    assertEquals(a.style.transition.includes("transform"), true, "animating");

    // A button inside the moving row finishes its own hover transition.
    // `transitionend` BUBBLES: unfiltered, this ended the row's FLIP early and
    // snapped it to its final position mid-slide.
    const btn = root.querySelector("#a-btn") as HTMLElement;
    // deno-lint-ignore no-explicit-any
    const ev = new (win as any).Event("transitionend", { bubbles: true });
    ev.propertyName = "background-color";
    btn.dispatchEvent(ev);
    assertEquals(
      a.style.transition.includes("transform"),
      true,
      "only this element's own transform ends its FLIP",
    );

    await new Promise((r) => setTimeout(r, 300));
    _unmount(handle);
    await win.happyDOM.close();
  },
});

Deno.test({
  name:
    "TransitionGroup: the FLIP safety timer is CLEARED when the transition ends",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);
    const layout = fakeLayout(win, doc);
    layout.set({ a: 0, b: 20 });
    const items = signal(["a", "b"]);
    const App = () =>
      h(
        TransitionGroup,
        { flip: true, flipDuration: 40 },
        ...items.value.map((id) => h("div", { key: id, id }, id)),
      );
    const handle = mount(root, App);
    items.set(["b", "a"]);
    layout.set({ a: 20, b: 0 });
    handle._flush();
    await raf();

    const a = root.querySelector("#a") as HTMLElement;
    // The real transition ends normally.
    // deno-lint-ignore no-explicit-any
    const ev = new (win as any).Event("transitionend", { bubbles: true });
    ev.propertyName = "transform";
    a.dispatchEvent(ev);
    assertEquals(a.style.transition, "", "cleanup ran");

    // Whatever the app does next with this element must survive: deleting the
    // map entry without clearing the timeout left an ARMED orphan holding the
    // old closure, which then fired into an unrelated animation.
    a.style.transition = "opacity 1s ease";
    await new Promise((r) => setTimeout(r, 150)); // past flipDuration + 50
    assertEquals(
      a.style.transition,
      "opacity 1s ease",
      "a cancelled cleanup must not fire later and wipe a live transition",
    );

    _unmount(handle);
    await win.happyDOM.close();
  },
});
