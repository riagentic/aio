// App identity + singleton lock for aio apps
// One lock file per app in $XDG_RUNTIME_DIR or /tmp — the lock IS the identity.
// Cross-platform: works on Linux, macOS, Windows
// Prevents multiple instances from corrupting shared resources

import {
  basename,
  dirname,
  fromFileUrl,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@std/path";
import { privateDirRefusal, selfUid } from "./dir-permissions.ts";
import { connectLocal, isPipePath } from "./local-listen.ts";
import {
  appDirs,
  appHome,
  appsDirEnv,
  legacyIdFallback,
  profileNameError,
  profileOfHome,
} from "./app-dirs.ts";
import { log } from "../diagnostics/logger-api.ts";
import {
  _renameDeps,
  isHeldOpenError,
  removeOverSync,
  RENAME_BACKOFF_MS,
} from "../diagnostics/rename-over.ts";
import { EXIT_WAIT_MS } from "./shutdown-budget.ts";
import { appKeyPath, readControlKey } from "./app-key.ts";
import { udsRequest } from "./local-request.ts";
import { locateDenoJsonAbove, readDenoJsonSync } from "./deno-json.ts";
import { inheritedWorkerAppId } from "./cell-worker-protocol.ts";
import { DEFAULT_ENTRY } from "./app-files.ts";

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
  cwd: string; // working directory (for am/instances display)
  /** The resolved data home this instance runs from. Part of the lock's
   *  IDENTITY (see {@linkcode lockKey}): two boots of one appId from two homes
   *  are two apps, not a duplicate. Optional only for locks written before
   *  alpha66 — a missing value means the default home. */
  home?: string;
  socketPath?: string; // UDS socket path (when using UDS transport)
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

// ── App ID Resolution ────────────────────────────────────────

/** Slugify a string for filesystem use — THE transform.
 *
 *  One fact with four copies before this: the appId slug names the lock file,
 *  the data directory, the UDS socket AND the shared-key cookie, and the same
 *  expression was written out in `build-helpers` (binary names),
 *  `electron-shared` (the userData path) and `server.ts` (the cookie). They
 *  agreed, which is the dangerous state: changing the appId rule in one place
 *  would leave two apps whose ids differ only in punctuation sharing a cookie
 *  while holding separate locks — a credential crossing between apps, from an
 *  edit that looked local.
 *
 *  The FALLBACK stays a caller's choice, because it genuinely is one: a lock
 *  with no id is `aio-app`, a nameless binary is `myapp`, a cookie is `app`. */
export function slugify(s: string, fallback = "aio-app"): string {
  const base =
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    fallback;
  // A NON-ASCII name is not a name this can spell, and dropping the letters
  // silently made DIFFERENT apps into ONE. Measured: "Über" and "Ber" both
  // became `ber`, and two apps named entirely in CJK or Cyrillic both became
  // the bare fallback — one `~/.<id>` data directory, one single-instance
  // lock (so the second refuses to start), one UDS socket, one `state.db`,
  // and one shared-key cookie. This function's own header calls that last one
  // "a credential crossing between apps".
  //
  // So a name with a character this alphabet cannot carry gets a short hash
  // of the ORIGINAL. Deliberately narrow: only NON-ASCII input is treated as
  // lossy, so every pure-ASCII id — which is all of them in practice, and
  // every id `cell()` would accept — is byte-identical to before. ASCII
  // punctuation stays a separator, as it always was.
  return _hasNonAscii(s) ? `${base}-${_shortHash(s)}` : base;
}

/** Does `s` carry a character this alphabet cannot spell?
 *
 *  By code point, not by regex: the range that says it (`[^\x00-\x7F]`)
 *  trips `no-control-regex`, and widening it to printable ASCII would make a
 *  tab or a newline "lossy" too — changing the id of a name that reduces
 *  perfectly well today. */
function _hasNonAscii(s: string): boolean {
  for (const ch of s) if (ch.codePointAt(0)! > 0x7f) return true;
  return false;
}

/** FNV-1a, 32-bit, base36. Short, stable across runs and platforms, and
 *  dependency-free — it only has to tell two app names apart. */
function _shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The identity fields of a project's `deno.json`, in the ONE order that decides
 *  an app's id. Null when the file names none of them.
 *
 *  Shared with the BUILD (`build-config.ts` names the binary with it) because a
 *  compiled app takes its identity from its own filename — so the build's
 *  naming rule and this chain are the same decision seen from two sides. They
 *  used to be two: the build read `title ?? basename(root)` and ignored `appId`
 *  outright, so a `deno.json` with `appId: "wallet"` in a directory called
 *  `thing` was `~/.wallet` in dev and `~/.thing` once compiled. The data
 *  directory MOVED when you compiled — the one asterisk `app-dirs.ts` promises
 *  it does not have. */
export function appIdFromConfig(
  cfg: { appId?: string; title?: string; name?: string } | null | undefined,
): string | null {
  // aio-ok: path-split — a package name (`@scope/name`)
  const raw = cfg?.appId ?? cfg?.title ?? cfg?.name?.split("/").pop();
  return raw ? slugify(raw) : null;
}

/** THE zero-config identity of a project: its deno.json's identity fields
 *  ({@link appIdFromConfig}), else the project directory's name.
 *
 *  One rule, three askers — the dev runtime (`resolveAppId`, with the project
 *  found by walking up from the ENTRY), the build (it names the binary with
 *  it, and a compiled app with no declared id takes its identity from that
 *  name) and `am` (from `projectRoot()`). They used to be three rules: dev read
 *  deno.json from the launch CWD only and otherwise took the ENTRY's directory
 *  name, so a pinned `appId` was dropped when `deno run` started from `src/`,
 *  and an entry at `server/main.ts` was `~/.server` in dev but `~/.<project>`
 *  once compiled and to `am`. */
export function projectAppId(
  root: string,
  cfg: { appId?: string; title?: string; name?: string } | null | undefined,
): string {
  return appIdFromConfig(cfg) ?? slugify(basename(root));
}

/** The entry module's `file:` URL, or null (REPL, eval, a remote entry, a
 *  worker — where `Deno.mainModule` is undefined). */
function _fileEntry(): URL | null {
  try {
    const main = new URL(Deno.mainModule);
    return main.protocol === "file:" ? main : null;
  } catch {
    return null;
  }
}

/** The entry's directory name — its parent when the entry sits in `src/`.
 *  The last rung when no deno.json is anywhere near the entry. */
function _entryDirAppId(main: URL): string | null {
  // aio-ok: path-split — a file: URL pathname — always `/`
  const parts = main.pathname.split("/").filter(Boolean);
  parts.pop(); // the entry file itself
  const dir = parts.pop();
  const name = dir === "src" ? parts.pop() : dir;
  // Undecoded, as it always was: this rung's answer for an existing app must
  // not change under it.
  return name ? slugify(name) : null;
}

/** The launch CWD's deno.json identity — only the previous dev rule and a
 *  non-`file:` entry (which has no project of its own to walk from) use it. */
function _cwdConfigAppId(): string | null {
  try {
    // JSONC-aware: `JSON.parse` threw on a deno.json with a comment in it and
    // the id silently fell through to the directory name.
    return appIdFromConfig(
      readDenoJsonSync(Deno.cwd())?.config as
        | { appId?: string; title?: string; name?: string }
        | undefined,
    );
  } catch {
    return null; // unreadable / malformed — fall through
  }
}

/** The PREVIOUS dev rule: the launch CWD's deno.json identity, else the
 *  entry's directory name. Still THE rule for an entry its project does not
 *  declare (see {@link _projectRuleAppId}).
 *
 *  The CWD's deno.json counts only for an entry INSIDE the CWD: from `~/appA`
 *  (`appId: "a"`), `deno run ../appB/src/app.ts` took the id "a" — and
 *  opened appA's `state.db`. */
function _legacyAppId(main: URL): string | null {
  let inside = false;
  try {
    // Real paths on both sides: a symlinked launch path is still inside, and
    // `relative` needs no separator suffix (a cwd of `/` or `C:\` works).
    const real = (p: string) => {
      try {
        return Deno.realPathSync(p);
      } catch {
        return resolve(p);
      }
    };
    const rel = relative(real(Deno.cwd()), real(fromFileUrl(main)));
    inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    // aio-ok: cwd gone — no cwd project to name the entry; the entry-dir rule answers
  }
  return (inside ? _cwdConfigAppId() : null) ?? _entryDirAppId(main);
}

/** The project rule's id ({@link projectAppId}) — or null unless the entry IS
 *  a declared entry of the project found by walking up from it (THE
 *  app-config walk, `locateDenoJsonAbove`, the one `appDenoJson()` uses):
 *  deno.json `entry` (else `DEFAULT_ENTRY`) or a `build.targets` entry —
 *  what `aio build` compiles, so dev == build for every buildable app.
 *
 *  An entry the project does not declare is not "that project's app": a
 *  monorepo root deno.json with no identity above `apps/a/main.ts` and
 *  `apps/b/main.ts` would make both ONE app (one lock, one `state.db`), and an
 *  unrelated `~/deno.json` would name every entry a few levels below it. */
function _projectRuleAppId(main: URL): string | null {
  const located = locateDenoJsonAbove(main);
  if (!located) return null;
  const root = fromFileUrl(located.dir);
  const { entry, targets } = _declaredEntries(located.config);
  const self = fromFileUrl(main);
  if (![entry, ...targets].some((e) => resolve(root, e) === self)) return null;
  const cfg = located.config as {
    appId?: string;
    title?: string;
    name?: string;
  };
  // A project that declares COMPONENTS (several entries in `build.targets`)
  // and names no identity has no single "this app": each entry keeps its own
  // directory's name, which is what `am` computes per component
  // (`componentAppId`). The project folder's name here would make every
  // component ONE app — one lock, one data directory — and the second refused.
  // (Two shells of one entry are one component.)
  if (!appIdFromConfig(cfg) && new Set(targets.map((t) => join(t))).size > 1) {
    return _entryDirAppId(main);
  }
  return projectAppId(root, cfg);
}

/** A deno.json's declared entries: its `entry` (else `DEFAULT_ENTRY`) — what
 *  `aio build` compiles with no target — and each object-form `build.targets`
 *  entry (a target with none compiles `entry`; the array form is one app). */
function _declaredEntries(
  cfg: Record<string, unknown>,
): { entry: string; targets: string[] } {
  const entry = typeof cfg.entry === "string" && cfg.entry
    ? cfg.entry
    : DEFAULT_ENTRY;
  const raw = (cfg.build as { targets?: unknown } | undefined)?.targets;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { entry, targets: [] };
  }
  const targets = Object.values(
    raw as Record<string, { entry?: unknown } | null>,
  ).map((t) =>
    typeof t?.entry === "string" && t.entry.trim() ? t.entry.trim() : entry
  );
  return { entry, targets };
}

/** Dev inference: the project rule for a declared entry, else the previous
 *  rule — and the previous rule's id even for a declared entry while ITS home
 *  holds this app's data and the project rule's home holds none
 *  ({@link legacyIdFallback}), with the warning the boot logs. */
function _devResolution(): { id: string | null; warning: string | null } {
  const main = _fileEntry();
  if (!main) return { id: _cwdConfigAppId(), warning: null };
  const legacy = _legacyAppId(main);
  const project = _projectRuleAppId(main);
  if (!project) return { id: legacy, warning: null };
  const warning = legacyIdFallback(project, legacy);
  return { id: warning ? legacy : project, warning };
}

/** The boot warning when this dev launch's zero-config id fell back to the
 *  previous rule's ({@link legacyIdFallback}), else null. Null too for every
 *  launch that never used that rule (a compiled binary, a worker thread; an
 *  explicit `appId` is the caller's check). */
export function inferredIdFallbackWarning(): string | null {
  if (inheritedWorkerAppId()) return null;
  const main = _fileEntry();
  if (!main) return null;
  // aio-ok: path-split — a file: URL pathname — always `/`
  if (main.pathname.split("/").some((p) => p.startsWith("deno-compile-"))) {
    return null;
  }
  return _devResolution().warning;
}

/** The deno.json that travels INSIDE a compiled binary, next to its entry.
 *  Read relative to `Deno.mainModule` (the VFS), never the launch directory —
 *  through THE app-config walk (`locateDenoJsonAbove`), the same one
 *  `appDenoJson()` uses for the version in the boot banner. It used to be a
 *  private copy that read only `deno.json` with `JSON.parse`: a `deno.jsonc`
 *  app, or a `deno.json` with one comment in it, found no identity, fell back
 *  to the binary's FILE NAME, and every versioned install
 *  (`app-1.2.3` → `~/.app-1-2-3/`) started from empty state. */
function _embeddedDenoJson(): unknown {
  try {
    return locateDenoJsonAbove(new URL(Deno.mainModule))?.config ?? null;
  } catch { /* no usable main module */ }
  return null;
}

/** Resolve app ID — explicit `appId` wins; otherwise inferred. */
export function resolveAppId(appId?: string): string {
  if (appId) return slugify(appId);
  // A `worker: true` cell's thread re-runs the app's entry, and its
  // `aio.run()` asks for the identity again. It must get the OWNER's answer,
  // not a fresh inference: `Deno.mainModule` is undefined inside a worker, so
  // neither the embedded deno.json nor the entry directory below is visible
  // there, and all that is left is the CWD — the one source a compiled binary
  // must never take its identity from. Measured: a compiled app with no
  // explicit appId crashed at boot when launched from `/`, and from another
  // project's directory its worker took that project's identity.
  const inherited = inheritedWorkerAppId();
  if (inherited) return inherited;
  // Compiled binaries: NEVER read the cwd's deno.json — the binary may be
  // launched from an unrelated project and must not adopt ITS identity
  // (locks, KV paths). The VFS path carries the binary name — stable per
  // binary regardless of launch directory.
  try {
    const main = new URL(Deno.mainModule);
    // aio-ok: path-split — a file: URL pathname — always `/`
    const compiledSeg = main.pathname.split("/").find((p) =>
      p.startsWith("deno-compile-")
    );
    if (compiledSeg) {
      // The VFS segment is named after the EXECUTABLE FILE, at runtime — so
      // renaming the binary renames the app. That is not a theoretical
      // objection: installing it as `<name>-<version>` (which is how versioned
      // installs and rollbacks work) gave the app the id `name-1-0-0`, and its
      // data directory moved with it. Every upgrade would then start from an
      // empty `~/.<name>-<newversion>/` while the real state sat in the old
      // one — silent, and exactly the kind of loss `~/.<appId>` exists to
      // prevent. `mv app app.bak` would do the same.
      //
      // The binary EMBEDS its deno.json (that is where the version in the boot
      // banner comes from), so the app's declared identity travels inside it
      // and does not depend on what the file is called. This still never reads
      // the CWD's deno.json — the rule that matters here is "not the launch
      // directory's identity", and an embedded file is the binary's own.
      const embedded = appIdFromConfig(
        _embeddedDenoJson() as
          | { appId?: string; title?: string; name?: string }
          | null,
      );
      if (embedded) return embedded;
      return slugify(compiledSeg.slice("deno-compile-".length));
    }
  } catch { /* no main module — fall through */ }
  // Zero-config inference (dev): THE project rule — the project the ENTRY
  // belongs to, not the directory it was launched from.
  const inferred = _devResolution().id;
  if (inferred) return inferred;
  throw new Error(
    '[aio] cannot infer an appId — add appId: "my-app" to aio.run() or ' +
      'an "appId"/"title" field to deno.json',
  );
}

