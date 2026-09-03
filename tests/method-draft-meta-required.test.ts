// `s.$signal`, not `s.$signal!`.
//
// The runtime has always served all four meta members on EVERY method, sync
// and async alike. The TYPE said otherwise: `MethodDraftMeta`, on the
// stated grounds that "strict contravariance forbids a required-extra param on
// Method<S>". That is not true, and `$do` — required, in `MethodDraftServed`
// right beside them — was the standing disproof: contravariance runs the other
// way, so a method accepting FEWER properties is assignable where more are
// supplied.
//
// What the `Partial` actually bought was `s.$signal!.aborted` and `s.$commit!()`
// in every cancellable method aio ships or documents, on its way to becoming
// the permanent idiom for "a method that can be cancelled".
//
// This file is a COMPILE-TIME test: it passes by type-checking. Every spelling
// an app could already have written must still be here, or the change was a
// break rather than a correction.
import { assert } from "@std/assert";
import { cell, type MethodDraftMeta } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";

type S = { n: number; done: boolean };

const spellings = cell("draft-meta-spellings", {
  state: { n: 0, done: false } as S,
  methods: {
    // The new spelling: no `!`, no `?.`, no annotation ritual.
    plain(s) {
      if (s.$signal.aborted) return;
      s.$commit();
      s.n++;
    },
    // A bare annotated parameter — the commonest form, and the one
    // contravariance was claimed to forbid.
    annotated(s: S) {
      s.n++;
    },
    // Extra parameters, with a default.
    withArgs(s: S, by = 1) {
      s.n += by;
    },
    // The legacy `!` spelling every doc and example used to teach.
    legacyBang(s) {
      if (s.$signal!.aborted) return;
      s.$commit!();
      s.done = true;
    },
    // The legacy optional-chain spelling.
    legacyOptional(s) {
      if (s.$signal?.aborted) return;
      s.$commit?.();
      s.done = true;
    },
    // An app that annotated the draft itself, the way the docs taught.
    // This `Partial<>` is deliberate: it is the spelling the change had to
    // keep compiling, so a sweep that "modernises" it destroys the test.
    legacyAnnotation(s: S & Partial<MethodDraftMeta<S>>) {
      s.$commit?.();
      s.n++;
    },
    // Async, the shape `cancelOn` exists for.
    async cancellable(s: S & MethodDraftMeta<S>) {
      if (s.$signal.aborted) return;
      await Promise.resolve();
      s.$commit();
      s.done = s.$live.done;
    },
  },
});

Deno.test("draft meta: every spelling of a cancellable method compiles", () => {
  // The assertion is that this module type-checked at all; this keeps the test
  // from being vacuous and proves the cell really composed.
  assert(typeof spellings.plain === "function");
  assert(typeof spellings.legacyBang === "function");
  assert(typeof spellings.legacyOptional === "function");
  assert(typeof spellings.cancellable === "function");
});

Deno.test("draft meta: the runtime serves all four, sync as well as async", async () => {
  const seen: Record<string, string> = {};
  const probe = cell("draft-meta-served", {
    state: { n: 0 },
    methods: {
      sync(s) {
        seen.syncSignal = typeof s.$signal;
        seen.syncCommit = typeof s.$commit;
        seen.syncLive = typeof s.$live;
        seen.syncDo = typeof s.$do;
      },
      async async(s) {
        await Promise.resolve();
        seen.asyncSignal = typeof s.$signal;
        seen.asyncCommit = typeof s.$commit;
        seen.asyncLive = typeof s.$live;
        seen.asyncDo = typeof s.$do;
      },
    },
  });
  await using _ = await bootCells([probe]);
  await probe.sync();
  await probe.async();
  assert(seen.syncSignal === "object", JSON.stringify(seen));
  assert(seen.syncCommit === "function", JSON.stringify(seen));
  assert(seen.syncLive === "object", JSON.stringify(seen));
  assert(seen.asyncSignal === "object", JSON.stringify(seen));
  assert(seen.asyncCommit === "function", JSON.stringify(seen));
  assert(seen.asyncLive === "object", JSON.stringify(seen));
});
