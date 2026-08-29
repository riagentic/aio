/**
 * @module
 * Process management commands for am — start, stop, restart, watch, status, instances.
 */

import { readDenoJson } from "../server/deno-json.ts";
import { KILL_POLL_MS } from "../server/single-instance-lock.ts";
import { dirname, join, resolve, SEPARATOR as sep } from "@std/path";
import { appDirs } from "../server/app-dirs.ts";
import {
  DEFAULT_BACKUP_KEEP,
  rotateFile,
  wipeFile,
} from "../diagnostics/logger-rotate.ts";
import {
  maxHeapFlagArgs,
  physicalMemoryBytes,
  resolveMaxHeapMB,
} from "../server/heap-policy.ts";
import type { GlobalFlags } from "./am-types.ts";
import {
  AppLock,
  type InstanceInfo,
  instances,
  isLockOwnerAlive,
  isProcessAlive,
  isSocketAlive,
  killProcess,
  type LockData,
  lockDir,
  processStartToken,
  readLaunchInfo,
  resolveAppId,
  STARTUP_GRACE_MS,
  writeLaunchInfo,
  writeLock,
} from "../server/single-instance-lock.ts";
import { EXIT_WAIT_MS } from "../server/shutdown-budget.ts";
import { VERSION } from "../server/aio-cli.ts";
import { detectMode, formatUptime, out, outError } from "./am-output.ts";
import { repoRoot } from "./am-cmd-create.ts";
import {
  declaredPort,
  liveLock,
  readEntryConfig,
  readPid,
  removePid,
  resolveAmAppId,
  resolveEntry,
} from "./am-utils.ts";
import { componentPort, processPlan } from "./am-components.ts";
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
  // The heap ceiling, resolved for THIS machine (25% of RAM, floor 4 GB).
  // A launcher is the only place that can size it correctly: V8 freezes the
  // ceiling at isolate creation, so by the time the app runs it is far too
  // late. Skipped when the caller already passed `--v8-flags` — an explicit
  // choice at the command line outranks a computed default.
  const heap = denoFlags.some((f) => f.startsWith("--v8-flags"))
    ? []
    : maxHeapFlagArgs(resolveMaxHeapMB(physicalMemoryBytes()));
  return [
    "run",
    "-A",
    "--unstable-kv",
    ...heap,
    ...denoFlags,
    entry,
    ...appFlags,
  ];
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

/** Apply the log-retention policy to `stdout.log` BEFORE the spawn.
 *
 *  It is the one log the app's own logger must not touch: the shell redirect
 *  holds its fd, so a rename from inside the app would carry the writer into
 *  the archive and an unlink would send the whole run's output to a file with
 *  no name. `am` is the only process that can rotate it — here, while nothing
 *  is writing to it — and it does so under the SAME policy the logger uses
 *  (`backupLogs` on by default, `--no-backup-logs` to wipe), because a log
 *  directory where five files keep history and one silently doesn't is the
 *  version of this that already shipped. Byte-budget eviction still belongs to
 *  the app: `stdout.log.<n>` archives have no open fd, so `enforceBudget`
 *  reaches them like any other. */
export async function prepareStdoutLog(
  logFile: string,
  flags: string[],
): Promise<void> {
  const backup = !flags.includes("--no-backup-logs");
  // `.err` is the Windows stderr split (detachedSpawnSpec); absent elsewhere,
  // where rotateFile/wipeFile are no-ops.
  for (const base of [logFile, `${logFile}.err`]) {
    if (backup) await rotateFile(base, DEFAULT_BACKUP_KEEP);
    else await wipeFile(base);
  }
}
// How long `am` waits for a STOPPING instance before it SIGKILLs — the
// runtime's own worst-case graceful stop plus a margin, imported rather than
// retyped: a 3 s wait against an 8 s budget killed legitimate final flushes.
// `EXIT_WAIT_MS` covers the app's own exit watchdog too, so `am` never kills
// an app one tick before it was going to end itself and say why.
const SINGLETON_WAIT_MS = EXIT_WAIT_MS;
/** Default for `--wait` on stop/restart, in seconds — the same budget. */
const STOP_WAIT_DEFAULT_S = Math.ceil(SINGLETON_WAIT_MS / 1000);
const POLL_INTERVAL_MS = 200;
/** How long `am start` waits before asking whether the child it just spawned
 *  is still there. A failed exec is reaped in single-digit milliseconds; a
 *  real boot takes far longer than this, so the check can only ever catch a
 *  child that never started. */
const SPAWN_LIVENESS_GRACE_MS = 150;
const HEALTH_TIMEOUT_MS = 2000;
const QUICK_TIMEOUT_MS = 1000;
const STOP_CHECK_TIMEOUT_MS = 500;

// ── Singleton enforcement ───────────────────────────────────

/** Kill a process and anything it left running — THE implementation, in
 *  `single-instance-lock.ts`, re-exported so `am`'s callers keep their import.
 *
 *  There were two copies of this, and they had already drifted in the way
 *  copies do: same shape, same constants retyped, and NEITHER of them knew
 *  about child processes — so a hung app's Electron window survived the kill
 *  that was meant to stop it. One killer, one grace period, one answer to
 *  "is it actually gone". */
export { killProcess };

