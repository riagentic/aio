// A method that throws a null-prototype object (e.g. a parsed-JSON error body
// built with Object.create(null)) must reach the caller as ITS throw — the
// error reporter must never throw in its place (an error reporter that throws
// hides the original error).
import { assert, assertStrictEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { createAioError } from "../src/diagnostics/error.ts";

Deno.test("createAioError: a null-prototype thrown value does not throw", () => {
  const raw = Object.create(null) as Record<string, unknown>;
  raw.reason = "nope";
  let err: unknown = null;
  let threw: unknown = null;
  try {
    err = createAioError("REDUCE_ERROR", raw, { cellName: "c" });
  } catch (e) {
    threw = e;
  }
  assertStrictEquals(threw, null, `createAioError threw: ${threw}`);
  assert(err instanceof Error);
});

Deno.test("createAioError: a value whose toString throws does not throw", () => {
  const raw = {
    toString() {
      throw new Error("toString exploded");
    },
  };
  let threw: unknown = null;
  try {
    createAioError("EFFECT_ASYNC_ERROR", raw, {});
  } catch (e) {
    threw = e;
  }
  assertStrictEquals(threw, null, `createAioError threw: ${threw}`);
});

Deno.test("sync method throwing a null-prototype object: caller sees it, not a TypeError", async () => {
  const thrown = Object.create(null) as Record<string, unknown>;
  thrown.reason = "declined";
  const c = cell("unprintable-throw", {
    state: { n: 0 },
    methods: {
      boom(_s: { n: number }) {
        throw thrown;
      },
    },
  });
  await using _ = await bootCells([c]);
  let caught: unknown = undefined;
  try {
    await c.boom();
  } catch (e) {
    caught = e;
  }
  assert(caught !== undefined, "the call must reject");
  // A non-Error throw reaches the caller as an AioError carrying the value's
  // TEXT (as a thrown string does) — never the reporter's own TypeError.
  const msg = caught instanceof Error ? caught.message : String(caught);
  assert(
    !msg.includes("Cannot convert object to primitive value"),
    `the original throw was replaced by the reporter's own error: ${msg}`,
  );
  assert(msg.includes("declined"), `the app's words are kept: ${msg}`);
});
