import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/vdom.ts";
import { _setDocument, mount, setDevMode } from "../src/aio-renderer.ts";

const S = { sanitizeOps: false, sanitizeResources: false } as const;

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
      win.close();
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
  ...S,
  fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("img", { src: "test.png" }));
    });
    assertEquals(
      warnings.some((w) => w.includes("missing") && w.includes("alt")),
      true,
    );
    cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on img with alt",
  ...S,
  fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("img", { src: "test.png", alt: "A photo" }));
    });
    assertEquals(warnings.some((w) => w.includes("alt")), false);
    cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on img with empty alt (decorative)",
  ...S,
  fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("img", { src: "test.png", alt: "" }));
    });
    assertEquals(warnings.some((w) => w.includes("alt")), false);
    cleanup();
  },
});

Deno.test({
  name: "a11y: warns on onClick without keyboard handler on div",
  ...S,
  fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("div", { onClick: () => {} }, "click me"));
    });
    assertEquals(warnings.some((w) => w.includes("keyboard")), true);
    cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on button with onClick (interactive element)",
  ...S,
  fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("button", { onClick: () => {} }, "click"));
    });
    assertEquals(warnings.some((w) => w.includes("keyboard")), false);
    cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on div with onClick + onKeyDown",
  ...S,
  fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(
        root,
        () => h("div", { onClick: () => {}, onKeyDown: () => {} }, "ok"),
      );
    });
    assertEquals(warnings.some((w) => w.includes("keyboard")), false);
    cleanup();
  },
});

Deno.test({
  name: "a11y: warns on input without label association",
  ...S,
  fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("input", { type: "text" }));
    });
    assertEquals(warnings.some((w) => w.includes("label")), true);
    cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on input with aria-label",
  ...S,
  fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("input", { type: "text", "aria-label": "Name" }));
    });
    assertEquals(warnings.some((w) => w.includes("label")), false);
    cleanup();
  },
});

Deno.test({
  name: "a11y: no warning on input with id",
  ...S,
  fn() {
    const { root, cleanup } = setup();
    const warnings = captureWarnings(() => {
      mount(root, () => h("input", { type: "text", id: "name-field" }));
    });
    assertEquals(warnings.some((w) => w.includes("label")), false);
    cleanup();
  },
});

Deno.test({
  name: "a11y: no warnings when dev mode disabled",
  ...S,
  fn() {
    const { root, cleanup } = setup();
    setDevMode(false);
    const warnings = captureWarnings(() => {
      mount(root, () => h("img", { src: "test.png" }));
    });
    assertEquals(warnings.length, 0);
    cleanup();
  },
});
