import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { batch, computed, signal } from "../src/signal.ts";
import { Fragment, h } from "../src/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  type MountHandle,
} from "../src/aio-renderer.ts";

function createDOM(): {
  document: Document;
  root: HTMLElement;
  cleanup: () => void;
} {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.close() };
}

Deno.test({
  name: "mount: renders simple component",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const App = () => h("div", null, "Hello AIO");
    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<div>Hello AIO</div>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "mount: renders component with props",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const Greeting = (props: { name: string }) =>
      h("span", null, `Hi ${props.name}`);
    const App = () => h(Greeting, { name: "World" });
    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<span>Hi World</span>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "mount: re-renders when signal changes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const count = signal(0);
    const App = () => h("div", null, `Count: ${count.value}`);
    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<div>Count: 0</div>");
    count.set(1);
    handle._flush();
    assertEquals(root.innerHTML, "<div>Count: 1</div>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "mount: computed works in components",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const a = signal(2);
    const b = signal(3);
    const App = () => {
      const sum = computed(() => a.value + b.value);
      return h("div", null, `Sum: ${sum.value}`);
    };
    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<div>Sum: 5</div>");
    a.set(10);
    handle._flush();
    assertEquals(root.innerHTML, "<div>Sum: 13</div>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "mount: event handlers work with signals",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const count = signal(0);
    const App = () =>
      h("button", {
        onClick: () => count.set(count.peek() + 1),
      }, `Count: ${count.value}`);
    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<button>Count: 0</button>");
    (root.firstChild as HTMLElement).click();
    handle._flush();
    assertEquals(root.innerHTML, "<button>Count: 1</button>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "mount: renders lists with map",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const items = signal(["a", "b", "c"]);
    const App = () =>
      h("ul", null, ...items.value.map((item) => h("li", { key: item }, item)));
    const handle = mount(root, App);
    assertEquals(root.querySelectorAll("li").length, 3);
    items.set(["a", "c"]);
    handle._flush();
    assertEquals(root.querySelectorAll("li").length, 2);
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "mount: conditional rendering with &&",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const show = signal(true);
    const App = () => h("div", null, show.value && h("span", null, "visible"));
    const handle = mount(root, App);
    assertEquals(root.querySelector("span")?.textContent, "visible");
    show.set(false);
    handle._flush();
    assertEquals(root.querySelector("span"), null);
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "mount: unmount cleans up signal subscriptions",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const count = signal(0);
    let renderCalls = 0;
    const App = () => {
      renderCalls++;
      return h("div", null, String(count.value));
    };
    const handle = mount(root, App);
    assertEquals(renderCalls, 1);
    count.set(1);
    handle._flush();
    assertEquals(renderCalls, 2);
    _unmount(handle);
    count.set(2);
    assertEquals(renderCalls, 2);
    cleanup();
  },
});

Deno.test({
  name: "vdom: style diffing removes stale properties",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const bold = signal(true);
    const App = () =>
      h("div", {
        style: bold.value
          ? { color: "red", fontWeight: "bold" }
          : { color: "blue" },
      }, "text");
    const handle = mount(root, App);
    const el = root.firstChild as HTMLElement;
    assertEquals(el.style.color, "red");
    assertEquals(el.style.fontWeight, "bold");
    bold.set(false);
    handle._flush();
    assertEquals(el.style.color, "blue");
    // fontWeight must be REMOVED, not persist as ghost
    assertEquals(el.style.fontWeight, "");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "vdom: dangerouslySetInnerHTML works",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const App = () =>
      h("div", { dangerouslySetInnerHTML: { __html: "<b>bold</b>" } });
    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<div><b>bold</b></div>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "vdom: keyed list reorder preserves DOM nodes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const order = signal(["a", "b", "c"]);
    const App = () =>
      h("ul", null, ...order.value.map((id) => h("li", { key: id }, id)));
    const handle = mount(root, App);
    const lis = root.querySelectorAll("li");
    assertEquals(lis.length, 3);
    // Capture DOM references
    const aNode = lis[0];
    const cNode = lis[2];
    // Reverse order
    order.set(["c", "b", "a"]);
    handle._flush();
    const newLis = root.querySelectorAll("li");
    assertEquals(newLis.length, 3);
    assertEquals(newLis[0]?.textContent, "c");
    assertEquals(newLis[2]?.textContent, "a");
    // DOM nodes should be reused (same references, just reordered)
    assertEquals(newLis[0], cNode);
    assertEquals(newLis[2], aNode);
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "mount: no double component execution",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    let childCalls = 0;
    const Child = ({ name }: { name: string }) => {
      childCalls++;
      return h("span", null, name);
    };
    const App = () => h("div", null, h(Child, { name: "test" }));
    const handle = mount(root, App);
    // Child should be called exactly ONCE during mount (not twice)
    assertEquals(childCalls, 1);
    assertEquals(root.innerHTML, "<div><span>test</span></div>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "vdom: Fragment re-render updates correctly",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const label = signal("hello");
    const App = () =>
      h(Fragment, null, h("span", null, label.value), h("b", null, "fixed"));
    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<span>hello</span><b>fixed</b>");
    label.set("world");
    handle._flush();
    assertEquals(root.innerHTML, "<span>world</span><b>fixed</b>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "vdom: component returning null renders nothing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const show = signal(false);
    const MaybeNull = () => show.value ? h("div", null, "yes") : null;
    const App = () => h("section", null, h(MaybeNull, null));
    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<section></section>");
    show.set(true);
    handle._flush();
    assertEquals(root.querySelector("div")?.textContent, "yes");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "vdom: nested components 3+ deep with signal re-render",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const count = signal(0);
    const Inner = ({ n }: { n: number }) => h("span", null, `n=${n}`);
    const Middle = ({ n }: { n: number }) => h("div", null, h(Inner, { n }));
    const App = () => h("main", null, h(Middle, { n: count.value }));
    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<main><div><span>n=0</span></div></main>");
    count.set(42);
    handle._flush();
    assertEquals(root.innerHTML, "<main><div><span>n=42</span></div></main>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "vdom: empty keyed list clears all children",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const items = signal(["a", "b", "c"]);
    const App = () =>
      h("ul", null, ...items.value.map((id) => h("li", { key: id }, id)));
    const handle = mount(root, App);
    assertEquals(root.querySelectorAll("li").length, 3);
    items.set([]);
    handle._flush();
    assertEquals(root.querySelectorAll("li").length, 0);
    assertEquals(root.innerHTML, "<ul></ul>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "signal: computed disposal prevents leak",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const a = signal(1);
    let computedCalls = 0;
    const App = () => {
      const doubled = computed(() => {
        computedCalls++;
        return a.value * 2;
      });
      return h("div", null, `${doubled.value}`);
    };
    const handle = mount(root, App);
    assertEquals(computedCalls, 1);
    assertEquals(root.innerHTML, "<div>2</div>");
    // Re-render: old computed should be disposed, new one created
    a.set(5);
    handle._flush();
    // Should be 2 (one from initial, one from re-render) — NOT accumulating
    assertEquals(computedCalls, 2);
    assertEquals(root.innerHTML, "<div>10</div>");
    // Third render
    a.set(10);
    handle._flush();
    assertEquals(computedCalls, 3);
    assertEquals(root.innerHTML, "<div>20</div>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "vdom: form element checked prop uses DOM property",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const checked = signal(true);
    const App = () => h("input", { type: "checkbox", checked: checked.value });
    const handle = mount(root, App);
    const input = root.firstChild as HTMLInputElement;
    assertEquals(input.checked, true);
    checked.set(false);
    handle._flush();
    assertEquals(input.checked, false);
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "vdom: Fragment conditional removal cleans up all children",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const show = signal(true);
    const App = () =>
      h(
        "div",
        null,
        show.value &&
          h(Fragment, null, h("span", null, "a"), h("span", null, "b")),
      );
    const handle = mount(root, App);
    assertEquals(root.querySelectorAll("span").length, 2);
    show.set(false);
    handle._flush();
    assertEquals(root.querySelectorAll("span").length, 0);
    // Bring back
    show.set(true);
    handle._flush();
    assertEquals(root.querySelectorAll("span").length, 2);
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "vdom: component VNode→null→VNode cycle",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const show = signal(true);
    const Toggle = () => show.value ? h("b", null, "on") : null;
    const App = () => h("div", null, h(Toggle, null));
    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<div><b>on</b></div>");
    // VNode → null
    show.set(false);
    handle._flush();
    assertEquals(root.innerHTML, "<div></div>");
    // null → VNode
    show.set(true);
    handle._flush();
    assertEquals(root.innerHTML, "<div><b>on</b></div>");
    _unmount(handle);
    cleanup();
  },
});

// ── Phase 2: Per-component reactivity tests ─────────────────────────

Deno.test({
  name:
    "phase2: per-component isolation — sibling signal change only re-renders affected component",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const sigA = signal("a1");
    const sigB = signal("b1");
    let callsA = 0;
    let callsB = 0;
    const CompA = () => {
      callsA++;
      return h("span", null, sigA.value);
    };
    const CompB = () => {
      callsB++;
      return h("span", null, sigB.value);
    };
    const App = () => h("div", null, h(CompA, null), h(CompB, null));
    const handle = mount(root, App);
    assertEquals(callsA, 1);
    assertEquals(callsB, 1);
    assertEquals(root.innerHTML, "<div><span>a1</span><span>b1</span></div>");
    // Change only sigA — only CompA should re-execute
    sigA.set("a2");
    handle._flush();
    assertEquals(callsA, 2);
    assertEquals(callsB, 1); // CompB NOT re-executed
    assertEquals(root.innerHTML, "<div><span>a2</span><span>b1</span></div>");
    // Change only sigB — only CompB should re-execute
    sigB.set("b2");
    handle._flush();
    assertEquals(callsA, 2); // CompA NOT re-executed
    assertEquals(callsB, 2);
    assertEquals(root.innerHTML, "<div><span>a2</span><span>b2</span></div>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name:
    "phase2: auto-memo — child skipped when parent re-renders with same props",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const parentSig = signal("p1");
    let childCalls = 0;
    const Child = ({ label }: { label: string }) => {
      childCalls++;
      return h("span", null, label);
    };
    const App = () =>
      h(
        "div",
        null,
        h("b", null, parentSig.value),
        h(Child, { label: "fixed" }),
      );
    const handle = mount(root, App);
    assertEquals(childCalls, 1);
    assertEquals(root.innerHTML, "<div><b>p1</b><span>fixed</span></div>");
    // Parent re-renders due to parentSig, but Child props unchanged → skip
    parentSig.set("p2");
    handle._flush();
    assertEquals(childCalls, 1); // Child NOT re-executed (auto-memo)
    assertEquals(root.innerHTML, "<div><b>p2</b><span>fixed</span></div>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name:
    "phase2: nested component — only grandchild re-renders when its signal changes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const deep = signal(0);
    let outerCalls = 0;
    let middleCalls = 0;
    let innerCalls = 0;
    const Inner = () => {
      innerCalls++;
      return h("span", null, `v=${deep.value}`);
    };
    const Middle = () => {
      middleCalls++;
      return h("div", null, h(Inner, null));
    };
    const App = () => {
      outerCalls++;
      return h("main", null, h(Middle, null));
    };
    const handle = mount(root, App);
    assertEquals(outerCalls, 1);
    assertEquals(middleCalls, 1);
    assertEquals(innerCalls, 1);
    // Change deep signal — only Inner reads it
    deep.set(42);
    handle._flush();
    assertEquals(outerCalls, 1); // NOT re-rendered
    assertEquals(middleCalls, 1); // NOT re-rendered
    assertEquals(innerCalls, 2); // re-rendered
    assertEquals(root.innerHTML, "<main><div><span>v=42</span></div></main>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "phase2: component unmount cleans up signal subscriptions",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const sig = signal("v1");
    let childCalls = 0;
    const show = signal(true);
    const Child = () => {
      childCalls++;
      return h("span", null, sig.value);
    };
    const App = () => h("div", null, show.value ? h(Child, null) : null);
    const handle = mount(root, App);
    assertEquals(childCalls, 1);
    // Remove the child component
    show.set(false);
    handle._flush();
    const callsAfterRemove = childCalls;
    // Changing sig should NOT trigger removed Child
    sig.set("v2");
    handle._flush();
    assertEquals(childCalls, callsAfterRemove); // Child NOT re-executed after unmount
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "phase2: auto-memo passes when props change",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const count = signal(0);
    let childCalls = 0;
    const Child = ({ n }: { n: number }) => {
      childCalls++;
      return h("span", null, `n=${n}`);
    };
    const App = () => h("div", null, h(Child, { n: count.value }));
    const handle = mount(root, App);
    assertEquals(childCalls, 1);
    // Props change → child MUST re-execute
    count.set(5);
    handle._flush();
    assertEquals(childCalls, 2);
    assertEquals(root.innerHTML, "<div><span>n=5</span></div>");
    _unmount(handle);
    cleanup();
  },
});

// ── Review fixes: B1 + additional coverage ──────────────────────────

Deno.test({
  name:
    "phase2: component→component nesting — parentDom propagated correctly for independent re-render",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const sig = signal("v1");
    let layoutCalls = 0;
    const Layout = () => {
      layoutCalls++;
      return h("section", null, sig.value);
    };
    // App renders a component directly (not an element wrapping a component)
    const App = () => h(Layout, null);
    const handle = mount(root, App);
    assertEquals(layoutCalls, 1);
    assertEquals(root.innerHTML, "<section>v1</section>");
    // Layout's signal changes — independent re-render must diff against root, not document.body
    sig.set("v2");
    handle._flush();
    assertEquals(layoutCalls, 2);
    assertEquals(root.innerHTML, "<section>v2</section>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "phase2: batch multiple signals — each component re-renders once",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const s1 = signal("a");
    const s2 = signal("b");
    let callsA = 0;
    let callsB = 0;
    const CompA = () => {
      callsA++;
      return h("span", null, s1.value);
    };
    const CompB = () => {
      callsB++;
      return h("span", null, s2.value);
    };
    const App = () => h("div", null, h(CompA, null), h(CompB, null));
    const handle = mount(root, App);
    assertEquals(callsA, 1);
    assertEquals(callsB, 1);
    // Batch: change both signals — each component should re-render exactly once
    batch(() => {
      s1.set("a2");
      s2.set("b2");
    });
    handle._flush();
    assertEquals(callsA, 2);
    assertEquals(callsB, 2);
    assertEquals(root.innerHTML, "<div><span>a2</span><span>b2</span></div>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name:
    "phase2: dynamic dep tracking — component tracks different signals on re-render",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const toggle = signal(true);
    const sigA = signal("A");
    const sigB = signal("B");
    let calls = 0;
    const Switcher = () => {
      calls++;
      return h("span", null, toggle.value ? sigA.value : sigB.value);
    };
    const App = () => h("div", null, h(Switcher, null));
    const handle = mount(root, App);
    assertEquals(calls, 1);
    assertEquals(root.innerHTML, "<div><span>A</span></div>");
    // sigB should NOT trigger re-render (not tracked)
    sigB.set("B2");
    handle._flush();
    assertEquals(calls, 1);
    // Switch to tracking sigB
    toggle.set(false);
    handle._flush();
    assertEquals(calls, 2);
    assertEquals(root.innerHTML, "<div><span>B2</span></div>");
    // Now sigA should NOT trigger, sigB should
    sigA.set("A2");
    handle._flush();
    assertEquals(calls, 2); // sigA no longer tracked
    sigB.set("B3");
    handle._flush();
    assertEquals(calls, 3);
    assertEquals(root.innerHTML, "<div><span>B3</span></div>");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "vdom: type-mismatch replacement cleans up component instances",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const mode = signal<"comp" | "elem">("comp");
    const sig = signal("v1");
    let childCalls = 0;
    const Comp = () => {
      childCalls++;
      return h("b", null, sig.value);
    };
    const App = () =>
      h(
        "div",
        null,
        mode.value === "comp" ? h(Comp, null) : h("i", null, "plain"),
      );
    const handle = mount(root, App);
    assertEquals(childCalls, 1);
    assertEquals(root.innerHTML, "<div><b>v1</b></div>");
    // Replace component with element — component instance should be cleaned up
    mode.set("elem");
    handle._flush();
    assertEquals(root.innerHTML, "<div><i>plain</i></div>");
    const callsAfterSwap = childCalls;
    // Changing sig should NOT re-render disposed Comp
    sig.set("v2");
    handle._flush();
    assertEquals(childCalls, callsAfterSwap);
    _unmount(handle);
    cleanup();
  },
});
