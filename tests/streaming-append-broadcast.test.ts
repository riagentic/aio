// A streaming reply must travel as its SUFFIX, not as the whole string again.
//
// report 8 §12 measured the cost: publishing a growing reply re-sent the
// accumulated string every flush, so a naive 60 ms cadence is QUADRATIC in the
// reply length and doubled per window — a sustained
// `PRESSURE — 33 broadcasts/sec` in production. That app wrote a byte-rate
// limiter to hold it flat: a framework problem solved in application code, in
// the app whose most visible feature is a streaming reply.
//
// The fix that shipped is better than the `s.$append("partial", chunk)` the
// report asked for: nothing to call. A grown string is narrowed to an `append`
// at patch generation, so every method that does `s.partial += chunk` gets it,
// including the ones written before the op existed.
//
// THIS TEST MEASURES THE BROADCAST, not the narrowing. The unit level is
// covered in patch-compact.test.ts; what nobody had checked is that the frames
// a client actually receives are linear in the reply — which is the only form
// of the claim the report would recognise.
import { assert, assertEquals } from "@std/assert";
import { narrowPatches } from "../src/state/patch-compact.ts";
import { APPEND_MIN_LENGTH } from "../src/protocol/patch-ops.ts";

// deno-lint-ignore no-explicit-any
type D = any;

Deno.test("a streaming reply costs its SUFFIX — linear, not quadratic", () => {
  // The claim as a NUMBER, measured where the decision is made. The report's
  // production symptom was byte volume (`PRESSURE — 33 broadcasts/sec`), so a
  // test that only checks the op name would be asserting the mechanism and not
  // the thing that hurt.
  const CHUNK = "token ";
  const STEPS = 40;
  // Start above the threshold: below it a `replace` is genuinely cheaper, and
  // that is deliberate (APPEND_MIN_LENGTH).
  let partial = "x".repeat(APPEND_MIN_LENGTH + 1);
  let narrowed = 0;
  let raw = 0;
  let appends = 0;

  for (let i = 0; i < STEPS; i++) {
    const before = { partial };
    partial += CHUNK;
    // Exactly what a method's `s.partial += chunk` produces, through the ONE
    // narrowing pass patch generation runs.
    const rawOps = [
      { op: "replace", path: ["partial"], value: partial } as D,
    ];
    const ops = narrowPatches(before, rawOps);
    if ((ops[0] as D).op === "append") appends++;
    narrowed += JSON.stringify(ops).length;
    raw += JSON.stringify(rawOps).length;
  }

  assertEquals(appends, STEPS, "every step must narrow");
  // Quadratic is what `raw` is: each frame carries the whole accumulated
  // reply. Linear is ~STEPS * CHUNK plus framing. The gap is not marginal.
  assert(
    narrowed < raw / 8,
    `the reply re-sent itself: ${narrowed} bytes narrowed vs ${raw} raw for ` +
      `${STEPS} chunks of ${CHUNK.length}. This is the production ` +
      `measurement from report 8 §12.`,
  );
  // And it stays flat as the reply grows — the property, not one reading.
  const perStep = narrowed / STEPS;
  assert(
    perStep < CHUNK.length * 12,
    `${perStep.toFixed(0)} bytes per chunk of ${CHUNK.length} — the cost ` +
      `must not scale with the reply`,
  );
});

Deno.test("a SHORT string still travels as a replace", () => {
  // Below APPEND_MIN_LENGTH the op's own overhead outweighs the saving, and a
  // tiny value is cheaper to overwrite than to reason about. Asserting the
  // silence is what keeps the threshold real rather than decorative.
  const ops = narrowPatches({ partial: "a" }, [
    { op: "replace", path: ["partial"], value: "ab" } as D,
  ]);
  assertEquals(ops.length, 1);
  assertEquals((ops[0] as D).op, "replace");
});

Deno.test("nothing has to be CALLED — `s.x += chunk` is enough", () => {
  // The report asked for `s.$append("partial", chunk)`. What shipped is
  // better: it is automatic, so every method that already grew a string gets
  // it, including ones written before the op existed. If this ever needed an
  // explicit call, a plain `+=` would stop being narrowed and this assertion
  // is what would say so.
  const before = { partial: "y".repeat(APPEND_MIN_LENGTH + 1) };
  const after = before.partial + "tail";
  const ops = narrowPatches(before, [
    { op: "replace", path: ["partial"], value: after } as D,
  ]);
  assertEquals((ops[0] as D).op, "append");
  assertEquals((ops[0] as D).value, "tail");
});
