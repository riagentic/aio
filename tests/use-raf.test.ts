// AIO-392: useRaf — managed requestAnimationFrame loop with auto-cleanup.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { useInterval, useRaf } from "../src/air/raf.ts";
import { assert } from "@std/assert";

function createDOM() {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { document: doc, root, cleanup: () => win.happyDOM.close() };
}

// Controllable rAF queue
function installFakeRaf() {
  const cbs = new Map<number, FrameRequestCallback>();
  let next = 1;
  const g = globalThis as Record<string, unknown>;
  const prevReq = g.requestAnimationFrame;
  const prevCancel = g.cancelAnimationFrame;
  g.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = next++;
    cbs.set(id, cb);
    return id;
  };
  g.cancelAnimationFrame = (id: number) => cbs.delete(id);
  return {
    tick(t: number) {
      // Fire exactly the frames queued right now (loop re-queues for next tick)
      const due = [...cbs.entries()];
      cbs.clear();
      for (const [, cb] of due) cb(t);
    },
    pending: () => cbs.size,
    restore() {
      g.requestAnimationFrame = prevReq;
      g.cancelAnimationFrame = prevCancel;
    },
  };
}

Deno.test({
  name: "useRaf: runs each frame and stops after unmount",
  async fn() {
    const raf = installFakeRaf();
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    const frames: number[] = [];
    const App = () => {
      useRaf((_t, dt) => frames.push(dt));
      return h("canvas", null);
    };
    const handle = mount(root, App);

    raf.tick(0); // first frame: delta 0
    raf.tick(16); // delta 16
    raf.tick(32); // delta 16
    assertEquals(frames, [0, 16, 16]);

    _unmount(handle);
    const before = frames.length;
    raf.tick(48); // no callback should remain after cleanup
    assertEquals(frames.length, before);
    assertEquals(raf.pending(), 0);

    raf.restore();
    await cleanup();
  },
});

Deno.test({
  name: "useRaf: active=false never starts the loop",
  async fn() {
    const raf = installFakeRaf();
    const { document, root, cleanup } = createDOM();
    _setDocument(document);

    let ran = false;
    const App = () => {
      useRaf(() => (ran = true), false);
      return h("div", null);
    };
    const handle = mount(root, App);
    raf.tick(0);
    assertEquals(ran, false);
    assertEquals(raf.pending(), 0);

    _unmount(handle);
    raf.restore();
    await cleanup();
  },
});

// ── A self-rescheduling loop must survive a throwing frame ────────────────
//
// `useRaf` called the user's callback and scheduled the NEXT frame on the line
// after it. One throw and that line never ran: the component stayed mounted,
// `active` stayed true, `onCleanup` never fired, and the animation stopped —
// permanently — behind one console line that reads like a transient error. A
// canvas game, a sequencer or a chart that stops redrawing after a single bad
// frame is the silent-broken-UI class, reachable from one typo in a draw call.
//
// The loop re-arms BEFORE calling the callback now, and the throw is contained
// and named the way every other user callback in the render pipeline is.
Deno.test({
  name: "useRaf: a throwing frame does not end the loop",
  async fn() {
    const raf = installFakeRaf();
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const realError = console.error;
    const errs: string[] = [];
    console.error = (...a: unknown[]) => errs.push(String(a[0]));

    let calls = 0;
    const App = () => {
      useRaf(() => {
        calls++;
        throw new Error("bad draw");
      });
      return h("canvas", null);
    };
    const handle = mount(root, App);
    try {
      raf.tick(0);
      raf.tick(16);
      raf.tick(32);
      assertEquals(
        calls,
        3,
        `the loop must keep running after a throwing frame — it stopped at frame ${calls}`,
      );
      assert(raf.pending() > 0, "a frame must still be scheduled");
      assert(
        errs.some((e) => e.includes("useRaf")),
        `the throw must be reported loudly and NAMED: ${JSON.stringify(errs)}`,
      );
      // …and still stoppable: containing the error must not have made the
      // loop immortal.
      _unmount(handle);
      const before = calls;
      raf.tick(48);
      assertEquals(calls, before, "unmount still stops it");
      assertEquals(raf.pending(), 0);
    } finally {
      console.error = realError;
      raf.restore();
      await cleanup();
    }
  },
});

// Loud is not the same as unreadable. At 60 Hz a report-every-frame policy
// writes 60 stack traces a second, and a console nobody can read is as silent
// as no console at all.
Deno.test({
  name: "useRaf: a burst of identical throws reports once, not once per frame",
  async fn() {
    const raf = installFakeRaf();
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const realError = console.error;
    const errs: string[] = [];
    console.error = (...a: unknown[]) => errs.push(String(a[0]));

    const App = () => {
      useRaf(() => {
        throw new Error("bad draw");
      });
      return h("canvas", null);
    };
    const handle = mount(root, App);
    try {
      for (let i = 0; i < 60; i++) raf.tick(i * 16);
      assertEquals(
        errs.length,
        1,
        `expected ONE report for a burst of identical throws, got ${errs.length}`,
      );
    } finally {
      console.error = realError;
      _unmount(handle);
      raf.restore();
      await cleanup();
    }
  },
});

// `setInterval` cannot die the way the rAF loop could — the platform re-arms
// it — but an uncaught throw was a bare trace with no hook name, once per ms.
Deno.test({
  name: "useInterval: a throwing tick is named, and the timer survives",
  async fn() {
    const { document, root, cleanup } = createDOM();
    _setDocument(document);
    const realError = console.error;
    const errs: string[] = [];
    console.error = (...a: unknown[]) => errs.push(String(a[0]));

    let calls = 0;
    const App = () => {
      useInterval(() => {
        calls++;
        throw new Error("bad tick");
      }, 1);
      return h("div", null);
    };
    const handle = mount(root, App);
    try {
      await new Promise((r) => setTimeout(r, 40));
      assert(calls >= 2, `the timer must keep ticking — got ${calls} call(s)`);
      assert(
        errs.some((e) => e.includes("useInterval")),
        `the throw must be named: ${JSON.stringify(errs)}`,
      );
    } finally {
      console.error = realError;
      _unmount(handle);
      await cleanup();
    }
  },
});
