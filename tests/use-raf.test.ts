// AIO-392: useRaf — managed requestAnimationFrame loop with auto-cleanup.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/aio-renderer.ts";
import { useRaf } from "../src/raf.ts";

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
