// A hydrated text whose client value is SHORTER than the server's (a prefix of
// it — most often `""`) followed by a non-text slot keeps the page equal to
// the model: no duplicated text, no orphan anchor.
//
// Hydration splits a server text run to undo the parser's merge of adjacent
// text children, leaving the remainder for the next text child. When the next
// child is an empty region instead, the remainder sat in its slot: the region
// inserted a second anchor in front of it, the text after the region adopted
// the remainder, and the server's own anchor and text stayed behind, owned by
// nothing — `<p>{msg}<>{rows}</>z</p>` hydrated as `z z`, with no warning and
// no fallback.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { Fragment, h, renderToString } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

Deno.test("hydrate: a shorter client text before an empty region leaves no duplicate", async () => {
  const win = new Window();
  try {
    const doc = win.document as unknown as Document;
    _setDocument(doc);
    const msg = signal("Loading");
    const rows = signal<string[]>([]);
    const App = () =>
      h(
        "p",
        null,
        msg.value,
        h(Fragment, null, ...rows.value.map((r) => h("b", { key: r }, r))),
        "z",
        null,
      );
    const html = renderToString(h(App, null));
    msg.set("");
    const ref = doc.createElement("div");
    const m = mount(ref, App as ComponentFn);
    const want = ref.innerHTML;
    _unmount(m);
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    host.innerHTML = html;
    // Claimed, not repaired: the remainder is dropped where the region
    // claims its anchor, so no server node is left over for the surplus
    // clean-up to remove (and to warn about).
    const warned: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a);
    const g = globalThis as Record<string, unknown>;
    const dev = g.__aioDev;
    g.__aioDev = true; // the surplus clean-up says what it removed in dev
    let handle;
    try {
      handle = hydrate(host, App as ComponentFn);
    } finally {
      console.warn = warn;
      g.__aioDev = dev;
    }
    assertEquals(warned, [], "hydrate repaired server leftovers");
    assertEquals(host.innerHTML, want);
    assertEquals(host.textContent, "z");
    rows.set(["r"]);
    handle._flush();
    assertEquals(host.textContent, "rz");
    _unmount(handle);
  } finally {
    await closeWindow(win);
  }
});