// ── Lock File Paths ──────────────────────────────────────────

/** Directory for lock + socket files — /tmp/aio/ (or $XDG_RUNTIME_DIR/aio/ on Linux) */
let _lockDir: string | null = null;
let _lockDirKey: string | null = null;
export function lockDir(): string {
  // AIO_APPS_DIR relocates the apps' DATA root — the lock/socket dir scopes
  // with it, so ONE env var isolates an instance completely. A temp $HOME
  // alone used to isolate state but NOT the lock: a sandboxed e2e died on
  // "already running", and its `am` silently reached the production instance
  // (a field report). Must-not-survive-reboot still holds — the
  // base stays $XDG_RUNTIME_DIR//tmp either way.
  //
  // Normalized (`appsDirEnv`), because the dir is named after the STRING:
  // `AIO_APPS_DIR=demo/../apps` for the app and `AIO_APPS_DIR=apps` for `am`
  // are one data root, and were two lock dirs — `am` said "not running" about
  // an app whose data it could see.
  const appsRoot = appsDirEnv() ?? "";
  if (_lockDir && _lockDirKey === appsRoot) return _lockDir;
  const { base, scope } = _lockDirParts(appsRoot);
  _lockDirKey = appsRoot;
  // Which candidates were already there — the preferred path AND the private
  // `aio-u<uid>` fallback `_chooseLockDir` may pick instead: "did this
  // process create it" is asked of the dir actually chosen, not of a path
  // it may not use.
  const before = new Set(
    scope === "" ? [] : _lockDirCandidates(base, scope).filter(_exists),
  );
  _lockDir = _chooseLockDir(base, scope);
  if (scope !== "" && !before.has(_lockDir)) {
    pruneAtExit(_lockDir);
    // Which apps root this dir serves, so the suite's end gate
    // (`scripts/check-orphans.ts`) can tell debris — root deleted, nothing
    // live — from a dir some process is about to use. Only there, AFTER
    // every test has ended: at runtime a missing root is no proof (an
    // `AIO_APPS_DIR` is often created on first use, after its lock dir).
    registerRoot(_lockDir, appsRoot);
  }
  return _lockDir;
}

/** Both dirs `_chooseLockDir(base, scope)` may answer with. */
function _lockDirCandidates(base: string, scope: string): string[] {
  const uid = selfUid();
  return [
    join(base, "aio" + scope),
    ...(uid === null ? [] : [join(base, `aio-u${uid}${scope}`)]),
  ];
}

function _exists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false; // aio-ok: absent is the answer asked for
  }
}

/** The registry entry naming the apps root of scoped lock dir `dir`:
 *  `<base>/.aio-roots/<dir name>`. OUTSIDE the lock dir on purpose — a marker
 *  inside it (`.root`, never released) made the dir non-empty, and a
 *  v1.0.9 app's exit prune is non-recursive: it left every such dir behind.
 *  Only the gate reads it. @internal */
export function rootRegistryEntry(dir: string): string {
  return join(dirname(dir), ".aio-roots", basename(dir));
}

/** Record which apps root `dir` serves. Best effort: an unregistered dir is
 *  one the gate cannot judge, which it counts rather than removes. The
 *  registry is checked like a lock dir (ours, 0700, no link) — under a
 *  shared `/tmp` another account could pre-create it and have this write
 *  follow a link it planted. */
function registerRoot(dir: string, appsRoot: string): void {
  const entry = rootRegistryEntry(dir);
  if (_prepareLockDir(dirname(entry)) !== null) return;
  sweepRootRegistry(dirname(dir));
  try {
    Deno.writeTextFileSync(entry, appsRoot, { mode: 0o600 });
  } catch { /* aio-ok: unregistered dirs are only counted, never swept */ }
}

/** Drop the registry entries under `base` whose lock dir is gone — removed
 *  by something that never unregisters it (a test's recursive cleanup, a
 *  1.0.9 app's prune). Each is a few bytes, but nothing else would ever
 *  clear them. Best effort: a dir re-created in the gap loses its entry, and
 *  an unregistered dir is only ever COUNTED by the gate, never removed.
 *  @internal */
export function sweepRootRegistry(base: string): void {
  const reg = join(base, ".aio-roots");
  let names: string[];
  try {
    names = [...Deno.readDirSync(reg)].map((e) => e.name);
  } catch {
    return; // aio-ok: no registry yet
  }
  for (const n of names) {
    if (_exists(join(base, n))) continue;
    try {
      Deno.removeSync(join(reg, n));
    } catch { /* aio-ok: a sibling dropped it first */ }
  }
}

/** Drop `dir`'s registry entry — after `dir` itself is gone. */
function unregisterRoot(dir: string): void {
  try {
    Deno.removeSync(rootRegistryEntry(dir));
  } catch { /* aio-ok: never registered, or already dropped */ }
}

/** Where `lockDir()` puts the lock dir for an apps root ("" = the shared
 *  one): the base and the `-<scope>` suffix. Pure over the env. */
function _lockDirParts(appsRoot: string): { base: string; scope: string } {
  const base = Deno.build.os === "windows"
    ? (Deno.env.get("TEMP") ?? Deno.env.get("TMP") ?? "C:\\Temp")
    : (Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp");
  const scope = appsRoot
    ? "-" + appsRoot.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      .slice(-48)
    : "";
  return { base, scope };
}

/** {@linkcode pruneDeadLockDirAt} for the scoped lock dir of `appsRoot` (an
 *  absolute `AIO_APPS_DIR`) — for a supervisor that owns that root and knows
 *  its processes are done (the test runner, after a shard). @internal */
// aio-ok: a seam for the test runner (scripts/test-shards.ts), not the product
export function pruneDeadLockDir(appsRoot: string): boolean {
  if (!appsRoot) return false;
  const { base, scope } = _lockDirParts(appsRoot);
  return pruneDeadLockDirAt(join(base, "aio" + scope));
}

/** {@linkcode pruneDeadLockDirAt} for every scoped lock dir whose name carries
 *  `tag` — the unique tail of a temp dir's name, which every apps root under
 *  it puts into its scope (whatever the subpath, so long as it keeps the
 *  48-char scope). Returns how many were removed. @internal */
export function pruneDeadLockDirsTagged(tag: string): number {
  if (tag.length < 8) return 0; // too short to be unique — never guess
  const { base } = _lockDirParts("x");
  let n = 0;
  let names: string[];
  try {
    names = [...Deno.readDirSync(base)]
      .filter((e) => e.isDirectory && e.name.startsWith("aio-"))
      .map((e) => e.name);
  } catch {
    return 0; // aio-ok: no runtime base — nothing was created in it
  }
  for (const name of names) {
    // The temp dir is gone before this runs: its root is gone.
    if (name.includes(tag) && pruneDeadLockDirAt(join(base, name), true)) n++;
  }
  return n;
}

/** Remove the scoped lock dir `dir` once nothing LIVE is in it — file by
 *  file, only the kinds this module knows how to judge dead, then the dir
 *  itself NEVER recursively:
 *  - a `.lock` whose owner is dead — compare-and-delete against the exact
 *    bytes judged, so a lock re-published meanwhile is never the one removed;
 *    an unparsable one only by {@linkcode unknownLockDead};
 *  - an idle `.lock.mx` mutex; a `watch-<pid>.tmp` / `<lock>.<pid>.<n>.tmp`
 *    whose pid is gone;
 *  - a `.sock` / `.http.sock` nobody is bound to (Linux: absent from
 *    `/proc/net/unix`; elsewhere unknown, so it stays) — a `singleton: false`
 *    app holds no lock, and its socket is the only sign it is alive;
 *  - a legacy `<appId>.launch.json`, or a second launch's `<key>.show`
 *    request, with no lock of that app beside it.
 *  Anything else keeps the dir. For a throwaway apps root whose processes are
 *  done — a test's temp dir, where a SIGKILLed child app leaves exactly these
 *  behind and no creator is alive to prune them — and the suite's end gate.
 *  The shared (unscoped) dir is never passed here. @internal */
export function pruneDeadLockDirAt(dir: string, rootGone = false): boolean {
  let names: string[];
  try {
    names = [...Deno.readDirSync(dir)].map((e) => e.name);
  } catch {
    return false; // aio-ok: never created, or already gone
  }
  let bound: Set<string> | null | undefined;
  for (const n of names) {
    const path = join(dir, n);
    if (n.endsWith(".lock")) {
      // Read through the path: `readLock` resolves under `lockDir()`, which
      // may be a different scope in this process.
      const { raw, data: own } = readLockAt(path);
      if (raw === null) continue; // gone, or not a file — rmdir decides
      if (!own) {
        if (unknownLockDead(path, raw, rootGone)) removeLockFileIf(path, raw);
        continue;
      }
      // Naming THIS process but held by no lock of it: a hand-written record
      // (a test fixture) — as dead as its writer is about to be.
      const planted = isOwnLock(own) &&
        !AppLock.live().some((l) => lockPath(l.key) === path);
      if (planted || !isLockOwnerAlive(own)) removeLockFileIf(path, raw);
    } else if (n.endsWith(".lock.mx") || n.endsWith(".hold")) {
      dropIdleMutex(path);
    } else if (/\.sock$/.test(n)) {
      if (bound === undefined) bound = boundUnixSockets();
      if (bound && !bound.has(path)) removeIfSocket(path);
    } else {
      const m = new RegExp(`^watch-${PID_TAG}\\.tmp$`).exec(n) ??
        new RegExp(`\\.lock\\.${PID_TAG}\\.[0-9a-f]{8}\\.tmp$`).exec(n);
      // With the apps root gone, an untagged file (an older build, or no
      // `/proc` access) goes once its pid is dead — the 10-minute age wait
      // is for a root something may still live under.
      if (
        m && (taggedOwnerGone(path, Number(m[1]), m[2]) ||
          (rootGone && !isProcessAlive(Number(m[1]))))
      ) {
        try {
          Deno.removeSync(path);
        } catch { /* aio-ok: a sibling removed it first */ }
      }
    }
  }
  // A pre-alpha38 `<appId>.launch.json` (nothing writes one there now; it is
  // only read) goes once no lock of that app is left beside it.
  for (const n of names) {
    const m = /^(.+)\.(?:launch\.json|show|quit)$/.exec(n);
    if (m && !_exists(join(dir, `${m[1]}.lock`))) {
      try {
        Deno.removeSync(join(dir, n));
      } catch { /* aio-ok: already gone */ }
    }
  }
  try {
    Deno.removeSync(dir);
  } catch {
    return false; // aio-ok: something live (or unknown) is in it — kept
  }
  unregisterRoot(dir);
  if (_lockDir === dir) {
    _lockDir = null;
    _lockDirKey = null;
  }
  return true;
}

/** An unparsable lock is written by nothing live: a publish is atomic (the
 *  record exists whole or not at all), so it is a torn 1.0.9 write, a hand
 *  edit, or debris. It goes when it names no live pid AND either its apps
 *  root is gone (`rootGone`: the caller checked — the gate) or it has not
 *  been touched for {@linkcode TORN_LOCK_AGE_MS}. Kept forever, it made its
 *  dir un-prunable while the gate counted it as a leftover. */
const TORN_LOCK_AGE_MS = 10 * 60_000;
function unknownLockDead(
  path: string,
  raw: string,
  rootGone: boolean,
): boolean {
  let pid: unknown;
  try {
    pid = (JSON.parse(raw) as { pid?: unknown } | null)?.pid;
  } catch { /* aio-ok: not JSON — no owner named */ }
  if (typeof pid === "number" && pid > 0 && isProcessAlive(pid)) return false;
  if (rootGone) return true;
  try {
    const m = Deno.statSync(path).mtime;
    return m !== null && ageSince(m.getTime()) > TORN_LOCK_AGE_MS;
  } catch {
    return false; // aio-ok: gone meanwhile — nothing to judge
  }
}

/** Paths of the unix sockets some process is bound to, or null where that
 *  cannot be read — "unknown", never "none".
 *  - Linux: `/proc/net/unix` (the path is the 8th column on);
 *  - macOS: `netstat -f unix -n` (the path is the 9th column on — measured on
 *    the macOS 14 VM; it is the path as bound, `/tmp/…` not `/private/tmp`).
 *  Without it a SIGKILLed app's socket was "unknown" on macOS and kept its
 *  lock dir forever — a CI shard's runtime dir with it.
 *  `read`/`os` are seams (a table a test builds). @internal */
export function boundUnixSockets(
  read?: () => string,
  os: typeof Deno.build.os = Deno.build.os,
): Set<string> | null {
  const firstPathCol = os === "darwin" ? 8 : 7;
  let text: string;
  try {
    text = read
      ? read()
      : os === "linux"
      ? Deno.readTextFileSync("/proc/net/unix")
      : os === "darwin"
      ? netstatUnix()
      : (() => {
        throw new Error("no socket table on " + os);
      })();
  } catch {
    return null; // aio-ok: no table readable here — liveness unknown
  }
  // The path is the RAW remainder after the fixed columns — never split and
  // rejoined, which folded `a  b` and `a\tb` into `a b` and named a socket
  // that does not exist (its own dir then read as dead). A path always starts
  // with `/`, so the gap before it is unambiguous.
  const row = new RegExp(`^\\s*(?:\\S+\\s+){${firstPathCol}}(/.*?)\\r?$`);
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const path = row.exec(line)?.[1];
    if (path === undefined) continue;
    out.add(path);
    try {
      out.add(Deno.realPathSync(path)); // a caller may name it either way
    } catch { /* aio-ok: gone meanwhile — the bound name is enough */ }
  }
  return out;
}

