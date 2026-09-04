// A lazy module that loads but has no component in it must FAIL, not hang.
//
// `startLoad` set `loading = true`, awaited the import, and assigned
// `resolved = mod.default`. When that is `undefined` the wrapper falls through
// to `startLoad()` on every render — which returns immediately, because
// `loading` is still true and nothing ever clears it. The import SUCCEEDED, so
// the catch (which owns the loud message, the backoff and the retry) never
// ran: the <Suspense> fallback spins forever, with a clean console and no way
// back.
//
// Reached by the commonest mistake there is — `export function Panel` instead
// of `export default` — and by any interop shape that resolves to a namespace
// without a default.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { lazy, Suspense } from "../src/air/vdom.ts";

function setup() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  _setDocument(doc);
  return { root, cleanup: () => win.happyDOM.close() };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

Deno.test("lazy: a module with no default export is reported, not hung", async () => {
  const { root, cleanup } = setup();
  const realError = console.error;
  const errs: string[] = [];
  console.error = (...a: unknown[]) =>
    errs.push(String(a[0]) + " " + String(a[1]));
  // Exactly what `import("./Panel.ts")` resolves to when Panel uses a NAMED
  // export: an object with no `default`.
  const LazyComp = lazy(() =>
    Promise.resolve({ Panel: () => h("div", null, "hi") } as never)
  );
  const App = () =>
    h(Suspense, { fallback: h("span", null, "Loading...") }, h(LazyComp, null));
  const handle = mount(root, App);
  try {
    await settle();
    assert(
      errs.some((e) => /lazy\(\)/.test(e) && /default/.test(e)),
      `the app must be TOLD its lazy module has no component in it — the ` +
        `import succeeded, so nothing else will ever say so. Logged: ${
          JSON.stringify(errs)
        }`,
    );
    assert(
      errs.some((e) => /export default/.test(e)),
      "…and the message must name the fix",
    );
  } finally {
    console.error = realError;
    _unmount(handle);
    await cleanup();
  }
});

Deno.test("lazy: a real default export still renders", async () => {
  const { root, cleanup } = setup();
  const LazyComp = lazy(() =>
    Promise.resolve({ default: () => h("div", null, "loaded") })
  );
  const App = () =>
    h(Suspense, { fallback: h("span", null, "Loading...") }, h(LazyComp, null));
  const handle = mount(root, App);
  try {
    assertEquals(root.innerHTML, "<span>Loading...</span>");
    await settle();
    assert(
      root.innerHTML.includes("loaded"),
      `the component must replace the fallback, got ${root.innerHTML}`,
    );
  } finally {
    _unmount(handle);
    await cleanup();
  }
});
