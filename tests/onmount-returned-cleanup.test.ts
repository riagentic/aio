// A returned cleanup from `onMount` must run on unmount, and must NOT run on a
// re-render.
//
// The failure this pins is the one class of bug the framework cannot warn about
// after the fact: TypeScript lets a callback declared `() => void` return a
// value, so `onMount(() => { const t = setInterval(...); return () => clearInterval(t); })`
// compiles, reads correctly to anyone arriving from React/Solid/Svelte/Vue, and
// silently leaked. A wallet shipped it three times in three components — every
// send dialog it ever opened left another interval running for the life of the
// process, each retaining its component's entire closure — and they were found
// by eye in an audit, because there was no gate that could see them.
//
// Both halves are asserted. Running the disposer is the fix; running it only at
// UNMOUNT is what makes it safe — a disposer that fired on every re-render
// would tear down the very subscription it exists to hold open, which is a
// worse bug than the one being fixed and would look identical from the outside.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { onMount } from "../src/air/renderer-lifecycle.ts";
import { signal } from "../src/state/signal.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => closeWindow(win) };
}

Deno.test("onMount: a returned function runs as cleanup on unmount", async () => {
  const { document, root, cleanup } = createDOM();
  _setDocument(document);
  const log: string[] = [];
  const Comp = () => {
    onMount(() => {
      log.push("mount");
      return () => log.push("dispose");
    });
    return h("div", null, "x");
  };
  try {
    const handle = mount(root, Comp);
    assertEquals(log, ["mount"], "onMount ran; the disposer must not have");
    _unmount(handle);
    assertEquals(
      log,
      ["mount", "dispose"],
      "the function onMount returned was DROPPED — this is the timer leak the " +
        "type system cannot see",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("onMount: the returned cleanup does not fire on a re-render", async () => {
  const { document, root, cleanup } = createDOM();
  _setDocument(document);
  const log: string[] = [];
  const tick = signal(0);
  const Comp = () => {
    onMount(() => {
      log.push("mount");
      return () => log.push("dispose");
    });
    return h("div", null, String(tick.value));
  };
  try {
    const handle = mount(root, Comp);
    tick.set(1);
    await new Promise((r) => setTimeout(r, 3));
    tick.set(2);
    await new Promise((r) => setTimeout(r, 3));
    assertEquals(
      log,
      ["mount"],
      "a re-render must not dispose a mount-scoped resource — an interval, a " +
        "MediaStream or a socket torn down on every keystroke is worse than " +
        "the leak this feature closes",
    );
    _unmount(handle);
    assertEquals(log, ["mount", "dispose"]);
  } finally {
    await cleanup();
  }
});

Deno.test("onMount: a callback returning a non-function is still fine", async () => {
  const { document, root, cleanup } = createDOM();
  _setDocument(document);
  // The idiomatic accident: an arrow body that returns whatever its last
  // expression evaluated to. It must not be mistaken for a disposer, and it
  // must not throw at unmount.
  const log: string[] = [];
  const Comp = () => {
    onMount(() => {
      log.push("mount");
      return "not a disposer" as unknown as void;
    });
    return h("div", null, "x");
  };
  try {
    const handle = mount(root, Comp);
    await new Promise((r) => setTimeout(r, 3));
    assertEquals(log, ["mount"], "the callback ran");
    _unmount(handle);
    assertEquals(
      log,
      ["mount"],
      "a string return must not be mistaken for a disposer, and unmount must " +
        "not throw trying to call it",
    );
  } finally {
    await cleanup();
  }
});
