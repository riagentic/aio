// A boundary that catches while it is being CREATED must record the discard,
// exactly as the diff path does.
//
// `_sweepDiscarded` only walks when the discard epoch moved during a render.
// A component body that throws moves it (`abortComponent`), and so does a
// catch in `_diffErrorBoundary` / `_diffSuspense`. The CREATION catches — the
// `<ErrorBoundary>` / `<Suspense>` branches of `createDom`, and the hydrate
// region catch — did not, so a throw that was not a component body's (a
// malformed child a wrapper returned) left the wrapper built, subscribed and
// unswept. Measured before the fix, a boundary mounted fresh on each of 21
// toggles over `<Wrapper>` reading `w` and rendering a non-node:
//
//   ErrorBoundary        w subscribers 11, still 11 after unmount
//   Suspense inside one  w subscribers 11, still 11 after unmount
//   hydrate              w subscribers 1 after unmount
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  type ComponentFn,
  ErrorBoundary,
  h,
  renderToString,
  Suspense,
  type VNode,
} from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
} from "../src/air/aio-renderer.ts";
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
  const origWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    await body(doc);
  } finally {
    console.error = origErr;
    console.warn = origWarn;
    await closeWindow(win);
  }
}

const boundary = (children: VNode[]) =>
  h(ErrorBoundary, { fallback: () => h("i", null, ["err"]) }, children);

for (const kind of ["ErrorBoundary", "Suspense inside an ErrorBoundary"]) {
  Deno.test(`mount catch: a malformed child under a boundary mounted fresh on each toggle leaks nothing — ${kind}`, async () => {
    await withDom((doc) => {
      const root = doc.createElement("div");
      doc.body.appendChild(root);
      const w = signal(0);
      const show = signal(false);
      // Not a node — `createDom` throws, and no component body did.
      const Wrapper = () =>
        h("section", null, [
          String(w.value),
          { nope: true } as unknown as string,
        ]);
      const region = () =>
        kind === "ErrorBoundary" ? boundary([h(C(Wrapper), null)]) : boundary([
          h(Suspense, { fallback: "loading" }, [h(C(Wrapper), null)]),
        ]);
      const App = () => h("div", null, [show.value ? region() : "off"]);
      const hd = mount(root, C(App));
      for (let i = 1; i <= 21; i++) {
        show.set(!show.value);
        hd._flush();
      }
      assertEquals(root.innerHTML, "<div><i>err</i></div>");
      assertEquals(subs(w) <= 1, true, `w subscribers: ${subs(w)}`);
      _unmount(hd);
      assertEquals(subs(w), 0);
    });
  });
}

Deno.test("hydrate catch: a wrapper discarded by a boundary claiming its server fallback is retired", async () => {
  await withDom((doc) => {
    const w = signal(0);
    const Wrapper = () => (void w.value, { nope: true } as unknown as VNode);
    const App = () => h("div", null, [boundary([h(C(Wrapper), null)])]);
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    root.innerHTML = renderToString(h(C(App), null));
    assertEquals(root.innerHTML, "<div><i>err</i></div>");
    const serverI = root.querySelector("i");
    const hd = hydrate(root, C(App));
    assertEquals(root.querySelector("i") === serverI, true, "fallback adopted");
    _unmount(hd);
    assertEquals(subs(w), 0);
  });
});
