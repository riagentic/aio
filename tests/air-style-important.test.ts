// `style={{ color: "red !important" }}` renders the declaration on every path.
//
// The priority is not part of a CSS value, so `setProperty(name, "red
// !important")` is an invalid value the CSSOM ignores (measured in Chromium:
// nothing is written on mount, and an update leaves the OLD declaration in
// place). SSR pastes the pair into the attribute, so the server shipped the
// rule working and the client — mount, diff and a signal-valued declaration
// alike — dropped it.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { _diff, _render, h } from "../src/air/vdom.ts";
import { signal } from "../src/state/signal.ts";
import {
  bindSignalProps,
  cleanupSignalBindings,
} from "../src/air/signal-binding.ts";

Deno.test("a style object value ending in !important is applied on mount, diff and signal paths", async () => {
  const win = new Window();
  try {
    const doc = win.document as unknown as Document;
    const host = doc.createElement("div");
    const a = h("p", { style: { color: "red" } });
    _render(host, a, null, { doc });
    const b = h("p", { style: { color: "blue !important" } });
    _diff(host, b, a, { doc });
    const p = host.firstChild as HTMLElement;
    assertEquals(p.style.getPropertyValue("color"), "blue");
    assertEquals(p.style.getPropertyPriority("color"), "important");

    const fresh = doc.createElement("div");
    _render(fresh, h("p", { style: { color: "blue !important" } }), null, {
      doc,
    });
    assertEquals(fresh.innerHTML, host.innerHTML);

    // Dropping the flag again clears the priority, not just the value.
    _diff(host, h("p", { style: { color: "blue" } }), b, { doc });
    assertEquals(p.style.getPropertyPriority("color"), "");

    const sig = signal("green !important");
    const el = doc.createElement("i");
    bindSignalProps(el, { style: { color: sig } });
    assertEquals(el.style.getPropertyValue("color"), "green");
    assertEquals(el.style.getPropertyPriority("color"), "important");
    cleanupSignalBindings(el);
  } finally {
    await closeWindow(win);
  }
});
