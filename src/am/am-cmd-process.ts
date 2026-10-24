/**
 * @module
 * Process management commands for am — start, stop, restart, watch, status, instances.
 *
 * This file holds am ui, am restart and am watch. The rest lives beside it and
 * is re-exported here, so every importer keeps this one path:
 *   am-launch.ts     — the deno argv, the stdout log, timings, the detached spawn
 *   am-cmd-start.ts  — am start, singleton enforcement, waiting for the child
 *   am-cmd-stop.ts   — am stop: which instance is meant, stopping one
 *   am-cmd-status.ts — am status and am instances
 *   am-cmd-kill.ts   — am kill
 */

import {
  isLockOwnerAlive,
  KILL_POLL_MS,
  killProcess,
  readLaunchInfo,
} from "../server/single-instance-lock.ts";
import { dirname, join } from "@std/path";
import { isUnder, projectRoot } from "./am-project.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError, sayErr } from "./am-output.ts";
import { repoRoot } from "./am-cmd-create.ts";
import {
  liveLock,
  maintenanceMessage,
  maintenanceOp,
  otherRootRefusal,
  resolveAmAppId,
} from "./am-utils.ts";
import {
  componentLaunchArgs,
  componentPort,
  processPlan,
} from "./am-components.ts";
import { envReplay, envWords } from "./am-instance.ts";
import { resolveControlPort } from "./am-http.ts";
import {
  detachedSpawnSpec,
  launchDetached,
  SINGLETON_WAIT_MS,
  STOP_CHECK_TIMEOUT_MS,
  STOP_WAIT_DEFAULT_S,
  WATCH_DEBOUNCE_MS,
} from "./am-launch.ts";
import {
  appFlagRefusal,
  cmdStart,
  componentProgress,
  effectiveClient,
  entryRefusal,
  headlessRefusal,
  restartEntry,
} from "./am-cmd-start.ts";
import {
  foreignCheckout,
  noLockOnPortMessage,
  resolveLockTarget,
  stopOne,
} from "./am-cmd-stop.ts";

// ── Moved out — re-exported so every importer keeps this path ──
export {
  buildDenoArgs,
  detachedSpawnSpec,
  entryTaskWords,
  launchDetached,
  LAUNCHER_TIMEOUT_MS,
  prepareStdoutLog,
} from "./am-launch.ts";
export {
  _ofLaunch,
  bootStalled,
  childSaid,
  clientOpensTabs,
  cmdStart,
  componentProgress,
  componentProgressLine,
  crashTail,
  doorAnswers,
  ensureSingleton,
  entryRefusal,
  localAppUrl,
  noLockMessage,
  profileArg,
  restartEntry,
  servesTls,
  SLOW_START_WAIT_MS,
  slowStartReason,
  startedReport,
  startWaitMs,
  stillStartingMessage,
  waitedAt,
  waitingMessage,
  waitingOf,
  writeStartPlaceholder,
} from "./am-cmd-start.ts";
export {
  ALREADY_RUNNING_FIX,
  alreadyRunningLine,
  cmdStop,
  foreignCheckout,
  hardStopNote,
  instancesInNestedProjects,
  instancesInProject,
  lockOnPort,
  noLockOnPortMessage,
  notAnsweringLine,
  relockAfterRestart,
  resolveLockTarget,
  resolveStopTarget,
  RESTART_QUIET_MS,
  startedByInstance,
  stopOne,
  stopRefusalNote,
  thisProjectAppId,
} from "./am-cmd-stop.ts";
export type { LockTarget, StopTarget } from "./am-cmd-stop.ts";
export {
  cmdInstances,
  cmdStatus,
  instanceAioMismatch,
  listedInstances,
  stopCommandFor,
} from "./am-cmd-status.ts";
export {
  askThenKill,
  cmdKill,
  ENDED_HARD,
  killSaid,
  listenerPids,
  lockedPidsEverywhere,
  stalePidRefusal,
} from "./am-cmd-kill.ts";

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
  // amui is its OWN project: Deno discovers `deno.json` from the working
  // directory, so launching it from the user's app directory hands it the
  // APP's config — the app's import map, the app's lock file — for a program
  // that is not the app. `am ui` is typed inside an app by definition, so
  // that is the normal case, not the corner one. Run it where it lives.
  const pid = await launchDetached(spec, logFile, {
    cwd: dirname(dirname(entry)),
  });
  out(
    mode === "pretty"
      ? `✓ amui launched (pid ${pid}) — ${entry}\n  log: ${logFile}`
      : { launched: entry, pid, log: logFile },
    mode,
  );
}

