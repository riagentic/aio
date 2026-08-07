/**
 * @module
 * Process management commands for am — start, stop, restart, watch, status, instances.
 */

import { dirname, join } from "@std/path";
import { appDirs } from "../server/app-dirs.ts";
import type { GlobalFlags } from "./am-types.ts";
import {
  AppLock,
  instances,
  isProcessAlive,
  isSocketAlive,
  type LockData,
  lockDir,
  readLaunchInfo,
  resolveAppId,
  writeLaunchInfo,
  writeLock,
} from "../server/single-instance-lock.ts";
import { detectMode, formatUptime, out, outError } from "./am-output.ts";
import {
  readPid,
  removePid,
  resolveAmAppId,
  resolveAmPort,
  resolveEntry,
} from "./am-utils.ts";
import {
  probePort,
  resolveControlPort,
  trojanGet,
  trojanPost,
} from "./am-http.ts";

// ── Constants ───────────────────────────────────────────────

// Flags Deno consumes itself (must sit BEFORE the entry script), as opposed to
// app flags that follow it. Only `--`-prefixed forms are ever seen here (`am`
// keeps only those); short forms like -c/-r are filtered upstream.
const DENO_RUNTIME_FLAG =
  /^(--env-file|--env|--config|--no-config|--import-map|--importmap|--reload|--no-remote|--cached-only|--lock|--no-lock|--frozen|--cert|--unstable|--unstable-[\w-]+|--v8-flags|--seed|--location|--inspect|--inspect-brk|--inspect-wait|--allow-[\w-]+|--deny-[\w-]+|--no-npm|--node-modules-dir|--vendor)(=|$)/;
const isDenoRuntimeFlag = (a: string): boolean => DENO_RUNTIME_FLAG.test(a);

/** Assemble the `deno run` argv: runtime flags (--env-file, …) BEFORE the entry
 *  script, app flags (--port, …) after it — placement Deno requires. Exported
 *  so the ordering contract is unit-tested. */
export function buildDenoArgs(entry: string, passthrough: string[]): string[] {
  const denoFlags = passthrough.filter(isDenoRuntimeFlag);
  const appFlags = passthrough.filter((a) => !isDenoRuntimeFlag(a));
  return ["run", "-A", "--unstable-kv", ...denoFlags, entry, ...appFlags];
}

/** Raw stdout+stderr of an app `am` launched: `~/.<appId>/logs/stdout.log`.
 *
 *  It used to be `<project>/.aio.log`, which split one app's output across two
 *  directories (the framework's own logs already went to the app dir) and left a
 *  stray file in every project. It has to exist because the framework logger
 *  can't capture what it doesn't route: a bare `console.log` in a cell, and the
 *  stack trace of a crash before the logger is up. */
function stdoutLogPath(appId: string): string {
  const path = join(appDirs(appId).logs, "stdout.log");
  try {
    Deno.mkdirSync(dirname(path), { recursive: true });
  } catch { /* exists, or unwritable — the redirect will report it */ }
  return path;
}
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

/** The per-OS command that spawns a DETACHED deno child whose stdout+stderr
 *  land in `logFile` and whose real PID is printed to stdout.
 *
 *  POSIX: `sh -c "nohup deno … >log 2>&1 & echo $!"` — nohup detaches from
 *  the session so the child survives am's exit and terminal close.
 *  Windows: there is no sh/nohup (`am start` used to fail outright) —
 *  PowerShell `Start-Process -PassThru` detaches natively; it cannot merge
 *  the two streams into one file, so stderr goes to `<log>.err`.
 *  Exported pure so both shapes are testable on any OS. */
