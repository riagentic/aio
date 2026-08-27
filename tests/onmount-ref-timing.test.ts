// AIO-390: onMount must run after the component's DOM subtree + refs are
// committed, so ref.current is the real node (not null) inside onMount — and
// CONNECTED, which is the half this file used to miss. It asserted `nodeName`
// only, and a node built into a detached DocumentFragment answers `nodeName`
// perfectly well: `ref.current.isConnected` was false, `focus()` was a no-op
// and `getBoundingClientRect()` returned zeros, while
// docs/ui/air-lifecycle.md promises focus and measurement work here.
import { assertEquals } from "@std/assert";
import { signal } from "../src/state/signal.ts";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { onMount, useRef } from "../src/air/renderer-lifecycle.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.happyDOM.close() };
}

Deno.test({
  name: "onMount: ref.current is committed, connected, and focusable",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    let tagInMount: string | null = null;
    let connectedInMount: boolean | null = null;
    let focusedInMount: boolean | null = null;
    const App = () => {
      const ref = useRef<HTMLElement>(null!);
      onMount(() => {
        tagInMount = ref.current ? ref.current.nodeName : null;
        connectedInMount = ref.current?.isConnected ?? null;
        (ref.current as unknown as HTMLInputElement)?.focus?.();
        focusedInMount = document.activeElement === ref.current;
      });
      return h("input", { ref, "aria-label": "x" });
    };
    const handle = mount(root, App);
    assertEquals(tagInMount, "INPUT"); // was null before AIO-390
    assertEquals(connectedInMount, true, "onMount must see a CONNECTED node");
    assertEquals(focusedInMount, true, "focus() must land inside onMount");
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "onMount: children mount before parent (bottom-up)",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const order: string[] = [];
    const Child = () => {
      onMount(() => order.push("child"));
      return h("span", null, "c");
    };
    const Parent = () => {
      onMount(() => order.push("parent"));
      return h("div", null, h(Child, null));
    };
    const handle = mount(root, Parent);
    assertEquals(order, ["child", "parent"]);
    _unmount(handle);
    await cleanup();
  },
});

// The re-render insertion path has to agree with the mount path: a component
// that appears LATER (a conditional branch, a row pushed into a list) is built
// into a fragment too, and its onMount used to fire before the insertion.
Deno.test({
  name: "onMount: a later-inserted component also sees a connected node",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const show = signal(false);
    let connected: boolean | null = null;
    let rect: { width: number } | null = null;
    const Child = () => {
      const ref = useRef<HTMLElement>(null!);
      onMount(() => {
        connected = ref.current?.isConnected ?? null;
        rect = ref.current?.getBoundingClientRect?.() ?? null;
      });
      return h("span", { ref }, "child");
    };
    const App = () => h("div", null, show.value ? h(Child, null) : null);
    const handle = mount(root, App);
    assertEquals(connected, null, "not mounted yet");
    show.set(true);
    await new Promise((r) => setTimeout(r, 5));
    handle._flush();
    assertEquals(connected, true, "onMount must see a CONNECTED node");
    assertEquals(rect !== null, true, "measurement is possible inside onMount");
    _unmount(handle);
    await cleanup();
  },
});

// onMount still runs BEFORE afterRender, and children before parents — both
// now drain from the same post-commit point.
Deno.test({
  name: "onMount runs before afterRender, children before parents",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const order: string[] = [];
    const { afterRender } = await import("../src/air/renderer-flush.ts");
    const Child = () => {
      onMount(() => order.push("mount:child"));
      afterRender(() => order.push("after:child"));
      return h("span", null, "c");
    };
    const Parent = () => {
      onMount(() => order.push("mount:parent"));
      afterRender(() => order.push("after:parent"));
      return h("div", null, h(Child, null));
    };
    const handle = mount(root, Parent);
    // onMount is bottom-up (children first); afterRender keeps its own
    // registration order (parent body runs before child body). Both drain from
    // the same post-commit point, onMount first.
    assertEquals(order, [
      "mount:child",
      "mount:parent",
      "after:parent",
      "after:child",
    ]);
    _unmount(handle);
    await cleanup();
  },
});
