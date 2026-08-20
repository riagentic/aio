import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/state/signal.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import type { MountHandle } from "../src/air/aio-renderer.ts";
import { Show } from "../src/air/show.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.happyDOM.close() };
}

Deno.test({
  name: "Show: renders children when condition is truthy",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const user = signal<{ name: string } | null>({ name: "Alice" });

    function App() {
      return h(Show, {
        when: user.value,
        fallback: h("span", null, "loading"),
        children: (u: { name: string }) => h("div", null, u.name),
      });
    }

    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<div>Alice</div>");
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "Show: renders fallback when condition is falsy",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const user = signal<{ name: string } | null>(null);

    function App() {
      return h(Show, {
        when: user.value,
        fallback: h("span", null, "loading"),
        children: (u: { name: string }) => h("div", null, u.name),
      });
    }

    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<span>loading</span>");
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "Show: switches between children and fallback reactively",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const user = signal<{ name: string } | null>(null);

    function App() {
      return h(Show, {
        when: user.value,
        fallback: h("span", null, "loading"),
        children: (u: { name: string }) => h("div", null, u.name),
      });
    }

    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<span>loading</span>");

    user.set({ name: "Bob" });
    handle._flush();
    assertEquals(root.innerHTML, "<div>Bob</div>");

    user.set(null);
    handle._flush();
    assertEquals(root.innerHTML, "<span>loading</span>");

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "Show: renders nothing when falsy and no fallback",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const flag = signal(false);

    function App() {
      return h(Show, {
        when: flag.value,
        children: () => h("div", null, "visible"),
      });
    }

    const handle = mount(root, App);
    // "Nothing" is a comment placeholder holding the position, not the absence
    // of any node: `<Show>` is exactly the shape that must come back WHERE IT
    // WAS WRITTEN rather than at the end of its parent (rimote R-10). Null
    // children have paid this same one-comment cost since AIO-107, and SSR
    // emits it too, so this is the framework agreeing with itself.
    assertEquals(root.innerHTML, "<!---->");
    assertEquals(root.querySelector("div"), null, "no element while falsy");

    flag.set(true);
    handle._flush();
    assertEquals(root.innerHTML, "<div>visible</div>");

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "Show: works with primitive truthy values",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const count = signal(0);

    function App() {
      return h(Show, {
        when: count.value,
        fallback: h("span", null, "zero"),
        children: (n: number) => h("div", null, String(n)),
      });
    }

    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<span>zero</span>");

    count.set(42);
    handle._flush();
    assertEquals(root.innerHTML, "<div>42</div>");

    _unmount(handle);
    await cleanup();
  },
});
