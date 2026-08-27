// `connectAioDevTools().tree` — the documented component tree.
//
// It was dead for the life of the feature: the handle read a `_treeSig` that
// only an exported `_updateTree` ever wrote, whose own doc said it was "called
// by the renderer periodically in dev mode" — and nothing in `src/` or `tests/`
// called it. So the public getter returned `[]` forever, and the JSDoc example
// beside it ("Read devtools.tree for component hierarchy") described something
// that could not happen. Nothing failed, because nothing asked.
//
// It is a PULL now (`src/air/devtools-tree.ts` walks the live roots on demand).
// The last test here is why: a push channel and a component that renders the
// tree are a feedback loop — publishing re-renders the viewer, which bumps its
// own render count, which changes the tree, which publishes again.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { connectAioDevTools } from "../src/diagnostics/devtools.ts";
import { signal } from "../src/state/signal.ts";
import type { ComponentTreeNode } from "../src/diagnostics/devtools.ts";

function env() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  return { win, doc, cleanup: () => win.happyDOM.close() };
}

const names = (nodes: ComponentTreeNode[]): string[] =>
  nodes.flatMap((n) => [n.name, ...names(n.children)]);

function find(nodes: ComponentTreeNode[], name: string): ComponentTreeNode {
  for (const n of nodes) {
    if (n.name === name) return n;
    const hit = find(n.children, name);
    if (hit) return hit;
  }
  return undefined as unknown as ComponentTreeNode;
}

Deno.test("devtools.tree reports the mounted component hierarchy", () => {
  const { doc, cleanup } = env();
  const dt = connectAioDevTools();
  try {
    const count = signal(0, "dt-tree-count");
    const Leaf = (p: { label: string }) => h("span", null, p.label);
    const Middle = () =>
      h("div", null, h(Leaf, { label: "a" }), h(Leaf, { label: "b" }));
    const App = () => h("section", null, String(count.value), h(Middle, null));

    const host = doc.createElement("main");
    doc.body.appendChild(host);
    const handle = mount(host, App);

    const tree = dt.tree;
    assertEquals(
      names(tree),
      ["App", "Middle", "Leaf", "Leaf"],
      "the walk must descend THROUGH host elements and nest components under " +
        "their nearest component ancestor",
    );
    const app = tree[0]!;
    assert(app.renderCount >= 1, `App renderCount was ${app.renderCount}`);
    assert(
      app.signalCount >= 1,
      `App reads one signal, so signalCount must be >= 1, got ${app.signalCount}`,
    );
    // Props are carried, minus `children` (which would serialize the subtree
    // back into every node).
    const leaf = find(tree, "Leaf");
    assert(leaf, `no Leaf in ${JSON.stringify(names(tree))}`);
    assertEquals(leaf.props.label, "a");
    assert(
      !("children" in leaf.props),
      "the subtree must not ride along in props",
    );

    // A re-render is visible in the tree — the whole point of the handle.
    const before = tree[0]!.renderCount;
    count.set(1);
    handle._flush();
    assert(
      dt.tree[0]!.renderCount > before,
      `App re-rendered but its renderCount stayed at ${before}`,
    );

    _unmount(handle);
    assertEquals(dt.tree, [], "an unmounted root contributes no components");
  } finally {
    dt.disconnect();
    cleanup();
  }
});

Deno.test("devtools.tree does not feed back into the render loop", () => {
  const { doc, cleanup } = env();
  const dt = connectAioDevTools();
  try {
    let renders = 0;
    const Viewer = () => {
      renders++;
      return h("pre", null, String(dt.tree.length));
    };
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    const handle = mount(host, Viewer);
    for (let i = 0; i < 5; i++) handle._flush();
    assertEquals(
      renders,
      1,
      `a component that RENDERS the devtools tree must not re-render itself ` +
        `by doing so — it rendered ${renders} times`,
    );
    _unmount(handle);
  } finally {
    dt.disconnect();
    cleanup();
  }
});
