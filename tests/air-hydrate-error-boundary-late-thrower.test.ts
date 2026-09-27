// Hydrating an ErrorBoundary whose SERVER render showed its fallback, when the
// thrower is NOT the boundary's first child.
//
// The markup at the boundary's slot is the fallback, and hydrate only learns
// that when a child throws — so every sibling before the thrower used to be
// hydrated against the fallback's nodes first. Depending on what they met:
//   - a mismatch: `hydrate()` threw the whole server page away for a client
//     render (dev warning; in prod, silently) and every component ran twice;
//   - an accidental match: the discarded siblings wrote into the fallback — a
//     null slot's `<!---->` appended beside it, their props and listeners on
//     the fallback's element.
// Found by tests/air-ssr-hydrate-mount-differential.test.ts (the former
// LATE_SSR_THROWER mask). Every case is asserted against mount(), never
// against a literal.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  type ComponentFn,
  ErrorBoundary,
  h,
  renderToString,
  type VNode,
} from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

const tick = () => new Promise((r) => setTimeout(r, 10));

interface Env {
  doc: Document;
  warns: string[];
}

async function withDoc(fn: (env: Env) => Promise<void>) {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const warns: string[] = [];
  const origWarn = console.warn, origErr = console.error;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  console.error = () => {}; // the caught render errors are logged; not under test
  const g = globalThis as Record<string, unknown>;
  const origDev = g.__aioDev;
  g.__aioDev = true; // dev: a hydrate divergence warns
  setDevMode(false);
  setDevMode("auto");
  try {
    await fn({ doc, warns });
  } finally {
    console.warn = origWarn;
    console.error = origErr;
    g.__aioDev = origDev;
    setDevMode("auto");
    await closeWindow(win);
  }
}

function host(doc: Document): HTMLElement {
  const el = doc.createElement("main");
  doc.body.appendChild(el);
  return el;
}

const hydrateWarnings = (warns: string[]) =>
  warns.filter((w) => w.includes("hydrate()"));

Deno.test("hydrate: a late thrower's earlier sibling does not discard the server page", async () => {
  await withDoc(async ({ doc, warns }) => {
    const bad = signal(true);
    let beforeRuns = 0;
    const Before = () => {
      beforeRuns++;
      return h("span", null, "before");
    };
    const Boom = () => {
      if (bad.value) throw new Error("boom");
      return h("em", null, "ok");
    };
    const App = () =>
      h(
        "div",
        null,
        h(
          ErrorBoundary,
          { fallback: (e: Error) => h("p", null, e.message) },
          h(Before, null),
          h(Boom, null),
        ),
      );

    const m = host(doc);
    const mh = mount(m, App as ComponentFn);
    const mountRuns = beforeRuns;
    beforeRuns = 0;

    const hHost = host(doc);
    hHost.innerHTML = renderToString(h(App, null));
    const serverFallback = hHost.querySelector("p");
    assert(serverFallback, "the server rendered the fallback");
    beforeRuns = 0;
    warns.length = 0;
    const hh = hydrate(hHost, App as ComponentFn);

    assertEquals(hydrateWarnings(warns), [], "hydrate reported a divergence");
    // The server's fallback node is adopted, not re-created by a client render.
    assertStrictEquals(hHost.querySelector("p"), serverFallback);
    assertEquals(hHost.innerHTML, m.innerHTML);
    // Every component body ran once, as on mount — no second, client render.
    assertEquals(beforeRuns, mountRuns);

    // …and the hydrated boundary recovers exactly like the mounted one.
    bad.set(false);
    await tick();
    assertEquals(hHost.innerHTML, m.innerHTML);
    assert(hHost.innerHTML.includes("<em>ok</em>"), hHost.innerHTML);
    _unmount(mh);
    _unmount(hh);
  });
});

Deno.test("hydrate: a late thrower's null siblings leave no stray comment beside the fallback", async () => {
  await withDoc(async ({ doc, warns }) => {
    const Empty = () => null;
    const Boom = () => {
      throw new Error("boom");
    };
    // The fallback is nothing (one `<!---->`); `Empty` claims it, the bare
    // `null` finds no node and used to APPEND one, then `Boom` threw.
    const App = () =>
      h(
        "div",
        null,
        h(
          ErrorBoundary,
          { fallback: () => null },
          h(Empty, null),
          null,
          h(Boom, null),
        ),
      );
    const m = host(doc);
    const mh = mount(m, App as unknown as ComponentFn);
    const hHost = host(doc);
    hHost.innerHTML = renderToString(h(App as unknown as ComponentFn, null));
    warns.length = 0;
    const hh = hydrate(hHost, App as unknown as ComponentFn);
    assertEquals(hydrateWarnings(warns), []);
    assertEquals(hHost.innerHTML, m.innerHTML);
    assertEquals(hHost.querySelector("div")!.childNodes.length, 1);
    _unmount(mh);
    _unmount(hh);
  });
});

Deno.test("hydrate: a late thrower's sibling that matches the fallback's tag writes nothing onto it", async () => {
  await withDoc(async ({ doc, warns }) => {
    let discardedClicks = 0;
    const Boom = () => {
      throw new Error("boom");
    };
    const fallback = (e: Error): VNode => h("b", { class: "fb" }, e.message);
    const App = () =>
      h(
        "div",
        null,
        h(
          ErrorBoundary,
          { fallback },
          h("b", { class: "kid", onClick: () => discardedClicks++ }, "x"),
          h(Boom, null),
        ),
      );
    const m = host(doc);
    const mh = mount(m, App as ComponentFn);
    const hHost = host(doc);
    hHost.innerHTML = renderToString(h(App, null));
    const serverB = hHost.querySelector("b")!;
    warns.length = 0;
    const hh = hydrate(hHost, App as ComponentFn);
    // The discarded `<b class="kid">` claimed the fallback's `<b>` and rewrote
    // its class, so the fallback's own hydration reported a divergence.
    assertEquals(hydrateWarnings(warns), []);
    assertStrictEquals(hHost.querySelector("b"), serverB);
    assertEquals(hHost.innerHTML, m.innerHTML);
    // …and its listener stayed on the fallback's element.
    serverB.dispatchEvent(
      new (doc.defaultView as unknown as Window).Event(
        "click",
        { bubbles: true },
      ) as unknown as Event,
    );
    assertEquals(discardedClicks, 0);
    _unmount(mh);
    _unmount(hh);
  });
});
