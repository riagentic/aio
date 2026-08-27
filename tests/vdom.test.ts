import { assertEquals, assertExists } from "@std/assert";
import { Window } from "happy-dom";
import { ErrorBoundary, Fragment, h, type VNode } from "../src/air/vdom.ts";
import { _diff, _render, setDevMode } from "../src/air/vdom.ts";

// happy-dom timers drained via win.happyDOM.close() — sanitizers re-enabled

function createDOM(): {
  document: Document;
  ctx: { doc: Document };
  cleanup: () => void;
} {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  return { document: doc, ctx: { doc }, cleanup: () => win.happyDOM.close() };
}

Deno.test("h: creates element vnode", () => {
  const vn = h("div", { id: "test" }, "hello");
  assertEquals(vn.tag, "div");
  assertEquals(vn.props.id, "test");
  assertEquals(vn.children, ["hello"]);
});

Deno.test("h: extracts key from props", () => {
  const vn = h("li", { key: "abc" }, "item");
  assertEquals(vn.key, "abc");
});

Deno.test("h: component vnode", () => {
  const Comp = (props: { x: number }) => h("span", null, String(props.x));
  const vn = h(Comp, { x: 42 });
  assertEquals(typeof vn.tag, "function");
  assertEquals(vn.props.x, 42);
});

Deno.test("h: fragment", () => {
  const vn = h(Fragment, null, h("a", null), h("b", null));
  assertEquals(vn.tag, Fragment);
  assertEquals(vn.children.length, 2);
});

Deno.test("h: flattens nested children arrays", () => {
  const vn = h("div", null, [h("a", null), h("b", null)], h("c", null));
  assertEquals(vn.children.length, 3);
});

Deno.test("h: preserves null/undefined/boolean as placeholders (AIO-107)", () => {
  const vn = h("div", null, null, undefined, false, "text", 0);
  // 3 null placeholders + "text" + 0 = 5 children
  assertEquals(vn.children.length, 5);
  // Placeholders are VNodes with _Null tag
  assertEquals(typeof vn.children[0], "object");
  assertEquals(vn.children[3], "text");
  assertEquals(vn.children[4], 0);
});

Deno.test({
  name: "render: creates text node",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(root, h("span", null, "hello"), null, ctx);
    assertEquals(root.innerHTML, "<span>hello</span>");
    await cleanup();
  },
});

Deno.test({
  name: "render: sets attributes",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(root, h("input", { type: "text", value: "abc" }), null, ctx);
    const input = root.firstChild as HTMLInputElement;
    assertEquals(input.getAttribute("type"), "text");
    await cleanup();
  },
});

Deno.test({
  name: "render: applies style object",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(
      root,
      h("div", { style: { color: "red", fontSize: "12px" } }),
      null,
      ctx,
    );
    const el = root.firstChild as HTMLElement;
    assertEquals(el.style.color, "red");
    assertEquals(el.style.fontSize, "12px");
    await cleanup();
  },
});

Deno.test({
  name: "render: event handlers",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    let clicked = false;
    _render(
      root,
      h("button", {
        onClick: () => {
          clicked = true;
        },
      }, "click"),
      null,
      ctx,
    );
    const btn = root.firstChild as HTMLElement;
    btn.click();
    assertEquals(clicked, true);
    await cleanup();
  },
});

Deno.test({
  name: "render: nested elements",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(
      root,
      h("ul", null, h("li", null, "one"), h("li", null, "two")),
      null,
      ctx,
    );
    assertEquals(root.querySelectorAll("li").length, 2);
    await cleanup();
  },
});

Deno.test({
  name: "render: fragment renders children without wrapper",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(
      root,
      h(Fragment, null, h("a", null, "1"), h("b", null, "2")),
      null,
      ctx,
    );
    assertEquals(root.childNodes.length, 2);
    assertEquals((root.firstChild as HTMLElement).tagName, "A");
    await cleanup();
  },
});

Deno.test({
  name: "render: className prop maps to class attribute",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(root, h("div", { className: "foo bar" }), null, ctx);
    assertEquals(
      (root.firstChild as HTMLElement).getAttribute("class"),
      "foo bar",
    );
    await cleanup();
  },
});

Deno.test({
  name: "diff: updates text content",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("span", null, "old");
    _render(root, old, null, ctx);
    const next = h("span", null, "new");
    _diff(root, next, old, ctx);
    assertEquals(root.innerHTML, "<span>new</span>");
    await cleanup();
  },
});

