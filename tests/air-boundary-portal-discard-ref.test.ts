// An `<ErrorBoundary>` that falls back retires what its failed attempt built.
// Inside a `<Portal>`, an element whose child threw is never placed (no `_dom`)
// and the portal teardown skipped it — so the siblings built before the throw
// were never unmounted: a `ref` among them was attached at the end of the
// commit to a DETACHED element (a modal's focus target pointing at nothing),
// while the same tree without the portal got its ref dropped. Found by the
// SSR/hydrate/mount differential once portals and refs joined its alphabet.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { type ComponentFn, ErrorBoundary, h, Portal } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";

const Boom = (() => {
  throw new Error("boom");
}) as unknown as ComponentFn;

Deno.test("boundary fallback: a ref in its discarded portal content is not attached", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const err = console.error;
  console.error = () => {}; // the caught render error is the input here
  try {
    for (const portal of [false, true]) {
      const target = doc.createElement("aside");
      doc.body.appendChild(target);
      const ref = { current: null as Element | null };
      const inner = h("div", null, h("p", { ref }, "r"), h(Boom, null));
      const App = (() =>
        h(
          ErrorBoundary,
          { fallback: () => "fb" },
          portal ? h(Portal, { target }, inner) : inner,
        )) as unknown as ComponentFn;
      const host = doc.createElement("main");
      doc.body.appendChild(host);
      const m = mount(host, App);
      assertEquals(host.innerHTML, "fb");
      assertEquals(target.innerHTML, "");
      assertEquals(ref.current, null, `portal=${portal}: ref holds a node`);
      _unmount(m);
    }
  } finally {
    console.error = err;
    await closeWindow(win);
  }
});
