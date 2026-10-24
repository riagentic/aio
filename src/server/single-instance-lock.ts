// App identity + singleton lock for aio apps
// One lock file per app in $XDG_RUNTIME_DIR or /tmp — the lock IS the identity.
// Cross-platform: works on Linux, macOS, Windows
// Prevents multiple instances from corrupting shared resources
//
// This file holds the singleton itself — the lock record's shape (LockData)
// and its public reader (readLock), AppLock (acquire, takeover, release), the
// handoff, the home claim and instances(). The rest lives beside it and is
// re-exported here, so every importer keeps this one path:
//   app-id.ts           — App ID resolution
//   lock-dir.ts         — the lock directory, key → path naming, launch info
//   lock-file.ts        — every other read/write of the lock record
//   lock-owner.ts       — owner judgment, probes, zombie verdict, stopping
//   process-liveness.ts — pid liveness/start tokens (a leaf: no lock imports)

import { basename, join, resolve } from "@std/path";
import { appHome } from "./app-dirs.ts";
import { homedir } from "./paths.ts";
import { log } from "../diagnostics/logger-api.ts";
import { _renameDeps } from "../diagnostics/rename-over.ts";
import {
  deadOwnerWarning,
  isHold,
  lockAgeMs,
  noteDeadHolder,
  parseLock,
  printable,
  publishExclusive,
  quitMarkPath,
  readLockAt,
  readLockRaw,
  removeLockFileIf,
  removeLockIf,
  replaceLockIf,
  rewriteLock,
  sameFile,
  sealLock,
  sweepOrphanLockTemps,
  takeQuitMark,
  tryCreateLock,
  withLockMutex,
} from "./lock-file.ts";
import {
  _exists,
  _lockDirCandidates,
  _lockDirParts,
  lockDir,
  lockKey,
  lockPath,
  parseLockKey,
} from "./lock-dir.ts";
import {
  _zombieDeps,
  foreignOwnerRefusal,
  isLockOwnerAlive,
  isOwnLock,
  ownerIdentity,
  stopInstance,
  takeHold,
  zombieLine,
  zombieVerdict,
} from "./lock-owner.ts";
import { delay, ownPidNs, parentPidOf } from "./process-liveness.ts";

// ── Moved out — re-exported so every importer keeps this path ──
export {
  _chooseLockDir,
  _lockDirParts,
  _prepareLockDir,
  boundUnixSockets,
  createInLockDir,
  ensureLockDirOf,
  hash8,
  heldLockKey,
  heldShowRequestPath,
  launchInfoPath,
  listenInLockDir,
  lockDir,
  lockDirRemade,
  lockKey,
  lockPath,
  parseLockKey,
  pruneDeadLockDir,
  pruneDeadLockDirAt,
  pruneDeadLockDirsTagged,
  pruneLockDir,
  readLaunchInfo,
  removeLaunchInfo,
  rootRegistryEntry,
  sentinelName,
  showRequestPath,
  sweepDeadSentinels,
  sweepRootRegistry,
  taggedOwnerGone,
  writeLaunchInfo,
} from "./lock-dir.ts";
export type { LaunchInfo } from "./lock-dir.ts";
export {
  descendantPids,
  isPortInUse,
  isProcessAlive,
  isSocketAlive,
  KILL_POLL_MS,
  ownPidNs,
  ownPidTag,
  parseLstartUtc,
  processStartEpoch,
  processStartToken,
  PS_TIMEOUT,
} from "./process-liveness.ts";
export {
  _probeDeps,
  _stopDeps,
  _zombieDeps,
  askToStop,
  endpointOf,
  foreignOwnerRefusal,
  heldLockLine,
  isLockOwnerAlive,
  isOwnLock,
  killProcess,
  otherAppsRootOf,
  ownerIdentity,
  ownerMatches,
  probeEndpoint,
  stopInstance,
  ZOMBIE_PROBE_GAP_MS,
  ZOMBIE_PROBES,
  zombieLine,
  zombieVerdict,
} from "./lock-owner.ts";
export type { EndpointProbe, ZombieVerdict } from "./lock-owner.ts";
export {
  _lockDeps,
  _seal,
  ageSince,
  deadOwnerWarning,
  isHold,
  mayUnlinkMutex,
  noteDeadHolder,
  printable,
  removeLock,
  removeLockFileIf,
  removeLockIf,
  removeLockIfOwner,
  replaceLockIf,
  sweepOrphanLockTemps,
  terminalSafe,
  withLockMutex,
  withLockMutexAt,
  writeLock,
} from "./lock-file.ts";

/** How long a lock may sit at `status:"starting"` before anyone — the next
 *  launch's zombie probe, `am start` — may treat "its listener does not answer"
 *  as "it is stuck". THE one decider: `am` used to have none, probed the port
 *  the placeholder lock carried (0, when the app had not declared one) and
 *  killed every app that was still booting. */
export const STARTUP_GRACE_MS = 10_000;

/** How long a `status:"starting"` lock whose owner is ALIVE but has bound
 *  nothing may go without any progress before `am start` may reclaim it. Past
 *  `STARTUP_GRACE_MS` a booting app is not a stuck one — a 15 s boot was
 *  killed at 10.4 s by the next `am start`, and every retry killed the next
 *  one (an agent re-running on exit 1 killed the app forever). "Progress" is
 *  the app's own stdout log still moving; see `bootStalled` in am. */
export const STUCK_STARTING_MS = 5 * STARTUP_GRACE_MS;

// ── File-size guard (SIGXFSZ) ────────────────────────────────

/** Holders of the process-wide SIGXFSZ listener, and the listener itself.
 *  Refcounted because the holders are independent: every boot takes one, and
 *  so does every `AppLock`, and two apps in one process (D2) must not
 *  un-protect each other on the way out. */
let _xfszHolders = 0;
let _xfszHandler: (() => void) | undefined;

/** Hold the process-wide guard against `RLIMIT_FSIZE`; the returned function
 *  releases this holder's claim (idempotent).
 *
 *  SIGXFSZ is raised by a write past `RLIMIT_FSIZE` (`ulimit -f`, a container
 *  limit). Its default action is terminate + core dump, so the first persist
 *  that grew `state.db` or the journal past the limit killed the app outright
 *  — no PERSIST_ERROR, no shutdown phases, no final persist, the lock left
 *  behind. Listening (a no-op) turns it into EFBIG ("File too large") on the
 *  write itself, which the persist path already reports, and the app stays
 *  up. POSIX only — Windows has no such signal.
 *
 *  It USED to be installed by `AppLock._registerCleanupHandlers`, i.e. it
 *  rode on the single-instance lock. `libraryMode` takes no lock (an embedded
 *  app must not claim the app's single-instance slot), so an embedded app got
 *  none of this and died of the signal exactly as a normal boot did before
 *  the listener existed — measured, `tests/sigxfsz-library-mode.test.ts`.
 *  The guard is a property of the PROCESS and grants no exclusivity, so it is
 *  its own holdable thing: the boot path holds one for every app, lock or no
 *  lock, and `AppLock` holds another. One code path, no `libraryMode`
 *  branch. */
