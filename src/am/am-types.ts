/**
 * @module
 * Type definitions for am — aio manager CLI.
 */

/** Output format for am CLI commands */
export type OutputMode = "pretty" | "json" | "quiet";

/** Result wrapper — success with data or failure with error message */
export type Result<T = unknown> = { ok: true; data: T } | {
  ok: false;
  error: string;
};

/** CLI global flags — port, output mode, filtering, and app targeting options. */
export type GlobalFlags = {
  /** Set when a global flag could not be parsed (e.g. `--port=80a0`).
   *  `am` exits loud on it before running any command — a flag we cannot
   *  read is an error, never a silent default. */
  error?: string;
  port?: number;
  json?: boolean;
  quiet?: boolean;
  jsonBody?: string;
  /** `--args='["a", 2]'` — the POSITIONAL argument list for a cell method,
   *  verbatim. The one spelling that can express a method taking a single
   *  string (`--args='["192.168.1.9"]'`), which no `key=value` form can. */
  jsonArgs?: string;
  filter?: string;
  lines?: number;
  wait?: number;
  follow?: boolean;
  entry?: string;
  transport?: string;
  app?: string;
  client?: number;
  all?: boolean;
  /** `am state --ui` — the filtered UI-state projection (was `am ui`). */
  ui?: boolean;
  /** `--help`/`-h` anywhere → print usage and exit 0. Without this the flag
   *  fell through to the subcommand's positionals and was silently ignored —
   *  `am dispatch --help` answered `{"ok":true}`, which reads as "your
   *  dispatch worked" (a field report). */
  help?: boolean;
};

/** Command handler signature */
export type CmdHandler = (
  args: string[],
  flags: GlobalFlags,
) => void | Promise<void>;
