// SSR attribute values escape `<` and `>`. Inside a raw-text parent —
// `<noscript>` for a browser with scripting on, and noembed/noframes/xmp/
// iframe — the parser sees no attributes, only text up to `</noscript`, so a
// value holding `</noscript><img src=x onerror=…>` ended the element and
// shipped live markup from app/user data. Asserted on the bytes (no HTML
// parser dependency): no `<` or `>` from the value may survive.
import { assert, assertEquals } from "@std/assert";
import { h, renderToString } from "../src/air/vdom.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { escapeAttr } from "../src/air/ssr-utils.ts";

const PAYLOAD = "</noscript><img src=x onerror=alert(document.domain)>";

const tree = () =>
  h(
    "div",
    null,
    h(
      "noscript",
      null,
      h("a", { href: "/plain", title: PAYLOAD }, "plain version"),
    ),
  );

function assertInert(html: string): void {
  assertEquals(
    html.match(/<\/noscript/gi)?.length,
    1,
    `the attribute value closed the noscript:\n${html}`,
  );
  assert(!/<img/i.test(html), `live <img> injected:\n${html}`);
  assert(
    html.includes(
      'title="&lt;/noscript&gt;&lt;img src=x onerror=alert(document.domain)&gt;"',
    ),
    html,
  );
}

Deno.test("escapeAttr: < and > are escaped", () => {
  assertEquals(escapeAttr("a<b>c"), "a&lt;b&gt;c");
  // `&` first, so the entities it adds are not double-escaped.
  assertEquals(escapeAttr("&<"), "&amp;&lt;");
});

Deno.test("renderToString: attribute data inside <noscript> cannot break out", () => {
  assertInert(renderToString(tree()));
});

Deno.test("renderToStream: attribute data inside <noscript> cannot break out", async () => {
  let html = "";
  for await (const chunk of renderToStream(tree())) html += chunk;
  assertInert(html);
});
