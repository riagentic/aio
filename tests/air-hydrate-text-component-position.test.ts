// A component that renders a bare string occupies one text node. `createDom`
// and `_diff` record that node as the component vnode's `_dom`, and every later
// commit relies on it — vdom-diff.ts / renderer-rerender.ts: "a component that
// renders a bare string owns a TEXT node, which `getDom(rendered)` can never
// see … the reconciler hands the node back instead" (the alpha47 fix, see
// docs/upgrade/from-alpha46-to-alpha47.md).
//
// Hydration's component branch still sets `vnode._dom = getDom(rendered)`,
// which is null for a string. So on a HYDRATED page such a component has no
// position: its own re-render APPENDS its new text at the end of the parent
// and leaves the server text behind, and a keyed list of them can never be
// removed or reordered. Asserted against mount(), never against a literal.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { repairProxiedSiblings } from "../src/testing/happy-dom-repair.ts";
import { type ComponentFn, h, renderToString } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

// The renderer supports string-returning components on every path (see the
// comments quoted above); the cast only satisfies ComponentFn's return type.
const Label = ((p: { text: string }) => p.text) as unknown as ComponentFn;

function setup() {
  const win = new Window({ url: "https://localhost" });
  repairProxiedSiblings(win);
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  return { doc, cleanup: () => closeWindow(win) };
}

/** Render `App` into a fresh host by mount or by SSR + hydrate, run `step`,
 *  and return the resulting markup. */
function run(
  doc: Document,
  mode: "mount" | "hydrate",
  App: ComponentFn,
  step: () => void,
): string {
  const host = doc.createElement("main");
  doc.body.appendChild(host);
  let handle;
  if (mode === "mount") handle = mount(host, App);
  else {
    host.innerHTML = renderToString(h(App, null));
    handle = hydrate(host, App);
  }
  step();
  handle._flush();
  const html = host.innerHTML;
  _unmount(handle);
  host.remove();
  return html;
}

Deno.test("hydrate: a string-rendering component re-renders in place, like mount", async () => {
  const { doc, cleanup } = setup();
  try {
    const results: Record<string, string> = {};
    for (const mode of ["mount", "hydrate"] as const) {
      const n = signal(1);
      const Count = (() => String(n.value)) as unknown as ComponentFn;
      const App = () =>
        h("p", null, h("b", null, "a"), h(Count, null), h("i", null, "z"));
      results[mode] = run(doc, mode, App, () => n.set(2));
    }
    assertEquals(results.mount, "<p><b>a</b>2<i>z</i></p>");
    assertEquals(
      results.hydrate,
      results.mount,
      "the hydrated component has no _dom: its new text is appended at the " +
        "parent's end and the server's text is left in place",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("hydrate: removing / reordering keyed string-rendering components, like mount", async () => {
  const { doc, cleanup } = setup();
  try {
    for (const after of [["b"], ["b", "a"]]) {
      const results: Record<string, string> = {};
      for (const mode of ["mount", "hydrate"] as const) {
        const list = signal(["a", "b"]);
        const App = () =>
          h("ul", null, list.value.map((t) => h(Label, { key: t, text: t })));
        results[mode] = run(doc, mode, App, () => list.set(after));
      }
      assertEquals(results.mount, `<ul>${after.join("")}</ul>`);
      assertEquals(results.hydrate, results.mount, `a,b -> ${after}`);
    }
  } finally {
    await cleanup();
  }
});
