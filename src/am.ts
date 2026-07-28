#!/usr/bin/env -S deno run -A
/**
 * @module
 * am — aio manager: process management and runtime inspection CLI.
 *
 * Thin facade — delegates to split command modules:
 * - am-cmd-process.ts: start, stop, restart, watch, status, instances
 * - am-cmd-inspect.ts: clients, sql, log, errors, metrics, health, config
 * - am-cmd-meta.ts:    version, new, help
 * - am-cmd-state.ts:   state, ui, dispatch, actions, tt, persist, snapshot
 * - am-cmd-auth.ts:    auth (users, create, unlock, revoke, …)
 *
 * ```sh
 * deno task am status
 * deno task am state --app counter
 * deno task am surface --app counter
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
  cmdTop,
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
import { cmdLink } from "./am/am-cmd-link.ts";
import { cmdFix } from "./am/am-cmd-fix.ts";
import { cmdAuth } from "./am/am-cmd-auth.ts";

import { cmdRecord } from "./am/record.ts";
import { cmdReplay, cmdTimeline } from "./am/am-cmd-timeline.ts";
import {
  cmdActions,
  cmdDispatch,
  cmdExpect,
  cmdMigrations,
  cmdPersist,
  cmdSnapshot,
  cmdState,
  cmdTT,
  cmdUi,
} from "./am/am-cmd-state.ts";

import type { CmdHandler } from "./am/am-types.ts";
import { detectMode, outError } from "./am/am-output.ts";
import { cmdBackup, cmdData, cmdRestore } from "./am/am-cmd-data.ts";
import { cmdPin } from "./am/am-cmd-pin.ts";
import { cmdCost } from "./am/am-cmd-cost.ts";
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
  expect: cmdExpect,
  record: cmdRecord,
  timeline: cmdTimeline,
  replay: cmdReplay,
  ui: cmdUi,
  dispatch: cmdDispatch,
  actions: cmdActions,
  tt: cmdTT,
  persist: cmdPersist,
  snapshot: cmdSnapshot,
  // Data — the files, not the state (see am-cmd-data.ts)
  data: cmdData,
  backup: cmdBackup,
  restore: cmdRestore,
  migrations: cmdMigrations,
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
  cost: cmdCost, // what aio moves on your behalf, and where it comes from
  top: cmdTop,
  health: cmdHealth,
  discover: cmdDiscover,
  profile: cmdProfile,
  config: cmdConfig,
  // Auth — operator console for auth: true (users, lockouts, sessions)
  auth: cmdAuth,
  // Meta
  create: cmdCreate,
  new: cmdNew,
  pin: cmdPin, // which aio version this app builds against
  link: cmdLink, // just the dep/aio symlink
  fix: cmdFix, // full clone repair (symlink + env + electron + config + …)
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
