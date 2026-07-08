import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, mount, setDevMode } from "../src/air/aio-renderer.ts";

// happy-dom timers drained via win.happyDOM.close() — sanitizers re-enabled

function setup() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  setDevMode(true);
  return {
    win,
    doc,
    root,
    cleanup: () => {
      setDevMode(false);
      return win.happyDOM.close();
    },
  };
}

function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return warnings;
}

Deno.test({
  name: "a11y: warns on img without alt",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("img", { src: "test.png" }));
    });
    assertEquals(
      warnings.some((w) => w.includes("missing") && w.includes("alt")),
      true,
    );
    await cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on img with alt",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("img", { src: "test.png", alt: "A photo" }));
    });
    assertEquals(warnings.some((w) => w.includes("alt")), false);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on img with empty alt (decorative)",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("img", { src: "test.png", alt: "" }));
    });
    assertEquals(warnings.some((w) => w.includes("alt")), false);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: warns on onClick without keyboard handler on div",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("div", { onClick: () => {} }, "click me"));
    });
    assertEquals(warnings.some((w) => w.includes("keyboard")), true);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on button with onClick (interactive element)",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("button", { onClick: () => {} }, "click"));
    });
    assertEquals(warnings.some((w) => w.includes("keyboard")), false);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on div with onClick + onKeyDown",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(
        root,
        () => h("div", { onClick: () => {}, onKeyDown: () => {} }, "ok"),
      );
    });
    assertEquals(warnings.some((w) => w.includes("keyboard")), false);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: warns on input without label association",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("input", { type: "text" }));
    });
    assertEquals(warnings.some((w) => w.includes("label")), true);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on input with aria-label",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("input", { type: "text", "aria-label": "Name" }));
    });
    assertEquals(warnings.some((w) => w.includes("label")), false);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on input with id",
  async fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("input", { type: "text", id: "name-field" }));
    });
    assertEquals(warnings.some((w) => w.includes("label")), false);
    await cleanup();
  },
});

Deno.test({
  name: "a11y: no warnings when dev mode disabled",
  async fn() {
    const { root, cleanup } = setup();
    setDevMode(false);
    const warnings = captureWarnings(() => {
      mount(root, () => h("img", { src: "test.png" }));
    });
    assertEquals(warnings.length, 0);
    await cleanup();
  },
});
