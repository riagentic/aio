/** @jsxImportSource aio */
// Server-rendering an app that uses the router.
//
// `<Route>` and `useRoute` call the router's runtime boot hook, which the
// `aio/air` entry installs as the browser transport's `ensureConnected`. Inside
// `renderToString` / `renderToStream` there is no page, so every routed app
// died on the server with
//
//   [aio:air] page has no HTTP origin and no IPC bridge — the aio:// page must
//   be loaded by the aio Electron shell
//
// — and no test had ever server-rendered a `Route`. Imported through the
// PUBLIC entry on purpose: that is the import that installs the throwing hook.
import { assert, assertEquals } from "@std/assert";
import {
  collectHead,
  Link,
  renderToStream,
  renderToString,
  Route,
  routePath,
  useHead,
  useRoute,
} from "../src/air.ts";

function Post() {
  const { params } = useRoute("/p/:slug");
  useHead({ title: `Post ${params.slug}` });
  return <article>post {params.slug}</article>;
}
function App() {
  useHead({ title: "Site" });
  return (
    <div>
      <Link to="/p/hello">hello</Link>
      <Route path="/p/:slug" element={<Post />} />
      <Route path="/about" element={<p>about</p>} />
    </div>
  );
}

async function atPath<T>(path: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = routePath.peek();
  routePath.set(path);
  try {
    return await fn();
  } finally {
    routePath.set(prev);
  }
}

Deno.test("SSR: renderToString of a routed app renders the matched page and its head", async () => {
  const html = await atPath("/p/hello", () => renderToString(<App />));
  assert(html.includes("<article>post hello</article>"), html);
  assert(html.includes('href="/p/hello"'), html);
  assertEquals(collectHead(), "<title>Post hello</title>");
  const about = await atPath("/about", () => renderToString(<App />));
  assert(about.includes("<p>about</p>"), about);
  assert(!about.includes("<article>"), about);
  assertEquals(collectHead(), "<title>Site</title>");
});

Deno.test("SSR: renderToStream of a routed app renders the matched page and its head", async () => {
  const html = await atPath("/p/streamed", async () => {
    let out = "";
    for await (const chunk of renderToStream(<App />)) out += chunk;
    return out;
  });
  assert(html.includes("<article>post streamed</article>"), html);
  assertEquals(collectHead(), "<title>Post streamed</title>");
});
