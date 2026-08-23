// App identity + singleton lock for aio apps
// One lock file per app in $XDG_RUNTIME_DIR or /tmp — the lock IS the identity.
// Cross-platform: works on Linux, macOS, Windows
// Prevents multiple instances from corrupting shared resources

import { dirname, join } from "@std/path";
import { appDirs } from "./app-dirs.ts";
import { log } from "../diagnostics/logger-api.ts";
import { SHUTDOWN_BUDGET_MS } from "./shutdown-budget.ts";

/** How long a lock may sit at `status:"starting"` before anyone — the next
 *  launch's zombie probe, `am start` — may treat "its listener does not answer"
 *  as "it is stuck". THE one decider: `am` used to have none, probed the port
 *  the placeholder lock carried (0, when the app had not declared one) and
 *  killed every app that was still booting. */
export const STARTUP_GRACE_MS = 10_000;

// ── Types ────────────────────────────────────────────────────

/** Unified lock file — replaces both .aio.lock and .aio.pid */
export type LockData = {
  appId: string; // canonical unique identity
  pid: number; // OS process ID
  port: number; // HTTP server port
  startedAt: number; // epoch ms
  status: "starting" | "started" | "stopping";
  cwd: string; // working directory (for am/instances display)
  socketPath?: string; // UDS socket path (when using UDS transport)
  trojanPort?: number; // plain-HTTP control port (when TLS active)
  // LAN-discovery metadata — present only for --expose'd apps, so any
  // discovery responder on the host can report EVERY exposed app (not just
  // itself) by reading the lock dir. See src/server/discovery.ts.
  discovery?: { title?: string; tls: boolean; needsAuth: boolean };
};

/** Instance info returned by instances() — lock data + liveness */
export type InstanceInfo = LockData & { alive: boolean };

/** What to do when another instance of the same app is already running */
export type SingletonMode = boolean;
// true = refuse if running (default)
// false = allow multiple instances

// ── App ID Resolution ────────────────────────────────────────

/** Slugify a string for filesystem use */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    "aio-app";
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
 *  the same lookup `appDenoJson()` uses for the version in the boot banner.
 *  Kept local so this module stays free of a server-side import cycle. */
function _embeddedDenoJson(): unknown {
  try {
    const main = new URL(Deno.mainModule);
    for (const up of ["./", "../", "../../"]) {
      try {
        const text = Deno.readTextFileSync(new URL(`${up}deno.json`, main));
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") return parsed;
      } catch { /* not at this level — walk up */ }
    }
  } catch { /* no usable main module */ }
  return null;
}

