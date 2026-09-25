// An element something OUTSIDE the renderer already took out of its parent
// (an action that moved or replaced it) is still leaving the tree when its vnode is removed. `removeDom` skipped it
// entirely — nothing to remove — so its actions' teardown never ran and its
// signal bindings stayed live, for good.
import { assertEquals } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import { signal } from "../src/air/aio-renderer.ts";
import { testUI } from "../src/testing/ui-test.ts";

Deno.test("removeDom: an element taken out of its parent by someone else still has its teardown run", async () => {
  const show = signal(true);
  let torn = 0;
  const act = (_el: HTMLElement) => () => {
    torn++;
  };
  const ui = await testUI(() =>
    h(
      "div",
      { id: "host" },
      show.value ? h("section", { id: "x", use: act }) : null,
    )
  );
  try {
    await ui.settle();
    const x = ui.document.getElementById("x")!;
    assertEquals(x.parentElement?.id, "host");
    // Someone else moves it out of the renderer's parent.
    ui.document.body.appendChild(x);
    show.set(false);
    await ui.settle();
    assertEquals(torn, 1, "the action's teardown ran on unmount");
  } finally {
    await ui.dispose();
  }
});

Deno.test("removeDom: an action teardown that moves its element does not abort the render", async () => {
  // The teardown runs before the removal; `removeChild` of a node it already
  // moved away threw, and the rest of that render (the sibling below) never
  // landed.
  const show = signal(true);
  const tick = signal(0);
  const ui = await testUI(() =>
    h(
      "div",
      { id: "host" },
      show.value
        ? h("section", {
          id: "x",
          use: (el: HTMLElement) => () => el.ownerDocument.body.append(el),
        })
        : null,
      h("span", { id: "after" }, `after ${tick.value}`),
    )
  );
  try {
    await ui.settle();
    tick.set(1);
    show.set(false);
    await ui.settle();
    assertEquals(ui.document.getElementById("after")?.textContent, "after 1");
  } finally {
    await ui.dispose();
  }
});
