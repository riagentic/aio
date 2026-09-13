// `useContextSelector` promised "Component only re-renders when the selected
// value changes" and re-rendered on EVERY context change. The selected value
// came from a `computed`, and a computed invalidates its readers eagerly — the
// moment its source moves, before anyone asks whether the RESULT moved — so the
// component was queued for a re-render on a field it never selected. The DOM
// came out the same (the diff found nothing), which is why the existing test,
// which only compared innerHTML, stayed green.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { signal } from "../src/state/signal.ts";
import { h } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  createContext,
  mount,
  onMount,
  useContextSelector,
} from "../src/air/aio-renderer.ts";

Deno.test("useContextSelector: an unselected field does not re-render the reader", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  _setDocument(doc);
  const ctxValue = signal({ theme: "dark", lang: "en", n: 0 });
  const Ctx = createContext({ theme: "dark", lang: "en", n: 0 });
  let childRenders = 0;

  function Child() {
    childRenders++;
    const theme = useContextSelector(Ctx, (v) => v.theme);
    return h("span", null, theme);
  }
  function App() {
    return h(Ctx.Provider, { value: ctxValue.value }, h(Child, null));
  }

  const handle = mount(root, App);
  try {
    assertEquals(childRenders, 1);

    ctxValue.set({ theme: "dark", lang: "fr", n: 1 });
    handle._flush();
    ctxValue.set({ theme: "dark", lang: "de", n: 2 });
    handle._flush();
    assertEquals(root.innerHTML, "<span>dark</span>");
    assertEquals(childRenders, 1, "lang is not selected — no re-render");

    ctxValue.set({ theme: "light", lang: "de", n: 3 });
    handle._flush();
    assertEquals(root.innerHTML, "<span>light</span>");
    assertEquals(childRenders, 2, "theme IS selected — exactly one re-render");

    // And it keeps listening after that re-render (the per-render watcher is
    // rebuilt, not lost).
    ctxValue.set({ theme: "light", lang: "it", n: 4 });
    handle._flush();
    assertEquals(childRenders, 2);
    ctxValue.set({ theme: "sepia", lang: "it", n: 5 });
    handle._flush();
    assertEquals(root.innerHTML, "<span>sepia</span>");
    assertEquals(childRenders, 3);
  } finally {
    _unmount(handle);
    _setDocument(null as never);
    await closeWindow(win);
  }
});

Deno.test("useContextSelector: a selector that builds a fresh object renders once per change, not forever", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  _setDocument(doc);
  const ctxValue = signal({ theme: "dark", lang: "en" });
  const Ctx = createContext({ theme: "dark", lang: "en" });
  let childRenders = 0;
  function Child() {
    childRenders++;
    const sel = useContextSelector(Ctx, (v) => ({ t: v.theme }));
    return h("span", null, sel.t);
  }
  function App() {
    return h(Ctx.Provider, { value: ctxValue.value }, h(Child, null));
  }
  const handle = mount(root, App);
  try {
    handle._flush();
    assertEquals(childRenders, 1, "no self-triggered re-render at mount");
    ctxValue.set({ theme: "light", lang: "en" });
    handle._flush();
    assertEquals(root.innerHTML, "<span>light</span>");
    assertEquals(childRenders, 2);
  } finally {
    _unmount(handle);
    _setDocument(null as never);
    await closeWindow(win);
  }
});

Deno.test("useContextSelector: inside onMount it reads once and leaves no watcher behind", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  _setDocument(doc);
  const ctxValue = signal({ theme: "dark" });
  const Ctx = createContext({ theme: "dark" });
  let selectorRuns = 0;
  let seen = "";
  function Child() {
    onMount(() => {
      seen = useContextSelector(Ctx, (v) => {
        selectorRuns++;
        return v.theme;
      });
    });
    return h("span", null, "x");
  }
  function App() {
    return h(Ctx.Provider, { value: ctxValue.value }, h(Child, null));
  }
  const handle = mount(root, App);
  try {
    handle._flush();
    assertEquals(seen, "dark");
    const after = selectorRuns;
    ctxValue.set({ theme: "light" });
    handle._flush();
    assertEquals(
      selectorRuns,
      after,
      "no effect was left subscribed to the context from the mount flush",
    );
  } finally {
    _unmount(handle);
    _setDocument(null as never);
    await closeWindow(win);
  }
});
