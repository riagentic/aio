import { assertEquals, assertNotEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/signal.ts";
import { ErrorBoundary, Fragment, h, renderToString } from "../src/vdom.ts";
import { _setDocument, _unmount, hydrate, mount } from "../src/aio-renderer.ts";
import {
  _getState,
  _injectDelta,
  _injectState,
  _reset as _resetAio,
  type FeatureRef,
} from "../src/state-core.ts";
import { useAio, useFeature, useLocal } from "../src/adapters/air.ts";

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

// ── Multi-root mount isolation ──────────────────────────────────────

Deno.test({
  name: "phase3: multi-root isolation — two mounts don't interfere",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const root2 = document.createElement("div");
    document.body.appendChild(root2);

    const sigA = signal("a1");
    const sigB = signal("b1");
    let callsA = 0;
    let callsB = 0;

    const AppA = () => {
      callsA++;
      return h("span", null, sigA.value);
    };
    const AppB = () => {
      callsB++;
      return h("span", null, sigB.value);
    };

    const handleA = mount(root, AppA);
    const handleB = mount(root2, AppB);

    assertEquals(callsA, 1);
    assertEquals(callsB, 1);
    assertEquals(root.innerHTML, "<span>a1</span>");
    assertEquals(root2.innerHTML, "<span>b1</span>");

    // Change sigA — only AppA re-renders
    sigA.set("a2");
    handleA._flush();
    handleB._flush();
    assertEquals(callsA, 2);
    assertEquals(callsB, 1);
    assertEquals(root.innerHTML, "<span>a2</span>");
    assertEquals(root2.innerHTML, "<span>b1</span>");

    _unmount(handleA);
    _unmount(handleB);
    cleanup();
  },
});

// ── className array/object ──────────────────────────────────────────

Deno.test({
  name: "phase3: className array — joins truthy values",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const active = signal(true);
    const App = () =>
      h("div", {
        className: ["base", active.value && "active", false && "hidden"],
      });
    const handle = mount(root, App);
    assertEquals(
      (root.firstChild as HTMLElement).getAttribute("class"),
      "base active",
    );
    active.set(false);
    handle._flush();
    assertEquals(
      (root.firstChild as HTMLElement).getAttribute("class"),
      "base",
    );
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "phase3: className object — keys with truthy values",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const App = () =>
      h("div", { className: { btn: true, primary: true, disabled: false } });
    const handle = mount(root, App);
    assertEquals(
      (root.firstChild as HTMLElement).getAttribute("class"),
      "btn primary",
    );
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "phase3: className string — works as before",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const App = () => h("div", { className: "foo bar" });
    const handle = mount(root, App);
    assertEquals(
      (root.firstChild as HTMLElement).getAttribute("class"),
      "foo bar",
    );
    _unmount(handle);
    cleanup();
  },
});

// ── Ref support ─────────────────────────────────────────────────────

Deno.test({
  name: "phase3: callback ref — called with DOM node on mount",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    let captured: Node | null = null;
    const App = () =>
      h("div", {
        ref: (el: Node | null) => {
          captured = el;
        },
      }, "hello");
    const handle = mount(root, App);
    assertNotEquals(captured, null);
    assertEquals(
      (captured as unknown as HTMLElement).tagName?.toLowerCase(),
      "div",
    );
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "phase3: object ref — current set on mount",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const myRef: { current: Node | null } = { current: null };
    const App = () => h("div", { ref: myRef }, "hello");
    const handle = mount(root, App);
    assertNotEquals(myRef.current, null);
    assertEquals((myRef.current as HTMLElement).tagName?.toLowerCase(), "div");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "phase3: ref nulled on element removal",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    let refValue: Node | null = null;
    const show = signal(true);
    const App = () =>
      h(
        "div",
        null,
        show.value
          ? h("span", {
            ref: (el: Node | null) => {
              refValue = el;
            },
          }, "hi")
          : null,
      );
    const handle = mount(root, App);
    assertNotEquals(refValue, null);
    show.set(false);
    handle._flush();
    assertEquals(refValue, null);
    _unmount(handle);
    cleanup();
  },
});

// ── Error boundaries ────────────────────────────────────────────────

