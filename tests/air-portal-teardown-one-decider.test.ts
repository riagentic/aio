// A portal that never mounted owns nothing in its target — by ONE rule, on
// every way out.
//
// A portal's teardown had two walks: `removeDom` (an unmount) and the diff's
// own copy (a target that changed or went away). The first asked "does this
// portal have a region here?" twice, in two spellings; the second did not ask
// at all and walked a portal with no region from `target.firstChild` — the
// target's own content, or another portal's. A commit that throws part-way is
// kept with the children after the throw never built, so a `<Portal>` behind
// a throwing sibling is exactly that: never mounted, and still in the tree.
//
// Now there is one walk and one answer (`removeDom`'s portal branch). Each
// case below reaches a never-mounted portal through a different door and
// compares what is left in the target with what was there before the portal
// existed; the last test pins that the diff has no walk of its own.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, Portal } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { computed, signal } from "../src/state/signal.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Mount an app whose `<Portal>` sits behind a child that throws while the
 *  update that adds both is committed, then take the `door` out. `a` and `b`
 *  are two targets, each holding content the app does not own. */
async function neverMounted(
  door: "retarget" | "untarget" | "remove" | "unmount",
): Promise<{ a: string; b: string; root: string; refs: unknown[] }> {
  const win = new Window({ url: "https://localhost" });
  const errors = console.error, warns = console.warn;
  console.error = console.warn = () => {};
  try {
    const doc = win.document as unknown as Document;
    _setDocument(doc);
    doc.body.innerHTML = '<div id="app"></div>' +
      '<aside id="a"><header>Brand A</header><p>kept</p></aside>' +
      '<aside id="b"><header>Brand B</header></aside>';
    const el = (id: string) => doc.getElementById(id)!;
    const root = el("app"), a = el("a"), b = el("b");
    const n = signal(0);
    // Every value the never-mounted child's callback ref is handed.
    const refs: unknown[] = [];
    const ref = (v: unknown) => void refs.push(v);
    const boom = computed(() => {
      if (n.value === 1) throw new Error("computed boom");
      return "v" + n.value;
    });
    const App = () =>
      h(
        "main",
        { "data-n": n.value },
        n.value ? boom as never : "plain",
        n.value === 0 || (door === "remove" && n.value === 2) ? null : h(
          Portal,
          {
            target: n.value === 1 ? a : door === "retarget" ? b : null,
          },
          "Saved",
          h("i", { ref }),
        ),
      );
    const handle = mount(root, App as ComponentFn);
    n.set(1); // the commit throws at `boom`; the portal behind it is not built
    await tick();
    assertEquals(a.textContent, "Brand Akept", "the portal never mounted");
    if (door === "unmount") _unmount(handle);
    else {
      n.set(2);
      await tick();
      _unmount(handle);
    }
    return { a: a.innerHTML, b: b.innerHTML, root: root.innerHTML, refs };
  } finally {
    console.error = errors;
    console.warn = warns;
    await closeWindow(win);
  }
}

for (const door of ["retarget", "untarget", "remove", "unmount"] as const) {
  Deno.test(`portal teardown: a portal that never mounted takes nothing out of its target — ${door}`, async () => {
    const left = await neverMounted(door);
    assertEquals(left.a, "<header>Brand A</header><p>kept</p>");
    assertEquals(left.b, "<header>Brand B</header>");
    assertEquals(left.root, "");
    // A ref is told `null` when ITS element leaves. This one never had an
    // element: a `null` here is a detach with no attach before it — and, for
    // a ref shared with a mounted element, the loss of a node still on screen.
    // (Retargeted, the portal does mount in `b`: one element, then its null.)
    assertEquals(
      left.refs.map((v) => v === null ? "null" : "element"),
      door === "retarget" ? ["element", "null"] : [],
      "a ref of an element that was never built",
    );
  });
}

// The same never-built element WITHOUT a portal around it: the diff removes
// it by `removeDom`'s element branch, the other place a ref is detached.
Deno.test("teardown: an element behind the child that threw was never built — removed by the next render, its ref hears nothing", async () => {
  const win = new Window({ url: "https://localhost" });
  const errors = console.error, warns = console.warn;
  console.error = console.warn = () => {};
  try {
    const doc = win.document as unknown as Document;
    _setDocument(doc);
    doc.body.innerHTML = '<div id="app"></div>';
    const root = doc.getElementById("app")!;
    const n = signal(0);
    const refs: unknown[] = [];
    const ref = (v: unknown) => void refs.push(v);
    const boom = computed(() => {
      if (n.value === 1) throw new Error("computed boom");
      return "v" + n.value;
    });
    const App = () =>
      h(
        "main",
        { "data-n": n.value },
        n.value ? boom as never : "plain",
        n.value === 1 ? h("i", { ref }) : null,
      );
    const handle = mount(root, App as ComponentFn);
    n.set(1); // the commit throws at `boom`; the <i> behind it is not built
    await tick();
    assertEquals(root.querySelector("i"), null, "the <i> was built after all");
    n.set(2); // …and the next render takes it out of the tree
    await tick();
    _unmount(handle);
    assertEquals(refs, []);
  } finally {
    console.error = errors;
    console.warn = warns;
    await closeWindow(win);
  }
});

Deno.test("portal teardown: the diff has no walk of its own — removeDom's portal branch is the one decider", async () => {
  const src = (f: string) =>
    Deno.readTextFile(new URL(`../src/air/${f}`, import.meta.url));
  const diff = await src("vdom-diff.ts");
  const at = diff.indexOf("function _diffPortal(");
  const end = diff.indexOf("\nfunction ", at + 1);
  const body = diff.slice(at, end);
  assert(at > 0 && end > at);
  // Both ways out of a target go through `removeDom`…
  assertEquals(body.match(/removeDom\(oldTarget, ov, ctx\)/g)?.length, 2);
  // …and nothing else in the diff walks a portal's region to remove it.
  assertEquals(diff.includes("_removePortalContent"), false);
  // In `removeDom`, the region is asked about once.
  const remove = await src("vdom-remove.ts");
  const from = remove.indexOf(
    "vnode.tag === Portal",
    remove.indexOf("export function removeDom("),
  );
  const branch = remove.slice(from, remove.indexOf("\n    return;", from));
  assertEquals(branch.match(/isChildOf\(anchor, target\)/g)?.length, 1, branch);
  assertEquals(branch.match(/vnode\._anchor\b/g)?.length, 2, branch);
});
