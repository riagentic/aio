// THE reader for a fuzzer's environment knobs — one decider for all of them.
//
// A sweep flag we cannot read must THROW, never shrug. `Number("2k")` is NaN,
// and every fuzzer folded that away differently and silently:
//
//   Number(env) >>> 0        → 0    ("replaying seed 3858958063" actually ran 0)
//   round < Number(env)      → false (a vacuous green over ZERO programs)
//
// Both report success for a run that never happened, which is the one outcome
// a fuzzer must never produce — you reach for it precisely when you do not
// trust the code, so it has to be the thing you CAN trust. This is the same
// silent-NaN class `parseNumArg` eradicated in `am`; it lives here so the
// three fuzzers cannot drift apart again.
//
// Absent is different from unreadable: an unset variable means "use the
// default" and is not an error, which is what keeps CI reproducible from its
// own commit while a sweep explores.

/** Read a non-negative integer knob, or throw naming the variable and value.
 *
 *  Deliberately strict — digits only. `0x1F`, `1e6`, `12.0` and `" 12 "` are
 *  all refused rather than guessed at, because a fuzzer knob is copied from a
 *  failure message and pasted into a shell, and a value that parses to
 *  something OTHER than what was written is the bug this exists to prevent. */
export function fuzzEnvInt(name: string, def: number, min = 0): number {
  const raw = Deno.env.get(name);
  if (raw === undefined) return def;
  const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n < min) {
    throw new Error(
      `${name}="${raw}" is not an integer >= ${min} — a fuzzer knob that ` +
        `cannot be read is an error, never a default: a silently-substituted ` +
        `seed reports a green for a run you did not ask for.`,
    );
  }
  return n;
}