Deno.test({
  name: "phase3: ErrorBoundary catches child render error",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const Broken = () => {
      throw new Error("boom");
    };
    const App = () =>
      h(
        "div",
        null,
        h(ErrorBoundary, {
          fallback: (e: Error) => h("span", { className: "error" }, e.message),
        }, h(Broken, null)),
      );
    const handle = mount(root, App);
    assertEquals(root.querySelector(".error")?.textContent, "boom");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "phase3: ErrorBoundary — siblings unaffected",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const Broken = () => {
      throw new Error("fail");
    };
    const App = () =>
      h(
        "div",
        null,
        h("span", null, "before"),
        h(ErrorBoundary, {
          fallback: (e: Error) => h("b", null, e.message),
        }, h(Broken, null)),
        h("span", null, "after"),
      );
    const handle = mount(root, App);
    const spans = root.querySelectorAll("span");
    assertEquals(spans.length, 2);
    assertEquals(spans[0]?.textContent, "before");
    assertEquals(spans[1]?.textContent, "after");
    assertEquals(root.querySelector("b")?.textContent, "fail");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "phase3: ErrorBoundary — no error renders children normally",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const Safe = () => h("span", null, "ok");
    const App = () =>
      h(
        "div",
        null,
        h(ErrorBoundary, {
          fallback: () => h("b", null, "error"),
        }, h(Safe, null)),
      );
    const handle = mount(root, App);
    assertEquals(root.querySelector("span")?.textContent, "ok");
    assertEquals(root.querySelector("b"), null);
    _unmount(handle);
    cleanup();
  },
});

// ── SSR: renderToString ─────────────────────────────────────────────

Deno.test({
  name: "ssr: renderToString — simple element",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const html = renderToString(h("div", { className: "box" }, "hello"));
    assertEquals(html, '<div class="box">hello</div>');
  },
});

Deno.test({
  name: "ssr: renderToString — nested elements",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const html = renderToString(
      h("ul", null, h("li", null, "a"), h("li", null, "b")),
    );
    assertEquals(html, "<ul><li>a</li><li>b</li></ul>");
  },
});

Deno.test({
  name: "ssr: renderToString — component",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const Greeting = (props: { name: string }) =>
      h("span", null, `Hi ${props.name}`);
    const html = renderToString(h(Greeting, { name: "World" }));
    assertEquals(html, "<span>Hi World</span>");
  },
});

Deno.test({
  name: "ssr: renderToString — fragment",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const html = renderToString(
      h(Fragment, null, h("a", null, "1"), h("b", null, "2")),
    );
    assertEquals(html, "<a>1</a><b>2</b>");
  },
});

Deno.test({
  name: "ssr: renderToString — void elements",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const html = renderToString(h("input", { type: "text", value: "hi" }));
    assertEquals(html, '<input type="text" value="hi">');
  },
});

Deno.test({
  name: "ssr: renderToString — boolean attributes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const html = renderToString(
      h("input", { type: "checkbox", checked: true, disabled: false }),
    );
    assertEquals(html, '<input type="checkbox" checked>');
  },
});

Deno.test({
  name: "ssr: renderToString — style object",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const html = renderToString(
      h("div", { style: { color: "red", fontSize: "14px" } }),
    );
    assertEquals(html, '<div style="color:red;font-size:14px"></div>');
  },
});

Deno.test({
  name: "ssr: renderToString — className array",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const html = renderToString(h("div", { className: ["a", false, "b"] }));
    assertEquals(html, '<div class="a b"></div>');
  },
});

Deno.test({
  name: "ssr: renderToString — className object",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const html = renderToString(
      h("div", { className: { active: true, hidden: false } }),
    );
    assertEquals(html, '<div class="active"></div>');
  },
});

Deno.test({
  name: "ssr: renderToString — HTML escaping",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const html = renderToString(h("div", null, "<script>alert(1)</script>"));
    assertEquals(html, "<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>");
  },
});

Deno.test({
  name: "ssr: renderToString — dangerouslySetInnerHTML",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const html = renderToString(
      h("div", { dangerouslySetInnerHTML: { __html: "<b>bold</b>" } }),
    );
    assertEquals(html, "<div><b>bold</b></div>");
  },
});

Deno.test({
  name: "ssr: renderToString — ErrorBoundary catches",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const Broken = () => {
      throw new Error("ssr-boom");
    };
    const html = renderToString(
      h(ErrorBoundary, {
        fallback: (e: Error) => h("div", null, `Error: ${e.message}`),
      }, h(Broken, null)),
    );
    assertEquals(html, "<div>Error: ssr-boom</div>");
  },
});

