// Field: the error/hint wiring is recomputed EVERY render, even when the
// control vnode is passed through unchanged (`{props.children}`).
//
// `nameControl`/`wireControl` wrote the attributes INTO the child vnode's
// props, filling only undefined ones. A wrapper that re-renders on its own
// state hands Field the same vnode object: last render's
// `aria-describedby` now looked app-set and stayed — pointing at a hint id
// that was gone — and an error never set `aria-invalid`. Field now rebuilds
// the path down to the control with fresh props each render, and the
// caller's vnode is never written.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import type { VChild } from "../src/air/vdom.ts";
import { useSignal } from "../src/air/aio-renderer.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { Field, Input } from "../src/ui/mod.ts";

// deno-lint-ignore no-explicit-any
type Doc = any;

/** Re-renders on ITS OWN state; its `children` vnode is the same object. */
function Wrap(props: { children?: VChild }) {
  const bad = useSignal(false);
  return h(
    "div",
    null,
    h(
      Field,
      {
        label: "Email",
        hint: bad.value ? undefined : "We never share it",
        error: bad.value ? "Required" : undefined,
      },
      props.children,
    ),
    h("button", { onClick: () => bad.set(!bad.peek()) }, "Toggle"),
  );
}

const control = h(Input, { value: "" });

Deno.test("Field: a passed-through control is re-wired when the hint becomes an error", async () => {
  const win = new Window();
  await using _w = { [Symbol.asyncDispose]: () => closeWindow(win) };
  await using ui = await testUI(() => h(Wrap, null, control), {
    document: win.document as Doc,
  });
  const doc = win.document as unknown as Document;
  const input = () => doc.querySelector("input")!;
  const hintId = input().getAttribute("aria-describedby")!;
  assertEquals(doc.getElementById(hintId)?.textContent, "We never share it");
  assertEquals(input().getAttribute("aria-invalid"), null);

  ui.ToggleButton.click();
  await ui.settle();
  const desc = input().getAttribute("aria-describedby");
  assert(desc, "described by something");
  assertEquals(
    doc.getElementById(desc)?.textContent,
    "Required",
    "aria-describedby names the error, not the removed hint",
  );
  assertEquals(input().getAttribute("aria-invalid"), "true");

  ui.ToggleButton.click();
  await ui.settle();
  assertEquals(input().getAttribute("aria-invalid"), null, "invalid cleared");
  const back = input().getAttribute("aria-describedby")!;
  assertEquals(doc.getElementById(back)?.textContent, "We never share it");
});

Deno.test("Field: never writes into the caller's vnode; an app-set attribute still wins", async () => {
  const own = h(Input, { value: "", "aria-describedby": "mine" });
  const win = new Window();
  await using _w = { [Symbol.asyncDispose]: () => closeWindow(win) };
  await using ui = await testUI(
    () => h("div", null, h("p", { id: "mine" }, "Mine"), h(Wrap, null, own)),
    { document: win.document as Doc },
  );
  const doc = win.document as unknown as Document;
  assertEquals(
    Object.keys(control.props).sort(),
    ["value"],
    "the shared vnode from the first test is untouched",
  );
  ui.ToggleButton.click();
  await ui.settle();
  const input = doc.querySelector("input")!;
  assertEquals(input.getAttribute("aria-describedby"), "mine");
  assertEquals(input.getAttribute("aria-invalid"), "true");
  assertEquals(
    Object.keys(own.props).sort(),
    ["aria-describedby", "value"],
  );
});