Deno.test({
  name: "diff: updates attributes",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("div", { id: "a", title: "old" });
    _render(root, old, null, ctx);
    const next = h("div", { id: "b" });
    _diff(root, next, old, ctx);
    const el = root.firstChild as HTMLElement;
    assertEquals(el.getAttribute("id"), "b");
    assertEquals(el.getAttribute("title"), null);
    await cleanup();
  },
});

Deno.test({
  name: "diff: replaces element when tag changes",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("span", null, "text");
    _render(root, old, null, ctx);
    const next = h("div", null, "text");
    _diff(root, next, old, ctx);
    assertEquals((root.firstChild as HTMLElement).tagName, "DIV");
    await cleanup();
  },
});

Deno.test({
  name: "diff: adds new children",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("ul", null, h("li", null, "a"));
    _render(root, old, null, ctx);
    const next = h("ul", null, h("li", null, "a"), h("li", null, "b"));
    _diff(root, next, old, ctx);
    assertEquals(root.querySelectorAll("li").length, 2);
    await cleanup();
  },
});

Deno.test({
  name: "diff: removes extra children",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h("ul", null, h("li", null, "a"), h("li", null, "b"));
    _render(root, old, null, ctx);
    const next = h("ul", null, h("li", null, "a"));
    _diff(root, next, old, ctx);
    assertEquals(root.querySelectorAll("li").length, 1);
    await cleanup();
  },
});

Deno.test({
  name: "diff: keyed reorder preserves DOM nodes",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const old = h(
      "ul",
      null,
      h("li", { key: "a" }, "A"),
      h("li", { key: "b" }, "B"),
      h("li", { key: "c" }, "C"),
    );
    _render(root, old, null, ctx);
    const ul = root.firstChild as HTMLElement;
    const origB = ul.children[1];
    const next = h(
      "ul",
      null,
      h("li", { key: "c" }, "C"),
      h("li", { key: "a" }, "A"),
      h("li", { key: "b" }, "B"),
    );
    _diff(root, next, old, ctx);
    assertEquals(ul.children[2], origB);
    assertEquals(ul.children[0]!.textContent, "C");
    await cleanup();
  },
});

Deno.test({
  name: "render: SVG elements use correct namespace",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    _render(
      root,
      h(
        "svg",
        { viewBox: "0 0 100 100" },
        h("circle", { cx: "50", cy: "50", r: "40" }),
      ),
      null,
      ctx,
    );
    const svg = root.firstChild as SVGElement;
    assertEquals(svg.tagName, "svg");
    assertEquals(svg.namespaceURI, "http://www.w3.org/2000/svg");
    await cleanup();
  },
});

Deno.test({
  name: "render: function component",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const Greeting = (props: { name: string }) =>
      h("span", null, `Hi ${props.name}`);
    _render(root, h(Greeting, { name: "World" }), null, ctx);
    assertEquals(root.innerHTML, "<span>Hi World</span>");
    await cleanup();
  },
});

Deno.test({
  name: "render: nested components",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");
    const Inner = () => h("b", null, "bold");
    const Outer = () => h("div", null, h(Inner, null));
    _render(root, h(Outer, null), null, ctx);
    assertEquals(root.innerHTML, "<div><b>bold</b></div>");
    await cleanup();
  },
});

// --- AIO-114 regression tests ---

Deno.test({
  name:
    "diff: mixed keyed + non-keyed children — no DOM leak on re-render (AIO-114)",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");

    // Initial: keyed list + non-keyed button
    const old = h(
      "div",
      null,
      h("span", { key: "a" }, "A"),
      h("span", { key: "b" }, "B"),
      h("button", null, "Toggle"),
    );
    _render(root, old, null, ctx);
    const container = root.firstChild as HTMLElement;
    assertEquals(container.childNodes.length, 3, "initial: 3 children");

    // Re-render with same structure — non-keyed button must be patched, not duplicated
    const next = h(
      "div",
      null,
      h("span", { key: "a" }, "A"),
      h("span", { key: "b" }, "B"),
      h("button", null, "Toggle"),
    );
    _diff(root, next, old, ctx);
    assertEquals(
      container.childNodes.length,
      3,
      "after re-render: still 3 children (no leak)",
    );

    // Third render — verify no accumulation
    const next2 = h(
      "div",
      null,
      h("span", { key: "a" }, "A"),
      h("span", { key: "b" }, "B"),
      h("button", null, "Toggle"),
    );
    _diff(root, next2, next, ctx);
    assertEquals(
      container.childNodes.length,
      3,
      "after 3rd render: still 3 children",
    );
    await cleanup();
  },
});

