#!/usr/bin/env -S deno run -A
/**
 * @module
 * am — aio manager: process management and runtime inspection CLI.
 *
 * Thin facade — delegates to split command modules:
 * - am-cmd-process.ts: start, stop, restart, watch, status, instances
 * - am-cmd-inspect.ts: clients, click, sql, log, errors, metrics, health, config
 * - am-cmd-meta.ts:    version, new, help
 * - am-cmd-state.ts:   state, ui, dispatch, actions, tt, persist, snapshot
 *
 * ```sh
 * deno task am status
 * deno task am state --app counter
 * deno task am click "#submit"
 * ```
 */

// ── Re-exports: types ──────────────────────────────────────

export type {
  CmdHandler,
  GlobalFlags,
  OutputMode,
  Result,
} from "./am-types.ts";

/** Process lock data — PID, port, socket path, start time, and app metadata. */
export { type LockData } from "./single-instance-lock.ts";
/** Process lock file data — alias for LockData */
export type { LockData as PidFile } from "./single-instance-lock.ts";

// ── Re-exports: utilities (public API consumed by tests) ───

export { formatUptime } from "./am-output.ts";
export { detectMode, out, outError } from "./am-output.ts";
export { resolveControlPort } from "./am-http.ts";
export {
  DEFAULT_PORT,
  parsePayload,
  readPid,
  removePid,
  resolveAmAppId,
  resolveAmPort,
  resolveEntry,
  resolvePath,
  resolvePort,
  writePid,
} from "./am-utils.ts";
export { isProcessAlive } from "./single-instance-lock.ts";

// ── Command imports ────────────────────────────────────────

import {
  cmdInstances,
  cmdRestart,
  cmdStart,
  cmdStatus,
  cmdStop,
  cmdWatch,
} from "./am-cmd-process.ts";

import {
  cmdClick,
  cmdClient,
  cmdClients,
  cmdConfig,
  cmdErrors,
  cmdHealth,
  cmdInteract,
  cmdLog,
  cmdMetrics,
  cmdSchedules,
  cmdSql,
  cmdTables,
} from "./am-cmd-inspect.ts";

import { cmdHelp, cmdNew, cmdVersion } from "./am-cmd-meta.ts";

import {
  cmdActions,
  cmdDispatch,
  cmdPersist,
  cmdSnapshot,
  cmdState,
  cmdTT,
  cmdUi,
} from "./am-cmd-state.ts";

import type { CmdHandler, GlobalFlags } from "./am-types.ts";
import { detectMode, outError } from "./am-output.ts";

// ── Command map ────────────────────────────────────────────

const COMMANDS: Record<string, CmdHandler> = {
  // Process
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  status: cmdStatus,
  watch: cmdWatch,
  instances: cmdInstances,
  ls: cmdInstances,
  // State
  state: cmdState,
  ui: cmdUi,
  dispatch: cmdDispatch,
  actions: cmdActions,
  tt: cmdTT,
  persist: cmdPersist,
  snapshot: cmdSnapshot,
  // Inspect
  clients: cmdClients,
  client: cmdClient,
  click: cmdClick,
  interact: cmdInteract,
  sql: cmdSql,
  tables: cmdTables,
  schedules: cmdSchedules,
  log: cmdLog,
  logs: cmdLog,
  errors: cmdErrors,
  metrics: cmdMetrics,
  health: cmdHealth,
  config: cmdConfig,
  // Meta
  new: cmdNew,
  version: cmdVersion,
  help: (args, flags) => cmdHelp(args, flags, Object.keys(COMMANDS)),
};

// ── CLI router ─────────────────────────────────────────────

/** Parse CLI arguments into command, positional args, and global flags (--json, --quiet, --port, --app) */
export function parseGlobalFlags(
  raw: string[],
): { command: string; args: string[]; flags: GlobalFlags } {
  const flags: GlobalFlags = {};
  const rest: string[] = [];

  for (const a of raw) {
    if (a === "--json") flags.json = true;
    else if (a === "--quiet") flags.quiet = true;
    else if (a.startsWith("--port=")) {
      const v = Number(a.slice(7));
      flags.port = isNaN(v) ? undefined : v;
    } else if (a.startsWith("--body=")) flags.jsonBody = a.slice(7);
    else if (a.startsWith("--filter=")) flags.filter = a.slice(9);
    else if (a.startsWith("--lines=")) {
      const v = Number(a.slice(8));
      flags.lines = isNaN(v) ? undefined : v;
    } else if (a.startsWith("--wait=")) {
      const v = Number(a.slice(7));
      flags.wait = isNaN(v) ? undefined : v;
    } else if (a === "--wait") flags.wait = 0; // bare --wait = use default
    else if (a === "--follow" || a === "-f") flags.follow = true;
    else if (a.startsWith("--entry=")) flags.entry = a.slice(8);
    else if (a.startsWith("--transport=")) flags.transport = a.slice(12);
    else if (a.startsWith("--app=")) flags.app = a.slice(6);
    else if (a.startsWith("--client=")) {
      const v = Number(a.slice(9));
      flags.client = isNaN(v) ? undefined : v;
    } else if (
      a.startsWith("-c") && a.length > 2 && !isNaN(Number(a.slice(2)))
    ) {
      flags.client = Number(a.slice(2));
    } else if (a === "--client") flags.client = 0;
    else if (a === "--all") flags.all = true;
    else rest.push(a);
  }

  const command = rest[0] ?? "help";
  const args = rest.slice(1);
  return { command, args, flags };
}

// ── Main entry ─────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, args, flags } = parseGlobalFlags(Deno.args);
  const handler = COMMANDS[command];
  if (!handler) {
    outError(
      `unknown command: ${command} — run "am help" for usage`,
      detectMode(flags),
    );
    Deno.exit(1);
  }
  try {
    await handler(args, flags);
  } catch (e) {
    outError(String(e), detectMode(flags));
    Deno.exit(1);
  }
}

// Run if executed directly (not imported for testing)
if (import.meta.main) main();
