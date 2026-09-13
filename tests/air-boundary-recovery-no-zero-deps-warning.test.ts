// A boundary that RECOVERED must not be reported as a component that lost its
// subscriptions.
//
// Field report: after an `<ErrorBoundary>` came back from its fallback, the
// dev console said
//
//   [aio-dev] EB re-rendered with 0 signal deps — component will not respond
//   to future signal changes.
//
// while the page had recovered correctly. `EB` reads no signal of its own; it
// re-rendered because the signals its failed child read were lent to it, so
// the render that brings the child back would be retried. That re-render ends
// with zero deps by design, and the warning — meant for a component whose own
// signal re-render dropped every read — was a false alarm on the one render
// that had just worked.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { ErrorBoundary, h } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

async function withWarnings(
  fn: (root: HTMLElement) => void,
): Promise<string[]> {
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  // The warning is a dev diagnostic — run as the dev server and every harness
  // does, or neither half of this file can see it.
  const g = globalThis as { __aioDev?: unknown };
  const prevDev = g.__aioDev;
  g.__aioDev = true;
  const warns: string[] = [];
  const origWarn = console.warn;
  const origErr = console.error;
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  console.error = () => {};
  try {
    fn(root);
  } finally {
    g.__aioDev = prevDev;
    console.warn = origWarn;
    console.error = origErr;
    _setDocument(null as never);
    await closeWindow(win);
  }
  return warns.filter((w) => w.includes("0 signal deps"));
}

for (const depth of [0, 1]) {
  Deno.test(`boundary recovery (thrower ${depth} deep) logs no 0-deps warning`, async () => {
    const zero = await withWarnings((root) => {
      const ready = signal(false);
      const Thrower = () => {
        if (!ready.value) throw new Error("not ready");
        return h("p", null, ["loaded"]);
      };
      const inner: ComponentFn = depth === 0
        ? Thrower as ComponentFn
        : (() => h("section", null, [h(Thrower as ComponentFn, null)]));
      const EB = () =>
        h("div", null, [
          h(ErrorBoundary, {
            fallback: (e: Error) => h("i", null, ["err:" + e.message]),
          }, [h(inner, null)]),
        ]);
      const hd = mount(root, EB as ComponentFn);
      ready.set(true);
      hd._flush();
      assertEquals(root.innerHTML.includes("loaded"), true, root.innerHTML);
      _unmount(hd);
    });
    assertEquals(zero, [], "a recovery re-render is not a lost subscription");
  });
}

Deno.test("a component whose own signal re-render reads nothing still warns", async () => {
  const zero = await withWarnings((root) => {
    const s = signal(0);
    let first = true;
    const Once = () => {
      if (first) {
        first = false;
        return h("p", null, [String(s.value)]);
      }
      return h("p", null, ["static"]);
    };
    const hd = mount(root, Once as ComponentFn);
    s.set(1);
    hd._flush();
    _unmount(hd);
  });
  assertEquals(zero.length, 1, "the genuine case is still reported");
});
