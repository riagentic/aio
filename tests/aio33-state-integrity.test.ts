// `_checkStateIntegrity` RETURNS the keys that went missing, and every test in
// this file used to throw that answer away.
//
// Four cases, each ending after the call with nothing checked but "it did not
// throw" — one of them with the comment "_diagEmit fires but function completes
// without error", which says out loud that the thing the function exists for is
// the thing not being looked at. Delete the whole missing-key loop and all four
// stayed green. (The `full` re-baseline semantics are pinned separately in
// tests/field-report-round-3.test.ts; this file is about the shape memory
// itself and its reset.)
import { assertEquals } from "@std/assert";
import { _checkStateIntegrity } from "../src/browser/browser-protocol.ts";
import { _reset } from "../src/state-core.ts";

Deno.test("state integrity: captures initial shape on first call", () => {
  _reset();
  // The FIRST state defines the shape — nothing can be missing from it.
  assertEquals(
    _checkStateIntegrity({
      ratelimit: { providers: [] },
      fleet: { members: [] },
      status: { ok: true },
    }),
    [],
  );
  // A later state carrying every key — values may change freely.
  assertEquals(
    _checkStateIntegrity({
      ratelimit: { providers: [1] },
      fleet: { members: [2] },
      status: { ok: false },
    }),
    [],
  );
});

Deno.test("state integrity: names the key that went missing", () => {
  _reset();
  _checkStateIntegrity({
    ratelimit: { providers: [] },
    fleet: { members: [] },
    status: { ok: true },
  });
  assertEquals(
    _checkStateIntegrity({
      ratelimit: { providers: [] },
      status: { ok: true },
    }),
    ["fleet"],
    "a patch that dropped a top-level key is the bug this detector is for",
  );
  // Two at once, in the order the captured shape holds them.
  assertEquals(_checkStateIntegrity({ status: { ok: true } }), [
    "ratelimit",
    "fleet",
  ]);
});

Deno.test("state integrity: skips non-object states", () => {
  _reset();
  // No shape captured yet — and none of these may capture one either, or the
  // next real state would be compared against nothing.
  for (const v of [null, undefined, 42, "hello", [1, 2, 3]]) {
    assertEquals(
      _checkStateIntegrity(v),
      [],
      `${JSON.stringify(v)} is not state`,
    );
  }
  // The first OBJECT is still the one that defines the shape.
  assertEquals(_checkStateIntegrity({ a: 1, b: 2 }), []);
  assertEquals(_checkStateIntegrity({ a: 1 }), ["b"]);
});

Deno.test("state integrity: reset clears initial shape", () => {
  _reset();
  _checkStateIntegrity({ a: 1, b: 2 });
  assertEquals(_checkStateIntegrity({ x: 10 }), ["a", "b"], "before the reset");

  _reset();
  // A new baseline: the old keys are forgotten, not still expected.
  assertEquals(_checkStateIntegrity({ x: 10, y: 20 }), []);
  assertEquals(_checkStateIntegrity({ x: 11, y: 21 }), []);
  assertEquals(_checkStateIntegrity({ x: 11 }), ["y"], "the NEW shape holds");
});
