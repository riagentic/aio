// Scope isolation: a render must not leave a scope open — not when it
// succeeds, and not when it THROWS.
//
// A component render opens three module-global scopes at once (dependency
// tracking, computed collection, effect collection) plus a lifecycle
// collector, and closes them in a DIFFERENT callback. The discipline is real —
// the throw path unwinds through `abortComponent`, which closes all three and
// disposes orphaned computeds/effects — but it is spread across five render
// paths (create, diff, hydrate, signal re-render, SSR) that each have to
// remember it, and nothing checked that they all do.
//
// What a missed unwind costs is not a leak, it is a LEAK OF SCOPE: the next
// component's signal reads are collected into the dead component's dependency
// set, so an unrelated component re-renders on a signal it never read — or
// stops re-rendering on one it did. The framework has already paid for this
// class once, in the same file: a throw that skipped a `_instanceStack` pop
// left a dead ancestor winning `useContext` lookups for every later component
// (see renderer-hydrate.ts).
//
// So the invariant is asserted directly, once per path, instead of reviewed.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { _openScopeDepth, signal } from "../src/state/signal.ts";
import { ErrorBoundary, h, renderToString } from "../src/air/vdom.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
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
  return { doc, cleanup: () => win.happyDOM.close() };
}

const clean = () => {
  const d = _openScopeDepth();
  return d.track === 0 && !d.computed && !d.effect;
};

/** A component that reads a signal and then throws — the shape that opens
 *  every scope and then leaves through the abort path. */
const sig = signal(1);
function Boom(): never {
  sig.value; // opens a tracking subscription mid-render
  throw new Error("boom");
}
function Fine() {
  return h("i", null, String(sig.value));
}

Deno.test("scope isolation: mount leaves no scope open, throw or not", () => {
  const { doc, cleanup } = env();
  try {
    assert(clean(), "precondition: no scope open before the test");

    const ok = mount(doc.body, () => h("div", null, h(Fine, null)));
    assert(clean(), "a successful mount left a scope open");
    _unmount(ok);
    assert(clean(), "unmount left a scope open");

    const caught = mount(
      doc.body,
      () =>
        h(
          ErrorBoundary,
          { fallback: () => h("p", null, "err") },
          h(Boom as unknown as () => null, null),
        ),
    );
    assert(clean(), "a component that THREW left a scope open");
    _unmount(caught);
    assert(clean(), "unmount after a throw left a scope open");
  } finally {
    cleanup();
  }
});

Deno.test("scope isolation: a signal re-render leaves no scope open", () => {
  const { doc, cleanup } = env();
  try {
    const s = signal(0);
    const C = () => h("b", null, String(s.value));
    const handle = mount(doc.body, () => h("div", null, h(C, null)));
    assert(clean());
    s.set(1);
    handle._flush();
    assert(clean(), "a signal-driven re-render left a scope open");
    _unmount(handle);
    assert(clean());
  } finally {
    cleanup();
  }
});

Deno.test("scope isolation: hydrate leaves no scope open, throw or not", () => {
  const { doc, cleanup } = env();
  try {
    const App = () => h("div", null, h(Fine, null));
    const html = renderToString(h(App, null));
    assert(clean(), "renderToString left a scope open");

    const host = doc.createElement("main");
    host.innerHTML = html;
    doc.body.appendChild(host);
    const hy = hydrate(host, App);
    assert(clean(), "hydrate left a scope open");
    _unmount(hy);

    const Bad = () =>
      h(
        ErrorBoundary,
        { fallback: () => h("p", null, "err") },
        h(Boom as unknown as () => null, null),
      );
    const badHtml = renderToString(h(Bad, null));
    assert(clean(), "renderToString of a throwing component left a scope open");
    const host2 = doc.createElement("main");
    host2.innerHTML = badHtml;
    doc.body.appendChild(host2);
    const hy2 = hydrate(host2, Bad);
    assert(clean(), "hydrating a thrown-past boundary left a scope open");
    _unmount(hy2);
  } finally {
    cleanup();
  }
});

Deno.test("scope isolation: the SSR streamer leaves no scope open", async () => {
  const { cleanup } = env();
  try {
    const App = () =>
      h(
        "div",
        null,
        h(Fine, null),
        h(ErrorBoundary, {
          fallback: () => h("p", null, "e"),
        }, h(Boom as unknown as () => null, null)),
      );
    let out = "";
    for await (const chunk of renderToStream(h(App, null))) out += chunk;
    // The stream must carry BOTH halves: the component that rendered fine and
    // the boundary's fallback for the one that threw. `out.length > 0` was
    // true of a stream carrying only an empty <div>.
    assertStringIncludes(out, "<i>1</i>");
    assertStringIncludes(out, "<p>e</p>");
    assert(clean(), "renderToStream left a scope open");
  } finally {
    cleanup();
  }
});

Deno.test("scope isolation: one component's reads never land in another's deps", () => {
  const { doc, cleanup } = env();
  try {
    // The consequence a leaked scope actually has: B reads `b` only, so a
    // change to `a` must not re-render it. If a scope from A stayed open, B's
    // reads would be attributed across the boundary and this drifts.
    const a = signal(0), b = signal(0);
    let aRenders = 0, bRenders = 0;
    const A = () => {
      aRenders++;
      return h("i", null, String(a.value));
    };
    const B = () => {
      bRenders++;
      return h("u", null, String(b.value));
    };
    const handle = mount(
      doc.body,
      () => h("div", null, h(A, null), h(B, null)),
    );
    assertEquals([aRenders, bRenders], [1, 1]);

    a.set(1);
    handle._flush();
    assertEquals(
      [aRenders, bRenders],
      [2, 1],
      "B re-rendered on a signal it never read — scopes crossed",
    );

    b.set(1);
    handle._flush();
    assertEquals([aRenders, bRenders], [2, 2]);
    assert(clean());
    _unmount(handle);
  } finally {
    cleanup();
  }
});
