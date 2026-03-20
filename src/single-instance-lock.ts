// App identity + singleton lock for aio apps
// One lock file per app in $XDG_RUNTIME_DIR or /tmp — the lock IS the identity.
// Cross-platform: works on Linux, macOS, Windows
// Prevents multiple instances from corrupting shared resources

import { join } from '@std/path'

// ── Types ────────────────────────────────────────────────────

/** Unified lock file — replaces both .aio.lock and .aio.pid */
export type LockData = {
  appId: string          // canonical unique identity
  pid: number            // OS process ID
  port: number           // HTTP server port
  startedAt: number      // epoch ms
  status: 'starting' | 'started' | 'stopping'
  cwd: string            // working directory (for am/instances display)
  socketPath?: string    // UDS socket path (when using UDS transport)
  trojanPort?: number    // plain-HTTP control port (when TLS active)
}

/** Instance info returned by instances() — lock data + liveness */
export type InstanceInfo = LockData & { alive: boolean }

/** What to do when another instance of the same app is already running */
export type SingletonMode = boolean | 'takeover'
// true = refuse if running (default)
// 'takeover' = kill old instance, start new
// false = allow multiple instances

// ── App ID Resolution ────────────────────────────────────────

/** Slugify a string for filesystem use */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'aio-app'
}

/** Resolve app ID from deno.json "appId" field. Mandatory — throws if missing. */
export function resolveAppId(_opts?: { appId?: string; title?: string }): string {
  // Explicit override (legacy compat — prefer deno.json)
  if (_opts?.appId) return slugify(_opts.appId)

  try {
    const cfg = JSON.parse(Deno.readTextFileSync(join(Deno.cwd(), 'deno.json'))) as { appId?: string }
    if (cfg.appId) return slugify(cfg.appId)
  } catch { /* no deno.json */ }

  throw new Error('[aio] missing "appId" in deno.json — add "appId": "my-app" to your deno.json')
}

// ── Lock File Paths ──────────────────────────────────────────

/** Directory for lock + socket files — /tmp/aio/ (or $XDG_RUNTIME_DIR/aio/ on Linux) */
let _lockDir: string | null = null
export function lockDir(): string {
  if (_lockDir) return _lockDir
  const base = Deno.build.os === 'windows'
    ? (Deno.env.get('TEMP') ?? Deno.env.get('TMP') ?? 'C:\\Temp')
    : (Deno.env.get('XDG_RUNTIME_DIR') ?? '/tmp')
  _lockDir = join(base, 'aio')
  try { Deno.mkdirSync(_lockDir, { recursive: true }) } catch { /* already exists */ }
  return _lockDir
}

/** Full path to the lock file for a given appId */
export function lockPath(appId: string): string {
  return join(lockDir(), `${appId}.lock`)
}

// ── Process Liveness ─────────────────────────────────────────

/** Check if a process is alive via signal 0 */
export function isProcessAlive(pid: number): boolean {
  try { Deno.kill(pid, 0); return true } catch { return false }
}

/** Check if a TCP port has something listening */
export async function isPortInUse(port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: '127.0.0.1', port })
    conn.close()
    return true
  } catch {
    return false
  }
}

// ── Lock File CRUD ───────────────────────────────────────────

/** Read a lock file, return null if missing or corrupt */
export function readLock(appId: string): LockData | null {
  try {
    const raw = Deno.readTextFileSync(lockPath(appId))
    const data = JSON.parse(raw) as LockData
    // Validate minimum fields
    if (!data.appId || !data.pid || !data.port) return null
    return data
  } catch { return null }
}

/** Write lock file atomically — createNew for first write, overwrite for updates */
export function writeLock(data: LockData): void {
  Deno.writeTextFileSync(lockPath(data.appId), JSON.stringify(data))
}

/** Atomic create-new lock file — returns false if file already exists (race-safe) */
function tryCreateLock(data: LockData): boolean {
  const encoded = new TextEncoder().encode(JSON.stringify(data))
  try {
    const fd = Deno.openSync(lockPath(data.appId), { createNew: true, write: true })
    fd.writeSync(encoded)
    fd.close()
    return true
  } catch {
    return false  // file already exists (another process won the race)
  }
}

/** Remove a lock file */
export function removeLock(appId: string): void {
  try { Deno.removeSync(lockPath(appId)) } catch { /* already gone */ }
}

