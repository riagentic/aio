// Route matching compares PATHS, not strings.
//
// Four ways the router answered "no match" for a url that plainly matches:
//
//  • an `index` route under a parent with a param compared the url against the
//    parent's PATTERN (`/users/42` vs "/users/:id") and never rendered; under
//    `/dash` it stayed empty at `/dash/`;
//  • a static segment with a non-ASCII character or a space never matched,
//    because `routePath` is the browser's percent-ENCODED pathname
//    (`/caf%C3%A9`) and the pattern is what the author wrote (`/café`);
//  • `<Link>` was never active when its `to` had a trailing slash, a query, a
//    hash — or that same encoding difference;
//  • `*` inside a segment was left as a regex quantifier, so `/a*b` matched `/b`.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { type ComponentFn, h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { _setRouterBoot, Link, Outlet, Route } from "../src/air/router.ts";
import { matchPath, routePath } from "../src/air/router-core.ts";

const R = Route as ComponentFn;
const L = Link as ComponentFn;

async function renderAt(path: string, App: ComponentFn): Promise<string> {
  _setRouterBoot(() => {});
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  routePath.set(path);
  try {
    const handle = mount(root, App);
    const html = root.innerHTML.replace(/<!---->/g, "");
    _unmount(handle);
    return html;
  } finally {
    routePath.set("/");
    _setRouterBoot(null);
    await closeWindow(win);
  }
}

const Layout = () => h("section", null, h(Outlet as ComponentFn, {}));

Deno.test("router: an index route renders under a param parent", async () => {
  const App = () =>
    h(
      R,
      { path: "/users/:id", element: h(Layout, {}) },
      h(R, { index: true, element: h("p", null, "overview") }),
      h(R, { path: "posts", element: h("p", null, "posts") }),
    );
  assertEquals(
    await renderAt("/users/42", App),
    "<section><p>overview</p></section>",
  );
  assertEquals(
    await renderAt("/users/42/posts", App),
    "<section><p>posts</p></section>",
  );
});

Deno.test("router: an index route renders at the parent's trailing slash", async () => {
  const App = () =>
    h(
      R,
      { path: "/dash", element: h(Layout, {}) },
      h(R, { index: true, element: h("p", null, "idx") }),
    );
  assertEquals(await renderAt("/dash/", App), "<section><p>idx</p></section>");
  assertEquals(await renderAt("/dash", App), "<section><p>idx</p></section>");
});

Deno.test("router: static segments match the browser's encoded pathname", async () => {
  const Cafe = () => h(R, { path: "/café", element: h("p", null, "cafe") });
  assertEquals(await renderAt("/caf%C3%A9", Cafe), "<p>cafe</p>");
  const About = () => h(R, { path: "/about us", element: h("p", null, "a") });
  assertEquals(await renderAt("/about%20us", About), "<p>a</p>");
  // A slash escaped INSIDE a param is still one segment, decoded once.
  assertEquals(matchPath("/u/:id", "/u/a%2Fb"), { id: "a/b" });
  assertEquals(matchPath("/u/:id/x", "/u/a%2Fb/x"), { id: "a/b" });
  assertEquals(matchPath("/u/:id", "/u/100%2541"), { id: "100%41" });
  assertEquals(matchPath("/u/:id", "/u/%E0%A4%A"), { id: "%E0%A4%A" });
});

Deno.test("router: `*` inside a segment is a literal, not a quantifier", () => {
  assertEquals(matchPath("/a*b", "/b"), null);
  assertEquals(matchPath("/a*b", "/aaab"), null);
  assertEquals(matchPath("/a*b", "/a*b"), {});
  assertEquals(matchPath("/files/*", "/files/a/b"), { "*": "a/b" });
});

Deno.test("router: a Link is active on the page it points at", async () => {
  for (const to of ["/users", "/users/", "/users?tab=1", "/users#top"]) {
    const App = () => h(L, { to, activeClass: "on" }, "x");
    assertEquals(
      await renderAt("/users", App),
      `<a href="${to}" class="on">x</a>`,
      `to=${to}`,
    );
  }
  const Space = () => h(L, { to: "/about us", activeClass: "on" }, "x");
  assertEquals(
    await renderAt("/about%20us", Space),
    '<a href="/about us" class="on">x</a>',
  );
  // …and still not on a sibling that merely shares a prefix.
  const Sib = () => h(L, { to: "/user", activeClass: "on" }, "x");
  assertEquals(await renderAt("/users", Sib), '<a href="/user">x</a>');
});