/** Ensure no other instance of this app is running. Kills zombies, waits for stopping. */
export async function ensureSingleton(
  appId: string,
  mode: import("./am-types.ts").OutputMode,
): Promise<void> {
  // Wherever the instance's home is: an app `am instances` lists must never
  // be started a second time because its lock sits under `<id>@<hash>`.
  const pf = liveLock(appId);
  if (!pf) return;

  // Stale lock — the process that wrote it is gone. By OWNER, not by pid: a
  // lock under /tmp outlives a reboot, and the pid it names may now be
  // somebody else's program.
  if (!isLockOwnerAlive(pf)) {
    removePid(appId, pf);
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
      await killProcess(pf.pid, 0, pf); // already waited, go straight to SIGKILL
    }
    removePid(appId, pf);
    return;
  }

  if (pf.status === "starting") {
    // A booting app is not a stuck one. Two facts decide that, and both used
    // to be ignored: the runtime's own grace (`STARTUP_GRACE_MS` — the same
    // number `AppLock.acquire` honours) and whether there is a port to probe
    // at all. `am start` writes the placeholder lock with `port: 0` when the
    // app declared none, so the probe below went to 127.0.0.1:0, failed by
    // definition, and a second `am start` during boot SIGTERMed the first.
    const probePort = pf.trojanPort ?? pf.port;
    const withinGrace = Date.now() - pf.startedAt < STARTUP_GRACE_MS;
    if (withinGrace || !(probePort > 0)) {
      outError(
        `already starting: ${appId} (pid ${pf.pid}) — wait for it, or ` +
          `\`am stop\` it first`,
        mode,
      );
      Deno.exit(1);
    }
    // Past the grace with a real port: is it actually responding?
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
    await killProcess(pf.pid, undefined, pf);
    removePid(appId, pf);
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
  // The same fallback `am status` carries (see its comment): a prod+UDS app
  // listens on its Unix socket and NOWHERE else, so the TCP probe above can
  // never succeed for it. Without this, single-instance protection was
  // INVERTED for that transport — `am start` never refused, it killed the
  // healthy running instance every time, while `am status` reported it up.
  if (!responds && pf.socketPath) {
    responds = await isSocketAlive(pf.socketPath);
  }

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
  await killProcess(pf.pid, undefined, pf);
  removePid(appId, pf);
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
  denoBin: string = Deno.execPath(),
): { cmd: string; args: string[] } {
  if (os === "windows") {
    const q = (v: string) => "'" + v.replace(/'/g, "''") + "'";
    const ps = `$p = Start-Process -FilePath ${q(denoBin)} -ArgumentList @(${
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
      `nohup ${esc(denoBin)} ${denoArgs.map(esc).join(" ")} >${
        esc(logFile)
      } 2>&1 & echo $!`,
    ],
  };
}

// ── am ui — open amui, the visual app manager ───────────────────────────────
//
// `am ui` used to print the server-side UI-STATE PROJECTION — the worst-named
// command of the fifty (the break review's words), because "ui" reads as "the
// visual manager". It now IS that: it launches amui detached. The old
// projection lives on as `am state --ui`.

/** The amui entry beside this am's framework root (the checkout am runs from —
 *  a versions-store install included, since that store IS a checkout), or null
 *  when there is none (a bare JSR global install ships no amui/ tree). */
export function amuiEntry(root: string | undefined): string | null {
  if (!root) return null;
  const entry = join(root, "amui", "src", "app.ts");
  try {
    Deno.statSync(entry);
    return entry;
  } catch {
    return null;
  }
}

/** The deno argv `am ui` launches amui with. No `--client` is forced — amui's
 *  own deno.json declares its default (electron); extra `am ui` args pass
 *  straight through, so `am ui --client=browser` opens a tab instead. Pure,
 *  pinned by a test — CI must never actually spawn Electron. */
export function amuiDenoArgs(entry: string, extra: string[]): string[] {
  return ["run", "-A", entry, ...extra];
}

export async function cmdUi(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  // The OLD spelling: `am ui [user]` printed the UI-state projection. A bare
  // token here is that usage, not an amui argument — misreading it and
  // launching a desktop app instead would be the confusing-rename trap this
  // command was renamed to escape.
  const bare = args.find((a) => !a.startsWith("-"));
  if (bare !== undefined) {
    outError(
      `am ui now opens amui (the visual manager) — the UI-state projection ` +
        `moved: am state --ui ${bare}`,
      mode,
    );
    Deno.exit(1);
  }
  const entry = amuiEntry(repoRoot());
  if (!entry) {
    outError(
      "amui not found beside this am (a bare JSR install ships no amui/ " +
        "tree) — run it directly: deno run -A jsr:@riagentic/aio/amui",
      mode,
    );
    Deno.exit(1);
  }
  // Detached, like `am start`: amui must survive am's exit. Output lands in a
  // log file so a boot failure is diagnosable, not vanished.
  const logFile = await Deno.makeTempFile({
    prefix: "amui-",
    suffix: ".log",
  });
  const spec = detachedSpawnSpec(
    Deno.build.os,
    amuiDenoArgs(entry, args),
    logFile,
  );
  const proc = new Deno.Command(spec.cmd, {
    args: spec.args,
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const output = await proc.output();
  const childPid = parseInt(new TextDecoder().decode(output.stdout).trim(), 10);
  const pid = Number.isFinite(childPid) ? childPid : proc.pid;
  out(
    mode === "pretty"
      ? `✓ amui launched (pid ${pid}) — ${entry}\n  log: ${logFile}`
      : { launched: entry, pid, log: logFile },
    mode,
  );
}

export async function cmdStart(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);

  // A project can be more than one app. When it says so — labelled build
  // targets with their own entries — `am start` means the PROJECT and
  // `am start <label>` means one component of it. Ordinary repos never take
  // this branch (see `processPlan`), so nothing about them changes.
  {
    const plan = processPlan(args, { app: flags.app, port: flags.port });
    if (plan.kind === "error") {
      outError(plan.message, mode);
      Deno.exit(1);
    }
    if (plan.kind === "one" || plan.kind === "all") {
      const list = plan.kind === "one" ? [plan.component] : plan.components;
      for (const c of list) {
        const port = componentPort(c);
        await cmdStart(
          args.filter((a) => a.startsWith("-")),
          {
            ...flags,
            app: c.appId,
            ...(port !== undefined ? { port } : {}),
            entry: c.entry,
          },
        );
      }
      return;
    }
  }
  const appId = resolveAmAppId(flags.app);
  // The port this app DECLARED, or undefined — in which case the runtime picks
  // a free one exactly as `deno task dev` does, and `am` reads it back from the
  // lock the app writes. `am` inventing 8000 here made the two commands
  // disagree about the same app, and made `am start` refuse over a port the app
  // was never going to bind.
  const declared = declaredPort(flags.port);
  const port = declared ?? 0; // 0 = "not decided yet", for the placeholder lock

  // Clean up stuck/zombie instances before acquiring lock
  await ensureSingleton(appId, mode);

  // `--home=<dir>` TARGETS an instance that is already running from that data
  // home (docs/clients/app-manager.md: "Target the instance of the app running
  // from data home DIR"). It cannot LAUNCH one: the runtime has no CLI flag for
  // its data home — an app chooses it with `aio.run({ appDir })`, or the whole
  // root moves with `AIO_APPS_DIR` — and `am` does not forward `--home` to the
  // child. Combining it with `start` used to boot the app in the DEFAULT home
  // while am filed the placeholder lock under the scoped key, leaving a
  // "starting, port 0" lock that never resolves and never clears. Refuse, and
  // name the two things that actually work.
  if (flags.home !== undefined) {
    outError(
      `--home targets an instance that is already running; it cannot start ` +
        `one. The runtime has no flag for its data home, so am cannot tell ` +
        `the child to boot in ${flags.home}.\n` +
        `  fix: AIO_APPS_DIR=${flags.home} am start   (moves the whole apps ` +
        `root for the child)\n` +
        `  or:  aio.run({ appDir: "${flags.home}" })  (the app decides, in ` +
        `its own entry)\n` +
        `  then: am --home=${flags.home} status|stop  targets it`,
      mode,
    );
    Deno.exit(1);
  }

  // Single-instance enforcement via AppLock.
  //
  // THE home, from the app-dirs registry — which `--home=<dir>` has already
  // written to (`targetHome`). Without it `AppLock` falls back to
  // `appHome(appId)`, which does NOT consult the registry, so `am --home=X
  // start` locked and stamped the DEFAULT instance's key (`demo`) while every
  // read and remove in the same command used the scoped one (`demo@b43bebbd`).
  // Measured: three keys, one command. The running default app could then no
  // longer update or release its own lock, so a stale lock survived its clean
  // shutdown and the next boot refused to start.
  const home = appDirs(appId).home;
  const lock = new AppLock(appId, home);
  const result = await lock.acquire(port);
  if (!result.ok) {
    const ex = result.existing;
    outError(
      `already running: ${ex.appId} (pid ${ex.pid}, port ${ex.port})`,
      mode,
    );
    Deno.exit(1);
  }

  // Pre-check: is the target port already taken? Only when there IS a target —
  // an app that declares no port has no port to conflict over, and probing a
  // guess produced a refusal naming an unrelated app on 8000.
  if (declared !== undefined) {
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
          // 401/403 is an aio app ANSWERING — it is asking for the key this
          // probe deliberately does not send. Reading that as "not aio" told the
          // user their own keyed app was "another process", which sends them
          // hunting a port conflict that does not exist. `authed` says which.
          : {
            ok: false,
            error: r.status === 401 || r.status === 403 ? "auth" : "",
          };
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
      } else if (!trojan.ok && trojan.error === "auth") {
        outError(
          `port ${port} in use by an aio app that requires a key (it answered ` +
            `the probe with 401) — stop it first, or use --port=N`,
          mode,
        );
      } else {
        outError(`port ${port} in use by another process — use --port=N`, mode);
      }
      Deno.exit(1);
    } catch { /* port free — good */ }
  }

  // Resolve entry point — --entry flag > deno.json "entry" > src/app.ts
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
        const dj = ((await readDenoJson(Deno.cwd()))?.config ?? {}) as {
          client?: string;
        };
        effective = dj.client;
      } catch { /* no deno.json client — framework default applies */ }
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
  await prepareStdoutLog(logFile, passthrough);
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

  // Release am's placeholder lock THE MOMENT the child exists — before the
  // liveness grace below, not after it.
  //
  // The lock am holds carries AM's pid, and the child's own `acquire()` sees a
  // lock owned by a live, different process and refuses to boot: "Already
  // running: <app> (pid <am>)". A small app boots in ~10 ms, well inside the
  // 150 ms grace, so `am start` could not start a fast app at all — it
  // reported "the child exited immediately" and quoted the app refusing
  // itself. The grace exists to notice a failed exec; it never needed the
  // lock. `release()` only removes a lock that is still ours, so a child that
  // has already written its own is untouched.
  lock.release();

  // A pid is not a running app. `sh` forks BEFORE it execs, so a pid comes
  // back even when the exec fails — and `am start` reported success, exited 0
  // and left a lock for a process that had already died, with the only
  // evidence in a log file nobody was told to read.
  //
  // The grace is short and one-sided: long enough for a failed exec to be
  // reaped, far short of a boot. A child alive here may still fail later
  // (that is what `--wait` and `am status` are for); a child DEAD here never
  // started, and calling that "starting" is the lie.
  await new Promise((r) => setTimeout(r, SPAWN_LIVENESS_GRACE_MS));
  if (!isProcessAlive(pid)) {
    const tail = (await Deno.readTextFile(logFile).catch(() => ""))
      // deno-lint-ignore no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, "") // the child's colours are not ours
      .trim();
    // A fresh clone's failure is ALWAYS this one, and Deno states it as a bare
    // `Module not found "file:///…/dep/aio/mod.ts"`. The link is gitignored on
    // purpose (it is machine-specific), so a clone never has it and the repair
    // has a name. Say the name — the error above is otherwise a dead end for
    // anyone who has not read the README.
    const missingLink = /Module not found[^\n]*dep[/\\]aio/.test(tail);
    outError(
      `${appId} did not start — the child (pid ${pid}) exited immediately.\n` +
        (tail
          ? `  it said:\n${
            tail.split("\n").slice(-8).map((l) => `      ${l}`).join("\n")
          }\n`
          : `  it wrote nothing to ${logFile}\n`) +
        (missingLink
          ? `  this clone has no dep/aio link (it is gitignored — every clone ` +
            `has to make its own).\n  fix: am fix\n`
          : "") +
        `  full log: ${logFile}`,
      mode,
    );
    Deno.exit(1);
  }

  // A placeholder lock for the child, so `am status` between here and the
  // child's own `_run()` says "starting" rather than "stopped" — but only if
  // the child has not written its own already. It boots in milliseconds, and
  // overwriting its real lock (the port it actually bound, its transport, its
  // start token) with this half-filled record is how `am start` came to report
  // `port: 0` for an app that was already listening.
  // `readPid`, not `liveLock`, on purpose: this is the lock of the child `am`
  // itself just spawned, under the home `am` launched it with — an instance
  // of the same id from ANOTHER home is a different app and must not be
  // mistaken for it.
  const childLock = readPid(appId);
  const lockData: LockData = {
    appId,
    pid,
    port,
    startedAt: Date.now(),
    status: "starting",
    cwd: Deno.cwd(),
    // `writeLock` keys by (appId, home) — omitting it filed this under the
    // DEFAULT instance's name. See the note on `home` above.
    home,
    // The CHILD's kernel start stamp, so a later `am stop` can tell this
    // process from a stranger that inherits its pid. The child overwrites this
    // lock with its own (which records the same thing); this covers the window
    // in between.
    ...(processStartToken(pid) !== null
      ? { startToken: processStartToken(pid)! }
      : {}),
  };
  if (!childLock || childLock.pid !== pid) writeLock(lockData);

  // ── `am start` WAITS by default ──
  //
  // It used to return the instant the child was spawned, with
  // `{"status":"starting","port":0}` — and the very next command in the
  // obvious sequence (`am start && am state`) died on a leaked Deno internal,
  // "Requests to port 0 are blocked", because port 0 is what "the app has not
  // chosen yet" was reported as. `--wait` returned in ~0.6 s with the real
  // port. Half a second is not worth a default sequence that does not work.
  //
  // `--no-wait` is the opt-out for a script that genuinely only wants the
  // spawn; it keeps the old output verbatim, including the honest refusal to
  // print a port the app has not picked.
  if (flags.noWait) {
    out(
      mode === "pretty"
        ? declared !== undefined
          ? `starting ${appId} (pid ${pid}, port ${port})`
          : `starting ${appId} (pid ${pid}) — the app picks a free port; ` +
            `am status shows it`
        : {
          appId,
          pid,
          ...(declared !== undefined ? { port } : {}),
          status: "starting",
        },
      mode,
    );
    return;
  }

  // Probe health until started or timeout (`--wait=<seconds>` overrides).
  const timeout = (flags.wait || 10) * 1000;
  let healthy = false;
  const deadline = Date.now() + timeout;
  // The port to probe is whatever the CHILD bound, which it records in its own
  // lock — the only honest source when nothing was declared.
  let livePort = declared;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (!isProcessAlive(pid)) break; // died early
    if (livePort === undefined) {
      const written = readPid(appId); // our own child's lock — see above
      if (written?.port) livePort = written.port;
      else continue; // not far enough into boot to have chosen one
    }
    try {
      const ctrlPort = resolveControlPort(livePort, appId);
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
    const updated = readPid(appId); // our own child's lock — see above
    if (updated && updated.status !== "started") {
      writeLock({ ...updated, status: "started" });
    }
    // The port the app ACTUALLY bound — from its own lock, falling back to what
    // we probed. Reporting `port` here would print am's placeholder for an app
    // that chose its own.
    const realPort = updated?.port ?? livePort ?? port;
    out(
      mode === "pretty"
        ? `started ${appId} (pid ${pid}, port ${realPort})`
        : { appId, pid, port: realPort, status: "started" },
      mode,
    );
  } else if (!isProcessAlive(pid)) {
    removePid(appId); // our own child's placeholder, under our own home
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
  // Wherever the instance's home is — `am stop` must stop the app
  // `am instances` lists, including one booted from its own `appDir`.
  const pf = liveLock(cwdAppId);

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
          pf: liveLock(probe.appId),
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

/** The project this `am` invocation is about: the nearest ancestor of the cwd
 *  holding a `deno.json`, or the cwd when there is none.
 *
 *  This is what scopes `--all`, and the walk UP is the point. A compiled app is
 *  routinely launched from somewhere inside its own project rather than the
 *  root — `dist/<app>/./<app>` is the normal way to run a built server — and
 *  its lock records THAT directory. Comparing against the bare cwd would leave
 *  exactly those instances running while reporting that everything stopped. */
export function projectRoot(from = Deno.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    try {
      if (Deno.statSync(join(dir, "deno.json")).isFile) return dir;
    } catch { /* keep walking */ }
    const up = dirname(dir);
    if (up === dir) return resolve(from);
    dir = up;
  }
}

