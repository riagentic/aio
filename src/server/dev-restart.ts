// dev-restart.ts — dev auto-restart when a CELL file changes.
//
// JSX hot-reloads; cells can't. They run in the server process, so an edited
// cell keeps its old logic while the browser shows new UI — the silent mismatch
// that sends people ghost-hunting. Until now aio warned and asked you to restart
// by hand. Now it restarts itself.
//
// How, without stacking processes: the first restart turns THIS process into a
// thin supervisor. It re-launches the app as a child (marked with
// AIO_DEV_SUPERVISED) and waits. When the child wants to restart it exits with
// RESTART_EXIT_CODE and the supervisor launches a fresh one — so the depth is
// always at most two, no matter how many times you edit a cell.
//
// Honesty rules (dev==prod doctrine):
// - dev only, never in prod, never in libraryMode (a test/host owns the process)
// - only when the process holds ALL permissions, i.e. it was started with `-A`.
//   A narrower grant can't be reconstructed from Deno.permissions (a partial
//   `--allow-read=/x` reads back as "prompt"), and re-launching with `-A` would
//   silently WIDEN permissions. Then we fall back to the warning.
// - opt out with AIO_NO_DEV_RESTART=1

import { dirname, fromFileUrl } from "@std/path";
import { log } from "../diagnostics/logger-api.ts";
import {
  instances,
  isLockOwnerAlive,
  type LockData,
  lockKey,
  ownerIdentity,
  readLock,
  removeLockIf,
  replaceLockIf,
  resolveAppId,
} from "./single-instance-lock.ts";

/** Exit code a supervised child uses to ask for a fresh process. 75 =
 *  EX_TEMPFAIL — "try again", and outside the range apps use for errors. */
export const RESTART_EXIT_CODE = 75;

const CHILD_ENV = "AIO_DEV_SUPERVISED";
const OPT_OUT_ENV = "AIO_NO_DEV_RESTART";

/** A child that dies THIS soon after a relaunch did not crash — it never got
 *  to run: the file just saved does not load (a syntax error, a bad import).
 *  That is a failed restart, and the answer to it is "fix the file", not "your
 *  dev server is gone". A child that ran longer and then died crashed for its
 *  own reasons, and its exit code is passed through exactly as before. */
export const FAILED_RESTART_WINDOW_MS = 15_000;

/** A restart-code exit THIS soon after the spawn is not a developer saving a
 *  file — nobody edits twice in a second. It is a loop: an external formatter,
 *  an editor's own watcher, or a second aio watcher touching a cell file, each
 *  touch asking for another restart. Left alone that spawns processes as fast
 *  as the machine allows. */
export const RESTART_STORM_MS = 1_000;

/** Consecutive storm-speed restarts tolerated before the supervisor throttles
 *  and says why. Five is comfortably above any real save burst. */
export const RESTART_STORM_LIMIT = 5;

/** How long the supervisor waits before each restart once a storm is
 *  detected — enough that a runaway toolchain costs one process per interval
 *  instead of a fork bomb, short enough that a real edit still lands fast. */
export const RESTART_STORM_COOLDOWN_MS = 5_000;

/** The delay before the next respawn, given how many storm-speed restarts have
 *  happened back to back. Pure — the throttle is a unit test, not a stopwatch. */
export function restartThrottleDelay(rapidStreak: number): number {
  return rapidStreak >= RESTART_STORM_LIMIT ? RESTART_STORM_COOLDOWN_MS : 0;
}

/** Source extensions whose change ends the wait after a failed restart. */
const SOURCE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".json",
  ".jsonc",
  ".css",
]);

const PERMISSIONS: Deno.PermissionName[] = [
  "read",
  "write",
  "net",
  "env",
  "run",
  "sys",
  "ffi",
];

/** Why a restart can't happen — null when it can. Pure-ish (queries the
 *  process's own permissions and argv, changes nothing). */
