// A boundary that falls back on an update says nothing about text the failed
// attempt had already removed.
//
// A boundary inserted BEFORE another (no keys) is diffed against the old one:
// the old one's keyed fragment departs, the new one's child throws, and the
// boundary retires the old region — where the departed fragment was walked as
// a removal with no position, so each of its bare texts after the first was
// reported as text that "will stay on the page forever". The document was
// right; the line (dev, and once in a packaged app) was not. Found by the
// lifecycle differential once it moved nodes between containers
// (tests/air-lifecycle-differential.test.ts, FUZZ_SEED=1 ROUNDS=1500 STEPS=20).
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { ErrorBoundary, Fragment, h } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { _resetDevWarnings } from "../src/air/vdom-types.ts";
import { signal } from "../src/state/signal.ts";

const Thrower = (p: { boom: boolean }) => {
  if (!p.boom) return null;
  throw new Error("thrown on purpose");
};
const boundary = (...kids: unknown[]) =>
  h(ErrorBoundary as never, { fallback: () => "!" }, ...kids as never[]);

for (const stays of [false, true]) {
  Deno.test(
    `boundary retire: a keyed fragment the failed diff removed is released, not reported — its second text ${
      stays ? "stays" : "goes"
    } in the model`,
    async () => {
      const win = new Window({ url: "https://localhost" });
      const lines: string[] = [];
      const orig = { warn: console.warn, error: console.error };
      console.warn = console.error = (...a: unknown[]) =>
        void lines.push(a.map(String).join(" "));
      setDevMode(true);
      _resetDevWarnings();
      try {
        const doc = win.document as unknown as Document;
        _setDocument(doc);
        const root = doc.createElement("div") as unknown as HTMLElement;
        doc.body.appendChild(root as unknown as Node);
        const n = signal(0);
        const App = () =>
          h(
            "main",
            null,
            h("header", null, "h"),
            h(
              Fragment,
              null,
              ...(n.value
                ? [boundary(h(Thrower as never, { boom: true }))]
                : []),
              boundary(
                h(
                  Fragment,
                  { key: "k" },
                  " ",
                  ...(n.value && !stays ? [] : ["b"]),
                ),
                h(Thrower as never, { boom: false }),
              ),
            ),
            h("footer", null, "f"),
          );
        const handle = mount(root, App as ComponentFn);
        handle._flush();
        n.set(1);
        handle._flush();
        assertEquals(
          root.innerHTML.replace(/ data-component="[^"]*"/, ""),
          `<main><header>h</header>! ${
            stays ? "b" : ""
          }<!----><footer>f</footer></main>`,
        );
        assertEquals(lines.filter((l) => /text child|aio bug/.test(l)), []);
        _unmount(handle);
        assertEquals(root.innerHTML, "");
      } finally {
        setDevMode("auto");
        console.warn = orig.warn;
        console.error = orig.error;
        await closeWindow(win);
      }
    },
  );
}
