// An attribute NAME the document cannot hold must be refused by every render
// path — above all by the server, which is the one that writes raw markup.
//
// MEASURED on the pre-fix tree. `setAttribute` enforces the XML `Name`
// production, so the client path threw `InvalidCharacterError` and nothing
// reached the DOM; the SSR writers asked nothing and pasted the key into the
// tag:
//
//   renderToString(h("div", { "x onload=alert(1)": "1" }, "hi"))
//     -> <div x onload=alert(1)="1">hi</div>
//   renderToStream(…)  -> the same
//
// An HTML parser reads that as the attribute `x` followed by
// `onload="alert(1)=..."` — an event handler, from a PROP NAME. A prop name
// can come from untrusted data as easily as a value can (a spread of a parsed
// query string, a CMS record, a user's own object), and value escaping does
// nothing for it. The client throwing where the server injects is also the
// forbidden direction of a dev/prod split: the strict path is the one nobody
// ships.
//
// The rule is written once (`_assertAttrName`, beside the rest of "this prop
// becomes this DOM mutation") and applied by `_renderPropsHtml` — the single
// props writer both SSR entry points already share — and by `_writeProp`, the
// single client one.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, renderToString } from "../src/air/vdom.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { _isAttrName, _writeProp } from "../src/air/prop-write.ts";
import type { VNode } from "../src/air/vdom-types.ts";

const INJECTIONS = [
  "x onload=alert(1)",
  'x"><script>alert(1)</script',
  "a b",
  "a=b",
  "a/b",
  "a<b",
  "a>b",
  "1leading-digit",
  "-leading-dash",
  "",
];

async function streamed(v: VNode): Promise<string> {
  let out = "";
  for await (const c of renderToStream(v)) out += c;
  return out;
}

Deno.test("SSR: renderToString refuses an illegal attribute name instead of writing raw HTML", () => {
  for (const bad of INJECTIONS) {
    const err = assertThrows(
      () => renderToString(h("div", { [bad]: "1" }, "hi")),
      Error,
      undefined,
      `renderToString accepted ${JSON.stringify(bad)}`,
    );
    const msg = (err as Error).message;
    assert(msg.includes("<div>"), `message names the element: ${msg}`);
    assert(
      msg.includes(JSON.stringify(bad)),
      `message names the attribute: ${msg}`,
    );
  }
});

Deno.test("SSR: renderToStream refuses the same names renderToString does", async () => {
  for (const bad of INJECTIONS) {
    let threw = false;
    let out = "";
    try {
      out = await streamed(h("div", { [bad]: "1" }, "hi") as VNode);
    } catch (e) {
      threw = true;
      assert(
        (e as Error).message.includes(JSON.stringify(bad)),
        `message names the attribute: ${(e as Error).message}`,
      );
    }
    assert(threw, `renderToStream wrote ${JSON.stringify(out)} for ${bad}`);
  }
});

Deno.test("SSR and the client agree on which attribute names are legal", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  try {
    for (const bad of INJECTIONS) {
      // Never more permissive than the DOM: whatever `setAttribute` refuses,
      // the predicate refuses. Not the converse — happy-dom accepts a few
      // names a real browser rejects (`1leading-digit`, which is not an XML
      // `Name`), and the predicate is the SPEC. Being stricter than the test
      // environment is the allowed direction; being laxer than the browser is
      // how a server ships markup no client can reproduce.
      let domRefused = false;
      try {
        doc.createElement("div").setAttribute(bad, "1");
      } catch {
        domRefused = true;
      }
      if (domRefused) {
        assertEquals(
          _isAttrName(bad),
          false,
          `setAttribute refuses ${
            JSON.stringify(bad)
          } and the predicate did not`,
        );
      }
      // …and the client writer refuses it by name, with the element in the
      // message, rather than as a bare InvalidCharacterError.
      const el = doc.createElement("section") as unknown as HTMLElement;
      const err = assertThrows(() => _writeProp(el, bad, "1"), Error);
      assert(
        (err as Error).message.includes("<section>"),
        `client message names the element: ${(err as Error).message}`,
      );
    }
  } finally {
    // AWAITED: closeWindow is async, and a bare call left happy-dom's own
    // timer running — which only showed up as "Leaks detected" when this file
    // shared a process with others, i.e. under the sharded suite and never in
    // a single-file run.
    await closeWindow(win);
  }
});

Deno.test("the attribute-name rule still accepts every spelling aio writes", async () => {
  const ok: Record<string, string> = {
    "data-x": "1",
    "aria-label": "hi",
    "xlink:href": "#a",
    "xml:lang": "en",
    viewBox: "0 0 1 1",
    _private: "1",
    "x.y": "1",
    "ns:name-2.3": "1",
    "héllo": "1",
  };
  for (const [k, v] of Object.entries(ok)) {
    assert(_isAttrName(k), `${k} should be a legal attribute name`);
    const html = renderToString(h("div", { [k]: v }));
    assert(html.startsWith("<div "), `${k} was not emitted: ${html}`);
    assertEquals(await streamed(h("div", { [k]: v }) as VNode), html);
  }
  // …and the mapped spellings, whose ATTRIBUTE name is not the prop name.
  assertEquals(
    renderToString(h("label", { htmlFor: "a" })),
    `<label for="a"></label>`,
  );
  assertEquals(
    renderToString(h("stop", { stopColor: "red" })),
    `<stop stop-color="red"></stop>`,
  );
});
