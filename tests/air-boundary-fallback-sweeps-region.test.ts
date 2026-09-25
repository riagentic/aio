// An `<ErrorBoundary>` that starts throwing replaces its WHOLE region with the
// fallback — no text child of the old content is left beside it.
//
// The keyed child diff removes some old children before it builds the new
// ones (departing keyed rows first; a mismatched child before its
// replacement). When the build then throws, the boundary retires its old
// region — but it walked it from the region's first node, which that diff had
// already detached, so the walk lost its cursor and every bare-text child after
// it (`Hello {name}` is two) stayed on the page beside the fallback. The sweep
// that clears such debris was skipped too: it asked whether the region's
// position was known AFTER the failed diff had detached it. Stepping over the
// detached child must not trip the dev "lost the positional cursor" warning
// either: nothing is wrong once the region is retired correctly.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { ErrorBoundary, h } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

Deno.test("a boundary falling back leaves none of its old text beside the fallback", async () => {
  const win = new Window();
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  setDevMode(false); // reset the once-per-id dedup
  setDevMode(true);
  try {
    const doc = win.document as unknown as Document;
    _setDocument(doc);
    const broken = signal(false);
    const rows = signal(["r1"]);
    const Boom = () => {
      throw new Error("boom");
    };
    const Fallback = () => h("b", null, "!");
    const cases: [string, () => unknown[]][] = [
      // A mismatched child removed before its replacement threw.
      ["text first", () => [
        broken.value ? h(Boom, null) : null,
        "Hello ",
        "Ada",
        rows.value.map((r) => h("i", { key: r }, r)),
      ]],
      // A keyed row departing before the build threw.
      ["row first", () => [
        broken.value ? [] : rows.value.map((r) => h("i", { key: r }, r)),
        "Hello ",
        "Ada",
        broken.value ? h(Boom, null) : null,
      ]],
    ];
    assertEquals(cases.length, 2);
    for (const [name, kids] of cases) {
      broken.set(false);
      const App = () =>
        h(
          "div",
          null,
          h("p", null),
          h(ErrorBoundary, { fallback: Fallback }, ...(kids() as [])),
          h("u", null),
        );
      const host = doc.createElement("div");
      doc.body.appendChild(host);
      const handle = mount(host, App as ComponentFn);
      handle._flush();
      broken.set(true);
      handle._flush();
      assertEquals(
        host.firstElementChild!.innerHTML,
        "<p></p><b>!</b><u></u>",
        name,
      );
      _unmount(handle);
      host.remove();
    }
    assertEquals(warns.filter((w) => w.includes("[aio-dev]")), []);
  } finally {
    console.warn = origWarn;
    setDevMode(false);
    await closeWindow(win);
  }
});
