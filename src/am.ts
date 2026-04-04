#!/usr/bin/env -S deno run -A
/**
 * @module
 * am — aio manager: process management and runtime inspection CLI.
 *
 * Manages running aio apps, queries state, inspects React component trees,
 * and automates UI actions via a trojan HTTP client.
 *
 * ```sh
 * deno task am status
 * deno task am state --app counter
 * deno task am click "#submit"
 * ```
 */

import { VERSION } from "./aio.ts";
import {
  AppLock,
  instances,
  isProcessAlive,
  type LockData,
  readLock,
  removeLock,
  resolveAppId,
  writeLock,
} from "./single-instance-lock.ts";
import { join } from "@std/path";

// ── 1. Types & constants ─────────────────────────────────────

/** Output format for am CLI commands */
export type OutputMode = "pretty" | "json" | "quiet";
/** Result wrapper — success with data or failure with error message */
export type Result<T = unknown> = { ok: true; data: T } | {
  ok: false;
  error: string;
};

/** Process lock data — PID, port, socket path, start time, and app metadata. */
export { type LockData } from "./single-instance-lock.ts";
/** Process lock file data — alias for LockData */
export type PidFile = LockData;

const LOG_FILE = ".aio.log";
const DEFAULT_PORT = 8000;
const KILL_GRACE_MS = 2000;
const KILL_POLL_MS = 100;
const KILL_REAP_MS = 300;
const SINGLETON_WAIT_MS = 3000;
const POLL_INTERVAL_MS = 200;
const HEALTH_TIMEOUT_MS = 2000;
const QUICK_TIMEOUT_MS = 1000;
const STOP_CHECK_TIMEOUT_MS = 500;

// ── 2. Pure utilities ────────────────────────────────────────

/** Parse aio.run() config from entry file — extracts scalar literals (appId, port, etc.)
 *  Cached per session since the file doesn't change while am runs. */
let _entryConfig: { appId?: string; port?: number } | null = null;
function readEntryConfig(): { appId?: string; port?: number } {
  if (_entryConfig) return _entryConfig;
  _entryConfig = {};
  const entry = resolveEntry();
  if (!entry) return _entryConfig;
  try {
    const src = Deno.readTextFileSync(entry);
    // Match aio.run({ ... }) block — lazy [\s\S]*? handles multiline configs
    const block = src.match(/aio\.run\s*\(\s*\{([\s\S]*?)\}\s*\)/);
    if (block?.[1]) {
      const b = block[1];
      const appId = b.match(/appId\s*:\s*['"]([^'"]+)['"]/);
      if (appId?.[1]) _entryConfig.appId = appId[1];
      const port = b.match(/port\s*:\s*(\d+)/);
      if (port?.[1]) _entryConfig.port = parseInt(port[1], 10);
    }
  } catch { /* unreadable entry */ }
  return _entryConfig;
}

/** Resolve the appId for am commands — --app flag > deno.json appId > app.ts aio.run().
 *  am runs in dev only (not compiled), so deno.json is always available. */
function resolveAmAppId(flag?: string): string {
  if (flag) return resolveAppId(flag);
  try {
    const cfg = JSON.parse(
      Deno.readTextFileSync(join(Deno.cwd(), "deno.json")),
    ) as { appId?: string };
    if (cfg.appId) return resolveAppId(cfg.appId);
  } catch { /* no deno.json */ }
  const ec = readEntryConfig();
  if (ec.appId) return resolveAppId(ec.appId);
  throw new Error(
    '[am] missing appId — pass --app=X, add "appId" to deno.json, or set appId in aio.run()',
  );
}

/** Resolve port for am commands — --port flag > deno.json port > app.ts aio.run() port > DEFAULT_PORT */
function resolveAmPort(flag?: number): number {
  if (flag !== undefined) return flag; // AIO-212: don't ignore --port=0
  try {
    const cfg = JSON.parse(
      Deno.readTextFileSync(join(Deno.cwd(), "deno.json")),
    ) as { port?: number };
    if (cfg.port) return cfg.port;
  } catch { /* no deno.json */ }
  return readEntryConfig().port ?? DEFAULT_PORT;
}

/** Read lock data for current app — replaces old readPid() */
export function readPid(appId?: string): LockData | null {
  const id = appId ?? resolveAmAppId();
  const lock = readLock(id);
  if (!lock) return null;
  // Backward compat: old lock files without status
  if (!lock.status) lock.status = "started";
  return lock;
}

/** Write lock data — replaces old writePid() */
export function writePid(pf: LockData): void {
  writeLock(pf);
}

/** Remove lock — replaces old removePid() */
export function removePid(appId?: string): void {
  removeLock(appId ?? resolveAmAppId());
}

/** --port flag > lock file > app.ts > default 8000. */
export function resolvePort(flag?: number, appId?: string): number {
  if (flag !== undefined) return flag;
  const pf = readPid(appId);
  if (pf) return pf.port;
  return readEntryConfig().port ?? DEFAULT_PORT;
}

/** Check if a process with the given PID is still running */
export { isProcessAlive };

/** Format seconds into human-readable uptime string (e.g. "2h 15m 30s") */
export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/** Resolve entry point: --entry flag > deno.json "entry" > src/app.ts
 *  Convention: entry is src/app.ts. Override via deno.json "entry" if renamed. */
function resolveEntry(flagEntry?: string): string | null {
  if (flagEntry) {
    try {
      Deno.statSync(flagEntry);
      return flagEntry;
    } catch {
      return null;
    }
  }
  try {
    const cfg = JSON.parse(Deno.readTextFileSync("deno.json")) as {
      entry?: string;
    };
    if (cfg.entry) {
      try {
        Deno.statSync(cfg.entry);
        return cfg.entry;
      } catch {
        return null;
      }
    }
  } catch { /* no deno.json */ }
  try {
    Deno.statSync("src/app.ts");
    return "src/app.ts";
  } catch {
    return null;
  }
}

function detectMode(flags: GlobalFlags): OutputMode {
  if (flags.json) return "json";
  if (flags.quiet) return "quiet";
  return Deno.stdout.isTerminal() ? "pretty" : "json";
}

function out(data: unknown, mode: OutputMode): void {
  if (mode === "quiet") return;
  if (mode === "json") {
    console.log(JSON.stringify(data));
  } else {
    if (typeof data === "string") console.log(data);
    else console.log(JSON.stringify(data, null, 2));
  }
}

function outError(msg: string, mode: OutputMode): void {
  if (mode === "json") console.error(JSON.stringify({ error: msg }));
  else console.error(`error: ${msg}`);
}