export async function restartBlockedReason(): Promise<string | null> {
  if (env(OPT_OUT_ENV) === "1") return `${OPT_OUT_ENV}=1`;
  if (!Deno.mainModule.startsWith("file:")) {
    return "the entry module is not a local file";
  }
  for (const name of PERMISSIONS) {
    let state: Deno.PermissionState;
    try {
      state = (await Deno.permissions.query({ name })).state;
    } catch {
      return `permission "${name}" could not be queried`;
    }
    if (state !== "granted") {
      // A partial grant reads as "prompt" — we can't reproduce it, and
      // re-launching with -A would hand the app more than it was given.
      return `the process was not started with -A (no full "${name}" permission)`;
    }
  }
  return null;
}

/** Read an env var without exploding when env access is denied. */
function env(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** True when this process is already a supervised child. */
export const isSupervisedChild = (): boolean => env(CHILD_ENV) === "1";

/** This process's REAL argv (minus argv[0]), when the OS exposes it.
 *
 *  `Deno.args` contains only what the *script* was given: the runtime flags
 *  (`--unstable-*`, `--env-file`, `-c/--config`, `--import-map`, `--watch`) are
 *  consumed by the deno CLI and never appear there. A synthesized
 *  `run -A <entry>` therefore restarts a DIFFERENT process than the one the
 *  developer started — an app that needs `--unstable-ffi` or an `--env-file`
 *  comes back broken, and nothing says why. Where the kernel hands us the true
 *  command line, replay it verbatim instead of guessing at it. */
async function realArgv(): Promise<string[] | null> {
  if (Deno.build.os !== "linux") return null; // /proc/self/cmdline is Linux-only
  try {
    const parts = (await Deno.readTextFile("/proc/self/cmdline"))
      .split("\0").filter((s) => s.length > 0);
    // Only replay a real `deno run`. Anything else (`deno test`, a compiled
    // binary, a wrapper) is not the command that starts THIS app, and
    // re-running it would launch something else entirely.
    return parts[1] === "run" ? parts.slice(1) : null;
  } catch {
    return null; // no /proc, no read permission — fall back below
  }
}

/** The synthesized fallback: everything a process CAN see about itself. */
const synthesizedArgs = (): string[] => [
  "run",
  "-A",
  fromFileUrl(Deno.mainModule),
  ...Deno.args,
];

/** The argv that re-launches this app — the process's own command line where
 *  that is readable, else `deno run -A <entry> <args…>`. */
export async function relaunchArgs(): Promise<string[]> {
  return (await realArgv()) ?? synthesizedArgs();
}

let _restarting = false;

/** True from the moment a cell-change restart begins in THIS process until it
 *  exits (supervised child) or has become the supervisor — it never goes back
 *  to false. Everything the restart's own teardown ends is EXPECTED while this
 *  is true: the Electron window `shutdown()` kills is the case. Its exit used
 *  to be read by the launch-time status handler as "the user closed the
 *  window" and answered with `stopProcess(0)` — in the process that had just
 *  become the supervisor, so the relaunched child followed its dead parent
 *  two seconds later and a cell edit under `--client=electron` ended the dev
 *  session (field report cc §5). */
export const isRestarting = (): boolean => _restarting;

/** What the restarted app must inherit from the one being torn down. */
export interface RestartCarry {
  /** The TCP port the app is bound to — read at restart time, after the
   *  listener has answered (`undefined` = no TCP port: a zero-port electron
   *  app, which the relaunch reproduces by naming none). */
  port?: () => number | undefined;
}

/** The environment a supervised child is spawned with — pure, so the carry
 *  is a unit test rather than a stopwatch.
 *
 *  `AIO_PORT` is THE port the relaunched app binds. A dev app that named no
 *  port got a free one from the runtime — and the runtime picked a DIFFERENT
 *  free one after every cell edit, so every open tab was orphaned on the old
 *  port while the terminal said "restarting the app" as if nothing moved.
 *  `--port=N` never had the problem (the flag is replayed in argv); an
 *  unnamed port is carried the one way a process with no command line to
 *  hang a flag on can be told its port: the env rung of the port chain
 *  (`envPort()` in paths.ts — the same reader a service unit or a container
 *  uses). A flag or an app-config port still wins over it or equals it, so
 *  the carry can never move an app that named its port. */
export function supervisorEnv(
  supervisorPid: number,
  port: number | undefined,
): Record<string, string> {
  return {
    [CHILD_ENV]: "1",
    // Die with the supervisor. Without this the child is a plain orphan:
    // close the terminal (or `kill -9` the supervisor) and the supervisor
    // goes while the CHILD survives — holding the port and the
    // single-instance lock with nothing supervising it, so the next
    // `deno task dev` is refused with "Already running" and the developer
    // has to hunt the pid. Headless apps make it worse: they deliberately
    // ignore SIGHUP so an unattended app survives a closed shell
    // (aio-lifecycle.ts), which is right for `nohup` and exactly wrong
    // here. `AIO_PARENT_PID` is the mechanism that already exists for this
    // (electron-spawn.ts sets it for the same reason) — the supervised
    // child is the case it was written for.
    AIO_PARENT_PID: String(supervisorPid),
    ...(port !== undefined && port > 0 ? { AIO_PORT: String(port) } : {}),
  };
}

/** Restart the app process because `path` changed. Tears the app down first
 *  (releasing the port and flushing persistence), then either exits for the
 *  supervisor to respawn, or becomes the supervisor itself. Never returns —
 *  except when a restart is impossible, where it warns and returns instead so
 *  the dev session simply continues as before. */
export async function restartForCellChange(
  path: string,
  shutdown: () => Promise<void>,
  carry: RestartCarry = {},
): Promise<void> {
  // Claimed synchronously: an editor save often produces two FS events, and
  // both would otherwise get past an await and restart twice.
  if (_restarting) return;
  _restarting = true;
  const blocked = await restartBlockedReason();
  const file = path.split("/").pop() ?? path;
  // The watcher also restarts for the server ENTRY (routes, schedules, auth
  // live there) and for a plain module the server imports — name each as
  // what it is.
  const real = (p: string): string => {
    try {
      return Deno.realPathSync(p);
    } catch {
      return p;
    }
  };
  const declaresCell = (): boolean => {
    try {
      return /\bcell\s*\(\s*["'`]/.test(Deno.readTextFileSync(path));
    } catch {
      return false;
    }
  };
  const what = Deno.mainModule.startsWith("file://") &&
      real(fromFileUrl(Deno.mainModule)) === real(path)
    ? "server entry"
    : declaresCell()
    ? "cell file"
    : "server module";
  if (blocked) {
    _restarting = false;
    log.warn(
      "watch",
      `${what} changed (${file}) — it runs in the server process and does ` +
        `NOT hot-reload, and auto-restart is off (${blocked}). Restart to ` +
        `apply: stop and re-run \`deno task dev\`. (Client JSX hot-reloads, ` +
        `so you may be seeing new UI on old cell logic.)`,
    );
    return;
  }
  log.info("watch", `${what} changed (${file}) — restarting the app`);
  // Read BEFORE the shutdown releases the listener: afterwards there is no
  // bound port to read.
  const port = carry.port?.();
  // …and this process's own lock, for the same reason: WHICH app this is
  // (appId, home, profile — the lock key) is what the supervisor needs to
  // hand the lock slot to its child and to recognise a rival start.
  const self = ownLock();
  try {
    await shutdown();
  } catch (e) {
    log.warn("watch", `shutdown before restart failed: ${e}`);
  }
  if (isSupervisedChild()) {
    Deno.exit(RESTART_EXIT_CODE); // the supervisor launches the next one
  }
  await superviseForever(port, self);
}

/** This process's lock, read before the shutdown removes it — null when it
 *  holds none (an app booted with `singleton: false`) or it cannot be read. */
function ownLock(): LockData | null {
  try {
    const mine = instances().find((i) => i.pid === Deno.pid);
    return mine ? readLock(lockKey(mine.appId, mine.home, mine.profile)) : null;
  } catch {
    return null; // aio-ok: no lock dir — the supervisor runs without a slot
  }
}

/** The lock of `self`'s app home as it stands, by the same key. */
const slotOf = (self: LockData): string =>
  lockKey(self.appId, self.home, self.profile);

/** Put the RELAUNCHED child in the lock slot the old app just vacated.
 *
 *  Between the old app's shutdown (its lock gone) and the child's own
 *  acquire (a module graph later — seconds), nothing named the app: `am
 *  restart` in that window saw it NOT running, started a second instance on
 *  a NEW port, and the child lost the race. A placeholder naming the child
 *  (the way `am start` files one for its own child) makes the app visible
 *  the whole time — as `starting`, on the port it is about to bind — so
 *  `am restart` stops IT and reuses that port, and `am stop` reaches it.
 *  Create-or-replace-a-dead-owner only: never over a live lock (a rival
 *  start that took the slot keeps it), never over the child's own. */
function fileChildPlaceholder(
  self: LockData,
  child: number,
  port: number | undefined,
): string | null {
  try {
    const data: LockData = {
      ...self,
      pid: child,
      port: port ?? self.port,
      status: "starting",
      startedAt: Date.now(),
      startToken: undefined,
      startEpoch: undefined,
      socketPath: undefined,
      trojanPort: undefined,
      ...ownerIdentity(child),
    };
    const seen = readLock(slotOf(self));
    const wrote = !seen
      ? replaceLockIf(null, data)
      : seen.pid !== child && !isLockOwnerAlive(seen) &&
        replaceLockIf(seen, data);
    // The BYTES written — what `replaceLockIf` stores — so only this exact
    // placeholder is ever taken back (see the removal after the child exits).
    return wrote ? JSON.stringify(data) : null;
  } catch (e) {
    // aio-ok: the child still takes the slot itself when it boots — only the
    // window stays open; said, not swallowed.
    log.warn("watch", `could not file the relaunch's lock placeholder: ${e}`);
    return null;
  }
}

/** A LIVE instance of `self`'s app home that is neither this supervisor nor
 *  its child `child` — a rival start (`am restart`, `am start`, a second
 *  `deno task dev`) that took the slot. `null` without a known `self`. */
function rivalOf(self: LockData | null, child: number): LockData | null {
  if (!self) return null;
  try {
    const l = readLock(slotOf(self));
    return l && l.pid !== child && l.pid !== Deno.pid && isLockOwnerAlive(l)
      ? l
      : null;
  } catch {
    return null; // aio-ok: unreadable slot — nothing to step aside for
  }
}

/** Become the supervisor: launch the app as a child, relaunch it whenever it
 *  exits asking for a restart, and pass any other exit code through. `port`
 *  is the TCP port the first app was on — every child binds the same one. */
async function superviseForever(
  port: number | undefined,
  self: LockData | null,
): Promise<never> {
  const real = await realArgv();
  const args = real ?? synthesizedArgs();
  if (!real) {
    // Say it before the first respawn, not after the child fails: a dropped
    // `--unstable-kv` shows up as an unrelated crash three seconds later.
    log.warn(
      "watch",
      `restarting as \`deno run -A ${
        args.slice(2).join(" ")
      }\` — a process cannot read the runtime flags it was started with ` +
        `(--unstable-*, --env-file, -c/--config, --import-map), so they are ` +
        `NOT carried into the restarted app. If yours needs them, stop the ` +
        `watcher and restart by hand.`,
    );
  }
  const stop = { child: null as Deno.ChildProcess | null };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(sig, () => {
        try {
          stop.child?.kill(sig);
        } catch { /* already gone */ }
        Deno.exit(0);
      });
    } catch { /* signal not supported here */ }
  }
  // SIGHUP — the supervisor must not be the weakest link in its own session.
  //
  // A headless app IGNORES SIGHUP on purpose (`aio-lifecycle.ts`: "the one
  // role whose entire purpose is running unattended must not need a wrapper to
  // do it"). The moment a cell edit turns that process into a supervisor its
  // app has shut down and released that listener, so the supervisor is a plain
  // process again — SIGHUP's default action TERMINATES it — while the child it
  // spawned still ignores SIGHUP. Two seconds later the child's parent watch
  // fires and kills the app: "parent process N is gone (AIO_PARENT_PID) —
  // shutting down", with nothing left to restart it and a message that blames
  // a pid. Measured end to end on this shape (a field report saw it three
  // times in one session): the mechanism that keeps an app alive across a cell
  // edit was defeating the one that keeps it alive across a hang-up.
  //
  // Forwarded, never swallowed: the CHILD decides, exactly as it does for
  // SIGINT/SIGTERM. A headless child ignores it and the session goes on; a
  // terminal-attached one dies on the default action, and the loop's own exit
  // rules below then take the supervisor with it — which is the documented
  // "a dev server attached to a terminal SHOULD go when the terminal does".
  try {
    Deno.addSignalListener("SIGHUP", () => {
      // NO CHILD, NO FORWARDING — and then this process is a plain process
      // again, so it takes the hang-up itself. Forwarding replaced SIGHUP's
      // default action for the supervisor's whole life, including the stretch
      // that has no child at all: `waitForSourceChange()`, which is unbounded
      // by design (the saved file does not load, so the loop waits for the
      // next save). Closing the terminal there swallowed the hang-up outright
      // and left an orphaned supervisor with a recursive `Deno.watchFs`,
      // outliving the session that started it with nothing to show for it.
      if (!stop.child) Deno.exit(0);
      try {
        stop.child.kill("SIGHUP");
      } catch {
        // aio-ok: the child exited between the read and the kill — there is
        // nothing left to forward the hang-up to, and the loop below is
        // already awaiting its status.
      }
    });
  } catch {
    // aio-ok: a platform with no SIGHUP (windows). Nothing can send one, so
    // there is nothing to forward and nothing to report.
  }
  let rapidStreak = 0;
  let saidStorm = false;
  while (true) {
    const spawnedAt = Date.now();
    const child = new Deno.Command(Deno.execPath(), {
      args,
      env: supervisorEnv(Deno.pid, port),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    stop.child = child;
    const placed = self ? fileChildPlaceholder(self, child.pid, port) : null;
    const status = await child.status;
    stop.child = null;
    // A placeholder the child never replaced names a dead pid now — gone,
    // so the next reader does not report an abrupt end that did not happen.
    // THAT placeholder only, byte for byte: a lock the child wrote itself
    // is left exactly as it ended — a graceful stop removed it already, and
    // one still there after a SIGKILL or an OOM kill is the evidence the next
    // boot reports ("did not shut down cleanly"). Removing it by pid made
    // that end silent.
    if (self && placed !== null) removeLockIf(slotOf(self), placed);
    if (status.code === RESTART_EXIT_CODE) {
      // Same `spawnedAt` guard the crash branch below uses. A restart that
      // arrives within a second of the spawn was not asked for by a human.
      rapidStreak = Date.now() - spawnedAt < RESTART_STORM_MS
        ? rapidStreak + 1
        : 0;
      const delay = restartThrottleDelay(rapidStreak);
      if (delay > 0 && !saidStorm) {
        saidStorm = true;
        log.warn(
          "watch",
          `${rapidStreak} restarts in under ${
            RESTART_STORM_MS / 1000
          }s each — something other than you is touching a cell file ` +
            `(an editor's format-on-save, a second watcher, a generator). ` +
            `Throttling to one restart every ${
              RESTART_STORM_COOLDOWN_MS / 1000
            }s so this does not spawn processes without end. Fix: stop the ` +
            `other writer, or set ${OPT_OUT_ENV}=1 to turn auto-restart off ` +
            `and restart by hand.`,
        );
      }
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    rapidStreak = 0;
    saidStorm = false;
    // A signal ended it: `am kill`, a `kill -9`, Ctrl-C reaching the child
    // directly. Someone wanted it dead; the supervisor goes too. A clean 0 is
    // `am stop` or the window closing — same answer. A crash after it had
    // been running is the app's own business and its code passes through.
    if (
      status.signal || status.code === 0 ||
      Date.now() - spawnedAt > FAILED_RESTART_WINDOW_MS
    ) {
      Deno.exit(status.code);
    }
    // It died right after the relaunch because ANOTHER start of this app
    // took the slot first (`am restart` / `am start` in the window before the
    // child booted): the child was refused, and that instance IS the app now.
    // Waiting for a save here left an app-less process no lock names —
    // invisible to `am instances`, `am stop` and `am kill --stale`.
    const rival = rivalOf(self, child.pid);
    if (rival) stepAside(rival.pid);
    // It died right after the relaunch: the file that was just saved does not
    // load. This used to be `Deno.exit(1)` — a typo mid-edit ended the dev
    // session, and nothing on screen said the watcher was gone. Stay up, say
    // so, relaunch on the next save.
    log.error(
      "watch",
      `the app exited with code ${status.code} right after the restart — ` +
        `the file you saved most likely does not load (syntax or import ` +
        `error above). The dev session stays up: fix it and save, and the ` +
        `app relaunches. Ctrl-C to quit.`,
    );
    // …and a rival that shows up WHILE waiting ends the wait too: the lock
    // slot is polled beside the watcher, never only after the next save.
    const late = await waitForSourceChange(() => rivalOf(self, 0)?.pid ?? null);
    if (late !== null) stepAside(late);
    // While we waited, `am start` (or a second `deno task dev`) may have
    // brought the app up on its own. Relaunching would only be refused with
    // "Already running" — say which process owns it and step aside.
    const other = otherInstancePid();
    if (other !== null) {
      log.warn(
        "watch",
        `another instance of this app is running (pid ${other}) — this dev ` +
          `session ends; that one is the app now`,
      );
      Deno.exit(0);
    }
  }
}

/** Resolve on the first change to a source file under the entry's directory
 *  (recursive), after a short settle so a save that lands in two events is one
 *  relaunch. Best-effort by design: if the watch cannot be set up the wait
 *  ends immediately and the relaunch happens (at worst it fails again and
 *  this runs again). */
async function waitForSourceChange(
  rival: () => number | null = () => null,
): Promise<number | null> {
  let dir: string;
  try {
    dir = dirname(fromFileUrl(Deno.mainModule));
  } catch {
    return null;
  }
  let watcher: Deno.FsWatcher;
  try {
    watcher = Deno.watchFs(dir, { recursive: true });
  } catch {
    return null;
  }
  // The rival poll closes the watcher, which ends the loop below.
  let found: number | null = null;
  const poll = setInterval(() => {
    found = rival();
    if (found !== null) {
      try {
        watcher.close();
      } catch { /* aio-ok: already closed */ }
    }
  }, RIVAL_POLL_MS);
  log.info("watch", `waiting for a change under ${dir}`);
  try {
    for await (const ev of watcher) {
      const hit = ev.paths.some((path) => {
        const dot = path.lastIndexOf(".");
        return dot >= 0 && SOURCE_EXT.has(path.slice(dot));
      });
      if (hit) break;
    }
  } catch {
    /* watcher died — relaunch anyway */
  } finally {
    clearInterval(poll);
    try {
      watcher.close();
    } catch { /* already closed */ }
  }
  if (found !== null) return found;
  await new Promise((r) => setTimeout(r, 150));
  return null;
}

/** How often a supervisor waiting for a save checks for a rival start. */
const RIVAL_POLL_MS = 1_000;

/** End this dev session because `pid` is the app now — said, then exit 0. */
function stepAside(pid: number): never {
  log.warn(
    "watch",
    `another start of this app took over (pid ${pid}) while the relaunch ` +
      `was booting — this dev session ends; that one is the app now (am ` +
      `status / am stop reach it)`,
  );
  Deno.exit(0);
}

/** The pid of a DIFFERENT live instance of this app, or null. Uses the same
 *  zero-config identity the child resolves; an app that names its `appId`
 *  only in `aio.run()` is not visible from here, and the relaunch then simply
 *  gets the runtime's own "Already running". */
function otherInstancePid(): number | null {
  try {
    const live = instances(resolveAppId()).find((i) =>
      i.alive && i.pid !== Deno.pid
    );
    return live ? live.pid : null;
  } catch {
    return null;
  }
}
