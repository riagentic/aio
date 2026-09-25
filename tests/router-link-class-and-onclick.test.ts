// Two things `<Link>`/`<NavLink>` did to props the author passed, silently:
//
//   • `onClick` was overwritten by the router's own handler, so
//     `<Link to="/x" onClick={closeMenu}>` navigated and never ran closeMenu.
//     Now the author's handler runs first, and its `preventDefault()` keeps
//     the link from routing (the anchor contract).
//   • `class` (the spelling aio apps write) and `className` land on one
//     attribute, and the active class was added to `className` only — so
//     `<NavLink class="nav">` rendered `class="active"` on its own page, and
//     the author's "nav" styling vanished exactly where the link is current.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { Link, NavLink } from "../src/browser/browser-air-router.ts";
import { navigate } from "../src/browser/browser-protocol.ts";
import { closeWindow } from "../src/testing/close-window.ts";

async function withPage(
  body: (t: { win: Window; doc: Document }) => void | Promise<void>,
): Promise<void> {
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
  try {
    await body({ win, doc });
  } finally {
    g.location = prevLoc;
    g.history = prevHist;
    await closeWindow(win);
  }
}

Deno.test("Link runs the author's onClick, and its preventDefault stops routing", async () => {
  await withPage(({ win, doc }) => {
    const seen: string[] = [];
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    const handle = mount(host, () =>
      h("nav", null, [
        h(Link, { to: "/a", onClick: () => seen.push("a") }, "A"),
        h(Link, {
          to: "/b",
          onClick: (e: Event) => {
            seen.push("b");
            e.preventDefault();
          },
        }, "B"),
      ]));
    try {
      const links = host.querySelectorAll("a");
      assertEquals(links.length, 2);
      const click = (el: Element) =>
        el.dispatchEvent(
          new win.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            button: 0,
          }) as unknown as Event,
        );
      click(links[0]!);
      assertEquals(seen, ["a"], "the author's onClick ran");
      assertEquals(win.location.pathname, "/a", "…and the link still routed");
      click(links[1]!);
      assertEquals(seen, ["a", "b"]);
      assertEquals(win.location.pathname, "/a", "a prevented click stays put");
    } finally {
      _unmount(handle);
      host.remove();
    }
  });
});

Deno.test("NavLink keeps the author's class beside the active one", async () => {
  await withPage(({ doc }) => {
    navigate("/users");
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    const handle = mount(host, () =>
      h("nav", null, [
        h(NavLink, { to: "/users", class: "nav" }, "Users"),
        h(NavLink, { to: "/about", class: "nav" }, "About"),
      ]));
    try {
      (handle as unknown as { _flush?: () => void })._flush?.();
      const links = host.querySelectorAll("a");
      assertEquals(links.length, 2);
      const cls = (el: Element) =>
        (el.getAttribute("class") ?? "").split(/\s+/).sort().join(" ");
      assertEquals(cls(links[0]!), "active nav", "active: both classes");
      assertEquals(cls(links[1]!), "nav", "inactive: the author's class");
      assert(!links[1]!.hasAttribute("className"));
    } finally {
      _unmount(handle);
      host.remove();
    }
  });
});