/** Is `path` inside `root` (or root itself)? Compared as path SEGMENTS, so
 *  `/home/u/remote-old` is not treated as living inside `/home/u/remote`. */
export function isUnder(root: string, path: string): boolean {
  const a = resolve(root);
  const b = resolve(path);
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/** The running instances `--all` is allowed to stop: this project's, and only
 *  this project's.
 *
 *  Scoped rather than global on purpose. `am instances` is machine-wide, so a
 *  literal "stop all" would reach into every other aio app the developer has
 *  running — a different project's server going down because someone tidied up
 *  in this one is not a tidy-up, it is an outage with no obvious cause. */
export function instancesInProject(root = projectRoot()): InstanceInfo[] {
  return instances()
    .filter((i) => i.cwd && isUnder(root, i.cwd))
    .sort((a, b) => a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0);
}

/** Stop one app. Returns what happened instead of exiting, so `--all` can carry
 *  on through a failure and report every app rather than dying on the first. */
async function stopOne(
  target: StopTarget,
  flags: GlobalFlags,
): Promise<
  | { ok: true; appId: string; pid?: number; port: number }
  | { ok: false; appId: string; error: string }
> {
  const { appId, port, pf } = target;

  // Mark as stopping
  if (pf) writeLock({ ...pf, status: "stopping" });

  // Try graceful shutdown via trojan API, fall back to SIGTERM
  const result = await trojanPost(port, "shutdown", undefined, appId);
  // The SIGTERM fallback is for an app that has a lock ON THIS PORT and is not
  // answering. It must never fire on an identity refusal — killing our own pid
  // because someone ELSE holds the port is the same retargeting bug mirrored.
  if (!result.ok && pf && pf.port === port && isLockOwnerAlive(pf)) {
    try {
      Deno.kill(pf.pid, "SIGTERM");
    } catch { /* already dead */ }
  } else if (!result.ok) {
    // The real reason, not the generic literal that discarded it: "app not
    // running on port N", an identity refusal, or the app's own error.
    if (pf) writeLock(pf); // we stopped nothing — undo the "stopping" mark
    return { ok: false, appId, error: result.error };
  }

  // Without --wait: return immediately, user checks with `am status`
  if (flags.wait === undefined) {
    return { ok: true, appId, pid: pf?.pid, port };
  }

  // With --wait: poll until dead, then force kill if needed
  const timeout = (flags.wait || STOP_WAIT_DEFAULT_S) * 1000;
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
    await killProcess(pf.pid, 0, pf); // already waited gracefully
  }
  removePid(appId, pf);
  return { ok: true, appId, pid: pf?.pid, port };
}