/** Resolve app ID — explicit `appId` wins; otherwise inferred. */
export function resolveAppId(appId?: string): string {
  if (appId) return slugify(appId);
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
    const cfg = JSON.parse(
      Deno.readTextFileSync(join(Deno.cwd(), "deno.json")),
    ) as { appId?: string; title?: string; name?: string };
    const fromCfg = appIdFromConfig(cfg);
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
  const appsRoot = Deno.env.get("AIO_APPS_DIR") ?? "";
  if (_lockDir && _lockDirKey === appsRoot) return _lockDir;
  const base = Deno.build.os === "windows"
    ? (Deno.env.get("TEMP") ?? Deno.env.get("TMP") ?? "C:\\Temp")
    : (Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp");
  const scope = appsRoot
    ? "-" + appsRoot.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      .slice(-48)
    : "";
  _lockDirKey = appsRoot;
  _lockDir = join(base, "aio" + scope);
  try {
    Deno.mkdirSync(_lockDir, { recursive: true });
  } catch { /* already exists */ }
  try {
    // 0700, and NOT only for tidiness: the base is `$XDG_RUNTIME_DIR` (already
    // 0700, so this is a no-op) OR `/tmp` when that is unset — containers,
    // no-systemd hosts, plain ssh. There the default 0755 left every app's
    // control socket at a predictable path any local user could traverse to and
    // connect to, i.e. dispatch methods into someone else's app. The mode has to
    // assume the /tmp case, because that is the one where it matters.
    if (Deno.build.os !== "windows") Deno.chmodSync(_lockDir, 0o700);
  } catch { /* best-effort — not ours to chmod (shared dir, odd FS) */ }
  return _lockDir;
}

/** Remove the per-`AIO_APPS_DIR` lock dir when it is empty — called at the
 *  very end of an app's shutdown. The default dir (`…/aio`) is never removed;
 *  it is shared by every app on the machine and costs nothing. A scoped one
 *  belongs to a temp home that is about to be deleted, and used to outlive it
 *  forever. Non-recursive on purpose: another app's lock or a live watcher
 *  sentinel makes the rmdir fail, which is the right answer. */
export function pruneLockDir(): void {
  if (!_lockDir || !Deno.env.get("AIO_APPS_DIR")) return;
  try {
    Deno.removeSync(_lockDir);
    // The path is still right; only the directory is gone. Forget the cached
    // answer so the next `lockDir()` call re-creates it (a later app in this
    // same process — every sequential test — must not write into a void).
    _lockDir = null;
    _lockDirKey = null;
  } catch { /* not empty, or already gone — either way not ours to force */ }
}

/** Full path to the lock file for a given appId */
export function lockPath(appId: string): string {
  return join(lockDir(), `${appId}.lock`);
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
export function writeLaunchInfo(appId: string, info: LaunchInfo): void {
  try {
    const path = launchInfoPath(appId);
    Deno.mkdirSync(dirname(path), { recursive: true });
    Deno.writeTextFileSync(path, JSON.stringify(info));
  } catch { /* best-effort — restart falls back to a warning */ }
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

/** Check if a Unix Domain Socket has something listening — used to detect
 *  zombie UDS-only instances (prod/electron skipHttp) whose process is alive
 *  but whose listener died. Mirrors isPortInUse for the socket transport. */
export async function isSocketAlive(socketPath: string): Promise<boolean> {
  try {
    const conn = await Deno.connect({ transport: "unix", path: socketPath });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

// ── Lock File CRUD ───────────────────────────────────────────

/** Read a lock file, return null if missing or corrupt */
export function readLock(appId: string): LockData | null {
  try {
    const raw = Deno.readTextFileSync(lockPath(appId));
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

/** Write lock file atomically — createNew for first write, overwrite for updates */
export function writeLock(data: LockData): void {
  const path = lockPath(data.appId);
  try {
    Deno.writeTextFileSync(path, JSON.stringify(data));
  } catch (e) {
    // Same case as tryCreateLock: a sibling's shutdown pruned the scoped lock
    // dir between our `lockDir()` and this write. Re-create, write once more.
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    Deno.mkdirSync(dirname(path), { recursive: true });
    Deno.writeTextFileSync(path, JSON.stringify(data));
  }
}

/** Atomic create-new lock file — returns false if file already exists (race-safe) */
function tryCreateLock(data: LockData): boolean {
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const open = () =>
    Deno.openSync(lockPath(data.appId), { createNew: true, write: true });
  try {
    let fd: Deno.FsFile;
    try {
      fd = open();
    } catch (e) {
      // The directory can vanish between `lockDir()` and this write: a sibling
      // app's shutdown pruned its (momentarily empty) scoped dir. Re-create
      // and try once more — an ENOENT here is never "someone holds the lock".
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      Deno.mkdirSync(dirname(lockPath(data.appId)), { recursive: true });
      fd = open();
    }
    fd.writeSync(encoded);
    fd.close();
    return true;
  } catch {
    return false; // file already exists (another process won the race)
  }
}

/** Remove a lock file */
export function removeLock(appId: string): void {
  try {
    Deno.removeSync(lockPath(appId));
  } catch { /* already gone */ }
}

// ── AppLock — Singleton Enforcement ──────────────────────────

export class AppLock {
  readonly appId: string;
  private acquired = false;

  constructor(appId: string) {
    this.appId = appId;
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
    const markStopping = () => {
      for (const lock of [...AppLock._live]) {
        lock.update({ status: "stopping" });
      }
    };
    try {
      addEventListener("unload", release);
    } catch { /* skip if listener limit */ }
    try {
      AppLock._sigintHandler = markStopping;
      Deno.addSignalListener("SIGINT", markStopping);
    } catch { /* unsupported on windows */ }
    try {
      AppLock._sigtermHandler = markStopping;
      Deno.addSignalListener("SIGTERM", markStopping);
    } catch { /* unsupported on windows */ }
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
    AppLock._sigintHandler = undefined;
    AppLock._sigtermHandler = undefined;
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

  /** Acquire the lock for this app.
   *  - Cleans stale locks (dead PID)
   *  - Refuses if alive instance exists (killExisting=false)
   *  - Kills old instance first (killExisting=true)
   *  Returns the existing LockData if refusing, null on success. */
  async acquire(
    port: number,
    killExisting = false,
  ): Promise<{ ok: true } | { ok: false; existing: LockData }> {
    const maxRetries = 30; // 3 seconds total

    for (let i = 0; i < maxRetries; i++) {
      const existing = readLock(this.appId);

      if (!existing) {
        // No lock — try atomic create
        const data: LockData = {
          appId: this.appId,
          pid: Deno.pid,
          port,
          startedAt: Date.now(),
          status: "starting",
          cwd: Deno.cwd(),
        };
        if (tryCreateLock(data)) {
          this.acquired = true;
          this._registerCleanupHandlers();
          return { ok: true };
        }
        // Race — someone else created it between our read and write. Retry.
        await delay(100);
        continue;
      }

      // Lock exists but owner is us (am pre-registered) — take over
      if (existing.pid === Deno.pid) {
        removeLock(this.appId);
        await delay(100);
        continue;
      }

      // Lock exists — check if owner is alive
      if (!isProcessAlive(existing.pid)) {
        // Dead process — clean stale lock and retry
        removeLock(this.appId);
        await delay(100);
        continue;
      }

      // Owner's pid is alive but its listener may be dead (zombie: event-loop
      // starvation killed the HTTP server while the process spun on, see
      // watcher-loop field report #5). Liveness = pid alive AND listener
      // responds. Probe whichever transport the owner advertises: TCP port
      // for HTTP servers, UDS for socket-only (prod/electron skipHttp) ones.
      // Grace: skip while the owner is still starting up.
      const pastStartup = existing.status !== "starting" ||
        Date.now() - existing.startedAt > STARTUP_GRACE_MS;
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
          ? `socket ${existing.socketPath}`
          : `port ${existing.port}`;
        log.warn(
          `[AIO] stale instance: pid ${existing.pid} is alive but ${where} refuses connections — reclaiming lock (zombie server)`,
        );
        removeLock(this.appId);
        await delay(100);
        continue;
      }

      // Owner is alive — behavior depends on killExisting
      if (killExisting) {
        // Kill the old instance — SIGTERM, then wait out the WHOLE graceful
        // budget before SIGKILL: a takeover is not a reason to truncate the
        // previous instance's final snapshot.
        await killProcess(existing.pid, SHUTDOWN_BUDGET_MS + 1000);
        removeLock(this.appId);
        await delay(100);
        continue;
      }

      // killExisting=false (default) — refuse
      return { ok: false, existing };
    }

    // Exhausted retries (persistent race condition)
    const existing = readLock(this.appId);
    if (existing) return { ok: false, existing };
    // Last-ditch attempt
    const data: LockData = {
      appId: this.appId,
      pid: Deno.pid,
      port,
      startedAt: Date.now(),
      status: "starting",
      cwd: Deno.cwd(),
    };
    if (tryCreateLock(data)) {
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
      existing: readLock(this.appId) ?? {
        appId: this.appId,
        pid: 0,
        port: 0,
        startedAt: Date.now(),
        status: "starting",
        cwd: "",
      },
    };
  }

  /** Update lock data (e.g. status change, socketPath, trojanPort) */
  update(partial: Partial<Omit<LockData, "appId" | "pid">>): void {
    const existing = readLock(this.appId);
    if (!existing || existing.pid !== Deno.pid) return; // not ours
    writeLock({ ...existing, ...partial });
  }

  /** Release the lock — removes the file and unregisters signal handlers */
  release(): void {
    if (!this.acquired) return;
    // Only remove if it's still ours (PID matches)
    const existing = readLock(this.appId);
    if (existing && existing.pid === Deno.pid) {
      removeLock(this.appId);
    }
    this.acquired = false;
    this._unregisterCleanupHandlers();
  }
}

// ── instances() — Scan Running Apps ──────────────────────────

/** Scan for running aio instances. Filters stale locks automatically. */
export function instances(appId?: string): InstanceInfo[] {
  const dir = lockDir();
  const results: InstanceInfo[] = [];

  try {
    for (const entry of Deno.readDirSync(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".lock")) continue;
      const id = entry.name.slice(0, -5); // strip ".lock" suffix
      if (appId && id !== appId) continue;

      const lock = readLock(id);
      if (!lock) continue;

      const alive = isProcessAlive(lock.pid);
      if (!alive) {
        // Clean stale lock
        removeLock(id);
        continue;
      }
      results.push({ ...lock, alive });
    }
  } catch { /* dir not readable */ }

  return results;
}

// ── Helpers ──────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const KILL_GRACE_MS = 2000;
const KILL_POLL_MS = 100;
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
): Promise<void> {
  if (!isProcessAlive(pid)) return;
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
