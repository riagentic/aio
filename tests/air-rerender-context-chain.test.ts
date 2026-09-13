// A child MOUNTED by a component's own signal-triggered re-render must see the
// Providers above that component. The ancestor chain was pushed for the body and
// popped BEFORE the diff, so a child created inside `_diff` walked a stack that
// held only the re-rendering instance and read the context DEFAULT — a themed
// panel opened by a toggle rendered "light" under a "dark" Provider, and a
// nested <Route> read basePath "" and never matched again.

import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  createContext,
  mount,
  useContext,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

Deno.test("context: a child mounted by a self re-render reads the ancestor Provider", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  try {
    const show = signal(false);
    const Ctx = createContext("DEFAULT");
    const Reader = () => h("b", null, "ctx=" + useContext(Ctx));
    // Toggler is the component that re-renders; Reader is new in that diff.
    const Toggler = () => h("i", null, show.value ? h(Reader, null) : "hidden");
    const App = () =>
      h(
        "div",
        null,
        h(Ctx.Provider as ComponentFn, { value: "PROVIDED" }, h(Toggler, null)),
      );
    const r = doc.createElement("div");
    doc.body.appendChild(r);
    const hd = mount(r, App);
    show.set(true);
    hd._flush();
    assertEquals(r.querySelector("b")?.textContent, "ctx=PROVIDED");
    // …and the stack is balanced afterwards: a second toggle behaves the same.
    show.set(false);
    hd._flush();
    show.set(true);
    hd._flush();
    assertEquals(r.querySelector("b")?.textContent, "ctx=PROVIDED");
    _unmount(hd);
  } finally {
    await closeWindow(win);
  }
});
