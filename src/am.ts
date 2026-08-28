#!/usr/bin/env -S deno run -A
/**
 * @module
 * am — aio manager: process management and runtime inspection CLI.
 *
 * Thin facade — delegates to split command modules:
 * - am-cmd-process.ts: start, stop, restart, watch, status, instances, ui
 * - am-cmd-inspect.ts: clients, sql, log, errors, metrics, health, config
 * - am-cmd-meta.ts:    version, add, help
 * - am-cmd-state.ts:   state (+--ui), dispatch, actions, tt, persist, snapshot
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
  cmdKill,
  cmdRestart,
  cmdStart,
  cmdStatus,
  cmdStop,
  cmdUi,
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
  cmdOpen,
  cmdPair,
  cmdProfile,
  cmdSchedules,
  cmdSql,
  cmdSurface,
  cmdTables,
  cmdTop,
  cmdTrigger,
} from "./am/am-cmd-inspect.ts";

import { cmdAdd, cmdHelp, cmdUninstall, cmdVersion } from "./am/am-cmd-meta.ts";
import { cmdCreate } from "./am/am-cmd-create.ts";
import { cmdPublish } from "./am/am-cmd-publish.ts";
import { cmdTrust } from "./am/am-cmd-trust.ts";
import { cmdLink } from "./am/am-cmd-link.ts";
import { cmdFix } from "./am/am-cmd-fix.ts";
import { cmdDoctor } from "./am/am-cmd-doctor.ts";
import { cmdAuth } from "./am/am-cmd-auth.ts";

import { cmdRecord } from "./am/record.ts";
import { cmdReplay, cmdTimeline } from "./am/am-cmd-timeline.ts";
import { cmdReport } from "./am/am-cmd-report.ts";
import {
  cmdActions,
  cmdDispatch,
  cmdExpect,
  cmdMigrations,
  cmdPersist,
  cmdSnapshot,
  cmdState,
  cmdTT,
} from "./am/am-cmd-state.ts";

import type { CmdHandler } from "./am/am-types.ts";
import { detectMode, outError } from "./am/am-output.ts";
import { cmdInstalled, cmdRemove, cmdUpgrade } from "./am/am-cmd-remove.ts";
import { cmdBackup, cmdData, cmdRestore } from "./am/am-cmd-data.ts";
import { cmdPin } from "./am/am-cmd-pin.ts";
import { cmdTheme } from "./am/am-cmd-theme.ts";
import { cmdCost } from "./am/am-cmd-cost.ts";
import { cmdShot } from "./am/am-cmd-shot.ts";
import { cmdLab } from "./am/am-cmd-lab.ts";
import { parseGlobalFlags, resolveAmAppId, targetHome } from "./am/am-utils.ts";
import { PATH_PIN_PREFIX } from "./am/am-versions.ts";
import { removedAmVerb, retiredSpellingLine } from "./state/removals.ts";
import { readDenoJsonSync, readLocalPinSync } from "./server/deno-json.ts";

// ── Command map ────────────────────────────────────────────

const COMMANDS: Record<string, CmdHandler> = {
  // Process
  start: cmdStart,
  stop: cmdStop,
  kill: cmdKill,
  restart: cmdRestart,
  status: cmdStatus,
  watch: cmdWatch,
  instances: cmdInstances,
  // State
  state: cmdState,
  expect: cmdExpect,
  record: cmdRecord,
  timeline: cmdTimeline,
  replay: cmdReplay,
  ui: cmdUi, // opens amui (the visual manager); the projection is `state --ui`
  open: cmdOpen, // opens THIS app — the thing `ui` does not do
  dispatch: cmdDispatch,
  actions: cmdActions,
  timetravel: cmdTT,
  persist: cmdPersist,
  snapshot: cmdSnapshot,
  // Data — the files, not the state (see am-cmd-data.ts)
  data: cmdData,
  backup: cmdBackup,
  restore: cmdRestore,
  migrations: cmdMigrations,
  report: cmdReport,
  // Inspect
  clients: cmdClients,
  client: cmdClient,
  surface: cmdSurface,
  trigger: cmdTrigger,
  shot: cmdShot,
  sql: cmdSql,
  tables: cmdTables,
  schedules: cmdSchedules,
  logs: cmdLog,
  errors: cmdErrors,
  metrics: cmdMetrics,
  cost: cmdCost, // what aio moves on your behalf, and where it comes from
  top: cmdTop,
  health: cmdHealth,
  doctor: cmdDoctor, // is the RUNNING app on the aio that is on disk?
  discover: cmdDiscover,
  profile: cmdProfile,
  pair: cmdPair, // a fresh single-use pairing PIN, without restarting the app
  config: cmdConfig,
  // Auth — operator console for auth: true (users, lockouts, sessions)
  auth: cmdAuth,
  // Meta
  create: cmdCreate,
  // build → ship → the channel directory a client actually fetches. The one
  // step of the release that lived only in prose (see am-cmd-publish.ts).
  publish: cmdPublish,
  add: cmdAdd,
  pin: cmdPin, // which aio version this app builds against
  lab: cmdLab, // a REAL Windows/macOS desktop in a container, driven by hand
  theme: cmdTheme, // adopt aio's stylesheet INTO the app, as a file it owns
  link: cmdLink, // just the dep/aio symlink
  fix: cmdFix, // full clone repair (symlink + env + electron + config + …)
  uninstall: cmdUninstall,
  remove: cmdRemove, // an installed APP; `uninstall` is am itself
  installed: cmdInstalled,
  upgrade: cmdUpgrade, // am itself / an installed app / a dev checkout
  version: cmdVersion,
  trust: cmdTrust,
  help: (args, flags) => cmdHelp(args, flags, Object.keys(COMMANDS)),
};

/** What `am <verb>` says for a verb it does not have. A verb that USED to
 *  exist (alpha70 kept one spelling per command: `instances` not `ls`,
 *  `logs` not `log`, `timetravel` not `tt`, `publish` not `release`,
 *  `upgrade` not `update`, `add` not `new`) answers with the new spelling in
 *  one line — read from the removals registry, never forwarded silently.
 *  Pure. @internal */
