// useId() is unique across every root in a document, and still matches the
// server's ids on hydrate.
//
// The counter was per ROOT and restarted at 0, so two `mount()`s on one page
// both handed out `:r0:` — the second root's `<label for>` pointed at the first
// root's input. Hydration is the one place a per-root sequence is required
// (renderToString restarts at 0 and the client must produce the same ids), so
// only the hydration pass keeps it; everything else draws from one sequence.

import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, renderToString } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
  useId,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

Deno.test("useId: ids are unique across mount roots, SSR ids survive hydrate, later ids do not repeat them", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  try {
    const Field = () => {
      const id = useId();
      return h("label", { htmlFor: id }, h("input", { id }));
    };
    const more = signal(false);
    const App = () =>
      h(
        "div",
        null,
        h(Field, null),
        h(Field, null),
        more.value && h(Field, null),
      );

    // Server markup, hydrated: the ids must be the server's.
    const html = renderToString(h(App, null));
    const hyd = doc.createElement("div");
    hyd.innerHTML = html;
    doc.body.appendChild(hyd);
    const serverIds = [...hyd.querySelectorAll("input")].map((i) => i.id);
    const hh = hydrate(hyd, App);
    assertEquals(
      [...hyd.querySelectorAll("input")].map((i) => i.id),
      serverIds,
      "hydrate keeps the SSR ids",
    );

    // Two client roots beside it.
    const a = doc.createElement("div");
    const b = doc.createElement("div");
    doc.body.append(a, b);
    const ha = mount(a, App);
    const hb = mount(b, App);
    // …and a component the hydrated root mounts AFTER hydration.
    more.set(true);
    hh._flush();
    ha._flush();
    hb._flush();

    const ids = [...doc.querySelectorAll("input")].map((i) => i.id);
    assertEquals(ids.length, 9);
    assertEquals(new Set(ids).size, ids.length, `duplicate ids: ${ids}`);
    const labels = [...doc.querySelectorAll("label")];
    assert(labels.length >= 2, "the fixture renders labels");
    for (const label of labels) {
      const input = label.querySelector("input")!;
      assert(
        doc.getElementById(label.getAttribute("for")!) === input,
        "every label resolves to its own input",
      );
    }
    _unmount(ha);
    _unmount(hb);
    _unmount(hh);
  } finally {
    await closeWindow(win);
  }
});