// ── AppLock — Singleton Enforcement ──────────────────────────

export class AppLock {
  readonly appId: string
  private acquired = false

  constructor(appId: string) {
    this.appId = appId
  }

  /** Acquire the lock for this app.
   *  - Cleans stale locks (dead PID)
   *  - Refuses if alive instance exists (singleton=true)
   *  - Kills old instance first (singleton='takeover')
   *  Returns the existing LockData if refusing, null on success. */
  async acquire(port: number, mode: SingletonMode = true): Promise<{ ok: true } | { ok: false; existing: LockData }> {
    const maxRetries = 30  // 3 seconds total

    for (let i = 0; i < maxRetries; i++) {
      const existing = readLock(this.appId)

      if (!existing) {
        // No lock — try atomic create
        const data: LockData = {
          appId: this.appId, pid: Deno.pid, port,
          startedAt: Date.now(), status: 'starting', cwd: Deno.cwd(),
        }
        if (tryCreateLock(data)) {
          this.acquired = true
          return { ok: true }
        }
        // Race — someone else created it between our read and write. Retry.
        await delay(100)
        continue
      }

      // Lock exists — check if owner is alive
      if (!isProcessAlive(existing.pid)) {
        // Dead process — clean stale lock and retry
        removeLock(this.appId)
        await delay(100)
        continue
      }

      // Owner is alive — behavior depends on mode
      if (mode === false) {
        // Multi-instance allowed — but same appId means same app, shouldn't overlap.
        // This case shouldn't really happen (multi-instance apps get unique IDs).
        return { ok: false, existing }
      }

      if (mode === 'takeover') {
        // Kill the old instance
        await killProcess(existing.pid)
        removeLock(this.appId)
        await delay(100)
        continue
      }

      // mode === true (default) — refuse
      return { ok: false, existing }
    }

    // Exhausted retries (persistent race condition)
    const existing = readLock(this.appId)
    if (existing) return { ok: false, existing }
    // Last-ditch attempt
    const data: LockData = {
      appId: this.appId, pid: Deno.pid, port,
      startedAt: Date.now(), status: 'starting', cwd: Deno.cwd(),
    }
    if (tryCreateLock(data)) {
      this.acquired = true
      return { ok: true }
    }
    return { ok: false, existing: readLock(this.appId)! }
  }

  /** Update lock data (e.g. status change, socketPath, trojanPort) */
  update(partial: Partial<Omit<LockData, 'appId' | 'pid'>>): void {
    const existing = readLock(this.appId)
    if (!existing || existing.pid !== Deno.pid) return  // not ours
    writeLock({ ...existing, ...partial })
  }

  /** Release the lock — removes the file */
  release(): void {
    if (!this.acquired) return
    // Only remove if it's still ours (PID matches)
    const existing = readLock(this.appId)
    if (existing && existing.pid === Deno.pid) {
      removeLock(this.appId)
    }
    this.acquired = false
  }
}

// ── instances() — Scan Running Apps ──────────────────────────

/** Scan for running aio instances. Filters stale locks automatically. */
export function instances(appId?: string): InstanceInfo[] {
  const dir = lockDir()
  const results: InstanceInfo[] = []

  try {
    for (const entry of Deno.readDirSync(dir)) {
      if (!entry.isFile || !entry.name.endsWith('.lock')) continue
      const id = entry.name.slice(0, -5)  // strip ".lock" suffix
      if (appId && id !== appId) continue

      const lock = readLock(id)
      if (!lock) continue

      const alive = isProcessAlive(lock.pid)
      if (!alive) {
        // Clean stale lock
        removeLock(id)
        continue
      }
      results.push({ ...lock, alive })
    }
  } catch { /* dir not readable */ }

  return results
}

// ── Helpers ──────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

const KILL_GRACE_MS = 2000
const KILL_POLL_MS = 100

/** Kill a process: SIGTERM first, SIGKILL after grace period */
async function killProcess(pid: number, grace = KILL_GRACE_MS): Promise<void> {
  if (!isProcessAlive(pid)) return
  try { Deno.kill(pid, 'SIGTERM') } catch { return }
  const deadline = Date.now() + grace
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await delay(KILL_POLL_MS)
  }
  if (isProcessAlive(pid)) {
    try { Deno.kill(pid, 'SIGKILL') } catch { /* ok */ }
    await delay(300)
  }
}
