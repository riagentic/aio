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

import { basename, dirname, fromFileUrl, join } from "@std/path";
import { log } from "../diagnostics/logger-api.ts";
import {
  AppLock,
  instances,
  isLockOwnerAlive,
  isOwnLock,
  type LockData,
  lockKey,
  ownerIdentity,
  readLock,
  removeLockIf,
  removeLockIfOwner,
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

/** The supervisor's own word to its child: the TCP port the app was on.
 *
 *  Not `AIO_PORT`, which carried it first: that is the OPERATOR's variable,
 *  and `electron: { ignoreDebugEnv }` exists to stop a desktop app reading it
 *  from an environment it did not choose. An Electron dev app with that key,
 *  on a TCP port nobody named (`--expose`), therefore ignored the carry — a
 *  different free port after every cell edit, and a warning each time that
 *  `AIO_PORT` "is set and ignored" in a shell that never set it. The carry is
 *  not ambient: only the supervisor writes it, and only a supervised child
 *  reads it ({@linkcode carriedPort}). */
export const RESTART_PORT_ENV = "AIO_DEV_RESTART_PORT";

/** The port the supervisor carried to THIS process — `undefined` outside a
 *  supervised child, so the variable left in a shell means nothing. Decimal
 *  digits, 1-65535; anything else is no carry (the app binds as if freshly
 *  started). Sits on the env rung of the port chain (aio.ts): a flag is
 *  replayed in argv and equals it, and it IS what a config port bound. Pure. */
export function carriedPort(
  get: (name: string) => string | undefined = env,
): number | undefined {
  if (get(CHILD_ENV) !== "1") return undefined;
  const raw = get(RESTART_PORT_ENV) ?? "";
  if (!/^[0-9]{1,5}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n > 0 && n <= 65535 ? n : undefined;
}

/** The supervisor's word on what the LAST start already found saved:
 *  `<streak>:<key>,<key>…` — see {@linkcode savedWhileStarting}. Read only in
 *  a supervised child, as the port is. */
export const RESTART_SAVED_ENV = "AIO_DEV_RESTART_SAVED";

/** One saved file as the carry names it: FNV-1a of its path and what it
 *  holds — the list rides in the environment, so it is kept short. */
const savedKey = (path: string, stamp: string): string => {
  let h = 0x811c9dc5;
  for (const c of `${path}\0${stamp}`) {
    h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193);
  }
  return (h >>> 0).toString(16);
};

/** The carry for the next child. More keys than an environment holds on
 *  Windows (32 KB in all) are not sent: the child then restarts once for a
 *  file it need not have, and the streak ends that. Pure. @internal */
export function savedCarry(
  streak: number,
  saved: ReadonlyMap<string, string>,
): string {
  const keys = [...saved].map(([p, s]) => savedKey(p, s));
  return `${streak}:${keys.length > 1_500 ? "" : keys.join(",")}`;
}

/** The source files under `roots` saved since THIS process loaded its modules
 *  (`since`, ms) that nothing has acted on — asked once, when the app's file
 *  watcher is up.
 *
 *  A save has a watcher event only once the watcher exists, and the watcher
 *  starts with the server: after the module graph is loaded, the lock taken
 *  and the store opened. A cell file saved in that stretch — the lock already
 *  names the app and its port, so a tool that waits for the app to "be there"
 *  saves exactly then — was loaded old and never restarted for: the dev loop
 *  dropped a save without a word.
 *
 *  …unless the previous start found the same file holding the same bytes:
 *  then it is the app's own start that writes it (codegen, a route manifest),
 *  and restarting for it never ends. A start that writes OTHER bytes each time
 *  is stopped by the streak: after {@linkcode RESTART_STORM_LIMIT} restarts
 *  that each came within {@linkcode FAILED_RESTART_WINDOW_MS} of the spawn,
 *  what is found here is said and not acted on. @internal */
export function savedWhileStarting(
  roots: readonly string[],
  since: number,
  get: (name: string) => string | undefined = env,
): string[] {
  const saved = savedStamps(
    roots.flatMap((r) => sourcesChangedSince(r, since)),
  );
  const [streak, keys = ""] =
    (get(CHILD_ENV) === "1" ? get(RESTART_SAVED_ENV) ?? "" : "").split(":");
  const known = new Set(keys.split(","));
  const fresh = [...saved].filter(([p, s]) => !known.has(savedKey(p, s)))
    .map(([p]) => p);
  const [first] = fresh;
  if (first !== undefined && Number(streak) >= RESTART_STORM_LIMIT) {
    log.warn(
      "watch",
      `${basename(first)}${
        fresh.length > 1 ? ` and ${fresh.length - 1} more` : ""
      } changed while the app was starting, as in each of the last ${streak} ` +
        `starts — the app's own start (or another tool) is rewriting a ` +
        `source file, so this start is not restarted for it. If the edit ` +
        `was yours, save the file again.`,
    );
    return [];
  }
  return fresh;
}

/** The environment a supervised child is spawned with — pure, so the carry
 *  is a unit test rather than a stopwatch.
 *
 *  `AIO_DEV_RESTART_PORT` is THE port the relaunched app binds. A dev app
 *  that named no port got a free one from the runtime — and the runtime
 *  picked a DIFFERENT free one after every cell edit, so every open tab was
 *  orphaned on the old port while the terminal said "restarting the app" as
 *  if nothing moved. `--port=N` never had the problem (the flag is replayed
 *  in argv); an unnamed port is carried in the environment, the one way a
 *  process with no command line to hang a flag on can be told its port, and
 *  read on the env rung of the port chain ({@linkcode carriedPort}). A flag
 *  or an app-config port still wins over it or equals it, so the carry can
 *  never move an app that named its port. */
export function supervisorEnv(
  supervisorPid: number,
  port: number | undefined,
  saved?: string,
): Record<string, string> {
  return {
    [CHILD_ENV]: "1",
    ...(saved !== undefined ? { [RESTART_SAVED_ENV]: saved } : {}),
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
    ...(port !== undefined && port > 0
      ? { [RESTART_PORT_ENV]: String(port) }
      : {}),
  };
}

/** What to say beside the first "restarting the app" of a dev session whose
 *  command line reads as a script's — `--cdp` or `--client=server-only` —
 *  and `""` otherwise.
 *
 *  A save restarts every running dev app, which ends a long scripted run (a UI
 *  tour, a screenshot pass). `--no-watch` is the switch for that, and a field
 *  report worked around its absence for weeks with a house rule ("no source
 *  edits while a run is up") because nothing named it where the restart
 *  happens. Said once: a relaunched app (`relaunched`) has said it already. */
export function scriptedRunHint(
  args: readonly string[],
  relaunched: boolean,
): string {
  if (relaunched) return "";
  const scripted = args.some((a) =>
    a === "--cdp" || a.startsWith("--cdp=") || a === "--client=server-only"
  );
  return scripted
    ? "a save restarts this app — if a script is driving it, start it with " +
      "--no-watch and the run is not cut short"
    : "";
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
  const file = basename(path) || path;
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
  const hint = scriptedRunHint(Deno.args, isSupervisedChild());
  if (hint) log.info("watch", hint);
  // Read BEFORE the shutdown releases the listener: afterwards there is no
  // bound port to read.
  const port = carry.port?.();
  // …and this process's own lock, for the same reason: WHICH app this is
  // (appId, home, profile — the lock key) is what the supervisor needs to
  // hand the lock slot to its child and to recognise a rival start.
  const self = ownLock();
  // Hand the slot over rather than vacate it: the shutdown's release writes a
  // record naming the supervisor (the parent, or this process when it becomes
  // one), which files the next child over it. It used to remove the lock, and
  // until that filing (~100 ms on every save) nothing named the app.
  if (self) {
    const parent = Number(env("AIO_PARENT_PID"));
    const supervisor = isSupervisedChild() && parent > 0 ? parent : Deno.pid;
    AppLock.live().find((l) => l.key === slotOf(self))?.handOver(
      placeholderFor(self, supervisor, port),
    );
  }
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
    const mine = instances().find((i) => isOwnLock(i));
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
  waiting?: LockData["waiting"],
): string | null {
  try {
    const data = placeholderFor(
      self,
      child,
      port,
      child === Deno.pid ? undefined : Deno.pid,
      waiting,
    );
    const seen = readLock(slotOf(self));
    // A record naming THIS supervisor is the old app's hand-over (see
    // `restartForCellChange`) — replaced, like a dead owner's.
    const wrote = !seen ? replaceLockIf(null, data) : !isOwnLock(seen, child) &&
      (isOwnLock(seen) || !isLockOwnerAlive(seen)) &&
      replaceLockIf(seen, data);
    // The BYTES written — what `replaceLockIf` stores — so only this exact
    // placeholder is ever taken back (see the removal after the child exits).
    if (wrote) return JSON.stringify(data);
  } catch (e) {
    // aio-ok: the child still takes the slot itself when it boots — only the
    // window stays open; said, not swallowed.
    log.warn("watch", `could not file the relaunch's lock placeholder: ${e}`);
  }
  // Not filed: a record still naming THIS supervisor (the old app's
  // hand-over, or the wait for a fix) would meet the child as a live owner —
  // "already running", or a zombie listener to kill. Removed, the child
  // takes the empty slot itself; only the window it was meant to close
  // stays open. Never a throw: it would end the supervisor loop with the
  // child spawned.
  if (child !== Deno.pid) {
    try {
      const seen = readLock(slotOf(self));
      if (seen && isOwnLock(seen)) removeLockIfOwner(slotOf(self), seen);
    } catch (e) {
      log.warn(
        "watch",
        `could not free the slot this supervisor holds for the relaunch: ${e}` +
          ` — the child may meet it as "already running"`,
      );
    }
  }
  return null;
}

/** @internal test seam — {@linkcode fileChildPlaceholder}. */
// aio-ok: a test seam — tests/lock-handover-failure.test.ts files a child over a slot it cannot write
export const _fileChildPlaceholder = fileChildPlaceholder;

/** The "starting" record naming `pid` in `self`'s slot, on the port it is
 *  about to bind; `supervisor` is whose child it is (`LockData.supervisor`). */
function placeholderFor(
  self: LockData,
  pid: number,
  port: number | undefined,
  supervisor?: number,
  waiting?: LockData["waiting"],
): LockData {
  return {
    ...self,
    waiting,
    pid,
    supervisor,
    port: port ?? self.port,
    status: "starting",
    startedAt: Date.now(),
    startToken: undefined,
    startEpoch: undefined,
    socketPath: undefined,
    trojanPort: undefined,
    // The previous instance's hold file proves nothing about the next one.
    hold: undefined,
    ...ownerIdentity(pid),
  };
}

/** A LIVE instance of `self`'s app home that is neither this supervisor nor
 *  its child `child` — a rival start (`am restart`, `am start`, a second
 *  `deno task dev`) that took the slot. `null` without a known `self`. */
function rivalOf(self: LockData | null, child: number): LockData | null {
  if (!self) return null;
  try {
    const l = readLock(slotOf(self));
    return l && !isOwnLock(l, child) && !isOwnLock(l) && isLockOwnerAlive(l)
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
  const stop = {
    child: null as Deno.ChildProcess | null,
    /** The lock bytes this supervisor filed for ITSELF while it waits for a
     *  save (see the failed-restart branch) — taken back on the way out. */
    waiting: null as string | null,
  };
  const dropWaiting = () => {
    if (self && stop.waiting !== null) removeLockIf(slotOf(self), stop.waiting);
    stop.waiting = null;
    // …and the old app's hand-over, when no child was filed over it yet.
    const own = self ? readLock(slotOf(self)) : null;
    if (self && own && isOwnLock(own)) removeLockIfOwner(slotOf(self), own);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(sig, () => {
        try {
          stop.child?.kill(sig);
        } catch { /* already gone */ }
        dropWaiting();
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
      if (!stop.child) {
        dropWaiting();
        Deno.exit(0);
      }
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
  /** Failed restarts whose wait for a save ended at once, back to back. */
  let failStreak = 0;
  /** The source files the last failed start found saved since its spawn. */
  let savedLast = new Map<string, string>();
  /** Restarts that each came soon after the spawn, back to back — and when
   *  the app before this child loaded its modules: what was saved since is
   *  what the child is told of (see `savedWhileStarting`). */
  let soonStreak = 0;
  let lastStart = performance.timeOrigin;
  const entryDir = Deno.mainModule.startsWith("file:")
    ? dirname(fromFileUrl(Deno.mainModule))
    : null;
  while (true) {
    const saved = entryDir === null
      ? new Map<string, string>()
      : savedStamps(sourcesChangedSince(entryDir, lastStart));
    const spawnedAt = Date.now();
    lastStart = spawnedAt;
    const child = new Deno.Command(Deno.execPath(), {
      args,
      env: supervisorEnv(Deno.pid, port, savedCarry(soonStreak, saved)),
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
    soonStreak = status.code === RESTART_EXIT_CODE &&
        Date.now() - spawnedAt < FAILED_RESTART_WINDOW_MS
      ? soonStreak + 1
      : 0;
    if (status.code === RESTART_EXIT_CODE) {
      failStreak = 0;
      savedLast = new Map();
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
    // A signal ended it: `am kill`, a `kill -9`, Ctrl-C reaching the child
    // directly. Someone wanted it dead; the supervisor goes too. A clean 0 is
    // `am stop` or the window closing — same answer. A crash after it had
    // been running is the app's own business and its code passes through.
    if (
      status.signal || status.code === 0 ||
      Date.now() - spawnedAt > FAILED_RESTART_WINDOW_MS
    ) {
      dropWaiting();
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
    // The wait is still THIS app's dev session, so the slot names it while it
    // lasts. With no lock, `am status` said "stopped", `am stop` said "not
    // running" (exit 1) and could not end it — and the next save brought the
    // app back up after the operator had "stopped" it. Filed under the
    // supervisor's own pid: `am stop` SIGTERMs it (the handler above takes
    // the lock back), and the relaunch below replaces it.
    if (self) {
      stop.waiting = fileChildPlaceholder(self, Deno.pid, port, {
        reason: `the app exited with code ${status.code} right after a ` +
          `restart — the file saved last does not load`,
        since: Date.now(),
      });
    }
    // …and a rival that shows up WHILE waiting ends the wait too: the lock
    // slot is polled beside the watcher, never only after the next save.
    //
    // The mark is the child's SPAWN, not its exit: a fix saved while the
    // failing child was still booting was read by nobody — the child had
    // loaded the broken file, and its own watcher never started — and a mark
    // at the exit waited for a save that had already been made.
    //
    // …unless the previous failed start found the same files saved: then it
    // is the app's own start that writes them (codegen, a route manifest),
    // each time it runs, and relaunching on them never ends. A fix is a file
    // that start did not write, or other bytes in one it did; the same bytes
    // in one it did write are waited for as a watcher event, as every save
    // was before this look existed.
    const waitFrom = Date.now();
    const late = await waitForSourceChange(
      () => rivalOf(self, 0)?.pid ?? null,
      (dir) => {
        const saved = savedStamps(sourcesChangedSince(dir, spawnedAt));
        const fresh = savedFresh(savedLast, saved);
        savedLast = saved;
        return fresh;
      },
      // An event for a file the failed start wrote itself, holding what the
      // look above found in it, is that same write heard late — not a save.
      (paths) => eventIsNews(savedLast, paths),
    );
    dropWaiting();
    if (late !== null) stepAside(late);
    // A start that writes a NEW source file each time it runs is never the
    // same set twice: each failed start would relaunch at once, without end.
    // Same guard, same numbers, as a storm of asked-for restarts above.
    failStreak = Date.now() - waitFrom < RESTART_STORM_MS ? failStreak + 1 : 0;
    if (failStreak === 0) saidStorm = false;
    const cool = restartThrottleDelay(failStreak);
    if (cool > 0 && !saidStorm) {
      saidStorm = true;
      log.warn(
        "watch",
        `${failStreak} failed starts in a row, each with a source file saved ` +
          `while it was starting — the app's own start (or another tool) ` +
          `is rewriting a source file. Throttling to one start every ${
            RESTART_STORM_COOLDOWN_MS / 1000
          }s until a start succeeds.`,
      );
    }
    if (cool > 0) await new Promise((r) => setTimeout(r, cool));
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
  /** Was a source file under `dir` saved before this wait began? Asked once,
   *  with the watcher already up. */
  savedBefore: (dir: string) => boolean = () => false,
  /** Is an event for these source files a save — or the failed start's own
   *  write, heard after the fact ({@linkcode eventIsNews})? */
  isNews: (paths: string[]) => boolean = () => true,
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
    // A save made BEFORE this watcher existed has no event — while the app
    // that failed was still starting, or after it died: "fix it and save"
    // was on screen ~20 ms earlier, and a tool that acted on it at once was
    // waited for forever (measured, macOS). Looked for once, now that later
    // saves do have one.
    if (savedBefore(dir)) watcher.close();
    for await (const ev of watcher) {
      const sources = ev.paths.filter((path) => {
        const dot = path.lastIndexOf(".");
        return dot >= 0 && SOURCE_EXT.has(path.slice(dot));
      });
      if (sources.length > 0 && isNews(sources)) break;
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

/** path → what the file holds (length + FNV-1a); a file that cannot be read
 *  holds "". @internal */
export function savedStamps(paths: readonly string[]): Map<string, string> {
  return new Map(paths.map((p) => {
    try {
      const b = Deno.readFileSync(p);
      let h = 0x811c9dc5;
      for (const x of b) h = Math.imul(h ^ x, 0x01000193);
      return [p, `${b.length}:${h >>> 0}`];
    } catch {
      return [p, ""]; // aio-ok: removed since the listing — not a fix
    }
  }));
}

/** Did this failed start find a save the last one did not — a new file, or
 *  other bytes in the same one? Two failing starts with the same file saved
 *  during each (a first try, then the fix) named no new PATH, so the fix read
 *  as the app's own start rewriting it and waited for one more save. A start
 *  that rewrites the same bytes still waits. Pure. @internal */
export function savedFresh(
  last: ReadonlyMap<string, string>,
  now: ReadonlyMap<string, string>,
): boolean {
  return [...now].some(([p, stamp]) => last.get(p) !== stamp);
}

/** Is a watcher event for `paths` news to a supervisor whose last look held
 *  `last` — or the failed start's own write, heard late? macOS delivers the
 *  events of writes made shortly BEFORE a watch began: a start that wrote its
 *  generated file and then failed was relaunched by that write's own event,
 *  again and again until the throttle (measured on macOS 26, 4 runs in 5; in
 *  1.0.19 too). The same bytes the look already found in that file are not a
 *  save; other bytes, a file the look did not hold, or one that is gone, are.
 *  Paths are compared as the files they are (`/tmp` is `/private/tmp` in an
 *  event there). @internal */
export function eventIsNews(
  last: ReadonlyMap<string, string>,
  paths: readonly string[],
): boolean {
  const real = (p: string): string => {
    try {
      return Deno.realPathSync(p);
    } catch {
      return p; // aio-ok: gone — compared under the name it had
    }
  };
  const byFile = (m: ReadonlyMap<string, string>) =>
    new Map([...m].map(([p, stamp]) => [real(p), stamp]));
  return savedFresh(byFile(last), byFile(savedStamps(paths)));
}

/** The source files under `dir` saved at or after `since` (ms). Dot-dirs and
 *  `node_modules` are not looked into, as the app's own watcher does not; an
 *  unreadable entry is not a change.
 *
 *  A filesystem that keeps whole seconds (ext3, HFS+, FAT at two) reports a
 *  save made in the spawn's own second as OLDER than the spawn: there, a
 *  stamp is compared against the start of `since`'s second. That counts a
 *  save from just before the spawn too — which costs one start, not a loop
 *  (the caller relaunches only on what the last look did not hold).
 *
 *  WHERE is decided by the tree, never by the one stamp: a file whose
 *  milliseconds happen to be 000 (one in a thousand) on a filesystem that
 *  keeps them was read as a coarse stamp, so an app file written just before
 *  the start read as saved during it and the dev app restarted itself once
 *  for nothing ({@linkcode wholeSeconds}).
 *  @internal */
export function sourcesChangedSince(dir: string, since: number): string[] {
  const sources: [path: string, at: number][] = [];
  const stamps: number[] = [];
  _walkSources(dir, sources, stamps);
  const mark = wholeSeconds(stamps) ? since - since % 1000 : since;
  return sources.filter(([, at]) => at >= mark).map(([path]) => path);
}

/** Does this filesystem keep whole seconds only? Judged by every stamp the
 *  walk met — files of any kind and the directories themselves, written and
 *  born: one of them with milliseconds is a filesystem that keeps them. Pure.
 *  @internal */
export function wholeSeconds(stamps: readonly number[]): boolean {
  return stamps.length > 0 && stamps.every((at) => at % 1000 === 0);
}

function _walkSources(
  dir: string,
  sources: [string, number][],
  stamps: number[],
): void {
  const seen = (info: Deno.FileInfo): number => {
    const at = info.mtime?.getTime() ?? 0;
    if (info.mtime) stamps.push(at);
    if (info.birthtime) stamps.push(info.birthtime.getTime());
    return at;
  };
  const isSource = (name: string): boolean => {
    const dot = name.lastIndexOf(".");
    return dot >= 0 && SOURCE_EXT.has(name.slice(dot));
  };
  let entries: Deno.DirEntry[];
  try {
    const info = Deno.statSync(dir);
    const at = seen(info);
    // A watch root that is a FILE (`watch: ["cell.ts"]`) is its own entry:
    // listing it threw, and a save to it before the watcher was up was lost.
    if (info.isFile) {
      if (isSource(basename(dir))) sources.push([dir, at]);
      return;
    }
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return; // aio-ok: gone or unreadable — the watcher is what is left
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const path = join(dir, e.name);
    if (e.isDirectory) {
      _walkSources(path, sources, stamps);
      continue;
    }
    try {
      const at = seen(Deno.statSync(path));
      if (isSource(e.name)) sources.push([path, at]);
    } catch { /* aio-ok: removed between the listing and the look */ }
  }
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
      i.alive && !isOwnLock(i)
    );
    return live ? live.pid : null;
  } catch {
    return null;
  }
}
