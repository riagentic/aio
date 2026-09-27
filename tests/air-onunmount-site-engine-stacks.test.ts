// The dev onUnmount slot-swap detector names the CALLER's frame from
// `new Error().stack`. It picked `split("\n")[2]`, which assumes V8's "Error"
// header line; SpiderMonkey and JavaScriptCore have no header, so index 2 was
// the caller's CALLER (the renderer, a different line on every re-render path)
// and every re-rendering component that called onUnmount logged a false
// "took another onUnmount()'s slot". An unrecognised stack must stay silent.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { onUnmount } from "../src/air/renderer-lifecycle.ts";
import { signal } from "../src/state/signal.ts";

type Shape = "v8" | "firefox" | "none";

/** V8's stack re-spelled as another engine would: no header line, and
 *  `name@location` frames. `none` is a shape nobody recognises. */
const reshape = (shape: Shape, s: string): string =>
  shape === "none" ? "" : shape === "v8" ? s : s.split("\n").slice(1)
    .map((l) => l.replace(/^\s*at (?:(\S+) \()?(.*?)\)?$/, "$1@$2"))
    .join("\n");

async function run(
  shape: Shape,
  swap: boolean,
): Promise<number> {
  const win = new Window();
  _setDocument(win.document as unknown as Document);
  setDevMode(true);
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  const RealError = globalThis.Error;
  globalThis.Error = class extends RealError {
    constructor(m?: string) {
      super(m);
      Object.defineProperty(this, "stack", {
        value: reshape(shape, this.stack ?? ""),
      });
    }
  } as ErrorConstructor;
  try {
    const n = signal(0);
    const C = () => {
      if (swap && n.value % 2) onUnmount(() => {});
      else onUnmount(() => {});
      return h("div", null, String(n.value));
    };
    const root = win.document.createElement("div");
    win.document.body.appendChild(root);
    const hd = mount(root as unknown as Element, C);
    hd._flush();
    n.set(1);
    hd._flush();
    n.set(2);
    hd._flush();
    _unmount(hd);
  } finally {
    globalThis.Error = RealError;
    console.error = origErr;
    await closeWindow(win);
  }
  return errs.filter((e) => e.includes("took another onUnmount")).length;
}

for (const shape of ["v8", "firefox", "none"] as const) {
  Deno.test(`onUnmount site (${shape} stack): a plain re-render is silent`, async () => {
    assertEquals(await run(shape, false), 0);
  });
}

for (const shape of ["v8", "firefox"] as const) {
  Deno.test(`onUnmount site (${shape} stack): a real slot swap is named`, async () => {
    assertEquals(await run(shape, true) > 0, true);
  });
}