export async function cmdStop(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const waited = flags.wait !== undefined;

  // `am stop` in a multi-component project stops the PROJECT — which is what
  // `--all` already did, now the default where the project says it has parts.
  // `am stop <label>` stops one. A single-app repo is untouched.
  let stopAll = flags.all;
  {
    const plan = processPlan(_args, { app: flags.app, port: flags.port });
    if (plan.kind === "error") {
      outError(plan.message, mode);
      Deno.exit(1);
    }
    if (plan.kind === "one") {
      flags = { ...flags, app: plan.component.appId };
    } else if (plan.kind === "all") {
      stopAll = true;
    }
  }

  if (stopAll) {
    // `--port` names ONE app; `--all` names every app here. Asking for both is
    // not a refinement of either, so it is refused rather than resolved by a
    // precedence rule nobody would remember.
    if (flags.port !== undefined || flags.app) {
      outError(
        "--all stops every app of this project; it cannot be combined with " +
          "--port or --app, which name one",
        mode,
      );
      Deno.exit(1);
    }
    const root = projectRoot();
    const running = instancesInProject(root);
    if (running.length === 0) {
      out(
        mode === "pretty"
          ? `nothing running under ${root}`
          : { root, stopped: [], status: "none-running" },
        mode,
      );
      return;
    }

    const results = [];
    for (const i of running) {
      results.push(
        // `i` IS the lock — re-reading it by appId used the DEFAULT-home key,
        // so stopping a fleet that contained a `--home`-scoped instance sent
        // the shutdown (and the SIGTERM fallback) to the DEFAULT instance's
        // pid instead. The instance we already hold is the answer.
        await stopOne({ appId: i.appId, port: i.port, pf: i }, flags),
      );
    }
    const failed = results.filter((r) => !r.ok);
    if (mode === "pretty") {
      for (const r of results) {
        out(
          r.ok
            ? `${waited ? "stopped" : "stopping"} ${r.appId}`
            : `✗ ${r.appId}: ${r.error}`,
          mode,
        );
      }
    } else {
      out({ root, stopped: results }, mode);
    }
    // Non-zero when ANY app is still up: a script that stops a fleet and reads
    // exit 0 is entitled to believe the fleet is down.
    if (failed.length) Deno.exit(1);
    return;
  }

  const resolved = await resolveStopTarget(flags);
  if (!resolved.ok) {
    outError(resolved.error, mode);
    Deno.exit(1);
  }
  const r = await stopOne(resolved.target, flags);
  if (!r.ok) {
    outError(r.error, mode);
    Deno.exit(1);
  }
  out(
    mode === "pretty"
      ? waited
        ? `stopped ${r.appId}`
        : `stopping ${r.appId} (pid ${r.pid ?? "?"}, port ${r.port})`
      : waited
      ? { appId: r.appId, status: "stopped" }
      : { appId: r.appId, status: "stopping", pid: r.pid, port: r.port },
    mode,
  );
}

