// A browser with scripting on parses `<noscript>` content as RAW TEXT. SSR
// writes element children; hydrate expected those elements, met one text
// node, reported a mismatch and discarded the WHOLE server page — the input
// the user typed into before the bundle loaded was replaced. happy-dom parses
// noscript with scripting off, so the browser's DOM is reproduced by hand.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { type ComponentFn, h, renderToString } from "../src/air/vdom.ts";
import { _setDocument, _unmount, hydrate } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

const msg = signal("This app needs JavaScript.");
const App = () =>
  h(
    "main",
    null,
    h("noscript", null, h("p", null, msg.value)),
    h("input", { "aria-label": "Search" }),
    h("span", null, "after"),
  );

Deno.test("hydrate: a <noscript> with element children keeps the server page", async () => {
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const warns: string[] = [];
  const ow = console.warn, oe = console.error;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  console.error = (...a: unknown[]) => void warns.push(a.join(" "));
  try {
    const root = doc.createElement("div");
    root.innerHTML = renderToString(h(App as ComponentFn, null));
    // What a scripting-enabled browser's parser makes of the same bytes:
    const ns = root.querySelector("noscript")!;
    ns.textContent = ns.innerHTML;
    assertEquals(ns.childNodes.length, 1);
    doc.body.appendChild(root);
    const input = root.querySelector("input")!;
    const span = root.querySelector("span")!;
    input.value = "typed before hydration";
    const handle = hydrate(root, App as ComponentFn);
    assertEquals(warns, []);
    // Later siblings were claimed in order, not rebuilt.
    assert(
      root.querySelector("input") === input,
      "the server <input> was replaced",
    );
    assert(
      root.querySelector("span") === span,
      "the server <span> was replaced",
    );
    assertEquals(input.value, "typed before hydration");
    // The noscript's children are owned nodes: the next diff patches them.
    msg.set("Enable JavaScript.");
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(
      root.querySelector("noscript p")?.textContent,
      "Enable JavaScript.",
    );
    assertEquals(warns, []);
    _unmount(handle);
  } finally {
    console.warn = ow;
    console.error = oe;
    _setDocument(null as never);
    await win.happyDOM.close();
  }
});
