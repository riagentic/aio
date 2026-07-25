// aio/ui Markdown — a safe, common-subset renderer. Emits VNodes (no raw HTML),
// so text is auto-escaped and only link hrefs need scheme-checking.
import { assert, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { Markdown } from "../src/ui/mod.ts";

async function render(src: string): Promise<string> {
  const win = new Window();
  const App: ComponentFn = () => h(Markdown, { source: src });
  // deno-lint-ignore no-explicit-any
  const ui = await testUI(App, { document: win.document as any });
  const html = ui.html();
  await ui.dispose();
  return html;
}

/** Render and hand back the live DOM root for semantic (attribute) assertions. */
async function renderDom(
  src: string,
): Promise<{ root: Element; dispose: () => Promise<void> }> {
  const win = new Window();
  const App: ComponentFn = () => h(Markdown, { source: src });
  // deno-lint-ignore no-explicit-any
  const ui = await testUI(App, { document: win.document as any });
  const root = win.document.querySelector(".aio-md") as unknown as Element;
  return { root, dispose: () => ui.dispose() };
}

// ── Rendering the common subset ──

Deno.test("md: headings, bold, italic, inline code", async () => {
  const html = await render(
    "# Title\n\nHello **bold** and *italic* and `code`.",
  );
  assertStringIncludes(html, "<h1>Title</h1>");
  assertStringIncludes(html, "<strong>bold</strong>");
  assertStringIncludes(html, "<em>italic</em>");
  assertStringIncludes(html, 'class="aio-md__code">code</code>');
});

Deno.test("md: fenced code block preserves content, not parsed", async () => {
  const html = await render("```js\nconst x = **notbold**;\n```");
  assertStringIncludes(html, "aio-md__pre");
  assertStringIncludes(html, "const x = **notbold**;"); // literal, not parsed
  assert(!html.includes("<strong>notbold"), "code fence is not inline-parsed");
});

Deno.test("md: lists (ordered + unordered)", async () => {
  const ul = await render("- one\n- two");
  assertStringIncludes(ul, "<ul");
  assertStringIncludes(ul, "<li>one</li>");
  const ol = await render("1. first\n2. second");
  assertStringIncludes(ol, "<ol");
  assertStringIncludes(ol, "<li>first</li>");
});

Deno.test("md: blockquote + hr", async () => {
  assertStringIncludes(await render("> quoted"), "aio-md__quote");
  assertStringIncludes(await render("---"), "aio-md__hr");
});

Deno.test("md: safe links get target/rel; relative links don't", async () => {
  const ext = await render("[site](https://example.com)");
  assertStringIncludes(ext, 'href="https://example.com"');
  assertStringIncludes(ext, 'target="_blank"');
  assertStringIncludes(ext, 'rel="noopener noreferrer"');
  const rel = await render("[home](/home)");
  assertStringIncludes(rel, 'href="/home"');
  assert(!rel.includes("target="), "relative links open in place");
});

// ── XSS safety ──

Deno.test("md XSS: javascript: link href is dropped, text kept", async () => {
  const html = await render("[click](javascript:alert(1))");
  assert(!html.includes("javascript:"), `href must be dropped: ${html}`);
  assert(!html.includes("<a "), "no anchor emitted for an unsafe href");
  assertStringIncludes(html, "click"); // the link text survives
});

Deno.test("md XSS: data: image src is dropped, alt kept", async () => {
  const html = await render("![x](data:text/html,<script>alert(1)</script>)");
  assert(!html.includes("<img"), "unsafe image src dropped");
  assert(!html.includes("data:text/html"), html);
});

Deno.test("md XSS: raw HTML in source is escaped as text — no live tags", async () => {
  const src = "Hello <script>alert(1)</script> <img src=x onerror=y>";
  const html = await render(src);
  // no LIVE tags — the `<` is escaped, so no real <script>/<img> element exists
  assert(!html.includes("<script"), "no live <script> tag");
  assert(!html.includes("<img"), "no live <img> tag from raw HTML");
  assertStringIncludes(html, "&lt;script&gt;"); // shows escaped, as inert text
  // and semantically: the root has no script/img descendants
  const { root, dispose } = await renderDom(src);
  assert(root.querySelector("script") === null, "no script element");
  assert(root.querySelector("img") === null, "no img element");
  await dispose();
});

Deno.test("md XSS: a quote in a link href can't inject an attribute", async () => {
  // `"` is a valid URL char (no space) so this parses to a link — the renderer
  // MUST escape the href value so it can't break out into an `onmouseover` attr.
  const { root, dispose } = await renderDom(
    '[x](https://e.com/a"onmouseover="alert(1))',
  );
  const a = root.querySelector("a");
  assert(a, "a link was produced");
  assert(
    a!.getAttribute("onmouseover") === null,
    "the crafted quote did NOT create an onmouseover attribute",
  );
  // the whole crafted string lives inside the href value, inert
  assertStringIncludes(a!.getAttribute("href") ?? "", "onmouseover");
  await dispose();
});