export async function cmdRestart(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);

  // A DECLARED project can be restarted whole, because the declaration is
  // exactly what `--all` lacked: each component's entry and identity. That is
  // why the refusal below still stands for undeclared fleets and does not
  // stand here.
  {
    const plan = processPlan(args, { app: flags.app, port: flags.port });
    if (plan.kind === "error") {
      outError(plan.message, mode);
      Deno.exit(1);
    }
    if (plan.kind === "one" || plan.kind === "all") {
      const list = plan.kind === "one" ? [plan.component] : plan.components;
      for (const c of list) {
        const port = componentPort(c);
        await cmdRestart(
          args.filter((a) => a.startsWith("-")),
          {
            ...flags,
            app: c.appId,
            ...(port !== undefined ? { port } : {}),
            entry: c.entry,
          },
        );
      }
      return;
    }
  }

  // Refused rather than ignored. `stop --all` exists, so `restart --all` is a
  // reasonable thing to type, and silently restarting ONE app while reporting
  // success is the worst available answer: a fleet half up, and a developer
  // who believes it is whole. Starting several apps is not the mirror of
  // stopping them — each needs its own entry and its own flags, and an app am
  // did not start has no launch to replay.
  if (flags.all) {
    outError(
      "restart --all is not supported: am can stop a fleet, but it cannot " +
        "know how to start every app back up (each has its own entry and " +
        "flags, and an app am did not start has no launch to replay). Use " +
        "am stop --all, then start each app the way you normally do",
      mode,
    );
    Deno.exit(1);
  }
  const appId = resolveAmAppId(flags.app);
  const pf = liveLock(appId); // wherever the instance's home is

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
    const stopFlags = {
      ...flags,
      quiet: true,
      wait: flags.wait ?? STOP_WAIT_DEFAULT_S,
    };
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
  if (!liveLock(appId)) await cmdStart([], flags); // never a double start

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

  // "Is the project up?" is the question a multi-component repo asks, and one
  // line about one of its three apps was not an answer to it.
  {
    const plan = processPlan(_args, { app: flags.app, port: flags.port });
    if (plan.kind === "error") {
      outError(plan.message, mode);
      Deno.exit(1);
    }
    if (plan.kind === "one") {
      flags = { ...flags, app: plan.component.appId };
    } else if (plan.kind === "all") {
      const rows = plan.components.map((c) => {
        const pf = liveLock(c.appId);
        const up = pf !== null && isProcessAlive(pf.pid);
        return {
          component: c.label,
          appId: c.appId,
          status: up ? (pf.status ?? "started") : "stopped",
          ...(up ? { pid: pf.pid, port: pf.port } : {}),
        };
      });
      out(
        mode === "pretty"
          ? rows.map((r) =>
            `${r.component} (${r.appId}): ${r.status}` +
            (r.pid ? ` (pid ${r.pid}, port ${r.port})` : "")
          ).join("\n")
          : { components: rows },
        mode,
      );
      // Same exit contract as the single-app form, read over the whole
      // project: 0 only when EVERY component is up.
      const up = rows.filter((r) => r.status === "started").length;
      if (up === rows.length) return;
      Deno.exit(rows.some((r) => r.status !== "stopped") ? 2 : 1);
    }
  }

  const appId = resolveAmAppId(flags.app);
  // Wherever the instance's home is: `am status` and `am instances` read the
  // same fact, so they can never disagree about an `appDir`-homed app again.
  const pf = liveLock(appId);

  // No lock file → stopped. But "stopped" is only half an answer when OTHER
  // aio apps are up: `am status` said `stopped` while `am instances` listed
  // the app as running, and two liveness sources disagreeing is what makes you
  // stop trusting your own measurements. They never actually disagreed — this
  // command asks about ONE appId (guessed from the cwd) and that one lists
  // every appId. Saying which id was asked about, and what else is running,
  // makes it one answer.
  if (!pf) {
    const others = instances();
    out(
      mode === "pretty"
        ? `${appId}: stopped` +
          (others.length > 0
            ? `\n  (running: ${
              others.map((i) =>
                `${i.appId} @ ${i.socketPath ? "uds" : `:${i.port}`}`
              ).join(", ")
            } — this directory resolves to "${appId}"; use --app=<id>)`
            : "")
        : { appId, status: "stopped", running: others.map((i) => i.appId) },
      mode,
    );
    Deno.exit(1);
  }

  const alive = isProcessAlive(pf.pid);

  // Lock file exists but process dead → stale, clean up
  if (!alive) {
    removePid(appId, pf);
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

/** Does an instance's recorded aio version differ from the `am` reading it?
 *  Unknown (a lock from before the field existed) is not a mismatch — it is
 *  printed as `?` so the absence is visible, not asserted. Pure. */
export function instanceAioMismatch(v: string | undefined): boolean {
  return v !== undefined && v !== VERSION;
}

/** The `aio=` column of one `am instances` row. Pure. */
export function instanceAioColumn(v: string | undefined): string {
  return `aio=${v ?? "?"}${instanceAioMismatch(v) ? `  ≠ am ${VERSION}` : ""}`;
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
        `${inst.appId}  pid=${inst.pid}  port=${inst.port}  ${inst.status}  ${transport}${uds}  uptime=${uptime}  ${
          instanceAioColumn(inst.aioVersion)
        }  home=${inst.home}  cwd=${inst.cwd}`,
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
        aio: inst.aioVersion ?? null,
        aioMismatch: instanceAioMismatch(inst.aioVersion),
        home: inst.home,
        cwd: inst.cwd,
      })),
      mode,
    );
  }
}

