// A `<pre>` / `<textarea>` whose text starts with a newline keeps it in SSR.
//
// The HTML parser DROPS the first newline after `<pre>`, `<textarea>` and
// `<listing>` (so `<pre>\nabc</pre>` parses to `abc`), while the client builds
// exactly the text it is given. A code block written as a template literal
// starting on its own line therefore lost its first line in server markup and
// got it back on hydration — the block jumped, and a server-only page never
// showed it. Every writer now emits one extra newline for the parser to eat.
import { assertEquals } from "@std/assert";
import {
  type ComponentFn,
  h,
  renderToString,
  type VNode,
} from "../src/air/vdom.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";

async function streamed(v: VNode): Promise<string> {
  let html = "";
  for await (const c of renderToStream(v)) html += c;
  return html;
}

Deno.test("SSR doubles the leading newline of pre and textarea content for the parser to drop", async () => {
  const Code = (() => "\nconst x = 1\n") as unknown as ComponentFn;
  const cases: [VNode, string][] = [
    [h("pre", null, "\nabc"), "<pre>\n\nabc</pre>"],
    [h("pre", null, h(Code, null)), "<pre>\n\nconst x = 1\n</pre>"],
    [h("textarea", { value: "\nnote" }), "<textarea>\n\nnote</textarea>"],
    // No leading newline — nothing added.
    [h("pre", null, "abc\n"), "<pre>abc\n</pre>"],
    [h("div", null, "\nabc"), "<div>\nabc</div>"],
  ];
  assertEquals(cases.length, 5);
  for (const [v, want] of cases) {
    assertEquals(renderToString(v), want);
    assertEquals(await streamed(v), want);
  }
});
