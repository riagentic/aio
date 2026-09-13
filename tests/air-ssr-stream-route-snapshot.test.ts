// A streamed server render keeps the route of the request that started it.
//
// The route lives in the module-level `routePath` / `routeSearch` signals,
// which the request handler sets before rendering (docs/ui/air-advanced.md).
// `renderToString` renders in one synchronous call, so it reads the value just
// set. `renderToStream` calls each component when its chunk is PULLED — so a
// second request that set the route while the first response was still being
// written re-routed the first one. Measured before the fix: a stream started
// at `/p/42`, pulled once, then a request for `/about` → the first response
// finished as the `/about` page (`<!----><i>about</i>`), with no post in it.
import { assertEquals } from "@std/assert";
import { type ComponentFn, h, renderToString } from "../src/air/vdom.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import {
  Link,
  Route,
  routePath,
  routeSearch,
  useRoute,
} from "../src/air/router.ts";

const C = (fn: unknown) => fn as ComponentFn;

const Post = C(() => {
  const r = useRoute("/p/:id");
  return h("b", null, `post ${r.params.id} tab=${r.search.get("tab")}`);
});
const App = C(() =>
  h(
    "div",
    null,
    h("header", null, "site"),
    h(C(Link), { to: "/about", activeClass: "on" }, "about"),
    h(C(Route), { path: "/p/:id", element: h(Post, null) }),
    h(C(Route), { path: "/about", element: h("i", null, "about") }),
  )
);

/** What the handler does: set the route from the request, start the stream,
 *  and write its first chunk. The rest is pulled later. */
async function startRequest(url: string) {
  const u = new URL(url, "http://localhost");
  routePath.set(u.pathname);
  routeSearch.set(u.searchParams);
  const gen = renderToStream(h(App, null));
  let out = "";
  const first = await gen.next();
  if (!first.done) out += first.value;
  return async () => {
    for await (const chunk of gen) out += chunk;
    return out;
  };
}

Deno.test("SSR route snapshot: two interleaved streams each render their own request's route", async () => {
  const prevPath = routePath.peek();
  const prevSearch = routeSearch.peek();
  try {
    const expectA = (() => {
      routePath.set("/p/42");
      routeSearch.set(new URLSearchParams("tab=info"));
      return renderToString(h(App, null));
    })();
    const expectB = (() => {
      routePath.set("/about");
      routeSearch.set(new URLSearchParams());
      return renderToString(h(App, null));
    })();
    assertEquals(expectA.includes("<b>post 42 tab=info</b>"), true, expectA);
    assertEquals(
      expectB.includes('<a href="/about" class="on">'),
      true,
      expectB,
    );

    const finishA = await startRequest("/p/42?tab=info");
    const finishB = await startRequest("/about");
    // A third request moves the signals again before either finishes.
    routePath.set("/nowhere");
    routeSearch.set(new URLSearchParams("tab=x"));
    assertEquals(await finishA(), expectA);
    assertEquals(await finishB(), expectB);
  } finally {
    routePath.set(prevPath);
    routeSearch.set(prevSearch);
  }
});