export function holdFileSizeGuard(): () => void {
  if (Deno.build.os === "windows") return () => {};
  if (_xfszHolders === 0) {
    try {
      _xfszHandler = () => {};
      Deno.addSignalListener("SIGXFSZ", _xfszHandler);
    } catch {
      // aio-ok: a runtime that refuses the listener keeps the kernel default
      // — the behaviour before this existed, nothing worse. Holders are still
      // counted so release stays balanced.
      _xfszHandler = undefined;
    }
  }
  _xfszHolders++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--_xfszHolders > 0) return;
    // The LISTENER belongs to the process: it comes off only when the last
    // holder lets go, or a second app in this one would be silently
    // un-protected by the first one's shutdown.
    try {
      if (_xfszHandler) Deno.removeSignalListener("SIGXFSZ", _xfszHandler);
    } catch {
      // aio-ok: already gone, or never installable — either way nothing is
      // left registered, which is all this wants.
    }
    _xfszHandler = undefined;
  };
}

/** How many holders the process-wide SIGXFSZ guard has right now.
 *
 *  Counting them is the only way to prove the D2 invariant — two apps in one
 *  process, and the first one's shutdown must not un-protect the second. The
 *  product must never branch on this; a boot that asks "is the guard already
 *  held?" is a second decider for something the refcount already decides. */
// aio-ok: a test-only seam — nothing in the product may read the refcount.
export function _fileSizeGuardHeld(): number {
  return _xfszHolders;
}

// ── Types ────────────────────────────────────────────────────

/** Unified lock file — replaces both .aio.lock and .aio.pid */
export type LockData = {
  appId: string; // canonical unique identity
  pid: number; // OS process ID
  port: number; // HTTP server port
  startedAt: number; // epoch ms
  status: "starting" | "started" | "stopping";
  /** Present when the holder is NOT an app: `am backup` / `am restore`
   *  holding the lock so the app cannot start while its data is copied or
   *  swapped (`op` names which, e.g. "am backup"). Readers check it BEFORE
   *  `status`: a live maintenance holder is never probed as a zombie, never
   *  taken over, and a refused boot names the op.
   *
   *  A separate field, not a fourth `status`: the status union is public
   *  surface and frozen. Such a hold writes `status: "starting"` (port 0, no
   *  socket, `startedAt` kept fresh by a heartbeat), the value readers that
   *  predate this field handle most safely — measured against v1.0.9: its
   *  app boot refuses ("already running"); its `am start` waits ("already
   *  starting") where "started" would probe port 0 and kill the holder as
   *  unresponsive and "stopping" would SIGKILL it after 3 s. Its `am stop`
   *  SIGTERMs any live holder whatever the status — unavoidable for a reader
   *  that old; the op traps SIGTERM and aborts with data/ untouched. */
  maintenance?: {
    op: string;
    /** When the op took the lock (epoch ms). `startedAt` is NOT that: the
     *  hold's heartbeat keeps `startedAt` fresh for pre-`maintenance` readers
     *  (see above), so `am instances` reads the op's age from here. */
    since?: number;
    /** What the op leaves behind if it is killed: `am backup`'s
     *  `<dest>.partial`, `am restore`'s `data.restoring-*` staging copy —
     *  named by whoever finds the dead holder ({@linkcode deadOwnerWarning}). */
    partial?: string;
  };
  /** Present when the holder is a DEV SESSION waiting for a fix: its
   *  relaunch died on a file that does not load, and it relaunches on the
   *  next save. Written with `status: "starting"` under the supervisor's own
   *  pid, so every reader sees the session (and `am stop` ends it); `am`
   *  names it instead of waiting on it or reclaiming it as stuck. */
  waiting?: {
    /** What went wrong, one line (e.g. "the app exited with code 1 …"). */
    reason: string;
    /** When the wait began (epoch ms). */
    since: number;
  };
  /** Present when the holder runs UNDER a dev supervisor: that supervisor's
   *  pid. A cell edit turns the process that was launched into a thin
   *  supervisor and the app into its child (dev-restart.ts), so the lock's
   *  `pid` is then no longer the process `am start` (or a terminal) launched —
   *  this names it. How `am` tells "the launch I made, relaunched" from
   *  "another launch that took the lock". Absent outside a supervised dev
   *  session and on locks written by an aio older than this field. */
  supervisor?: number;
  cwd: string; // working directory (for am/instances display)
  /** The resolved data home this instance runs from. Part of the lock's
   *  IDENTITY (see {@linkcode lockKey}): two boots of one appId from two homes
   *  are two apps, not a duplicate. Optional only for locks written before
   *  alpha66 — a missing value means the default home. */
  home?: string;
  socketPath?: string; // UDS socket path (when using UDS transport)
  /** The HTTP handler's socket (`<key>.http.sock`) of an app with no TCP
   *  port — the door `peer()` takes for blobs and a proven identity. Absent
   *  whenever a port exists, and on locks written before 1.0.25. */
  httpSocketPath?: string;
  /** The address `port` is bound on, as configured (`127.0.0.1`, `0.0.0.0`,
   *  `::`, a LAN address, a name) — written when the lock is taken, from the
   *  same decider the server binds with. `port`
   *  alone does not say where to connect — an app with `host: "127.0.0.2"`
   *  refuses on `127.0.0.1` forever. Whoever asks "is this instance's
   *  listener still there?" asks at THIS address ({@linkcode probeEndpoint}).
   *  Absent on a socket-only app and on locks written before 1.0.17-beta —
   *  and then nobody may conclude from a refused connect that the listener
   *  is gone. */
  host?: string;
  /** A one-time secret on a lock `am start` holds while it spawns the app:
   *  the child is handed the same value in {@linkcode HANDOFF_ENV}, and only
   *  a process holding it takes this lock over. The pid of whoever filed it
   *  says nothing — a child is not reliably that pid's child (on Windows the
   *  launcher is an intermediate process). */
  handoff?: string;
  trojanPort?: number; // plain-HTTP control port (when TLS active)
  // LAN-discovery metadata — present only for --expose'd apps, so any
  // discovery responder on the host can report EVERY exposed app (not just
  // itself) by reading the lock dir. See src/server/discovery.ts.
  discovery?: { title?: string; tls: boolean; needsAuth: boolean };
  /** The PROFILE this instance runs under (`--profile=dev`), when it runs
   *  from a profile's home; absent otherwise and on locks before 1.0.10. */
  profile?: string;
  /** The aio VERSION the instance runs — so `am instances` can say which
   *  framework each process is on, and mark one that differs from the `am`
   *  reading it (two checkouts on one machine is the normal dev setup, and
   *  a mismatch is the first thing to rule out). Absent on locks written
   *  before alpha68. */
  aioVersion?: string;
  /** Chrome DevTools Protocol port of the instance's desktop window, when
   *  one is open and debuggable. Reserved: written as undefined for now. */
  cdpPort?: number;
  /** The CLIENT this instance runs — "electron" | "browser" | "cli" |
   *  "server-only". Only an electron app has a WINDOW, and `am shot` had no
   *  way to know that: it told the operator of a browser app to restart with
   *  `--cdp`, which for a browser app either is refused or records a port
   *  nothing will ever listen on. Absent on locks written before alpha76. */
  client?: string;
  /** Where this instance's DATA actually is: the resolved app directory that
   *  holds `state.db`, `auth.db`, the journal and the rest.
   *
   *  Three things are spelled like "where this app lives" and only one moves
   *  the data: `--home` addresses an existing instance, `AIO_APPS_DIR` moves
   *  the ROOT that homes are resolved under, and `appDir` moves the app's own
   *  directory. `AIO_APPS_DIR` therefore *appears* to work — the lock and the
   *  discovery files move, so `am` follows the app — while an `appDir` set in
   *  code keeps the database exactly where it was (report 1 §20). `home` was in
   *  the lock and this was not, so nothing could show the difference.
   *
   *  Absent on locks written before 1.0.0-beta, where `home` is the best answer. */
  dataDir?: string;
  /** A kernel stamp that changes when a pid is REUSED — see
   *  {@linkcode processStartToken}.
   *
   *  A pid on its own is not an identity. This lock file outlives a reboot
   *  whenever `XDG_RUNTIME_DIR` is unset (the base is then `/tmp`, which
   *  Debian and Ubuntu do NOT clear at boot — contradicting
   *  `docs/persistence/where-files-live.md:34`), and pids wrap. So every kill
   *  site — `am stop`, `killProcess`, `acquire(killExisting)`, the parent
   *  watch, `am kill --stale` — was one recycled pid away from SIGTERMing an
   *  unrelated program of the user's, on the strength of a number in a file.
   *  Written when the lock is created; absent on locks written before
   *  alpha69 and on platforms that cannot report it, where the pid alone is
   *  all there is. */
  startToken?: string;
  /** macOS: the owner's start time in epoch SECONDS (UTC), read with a fixed
   *  locale and zone — the same number for every reader. `startToken` there
   *  used to be `ps -o lstart=` TEXT, which changes with the READER's TZ and
   *  LANG (measured on macOS 14: UTC, Asia/Tokyo and de_DE gave three
   *  strings), so a live owner read as a recycled pid and its lock was taken.
   *  A separate field on purpose: a pre-1.0.10 reader compares `startToken`
   *  as text, and an epoch there would make IT call every live owner dead;
   *  without one it falls back to pid liveness, its own baseline. A legacy
   *  text `startToken` is read as "unknown" (pid liveness), never as dead. */
  startEpoch?: number;
  /** The owner's pid namespace (Linux; see {@linkcode ownPidNs}). A pid
   *  means something only in the namespace that wrote it: a container
   *  sharing this lock dir runs as pid 7 (under tini), which is dead — or a
   *  stranger — HERE. Absent on locks written before 1.0.13-beta and where
   *  there are no namespaces; then the pid decides, as it always did. */
  ns?: number;
  /** The owner's HOLD file beside the lock (its name; resolved against the
   *  directory the lock was read from): the owner keeps an OS lock
   *  (`flock`) on it for its lifetime, and the KERNEL drops that lock when
   *  the owner dies — in any pid namespace sharing the file system. How a
   *  reader in another namespace judges the owner (see
   *  {@linkcode isLockOwnerAlive}). Absent where the file system cannot lock,
   *  and on locks written before 1.0.13-beta. */
  hold?: string;
  /** Every setting with more than one home (flag, config, env, deno.json),
   *  as `name → "value (source)"` — what `am doctor` shows. Decided by
   *  config-sources.ts; absent on locks written before 1.0.6. */
  settings?: Record<string, string>;
};

