// A component hydrated inside an ErrorBoundary whose sibling boundary fell
// back runs inside an ATTEMPT: its element's props pass is queued and runs
// after the component stamped `data-component` on its root (explicit dev
// mode). The queued sweep then stripped the stamp as a "server-only
// attribute" and fired the server/client divergence warning on correct
// markup. Found by tests/air-stateful-differential.test.ts (hydrate mode).
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { ErrorBoundary, h, renderToString } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  setDevMode,
} from "../src/air/aio-renderer.ts";

const Boom: ComponentFn = () => {
  throw new Error("boom");
};
const Leaf: ComponentFn = () => h("u", null, "x");
const Stable: ComponentFn = () => h("q", null, h(Leaf, null));
const App: ComponentFn = () =>
  h(
    ErrorBoundary as never,
    { fallback: () => h("b", null, "!") },
    h(
      ErrorBoundary as never,
      { fallback: () => h("b", null, "!") },
      h(Boom, null),
    ),
    h(Stable, null),
  );

Deno.test("hydrate inside a boundary attempt keeps the dev stamp and stays quiet", async () => {
  const win = new Window();
  const doc = win.document;
  _setDocument(doc);
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a.join(" "));
  setDevMode(true);
  try {
    const a = doc.createElement("div");
    a.innerHTML = renderToString(h(App, null));
    const hd = hydrate(a, App);
    hd._flush();
    assertEquals(
      a.innerHTML,
      `<b data-component="App">!</b><q data-component="Stable">` +
        `<u data-component="Leaf">x</u></q>`,
    );
    assertEquals(warns.filter((w) => /disagrees/.test(w)), []);
    _unmount(hd);
  } finally {
    console.warn = warn;
    setDevMode("auto");
    await closeWindow(win);
  }
});
