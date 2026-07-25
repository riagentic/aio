/**
 * @module
 * Process management commands for am — start, stop, restart, watch, status, instances.
 */

import type { GlobalFlags } from "./am-types.ts";
import {
  AppLock,
  instances,
  isProcessAlive,
  type LockData,
  readLaunchInfo,
  writeLaunchInfo,
  writeLock,
} from "../server/single-instance-lock.ts";
import { detectMode, formatUptime, out, outError } from "./am-output.ts";
import {
  DEFAULT_PORT,
  readPid,
  removePid,
  resolveAmAppId,
  resolveAmPort,
  resolveEntry,
} from "./am-utils.ts";
import { resolveControlPort, trojanGet, trojanPost } from "./am-http.ts";

// ── Constants ───────────────────────────────────────────────

// Flags Deno consumes itself (must sit BEFORE the entry script), as opposed to
// app flags that follow it. Only `--`-prefixed forms are ever seen here (`am`
// keeps only those); short forms like -c/-r are filtered upstream.
const DENO_RUNTIME_FLAG =
  /^(--env-file|--env|--config|--no-config|--import-map|--importmap|--reload|--no-remote|--cached-only|--lock|--no-lock|--frozen|--cert|--unstable|--unstable-[\w-]+|--v8-flags|--seed|--location|--inspect|--inspect-brk|--inspect-wait|--allow-[\w-]+|--deny-[\w-]+|--no-npm|--node-modules-dir|--vendor)(=|$)/;
const isDenoRuntimeFlag = (a: string): boolean => DENO_RUNTIME_FLAG.test(a);

/** Assemble the `deno run` argv: runtime flags (--env-file, …) BEFORE the entry
 *  script, app flags (--port, …) after it — placement Deno requires. Exported
 *  so the ordering contract is unit-tested (risoto 2026-07-24 Bad #4). */
export function buildDenoArgs(entry: string, passthrough: string[]): string[] {
  const denoFlags = passthrough.filter(isDenoRuntimeFlag);
  const appFlags = passthrough.filter((a) => !isDenoRuntimeFlag(a));
  return ["run", "-A", "--unstable-kv", ...denoFlags, entry, ...appFlags];
}

const LOG_FILE = ".aio.log";
const KILL_GRACE_MS = 2000;
const KILL_POLL_MS = 100;
const KILL_REAP_MS = 300;
const SINGLETON_WAIT_MS = 3000;
const POLL_INTERVAL_MS = 200;
const HEALTH_TIMEOUT_MS = 2000;
const QUICK_TIMEOUT_MS = 1000;
const STOP_CHECK_TIMEOUT_MS = 500;

// ── Singleton enforcement ───────────────────────────────────

/** Kill a process: SIGTERM first, SIGKILL after grace period */
export async function killProcess(
  pid: number,
  grace = KILL_GRACE_MS,
): Promise<void> {
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
export async function ensureSingleton(
  appId: string,
  mode: import("./am-types.ts").OutputMode,
): Promise<void> {
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

// ── Process management commands ─────────────────────────────

export async function cmdStart(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
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
    let trojan: import("./am-types.ts").Result;
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
  // Deno-runtime flags before the entry script; app flags after it (see
  // buildDenoArgs) — a misplaced --env-file is silently ignored by Deno.
  const denoArgs = buildDenoArgs(entry, passthrough);

  // Record the launch so `am restart` can replay it — the running app can't
  // recover deno-runtime flags (esp. --env-file) from its own Deno.args.
  writeLaunchInfo(appId, { flags: passthrough, entry, cwd: Deno.cwd() });

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

export async function cmdStop(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
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

export async function cmdRestart(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const pf = readPid(appId);

  // Preserve the original launch across restart (risoto 2026-07-24 Bad #4:
  // restart dropped --env-file → the vault stopped auto-unlocking). Explicit
  // flags on THIS `am restart` win; otherwise replay what start recorded.
  const explicit = args.filter((a) => a.startsWith("--"));
  const recorded = readLaunchInfo(appId);
  let launchArgs = args;
  if (explicit.length === 0) {
    if (recorded && recorded.flags.length > 0) {
      launchArgs = recorded.flags;
      out(
        mode === "pretty"
          ? `restart: replaying original flags — ${recorded.flags.join(" ")}`
          : { restart: "replay", flags: recorded.flags },
        mode,
      );
    } else if (!recorded) {
      // Started outside am (e.g. `deno task dev`) → we never captured its flags.
      outError(
        `restart can't recover the original launch flags (e.g. --env-file) — ` +
          `this instance wasn't started by \`am start\`. Relaunching with ` +
          `defaults; re-run your original command, or pass the flags to ` +
          `\`am restart …\` to record them.`,
        mode,
      );
    }
  }

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
  await cmdStart(launchArgs, flags);
}

export async function cmdWatch(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
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

export async function cmdStatus(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
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

export function cmdInstances(_args: string[], flags: GlobalFlags): void {
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
