// color.ts — one decider for "does this output carry ANSI escapes?"
//
// aio printed colour unconditionally from four places, so a redirected log, a
// CI transcript, a `| grep` and a screen reader all got `\x1b[31m` wrapped
// around every word — and `NO_COLOR`, which every other CLI honours, did
// nothing anywhere. Colour is decoration: turning it off must change no
// character of the message, only whether escapes surround it.
//
// The decision lives HERE and nowhere else. A second copy is how one surface
// keeps colouring after the user asked it not to.

/** True when ANSI escapes should be emitted at all.
 *
 *  - `FORCE_COLOR` wins (a pipe that renders ANSI anyway — `less -R`, CI).
 *  - `NO_COLOR` (https://no-color.org) turns it off, whatever the value.
 *  - Otherwise: only when stdout is a real terminal.
 *  - In the browser — this module is served, `logger-format` reaches the page —
 *    and without `--allow-env`, plain text. Never a throw over decoration. */
export const colorEnabled: boolean = (() => {
  try {
    // deno-lint-ignore no-explicit-any
    const D = (globalThis as any).Deno;
    if (!D?.env) return false;
    if (D.env.get("FORCE_COLOR")) return true;
    if (D.env.get("NO_COLOR")) return false;
    return D.stdout?.isTerminal?.() ?? false;
  } catch {
    return false;
  }
})();

/** An escape code, or "" when colour is off — for palette constants that are
 *  interpolated directly (`${C.red}…${C.r}`). */
export function ansi(code: string): string {
  return colorEnabled ? code : "";
}

/** Wrap `s` in `codes`, or return it untouched when colour is off. */
export function paint(s: string, ...codes: string[]): string {
  return colorEnabled ? `${codes.join("")}${s}\x1b[0m` : s;
}