Deno.test({
  name: "ssr: renderToString — null/skip event handlers",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const html = renderToString(h("button", { onClick: () => {} }, "click"));
    assertEquals(html, "<button>click</button>");
  },
});

Deno.test({
  name: "ssr: renderToString — ref skipped",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const html = renderToString(h("div", { ref: () => {} }, "ref"));
    assertEquals(html, "<div>ref</div>");
  },
});

// ── Hydrate ─────────────────────────────────────────────────────────

Deno.test({
  name: "phase3: hydrate — attaches to existing DOM",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    // Pre-render HTML (simulate SSR output)
    root.innerHTML = "<div><span>hello</span></div>";
    const originalSpan = root.querySelector("span");

    const App = () => h("div", null, h("span", null, "hello"));
    const handle = hydrate(root, App);

    // DOM should be preserved (same nodes, not re-created)
    assertEquals(root.querySelector("span"), originalSpan);
    assertEquals(root.innerHTML, "<div><span>hello</span></div>");

    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "phase3: hydrate — attaches event listeners",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    root.innerHTML = "<button>Click</button>";
    let clicked = false;
    const App = () =>
      h("button", {
        onClick: () => {
          clicked = true;
        },
      }, "Click");
    const handle = hydrate(root, App);

    (root.firstChild as HTMLElement).click();
    assertEquals(clicked, true);

    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "phase3: hydrate — signal changes work after hydration",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    root.innerHTML = "<div>Count: 0</div>";
    const count = signal(0);
    const App = () => h("div", null, `Count: ${count.value}`);
    const handle = hydrate(root, App);

    assertEquals(root.innerHTML, "<div>Count: 0</div>");
    count.set(5);
    handle._flush();
    assertEquals(root.innerHTML, "<div>Count: 5</div>");

    _unmount(handle);
    cleanup();
  },
});

// ── AIO Hooks: useFeature ───────────────────────────────────────────

Deno.test({
  name: "aio-hooks: useFeature — reads injected state reactively",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    _resetAio();

    const counter: FeatureRef = {
      __aio: { id: "counter", state: { count: 0 } },
    };
    _injectState({ counter: { count: 42 } });

    const App = () => {
      const { state } = useFeature(counter);
      return h("div", null, `Count: ${state.count}`);
    };

    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<div>Count: 42</div>");

    // Delta update
    _injectDelta({ $p: { counter: { count: 99 } } });
    handle._flush();
    assertEquals(root.innerHTML, "<div>Count: 99</div>");

    _unmount(handle);
    _resetAio();
    cleanup();
  },
});

Deno.test({
  name: "aio-hooks: useFeature — fallback to initial state",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    _resetAio();

    const counter: FeatureRef = {
      __aio: { id: "counter", state: { count: 0 } },
    };
    // No state injected — should use fallback from ref

    const App = () => {
      const { state } = useFeature(counter);
      return h("div", null, `Count: ${state.count}`);
    };

    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<div>Count: 0</div>");

    _unmount(handle);
    _resetAio();
    cleanup();
  },
});

Deno.test({
  name: "aio-hooks: useFeature — send proxy dispatches actions",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    _resetAio();

    const counter: FeatureRef = {
      __aio: { id: "counter", state: { count: 0 } },
    };
    const { send } = useFeature(counter);

    // Can't test WebSocket sending without mock, but verify send is callable
    assertEquals(typeof send.increment, "function");
    assertEquals(typeof send.reset, "function");

    // Calling should not throw (queues offline)
    send.increment!(5);

    _resetAio();
  },
});

// ── AIO Hooks: useAio ──────────────────────────────────────────────

Deno.test({
  name: "aio-hooks: useAio — reads full state reactively",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    _resetAio();

    _injectState({ counter: { count: 10 }, todo: { items: [] } });

    const App = () => {
      const { state } = useAio();
      return h("div", null, JSON.stringify(state.counter));
    };

    const handle = mount(root, App);
    assertEquals(root.innerHTML, '<div>{"count":10}</div>');

    _injectDelta({ $p: { counter: { count: 20 } } });
    handle._flush();
    assertEquals(root.innerHTML, '<div>{"count":20}</div>');

    _unmount(handle);
    _resetAio();
    cleanup();
  },
});

// ── AIO Hooks: useLocal ─────────────────────────────────────────────

