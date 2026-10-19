// `am trigger <path> click` on a button whose onClick throws answered
// `{"ok":true}` and exit 0. The framework contains a handler throw so the page
// keeps rendering — right for an app — but the trigger is the agent's ACT in
// observe → act → observe, and "ok" told it the click worked. Found live: a
// method renamed in cell.ts, the UI still calling the old name, every click a
// `TypeError` in client.log, every trigger green. testUI fails on the same
// throw; the trigger engine both share now says so too.
import "./store-sandbox.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { h } from "../src/air/vdom.ts";
import { runUITrigger } from "../src/air/ui-remote.ts";

Deno.test("a trigger whose handler throws is not ok, and names the throw", async () => {
  let clicks = 0;
  const App = () =>
    h(
      "div",
      null,
      h("button", {
        onClick: () => {
          throw new TypeError("todo.flip is not a function");
        },
      }, "Broken"),
      h("button", { onClick: () => void clicks++ }, "Fine"),
    );
  const orig = console.error;
  console.error = () => {}; // the contained throw logs by design
  try {
    await using ui = await testUI(App, { allowContainedErrors: true });
    await ui.settle();

    const bad = await runUITrigger({
      path: "App:BrokenButton",
      action: "click",
    });
    assertEquals(bad.ok, false, JSON.stringify(bad));
    assertStringIncludes(bad.error ?? "", "todo.flip is not a function");
    assertEquals(
      Array.isArray(bad.surface),
      true,
      "the surface still rides back",
    );

    const good = await runUITrigger({
      path: "App:FineButton",
      action: "click",
    });
    assertEquals(good.ok, true, JSON.stringify(good));
    assertEquals(clicks, 1);
  } finally {
    console.error = orig;
  }
});

Deno.test("overlapping triggers each answer for their own gesture", async () => {
  // The server can send the next trigger before the last one answered. With
  // the error sink swapped per trigger, the Fine click named the Broken
  // click's throw, and the sink was restored out of order.
  const App = () =>
    h(
      "div",
      null,
      h("button", {
        onClick: () => {
          throw new TypeError("todo.flip is not a function");
        },
      }, "Broken"),
      h("button", { onClick: () => {} }, "Fine"),
    );
  const orig = console.error;
  console.error = () => {}; // the contained throw logs by design
  try {
    await using ui = await testUI(App, { allowContainedErrors: true });
    await ui.settle();
    const [fine, bad] = await Promise.all([
      runUITrigger({ path: "App:FineButton", action: "click" }),
      runUITrigger({ path: "App:BrokenButton", action: "click" }),
    ]);
    assertEquals(bad.ok, false, JSON.stringify(bad));
    assertEquals(fine.ok, true, JSON.stringify(fine));
  } finally {
    console.error = orig;
  }
});
