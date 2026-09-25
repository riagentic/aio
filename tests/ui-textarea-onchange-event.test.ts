// kit.md promised that the input components' handlers receive the VALUE, and
// Textarea's `onChange` is not wrapped: it receives the DOM Event, so
// `<Textarea onChange={form.setBio}/>` handed a cell method an Event object.
// Kept as shipped (an app reading `e.target.value` must not break) — the doc
// now says so, and dev says it once, at the one site it can be seen.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { Textarea } from "../src/ui/mod.ts";

Deno.test("Textarea onChange: still the Event, and dev says so once", async () => {
  const g = globalThis as Record<string, unknown>;
  const wasDev = g.__aioDev;
  g.__aioDev = true;
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const got: unknown[] = [];
  const onChange = (e: unknown) => void got.push(e);
  // deno-lint-ignore no-explicit-any
  const handle = mount(root, () =>
    h("div", null, [
      h(Textarea as never, { value: "a", onChange }),
      h(Textarea as never, { value: "b", onChange }),
    ]) as never) as any;
  try {
    handle._flush();
    const ta = root.querySelector("textarea");
    ta.value = "ab";
    // With no `onInput` beside it, AIR maps `onChange` to the `input` event
    // (React semantics) — so this is the event a keystroke fires.
    ta.dispatchEvent(new win.Event("input", { bubbles: true }));
    assertEquals(got.length, 1);
    assert(got[0] instanceof win.Event, "the handler still receives the Event");
    const said = warns.filter((w) => w.includes("<Textarea onChange>"));
    assertEquals(said.length, 1, `said exactly once: ${warns.join(" | ")}`);
  } finally {
    console.warn = orig;
    g.__aioDev = wasDev;
    _unmount(handle);
    await closeWindow(win);
  }
});
