// The fuzzer knob contract — three fuzzers depend on it.
//
// A fuzzer is the tool you reach for precisely when you do not trust the code,
// so it has to be the thing you CAN trust. Each of the three read its env knobs
// differently and each folded an unreadable value away silently:
// `Number("2k") >>> 0` is 0, so a mistyped replay ran seed 0 and reported a
// confident green for a program nobody asked for; `round < Number("2k")` is
// false, so a sweep "passed" over ZERO programs. Both report success for a run
// that never happened.
import { assertEquals, assertThrows } from "@std/assert";
import { fuzzEnvInt } from "./fuzz-seed.ts";

/** Set an env var for the duration of `fn`, then RESTORE it — never delete it
 *  (the suite shares one process, and a deleted var is not the same as one that
 *  was never set). */
function withEnv(name: string, value: string | undefined, fn: () => void) {
  const had = Deno.env.get(name);
  try {
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
    fn();
  } finally {
    if (had === undefined) Deno.env.delete(name);
    else Deno.env.set(name, had);
  }
}

const NAME = "AIO_FUZZ_SEED_PROBE";

Deno.test("fuzz knob: absent means the default — that is what keeps CI reproducible", () => {
  withEnv(NAME, undefined, () => {
    assertEquals(fuzzEnvInt(NAME, 120), 120);
  });
});

Deno.test("fuzz knob: a readable value is used verbatim, 0 included", () => {
  withEnv(NAME, "0", () => assertEquals(fuzzEnvInt(NAME, 120), 0));
  withEnv(NAME, "3858958063", () => {
    assertEquals(fuzzEnvInt(NAME, 120), 3858958063);
  });
  withEnv(NAME, " 42 ", () => assertEquals(fuzzEnvInt(NAME, 1), 42));
});

Deno.test("fuzz knob: an UNREADABLE value throws — never a silent substitution", () => {
  for (const bad of ["abc", "2k", "", "  ", "1e6", "0x1F", "12.5", "-3"]) {
    withEnv(NAME, bad, () => {
      const e = assertThrows(() => fuzzEnvInt(NAME, 120), Error);
      // The message must name the variable AND the value, because this is read
      // off a terminal by someone who just pasted a replay line.
      const msg = String(e);
      assertEquals(
        msg.includes(NAME) && msg.includes(bad.trim() === "" ? '""' : bad) ||
          msg.includes(bad),
        true,
        `must name variable and value: ${msg}`,
      );
    });
  }
});

Deno.test("fuzz knob: a below-minimum value throws — a 0-round sweep is a vacuous green", () => {
  withEnv(NAME, "0", () => {
    assertThrows(() => fuzzEnvInt(NAME, 120, 1), Error);
  });
});
