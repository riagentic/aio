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
  filter?: string;
  lines?: number;
  wait?: number;
  follow?: boolean;
  entry?: string;
  transport?: string;
  app?: string;
  client?: number;
  all?: boolean;
};

/** Command handler signature */
export type CmdHandler = (
  args: string[],
  flags: GlobalFlags,
) => void | Promise<void>;
