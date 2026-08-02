// ErrorBoundary and Suspense rebuilt their content with `appendChild`,
// which appends to the END of the parent. A boundary with siblings AFTER it
// therefore moved: switching to the fallback (or recovering from it) put the
// new content behind everything that followed it, silently reordering the page.
//
// Both now capture the region the boundary occupies BEFORE tearing it down and
// put the replacement back in the same slot.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { ErrorBoundary, h, lazy, Suspense } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom-types.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

function dom() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { doc, root, cleanup: () => win.happyDOM.close() };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

Deno.test("ErrorBoundary: fallback and recovery keep the boundary's place", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  const boom = signal(true);
  const gen = signal(0); // read by App so the boundary re-diffs on change

  const Volatile = () => {
    if (boom.value) throw new Error("nope");
    return h("span", null, "MIDDLE");
  };
  const App = () =>
    h(
      "div",
      { id: "x", "data-gen": String(gen.value) },
      h("span", null, "BEFORE"),
      h(
        ErrorBoundary,
        { fallback: () => h("span", null, "FALLBACK") },
        h(Volatile as never, null),
      ),
      h("span", null, "AFTER"),
    );

  const handle = mount(root, App);
  assertEquals(
    root.querySelector("#x")?.textContent,
    "BEFOREFALLBACKAFTER",
    "the fallback renders BETWEEN the siblings, not after them",
  );

  boom.set(false); // recover
  gen.set(1);
  handle._flush();
  await tick();
  assertEquals(
    root.querySelector("#x")?.textContent,
    "BEFOREMIDDLEAFTER",
    "recovered content lands back between BEFORE and AFTER",
  );

  boom.set(true); // fail again — the fallback returns to the same slot
  gen.set(2);
  handle._flush();
  await tick();
  assertEquals(
    root.querySelector("#x")?.textContent,
    "BEFOREFALLBACKAFTER",
  );
  _unmount(handle);
  await cleanup();
});

Deno.test("Suspense: the fallback keeps the boundary's place", async () => {
  const { doc, root, cleanup } = dom();
  _setDocument(doc);
  // A loader that never settles: the boundary stays on its fallback, which is
  // what has to sit between the siblings.
  const Slow = lazy(() => new Promise<{ default: ComponentFn }>(() => {}));
  const App = () =>
    h(
      "div",
      { id: "x" },
      h("span", null, "BEFORE"),
      h(Suspense, { fallback: h("i", null, "WAIT") }, h(Slow as never, null)),
      h("span", null, "AFTER"),
    );

  const handle = mount(root, App);
  await tick();
  assertEquals(
    root.querySelector("#x")?.textContent,
    "BEFOREWAITAFTER",
    "the pending fallback renders in the boundary's own position",
  );
  _unmount(handle);
  await cleanup();
});
