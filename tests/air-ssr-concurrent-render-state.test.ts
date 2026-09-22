// Two server renders that overlap in time must not share state.
//
// `renderToStream` is an async generator: it calls each component when its
// chunk is PULLED, so two requests being written at once interleave at every
// `yield`. Everything the SSR path kept in a MODULE variable — the `useId`
// sequence, the `useHead` entries, the open `<select>` stack — was therefore
// one shared scope that both renders wrote into and that each one RESET when
// it started. Measured on the pre-fix tree, two interleaved streams of the
// same page (want `:r0: :r1:` for each — hydration's per-root counter restarts
// at 0, so those are the numbers the client will reproduce):
//
//   ids       A: ":r0:" ":r2:"   B: ":r1:" ":r3:"    (one counter, taken in turn)
//   <head>    collectHead() -> bob's <title>, description and canonical, for
//             BOTH responses; alice's page never had a head of its own
//   <select>  A: <option selected>red</option><option selected>blue</option>
//             — B's open <select value="blue"> scope marked A's option too
//
// Every id after the first is a hydration mismatch, so every `<label for>` /
// `aria-controls` pair the server wrote pointed at the wrong element. The head
// is one response's title and canonical URL served inside another response — a
// privacy defect, not just a rendering one.
//
// The fix is per-render state, not a lock: a render carries its own state in
// the SSR scope it already threads through every writer, so concurrency costs
// nothing and serialising SSR is never needed.

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { collectHead, h, useHead, useId } from "../src/air.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { renderToString } from "../src/air/vdom-ssr.ts";
import { _resetHead } from "../src/air/head.ts";
import { setDevMode } from "../src/air/aio-renderer.ts";
import type { VNode } from "../src/air/vdom-types.ts";

/** Pull two streams one chunk at a time, alternating — the interleaving a
 *  server produces when two requests are in flight. */
async function interleave(
  a: AsyncGenerator<string, void, unknown>,
  b: AsyncGenerator<string, void, unknown>,
): Promise<{ a: string; b: string }> {
  let outA = "";
  let outB = "";
  for (;;) {
    const ra = await a.next();
    const rb = await b.next();
    if (!ra.done) outA += ra.value;
    if (!rb.done) outB += rb.value;
    if (ra.done && rb.done) return { a: outA, b: outB };
  }
}

const Field = () => h("input", { id: useId() });

Deno.test("SSR: two interleaved streams keep their own useId sequence", async () => {
  const Page = () => h("div", null, h(Field, null), h(Field, null));
  const { a, b } = await interleave(
    renderToStream(h(Page, null)),
    renderToStream(h(Page, null)),
  );
  const want = `<div><input id=":r0:"><input id=":r1:"></div>`;
  assertEquals(a, want, "stream A ids");
  assertEquals(b, want, "stream B ids");
});

Deno.test("SSR: two interleaved streams keep their own <head>", async () => {
  const Page = (p: { name: string }) => {
    useHead({
      title: `${p.name} — site`,
      meta: [{ name: "description", content: `about ${p.name}` }],
      link: [{ rel: "canonical", href: `https://x.test/${p.name}` }],
    });
    return h("div", null, p.name);
  };
  const reqA = {};
  const reqB = {};
  const { a, b } = await interleave(
    renderToStream(h(Page, { name: "alice" }) as VNode, reqA),
    renderToStream(h(Page, { name: "bob" }) as VNode, reqB),
  );
  assertEquals(a, "<div>alice</div>");
  assertEquals(b, "<div>bob</div>");

  const headA = collectHead(reqA);
  const headB = collectHead(reqB);
  assertStringIncludes(headA, "<title>alice — site</title>");
  assertStringIncludes(headA, 'content="about alice"');
  assertStringIncludes(headA, "https://x.test/alice");
  assert(!headA.includes("bob"), `A's head leaked B's page: ${headA}`);
  assertStringIncludes(headB, "<title>bob — site</title>");
  assert(!headB.includes("alice"), `B's head leaked A's page: ${headB}`);
});