/** What a boot records about itself beyond identity — see {@linkcode LockData}. */
export type LockMeta = {
  aioVersion?: string;
  /** See {@linkcode LockData} `profile`. */
  profile?: string;
  cdpPort?: number;
  client?: string;
  /** The directory the app's DATA actually lives in — see {@linkcode LockData}
   *  `dataDir`. */
  dataDir?: string;
  /** Every setting with more than one home (flag, config, env, deno.json),
   *  as `name → "value (source)"` — what `am doctor` shows. Decided by
   *  config-sources.ts; absent on locks written before 1.0.6. */
  settings?: Record<string, string>;
  /** The address the boot will bind `port` on — see {@linkcode LockData}
   *  `host`. */
  host?: string;
  /** See {@linkcode LockData} `handoff`. */
  handoff?: string;
};

/** The variable `am start` hands its child the lock's `handoff` secret in. */
export const HANDOFF_ENV = "AIO_LOCK_HANDOFF";

let _secret: string | undefined | null = null;
/** The hand-off secret this process was given — read ONCE and taken out of
 *  the environment, so no child of the app (a worker, the window, a
 *  subprocess) inherits it. */
function handoffSecret(): string | undefined {
  if (_secret === null) {
    _secret = Deno.env.get(HANDOFF_ENV);
    if (_secret !== undefined) Deno.env.delete(HANDOFF_ENV);
  }
  return _secret;
}

/** The dev supervisor this process runs under (dev-restart.ts hands its
 *  child both variables), or undefined — see {@linkcode LockData}
 *  `supervisor`. */
function devSupervisorPid(): number | undefined {
  try {
    if (Deno.env.get("AIO_DEV_SUPERVISED") !== "1") return undefined;
    return parentPidOf(Deno.env.get("AIO_PARENT_PID"));
  } catch {
    return undefined; // aio-ok: no env permission — then nothing supervises it
  }
}

/** Was `lock` filed FOR this process — does it carry the hand-off secret
 *  this process was given? Never by pid or parent pid. Pure. @internal */
export function _handedOver(
  lock: { handoff?: string },
  secret: string | undefined = handoffSecret(),
): boolean {
  return !!secret && lock.handoff === secret;
}

/** Instance info returned by instances() — lock data + liveness */
export type InstanceInfo = LockData & { alive: boolean };

/** What {@linkcode AppLock.acquire} answers. `unendable`: the holder is a
 *  zombie by the sustained verdict and could not be ended — the refusal
 *  names it rather than calling it a running app. */
export type AcquireResult =
  | { ok: true }
  | {
    ok: false;
    existing: LockData;
    unendable?: true;
    /** The owner `existing` names is DEAD, and its lock file could not be
     *  removed (why) — another program has it open. Not "already running":
     *  see {@linkcode AppLock.adoptUnfiled}. */
    held?: string;
  };

/** What to do when another instance of the same app is already running */
export type SingletonMode = boolean;
// true = refuse if running (default)
// false = allow multiple instances

// ── App ID Resolution — src/server/app-id.ts, re-exported ────

export {
  appIdFromConfig,
  inferredIdFallbackWarning,
  projectAppId,
  resolveAppId,
  slugify,
} from "./app-id.ts";

// ── Lock File CRUD ───────────────────────────────────────────

/** Read a lock file, return null if missing or corrupt */
/** Read a lock by its key — the plain appId for a default-home app, or the
 *  `<appId>@<hash8(home)>` key {@linkcode lockKey} builds for any other home. */
