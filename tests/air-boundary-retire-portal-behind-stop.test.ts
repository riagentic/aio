// A boundary that falls back on an update unmounts ALL of its old children —
// also the ones behind the point where its region ran out of nodes.
//
// Retiring a region walks the old children over the nodes between the
// boundary's bounds. A failed diff may already have taken nodes out, so the
// walk reaches the node past the region before the model is done — and it
// STOPPED there. Whatever came after was never unmounted: a `<Portal>` kept
// its content in its target (the next mount put a second copy beside it, and
// one stayed on the page after the app was unmounted), and a component kept
// what its `onUnmount` releases. It needed a node after the boundary — a
// footer — which is why no test had one. Found by the lifecycle differential
// once it could unwrap a container (tests/air-lifecycle-differential.test.ts,
// FUZZ_SEED=99 ROUNDS=1500 STEPS=20).
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { ErrorBoundary, Fragment, h, Portal } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  onUnmount,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

Deno.test("boundary retire: a portal and a component behind the end of the region are unmounted — no second copy, nothing left after unmount", async () => {
  const win = new Window({ url: "https://localhost" });
  const orig = { warn: console.warn, error: console.error };
  console.warn = console.error = () => {};
  try {
    const doc = win.document as unknown as Document;
    _setDocument(doc);
    const root = doc.createElement("div") as unknown as HTMLElement;
    const toast = doc.createElement("aside") as unknown as HTMLElement;
    const menu = doc.createElement("aside") as unknown as HTMLElement;
    doc.body.append(root as unknown as Node, toast as unknown as Node);
    const n = signal(0);
    let held = 0;
    const Holder = () => {
      held++;
      onUnmount(() => void held--);
      return null;
    };
    const Thrower = (p: { boom: boolean }) => {
      if (!p.boom) return null;
      throw new Error("thrown on purpose");
    };
    const boundary = (...kids: unknown[]) =>
      h(ErrorBoundary as never, { fallback: () => "!" }, ...kids as never[]);
    // The inner boundary's portal is what takes a node out of the region
    // before the throw: the diff replaces the old inner boundary (showing
    // "!") with it, and a portal occupies no node here.
    const inner = () =>
      boundary(
        h(Portal as never, { target: menu }),
        h(Thrower as never, { boom: n.value >= 1 }),
      );
    const saved = () => h(Portal as never, { target: toast }, "Saved");
    const App = () =>
      h(
        "main",
        null,
        h(
          Fragment,
          null,
          // 0, 1: one boundary around both. 2: the wrapper is gone.
          ...(n.value < 2
            ? [boundary(inner(), saved(), h(Holder, null))]
            : [inner(), saved()]),
        ),
        h("footer", null, "f"),
      );
    const handle = mount(root, App as ComponentFn);
    handle._flush();
    assertEquals([toast.textContent, held], ["Saved", 1]);
    for (const v of [1, 2]) {
      n.set(v);
      handle._flush();
    }
    assertEquals(root.textContent, "!f");
    assertEquals(toast.textContent, "Saved", "one copy, not two");
    assertEquals(held, 0, "the component behind the stop was unmounted");
    _unmount(handle);
    assertEquals(toast.innerHTML, "", "nothing of the app outlives it");
  } finally {
    console.warn = orig.warn;
    console.error = orig.error;
    await closeWindow(win);
  }
});
