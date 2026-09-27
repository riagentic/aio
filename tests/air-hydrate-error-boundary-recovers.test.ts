// docs/ui/air-lifecycle.md, "Error Handling": an ErrorBoundary "catches errors
// during initial render, signal-triggered re-render …" and "Recovery is
// automatic. The failing component stays subscribed to the signals its failed
// render read, so when one of them changes the component is rendered again".
//
// Both halves depend on `_boundaryStack` (renderer-state.ts): `createDom` and
// `_diffErrorBoundary` push the boundary while its children render, so that
// `abortComponent` can lend the thrower's deps to the boundary's owner and each
// component instance remembers the boundary it sits in (`_currentBoundary`).
// `_hydrateNode`'s ErrorBoundary branch never pushes it — so on a HYDRATED page
// a fallback is permanent and a later re-render throw is not caught at all.
// Each case is asserted against mount(), never against a literal.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { ErrorBoundary, h, renderToString } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

const tick = () => new Promise((r) => setTimeout(r, 10));

/** Mount or SSR+hydrate an app whose `Risky` child throws while `s` is 1;
 *  record the markup initially and after each value in `steps`. */
async function trace(
  doc: Document,
  mode: "mount" | "hydrate",
  initial: number,
  steps: number[],
): Promise<string[]> {
  const s = signal(initial);
  const Risky = () => {
    if (s.value === 1) throw new Error("bad");
    return h("b", null, `ok${s.value}`);
  };
  const App = () =>
    h(
      "div",
      null,
      h(
        ErrorBoundary,
        { fallback: (e: Error) => h("p", null, e.message) },
        h(Risky, null),
      ),
    );
  const host = doc.createElement("main");
  doc.body.appendChild(host);
  let handle;
  if (mode === "mount") handle = mount(host, App);
  else {
    host.innerHTML = renderToString(h(App, null));
    handle = hydrate(host, App);
  }
  const out = [host.innerHTML];
  for (const v of steps) {
    s.set(v);
    await tick();
    out.push(host.innerHTML);
  }
  _unmount(handle);
  host.remove();
  return out;
}

async function withDoc(fn: (doc: Document) => Promise<void>) {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const err = console.error;
  console.error = () => {}; // the caught render errors are logged; not under test
  try {
    await fn(doc);
  } finally {
    console.error = err;
    await closeWindow(win);
  }
}

Deno.test("hydrate: a server-rendered ErrorBoundary fallback recovers when the signal changes, like mount", async () => {
  await withDoc(async (doc) => {
    const mounted = await trace(doc, "mount", 1, [2]);
    const hydrated = await trace(doc, "hydrate", 1, [2]);
    assertEquals(mounted, ["<div><p>bad</p></div>", "<div><b>ok2</b></div>"]);
    assertEquals(
      hydrated,
      mounted,
      "hydrated fallback is permanent: the thrower's deps were never lent",
    );
  });
});

Deno.test("hydrate: a hydrated child that starts throwing on re-render is caught by its ErrorBoundary, like mount", async () => {
  await withDoc(async (doc) => {
    const mounted = await trace(doc, "mount", 0, [1]);
    const hydrated = await trace(doc, "hydrate", 0, [1]);
    assertEquals(mounted, ["<div><b>ok0</b></div>", "<div><p>bad</p></div>"]);
    assertEquals(
      hydrated,
      mounted,
      "the hydrated instance does not know its boundary, so the throw is " +
        "isolated and the last good output stays on screen",
    );
  });
});
