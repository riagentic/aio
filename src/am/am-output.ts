/**
 * @module
 * Output formatting helpers for am — aio manager CLI.
 */

import type { GlobalFlags, OutputMode } from "./am-types.ts";
import { block, describe, dur } from "../diagnostics/fmt.ts";

export {
  block,
  bytes,
  count,
  describe,
  dur,
  fold,
  heading,
  hints,
  indent,
  kv,
  mark,
  pad,
  stack,
  statusLine,
  statusList,
  style,
  table,
  tally,
  termWidth,
  type Tone,
  width,
  wrap,
} from "../diagnostics/fmt.ts";

/** Detect output mode from CLI flags and terminal state */
export function detectMode(flags: GlobalFlags): OutputMode {
  if (flags.json) return "json";
  if (flags.quiet) return "quiet";
  return Deno.stdout.isTerminal() ? "pretty" : "json";
}

/** Formatted output — respects quiet/json/pretty mode.
 *
 *  In `json` mode the payload is ALWAYS a JSON object. A command that only has
 *  a human sentence to say used to reach `JSON.stringify("…")`, which is a
 *  JSON *string*: `am create x | tee` (and therefore every CI log and every
 *  coding agent, since a pipe IS json mode) got one long quoted line with
 *  literal `\n` escapes in it instead of data. Wrapping it as `{ message }`
 *  costs a human nothing — they see the pretty branch — and gives a parser a
 *  shape it can address. A command with real structure to report gives an
 *  object here and it is passed through untouched; that is always the better
 *  answer, and `am create` was the last one that did not.
 *
 *  `pretty` is the HUMAN rendering of the same facts — a string, or a thunk so
 *  a command never pays to format output that `--json` or `--quiet` will
 *  discard. When a command has none, the object falls through to `describe()`
 *  (the house data renderer) rather than to `JSON.stringify(x, null, 2)`,
 *  which is what `am doctor` used to answer a person with: braces, quotes and
 *  a `"findings": []`. The two branches never share a formatter, so styling
 *  the human half can never move a byte of the machine half. */
export function out(
  data: unknown,
  mode: OutputMode,
  pretty?: string | (() => string),
): void {
  if (mode === "quiet") return;
  if (mode === "json") {
    console.log(
      JSON.stringify(typeof data === "string" ? { message: data } : data),
    );
    return;
  }
  const human = typeof pretty === "function" ? pretty() : pretty;
  if (human !== undefined) console.log(human);
  else if (typeof data === "string") console.log(data);
  else console.log(describe(data));
}

/** Multi-line USAGE text — always plain, unless `--json` was asked for.
 *
 *  `out()` picks its mode from the terminal, so `am auth | less` printed the
 *  whole help as ONE JSON string: escaped newlines, wrapping quotes, unusable.
 *  Help is for a human by definition; a pipe does not change who is reading.
 *  Only an explicit `--json` (a script asking) turns it into data. */
export function usage(text: string, flags: { json?: boolean }): void {
  if (flags.json) console.log(JSON.stringify({ usage: text }));
  else console.log(text);
}

/** Error output — JSON or plain depending on mode.
 *
 *  In `--json` the error object goes to STDOUT: that is the stream a script
 *  (or an agent) parses, and an empty stdout + stderr-only error made the
 *  first diagnostic a JSONDecodeError with no cause (a field report). The
 *  non-zero exit still says "failed"; `--json` output is a superset of plain
 *  mode, never a mode that loses information.
 *
 *  `fix` is the command the reader should type next. It gets its own line
 *  under the message instead of being glued to the end of the sentence, where
 *  it used to run off the right edge of the terminal and could not be
 *  double-clicked. */
export function outError(
  msg: string,
  mode: OutputMode,
  fix?: string,
): void {
  // No early `return` here, and that is deliberate: tests/am-failure-exits
  // scans for `outError(…)` followed by a bare `return`, the pattern that ends
  // a failed command with exit 0. The guard cannot tell a definition from a
  // call site, and a gate that has to special-case its own subject is a weaker
  // gate — an `else` costs nothing and keeps it exact.
  if (mode === "json") {
    console.log(JSON.stringify(fix ? { error: msg, fix } : { error: msg }));
  } else {
    // Split into a HEADLINE and a body. A refusal is usually one sentence of
    // what happened followed by three of context, and painting the whole
    // paragraph red made none of it stand out — the reader has to find the
    // first sentence before they can decide whether to keep reading. An
    // explicit newline wins; otherwise the first sentence-ending period does.
    // `Error: ` at the head is what a caught exception carries; the glyph
    // already says it, and printing both reads as a stutter.
    msg = msg.replace(/^\s*(?:Error|TypeError|RangeError):\s*/, "");
    const nl = msg.indexOf("\n");
    const dot = /[.!?](?:\s|$)/.exec(msg);
    const cut = nl >= 0 && (!dot || nl < dot.index)
      ? nl
      : dot
      ? dot.index + 1
      : -1;
    const head = cut > 0 ? msg.slice(0, cut).trim() : msg;
    const body = cut > 0 ? msg.slice(cut).replace(/\n/g, " ").trim() : "";
    console.error(block("bad", head, body || undefined, fix, { indent: "" }));
  }
}

/** Report a failure and END the command with a non-zero exit — ONE act, so the
 *  exit code cannot drift from the message.
 *
 *  `am` is scripted against (`am create x && cd x`, `am health && deploy`), and
 *  the two halves used to be written separately at every call site: most did
 *  `outError(…); Deno.exit(1)`, but `am create`, `am new` and `am log` did
 *  `outError(…); return` — printing a refusal and then handing the shell a
 *  SUCCESS. `am create x && cd x` cd'd into a directory that was never made.
 *  Anything that is a failure goes through here; `outError` alone is for the
 *  handful of places that genuinely carry on (a warning, a poll that retries). */
export function fail(msg: string, mode: OutputMode, fix?: string): never {
  outError(msg, mode, fix);
  Deno.exit(1);
}

/** Format seconds into a human-readable uptime string (e.g. "2h 15m"). ONE
 *  spelling, shared with every other duration aio prints (`fmt.dur`), so an
 *  uptime and a build time cannot disagree about what 90 seconds looks like. */
export function formatUptime(seconds: number): string {
  // Uptime has no sub-second resolution, so a fresh process reads "0s", never
  // `dur`'s millisecond form.
  return seconds < 1 ? "0s" : dur(seconds * 1000);
}
