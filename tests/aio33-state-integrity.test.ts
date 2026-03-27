import { assertEquals } from "@std/assert";
import { _checkStateIntegrity, _reset } from "../src/browser.ts";

Deno.test("state integrity: captures initial shape on first call", () => {
  _reset();

  // First valid state captures shape
  _checkStateIntegrity({
    ratelimit: { providers: [] },
    fleet: { members: [] },
    status: { ok: true },
  });

  // Second call with all keys present — no warning (no throw = pass)
  _checkStateIntegrity({
    ratelimit: { providers: [1] },
    fleet: { members: [2] },
    status: { ok: false },
  });
});

Deno.test("state integrity: detects missing key without crashing", () => {
  _reset();

  // Capture initial shape
  _checkStateIntegrity({
    ratelimit: { providers: [] },
    fleet: { members: [] },
    status: { ok: true },
  });

  // Call with fleet missing — _diagEmit fires but function completes without error
  _checkStateIntegrity({ ratelimit: { providers: [] }, status: { ok: true } }); // fleet missing
});

Deno.test("state integrity: skips non-object states", () => {
  _reset();

  // These should all be no-ops (no crash)
  _checkStateIntegrity(null);
  _checkStateIntegrity(undefined);
  _checkStateIntegrity(42);
  _checkStateIntegrity("hello");
  _checkStateIntegrity([1, 2, 3]);
});

Deno.test("state integrity: reset clears initial shape", () => {
  _reset();

  // Capture shape with key "a"
  _checkStateIntegrity({ a: 1, b: 2 });

  // Reset — should clear initial shape
  _reset();

  // Now capture new shape with different keys — no warning about missing "a"/"b"
  _checkStateIntegrity({ x: 10, y: 20 });
  _checkStateIntegrity({ x: 11, y: 21 }); // all keys present, no issue
});
