// A component that RE-RENDERS to something that is not a node (an array, a
// boolean, a promise …) fails exactly like a body that threw: the last good
// output stays, an enclosing <ErrorBoundary> shows its fallback, and the next
// good render replaces it cleanly.
//
// The return value used to be checked only later, by `createDom`, after it had
// already been stored as the component's `_rendered`. The diff then threw
// half-way: the old output was never removed, so once the component recovered
// its first good render landed NEXT TO a ghost of the old one that stayed on
// the page through every later render — and the root unmount died walking the
// stored array (`_cleanupChildren is not a function or its return value is not
// iterable`). Both re-render paths — the component's own signal, and a parent
// that re-renders it with new props — are pinned.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { ErrorBoundary, h, type VNode } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

const BAD: Array<[string, unknown]> = [
  ["an array", ["x", "y"]],
  ["a boolean", false],
];

async function run(
  shape: "self" | "parent",
  bad: unknown,
  boundary: boolean,
): Promise<{ seen: string[]; errors: number }> {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  setDevMode(false);
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a[0]);
  try {
    const s = signal(1);
    const Self = () => (s() === 0 ? bad : h("b", null, String(s()))) as VNode;
    const Prop = (p: { n: number }) =>
      (p.n === 0 ? bad : h("b", null, String(p.n))) as VNode;
    const child = () => shape === "self" ? h(Self, null) : h(Prop, { n: s() });
    const App = () => {
      if (shape === "parent") s(); // the PARENT reads it, so it re-renders
      const c = child();
      return h(
        "div",
        null,
        h("i", null, "L"),
        boundary
          ? h(ErrorBoundary as never, { fallback: () => h("u", null, "!") }, c)
          : c,
        h("i", null, "R"),
      );
    };
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const handle = mount(root, App);
    const seen: string[] = [];
    for (const v of [0, 2, 3]) {
      s.set(v);
      handle._flush();
      await new Promise((r) => setTimeout(r, 0));
      seen.push(root.innerHTML.replace(/<!---->/g, ""));
    }
    _unmount(handle); // must not throw
    assertEquals(root.innerHTML, "");
    return { seen, errors: errors.length };
  } finally {
    console.error = orig;
    await closeWindow(win);
  }
}

for (const shape of ["self", "parent"] as const) {
  for (const [what, bad] of BAD) {
    Deno.test(`a ${shape} re-render that returns ${what} keeps the last good output and recovers cleanly`, async () => {
      const { seen, errors } = await run(shape, bad, false);
      assertEquals(seen, [
        "<div><i>L</i><b>1</b><i>R</i></div>",
        "<div><i>L</i><b>2</b><i>R</i></div>",
        "<div><i>L</i><b>3</b><i>R</i></div>",
      ]);
      assert(errors > 0, "the bad return was not reported");
    });
  }
}

Deno.test("a re-render that returns an array under an <ErrorBoundary> shows the fallback, then recovers", async () => {
  const { seen } = await run("self", ["x", "y"], true);
  assertEquals(seen, [
    "<div><i>L</i><u>!</u><i>R</i></div>",
    "<div><i>L</i><b>2</b><i>R</i></div>",
    "<div><i>L</i><b>3</b><i>R</i></div>",
  ]);
});
