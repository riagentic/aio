// AIO-412: the dev-mode child-alignment invariant (an element must hold exactly
// Σ _domNodeCount(child) DOM nodes after a diff) must stay SILENT on correct
// renders — a detection layer that cries wolf is worse than none. This exercises
// the shapes most likely to trip a naive check (fragments, components rendering
// fragments, portals, mixed dynamic text, nested) across re-renders and asserts
// no `child-desync` warning is ever emitted.

import { assert, assertEquals } from "jsr:@std/assert";
import { signal } from "../src/state/signal.ts";
import { Fragment, h, Portal } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { Window } from "happy-dom";

function dom() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { doc, root, cleanup: () => win.happyDOM.close() };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

Deno.test("child-alignment invariant is silent on correct renders", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  const portalHost = doc.createElement("div");
  doc.body.appendChild(portalHost);

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    const s = a.map(String).join(" ");
    if (s.includes("child-desync") || s.includes("desynced")) warnings.push(s);
  };
  setDevMode(true);
  try {
    const n = signal(0);
    const show = signal(true);
    const Two = () =>
      h(Fragment, null, h("span", null, "P"), h("span", null, "Q"));

    const App = () =>
      h(
        "div",
        { id: "x" },
        h(Two as never, null), // component → fragment (2 nodes)
        `n=${n.value}`, // dynamic text
        show.value ? h("b", null, "!") : null, // conditional → element or _Null
        h(Fragment, null, "a", "b"), // fragment of text
        h(Portal, { target: portalHost }, h("i", null, "port")), // 0 nodes here
        " tail",
      );

    const handle = mount(root, App);
    assertEquals(
      root.querySelector("#x")?.textContent,
      "PQn=0!ab tail",
      "initial",
    );

    n.set(5);
    await tick();
    await tick();
    assertEquals(
      root.querySelector("#x")?.textContent,
      "PQn=5!ab tail",
      "after n change",
    );

    show.set(false);
    await tick();
    await tick();
    assertEquals(
      root.querySelector("#x")?.textContent,
      "PQn=5ab tail",
      "after hide",
    );

    show.set(true);
    n.set(9);
    await tick();
    await tick();
    assertEquals(
      root.querySelector("#x")?.textContent,
      "PQn=9!ab tail",
      "after show+change",
    );

    assert(
      warnings.length === 0,
      `invariant false-positived on correct renders: ${warnings.join(" | ")}`,
    );

    _unmount(handle);
  } finally {
    setDevMode(false);
    console.warn = origWarn;
    await cleanup();
  }
});
