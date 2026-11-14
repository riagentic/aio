// <TransitionGroup flip> — two reorders inside one animation frame leave a row
// permanently translated. The second FLIP reads the first one's in-flight
// `translate(...)` as the element's "existing" transform and restores THAT in
// its rAF, after the first rAF already cleared it.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { TransitionGroup } from "../src/air/transition-group.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";
import { closeWindow } from "../src/testing/close-window.ts";

Deno.test("TransitionGroup flip: two reorders in one frame settle with no leftover transform", async () => {
  const win = new Window({ url: "https://localhost" });
  // Layout stand-in: a row's box is its index among its siblings (happy-dom
  // has no layout; a browser's answer has the same shape).
  // deno-lint-ignore no-explicit-any
  (win as any).HTMLElement.prototype.getBoundingClientRect = function (
    this: HTMLElement,
  ) {
    const i = Array.prototype.indexOf.call(
      this.parentNode?.childNodes ?? [],
      this,
    );
    return {
      left: 0,
      top: i * 20,
      width: 100,
      height: 20,
      right: 100,
      bottom: i * 20 + 20,
      x: 0,
      y: i * 20,
    };
  };
  // Frames arrive only when the test says so — two renders land in one frame.
  const frames: (() => void)[] = [];
  // deno-lint-ignore no-explicit-any
  (win as any).requestAnimationFrame = (cb: () => void) => frames.push(cb);
  _setDocument(win.document);
  const root = win.document.createElement("div");
  win.document.body.appendChild(root);
  const order = signal(["a", "b", "c"]);
  const App = () =>
    h(
      TransitionGroup,
      { flip: true, flipDuration: 10 },
      ...order.value.map((k) => h("p", { key: k, id: k }, k)),
    );
  const hd = mount(root, App);
  hd._flush();
  order.set(["c", "a", "b"]);
  hd._flush();
  order.set(["b", "c", "a"]);
  hd._flush();
  // The frame comes, then the transitions finish.
  for (const f of frames.splice(0)) f();
  await new Promise((r) => setTimeout(r, 100));
  const transforms = ["a", "b", "c"].map((k) =>
    root.querySelector("#" + k)!.getAttribute("style") ?? ""
  );
  _unmount(hd);
  await closeWindow(win);
  // At rest every row sits where layout put it: no translate left behind.
  for (const t of transforms) {
    assertEquals(/translate/.test(t), false, `left over: ${transforms}`);
  }
});
