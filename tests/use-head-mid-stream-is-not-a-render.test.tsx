/** @jsxImportSource aio */
// `useHead` from an async continuation while a stream is open is the MISTAKE,
// not a server render.
//
// Every other hook was taught to tell the two apart: they ask `_inSsrCall()`,
// which is true only for the synchronous span of one server component call, so
// a hook fired from a timer between two chunks of a `renderToStream` still
// gets the warning it exists for. `useHead` kept asking `_isSsrRendering()`,
// which stays true for the WHOLE stream, including its async gaps — so a
// `useHead` from a timer, a promise continuation or an event handler was
// silently accepted, and what it asked for was written into the head of the
// page that happened to be streaming at that moment. The title of a response
// could be changed by code that had nothing to do with it, in silence, in the
// one hook whose entire job is the head of a page.
import { assert, assertEquals } from "@std/assert";
import { collectHead, h, useHead } from "../src/air.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { _resetHead } from "../src/air/head.ts";
import { _armTestStrict } from "../src/testing/test-strict.ts";

_armTestStrict();

/** Collect `console.warn` for the span of `fn`. */
async function withWarnings(
  fn: () => Promise<void>,
): Promise<string[]> {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return warns;
}

const Page = () => {
  useHead({ title: "the page" });
  return h("div", null, "body");
};

Deno.test("useHead between two stream chunks does not reach the stream's head", async () => {
  _resetHead();
  const warns = await withWarnings(async () => {
    for await (const _chunk of renderToStream(h(Page as never, null))) {
      // A timer, a promise continuation, an event handler — anything that
      // runs in one of the stream's async gaps. It is NOT a component body.
      await new Promise((r) => setTimeout(r, 0));
      useHead({ title: "FROM A TIMER" });
    }
  });

  assertEquals(
    collectHead(),
    "<title>the page</title>",
    "the streamed page's head is what its components asked for",
  );
  assert(
    warns.some((w) =>
      w.includes("useHead() called outside a component render")
    ),
    `the mistake is reported — got ${JSON.stringify(warns)}`,
  );
  _resetHead();
});

Deno.test("useHead inside a streamed component body is still collected", async () => {
  _resetHead();
  const warns = await withWarnings(async () => {
    for await (const _chunk of renderToStream(h(Page as never, null))) {
      // drained, nothing else
    }
  });
  assertEquals(collectHead(), "<title>the page</title>");
  assertEquals(warns, [], "a component body is not a mistake");
  _resetHead();
});
