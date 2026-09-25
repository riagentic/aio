// App identity + singleton lock for aio apps
// One lock file per app in $XDG_RUNTIME_DIR or /tmp — the lock IS the identity.
// Cross-platform: works on Linux, macOS, Windows
// Prevents multiple instances from corrupting shared resources

import { basename, dirname, join, resolve } from "@std/path";
import { privateDirRefusal, selfUid } from "./dir-permissions.ts";
import { connectLocal, isPipePath } from "./local-listen.ts";
import {
  appDirs,
  appHome,
  appsDirEnv,
  profileNameError,
  profileOfHome,
} from "./app-dirs.ts";
import { log } from "../diagnostics/logger-api.ts";
import { EXIT_WAIT_MS } from "./shutdown-budget.ts";
import { locateDenoJsonAbove, readDenoJsonSync } from "./deno-json.ts";
import { inheritedWorkerAppId } from "./cell-worker-protocol.ts";

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
  cwd: string; // working directory (for am/instances display)
  /** The resolved data home this instance runs from. Part of the lock's
   *  IDENTITY (see {@linkcode lockKey}): two boots of one appId from two homes
   *  are two apps, not a duplicate. Optional only for locks written before
   *  alpha66 — a missing value means the default home. */
  home?: string;
  socketPath?: string; // UDS socket path (when using UDS transport)
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
};

/** Instance info returned by instances() — lock data + liveness */
export type InstanceInfo = LockData & { alive: boolean };

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
  const raw = cfg?.appId ?? cfg?.title ?? cfg?.name?.split("/").pop();
  return raw ? slugify(raw) : null;
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
  // Zero-config inference (dev): deno.json appId > title > name (unscoped) —
  // then the main module's directory name (its parent when the entry sits in
  // src/). Deterministic per project, so locks/KV/socket identity is stable.
  try {
    // THE reader — JSONC-aware. `JSON.parse` here threw on a deno.json with a
    // comment in it, and the catch below inferred the app id from the
    // directory name instead: a different id, a different data dir, an
    // app that "lost" its data by adding a comment to its config.
    const cfg = readDenoJsonSync(Deno.cwd())?.config as
      | { appId?: string; title?: string; name?: string }
      | undefined;
    const fromCfg = cfg ? appIdFromConfig(cfg) : undefined;
    if (fromCfg) return fromCfg;
  } catch { /* no deno.json — fall through */ }
  try {
    const main = new URL(Deno.mainModule);
    if (main.protocol === "file:") {
      const parts = main.pathname.split("/").filter(Boolean);
      parts.pop(); // the entry file itself
      const dir = parts.pop();
      const name = dir === "src" ? parts.pop() : dir;
      if (name) return slugify(name);
    }
  } catch { /* unusual entry */ }
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
    if (name.includes(tag) && pruneDeadLockDirAt(join(base, name))) n++;
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
 *  - a legacy `<appId>.launch.json` with no lock of that app beside it.
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
      let raw: string | null = null;
      try {
        raw = Deno.readTextFileSync(path);
      } catch { /* aio-ok: gone meanwhile, or not a file — rmdir decides */ }
      if (raw === null) continue; // gone, or not a file — rmdir decides
      const own = parseLock(raw);
      if (!own) {
        if (unknownLockDead(path, raw, rootGone)) removeLockFileIf(path, raw);
        continue;
      }
      // Naming THIS process but held by no lock of it: a hand-written record
      // (a test fixture) — as dead as its writer is about to be.
      const planted = own.pid === Deno.pid &&
        !AppLock.live().some((l) => lockPath(l.key) === path);
      if (planted || !isLockOwnerAlive(own)) removeLockFileIf(path, raw);
    } else if (n.endsWith(".lock.mx")) {
      dropIdleMutex(path);
    } else if (/\.sock$/.test(n)) {
      if (bound === undefined) bound = boundUnixSockets();
      if (bound && !bound.has(path)) removeIfSocket(path);
    } else {
      const m = /^watch-(\d+)\.tmp$/.exec(n) ??
        /\.lock\.(\d+)\.[0-9a-f]{8}\.tmp$/.exec(n);
      if (m && !isProcessAlive(Number(m[1]))) {
        try {
          Deno.removeSync(path);
        } catch { /* aio-ok: a sibling removed it first */ }
      }
    }
  }
  // A pre-alpha38 `<appId>.launch.json` (nothing writes one there now; it is
  // only read) goes once no lock of that app is left beside it.
  for (const n of names) {
    const m = /^(.+)\.launch\.json$/.exec(n);
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
    const sentinel = join(dir, `watch-${Deno.pid}.tmp`);
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
      if (parseLock(raw)?.pid === Deno.pid) removeLockFileIf(path, raw);
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
): Pick<LockData, "startToken" | "startEpoch"> {
  const token = processStartToken(pid);
  if (token !== null) return { startToken: token };
  const epoch = processStartEpoch(pid);
  return epoch !== null ? { startEpoch: epoch } : {};
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
  lock: { pid: number; startToken?: string; startEpoch?: number },
): boolean {
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
  return parseLock(readLockRaw(key));
}

