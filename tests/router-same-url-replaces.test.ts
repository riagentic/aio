// A navigation to the URL the page is already at REPLACES its history entry.
//
// That is the HTML navigate algorithm's rule for a same-URL navigation, and
// what a plain `<a>` does. `navigate()` pushed unconditionally, so a `<Link>`
// to the current page — a nav bar's own item, clicked again — added a
// duplicate entry every click. Measured: `history.length` 9 → 10 on a
// self-link, and Back then looked dead once per click.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { Link } from "../src/browser/browser-air-router.ts";
import { navigate, routePath } from "../src/browser/browser-protocol.ts";
import { closeWindow } from "../src/testing/close-window.ts";

async function withWindow(
  url: string,
  fn: (win: Window, doc: Document) => void | Promise<void>,
): Promise<void> {
  const win = new Window({
    url,
    settings: { navigation: { disableMainFrameNavigation: true } },
  });
  const doc = win.document as unknown as Document;
  const g = globalThis as Record<string, unknown>;
  const prevLoc = g.location, prevHist = g.history;
  g.location = win.location;
  g.history = win.history;
  _setDocument(doc);
  try {
    await fn(win, doc);
  } finally {
    g.location = prevLoc;
    g.history = prevHist;
    await closeWindow(win);
  }
}

Deno.test("navigate(): the current URL replaces; a different path, query or hash pushes", async () => {
  await withWindow("https://app.test/users/42", (win) => {
    const len = () => win.history.length;
    const start = len();
    navigate("/users/42");
    assertEquals(len(), start, "same URL → no new entry");
    navigate("https://app.test/users/42");
    assertEquals(len(), start, "same URL, spelled absolute → no new entry");
    navigate("/users/7");
    assertEquals(len(), start + 1, "a different path pushes");
    navigate("/users/7?tab=1");
    assertEquals(len(), start + 2, "a different query pushes");
    navigate("/users/7?tab=1#top");
    assertEquals(len(), start + 3, "a different hash pushes");
    navigate("/users/7?tab=1#top");
    assertEquals(len(), start + 3, "…and repeating it does not");
    assertEquals(routePath.peek(), "/users/7");
  });
});

Deno.test("Link to the current page does not add a history entry", async () => {
  await withWindow("https://app.test/users/42", (win, doc) => {
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    const handle = mount(host, () => h(Link, { to: "/users/42" }, "me"));
    try {
      const start = win.history.length;
      const a = host.querySelector("a") as unknown as HTMLElement;
      for (let i = 0; i < 3; i++) {
        const ev = new win.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
        });
        a.dispatchEvent(ev as unknown as Event);
        assertEquals((ev as unknown as Event).defaultPrevented, true);
      }
      assertEquals(win.history.length, start, "three self-clicks, no entries");
    } finally {
      _unmount(handle);
      host.remove();
    }
  });
});