Deno.test("SSR: an interleaved stream does not mark the other render's <option>", async () => {
  const Pick = (p: { value: string }) =>
    h(
      "select",
      { value: p.value },
      h("option", null, "red"),
      h("option", null, "blue"),
    );
  const { a, b } = await interleave(
    renderToStream(h(Pick, { value: "red" }) as VNode),
    renderToStream(h(Pick, { value: "blue" }) as VNode),
  );
  assertEquals(
    a,
    `<select><option selected>red</option><option>blue</option></select>`,
  );
  assertEquals(
    b,
    `<select><option>red</option><option selected>blue</option></select>`,
  );
});

Deno.test("SSR: a lone stream's head still answers collectHead() with no argument", async () => {
  const Page = () => {
    useHead({ title: "only" });
    return h("p", null, "x");
  };
  const req = {};
  let out = "";
  for await (const c of renderToStream(h(Page, null), req)) out += c;
  assertEquals(out, "<p>x</p>");
  assertStringIncludes(collectHead(), "<title>only</title>");
  assertStringIncludes(collectHead(req), "<title>only</title>");
});

Deno.test("SSR: collectHead() with no argument REFUSES to guess between overlapped streams", async () => {
  const Page = (p: { name: string }) => {
    useHead({ title: p.name });
    return h("p", null, p.name);
  };
  const reqA = {};
  const reqB = {};
  await interleave(
    renderToStream(h(Page, { name: "alice" }) as VNode, reqA),
    renderToStream(h(Page, { name: "bob" }) as VNode, reqB),
  );
  const err = assertThrows(() => collectHead(), Error);
  assertStringIncludes((err as Error).message, "collectHead(req)");
  // …and the exact answer is always available to whoever named their render.
  assertStringIncludes(collectHead(reqA), "<title>alice</title>");
  assertStringIncludes(collectHead(reqB), "<title>bob</title>");
});

Deno.test("SSR: a renderToString inside an open stream keeps both heads intact", async () => {
  const Sync = () => {
    useHead({ title: "inner" });
    return h("i", null, "inner");
  };
  const Streamed = () => {
    useHead({ title: "outer" });
    return h("div", null, h(Field, null), h(Field, null));
  };
  const req = {};
  const s = renderToStream(h(Streamed, null), req);
  // One chunk in — the stream is open and has handed out its first id.
  const first = await s.next();
  assert(!first.done);
  const innerHtml = renderToString(h(Sync, null));
  assertEquals(innerHtml, "<i>inner</i>");
  assertStringIncludes(collectHead(), "<title>inner</title>");
  let rest = first.value;
  for (;;) {
    const r = await s.next();
    if (r.done) break;
    rest += r.value;
  }
  assertEquals(rest, `<div><input id=":r0:"><input id=":r1:"></div>`);
  assertStringIncludes(collectHead(req), "<title>outer</title>");
});

// ── the window AFTER a render ends ────────────────────────────────────
//
// Per-render state fixed what two renders do to each other WHILE both are
// open. It left the window that opens the moment one closes: a caller asks for
// its head after its own render has ended, and the first version answered with
// the most recently STARTED render — which, by then, can be a request that
// began after this one finished. Measured on that tree, two requests one after
// the other with an ordinary await between the body and the head:
//
//   for await (…renderToStream(<Page name="alice"/>)) …   // A's body, done
//   …request B starts streaming…
//   collectHead()  ->  <title>bob</title>                 // inside A's page
//
// Nothing flagged it: A and B never overlapped, so the "another render was
// live when this one started" test — the only one there was — was false for
// both. It is the SAME defect as the one this file opens with, one window
// further along, and it is silent in exactly the same way.
Deno.test("SSR: a render that started after mine ended is not mine", async () => {
  _resetHead();
  const Titled = (p: { name: string }) => {
    useHead({ title: p.name });
    return h("p", null, p.name);
  };
  let bodyA = "";
  for await (const c of renderToStream(h(Titled, { name: "alice" }) as VNode)) {
    bodyA += c;
  }
  assertEquals(bodyA, "<p>alice</p>");
  // Request B arrives in the gap between A's last chunk and A's `<head>`.
  const b = renderToStream(h(Titled, { name: "bob" }) as VNode);
  await b.next();
  assertStringIncludes(
    collectHead(),
    "<title>alice</title>",
    "A's response was served B's head",
  );
  for await (const _ of b) { /* drain B */ }
  _resetHead();
});