export function unknownCommandLine(command: string): string {
  const r = removedAmVerb(command);
  return r
    ? retiredSpellingLine(r)
    : `unknown command: ${command} — run "am help" for usage`;
}

// ── Main entry ─────────────────────────────────────────────

/** A path-pinned app (`aioVersion: "path:<checkout>"`) uses THE PINNED
 *  CHECKOUT'S am, not the installed one — the whole point of a local-dev pin
 *  is toolchain coherence with unpushed framework+am changes (the installed
 *  am may not even know the commands the pinned framework's docs describe).
 *  Loud on stderr, opt-out via AIO_AM_NO_DELEGATE=1; version pins keep the
 *  installed am (least surprise — old checkouts may lack current commands). */
async function delegateToPathPin(): Promise<boolean> {
  if (Deno.env.get("AIO_AM_NO_DELEGATE")) return false;
  const { isPathPin, pathPinTarget } = await import("./am/am-versions.ts");
  // QUIET read. `readPin` goes through the framework's pin reader, which
  // announces "local path pin → …" once per PROCESS — and delegation is a
  // second process, so a delegated command printed the line twice (parent,
  // then child). The decision to hand off needs the value, not the
  // announcement; the am that does the work says it, once.
  const pin = readPinQuiet(Deno.cwd());
  if (!pin || !isPathPin(pin)) return false;
  const target = pathPinTarget(pin);
  const entry = `${target}/src/am.ts`;
  try {
    await Deno.stat(entry);
  } catch {
    return false; // dangling pin — the normal flow reports it properly
  }
  // Already running from that checkout? (deno task am, or a re-exec.) By REAL
  // path: `deno task am` runs `./dep/aio/src/am.ts`, and in a repaired app
  // dep/aio is a symlink to the pinned checkout — the same file under two
  // spellings. Comparing the spellings re-exec'd the identical am on every
  // invocation, with the hand-off note (and the pin line) printed each time.
  if (sameFile(new URL(import.meta.url).pathname, entry)) return false;
  // A checkout from before the per-machine override (`.aio/pin.local`)
  // cannot read the pin that just selected it — its am would see an unpinned
  // app and re-seal it. Stay on the installed am and say so, rather than
  // hand off to a tool that will undo the setup.
  try {
    const dj = await Deno.readTextFile(`${target}/src/server/deno-json.ts`);
    if (!dj.includes("LOCAL_PIN_FILE")) {
      console.error(
        `am: note: path pin — the pinned checkout (${target}) predates ` +
          `.aio/pin.local, so the installed am runs instead of its own.`,
      );
      return false;
    }
  } catch {
    // No src/server/deno-json.ts at all: not a layout we can date (a marker
    // checkout, a trimmed one) — nothing there can re-seal the app, delegate.
  }
  console.error(
    `am: note: path pin — using the pinned checkout's am (${target}). ` +
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

/** The pin as {@linkcode readFrameworkPinSync} resolves it, without its
 *  one-line announcement: `.aio/pin.local` first, then deno.json's
 *  `aioVersion`. Same precedence, no side effect — pure over the two files.
 *  @internal */
export function readPinQuiet(dir: string): string | null {
  const local = readLocalPinSync(dir);
  if (local !== null) return `${PATH_PIN_PREFIX}${local}`;
  try {
    const v = readDenoJsonSync(dir)?.config.aioVersion;
    return typeof v === "string" && v !== "" ? v : null;
  } catch {
    return null;
  }
}

/** Two paths name one file — through symlinks. A path that does not exist
 *  is compared as spelled.
 *  @internal */
export function sameFile(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return Deno.realPathSync(p);
    } catch {
      return p;
    }
  };
  return a === b || real(a) === real(b);
}

async function main(): Promise<void> {
  await delegateToPathPin();
  const { command, args, flags } = parseGlobalFlags(Deno.args);
  if (flags.error) {
    outError(flags.error, detectMode(flags));
    Deno.exit(1);
  }
  // `--home=<dir>` targets the instance running from that data home. Bound
  // here, once, before any command resolves a lock — see `targetHome`.
  if (flags.home !== undefined) {
    if (!flags.home) {
      outError("--home needs a directory: --home=<dir>", detectMode(flags));
      Deno.exit(1);
    }
    targetHome(resolveAmAppId(flags.app), flags.home);
  }
  // `am <anything> --help` answers with usage, never with a command result.
  if (flags.help) {
    await COMMANDS.help!(command === "help" ? args : [command, ...args], flags);
    Deno.exit(0);
  }
  // `--version` / `-v` / `-V` are what every other CLI answers to, and they are
  // the FIRST thing anyone types to check an install worked. `am` answered
  // `{"error":"unknown command: --version"}` — a JSON error, in the first
  // sixty seconds, to a question that has an obvious answer. The onboarding lab
  // caught it because the installer verifies `am` by asking it its version.
  const cmd = /^--?(version|V)$/i.test(command) ? "version" : command;
  const handler = COMMANDS[cmd];
  if (!handler) {
    outError(unknownCommandLine(command), detectMode(flags));
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
