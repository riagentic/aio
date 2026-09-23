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
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { collectHead, h, useHead, useId } from "../src/air.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import {
  _isSsrRendering,
  _registerSsrCapture,
  renderToString,
} from "../src/air/vdom-ssr.ts";
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

// ── a client that went away (found by the SSR soak) ─────────────────────
//
// A stream whose consumer RETURNED it — a closed tab — ends with nobody
// left to ask for its head. It used to count like any other finished page:
// as the neighbour that made the NEXT request's no-argument answer a refusal
// (one closed tab, one 500 — in an app serving one request at a time), and
// as the no-argument answer itself.

const Titled = (p: { name: string }) => {
  if (p.name !== "headless") useHead({ title: p.name });
  return h("div", null, h("p", null, p.name), h("p", null, "more"));
};
async function drain(name: string, key?: object): Promise<void> {
  for await (const _ of renderToStream(h(Titled, { name }) as VNode, key)) {
    /* the whole body */
  }
}
async function closeTab(name: string): Promise<void> {
  const gone = renderToStream(h(Titled, { name }) as VNode);
  await gone.next(); // its head is registered…
  await gone.return(); // …and the client went away
}
function silently<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.warn;
  const said: string[] = [];
  console.warn = (...a: unknown[]) => void said.push(a.join(" "));
  return fn().finally(() => {
    console.warn = orig;
    assertEquals(said, [], "collectHead() said something");
  });
}

// A closed tab's caller is gone, so once another request has set up its
// render, the tab's head is nobody's: 1.0.9 handed it to whoever asked next —
// a visitor who had left's title, inside another page.
Deno.test("SSR: a closed tab's head is not the no-argument answer once another render is set up", async () => {
  _resetHead();
  await silently(async () => {
    await drain("mine");
    assertStringIncludes(collectHead(), "<title>mine</title>");
    await closeTab("gone"); // aborted after mine was answered
    const next = renderToStream(h(Titled, { name: "next" }) as VNode);
    assertEquals(collectHead(), ""); // mine's caller again: was gone's title
    for await (const _ of next) { /* the next request, streamed */ }
    assertStringIncludes(collectHead(), "<title>next</title>"); // no refusal
  });
  _resetHead();
});

// With nothing set up since, the one who asks may be the code that stopped
// reading its own stream — a `break` out of the loop. It gets that render's
// head, exactly as in 1.0.9.
Deno.test("SSR: breaking out of your own stream, then asking, answers as 1.0.9", async () => {
  _resetHead();
  await silently(async () => {
    const gen = renderToStream(h(Titled, { name: "Mine" }) as VNode);
    for await (const c of gen) if (c.includes("Mine")) break;
    assertStringIncludes(collectHead(), "<title>Mine</title>");
  });
  _resetHead();
});

// Nor the page before it: that page's caller may be the one asking AGAIN, and
// B's head in A's response is exactly the leak the refusal exists to stop.
// (Found by a hunt: an earlier version answered with the last completed page,
// here Bob's — 1.0.9 answered with the closed tab's empty head.)
Deno.test("SSR: a closed tab never hands out the page before it", async () => {
  _resetHead();
  await silently(async () => {
    await drain("Alice-private"); // A: finished, caller not asked yet
    await drain("Bob-private"); // B: finished after A, superseded
    await closeTab("headless"); // C: headless, client leaves
    assertEquals(collectHead(), ""); // A's caller: never Bob's head
  });
  _resetHead();
});

// A closed tab next to the page after it is still 1.0.9's neighbour: its
// caller could not be told from the next one's, so the next page's
// no-argument head is REFUSED — loud, where any answer could be the wrong
// visitor's. The key is exact.
Deno.test("SSR: a closed tab still makes the next page's no-argument head refused", async () => {
  _resetHead();
  await silently(async () => {
    await drain("before");
    assertStringIncludes(collectHead(), "<title>before</title>");
    await closeTab("gone");
    const req = {};
    await drain("next", req);
    const err = assertThrows(() => collectHead(), Error);
    assertStringIncludes((err as Error).message, "collectHead(req)");
    assertStringIncludes(collectHead(req), "<title>next</title>");
  });
  _resetHead();
});

// ── what 1.0.9 answered or refused, unchanged ──────────────────────────
//
// Pinned from two independent reviews of an earlier, wider version of this
// ledger, which refused or warned about each of these in apps that render one
// request at a time. Same answers as 1.0.9, and not a word said.

Deno.test("SSR: 1.0.9 answers — a head collected mid-render, then the next page", async () => {
  _resetHead();
  let mid = "";
  const Probe = () => {
    mid = collectHead();
    return h("i", null, "x");
  };
  await silently(async () => {
    for await (
      const _ of renderToStream(
        h("div", null, h(Titled, { name: "A" }), h(Probe, null)) as VNode,
      )
    ) { /**/ }
    await drain("B");
    assertStringIncludes(collectHead(), "<title>B</title>");
    assertStringIncludes(collectHead(), "<title>B</title>");
  });
  assertStringIncludes(mid, "<title>A</title>");
  _resetHead();
});

