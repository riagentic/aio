import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { batch, computed, effect, signal } from "../src/signal.ts";
import { Fragment, h } from "../src/vdom.ts";
import {
  _setDocument,
  _unmount,
  afterRender,
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

Deno.test({
  name: "vdom: event handlers are auto-batched",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const a = signal(0);
    const b = signal(0);
    let renderCount = 0;

    const App = () => {
      renderCount++;
      return h("button", {
        onClick: () => {
          a.set(1);
          b.set(1);
        },
      }, `${a.value}+${b.value}`);
    };

    const handle = mount(root, App);
    assertEquals(renderCount, 1);

    // Simulate click
    const btn = root.querySelector("button")!;
    btn.click();
    handle._flush();

    // Should be 2 (initial + one batched re-render), not 3
    assertEquals(renderCount, 2);
    assertEquals(a.value, 1);
    assertEquals(b.value, 1);

    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "renderer: effects auto-dispose on component unmount",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const visible = signal(true);
    let effectRunCount = 0;
    let effectCleanedUp = false;
    const trigger = signal(0);

    const Child = () => {
      // Effect created during render — should auto-dispose when Child unmounts
      effect(() => {
        trigger.value;
        effectRunCount++;
        return () => {
          effectCleanedUp = true;
        };
      });
      return h("span", null, "child");
    };

    const App = () => visible.value ? h(Child, null) : h("span", null, "gone");

    const handle = mount(root, App);
    assertEquals(effectRunCount, 1);
    assertEquals(effectCleanedUp, false);

    // Unmount Child by toggling visible
    visible.set(false);
    handle._flush();
    assertEquals(effectCleanedUp, true);

    // Trigger the signal the effect was tracking — should NOT re-run
    const countBefore = effectRunCount;
    trigger.set(1);
    assertEquals(effectRunCount, countBefore); // no re-run after dispose

    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "afterRender: callback runs after initial mount DOM commit",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const domTexts: string[] = [];

    const App = () => {
      afterRender(() => {
        domTexts.push(root.textContent ?? "");
      });
      return h("div", null, "hello");
    };

    const handle = mount(root, App);
    assertEquals(domTexts, ["hello"]); // callback ran after DOM commit
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "afterRender: callback runs after re-render DOM commit",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const count = signal(0);
    const domTexts: string[] = [];

    const App = () => {
      afterRender(() => {
        domTexts.push(root.textContent ?? "");
      });
      return h("div", null, `count: ${count.value}`);
    };

    const handle = mount(root, App);
    assertEquals(domTexts, ["count: 0"]);

    count.set(1);
    handle._flush();
    assertEquals(domTexts, ["count: 0", "count: 1"]);

    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "afterRender: multiple callbacks run in registration order",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const order: number[] = [];

    const App = () => {
      afterRender(() => order.push(1));
      afterRender(() => order.push(2));
      return h("div", null, "test");
    };

    const handle = mount(root, App);
    assertEquals(order, [1, 2]);
    _unmount(handle);
    cleanup();
  },
});

// ── AIO-168: Empty Fragment comment anchor cleanup ──────────────────

Deno.test({
  name: "AIO-168: empty Fragment comment anchor removed on unmount",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const show = signal(true);
    // Fragment starts non-empty, becomes empty via signal → diff creates comment anchor
    const App = () =>
      h(
        "div",
        { id: "wrap" },
        h(Fragment, null, ...(show.value ? [h("span", null, "visible")] : [])),
        h("p", null, "after"),
      );

    const handle = mount(root, App);
    const wrap = root.querySelector("#wrap")!;
    assertEquals(wrap.innerHTML, "<span>visible</span><p>after</p>");

    // Make Fragment empty → diff inserts comment anchor (AIO-128)
    show.set(false);
    handle._flush();
    // <p> + comment anchor (anchor appended after child removal)
    assertEquals(wrap.childNodes.length, 2);
    const commentNode = wrap.childNodes[1]!;
    assertEquals(commentNode.nodeType, 8); // comment anchor

    // Unmount — comment anchor must be cleaned up (AIO-168)
    _unmount(handle);
    assertEquals(root.innerHTML, "");
    cleanup();
  },
});

Deno.test({
  name:
    "AIO-168: empty Fragment comment anchor cleaned up after multiple cycles (no accumulation)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const items = signal<string[]>(["a", "b"]);

    // Fragment with dynamic children — goes full→empty→full→empty
    const App = () =>
      h(
        "div",
        { id: "wrap" },
        h(Fragment, null, ...items.value.map((i) => h("span", null, i))),
        h("p", null, "end"),
      );

    const handle = mount(root, App);
    const wrap = root.querySelector("#wrap")!;
    assertEquals(wrap.innerHTML, "<span>a</span><span>b</span><p>end</p>");

    // Make Fragment empty → comment anchor created
    items.set([]);
    handle._flush();
    let comments = 0;
    for (let i = 0; i < wrap.childNodes.length; i++) {
      if (wrap.childNodes[i]!.nodeType === 8) comments++;
    }
    assertEquals(
      comments,
      1,
      "Should have 1 comment anchor for empty Fragment",
    );

    // Re-fill Fragment → comment anchor should be replaced by real content
    items.set(["c"]);
    handle._flush();
    assertEquals(wrap.querySelector("span")!.textContent, "c");

    // Empty again → 1 comment anchor, NOT 2 (no accumulation)
    items.set([]);
    handle._flush();
    comments = 0;
    for (let i = 0; i < wrap.childNodes.length; i++) {
      if (wrap.childNodes[i]!.nodeType === 8) comments++;
    }
    assertEquals(
      comments,
      1,
      "Should still have exactly 1 comment anchor (no accumulation)",
    );

    // Unmount cleans up everything
    _unmount(handle);
    assertEquals(root.innerHTML, "");
    cleanup();
  },
});

