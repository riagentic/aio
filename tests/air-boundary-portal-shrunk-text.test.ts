// A `<Portal>` whose content shrinks in the same update a sibling starts to
// throw: the boundary retires its OLD region before sweeping the half-diffed
// new one, and the OLD portal vnode — whose children describe nodes the diff
// had already replaced — walked the shared region by stale positions, took the
// anchor and left the NEW bare text "a" in the target (often `document.body`)
// for good. Found by the SSR/hydrate/mount differential once portals joined.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { type ComponentFn, ErrorBoundary, h, Portal } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

const X = ((p: { t: boolean }) => {
  if (p.t) throw new Error("boom");
  return h("em", null, "ok");
}) as unknown as ComponentFn;

Deno.test("boundary catching on update: shrunk portal content leaves no text", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const said: string[] = [];
  const err = console.error, warn = console.warn;
  console.error = () => {}; // the caught render error is the input here
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    // [i, u, "a"] → [u, "a"] (shrunk), and the same content kept as it was.
    for (const shrink of [true, false]) {
      const v = signal(1);
      const target = doc.createElement("aside");
      doc.body.appendChild(target);
      const App = (() => {
        const one = v.value === 1;
        return h(
          "div",
          null,
          h(
            ErrorBoundary,
            { fallback: () => null },
            h(
              Portal,
              { target },
              ...(one && shrink
                ? [h("i", null, "x"), h("u", null, "u"), "a"]
                : [
                  h("u", null, "u"),
                  "a",
                ]),
            ),
            h(X, { t: !one }),
          ),
        );
      }) as unknown as ComponentFn;
      const host = doc.createElement("main");
      doc.body.appendChild(host);
      const m = mount(host, App);
      assertEquals(target.textContent, shrink ? "xua" : "ua");
      v.set(2);
      m._flush();
      await new Promise((r) => setTimeout(r, 0));
      m._flush();
      assertEquals(host.innerHTML, "<div><!----></div>");
      assertEquals(target.innerHTML, "", "the portal's text left with it");
      assertEquals(
        said.filter((s) => s.includes("without its DOM position")),
        [],
      );
      _unmount(m);
    }
  } finally {
    console.error = err;
    console.warn = warn;
    await closeWindow(win);
  }
});