/** `am kill [--stale]` — end a process the polite path cannot reach.
 *
 *  `am stop` asks the app to shut down and falls back to SIGTERM when it has a
 *  lock on the port. Neither helps against an ORPHAN: a run whose lock is gone
 *  but whose process kept the port and kept answering. A field report hit that
 *  three times in one session — `am status` said `stopped`, `am instances`
 *  listed nothing, and `am state` cheerfully served five-hour-old numbers,
 *  which they then reported to a user as current. A stale singleton silently
 *  serving old state is worse than a crash, because nothing about it looks
 *  wrong.
 *
 *  `--stale` finds them the only way that is reliable: ASK. Every port a lock
 *  or the app config names is probed; a responder that reports an `appId`/`pid`
 *  no live lock accounts for is an orphan, and its pid comes from its own
 *  health answer (which is why `/__aio/health` reports one).
 *
 *  Nothing is killed silently — every kill is named, and with no orphans the
 *  command says so. */
/** Every pid an aio lock names, anywhere on this machine — the default lock
 *  dir AND every `AIO_APPS_DIR`-scoped sibling beside it (`aio-<scope>`).
 *
 *  `instances()` only ever reads OUR scope. An app started under a different
 *  `AIO_APPS_DIR` was therefore invisible to it, so `am kill --stale`
 *  classified a perfectly healthy app as an orphan and SIGTERMed it. The lock
 *  files are right there; not reading them was the bug. */
