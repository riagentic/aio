// Standard HTML attributes the JSX types were missing (TS2322 → `as any`):
// `<time dateTime>` (jot), `<input list>` (studio), and the rest of an audit
// of the WHATWG global + per-element attribute tables. This file is a
// TYPE test first — it must compile under `deno task check` — and a render
// test second: each attribute must reach the markup under its HTML name.
import { assertStringIncludes } from "@std/assert";
import { renderToString } from "../src/air/vdom.ts";
import { testUI } from "aio/testing";

function Picker() {
  return (
    <div>
      <input t="fruit" list="fruits" aria-label="Fruit" />
      <datalist id="fruits">
        <option value="apple" />
      </datalist>
      <time t="when" dateTime="2026-10-20">today</time>
    </div>
  );
}

testUI(Picker, "client render: <input list> wires the datalist", async (ui) => {
  await ui.settle();
  assertStringIncludes(ui.fruit.attr("list") ?? "", "fruits");
  assertStringIncludes(ui.when.attr("datetime") ?? "", "2026-10-20");
});

const html = (n: unknown) => renderToString(n as never).toLowerCase();

Deno.test("jot/studio: <time dateTime>, <time datetime>, <input list>", () => {
  assertStringIncludes(
    html(<time dateTime="2026-10-20">today</time>),
    'datetime="2026-10-20"',
  );
  assertStringIncludes(
    html(<time datetime="2026-10-20">today</time>),
    'datetime="2026-10-20"',
  );
  const out = html(
    <div>
      <input list="fruits" aria-label="Fruit" />
      <datalist id="fruits">
        <option value="apple" />
      </datalist>
    </div>,
  );
  assertStringIncludes(out, 'list="fruits"');
});

Deno.test("global attributes", () => {
  const out = html(
    <div
      accessKey="k"
      autoFocus
      autoCorrect="off"
      inert
      nonce="n1"
      popover="manual"
      translate="no"
      hidden="until-found"
      part="p"
      exportParts="p"
      itemScope
      itemProp="name"
      itemType="https://schema.org/Thing"
      itemID="urn:x"
      itemRef="r"
      writingSuggestions="false"
    />,
  );
  for (
    const a of [
      'accesskey="k"',
      "autofocus",
      'autocorrect="off"',
      "inert",
      'nonce="n1"',
      'popover="manual"',
      'translate="no"',
      'hidden="until-found"',
      'part="p"',
      'itemprop="name"',
      'itemid="urn:x"',
    ]
  ) assertStringIncludes(out, a);
});

Deno.test("per-element attributes", () => {
  const out = html(
    <div>
      <form acceptCharset="utf-8" rel="noopener">
        <button
          type="submit"
          formAction="/x"
          formMethod="post"
          formNoValidate
          popoverTarget="pop"
          popoverTargetAction="show"
          commandFor="dlg"
          command="show-modal"
        >
          go
        </button>
        <input type="image" src="/i.png" alt="go" width={10} height={10} />
        <input type="file" capture="user" form="f" aria-label="Photo" />
        <textarea autoComplete="off" dirName="d.dir" aria-label="T" />
        <select autoComplete="country" form="f" aria-label="S" />
      </form>
      <ol reversed start={3} type="i">
        <li value={5}>x</li>
      </ol>
      <blockquote cite="https://a.test">q</blockquote>
      <del dateTime="2026-01-01" cite="https://a.test">d</del>
      <ins datetime="2026-01-02">i</ins>
      <table>
        <colgroup span={2}>
          <col span={1} />
        </colgroup>
      </table>
      <data value={42}>forty-two</data>
      <output htmlFor="a b" name="sum">3</output>
      <video>
        <source src="/v.mp4" type="video/mp4" />
        <track default kind="captions" srcLang="en" label="EN" src="/c.vtt" />
      </video>
      <a href="/" ping="/p">a</a>
      <dialog closedBy="any" />
      <template shadowRootMode="open" />
      <slot name="s" />
      <object data="/o" type="application/pdf" />
      <embed src="/e" type="image/svg+xml" />
      <map name="m">
        <area shape="rect" coords="0,0,1,1" href="/" alt="r" />
      </map>
    </div>,
  );
  for (
    const a of [
      'accept-charset="utf-8"',
      'formaction="/x"',
      "formnovalidate",
      'popovertarget="pop"',
      'commandfor="dlg"',
      'capture="user"',
      'dirname="d.dir"',
      'start="3"',
      'value="5"',
      'cite="https://a.test"',
      'datetime="2026-01-01"',
      'datetime="2026-01-02"',
      'span="2"',
      'value="42"',
      'for="a b"',
      'srclang="en"',
      'ping="/p"',
      'closedby="any"',
      'shadowrootmode="open"',
      'coords="0,0,1,1"',
    ]
  ) assertStringIncludes(out, a);
});

Deno.test("head tags", () => {
  const out = html(
    <div>
      <meta charSet="utf-8" />
      <meta property="og:title" content="T" />
      <link rel="preload" as="font" crossOrigin="anonymous" href="/f.woff2" />
      <script async noModule src="/s.js" integrity="sha384-x" />
      <style media="print" />
      <base href="/" target="_blank" />
    </div>,
  );
  for (
    const a of [
      'charset="utf-8"',
      'property="og:title"',
      'as="font"',
      'crossorigin="anonymous"',
      "nomodule",
      'integrity="sha384-x"',
      'media="print"',
    ]
  ) assertStringIncludes(out, a);
});
