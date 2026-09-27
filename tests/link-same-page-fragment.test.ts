// `<Link to="#section">` is claimed by the router (preventDefault +
// history.pushState). pushState never fires `hashchange` and never scrolls to
// the fragment, so an in-page anchor Link does neither — where the plain
// `<a href="#section">` it renders would do both. Either the router leaves a
// same-document fragment click to the browser, or it must reproduce what the
// browser does (at minimum, the `hashchange` every hash listener waits on).
import { assert } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { Link } from "../src/browser/browser-air-router.ts";
import { closeWindow } from "../src/testing/close-window.ts";

Deno.test("Link to a same-page fragment behaves like the anchor: hashchange fires", async () => {
  const win = new Window({
    url: "https://app.test/docs",
    settings: { navigation: { disableMainFrameNavigation: true } },
  });
  const doc = win.document as unknown as Document;
  const g = globalThis as Record<string, unknown>;
  const prevLoc = g.location, prevHist = g.history;
  g.location = win.location;
  g.history = win.history;
  _setDocument(doc);
  try {
    let hashchanges = 0;
    win.addEventListener("hashchange", () => hashchanges++);
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    const handle = mount(
      host,
      () =>
        h(
          "div",
          null,
          h(Link, { to: "#install" }, "Install"),
          h("h2", { id: "install" }, "x"),
        ),
    );
    const a = host.querySelector("a") as unknown as HTMLElement;
    const ev = new win.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    a.dispatchEvent(ev as unknown as Event);
    await new Promise((r) => setTimeout(r, 20));
    const claimed = (ev as unknown as Event).defaultPrevented;
    _unmount(handle);
    assert(
      !claimed || hashchanges > 0,
      `Link claimed the fragment click (defaultPrevented) and routed with ` +
        `pushState: location=${win.location.href}, hashchange fired ` +
        `${hashchanges}x, no scroll to #install`,
    );
  } finally {
    g.location = prevLoc;
    g.history = prevHist;
    await closeWindow(win);
  }
});
