// `<Link>`'s active state for an ABSOLUTE same-origin `to` is judged
// against a stand-in origin (`http://aio.invalid/`) on the server, where there
// is no `location`. The server render says "inactive"; the browser, judging
// the same link at the same route against its real origin, says "active" — so
// the SSR markup and the first client render disagree on `class`.
import { assertEquals } from "@std/assert";
import { type ComponentFn, h, renderToString } from "../src/air/vdom.ts";
import { Link, routePath } from "../src/air/router.ts";

const C = (fn: unknown) => fn as ComponentFn;
const App = C(() =>
  h(
    C(Link),
    { to: "http://localhost:8000/about", activeClass: "on" },
    "about",
  )
);

Deno.test("SSR and client agree on an absolute same-origin Link's active class", () => {
  const g = globalThis as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(globalThis, "location");
  const prev = routePath.peek();
  try {
    routePath.set("/about");
    const server = renderToString(h(App, null)); // no `location`: a server
    g.location = new URL("http://localhost:8000/about");
    const client = renderToString(h(App, null)); // the browser at that page
    assertEquals(
      server,
      client,
      "server render and client render of the same route differ",
    );
  } finally {
    if (had) Object.defineProperty(globalThis, "location", had);
    else delete g.location;
    routePath.set(prev);
  }
});
