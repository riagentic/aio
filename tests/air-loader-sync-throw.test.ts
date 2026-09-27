// A `lazy()` / `<Defer load>` loader that throws SYNCHRONOUSLY (a plain
// function, not `async`: a route table lookup that misses, a guard that
// refuses) is a failed load like a rejected import — the same gap resource()
// had. lazy() left `loading` set for good, so the <Suspense> fallback spun
// forever with no retry; <Defer> stayed on its `loading` view, the throw
// escaping the mount. An island's `load` threw out of its onMount instead of
// the "[aio:island] Failed to load module" report.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, lazy, Suspense } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { Defer } from "../src/air/defer.ts";
import { island } from "../src/air/island.ts";
import { signal } from "../src/state/signal.ts";

function setup() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  _setDocument(doc);
  return { root, cleanup: () => closeWindow(win) };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

Deno.test("lazy: a loader's synchronous throw is a failed load — reported, and a later attempt can succeed", async () => {
  const { root, cleanup } = setup();
  const realError = console.error;
  const errs: string[] = [];
  console.error = (...a: unknown[]) => void errs.push(String(a[0]));
  let fail = true;
  const LazyComp = lazy((): Promise<{ default: ComponentFn }> => {
    if (fail) throw new Error("no such route");
    return Promise.resolve({ default: () => h("b", null, "ok") });
  });
  const tick = signal(0);
  const App =
    () => (void tick.value,
      h(Suspense, { fallback: h("i", null, "…") }, h(LazyComp, null)));
  let handle;
  try {
    handle = mount(root, App);
    await settle();
    assert(errs.some((e) => e.includes("[aio:lazy]")), JSON.stringify(errs));
    fail = false;
    // Past the backoff (first retry after 1s at most).
    await new Promise((r) => setTimeout(r, 1100));
    // The render past the backoff re-throws the cached error once and
    // clears it (as for a rejected import); the next one loads again.
    for (let i = 1; i <= 2; i++) {
      tick.set(i);
      handle._flush();
      await settle();
      handle._flush();
    }
    assertEquals(root.innerHTML, "<b>ok</b>");
  } finally {
    console.error = realError;
    if (handle) _unmount(handle);
    await cleanup();
  }
});

Deno.test("Defer: a load() that throws synchronously renders the error view", async () => {
  const { root, cleanup } = setup();
  const realError = console.error;
  const errs: string[] = [];
  console.error = (...a: unknown[]) => void errs.push(String(a[0]));
  let handle;
  try {
    handle = mount(root, () =>
      h(Defer, {
        trigger: "immediate",
        load: (): Promise<{ default: ComponentFn }> => {
          throw new Error("refused");
        },
        loading: h("span", null, "loading"),
        error: h("span", null, "failed"),
      }));
    await settle();
    handle._flush();
    assertEquals(root.innerHTML.includes("failed"), true, root.innerHTML);
    assert(errs.some((e) => e.includes("[aio:Defer]")), JSON.stringify(errs));
  } finally {
    console.error = realError;
    if (handle) _unmount(handle);
    await cleanup();
  }
});

Deno.test("island: a load() that throws synchronously is reported as a failed load", async () => {
  const { root, cleanup } = setup();
  const realError = console.error;
  const errs: string[] = [];
  console.error = (...a: unknown[]) => void errs.push(String(a[0]));
  let handle;
  try {
    const Chart = island({
      load: (): Promise<unknown> => {
        throw new Error("refused");
      },
      mount: () => ({ update() {}, unmount() {} }),
      props: () => ({}),
    });
    handle = mount(root, () => h(Chart, null));
    await settle();
    assert(
      errs.some((e) => e.includes("[aio:island] Failed to load module")),
      JSON.stringify(errs),
    );
  } finally {
    console.error = realError;
    if (handle) _unmount(handle);
    await cleanup();
  }
});
