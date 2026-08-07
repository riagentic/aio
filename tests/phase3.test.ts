import { assertEquals, assertNotEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/state/signal.ts";
import { ErrorBoundary, Fragment, h, renderToString } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
} from "../src/air/aio-renderer.ts";
import {
  _getState,
  _injectState,
  _reset as _resetAio,
  handleMessage,
} from "../src/state-core.ts";
import { useAio, useLocal } from "../src/adapters/air.ts";

function createDOM(): {
  document: Document;
  root: HTMLElement;
  cleanup: () => void;
} {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.happyDOM.close() };
}

// ── Multi-root mount isolation ──────────────────────────────────────

Deno.test({
  name: "phase3: multi-root isolation — two mounts don't interfere",
  async fn() {
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
    await cleanup();
  },
});

// ── className array/object ──────────────────────────────────────────

Deno.test({
  name: "phase3: className array — joins truthy values",
  async fn() {
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
    await cleanup();
  },
});

Deno.test({
  name: "phase3: className object — keys with truthy values",
  async fn() {
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
    await cleanup();
  },
});

Deno.test({
  name: "phase3: className string — works as before",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const App = () => h("div", { className: "foo bar" });
    const handle = mount(root, App);
    assertEquals(
      (root.firstChild as HTMLElement).getAttribute("class"),
      "foo bar",
    );
    _unmount(handle);
    await cleanup();
  },
});

// ── Ref support ─────────────────────────────────────────────────────

Deno.test({
  name: "phase3: callback ref — called with DOM node on mount",
  async fn() {
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
    await cleanup();
  },
});

Deno.test({
  name: "phase3: object ref — current set on mount",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const myRef: { current: Node | null } = { current: null };
    const App = () => h("div", { ref: myRef }, "hello");
    const handle = mount(root, App);
    assertNotEquals(myRef.current, null);
    assertEquals((myRef.current as HTMLElement).tagName?.toLowerCase(), "div");
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "phase3: ref nulled on element removal",
  async fn() {
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
    await cleanup();
  },
});

// ── Error boundaries ────────────────────────────────────────────────

Deno.test({
  name: "phase3: ErrorBoundary catches child render error",
  async fn() {
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
    await cleanup();
  },
});

Deno.test({
  name: "phase3: ErrorBoundary — siblings unaffected",
  async fn() {
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
    await cleanup();
  },
});

Deno.test({
  name: "phase3: ErrorBoundary — no error renders children normally",
  async fn() {
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
    await cleanup();
  },
});

// ── SSR: renderToString ─────────────────────────────────────────────

Deno.test({
  name: "ssr: renderToString — simple element",
  async fn() {
    const html = renderToString(h("div", { className: "box" }, "hello"));
    assertEquals(html, '<div class="box">hello</div>');
  },
});

Deno.test({
  name: "ssr: renderToString — nested elements",
  async fn() {
    const html = renderToString(
      h("ul", null, h("li", null, "a"), h("li", null, "b")),
    );
    assertEquals(html, "<ul><li>a</li><li>b</li></ul>");
  },
});

Deno.test({
  name: "ssr: renderToString — component",
  async fn() {
    const Greeting = (props: { name: string }) =>
      h("span", null, `Hi ${props.name}`);
    const html = renderToString(h(Greeting, { name: "World" }));
    assertEquals(html, "<span>Hi World</span>");
  },
});

Deno.test({
  name: "ssr: renderToString — fragment",
  async fn() {
    const html = renderToString(
      h(Fragment, null, h("a", null, "1"), h("b", null, "2")),
    );
    assertEquals(html, "<a>1</a><b>2</b>");
  },
});

Deno.test({
  name: "ssr: renderToString — void elements",
  async fn() {
    const html = renderToString(h("input", { type: "text", value: "hi" }));
    assertEquals(html, '<input type="text" value="hi">');
  },
});

Deno.test({
  name: "ssr: renderToString — boolean attributes",
  async fn() {
    const html = renderToString(
      h("input", { type: "checkbox", checked: true, disabled: false }),
    );
    assertEquals(html, '<input type="checkbox" checked>');
  },
});

Deno.test({
  name: "ssr: renderToString — style object",
  async fn() {
    const html = renderToString(
      h("div", { style: { color: "red", fontSize: "14px" } }),
    );
    assertEquals(html, '<div style="color:red;font-size:14px"></div>');
  },
});

Deno.test({
  name: "ssr: renderToString — className array",
  async fn() {
    const html = renderToString(h("div", { className: ["a", false, "b"] }));
    assertEquals(html, '<div class="a b"></div>');
  },
});

Deno.test({
  name: "ssr: renderToString — className object",
  async fn() {
    const html = renderToString(
      h("div", { className: { active: true, hidden: false } }),
    );
    assertEquals(html, '<div class="active"></div>');
  },
});

Deno.test({
  name: "ssr: renderToString — HTML escaping",
  async fn() {
    const html = renderToString(h("div", null, "<script>alert(1)</script>"));
    assertEquals(html, "<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>");
  },
});

Deno.test({
  name: "ssr: renderToString — dangerouslySetInnerHTML",
  async fn() {
    const html = renderToString(
      h("div", { dangerouslySetInnerHTML: { __html: "<b>bold</b>" } }),
    );
    assertEquals(html, "<div><b>bold</b></div>");
  },
});

Deno.test({
  name: "ssr: renderToString — ErrorBoundary catches",
  async fn() {
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
  async fn() {
    const html = renderToString(h("button", { onClick: () => {} }, "click"));
    assertEquals(html, "<button>click</button>");
  },
});

Deno.test({
  name: "ssr: renderToString — ref skipped",
  async fn() {
    const html = renderToString(h("div", { ref: () => {} }, "ref"));
    assertEquals(html, "<div>ref</div>");
  },
});

// ── Hydrate ─────────────────────────────────────────────────────────

Deno.test({
  name: "phase3: hydrate — attaches to existing DOM",
  async fn() {
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
    await cleanup();
  },
});

Deno.test({
  name: "phase3: hydrate — attaches event listeners",
  async fn() {
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
    await cleanup();
  },
});

Deno.test({
  name: "phase3: hydrate — signal changes work after hydration",
  async fn() {
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
    await cleanup();
  },
});

// ── AIO Hooks: useAio ──────────────────────────────────────────────

Deno.test({
  name: "aio-hooks: useAio — reads full state reactively",
  async fn() {
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

    handleMessage({
      $patches: [{ op: "replace", path: ["counter", "count"], value: 20 }],
    });
    handle._flush();
    assertEquals(root.innerHTML, '<div>{"count":20}</div>');

    _unmount(handle);
    _resetAio();
    await cleanup();
  },
});

// ── AIO Hooks: useLocal ─────────────────────────────────────────────

Deno.test({
  name: "aio-hooks: useLocal — local state reactive in component",
  async fn() {
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
    await cleanup();
  },
});
