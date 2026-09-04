import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/state/signal.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import type { MountHandle } from "../src/air/aio-renderer.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.happyDOM.close() };
}

Deno.test({
  name: "actions: use prop calls action with DOM element on mount",
  async fn() {
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
    await cleanup();
  },
});

Deno.test({
  name: "actions: cleanup runs on unmount",
  async fn() {
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
    await cleanup();
  },
});

Deno.test({
  name: "actions: multiple actions on same element",
  async fn() {
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
    await cleanup();
  },
});

Deno.test({
  name: "actions: action with no cleanup is fine",
  async fn() {
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
    await cleanup();
  },
});

Deno.test({
  name: "actions: use prop change cleans up old and applies new",
  async fn() {
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
    await cleanup();
  },
});

Deno.test({
  name: "actions: use prop skipped for non-array values",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);

    function App() {
      // deno-lint-ignore no-explicit-any
      return h("div", { use: "invalid" as any }, "hello");
    }

    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<div>hello</div>");
    _unmount(handle);
    await cleanup();
  },
});

// ── The documented shapes (docs/ui/air-advanced.md) ────────────────────────
//
// `use={fn}`, `use={[fn, value]}` → `fn(el, value)`, and "return a cleanup
// function" are the three forms the docs show. The runner honoured none of
// them: a bare function was dropped in silence (the doc's own `<input
// use={autoFocus}>` focused nothing), the value never reached the action, and
// a returned FUNCTION was ignored — only `{ cleanup }` ran. Each was a
// directive that "simply does nothing", with no warning anywhere.
Deno.test({
  name: "actions: a bare function is an action — use={fn}",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    let receivedNode: HTMLElement | null = null;
    function autoFocus(node: HTMLElement) {
      receivedNode = node;
    }
    function App() {
      return h("input", { use: autoFocus, "aria-label": "x" });
    }
    const handle = mount(root, App);
    assertEquals(receivedNode !== null, true, "the bare action ran");
    assertEquals(receivedNode!.tagName, "INPUT");
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name:
    "actions: [fn, value] calls fn(el, value); values bind to the action before them",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const calls: string[] = [];
    function tooltip(_el: HTMLElement, text: string) {
      calls.push(`tooltip:${text}`);
    }
    function badge(_el: HTMLElement, n: number, unit: string) {
      calls.push(`badge:${n}${unit}`);
    }
    function App() {
      return h("button", {
        use: [tooltip, "Click me!", badge, 3, "px"],
      }, "b");
    }
    const handle = mount(root, App);
    assertEquals(calls, ["tooltip:Click me!", "badge:3px"]);
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "actions: a returned FUNCTION is the cleanup, as the docs say",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    let cleaned = 0;
    function listen(_el: HTMLElement) {
      return () => {
        cleaned++;
      };
    }
    const show = signal(true);
    function App() {
      return show.value ? h("div", { use: [listen] }, "hello") : null;
    }
    const handle = mount(root, App);
    assertEquals(cleaned, 0);
    show.set(false);
    handle._flush();
    assertEquals(cleaned, 1, "the returned function ran on unmount");
    _unmount(handle);
    await cleanup();
  },
});

// `use={[fn]}` is a NEW array on every render. Compared by identity, the diff
// tore the actions down and ran them again on every re-render of the
// component that wrote them — `use={[initEditor]}` rebuilt its editor on each
// keystroke of an unrelated field in the same component, and the "cleanup on
// unmount" the docs promise ran on every update instead. Same functions, same
// arguments: same actions.
Deno.test({
  name:
    "actions: an inline array with the same actions does not re-run on re-render",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const calls: string[] = [];
    function initEditor(_el: HTMLElement, mode: string) {
      calls.push(`init:${mode}`);
      return { cleanup: () => calls.push(`destroy:${mode}`) };
    }
    const gen = signal(0);
    const mode = signal("md");
    function App() {
      return h(
        "div",
        null,
        h("span", null, `g:${gen.value}`),
        // Fresh array literal every render — the shape every app writes.
        h("textarea", { use: [initEditor, mode.value], "aria-label": "e" }),
      );
    }
    const handle = mount(root, App);
    assertEquals(calls, ["init:md"]);

    gen.set(1); // an unrelated re-render of the same component
    handle._flush();
    assertEquals(
      calls,
      ["init:md"],
      "same action, same argument — the editor must NOT be rebuilt",
    );

    mode.set("html"); // a changed ARGUMENT is a different action: re-run
    handle._flush();
    assertEquals(calls, ["init:md", "destroy:md", "init:html"]);

    _unmount(handle);
    assertEquals(calls, ["init:md", "destroy:md", "init:html", "destroy:html"]);
    await cleanup();
  },
});
