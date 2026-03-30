import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/signal.ts";
import { h } from "../src/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/aio-renderer.ts";
import type { MountHandle } from "../src/aio-renderer.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.close() };
}

Deno.test({
  name: "actions: use prop calls action with DOM element on mount",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    let receivedNode: HTMLElement | null = null;

    function myAction(node: HTMLElement) {
      receivedNode = node;
    }

    function App() {
      return h("div", { use: [myAction] }, "hello");
    }

    const handle = mount(root, App);
    assertEquals(receivedNode !== null, true);
    assertEquals(receivedNode!.tagName, "DIV");
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "actions: cleanup runs on unmount",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    let cleanedUp = false;

    function myAction(_node: HTMLElement) {
      return {
        cleanup() {
          cleanedUp = true;
        },
      };
    }

    const show = signal(true);
    function App() {
      return show.value ? h("div", { use: [myAction] }, "hello") : null;
    }

    const handle = mount(root, App);
    assertEquals(cleanedUp, false);

    show.set(false);
    handle._flush();
    assertEquals(cleanedUp, true);

    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "actions: multiple actions on same element",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const calls: string[] = [];

    function actionA(_node: HTMLElement) {
      calls.push("a-mount");
      return {
        cleanup() {
          calls.push("a-cleanup");
        },
      };
    }
    function actionB(_node: HTMLElement) {
      calls.push("b-mount");
      return {
        cleanup() {
          calls.push("b-cleanup");
        },
      };
    }

    const show = signal(true);
    function App() {
      return show.value ? h("div", { use: [actionA, actionB] }, "hello") : null;
    }

    const handle = mount(root, App);
    assertEquals(calls, ["a-mount", "b-mount"]);

    show.set(false);
    handle._flush();
    assertEquals(calls, ["a-mount", "b-mount", "a-cleanup", "b-cleanup"]);

    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "actions: action with no cleanup is fine",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    let called = false;

    function myAction(_node: HTMLElement) {
      called = true;
    }

    function App() {
      return h("div", { use: [myAction] }, "hello");
    }

    const handle = mount(root, App);
    assertEquals(called, true);
    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "actions: use prop change cleans up old and applies new",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const calls: string[] = [];

    function actionA(_node: HTMLElement) {
      calls.push("a-mount");
      return {
        cleanup() {
          calls.push("a-cleanup");
        },
      };
    }
    function actionB(_node: HTMLElement) {
      calls.push("b-mount");
      return {
        cleanup() {
          calls.push("b-cleanup");
        },
      };
    }

    const which = signal<"a" | "b">("a");
    function App() {
      return h(
        "div",
        { use: which.value === "a" ? [actionA] : [actionB] },
        "hello",
      );
    }

    const handle = mount(root, App);
    assertEquals(calls, ["a-mount"]);

    which.set("b");
    handle._flush();
    assertEquals(calls, ["a-mount", "a-cleanup", "b-mount"]);

    _unmount(handle);
    cleanup();
  },
});

Deno.test({
  name: "actions: use prop skipped for non-array values",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);

    function App() {
      // deno-lint-ignore no-explicit-any
      return h("div", { use: "invalid" as any }, "hello");
    }

    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<div>hello</div>");
    _unmount(handle);
    cleanup();
  },
});