Deno.test({
  name:
    "diff: mixed keyed + conditional non-keyed — removed conditionals don't leak (AIO-114)",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");

    // Initial: keyed list + conditional badge + button
    const old = h(
      "div",
      null,
      h("span", { key: "a" }, "A"),
      h("span", null, "BADGE"),
      h("button", null, "Click"),
    );
    _render(root, old, null, ctx);
    const container = root.firstChild as HTMLElement;
    assertEquals(container.childNodes.length, 3);

    // Re-render: badge removed (conditional false)
    const next = h(
      "div",
      null,
      h("span", { key: "a" }, "A"),
      h("button", null, "Click"),
    );
    _diff(root, next, old, ctx);
    // Should have 2 children: keyed span + button. Old badge removed.
    assertEquals(
      container.childNodes.length,
      2,
      "badge removed, no orphan DOM",
    );
    await cleanup();
  },
});

Deno.test({
  name:
    "diff: mixed keyed + non-keyed — keyed reorder preserves non-keyed identity (AIO-114)",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");

    const old = h(
      "ul",
      null,
      h("li", { key: "x" }, "X"),
      h("li", { key: "y" }, "Y"),
      h("li", null, "footer"),
    );
    _render(root, old, null, ctx);
    const ul = root.firstChild as HTMLElement;
    const footerBefore = ul.children[2];

    // Reorder keyed, non-keyed stays
    const next = h(
      "ul",
      null,
      h("li", { key: "y" }, "Y"),
      h("li", { key: "x" }, "X"),
      h("li", null, "footer"),
    );
    _diff(root, next, old, ctx);
    assertEquals(ul.children.length, 3, "still 3 children after reorder");
    assertEquals(ul.children[0]!.textContent, "Y");
    assertEquals(ul.children[1]!.textContent, "X");
    assertEquals(ul.children[2]!.textContent, "footer");
    // Non-keyed element should preserve DOM identity (patched in place)
    assertEquals(
      ul.children[2],
      footerBefore,
      "non-keyed DOM identity preserved",
    );
    await cleanup();
  },
});

Deno.test({
  name:
    "diff: keyed Fragment siblings don't corrupt non-keyed cursor walk (AIO-114)",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");

    // Keyed Fragment expands to multiple DOM nodes, followed by non-keyed element
    const old = h(
      "div",
      null,
      h(Fragment, { key: "frag" }, h("span", null, "A"), h("span", null, "B")),
      h("button", null, "Action"),
    );
    _render(root, old, null, ctx);
    const container = root.firstChild as HTMLElement;
    // Fragment(2 spans) + button = 3 DOM nodes
    assertEquals(container.childNodes.length, 3, "initial: 3 DOM nodes");

    // Re-render same structure — button must not leak
    const next = h(
      "div",
      null,
      h(Fragment, { key: "frag" }, h("span", null, "A"), h("span", null, "B")),
      h("button", null, "Action"),
    );
    _diff(root, next, old, ctx);
    assertEquals(
      container.childNodes.length,
      3,
      "after re-render: still 3 DOM nodes",
    );

    // Third render to confirm no accumulation
    const next2 = h(
      "div",
      null,
      h(Fragment, { key: "frag" }, h("span", null, "A"), h("span", null, "B")),
      h("button", null, "Action"),
    );
    _diff(root, next2, next, ctx);
    assertEquals(
      container.childNodes.length,
      3,
      "after 3rd render: still 3 DOM nodes",
    );
    await cleanup();
  },
});

