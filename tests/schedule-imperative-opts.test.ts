// `aio.run({ schedules })` refuses a non-number duration by name and teaches
// the fix. `schedule.backoff`/`schedule.poll` did the arithmetic first, so the
// same typo became `NaN` and travelled: it surfaced later as
// `schedule.after '<id>': ms must be finite` — naming an API the app never
// called and a key it never wrote. Non-finite always threw; it threw the wrong
// sentence, somewhere else.
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { schedule } from "../src/state/schedule.ts";

// deno-lint-ignore no-explicit-any
const S = schedule as any;
const A = { type: "c:tick" };

const msgOf = (fn: () => unknown): string => assertThrows(fn, Error).message;

Deno.test("poll names ITS OWN api and key, not schedule.after", () => {
  const m = msgOf(() => S.poll("refresh", 1, A, { every: undefined }));
  assertStringIncludes(m, "schedule.poll 'refresh'");
  assertStringIncludes(m, "every is missing");
  // the old text, from the wrong door
  assertEquals(m.includes("schedule.after"), false);
});

Deno.test("a CLI-style duration teaches the plain-number fix", () => {
  const m = msgOf(() => S.poll("refresh", 0, A, { every: "5m" }));
  assertStringIncludes(m, 'every is string "5m"');
  assertStringIncludes(m, "write 300_000");
});

Deno.test("backoff names base, factor and max separately", () => {
  assertStringIncludes(
    msgOf(() => S.backoff("retry", 1, A, {})),
    "schedule.backoff 'retry': base is missing",
  );
  assertStringIncludes(
    msgOf(() => S.backoff("retry", 1, A, { base: 100, factor: "2" })),
    'factor is string "2"',
  );
  assertStringIncludes(
    msgOf(() => S.backoff("retry", 1, A, { base: 100, max: null })),
    "max is null",
  );
});

// JSON.stringify(NaN) is `null`, so the classic `${typeof v} ${stringify(v)}`
// rendered the likeliest bad duration of all as "number null".
Deno.test("NaN and Infinity are named, not rendered as null", () => {
  assertStringIncludes(
    msgOf(() => S.backoff("retry", 1, A, { base: NaN })),
    "base is number NaN",
  );
  assertStringIncludes(
    msgOf(() => S.poll("p", 0, A, { every: Infinity })),
    "every is number Infinity",
  );
});

// The refusal must not narrow what already worked: every valid shape keeps the
// exact delay it produced before.
Deno.test("valid options are unchanged", () => {
  assertEquals(S.poll("p", 0, A, { every: 1000 }).ms, 1000);
  assertEquals(S.poll("p", 2, A, { every: 1000, factor: 2 }).ms, 4000);
  assertEquals(
    S.poll("p", 9, A, { every: 1000, factor: 2, max: 5000 }).ms,
    5000,
  );
  assertEquals(S.backoff("b", 0, A, { base: 250 }).ms, 250);
  assertEquals(S.backoff("b", 3, A, { base: 250 }).ms, 2000);
  assertEquals(S.backoff("b", 3, A, { base: 250, factor: 3 }).ms, 6750);
  assertEquals(S.backoff("b", 30, A, { base: 250, max: 60_000 }).ms, 60_000);
  // a negative attempt is clamped to 0, as before
  assertEquals(S.backoff("b", -5, A, { base: 250 }).ms, 250);
});
