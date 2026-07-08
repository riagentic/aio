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
