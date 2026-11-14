// After client navigation away from an SSR page, its `useHead` title stayed:
// collectHead() wrote `<title>` without `data-aio-head`, so hydration recorded
// the SERVER page's title as the document's original and "restored" it on the
// next page without a useHead. A client mount drops it.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { type ComponentFn, h, renderToString } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
} from "../src/air/aio-renderer.ts";
import { _resetHead, collectHead, useHead } from "../src/air/head.ts";
import { signal } from "../src/state/signal.ts";

const page = signal<"post" | "about">("post");
const Post = () => {
  useHead({
    title: "Post 1 — My Blog",
    meta: [{ name: "description", content: "post" }],
  });
  return h("article", null, "post body");
};
const About = () => h("p", null, "about");
const App = () =>
  h(
    "main",
    null,
    page.value === "post"
      ? h(Post as ComponentFn, null)
      : h(About as ComponentFn, null),
  );

async function run(
  mode: "client" | "ssr" | "ssr+shell",
): Promise<{ title: string; metas: number; titles: number }> {
  _resetHead();
  page.set("post");
  const win = new Window({ url: "http://localhost/posts/1" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  let handle;
  if (mode === "client") {
    handle = mount(root, App as ComponentFn);
  } else {
    const body = renderToString(h(App as ComponentFn, null));
    const head = collectHead();
    doc.head.innerHTML = mode === "ssr+shell"
      ? head + "<title>Shell</title>"
      : head;
    root.innerHTML = body;
    handle = hydrate(root, App as ComponentFn);
  }
  assertEquals(doc.title, "Post 1 — My Blog");
  // Hydrating kept the server's description meta, not a duplicate of it.
  assertEquals(doc.head.querySelectorAll("meta").length, 1);
  page.set("about"); // client navigation to a page with no useHead
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(root.textContent, "about");
  const out = {
    title: doc.title,
    metas: doc.head.querySelectorAll("meta").length,
    titles: doc.head.querySelectorAll("title").length,
  };
  _unmount(handle);
  _setDocument(null as never);
  await closeWindow(win);
  return out;
}

Deno.test("collectHead marks the title it writes", () => {
  _resetHead();
  renderToString(h(Post as ComponentFn, null));
  assertEquals(
    collectHead(),
    '<title data-aio-head>Post 1 — My Blog</title><meta name="description" content="post" data-aio-head>',
  );
});

Deno.test("SSR+hydrate: leaving the page drops its title like a client mount does", async () => {
  const client = await run("client");
  const ssr = await run("ssr");
  assertEquals(client.metas, 0);
  assertEquals(ssr.metas, 0);
  assertEquals(client.title, "");
  assertEquals(ssr.title, "", "the post's title was left on the About page");
});

Deno.test("SSR+hydrate: the shell's own unmarked title is the one restored", async () => {
  const r = await run("ssr+shell");
  assertEquals(r.metas, 0);
  assertEquals(r.title, "Shell");
});