// THE project-root resolver lives in am-project.ts (one decider, shared with
// every reader of the project's config); re-exported here for its callers.
export { isUnder, projectRoot };

export async function cmdRestart(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const lost = await restartAll(args, flags);
  // The app is back up either way — from the state that IS on disk. The exit
  // code stops claiming that the state before the restart went with it: this
  // used to route through `cmdStop` with `quiet: true`, whose own exit 1 on a
  // refused final write fired INSIDE the restart — the app was stopped, the
  // NOT SAVED line was swallowed by quiet, the start never ran, and `am
  // watch` (which calls this) died with it. Silent, and half done.
  if (lost.length) Deno.exit(1);
}

/** Restart what `args`/`flags` name — one app, a component, or a declared
 *  fleet — and return the ids whose FINAL write was refused. The exit code
 *  is the caller's decision: `am restart` exits 1 on any of them, `am watch`
 *  keeps watching (the next save is the fix, and a dead watcher fixes
 *  nothing). Every app restarts before the verdict is returned: a fleet half
 *  up because the first one's write was refused is worse than the refusal. */
async function restartAll(
  args: string[],
  flags: GlobalFlags,
): Promise<string[]> {
  const mode = detectMode(flags);

  // A DECLARED project can be restarted whole, because the declaration is
  // exactly what `--all` lacked: each component's entry and identity. That is
  // why the refusal in `restartApp` still stands for undeclared fleets and
  // does not stand here.
  const plan = processPlan(args, {
    app: flags.app,
    port: flags.port,
    entry: flags.entry,
  });
  if (plan.kind === "error") {
    outError(plan.message, mode);
    Deno.exit(1);
  }
  // A positional that named a RUNNING instance resolves to `--app` — see
  // processPlan. `am instances` prints app ids, and typing one back was
  // refused with a message about components.
  if (plan.kind === "single" && plan.appId) {
    flags = { ...flags, app: plan.appId };
    args = args.filter((a) => a !== plan.appId);
  }
  if (plan.kind === "one" || plan.kind === "all") {
    const list = plan.kind === "one" ? [plan.component] : plan.components;
    const lost: string[] = [];
    const progress = componentProgress("restart", list.map((c) => c.label));
    for (const c of list) {
      const port = componentPort(c);
      const r = await restartApp(
        componentLaunchArgs(c, args.filter((a) => a.startsWith("-"))),
        {
          ...flags,
          app: c.appId,
          ...(port !== undefined ? { port } : {}),
          entry: c.entry,
        },
      );
      if (r.unsaved) lost.push(r.appId);
      progress.done();
    }
    progress.end();
    return lost;
  }
  const r = await restartApp(args, flags);
  return r.unsaved ? [r.appId] : [];
}

/** `am`'s OWN flags — the ones that steer the restart rather than the app.
 *
 *  `--force` decides whether to take over another checkout; `--json` picks an
 *  output format. Neither says anything about how the app should boot, and
 *  neither should suppress the replay of flags that do. */
const AM_ONLY_FLAGS = new Set([
  "--force",
  "--json",
  "--quiet",
  "--wait",
  "--all",
  "--long",
  "--timeout",
  "--app",
]);

/** The flag NAME, so `--port=8140` and `--port` are the same flag. */
const flagName = (a: string): string => a.split("=", 1)[0]!;

/** Merge a recorded launch with the flags typed on THIS restart.
 *
 *  Replay used to be all-or-nothing: any flag on the command line skipped the
 *  recorded launch entirely. So `am restart --force` — where `--force` means
 *  "yes, take over that other checkout" and nothing about how to boot — threw
 *  away the `--cdp --port=8140` the app was started with, and the app came back
 *  with `port: 0` and no debugging port (report 4 §5, report 1 §22.4). The
 *  downstream error was excellent; the cause was silent.
 *
 *  Per FLAG, not all-or-nothing: an explicit `--port=9000` overrides a recorded
 *  one, and everything else recorded is replayed. Pure, so the rule is testable
 *  without launching anything. */
