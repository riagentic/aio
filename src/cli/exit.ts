// exit.ts — exit codes as ONE vocabulary, and `fail` as one act.
//
// `am` learned the hard way that "print the error" and "exit non-zero" written
// as two statements drift apart (src/am/am-output.ts `fail`): a refusal
// followed by `return` hands the shell a SUCCESS. Same rule here — a failure
// is one call, and it never returns.

import { type CliIO, defaultIO } from "./io.ts";

/** Exit codes: `ok` 0 · `error` 1 (the command failed) · `usage` 2 (the
 *  invocation was wrong — unknown flag, missing argument, no terminal). */
export const EXIT = { ok: 0, error: 1, usage: 2 } as const;

/** Options for {@link fail}. */
export type FailOptions = {
  /** Exit code — default `EXIT.error`. */
  code?: number;
  /** `--json` mode: the error goes to STDOUT as `{"error": msg}`, the stream a
   *  script parses (same rule as `am --json`). Plain mode: `error: msg` on stderr. */
  json?: boolean;
  /** Injected streams (tests). */
  io?: CliIO;
};

/** Report `msg` and END the process with a non-zero code — never returns. */
export function fail(msg: string, opts: FailOptions = {}): never {
  const io = opts.io ?? defaultIO();
  if (opts.json) io.out(JSON.stringify({ error: msg }) + "\n");
  else io.err(`error: ${msg}\n`);
  return io.exit(opts.code ?? EXIT.error);
}
