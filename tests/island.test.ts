import { assertEquals, assertExists } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/signal.ts";
import { h } from "../src/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/aio-renderer.ts";
import type { MountHandle } from "../src/aio-renderer.ts";
import { island } from "../src/island.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.close() };
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

Deno.test({
  name: "island: mounts external component after lazy load",
  sanitizeOps: false,
  sanitizeResources: false,
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
    cleanup();
  },
});

Deno.test({
  name: "island: updates external component when props signal changes",
  sanitizeOps: false,
  sanitizeResources: false,
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
    cleanup();
  },
});

Deno.test({
  name: "island: unmounts external component on AIR unmount",
  sanitizeOps: false,
  sanitizeResources: false,
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
    cleanup();
  },
});

Deno.test({
  name: "island: shows loading placeholder while module loads",
  sanitizeOps: false,
  sanitizeResources: false,
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
    cleanup();
  },
});