Deno.test("SSR: 1.0.9 answers — a fragment endpoint that never asks, then pages", async () => {
  _resetHead();
  await silently(async () => {
    await drain("frag"); // uses useHead; its handler never asks
    for (let i = 0; i < 3; i++) {
      assertEquals(
        renderToString(h(Titled, { name: `s${i}` }) as VNode),
        `<div><p>s${i}</p><p>more</p></div>`,
      );
      assertStringIncludes(collectHead(), `<title>s${i}</title>`);
      assertStringIncludes(collectHead(), `<title>s${i}</title>`); // twice
    }
    await drain("Q");
    assertStringIncludes(collectHead(), "<title>Q</title>");
    await drain("Q2");
    assertStringIncludes(collectHead(), "<title>Q2</title>");
  });
  _resetHead();
});

Deno.test("SSR: 1.0.9 answers — pages asked twice behind unasked fragments", async () => {
  _resetHead();
  await silently(async () => {
    await drain("headless");
    await drain("P");
    assertStringIncludes(collectHead(), "<title>P</title>");
    assertStringIncludes(collectHead(), "<title>P</title>");
    await drain("F");
    const q = {};
    await drain("headless", q);
    assertEquals(collectHead(), "");
    assertEquals(collectHead(q), "");
  });
  _resetHead();
});

Deno.test("SSR: 1.0.9 answers — an error handler collecting a thrown page's head", async () => {
  _resetHead();
  const Boom = () => {
    throw new Error("boom");
  };
  await silently(async () => {
    await drain("headless");
    try {
      for await (
        const _ of renderToStream(
          h("div", null, h(Titled, { name: "Y" }), h(Boom, null)) as VNode,
        )
      ) { /**/ }
    } catch { /* the handler's catch… */ }
    assertStringIncludes(collectHead(), "<title>Y</title>"); // …asks
  });
  _resetHead();
});

Deno.test("SSR: 1.0.9 refuses — a thrown page and the page after it; a keyed neighbour", async () => {
  _resetHead();
  const Boom = () => {
    throw new Error("boom");
  };
  const a = renderToStream(
    h("div", null, h(Titled, { name: "A" }), h(Boom, null)) as VNode,
  );
  const b = renderToStream(h(Titled, { name: "B" }) as VNode);
  await a.next();
  await b.next();
  try {
    for await (const _ of a) { /**/ }
  } catch { /* A's handler has its own catch */ }
  for await (const _ of b) { /**/ }
  // B's caller, and then A's error handler: either could be asking.
  assertThrows(() => collectHead(), Error);
  assertThrows(() => collectHead(), Error);
  _resetHead();
  const k = {};
  await drain("A");
  await drain("K", k);
  await drain("B");
  assertStringIncludes(collectHead(k), "<title>K</title>");
  assertThrows(() => collectHead(), Error); // A's caller
  assertThrows(() => collectHead(), Error); // B's caller
  _resetHead();
});

// ── renderToStream sets up at the CALL, and fails at the first pull ────
//
// The request's route, key and nesting are taken when the stream is created
// (see the HTTP route test in air-ssr-soak.test.ts). What that set-up throws
// must still surface where the old `async function*` surfaced it — from the
// first `next()`, never from the call — or a handler that creates the body
// inside one try and reads it in another sees the error move.

Deno.test("SSR stream: a key that cannot key a render fails at the first pull, not at the call", async () => {
  _resetHead();
  // An earlier test in this file leaves a stream open on purpose (ghost).
  const wasRendering = _isSsrRendering();
  const gen = renderToStream(h("p", null, "x"), 42 as unknown as object);
  assertEquals(typeof gen.next, "function"); // the call itself returned
  await assertRejects(() => gen.next(), TypeError);
  assertEquals(await gen.next(), { done: true, value: undefined });
  assertEquals(_isSsrRendering(), wasRendering);
  _resetHead();
});

Deno.test("SSR stream: a request snapshot that throws fails at the first pull, not at the call", async () => {
  _resetHead();
  const wasRendering = _isSsrRendering();
  const id = Symbol("test.throwingCapture");
  let armed = true;
  _registerSsrCapture(id, () => {
    if (armed) throw new Error("capture exploded");
    return null;
  });
  try {
    const gen = renderToStream(h("p", null, "x"));
    armed = false; // the error was taken at the call, and is held
    await assertRejects(() => gen.next(), Error, "capture exploded");
    assertEquals(_isSsrRendering(), wasRendering);
    // And the next stream, set up without the error, renders.
    let out = "";
    for await (const c of renderToStream(h("p", null, "y"))) out += c;
    assertEquals(out, "<p>y</p>");
  } finally {
    armed = false;
    _resetHead();
  }
});

// The end-of-turn re-read of the request values can throw too (a capture that
// fails on the second read). Held, and thrown from the first pull — never a
// silent fall back to the call-time snapshot.
Deno.test("SSR stream: a request value that throws when re-read fails the first pull", async () => {
  _resetHead();
  const id = Symbol("test.throwsOnReread");
  let armed = false;
  _registerSsrCapture(id, () => {
    if (armed) throw new Error("re-read exploded");
    return null;
  });
  try {
    // Settled at the first pull, still in the call's turn.
    const a = renderToStream(h("p", null, "a"));
    armed = true;
    await assertRejects(() => a.next(), Error, "re-read exploded");
    // Settled by the end-of-turn microtask, then pulled later.
    armed = false;
    const b = renderToStream(h("p", null, "b"));
    armed = true;
    await Promise.resolve();
    armed = false;
    await assertRejects(() => b.next(), Error, "re-read exploded");
  } finally {
    armed = false;
    _resetHead();
  }
});