export function readLock(key: string): LockData | null {
  return readLockAt(lockPath(key)).data;
}

// ── AppLock — Singleton Enforcement ──────────────────────────

export class AppLock {
  readonly appId: string;
  /** Resolved data home — half of the identity (see {@linkcode lockKey}). */
  readonly home: string;
  /** THE file name this lock lives under. */
  readonly key: string;
  private acquired = false;

  /** The profile this lock's home is (`--profile=dev`), when known. */
  readonly profile?: string;

  constructor(appId: string, home?: string, profile?: string) {
    this.appId = appId;
    this.home = resolve(home ?? appHome(appId));
    this.key = lockKey(appId, this.home, profile);
    if (profile !== undefined) this.profile = profile;
  }

  /** Every lock held in this process (read-only view of `_live`). */
  static live(): readonly AppLock[] {
    return [...AppLock._live];
  }

  /** Register process-termination hooks. Idempotent — safe to call from every
   *  acquire() exit path.
   *
   *  Two different things happen here, and they used to be one:
   *
   *  • `unload` RELEASES — the process is ending, nothing runs after this.
   *  • SIGINT / SIGTERM only MARK the lock `stopping`. The signal starts the
   *    graceful shutdown (`aio-server.ts` installs that handler); the lock is
   *    released by its Phase 6, AFTER the final persist. Releasing it at signal
   *    time — which is what this did — left the app alive, listening and
   *    flushing, but unlocked: measured, the lock file was gone 1 ms after
   *    SIGTERM and the process 14 ms later, and for an app with a real final
   *    snapshot the gap is the whole shutdown (seconds). A launch in that gap
   *    took the lock, opened the same `state.db`, restored PRE-final state and
   *    overwrote the first app's last write on its next persist. The stale-
   *    lock case this was added for (Audit F-7: a hard exit leaves the file
   *    behind) is covered by pid liveness — a dead owner is reclaimed on the
   *    next launch — and a hard exit runs no JS handler anyway. */
  private _registerCleanupHandlers(): void {
    // TWO facts, and merging them was the bug: "are the process-wide listeners
    // installed?" and "which locks must they release?".
    //
    // The flag is static (right — one set of listeners per process) but the
    // handler used to close over ONE instance's `this`. So a second locked app
    // in the same process — a supported shape (D2); `singleton` defaults to
    // true outside libraryMode — saw the flag already set, returned early, and
    // got no cleanup at all. On SIGTERM the first app's lock was released and
    // the second's was left behind, to block that app's next launch.
    //
    // The live set is the second fact, held separately.
    AppLock._live.add(this);
    if (AppLock._cleanupRegistered) return;
    AppLock._cleanupRegistered = true;
    // Snapshot the set: `release()` mutates it, and a Set must not be mutated
    // while it is being iterated.
    const release = () => {
      for (const lock of [...AppLock._live]) lock.release();
    };
    const markStopping = (signal: "SIGINT" | "SIGTERM") => {
      // SIGTERM gets the advice line in the log; SIGINT does not (both get
      // the one-line "<signal> received — stopping" reason from `stopProcess`).
      //
      // That split is the whole point. SIGINT is a human at a terminal
      // pressing Ctrl-C on an app they are watching — they know what they
      // did. SIGTERM arrives from somewhere else, and the somewhere that
      // costs people their afternoon is a process-table match: every aio app
      // runs as `deno run … <entry>.ts`, so `pkill -f app.ts` ends ALL of
      // them — the sender's app, the ones it did not start, and the human's
      // own long-running work.
      //
      // Stated as a fact with the narrower command beside it, never as an
      // accusation: `am stop`'s own fallback reaches here too, when an app
      // has stopped answering the graceful door, and so does a service
      // manager. Every one of those readers is better off knowing the
      // spelling that ends one app.
      //
      // Observe-only, identical in dev and prod: the shutdown that follows is
      // byte-for-byte the one that happened before this line existed.
      if (signal === "SIGTERM") {
        for (const lock of AppLock._live) {
          // `am backup` / `am restore` holding the lock is not an app: "am
          // stop stops this app" would be advice about something else (and
          // `am stop` refuses a hold). The op reports its own interruption.
          if (isHold(readLock(lock.key))) continue;
          log.warn(
            `SIGTERM — shutting down. "am stop --app=${lock.appId}" stops ` +
              `this app alone; a process match (pkill -f …) ends EVERY aio ` +
              `app on this machine, not just this one.`,
          );
          break; // one line per process, not one per lock held in it
        }
      }
      for (const lock of [...AppLock._live]) {
        lock.update({ status: "stopping" });
      }
    };
    const onInt = () => markStopping("SIGINT");
    const onTerm = () => markStopping("SIGTERM");
    try {
      addEventListener("unload", release);
    } catch { /* skip if listener limit */ }
    try {
      AppLock._sigintHandler = onInt;
      Deno.addSignalListener("SIGINT", onInt);
    } catch { /* unsupported on windows */ }
    try {
      AppLock._sigtermHandler = onTerm;
      Deno.addSignalListener("SIGTERM", onTerm);
    } catch { /* unsupported on windows */ }
    // The file-size guard rode on the LOCK until alpha; it is a property of
    // the PROCESS, so it is held here as one holder among others and released
    // with this lock. See {@linkcode holdFileSizeGuard}.
    AppLock._xfszRelease = holdFileSizeGuard();
  }

  /** Unregister signal handlers to prevent listener leaks (e.g. in tests). */
  private _unregisterCleanupHandlers(): void {
    // This lock is done, but the LISTENERS belong to the process. Tearing them
    // down while another app still holds a lock would silently un-protect it —
    // the same class of bug as the one above, arrived at from the other side.
    AppLock._live.delete(this);
    if (AppLock._live.size > 0) return;
    try {
      AppLock._sigintHandler &&
        Deno.removeSignalListener("SIGINT", AppLock._sigintHandler);
    } catch { /* already removed or unsupported */ }
    try {
      AppLock._sigtermHandler &&
        Deno.removeSignalListener("SIGTERM", AppLock._sigtermHandler);
    } catch { /* already removed or unsupported */ }
    AppLock._xfszRelease?.();
    AppLock._sigintHandler = undefined;
    AppLock._sigtermHandler = undefined;
    AppLock._xfszRelease = undefined;
    AppLock._cleanupRegistered = false;
  }

  // ── Shared cleanup state (only one set of handlers ever registered) ──
  /** Every lock currently held in THIS process. The signal handlers release
   *  all of them; see `_registerCleanupHandlers` for why this is separate from
   *  the registration flag. */
  private static _live = new Set<AppLock>();
  private static _cleanupRegistered = false;
  private static _sigintHandler?: () => void;
  private static _sigtermHandler?: () => void;
  /** This lock's hold on the process-wide file-size guard. */
  private static _xfszRelease?: () => void;