/** The lock file's exact bytes (as text), or null when there is no file.
 *  Every removal compares against THIS — see {@linkcode removeLockIf}. */
function readLockRaw(key: string): string | null {
  try {
    return Deno.readTextFileSync(lockPath(key));
  } catch {
    return null;
  }
}

function parseLock(raw: string | null): LockData | null {
  if (raw === null) return null;
  try {
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
//     for every update; updates now replace the file with one `rename`.)
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

/** Publish `text` at `path` only if nothing is there — never a half-written
 *  file. True on success, false if the name is taken. */
function publishExclusive(path: string, text: string): boolean {
  const tmp = `${path}.${Deno.pid}.${_nonce()}.tmp`;
  const writeTmp = () => Deno.writeTextFileSync(tmp, text, { mode: 0o600 });
  try {
    writeTmp();
  } catch (e) {
    // The directory can vanish between `lockDir()` and this write: a sibling
    // app's shutdown pruned its (momentarily empty) scoped dir. Re-create and
    // try once more — an ENOENT here is never "someone holds the lock".
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    remakeLockDir(dirname(path));
    writeTmp();
  }
  try {
    Deno.linkSync(tmp, path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.AlreadyExists) return false;
    // A filesystem without hard links: fall back to an exclusive create. The
    // content goes in with ONE write call; readers treat a short/empty file
    // as "being written" for a grace period (see `acquire`), never as dead.
    // `mode` as the tmp above has it: the record names the owner's pid,
    // cwd and home, and this branch used to create it at the umask default
    // (0644 — every local user reads it) while the link path gave 0600.
    const excl = { createNew: true, write: true, mode: 0o600 };
    const fd = Deno.openSync(path, excl);
    try {
      fd.writeSync(new TextEncoder().encode(text));
    } finally {
      fd.close();
    }
    return true;
  } finally {
    try {
      Deno.removeSync(tmp);
    } catch { /* aio-ok: already gone */ }
  }
}

/** Replace `path` with `text` in one step (tmp → rename). */
function replaceAtomic(path: string, text: string): void {
  const tmp = `${path}.${Deno.pid}.${_nonce()}.tmp`;
  try {
    Deno.writeTextFileSync(tmp, text, { mode: 0o600 });
  } catch (e) {
    // Same case as publishExclusive: a sibling's shutdown pruned the scoped
    // lock dir between our `lockDir()` and this write. Re-create, write again.
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    remakeLockDir(dirname(path));
    Deno.writeTextFileSync(tmp, text, { mode: 0o600 });
  }
  try {
    Deno.renameSync(tmp, path);
  } catch (e) {
    try {
      Deno.removeSync(tmp);
    } catch { /* aio-ok: already gone */ }
    throw e;
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
 *  be being pruned. */
function withLockMutexAt<T>(
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
const ORPHAN_TEMP = /^\.(\d+)\.[0-9a-f]{8}\.tmp$/;
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
    if (rest === ".mx") {
      dropIdleMutex(join(lockDir(), name));
      continue;
    }
    const m = ORPHAN_TEMP.exec(rest);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === Deno.pid || isProcessAlive(pid)) continue;
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
): boolean {
  return withLockMutexAt(path, () => {
    let now: string | null = null;
    try {
      now = Deno.readTextFileSync(path);
    } catch { /* aio-ok: gone — nothing to remove */ }
    if (now !== judged) return false;
    try {
      Deno.removeSync(path);
      return true;
    } catch {
      return false; // aio-ok: removed meanwhile — the goal holds
    }
  }, recreate) ?? false;
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
      Deno.removeSync(lockPath(key));
      return true;
    } catch {
      return false; // aio-ok: removed meanwhile — the goal holds
    }
  });
}

/** Write lock file — an atomic whole-file replace (never a half-written file a
 *  reader could take for a dead lock), under the lock's mutex.
 *  @decider */
export function writeLock(data: LockData): void {
  const key = lockKey(data.appId, data.home, data.profile);
  withLockMutex(key, () => replaceAtomic(lockPath(key), JSON.stringify(data)));
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
    const now = parseLock(readLockRaw(key));
    if (!now || !sameRecord(expected, now)) return false;
    const data = typeof next === "function" ? next(now) : next;
    replaceAtomic(path, JSON.stringify(data));
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
  if (was.startToken && now.startToken && was.startToken !== now.startToken) {
    return false;
  }
  return !(typeof was.startEpoch === "number" &&
    typeof now.startEpoch === "number" && was.startEpoch !== now.startEpoch);
}

