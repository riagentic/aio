#!/usr/bin/env -S deno run -A
/**
 * @module
 * am — aio manager: process management and runtime inspection CLI.
 *
 * Thin facade — delegates to split command modules:
 * - am-cmd-process.ts: start, stop, restart, watch, status, instances
 * - am-cmd-inspect.ts: clients, sql, log, errors, metrics, health, config
 * - am-cmd-meta.ts:    version, add, help
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
  cmdPair,
  cmdProfile,
  cmdSchedules,
  cmdSql,
  cmdSurface,
  cmdTables,
  cmdTop,
  cmdTrigger,
} from "./am/am-cmd-inspect.ts";

import {
  cmdAdd,
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
  pair: cmdPair, // a fresh single-use pairing PIN, without restarting the app
  config: cmdConfig,
  // Auth — operator console for auth: true (users, lockouts, sessions)
  auth: cmdAuth,
  // Meta
  create: cmdCreate,
  add: cmdAdd,
  new: cmdNew, // deprecated alias of `add` — prints the rename, still works
  pin: cmdPin, // which aio version this app builds against
  link: cmdLink, // just the dep/aio symlink
  fix: cmdFix, // full clone repair (symlink + env + electron + config + …)
  update: cmdUpdate,
  uninstall: cmdUninstall,
  version: cmdVersion,
  help: (args, flags) => cmdHelp(args, flags, Object.keys(COMMANDS)),
};

// ── Main entry ─────────────────────────────────────────────

/** A path-pinned app (`aioVersion: "path:<checkout>"`) uses THE PINNED
 *  CHECKOUT'S am, not the installed one — the whole point of a local-dev pin
 *  is toolchain coherence with unpushed framework+am changes (the installed
 *  am may not even know the commands the pinned framework's docs describe).
 *  Loud on stderr, opt-out via AIO_AM_NO_DELEGATE=1; version pins keep the
 *  installed am (least surprise — old checkouts may lack current commands). */
async function delegateToPathPin(): Promise<boolean> {
  if (Deno.env.get("AIO_AM_NO_DELEGATE")) return false;
  const { readPin, isPathPin, pathPinTarget } = await import(
    "./am/am-versions.ts"
  );
  const pin = await readPin(Deno.cwd());
  if (!pin || !isPathPin(pin)) return false;
  const target = pathPinTarget(pin);
  const entry = `${target}/src/am.ts`;
  try {
    await Deno.stat(entry);
  } catch {
    return false; // dangling pin — the normal flow reports it properly
  }
  // Already running from that checkout? (deno task am, or a re-exec.)
  const self = new URL(import.meta.url).pathname;
  if (self === entry) return false;
  console.error(
    `am: path pin — using the pinned checkout's am (${target}). ` +
      `AIO_AM_NO_DELEGATE=1 uses the installed am instead.`,
  );
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", `${target}/deno.json`, entry, ...Deno.args],
    env: { ...Deno.env.toObject(), AIO_AM_NO_DELEGATE: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  Deno.exit((await p.status).code);
}

async function main(): Promise<void> {
  await delegateToPathPin();
  const { command, args, flags } = parseGlobalFlags(Deno.args);
  if (flags.error) {
    outError(flags.error, detectMode(flags));
    Deno.exit(1);
  }
  // `am <anything> --help` answers with usage, never with a command result.
  if (flags.help) {
    await COMMANDS.help!(command === "help" ? args : [command, ...args], flags);
    Deno.exit(0);
  }
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
