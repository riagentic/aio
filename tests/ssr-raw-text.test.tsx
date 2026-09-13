// <script> and <style> hold RAW TEXT, and SSR escaped it.
//
// The HTML parser reads a raw-text element to its closing tag and decodes no
// entities on the way, so `&gt;` inside a `<style>` is the six characters
// `&gt;`, not `>`. SSR ran every string child through `escapeHtml`, so a
// server-rendered stylesheet shipped `.a &gt; .b` — a selector that matches
// nothing — and a server-rendered script comparing `a < b` shipped `a &lt; b`,
// which does not parse. The client's `createDom` writes both as text and got
// them right, so the same component behaved one way in the browser and
// another on the server.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/air/vdom-create.ts";
import { renderToString } from "../src/air/vdom-ssr.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";

async function streamed(vnode: ReturnType<typeof h>): Promise<string> {
  let out = "";
  for await (const chunk of renderToStream(vnode)) out += chunk;
  return out;
}

Deno.test("SSR: <style> text keeps > and & verbatim", async () => {
  const css = ".a > .b { color: red } .c[x='1'] & .d { top: 0 }";
  const vnode = h("style", null, css);
  const str = renderToString(vnode);
  assertEquals(str, `<style>${css}</style>`);
  assertEquals(await streamed(h("style", null, css)), `<style>${css}</style>`);
});

Deno.test("SSR: <script> text keeps < and & verbatim", async () => {
  const js = 'if (a < b && c > d) { x("&") }';
  assertEquals(renderToString(h("script", null, js)), `<script>${js}</script>`);
  assertEquals(await streamed(h("script", null, js)), `<script>${js}</script>`);
});

Deno.test("SSR: every other element still escapes its text", () => {
  // The fix must be scoped to raw-text elements. A <div> that stopped
  // escaping would be an HTML injection, which is the opposite mistake.
  assertEquals(
    renderToString(h("div", null, "a < b & c > d")),
    "<div>a &lt; b &amp; c &gt; d</div>",
  );
  // <title> and <textarea> are ESCAPABLE raw text (RCDATA): entities ARE
  // decoded there, so escaping stays correct.
  assertStringIncludes(renderToString(h("title", null, "a < b")), "a &lt; b");
});

Deno.test("SSR: a literal closing tag inside raw text throws in dev", () => {
  setDevModeOverride(true);
  try {
    let threw = "";
    try {
      renderToString(h("style", null, "a{} </style><b>owned</b>"));
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    assertStringIncludes(threw, "</style");
    assertStringIncludes(threw, "ends the element");
  } finally {
    setDevModeOverride(null);
  }
});

Deno.test("SSR: outside dev a closing tag degrades to escaping, never breaks out", () => {
  setDevModeOverride(false);
  const realError = console.error;
  const said: string[] = [];
  console.error = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    const out = renderToString(h("script", null, 'x("</script><b>owned")'));
    // The one thing that must never happen: markup escaping the element.
    assert(
      !/<\/script><b>/.test(out),
      `raw text broke out of its element: ${out}`,
    );
    assertEquals(said.length, 1, "it degrades LOUDLY, not silently");
  } finally {
    console.error = realError;
    setDevModeOverride(null);
  }
});