/** Traverse path with JS-like syntax: "fleet[0].stats", "fleet[*].{pair,status}", "owner.{id,name}" */
export function resolvePath(
  obj: unknown,
  path: string,
): { found: true; value: unknown } | { found: false } {
  // Normalize bracket notation: fleet[0] → fleet.0, fleet[*] → fleet.*
  path = path.replace(/\[(\d+|\*)\]/g, ".$1");

  // Wildcard: split on first *, resolve prefix as array, map suffix over elements
  const starIdx = path.indexOf(".*");
  if (starIdx !== -1) {
    const prefix = path.slice(0, starIdx);
    const suffix = path.slice(starIdx + 2); // skip ".*"
    const rest = suffix.startsWith(".") ? suffix.slice(1) : suffix; // drop leading dot
    const parent = prefix
      ? resolvePath(obj, prefix)
      : { found: true as const, value: obj };
    if (!parent.found) return parent;
    if (!Array.isArray(parent.value)) return { found: false };
    const arr = parent.value as unknown[];
    if (!rest) return { found: true, value: arr };
    const results: unknown[] = [];
    for (const item of arr) {
      const r = resolvePath(item, rest);
      if (r.found) results.push(r.value);
    }
    return results.length ? { found: true, value: results } : { found: false };
  }

  // Check for brace-pick: "prefix.{a,b,c}" or "{a,b}" at root
  const braceMatch = path.match(/^(.*?)\.?\{([^}]+)\}$/);
  if (braceMatch) {
    const prefix = braceMatch[1];
    const picks = braceMatch[2]!.split(",").map((s) => s.trim());
    // Resolve prefix (or use root if empty)
    const parent = prefix
      ? resolvePath(obj, prefix)
      : { found: true as const, value: obj };
    if (!parent.found) return parent;
    if (parent.value == null || typeof parent.value !== "object") {
      return { found: false };
    }
    const src = parent.value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of picks) {
      // Support nested picks: {stats.pnl} traverses into the picked parent
      if (key.includes(".")) {
        const r = resolvePath(src, key);
        if (r.found) result[key] = r.value;
      } else {
        const idx = /^\d+$/.test(key) ? Number(key) : undefined;
        const val = idx !== undefined && Array.isArray(src)
          ? src[idx]
          : src[key];
        if (val !== undefined) result[key] = val;
      }
    }
    return { found: true, value: result };
  }

  const segments = path.split(".");
  let cur = obj;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object") return { found: false };
    const idx = /^\d+$/.test(seg) ? Number(seg) : undefined;
    if (idx !== undefined && Array.isArray(cur)) {
      cur = cur[idx];
    } else {
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (cur === undefined) return { found: false };
  }
  return { found: true, value: cur };
}

/** Parse "key=val" pairs → object, auto-parse values */
export function parsePayload(args: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq === -1) {
      result[arg] = true;
      continue;
    }
    const key = arg.slice(0, eq);
    const raw = arg.slice(eq + 1);
    try {
      result[key] = JSON.parse(raw);
    } catch {
      result[key] = raw;
    }
  }
  return result;
}

// ── 3. HTTP client ───────────────────────────────────────────

const FETCH_TIMEOUT = 5000;

function fetchError(e: unknown, port: number): Result {
  if (e instanceof TypeError && String(e).includes("onnect")) {
    return { ok: false, error: `app not running on port ${port}` };
  }
  if (e instanceof DOMException && e.name === "TimeoutError") {
    return { ok: false, error: `timeout connecting to port ${port}` };
  }
  return { ok: false, error: String(e) };
}

/** Returns the plain-HTTP control port: trojanPort (when TLS active) or main port */
export function resolveControlPort(mainPort: number, appId?: string): number {
  const pf = readPid(appId);
  return (pf?.port === mainPort && pf.trojanPort) ? pf.trojanPort : mainPort;
}

async function trojanGet(
  port: number,
  route: string,
  appId?: string,
  timeout = FETCH_TIMEOUT,
): Promise<Result> {
  const ctrl = resolveControlPort(port, appId);
  try {
    const resp = await fetch(`http://127.0.0.1:${ctrl}/__aio/trojan/${route}`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) {
      const body = await resp.text();
      try {
        return { ok: false, error: JSON.parse(body).error ?? body };
      } catch {
        return { ok: false, error: body };
      }
    }
    return { ok: true, data: await resp.json() };
  } catch (e) {
    return fetchError(e, ctrl);
  }
}

