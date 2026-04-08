// Integration tests for the animation system.
// Covers edge cases and cross-component interactions.

import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/signal.ts";
import { h } from "../src/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/aio-renderer.ts";
import { Transition } from "../src/transition-component.ts";
import { TransitionGroup } from "../src/transition-group.ts";
import { fade, scale, slide } from "../src/transition.ts";

// happy-dom timers drained via win.happyDOM.close() — sanitizers enabled

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { win, doc, root };
}

// ── 1. Transition inside conditional rendering ───────────────────────
// Parent component conditionally renders the <Transition> itself.

Deno.test({
  name: "Integration: Transition inside conditional parent rendering",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);

    const showParent = signal(true);
    const showChild = signal(true);

    const App = () => {
      if (!showParent.value) return null;
      return h(
        Transition,
        { enter: fade, exit: fade },
        showChild.value ? h("div", { id: "inner" }, "content") : null,
      );
    };

    const handle = mount(root, App);
    assertEquals(
      root.querySelector("#inner") !== null,
      true,
      "inner rendered initially",
    );

    // Hide child — exit animation defers removal
    showChild.set(false);
    handle._flush();
    assertEquals(
      root.querySelector("#inner") !== null,
      true,
      "inner still in DOM during exit",
    );

    await new Promise((r) => setTimeout(r, 400));
    assertEquals(
      root.querySelector("#inner"),
      null,
      "inner removed after exit animation",
    );

    // Show child again
    showChild.set(true);
    handle._flush();
    assertEquals(
      root.querySelector("#inner") !== null,
      true,
      "inner re-renders after show",
    );

    // Now hide entire parent
    showParent.set(false);
    handle._flush();
    // After parent is gone, exit animation finishes
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(
      root.querySelector("#inner") === null,
      true,
      "inner gone when parent removed",
    );

    _unmount(handle);
    await win.happyDOM.close();
  },
});

// ── 2. TransitionGroup with signal-driven list ───────────────────────
// Items added/removed via signal; verify enter animations and deferred exit.

Deno.test({
  name: "Integration: TransitionGroup signal-driven list add/remove",
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
    assertEquals(root.querySelectorAll("div").length, 3, "initial 3 items");

    // Add item "d"
    items.set(["a", "b", "c", "d"]);
    handle._flush();
    assertEquals(root.querySelectorAll("div").length, 4, "4 items after add");

    // New item "d" should have enter animation applied
    const d = root.querySelector("#d") as HTMLElement;
    assertEquals(d !== null, true, "item d exists");
    assertEquals(d.style.animation !== "", true, "item d has enter animation");

    // Remove item "b"
    items.set(["a", "c", "d"]);
    handle._flush();

    // "b" still in DOM (deferred exit)
    assertEquals(
      root.querySelector("#b") !== null,
      true,
      "item b still in DOM during exit",
    );

    // After animation completes
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(
      root.querySelector("#b"),
      null,
      "item b removed after exit animation",
    );
    // Remaining items intact
    assertEquals(root.querySelectorAll("div").length, 3, "3 items remain");

    _unmount(handle);
    await win.happyDOM.close();
  },
});

// ── 3. Transition with no enter (exit only) ──────────────────────────
// Only exit transition configured; enter should mount without animation.

Deno.test({
  name: "Integration: Transition exit only (no enter animation)",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);

    const show = signal(true);

    const App = () =>
      h(
        Transition,
        { exit: fade }, // no enter
        show.value ? h("div", { id: "box" }, "content") : null,
      );

    const handle = mount(root, App);
    const box = root.querySelector("#box") as HTMLElement;
    assertEquals(box !== null, true, "element mounted");
    // No enter animation — style should be empty or unset
    assertEquals(box.style.animation, "", "no enter animation applied");

    // Trigger exit — should be deferred
    show.set(false);
    handle._flush();
    assertEquals(
      root.querySelector("#box") !== null,
      true,
      "still in DOM during exit",
    );

    await new Promise((r) => setTimeout(r, 400));
    assertEquals(
      root.querySelector("#box"),
      null,
      "removed after exit animation",
    );

    _unmount(handle);
    await win.happyDOM.close();
  },
});

// ── 4. TransitionGroup simultaneous add + remove ─────────────────────
// Add "d" and remove "b" in the same signal update.

