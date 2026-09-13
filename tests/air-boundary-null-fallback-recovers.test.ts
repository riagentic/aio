// A boundary whose fallback renders NOTHING is still showing its fallback.
//
// `_rendered != null` is how every walker asks "is this boundary in its
// fallback?" — the diff (retry the children, or patch them), the teardown
// walks, the discarded-subtree sweep. `fallback={() => null}` and a
// `<Suspense>` with no fallback stored `null` there and so answered "no".
// Measured before the fix:
//
//   <div>{tick}<ErrorBoundary fallback={() => null}>[<Ok/>, "txt", <Thrower r/>]
//   </ErrorBoundary>z</div>
//     throw  → <div>1z</div>
//     ready  → <div>3z</div>      never came back (the diff patched the
//                                 discarded children as if on screen)
//     throw  → <div>5</div>       and the sibling "z" was DELETED
//
//   <Suspense>[<Ok/>, <Lazy/>]</Suspense> resolved → <div>19z<p>loaded</p></div>
//                                 content after its sibling, <Ok/> missing
//
// A fallback of nothing now holds the boundary's slot with a placeholder, as a
// component that renders nothing does; both SSR writers emit its comment so
// hydration stays in step.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  type ComponentFn,
  ErrorBoundary,
  h,
  lazy,
  renderToString,
  Suspense,
  type VNode,
} from "../src/air/vdom.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
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

/** Visible markup: what a user sees, placeholders stripped. */
const seen = (html: string) => html.replaceAll("<!---->", "");

Deno.test("null fallback: an ErrorBoundary showing nothing recovers, in place, and never touches its sibling", async () => {
  await withDom((doc) => {
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const ready = signal(true);
    const tick = signal(0);
    const w = signal(0);
    const Thrower = (p: { r: boolean }) => {
      if (!p.r) throw new Error("x");
      return h("p", null, ["ok"]);
    };
    const Ok = () => h("b", null, [String(w.value)]);
    const App = () =>
      h("div", null, [
        String(tick.value),
        h(ErrorBoundary, { fallback: () => null }, [
          h(C(Ok), null),
          "txt",
          h(C(Thrower), { r: ready.value }),
        ]),
        "z",
      ]);
    const hd = mount(root, C(App));
    const step = (r: boolean, t: number) => {
      ready.set(r);
      tick.set(t);
      hd._flush();
      return seen(root.innerHTML);
    };
    assertEquals(seen(root.innerHTML), "<div>0<b>0</b>txt<p>ok</p>z</div>");
    assertEquals(step(false, 1), "<div>1z</div>");
    assertEquals(step(false, 2), "<div>2z</div>");
    assertEquals(step(true, 3), "<div>3<b>0</b>txt<p>ok</p>z</div>");
    assertEquals(step(false, 4), "<div>4z</div>");
    for (let i = 5; i < 25; i++) step(false, i);
    assertEquals(subs(w) <= 1, true, `w subscribers: ${subs(w)}`);
    assertEquals(step(true, 25), "<div>25<b>0</b>txt<p>ok</p>z</div>");
    _unmount(hd);
    assertEquals([subs(w), subs(ready), subs(tick)], [0, 0, 0]);
  });
});

Deno.test("null fallback: a first-render throw into a null fallback recovers in place", async () => {
  await withDom((doc) => {
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const ready = signal(false);
    const Thrower = () => {
      if (!ready.value) throw new Error("x");
      return h("p", null, ["ok"]);
    };
    const App = () =>
      h("div", null, [
        "a",
        h(ErrorBoundary, { fallback: () => null }, [h(C(Thrower), null)]),
        "z",
      ]);
    const hd = mount(root, C(App));
    assertEquals(root.innerHTML, "<div>a<!---->z</div>");
    ready.set(true);
    hd._flush();
    assertEquals(root.innerHTML, "<div>a<p>ok</p>z</div>");
    _unmount(hd);
    assertEquals(subs(ready), 0);
  });
});

Deno.test("null fallback: a <Suspense> with no fallback shows its content in place once the lazy resolves", async () => {
  await withDom(async (doc) => {
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const show = signal(false);
    const tick = signal(0);
    const w = signal(0);
    let resolve!: (m: { default: ComponentFn }) => void;
    const Lazy = lazy(() => new Promise((r) => (resolve = r)));
    const Ok = () => h("b", null, [String(w.value)]);
    const App = () =>
      h("div", null, [
        String(tick.value),
        h(Suspense, {}, [
          h(C(Ok), null),
          show.value ? h(Lazy, null) : "none",
        ]),
        "z",
      ]);
    const hd = mount(root, C(App));
    show.set(true);
    hd._flush();
    for (let i = 1; i < 20; i++) {
      tick.set(i);
      hd._flush();
    }
    assertEquals(seen(root.innerHTML), "<div>19z</div>");
    assertEquals(subs(w) <= 1, true, `w subscribers: ${subs(w)}`);
    resolve({ default: C(() => h("p", null, ["loaded"])) });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    hd._flush();
    assertEquals(root.innerHTML, "<div>19<b>0</b><p>loaded</p>z</div>");
    _unmount(hd);
    assertEquals(subs(w), 0);
  });
});

Deno.test("null fallback: server markup holds the slot, and hydration adopts the sibling after it", async () => {
  await withDom(async (doc) => {
    const Boom = () => {
      throw new Error("x");
    };
    const Pending = lazy(() => new Promise<never>(() => {}));
    const App = C(() =>
      h("div", null, [
        h(ErrorBoundary, { fallback: () => null }, [h(C(Boom), null)]),
        h(Suspense, {}, [h(Pending, null)]),
        h("b", null, ["after"]),
      ])
    );
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    const handle = mount(host, App);
    const mounted = host.innerHTML;
    _unmount(handle);
    assertEquals(mounted, "<div><!----><!----><b>after</b></div>");
    assertEquals(renderToString(h(App, null)), mounted);
    let streamed = "";
    for await (const c of renderToStream(h(App, null) as VNode)) streamed += c;
    assertEquals(streamed, mounted);

    host.innerHTML = mounted;
    const b = host.querySelector("b");
    const hd = hydrate(host, App);
    assertEquals(host.innerHTML, mounted);
    assertEquals(host.querySelector("b") === b, true, "server <b> adopted");
    _unmount(hd);
  });
});