Deno.test({
  name: "diff: non-keyed count shrinks and grows correctly (AIO-114)",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");

    // 3 non-keyed + 1 keyed
    const v1 = h(
      "div",
      null,
      h("span", { key: "k" }, "keyed"),
      h("em", null, "a"),
      h("em", null, "b"),
      h("em", null, "c"),
    );
    _render(root, v1, null, ctx);
    const container = root.firstChild as HTMLElement;
    assertEquals(container.childNodes.length, 4);

    // Shrink to 1 non-keyed
    const v2 = h(
      "div",
      null,
      h("span", { key: "k" }, "keyed"),
      h("em", null, "only"),
    );
    _diff(root, v2, v1, ctx);
    assertEquals(container.childNodes.length, 2, "shrink: 2 DOM nodes");

    // Grow to 4 non-keyed
    const v3 = h(
      "div",
      null,
      h("span", { key: "k" }, "keyed"),
      h("em", null, "w"),
      h("em", null, "x"),
      h("em", null, "y"),
      h("em", null, "z"),
    );
    _diff(root, v3, v2, ctx);
    assertEquals(container.childNodes.length, 5, "grow: 5 DOM nodes");
    await cleanup();
  },
});

// ── AIO-116: text node nodeType validation in diffUnkeyed/diffKeyed ────

Deno.test({
  name:
    "AIO-116: a desynced text cursor keeps the element it lands on, and warns",
  async fn() {
    // The previous version of this test was VACUOUS: it looped
    // `if (node.nodeName === "B")` over the children, but the diff removed the
    // <b> outright, so the assertion body never ran and the test passed while
    // the element was being deleted. Assert on the node directly.
    const { document: doc, ctx, cleanup } = createDOM();
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const warnings: string[] = [];
    const origWarn = console.warn;
    setDevMode(true);
    console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));

    try {
      // Initial render: parent with text child + element child
      const v1 = h("div", null, "hello", h("span", null, "world"));
      _render(root, v1, null, ctx);
      const container = root.firstChild as HTMLElement;

      // Externally mutate DOM: replace the text node with an element.
      // Simulates cursor desync (Fragment shift, external mutation, etc.)
      const textNode = container.childNodes[0]!;
      const injected = doc.createElement("b");
      injected.innerHTML = "<em>keep</em><strong>this</strong>";
      container.replaceChild(injected, textNode);
      assertEquals(container.childNodes[0]!.nodeName, "B");

      // Re-render: old vnode says "hello" (text), new says "updated" (text).
      const v2 = h("div", null, "updated", h("span", null, "world"));
      _diff(root, v2, v1, ctx);

      // The <b> is owned by nobody the reconciler knows about, but it is a real
      // element with real children: deleting it silently is the bug. It stays.
      assertEquals(
        injected.parentNode,
        container,
        "the element the cursor landed on must NOT be deleted",
      );
      assertEquals(
        injected.childNodes.length,
        2,
        "<b> keeps its own children",
      );
      // The new text is written positionally, before the node in the way.
      assertEquals(container.childNodes[0]!.nodeType, 3);
      assertEquals(container.childNodes[0]!.textContent, "updated");
      assertEquals(container.childNodes[1], injected);
      // And it is LOUD in dev — a silent desync is the failure this project
      // forbids.
      assertEquals(
        warnings.some((w) => w.includes("instead of its text node")),
        true,
        `expected a dev warning, got ${JSON.stringify(warnings)}`,
      );
    } finally {
      console.warn = origWarn;
      setDevMode(false);
    }

    await cleanup();
  },
});

// Audit 2026-07-24 (HIGH, DOM corruption): the static-VNode short-circuit
// carried `_dom` only one level down, so in an element-only (`_static`) subtree
// the GRANDCHILDREN lost their DOM handles. A later render could no longer find
// those nodes: the removal silently no-oped and the replacement was appended,
// leaving both the old and the new element in the DOM.
Deno.test({
  name: "diff: static short-circuit carries _dom to every depth",
  async fn() {
    const { document, ctx, cleanup } = createDOM();
    const root = document.createElement("div");

    const tree = () => h("div", null, h("span", null, h("b", null)));
    const r1 = tree();
    _render(root, r1, null, ctx);
    assertEquals(root.innerHTML, "<div><span><b></b></span></div>");

    // Identical render → the short-circuit fires and must hand the whole
    // subtree's DOM handles to the new vnodes.
    const r2 = tree();
    _diff(root, r2, r1, ctx);
    const span = r2.children[0] as VNode;
    const bold = span.children[0] as VNode;
    assertExists(span._dom, "child keeps its DOM handle");
    assertExists(bold._dom, "GRANDchild keeps its DOM handle");

    // Now swap the deep leaf: it must be replaced, not duplicated.
    const r3 = h("div", null, h("span", null, h("i", null)));
    _diff(root, r3, r2, ctx);
    assertEquals(root.innerHTML, "<div><span><i></i></span></div>");
    await cleanup();
  },
});