  /** Acquire the lock for this app.
   *  - Cleans stale locks (dead PID)
   *  - Refuses if alive instance exists (killExisting=false)
   *  - Kills old instance first (killExisting=true)
   *  Returns the existing LockData if refusing, null on success. */
  async acquire(
    port: number,
    killExisting = false,
    meta: LockMeta = {},
  ): Promise<AcquireResult> {
    const maxRetries = 30; // 3 seconds total
    // The record a successful create writes — ONE shape for both attempts.
    const fresh = (): LockData => ({
      appId: this.appId,
      pid: Deno.pid,
      port,
      startedAt: Date.now(),
      status: "starting",
      cwd: Deno.cwd(),
      home: this.home,
      // Recorded WITH the pid, because the pid alone is not an identity.
      ...ownerIdentity(Deno.pid),
      ...(this._hold ? { hold: basename(this._hold.path) } : {}),
      ...(meta.aioVersion !== undefined ? { aioVersion: meta.aioVersion } : {}),
      ...((this.profile ?? meta.profile) !== undefined
        ? { profile: this.profile ?? meta.profile }
        : {}),
      ...(meta.cdpPort !== undefined ? { cdpPort: meta.cdpPort } : {}),
      ...(meta.client !== undefined ? { client: meta.client } : {}),
      ...(meta.dataDir !== undefined ? { dataDir: meta.dataDir } : {}),
      ...(meta.settings !== undefined ? { settings: meta.settings } : {}),
      ...(meta.host !== undefined ? { host: meta.host } : {}),
      ...(meta.handoff !== undefined ? { handoff: meta.handoff } : {}),
      ...(devSupervisorPid() !== undefined
        ? { supervisor: devSupervisorPid() }
        : {}),
    });

    handoffSecret(); // out of the environment before anything is spawned
    sweepOrphanLockTemps(this.key);
    this._hold ??= takeHold(lockPath(this.key));
    const r = await this._acquire(killExisting, fresh, maxRetries);
    if (!r.ok && r.held === undefined) this._dropHold();
    return r;
  }

  /** This lock's hold file, OS-locked while the lock is ours. */
  private _hold: { f: Deno.FsFile; path: string } | null = null;

  /** The lock file itself, open since this process created it and for as
   *  long as it holds the lock: every change of the record is written
   *  through it ({@linkcode rewriteLock}). */
  private _file: Deno.FsFile | null = null;
  private _keep = (f: Deno.FsFile): void => {
    this._file?.close();
    this._file = f;
  };
  private _dropFile(): void {
    this._file?.close();
    this._file = null;
  }

  /** The record as this owner last wrote it. */
  private _record: LockData | null = null;

  /** File this owner's record again when the lock file is gone, or names a
   *  process that is gone. True when it had to.
   *
   *  The file lives in a runtime directory other things clean, and a running
   *  app whose lock file was removed was invisible to `am` — status said
   *  stopped, `am stop` could not reach it — for the rest of its life. The
   *  owner knows its own record; it looks (one `stat` against the handle it
   *  holds) on a slow tick and puts it back. A LIVE process named there is
   *  left alone: it meets the data folder's lock and withdraws. */
  reassert(): boolean {
    if (!this.acquired || !this._record) return false;
    const path = lockPath(this.key);
    if (this._file && sameFile(this._file, path)) return false;
    return withLockMutex(this.key, () => {
      const was = readLockRaw(this.key);
      const now = parseLock(was, path);
      if (now && (isOwnLock(now) || isLockOwnerAlive(now))) return false;
      // A record young enough to be a launch still writing it is not judged.
      if (was !== null && !now && lockAgeMs(this.key) <= 1_000) return false;
      // A dead owner's, or unreadable. One try: on Windows a program that has
      // it open refuses this, and the next tick tries again.
      if (was !== null) _renameDeps.remove(path);
      if (!publishExclusive(path, sealLock(this._record!), this._keep)) {
        return false; // taken in this instant — the next look judges it
      }
      log.warn(
        "lock",
        `${printable(this.appId)}: the lock file ${printable(path)} ` +
          (was === null ? `was gone` : `named a process that is gone`) +
          ` while this app ran — filed again (pid ${Deno.pid})`,
      );
      return true;
    });
  }

  /** Run WITHOUT the lock file, after `acquire` answered `held`: the
   *  previous owner is dead and its file cannot be removed while another
   *  program has it open. Allowed only to a caller that holds the data
   *  folder's OS lock ({@linkcode claimHome}, `guarded`) — that is what keeps
   *  a second instance out meanwhile (a second launch meets it and is
   *  refused, naming this process). The slow tick ({@linkcode reassert})
   *  files this record once the dead owner's file can be replaced. */
  adoptUnfiled(): void {
    if (!this._record) {
      throw new Error("adoptUnfiled: acquire found no held lock");
    }
    this.acquired = true;
    this._registerCleanupHandlers();
  }

  /** Let the hold file go: unlinked while still locked (a reader that opens
   *  it afterwards finds nothing — dead), then unlocked. */
  private _dropHold(): void {
    const h = this._hold;
    this._hold = null;
    if (!h) return;
    try {
      Deno.removeSync(h.path);
    } catch { /* aio-ok: swept already — the lock goes with the close */ }
    h.f.close();
  }

  private async _acquire(
    killExisting: boolean,
    fresh: () => LockData,
    maxRetries: number,
  ): Promise<AcquireResult> {
    let saidUnreadable = false;
    for (let i = 0; i < maxRetries; i++) {
      // The BYTES, kept: every removal below is compare-and-delete against
      // exactly the record judged here, never "whatever is at the path now".
      const { raw, data: existing } = readLockAt(lockPath(this.key));

      if (!existing) {
        // No lock — try atomic create
        if (tryCreateLock(this._record = fresh(), this._keep)) {
          this.acquired = true;
          this._registerCleanupHandlers();
          return { ok: true };
        }
        // The create failed, so a FILE is there. Either someone won the race
        // (retry) or the file is UNREADABLE — 0 bytes or truncated JSON, which
        // is exactly what a crash or power cut mid-`writeLock` leaves, since
        // that write is not atomic.
        //
        // An unreadable lock names no owner, so it cannot be protecting one,
        // and it bricked the app permanently: `readLock` said "no lock" while
        // `acquire` synthesised `pid: 0` and refused with "already running
        // (pid 0, port 0)" — a pid no process has — while `am status` said
        // "stopped", `am kill` said "killed: false" and `am kill --stale`
        // found nothing. Two readers of one file, two answers, and the only
        // way out was deleting a file in a runtime directory nobody has reason
        // to know about. `readLock`'s own docstring calls that failure by
        // name. Reclaim it, loudly.
        // (Publication is atomic now — `publishExclusive` — so a live
        // racer's lock is never seen half-written; only on a filesystem
        // without hard links is it created-then-written, hence the age floor.)
        const judged = readLockRaw(this.key);
        // There, and it cannot even be READ: another program holds it open
        // without sharing it (Windows share=None). The wait is silent
        // otherwise — say once what this launch waits for.
        if (judged === null && !saidUnreadable) {
          try {
            Deno.readTextFileSync(lockPath(this.key));
          } catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) {
              saidUnreadable = true;
              log.info(
                "lock",
                `${printable(this.appId)}: its lock file ${
                  printable(lockPath(this.key))
                } is there but cannot be read (${e}) — another program has ` +
                  `it open; waiting for it to let go`,
              );
            }
          }
        }
        if (
          judged !== null && parseLock(judged) === null &&
          lockAgeMs(this.key) > 1_000
        ) {
          log.warn(
            "lock",
            `unreadable lock at ${
              lockPath(this.key)
            } (empty or truncated — a crash mid-write leaves exactly this) — ` +
              `it names no owner, so it is being reclaimed`,
          );
          removeLockIf(this.key, judged);
        }
        await delay(100);
        continue;
      }

