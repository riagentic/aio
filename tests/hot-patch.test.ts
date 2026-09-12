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

Deno.test("swapping the root renders the NEW component", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  try {
    const Before = () => h("div", { id: "r" }, h("span", { id: "v" }, "old"));
    const t = testComponent(Before, { document: doc });
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
    const t = testComponent(Before, { document: doc });
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
