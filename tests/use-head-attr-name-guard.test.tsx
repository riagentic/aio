// A `useHead` tag's attribute NAME is refused on the server exactly as the
// browser refuses it.
//
// `collectHead()` pasted each key into its markup verbatim, so a tag built by
// spreading data shipped `<meta … x onload=alert(1)//="1">` — a live handler
// in the server's `<head>` — while the browser's `setAttribute` throws for the
// same key. The element writers already share one rule (`_assertAttrName`);
// the head writers now use it too.
import { assertStringIncludes, assertThrows } from "@std/assert";
import { type ComponentFn, h, renderToString } from "../src/air/vdom.ts";
import { _resetHead, collectHead, useHead } from "../src/air/head.ts";

const page = (meta: Record<string, unknown>) =>
  (() => {
    useHead({ meta: [meta as Record<string, string>] });
    return h("p", null, "x");
  }) as unknown as ComponentFn;

Deno.test("collectHead refuses an attribute name that would write raw HTML", () => {
  _resetHead();
  renderToString(h(page({ name: "d", "x onload=alert(1)//": "1" }), null));
  assertThrows(() => collectHead(), Error, "not a legal attribute name");
  _resetHead();
});

Deno.test("collectHead keeps legal names, and an omitted bad key is not written", () => {
  _resetHead();
  renderToString(
    h(
      page({ name: "d", content: "c", "data-x": "1", "bad key": undefined }),
      null,
    ),
  );
  assertStringIncludes(
    collectHead(),
    '<meta name="d" content="c" data-x="1" data-aio-head>',
  );
  _resetHead();
});