      // Lock exists but owner is us — or `am start` filed it FOR us and
      // handed us its secret — take over.
      if (isOwnLock(existing) || _handedOver(existing)) {
        // Our record goes OVER the placeholder, written in place under the
        // mutex (`rewriteLock` — never a rename: the file was published by
        // hard link, and Windows refuses a rename over one): the remove, a
        // 100 ms wait and the create left the slot empty on every dev
        // restart and every `am start` — `am status` read "not running" in
        // between.
        const record = fresh();
        const took = withLockMutex(this.key, () => {
          if (readLockRaw(this.key) !== raw) return false;
          try {
            this._keep(
              rewriteLock(lockPath(this.key), raw!, record, null, true)!,
            );
            return true;
          } catch {
            return false; // aio-ok: refused (Windows, held open) — the remove below, then a create
          }
        });
        if (took) {
          this._record = record;
          this.acquired = true;
          this._registerCleanupHandlers();
          return { ok: true };
        }
        removeLockIf(this.key, raw!);
        await delay(100);
        continue;
      }

      // Lock exists — check if the OWNER is alive (not merely "some process
      // has that pid": a lock under /tmp outlives a reboot, and a recycled pid
      // would make this refuse to boot on account of a stranger's process, or
      // — with killExisting — kill it).
      if (!isLockOwnerAlive(existing)) {
        // Dead process — clean stale lock and retry.
        //
        // …and SAY SO. A graceful shutdown removes this file (see the note on
        // `release`), so a lock whose owner is dead is proof the last run
        // ended abruptly: SIGKILL, an OOM kill, a power cut. Persistence is
        // debounced, so whatever was committed inside the last window died
        // with the process — and the app then comes back looking perfectly
        // healthy, quietly older than it was. MEASURED on a scaffolded
        // counter: `-9` at kill time, `-8` after the restart, not one line
        // logged. The two sibling reclaim paths in this same function — an
        // unreadable lock above, a zombie listener below — both speak; this
        // one, the commonest of the three, was the only mute one.
        // A dev session that was WAITING for a fix held the slot while the
        // app itself was down (its relaunch had died): killed there, it lost
        // no state, and "did not shut down cleanly" would be a false alarm.
        if (existing.waiting) {
          log.info(
            "lock",
            `${printable(this.appId)}: a dev session waiting for a fix ` +
              `(pid ${existing.pid}) is gone — the app was not running, so ` +
              `no state was lost`,
          );
        } else if (takeQuitMark(this.key, raw!)) {
          log.info(
            "lock",
            `the previous run of "${printable(this.appId)}" (pid ` +
              `${existing.pid}) quit cleanly but could not remove its lock ` +
              `file — another process had it open. No state was lost.`,
          );
        } else log.warn("lock", deadOwnerWarning(this.appId, existing));
        try {
          // Waits out a Windows program that has it open, to the bound.
          removeLockFileIf(lockPath(this.key), raw!, true, true);
        } catch (e) {
          // Still held: a scanner looking at a crashed app's file held it for
          // 10 s, and this loop then refused the start "Already running",
          // naming the DEAD pid. A dead owner is not a running app; whether
          // this start may go on without the file is the caller's call — it
          // holds the data folder's own lock, or it does not.
          this._record = fresh();
          return {
            ok: false,
            existing,
            held: e instanceof Error ? e.message : String(e),
          };
        }
        await delay(100);
        continue;
      }

      // Owner's pid is alive but its listener may be dead (zombie: event-loop
      // starvation killed the HTTP server while the process spun on, see
      // watcher-loop field report #5). Liveness = pid alive AND listener
      // responds. Probe whichever transport the owner advertises: TCP port
      // for HTTP servers, UDS for socket-only (prod/electron skipHttp) ones.
      // Grace: skip while the owner is still starting up.
      //
      // A MAINTENANCE hold (`am backup`/`am restore`) has no listener to
      // probe — port 0, no socket — so it is never a zombie while its pid
      // lives, and `killExisting` must not SIGTERM a copy half-way through:
      // refuse, and let the caller name the op.
      if (isHold(existing)) return { ok: false, existing };
      // Alive in ANOTHER pid namespace (its hold file says so): its port or
      // socket may not be reachable from here — no zombie probe — and its pid
      // cannot be signalled from here — no kill. Refused, and said why.
      const foreign = foreignOwnerRefusal(existing);
      if (foreign) {
        if (killExisting) log.warn("lock", foreign);
        return { ok: false, existing };
      }
      // A dev session WAITING for a fix serves nothing until the next save;
      // a new start takes the slot and the session steps aside on its own
      // (its rival poll — dev-restart.ts), exactly as before it named itself
      // here. Never probed as a zombie, never killed.
      if (existing.waiting) {
        log.info(
          "lock",
          `${this.appId}: a dev session waiting for a fix holds the slot ` +
            `(pid ${existing.pid}) — this start takes it; that session ` +
            `steps aside`,
        );
        removeLockIf(this.key, raw!);
        await delay(100);
        continue;
      }
      // A LIVE process that is a zombie by the sustained verdict
      // ({@linkcode zombieVerdict}) is ENDED before its lock is taken: it
      // still has the database open, and a launch that started beside it was
      // two processes on one database by decision instead of by race. A
      // zombie that cannot be ended refuses this start, by name.
      const verdict = await zombieVerdict(this.key, existing, raw);
      if (verdict === "moved") continue;
      if (verdict) {
        log.warn(
          `[AIO] stale instance: ${zombieLine(existing, verdict)}. Ending ` +
            `it to take over (zombie server).`,
        );
        if (!(await _zombieDeps.end(existing))) {
          return { ok: false, existing, unendable: true };
        }
        removeLockIf(this.key, raw!);
        await delay(100);
        continue;
      }

      // Owner is alive — behavior depends on killExisting
      if (killExisting) {
        // End the old instance — ASK it first (`stopInstance`), then wait out
        // the WHOLE graceful budget before forcing it: a takeover is not a
        // reason to truncate the previous instance's final snapshot.
        // Wait out the app's OWN self-kill deadline too (`stopProcess`'s
        // watchdog), not just the phase budget: a takeover that SIGKILLs at
        // 9 s cuts off an app that was about to end itself cleanly at 10 s.
        await stopInstance(existing);
        removeLockIf(this.key, raw!);
        await delay(100);
        continue;
      }