async function trojanPost(
  port: number,
  route: string,
  body?: unknown,
  appId?: string,
): Promise<Result> {
  const ctrl = resolveControlPort(port, appId);
  try {
    const resp = await fetch(`http://127.0.0.1:${ctrl}/__aio/trojan/${route}`, {
      method: "POST",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        "X-AIO": "1",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) {
      const text = await resp.text();
      try {
        return { ok: false, error: JSON.parse(text).error ?? text };
      } catch {
        return { ok: false, error: text };
      }
    }
    return { ok: true, data: await resp.json() };
  } catch (e) {
    return fetchError(e, ctrl);
  }
}

async function httpGet(
  port: number,
  path: string,
  appId?: string,
): Promise<Result<string>> {
  const ctrl = resolveControlPort(port, appId);
  try {
    const resp = await fetch(`http://127.0.0.1:${ctrl}${path}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) {
      return { ok: false, error: `${resp.status} ${await resp.text()}` };
    }
    return { ok: true, data: await resp.text() };
  } catch (e) {
    return fetchError(e, ctrl) as Result<string>;
  }
}

// ── 4. Command handlers ──────────────────────────────────────

// Singleton enforcement

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
    await new Promise((r) => setTimeout(r, KILL_POLL_MS));
  }
  if (isProcessAlive(pid)) {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* ok */ }
    await new Promise((r) => setTimeout(r, KILL_REAP_MS));
  }
}

/** Ensure no other instance of this app is running. Kills zombies, waits for stopping. */
async function ensureSingleton(appId: string, mode: OutputMode): Promise<void> {
  const pf = readPid(appId);
  if (!pf) return;

  // Stale lock — process already dead
  if (!isProcessAlive(pf.pid)) {
    removePid(appId);
    return;
  }

  // Process alive — behavior depends on status
  if (pf.status === "stopping") {
    // Already shutting down — wait up to 3s, then force kill
    out(
      mode === "pretty"
        ? `waiting for instance to stop (pid ${pf.pid})…`
        : { waiting: pf.pid, status: "stopping" },
      mode,
    );
    const deadline = Date.now() + SINGLETON_WAIT_MS;
    while (Date.now() < deadline && isProcessAlive(pf.pid)) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (isProcessAlive(pf.pid)) {
      await killProcess(pf.pid, 0); // already waited, go straight to SIGKILL
    }
    removePid(appId);
    return;
  }

  if (pf.status === "starting") {
    // Check if it's actually responding (auto-heal to 'started')
    let responds = false;
    try {
      const r = await fetch(`http://127.0.0.1:${pf.trojanPort ?? pf.port}/`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      await r.body?.cancel();
      responds = r.ok;
    } catch { /* not yet */ }
    if (responds) {
      // It's actually started — refuse
      outError(`already running (pid ${pf.pid}, port ${pf.port})`, mode);
      Deno.exit(1);
    }
    // Not responding — stuck process, kill it and clean up
    out(
      mode === "pretty"
        ? `killing stuck instance (pid ${pf.pid}, status: starting)…`
        : { killing: pf.pid, reason: "stuck-starting" },
      mode,
    );
    await killProcess(pf.pid);
    removePid(appId);
    return;
  }

  // status='started' — verify it's actually responding
  let responds = false;
  try {
    const r = await fetch(`http://127.0.0.1:${pf.trojanPort ?? pf.port}/`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    await r.body?.cancel();
    responds = r.ok;
  } catch { /* not responding */ }

  if (responds) {
    outError(`already running (pid ${pf.pid}, port ${pf.port})`, mode);
    Deno.exit(1);
  }

  // Marked 'started' but not responding — zombie, kill it
  out(
    mode === "pretty"
      ? `killing non-responsive instance (pid ${pf.pid})…`
      : { killing: pf.pid, reason: "unresponsive" },
    mode,
  );
  await killProcess(pf.pid);
  removePid(appId);
}

// Process management

async function cmdStart(args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolveAmPort(flags.port);

  // Clean up stuck/zombie instances before acquiring lock
  await ensureSingleton(appId, mode);

  // Single-instance enforcement via AppLock
  const lock = new AppLock(appId);
  const result = await lock.acquire(port);
  if (!result.ok) {
    const ex = result.existing;
    outError(
      `already running: ${ex.appId} (pid ${ex.pid}, port ${ex.port})`,
      mode,
    );
    Deno.exit(1);
  }

  // Pre-check: is the target port already taken?
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(QUICK_TIMEOUT_MS),
    });
    await resp.body?.cancel();
    // Something is listening — check if it's an aio app
    let trojan: Result;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/config`, {
        signal: AbortSignal.timeout(QUICK_TIMEOUT_MS),
      });
      trojan = r.ok
        ? { ok: true, data: await r.json() }
        : { ok: false, error: "" };
    } catch {
      trojan = { ok: false, error: "" };
    }
    if (trojan.ok) {
      const cfg = trojan.data as { title?: string };
      outError(
        `port ${port} in use by aio app "${
          cfg.title ?? "?"
        }" — stop it first or use --port=N`,
        mode,
      );
    } else {
      outError(`port ${port} in use by another process — use --port=N`, mode);
    }
    Deno.exit(1);
  } catch { /* port free — good */ }

  // Resolve entry point — --entry flag > deno.json "entry" > src/app.ts > src/main.ts
  const entry = resolveEntry(flags.entry);
  if (!entry) {
    outError(
      flags.entry
        ? `entry not found: ${flags.entry}`
        : 'no src/app.ts found — add "entry" to deno.json or use --entry=<path>',
      mode,
    );
    Deno.exit(1);
  }

  // Pass through any extra args (--port, --verbose, --transport, etc.)
  // Re-inject --port if it was consumed by global flag parser
  const passthrough = args.filter((a) => a.startsWith("--"));
  if (flags.port && !passthrough.some((a) => a.startsWith("--port="))) {
    passthrough.push(`--port=${flags.port}`);
  }
  if (
    flags.transport && !passthrough.some((a) => a.startsWith("--transport="))
  ) {
    passthrough.push(`--transport=${flags.transport}`);
  }
  const denoArgs = ["run", "-A", "--unstable-kv", entry, ...passthrough];

  // nohup + background: child survives parent exit (immune to SIGHUP).
  // `exec` alone keeps child in parent session — gets killed when am exits.
  // Capture real PID via $! on stdout.
  const esc = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const cmd = `nohup deno ${denoArgs.map(esc).join(" ")} >${
    esc(LOG_FILE)
  } 2>&1 & echo $!`;
  const proc = new Deno.Command("sh", {
    args: ["-c", cmd],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();

  const output = await proc.output();
  const childPid = parseInt(new TextDecoder().decode(output.stdout).trim(), 10);
  const pid = Number.isFinite(childPid) ? childPid : proc.pid;

  // The app's _run() will create its own lock file. Release am's temporary lock.
  lock.release();

  // Write a lock for the child (will be overwritten by the child's _run() with full data)
  const lockData: LockData = {
    appId,
    pid,
    port,
    startedAt: Date.now(),
    status: "starting",
    cwd: Deno.cwd(),
  };
  writeLock(lockData);

  // Without --wait: return immediately, user checks with `am status`
  if (flags.wait === undefined) {
    out(
      mode === "pretty"
        ? `starting ${appId} (pid ${pid}, port ${port})`
        : { appId, pid, port, status: "starting" },
      mode,
    );
    return;
  }

  // With --wait: probe health until started or timeout
  const timeout = (flags.wait || 10) * 1000;
  let healthy = false;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (!isProcessAlive(pid)) break; // died early
    try {
      const ctrlPort = resolveControlPort(port, appId);
      const resp = await fetch(`http://127.0.0.1:${ctrlPort}/`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      await resp.body?.cancel();
      if (resp.ok) {
        healthy = true;
        break;
      }
    } catch { /* not ready yet */ }
  }

  if (healthy) {
    // Child's _run() should have updated the lock by now
    const updated = readPid(appId);
    if (updated && updated.status !== "started") {
      writeLock({ ...updated, status: "started" });
    }
    out(
      mode === "pretty"
        ? `started ${appId} (pid ${pid}, port ${port})`
        : { appId, pid, port, status: "started" },
      mode,
    );
  } else if (!isProcessAlive(pid)) {
    removePid(appId);
    let reason = "";
    try {
      const log = Deno.readTextFileSync(LOG_FILE);
      const lines = log.split("\n");
      const errLine = lines.findLast((l) =>
        l.includes("Error:") || l.includes("[ERROR]")
      );
      if (errLine) {
        reason = errLine
          // deno-lint-ignore no-control-regex
          .replace(/\x1b\[[0-9;]*m/g, "") // strip ANSI
          .replace(/^error:\s*(Uncaught\s*(\(in promise\)\s*)?)?/i, "") // strip Deno wrapper
          .trim();
      }
    } catch { /* no log */ }
    outError(reason || `process crashed — check ${LOG_FILE}`, mode);
    Deno.exit(1);
  } else {
    // Timed out but process alive — leave lock at 'starting'
    outError(
      `not responding on port ${port} after ${
        timeout / 1000
      }s — check am status`,
      mode,
    );
    Deno.exit(1);
  }
}

async function cmdStop(_args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const pf = readPid(appId);
  const port = flags.port ?? pf?.port ?? DEFAULT_PORT;

  // Safety: only send shutdown if we have a lock file or explicit --port
  if (!pf && !flags.port) {
    outError(
      "app not running (no lock file) — use --port=N to target a specific port",
      mode,
    );
    Deno.exit(1);
  }

  // Mark as stopping
  if (pf) writeLock({ ...pf, status: "stopping" });

  // Try graceful shutdown via trojan API, fall back to SIGTERM
  const result = await trojanPost(port, "shutdown", undefined, appId);
  if (!result.ok && pf && isProcessAlive(pf.pid)) {
    try {
      Deno.kill(pf.pid, "SIGTERM");
    } catch { /* already dead */ }
  } else if (!result.ok) {
    outError("app not running", mode);
    Deno.exit(1);
  }

  // Without --wait: return immediately, user checks with `am status`
  if (flags.wait === undefined) {
    out(
      mode === "pretty"
        ? `stopping ${appId} (pid ${pf?.pid ?? "?"}, port ${port})`
        : { appId, status: "stopping", pid: pf?.pid, port },
      mode,
    );
    return;
  }

  // With --wait: poll until dead, then force kill if needed
  const timeout = (flags.wait || 5) * 1000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pf && !isProcessAlive(pf.pid)) break;
    try {
      const ctrlPort = resolveControlPort(port, appId);
      const resp = await fetch(`http://127.0.0.1:${ctrlPort}/`, {
        signal: AbortSignal.timeout(QUICK_TIMEOUT_MS),
      });
      await resp.body?.cancel();
    } catch {
      break;
    } // connection refused = dead
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Graceful timeout expired — escalate to SIGKILL
  if (pf && isProcessAlive(pf.pid)) {
    await killProcess(pf.pid, 0); // already waited gracefully
  }
  removePid(appId);
  out(
    mode === "pretty" ? `stopped ${appId}` : { appId, status: "stopped" },
    mode,
  );
}

async function cmdRestart(args: string[], flags: GlobalFlags): Promise<void> {
  const appId = resolveAmAppId(flags.app);
  const pf = readPid(appId);
  if (pf && isProcessAlive(pf.pid)) {
    const port = pf.port;
    // Stop must complete before start — force --wait internally
    const stopFlags = { ...flags, quiet: true, wait: flags.wait ?? 5 };
    await cmdStop([], stopFlags);
    // Wait until port is free
    const deadline = Date.now() + SINGLETON_WAIT_MS;
    while (Date.now() < deadline) {
      try {
        const ctrlPort = resolveControlPort(port, appId);
        const r = await fetch(`http://127.0.0.1:${ctrlPort}/`, {
          signal: AbortSignal.timeout(STOP_CHECK_TIMEOUT_MS),
        });
        await r.body?.cancel();
        await new Promise((r) => setTimeout(r, KILL_POLL_MS));
      } catch {
        break;
      } // connection refused = port free
    }
  }
  await cmdStart(args, flags);
}

async function cmdWatch(args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const watchDir = args[0] ?? "src";
  out(
    mode === "pretty"
      ? `watching ${watchDir}/ for changes…`
      : { watching: watchDir },
    mode,
  );

  // Start initially if not already running
  if (!readPid(appId)) await cmdStart([], flags);

  // Auto-restart disabled — server.ts handles UI live reload (.tsx/.css/.html/.svg)
  // via WebSocket without killing the process. Backend .ts changes require manual restart.
  // Keep the process alive so the initial cmdStart above isn't orphaned.
  await new Promise(() => {});
}

async function cmdStatus(_args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const pf = readPid(appId);

  // No lock file → stopped
  if (!pf) {
    out(
      mode === "pretty" ? `${appId}: stopped` : { appId, status: "stopped" },
      mode,
    );
    Deno.exit(1);
  }

  const alive = isProcessAlive(pf.pid);

  // Lock file exists but process dead → stale, clean up
  if (!alive) {
    removePid(appId);
    out(
      mode === "pretty" ? `${appId}: stopped` : { appId, status: "stopped" },
      mode,
    );
    Deno.exit(1);
  }

  // Process alive + stopping → report stopping (exit 2 = transitional, not error)
  if (pf.status === "stopping") {
    out(
      mode === "pretty"
        ? `${appId}: stopping (pid ${pf.pid}, port ${pf.port})`
        : { appId, status: "stopping", pid: pf.pid, port: pf.port },
      mode,
    );
    Deno.exit(2);
  }

  // Process alive — probe control port to distinguish starting vs started
  const port = pf.port;
  const ctrlPort = pf.trojanPort ?? pf.port;
  let portResponds = false;
  try {
    const resp = await fetch(`http://127.0.0.1:${ctrlPort}/`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    await resp.body?.cancel();
    portResponds = resp.ok;
  } catch { /* not responding */ }

  if (portResponds) {
    // Port responds → started (auto-fix lock if stuck at 'starting')
    if (pf.status !== "started") writeLock({ ...pf, status: "started" });
    const metrics = await trojanGet(port, "metrics", appId);
    const transport = pf.socketPath ? "uds" : "ws";
    if (metrics.ok) {
      const m = metrics.data as {
        uptime: number;
        connections: number;
        schedules: number;
      };
      if (mode === "pretty") {
        const uds = pf.socketPath ? `, transport uds (${pf.socketPath})` : "";
        out(
          `${appId}: started (pid ${pf.pid}, port ${port}, uptime ${
            formatUptime(m.uptime)
          }, ${m.connections} connections${uds})`,
          mode,
        );
      } else {
        out({
          appId,
          status: "started",
          pid: pf.pid,
          port,
          transport,
          ...(pf.socketPath ? { socketPath: pf.socketPath } : {}),
          ...m,
        }, mode);
      }
    } else {
      if (mode === "pretty") {
        const uds = pf.socketPath ? `, transport uds (${pf.socketPath})` : "";
        out(`${appId}: started (pid ${pf.pid}, port ${port}${uds})`, mode);
      } else {
        out({
          appId,
          status: "started",
          pid: pf.pid,
          port,
          transport,
          ...(pf.socketPath ? { socketPath: pf.socketPath } : {}),
        }, mode);
      }
    }
  } else {
    // Port not responding but process alive → starting (exit 2 = transitional, not error)
    out(
      mode === "pretty"
        ? `${appId}: starting (pid ${pf.pid}, port ${port})`
        : { appId, status: "starting", pid: pf.pid, port },
      mode,
    );
    Deno.exit(2);
  }
}

// ── instances command ────────────────────────────────────────

function cmdInstances(_args: string[], flags: GlobalFlags): void {
  const mode = detectMode(flags);
  const all = instances();

  if (all.length === 0) {
    out(mode === "pretty" ? "no running aio instances" : [], mode);
    return;
  }

  if (mode === "pretty") {
    for (const inst of all) {
      const transport = inst.socketPath ? "uds" : "ws";
      const uptime = formatUptime(
        Math.round((Date.now() - inst.startedAt) / 1000),
      );
      const uds = inst.socketPath ? ` (${inst.socketPath})` : "";
      console.log(
        `${inst.appId}  pid=${inst.pid}  port=${inst.port}  ${inst.status}  ${transport}${uds}  uptime=${uptime}  cwd=${inst.cwd}`,
      );
    }
  } else {
    out(
      all.map((inst) => ({
        appId: inst.appId,
        pid: inst.pid,
        port: inst.port,
        status: inst.status,
        transport: inst.socketPath ? "uds" : "ws",
        ...(inst.socketPath ? { socketPath: inst.socketPath } : {}),
        uptime: Math.round((Date.now() - inst.startedAt) / 1000),
        cwd: inst.cwd,
      })),
      mode,
    );
  }
}

// State

async function cmdState(args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const path = args[0];

  const fetchAndResolve = async (
    silent = false,
  ): Promise<{ ok: true; data: unknown } | { ok: false }> => {
    const result = await trojanGet(port, "state", appId);
    if (!result.ok) {
      if (!silent) outError(result.error, mode);
      return { ok: false };
    }
    if (!path) return { ok: true, data: result.data };
    const r = resolvePath(result.data, path);
    if (!r.found) {
      if (!silent) {
        const keys = result.data && typeof result.data === "object"
          ? Object.keys(result.data as Record<string, unknown>)
          : [];
        const hint = keys.length ? ` (available: ${keys.join(", ")})` : "";
        outError(`path "${path}" not found in state${hint}`, mode);
      }
      return { ok: false };
    }
    return { ok: true, data: r.value };
  };

  // Single shot (no --wait)
  if (flags.wait === undefined) {
    const r = await fetchAndResolve();
    if (!r.ok) Deno.exit(1);
    out(r.data, mode);
    return;
  }

  // Watch mode: --wait=N polls every N seconds (bare --wait defaults to 2s)
  const interval = (flags.wait || 2) * 1000;
  let lastOk = true;
  while (true) {
    const r = await fetchAndResolve(!lastOk); // suppress repeated errors
    if (!r.ok) {
      if (lastOk) lastOk = false; // first error already printed by fetchAndResolve
      await new Promise((r) => setTimeout(r, interval));
      continue;
    }
    lastOk = true;
    out(r.data, mode);
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function cmdUi(args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const clientIdx = flags.client ?? 0;

  // If first arg looks like a user ID (no --client flag), use server-state UI
  const user = args[0];
  if (user && flags.client === undefined) {
    const route = user ? `ui?user=${encodeURIComponent(user)}` : "ui";
    const result = await trojanGet(port, route, appId);
    if (!result.ok) {
      outError(result.error, mode);
      Deno.exit(1);
    }
    out(result.data, mode);
    return;
  }

  // DOM snapshot from client
  const allParam = flags.all ? "?all=true" : "";
  const result = await trojanGet(
    port,
    `dom/${clientIdx}${allParam}`,
    appId,
    10_000,
  );
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }

  if (mode === "pretty" && Array.isArray(result.data)) {
    _prettyPrintTree(result.data as Record<string, unknown>[], 0);
  } else {
    out(result.data, mode);
  }
}

function _prettyPrintTree(
  nodes: Record<string, unknown>[],
  indent: number,
): void {
  for (const n of nodes) {
    const tag = n.tag as string;
    const id = n.id ? `#${n.id}` : "";
    const cls = (n.classes as string[])?.map((c) => `.${c}`).join("") ?? "";
    const comp = n.component ? ` [${n.component}]` : "";
    const testId = n.testId ? ` [test:${n.testId}]` : "";
    const text = n.text ? ` "${(n.text as string).slice(0, 60)}"` : "";
    const disabled = n.disabled ? " (disabled)" : "";
    const pad = "  ".repeat(indent);
    console.log(`${pad}${tag}${id}${cls}${comp}${testId}${text}${disabled}`);
    if (n.children && Array.isArray(n.children)) {
      _prettyPrintTree(n.children as Record<string, unknown>[], indent + 1);
    }
  }
}

// Actions

async function cmdDispatch(args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);

  let action: unknown;
  if (flags.jsonBody) {
    // --body='{"type":"Increment","payload":{"by":1}}'
    try {
      action = JSON.parse(flags.jsonBody);
    } catch {
      outError("invalid --body JSON", mode);
      Deno.exit(1);
    }
  } else if (args.length === 0) {
    outError(
      "usage: am dispatch <Type> [key=val ...] or am dispatch --body='{\"type\":...}'",
      mode,
    );
    Deno.exit(1);
  } else {
    const type = args[0];
    if (args.length <= 1) {
      action = { type };
    } else {
      const rest = args.slice(1);
      // If any arg has '=' → action-style named payload: { key: val }
      // Otherwise → method-style positional args: { args: [...] }
      const hasNamedArgs = rest.some((a) => a.includes("="));
      if (hasNamedArgs) {
        action = { type, payload: parsePayload(rest) };
      } else {
        // Parse each positional arg as JSON if possible, else string
        const parsed = rest.map((a) => {
          try {
            return JSON.parse(a);
          } catch {
            return a;
          }
        });
        action = { type, payload: { args: parsed } };
      }
    }
  }

  const result = await trojanPost(port, "dispatch", action, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(mode === "pretty" ? "dispatched" : result.data, mode);
}

async function cmdActions(_args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const result = await trojanGet(port, "history", appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

// Time-travel

async function cmdTT(args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const cmd = args[0];
  if (!cmd) {
    outError("usage: am tt <undo|redo|goto N|pause|resume>", mode);
    Deno.exit(1);
  }
  const arg = cmd === "goto" ? Number(args[1]) : undefined;
  if (cmd === "goto" && (arg === undefined || isNaN(arg))) {
    outError("usage: am tt goto <index>", mode);
    Deno.exit(1);
  }
  const result = await trojanPost(port, "tt", { cmd, arg }, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(
    mode === "pretty"
      ? `tt: ${cmd}${arg !== undefined ? " " + arg : ""}`
      : result.data,
    mode,
  );
}

// Persistence

async function cmdPersist(_args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const result = await trojanPost(port, "persist", undefined, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(mode === "pretty" ? "persisted" : result.data, mode);
}

async function cmdSnapshot(args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const sub = args[0];

  if (!sub) {
    // GET snapshot to stdout
    const result = await httpGet(port, "/__aio/snapshot", appId);
    if (!result.ok) {
      outError(result.error, mode);
      Deno.exit(1);
    }
    console.log(result.data);
    return;
  }

  if (sub === "save") {
    const file = args[1] ?? "snapshot.json";
    const result = await httpGet(port, "/__aio/snapshot", appId);
    if (!result.ok) {
      outError(result.error, mode);
      Deno.exit(1);
    }
    Deno.writeTextFileSync(file, result.data as string);
    out(
      mode === "pretty" ? `saved to ${file}` : { file, status: "saved" },
      mode,
    );
    return;
  }

  if (sub === "load") {
    const file = args[1];
    if (!file) {
      outError("usage: am snapshot load <file>", mode);
      Deno.exit(1);
    }
    let json: string;
    try {
      json = Deno.readTextFileSync(file);
    } catch {
      outError(`can't read ${file}`, mode);
      Deno.exit(1);
      return;
    }
    const result = await trojanPost(port, "snapshot", JSON.parse(json), appId);
    if (!result.ok) {
      outError(result.error, mode);
      Deno.exit(1);
    }
    out(
      mode === "pretty" ? `loaded from ${file}` : { file, status: "loaded" },
      mode,
    );
    return;
  }

  outError("usage: am snapshot [save <file>|load <file>]", mode);
  Deno.exit(1);
}

// Inspection

async function cmdClients(_args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const result = await trojanGet(port, "clients", appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

async function cmdClient(args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const idx = args[0];
  if (idx === undefined) {
    outError(
      "usage: am client <index> — request client-side state (dev mode)",
      mode,
    );
    Deno.exit(1);
  }
  const result = await trojanGet(port, `client/${idx}`, appId, 10_000);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

async function cmdClick(args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const clientIdx = args[0];
  const componentName = args[1];
  const targetArg = args[2]; // index (e.g. "0") or prop:value (e.g. 'title:Settings')

  if (!clientIdx || !componentName) {
    outError(
      "usage: am click <clientIndex> <Component> [index | prop:value]",
      mode,
    );
    Deno.exit(1);
  }

  // Build target string: "ComponentName:index" or "ComponentName:prop:value"
  let target = componentName;
  if (targetArg !== undefined) {
    target += ":" + targetArg;
  }

  const result = await trojanGet(
    port,
    `click/${clientIdx}/${encodeURIComponent(target)}`,
    appId,
    10_000,
  );
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

async function cmdSql(args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const query = args.join(" ");
  if (!query) {
    outError("usage: am sql <query>", mode);
    Deno.exit(1);
  }
  const result = await trojanPost(port, "sql", { query }, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

async function cmdTables(_args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const result = await trojanPost(port, "sql", {
    query: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  }, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  const rows = result.data as { name: string }[];
  if (mode === "pretty") {
    if (rows.length === 0) console.log("no tables");
    else rows.forEach((r) => console.log(r.name));
  } else {
    out(rows.map((r) => r.name), mode);
  }
}

async function cmdSchedules(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const result = await trojanGet(port, "schedules", appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

async function cmdLog(args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);

  // --client flag: tail log/client.log instead of .aio.log
  if (flags.client !== undefined) {
    await _tailClientLog(flags);
    return;
  }

  const filter = args[0] ?? flags.filter;
  const n = flags.lines ?? 50;
  const follow = flags.follow ?? false;

  // Print current tail
  let offset = 0;
  try {
    const content = Deno.readTextFileSync(LOG_FILE);
    let lines = content.split("\n");
    if (filter) {
      const lc = filter.toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(lc));
    }
    const tail = lines.slice(-n);
    if (mode === "json") {
      // deno-lint-ignore no-control-regex
      const clean = tail.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
      out({
        total: lines.length,
        shown: clean.length,
        filter: filter ?? null,
        lines: clean,
      }, mode);
    } else console.log(tail.join("\n"));
    offset = Deno.statSync(LOG_FILE).size;
  } catch {
    if (!follow) {
      outError("no log file found", mode);
      return;
    }
  }

  if (!follow) return;

  // --follow / -f: stream new bytes as they arrive (like tail -f)
  const enc = new TextEncoder();
  const watcher = Deno.watchFs(LOG_FILE);
  let buf = "";
  for await (const event of watcher) {
    if (event.kind !== "modify" && event.kind !== "create") continue;
    try {
      // AIO-214: detect log rotation — reset offset if file shrunk
      const stat = await Deno.stat(LOG_FILE);
      if (stat.size < offset) offset = 0;
      // AIO-213: use try/finally to ensure file handle is always closed
      const file = await Deno.open(LOG_FILE, { read: true });
      try {
        await file.seek(offset, Deno.SeekMode.Start);
        const chunk = new Uint8Array(65536);
        let bytesRead: number | null;
        while ((bytesRead = await file.read(chunk)) !== null) {
          const text = new TextDecoder().decode(chunk.subarray(0, bytesRead));
          offset += bytesRead;
          buf += text;
          // Output complete lines; buffer partial last line
          const newline = buf.lastIndexOf("\n");
          if (newline === -1) continue;
          const toWrite = buf.slice(0, newline + 1);
          buf = buf.slice(newline + 1);
          const filtered = filter
            ? toWrite.split("\n").filter((l) =>
              l.toLowerCase().includes(filter.toLowerCase())
            ).join("\n") + "\n"
            : toWrite;
          if (filtered.trim()) await Deno.stdout.write(enc.encode(filtered));
        }
      } finally {
        file.close();
      }
    } catch { /* file rotated or removed */ }
  }
}

async function _tailClientLog(flags: GlobalFlags): Promise<void> {
  const n = flags.lines ?? 50;
  const follow = flags.follow ?? false;
  const filter = flags.filter;
  const logPath = "log/client.log";

  try {
    const content = await Deno.readTextFile(logPath);
    let lines = content.split("\n").filter(Boolean);
    if (filter) {
      const lc = filter.toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(lc));
    }
    const tail = lines.slice(-n);
    for (const line of tail) console.log(line);

    if (!follow) return;

    // Follow mode — poll for new content
    let offset = (await Deno.stat(logPath)).size;
    const poll = async () => {
      try {
        const stat = await Deno.stat(logPath);
        if (stat.size > offset) {
          const f = await Deno.open(logPath, { read: true });
          try {
            await f.seek(offset, Deno.SeekMode.Start);
            const buf = new Uint8Array(stat.size - offset);
            await f.read(buf);
            const newContent = new TextDecoder().decode(buf);
            const newLines = newContent.split("\n").filter(Boolean);
            for (const line of newLines) {
              if (
                !filter || line.toLowerCase().includes(filter.toLowerCase())
              ) {
                console.log(line);
              }
            }
          } finally {
            f.close();
          }
          offset = stat.size;
        }
      } catch { /* file may not exist yet */ }
    };
    setInterval(poll, 500);
    await new Promise(() => {});
  } catch {
    console.log("(no client log yet)");
    if (follow) {
      // Wait for file to appear, then start tailing
      let offset = 0;
      const poll = async () => {
        try {
          const stat = await Deno.stat(logPath);
          if (stat.size > offset) {
            const f = await Deno.open(logPath, { read: true });
            try {
              await f.seek(offset, Deno.SeekMode.Start);
              const buf = new Uint8Array(stat.size - offset);
              await f.read(buf);
              const text = new TextDecoder().decode(buf);
              const newLines = text.split("\n").filter(Boolean);
              for (const line of newLines) {
                if (
                  !filter || line.toLowerCase().includes(filter!.toLowerCase())
                ) {
                  console.log(line);
                }
              }
            } finally {
              f.close();
            }
            offset = stat.size;
          }
        } catch { /* not yet */ }
      };
      setInterval(poll, 1000);
      await new Promise(() => {});
    }
  }
}

async function cmdErrors(_args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const result = await httpGet(port, "/__aio/error", appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  const text = (result.data as string).trim();
  // Server returns JSON { errors: [...] } or null/empty when no errors
  let errors: string[] = [];
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.errors)) errors = parsed.errors;
    else if (parsed === null) errors = [];
    else errors = [text]; // legacy: plain text error
  } catch {
    if (text) errors = [text]; // plain text fallback
  }
  if (errors.length === 0) {
    out(mode === "pretty" ? "no errors" : { errors: [] }, mode);
  } else {
    out(mode === "pretty" ? errors.join("\n") : { errors }, mode);
  }
}

async function cmdMetrics(_args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const result = await trojanGet(port, "metrics", appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  const m = result.data as {
    uptime: number;
    connections: number;
    schedules: number;
  };
  if (mode === "pretty") {
    out(
      `uptime: ${
        formatUptime(m.uptime)
      }\nconnections: ${m.connections}\nschedules: ${m.schedules}`,
      mode,
    );
  } else {
    out(m, mode);
  }
}

async function cmdHealth(_args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const ctrlPort = resolveControlPort(port, appId);
  try {
    const resp = await fetch(`http://127.0.0.1:${ctrlPort}/`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    await resp.body?.cancel();
    out(
      mode === "pretty"
        ? `healthy (${resp.status})`
        : { healthy: true, status: resp.status },
      mode,
    );
  } catch {
    out(mode === "pretty" ? "unreachable" : { healthy: false }, mode);
    Deno.exit(1);
  }
}

async function cmdConfig(_args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const result = await trojanGet(port, "config", appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

function cmdVersion(_args: string[], flags: GlobalFlags): void {
  const mode = detectMode(flags);
  out(mode === "pretty" ? `am ${VERSION}` : { version: VERSION }, mode);
}

async function cmdNew(args: string[], flags: GlobalFlags): Promise<void> {
  const kind = args[0];
  const name = args[1];
  const mode = detectMode(flags);

  if (!kind || !name) {
    outError("usage: am new <feature|page> <name>", mode);
    return;
  }

  if (kind === "feature") {
    const dir = `src/features/${name}`;
    const file = `${dir}/index.ts`;
    try {
      await Deno.stat(file);
      outError(`${file} already exists`, mode);
      return;
    } catch { /* ok */ }
    await Deno.mkdir(dir, { recursive: true });
    const content = `import { feature } from 'aio'

export const ${name} = feature('${name}', {
  state: {},
  methods: {
  },
})
`;
    await Deno.writeTextFile(file, content);
    out(flags.json ? { created: file } : `created ${file}`, mode);
  } else if (kind === "page") {
    const pascal = name.charAt(0).toUpperCase() + name.slice(1);
    const dir = "src/pages";
    const file = `${dir}/${pascal}.tsx`;
    try {
      await Deno.stat(file);
      outError(`${file} already exists`, mode);
      return;
    } catch { /* ok */ }
    await Deno.mkdir(dir, { recursive: true });
    const content = `import { useAio } from 'aio'

export function ${pascal}() {
  const { state } = useAio()
  if (!state) return <div>Loading\u2026</div>

  return (
    <div>
      <h1>${pascal}</h1>
    </div>
  )
}
`;
    await Deno.writeTextFile(file, content);
    out(flags.json ? { created: file } : `created ${file}`, mode);
  } else {
    outError(
      `unknown scaffold type: '${kind}' — use 'feature' or 'page'`,
      mode,
    );
  }
}

function cmdHelp(_args: string[], flags: GlobalFlags): void {
  if (flags.json) {
    out({ commands: Object.keys(COMMANDS) }, "json");
    return;
  }
  console.log(`am ${VERSION} — aio manager

Process (singleton — one instance per app identity):
  start                   Start app (kills zombies, refuses if already running)
  stop                    Graceful shutdown (SIGTERM → SIGKILL)
  restart                 Stop + start
  watch [dir]             Hot-restart on .ts/.tsx change in dir (default: src/)
  status                  stopped|starting|started|stopping (exit 0=started, 1=stopped, 2=transitional)
  instances               List all running aio apps on this machine

State:
  state [path] [--wait=N] State query (dot-path, [*] wildcard, {pick})
  ui [user]               UI state (server) or DOM snapshot (--client=N)
  dispatch <Type> [k=v]   Dispatch action (or --body='{"type":...}')
  actions                 Time-travel history

Time-travel:
  tt undo|redo            Step back/forward
  tt goto <N>             Jump to index
  tt pause|resume         Freeze/unfreeze state

Persistence:
  persist                 Force immediate persist
  snapshot                Dump state JSON to stdout
  snapshot save [file]    Save snapshot to file
  snapshot load <file>    Load snapshot from file

Inspect:
  clients                 Connected WebSocket clients (with index)
  client <index>          Request React component tree from client (dev mode)
  click <idx> <Comp> [n]  Click component — by index or prop:value (dev mode)
  ui [--client=N] [--all] DOM snapshot from client (default: client 0, visible only)
  interact <action> <sel> Interact with UI element (click/type/select/focus/blur/scroll/hover)
  sql <query>             Execute read-only SQL
  tables                  List SQLite tables
  schedules               Active scheduled effects
  log [filter]            Tail app log (--client for client.log) (--filter --lines --follow)
  errors                  Last build error
  metrics                 Uptime, connections, schedules
  health                  HTTP health check
  config                  Server configuration

Scaffold:
  new feature <name>      Generate src/features/<name>/index.ts
  new page <name>         Generate src/pages/<Name>.tsx

Other:
  version                 Print version
  help                    This message

Flags: --app=X  --port=N  --entry=<path>  --wait[=N]  --json  --quiet  --body='{...}'  --filter=X  --lines=N  --follow/-f  --transport=ws|uds  --client=N/-cN  --all

--app: target specific app by ID (default: resolved from deno.json name)
--entry: override entry point (default: deno.json "entry" > src/app.ts > src/main.ts)
--wait: start/stop block until complete (default 10s/5s). state polls every Ns.`);
}

async function cmdInteract(args: string[], flags: GlobalFlags): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const port = resolvePort(flags.port, appId);
  const clientIdx = flags.client ?? 0;

  const action = args[0];
  const selector = args[1];
  const value = args[2];

  const validActions = new Set([
    "click",
    "type",
    "select",
    "focus",
    "blur",
    "scroll",
    "hover",
  ]);
  if (!action || !selector || (action && !validActions.has(action))) {
    outError(
      'usage: am interact <action> "<selector>" [value] [--client=N]\n' +
        "actions: click, type, select, focus, blur, scroll, hover",
      mode,
    );
    Deno.exit(1);
  }

  const cmd = {
    action,
    selector,
    ...(value !== undefined ? { value } : {}),
  };

  const result = await trojanPost(port, `interact/${clientIdx}`, cmd, appId);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  out(result.data, mode);
}

// ── 5. Main entry & router ───────────────────────────────────

/** CLI global flags — port, output mode, filtering, and app targeting options. */
export type GlobalFlags = {
  port?: number;
  json?: boolean;
  quiet?: boolean;
  jsonBody?: string;
  filter?: string;
  lines?: number;
  wait?: number;
  follow?: boolean;
  entry?: string;
  transport?: string;
  app?: string;
  client?: number;
  all?: boolean;
};
type CmdHandler = (args: string[], flags: GlobalFlags) => void | Promise<void>;

const COMMANDS: Record<string, CmdHandler> = {
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  status: cmdStatus,
  watch: cmdWatch,
  instances: cmdInstances,
  ls: cmdInstances,
  state: cmdState,
  ui: cmdUi,
  dispatch: cmdDispatch,
  actions: cmdActions,
  tt: cmdTT,
  persist: cmdPersist,
  snapshot: cmdSnapshot,
  clients: cmdClients,
  client: cmdClient,
  click: cmdClick,
  interact: cmdInteract,
  sql: cmdSql,
  tables: cmdTables,
  schedules: cmdSchedules,
  log: cmdLog,
  logs: cmdLog,
  errors: cmdErrors,
  metrics: cmdMetrics,
  health: cmdHealth,
  new: cmdNew,
  config: cmdConfig,
  version: cmdVersion,
  help: cmdHelp,
};

/** Parse CLI arguments into command, positional args, and global flags (--json, --quiet, --port, --app) */
export function parseGlobalFlags(
  raw: string[],
): { command: string; args: string[]; flags: GlobalFlags } {
  const flags: GlobalFlags = {};
  const rest: string[] = [];

  for (const a of raw) {
    if (a === "--json") flags.json = true;
    else if (a === "--quiet") flags.quiet = true;
    else if (a.startsWith("--port=")) {
      const v = Number(a.slice(7));
      flags.port = isNaN(v) ? undefined : v;
    } else if (a.startsWith("--body=")) flags.jsonBody = a.slice(7);
    else if (a.startsWith("--filter=")) flags.filter = a.slice(9);
    else if (a.startsWith("--lines=")) {
      const v = Number(a.slice(8));
      flags.lines = isNaN(v) ? undefined : v;
    } else if (a.startsWith("--wait=")) {
      const v = Number(a.slice(7));
      flags.wait = isNaN(v) ? undefined : v;
    } else if (a === "--wait") flags.wait = 0; // bare --wait = use default
    else if (a === "--follow" || a === "-f") flags.follow = true;
    else if (a.startsWith("--entry=")) flags.entry = a.slice(8);
    else if (a.startsWith("--transport=")) flags.transport = a.slice(12);
    else if (a.startsWith("--app=")) flags.app = a.slice(6);
    else if (a.startsWith("--client=")) {
      const v = Number(a.slice(9));
      flags.client = isNaN(v) ? undefined : v;
    } else if (
      a.startsWith("-c") && a.length > 2 && !isNaN(Number(a.slice(2)))
    ) {
      flags.client = Number(a.slice(2));
    } else if (a === "--client") flags.client = 0;
    else if (a === "--all") flags.all = true;
    else rest.push(a);
  }

  const command = rest[0] ?? "help";
  const args = rest.slice(1);
  return { command, args, flags };
}

async function main(): Promise<void> {
  const { command, args, flags } = parseGlobalFlags(Deno.args);
  const handler = COMMANDS[command];
  if (!handler) {
    outError(
      `unknown command: ${command} — run "am help" for usage`,
      detectMode(flags),
    );
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
