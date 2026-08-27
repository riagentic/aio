/**
 * @module
 * Output formatting helpers for am — aio manager CLI.
 */

import type { GlobalFlags, OutputMode } from "./am-types.ts";

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
 *  answer, and `am create` was the last one that did not. */
export function out(data: unknown, mode: OutputMode): void {
  if (mode === "quiet") return;
  if (mode === "json") {
    console.log(
      JSON.stringify(typeof data === "string" ? { message: data } : data),
    );
  } else {
    if (typeof data === "string") console.log(data);
    else console.log(JSON.stringify(data, null, 2));
  }
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
 *  mode, never a mode that loses information. */
export function outError(msg: string, mode: OutputMode): void {
  if (mode === "json") console.log(JSON.stringify({ error: msg }));
  else console.error(`error: ${msg}`);
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
export function fail(msg: string, mode: OutputMode): never {
  outError(msg, mode);
  Deno.exit(1);
}

/** Format seconds into human-readable uptime string (e.g. "2h 15m 30s") */
export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