      // killExisting=false (default) — refuse
      return { ok: false, existing };
    }

    // Exhausted retries (persistent race condition)
    const existing = readLock(this.key);
    if (existing) return { ok: false, existing };
    // Last-ditch attempt
    if (tryCreateLock(this._record = fresh(), this._keep)) {
      this.acquired = true;
      this._registerCleanupHandlers();
      return { ok: true };
    }
    // The lock can vanish between that failed create and this read (the owner
    // exited in the gap). `readLock(...)!` asserted it away, and the caller
    // then read `.port` off null — a TypeError from inside the framework
    // instead of "already running", for a race whose honest answer is "someone
    // else holds it and we can't say who".
    return {
      ok: false,
      existing: readLock(this.key) ?? {
        appId: this.appId,
        pid: 0,
        port: 0,
        startedAt: Date.now(),
        status: "starting",
        cwd: "",
        home: this.home,
      },
    };
  }

  /** Update lock data (e.g. status change, socketPath, trojanPort) */
  update(partial: Partial<Omit<LockData, "appId" | "pid" | "home">>): void {
    // Read-check-write as ONE step under the lock's mutex: a check outside it
    // could pass and then overwrite a lock another process took meanwhile.
    withLockMutex(this.key, () => {
      const was = readLockRaw(this.key);
      const existing = parseLock(was, lockPath(this.key));
      if (!existing || !isOwnLock(existing)) {
        // Not ours on disk — but an owner that runs without its file
        // (`adoptUnfiled`) files THIS record when it can: keep it current.
        if (this.acquired && this._record) {
          this._record = { ...this._record, ...partial };
        }
        return;
      }
      this._record = { ...existing, ...partial };
      this._file = rewriteLock(
        lockPath(this.key),
        was!,
        this._record,
        this._file,
        true,
      );
    });
  }

  /** Release the lock — removes the file and unregisters signal handlers */
  /** Something held for exactly as long as this lock — see
   *  {@linkcode AppLock.attach}. */
  private _attached: (() => void)[] = [];

  /** Tie `close` to this lock: it runs when the lock is released. */
  attach(close: () => void): void {
    this._attached.push(close);
  }

  /** The record {@linkcode release} leaves in the slot instead of removing
   *  it (see {@linkcode handOver}). */
  private _handOver: LockData | null = null;

  /** At release, write `next` over this lock rather than removing it — the
   *  dev restart's hand-over: the slot names the supervisor that relaunches
   *  the app from the old app's release until the next child is filed, so
   *  `am status` / `am restart` never read "not running" in between. */
  handOver(next: LockData): void {
    this._handOver = next;
  }

  release(): void {
    for (const close of this._attached.splice(0)) {
      try {
        close();
      } catch { /* aio-ok: a close that fails has nothing left to release */ }
    }
    if (!this.acquired) {
      this._dropHold(); // kept by an acquire that found the file held
      return;
    }
    // Before the removal: on Windows a file is not gone while a handle is on
    // it, and this is one.
    this._dropFile();
    // Only remove if it's still ours (PID matches)
    const { raw, data: now } = readLockAt(lockPath(this.key));
    const ours = !!now && isOwnLock(now);
    const next = this._handOver;
    this._handOver = null;
    // Handed over: the record names the supervisor now — nothing to remove.
    // A hand-over that throws (a write refused part-way) falls back to the
    // removal below: the rest of the release must still run.
    let handed = false;
    let refused: string | null = null;
    if (ours && next !== null) {
      try {
        handed = replaceLockIf(now!, next);
      } catch (e) {
        refused = e instanceof Error ? e.message : String(e);
      }
    }
    if (ours && !handed) {
      // A hand-over refused part-way may have emptied the file
      // (`rewriteLock`), cut it short, or written it whole: each is this
      // release's own leftover, removed like the record it replaced. A
      // record that parses as anything else is a rival's — kept.
      let judged = raw!;
      if (refused !== null) {
        const at = readLockRaw(this.key);
        if (
          at !== null && (parseLock(at) === null || at === JSON.stringify(next))
        ) judged = at;
      }
      try {
        const removed = removeLockFileIf(
          lockPath(this.key),
          judged,
          true,
          true,
        );
        if (refused !== null) {
          log.warn(
            "lock",
            `${printable(this.appId)}: the lock could not be handed to the ` +
              `dev supervisor (${refused}) — ${
                removed
                  ? "removed instead"
                  : "it names another instance now, left to it"
              }; the relaunch files its own`,
          );
        }
      } catch (e) {
        // Held open by another process to the end of the wait. The file
        // stays, and it must not read as a crash: the mark beside it tells
        // the next start this was a clean quit.
        try {
          Deno.writeTextFileSync(quitMarkPath(this.key), raw!, { mode: 0o600 });
        } catch {
          // aio-ok: unmarked, the next start warns as for a crash — what it
          // did before the mark existed.
        }
        log.warn(
          "lock",
          `${printable(this.appId)}: the lock file could not be removed at ` +
            `quit (${e instanceof Error ? e.message : String(e)}) — the ` +
            `next start reclaims it`,
        );
      }
    }
    this._dropHold(); // after the record: never a record naming a gone hold
    this.acquired = false;
    this._unregisterCleanupHandlers();
  }
}

// ── The home claim — one data home, one process ─────────────
//
// The lock FILE lives in a lock dir that `AIO_APPS_DIR` scopes (`--instance`),
// while an app that names its folder (`aio.run({ appDir })`) keeps its data
// where it is. So two scopes could each take "their" lock for ONE data home,
// and two processes wrote one state.db. The claim lives WITH the data: an
// OS lock on `<home>/.aio-instance.lock`, held for the lock's lifetime and
// released by the kernel when the process dies — no stale state to judge.

/** The claim file in a data home (the OS lock), and who holds it (text —
 *  a file locked on Windows cannot be read by another process). */
export const HOME_CLAIM = ".aio-instance.lock";
const HOME_CLAIM_INFO = ".aio-instance.json";

/** Does another LIVE process hold this data folder's claim
 *  ({@linkcode claimHome})? A look, never a claim: the OS lock is taken and
 *  let go at once when it is free. Ground truth even when the lock FILE is
 *  gone — what a start that has not yet taken the lock asks before it
 *  touches anything of a running app (its logs). False when there is no
 *  claim file, or this file system cannot lock. */
export function homeInUse(home: string): boolean {
  let f: Deno.FsFile;
  try {
    f = Deno.openSync(join(home, HOME_CLAIM), { read: true, write: true });
  } catch {
    return false; // aio-ok: no claim file — nothing has claimed this folder
  }
  try {
    if (!f.tryLockSync(true)) return true;
    f.unlockSync();
    return false;
  } catch {
    return false; // aio-ok: no OS locks here — the lock file is all there is
  } finally {
    f.close();
  }
}

/** The homes already said to run without the folder guarantee. */
const _unguarded = new Set<string>();

/** Say, once per home, that it runs without the folder guarantee: its claim
 *  file could not be opened, or its file system cannot lock. The start goes
 *  on — the lock file still keeps one instance per lock scope — but a second
 *  process in ANOTHER scope would no longer be refused on this folder. */
