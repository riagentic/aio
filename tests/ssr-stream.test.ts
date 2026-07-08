import { assertEquals } from "@std/assert";
import { type ComponentFn, Fragment, h } from "../src/air/vdom.ts";
import { lazy, Suspense } from "../src/air/vdom.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";

async function collect(
  vnode: Parameters<typeof renderToStream>[0],
): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of renderToStream(vnode)) chunks.push(chunk);
  return chunks.join("");
}

Deno.test("renderToStream: renders simple element", async () => {
  const html = await collect(h("div", { className: "a" }, "hello"));
  assertEquals(html, '<div class="a">hello</div>');
});

Deno.test("renderToStream: renders component", async () => {
  const App = () => h("section", null, h("h1", null, "Title"));
  assertEquals(
    await collect(h(App, null)),
    "<section><h1>Title</h1></section>",
  );
});

Deno.test("renderToStream: renders Fragment children", async () => {
  const html = await collect(
    h(Fragment, null, h("a", null, "1"), h("b", null, "2")),
  );
  assertEquals(html, "<a>1</a><b>2</b>");
});

Deno.test("renderToStream: Suspense with lazy shows fallback", async () => {
  // Create a lazy component that never resolves during this test
  const LazyComp = lazy(() => new Promise(() => {})); // never resolves
  const App = () =>
    h(
      Fragment,
      null,
      h("header", null, "top"),
      h(
        Suspense,
        { fallback: h("span", null, "loading...") },
        h(LazyComp, null),
      ),
      h("footer", null, "bottom"),
    );
  const html = await collect(h(App, null));
  assertEquals(html.includes("<header>top</header>"), true);
  assertEquals(html.includes("<span>loading...</span>"), true);
  assertEquals(html.includes("<footer>bottom</footer>"), true);
});

Deno.test("renderToStream: nested Suspense renders content", async () => {
  const Inner = () => h("div", null, "inner content");
  const App = () =>
    h(
      Suspense,
      { fallback: h("div", null, "outer loading") },
      h(
        "div",
        null,
        h(
          Suspense,
          { fallback: h("span", null, "inner loading") },
          h(Inner, null),
        ),
      ),
    );
  const html = await collect(h(App, null));
  assertEquals(html.includes("inner content"), true);
});

Deno.test("renderToStream: escapes HTML entities", async () => {
  const html = await collect(h("div", null, "<script>alert('xss')</script>"));
  assertEquals(html, "<div>&lt;script&gt;alert('xss')&lt;/script&gt;</div>");
});

Deno.test("renderToStream: renders void elements", async () => {
  assertEquals(await collect(h("br", null)), "<br>");
});

Deno.test("renderToStream: renders boolean and null attributes", async () => {
  const html = await collect(
    h("input", { disabled: true, hidden: false, type: "text" }),
  );
  assertEquals(html.includes("disabled"), true);
  assertEquals(html.includes("hidden"), false);
  assertEquals(html.includes('type="text"'), true);
});

Deno.test("renderToStream: dangerouslySetInnerHTML passes through unescaped", async () => {
  const html = await collect(
    h("div", { dangerouslySetInnerHTML: { __html: "<b>raw &amp; bold</b>" } }),
  );
  assertEquals(html, "<div><b>raw &amp; bold</b></div>");
});

Deno.test("renderToStream: escapes backticks in attributes", async () => {
  const html = await collect(h("div", { title: "a`b" }));
  assertEquals(html, '<div title="a&#96;b"></div>');
});
