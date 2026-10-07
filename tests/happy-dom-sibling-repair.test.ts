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
import {
  acceptHostEvents,
  repairProxiedSiblings,
} from "../src/testing/happy-dom-repair.ts";
import { h } from "../src/air/vdom.ts";
import { onMount } from "../src/air.ts";
import { testUI } from "../src/testing/ui-test.ts";
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

// MEASURED (happy-dom 20.14.5; 17.6.3 took anything): `dispatchEvent` throws
// for an event that is not happy-dom's own — and under the harness the GLOBAL
// `Event` is Deno's. `window.dispatchEvent(new Event("resize"))` in a
// component is one line in a browser and was a TypeError here.
Deno.test("acceptHostEvents: the host's Event is dispatched as it was before the check existed", async () => {
  const win = await freshWindow();
  try {
    const d = win.document;
    const el = d.createElement("div");
    let threw = false;
    try {
      el.dispatchEvent(new Event("probe"));
    } catch {
      threw = true;
    }
    assertEquals(
      acceptHostEvents(win),
      threw,
      "patched exactly when the engine refused — never a working DOM",
    );
    const seen: string[] = [];
    el.addEventListener("ping", (e: Event) => seen.push(e.type));
    win.addEventListener("resize", (e: Event) => seen.push(e.type));
    let detail: unknown;
    el.addEventListener("x", (e: Event) => detail = (e as CustomEvent).detail);
    assertEquals(el.dispatchEvent(new Event("ping")), true);
    win.dispatchEvent(new Event("resize"));
    el.dispatchEvent(new CustomEvent("x", { detail: 7 }));
    assertEquals(seen, ["ping", "resize"]);
    assertEquals(detail, 7);
    // The window's own events are untouched, and only the BASE check widened.
    el.dispatchEvent(new win.Event("ping"));
    assertEquals(seen, ["ping", "resize", "ping"]);
    assertEquals(new Event("a") instanceof win.CustomEvent, false);
    assertEquals(new win.CustomEvent("a") instanceof win.Event, true);
    assertEquals({} instanceof win.Event, false);
    let refused = false;
    try {
      el.dispatchEvent({ type: "ping" });
    } catch {
      refused = true;
    }
    assertEquals(refused || seen.length === 3, true, "a non-event is no event");
    assertEquals(acceptHostEvents(win), false, "second call: nothing to do");
  } finally {
    await closeWindow(win);
  }
});

const heard: string[] = [];
const Resizer = () => {
  onMount(() => {
    const w = (globalThis as unknown as { window: Window }).window;
    w.addEventListener("resize", () => heard.push("resize"));
    // What a component writes: the GLOBAL constructors.
    w.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new CustomEvent("app:ready", { detail: 1 }));
    heard.push("after");
  });
  return h("div", null, ["x"]);
};
testUI(
  Resizer as never,
  "testUI: a component dispatching `new Event()` on window/document does not throw",
  { cells: [] },
  async (ui) => {
    await ui.settle();
    assertEquals(heard, ["resize", "after"]);
  },
);