Deno.test({
  name: "Integration: TransitionGroup simultaneous add and remove",
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

    // Simultaneously: add "d", remove "b"
    items.set(["a", "c", "d"]);
    handle._flush();

    // "d" should be in DOM with enter animation
    const d = root.querySelector("#d") as HTMLElement;
    assertEquals(d !== null, true, "new item d is in DOM");
    assertEquals(d.style.animation !== "", true, "item d has enter animation");

    // "b" should still be in DOM (exit animation in progress)
    assertEquals(
      root.querySelector("#b") !== null,
      true,
      "removed item b still in DOM",
    );

    // "a" and "c" remain without disruption
    assertEquals(root.querySelector("#a") !== null, true);
    assertEquals(root.querySelector("#c") !== null, true);

    // After animation: "b" gone, "d" remains
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(root.querySelector("#b"), null, "item b removed after exit");
    assertEquals(root.querySelector("#d") !== null, true, "item d remains");
    assertEquals(root.querySelectorAll("div").length, 3, "3 items total");

    _unmount(handle);
    await win.happyDOM.close();
  },
});

// ── 5. Transition with different enter/exit functions ─────────────────
// Fade in, slide out — enter and exit use different transition presets.

Deno.test({
  name:
    "Integration: Transition different enter (fade) and exit (slide) functions",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);

    const show = signal(true);

    const App = () =>
      h(
        Transition,
        { enter: fade, exit: slide },
        show.value ? h("div", { id: "box" }, "mixed") : null,
      );

    const handle = mount(root, App);
    const box = root.querySelector("#box") as HTMLElement;
    assertEquals(box !== null, true, "element mounted");

    // Enter animation should be applied (fade)
    assertEquals(box.style.animation !== "", true, "enter animation applied");

    // Trigger exit — should use slide
    show.set(false);
    handle._flush();

    // Element still in DOM during exit
    assertEquals(
      root.querySelector("#box") !== null,
      true,
      "still in DOM during exit",
    );

    // After slide duration (300ms default) + margin
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(
      root.querySelector("#box"),
      null,
      "removed after exit animation",
    );

    _unmount(handle);
    await win.happyDOM.close();
  },
});

// ── 6. TransitionGroup: all items removed ────────────────────────────
// List goes to empty; all items should have deferred exit animations.

Deno.test({
  name: "Integration: TransitionGroup all items removed at once",
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
    assertEquals(root.querySelectorAll("div").length, 3, "initial 3 items");

    // Remove all items at once
    items.set([]);
    handle._flush();

    // All 3 still in DOM (exit animations running)
    assertEquals(root.querySelector("#a") !== null, true, "a still in DOM");
    assertEquals(root.querySelector("#b") !== null, true, "b still in DOM");
    assertEquals(root.querySelector("#c") !== null, true, "c still in DOM");

    // After animation duration all gone
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(root.querySelector("#a"), null, "a removed");
    assertEquals(root.querySelector("#b"), null, "b removed");
    assertEquals(root.querySelector("#c"), null, "c removed");

    _unmount(handle);
    await win.happyDOM.close();
  },
});

// ── 7. Rapid show/hide toggle ─────────────────────────────────────────
// show=true → false → true in rapid succession; element should survive.

Deno.test({
  name: "Integration: Transition rapid show/hide/show toggle",
  async fn() {
    const { win, doc, root } = createDOM();
    _setDocument(doc);

    const show = signal(true);

    const App = () =>
      h(
        Transition,
        { enter: fade, exit: fade },
        show.value ? h("div", { id: "box" }, "rapid") : null,
      );

    const handle = mount(root, App);
    assertEquals(
      root.querySelector("#box") !== null,
      true,
      "initially visible",
    );

    // Hide — exit starts
    show.set(false);
    handle._flush();
    assertEquals(
      root.querySelector("#box") !== null,
      true,
      "still visible during exit",
    );

    // Show again quickly (before exit animation completes)
    show.set(true);
    handle._flush();

    // After a short wait — element should be present (re-shown)
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(
      root.querySelector("#box") !== null,
      true,
      "element survives rapid toggle",
    );

    // Wait past the original exit timeout to ensure no stale removal
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(
      root.querySelector("#box") !== null,
      true,
      "element remains after exit timeout",
    );

    _unmount(handle);
    await win.happyDOM.close();
  },
});