export function detachedSpawnSpec(
  os: typeof Deno.build.os,
  denoArgs: string[],
  logFile: string,
): { cmd: string; args: string[] } {
  if (os === "windows") {
    const q = (v: string) => "'" + v.replace(/'/g, "''") + "'";
    const ps = `$p = Start-Process -FilePath 'deno' -ArgumentList @(${
      denoArgs.map(q).join(",")
    }) -RedirectStandardOutput ${q(logFile)} -RedirectStandardError ${
      q(logFile + ".err")
    } -PassThru -WindowStyle Hidden; Write-Output $p.Id`;
    return {
      cmd: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", ps],
    };
  }
  const esc = (v: string) => "'" + v.replace(/'/g, "'\\''") + "'";
  return {
    cmd: "sh",
    args: [
      "-c",
      `nohup deno ${denoArgs.map(esc).join(" ")} >${
        esc(logFile)
      } 2>&1 & echo $!`,
    ],
  };
}

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

  // Pass through any extra args (--port, --verbose, --transport, --client
  // etc.). Re-inject --port if it was consumed by the global flag parser.
  const passthrough = args.filter((a) => a.startsWith("--"));
  // A GUI client on a headless box hangs forever (electron never returns) —
  // fail FAST with the fix instead (a field report). The
  // effective client is the --client override, else the app's declared target.
  {
    const clientArg = passthrough.find((a) => a.startsWith("--client="))
      ?.slice(9);
    let effective = clientArg;
    if (!effective) {
      try {
        const dj = JSON.parse(await Deno.readTextFile("deno.json")) as {
          target?: string;
        };
        effective = dj.target;
      } catch { /* no deno.json target — framework default applies */ }
    }
    const gui = effective === "electron" || effective === "client";
    const headless = Deno.build.os === "linux" &&
      !Deno.env.get("DISPLAY") && !Deno.env.get("WAYLAND_DISPLAY");
    if (gui && headless) {
      outError(
        `client "${effective}" needs a display and this box has none ` +
          `(no DISPLAY/WAYLAND_DISPLAY) — electron would hang forever. ` +
          `Use: am start --client=browser (or --client=server-only)`,
        mode,
      );
      Deno.exit(1);
    }
  }
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

  // Detached background spawn — the child must survive am's exit, its output
  // must land in the log file, and its real PID must come back on stdout. The
  // HOW is per-OS (sh/nohup does not exist on Windows — am start used to fail
  // there outright); detachedSpawnSpec builds the right command for each.
  const logFile = stdoutLogPath(appId);
  const spec = detachedSpawnSpec(Deno.build.os, denoArgs, logFile);
  const proc = new Deno.Command(spec.cmd, {
    args: spec.args,
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
      const log = Deno.readTextFileSync(stdoutLogPath(appId));
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
    outError(
      reason || `process crashed — check ${stdoutLogPath(appId)}`,
      mode,
    );
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

/** Where am looked for the lock, and the one env var that decides it.
 *
 *  "app not running (no lock file)" named neither, and `lockDir()` is derived
 *  from XDG_RUNTIME_DIR|/tmp plus an AIO_APPS_DIR-shaped suffix — so two shells
 *  with different AIO_APPS_DIR genuinely search different directories and the
 *  message was true in both while explaining neither. */
export function noLockMessage(appId: string): string {
  const apps = Deno.env.get("AIO_APPS_DIR");
  return `app not running: no lock file for "${appId}"\n` +
    `  searched: ${lockDir()}\n` +
    `  AIO_APPS_DIR=${apps ?? "unset"} (it scopes the lock dir — am and the ` +
    `app must share the same value)\n` +
    `  see what IS running: am instances — or target the app by id ` +
    `(--app=<id>) or by port (--port=N, am reads the id from that port)`;
}

/** Who `am stop` is about to talk to — resolved from the lock file, or, with
 *  `--port=N`, from the port itself. Split out of `cmdStop` so the resolution
 *  (and every refusal message) is testable without the process-exiting shell. */
export type StopTarget = { appId: string; port: number; pf: LockData | null };

export async function resolveStopTarget(
  flags: GlobalFlags,
): Promise<{ ok: true; target: StopTarget } | { ok: false; error: string }> {
  const cwdAppId = resolveAmAppId(flags.app);
  const pf = readPid(cwdAppId);

  // No --port: the lock file is the only decider.
  if (flags.port === undefined) {
    return pf
      ? { ok: true, target: { appId: cwdAppId, port: pf.port, pf } }
      : { ok: false, error: noLockMessage(cwdAppId) };
  }

  // --port that matches our own lock — nothing to discover.
  if (pf && pf.port === flags.port) {
    return { ok: true, target: { appId: cwdAppId, port: flags.port, pf } };
  }

  // `--port=N` IDENTIFIES the app; it never merely overrides the port of a
  // cwd-derived one. In a two-app repo the cwd's deno.json named the OTHER
  // app, so `am stop --port=N` addressed a lock that did not exist, fell back
  // to the main port, and reported the bare "app not running" — while the app
  // on N kept running.
  const probe = await probePort(flags.port);
  switch (probe.kind) {
    case "aio": {
      const wanted = flags.app ? resolveAppId(flags.app) : undefined;
      if (wanted && wanted !== probe.appId) {
        return {
          ok: false,
          error: `port ${flags.port} answers as app "${probe.appId}", not ` +
            `"${wanted}" (--app) — refusing to stop a different app`,
        };
      }
      return {
        ok: true,
        target: {
          appId: probe.appId,
          port: flags.port,
          pf: readPid(probe.appId),
        },
      };
    }
    case "tls":
      return {
        ok: false,
        error: `port ${flags.port} speaks TLS (https) — under --expose the ` +
          `control endpoint is plain HTTP on a SEPARATE port, recorded only ` +
          `in the lock file, so no port on the TLS side can reach it. Target ` +
          `the app by id instead: am stop --app=<id> (ids: am instances; ` +
          `lock dir: ${lockDir()})`,
      };
    case "listening":
      return {
        ok: false,
        error: `port ${flags.port} has a listener that answers neither HTTP ` +
          `nor TLS — not an aio app`,
      };
    case "http":
      return {
        ok: false,
        error: `port ${flags.port} answers HTTP but is not an aio app ` +
          `(no /__aio/health) — wrong port?`,
      };
    case "closed":
      return {
        ok: false,
        error: `nothing is listening on port ${flags.port} — no app to stop ` +
          `there (running instances: am instances)`,
      };
  }
}

export async function cmdStop(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const resolved = await resolveStopTarget(flags);
  if (!resolved.ok) {
    outError(resolved.error, mode);
    Deno.exit(1);
  }
  const { appId, port, pf } = resolved.target;

  // Mark as stopping
  if (pf) writeLock({ ...pf, status: "stopping" });

  // Try graceful shutdown via trojan API, fall back to SIGTERM
  const result = await trojanPost(port, "shutdown", undefined, appId);
  // The SIGTERM fallback is for an app that has a lock ON THIS PORT and is not
  // answering. It must never fire on an identity refusal — killing our own pid
  // because someone ELSE holds the port is the same retargeting bug mirrored.
  if (!result.ok && pf && pf.port === port && isProcessAlive(pf.pid)) {
    try {
      Deno.kill(pf.pid, "SIGTERM");
    } catch { /* already dead */ }
  } else if (!result.ok) {
    // The real reason, not the generic literal that discarded it: "app not
    // running on port N", an identity refusal, or the app's own error.
    if (pf) writeLock(pf); // we stopped nothing — undo the "stopping" mark
    outError(result.error, mode);
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

  // Preserve the original launch across restart (a field report:
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

  // A compiled (prod, zero-TCP) app listens on its Unix socket and NOWHERE
  // else, so the TCP probe above can never succeed — `status` sat on
  // `starting` (exit 2) forever for an app that had been drawing pixels for a
  // minute (a field report). The lock records the socket; probe it.
  if (!portResponds && pf.socketPath) {
    portResponds = await isSocketAlive(pf.socketPath);
  }

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