/** macOS's socket table, as text; throws when it cannot be read. */
function netstatUnix(): string {
  const r = new Deno.Command("netstat", {
    args: ["-f", "unix", "-n"],
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  if (!r.success) throw new Error("netstat failed");
  return new TextDecoder().decode(r.stdout);
}

/** Remove `path` only if it is still a socket (never a file swapped in). */
function removeIfSocket(path: string): void {
  try {
    if (Deno.lstatSync(path).isSocket) Deno.removeSync(path);
  } catch { /* aio-ok: gone meanwhile */ }
}

/** Re-create a lock dir a sibling's prune removed between our `lockDir()`
 *  and our write. A scoped one is then OURS to prune at exit, like one
 *  `lockDir()` created — else it outlived every process, unmarked. */
function remakeLockDir(dir: string): void {
  const was = _exists(dir);
  // The same checks `lockDir()` made (ours, 0700, not a link) — EVERY time,
  // not only when it is missing: under a shared `/tmp` another account can
  // create the path in the gap a prune opened, and "it exists" is exactly
  // what that looks like.
  const why = _prepareLockDir(dir);
  if (why !== null) throw new Error(`aio: ${why}`);
  const appsRoot = appsDirEnv() ?? "";
  if (was || appsRoot === "" || dir !== _lockDir) return;
  pruneAtExit(dir);
  registerRoot(dir, appsRoot);
}

/** Make sure the lock dir holding `path` exists before a file is created in
 *  it — a control socket, the watcher's sentinel. `lockDir()` is cached, and
 *  a sibling's exit prune removes the dir whenever it is empty: a
 *  `singleton: false` app (no lock to keep it) then bound its socket into a
 *  void, ENOENT. No-op for a pipe name or a dir that is there. */
export function ensureLockDirOf(path: string): void {
  if (isPipePath(path)) return; // a Windows pipe name, not a file
  const dir = dirname(path);
  // Only a LOCK dir gets the lock dir's rules — this one, or the `/tmp`
  // fallback `resolveSocketPath` picks (`aio` / `aio-u<uid>`). A socket path
  // a caller chose (`createUDSListener` is public) is left as it was: its
  // directory is theirs to make, and chmodding it 0700 is not ours to do.
  if (dir !== lockDir() && !/^aio(-u\d+)?$/.test(basename(dir))) return;
  remakeLockDir(dir);
}

/** Scoped lock dirs THIS process created, removed (when empty) at exit. */
const _madeScoped = new Set<string>();
let _pruneArmed = false;

/** A scoped (`AIO_APPS_DIR`) lock dir is created by whoever first asks for
 *  it — an app, but just as often `am backup`, `am status`, or a test calling
 *  `AppLock` in-process — and only an app's shutdown ever pruned it. Every
 *  other creator left it behind in `$XDG_RUNTIME_DIR`: measured, ~5,400 empty
 *  `aio-<scope>` dirs from one day of test runs. The creator now removes it
 *  at exit, by the same rule as {@linkcode pruneLockDir}: only when empty
 *  (idle mutexes dropped first), never recursively — a sibling's live lock
 *  or socket keeps it. Its own held locks are released first, since the
 *  `unload` that releases them may run after this one. */
function pruneAtExit(dir: string): void {
  _madeScoped.add(dir);
  if (_pruneArmed) return;
  _pruneArmed = true;
  try {
    addEventListener("unload", () => {
      for (const l of AppLock.live()) l.release();
      for (const d of _madeScoped) {
        dropOwnPlants(d);
        pruneScopedDir(d);
      }
      _madeScoped.clear();
    });
  } catch { /* aio-ok: no global event target — nothing to arm */ }
}

/** Remove, from `dir`, lock files that name THIS process but that no lock it
 *  holds wrote — records written by hand (`writeLock`, a test's fixture) that
 *  outlive the process they name, and this process's own `watch-<pid>.tmp`
 *  sentinel. Only this process's own: another's dead
 *  lock is left for the next acquire, which says what that death may have
 *  cost. Called at exit, after every held lock is released. */
function dropOwnPlants(dir: string): void {
  // This process's live-reload sentinel (`server-watcher.ts`): its watcher is
  // gone with the process, and left behind it keeps the dir from pruning.
  try {
    const sentinel = join(dir, `watch-${ownPidTag()}.tmp`);
    if (Deno.lstatSync(sentinel).isFile) Deno.removeSync(sentinel);
  } catch { /* aio-ok: no sentinel — this process never watched here */ }
  let names: string[];
  try {
    names = [...Deno.readDirSync(dir)]
      .filter((e) => e.isFile && e.name.endsWith(".lock"))
      .map((e) => e.name);
  } catch {
    return; // aio-ok: gone — nothing planted in it
  }
  for (const n of names) {
    const path = join(dir, n);
    try {
      const raw = Deno.readTextFileSync(path);
      // Compare-and-delete: only the record read, never one written since.
      const l = parseLock(raw);
      if (l && isOwnLock(l)) removeLockFileIf(path, raw);
    } catch { /* aio-ok: unreadable or gone — not ours to judge */ }
  }
}

/** Remove `dir` if nothing but idle mutex files is in it. */
function pruneScopedDir(dir: string): boolean {
  try {
    for (const e of Deno.readDirSync(dir)) {
      if (e.isFile && e.name.endsWith(".lock.mx")) {
        dropIdleMutex(join(dir, e.name));
      }
    }
  } catch { /* aio-ok: the dir is already gone — nothing to prune */ }
  try {
    Deno.removeSync(dir);
  } catch {
    return false; // aio-ok: not empty (a sibling's lock/socket), or gone
  }
  unregisterRoot(dir);
  if (_lockDir === dir) {
    _lockDir = null;
    _lockDirKey = null;
  }
  return true;
}

/** Create `dir` 0700 and say why it still cannot hold a control socket.
 *
 *  The 0700 is NOT tidiness: the base is `$XDG_RUNTIME_DIR` (already 0700, so
 *  the chmod is a no-op) OR `/tmp` when that is unset — containers,
 *  no-systemd hosts, plain ssh. There the default 0755 left every app's
 *  control socket at a predictable path any local user could traverse to and
 *  connect to, i.e. dispatch methods into someone else's app.
 *
 *  It used to stop at the chmod and swallow the failure, which is the half
 *  that does not hold: chmod on a directory you do not own returns EPERM, so
 *  a `/tmp/aio` somebody else created — at 0777, or at 0700 as themselves —
 *  was then used exactly as if the chmod had worked. Create, narrow, and then
 *  LOOK. */
export function _prepareLockDir(
  dir: string,
  // A seam, because the case that matters cannot be built in a test: chmod
  // fails with EPERM only on a directory owned by ANOTHER account, and a test
  // has exactly one uid. Injecting the chmod reproduces it exactly — the same
  // branch, for the same reason — instead of leaving the wiring unproven and
  // the pure rule tested in isolation. @internal
  ops: {
    chmod?: (path: string, mode: number) => void;
    stat?: (path: string) => Deno.FileInfo;
    /** The same seam, for the OTHER account's half of the symlink case: a
     *  link this process planted is its own, and a test has one uid.
     *  @internal */
    lstat?: (path: string) => Deno.FileInfo;
  } = {},
): string | null {
  const chmod = ops.chmod ?? Deno.chmodSync;
  const stat = ops.stat ?? Deno.statSync;
  const lstat = ops.lstat ?? Deno.lstatSync;
  try {
    Deno.mkdirSync(dir, { recursive: true });
  } catch { /* already exists — the stat below is the real check */ }
  try {
    if (Deno.build.os !== "windows") chmod(dir, 0o700);
  } catch { /* not ours to chmod — precisely what the stat is for */ }
  if (Deno.build.os === "windows") return null; // no POSIX mode to read
  // The LOOK must not be pointed somewhere else. `stat` FOLLOWS a symlink, so
  // on the host this rule exists for — no `$XDG_RUNTIME_DIR`, base `/tmp`, a
  // predictable path any local account can pre-create — another user can make
  // `/tmp/aio` a link to a directory of OURS that is already 0700 (`~/.ssh`,
  // `~/.config/…`) and every check below passes: the target's mode is 0700
  // and its owner is us. The app's lock files and its control socket then sit
  // where somebody else decided.
  //
  // The link's OWN owner is the question, because that is the part they have
  // to forge: a link they planted is theirs, and a link we (or the user) made
  // is ours and its target is still judged below. An uid we cannot read is
  // "cannot tell", which must not refuse — the same rule as everywhere else
  // here.
  try {
    const link = lstat(dir);
    const me = selfUid();
    if (
      link.isSymlink && me !== null && link.uid !== null &&
      link.uid !== undefined && link.uid !== me
    ) {
      return `${dir} is a symbolic link owned by uid ${link.uid}, not by you ` +
        `(uid ${me}) — whoever owns the link chooses where this app's lock ` +
        `and control socket actually go`;
    }
  } catch {
    // aio-ok: the symlink question is an EXTRA screen, not the decision. If
    // lstat cannot answer — the path vanished between the mkdir above and
    // here, or the parent directory is unreadable — the `stat` below is the
    // real check and it refuses loudly with the reason. Swallowing here
    // cannot make a bad directory look good; it can only defer to the gate
    // that was always the one saying yes.
  }
  let st: Deno.FileInfo;
  try {
    st = stat(dir);
  } catch (e) {
    return `${dir} cannot be created or read (${
      e instanceof Error ? e.message : e
    })`;
  }
  if (!st.isDirectory) return `${dir} exists and is not a directory`;
  return privateDirRefusal(dir, st.mode, st.uid);
}

/** The lock/socket directory this process may actually use.
 *
 *  Shared `<base>/aio` first — one directory per machine keeps `am` able to
 *  see every app of THIS user. When that one belongs to somebody else, a
 *  uid-scoped sibling is used instead: it is the same isolation the shared
 *  directory was supposed to provide, and it also fixes the case that was
 *  merely broken rather than unsafe — a second user on a host with no
 *  `$XDG_RUNTIME_DIR` could not bind in the first user's 0700 directory and
 *  got an unexplained bind failure.
 *
 *  If the fallback is unusable too, that is not a configuration this can paper
 *  over, and a control socket is not something to place hopefully.
 *
 *  Exported because `resolveSocketPath`'s long-path fallback places a control
 *  socket in a shared `/tmp` too and must ask the SAME question — it used to
 *  mkdir + chmod and hope, which is the half that does not hold. @internal
 *  @decider */
export function _chooseLockDir(base: string, scope: string): string {
  const preferred = join(base, "aio" + scope);
  const first = _prepareLockDir(preferred);
  if (first === null) return preferred;
  const uid = selfUid();
  if (uid === null) {
    throw new Error(
      `aio: ${first}, and this process cannot read its own uid to pick a ` +
        `private directory instead. Set XDG_RUNTIME_DIR to a directory you ` +
        `own, or grant --allow-sys.`,
    );
  }
  const scoped = join(base, `aio-u${uid}${scope}`);
  const second = _prepareLockDir(scoped);
  if (second === null) {
    log.warn(
      `${first} — using ${scoped} for this app's lock and control socket ` +
        `instead. Other users' aio apps are not visible to \`am\` from here.`,
    );
    return scoped;
  }
  throw new Error(
    `aio: refusing to place a control socket where another local user can ` +
      `reach it. ${first}; the private fallback failed too: ${second}. ` +
      `A control socket lets whoever connects dispatch methods into this app. ` +
      `Fix: remove or chmod 700 the directory named above, or set ` +
      `XDG_RUNTIME_DIR to a directory you own.`,
  );
}

/** Remove the per-`AIO_APPS_DIR` lock dir when it is empty — called at the
 *  very end of an app's shutdown. The default dir (`…/aio`) is never removed;
 *  it is shared by every app on the machine and costs nothing. A scoped one
 *  belongs to a temp home that is about to be deleted, and used to outlive it
 *  forever. Non-recursive on purpose: another app's lock or a live watcher
 *  sentinel makes the rmdir fail, which is the right answer. */
export function pruneLockDir(): void {
  if (!_lockDir || !appsDirEnv()) return;
  // A crashed app's idle mutex file would keep the dir non-empty forever.
  // On success the cached answer is forgotten, so the next `lockDir()` call
  // re-creates it (a later app in this same process — every sequential test
  // — must not write into a void).
  pruneScopedDir(_lockDir);
}

/** 8 hex chars of FNV-1a over `s` — a filename-safe tag, not a secret. */
export function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** THE key a lock (and its sockets) is filed under: `<appId>` when the app runs
 *  from its default home, `<appId>@<hash8(home)>` otherwise.
 *
 *  The lock used to be keyed by appId alone, so an app booted a second time
 *  ON PURPOSE from an isolated home (`--<app>-home=/tmp/x` for a smoke test or
 *  a screenshot harness) was refused as a duplicate — and the refusal named
 *  the USER's port and pid, which is how a harness came to `kill` the user's
 *  running wallet (a field report, §2.1). Identity is appId AND home: one
 *  data dir, one instance. The default home keeps the plain name, so nothing
 *  already running or already written needs migrating. */
export function lockKey(
  appId: string,
  home?: string,
  profile?: string,
): string {
  if (!home) return appId;
  const want = resolve(home);
  if (want === resolve(appHome(appId))) return appId;
  // A PROFILE's home is filed under its name — `myapp@dev` — never a hash: a
  // name cannot look like one (profileNameError refuses 8 hex digits). The
  // default base (`~/.myapp-dev`) is recognised from the home alone; an
  // `appDir` app's (`/opt/myapp-dev`) from the profile its lock RECORDS
  // (`LockData.profile`), which every reader passes back in.
  const named = profile !== undefined && want.endsWith(`-${profile}`) &&
      profileNameError(profile) === null
    ? profile
    : profileOfHome(appId, want);
  if (named) return `${appId}@${named}`;
  return `${appId}@${hash8(want)}`;
}

/** The two halves of a lock key / lock file name. */
export function parseLockKey(key: string): { appId: string; tag?: string } {
  const at = key.lastIndexOf("@");
  return at > 0
    ? { appId: key.slice(0, at), tag: key.slice(at + 1) }
    : { appId: key };
}

/** The key of the lock THIS process holds for `appId`, else the plain appId.
 *  The socket paths (`paths.ts`) are named by it, so an instance's control
 *  socket follows its lock: `am --home=<dir>` reads that lock and finds that
 *  socket, never the default instance's. */
export function heldLockKey(appId: string): string {
  for (const l of AppLock.live()) if (l.appId === appId) return l.key;
  return appId;
}

/** Full path to the lock file for a given lock key (see {@linkcode lockKey}) */
export function lockPath(key: string): string {
  return join(lockDir(), `${key}.lock`);
}

/** Where a second launch asks the running window of the instance under lock
 *  `key` to come to the front — beside the lock, in the 0700 lock dir. The
 *  window watches it (`AioMeta.showFile`); see `askRunningToShow` (aio-run-helpers.ts). */
export function showRequestPath(key: string): string {
  return join(lockDir(), `${key}.show`);
}

/** The show-request file of the lock this process holds for `appId`, or
 *  undefined when it holds none (`singleton: false`, `libraryMode`): with no
 *  lock there is no "second launch" to answer. */
export function heldShowRequestPath(appId: string): string | undefined {
  const l = AppLock.live().find((l) => l.appId === appId);
  return l ? showRequestPath(l.key) : undefined;
}

// ── Launch-info sidecar (am restart flag preservation) ───────
// The running app can't recover deno-runtime flags (e.g. --env-file) from its
// own Deno.args — only the launcher (am) knows them. am records them here at
// start so `am restart` can replay the exact launch; am-owned, the app's _run()
// never touches it. (a field report: restart dropped --env-file, so
// the vault silently stopped auto-unlocking.)
export type LaunchInfo = { flags: string[]; entry?: string; cwd?: string };

/** Path to am's launch-info sidecar: `~/.<appId>/launch.json`.
 *
 *  Two things this is NOT, both learned the hard way:
 *
 *  • not the runtime dir — a launch record has to outlive the machine (`am start`
 *    in the morning, reboot, `am restart` in the afternoon must still replay
 *    `--env-file`). `$XDG_RUNTIME_DIR` is cleared on logout BY DESIGN, which is
 *    exactly right for the lock and socket and exactly wrong for this.
 *  • not a shared toolchain directory — these are THIS app's flags, so keeping
 *    them with the app means "delete the app" is one `rm -rf` and there is no
 *    second root to relocate when sandboxing. */
export function launchInfoPath(appId: string): string {
  return appDirs(appId).launch;
}

/** Pre-alpha38: the record lived in the runtime dir, so it vanished on logout. */
function legacyLaunchPath(appId: string): string {
  return join(lockDir(), `${appId}.launch.json`);
}

/** Record the flags am launched an app with (best-effort). */
export function writeLaunchInfo(
  appId: string,
  info: LaunchInfo,
): string | null {
  // The app's HOME, not a lock dir: a plain mkdir, as ever. The lock dir's
  // rules (chmod 0700, refuse what is not ours) have no business here — a
  // home on exFAT/NTFS/CIFS or owned by another uid cannot be chmodded, and
  // applying them made launch.json silently vanish, so `am restart` came back
  // without the `--env-file` it was started with (a field bug, twice).
  const path = launchInfoPath(appId);
  try {
    Deno.mkdirSync(dirname(path), { recursive: true });
    Deno.writeTextFileSync(path, JSON.stringify(info));
    return null;
  } catch (e) {
    // Said, never swallowed: the caller prints it where the operator looks.
    return `could not record this launch in ${path} (${
      e instanceof Error ? e.message : String(e)
    }) — \`am restart\` will not replay its flags (--env-file, --port, …)`;
  }
}

/** Read the recorded launch info, or null if none/corrupt. */
export function readLaunchInfo(appId: string): LaunchInfo | null {
  // The pre-alpha38 runtime-dir location is still read, so an app already
  // running when aio was upgraded can still be restarted with its flags.
  for (const path of [launchInfoPath(appId), legacyLaunchPath(appId)]) {
    try {
      const info = JSON.parse(Deno.readTextFileSync(path)) as LaunchInfo;
      if (Array.isArray(info.flags)) return info;
    } catch { /* next */ }
  }
  return null;
}

/** Remove the launch sidecar (on a clean stop) — both locations. */
export function removeLaunchInfo(appId: string): void {
  for (const path of [launchInfoPath(appId), legacyLaunchPath(appId)]) {
    try {
      Deno.removeSync(path);
    } catch { /* already gone */ }
  }
}

// ── Process Liveness ─────────────────────────────────────────

/** This process's pid namespace (the inode of Linux's `/proc/self/ns/pid`),
 *  or undefined where there is none to read. Two containers sharing one
 *  bind-mounted directory can both be pid 1: a pid means something only
 *  inside the namespace that wrote it. */
let _ownNs: number | undefined | null = null;
export function ownPidNs(): number | undefined {
  if (_ownNs === null) {
    _ownNs = undefined;
    try {
      const m = /\[(\d+)\]/.exec(Deno.readLinkSync("/proc/self/ns/pid"));
      const n = m ? Number(m[1]) : NaN;
      if (n > 0 && n <= 0xffffffff) _ownNs = n;
    } catch { /* aio-ok: no /proc (macOS, Windows) — no namespace to record */ }
  }
  return _ownNs;
}

/** How a file names the process it belongs to: `<pid>`, plus `d<ns, 8 hex>`
 *  where Linux has pid namespaces (see {@linkcode taggedOwnerGone}). */
export function ownPidTag(): string {
  const ns = ownPidNs();
  return `${Deno.pid}${
    ns === undefined ? "" : `d${ns.toString(16).padStart(8, "0")}`
  }`;
}

/** The `<pid>[d<ns>]` of {@linkcode ownPidTag}, as a regex source: groups
 *  pid, namespace hex. */
const PID_TAG = String.raw`(\d+)(?:d([0-9a-f]{8}))?`;

/** Is the process a file's name tags (`pid`, namespace hex `ns`) gone? A pid
 *  means something only in the namespace that wrote it: ours (or none on
 *  either side — macOS, Windows), its death decides. Another namespace (a
 *  container sharing this dir, where pid 7 is not ours), or no namespace
 *  recorded where one exists (an older aio's name): only once the file went
 *  untouched for {@linkcode TORN_LOCK_AGE_MS} — its owner finishes such a
 *  file in microseconds or refreshes it (the watch sentinel, every 30 s). A
 *  future mtime (a skewed clock) counts as fresh. @internal */
export function taggedOwnerGone(
  path: string,
  pid: number,
  ns: string | undefined,
): boolean {
  if ((ns === undefined ? undefined : parseInt(ns, 16)) === ownPidNs()) {
    return pid <= 0 || !isProcessAlive(pid);
  }
  try {
    const m = Deno.statSync(path).mtime;
    return m !== null && Date.now() - m.getTime() > TORN_LOCK_AGE_MS;
  } catch {
    return false; // aio-ok: gone meanwhile — nothing to judge
  }
}

/** Check if a process is alive via signal 0 */
export function isProcessAlive(pid: number): boolean {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the pid EXISTS but belongs to another user — that process
    // is alive. Conflating it with ESRCH ("no such process") made every
    // liveness guard (backup/restore live-writer refusal, lock takeover)
    // treat an app running under a different account as stopped.
    return e instanceof Deno.errors.PermissionDenied;
  }
}

/** A stamp the KERNEL controls that changes when a pid is recycled, or null
 *  when this platform cannot say.
 *
 *  Linux: field 22 of `/proc/<pid>/stat` — the process's start time in clock
 *  ticks since boot. (Field 2, `comm`, may contain spaces and parentheses, so
 *  it is cut at the LAST `)` before splitting — a bug every naive parse of
 *  this file has.) Linux only: macOS's identity is {@linkcode
 *  processStartEpoch} in its own field (`startEpoch`). Its token used to be
 *  `ps -o lstart=` TEXT, which varies with the reader's TZ and locale — a
 *  reader in another zone than the writer judged a live owner's pid
 *  "recycled", and a second instance opened the same state.db.
 *
 *  Pure read, no signal, no side effect. Returns null (rather than throwing)
 *  for a pid that is gone — the caller's liveness check owns that answer. */
export function processStartToken(pid: number): string | null {
  if (!(pid > 0)) return null;
  try {
    if (Deno.build.os === "linux") {
      const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
      const after = stat.slice(stat.lastIndexOf(")") + 2);
      const f = after.split(" ");
      // stat fields are 1-based and `after` begins at field 3, so field 22 is
      // index 19.
      const ticks = f[19];
      return ticks && /^\d+$/.test(ticks) ? ticks : null;
    }
  } catch { /* no /proc entry, no permission — we simply cannot say */ }
  // macOS: see `processStartEpoch` / `LockData.startEpoch` — its token was
  // reader-locale text, so there is deliberately none any more.
  return null;
}

const _MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `ps -o lstart=` output under `LC_ALL=C TZ=UTC` ("Tue Sep 23 07:45:12
 *  2026") → epoch seconds, or null for anything else. Pure. @internal */
export function parseLstartUtc(text: string): number | null {
  const m =
    /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/
      .exec(text);
  if (!m) return null;
  const mon = _MONTHS.indexOf(m[1]!);
  if (mon < 0) return null;
  const ms = Date.UTC(+m[6]!, mon, +m[2]!, +m[3]!, +m[4]!, +m[5]!);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** How `processStartEpoch` bounds `ps`. Mutable only as a test seam (a `ps`
 *  that hangs cannot be built portably otherwise). @internal */
export const PS_TIMEOUT = { perl: "perl", ps: "ps", seconds: 2 };

/** macOS: when `pid` started, in epoch seconds — identical for every reader
 *  (`ps` run with `LC_ALL=C`, `TZ=UTC`). Null elsewhere or when unknown. */
export function processStartEpoch(
  pid: number,
  // A seam: the bounded `ps` is exercised on Linux too (procps prints the
  // same C-locale `lstart`). @internal
  os: typeof Deno.build.os = Deno.build.os,
): number | null {
  if (!(pid > 0) || os !== "darwin") return null;
  // Bounded: this runs synchronously inside every liveness check, and a `ps`
  // that hangs (a wedged process table, a stuck NFS home) would hang `am`
  // and the boot with it. macOS has no `timeout(1)`; perl is the portable
  // sync bound — it runs `ps` in its OWN process group and, at the alarm,
  // kills the whole group (killing `ps` alone is not enough: a descendant
  // still holding the stdout pipe keeps the read open — measured on the
  // macOS VM). A timeout is "unknown" (null) → pid liveness decides.
  const args = ["-o", "lstart=", "-p", String(pid)];
  const run = (cmd: string, argv: string[]) =>
    new Deno.Command(cmd, {
      args: argv,
      env: { LC_ALL: "C", LANG: "C", TZ: "UTC" },
      stdout: "piped",
      stderr: "null",
    }).outputSync();
  try {
    let r: Deno.CommandOutput;
    try {
      r = run(PS_TIMEOUT.perl, [
        "-e",
        `my $p = fork; exit 125 unless defined $p;` +
        `if (!$p) { setpgrp(0, 0); exec @ARGV or exit 127 }` +
        `$SIG{ALRM} = sub { kill "KILL", -$p; exit 124 };` +
        `alarm ${PS_TIMEOUT.seconds}; waitpid($p, 0); exit($? >> 8);`,
        PS_TIMEOUT.ps,
        ...args,
      ]);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      r = run(PS_TIMEOUT.ps, args); // no perl: unbounded, as before
    }
    if (!r.success) return null;
    return parseLstartUtc(new TextDecoder().decode(r.stdout));
  } catch {
    return null; // aio-ok: no ps, no permission — we simply cannot say
  }
}

/** The identity fields a lock records for its owner `pid`: Linux's kernel
 *  start ticks (`startToken`), macOS's UTC start second (`startEpoch`),
 *  nothing where neither is available. */
export function ownerIdentity(
  pid: number,
): Pick<LockData, "startToken" | "startEpoch" | "ns"> {
  // `pid` is this process or a child it spawned: our namespace either way.
  const ns = ownPidNs();
  const where = ns === undefined ? {} : { ns };
  const token = processStartToken(pid);
  if (token !== null) return { startToken: token, ...where };
  const epoch = processStartEpoch(pid);
  return epoch !== null ? { startEpoch: epoch, ...where } : where;
}

/** Is the process this lock names still THE process the lock was written for?
 *
 *  `isProcessAlive` answers "does some process have this pid", which is a
 *  different question and the one every kill site used to ask. A lock that
 *  survived a reboot names a pid the kernel has since handed to somebody
 *  else, and SIGTERM does not ask who it is talking to.
 *
 *  Fails SAFE in the only direction that is safe: when either token is
 *  unavailable (an old lock, Windows, a pid we cannot read) this falls back to
 *  liveness — which is exactly the old behaviour, never worse. When both are
 *  known and they DIFFER, the pid was recycled and the answer is no.
 *  @decider */
export function isLockOwnerAlive(
  lock: {
    pid: number;
    startToken?: string;
    startEpoch?: number;
    ns?: number;
    hold?: string;
    startedAt?: number;
  },
): boolean {
  // Written in another pid namespace: its pid says nothing here. Its hold
  // file does — the kernel released it if the owner died. Without one (a
  // placeholder `am start` or a dev supervisor filed for a child that has
  // not booted yet): alive until a boot that long would be reclaimed as
  // stuck anyway (`STUCK_STARTING_MS`, `am`'s rule for a booting app).
  if (lock.ns !== undefined && lock.ns !== ownPidNs()) {
    const held = lock.hold && isAbsolute(lock.hold)
      ? holdIsHeld(lock.hold)
      : null;
    return held ?? (typeof lock.startedAt === "number" &&
      ageSince(lock.startedAt) < STUCK_STARTING_MS);
  }
  if (!isProcessAlive(lock.pid)) return false;
  return ownerMatches(lock, {
    token: lock.startToken ? processStartToken(lock.pid) : null,
    epoch: typeof lock.startEpoch === "number"
      ? processStartEpoch(lock.pid)
      : null,
  });
}

/** Does a LIVE pid's current identity (`now`) match what its lock recorded?
 *  Only a known-and-different value says no: an absent, unreadable or legacy
 *  record (macOS's old locale text `startToken`, which no reader derives any
 *  more — `now.token` is null there) is "unknown", which falls back to pid
 *  liveness. Pure. @internal */
export function ownerMatches(
  lock: { startToken?: string; startEpoch?: number },
  now: { token: string | null; epoch: number | null },
): boolean {
  if (lock.startToken && now.token !== null && now.token !== lock.startToken) {
    return false;
  }
  if (
    typeof lock.startEpoch === "number" && now.epoch !== null &&
    now.epoch !== lock.startEpoch
  ) return false;
  return true;
}

/** Does `lock` name THIS process (or `pid`, a child of ours)? The pid AND
 *  the namespace: a container sharing the lock dir is pid 7 too, and treating
 *  its live lock as ours deleted it (take-over of "our" placeholder, exit
 *  cleanup, release) or overwrote it (update). A lock with no namespace
 *  recorded (older, or no namespaces here): the pid, as before. */
export function isOwnLock(
  lock: { pid: number; ns?: number },
  pid: number = Deno.pid,
): boolean {
  return lock.pid === pid &&
    (lock.ns === undefined || lock.ns === ownPidNs());
}

/** Why the owner `lock` names cannot be SIGNALLED from here — it runs in
 *  another pid namespace (a container sharing this lock dir), where its pid
 *  is not the one this process would hit — or null when it can. Every kill
 *  site asks this first: signalling "pid 7" here reaches a stranger or
 *  nothing. */
export function foreignOwnerRefusal(
  lock: { pid: number; ns?: number },
): string | null {
  if (lock.ns === undefined || lock.ns === ownPidNs()) return null;
  return `refusing to signal pid ${lock.pid}: it runs in another pid ` +
    `namespace (a container sharing this lock dir), so that pid means a ` +
    `different process here.\n  fix: stop it where it runs (inside that ` +
    `container), or with \`am stop\` there.`;
}

/** Is the hold file at `path` OS-locked by a live process? False when it is
 *  gone (its owner released it, or it was swept as a dead owner's) or
 *  lockable (the kernel dropped a dead owner's lock). A lock another reader
 *  holds for the microseconds of this same check looks held, so a failed try
 *  is retried briefly; an owner holds it for its whole life. Null: this file
 *  system cannot say. */
function holdIsHeld(path: string): boolean | null {
  let f: Deno.FsFile;
  try {
    f = Deno.openSync(path, { read: true });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    return null; // aio-ok: unreadable here — the caller's fallback judges
  }
  try {
    for (let i = 0; i < 3; i++) {
      if (f.tryLockSync(true)) return false;
      pauseSync(2);
    }
    return true;
  } catch {
    return null; // aio-ok: no OS locks on this file system — fallback judges
  } finally {
    f.close();
  }
}

/** Create and OS-lock this process's hold file for the lock at `lockFile`
 *  (see {@linkcode LockData} `hold`). Null where there are no pid namespaces
 *  (the pid decides there) or the file system cannot lock. The file is
 *  locked BEFORE any record names it, and a sweep that unlinked it before our
 *  lock landed is caught by `sameFile` — retried. */
function takeHold(lockFile: string): { f: Deno.FsFile; path: string } | null {
  if (ownPidNs() === undefined) return null;
  for (let i = 0; i < 3; i++) {
    const path = `${lockFile}.${ownPidTag()}.${_nonce()}.hold`;
    const open = () =>
      Deno.openSync(path, { write: true, createNew: true, mode: 0o600 });
    let f: Deno.FsFile;
    try {
      f = open();
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) return null; // aio-ok: unwritable — the pid rule stays
      try {
        remakeLockDir(dirname(path));
        f = open();
      } catch {
        return null; // aio-ok: unwritable lock dir — the pid rule stays
      }
    }
    let ok = false;
    try {
      ok = f.tryLockSync(true) && sameFile(f, path);
    } catch { /* aio-ok: no OS locks here — no hold, the pid rule stays */ }
    if (ok) return { f, path };
    f.close();
    try {
      Deno.removeSync(path);
    } catch { /* aio-ok: swept already */ }
  }
  return null;
}

/** What one connection attempt to a holder's endpoint found.
 *  `up`: something accepted. `gone`: NOTHING listens there — the address
 *  refused, or the socket/pipe does not exist. `busy`: something is there
 *  and did not take this connection (every pipe instance in use, access
 *  denied, a timeout) — a listener that is busy is a listener. */
export type EndpointProbe = { state: "up" | "busy" | "gone"; why?: string };

/** Where a lock record says its holder listens — its local socket when it
 *  has one, else the TCP address it BOUND (`host` + `port`). A wildcard bind
 *  is reached on loopback: `0.0.0.0` at `127.0.0.1`; `::`, which binds both
 *  families on most systems, at `::1` AND `127.0.0.1`. Null: the record
 *  names no endpoint — it has no door, or it was written by an aio that
 *  recorded the port without the address, which says nothing about where to
 *  connect. Pure. */
export function endpointOf(
  l: Pick<LockData, "socketPath" | "port" | "host">,
): { socket: string } | { hostnames: string[]; port: number } | null {
  if (l.socketPath) return { socket: l.socketPath };
  if (!(l.port > 0) || typeof l.host !== "string" || !l.host) return null;
  const h = l.host.replace(/^\[|\]$/g, "");
  const hostnames = h === "0.0.0.0"
    ? ["127.0.0.1"]
    : h === "::"
    ? ["::1", "127.0.0.1"]
    : [h];
  return { hostnames, port: l.port };
}

/** The OS steps of {@linkcode probeEndpoint}. `value`-style seam: replaced
 *  by its test, to answer as a machine without an IPv6 loopback does. */
export const _probeDeps = {
  connect: (o: { hostname: string; port: number }): Promise<Deno.Conn> =>
    Deno.connect(o),
};

/** An answer that says nothing about the listener: this machine cannot
 *  reach that address at all (no IPv6 loopback — EADDRNOTAVAIL, an
 *  unreachable network). Pure. */
function noRoute(e: unknown): boolean {
  return e instanceof Deno.errors.AddrNotAvailable ||
    (e instanceof Error &&
      /\(os error (99|101|10049|10051|49|51)\)/.test(e.message));
}

/** One connection attempt to the endpoint a lock record NAMES
 *  ({@linkcode endpointOf}) — never to an address guessed from its port.
 *  Null: the record names nothing to probe. Several addresses (a `::` bind):
 *  any accept is `up`; `gone` only when every address that could be reached
 *  refused, at least one did, and none was `busy`; an address this machine
 *  cannot reach at all counts for nothing — and when NO address gave a
 *  definite answer, the probe is `busy`, the safe side.
 *  @internal */
export async function probeEndpoint(
  l: Pick<LockData, "socketPath" | "port" | "host">,
): Promise<EndpointProbe | null> {
  const at = endpointOf(l);
  if (!at) return null;
  const one = async (
    open: () => Promise<{ close(): void }>,
  ): Promise<EndpointProbe & { noRoute?: true }> => {
    try {
      (await open()).close();
      return { state: "up" };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (noRoute(e)) return { state: "busy", why, noRoute: true };
      const nothingThere = e instanceof Deno.errors.NotFound ||
        e instanceof Deno.errors.ConnectionRefused;
      return { state: nothingThere ? "gone" : "busy", why };
    }
  };
  if ("socket" in at) {
    const { state, why } = await one(() => connectLocal(at.socket));
    return why === undefined ? { state } : { state, why };
  }
  const all = [];
  for (const hostname of at.hostnames) {
    all.push(await one(() => _probeDeps.connect({ hostname, port: at.port })));
  }
  if (all.some((p) => p.state === "up")) return { state: "up" };
  const definite = all.filter((p) => !p.noRoute);
  const busy = definite.find((p) => p.state === "busy");
  if (busy) return { state: "busy", why: busy.why };
  if (definite.length > 0) return { state: "gone", why: definite[0]!.why };
  return { state: "busy", why: all[0]?.why };
}

/** How many connection attempts, and how far apart, before a LIVE process is
 *  called a zombie: six over 2.5 s. Taking the lock of a live process is the
 *  most dangerous thing the lock does — one refused connect is not evidence
 *  (a listener binds a moment after its record says `started`; a named pipe
 *  refuses between two accepts). */
export const ZOMBIE_PROBES = 6;
export const ZOMBIE_PROBE_GAP_MS = 500;

/** The steps of the zombie verdict a test replaces. @internal */
export const _zombieDeps = {
  probe: probeEndpoint,
  delay: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
  /** Ms since the lock file last changed. */
  recordAge: (key: string): number => lockAgeMs(key),
  /** End the process `l` names — ask, wait, then force — and say whether it
   *  is gone. False also when it is not this user's to signal. */
  async end(l: LockData): Promise<boolean> {
    try {
      await killProcess(l.pid, undefined, l);
    } catch {
      return false; // aio-ok: not ours to signal — the caller refuses, by name
    }
    return !isProcessAlive(l.pid);
  },
};

/** What the zombie verdict found: how many attempts, over how long, and the
 *  last answer. */
export type ZombieVerdict = { tries: number; ms: number; why: string };

/** THE verdict "this LIVE process is a zombie" — one rule for a launch that
 *  would take its lock and for `am start`, which would end it.
 *
 *  Taking over from a live process is the most dangerous thing the lock
 *  does, so it needs sustained evidence, never one probe. One refused
 *  connect called a healthy app a zombie — measured on Windows, 10 of 60
 *  double-click pairs: the holder's record said `started` 56 ms before its
 *  pipe was bound, and the losing launch took its lock and opened the same
 *  database. So:
 *   · a holder still inside its startup grace is not judged;
 *   · a record that CHANGED within the grace is not judged either — its
 *     owner wrote it a moment ago, which a wedged process does not do;
 *   · the endpoint must answer "nothing is here" to every one of
 *     ZOMBIE_PROBES attempts spread over seconds — an accept, or an endpoint
 *     that is there but busy, ends it: alive;
 *   · and the record must be the same bytes at the end as at the start
 *     (`"moved"`: judge what is there now).
 *  Null: alive, or nothing to ask. */
export async function zombieVerdict(
  key: string,
  existing: LockData,
  raw: string | null = readLockRaw(key),
): Promise<ZombieVerdict | "moved" | null> {
  const pastStartup = existing.status !== "starting" ||
    ageSince(existing.startedAt) > STARTUP_GRACE_MS;
  if (!pastStartup || !(_zombieDeps.recordAge(key) > STARTUP_GRACE_MS)) {
    return null;
  }
  const t0 = performance.now();
  for (let n = 1;; n++) {
    const p = await _zombieDeps.probe(existing);
    if (p === null || p.state !== "gone") return null;
    if (readLockRaw(key) !== raw) return "moved";
    if (n === ZOMBIE_PROBES) {
      return {
        tries: n,
        ms: Math.round(performance.now() - t0),
        why: p.why ?? "refused",
      };
    }
    await _zombieDeps.delay(ZOMBIE_PROBE_GAP_MS);
  }
}

/** What a refused `am` verb says when `acquire` answered `held`: the owner
 *  is gone, its file is not — never "running". Pure. */
export function heldLockLine(appId: string, existing: LockData, why: string) {
  return `"${printable(appId)}" is not running — its previous run (pid ` +
    `${existing.pid}) is gone, but its lock file cannot be removed ` +
    `(${printable(why)}): another program has it open. Try again in a moment.`;
}

/** The line for a zombie verdict on `l`: what was seen. */
export function zombieLine(l: LockData, v: ZombieVerdict): string {
  const at = endpointOf(l);
  const where = !at
    ? `port ${l.port}`
    : "socket" in at
    ? `socket ${printable(at.socket)}`
    : `${printable(at.hostnames.join(" and "))} port ${at.port}`;
  // Said as what it is: the file is not there. A cleaner of the runtime
  // directory removes it from under a LIVE app too, which then dies here —
  // its own tick has said so in its log since (`lockTick`).
  let noFile = "";
  if (at && "socket" in at && !isPipePath(at.socket)) {
    try {
      Deno.lstatSync(at.socket);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        noFile = " (the socket file is gone — its listener ended, or the " +
          "file was removed from under it)";
      }
    }
  }
  return `pid ${l.pid} is alive but nothing listens on ${where}${noFile} — ` +
    `${v.tries} connection attempts over ${v.ms} ms were all refused (${
      printable(v.why)
    }), and its lock record has not changed for more than ` +
    `${STARTUP_GRACE_MS / 1000} s`;
}

/** Check if a TCP port has something listening */
export async function isPortInUse(port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

/** Check if a local socket (Unix socket, or a named pipe on windows) has
 *  something listening — used to detect zombie socket-only instances
 *  (prod/electron skipHttp) whose process is alive but whose listener died.
 *  Mirrors isPortInUse for the socket transport. */
export async function isSocketAlive(socketPath: string): Promise<boolean> {
  try {
    const conn = await connectLocal(socketPath);
    conn.close();
    return true;
  } catch {
    return false;
  }
}

// ── Lock File CRUD ───────────────────────────────────────────

/** Read a lock file, return null if missing or corrupt */
/** Read a lock by its key — the plain appId for a default-home app, or the
 *  `<appId>@<hash8(home)>` key {@linkcode lockKey} builds for any other home. */
export function readLock(key: string): LockData | null {
  return readLockAt(lockPath(key)).data;
}

/** The lock file at `path`: its exact bytes and the record they hold — for a
 *  reader that does NOT hold the lock's mutex.
 *
 *  An owner rewrites its record IN PLACE (see {@linkcode rewriteLock}), so
 *  such a reader can catch the file mid-write. A record written that way
 *  carries a check ({@linkcode sealLock}); bytes that do not pass it, or do
 *  not parse, are read again — the write is one small call, done long before
 *  the last look. Still unreadable after that: `data` null, as for a file a
 *  crash left empty. */
function readLockAt(
  path: string,
): { raw: string | null; data: LockData | null } {
  for (let look = 0;; look++) {
    let raw: string | null = null;
    try {
      raw = Deno.readTextFileSync(path);
    } catch { /* aio-ok: no lock file — null is the answer */ }
    const data = parseLock(raw, path);
    if (raw === null || data !== null || look === TORN_REREADS) {
      return { raw, data };
    }
    pauseSync(1 << look); // 1, 2, 4, 8 ms
  }
}
/** How many times bytes that do not read as a record are read again. */
const TORN_REREADS = 4;

/** The lock file's exact bytes (as text), or null when there is no file.
 *  Every removal compares against THIS — see {@linkcode removeLockIf}. */
function readLockRaw(key: string): string | null {
  try {
    return Deno.readTextFileSync(lockPath(key));
  } catch {
    return null;
  }
}

/** `path`: where `raw` was read — a `hold` name resolves beside it. */
function parseLock(raw: string | null, path?: string): LockData | null {
  if (raw === null) return null;
  try {
    // A sealed record whose check does not match is a write caught half-way.
    const seal = SEAL.exec(raw);
    if (seal && sealOf(raw.slice(0, seal.index)) !== seal[1]) return null;
    const data = JSON.parse(raw) as LockData;
    // Validate the SHAPE of each field, never its truthiness.
    //
    // This used to be `if (!data.appId || !data.pid || !data.port)`, and
    // `port: 0` is falsy — while being the documented "pick a free port"
    // setting, written into the lock verbatim. A port-0 app's lock therefore
    // read back as INVALID, and every consequence compounded in the same
    // direction: `release()` guards on this returning our record, so a
    // GRACEFUL shutdown removed nothing; staleness is decided from this data,
    // so the leftover could never be recognised as stale either; and the next
    // launch refused to start, permanently, with "Already running". An app
    // bricked by its own clean exit, recoverable only by finding a file in a
    // runtime directory nobody has reason to know about.
    //
    // pid is checked as POSITIVE (no process is pid 0, and the not-ok branch
    // below synthesises `pid: 0` for "someone holds it and we can't say who" —
    // that placeholder must never validate as a real record), while port is
    // checked only for being a number, because 0 is a real port value here.
    if (typeof data.appId !== "string" || data.appId === "") return null;
    if (typeof data.pid !== "number" || !(data.pid > 0)) return null;
    if (typeof data.port !== "number" || data.port < 0) return null;
    // Only a file beside the lock, whatever path the writer saw it at (a
    // container may mount this dir elsewhere).
    if (typeof data.hold === "string") {
      data.hold = path ? join(dirname(path), basename(data.hold)) : undefined;
    }
    return data;
  } catch {
    return null;
  }
}

// ── Exclusive, atomic lock-file primitives ───────────────────
//
// The lock was NOT exclusive, and two instances opened one `state.db`
// (measured: 6 processes on a barrier, >1 holder in 11 of 15 rounds, once 3).
// Three holes, each closed here:
//
//  1. CREATE-THEN-WRITE. The file was created empty (`createNew`) and filled a
//     moment later, so a racer read an EMPTY lock, judged it "unreadable —
//     names no owner", deleted it and took the name. Now the full record is
//     written to a private tmp file and PUBLISHED with `link()`, which fails
//     with EEXIST when the name is taken: the lock file never exists without
//     its whole content. (`writeLock`'s in-place overwrite had the same hole
//     for every update; see the seal below for how an update is written.)
//  2. DELETE-BY-PATH. A reclaim judged the record at the path dead, then
//     removed WHATEVER was at the path — by then possibly a fresh lock a live
//     racer had just taken. Every removal is now compare-and-delete: under a
//     per-lock mutex, the bytes are re-read and removed only if they are
//     exactly the record that was judged.
//  3. The owner's own `update`/`release` read-then-wrote the same way; they
//     run under the same mutex.
//
// Creation needs no mutex (`link` is the exclusive step); only the steps that
// CHANGE or REMOVE an existing file take it, and they hold it for a few
// synchronous file operations. The mutex is an OS lock (`flock`/`LockFileEx`
// via `FsFile.tryLockSync`) on `<lock>.mx`, so a holder that dies releases it
// with its process — there is nothing to BREAK. It used to be a file whose
// presence was the hold, and breaking a dead holder's file (rename aside,
// compare, link back) had a window no ordering closes: while a live holder's
// file sat moved aside, the name was free, a third process published, and
// the link-back failed — two holders. See `withLockMutex` for the protocol.

const _nonce = (): string => crypto.randomUUID().slice(0, 8);

// ── The seal: a record that is rewritten in place says when it is whole ──
//
// A lock's owner changes its record (`starting` → `started`, its socket, its
// port) by writing the new bytes OVER the old ones through a handle it keeps
// open, never by writing a new file and renaming it. The lock is published
// through a hard link (`publishExclusive`), and on Windows a rename over a
// file published that way is refused with "access denied" — measured, 2 000
// tries a cell: 1.4–4.1 % of them, clearing after 0.5–1.3 s on a quiet
// machine and not within 10 s right after an install or an update, which is
// where a desktop app's boot was refused with an 11-try, 1.3 s wait already
// in place. A rename over a file written any other way was refused 0 times
// in 20 000, and a write through an open handle 0 times in 8 000.
//
// The price is that a reader without the mutex can see the write half done.
// So such a record ends in a SEAL: 32 spaces and tabs — the 32 bits of a hash
// of the JSON before them — on a line of their own. To `JSON.parse` (and to
// every older aio that reads a lock) that is trailing whitespace. To this
// reader it is the proof the bytes are one whole record: a mix of two writes
// does not pass, and is read again ({@linkcode readLockAt}).
//
// A placeholder filed by `am` or a dev session, and anything an older aio
// wrote, carries no seal: plain `JSON.stringify` text, which its writer
// compares byte for byte. Such a record is changed in place too, the file
// emptied first ({@linkcode rewriteLock}).

/** The seal at the end of a record: its 32 marks. */
const SEAL = /\n([ \t]{32})\n$/;

/** The 32 marks for `json`: the bits of its FNV-1a hash, space = 0, tab = 1. */
function sealOf(json: string): string {
  return parseInt(hash8(json), 16).toString(2).padStart(32, "0")
    .replaceAll("0", " ").replaceAll("1", "\t");
}

/** `data` as the text an owner's own record is stored as. */
function sealLock(data: LockData): string {
  const json = JSON.stringify(data);
  return `${json}\n${sealOf(json)}\n`;
}

/** The seal's two halves, for their test. @internal */
// aio-ok: a test seam — the product reaches both through the lock's own reads and writes
export const _seal = {
  text: sealLock,
  parse: (raw: string): LockData | null => parseLock(raw),
};

/** The file steps a test replaces (a write that fails, a platform).
 *  @internal */
export const _lockDeps = {
  /** The whole record over the old one: one write from offset 0, then the
   *  length. */
  write(f: Deno.FsFile, bytes: Uint8Array): void {
    f.seekSync(0, Deno.SeekMode.Start);
    for (let at = 0; at < bytes.length;) at += f.writeSync(bytes.subarray(at));
    f.truncateSync(bytes.length);
  },
  open: (path: string): Deno.FsFile =>
    Deno.openSync(path, { read: true, write: true }),
  windows: (): boolean => Deno.build.os === "windows",
};

/** Open the lock file at `path` to rewrite it. On Windows a process that has
 *  it open without write sharing refuses this for as long as it looks — the
 *  same bounded wait as a rename gets. (An owner does not come here: it
 *  writes through the handle it has had open since it made the file.) */
function openToRewrite(path: string): Deno.FsFile {
  for (let tries = 1;; tries++) {
    try {
      return _lockDeps.open(path);
    } catch (e) {
      const wait = _lockDeps.windows() && isHeldOpenError(e)
        ? RENAME_BACKOFF_MS[tries - 1]
        : undefined;
      if (wait === undefined) throw e;
      pauseSync(wait);
    }
  }
}

/** Change the record at `path` to `data` — the caller holds the mutex and
 *  has read `was`, the bytes there now. Returns the handle an OWNER keeps
 *  (`owner`: the caller is the lock's holder, `held` its handle so far).
 *
 *  ALWAYS in place, never a replace by rename: the file was published
 *  through a hard link ({@linkcode publishExclusive}), and on Windows a
 *  rename over such a file is refused (ACCESS_DENIED) in 1.4–4.1 % of the
 *  tries for a second or longer — measured; a write through an open handle
 *  was refused in none of 8 000. It goes through `held` when that is still
 *  the file at the path, else through a handle opened for this write (which
 *  an owner then keeps instead).
 *
 *  Sealed over a sealed record of the same process: written over it, and a
 *  reader that catches the two mixed fails the check and reads again.
 *  Anything else — a record with no seal, a dead owner's record, a writer
 *  that stores the plain bytes it compares later — has no check both sides
 *  share, so the file is EMPTIED first: a reader then sees the old record,
 *  nothing, a cut-off start of the new one (none of which parses, bar the
 *  whole new record short of its seal), or the new one — never a splice of
 *  two records that reads as a third. An owner always writes sealed. */
function rewriteLock(
  path: string,
  was: string,
  data: LockData,
  held: Deno.FsFile | null,
  owner: boolean,
): Deno.FsFile | null {
  const over = SEAL.test(was) && parseLock(was)?.pid === data.pid;
  const text = owner || over ? sealLock(data) : JSON.stringify(data);
  const mine = held !== null && sameFile(held, path);
  const f = mine ? held : openToRewrite(path);
  try {
    if (!over) f.truncateSync(0);
    _lockDeps.write(f, new TextEncoder().encode(text));
  } catch (e) {
    if (!mine) f.close(); // the owner's own handle stays the owner's
    throw e;
  }
  if (mine) return held;
  if (!owner) {
    f.close();
    return null;
  }
  held?.close(); // open on a file that is no longer the lock
  return f;
}

/** Publish `text` at `path` only if nothing is there — never a half-written
 *  file. True on success, false if the name is taken. */
function publishExclusive(
  path: string,
  text: string,
  /** Handed the handle the record was written through, still open — the
   *  owner keeps it for the lock's life ({@linkcode rewriteLock}). Without
   *  it the handle is closed here. */
  keep?: (f: Deno.FsFile) => void,
): boolean {
  const tmp = `${path}.${ownPidTag()}.${_nonce()}.tmp`;
  const bytes = new TextEncoder().encode(text);
  const fill = (at: string): Deno.FsFile => {
    const f = Deno.openSync(at, {
      read: true,
      write: true,
      createNew: true,
      mode: 0o600,
    });
    try {
      for (let n = 0; n < bytes.length;) n += f.writeSync(bytes.subarray(n));
    } catch (e) {
      f.close();
      throw e;
    }
    return f;
  };
  /** Published: the handle goes to the owner, or is closed. */
  const done = (f: Deno.FsFile): true => {
    if (keep) keep(f);
    else f.close();
    return true;
  };
  let f: Deno.FsFile;
  try {
    f = fill(tmp);
  } catch (e) {
    // The directory can vanish between `lockDir()` and this write: a sibling
    // app's shutdown pruned its (momentarily empty) scoped dir. Re-create and
    // try once more — an ENOENT here is never "someone holds the lock".
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    remakeLockDir(dirname(path));
    f = fill(tmp);
  }
  try {
    // The handle opened on the temp name IS the published file (a hard link
    // is a second name for the same file). The owner keeps one opened by the
    // lock's OWN name instead, taken while this one is still open: nobody
    // can have the file open in a way that refuses it, since their open had
    // to allow this handle's writing. Not opened: this one is kept.
    Deno.linkSync(tmp, path);
    if (!keep) return done(f);
    let named: Deno.FsFile;
    try {
      named = _lockDeps.open(path);
    } catch {
      return done(f); // aio-ok: the first handle is the same file — kept
    }
    f.close();
    return done(named);
  } catch (e) {
    f.close();
    if (e instanceof Deno.errors.AlreadyExists) return false;
    // A filesystem without hard links: fall back to an exclusive create. The
    // content goes in with ONE write call; readers treat a short/empty file
    // as "being written" for a grace period (see `acquire`), never as dead.
    // `mode` as the tmp above has it: the record names the owner's pid,
    // cwd and home, and this branch used to create it at the umask default
    // (0644 — every local user reads it) while the link path gave 0600.
    return done(fill(path));
  } finally {
    try {
      Deno.removeSync(tmp);
    } catch { /* aio-ok: already gone */ }
  }
}

const _sleepCell = new Int32Array(new SharedArrayBuffer(4));
/** A short SYNCHRONOUS pause — the mutex holders are synchronous, so the
 *  waiters are too. */
function pauseSync(ms: number): void {
  Atomics.wait(_sleepCell, 0, 0, ms);
}

/** How long a waiter polls for the per-lock mutex before it BLOCKS on it.
 *  Holders keep it for a few synchronous file operations, and a dead holder
 *  has already released it (the OS does), so the blocking wait only ever
 *  waits for a live holder to finish. */
const MUTEX_WAIT_MS = 2_000;

/** Run `fn` holding the per-lock mutex: an exclusive OS lock on `<lock>.mx`.
 *
 *  The file is removed by its holder on the way out (a scoped lock dir must
 *  be able to empty), so a waiter can end up locking an inode that is no
 *  longer at the path — a file the holder unlinked after the waiter opened
 *  it. Holding THAT proves nothing; the waiter re-checks that the inode it
 *  locked is the one at the path, and starts over if not. Invariant: the
 *  only way the path's inode changes is an unlink by the current holder, so
 *  exactly one process holds the lock on the inode at the path.
 *  @internal exported for its race test only. */
export function withLockMutex<T>(key: string, fn: () => T): T {
  return withLockMutexAt(lockPath(key), fn, true)!;
}

/** {@linkcode withLockMutex} for the lock FILE at `lockFile`, in any lock dir.
 *  `recreate` false: a lock dir that is gone is NOT made again — the result
 *  is `undefined` (nothing there to judge) — for cleanups of a dir that may
 *  be being pruned. Also the build lock's mutex (build-compile.ts). */
export function withLockMutexAt<T>(
  lockFile: string,
  fn: () => T,
  recreate: boolean,
): T | undefined {
  const mx = `${lockFile}.mx`;
  // MONOTONIC: a wall-clock jump must neither stretch nor skip this wait.
  const deadline = performance.now() + MUTEX_WAIT_MS;
  let f: Deno.FsFile;
  for (;;) {
    const open = () =>
      Deno.openSync(mx, { read: true, write: true, create: true, mode: 0o600 });
    try {
      f = open();
    } catch (e) {
      // A sibling's shutdown pruned the (momentarily empty) scoped lock dir.
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      if (!recreate) return undefined;
      remakeLockDir(dirname(mx));
      continue;
    }
    let locked = false;
    while (!(locked = f.tryLockSync(true)) && performance.now() < deadline) {
      pauseSync(1 + Math.floor(Math.random() * 3));
    }
    if (!locked) f.lockSync(true); // a LIVE holder: wait for it, never break
    if (sameFile(f, mx)) break;
    f.close(); // locked a file its holder already unlinked — start over
  }
  try {
    return fn();
  } finally {
    // Unlink BEFORE unlocking: a waiter that locks this inode afterwards
    // sees it is no longer at the path and retries (see above).
    unlinkHeldMutex(f, mx);
    f.close();
  }
}

/** Is the file open as `f` the one at `path` right now? */
function sameFile(f: Deno.FsFile, path: string): boolean {
  let at: Deno.FileInfo;
  try {
    at = Deno.statSync(path);
  } catch {
    return false; // aio-ok: unlinked since we opened it — not the mutex
  }
  const mine = f.statSync();
  // No file identity on this filesystem: the mutex file is then never
  // unlinked (`unlinkHeldMutex`), so the path cannot have moved under us.
  if (mine.ino === null || at.ino === null) return true;
  return mine.ino === at.ino && mine.dev === at.dev;
}

/** May a HELD mutex file be unlinked? Only where files have an identity the
 *  waiters' `sameFile` check can compare — every platform aio runs on
 *  (Windows included: measured on Deno 2.9.6, `ino` is set and an open,
 *  locked file unlinks with POSIX semantics). Without one the file stays:
 *  correctness over a tidy directory. Pure. */
export function mayUnlinkMutex(info: { ino: number | null }): boolean {
  return info.ino !== null;
}

/** Unlink the mutex file `f` (locked by us, verified at `path`). */
function unlinkHeldMutex(f: Deno.FsFile, path: string): void {
  if (!mayUnlinkMutex(f.statSync())) return;
  try {
    Deno.removeSync(path);
  } catch { /* aio-ok: already gone — the lock releases when f closes */ }
}

/** Remove a mutex file nobody holds — the one a process SIGKILLed inside the
 *  mutex leaves behind (no pid in its name, so the temp sweep cannot judge
 *  it, and it keeps a scoped lock dir from ever being pruned). Taken through
 *  the SAME protocol as a holder's exit: lock it without waiting, confirm it
 *  is the file at the path, unlink, unlock. Held by anyone → left alone. */
function dropIdleMutex(path: string): void {
  let f: Deno.FsFile;
  try {
    f = Deno.openSync(path, { read: true, write: true });
  } catch {
    return; // aio-ok: no mutex file — nothing to drop
  }
  try {
    if (f.tryLockSync(true) && sameFile(f, path)) unlinkHeldMutex(f, path);
  } finally {
    f.close();
  }
}

/** The private files the steps above leave for a moment — `<lock>.<pid>.
 *  <nonce>.tmp` (publish/replace) and the `<lock>.mx` mutex file — outlive a
 *  process killed mid-step. Nothing else ever removes them, they pile up,
 *  and they keep the scoped lock dir from being pruned. Swept at acquire: a
 *  temp ONLY when the pid in its name is gone (a live process's file is part
 *  of an operation it is still running), the mutex only when nobody holds
 *  it (`dropIdleMutex`). */
const ORPHAN_TEMP = new RegExp(`^\\.${PID_TAG}\\.[0-9a-f]{8}\\.tmp$`);
export function sweepOrphanLockTemps(key: string): void {
  const base = `${key}.lock`;
  let names: string[];
  try {
    names = [...Deno.readDirSync(lockDir())]
      .filter((e) => e.isFile && e.name.startsWith(base))
      .map((e) => e.name);
  } catch {
    return; // aio-ok: no lock dir yet — nothing to sweep
  }
  for (const name of names) {
    const rest = name.slice(base.length);
    if (rest === ".mx" || rest.endsWith(".hold")) {
      // An unheld hold file is a dead owner's: same protocol as the mutex.
      dropIdleMutex(join(lockDir(), name));
      continue;
    }
    const m = ORPHAN_TEMP.exec(rest);
    if (!m) continue;
    const pid = Number(m[1]);
    if (
      pid === Deno.pid || !taggedOwnerGone(join(lockDir(), name), pid, m[2])
    ) {
      continue;
    }
    try {
      Deno.removeSync(join(lockDir(), name));
    } catch { /* aio-ok: a sibling swept it first */ }
  }
}

/** Remove the lock at `key` only if its bytes are still exactly `judged` —
 *  the record the caller decided was dead/stale/ours. True when removed. */
export function removeLockIf(key: string, judged: string): boolean {
  return removeLockFileIf(lockPath(key), judged, true);
}

/** {@linkcode removeLockIf} for the lock FILE at `path`, in any lock dir.
 *  @internal */
export function removeLockFileIf(
  path: string,
  judged: string,
  recreate = false,
  /** Wait out a Windows process that has the file open (`removeOverSync`),
   *  and THROW when it is still there at the bound — the owner's own release
   *  asks for this. A reclaim does not: its caller's loop is the retry. */
  wait = false,
): boolean {
  return withLockMutexAt(path, () => {
    let now: string | null = null;
    try {
      now = Deno.readTextFileSync(path);
    } catch { /* aio-ok: gone — nothing to remove */ }
    if (now !== judged) return false;
    if (wait) return removeOverSync(path);
    try {
      _renameDeps.remove(path); // the OS step `removeOverSync` takes too
      return true;
    } catch {
      return false; // aio-ok: removed meanwhile, or held — the caller's loop looks again
    }
  }, recreate) ?? false;
}

/** Beside the lock: "the instance this lock names quit CLEANLY and could not
 *  remove it". A lock whose owner is gone otherwise means a crash, and the
 *  next start says so — which would be false here. Holds the lock's bytes. */
function quitMarkPath(key: string): string {
  return join(lockDir(), `${key}.quit`);
}

/** Is the dead owner's lock `raw` one its owner tried to remove on a clean
 *  quit? The mark is consumed either way. */
function takeQuitMark(key: string, raw: string): boolean {
  const path = quitMarkPath(key);
  let mark: string | null = null;
  try {
    mark = Deno.readTextFileSync(path);
    Deno.removeSync(path);
  } catch { /* aio-ok: no mark — the owner did not quit cleanly */ }
  return mark === raw;
}

/** Remove the lock at `key` only if it still names the owner that was judged
 *  dead — the same pid, and the same start token when both carry one. A
 *  caller that holds only the PARSED record (`am`'s `pf`) uses this: deleting
 *  "whatever is at the path" removed a re-booted instance's LIVE lock, and a
 *  second instance then opened the same state.db. */
export function removeLockIfOwner(
  key: string,
  owner: Pick<LockData, "pid" | "startToken" | "startEpoch">,
): boolean {
  return withLockMutex(key, () => {
    const now = parseLock(readLockRaw(key));
    if (!now || now.pid !== owner.pid) return false;
    if (
      owner.startToken && now.startToken && owner.startToken !== now.startToken
    ) {
      return false;
    }
    if (
      owner.startEpoch !== undefined && now.startEpoch !== undefined &&
      owner.startEpoch !== now.startEpoch
    ) return false;
    try {
      removeOverSync(lockPath(key));
      return true; // removed, or removed meanwhile — the goal holds
    } catch (e) {
      log.warn(
        "lock",
        `${printable(lockPath(key))} could not be removed (${
          e instanceof Error ? e.message : String(e)
        }) — the next start reclaims it`,
      );
      return false;
    }
  });
}

/** Write lock file — created whole if none is there, else written over in
 *  place ({@linkcode rewriteLock}: a reader never takes a half-written file
 *  for a record), under the lock's mutex.
 *  @decider */
export function writeLock(data: LockData): void {
  const key = lockKey(data.appId, data.home, data.profile);
  withLockMutex(key, () => {
    const path = lockPath(key);
    const was = readLockRaw(key);
    if (was === null && publishExclusive(path, JSON.stringify(data))) return;
    // There, or filed in the instant since the read: written over.
    rewriteLock(path, was ?? readLockRaw(key) ?? "", data, null, false);
  });
}

/** Compare-and-swap for `am`'s own lock writes (the placeholder, the
 *  "stopping" mark and its undo, a status self-repair). They held only the
 *  PARSED record they read, and wrote over whatever sat at the path by then —
 *  a re-booted instance's live lock became a stale-looking copy of the old
 *  one, the next reader reclaimed it, and a second instance opened the same
 *  state.db.
 *
 *  `expected === null`: write only while NO lock is there (create-new).
 *  Otherwise the current record must still name the owner read — same pid,
 *  and the same start identity when both carry one ({@linkcode sameRecord})
 *  — and `next` is applied to the CURRENT record, so what the owner wrote
 *  since (its status, its bound port, its socket) is kept. Under the key's mutex. True when
 *  written; false = the lock changed, nothing written — the caller says so.
 *  @decider */
export function replaceLockIf(
  expected: LockData | null,
  next: LockData | ((now: LockData) => LockData),
): boolean {
  const ref = expected ?? (typeof next === "function" ? null : next);
  if (!ref) return false;
  const key = lockKey(ref.appId, ref.home, ref.profile);
  return withLockMutex(key, () => {
    const path = lockPath(key);
    if (expected === null) {
      // Create-new IS the compare: the link fails while any lock is there.
      if (typeof next === "function") return false;
      return publishExclusive(path, JSON.stringify(next));
    }
    const was = readLockRaw(key);
    const now = parseLock(was);
    if (!now || !sameRecord(expected, now)) return false;
    const data = typeof next === "function" ? next(now) : next;
    rewriteLock(path, was!, data, null, false);
    return true;
  }) ?? false;
}

/** Is `now` still written by the OWNER `was` names — same pid, and the same
 *  start identity when both carry one? Pure.
 *
 *  Identity only, never `status`/`startedAt`: a booting app rewrites its own
 *  lock (`starting` → `started`, its own `startedAt` over `am start`'s
 *  placeholder), and comparing those made `am stop` on an app that finished
 *  booting mid-command answer "lock changed — nothing was stopped" about the
 *  very process it meant, `am stop --all` skip it, and `am restart` exit 1.
 *  A changed record of the SAME owner is not a race to refuse: `next` is
 *  applied to that current record. */
function sameRecord(was: LockData, now: LockData): boolean {
  if (now.pid !== was.pid) return false;
  // Pid 7 in two containers sharing the lock dir is two owners.
  if (was.ns !== undefined && now.ns !== undefined && was.ns !== now.ns) {
    return false;
  }
  if (was.startToken && now.startToken && was.startToken !== now.startToken) {
    return false;
  }
  return !(typeof was.startEpoch === "number" &&
    typeof now.startEpoch === "number" && was.startEpoch !== now.startEpoch);
}

/** Atomic create-new lock file — returns false if file already exists (race-safe) */
function tryCreateLock(
  data: LockData,
  /** The owner's: it gets the open handle, and the record is sealed. */
  keep: (f: Deno.FsFile) => void,
): boolean {
  const path = lockPath(lockKey(data.appId, data.home, data.profile));
  try {
    return publishExclusive(path, sealLock(data), keep);
  } catch (e) {
    // `false` means ONE thing: the file is already there, so another process
    // won the race. It used to mean "anything went wrong", and the caller
    // renders that as `[AIO] Already running` + exit 1 — which for a lock dir
    // that cannot be written is a lie about a machine problem, after a 3-second
    // retry loop looking for an owner that does not exist (measured: 3041 ms,
    // then "Already running: probe-app", pid 0).
    //
    // The triggers are ordinary: a read-only or full /tmp, `/tmp/aio` owned by
    // another uid when XDG_RUNTIME_DIR is unset (Docker, ssh without logind,
    // cron), SELinux. In every one of them the app cannot boot and the message
    // sends the operator to look for a process.
    if (e instanceof Deno.errors.AlreadyExists) return false;
    throw new Error(
      `cannot write the single-instance lock ${path}: ${
        e instanceof Error ? e.message : String(e)
      }\n` +
        `  This is not "already running" — the lock DIRECTORY is unusable ` +
        `(read-only or full filesystem, owned by another user, or blocked by ` +
        `SELinux/AppArmor).\n` +
        `  fix: make ${dirname(path)} writable by this user, or point the ` +
        `lock dir somewhere writable with XDG_RUNTIME_DIR=… (or AIO_APPS_DIR=… ` +
        `to scope the whole instance).`,
      { cause: e },
    );
  }
}

/** Milliseconds since a wall-clock stamp — and a stamp from the FUTURE is
 *  OLD, not young. The wall clock jumps back (NTP step, a restored VM
 *  snapshot, a hand-set clock), and a file written before the jump then
 *  carries a time "after now": read as young, an unreadable lock was never
 *  reclaimed and the app refused to start, "already running (pid 0)",
 *  forever. A second of slack covers coarse filesystem timestamps. */
export function ageSince(t: number): number {
  const age = Date.now() - t;
  return age < -1_000 ? Infinity : age;
}

/** Milliseconds since the lock file was last modified — Infinity when the
 *  platform reports no mtime (then nothing but the content can judge it), 0
 *  when the file is gone. */
function lockAgeMs(key: string): number {
  try {
    const m = Deno.statSync(lockPath(key)).mtime;
    return m ? ageSince(m.getTime()) : Infinity;
  } catch {
    return 0;
  }
}

/** Remove a lock file by its key (the plain appId for a default-home app).
 *  Unconditional, so no product path calls it — test fixtures only. Every
 *  removal aio makes compares first ({@linkcode removeLockIf},
 *  {@linkcode removeLockIfOwner}): by the time a lock is judged dead, a new
 *  instance may hold the same name. */
// aio-ok: test fixtures' cleanup — no product path may delete unconditionally
export function removeLock(key: string): void {
  withLockMutex(key, () => {
    try {
      Deno.removeSync(lockPath(key));
    } catch { /* aio-ok: already gone — the removal's goal holds */ }
  });
}

/** Is this lock a MAINTENANCE hold (`am backup` / `am restore`), not an app?
 *  THE one predicate — acquire, the signal handler, every `am` verb and the
 *  dead-owner warning ask it, so they cannot disagree. ANY present value
 *  counts: a malformed one (`"yes"`, a hand edit, a future shape) is a hold
 *  of an unknown op, never an app to probe or kill. Pure. */
export function isHold(
  lock: { maintenance?: unknown } | null | undefined,
): boolean {
  const m = lock?.maintenance;
  return m !== undefined && m !== null && m !== false;
}

/** The invisible-or-reordering characters beyond C0/DEL/C1, as escapes in a
 *  STRING: `deno fmt` rewrites unicode escapes in a regex literal into the
 *  invisible characters themselves. */
const UNSEEN = "\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff";
const CTRL_FIELD = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${UNSEEN}]`, "g");
const CTRL_TEXT = new RegExp(
  `\\x1b\\[[0-9;]*m|[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f${UNSEEN}]`,
  "g",
);
/** The SGR codes `diagnostics/fmt.ts` emits, one parameter each. */
// deno-lint-ignore no-control-regex
const SGR_OK = new RegExp("^\\x1b\\[(?:0|1|2|4|22|24|39|3[0-7]|9[0-7])?m$");

/** USER DATA as it may reach a TERMINAL (an app's state, its logs, an eval
 *  result, surface text) — the opposite trade to {@linkcode printable}:
 *  everything that DISPLAYS stays byte-exact — ZWJ emoji, ZWNJ, LRM/RLM,
 *  a BOM, `\r`, every SGR colour (256 and truecolor included) — and only
 *  what a terminal would EXECUTE goes: OSC (titles, hyperlinks, clipboard),
 *  every non-SGR CSI (cursor moves, erase), other ESC sequences, C1 controls
 *  and the C0 controls a display has no use for (BEL, BS, …). Removed, not
 *  replaced: a log's `\x1b[K` is noise, not a warning sign. Never applied
 *  when the output is not a terminal — piped data is passed through as is.
 *  Pure. */
const EXEC_SEQ = new RegExp(
  "\\x1b\\[[0-?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?|" +
    "\\x1b[PX^_][^\\x1b]*(?:\\x1b\\\\)?|\\x1b[ -~]?|" +
    "[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1a\\x1c-\\x1f\\x7f-\\x9f]",
  "g",
);
// deno-lint-ignore no-control-regex
const SGR_ANY = new RegExp("^\\x1b\\[[0-9;:]*m$");
export function terminalSafe(s: string): string {
  return s.replace(EXEC_SEQ, (m) => SGR_ANY.test(m) ? m : "");
}

/** Text as it may be PRINTED to a terminal — THE one helper. Lock files (and
 *  anything else read from disk) are writable by anything running as the
 *  user, and what is planted in one must not reach the operator's terminal
 *  from `am status`, a refusal, a warning:
 *  - control characters (C0, DEL, C1): an escape (`\x1b[2J`, an OSC title or
 *    hyperlink), a CSI via C1 `\x9b`, a `\r` that overwrites the line;
 *  - bidi controls (U+202A–202E, U+2066–2069): text that DISPLAYS in another
 *    order than it reads (a path that shows as a different path);
 *  - zero-width characters (U+200B–200F, U+FEFF): two names that look alike.
 *  Each becomes `?`.
 *
 *  Applied at PRINT, never at parse: a lock's `home`/`cwd`/`socketPath` are
 *  IDENTITY — the lock key is derived from `home` — and "cleaning" them on
 *  read filed a self-repair under a second key (two lock files, one app
 *  "running from 2 data homes").
 *
 *  `text: false` (a single field): all of the above.
 *  `text: true` (a whole message): `\n` and `\t` are kept, and so are the
 *  SGR codes aio's own styling emits — exactly those ({@linkcode SGR_OK}:
 *  reset, bold, dim, underline and their resets, the 8+8 foreground colours).
 *  Any other escape (conceal (SGR 8), a cursor move) is replaced. Pure. */
export function printable(s: string, text = false): string {
  return text
    ? s.replace(CTRL_TEXT, (m) => m.length > 1 && SGR_OK.test(m) ? m : "?")
    : s.replace(CTRL_FIELD, "?");
}

/** Before a DEAD maintenance holder's lock is removed — by any cleanup:
 *  a boot, `am start`, `am status`, `am instances` — say which op was killed
 *  and what it left. Cleaning the lock up silently was how a restore killed
 *  mid-swap ended in an app booting on an empty data/ with no word of why.
 *  An app's dead lock stays as it was (the boot alone warns about that). */
export function noteDeadHolder(lock: LockData): void {
  if (isHold(lock)) log.warn("lock", deadOwnerWarning(lock.appId, lock));
}

/** What a boot says when it reclaims the lock of a DEAD owner. Pure.
 *
 *  An app that died may have lost its last debounced writes — that is the
 *  warning. A dead MAINTENANCE holder (`am backup` / `am restore` killed
 *  mid-run) was never the app: it held no app state, and blaming "the
 *  previous run" of the app for lost writes sent the reader after a data
 *  loss that did not happen. It says what the op leaves instead.
 *  @internal exported for its test only. */
export function deadOwnerWarning(
  appId: string,
  existing: Pick<LockData, "pid" | "maintenance">,
): string {
  const m = existing.maintenance as unknown;
  appId = printable(appId); // may come from a lock file — printed below
  if (isHold(existing)) {
    const rec = typeof m === "object" ? m as Record<string, unknown> : {};
    const op = typeof rec.op === "string" && rec.op ? printable(rec.op) : "am";
    const left = typeof rec.partial === "string" && rec.partial
      ? ` It left ${printable(rec.partial)} — possibly incomplete, never the ` +
        `live data; delete it when you no longer need it.`
      : "";
    return `${op} (pid ${existing.pid}) was killed before it finished — it ` +
      `was not "${appId}" running, so no app state was lost. ` +
      (/restore/.test(op)
        ? `data/ holds the old data or the restored copy — unless it died ` +
          `between the swap's two renames, when data/ is missing and the ` +
          `previous data is in data.replaced-*.`
        : `data/ was only being read.`) +
      left;
  }
  return `the previous run of "${appId}" (pid ${existing.pid}) did not ` +
    `shut down cleanly — a graceful stop removes its lock, so that ` +
    `process was killed, crashed, or lost power. Persistence is ` +
    `debounced: state committed inside the last window is replayed on ` +
    `boot only with \`journal: true\`, and is otherwise gone. ` +
    `See docs/persistence/auto-persist.md`;
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
    if (now && isOwnLock(now)) {
      try {
        removeLockFileIf(lockPath(this.key), raw!, true, true);
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

// ── Helpers ──────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const KILL_GRACE_MS = 2000;
/** How often to re-check whether a signalled process has actually exited.
 *  Exported because `am`'s own kill loop polls the same fact — it had its own
 *  100 until they were found side by side. */
export const KILL_POLL_MS = 100;
const KILL_REAP_MS = 300;

/** Kill a process: SIGTERM first, SIGKILL after grace period */
/** Every descendant of `pid`, shallowest first.
 *
 *  Asked BEFORE anything is killed, because once a parent dies its children are
 *  reparented to init and can no longer be found by walking down from it. */
export async function descendantPids(pid: number): Promise<number[]> {
  const out: number[] = [];
  const walk = async (p: number) => {
    const r = await new Deno.Command("pgrep", {
      args: ["-P", String(p)],
      stdout: "piped",
      stderr: "null",
    }).output().catch(() => null);
    if (!r?.success) return; // no pgrep (windows) — the parent is still killed
    for (const line of new TextDecoder().decode(r.stdout).trim().split("\n")) {
      const child = Number(line.trim());
      if (Number.isInteger(child) && child > 0) {
        out.push(child);
        await walk(child);
      }
    }
  };
  await walk(pid).catch(() => {});
  return out;
}

/** Ask the instance `l` names to stop, through the request `am stop` sends:
 *  `POST /__aio/trojan/shutdown` with the instance's per-boot control
 *  credential (`<data>/control.key`, which production answers too), at the
 *  endpoint its record names — the socket (a pipe on Windows), else the
 *  control port. The app's shared key only when the app asks for it (401/403),
 *  as `am` does. True when it accepted. @internal */
export async function askToStop(
  l: LockData,
  timeout = ASK_TIMEOUT_MS,
): Promise<boolean> {
  const control = readControlKey(l.appId, l.home);
  if (control.error !== undefined) return false;
  const headers: Record<string, string> = {
    "X-AIO": "1",
    "X-Aio-Control": control.key,
    // So the old app's log says a takeover ended it, not `am stop`.
    "X-Aio-Stop-By": "takeover",
  };
  const path = "/__aio/trojan/shutdown";
  const send = async (h: Record<string, string>): Promise<number | null> => {
    if (l.socketPath) {
      const r = await udsRequest(l.socketPath, path, {
        method: "POST",
        headers: h,
      }, timeout);
      return "error" in r ? null : r.status;
    }
    const port = l.trojanPort ?? l.port;
    if (!(port > 0)) return null;
    const at = endpointOf({ ...l, port });
    const host = at && "hostnames" in at ? at.hostnames[0]! : "127.0.0.1";
    try {
      const r = await fetch(
        `http://${host.includes(":") ? `[${host}]` : host}:${port}${path}`,
        { method: "POST", headers: h, signal: AbortSignal.timeout(timeout) },
      );
      await r.body?.cancel();
      return r.status;
    } catch {
      return null; // aio-ok: no answer — the caller ends it as before
    }
  };
  let status = await send(headers);
  if (status === 401 || status === 403) {
    try {
      const key = Deno.readTextFileSync(appKeyPath(l.appId, l.home)).trim();
      if (key) {
        status = await send({ ...headers, Authorization: `Bearer ${key}` });
      }
    } catch { /* aio-ok: no shared key — the refusal stands */ }
  }
  return status !== null && status >= 200 && status < 300;
}

/** How long {@linkcode askToStop} waits for the instance to answer. */
const ASK_TIMEOUT_MS = 3_000;

/** The steps of {@linkcode stopInstance} a test replaces. @internal */
export const _stopDeps = { ask: askToStop };

/** THE way a launch ends a HEALTHY instance (`--takeover`): ask it to stop,
 *  give it the whole teardown budget (`EXIT_WAIT_MS`) to end itself, and only
 *  then force it ({@linkcode killProcess}). Asking first is what makes the
 *  stop graceful on Windows, where the signal `killProcess` sends is
 *  TerminateProcess — no `onStop`, no final save. An instance that does not
 *  answer (a zombie, a build before the stop request existed) gets
 *  `killProcess` as before. */
export async function stopInstance(
  l: LockData,
  grace = EXIT_WAIT_MS,
): Promise<void> {
  // Not ours to end — asking included (see `killProcess`).
  const foreign = foreignOwnerRefusal(l);
  if (foreign) throw new Error(foreign);
  if (await _stopDeps.ask(l)) {
    const until = Date.now() + grace;
    while (Date.now() < until && isLockOwnerAlive(l)) {
      await delay(KILL_POLL_MS);
    }
    if (!isLockOwnerAlive(l)) return;
    // Asked, and still there after the whole budget: force it, now.
    return await killProcess(l.pid, 0, l);
  }
  await killProcess(l.pid, grace, l);
}

/** THE process killer: SIGTERM, a grace period, then SIGKILL — and then any
 *  descendant the app left behind.
 *
 *  This used to exist TWICE, near-identically, and neither copy knew about
 *  child processes. That mattered most for the case it was written for: an aio
 *  app owns an Electron window, and a graceful stop closes it (`shutdown.ts`
 *  has an "electron" phase). But a HUNG app never reaches its shutdown, so the
 *  SIGKILL below orphaned the window — leaving a desktop app on screen with no
 *  server behind it, and a developer killing processes by hand before their
 *  next run would start.
 *
 *  The graceful path is unchanged and still preferred: when the app shuts down
 *  properly it reaps its own children, and the sweep below finds nothing. */
export async function killProcess(
  pid: number,
  grace = KILL_GRACE_MS,
  expect?: { startToken?: string; startEpoch?: number; ns?: number },
): Promise<void> {
  const foreign = expect && foreignOwnerRefusal({ pid, ns: expect.ns });
  if (foreign) throw new Error(foreign);
  if (!isProcessAlive(pid)) return;
  // `expect` is the lock that named this pid. If it recorded a start token and
  // the live process's does not match, the pid was RECYCLED: signalling it
  // would kill whatever the user happens to be running now. Refusing is the
  // only safe answer, and it is loud — a caller that wanted a process gone has
  // to know it is not gone.
  if (
    (expect?.startToken || expect?.startEpoch !== undefined) &&
    !isLockOwnerAlive({
      pid,
      startToken: expect.startToken,
      startEpoch: expect.startEpoch,
    })
  ) {
    throw new Error(
      `refusing to signal pid ${pid}: it is no longer the process that ` +
        `recorded this lock (the pid was reused — the lock outlived a reboot, ` +
        `which happens whenever XDG_RUNTIME_DIR is unset and the lock dir is ` +
        `under /tmp).\n` +
        `  fix: the lock is stale — remove it (am stop --stale) rather than ` +
        `killing pid ${pid}, which now belongs to something else.`,
    );
  }
  // Ask first, kill second.
  const kids = await descendantPids(pid);
  try {
    Deno.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + grace;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await delay(KILL_POLL_MS);
  }
  if (isProcessAlive(pid)) {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* ok */ }
    await delay(KILL_REAP_MS);
  }
  // Deepest first, so a parent cannot spawn a replacement on its way out.
  // Anything already gone (the graceful case) is a no-op.
  for (const kid of kids.reverse()) {
    if (!isProcessAlive(kid)) continue;
    try {
      Deno.kill(kid, "SIGKILL");
    } catch { /* already gone, or not ours to signal */ }
  }
}