// A stream the consumer pulled once and then dropped — a `Promise.race` that
// timed out, a manual `next()` loop that broke — never runs its `finally`.
// The first version kept a set of renders that had started and not finished,
// so that generator stayed "live" for the life of the process and every later
// render was flagged as having overlapped it: ONE abandoned stream turned
// every no-argument `collectHead()` after it into a permanent throw, for an
// app serving one request at a time. Nothing depends on a render ever ending
// now.
Deno.test("SSR: an abandoned stream does not poison every later head", async () => {
  _resetHead();
  const Titled = (p: { name: string }) => {
    useHead({ title: p.name });
    return h("p", null, p.name);
  };
  const ghost = renderToStream(h(Titled, { name: "ghost" }) as VNode);
  await ghost.next(); // started, and then nobody ever comes back for it
  let body = "";
  for await (const c of renderToStream(h(Titled, { name: "real" }) as VNode)) {
    body += c;
  }
  assertEquals(body, "<p>real</p>");
  assertStringIncludes(collectHead(), "<title>real</title>");
  _resetHead();
});

// What end order genuinely cannot separate: two streams finish, and the first
// one's caller had not asked yet. From that moment one answer belongs to two
// responses, so there is none — and aio says so instead of serving one
// visitor's title inside another's page.
Deno.test("SSR: two heads finished and unasked-for is still a refusal", async () => {
  _resetHead();
  const Titled = (p: { name: string }) => {
    useHead({ title: p.name });
    return h("p", null, p.name);
  };
  const ra = {};
  const rb = {};
  await interleave(
    renderToStream(h(Titled, { name: "alice" }) as VNode, ra),
    renderToStream(h(Titled, { name: "bob" }) as VNode, rb),
  );
  const err = assertThrows(() => collectHead(), Error);
  assertStringIncludes((err as Error).message, "collectHead(req)");
  assertStringIncludes(collectHead(ra), "<title>alice</title>");
  assertStringIncludes(collectHead(rb), "<title>bob</title>");
  _resetHead();
});

// The keyed form's own silent failure: a key that names no render answers with
// an EMPTY head, which is exactly what a page with no `useHead` answers, so
// the two are indistinguishable from the outside. `collectHead(res)` for
// `collectHead(req)`, a `Request` cloned between the two calls, or a key given
// to one call and not the other, therefore shipped every page with no title,
// no description and no canonical — in silence, in the module whose whole job
// is the head of a page.
Deno.test("SSR: a key that names no render says so instead of an empty head", async () => {
  _resetHead();
  const Titled = () => {
    useHead({ title: "named" });
    return h("p", null, "x");
  };
  const req = {};
  for await (const _ of renderToStream(h(Titled, null) as VNode, req)) { /**/ }
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  // The warning is observe-only, so it is a DEV one — prod returns the same
  // empty head it always did.
  setDevMode(true);
  let got: string;
  try {
    got = collectHead({}); // the object that was never handed to the render
  } finally {
    console.warn = orig;
  }
  assertEquals(got, "", "an unknown key has no head to give");
  assert(
    warns.some((w) => w.includes("names no server render")),
    `the empty answer must be explained — got ${JSON.stringify(warns)}`,
  );
  // …and the key that WAS used still answers exactly, with nothing said.
  const quiet: string[] = [];
  console.warn = (...a: unknown[]) => void quiet.push(a.join(" "));
  try {
    assertStringIncludes(collectHead(req), "<title>named</title>");
  } finally {
    console.warn = orig;
  }
  assertEquals(quiet, [], "the correct call must be silent");
  _resetHead();
});
