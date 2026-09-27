// A `<Link>` with a RELATIVE `to` navigates relative to the page (`navigate`
// resolves it against `location.href`, docs/ui/air-routing.md: "Relative paths
// resolve against location.href") — but its ACTIVE state compared the raw
// string the author wrote against the pathname. The docs promise "Paths are
// compared, not strings"; for a relative `to` it was neither, so a NavLink to
// "api" was never active on the very page it navigates to (`/docs/api`).
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { type ComponentFn, h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { _setRouterBoot, Link } from "../src/air/router.ts";
import { routePath } from "../src/air/router-core.ts";

const L = Link as ComponentFn;

async function renderAt(path: string, App: ComponentFn): Promise<string> {
  _setRouterBoot(() => {});
  const g = globalThis as Record<string, unknown>;
  const prevLoc = g.location;
  const href = `https://localhost${path}`;
  // The page really is at `path` — location and the route signal agree.
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL(href),
  });
  const win = new Window({ url: href });
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
    if (prevLoc === undefined) delete g.location;
    else {
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: prevLoc,
      });
    }
    await closeWindow(win);
  }
}

const link = (to: string) => () => h(L, { to, activeClass: "on" }, "x");

Deno.test("router: a Link with a relative `to` is active on the page it resolves to", async () => {
  // Sanity: `api` from /docs/api IS /docs/api — the URL the click navigates to.
  assertEquals(
    new URL("api", "https://localhost/docs/api").pathname,
    "/docs/api",
  );
  for (const to of ["api", "./api", "../docs/api", "?tab=2", "#top", ""]) {
    assertEquals(
      await renderAt("/docs/api", link(to)),
      `<a href="${to}" class="on">x</a>`,
      `to=${to} resolves to /docs/api, the current page`,
    );
  }
});

Deno.test("router: a relative `to` resolving elsewhere is not active, nor is another origin", async () => {
  for (const to of ["guide", "../api", "https://example.com/docs/api"]) {
    assertEquals(
      await renderAt("/docs/api", link(to)),
      `<a href="${to}">x</a>`,
      `to=${to} does not lead to /docs/api`,
    );
  }
});

Deno.test("router: a relative `to` is prefix-matched like an absolute one", async () => {
  // From `/docs/api/v2`, `../api` is `/docs/api` — a parent of the page.
  assertEquals(
    await renderAt("/docs/api/v2", link("../api")),
    `<a href="../api" class="on">x</a>`,
  );
  // …but `exact` still asks for the page itself.
  const Exact = () =>
    h(L, { to: "../api", exact: true, activeClass: "on" }, "x");
  assertEquals(await renderAt("/docs/api/v2", Exact), `<a href="../api">x</a>`);
});
