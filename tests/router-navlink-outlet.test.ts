// NavLink + Outlet functional tests — the two router exports no other suite
// exercises. Rendered for real via happy-dom + the AIR renderer.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { type ComponentFn, h, type VChild } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { NavLink, Outlet, Route } from "../src/browser/browser-air-router.ts";
import { routePath, routeSearch } from "../src/browser/browser-protocol.ts";

// ── Linked location/history stubs so navigate() works outside a browser ──

const origLocation = globalThis.location;
// deno-lint-ignore no-explicit-any
const origHistory = (globalThis as any).history;

function stubNavigation(startHref = "http://localhost:3000/"): void {
  let href = startHref;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).location = {
    get protocol() {
      return new URL(href).protocol;
    },
    get host() {
      return new URL(href).host;
    },
    get pathname() {
      return new URL(href).pathname;
    },
    get search() {
      return new URL(href).search;
    },
    get origin() {
      return new URL(href).origin;
    },
    get href() {
      return href;
    },
    reload: () => {},
  };
  // deno-lint-ignore no-explicit-any
  (globalThis as any).history = {
    pushState: (_s: unknown, _t: string, url: string | URL) => {
      href = new URL(url, href).href;
    },
    replaceState: (_s: unknown, _t: string, url: string | URL) => {
      href = new URL(url, href).href;
    },
    go: () => {},
  };
}

function restoreNavigation(): void {
  if (origLocation === undefined) {
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).location;
  } else {
    globalThis.location = origLocation;
  }
  if (origHistory === undefined) {
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).history;
  } else {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).history = origHistory;
  }
}

function createDOM(): { root: HTMLElement; cleanup: () => Promise<void> } {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  return { root, cleanup: () => win.happyDOM.close() };
}

function withRouterDOM(
  path: string,
  fn: (root: HTMLElement) => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    stubNavigation(`http://localhost:3000${path}`);
    routePath.set(path);
    routeSearch.set(new URLSearchParams());
    const { root, cleanup } = createDOM();
    try {
      await fn(root);
    } finally {
      routePath.set("/");
      await cleanup();
      restoreNavigation();
    }
  };
}

// ── Outlet ──────────────────────────────────────────────────────────

Deno.test(
  "Outlet: renders nothing outside a Route context",
  withRouterDOM("/", (root) => {
    const App = () => h("div", null, h(Outlet as ComponentFn, {}));
    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<div></div>");
    _unmount(handle);
  }),
);

Deno.test(
  "Outlet: renders the matching child route inside the parent layout",
  withRouterDOM("/dash/settings", (root) => {
    const Layout = () =>
      h("section", null, h("h1", null, "dash"), h(Outlet as ComponentFn, {}));
    const App = () =>
      h(
        Route as ComponentFn,
        { path: "/dash", element: h(Layout, {}) },
        h(Route as ComponentFn, {
          path: "settings",
          element: h("p", null, "settings-page"),
        }),
      );
    const handle = mount(root, App);
    assertEquals(
      root.innerHTML,
      "<section><h1>dash</h1><p>settings-page</p></section>",
    );
    _unmount(handle);
  }),
);

Deno.test(
  "Outlet: index child renders at the parent's base path",
  withRouterDOM("/dash", (root) => {
    const Layout = () => h("section", null, h(Outlet as ComponentFn, {}));
    const App = () =>
      h(
        Route as ComponentFn,
        { path: "/dash", element: h(Layout, {}) },
        h(Route as ComponentFn, {
          index: true,
          element: h("p", null, "index-page"),
        }),
      );
    const handle = mount(root, App);
    assertEquals(root.innerHTML, "<section><p>index-page</p></section>");
    _unmount(handle);
  }),
);

// ── NavLink ─────────────────────────────────────────────────────────

Deno.test(
  "NavLink: adds the default 'active' class only on the matching path",
  withRouterDOM("/inbox", (root) => {
    const App = () =>
      h(
        "nav",
        null,
        h(NavLink as ComponentFn, { to: "/inbox" }, "Inbox"),
        h(NavLink as ComponentFn, { to: "/sent" }, "Sent"),
      );
    const handle = mount(root, App);
    const [inbox, sent] = Array.from(root.querySelectorAll("a"));
    assertEquals(inbox!.getAttribute("class"), "active");
    assertEquals(sent!.getAttribute("class"), null);
    assertEquals(inbox!.getAttribute("href"), "/inbox");
    _unmount(handle);
  }),
);

Deno.test(
  "NavLink: honors a custom activeClass and keeps existing className",
  withRouterDOM("/inbox", (root) => {
    const App = () =>
      h(NavLink as ComponentFn, {
        to: "/inbox",
        activeClass: "current",
        className: "nav-item",
      }, "Inbox");
    const handle = mount(root, App);
    assertEquals(
      root.querySelector("a")!.getAttribute("class"),
      "nav-item current",
    );
    _unmount(handle);
  }),
);

Deno.test(
  "NavLink: click navigates (routePath updates, active class moves)",
  withRouterDOM("/inbox", async (root) => {
    const App = () =>
      h(
        "nav",
        null,
        h(NavLink as ComponentFn, { to: "/inbox" }, "Inbox"),
        h(NavLink as ComponentFn, { to: "/sent" }, "Sent"),
      );
    const handle = mount(root, App);
    const sent = Array.from(root.querySelectorAll("a"))[1]!;
    sent.click();
    assertEquals(routePath.value, "/sent");
    assertEquals(location.pathname, "/sent");
    await new Promise((r) => setTimeout(r, 20)); // signal-driven re-render
    const [inboxAfter, sentAfter] = Array.from(root.querySelectorAll("a"));
    assertEquals(inboxAfter!.getAttribute("class"), null);
    assertEquals(sentAfter!.getAttribute("class"), "active");
    _unmount(handle);
  }),
);
