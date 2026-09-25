// `<Link>`/`<NavLink>` keep a SIGNAL `class`/`className` bound, as every
// element does (docs/ui/air-reference.md "Signal-Bound Attributes").
//
// Folding the author's `class` and `className` into one string (so the active
// class no longer replaces the author's) stringified a signal: the link
// rendered its source text as the class and never updated — where 1.0.11
// passed it through bound.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { Link } from "../src/browser/browser-air-router.ts";
import { signal } from "../src/state/signal.ts";
import { closeWindow } from "../src/testing/close-window.ts";

Deno.test("Link keeps a signal class bound", async () => {
  const win = new Window({
    url: "https://app.test/home",
    settings: { navigation: { disableMainFrameNavigation: true } },
  });
  const doc = win.document as unknown as Document;
  const g = globalThis as Record<string, unknown>;
  const prevLoc = g.location, prevHist = g.history;
  g.location = win.location;
  g.history = win.history;
  _setDocument(doc);
  const a = signal("red");
  const b = signal("red");
  const host = doc.createElement("main");
  doc.body.appendChild(host);
  const handle = mount(host, () =>
    h("nav", null, [
      h(Link, { to: "/a", class: a }, "A"),
      h(Link, { to: "/b", className: b }, "B"),
    ]));
  try {
    const links = host.querySelectorAll("a");
    assertEquals(links.length, 2);
    assertEquals(links[0]!.getAttribute("class"), "red");
    assertEquals(links[1]!.getAttribute("class"), "red");
    a.set("blue");
    b.set("blue");
    assertEquals(links[0]!.getAttribute("class"), "blue");
    assertEquals(links[1]!.getAttribute("class"), "blue");
  } finally {
    _unmount(handle);
    host.remove();
    g.location = prevLoc;
    g.history = prevHist;
    await closeWindow(win);
  }
});