export function lockedPidsEverywhere(): Map<
  number,
  { appId: string; dir: string }
> {
  const found = new Map<number, { appId: string; dir: string }>();
  const base = dirname(lockDir());
  const dirs = new Set<string>([lockDir()]);
  try {
    for (const e of Deno.readDirSync(base)) {
      if (e.isDirectory && /^aio(-|$)/.test(e.name)) {
        dirs.add(join(base, e.name));
      }
    }
  } catch { /* base unreadable — the default dir alone still applies */ }
  for (const dir of dirs) {
    try {
      for (const e of Deno.readDirSync(dir)) {
        if (!e.isFile || !e.name.endsWith(".lock")) continue;
        try {
          const d = JSON.parse(Deno.readTextFileSync(join(dir, e.name))) as {
            pid?: number;
            appId?: string;
          };
          if (typeof d.pid === "number" && d.pid > 0) {
            found.set(d.pid, { appId: d.appId ?? "?", dir });
          }
        } catch { /* unreadable or half-written lock — skip it */ }
      }
    } catch { /* dir vanished */ }
  }
  return found;
}

/** The command line of `pid`, or null when this platform will not say. */
function pidCommandLine(pid: number): string | null {
  try {
    if (Deno.build.os === "linux") {
      const cmdline = Deno.readTextFileSync(`/proc/${pid}/cmdline`)
        .replaceAll("\0", " ").trim();
      if (cmdline) return cmdline;
      // EMPTY is not "no such process" — `/proc/<pid>/cmdline` is empty for a
      // kernel thread, for a zombie, and for the instant between fork and
      // execve. It used to be returned as-is, so the refusal below read
      // "…it is running: " and stopped mid-sentence: a message that names
      // nothing, on the exact path that decides whether to signal a stranger's
      // process. `comm` is populated for every live pid, so it answers when
      // cmdline cannot.
      const comm = Deno.readTextFileSync(`/proc/${pid}/comm`).trim();
      return comm || null;
    }
    if (Deno.build.os === "darwin") {
      const r = new Deno.Command("ps", {
        args: ["-o", "command=", "-p", String(pid)],
        stdout: "piped",
        stderr: "null",
      }).outputSync();
      return r.success
        ? new TextDecoder().decode(r.stdout).trim() || null
        : null;
    }
  } catch { /* gone, or not ours to read */ }
  return null;
}

