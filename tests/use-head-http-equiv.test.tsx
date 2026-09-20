/** @jsxImportSource aio */
// `useHead({ meta: [{ httpEquiv: … }] })` must write `http-equiv=`.
//
// `_tagKey` has always accepted `httpEquiv` as a `<meta>`'s identity — the
// camelCase spelling aio uses everywhere else (`htmlFor` → `for`,
// `stopColor` → `stop-color`), and the one a React user types from muscle
// memory. Both writers then emitted the key VERBATIM, so the tag shipped as
// `<meta httpEquiv="refresh">`: HTML attribute names are case-insensitive but
// not hyphen-insensitive, so that parses as `httpequiv`, an attribute no
// browser reads. The refresh never fired, the CSP was never applied, and
// nothing said so — the same silent no-op `htmlFor` had before
// `ssr-utils.ts`'s `_ATTR_NAME` fixed it there.
//
// A key the module accepts in one surface and drops in another is the bug; it
// is normalized ONCE, at merge, so `collectHead()` and the live document
// cannot disagree about it.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { collectHead, h, renderToString, useHead } from "../src/air.ts";
import { _resetHead } from "../src/air/head.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { _armTestStrict } from "../src/testing/test-strict.ts";

_armTestStrict();

function ssrHead(App: () => unknown): string {
  _resetHead();
  renderToString(h(App as never, null));
  return collectHead();
}

/** The attributes the CLIENT writer put on the head tags it owns. */
async function liveHeadAttrs(
  App: () => unknown,
): Promise<Record<string, string>[]> {
  _resetHead();
  const win = new Window({ url: "https://localhost/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const host = doc.createElement("main");
  doc.body.appendChild(host);
  const handle = mount(host, App as never);
  const out = Array.from(doc.head.querySelectorAll("[data-aio-head]")).map(
    (el) =>
      Object.fromEntries(
        Array.from(el.attributes)
          .filter((a) => a.name !== "data-aio-head")
          .map((a) => [a.name, a.value]),
      ),
  );
  _unmount(handle);
  await closeWindow(win);
  return out;
}

function Refresh() {
  useHead({
    meta: [{ httpEquiv: "refresh", content: "5;url=/next" }],
  });
  return null;
}

Deno.test("useHead: httpEquiv is written as the http-equiv attribute (server)", () => {
  assertEquals(
    ssrHead(Refresh),
    '<meta http-equiv="refresh" content="5;url=/next" data-aio-head>',
  );
});

Deno.test("useHead: httpEquiv is written as the http-equiv attribute (client)", async () => {
  assertEquals(await liveHeadAttrs(Refresh), [
    { "http-equiv": "refresh", content: "5;url=/next" },
  ]);
});

Deno.test("useHead: the hyphenated spelling is unchanged and is the SAME tag", () => {
  function App() {
    useHead({
      meta: [
        { httpEquiv: "refresh", content: "1" },
        { "http-equiv": "refresh", content: "2" },
      ],
    });
    return null;
  }
  // One identity, so the later one wins — and exactly one attribute is
  // written, never both spellings of it.
  assertEquals(
    ssrHead(App),
    '<meta http-equiv="refresh" content="2" data-aio-head>',
  );
});
