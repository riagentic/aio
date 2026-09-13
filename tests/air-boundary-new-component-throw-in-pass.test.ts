// A component MOUNTED by a re-render pass that throws shows its boundary's
// fallback — not a blank.
//
// A re-render pass contains a component throw where it happens when no
// boundary was entered inside the pass (`isolateComponentError`): an existing
// component keeps its output and renders the enclosing boundary's fallback in
// its place on the next turn. A NEW component took the other branch — an empty
// placeholder — because the boundary around the component that re-rendered is
// not on `_boundaryStack` during that pass (it was pushed at that component's
// mount). And every instance the pass mounted recorded `_boundary: null` for
// the same reason, so a later throw from one of them fell back to nothing too.
// Measured before the fix, `<ErrorBoundary><Parent/></ErrorBoundary>` with
// `Parent` re-rendering itself into `{show && <Boom/>}`:
//
//   <section>p<!----></section>                      — no fallback
//   <section>p<span><!----></span></section>         — Boom under a new <W/>
//
// The same state reached by a fresh mount shows the fallback.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { type ComponentFn, ErrorBoundary, h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { type Signal, signal } from "../src/state/signal.ts";

const C = (fn: unknown) => fn as ComponentFn;
const subs = (s: Signal<unknown>): number =>
  (s as unknown as { _subscribers: Set<unknown> })._subscribers.size;

// deno-lint-ignore no-explicit-any
async function withDom(body: (doc: any) => void | Promise<void>) {
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document;
  _setDocument(doc as unknown as Document);
  const origErr = console.error;
  console.error = () => {};
  try {
    await body(doc);
  } finally {
    console.error = origErr;
    await closeWindow(win);
  }
}

const fallback = (e: Error) => h("i", null, ["fb:" + e.message]);

/** The markup a FRESH mount of `App` builds right now — the reference. */
// deno-lint-ignore no-explicit-any
function fresh(doc: any, App: ComponentFn): string {
  const host = doc.createElement("div");
  const hd = mount(host, App);
  const html = host.innerHTML;
  _unmount(hd);
  return html;
}

const SHAPES: Record<string, (Boom: ComponentFn) => ComponentFn> = {
  "directly": (Boom) => Boom,
  "under a wrapper the pass also mounts": (Boom) =>
    C(() => h("span", null, [h(Boom, null)])),
  "two wrappers deep": (Boom) => {
    const W = C(() => h("span", null, [h(Boom, null)]));
    return C(() => h("em", null, [h(W, null)]));
  },
};

for (const [shape, wrap] of Object.entries(SHAPES)) {
  Deno.test(`new component throw in a pass: the boundary's fallback shows — ${shape}`, async () => {
    await withDom((doc) => {
      const root = doc.createElement("div");
      doc.body.appendChild(root);
      const show = signal(false);
      const ready = signal(false);
      const Boom = C(() => {
        if (!ready.value) throw new Error("boom");
        return h("b", null, ["ok"]);
      });
      const Child = wrap(Boom);
      // Parent re-renders ITSELF (it reads `show`), so the boundary above it
      // is outside the pass.
      const Parent = () =>
        h("section", null, ["p", show.value ? h(Child, null) : "none"]);
      const App = C(() =>
        h("div", null, [
          "a",
          h(ErrorBoundary, { fallback }, [h(C(Parent), null)]),
          "z",
        ])
      );
      const hd = mount(root, App);
      assertEquals(root.innerHTML, "<div>a<section>pnone</section>z</div>");

      show.set(true);
      hd._flush();
      const html = root.innerHTML;
      assertEquals(html.includes("<i>fb:boom</i>"), true, html);
      assertEquals(html.endsWith("</section>z</div>"), true, html);

      // Recovers when the signal the failed render read changes…
      ready.set(true);
      hd._flush();
      assertEquals(root.innerHTML, fresh(doc, App));
      assertEquals(root.innerHTML.includes("<b>ok</b>"), true);

      // …and an instance the PASS mounted, throwing later on its own
      // re-render, falls back too (it recorded its boundary).
      ready.set(false);
      hd._flush();
      assertEquals(
        root.innerHTML.includes("<i>fb:boom</i>"),
        true,
        root.innerHTML,
      );
      ready.set(true);
      hd._flush();
      assertEquals(root.innerHTML.includes("<b>ok</b>"), true, root.innerHTML);

      show.set(false);
      hd._flush();
      assertEquals(root.innerHTML, "<div>a<section>pnone</section>z</div>");
      _unmount(hd);
      assertEquals([subs(show), subs(ready)], [0, 0]);
    });
  });
}

Deno.test("new component throw in a pass: outside any boundary the slot stays empty and the pass completes", async () => {
  await withDom((doc) => {
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const show = signal(false);
    const Boom = C(() => {
      throw new Error("boom");
    });
    const Parent = () =>
      h("section", null, [show.value ? h(Boom, null) : "none", "after"]);
    const hd = mount(root, C(() => h("div", null, [h(C(Parent), null)])));
    show.set(true);
    hd._flush();
    assertEquals(root.innerHTML, "<div><section><!---->after</section></div>");
    _unmount(hd);
  });
});

Deno.test("new component throw in a pass: a fallback that throws leaves the slot empty and is reported", async () => {
  await withDom((doc) => {
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const errors: string[] = [];
    console.error = (...a: unknown[]) => void errors.push(String(a[0]));
    const show = signal(false);
    const Boom = C(() => {
      throw new Error("boom");
    });
    const Parent = () =>
      h("section", null, [show.value ? h(Boom, null) : "none", "after"]);
    const bad = () => {
      throw new Error("fallback broke");
    };
    const App = () =>
      h("div", null, [
        h(ErrorBoundary, { fallback: bad }, [h(C(Parent), null)]),
      ]);
    const hd = mount(root, C(App));
    show.set(true);
    hd._flush();
    assertEquals(root.innerHTML, "<div><section><!---->after</section></div>");
    assertEquals(
      errors.some((e) => e.includes("ErrorBoundary fallback threw")),
      true,
      errors.join("\n"),
    );
    _unmount(hd);
  });
});
