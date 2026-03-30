import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  setDevMode,
} from "../src/aio-renderer.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.close() };
}

Deno.test({
  name: "dev-mode: warns on img without alt",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    setDevMode(true);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };

    try {
      function App() {
        return h("img", { src: "test.png" });
      }
      const handle = mount(root, App);
      assertEquals(warnings.some((w) => w.includes("alt")), true);
      _unmount(handle);
    } finally {
      console.warn = origWarn;
      setDevMode(false);
      cleanup();
    }
  },
});

Deno.test({
  name: "dev-mode: no warning when img has alt",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    setDevMode(true);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };

    try {
      function App() {
        return h("img", { src: "test.png", alt: "A test image" });
      }
      const handle = mount(root, App);
      assertEquals(warnings.some((w) => w.includes("alt")), false);
      _unmount(handle);
    } finally {
      console.warn = origWarn;
      setDevMode(false);
      cleanup();
    }
  },
});

Deno.test({
  name: "dev-mode: warns on onClick without keyboard handler",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    setDevMode(true);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };

    try {
      function App() {
        return h("div", { onClick: () => {} }, "click me");
      }
      const handle = mount(root, App);
      assertEquals(warnings.some((w) => w.includes("keyboard")), true);
      _unmount(handle);
    } finally {
      console.warn = origWarn;
      setDevMode(false);
      cleanup();
    }
  },
});

Deno.test({
  name: "dev-mode: no keyboard warning on button with onClick",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    setDevMode(true);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };

    try {
      function App() {
        return h("button", { onClick: () => {} }, "click me");
      }
      const handle = mount(root, App);
      assertEquals(warnings.some((w) => w.includes("keyboard")), false);
      _unmount(handle);
    } finally {
      console.warn = origWarn;
      setDevMode(false);
      cleanup();
    }
  },
});

Deno.test({
  name: "dev-mode: warns on input without label",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    setDevMode(true);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };

    try {
      function App() {
        return h("input", { type: "text" });
      }
      const handle = mount(root, App);
      assertEquals(warnings.some((w) => w.includes("label")), true);
      _unmount(handle);
    } finally {
      console.warn = origWarn;
      setDevMode(false);
      cleanup();
    }
  },
});

Deno.test({
  name: "dev-mode: no label warning with aria-label",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    setDevMode(true);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };

    try {
      function App() {
        return h("input", { type: "text", "aria-label": "Search" });
      }
      const handle = mount(root, App);
      assertEquals(warnings.some((w) => w.includes("label")), false);
      _unmount(handle);
    } finally {
      console.warn = origWarn;
      setDevMode(false);
      cleanup();
    }
  },
});

Deno.test({
  name: "dev-mode: no warnings when devMode is off",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    setDevMode(false);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };

    try {
      function App() {
        return h("img", { src: "test.png" });
      }
      const handle = mount(root, App);
      assertEquals(warnings.filter((w) => w.includes("[aio-dev]")).length, 0);
      _unmount(handle);
    } finally {
      console.warn = origWarn;
      cleanup();
    }
  },
});