export function mergeLaunchFlags(
  recorded: readonly string[],
  typed: readonly string[],
): { launch: string[]; replayed: string[]; overridden: string[] } {
  // A bare `--` ends the options on both sides: what follows it is the APP's
  // argument list. Appending typed flags after a recorded `-- x` made
  // `am restart --expose` hand `--expose` to the app as an argument — it
  // booted unexposed and said nothing. Flags merge before the separator; a
  // typed argument list replaces the recorded one whole.
  const split = (a: readonly string[]) => {
    const i = a.indexOf("--");
    return i === -1 ? [a, null] as const : [a.slice(0, i), a.slice(i)] as const;
  };
  const [recFlags, recTail] = split(recorded);
  const [typedFlags, typedTail] = split(typed);
  const appTyped = typedFlags.filter((a) => !AM_ONLY_FLAGS.has(flagName(a)));
  const typedNames = new Set(appTyped.map(flagName));
  const kept = recFlags.filter((a) => !typedNames.has(flagName(a)));
  const replayed = [...kept, ...(typedTail ? [] : recTail ?? [])];
  const overridden = [
    ...recFlags.filter((a) => typedNames.has(flagName(a))).map(flagName),
    ...(typedTail && recTail ? ["--"] : []),
  ];
  // Recorded first, then what was typed: a later occurrence wins in every CLI
  // parser aio ships, so an override that survived the filter still lands last.
  return {
    launch: [...kept, ...appTyped, ...(typedTail ?? recTail ?? [])],
    replayed,
    overridden,
  };
}

/** A restart NOTE — said before the start that follows.
 *
 *  Pretty mode prints it on stdout (the operator is watching). `--json` must
 *  NOT: a preceding `out({restart:…})` then the start's `{status:"started"}`
 *  made TWO documents, so `JSON.parse(stdout)` — the contract every other
 *  verb keeps — failed on a command that had already started the app. Notes
 *  ride on stderr in `--json`; the one document is the start result. */
function restartNote(mode: ReturnType<typeof detectMode>, line: string): void {
  if (mode === "json") sayErr(line);
  else out(line, mode);
}

