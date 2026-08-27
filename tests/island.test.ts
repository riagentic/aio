import { assertEquals, assertExists } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/state/signal.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import type { MountHandle } from "../src/air/aio-renderer.ts";
import { island } from "../src/air/island.ts";

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
  name: "island: mounts external component after lazy load",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);

    let mountedProps: Record<string, unknown> | null = null;
    let mountedContainer: HTMLElement | null = null;

    const ExternalWidget = island({
      load: () => Promise.resolve({ default: "FakeComponent" }),
      mount: (container, _component, props) => {
        mountedContainer = container;
        mountedProps = { ...props };
        container.innerHTML = `<span>external: ${props.label}</span>`;
        return {
          update(p) {
            container.innerHTML = `<span>external: ${p.label}</span>`;
            mountedProps = { ...p };
          },
          unmount() {
            container.innerHTML = "";
          },
        };
      },
      props: () => ({ label: "hello" }),
    });

    function App() {
      return h(ExternalWidget, null);
    }

    const handle = mount(root, App);
    await delay(10);
    handle._flush();

    assertExists(mountedContainer);
    assertEquals(mountedProps!.label, "hello");
    assertEquals(root.querySelector("span")?.textContent, "external: hello");

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "island: updates external component when props signal changes",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);

    const label = signal("v1");
    let updateCount = 0;

    const ExternalWidget = island({
      load: () => Promise.resolve({ default: "FakeComponent" }),
      mount: (container, _component, props) => {
        container.innerHTML = `<span>${props.label}</span>`;
        return {
          update(p) {
            updateCount++;
            container.innerHTML = `<span>${p.label}</span>`;
          },
          unmount() {
            container.innerHTML = "";
          },
        };
      },
      props: () => ({ label: label.value }),
    });

    function App() {
      return h(ExternalWidget, null);
    }

    const handle = mount(root, App);
    await delay(10);
    handle._flush();
    assertEquals(root.querySelector("span")?.textContent, "v1");

    label.set("v2");
    await delay(10);
    assertEquals(root.querySelector("span")?.textContent, "v2");
    assertEquals(updateCount >= 1, true);

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "island: unmounts external component on AIR unmount",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);

    let unmounted = false;
    const show = signal(true);

    const ExternalWidget = island({
      load: () => Promise.resolve({ default: "Fake" }),
      mount: (container) => {
        container.innerHTML = "<b>ext</b>";
        return {
          update() {},
          unmount() {
            unmounted = true;
            container.innerHTML = "";
          },
        };
      },
      props: () => ({}),
    });

    function App() {
      return show.value ? h(ExternalWidget, null) : h("span", null, "gone");
    }

    const handle = mount(root, App);
    await delay(10);
    handle._flush();
    assertEquals(unmounted, false);

    show.set(false);
    handle._flush();
    await delay(10);
    assertEquals(unmounted, true);

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "island: shows loading placeholder while module loads",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);

    let resolveLoad: (() => void) | undefined;

    const ExternalWidget = island({
      load: () =>
        new Promise((r) => {
          resolveLoad = () => r({ default: "Fake" });
        }),
      mount: (container) => {
        container.innerHTML = "<b>loaded</b>";
        return { update() {}, unmount() {} };
      },
      props: () => ({}),
      loading: () => h("span", null, "loading..."),
    });

    function App() {
      return h(ExternalWidget, null);
    }

    const handle = mount(root, App);
    handle._flush();
    assertEquals(root.innerHTML.includes("loading..."), true);

    resolveLoad!();
    await delay(10);
    handle._flush();
    assertEquals(root.querySelector("b")?.textContent, "loaded");

    _unmount(handle);
    await cleanup();
  },
});

// Every test above uses a prop-LESS island, which is exactly why the most
// destructive island bug went unseen: `onCleanup` sat in the component BODY, so
// it ran before every RE-RENDER, not only at unmount. `<Chart n={count}/>`
// mounted, then tore the external component down on the first `n` change — and
// `onMount` is once-per-instance, so nothing ever rebuilt it. Measured:
// mounts 1, unmounts 1, and a permanently empty <div>. Reactive props were dead,
// silently.
Deno.test({
  name: "island: a changing prop updates the island, never unmounts it",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const count = signal(0);
    let mounts = 0, unmounts = 0, updates = 0;

    const Widget = island({
      load: () => Promise.resolve({ default: "Fake" }),
      mount: (container, _c, props) => {
        mounts++;
        container.innerHTML = `<span>n=${props.n}</span>`;
        return {
          update(p) {
            updates++;
            container.innerHTML = `<span>n=${p.n}</span>`;
          },
          unmount() {
            unmounts++;
            container.innerHTML = "";
          },
        };
      },
      props: () => ({ n: count.value }),
    });

    function App() {
      return h("div", null, h(Widget, { n: count.value }));
    }

    const handle = mount(root, App);
    await delay(10);
    handle._flush();
    assertEquals(root.querySelector("span")?.textContent, "n=0");

    count.set(1);
    await delay(10);
    handle._flush();
    await delay(10);

    assertEquals(unmounts, 0, "a prop change must not unmount the island");
    assertEquals(mounts, 1, "mounted exactly once");
    assertEquals(updates, 1, "the external component was UPDATED instead");
    assertEquals(root.querySelector("span")?.textContent, "n=1");

    _unmount(handle);
    assertEquals(unmounts, 1, "and it IS unmounted when the tree goes away");
    await cleanup();
  },
});

// Same, with a `loading` placeholder — the placeholder is the island's initial
// child, so a re-render also has to leave the externally-injected DOM alone.
Deno.test({
  name: "island: a changing prop survives a loading placeholder",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const count = signal(0);

    const Widget = island({
      load: () => Promise.resolve({ default: "Fake" }),
      mount: (container, _c, props) => {
        container.innerHTML = `<span>n=${props.n}</span>`;
        return {
          update(p) {
            container.innerHTML = `<span>n=${p.n}</span>`;
          },
          unmount() {
            container.innerHTML = "";
          },
        };
      },
      props: () => ({ n: count.value }),
      loading: () => h("em", null, "loading..."),
    });

    function App() {
      return h("div", null, h(Widget, { n: count.value }));
    }

    const handle = mount(root, App);
    await delay(10);
    handle._flush();
    count.set(1);
    await delay(10);
    handle._flush();
    await delay(10);
    assertEquals(root.innerHTML, "<div><div><span>n=1</span></div></div>");
    _unmount(handle);
    await cleanup();
  },
});
