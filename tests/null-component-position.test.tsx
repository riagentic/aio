// A component that renders `null` keeps its written POSITION (rimote R-10).
//
// It used to create no node and therefore no `vnode._dom` — and `_dom` is the
// anchor the next diff inserts before. So the first time such a component
// returned an element, the reconciler had nothing to insert before and
// APPENDED it to the parent instead. A field app's approval prompt, written as
// the first child of its panel, rendered LAST: below a screenful of settings
// and off the bottom of a window it did not fit in. Silent, visual, and it
// cannot fire until the component first becomes visible — so every test that
// starts in the visible state passes.
//
// The fix is the `_Null` placeholder null CHILDREN have used since AIO-107 and
// that SSR already emits, applied at the component boundary too: create, diff,
// hydrate, AND the signal re-render path (that last one is why the SECOND
// appearance could still be misplaced after the first was fixed).
//
// Every `x ? <El/> : null` component has this shape — banners, toasts, modals,
// alerts, validation messages — and those are precisely the ones whose
// position carries meaning.
import { assert, assertEquals } from "@std/assert";
import { cell } from "aio";
import { testUI } from "aio/testing";
import { Window } from "happy-dom";
import { h, renderToString } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
} from "../src/air/aio-renderer.ts";

const c = cell("nullpos", {
  state: { asked: false },
  methods: {
    ask(s) {
      s.asked = true;
    },
    clear(s) {
      s.asked = false;
    },
  },
});

/** The reported shape: an absent-by-default prompt written FIRST. */
function Approval() {
  return c.asked ? <section class="ask">Allow?</section> : null;
}

function App() {
  return (
    <main class="panel">
      <Approval />
      <div class="strip">link</div>
      <section class="block">settings</section>
    </main>
  );
}

const classes = () =>
  [...(document.querySelector(".panel")?.children ?? [])].map((e) =>
    (e as Element).className
  );

testUI(
  App,
  "a null component returns to the position it was written in",
  async (ui) => {
    assertEquals(
      classes(),
      ["strip", "block"],
      "nothing rendered while absent",
    );

    c.ask();
    await ui.settle();
    assertEquals(
      classes(),
      ["ask", "strip", "block"],
      "the prompt must render FIRST — where it is written — not appended last",
    );

    // …and again, after going away. The signal re-render path is a DIFFERENT
    // path from the initial diff: with only the first fixed, the prompt came
    // back correctly once and was appended every time after.
    c.clear();
    await ui.settle();
    assertEquals(classes(), ["strip", "block"]);
    c.ask();
    await ui.settle();
    assertEquals(
      classes(),
      ["ask", "strip", "block"],
      "position must survive the second and every later appearance",
    );
    c.clear();
    await ui.settle();
  },
);

Deno.test("SSR and hydration agree about an absent component's position", () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  try {
    const Absent = () => null;
    const Page = () =>
      h("main", null, h(Absent, null), h("div", { class: "after" }, "x"));

    // SSR emits the placeholder…
    const html = renderToString(h(Page, null));
    assert(
      html.startsWith("<main><!---->"),
      `SSR must reserve the slot, got: ${html}`,
    );

    // …mount agrees with it, so hydration has the node it expects instead of
    // rebuilding one step out of alignment (which is how a null-first
    // component hydrated correctly and then MOVED on its first re-render).
    const host = doc.createElement("div");
    doc.body.appendChild(host);
    const m = mount(host, Page);
    assertEquals(host.innerHTML, html);
    _unmount(m);

    host.innerHTML = html;
    const hy = hydrate(host, Page);
    assertEquals(host.innerHTML, html, "hydration must not move or drop nodes");
    _unmount(hy);
    host.remove();
  } finally {
    win.happyDOM.close();
  }
});