async function restartApp(
  args: string[],
  flags: GlobalFlags,
): Promise<{ appId: string; unsaved?: string }> {
  const mode = detectMode(flags);

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
  // Same target resolver as `stop` and `kill` — `--port=N` names the app.
  const t = resolveLockTarget(flags);
  if (t.kind === "probe") {
    outError(noLockOnPortMessage(t.port), mode);
    Deno.exit(1);
  }
  const appId = t.kind === "target"
    ? t.target.appId
    : resolveAmAppId(flags.app);
  const pf = t.kind === "target" ? t.target.pf : null;
  const running = pf !== null && isLockOwnerAlive(pf);

  // `am backup` / `am restore` holding the lock: nothing to restart, and the
  // start half would be refused anyway — refuse FIRST, before any
  // "restart: …" note announces a relaunch that is not going to happen.
  if (pf && running && maintenanceOp(pf)) {
    outError(maintenanceMessage(appId, pf), mode);
    Deno.exit(1);
  }
  // …and another apps root's app is not this `am`'s to restart: said first,
  // by its own reason (`stopOne` would refuse it after the notes).
  const otherRoot = pf && running ? otherRootRefusal("restart", pf) : null;
  if (otherRoot) {
    outError(otherRoot, mode);
    Deno.exit(1);
  }

  // Restarting an instance started from ANOTHER checkout of this app relaunches
  // it from HERE — a different tree, possibly a different framework pin. It
  // used to do that silently: `am restart` in checkout B stopped A's process
  // and started B's, and nothing in the output said so. One lock per app id
  // means this is a real, reachable state (a worktree, a second clone).
  const elsewhere = pf && running ? foreignCheckout(pf) : null;
  if (elsewhere && !flags.force) {
    outError(
      `${appId} is running from ${elsewhere}, not this checkout ` +
        `(${projectRoot()}) — restarting here would stop that process and ` +
        `relaunch the app from this tree.\n` +
        `  am restart --force does exactly that, deliberately; ` +
        `am stop ends the running one; cd ${elsewhere} && am restart ` +
        `restarts it where it lives`,
      mode,
    );
    Deno.exit(1);
  }
  if (elsewhere) {
    restartNote(
      mode,
      `restart --force: switching checkouts — ${elsewhere} → ${projectRoot()}`,
    );
  }

  // Preserve the original launch across restart (a field report:
  // restart dropped --env-file → the vault stopped auto-unlocking). Explicit
  // flags on THIS `am restart` win; otherwise replay what start recorded.
  // Words after a bare `--` are the app's, kept verbatim with the marker.
  const end = args.indexOf("--");
  const head = end === -1 ? args : args.slice(0, end);
  const explicit = [
    ...head.filter((a) => a.startsWith("--")),
    ...(end === -1 ? [] : args.slice(end)),
  ];
  const recorded = readLaunchInfo(appId);
  let launchArgs = args;
  if (recorded && recorded.flags.length > 0) {
    const merged = mergeLaunchFlags(recorded.flags, explicit);
    launchArgs = [...head.filter((a) => !a.startsWith("--")), ...merged.launch];
    if (merged.replayed.length > 0) {
      restartNote(
        mode,
        `restart: replaying original flags — ${merged.replayed.join(" ")}` +
          (merged.overridden.length
            ? ` (overridden here: ${merged.overridden.join(" ")})`
            : ""),
      );
    }
  } else if (explicit.length === 0) {
    if (!recorded && running) {
      // Started outside am (e.g. `deno task dev`) → we never captured its
      // flags. Said only when there IS an instance: with nothing running there
      // is no launch to have missed. Used to be an `{error}` document (two
      // documents, one of them a lie); then a note document on stdout (still
      // two documents next to the start result). `restartNote` keeps the
      // sentence without a second JSON document.
      restartNote(
        mode,
        `restart: can't recover the original launch flags (e.g. ` +
          `--env-file) — this instance wasn't started by \`am start\`. ` +
          `Relaunching with defaults; pass the flags to \`am restart …\` ` +
          `to record them.`,
      );
    }
  }

  // …and the start ENVIRONMENT that decides where data lives (jot §9): an
  // instance started with `XDG_DATA_HOME=…` came back on the user's real
  // data, silently. Replayed for the child, and said; a variable that
  // decides where am itself FINDS the app is never moved under it — said.
  const env = envReplay(recorded?.env, Deno.env.toObject());
  if (Object.keys(env.set).length) {
    restartNote(
      mode,
      `restart: replaying the start env — ${envWords(env.set)}`,
    );
  }
  if (env.notReplayed.length) {
    restartNote(
      mode,
      `restart: env not replayed: ${
        env.notReplayed.map((k) =>
          `${k} (started with ${recorded!.env![k] ?? "unset"}, now ${
            Deno.env.get(k) || "unset"
          })`
        ).join(", ")
      } — it decides where am finds the app; run am restart with the start ` +
        `value to match`,
    );
  }
  if (recorded && !recorded.env && running) {
    restartNote(
      mode,
      `restart: env not replayed — an older am started this instance and ` +
        `did not record its environment (XDG_DATA_HOME, …); this restart ` +
        `uses the current one`,
    );
  }

  // The START is decided — and checked — BEFORE anything is stopped. The
  // entry `am start` recorded is replayed (see restartEntry), and a launch
  // that cannot start is refused with the app still UP: stopping first and
  // failing the start after left it down, with only a start error to show.
  const re = restartEntry(flags.entry, recorded, projectRoot(), (p) => {
    try {
      return Deno.statSync(p).isFile;
    } catch {
      return false; // aio-ok: missing — reported below as `gone`
    }
  });
  if (re.gone) {
    restartNote(
      mode,
      `restart: the recorded entry ${re.gone} is gone — relaunching with ` +
        `the project's default entry`,
    );
  }
  if (re.entry !== undefined) flags = { ...flags, entry: re.entry };
  {
    const cannot = entryRefusal(flags.entry) ?? appFlagRefusal(flags) ??
      headlessRefusal(await effectiveClient(launchArgs));
    if (cannot) {
      outError(
        running
          ? `${appId} was NOT restarted (still running, untouched) — it ` +
            `could not be started again: ${cannot}`
          : cannot,
        mode,
      );
      Deno.exit(1);
    }
  }

  let unsaved: string | undefined;
  // The port the app bound LAST time — reused when nothing declares one and
  // it is still free, so a restart keeps the address a human's tab (and an
  // agent's script) is pointed at. `deno task dev` keeps its port across a
  // restart; `am restart` moved the app to a new free one (55095 → 51159,
  // measured) and every open tab died with it.
  const lastPort = pf && running && t.kind === "target" && pf.port > 0
    ? pf.port
    : undefined;
  if (pf && running && t.kind === "target") {
    const port = pf.port;
    // Stop must complete before start — force --wait internally. `stopOne`
    // directly, not `cmdStop`: the verdict it takes (`finalPersistVerdict`,
    // BEFORE the door closes) has to come back HERE, where the restart goes
    // on and the exit code is decided last — `cmdStop` decides its own and
    // exits, and under `quiet` it said nothing first.
    const stopped = await stopOne(t.target, {
      ...flags,
      wait: flags.wait ?? STOP_WAIT_DEFAULT_S,
    });
    if (!stopped.ok) {
      outError(stopped.error, mode);
      Deno.exit(1);
    }
    unsaved = stopped.unsaved;
    // Said NOW, then the restart proceeds — the new process boots from the
    // state that IS on disk. Pretty prints on stdout; `--json` on stderr so
    // the start's one document stays alone (exit 1 still carries the verdict).
    if (unsaved) {
      restartNote(
        mode,
        `stopped ${appId}\n  ⚠ NOT SAVED — ${unsaved}`,
      );
    }
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
  await cmdStart(launchArgs, flags, {
    ...(lastPort !== undefined ? { reusePort: lastPort } : {}),
    peerOf: { stopped: pf && running ? pf.pid : undefined },
    env: env.set,
  });
  return unsaved === undefined ? { appId } : { appId, unsaved };
}

/** Which directory `am watch` watches — the first POSITIONAL argument.
 *
 *  `watch` is a PASSTHROUGH verb (its surplus flags are forwarded to the app,
 *  exactly as `start`'s are), so the central unknown-flag gate does not run for
 *  it — and `args[0]` used to be taken as the directory whatever it was:
 *  `am watch --zzz` answered `{"watching":"--zzz"}` and then watched nothing.
 *  A flag is never a path. Pure, so both readings are a unit test. */
export function watchTargetDir(args: readonly string[]): string {
  return args.find((a) => !a.startsWith("-")) ?? "src";
}

/** File extensions a change to which restarts the app.
 *
 *  `.tsx` is included even though the dev server hot-reloads client JSX over
 *  the WebSocket: `am watch`'s contract is "restart on a source change", a
 *  restart delivers the new UI too, and a rule that silently exempts half the
 *  extensions in its own help line is the defect this command already had. */
const WATCH_EXT = new Set([".ts", ".tsx"]);

export async function cmdWatch(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appId = resolveAmAppId(flags.app);
  const watchDir = watchTargetDir(args);

  // A directory that is not there is refused, not reported as watched. This
  // accepted any string — `am watch /definitely/not/a/dir` printed
  // `{"watching":"/definitely/not/a/dir"}` and hung forever.
  let dirOk = false;
  try {
    dirOk = Deno.statSync(watchDir).isDirectory;
  } catch {
    // aio-ok: a missing or unreadable path IS the refusal below, which names
    // it and the cwd — re-raising the raw stat error says less.
  }
  if (!dirOk) {
    outError(
      `am watch: "${watchDir}" is not a directory (cwd: ${Deno.cwd()}). ` +
        `Pass the directory to watch, e.g. \`am watch src\`.`,
      mode,
    );
    Deno.exit(1);
  }

  // Start initially if not already running
  if (!liveLock(appId)) await cmdStart([], flags); // never a double start

  out(
    mode === "pretty"
      ? `watching ${watchDir}/ for .ts/.tsx changes — restarting on save…`
      : { watching: watchDir, extensions: [...WATCH_EXT], appId },
    mode,
  );

  // Coalesce the burst an editor save produces (write + rename + chmod, often
  // several files) into ONE restart, and never overlap two restarts: a save
  // during a restart schedules the next one instead of racing it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restarting = false;
  let again = false;
  const restart = async () => {
    if (restarting) {
      again = true;
      return;
    }
    restarting = true;
    try {
      do {
        again = false;
        // `restartAll`, not `cmdRestart`: a refused final write is printed
        // (NOT SAVED) and the app still comes back up — but it must not end
        // the watch, which is what `cmdRestart`'s exit 1 would do.
        await restartAll([], flags);
      } while (again);
    } catch (e) {
      // A failed restart leaves the OLD app running (or none) — either way the
      // watch keeps going, because the next save is the fix.
      outError(`am watch: restart failed — ${e}`, mode);
    } finally {
      restarting = false;
    }
  };

  for await (const ev of Deno.watchFs(watchDir, { recursive: true })) {
    if (ev.kind === "access") continue;
    const hit = ev.paths.find((p) => {
      const dot = p.lastIndexOf(".");
      return dot >= 0 && WATCH_EXT.has(p.slice(dot));
    });
    if (!hit) continue;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void restart();
    }, WATCH_DEBOUNCE_MS);
  }
}
