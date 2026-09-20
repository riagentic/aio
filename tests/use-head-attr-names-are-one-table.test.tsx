/** @jsxImportSource aio */
// `useHead` spells an attribute the way every other render path spells it.
//
// `_htmlAttrs` was a SECOND decider: a hand-written rule for `httpEquiv`
// alone, beside `attrNameOf`, the table the client patcher, hydration and both
// SSR writers share. Two deciders only ever disagree — and this pair already
// did, in two ways:
//
//   - A mapping added to the table did not reach `<head>`.
//   - The rule dropped what it was meant to keep. It asked whether the
//     hyphenated key was absent, decided it was, and then re-applied the tag's
//     own `"http-equiv": undefined` OVER its answer, so a tag built by
//     spreading a base that mentions the key erased the very attribute the
//     camelCase spelling asked for: `<meta content="5">`, no refresh, in
//     silence.
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
  const out = collectHead();
  _resetHead();
  return out;
}

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
  _setDocument(undefined as never);
  _resetHead();
  return out;
}

// A helper that sets `http-equiv` only sometimes leaves the key present and
// undefined; the camelCase spelling beside it still has to be honoured.
const base: Record<string, string | undefined> = {
  "http-equiv": undefined,
  content: "5",
};
const Spread = () => {
  useHead({ meta: [{ ...base, httpEquiv: "refresh" }] });
  return h("div", null);
};

Deno.test("useHead: a key present-and-undefined does not erase the camelCase one (server)", () => {
  assertEquals(
    ssrHead(Spread),
    `<meta http-equiv="refresh" content="5" data-aio-head>`,
  );
});

Deno.test("useHead: …and the live document agrees", async () => {
  assertEquals(
    await liveHead(Spread),
    `<meta http-equiv="refresh" content="5" data-aio-head>`,
  );
});

// The table, not a copy of one entry of it: `acceptCharset` was added to
// `attrNameOf` and `<head>` has to have got it for free.
const FromTheTable = () => {
  useHead({
    link: [{ rel: "search", href: "/o.xml", acceptCharset: "utf-8" }],
  });
  return h("div", null);
};

Deno.test("useHead: head tags use the same attribute-name table as elements", async () => {
  const want =
    `<link rel="search" href="/o.xml" accept-charset="utf-8" data-aio-head>`;
  assertEquals(ssrHead(FromTheTable), want);
  assertEquals(await liveHead(FromTheTable), want);
});
