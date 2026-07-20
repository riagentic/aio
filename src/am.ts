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

// Pure CLI script — no library exports (roadmap A1). Internals live in
// am-utils.ts / am-output.ts / am-http.ts / single-instance-lock.ts.

// ── Command imports ────────────────────────────────────────

import {
  cmdInstances,
  cmdRestart,
  cmdStart,
  cmdStatus,
  cmdStop,
  cmdWatch,
} from "./am/am-cmd-process.ts";

import {
  cmdClient,
  cmdClients,
  cmdConfig,
  cmdDiscover,
  cmdErrors,
  cmdHealth,
  cmdLog,
  cmdMetrics,
  cmdProfile,
  cmdSchedules,
  cmdSql,
  cmdSurface,
  cmdTables,
  cmdTrigger,
} from "./am/am-cmd-inspect.ts";

import {
  cmdHelp,
  cmdNew,
  cmdUninstall,
  cmdUpdate,
  cmdVersion,
} from "./am/am-cmd-meta.ts";
import { cmdCreate } from "./am/am-cmd-create.ts";

import {
  cmdActions,
  cmdDispatch,
  cmdPersist,
  cmdSnapshot,
  cmdState,
  cmdTT,
  cmdUi,
} from "./am/am-cmd-state.ts";

import type { CmdHandler } from "./am/am-types.ts";
import { detectMode, outError } from "./am/am-output.ts";
import { parseGlobalFlags } from "./am/am-utils.ts";

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
  surface: cmdSurface,
  trigger: cmdTrigger,
  sql: cmdSql,
  tables: cmdTables,
  schedules: cmdSchedules,
  log: cmdLog,
  logs: cmdLog,
  errors: cmdErrors,
  metrics: cmdMetrics,
  health: cmdHealth,
  discover: cmdDiscover,
  profile: cmdProfile,
  config: cmdConfig,
  // Meta
  create: cmdCreate,
  new: cmdNew,
  update: cmdUpdate,
  uninstall: cmdUninstall,
  version: cmdVersion,
  help: (args, flags) => cmdHelp(args, flags, Object.keys(COMMANDS)),
};

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
