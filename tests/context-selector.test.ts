import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { signal } from "../src/signal.ts";
import { h } from "../src/vdom.ts";
import {
  _setDocument,
  _unmount,
  createContext,
  mount,
  useContextSelector,
} from "../src/aio-renderer.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.happyDOM.close() };
}

Deno.test({
  name: "useContextSelector: reads selected value from context",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const Ctx = createContext({ theme: "dark", lang: "en" });

    function Child() {
      const theme = useContextSelector(Ctx, (v) => v.theme);
      return h("span", null, theme);
    }

    function App() {
      return h(
        Ctx.Provider,
        { value: { theme: "light", lang: "en" } },
        h(Child, null),
      );
    }

    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<span>light</span>");
    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "useContextSelector: only re-renders when selected slice changes",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const ctxValue = signal({ theme: "dark", lang: "en" });
    const Ctx = createContext({ theme: "dark", lang: "en" });

    function Child() {
      const theme = useContextSelector(Ctx, (v) => v.theme);
      return h("span", null, theme);
    }

    function App() {
      return h(Ctx.Provider, { value: ctxValue.value }, h(Child, null));
    }

    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<span>dark</span>");

    // Change lang only — DOM should still show "dark"
    ctxValue.set({ theme: "dark", lang: "fr" });
    handle._flush();
    assertEquals(root.innerHTML, "<span>dark</span>");

    // Change theme — should update
    ctxValue.set({ theme: "light", lang: "fr" });
    handle._flush();
    assertEquals(root.innerHTML, "<span>light</span>");

    _unmount(handle);
    await cleanup();
  },
});

Deno.test({
  name: "useContextSelector: falls back to default when no provider",
  async fn() {
    const { document: doc, root, cleanup } = createDOM();
    _setDocument(doc);
    const Ctx = createContext({ theme: "dark", lang: "en" });

    function Child() {
      const theme = useContextSelector(Ctx, (v) => v.theme);
      return h("span", null, theme);
    }

    function App() {
      return h(Child, null);
    }

    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<span>dark</span>");
    _unmount(handle);
    await cleanup();
  },
});