/** Atomic create-new lock file — returns false if file already exists (race-safe) */
function tryCreateLock(data: LockData): boolean {
  const path = lockPath(lockKey(data.appId, data.home, data.profile));
  try {
    return publishExclusive(path, JSON.stringify(data));
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
      // SIGTERM gets a line in the log; SIGINT does not.
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
  ): Promise<{ ok: true } | { ok: false; existing: LockData }> {
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
      ...(meta.aioVersion !== undefined ? { aioVersion: meta.aioVersion } : {}),
      ...((this.profile ?? meta.profile) !== undefined
        ? { profile: this.profile ?? meta.profile }
        : {}),
      ...(meta.cdpPort !== undefined ? { cdpPort: meta.cdpPort } : {}),
      ...(meta.client !== undefined ? { client: meta.client } : {}),
      ...(meta.dataDir !== undefined ? { dataDir: meta.dataDir } : {}),
      ...(meta.settings !== undefined ? { settings: meta.settings } : {}),
    });

    sweepOrphanLockTemps(this.key);
    for (let i = 0; i < maxRetries; i++) {
      // The BYTES, kept: every removal below is compare-and-delete against
      // exactly the record judged here, never "whatever is at the path now".
      const raw = readLockRaw(this.key);
      const existing = parseLock(raw);

      if (!existing) {
        // No lock — try atomic create
        if (tryCreateLock(fresh())) {
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

      // Lock exists but owner is us (am pre-registered) — take over
      if (existing.pid === Deno.pid) {
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
        log.warn("lock", deadOwnerWarning(this.appId, existing));
        removeLockIf(this.key, raw!);
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
      const pastStartup = existing.status !== "starting" ||
        ageSince(existing.startedAt) > STARTUP_GRACE_MS;
      let listenerDead = false;
      if (pastStartup) {
        if (existing.socketPath) {
          listenerDead = !(await isSocketAlive(existing.socketPath));
        } else if (existing.port > 0) {
          listenerDead = !(await isPortInUse(existing.port));
        }
      }
      if (listenerDead) {
        const where = existing.socketPath
          ? `socket ${printable(existing.socketPath)}`
          : `port ${existing.port}`;
        log.warn(
          `[AIO] stale instance: pid ${existing.pid} is alive but ${where} refuses connections — reclaiming lock (zombie server)`,
        );
        removeLockIf(this.key, raw!);
        await delay(100);
        continue;
      }

      // Owner is alive — behavior depends on killExisting
      if (killExisting) {
        // Kill the old instance — SIGTERM, then wait out the WHOLE graceful
        // budget before SIGKILL: a takeover is not a reason to truncate the
        // previous instance's final snapshot.
        // Wait out the app's OWN self-kill deadline too (`stopProcess`'s
        // watchdog), not just the phase budget: a takeover that SIGKILLs at
        // 9 s cuts off an app that was about to end itself cleanly at 10 s.
        await killProcess(existing.pid, EXIT_WAIT_MS, existing);
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
    if (tryCreateLock(fresh())) {
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
      const existing = readLock(this.key);
      if (!existing || existing.pid !== Deno.pid) return; // not ours
      replaceAtomic(
        lockPath(this.key),
        JSON.stringify({ ...existing, ...partial }),
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
    if (!this.acquired) return;
    // Only remove if it's still ours (PID matches)
    const raw = readLockRaw(this.key);
    if (parseLock(raw)?.pid === Deno.pid) removeLockIf(this.key, raw!);
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

/** Take the home claim, or name who holds it.
 *
 *  Refused only ACROSS scopes: a holder filed in THIS lock dir was already
 *  judged by the lock file (a zombie the acquire just reclaimed keeps its OS
 *  lock until it dies), so that verdict stands, exactly as before the claim
 *  existed. A home that does not exist yet and a file system that cannot lock
 *  are not refusals either. @internal */
export function claimHome(
  home: string,
  who: { appId: string; port: number; key?: string },
):
  | { ok: true; close: () => void }
  | {
    ok: false;
    holder?: { pid?: number; appId?: string; lockDir?: string; lock?: string };
  } {
  const none = { ok: true as const, close: () => {} };
  let f: Deno.FsFile;
  try {
    f = Deno.openSync(join(home, HOME_CLAIM), {
      read: true,
      write: true,
      create: true,
      mode: 0o600,
    });
  } catch {
    return none; // aio-ok: no home yet — nothing to guard
  }
  let locked: boolean;
  try {
    locked = f.tryLockSync(true);
  } catch {
    f.close();
    return none; // aio-ok: this file system cannot lock
  }
  const info = join(home, HOME_CLAIM_INFO);
  if (!locked) {
    f.close();
    let holder:
      | { pid?: number; appId?: string; lockDir?: string; lock?: string }
      | undefined;
    try {
      holder = JSON.parse(Deno.readTextFileSync(info));
    } catch { /* aio-ok: no text — refused, named without it */ }
    // Only the EXACT lock this acquire just judged — same dir, same name —
    // stands; anything else holding the home is another process on it.
    const mine = who.key !== undefined ? lockPath(who.key) : undefined;
    if (mine !== undefined && holder?.lock === mine) return none;
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
      }),
      { mode: 0o600 },
    );
  } catch { /* aio-ok: the OS lock is what guards; the text only names it */ }
  return { ok: true, close: () => f.close() };
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
      const raw = readLockRaw(key);
      const lock = parseLock(raw);
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
  expect?: { startToken?: string; startEpoch?: number },
): Promise<void> {
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
