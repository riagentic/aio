/** @jsxImportSource aio */
// The camelCase props whose HTML attribute is HYPHENATED must be written
// hyphenated, by every render path.
//
// `attrNameOf` is the ONE table the client patcher, hydration and both SSR
// writers share, and it is the reason `htmlFor` becomes `for` and
// `stopColor` becomes `stop-color`. `httpEquiv` and `acceptCharset` were
// missing from it, so they were emitted VERBATIM: attribute names are
// case-insensitive but not hyphen-insensitive, so `<meta httpEquiv=…>` is
// `httpequiv` and `<form acceptCharset=…>` is `acceptcharset` — attributes no
// browser reads. The refresh never fired, the CSP was never applied, the form
// encoding was never set, and nothing said so: the silent no-op `htmlFor` had
// before this table existed.
//
// 481c2751 fixed the same spelling for `useHead`'s `<meta>` tags only. A key
// the framework honours in one surface and drops in another is the bug, so
// this holds the table itself.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, renderToString } from "../src/air.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { attrNameOf } from "../src/air/ssr-utils.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { _armTestStrict } from "../src/testing/test-strict.ts";

_armTestStrict();

const App = () =>
  h("div", null, [
    h("meta", { httpEquiv: "content-security-policy", content: "default-src" }),
    h("form", { acceptCharset: "utf-8" }),
  ]);

Deno.test("attrNameOf maps every hyphenated HTML attribute it is given", () => {
  assertEquals(attrNameOf("httpEquiv"), "http-equiv");
  assertEquals(attrNameOf("acceptCharset"), "accept-charset");
  // unchanged neighbours, so the table is not being rewritten around this
  assertEquals(attrNameOf("htmlFor"), "for");
  assertEquals(attrNameOf("viewBox"), "viewBox");
});

Deno.test("renderToString writes http-equiv and accept-charset", () => {
  const html = renderToString(h(App as never, null));
  assert(
    html.includes(`http-equiv="content-security-policy"`),
    `server markup must carry http-equiv — got ${html}`,
  );
  assert(
    html.includes(`accept-charset="utf-8"`),
    `server markup must carry accept-charset — got ${html}`,
  );
  assert(!/httpEquiv|acceptCharset/.test(html), `verbatim spelling in ${html}`);
});

Deno.test("renderToStream writes http-equiv and accept-charset", async () => {
  let html = "";
  for await (const chunk of renderToStream(h(App as never, null))) {
    html += chunk;
  }
  assert(
    html.includes(`http-equiv="content-security-policy"`),
    `streamed markup must carry http-equiv — got ${html}`,
  );
  assert(
    html.includes(`accept-charset="utf-8"`),
    `streamed markup must carry accept-charset — got ${html}`,
  );
});

Deno.test("the client writes http-equiv and accept-charset too", async () => {
  const win = new Window({ url: "https://localhost/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const host = doc.createElement("main");
  doc.body.appendChild(host);
  const handle = mount(host, App as never);
  const meta = host.querySelector("meta")!;
  const form = host.querySelector("form")!;
  assertEquals(meta.getAttribute("http-equiv"), "content-security-policy");
  assertEquals(form.getAttribute("accept-charset"), "utf-8");
  assertEquals(meta.getAttribute("httpequiv"), null);
  assertEquals(form.getAttribute("acceptcharset"), null);
  _unmount(handle);
  await closeWindow(win);
  _setDocument(undefined as never);
});