// ── Controlled props are re-asserted from the LIVE element ──────────────
//
// `value` and `checked` are the two props the USER changes behind the
// reconciler's back: the browser writes them on every keystroke and click,
// BEFORE the handler runs. When the handler then REFUSES the input — a length
// cap, a validator, an unchanged cell — the next render sees
// `prev.value === next.value` and used to write nothing, so the screen kept
// what state REJECTED. Measured: state "ab", DOM "abcdef", permanently — and
// `am surface` / `ui.X.value` then report a value the cell never accepted.
Deno.test({
  name: "controlled input: a REJECTED keystroke is undone on the next render",
  async fn() {
    const { document: doc, cleanup } = createDOM();
    const { _setDocument, _unmount, mount } = await import(
      "../src/air/aio-renderer.ts"
    );
    const { signal } = await import("../src/state/signal.ts");
    _setDocument(doc);
    const root = doc.createElement("div");
    doc.body.appendChild(root);

    const text = signal("");
    const rejected = signal(0);
    const App = () =>
      h(
        "div",
        null,
        h("input", {
          value: text.value,
          "aria-label": "t",
          onInput: (e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            if (v.length <= 3) text.set(v);
            else rejected.set(rejected.peek() + 1); // refuse, show a hint
          },
        }),
        h("span", null, `rejected:${rejected.value}`),
      );

    const handle = mount(root, App);
    const input = root.querySelector("input") as HTMLInputElement;
    const fire = () =>
      input.dispatchEvent(
        // deno-lint-ignore no-explicit-any
        new (doc.defaultView as any).Event("input", { bubbles: true }),
      );

    input.value = "ab";
    fire();
    await new Promise((r) => setTimeout(r, 5));
    handle._flush();
    assertEquals(text.peek(), "ab");
    assertEquals(input.value, "ab");

    input.value = "abcdef"; // over the cap — the handler refuses it
    fire();
    await new Promise((r) => setTimeout(r, 5));
    handle._flush();
    await new Promise((r) => setTimeout(r, 5));
    assertEquals(text.peek(), "ab", "state refused the input");
    assertEquals(input.value, "ab", "and the DOM shows what state holds");

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "controlled checkbox: a REJECTED click is undone on the next render",
  async fn() {
    const { document: doc, cleanup } = createDOM();
    const { _setDocument, _unmount, mount } = await import(
      "../src/air/aio-renderer.ts"
    );
    const { signal } = await import("../src/state/signal.ts");
    _setDocument(doc);
    const root = doc.createElement("div");
    doc.body.appendChild(root);

    const on = signal(false);
    const tries = signal(0);
    const App = () =>
      h(
        "div",
        null,
        h("input", {
          type: "checkbox",
          "aria-label": "c",
          checked: on.value,
          onChange: () => tries.set(tries.peek() + 1), // always refuse
        }),
        h("span", null, `t:${tries.value}`),
      );

    const handle = mount(root, App);
    const box = root.querySelector("input") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(
      // deno-lint-ignore no-explicit-any
      new (doc.defaultView as any).Event("input", { bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 5));
    handle._flush();
    assertEquals(on.peek(), false);
    assertEquals(box.checked, false, "the DOM shows what state holds");

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "controlled select: a REJECTED choice is undone on the next render",
  async fn() {
    const { document: doc, cleanup } = createDOM();
    const { _setDocument, _unmount, mount } = await import(
      "../src/air/aio-renderer.ts"
    );
    const { signal } = await import("../src/state/signal.ts");
    _setDocument(doc);
    const root = doc.createElement("div");
    doc.body.appendChild(root);

    const picked = signal("a");
    const tries = signal(0);
    const App = () =>
      h(
        "div",
        null,
        h(
          "select",
          {
            "aria-label": "s",
            value: picked.value,
            onChange: () => tries.set(tries.peek() + 1), // always refuse
          },
          h("option", { value: "a" }, "A"),
          h("option", { value: "b" }, "B"),
        ),
        h("span", null, `t:${tries.value}`),
      );

    const handle = mount(root, App);
    const sel = root.querySelector("select") as HTMLSelectElement;
    assertEquals(sel.value, "a");
    sel.value = "b";
    sel.dispatchEvent(
      // deno-lint-ignore no-explicit-any
      new (doc.defaultView as any).Event("input", { bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 5));
    handle._flush();
    assertEquals(picked.peek(), "a");
    assertEquals(sel.value, "a", "the DOM shows what state holds");

    _unmount(handle);
    await cleanup();
  },
});

// ── Deferred exit removal is visible to the reconciler ──────────────────
//
// A node kept in the DOM for its exit animation leaves the vnode tree, and
// nothing used to MARK it — so the positional model went out of step with the
// DOM for the whole animation. One cause, several symptoms; these pin them.
function exitCtx(doc: Document, ms = 50) {
  return {
    doc,
    onBeforeRemove: () => new Promise<void>((r) => setTimeout(r, ms)),
  } as unknown as { doc: Document };
}

Deno.test({
  name: "exit animation: the dying keyed row stays in place, it does not move",
  async fn() {
    const { document: doc, cleanup } = createDOM();
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const ctx = exitCtx(doc);
    const mk = (keys: string[]) =>
      h("div", null, ...keys.map((k) => h("p", { key: k }, k)));

    const v1 = mk(["a", "b", "c"]);
    _render(root, v1, null, ctx);
    const box = root.firstChild as HTMLElement;
    assertEquals(box.textContent, "abc");

    _diff(root, mk(["a", "c"]), v1, ctx);
    // Before the fix this read "acb" — `c` was placed against an anchor that
    // was really the dying row, so the fade happened at the BOTTOM of the list.
    assertEquals(box.textContent, "abc", "b fades where it stands");

    await new Promise((r) => setTimeout(r, 80));
    assertEquals(box.textContent, "ac", "and then it is gone");
    await cleanup();
  },
});

Deno.test({
  name: "exit animation: re-adding a key mid-exit replaces the dying row",
  async fn() {
    const { document: doc, cleanup } = createDOM();
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const ctx = exitCtx(doc);
    const mk = (keys: string[]) =>
      h("div", null, ...keys.map((k) => h("p", { key: k }, k)));

    const v1 = mk(["a", "b"]);
    _render(root, v1, null, ctx);
    const box = root.firstChild as HTMLElement;
    const v2 = mk(["b"]);
    _diff(root, v2, v1, ctx);
    // "a" is still on screen, fading. Put it back before it finishes.
    _diff(root, mk(["a", "b"]), v2, ctx);
    // Before the fix: "<p>a</p><p>b</p><p>a</p>" — two rows for one key.
    assertEquals(box.innerHTML, "<p>a</p><p>b</p>");

    await new Promise((r) => setTimeout(r, 80));
    assertEquals(
      box.innerHTML,
      "<p>a</p><p>b</p>",
      "and the exit is cancelled",
    );
    await cleanup();
  },
});

Deno.test({
  name: "exit animation: an unkeyed list reconciles around the dying node",
  async fn() {
    const { document: doc, cleanup } = createDOM();
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const ctx = exitCtx(doc);

    const v1 = h("div", null, h("p", null, "one"), h("p", null, "two"));
    _render(root, v1, null, ctx);
    const box = root.firstChild as HTMLElement;
    const v2 = h("div", null, h("p", null, "one"));
    _diff(root, v2, v1, ctx);
    // The remaining row keeps updating while the other one fades out.
    const v3 = h("div", null, h("p", null, "ONE"));
    _diff(root, v3, v2, ctx);
    assertEquals(box.innerHTML, "<p>ONE</p><p>two</p>");

    await new Promise((r) => setTimeout(r, 80));
    assertEquals(box.innerHTML, "<p>ONE</p>");
    await cleanup();
  },
});

// The dev child-desync tripwire counts DOM nodes against vnode children. A
// node held back for its exit animation belongs to no vnode, so counting it
// made the tripwire cry "this is an aio bug; please report" at a perfectly
// legitimate <Transition> — the loudest possible false alarm.
Deno.test({
  name: "exit animation: the child-desync tripwire does not false-alarm",
  async fn() {
    const { document: doc, cleanup } = createDOM();
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const ctx = exitCtx(doc);
    const warnings: string[] = [];
    const origWarn = console.warn;
    setDevMode(true);
    console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
    try {
      const mk = (keys: string[]) =>
        h("div", null, ...keys.map((k) => h("p", { key: k }, k)));
      const v1 = mk(["a", "b", "c"]);
      _render(root, v1, null, ctx);
      // The FIRST node exits, so the region no longer starts where the DOM
      // does — the shape that made the tripwire report a phantom desync.
      const v2 = mk(["b", "c"]);
      _diff(root, v2, v1, ctx);
      _diff(root, mk(["c", "b"]), v2, ctx); // reorder while a is still fading
      assertEquals(
        warnings.filter((w) => w.includes("desynced")),
        [],
        `false alarm: ${JSON.stringify(warnings)}`,
      );
    } finally {
      console.warn = origWarn;
      setDevMode(false);
    }
    await new Promise((r) => setTimeout(r, 80));
    await cleanup();
  },
});

// ── The same controlled props, bound to a SIGNAL ────────────────────────
//
// `applyProps` skips every signal-valued prop ("the binding owns it"), and what
// the binding owns it through is an EFFECT — which runs when the SIGNAL
// changes and never otherwise. The user typing into `<input value={sig}>`
// changes the DOM, not the signal, so a refused keystroke had NO path back:
// `value={s.x}` self-corrected on the next render and `value={sig}` did not,
// which is the same divergence-by-signal the prop rule was unified to end.
Deno.test({
  name: "controlled input bound to a SIGNAL: a REJECTED keystroke is undone",
  async fn() {
    const { document: doc, cleanup } = createDOM();
    const { _setDocument, _unmount, mount } = await import(
      "../src/air/aio-renderer.ts"
    );
    const { signal } = await import("../src/state/signal.ts");
    _setDocument(doc);
    const root = doc.createElement("div");
    doc.body.appendChild(root);

    const text = signal("");
    const rejected = signal(0);
    const App = () =>
      h(
        "div",
        null,
        h("input", {
          value: text, // the SIGNAL itself, not `text.value`
          "aria-label": "t",
          onInput: (e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            if (v.length <= 3) text.set(v);
            else rejected.set(rejected.peek() + 1); // refuse, show a hint
          },
        }),
        h("span", null, `rejected:${rejected.value}`),
      );

    const handle = mount(root, App);
    const input = root.querySelector("input") as HTMLInputElement;
    const fire = () =>
      input.dispatchEvent(
        // deno-lint-ignore no-explicit-any
        new (doc.defaultView as any).Event("input", { bubbles: true }),
      );

    input.value = "ab";
    fire();
    await new Promise((r) => setTimeout(r, 5));
    handle._flush();
    assertEquals(text.peek(), "ab");
    assertEquals(input.value, "ab");

    input.value = "abcdef"; // over the cap — the handler refuses it
    fire();
    await new Promise((r) => setTimeout(r, 5));
    handle._flush();
    await new Promise((r) => setTimeout(r, 5));
    assertEquals(text.peek(), "ab", "state refused the input");
    assertEquals(input.value, "ab", "and the DOM shows what state holds");

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "controlled checkbox bound to a SIGNAL: a REJECTED click is undone",
  async fn() {
    const { document: doc, cleanup } = createDOM();
    const { _setDocument, _unmount, mount } = await import(
      "../src/air/aio-renderer.ts"
    );
    const { signal } = await import("../src/state/signal.ts");
    _setDocument(doc);
    const root = doc.createElement("div");
    doc.body.appendChild(root);

    const on = signal(false);
    const tries = signal(0);
    const App = () =>
      h(
        "div",
        null,
        h("input", {
          type: "checkbox",
          "aria-label": "c",
          checked: on, // the SIGNAL itself
          onChange: () => tries.set(tries.peek() + 1), // always refuse
        }),
        h("span", null, `t:${tries.value}`),
      );

    const handle = mount(root, App);
    const box = root.querySelector("input") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(
      // deno-lint-ignore no-explicit-any
      new (doc.defaultView as any).Event("input", { bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 5));
    handle._flush();
    assertEquals(on.peek(), false);
    assertEquals(box.checked, false, "the DOM shows what state holds");

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "controlled select bound to a SIGNAL: a REJECTED choice is undone",
  async fn() {
    const { document: doc, cleanup } = createDOM();
    const { _setDocument, _unmount, mount } = await import(
      "../src/air/aio-renderer.ts"
    );
    const { signal } = await import("../src/state/signal.ts");
    _setDocument(doc);
    const root = doc.createElement("div");
    doc.body.appendChild(root);

    const picked = signal("a");
    const tries = signal(0);
    const App = () =>
      h(
        "div",
        null,
        h(
          "select",
          {
            "aria-label": "s",
            value: picked, // the SIGNAL itself
            onChange: () => tries.set(tries.peek() + 1), // always refuse
          },
          h("option", { value: "a" }, "A"),
          h("option", { value: "b" }, "B"),
        ),
        h("span", null, `t:${tries.value}`),
      );

    const handle = mount(root, App);
    const sel = root.querySelector("select") as HTMLSelectElement;
    assertEquals(sel.value, "a");
    sel.value = "b";
    sel.dispatchEvent(
      // deno-lint-ignore no-explicit-any
      new (doc.defaultView as any).Event("input", { bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 5));
    handle._flush();
    assertEquals(picked.peek(), "a");
    assertEquals(sel.value, "a", "the DOM shows what state holds");

    _unmount(handle);
    await cleanup();
  },
});

// An accepted keystroke must NOT be rewritten — the re-assert is a drift check,
// not an unconditional write, because assigning an <input>'s `value` its own
// string still moves the caret to the end.
Deno.test({
  name: "controlled signal prop: an ACCEPTED value is not rewritten",
  async fn() {
    const { document: doc, cleanup } = createDOM();
    const { _setDocument, _unmount, mount } = await import(
      "../src/air/aio-renderer.ts"
    );
    const { signal } = await import("../src/state/signal.ts");
    _setDocument(doc);
    const root = doc.createElement("div");
    doc.body.appendChild(root);

    const text = signal("ab");
    const gen = signal(0);
    const App = () =>
      h(
        "div",
        null,
        h("input", { value: text, "aria-label": "t" }),
        h("span", null, `g:${gen.value}`),
      );
    const handle = mount(root, App);
    const input = root.querySelector("input") as HTMLInputElement;
    let writes = 0;
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => "ab",
      set: () => writes++,
    });
    gen.set(1); // a render that has nothing to do with the input
    handle._flush();
    await new Promise((r) => setTimeout(r, 5));
    assertEquals(
      writes,
      0,
      "the element already shows it — no write, no caret jump",
    );

    _unmount(handle);
    await cleanup();
  },
});

// ── Exit animations inside a BOUNDARY region ────────────────────────────
//
// `_nextLive`/`_firstLive` made every positional walk step over a node that is
// only finishing its exit animation — except the boundary's, which walked
// `startAnchor.nextSibling` / `parent.firstChild` directly. So inside an
// ErrorBoundary/Suspense region the positional model was still one node out,
// and the region-sweep tore a dying node off the screen (leaking the
// exiting-node counter with it, which slows every later walk in the process).
Deno.test({
  name: "exit animation: a dying node inside an ErrorBoundary region survives",
  async fn() {
    const { document: doc, cleanup } = createDOM();
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const ctx = exitCtx(doc);

    const Boom = () => {
      throw new Error("nope");
    };
    const mk = (keys: string[], boom: boolean) =>
      h(
        "div",
        null,
        h("span", null, "BEFORE"),
        h(
          ErrorBoundary,
          { fallback: () => h("span", null, "FALLBACK") },
          ...keys.map((k) => h("p", { key: k }, k)),
          ...(boom ? [h(Boom as never, null)] : []),
        ),
        h("span", null, "AFTER"),
      );

    const v1 = mk(["a", "b"], false);
    _render(root, v1, null, ctx);
    const box = root.firstChild as HTMLElement;
    assertEquals(box.textContent, "BEFOREabAFTER");

    const v2 = mk(["b"], false);
    _diff(root, v2, v1, ctx); // "a" leaves the model and starts fading
    assertEquals(box.textContent, "BEFOREabAFTER", "a fades where it stands");

    // Now the boundary fails while "a" is still on screen.
    const v3 = mk(["b"], true);
    _diff(root, v3, v2, ctx);
    assertEquals(
      box.textContent,
      "BEFOREabFALLBACKAFTER",
      "the fallback lands in the boundary's slot; the node already fading and " +
        "the one the boundary just retired both finish their exits, and AFTER " +
        "is untouched",
    );

    await new Promise((r) => setTimeout(r, 80));
    assertEquals(
      box.textContent,
      "BEFOREFALLBACKAFTER",
      "and then the exit finishes on its own",
    );
    await cleanup();
  },
});
