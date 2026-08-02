// App identity + singleton lock for aio apps
// One lock file per app in $XDG_RUNTIME_DIR or /tmp — the lock IS the identity.
// Cross-platform: works on Linux, macOS, Windows
// Prevents multiple instances from corrupting shared resources

import { dirname, join } from "@std/path";
import { appDirs } from "./app-dirs.ts";

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
    const fromCfg = cfg.appId ?? cfg.title ?? cfg.name?.split("/").pop();
    if (fromCfg) return slugify(fromCfg);
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
  return _lockDir;
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
  } catch {
    return false;
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
    // Validate minimum fields
    if (!data.appId || !data.pid || !data.port) return null;
    return data;
  } catch {
    return null;
  }
}

/** Write lock file atomically — createNew for first write, overwrite for updates */
export function writeLock(data: LockData): void {
  Deno.writeTextFileSync(lockPath(data.appId), JSON.stringify(data));
}

/** Atomic create-new lock file — returns false if file already exists (race-safe) */
function tryCreateLock(data: LockData): boolean {
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  try {
    const fd = Deno.openSync(lockPath(data.appId), {
      createNew: true,
      write: true,
    });
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

  /** Register process-termination hooks so the lock file is removed on crash /
   *  SIGINT / SIGTERM / page unload. Idempotent — safe to call from every
   *  acquire() exit path. Audit F-7: previously only registered in the
   *  last-ditch fallback, so normal startups leaked stale locks on hard exit. */
  private _registerCleanupHandlers(): void {
    if (AppLock._cleanupRegistered) return;
    AppLock._cleanupRegistered = true;
    const cleanup = () => this.release();
    try {
      addEventListener("unload", cleanup);
    } catch { /* skip if listener limit */ }
    try {
      AppLock._sigintHandler = cleanup;
      Deno.addSignalListener("SIGINT", cleanup);
    } catch { /* unsupported on windows */ }
    try {
      AppLock._sigtermHandler = cleanup;
      Deno.addSignalListener("SIGTERM", cleanup);
    } catch { /* unsupported on windows */ }
  }

  /** Unregister signal handlers to prevent listener leaks (e.g. in tests). */
  private _unregisterCleanupHandlers(): void {
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
        Date.now() - existing.startedAt > 10_000;
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
        console.warn(
          `[AIO] stale instance: pid ${existing.pid} is alive but ${where} refuses connections — reclaiming lock (zombie server)`,
        );
        removeLock(this.appId);
        await delay(100);
        continue;
      }

      // Owner is alive — behavior depends on killExisting
      if (killExisting) {
        // Kill the old instance
        await killProcess(existing.pid);
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

/** Kill a process: SIGTERM first, SIGKILL after grace period */
async function killProcess(pid: number, grace = KILL_GRACE_MS): Promise<void> {
  if (!isProcessAlive(pid)) return;
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
    await delay(300);
  }
}
