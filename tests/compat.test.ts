import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/state/signal.ts";
import { h } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  type MountHandle,
} from "../src/air/aio-renderer.ts";
import {
  _resetHints,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "../src/air/compat.ts";

function createDOM(): {
  document: Document;
  root: HTMLElement;
  cleanup: () => void;
} {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.happyDOM.close() };
}

// ── useState ───────────────────────────────────────────────────────

Deno.test({
  name: "compat: useState returns [value, setter] tuple",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    let captured: [number, (n: number | ((p: number) => number)) => void] = [
      0,
      () => {},
    ];
    const App = () => {
      captured = useState(42);
      return h("div", null, String(captured[0]));
    };
    const handle = mount(root, App);
    assertEquals(captured[0], 42);
    assertEquals(root.innerHTML, "<div>42</div>");
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "compat: useState setter triggers re-render",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    let setter: (n: number | ((p: number) => number)) => void = () => {};
    const App = () => {
      const [val, set] = useState(0);
      setter = set;
      return h("div", null, String(val));
    };
    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<div>0</div>");
    setter(7);
    handle._flush();
    assertEquals(root.innerHTML, "<div>7</div>");
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "compat: useState setter accepts updater function",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    let setter: (n: number | ((p: number) => number)) => void = () => {};
    const App = () => {
      const [val, set] = useState(10);
      setter = set;
      return h("div", null, String(val));
    };
    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<div>10</div>");
    setter((prev) => prev + 5);
    handle._flush();
    assertEquals(root.innerHTML, "<div>15</div>");
    setter((prev) => prev * 2);
    handle._flush();
    assertEquals(root.innerHTML, "<div>30</div>");
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "compat: useState accepts lazy initializer function",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    let captured = 0;
    const App = () => {
      const [val, _] = useState(() => 42);
      captured = val;
      return h("div", null, String(val));
    };
    const handle = mount(root, App);
    assertEquals(captured, 42);
    assertEquals(root.innerHTML, "<div>42</div>");
    _unmount(handle);
    await cleanup();
  },
});

// ── useEffect ──────────────────────────────────────────────────────

Deno.test({
  name: "compat: useEffect with empty deps runs on mount",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    let mounted = false;
    const App = () => {
      useEffect(() => {
        mounted = true;
      }, []);
      return h("div", null, "test");
    };
    const handle = mount(root, App);
    assertEquals(mounted, true);
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "compat: useEffect cleanup runs on unmount",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    let cleaned = false;
    const App = () => {
      useEffect(() => {
        return () => {
          cleaned = true;
        };
      }, []);
      return h("div", null, "test");
    };
    const handle = mount(root, App);
    assertEquals(cleaned, false);
    _unmount(handle);
    assertEquals(cleaned, true);
    await cleanup();
  },
});

Deno.test({
  name: "compat: useEffect with non-empty deps — React semantics (AIO-7.1)",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const sig = signal(0);
    let effectCount = 0;
    const App = () => {
      useEffect(() => {
        const _v = sig.value; // read inside — must NOT auto-track (untracked)
        effectCount++;
      }, [sig.value]); // dep changes on re-render → re-fires once per change
      return h("div", null, String(sig.value));
    };
    const handle = mount(root, App);
    await new Promise((r) => setTimeout(r, 0)); // first run lands post-mount
    assertEquals(effectCount, 1);
    sig.set(5);
    handle._flush();
    await new Promise((r) => setTimeout(r, 0)); // re-run lands post-render
    // Deps-driven: exactly one re-run for one dep change — no auto-track
    // double-fire, no effect-recreation extra run (old AIO-182 behavior).
    assertEquals(effectCount, 2);
    _unmount(handle);
    await cleanup();
  },
});

// ── useCallback ────────────────────────────────────────────────────

Deno.test({
  name: "compat: useCallback returns function as-is",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const original = () => 123;
    let captured: (() => number) | null = null;
    const App = () => {
      captured = useCallback(original, []);
      return h("div", null, "test");
    };
    const handle = mount(root, App);
    assertEquals(captured, original);
    _unmount(handle);
    await cleanup();
  },
});

// ── useMemo ────────────────────────────────────────────────────────

Deno.test({
  name: "compat: useMemo calls fn and returns result",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    let called = 0;
    let captured = 0;
    const App = () => {
      captured = useMemo(() => {
        called++;
        return 99;
      }, []);
      return h("div", null, String(captured));
    };
    const handle = mount(root, App);
    assertEquals(called, 1);
    assertEquals(captured, 99);
    assertEquals(root.innerHTML, "<div>99</div>");
    _unmount(handle);
    await cleanup();
  },
});

// ── Dev hints ──────────────────────────────────────────────────────

Deno.test({
  name: "compat: dev hints fire once per name",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    // Enable dev mode
    (globalThis as Record<string, unknown>).__aioDev = true;
    _resetHints();

    const infos: string[] = [];
    const origInfo = console.info;
    console.info = (...args: unknown[]) => {
      infos.push(String(args[0]));
    };

    try {
      const App = () => {
        useState(0);
        useState(1); // second call — should NOT hint again
        useCallback(() => {}, []);
        useCallback(() => {}, []); // second call — no hint
        return h("div", null, "test");
      };
      const handle = mount(root, App);

      // useState hint once, useCallback hint once
      assertEquals(infos.filter((m) => m.includes("useState")).length, 1);
      assertEquals(infos.filter((m) => m.includes("useCallback")).length, 1);

      _unmount(handle);
    } finally {
      console.info = origInfo;
      (globalThis as Record<string, unknown>).__aioDev = false;
      _resetHints();
    }
    await cleanup();
  },
});