Deno.test({
  name: "aio-hooks: useLocal — local state reactive in component",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    // useLocal called outside component (like signal) — persists across re-renders
    const editing = useLocal(false);
    const App = () => h("div", null, editing.local ? "editing" : "viewing");

    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<div>viewing</div>");

    editing.set(true);
    handle._flush();
    assertEquals(root.innerHTML, "<div>editing</div>");

    _unmount(handle);
    cleanup();
  },
});

// ── AIO Hooks: $id: identity array ─────────────────────────────────

Deno.test({
  name: "aio-hooks: $id array patch — adds and updates elements",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    _resetAio();

    _injectState({
      fleet: {
        members: [
          { id: "SOL", name: "Solana", price: 100 },
          { id: "BTC", name: "Bitcoin", price: 50000 },
        ],
      },
    });

    // Verify initial state
    const state = _getState();
    assertEquals(state.fleet.members.length, 2);

    // $id: patch — update SOL price, add ETH
    _injectDelta({
      $p: {
        fleet: {
          members: {
            $arr: true,
            "$id:SOL": { id: "SOL", name: "Solana", price: 200 },
            "$id:ETH": { id: "ETH", name: "Ethereum", price: 3000 },
          },
        },
      },
    });

    const updated = _getState();
    assertEquals(updated.fleet.members.length, 3);
    assertEquals(updated.fleet.members[0].price, 200); // SOL updated
    assertEquals(updated.fleet.members[2].id, "ETH"); // ETH added

    _resetAio();
  },
});

Deno.test({
  name: "aio-hooks: $id array patch — removes elements via $d",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    _resetAio();

    _injectState({
      fleet: {
        members: [
          { id: "SOL", name: "Solana" },
          { id: "BTC", name: "Bitcoin" },
          { id: "ETH", name: "Ethereum" },
        ],
      },
    });

    // Remove BTC via $d path
    _injectDelta({ $d: ["fleet.members.$id:BTC"] });

    const updated = _getState();
    assertEquals(updated.fleet.members.length, 2);
    assertEquals(updated.fleet.members[0].id, "SOL");
    assertEquals(updated.fleet.members[1].id, "ETH");

    _resetAio();
  },
});

Deno.test({
  name: "aio-hooks: $id array — renders reactively in component",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    _resetAio();

    const fleet: FeatureRef = {
      __aio: { id: "fleet", state: { members: [] } },
    };
    _injectState({
      fleet: {
        members: [
          { id: "SOL", name: "Solana" },
          { id: "BTC", name: "Bitcoin" },
        ],
      },
    });

    const App = () => {
      const { state } = useFeature(fleet);
      const members = (state as Record<string, unknown>).members as {
        id: string;
        name: string;
      }[];
      return h(
        "ul",
        null,
        ...members.map((m) => h("li", { key: m.id }, m.name)),
      );
    };

    const handle = mount(root, App);
    assertEquals(root.querySelectorAll("li").length, 2);

    // Add via $id patch
    _injectDelta({
      $p: {
        fleet: {
          members: {
            $arr: true,
            "$id:ETH": { id: "ETH", name: "Ethereum" },
          },
        },
      },
    });
    handle._flush();
    assertEquals(root.querySelectorAll("li").length, 3);

    _unmount(handle);
    _resetAio();
    cleanup();
  },
});

// ── AIO Hooks: delta deep merge ($f) ───────────────────────────────

Deno.test({
  name: "aio-hooks: filtered delta ($f:1) deep merges",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    _resetAio();

    _injectState({
      dashboard: {
        stats: { online: 5, total: 10 },
        config: { theme: "dark" },
      },
    });

    // Filtered response — only updates stats.online, preserves stats.total and config
    _injectDelta({
      $p: { dashboard: { stats: { online: 8 } } },
      $f: 1,
    });

    const state = _getState();
    assertEquals(state.dashboard.stats.online, 8);
    assertEquals(state.dashboard.stats.total, 10); // Preserved
    assertEquals(state.dashboard.config.theme, "dark"); // Preserved

    _resetAio();
  },
});

// ── AIO Hooks: simple $d deletion ──────────────────────────────────

Deno.test({
  name: "aio-hooks: $d deletes feature-level key",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    _resetAio();

    _injectState({
      counter: { count: 5 },
      todo: { items: [] },
    });

    _injectDelta({ $d: ["todo"] });

    const state = _getState();
    assertEquals(state.counter.count, 5);
    assertEquals(state.todo, undefined);

    _resetAio();
  },
});