function unguarded(home: string, e: unknown): void {
  if (_unguarded.has(home)) return;
  _unguarded.add(home);
  log.warn(
    "lock",
    `${printable(home)}: the data folder cannot be claimed (${
      printable(e instanceof Error ? e.message : String(e))
    }) — this start goes on without the folder guarantee: one process per ` +
      `lock scope still holds, but a process started under another ` +
      `AIO_APPS_DIR scope would not be refused on this folder.`,
  );
}

/** Take the home claim, or name who holds it.
 *
 *  The claim is an OS lock a process holds for as long as it uses the data
 *  folder, so a LIVE holder is ground truth: someone has this database open,
 *  whatever the lock file says. It always refuses. (A holder filed under
 *  this very lock used to be let through — "the lock file already judged
 *  it" — so a launch that found the lock file gone, or took it from a
 *  process it called a zombie, opened the database beside a live process. A
 *  zombie is ended before its lock is taken now, and a dead holder's OS lock
 *  is gone with it.) A home that does not exist yet and a file system that
 *  cannot lock are not refusals. `who` is written beside the claim, to name
 *  the holder to whoever is refused. @internal */
export function claimHome(
  home: string,
  who: { appId: string; port: number; key?: string },
): /** `guarded`: this process now holds the folder's OS lock. False when
 *  there was nothing to lock (no home yet, a file system that cannot). */
| { ok: true; close: () => void; guarded: boolean }
| {
  ok: false;
  holder?: { pid?: number; appId?: string; lockDir?: string; lock?: string };
} {
  const none = { ok: true as const, close: () => {}, guarded: false };
  let f: Deno.FsFile;
  try {
    f = Deno.openSync(join(home, HOME_CLAIM), {
      read: true,
      write: true,
      create: true,
      mode: 0o600,
    });
  } catch (e) {
    // No home yet: nothing in it to guard. Anything else: said.
    if (!(e instanceof Deno.errors.NotFound)) unguarded(home, e);
    return none;
  }
  let locked: boolean;
  try {
    locked = f.tryLockSync(true);
  } catch (e) {
    f.close();
    unguarded(home, e);
    return none;
  }
  const info = join(home, HOME_CLAIM_INFO);
  if (!locked) {
    f.close();
    let holder:
      | {
        pid?: number;
        appId?: string;
        lockDir?: string;
        lock?: string;
        machine?: string;
        ns?: number;
      }
      | undefined;
    try {
      holder = JSON.parse(Deno.readTextFileSync(info));
    } catch { /* aio-ok: no text — refused, named without it */ }
    return { ok: false, holder };
  }
  try {
    Deno.writeTextFileSync(
      info,
      JSON.stringify({
        pid: Deno.pid,
        appId: who.appId,
        lockDir: lockDir(),
        ...(who.key !== undefined ? { lock: lockPath(who.key) } : {}),
        ...(machineId() !== undefined ? { machine: machineId() } : {}),
        ...(ownPidNs() !== undefined ? { ns: ownPidNs() } : {}),
      }),
      { mode: 0o600 },
    );
  } catch { /* aio-ok: the OS lock is what guards; the text only names it */ }
  return { ok: true, close: () => f.close(), guarded: true };
}

/** This machine's STABLE identity for the home claim: systemd's
 *  `/etc/machine-id` (fixed at install, unlike a hostname). Undefined where
 *  there is none (macOS, Windows) or it may not be read without a prompt —
 *  the claim then names no machine, and the path decides as before. */
let _machineId: string | undefined | null = null;
function machineId(): string | undefined {
  if (_machineId !== null) return _machineId;
  _machineId = undefined;
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      if (
        Deno.permissions.querySync({ name: "read", path }).state !== "granted"
      ) continue;
      const id = Deno.readTextFileSync(path).trim();
      if (/^[0-9a-f]{32}$/.test(id)) return (_machineId = id);
    } catch { /* aio-ok: absent or unreadable — try the next, else none */ }
  }
  return _machineId;
}

// ── instances() — Scan Running Apps ──────────────────────────

/** Scan for running aio instances. Filters stale locks automatically.
 *
 *  A lock file is `<appId>[@<hash8(home)>].lock` (see {@linkcode lockKey});
 *  the identity is read from the LOCK's `appId` + `home`, never parsed back
 *  out of the file name, so a suffixed lock lists as the app it is. `home`
 *  is always filled in — a pre-alpha66 lock means the default home. */
export function instances(appId?: string): InstanceInfo[] {
  const dir = lockDir();
  const results: InstanceInfo[] = [];

  try {
    for (const entry of Deno.readDirSync(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".lock")) continue;
      const key = entry.name.slice(0, -5); // strip ".lock" suffix
      if (appId && parseLockKey(key).appId !== appId) continue;

      // The BYTES, kept: the stale-lock cleanup below deletes only exactly
      // the record judged here, never whatever a new instance put there since.
      const { raw, data: lock } = readLockAt(lockPath(key));
      if (!lock || (appId && lock.appId !== appId)) continue;

      // By OWNER, not by pid: a lock that survived a reboot (the base is
      // `/tmp` whenever XDG_RUNTIME_DIR is unset, and /tmp is not cleared at
      // boot on Debian/Ubuntu) names a pid the kernel has since reused, and
      // `isProcessAlive` would call that stale lock a running app — which is
      // how `am stop` came to SIGTERM a stranger.
      const alive = isLockOwnerAlive(lock);
      if (!alive) {
        // Clean stale lock — naming a killed `am backup`/`am restore` first.
        noteDeadHolder(lock);
        removeLockIf(key, raw!);
        continue;
      }
      results.push({ ...lock, home: lock.home ?? appHome(lock.appId), alive });
    }
  } catch { /* dir not readable */ }

  return results;
}

/** The LIVE instances of ANOTHER apps root (`AIO_APPS_DIR=appsRoot`; `""`:
 *  the default one, no AIO_APPS_DIR), read without moving this process into
 *  it: no lock dir is created, no stale lock removed (that root's own readers
 *  do that). For `am instances`, which lists every `--instance` scope beside
 *  its own, and `peer(id, { instance })`. */
export function liveInstancesUnder(appsRoot: string): InstanceInfo[] {
  const root = appsRoot ? resolve(appsRoot) : "";
  const { base, scope } = _lockDirParts(root);
  const results: InstanceInfo[] = [];
  for (const dir of _lockDirCandidates(base, scope).filter(_exists)) {
    try {
      for (const e of Deno.readDirSync(dir)) {
        if (!e.isFile || !e.name.endsWith(".lock")) continue;
        const { data: lock } = readLockAt(join(dir, e.name));
        if (!lock || !isLockOwnerAlive(lock)) continue;
        results.push({
          ...lock,
          home: lock.home ??
            (root ? join(root, lock.appId) : join(homedir(), `.${lock.appId}`)),
          alive: true,
        });
      }
    } catch { /* aio-ok: dir vanished — nothing live in it */ }
  }
  return results;
}