// ── AIO-169: _domNodeCount empty Fragment cursor alignment ──────────

Deno.test({
  name: "AIO-169: empty Fragment sibling positioned correctly after cursor fix",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const items = signal<string[]>(["x"]);
    const label = signal("hello");

    // Fragment with dynamic content followed by a sibling that also updates.
    // If _domNodeCount is wrong for empty Fragment, the sibling's text update
    // hits the wrong DOM node (cursor misalignment).
    const App = () =>
      h(
        "div",
        { id: "wrap" },
        h(Fragment, null, ...items.value.map((i) => h("span", null, i))),
        h("em", null, label.value),
      );

    const handle = mount(root, App);
    const wrap = root.querySelector("#wrap")!;
    assertEquals(wrap.innerHTML, "<span>x</span><em>hello</em>");

    // Empty the Fragment → comment anchor
    items.set([]);
    handle._flush();
    assertEquals(wrap.querySelector("em")!.textContent, "hello");

    // Now update the sibling text — this is where AIO-169 manifests.
    // With wrong _domNodeCount(empty Fragment)=0, cursor doesn't advance past
    // the comment anchor, so the <em>'s oldDom snapshot is wrong and text
    // update may target the wrong node.
    label.set("world");
    handle._flush();
    assertEquals(
      wrap.querySelector("em")!.textContent,
      "world",
      "AIO-169: sibling text after empty Fragment should update correctly",
    );

    _unmount(handle);
    cleanup();
  },
});

// ── AIO-170: Signal-binding style handling ──────────────────────────

Deno.test({
  name: "AIO-170: signal-bound style object applies correctly",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const style = signal<Record<string, string>>({
      color: "red",
      fontSize: "14px",
    });

    const App = () => h("div", { id: "box", style: style }, "styled");

    const handle = mount(root, App);
    const box = root.querySelector("#box") as HTMLElement;

    // Signal style object should apply as inline styles
    assertEquals(box.style.color, "red");
    assertEquals(box.style.fontSize, "14px");

    // Update signal → style should change
    style.set({ color: "blue", marginTop: "10px" });
    handle._flush();
    assertEquals(box.style.color, "blue");
    assertEquals(box.style.marginTop, "10px");
    // fontSize should be cleared (not in new object)
    assertEquals(box.style.fontSize, "");

    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "AIO-170: signal-bound style string applies correctly",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const style = signal("color: green");

    const App = () => h("div", { id: "box", style: style }, "styled");

    const handle = mount(root, App);
    const box = root.querySelector("#box") as HTMLElement;

    assertEquals(box.style.color, "green");

    style.set("color: purple; font-weight: bold");
    handle._flush();
    assertEquals(box.style.color, "purple");

    _unmount(handle);
    cleanup();
  },
});

// ── AIO-177: diffKeyed Fragment lastPlaced tracks first child, not last ─

Deno.test({
  name:
    "AIO-177: keyed Fragment reorder — siblings positioned after last Fragment child",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const order = signal<"abc" | "dfc">("abc");

    // Keyed children: Fragment with 2 spans, plus 2 keyed elements
    const App = () => {
      if (order.value === "abc") {
        return h(
          "div",
          { id: "wrap" },
          h(Fragment, { key: "f" }, h("span", null, "A"), h("span", null, "B")),
          h("em", { key: "c" }, "C"),
          h("b", { key: "d" }, "D"),
        );
      } else {
        // Reorder: D first, then Fragment, then C
        return h(
          "div",
          { id: "wrap" },
          h("b", { key: "d" }, "D"),
          h(Fragment, { key: "f" }, h("span", null, "A"), h("span", null, "B")),
          h("em", { key: "c" }, "C"),
        );
      }
    };

    const handle = mount(root, App);
    const wrap = root.querySelector("#wrap")!;
    assertEquals(
      wrap.innerHTML,
      "<span>A</span><span>B</span><em>C</em><b>D</b>",
    );

    // Reorder: D, Fragment[A,B], C
    order.set("dfc");
    handle._flush();

    // Expected: D, A, B, C — Fragment's children must stay together
    assertEquals(
      wrap.innerHTML,
      "<b>D</b><span>A</span><span>B</span><em>C</em>",
      "AIO-177: keyed Fragment reorder — C should be after B, not inserted between A and B",
    );

    _unmount(handle);
    cleanup();
  },
});
