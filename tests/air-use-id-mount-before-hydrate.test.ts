// useId() is unique across roots in EITHER order: a `mount()` root created
// BEFORE a `hydrate()` must not hand out the ids the hydration pass is about
// to reproduce from the server's markup.
//
// Client and server ids shared one spelling, `:r{N}:`. The hydration pass has
// to produce the server's numbers, and a client sequence cannot skip numbers a
// later hydration will need — so `mount()` then `hydrate()` on one page gave
// both roots `:r0:` and `:r1:`, and a `<label for>` in one root pointed at an
// input in the other. Client ids are now spelled `:rc{N}:`; the hydrated ids
// are still exactly the server's (the same DOM nodes are adopted, not rebuilt).

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

Deno.test("useId: a mount() before hydrate() shares no id with it, and hydrate keeps the server's ids", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  try {
    const Field = ({ n }: { n: string }) => {
      const id = useId();
      return h("label", { htmlFor: id, "data-n": n }, h("input", { id }));
    };
    const late = signal(false);
    const App = () =>
      h(
        "div",
        null,
        h(Field, { n: "a" }),
        h(Field, { n: "b" }),
        late.value ? h(Field, { n: "late" }) : null,
      );

    const html = renderToString(h(App, null));
    const hyd = doc.createElement("div");
    hyd.innerHTML = html;
    doc.body.appendChild(hyd);
    const serverInputs = [...hyd.querySelectorAll("input")];
    const serverIds = serverInputs.map((i) => i.id);
    assertEquals(serverIds, [":r0:", ":r1:"], "the server's sequence");

    // A client root FIRST — it draws ids before the hydration pass runs.
    const first = doc.createElement("div");
    doc.body.appendChild(first);
    const hm = mount(first, () =>
      h(
        "section",
        null,
        h(Field, { n: "m0" }),
        h(Field, { n: "m1" }),
        h(Field, { n: "m2" }),
      ));

    const hh = hydrate(hyd, App);
    const hydratedInputs = [...hyd.querySelectorAll("input")];
    assertEquals(hydratedInputs.map((i) => i.id), serverIds, "no mismatch");
    assert(
      hydratedInputs.every((el, i) => el === serverInputs[i]),
      "hydration adopted the server's nodes instead of re-rendering them",
    );

    // …and ids drawn after hydration: the hydrated root's late child, and a
    // root mounted last.
    late.set(true);
    hh._flush();
    const last = doc.createElement("div");
    doc.body.appendChild(last);
    const hl = mount(last, () => h(Field, { n: "last" }));

    const ids = [...doc.querySelectorAll("input")].map((i) => i.id);
    assertEquals(ids.length, 7);
    assertEquals(new Set(ids).size, ids.length, `duplicate ids: ${ids}`);
    const labels = [...doc.querySelectorAll("label")];
    assertEquals(labels.length, 7);
    for (const label of labels) {
      assert(
        doc.getElementById(label.getAttribute("for")!) ===
          label.querySelector("input"),
        `label ${label.getAttribute("data-n")} resolves to its own input`,
      );
    }
    _unmount(hl);
    _unmount(hh);
    _unmount(hm);
  } finally {
    await closeWindow(win);
  }
});
