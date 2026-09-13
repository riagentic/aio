// The test DOM must agree with a browser about where a `<form>` sits.
//
// MEASURED (happy-dom 17.6.3): `form.nextSibling` is `null` even when the form
// is child 1 of a four-child parent and `parent.childNodes[1] === form`. A
// sweep of every HTML tag finds exactly two affected — `<form>` and
// `<select>`, the two happy-dom wraps in a named-item Proxy.
//
// `_nextLive`/`_firstLive`/`_advance` walk siblings, and they are the AIR
// reconciler's positional cursor. So under the harness the cursor stopped dead
// at any form, and AIR's dev tripwire reported `<main> ran out of DOM nodes at
// child 2 … the child reconciler desynced`, signing off with "this is an aio
// bug; please report the component's child shape" — on a DOM that was correct.
// `examples/todo` tripped it on the first click, and so would every app with a
// form in it.
import { assertEquals } from "@std/assert";
import { repairProxiedSiblings } from "../src/testing/happy-dom-repair.ts";
import { closeWindow } from "../src/testing/close-window.ts";

// deno-lint-ignore no-explicit-any
async function freshWindow(): Promise<any> {
  const spec = "happy-dom";
  const hd = await import(spec);
  return new hd.Window({ url: "http://localhost/" });
}

Deno.test("repairProxiedSiblings: a form and a select know their siblings", async () => {
  const win = await freshWindow();
  try {
    const d = win.document;
    // The defect, first — so this test fails loudly the day it is fixed
    // upstream rather than passing on a repair that no longer does anything.
    const pre = d.createElement("div");
    const preForm = d.createElement("form");
    const preAfter = d.createElement("span");
    pre.appendChild(preForm);
    pre.appendChild(preAfter);
    const wasBroken = preForm.nextSibling !== preAfter;

    const patched = repairProxiedSiblings(win);
    if (!wasBroken) {
      assertEquals(
        patched,
        [],
        "happy-dom behaves now — the repair must leave a working DOM alone",
      );
      return;
    }
    assertEquals(patched, ["HTMLFormElement", "HTMLSelectElement"]);

    for (const tag of ["form", "select"]) {
      const parent = d.createElement("div");
      const before = d.createElement("h1");
      const node = d.createElement(tag);
      const after = d.createElement("ul");
      parent.appendChild(before);
      parent.appendChild(node);
      parent.appendChild(after);
      d.body.appendChild(parent);
      assertEquals(node.nextSibling, after, `<${tag}>.nextSibling`);
      assertEquals(node.previousSibling, before, `<${tag}>.previousSibling`);
      assertEquals(node.nextElementSibling, after, `<${tag}>.nextElementSib`);
      assertEquals(
        node.previousElementSibling,
        before,
        `<${tag}>.previousElementSibling`,
      );
    }

    // A node with nothing on one side still answers null, not a wrap-around.
    const lone = d.createElement("div");
    const only = d.createElement("form");
    lone.appendChild(only);
    assertEquals(only.nextSibling, null);
    assertEquals(only.previousSibling, null);
    // …and an unparented one does not throw.
    assertEquals(d.createElement("form").nextSibling, null);
  } finally {
    await closeWindow(win);
  }
});
