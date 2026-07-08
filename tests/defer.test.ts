import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { Defer } from "../src/air/defer.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.happyDOM.close() };
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

Deno.test({
  name: "Defer: immediate trigger loads content right away",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);

    function HeavyComponent() {
      return h("div", null, "loaded");
    }

    function App() {
      return h(Defer, {
        trigger: "immediate",
        load: () => Promise.resolve({ default: HeavyComponent }),
        placeholder: h("span", null, "placeholder"),
        loading: h("span", null, "loading..."),
      });
    }

    const handle = mount(root, App);
    // Should show loading or loading container
    const initialHtml = root.innerHTML;
    assertEquals(
      initialHtml.includes("loading") || initialHtml.includes("placeholder"),
      true,
    );

    await delay(20);
    handle._flush();
    assertEquals(root.innerHTML, "<div>loaded</div>");

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "Defer: timer trigger loads after delay",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);

    function HeavyComponent() {
      return h("div", null, "loaded");
    }

    function App() {
      return h(Defer, {
        trigger: 50,
        load: () => Promise.resolve({ default: HeavyComponent }),
        placeholder: h("span", null, "waiting"),
      });
    }

    const handle = mount(root, App);
    assertEquals(root.innerHTML.includes("waiting"), true);

    await delay(20);
    handle._flush();
    // Still waiting — timer hasn't fired
    assertEquals(root.innerHTML.includes("waiting"), true);

    await delay(50);
    handle._flush();
    await delay(10);
    handle._flush();
    assertEquals(root.innerHTML, "<div>loaded</div>");

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "Defer: shows error fallback on load failure",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);

    function App() {
      return h(Defer, {
        trigger: "immediate",
        load: () => Promise.reject(new Error("network fail")),
        placeholder: h("span", null, "placeholder"),
        error: h("span", null, "failed"),
      });
    }

    const handle = mount(root, App);
    await delay(20);
    handle._flush();
    assertEquals(root.innerHTML, "<span>failed</span>");

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "Defer: falls back to placeholder when no error prop",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);

    function App() {
      return h(Defer, {
        trigger: "immediate",
        load: () => Promise.reject(new Error("fail")),
        placeholder: h("span", null, "placeholder"),
      });
    }

    const handle = mount(root, App);
    await delay(20);
    handle._flush();
    // Falls back to placeholder on error when no error prop
    assertEquals(root.innerHTML.includes("placeholder"), true);

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "Defer: passes componentProps to loaded component",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);

    function DataComp(props: { title: string }) {
      return h("h1", null, props.title);
    }

    function App() {
      return h(Defer, {
        trigger: "immediate",
        load: () => Promise.resolve({ default: DataComp }),
        componentProps: { title: "Hello World" },
      });
    }

    const handle = mount(root, App);
    await delay(20);
    handle._flush();
    assertEquals(root.innerHTML, "<h1>Hello World</h1>");

    _unmount(handle);
    await cleanup();
  },
});
