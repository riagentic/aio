// `hydrate()` is `mount()` over markup that already exists. Anything the one
// does and the other does not is a bug you can only see on a server-rendered
// page — the exact path least likely to be exercised by a unit test and most
// likely to be what a user loads first.
//
// ErrorBoundary and Suspense are decided in THREE places: `createDom` (mount),
// `renderToString` (the server) and `_hydrateNode` (hydration). The first two
// caught; the third did not. So a boundary that works in dev, works in the
// harness, and renders its fallback correctly in the server HTML let the error
// escape `hydrate()` — the app never booted and the page sat there as a dead
// screenshot of itself, fully painted, with no handlers and no updates. Same
// for a lazy component: `<Suspense>` rendered its fallback on the server and
// then threw `_LAZY_PENDING` out of hydration on the client.
//
// The class is "hydrate forgot a rule the other two commit paths have", so each
// test below asserts hydrate against MOUNT, never against a literal.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import {
  type ComponentFn,
  ErrorBoundary,
  h,
  lazy,
  renderToString,
  Suspense,
} from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
} from "../src/air/aio-renderer.ts";

function env() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  return { win, doc, cleanup: () => win.happyDOM.close() };
}

/** What `mount()` produces, and what SSR produces — they must already agree. */
// deno-lint-ignore no-explicit-any
function mounted(doc: Document, App: any): string {
  const host = doc.createElement("main");
  doc.body.appendChild(host);
  const handle = mount(host, App);
  const html = host.innerHTML;
  _unmount(handle);
  host.remove();
  return html;
}

Deno.test("hydrate: an ErrorBoundary catches a render throw, exactly like mount", () => {
  const { doc, cleanup } = env();
  try {
    const Boom = () => {
      throw new Error("boom");
    };
    const App = () =>
      h(
        "div",
        null,
        h(
          ErrorBoundary,
          { fallback: (e: Error) => h("p", null, `caught: ${e.message}`) },
          h(Boom, null),
        ),
        h("i", null, "sibling"),
      );

    const ssr = renderToString(h(App, null));
    const csr = mounted(doc, App);
    assertEquals(ssr, csr, "SSR and mount must agree before hydrate is judged");

    const host = doc.createElement("main");
    doc.body.appendChild(host);
    host.innerHTML = ssr;
    // Before: this THREW out of hydrate() and the app never booted.
    const handle = hydrate(host, App);
    try {
      assertEquals(
        host.innerHTML,
        csr,
        "a hydrated ErrorBoundary must show the fallback its own server " +
          "render already put on the page",
      );
    } finally {
      _unmount(handle);
    }
  } finally {
    cleanup();
  }
});

Deno.test("hydrate: an ErrorBoundary keeps its siblings interactive", () => {
  const { win, doc, cleanup } = env();
  try {
    let clicks = 0;
    const Boom = () => {
      throw new Error("nope");
    };
    const App = () =>
      h(
        "div",
        null,
        h(
          ErrorBoundary,
          { fallback: () => h("p", null, "fallback") },
          h(
            Boom,
            null,
          ),
        ),
        h("button", { onClick: () => clicks++ }, "go"),
      );

    const host = doc.createElement("main");
    doc.body.appendChild(host);
    host.innerHTML = renderToString(h(App, null));
    const handle = hydrate(host, App);
    try {
      const button = host.querySelector("button")!;
      button.dispatchEvent(
        new win.Event("click", { bubbles: true }) as unknown as Event,
      );
      assertEquals(
        clicks,
        1,
        "the error escaped hydration, so nothing on the page was ever wired up",
      );
    } finally {
      _unmount(handle);
    }
  } finally {
    cleanup();
  }
});

Deno.test("hydrate: a boundary with no fallback still reports its error", () => {
  const { doc, cleanup } = env();
  try {
    const Boom = () => {
      throw new Error("unhandled");
    };
    const App = () => h("div", null, h(ErrorBoundary, null, h(Boom, null)));
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    host.innerHTML = "<div></div>";
    let thrown: unknown;
    try {
      hydrate(host, App);
    } catch (e) {
      thrown = e;
    }
    // Fail LOUD: a boundary that cannot render anything must not swallow.
    assert(
      thrown instanceof Error && thrown.message === "unhandled",
      `a fallback-less boundary must rethrow, got ${String(thrown)}`,
    );
  } finally {
    cleanup();
  }
});

Deno.test("hydrate: Suspense adopts its server fallback and resolves onto it", async () => {
  const { doc, cleanup } = env();
  try {
    let resolveIt = () => {};
    const Lazy = lazy(() =>
      new Promise<{ default: ComponentFn }>((res) => {
        resolveIt = () => res({ default: () => h("b", null, "loaded") });
      })
    );
    const App = () =>
      h(
        "div",
        null,
        h(
          Suspense,
          { fallback: h("p", null, "loading") },
          h(Lazy as unknown as ComponentFn, null),
        ),
      );

    const ssr = renderToString(h(App, null));
    assertEquals(ssr, "<div><p>loading</p></div>");

    const host = doc.createElement("main");
    doc.body.appendChild(host);
    host.innerHTML = ssr;
    // Before: `_LAZY_PENDING` escaped hydration — every page with a lazy
    // component below a Suspense boundary failed to boot when server-rendered.
    const handle = hydrate(host, App);
    try {
      assertEquals(host.innerHTML, ssr, "the fallback markup must be adopted");
      resolveIt();
      await new Promise((r) => setTimeout(r, 0));
      handle._flush();
      await new Promise((r) => setTimeout(r, 0));
      assertEquals(
        host.innerHTML,
        "<div><b>loaded</b></div>",
        "the resolved component must replace the hydrated fallback",
      );
    } finally {
      _unmount(handle);
    }
  } finally {
    cleanup();
  }
});
