// A context Provider must reach its children on the SERVER, exactly as it does
// on the client.
//
// The client Provider writes its value into the component instance that
// rendered it, and `useContext` walks the instance stack. The server writers
// call component functions directly — no instance, no stack — so the Provider
// wrote nowhere and every `useContext` answered the default. Measured before
// the fix:
//
//   renderToString(<C.Provider value="provided"><R/></C.Provider>)
//     → "<b>default</b>"
//   <Route path="/dash" element={<Layout/>}><Route path="settings" …/></Route>
//     at /dash/settings → the layout with an empty Outlet
//
// — the nested page never reached the server HTML (the route context is a
// context), and hydration adopted markup the client does not build. Each test
// asserts the server against a client MOUNT of the same tree, never against a
// literal alone.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  type ComponentFn,
  ErrorBoundary,
  h,
  renderToString,
  type VNode,
} from "../src/air/vdom.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import {
  _setDocument,
  _unmount,
  createContext,
  hydrate,
  mount,
  useContext,
  useContextSelector,
} from "../src/air/aio-renderer.ts";
import {
  _getRouterBoot,
  _setRouterBoot,
  Outlet,
  Route,
  routePath,
} from "../src/air/router.ts";

const C = (fn: unknown) => fn as ComponentFn;

async function streamed(v: VNode): Promise<string> {
  let out = "";
  for await (const chunk of renderToStream(v)) out += chunk;
  return out;
}

/** What a client `mount` builds for `App`, and the handle-free teardown. */
async function mounted(App: ComponentFn): Promise<string> {
  const win = new Window({ url: "https://localhost" });
  _setDocument(win.document as unknown as Document);
  try {
    // deno-lint-ignore no-explicit-any
    const host = (win.document as any).createElement("main");
    const handle = mount(host, App);
    const html = host.innerHTML as string;
    _unmount(handle);
    return html;
  } finally {
    await closeWindow(win);
  }
}

const Ctx = createContext("default");
const Read = C(() => h("b", null, useContext(Ctx)));

Deno.test("SSR context: a Provider's value reaches its children — string, stream and mount agree", async () => {
  const App = C(() =>
    h("div", null, h(Ctx.Provider, { value: "provided" }, h(Read, null)))
  );
  const want = "<div><b>provided</b></div>";
  assertEquals(await mounted(App), want);
  assertEquals(renderToString(h(App, null)), want);
  assertEquals(await streamed(h(App, null)), want);
});

Deno.test("SSR context: the nearest Provider wins, and a sibling OUTSIDE it sees the default", async () => {
  const Deep = C(() =>
    h(
      "p",
      null,
      h(Ctx.Provider, { value: "outer" }, [
        h(Read, null),
        h(Ctx.Provider, { value: "inner" }, h(Read, null)),
        h(Read, null),
      ]),
      h(Read, null),
    )
  );
  const want = await mounted(Deep);
  assertEquals(
    want,
    "<p><b>outer</b><b>inner</b><b>outer</b><b>default</b></p>",
  );
  assertEquals(renderToString(h(Deep, null)), want);
  assertEquals(await streamed(h(Deep, null)), want);
});

Deno.test("SSR context: useContextSelector and an ErrorBoundary fallback read the provided value", async () => {
  const Obj = createContext({ n: 0, label: "none" });
  const Sel = C(() =>
    h("i", null, String(useContextSelector(Obj, (v) => v.n)))
  );
  const Boom = C(() => {
    throw new Error("x");
  });
  const FromFallback = C(() => h("u", null, useContext(Obj).label));
  const App = C(() =>
    h(
      "div",
      null,
      h(Obj.Provider, { value: { n: 7, label: "seen" } }, [
        h(Sel, null),
        h(ErrorBoundary, { fallback: () => h(FromFallback, null) }, [
          h(Boom, null),
        ]),
      ]),
    )
  );
  const origErr = console.error;
  console.error = () => {};
  try {
    const want = await mounted(App);
    assertEquals(want, "<div><i>7</i><u>seen</u></div>");
    assertEquals(renderToString(h(App, null)), want);
    assertEquals(await streamed(h(App, null)), want);
  } finally {
    console.error = origErr;
  }
});

Deno.test("SSR context: two interleaved streams keep their own providers", async () => {
  const page = (v: string) =>
    h(Ctx.Provider, { value: v }, h("div", null, h(Read, null), h(Read, null)));
  const a = renderToStream(page("A"));
  const b = renderToStream(page("B"));
  let outA = "";
  let outB = "";
  for (;;) {
    const ra = await a.next();
    const rb = await b.next();
    if (!ra.done) outA += ra.value;
    if (!rb.done) outB += rb.value;
    if (ra.done && rb.done) break;
  }
  assertEquals(outA, "<div><b>A</b><b>A</b></div>");
  assertEquals(outB, "<div><b>B</b><b>B</b></div>");
});

Deno.test("SSR context: a nested route renders its page into the layout's Outlet on the server", async () => {
  const prevBoot = _getRouterBoot();
  const prevPath = routePath.peek();
  _setRouterBoot(() => {});
  try {
    const Layout = C(() =>
      h("section", null, h("h1", null, "dash"), h(C(Outlet), {}))
    );
    const App = C(() =>
      h(
        C(Route),
        { path: "/dash", element: h(Layout, {}) },
        h(C(Route), {
          path: "settings",
          element: h("p", null, "settings-page"),
        }),
        h(C(Route), { path: ":tab/:id", element: h("p", null, "tab") }),
      )
    );
    routePath.set("/dash/settings");
    const want = await mounted(App);
    assertEquals(
      want,
      "<section><h1>dash</h1><p>settings-page</p><!----></section>",
    );
    assertEquals(renderToString(h(App, null)), want);
    assertEquals(await streamed(h(App, null)), want);
  } finally {
    routePath.set(prevPath);
    _setRouterBoot(prevBoot);
  }
});

Deno.test("SSR context: hydrating provided markup adopts the server nodes instead of re-rendering", async () => {
  // The ELEMENT depends on the context, so markup rendered with the default
  // cannot be adopted — a text-only difference would be silently repaired.
  const Tag = C(() => h(useContext(Ctx) === "provided" ? "b" : "s", null, "t"));
  const App = C(() =>
    h("div", null, h(Ctx.Provider, { value: "provided" }, h(Tag, null)))
  );
  const win = new Window({ url: "https://localhost" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  try {
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    host.innerHTML = renderToString(h(App, null));
    const serverB = host.querySelector("b");
    const handle = hydrate(host, App);
    assertEquals(host.innerHTML, "<div><b>t</b></div>");
    assertEquals(
      host.querySelector("b") === serverB,
      true,
      "server <b> adopted",
    );
    _unmount(handle);
  } finally {
    await closeWindow(win);
  }
});