/** Why `pid` must NOT be signalled as a stale aio app, or null when it may be.
 *
 *  `am kill --stale` used to SIGTERM whatever pid an unauthenticated loopback
 *  `/__aio/health` response reported ABOUT ITSELF, unverified. Two things
 *  follow, and both are real: a healthy app under a different `AIO_APPS_DIR`
 *  is invisible to `instances()` and so gets killed as an orphan; and anything
 *  listening on a candidate port can name ANY pid on the machine and have `am`
 *  SIGTERM it. A number that arrives over a socket is a claim, not a fact — so
 *  it is checked against the process table before any signal. */
export function stalePidRefusal(
  pid: number,
  locked: Map<number, { appId: string; dir: string }>,
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return `"${pid}" is not a pid`;
  if (pid === Deno.pid) return "that is am itself";
  const known = locked.get(pid);
  if (known) {
    return `pid ${pid} is a LOCKED aio instance (${known.appId} in ` +
      `${known.dir}) — running normally, just not in this scope ` +
      `(AIO_APPS_DIR). Not an orphan.`;
  }
  if (!isProcessAlive(pid)) return `pid ${pid} is already gone`;
  // Ours to signal at all? isProcessAlive counts EPERM as alive on purpose
  // (another user's process IS running), which is exactly the case to refuse.
  try {
    Deno.kill(pid, 0);
  } catch {
    return `pid ${pid} belongs to another user — not ours to signal`;
  }
  const cmd = pidCommandLine(pid);
  if (cmd === null) return null; // platform will not say; the pid is all there is
  if (!/\bdeno\b|aio/i.test(cmd)) {
    return `pid ${pid} is not an aio process — it is running: ${
      cmd.slice(0, 120)
    }`;
  }
  return null;
}

export async function cmdKill(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const live = instances();

  if (!flags.stale) {
    // The blunt form: end THIS app now. `am stop` is the polite one.
    const appId = resolveAmAppId(flags.app);
    const pf = liveLock(appId); // wherever the instance's home is
    if (!pf || !isLockOwnerAlive(pf)) {
      out(
        mode === "pretty" ? `${appId}: not running` : { appId, killed: false },
        mode,
      );
      Deno.exit(1);
    }
    try {
      Deno.kill(pf.pid, "SIGTERM");
    } catch { /* raced us to the exit */ }
    removePid(appId, pf);
    out(
      mode === "pretty"
        ? `killed ${appId} (pid ${pf.pid})`
        : { appId, pid: pf.pid, killed: true },
      mode,
    );
    return;
  }

  // Candidate ports: everything a lock names, plus the port this project's
  // config asks for — the one an orphan of THIS app is most likely holding.
  const accounted = new Map<number, { appId: string; pid: number }>();
  for (const i of live) accounted.set(i.port, { appId: i.appId, pid: i.pid });
  const candidates = new Set<number>(accounted.keys());
  const cfgPort = readEntryConfig().port;
  if (cfgPort) candidates.add(cfgPort);
  if (flags.port) candidates.add(flags.port);
  // …plus the port THIS app was last launched with. An orphan usually holds
  // the same port its predecessor did, and `am start` recorded it even though
  // the lock is gone.
  const launched = readLaunchInfo(resolveAmAppId(flags.app));
  for (const f of launched?.flags ?? []) {
    const m = /^--port=(\d+)$/.exec(f);
    if (m) candidates.add(Number(m[1]));
  }

  const orphans: Array<{ appId: string; pid: number; port: number }> = [];
  /** Ports that answered but whose pid this refuses to signal — reported, not
   *  swallowed: "nothing happened" and "I would not do that" are different
   *  answers, and only one of them is actionable. */
  const spared: Array<{ port: number; pid: number; why: string }> = [];
  const lockedPids = lockedPidsEverywhere();
  for (const port of candidates) {
    let health: { appId?: string; pid?: number } | null = null;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/__aio/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      health = r.ok ? await r.json() : null;
    } catch { /* nothing there — not an orphan, just a closed port */ }
    if (!health?.pid) continue;
    const known = accounted.get(port);
    // Accounted for by a live lock, and the SAME process — this is the app.
    if (known && known.pid === health.pid) continue;
    // The pid arrived over an unauthenticated loopback socket. Check it.
    const refusal = stalePidRefusal(health.pid, lockedPids);
    if (refusal) {
      spared.push({ port, pid: health.pid, why: refusal });
      continue;
    }
    orphans.push({
      appId: health.appId ?? "unknown",
      pid: health.pid,
      port,
    });
  }

  if (orphans.length === 0) {
    out(
      mode === "pretty"
        ? `no stale aio processes (checked ports: ${
          [...candidates].sort((a, b) => a - b).join(", ") || "none"
        })` +
          spared.map((sp) =>
            `\n  left pid ${sp.pid} on port ${sp.port} alone — ${sp.why}`
          ).join("") +
          `\n  an orphan on a port nothing records is invisible here — ` +
          `name it with --port=N`
        : { killed: [], checked: [...candidates], spared },
      mode,
    );
    return;
  }

  for (const o of orphans) {
    try {
      Deno.kill(o.pid, "SIGTERM");
    } catch { /* already gone */ }
  }
  out(
    mode === "pretty"
      ? orphans
        .map((o) =>
          `killed stale ${o.appId} (pid ${o.pid}, port ${o.port}) — it was ` +
          `serving with no lock, so every am command was reading past it`
        )
        .join("\n") +
        spared.map((sp) =>
          `\nleft pid ${sp.pid} on port ${sp.port} alone — ${sp.why}`
        ).join("")
      : { killed: orphans, spared },
    mode,
  );
}
