/** @jsxImportSource aio */
// A `<meta>`'s identity is WHICH attribute names it plus what that attribute
// says — `name=description`, not `description`.
//
// The value alone was the key, so two tags naming different things through
// different attributes collided and one was silently dropped: the pair Google's
// own markup asks for (`<meta name="description">` beside
// `<meta itemprop="description">`) shipped as ONE tag, and so did
// `{ name: "twitter:title" }` beside `{ property: "twitter:title" }`. The docs
// list `name` / `property` / `http-equiv` / `charset` / `itemprop` as
// alternative identity SOURCES — an identity is one of them AND its value.
//
// Both writers are held to it: `collectHead()` (the server) and the live
// document (the client), because a page that disagrees with its own server
// render is the divergence this renderer reports the loudest.
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

/** The same head, written into a live document by the client path. */
async function liveHead(App: () => unknown): Promise<string> {
  _resetHead();
  const win = new Window({ url: "https://localhost/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const host = doc.createElement("main");
  doc.body.appendChild(host);
  const handle = mount(host, App as never);
  const out = Array.from(doc.head.querySelectorAll("[data-aio-head]"))
    .map((el) => el.outerHTML.replace(/ data-aio-head=""/, " data-aio-head"))
    .join("");
  _unmount(handle);
  await closeWindow(win);
  return out;
}

function ThreeDescriptions() {
  useHead({
    meta: [
      { name: "description", content: "for search engines" },
      { itemprop: "description", content: "for structured data" },
      { property: "og:description", content: "for shares" },
    ],
  });
  return null;
}

Deno.test("useHead: name/itemprop/property with the same value are three tags, not one", async () => {
  const expected =
    '<meta name="description" content="for search engines" data-aio-head>' +
    '<meta itemprop="description" content="for structured data" data-aio-head>' +
    '<meta property="og:description" content="for shares" data-aio-head>';
  assertEquals(ssrHead(ThreeDescriptions), expected);
  assertEquals(await liveHead(ThreeDescriptions), expected);
});

Deno.test("useHead: one name, two spellings of the same thing, still dedups", () => {
  // The documented rule this must not break: a page's `description` REPLACES
  // a layout's, because they are the same identity.
  function Page() {
    useHead({ meta: [{ name: "description", content: "page" }] });
    return null;
  }
  function Layout() {
    useHead({ meta: [{ name: "description", content: "layout" }] });
    return h("div", null, h(Page, null));
  }
  assertEquals(
    ssrHead(Layout),
    '<meta name="description" content="page" data-aio-head>',
  );
});

Deno.test("useHead: two names that differ only by attribute keep both positions", () => {
  function App() {
    useHead({
      meta: [
        { property: "twitter:title", content: "og-style" },
        { name: "twitter:title", content: "name-style" },
      ],
    });
    return null;
  }
  assertEquals(
    ssrHead(App),
    '<meta property="twitter:title" content="og-style" data-aio-head>' +
      '<meta name="twitter:title" content="name-style" data-aio-head>',
  );
});
