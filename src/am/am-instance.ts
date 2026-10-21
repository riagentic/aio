/**
 * @module
 * `--instance` facts `am` needs beside the scope itself (am.ts binds that):
 * who started an instance, the start environment `am restart` replays, and
 * the throwaway data home of `am start --instance=X --fresh`.
 */
import { dirname, join, resolve } from "@std/path";
import { instanceAppsDir } from "../server/app-dirs.ts";
import {
  isOwnLock,
  type LaunchInfo,
  type LockData,
  ownerMatches,
} from "../server/single-instance-lock.ts";

// ── who started it ──────────────────────────────────────────────────────────

/** Who started an instance: `am` (its `am start` record names this very
 *  process), `other` (a terminal, a launcher, a double-click — no record, or
 *  a record of a DIFFERENT process), or `unknown` (a record written by an am
 *  older than the pid it now carries). */
export type StartedBy = "am" | "other" | "unknown";

/** Decided from the launch record `am start` writes after it spawns the
 *  child (`launch.json`: pid + kernel start stamp) — never from the process
 *  table. The pid alone is not enough (pids are reused), so a recorded
 *  start stamp that DIFFERS from the lock's means another process. A dev
 *  session's supervisor is the launched pid (`LockData.supervisor`). Pure. */
export function startedByOf(
  lock: Pick<
    LockData,
    "pid" | "ns" | "supervisor" | "startToken" | "startEpoch"
  >,
  launch: LaunchInfo | null,
): StartedBy {
  if (!launch) return "other";
  if (launch.pid === undefined) return "unknown";
  if (!isOwnLock(lock, launch.pid)) {
    // A dev session's supervisor IS the process am launched.
    return lock.supervisor !== undefined &&
        isOwnLock({ pid: lock.supervisor, ns: lock.ns }, launch.pid)
      ? "am"
      : "other";
  }
  return ownerMatches(launch, {
      token: lock.startToken ?? null,
      epoch: lock.startEpoch ?? null,
    })
    ? "am"
    : "other";
}

/** What `am stop` says after stopping an instance it did not start. */
export function notStartedByAmNote(appId: string, pid: number): string {
  return `${appId} (pid ${pid}) was not started by am — a terminal or ` +
    `launcher started it, so it may be a person's window (unsaved work ` +
    `there is theirs). Stopped as asked; \`am instances\` shows startedBy ` +
    `before a stop`;
}

// ── the start environment ───────────────────────────────────────────────────

/** Variables that decide where `am` FINDS an instance (its lock, its
 *  launch record). They are never replayed: a restart that found the record
 *  already runs under the same ones, and changing them under `am` mid-command
 *  would split am from its child. A difference is SAID. */
export const ADDRESS_ENV: readonly string[] = [
  "HOME",
  "USERPROFILE",
  "AIO_APPS_DIR",
  "XDG_RUNTIME_DIR",
];

/** Variables that decide where the app (or its own code) keeps DATA — the
 *  ones `am restart` hands the new child as they were at start. Paths only:
 *  nothing secret is ever recorded (no `AIO_*` wildcard — that family holds
 *  keystore passwords). */
export const DATA_ENV: readonly string[] = [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "AIO_PROFILE",
];

/** The recorded start env: every {@linkcode ADDRESS_ENV}/{@linkcode DATA_ENV}
 *  name → its value, or null when unset (so a restart can unset it). Pure. */
export function captureLaunchEnv(
  env: Readonly<Record<string, string>>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of [...ADDRESS_ENV, ...DATA_ENV]) out[k] = env[k] || null;
  return out;
}

/** The env a restart's child gets on top of `current`: each recorded
 *  {@linkcode DATA_ENV} value that differs (null = unset it), and the
 *  {@linkcode ADDRESS_ENV} names that differ and are NOT replayed. Pure. */
export function envReplay(
  recorded: Readonly<Record<string, string | null>> | undefined,
  current: Readonly<Record<string, string>>,
): { set: Record<string, string | null>; notReplayed: string[] } {
  const set: Record<string, string | null> = {};
  const notReplayed: string[] = [];
  if (!recorded) return { set, notReplayed };
  const now = (k: string) => current[k] || null;
  for (const k of DATA_ENV) {
    if (Object.hasOwn(recorded, k) && recorded[k] !== now(k)) {
      set[k] = recorded[k]!;
    }
  }
  for (const k of ADDRESS_ENV) {
    if (Object.hasOwn(recorded, k) && recorded[k] !== now(k)) {
      notReplayed.push(k);
    }
  }
  return { set, notReplayed };
}

/** `env` with `over` applied (null deletes). Pure. */
export function withEnv(
  env: Readonly<Record<string, string>>,
  over: Readonly<Record<string, string | null>> | undefined,
): Record<string, string> {
  const out = { ...env };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** `K=v` for a note — `K unset` for null. Pure. */
export function envWords(set: Readonly<Record<string, string | null>>): string {
  return Object.entries(set).map(([k, v]) =>
    v === null ? `${k} unset` : `${k}=${v}`
  )
    .join(" ");
}

// ── `--fresh` ───────────────────────────────────────────────────────────────

/** The throwaway data home of `am start --instance=<name> --fresh`:
 *  `~/.aio-instances/<name>/.fresh/<appId>`. Per app, so two fresh apps of
 *  one instance never share — or delete — each other's data. */
export function freshHome(instance: string, appId: string): string {
  return join(instanceAppsDir(instance), ".fresh", appId);
}

/** Is `home` the fresh home of `appId` in `instance`? Pure. */
export function isFreshHome(
  home: string | undefined,
  instance: string | undefined,
  appId: string,
): boolean {
  return home !== undefined && instance !== undefined &&
    resolve(home) === resolve(freshHome(instance, appId));
}

/** Delete the fresh home of `appId` in `instance` — that ONE directory, built
 *  from the two validated names (never a path read from anywhere), then the
 *  `.fresh` parent only when it is empty. Null on success (or nothing there);
 *  otherwise what went wrong, for the caller to say. */
export function dropFreshHome(instance: string, appId: string): string | null {
  if (!appId || /[\\/]/.test(appId) || appId === "." || appId === "..") {
    return `refusing to delete a fresh home for app id ${
      JSON.stringify(appId)
    }`;
  }
  const dir = freshHome(instance, appId);
  try {
    Deno.removeSync(dir, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      return `could not delete ${dir} (${e instanceof Error ? e.message : e})`;
    }
  }
  try {
    Deno.removeSync(dirname(dir)); // non-recursive: only an empty `.fresh`
  } catch { /* aio-ok: another app's fresh home is still there, or gone */ }
  return null;
}
