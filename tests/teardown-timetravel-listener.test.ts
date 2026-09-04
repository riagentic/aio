// A torn-down client must leave nothing on `document`.
//
// The time-travel panel adds a `keydown` listener to `document` the first time
// a `tt-state` frame arrives, and puts a node in the DOM. `resetTT` removes
// both — and nothing called it. Its doc comment said "called from browser.ts
// _reset() and teardown": `browser.ts` has not existed since the alpha52
// decomposition, and the one import of it, in `browser-protocol.ts`, was
// spelled `resetTT as _resetTT` — the exact alias that silences the
// unused-import lint. Type-checked, linted, documented, and dead: one leaked
// document listener and one orphaned node per teardown, in every Electron
// route change and every re-mount.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  getTTState,
  handleTTMessage,
  resetTT,
} from "../src/air/time-travel-panel.ts";
import { _teardownNow } from "../src/browser/protocol-subscription.ts";
import "../src/browser/browser-air-transport.ts"; // installs the teardown fn

Deno.test("client teardown removes the time-travel panel's document listener", async () => {
  const win = new Window({ url: "https://localhost" });
  const g = globalThis as Record<string, unknown>;
  const prevDoc = g.document, prevWin = g.window;
  g.document = win.document;
  g.window = win;
  // Count what lands on `document`, since happy-dom exposes no listener list.
  const doc = win.document as unknown as {
    addEventListener: (t: string, f: unknown) => void;
    removeEventListener: (t: string, f: unknown) => void;
  };
  const added: unknown[] = [];
  const realAdd = doc.addEventListener.bind(doc);
  const realRemove = doc.removeEventListener.bind(doc);
  doc.addEventListener = (t: string, f: unknown) => {
    if (t === "keydown") added.push(f);
    realAdd(t, f);
  };
  const removed: unknown[] = [];
  doc.removeEventListener = (t: string, f: unknown) => {
    if (t === "keydown") removed.push(f);
    realRemove(t, f);
  };

  try {
    resetTT(); // a clean slate, whatever an earlier test left
    added.length = 0;
    removed.length = 0;

    handleTTMessage({ entries: [], index: 0, paused: false });
    assertEquals(added.length, 1, "the panel binds Ctrl+. on the document");
    assert(getTTState() !== null);

    _teardownNow(); // the ONE path a client goes away through

    assertEquals(
      removed.length,
      1,
      "teardown must take the keydown listener with it",
    );
    assertEquals(removed[0], added[0], "and it must be THAT listener");
    assertEquals(getTTState(), null, "…and forget the state it was showing");
  } finally {
    resetTT();
    doc.addEventListener = realAdd;
    doc.removeEventListener = realRemove;
    g.document = prevDoc;
    g.window = prevWin;
    await closeWindow(win);
  }
});

Deno.test("teardown after the document is already gone does not throw", async () => {
  // The teardown runs from a 300 ms grace TIMER, so the document can be
  // replaced or removed between the arming and the firing — a window closing,
  // an Electron re-mount, a test tearing its DOM down first. A bare `document`
  // reference threw a ReferenceError out of that timer callback, which is an
  // uncaught error nothing can catch (it failed a whole test FILE that never
  // touched time travel). Dropping our own handle is the half that matters:
  // a listener on a document nobody holds any more keeps nothing alive.
  const win = new Window({ url: "https://localhost" });
  const g = globalThis as Record<string, unknown>;
  const prevDoc = g.document, prevWin = g.window;
  g.document = win.document;
  g.window = win;
  try {
    handleTTMessage({ entries: [], index: 0, paused: false }); // binds keydown
    g.document = prevDoc; // …and now the document is gone
    g.window = prevWin;
    _teardownNow(); // must not throw
    assertEquals(getTTState(), null);
  } finally {
    g.document = prevDoc;
    g.window = prevWin;
    resetTT();
    await closeWindow(win);
  }
});
