// A `.tsx` edit patches the root instead of reloading the document.
//
// aio starts from a better position than anyone: cell state lives on the
// server and already survives a reload, so what a reload costs is usually
// small — `useLocal`, scroll, focus, stateful DOM. But "small" included an
// embedded `<webview>` with its logged-in session (report 5 §8.3), 760 MB of
// loaded GPU weights (report 7 §8.2) and a wallet's unlock (report 1 §22.4).
//
// The mechanism is one line — `RootState.App` is the component a root renders
// — and the whole difficulty is knowing WHEN it is safe. Re-importing a module
// gives a fresh copy, and every module that imported the OLD one still holds
// it; that is harmless for the UI ENTRY (nothing in the client graph imports
// it) and wrong for anything else. A hot reload that silently does not apply
// an edit to a child module is worse than a reload that always works, so the
// condition is "one changed file, and it is the entry".
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { swapRootComponent } from "../src/air/hot-swap.ts";
import { testComponent } from "../src/testing/test-component.ts";
import { FRAME_KINDS } from "../src/protocol/envelope.ts";

// deno-lint-ignore no-explicit-any
type D = any;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** The container boot mounts the entry into: `<div id="root">`. */
const entryRoot = (doc: Document) => {
  const el = doc.createElement("div");
  el.id = "root";
  doc.body.appendChild(el);
  return el;
};

Deno.test("swapping the root renders the NEW component", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  try {
    const Before = () => h("div", { id: "r" }, h("span", { id: "v" }, "old"));
    const t = testComponent(Before, { document: doc, root: entryRoot(doc) });
    assertEquals((doc as D).querySelector("#v").textContent, "old");

    const After = () => h("div", { id: "r" }, h("span", { id: "v" }, "new"));
    assertEquals(swapRootComponent(After), 1, "one live root was swapped");
    await tick();
    assertEquals((doc as D).querySelector("#v").textContent, "new");
    t.unmount();
  } finally {
    await closeWindow(win);
  }
});

Deno.test("a STATEFUL node survives the swap — this is the whole point", async () => {
  // AIR's diff patches the DOM rather than replacing it, so a node the browser
  // owns state for (a `<webview>`'s session, a `<video>`'s buffer, focus,
  // scroll) is the SAME element afterwards. A reload cannot do that.
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  try {
    const Before = () =>
      h("div", { id: "r" }, h("video", { id: "keep" }), h("b", null, "old"));
    const t = testComponent(Before, { document: doc, root: entryRoot(doc) });
    const node = (doc as D).querySelector("#keep");
    assert(node, "precondition");
    // Something only the live element carries — the analogue of a login.
    (node as D)._session = "signed-in";

    const After = () =>
      h("div", { id: "r" }, h("video", { id: "keep" }), h("b", null, "new"));
    swapRootComponent(After);
    await tick();

    const same = (doc as D).querySelector("#keep");
    assert(same === node, "the element was REPLACED, so its state is gone");
    assertEquals((same as D)._session, "signed-in");
    assertEquals((doc as D).querySelector("b").textContent, "new");
    t.unmount();
  } finally {
    await closeWindow(win);
  }
});

Deno.test("a SECOND root on the page keeps its own component", async () => {
  // Only the entry's root renders the entry. A page may mount another root —
  // a widget, a toast host, an island — and swapping the entry into EVERY
  // live root rendered the whole app inside that one on the next save.
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  try {
    const Before = () => h("div", null, h("b", { id: "v" }, "old"));
    const Widget = () => h("i", { id: "w" }, "widget");
    const app = testComponent(Before, { document: doc, root: entryRoot(doc) });
    const widget = testComponent(Widget, { document: doc });
    const After = () => h("div", null, h("b", { id: "v" }, "new"));
    assertEquals(swapRootComponent(After), 1, "only the entry's root");
    await tick();
    assertEquals((doc as D).querySelector("#v").textContent, "new");
    assertEquals((doc as D).querySelectorAll("#v").length, 1);
    assertEquals((doc as D).querySelector("#w").textContent, "widget");
    // And again: the root that now renders After is the one Again replaces.
    const Again = () => h("div", null, h("b", { id: "v" }, "again"));
    assertEquals(swapRootComponent(Again), 1);
    await tick();
    assertEquals((doc as D).querySelector("#v").textContent, "again");
    assertEquals((doc as D).querySelector("#w").textContent, "widget");
    widget.unmount();
    app.unmount();
  } finally {
    await closeWindow(win);
  }
});

Deno.test("a toast host mounted BEFORE the entry keeps its own component", async () => {
  // Boot mounts the entry late — after `_waitForState` — so a module-level
  // `mount(toastHost, Toaster)` is the FIRST live root. Anchoring on "the
  // first root" put the new app inside the toast host while the real app kept
  // the old code, silently.
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  try {
    const Toaster = () => h("i", { id: "w" }, "toast");
    const toast = testComponent(Toaster, { document: doc });
    const app = testComponent(() => h("b", { id: "v" }, "old"), {
      document: doc,
      root: entryRoot(doc),
    });
    assertEquals(swapRootComponent(() => h("b", { id: "v" }, "new")), 1);
    await tick();
    assertEquals((doc as D).querySelector("#v").textContent, "new");
    assertEquals((doc as D).querySelectorAll("#v").length, 1);
    assertEquals((doc as D).querySelector("#w").textContent, "toast");
    app.unmount();
    toast.unmount();
  } finally {
    await closeWindow(win);
  }
});

Deno.test("a REMOUNTED entry is still the one swapped", async () => {
  // Unmount + mount again puts the entry's root AFTER any other live root.
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  try {
    const root = entryRoot(doc);
    const first = testComponent(() => h("b", { id: "v" }, "old"), {
      document: doc,
      root,
    });
    const widget = testComponent(() => h("i", { id: "w" }, "widget"), {
      document: doc,
    });
    first.unmount();
    const again = testComponent(() => h("b", { id: "v" }, "old"), {
      document: doc,
      root,
    });
    assertEquals(swapRootComponent(() => h("b", { id: "v" }, "new")), 1);
    await tick();
    assertEquals((doc as D).querySelector("#v").textContent, "new");
    assertEquals((doc as D).querySelector("#w").textContent, "widget");
    again.unmount();
    widget.unmount();
  } finally {
    await closeWindow(win);
  }
});

Deno.test("no live root is ZERO, not a silent success", () => {
  // The caller falls back to a reload on zero. Reporting success for a page
  // with nothing mounted would leave it showing the old code forever.
  assertEquals(swapRootComponent(() => h("div", null)), 0);
});

Deno.test("`patch` is a real wire kind, and `reload` still is", () => {
  // An unknown frame kind is dropped, so a client and server that disagree
  // about this would simply stop hot-reloading, quietly.
  assert(
    FRAME_KINDS.includes("patch" as never),
    "the kind must be on the wire list",
  );
  assert(
    FRAME_KINDS.includes("reload" as never),
    "…and the fallback is untouched",
  );
});
