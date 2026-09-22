// `onUnmount` — a cleanup that runs ONCE, when the component goes away.
//
// `onCleanup` in a component BODY runs on unmount AND before every re-render.
// That is correct for something the body re-creates each render, and wrong for
// anything meant to outlive one. A field report shipped the wrong one four
// times in four components: a gallery released its place in a download queue
// from the body, so 85 of 89 cards were cancelled on the next repaint and
// never asked again; a send button's three-second auto-disarm was cleared on
// every balance patch, so a safety control quietly stopped being one.
//
// Three claims are made about this function, and a test that only proved the
// first would leave the other two as prose:
//
//   1. it does NOT run on a re-render — the whole point;
//   2. it DOES run on unmount;
//   3. it is NOT `onMount(() => onCleanup(fn))`, because a render whose body
//      THROWS never reaches its onMount, so a hold released only from there is
//      leaked for good. That is the case the docstring claims this handles,
//      and the only one that justifies a second function existing.
//
// The third is the reason this file is not one test. It is also the one that
// would rot silently: the renderer could stop draining a discarded render's
// holds and claims 1 and 2 would both stay green.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { onCleanup, onUnmount, useRef } from "../src/air/renderer-lifecycle.ts";
import { signal } from "../src/state/signal.ts";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => closeWindow(win) };
}

Deno.test("onUnmount: a re-render does not release the hold", async () => {
  const { document, root, cleanup } = createDOM();
  _setDocument(document);
  const log: string[] = [];
  const tick = signal(0);
  // The gallery card, reduced: a queue slot taken once, released once.
  const Card = () => {
    onUnmount(() => log.push("release"));
    // The body-level onCleanup beside it, so the two are compared in the same
    // render rather than in two tests that could drift apart.
    onCleanup(() => log.push("per-render"));
    return h("div", null, String(tick.value));
  };
  try {
    const handle = mount(root, Card);
    tick.set(1);
    await new Promise((r) => setTimeout(r, 3));
    tick.set(2);
    await new Promise((r) => setTimeout(r, 3));

    assert(
      !log.includes("release"),
      `onUnmount fired on a re-render (${log.join(", ")}) — this is the ` +
        `85-of-89-cards bug, and it would make onUnmount a slower onCleanup`,
    );
    assert(
      log.includes("per-render"),
      "the instrument is broken: no re-render happened, so the assertion " +
        "above proved nothing. onCleanup must have fired at least once.",
    );

    _unmount(handle);
    assertEquals(
      log.filter((x) => x === "release"),
      ["release"],
      "the hold must be released exactly once, at unmount",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("onUnmount: a body that THROWS still releases its hold", async () => {
  // The claim that makes this a separate function rather than sugar for
  // `onMount(() => onCleanup(fn))`. The hold is taken on the first line; the
  // body throws on the next, so no instance is ever mounted and onMount is
  // never reached. The resource is still gone from the caller's point of view,
  // so something has to hand it back.
  const { document, root, cleanup } = createDOM();
  _setDocument(document);
  const log: string[] = [];
  const Boom = () => {
    onUnmount(() => log.push("release"));
    throw new Error("the body threw");
  };
  try {
    let threw = false;
    try {
      mount(root, Boom);
    } catch {
      threw = true;
    }
    assert(
      threw,
      "the instrument is broken: the body was supposed to throw and did not, " +
        "so the release below proves nothing about the discarded-render path",
    );
    assertEquals(
      log,
      ["release"],
      "a render whose body threw never reaches onMount — a hold released " +
        "only from there is leaked for the life of the process. onUnmount " +
        "exists precisely so this one is handed back.",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("onUnmount: outside a render it warns instead of silently doing nothing", async () => {
  // Fail loud. Called at module scope it can never fire, and a cleanup that
  // will never run must not look like one that will.
  const { cleanup } = createDOM();
  const warned: string[] = [];
  const realWarn = console.warn;
  // The warning is dev-only, exactly like onMount's and onCleanup's — an
  // observe-only difference, which is the only kind this project allows.
  setDevMode(true);
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  try {
    onUnmount(() => {});
  } finally {
    console.warn = realWarn;
    setDevMode(false);
    await cleanup();
  }
  assert(
    warned.some((w) => w.includes("onUnmount")),
    `calling onUnmount outside a render said nothing: ${
      JSON.stringify(warned)
    }`,
  );
});

Deno.test("onUnmount: the callback that runs is the LAST render's, not the first's", async () => {
  // The other half of registering once. Holding the FIRST render's closure
  // would be the same staleness bug from the opposite side: a card that
  // re-keyed to id "c" would hand back slot "a" and leak "c" for good.
  const { document, root, cleanup } = createDOM();
  _setDocument(document);
  const released: string[] = [];
  const id = signal("a");
  const Card = () => {
    const held = id.value;
    onUnmount(() => released.push(held));
    return h("div", null, held);
  };
  try {
    const handle = mount(root, Card);
    id.set("b");
    await new Promise((r) => setTimeout(r, 3));
    id.set("c");
    await new Promise((r) => setTimeout(r, 3));
    assertEquals(
      root.textContent,
      "c",
      "the instrument: no re-render happened",
    );
    _unmount(handle);
    assertEquals(
      released,
      ["c"],
      "the hold was released for the value the FIRST render captured, so the " +
        "one the component actually held at the end was never handed back",
    );
  } finally {
    await cleanup();
  }
});

// A conditional `onUnmount` lands on the neighbouring hook's slot — and the
// mechanism that makes it register once per CALL SITE rather than once per
// render is what puts it there. State slots are matched by call order, so
// `if (x) onUnmount(…)` takes whichever slot the cursor is on.
//
// MEASURED before this was named, with `onUnmount` one line above a
// `useRef`:
//
//   slot held `{n: 7}`   -> truthy, so `fn` was written onto the app's OWN
//                           object and `_onUnmount` was never called: the
//                           hold LEAKED, silently, in production — the exact
//                           bug onUnmount exists to prevent;
//   slot held `"B"`      -> TypeError: Cannot create property 'fn' on string
//                           'B', thrown from inside the renderer;
//   slot held a signal   -> it worked, by luck.
//
// The dev hook-order tripwire is no answer to this: it runs AFTER the body
// (so the TypeError beats it) and it is observe-only (so production never
// hears it). `onMount` and `onCleanup` beside it MAY be called conditionally
// and the docs say so, which is why someone writes this in the first place.
Deno.test("onUnmount: a conditional call says so instead of leaking the hold", async () => {
  const { document, root, cleanup } = createDOM();
  _setDocument(document);
  setDevMode(true);
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  const log: string[] = [];
  const tick = signal(0);
  // The shape that leaked: the slot the conditional call lands on already
  // holds the component's own object.
  const Card = () => {
    if (tick.value > 0) onUnmount(() => log.push("release"));
    const box = useRef<{ n: number } | null>(null);
    box.current ??= { n: 7 };
    return h("div", null, String(tick.value));
  };
  try {
    const handle = mount(root, Card);
    tick.set(1);
    await new Promise((r) => setTimeout(r, 5));
    _unmount(handle);
    await new Promise((r) => setTimeout(r, 5));
  } finally {
    console.error = origError;
    setDevMode(false);
    await cleanup();
  }
  const named = errors.find((e) => e.includes("onUnmount() landed on"));
  assert(
    named,
    `the mis-placed onUnmount is never named — got ${JSON.stringify(errors)}`,
  );
  assert(
    named.includes("unconditionally"),
    `the message must say what to do instead: ${named}`,
  );
  assertEquals(
    log,
    [],
    "nothing may have been registered on a slot that is not this call's",
  );
});
