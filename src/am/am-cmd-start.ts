// am start — the command, singleton enforcement before it, its refusals,
// waiting for the child to come up (lock, door, log), and every line it
// prints while waiting or on failure. Split out of am-cmd-process.ts, which
// re-exports every name here, so no importer changes.

import { readDenoJson } from "../server/deno-json.ts";
import {
  AppLock,
  HANDOFF_ENV,
  heldLockLine,
  instances,
  isLockOwnerAlive,
  isOwnLock,
  isPortInUse,
  isProcessAlive,
  isSocketAlive,
  killProcess,
  lockDir,
  lockKey,
  ownerIdentity,
  probeEndpoint,
  removeLockIfOwner,
  replaceLockIf,
  resolveAppId,
  STARTUP_GRACE_MS,
  STUCK_STARTING_MS,
  writeLaunchInfo,
  zombieVerdict,
} from "../server/single-instance-lock.ts";
import type { LaunchInfo, LockData } from "../server/single-instance-lock.ts";
import { basename, dirname, isAbsolute, join, resolve } from "@std/path";
import { projectRoot } from "./am-project.ts";
import {
  appDirs,
  appHome,
  appsDirEnv,
  foreignAppHomeError,
  homeOwnerError,
  profileOfHome,
  registerAppDirs,
  registeredProfile,
  reservedAppHomeError,
} from "../server/app-dirs.ts";
import { declaredMaxHeapOf } from "../server/heap-policy.ts";
import type { GlobalFlags } from "./am-types.ts";
import { STDOUT_IS_LOG_ENV } from "../diagnostics/logger-format.ts";
import { runtimeSpelling } from "../server/aio-cli.ts";
import {
  amIsInteractive,
  displayChoice,
  planDisplay,
  readDisplayFlag,
  validDisplayChoice,
} from "./am-display.ts";
import { detectMode, out, outError, sayErr } from "./am-output.ts";
import {
  amLockKey,
  declaredPort,
  inInstancesHint,
  liveLock,
  maintenanceMessage,
  maintenanceOp,
  printable,
  readEntryConfig,
  readPid,
  removePid,
  resolveAmAppId,
  resolveEntry,
  runningApps,
  runningInstancesOf,
  sharedLockStartRefusal,
} from "./am-utils.ts";
import {
  componentLaunchArgs,
  componentPort,
  processPlan,
  projectComponents,
} from "./am-components.ts";
import { captureLaunchEnv, dropFreshHome, withEnv } from "./am-instance.ts";
import { resolveControlPort } from "./am-http.ts";
import {
  buildDenoArgs,
  detachedSpawnSpec,
  entryTaskWords,
  HEALTH_TIMEOUT_MS,
  launchDetached,
  POLL_INTERVAL_MS,
  prepareStdoutLog,
  QUICK_TIMEOUT_MS,
  SINGLETON_WAIT_MS,
  SPAWN_LIVENESS_GRACE_MS,
  stdoutLogPath,
} from "./am-launch.ts";
import {
  alreadyRunningFix,
  alreadyRunningLine,
  foreignCheckout,
  notAnsweringLine,
} from "./am-cmd-stop.ts";

/** Ensure no other instance of this app is running. Kills zombies, waits for
 *  stopping — and ATTACHES to one that is still booting: with `attach` (the
 *  caller's flags) a live, progressing `starting` instance is waited for the
 *  way `am start` waits for its own child, and this call never returns. */
export async function ensureSingleton(
  appId: string,
  mode: import("./am-types.ts").OutputMode,
  attach?: GlobalFlags,
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

  // Another apps root's app, under a lock folder this root shares (two
  // `--instance` names that differ only in punctuation): never this scope's
  // to wait for, attach to or reclaim — refused, naming whose it is.
  const shared = sharedLockStartRefusal(pf);
  if (shared) {
    outError(shared.error, mode, shared.fix);
    Deno.exit(1);
  }

  // `am backup` / `am restore` holding the lock (`maintenanceMark`): not an
  // app, so neither "stuck" nor a zombie — it read as a door-less `started`
  // lock below and was SIGTERMed mid-copy. Wait for it; never kill it.
  if (maintenanceOp(pf)) {
    outError(maintenanceMessage(appId, pf), mode);
    Deno.exit(1);
  }

  // A dev session WAITING for a fix: alive, nothing bound, and it will stay
  // that way until the next save — neither booting (waiting on it can only
  // time out) nor stuck (reclaiming it killed a live dev session). Say what
  // broke, as a failed start of our own would.
  const waiting = waitingOf(pf);
  if (waiting) {
    outError(
      waitingMessage(appId, pf.pid, waiting, waitingSaid(appId, waiting.since)),
      mode,
    );
    Deno.exit(1);
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
    while (Date.now() < deadline && isLockOwnerAlive(pf)) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (isLockOwnerAlive(pf)) {
      await killProcess(pf.pid, 0, pf); // already waited, go straight to SIGKILL
    }
    removePid(appId, pf);
    return;
  }

  if (pf.status === "starting") {
    // A booting app is not a stuck one. Three facts decide that, and all
    // three used to be ignored: the runtime's own grace (`STARTUP_GRACE_MS`
    // — the same number `AppLock.acquire` honours), whether there is a door
    // to probe at all (`am start` writes the placeholder lock with `port: 0`
    // when the app declared none, so a probe went to 127.0.0.1:0, failed by
    // definition, and a second `am start` during boot SIGTERMed the first),
    // and — the one that cost the most — whether anything is LISTENING yet.
    // A cell module that takes 15 s to import has bound nothing at 10 s; the
    // next `am start` called that "stuck", killed it, and spawned another
    // that it would kill in turn. An agent re-running on exit 1 killed the
    // app every 10 s forever (h7 F2, measured).
    //
    // The rule now: alive and nothing bound is BOOTING until neither the lock
    // nor the app's own log has moved for `STUCK_STARTING_MS`; a booting
    // instance is attached to, never killed. And something LISTENING on its
    // port that does not answer is never ended by am either — the same rule
    // as a `started` one below: a listener is a live process, and a port
    // that answers a connect is not even proof the listener is this app's.
    // It is refused, saying so, and the user ends it (`am stop`/`am kill`).
    const probePort = pf.trojanPort ?? pf.port;
    const pastGrace = Date.now() - pf.startedAt >= STARTUP_GRACE_MS;
    const listening = probePort > 0
      ? await isPortInUse(probePort)
      : pf.socketPath
      ? await isSocketAlive(pf.socketPath)
      : false;
    if (listening && pastGrace) {
      let responds = !(probePort > 0); // a live socket IS the answer
      if (probePort > 0) responds = await doorAnswers(probePort);
      if (responds) {
        // It's actually started — refuse
        outError(alreadyRunningLine(pf), mode, alreadyRunningFix());
        Deno.exit(1);
      }
      outError(notAnsweringLine(pf), mode);
      Deno.exit(1);
    }
    if (
      !listening &&
      bootStalled(pf.startedAt, logMtime(stdoutLogPath(appId)))
    ) {
      // Alive, nothing bound, and neither the lock nor the log has moved for
      // STUCK_STARTING_MS — hung before it could listen. Reclaim.
      out(
        mode === "pretty"
          ? `killing stuck instance (pid ${pf.pid}, status: starting, ` +
            `nothing listening and no log progress for ${
              STUCK_STARTING_MS / 1000
            }s)…`
          : { killing: pf.pid, reason: "stuck-starting" },
        mode,
      );
      await killProcess(pf.pid, undefined, pf);
      removePid(appId, pf);
      return;
    }
    // Booting. Wait for it the way `am start` waits for its own child; a
    // caller that opted out of waiting is told, and told the truth.
    if (!attach || attach.noWait) {
      outError(
        `already starting: ${appId} (pid ${pf.pid}) — am status follows ` +
          `it, or \`am start\` (without --no-wait) waits for it`,
        mode,
      );
      Deno.exit(1);
    }
    sayErr(`am: note: still starting (pid ${pf.pid}) — waiting`);
    await awaitStarted({
      appId,
      pid: pf.pid,
      declared: pf.port > 0 ? pf.port : undefined,
      port: pf.port,
      flags: attach,
      mode,
    });
    Deno.exit(0);
  }

  // status='started' — verify it's actually responding
  let responds = await doorAnswers(pf.trojanPort ?? pf.port);
  // The same fallback `am status` carries (see its comment): a prod+UDS app
  // listens on its Unix socket and NOWHERE else, so the TCP probe above can
  // never succeed for it. Without this, single-instance protection was
  // INVERTED for that transport — `am start` never refused, it killed the
  // healthy running instance every time, while `am status` reported it up.
  if (!responds && pf.socketPath) {
    responds = await isSocketAlive(pf.socketPath);
  }
  // ONE look that finds no answer is not a zombie. An app's record says
  // `started` a moment before its listener is bound (measured: 56 ms on a
  // desktop app), and killing on that look ended a healthy app that had just
  // come up. THE rule is the lock's own (`zombieVerdict`): a settled record,
  // and nothing listening through several attempts seconds apart. Anything
  // less is a running app.
  const verdict = responds
    ? null
    : await zombieVerdict(lockKey(pf.appId, pf.home, pf.profile), pf);
  if (verdict === null || verdict === "moved") {
    // Not answering, and something IS at the address its record names: say
    // that. Otherwise (a record just written, or one that names no address)
    // it is simply running.
    const at = responds ? null : await probeEndpoint(pf);
    const there = at !== null && at.state !== "gone";
    if (there) outError(notAnsweringLine(pf), mode);
    else outError(alreadyRunningLine(pf), mode, alreadyRunningFix());
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

/** The `--profile=` a started child gets: the NAME when one was given (so the
 *  runtime derives the home exactly as it would for `deno task dev
 *  --profile=dev`), else the targeted folder as an absolute path; nothing
 *  for the app's own home. Pure but for the registry read. */
export function profileArg(appId: string, flags: GlobalFlags): string | null {
  if (flags.profile === undefined && flags.home === undefined) return null;
  const home = appDirs(appId).home;
  const name = registeredProfile(appId) ?? profileOfHome(appId, home);
  if (name !== undefined) return `--profile=${name}`;
  if (resolve(home) === resolve(appHome(appId))) return null;
  return `--profile=${home}`;
}

/** What a project-wide `start`/`restart` got through, said when one
 *  component's failure ends the command. `cmdStart` refuses by EXITING, so
 *  the loop over the rest never ran and nothing said which components were
 *  up, which failed and which were never tried — a project half up, reported
 *  as one component's error. Said from `unload` (which `Deno.exit` fires);
 *  `end()` disarms it once every component went through. */
export function componentProgress(
  verb: "start" | "restart",
  labels: readonly string[],
): { done(): void; end(): void } {
  let i = 0;
  const onUnload = () => {
    const line = componentProgressLine(verb, labels, i);
    if (line) sayErr(line);
  };
  globalThis.addEventListener("unload", onUnload);
  return {
    done: () => void i++,
    end: () => globalThis.removeEventListener("unload", onUnload),
  };
}

/** The line for a project-wide `verb` that ended at `labels[failed]`, or null
 *  when there is nothing to add (a single component). Pure. */
export function componentProgressLine(
  verb: "start" | "restart",
  labels: readonly string[],
  failed: number,
): string | null {
  if (labels.length < 2 || failed >= labels.length) return null;
  const ed = verb === "start" ? "started" : "restarted";
  const up = labels.slice(0, failed);
  const rest = labels.slice(failed + 1);
  return `am: warning: the project is NOT fully up — ${verb} failed at ` +
    `"${labels[failed]}"` +
    (up.length ? `; ${ed}: ${up.join(", ")}` : "") +
    (rest.length ? `; not attempted: ${rest.join(", ")}` : "") +
    ` (am ${verb} <component> for one)`;
}

/** `am start`'s refusal for an entry that does not resolve, or null. THE
 *  one wording — `am restart` asks it BEFORE it stops anything. */
export function entryRefusal(flagEntry?: string): string | null {
  if (resolveEntry(flagEntry)) return null;
  return flagEntry
    ? `entry not found: ${flagEntry}`
    : 'no src/app.ts found — add "entry" to deno.json or use --entry=<path>';
}

/** `am start`'s refusal for an `--app` that names no app of this project, or
 *  null. The child runs the project's entry, which takes its OWN id: `--app=
 *  nope` ran the project's app under a second lock named `nope`, and with
 *  `--fresh` named the throwaway home after `nope`, so stop never dropped it.
 *  Null wherever am cannot know the id the entry runs as — an explicit
 *  `--entry` (a component's, or the user's choice), a project of components,
 *  a computed `appId`, no entry. */
export function appFlagRefusal(
  flags: Pick<GlobalFlags, "app" | "entry">,
  root = projectRoot(),
): string | null {
  if (flags.app === undefined || flags.entry !== undefined) return null;
  // A project of components: `processPlan` already matched `--app` against
  // them, and what its default entry runs as is the runtime's own rule.
  if (projectComponents(root).length > 0) return null;
  const entry = resolveEntry();
  if (!entry) return null;
  let src: string;
  try {
    src = Deno.readTextFileSync(entry);
  } catch {
    return null; // aio-ok: unreadable — entryRefusal / the child say so
  }
  const literal = readEntryConfig().appId;
  if (!literal && /\bappId\b/.test(src)) return null;
  let ids: string[];
  try {
    ids = [resolveAmAppId()];
  } catch {
    return null; // aio-ok: no id to compare — the child decides
  }
  if (literal) ids = [...new Set([...ids, resolveAppId(literal)])];
  if (ids.includes(resolveAmAppId(flags.app))) return null;
  return `--app=${printable(flags.app)} names no app of this project ` +
    `(${root}) — its entry runs as ${ids.join(", ")}: am start ` +
    `--app=${ids[0]}, or no --app`;
}

/** The client a launch with these flags runs: `--client=` first, else the
 *  app's declared one; undefined = the framework default (a browser). */
export async function effectiveClient(
  flags: readonly string[],
): Promise<string | undefined> {
  const arg = flags.find((a) => a.startsWith("--client="))?.slice(9);
  if (arg) return arg;
  try {
    const dj = ((await readDenoJson(projectRoot()))?.config ?? {}) as {
      client?: string;
    };
    return dj.client;
  } catch {
    return undefined; // aio-ok: no deno.json client — the framework default
  }
}

const isGuiClient = (c: string | undefined): boolean =>
  c === "electron" || c === "client";

/** A GUI client on a headless box hangs forever (electron never returns) —
 *  the refusal with the fix, or null (a field report). */
export function headlessRefusal(effective: string | undefined): string | null {
  const headless = Deno.build.os === "linux" &&
    !Deno.env.get("DISPLAY") && !Deno.env.get("WAYLAND_DISPLAY");
  return isGuiClient(effective) && headless
    ? `client "${effective}" needs a display and this box has none ` +
      `(no DISPLAY/WAYLAND_DISPLAY) — electron would hang forever. ` +
      `Use: am start --client=browser (or --client=server-only)`
    : null;
}

/** The entry `am restart` relaunches: an explicit `--entry` wins; else the
 *  one `am start` RECORDED (resolved against the recorded cwd — `am start
 *  --entry=app.ts` recorded it relative), when it is still there; else
 *  undefined — the project's default, as `am start` resolves it. Replaying
 *  only the flags dropped a `--entry`, and the restart (having already
 *  stopped the app) failed "no src/app.ts found": the app left DOWN. */
export function restartEntry(
  explicit: string | undefined,
  recorded: { entry?: string; cwd?: string } | null,
  root: string,
  exists: (p: string) => boolean,
): { entry?: string; gone?: string } {
  if (explicit !== undefined) return { entry: explicit };
  if (!recorded?.entry) return {};
  const abs = resolve(recorded.cwd ?? root, recorded.entry);
  return exists(abs) ? { entry: abs } : { gone: abs };
}

export async function cmdStart(
  args: string[],
  flags: GlobalFlags,
  /** `reusePort`: the port this app bound LAST time (a restart) — used when
   *  nothing declares one and it is still free, so a restart does not move
   *  the app and kill every open tab. Never recorded: a later restart asks
   *  the same question again, and a taken port falls back to a free one.
   *  `peerOf`: a RESTART's start — the pid it stopped (none when nothing was
   *  running). A child refused because another launch of this same identity
   *  took the lock first is then judged by that instance (see
   *  {@linkcode racingPeer}), not reported as a start that failed. */
  opts?: {
    reusePort?: number;
    peerOf?: { stopped?: number };
    /** A restart's replayed start env (am-instance.ts `envReplay`): applied
     *  on top of this process's env for the child; null unsets. */
    env?: Record<string, string | null>;
  },
): Promise<void> {
  const mode = detectMode(flags);

  // `start` forwards its surplus flags to the app, so the per-verb flag gate
  // never sees this one — and a `--display=` we cannot read must be refused
  // here rather than falling through to `auto`. Silently ignoring the one
  // flag whose entire job is "keep off my desktop" is the worst failure
  // available to it: the caller believes they asked, and the window opens on
  // the human's screen anyway.
  {
    const raw = readDisplayFlag(args) ??
      (Deno.env.get("AIO_AM_DISPLAY") || null);
    if (raw !== null && !validDisplayChoice(raw)) {
      outError(
        `--display=${raw} is not a display choice`,
        mode,
        "auto (contain only a non-interactive launch) · isolated · " +
          "current (change nothing) · :N (a display you manage)",
      );
      Deno.exit(1);
    }
  }

  /** `--app` came from a positional that named a RUNNING app — not this
   *  project's to judge: the lock below answers "already running". */
  let runningNamed = false;
  // A project can be more than one app. When it says so — labelled build
  // targets with their own entries — `am start` means the PROJECT and
  // `am start <label>` means one component of it. Ordinary repos never take
  // this branch (see `processPlan`), so nothing about them changes.
  {
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
    // processPlan. Without this the plan is right and the command still acts
    // on the wrong app, which is worse than the refusal it replaced.
    if (plan.kind === "single" && plan.appId) {
      flags = { ...flags, app: plan.appId };
      runningNamed = true;
    }
    if (plan.kind === "one" || plan.kind === "all") {
      const list = plan.kind === "one" ? [plan.component] : plan.components;
      const progress = componentProgress("start", list.map((c) => c.label));
      for (const c of list) {
        const port = componentPort(c);
        await cmdStart(
          componentLaunchArgs(c, args.filter((a) => a.startsWith("-"))),
          {
            ...flags,
            app: c.appId,
            ...(port !== undefined ? { port } : {}),
            entry: c.entry,
          },
        );
        progress.done();
      }
      progress.end();
      return;
    }
  }
  {
    const bad = runningNamed ? null : appFlagRefusal(flags);
    if (bad) {
      outError(bad, mode);
      Deno.exit(1);
    }
  }
  const appId = resolveAmAppId(flags.app);
  // The port this app DECLARED, or undefined — in which case the runtime picks
  // a free one exactly as `deno task dev` does, and `am` reads it back from the
  // lock the app writes. `am` inventing 8000 here made the two commands
  // disagree about the same app, and made `am start` refuse over a port the app
  // was never going to bind.
  const declared = declaredPort(
    flags.port,
    args.find((a) => a.startsWith("--client="))?.slice(9),
  );
  let reused: number | undefined;
  if (declared === undefined && opts?.reusePort) {
    if (await isPortInUse(opts.reusePort)) {
      sayErr(
        `am: note: port ${opts.reusePort} (the one this app bound before) ` +
          `is taken now — the app picks a free one`,
      );
    } else reused = opts.reusePort;
  }
  // 0 = "not decided yet", for the placeholder lock
  const port = declared ?? reused ?? 0;

  // `--fresh` (am.ts bound its home): a fresh home LEFT by a run that was
  // never stopped (a crash, `am stop --no-wait`, a reboot) is thrown away
  // FIRST — unless its app is still running there, which ensureSingleton
  // below refuses as "already running", data untouched.
  if (flags.fresh && flags.instance !== undefined) {
    const pf = liveLock(appId);
    if (!pf || !isLockOwnerAlive(pf)) {
      const failed = dropFreshHome(flags.instance, appId);
      if (failed) {
        outError(`--fresh: ${failed} — nothing was started`, mode);
        Deno.exit(1);
      }
    }
  }

  // A REQUESTED home (`--profile`, `--home`) is checked BEFORE am writes
  // anything into it — the same refusals the child makes. Written first, a
  // launch.json or a logs/ dir made a foreign folder look like an aio app's
  // (and so pass the child's own check), and overwrote another app's.
  const requested = flags.profile !== undefined || flags.home !== undefined;
  if (requested) {
    const dirs = appDirs(appId);
    const refusal = foreignAppHomeError(appId, dirs.home) ??
      reservedAppHomeError(appId, dirs.home) ??
      homeOwnerError(dirs, appId, registeredProfile(appId));
    if (refusal) {
      outError(
        flags.home !== undefined
          ? refusal.replaceAll("--profile=<name>", "--home=<other dir>")
          : refusal,
        mode,
      );
      Deno.exit(1);
    }
  }

  // Clean up stuck/zombie instances before acquiring lock — or ATTACH to one
  // that is still booting (this returns only when there is nothing to attach
  // to; see ensureSingleton).
  await ensureSingleton(appId, mode, flags);

  // `--profile=<name|path>` / `--home=<dir>`: the data home was bound by
  // `targetHome` (am.ts) before anything read a lock, so the placeholder
  // below is filed under the key the child will use — and the child is TOLD
  // (see `profileArg`), so it boots there.
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
  const lock = new AppLock(appId, home, registeredProfile(appId));
  // The child is handed this secret (`HANDOFF_ENV`) and takes the lock over
  // with it — the only proof it is the child this lock was filed for.
  const handoff = crypto.randomUUID();
  const result = await lock.acquire(port, false, { handoff });
  if (!result.ok) {
    lock.release();
    if (result.held !== undefined) {
      outError(heldLockLine(appId, result.existing, result.held), mode);
    } else {
      const shared = sharedLockStartRefusal(result.existing);
      if (shared) outError(shared.error, mode, shared.fix);
      else {
        outError(
          alreadyRunningLine(result.existing),
          mode,
          maintenanceOp(result.existing) ? undefined : alreadyRunningFix(),
        );
      }
    }
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
          }" — stop it first, or run this one on --port=0 (a free port) ` +
            `— a profile of a fixed-port app needs its own`,
          mode,
        );
      } else if (!trojan.ok && trojan.error === "auth") {
        outError(
          `port ${port} in use by an aio app that requires a key (it answered ` +
            `the probe with 401) — stop it first, or use --port=0 (a free ` +
            `port)`,
          mode,
        );
      } else {
        outError(
          `port ${port} in use by another process — use --port=0 (a free ` +
            `port) or --port=N`,
          mode,
        );
      }
      Deno.exit(1);
    } catch { /* port free — good */ }
  }

  // Resolve entry point — --entry flag > deno.json "entry" > src/app.ts
  const entry = resolveEntry(flags.entry);
  if (!entry) {
    outError(entryRefusal(flags.entry)!, mode);
    Deno.exit(1);
  }

  // Pass through any extra args (--port, --verbose, --transport, --client
  // etc.). Re-inject --port if it was consumed by the global flag parser.
  // `--display=` is AM's (where the window goes), not the app's. `start` is a
  // PASSTHROUGH verb, so anything left here reaches the child as one of its
  // own flags — an app that does not know `--display` would refuse to boot.
  // A build word that picks a client (`--headless`) is translated to its
  // runtime spelling — the app itself refuses the build word.
  const passthrough = args.filter((a) =>
    a.startsWith("--") && !a.startsWith("--display=")
  ).map((a) => runtimeSpelling(a) ?? a);
  // A GUI client on a headless box hangs forever (electron never returns) —
  // fail FAST with the fix instead (a field report). The
  // effective client is the --client override, else the app's declared target.
  let gui = false;
  /** The client this launch runs, when known: `--client=` first, else the
   *  app's declared one. `undefined` = the framework default (a browser). */
  let effective: string | undefined;
  {
    effective = await effectiveClient(passthrough);
    gui = isGuiClient(effective);
    const headless = headlessRefusal(effective);
    if (headless) {
      outError(headless, mode);
      Deno.exit(1);
    }
  }
  if (flags.port && !passthrough.some((a) => a.startsWith("--port="))) {
    passthrough.push(`--port=${flags.port}`);
  }
  // The profile, as ARGV — never env-only: a runtime older than profiles then
  // REFUSES the unknown flag, where an ignored variable would boot it on the
  // app's real data. Recorded in launch.json below, so `am restart` replays it.
  {
    const pa = profileArg(appId, flags);
    const i = passthrough.findIndex((a) => a.startsWith("--profile="));
    // A REPLAYED `--profile=<dir>` naming the home am is bound to (a restart
    // that followed the running instance, `adoptRunningHome`) is that
    // instance's own: dropping it relaunched a `--home`/`--fresh` instance on
    // the scope's default home — off its data.
    const own = i !== -1 && !pa &&
      isAbsolute(passthrough[i]!.slice(10)) &&
      resolve(passthrough[i]!.slice(10)) === resolve(appDirs(appId).home);
    if (i !== -1 && !own) passthrough.splice(i, 1);
    if (pa) passthrough.push(pa);
  }
  if (
    flags.transport && !passthrough.some((a) => a.startsWith("--transport="))
  ) {
    passthrough.push(`--transport=${flags.transport}`);
  }
  // Record the launch so `am restart` can replay it — the running app can't
  // recover deno-runtime flags (esp. --env-file) from its own Deno.args.
  // The PROJECT root, not the cwd: `am start` from a subdirectory launches
  // the app the way `deno task dev` at the root would, and records that.
  // Recorded BEFORE a reused port joins: that port is this restart's answer,
  // not the app's declaration.
  const cwd = projectRoot();
  // The child's environment before containment — what it is started with,
  // and (its data-location part) what `am restart` replays.
  const childEnv = withEnv(Deno.env.toObject(), opts?.env);
  const launchInfo: LaunchInfo = {
    flags: [...passthrough],
    entry,
    cwd,
    env: captureLaunchEnv(childEnv),
  };
  if (reused !== undefined) passthrough.push(`--port=${reused}`);
  // The command word this app's own `dev` task gives its entry (`serve`), in
  // FRONT of the flags — the cli scaffold routes on `Deno.args[0]`. Derived at
  // every launch rather than recorded: the launch info is REPLAYED by
  // `am restart`, where a positional would be read as a component label.
  const appCfg = ((await readDenoJson(cwd))?.config ?? {}) as
    & Record<
      string,
      unknown
    >
    & { tasks?: Record<string, string> };
  const words = entryTaskWords(appCfg.tasks?.dev, entry, cwd);
  // Deno-runtime flags before the entry script; app flags after it (see
  // buildDenoArgs) — a misplaced --env-file is silently ignored by Deno. The
  // declared heap ceiling rides along: only the launch can apply it.
  const denoArgs = buildDenoArgs(
    entry,
    [...words, ...passthrough],
    declaredMaxHeapOf(appCfg),
  );

  // Detached background spawn — the child must survive am's exit, its output
  // must land in the log file, and its real PID must come back on stdout. The
  // HOW is per-OS (sh/nohup does not exist on Windows — am start used to fail
  // there outright); detachedSpawnSpec builds the right command for each.
  // A requested home gets its stdout log BESIDE it until the child has
  // started (same file system, so it can be renamed in) — never inside it.
  const logFile = requested
    ? besideLog(appDirs(appId).home)
    : stdoutLogPath(appId);
  if (!requested) await prepareStdoutLog(logFile, passthrough);
  const spec = detachedSpawnSpec(Deno.build.os, denoArgs, logFile);
  // Where the window goes, and whether the app may open a tab in the human's
  // browser. `{}` unless something is actually being contained, so a human at
  // a terminal gets byte-for-byte the launch they got before (am-display.ts).
  const plan = planDisplay({
    choice: displayChoice(
      readDisplayFlag(args),
      Deno.env.get("AIO_AM_DISPLAY"),
    ),
    gui,
    interactive: amIsInteractive(),
    inheritedDisplay: Deno.env.get("DISPLAY"),
    inheritedXauthority: Deno.env.get("XAUTHORITY"),
    inheritedElectronArgs: Deno.env.get("AIO_ELECTRON_ARGS"),
    // A client that never opens a tab gets no "tabs suppressed" note — the
    // note is about what WOULD have happened, and for server-only nothing
    // would (a hunter read it as "my server-only app tried to open a tab").
    tabs: clientOpensTabs(effective),
  });
  if (plan.note) {
    // The level is part of the message, not decoration: "note:" is what
    // happened, "warning:" is "this did not work and your desktop is about to
    // be used". tests/every-message-has-a-level pins that every CLI
    // diagnostic says which.
    sayErr(
      plan.level === "warn"
        ? `am: warning: ${plan.note}`
        : `am: note: ${plan.note}`,
    );
  }
  let pid: number;
  try {
    pid = await launchDetached(spec, logFile, {
      // Inherited PLUS the containment decision. Spread, never replaced: the
      // child needs PATH, HOME and the user's own environment to boot at all.
      // And told that its stdout is a log FILE, so the `--expose` banner's
      // share-link token and pair code are masked there as in every other log
      // file (the key file the banner names still holds the key).
      env: {
        ...childEnv,
        ...plan.env,
        [STDOUT_IS_LOG_ENV]: "1",
        [HANDOFF_ENV]: handoff,
      },
      // THE cwd the launch record above claims — the same value, not a second
      // decision. Without it the child inherited am's OWN cwd: `cd src && am
      // start` recorded `cwd: <root>` in launch.json and the lock (which `am
      // restart`, `am doctor` and `foreignCheckout` read as where the app runs)
      // while the process actually ran from `<root>/src` — so a relative
      // `--db-path=data.db` or `--tls-cert=certs/x.pem` resolved one directory
      // below where every reader of the record said it would, and the state
      // landed in a file `am data`/`am backup` never looked at.
      cwd,
    });
  } catch (e) {
    lock.release();
    outError(e instanceof Error ? e.message : String(e), mode);
    Deno.exit(1);
  }

  // Recorded AFTER the spawn, with the child's pid and start stamp: that is
  // what lets `am instances` tell an instance am started (`startedBy`) — a
  // record naming no process could not. For a REQUESTED home, recorded only
  // once the child has STARTED — into the home its lock reports (see
  // `awaitStarted`): a refused boot leaves nothing.
  {
    const { startToken, startEpoch } = ownerIdentity(pid);
    Object.assign(launchInfo, { pid, startToken, startEpoch });
  }
  if (!requested) {
    const unrecorded = writeLaunchInfo(appId, launchInfo);
    if (unrecorded) sayErr(`am: warning: ${unrecorded}`);
  }

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
    const { text: tail, files } = childSaid(logFile);
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
            crashTail(tail).map((l) => `      ${l}`).join("\n")
          }\n`
          : `  it wrote nothing to ${
            Deno.build.os === "windows"
              ? `${logFile} or ${logFile}.err`
              : logFile
          }\n`) +
        (missingLink
          ? `  this clone has no dep/aio link (it is gitignored — every clone ` +
            `has to make its own).\n  fix: am fix\n`
          : "") +
        `  full log: ${(files.length ? files : [logFile]).join(" and ")}`,
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
    cwd,
    // `writeLock` keys by (appId, home) — omitting it filed this under the
    // DEFAULT instance's name. See the note on `home` above.
    home,
    // The CHILD's kernel start stamp, so a later `am stop` can tell this
    // process from a stranger that inherits its pid. The child overwrites this
    // lock with its own (which records the same thing); this covers the window
    // in between.
    ...ownerIdentity(pid),
  };
  writeStartPlaceholder(childLock, {
    ...lockData,
    // Every lock am writes carries the profile, so its key is the child's.
    ...(registeredProfile(appId) ? { profile: registeredProfile(appId) } : {}),
  });

  await awaitStarted({
    appId,
    pid,
    declared,
    port,
    flags,
    mode,
    logFile,
    peerOf: opts?.peerOf,
    onStarted: requested
      ? async (real) => {
        // The home the CHILD resolved — for an `appDir` app, `<appDir>-dev`,
        // not the `~/.<app>-dev` am computed.
        const home = real?.home ?? appDirs(appId).home;
        registerAppDirs(appId, appDirs(appId, home));
        const logs = appDirs(appId).logs;
        try {
          Deno.mkdirSync(logs, { recursive: true });
          const dest = join(logs, "stdout.log");
          await prepareStdoutLog(dest, passthrough);
          try {
            Deno.renameSync(logFile, dest);
          } catch {
            Deno.symlinkSync(logFile, dest); // another file system
          }
        } catch (e) {
          sayErr(`am: warning: the start log stays at ${logFile} (${e})`);
        }
        const unrecorded = writeLaunchInfo(appId, launchInfo);
        if (unrecorded) sayErr(`am: warning: ${unrecorded}`);
      }
      : undefined,
  });
}

/** The start log of a REQUESTED home: beside it (same file system, so it can
 *  be renamed in once the child started), never inside it. The parent — the
 *  apps root, `~` — is made if missing; the home itself is not. */
function besideLog(home: string): string {
  try {
    Deno.mkdirSync(dirname(home), { recursive: true });
  } catch { /* aio-ok: the redirect reports an unwritable parent */ }
  return join(dirname(home), `.${basename(home)}.am-start-${Deno.pid}.log`);
}

/** The lock of the child `am` spawned (`pid`): under the key am computed, or
 *  — for an app that chose its own home (`appDir`) — wherever it filed it. */
function childLockOf(appId: string, pid: number): LockData | null {
  const own = readPid(appId);
  if (own && own.pid === pid) {
    // Our placeholder, unless the child filed its real lock elsewhere.
    const real = instances(appId).find((i) =>
      i.pid === pid && lockKey(i.appId, i.home, i.profile) !== amLockKey(appId)
    );
    return real ?? own;
  }
  return instances(appId).find((i) => i.pid === pid) ?? own;
}

/** Is `l` the lock of the launch am made (`pid`)? That process's own — or,
 *  once a cell edit turned it into the dev supervisor, the app it supervises
 *  (`LockData.supervisor`). Anything else under the app's key is ANOTHER
 *  launch, whatever answers on the port. Pure. @internal */
export function _ofLaunch(
  l: Pick<LockData, "pid" | "ns" | "supervisor">,
  pid: number,
): boolean {
  return isOwnLock(l, pid) ||
    (l.supervisor !== undefined &&
      isOwnLock({ pid: l.supervisor, ns: l.ns }, pid));
}

/** Wait for `pid` — a child `am start` just spawned, or a booting instance it
 *  attached to — to answer, then print the verdict: `started` (returns), a
 *  crash (exit 1, with what the log said), or the truth about a wait that ran
 *  out (exit 1): alive but nothing listening yet is STILL STARTING, not "not
 *  responding" — the fault-shaped wording sent readers hunting a fault in an
 *  app that was 10 s into a 15 s boot while `am status` said `starting`. */
async function awaitStarted(o: {
  appId: string;
  pid: number;
  /** The port declared (or reused by a restart) — probed from the first
   *  tick; `undefined` = read it from the child's own lock. */
  declared: number | undefined;
  /** The placeholder lock's port (0 = none), the report's last fallback. */
  port: number;
  flags: GlobalFlags;
  mode: import("./am-types.ts").OutputMode;
  /** The child's stdout log, when not `stdoutLogPath(appId)`. */
  logFile?: string;
  /** Run once the child is up, with its real lock. */
  onStarted?: (real: LockData | null) => Promise<void>;
  /** A restart's start — see `cmdStart`'s `peerOf`. */
  peerOf?: { stopped?: number };
}): Promise<void> {
  const { appId, pid, declared, port, flags, mode } = o;
  const logPath = () => o.logFile ?? stdoutLogPath(appId);
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
  let timeout = (flags.wait || 10) * 1000;
  let healthy = false;
  const startedAt = Date.now();
  let deadline = startedAt + timeout;
  let slowStart: string | null = null;
  // The port to probe is whatever the CHILD bound, which it records in its own
  // lock — the only honest source when nothing was declared. Re-read on EVERY
  // tick, never latched: a socket-only app takes its lock with the TCP port it
  // might bind (`status: "starting"`) and rewrites it ~1 s later as
  // `port: 0, socketPath` — a latched first read probed a port nothing ever
  // listened on and reported a live app "not responding", exit 1 (cc §1).
  let livePort = declared;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (!isProcessAlive(pid)) break; // died early
    // A FIRST run downloads the Electron runtime (~100 MB, once per machine)
    // before the app can answer at all — 15 s on a fast line, minutes on a
    // slow one. `am start` gave up at 10 s with exit 1 and "not responding";
    // the window appeared seconds later, and an agent, reading exit 1 as
    // failure, started it AGAIN (cc §6). The child's own log says when that
    // is what it is doing; wait for it — bounded, announced, and only when
    // no explicit `--wait` was given (an explicit number is the caller's).
    //
    // Read on EVERY tick, never latched: the first look often lands while
    // Deno sets up a new app's packages, and holding the long wait from then
    // on gave an app that had since started — and then booted slowly, or
    // hung — 180 s under a note about a download that was over.
    if (!flags.wait) {
      // Both files: Deno's own lines are stderr, split off on Windows.
      const why = slowStartReason(
        readLogTail(logPath()),
        readLogTail(`${logPath()}.err`),
      );
      timeout = startWaitMs(
        slowStart,
        why,
        Date.now() - startedAt,
        timeout,
        10_000,
      );
      deadline = startedAt + timeout;
      if (why && why !== slowStart) {
        sayErr(
          `am: note: ${why} — waiting up to ${
            SLOW_START_WAIT_MS / 1000
          }s for it (--wait=N to change)`,
        );
      }
      slowStart = why;
    }
    {
      // Our own child's lock — and only if it IS our child's (same pid):
      // `childLockOf` falls back to whatever sits under the key.
      const found = childLockOf(appId, pid);
      const written = found && _ofLaunch(found, pid) ? found : null;
      // A SOCKET-ONLY app never binds a port, and `port: 0` is falsy — so
      // `livePort` never resolved, the loop always ran out, and `am start`
      // exited 1 with "not responding on port 0 after 10s" for a desktop app
      // (the default `--client=electron` shape) that had started perfectly.
      // `am start && am open` could not work at all. Its socket is the door;
      // ask that, exactly as `am status` and `am stop` already do.
      if (written?.socketPath && !written.port) {
        if (await isSocketAlive(written.socketPath)) {
          healthy = true;
          break;
        }
        continue; // listening not yet — keep waiting
      }
      livePort = written?.port || declared;
      if (livePort === undefined) continue; // no port chosen yet
    }
    if (await doorAnswers(resolveControlPort(livePort, appId), appId)) {
      // WHOSE door? A declared (or reused) port is answered by whichever
      // launch of this app serves there — its dev watcher relaunching, a
      // second `am start` — while our child is alive only until its own
      // acquire is refused; read as ours, the doomed child was reported as
      // the started app, pid and all. The lock says who holds the app, and
      // it is read AFTER the answer: an app takes its lock before it
      // listens, so whoever answered is in it by now. (Read before, it was
      // stale — a refused connect takes ~0.5 s on Windows, and the winner
      // locked and bound inside that one probe: measured, 10 runs in 10.)
      // Not ours: wait — the child exits (the verdict below names the
      // winner), or the holder goes and the child takes the lock.
      const holder = childLockOf(appId, pid);
      if (holder && !_ofLaunch(holder, pid) && isLockOwnerAlive(holder)) {
        continue;
      }
      healthy = true;
      break;
    }
  }

  if (healthy) {
    // Child's _run() should have updated the lock by now
    const updated = childLockOf(appId, pid); // our own child's lock
    // The child filed its lock under ANOTHER key (an `appDir` app): am's
    // placeholder under the computed key is a ghost — same pid — and goes.
    if (
      updated &&
      lockKey(updated.appId, updated.home, updated.profile) !== amLockKey(appId)
    ) {
      removeLockIfOwner(amLockKey(appId), { pid });
    }
    await o.onStarted?.(updated);
    if (updated && updated.status !== "started") {
      // CAS: only the record just read — never over a lock written since.
      replaceLockIf(updated, (now) => ({ ...now, status: "started" }));
    }
    // The port the app ACTUALLY bound — from its own lock, falling back to what
    // we probed. Reporting `port` here would print am's placeholder for an app
    // that chose its own.
    const realPort = updated?.port ?? livePort ?? port;
    // A SOCKET-ONLY app (the desktop shape) bound no port: "port 0" named a
    // door that does not exist. Its door is the socket — named as
    // `am status` names it.
    const done = startedReport(
      appId,
      pid,
      realPort,
      updated?.socketPath,
      updated?.cdpPort,
      servesTls(updated),
    );
    out(mode === "pretty" ? done.line : done.doc, mode);
  } else if (!isProcessAlive(pid)) {
    // Our own child's placeholder, under our own home — and ONLY it: by the
    // time the child died another start may have taken the name.
    removeLockIfOwner(amLockKey(appId), { pid });
    // A RESTART whose child lost the lock to another launch of the SAME app:
    // save a cell file and `am restart` at once, and the app's dev watcher
    // relaunches it in-process while am launches its own child — one wins.
    // When the watcher's did, this said "did not start", exit 1, while
    // `am status` showed the app up under a new pid. The app IS up, under the
    // identity the restart asked for: that is the verdict, said with the pid
    // actually serving, and a note for the child that stood down.
    const peer = o.peerOf
      ? await racingPeer(appId, pid, o.peerOf.stopped, deadline)
      : null;
    if (peer) {
      sayErr(
        `am: note: another launch of ${appId} (pid ${peer.pid} — e.g. its ` +
          `dev watcher reloading a saved file) took the lock first; this ` +
          `restart's child (pid ${pid}) stood down, and that instance is the ` +
          `app now`,
      );
      const done = startedReport(
        appId,
        peer.pid,
        peer.port,
        peer.socketPath,
        peer.cdpPort,
        servesTls(peer),
      );
      out(mode === "pretty" ? done.line : done.doc, mode);
      return;
    }
    // What it said — the `error:` line and the `→ fix:` lines under it, not
    // the last lines of the log (the stack frames, so the one line that says
    // what to do was the first to be cut).
    const left = childSaid(logPath());
    const said = crashTail(left.text);
    outError(
      said.length
        ? `${appId} did not start — the child (pid ${pid}) exited.\n` +
          `  it said:\n${said.map((l) => `      ${l}`).join("\n")}\n` +
          `  full log: ${left.files.join(" and ")}`
        : `process crashed — check ${logPath()}`,
      mode,
    );
    Deno.exit(1);
  } else {
    // Timed out but process alive — leave lock at 'starting'. Two different
    // truths, told apart by whether anything is LISTENING:
    //  · nothing bound yet → it is still starting. Not a fault: `am status`
    //    says `starting` (exit 2) and a cold start may need a longer wait.
    //  · bound but not answering → "not responding", naming the door we
    //    knocked on (`port` is am's placeholder and reads 0 for the
    //    socket-only desktop shape — "not responding on port 0" sent a
    //    reader after a port that never existed).
    const lock = readPid(appId);
    if (lock && !_ofLaunch(lock, pid) && isLockOwnerAlive(lock)) {
      outError(
        `${appId} is held by another launch (pid ${lock.pid}) and this ` +
          `start's child (pid ${pid}) has neither taken over nor stood down ` +
          `after ${timeout / 1000}s — check am status and ${logPath()}`,
        mode,
      );
      Deno.exit(1);
    }
    const socketOnly = !!lock?.socketPath && !lock.port;
    const doorPort = lock?.port || livePort;
    const bound = socketOnly
      ? await isSocketAlive(lock!.socketPath!)
      : doorPort
      ? await isPortInUse(doorPort)
      : false;
    const secs = timeout / 1000;
    outError(
      bound
        ? `not responding ${waitedAt(lock, livePort)} after ${secs}s — ` +
          `pid ${pid} is listening but did not answer — check am status ` +
          `and ${stdoutLogPath(appId)}`
        : stillStartingMessage(
          secs,
          pid,
          socketOnly ? "socket" : doorPort ? doorPort : null,
        ),
      mode,
    );
    Deno.exit(1);
  }
}

/** The instance that won the lock from a restart's child (`child`), when it
 *  is the app the restart asked for — and SERVING — by `deadline`: under the
 *  same lock key (appId + home + profile), alive, not the pid the restart
 *  stopped (`stopped`: that one surviving is a failed stop, never a start),
 *  not a maintenance hold, launched from THIS checkout, `started`, and its
 *  door answering. Anything else is null — a start that really failed. */
async function racingPeer(
  appId: string,
  child: number,
  stopped: number | undefined,
  deadline: number,
): Promise<LockData | null> {
  // At least a short grace: the child exits the moment it is refused, which
  // can be before the winner has finished its own boot.
  const until = Math.max(deadline, Date.now() + PEER_GRACE_MS);
  do {
    const l = readPid(appId);
    if (
      !l || isOwnLock(l, child) ||
      (stopped !== undefined && isOwnLock(l, stopped)) || maintenanceOp(l) ||
      foreignCheckout(l) !== null || !isLockOwnerAlive(l)
    ) return null;
    if (l.status === "started") {
      if (await answers(l, appId)) return l;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  } while (Date.now() < until);
  return null;
}

/** Does `l`'s door answer — its socket (the socket-only desktop shape), else
 *  an HTTP 2xx on its control port, the test `awaitStarted` uses. */
async function answers(l: LockData, appId: string): Promise<boolean> {
  if (l.socketPath && !l.port) return await isSocketAlive(l.socketPath);
  if (!(l.port > 0)) return false;
  return await doorAnswers(resolveControlPort(l.port, appId), appId);
}

/** Does the aio server on `port` ANSWER? Its page (`/`) with a 2xx — or,
 *  when the page is refused, its health route: a prod server with no
 *  browser bundle (every `client: "server-only"` app) answers `/` with an
 *  honest 503, and reading that as "not answering" made `am start --prod`
 *  exit 1 ("did not answer") for an app that was serving, and made the
 *  single-instance check kill it as a zombie. `/__aio/health` is served in
 *  every mode; a 401/403 there is a keyed app answering. THE liveness
 *  question for `start`, the singleton check and a restart's peer.
 *  `appId`: the app it must be — another app answering is not an answer.
 *  @internal */
export async function doorAnswers(
  port: number,
  appId?: string,
): Promise<boolean> {
  const get = async (path: string): Promise<number> => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      // The app that answers, when the caller knows which one it waits for:
      // a declared port can be another app's while ours still boots, and
      // its answer was read as "ours started".
      if (appId !== undefined && path === "/__aio/health" && r.ok) {
        let who: { appId?: unknown } = {};
        try {
          who = await r.json();
        } catch {
          // aio-ok: not JSON — no name to compare, the status decides
        }
        return typeof who.appId === "string" && who.appId !== appId
          ? -1
          : r.status;
      }
      await r.body?.cancel();
      return r.status;
    } catch {
      return 0; // aio-ok: nothing answered — the verdict below says so
    }
  };
  if (appId !== undefined && await get("/__aio/health") === -1) return false;
  const page = await get("/");
  if (page >= 200 && page < 300) return true;
  if (page === 0) return false;
  const health = await get("/__aio/health");
  return (health >= 200 && health < 300) || health === 401 || health === 403;
}

/** How long {@linkcode racingPeer} waits at least for the winner to serve. */
const PEER_GRACE_MS = 5_000;

/** The URL this machine opens for an app that bound `port`, or undefined when
 *  it bound none (a socket-only desktop app has no URL, its door is the
 *  socket). `tls` picks the scheme: an app serving TLS answers only on https.
 *  `localhost`, never the advertise host — this is the link for the person at
 *  THIS console to click. Pure. */
export function localAppUrl(port: number, tls = false): string | undefined {
  return port > 0 ? `${tls ? "https" : "http"}://localhost:${port}` : undefined;
}

// Moved beside `endpointOf` so `peer()` (src/server) reads the same rule.
import { servesTls } from "../server/lock-owner.ts";
export { servesTls };

/** `am start`'s verdict for a child that is up — the pretty line and the
 *  JSON document. A SOCKET-ONLY app (the desktop shape) bound no port, and
 *  "port 0" named a door that does not exist: its door is the socket, named
 *  as `am status` names it (`transport uds (<path>)`). A TCP app also names
 *  the URL to click — the port alone left the reader typing it by hand. Pure. */
export function startedReport(
  appId: string,
  pid: number,
  port: number,
  socketPath?: string,
  /** The DevTools port of a `--cdp` launch: the pretty line then names
   *  `am shot`, the verb for it — a field report scripted screenshots over raw
   *  CDP and hunted the port with `ss`. */
  cdpPort?: number,
  /** Whether the app serves TLS — the URL's scheme. */
  tls = false,
): { line: string; doc: Record<string, unknown> } {
  const door = socketPath && !port
    ? `socket ${socketPath}`
    : `port ${port}${socketPath ? `, transport uds (${socketPath})` : ""}`;
  const url = localAppUrl(port, tls);
  const cdp = cdpPort
    ? `\ncdp 127.0.0.1:${cdpPort} — screenshots: am shot (not raw CDP)`
    : "";
  return {
    line: `started ${appId} (pid ${pid}, ${door}${
      url ? `, ${url}` : ""
    })${cdp}`,
    doc: {
      appId,
      pid,
      port,
      status: "started",
      ...(url ? { url } : {}),
      ...(socketPath ? { transport: "uds", socketPath } : {}),
    },
  };
}

/** The timeout message for a child that is alive but not listening yet.
 *  `door`: "socket" (a socket-only app), the declared port, or null (none
 *  chosen yet). Pure — the wording is pinned by a test. */
export function stillStartingMessage(
  secs: number,
  pid: number,
  door: "socket" | number | null,
): string {
  const what = door === "socket"
    ? "its socket is not up yet"
    : door
    ? `port ${door} not bound yet`
    : "no port yet";
  return `still starting after ${secs}s (pid ${pid} alive, ${what}) — ` +
    `am status follows it (exit 2 = transitional); a cold start may need ` +
    `--wait=60`;
}

/** What a crashed child SAID, for `am start`'s report: ANSI stripped, stack
 *  frames (`    at …`) and caret lines dropped, and — when the log has an
 *  `error:` line — starting FROM it, so the `→ fix:` lines a teachable error
 *  carries are the ones shown. The last eight raw lines used to be taken, and
 *  a ten-frame stack is longer than eight lines: the line that said what to
 *  do was exactly the one cut off. Pure. */
export function crashTail(log: string, n = 8): string[] {
  const lines = log
    // deno-lint-ignore no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "") // the child's colours are not ours
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => !/^\s*at\s/.test(l) && !/^\s*[\^~]+\s*$/.test(l));
  while (lines.length && lines.at(-1) === "") lines.pop();
  const errAt = lines.findLastIndex((l) =>
    /^\s*error\b/i.test(l) || l.includes("[ERROR]")
  );
  return errAt >= 0 ? lines.slice(errAt, errAt + n) : lines.slice(-n);
}

/** Is a `starting` lock whose owner is alive but has bound nothing STUCK, or
 *  merely slow? Stuck = the lock is older than `STUCK_STARTING_MS` AND the
 *  app's own stdout log (its progress) has not moved for as long — a boot
 *  that is still printing is a boot. `logMtime` null = no log at all. Pure. */
export function bootStalled(
  lockStartedAt: number,
  logMtime: number | null,
  now: number = Date.now(),
  stuckMs: number = STUCK_STARTING_MS,
): boolean {
  if (now - lockStartedAt < stuckMs) return false;
  return logMtime === null || now - logMtime >= stuckMs;
}

/** The dev session behind this lock is WAITING for a fix
 *  (`LockData.waiting`) — or null. A malformed value is no wait. Pure. */
export function waitingOf(
  pf: Pick<LockData, "waiting"> | null | undefined,
): { reason: string; since: number } | null {
  const w = pf?.waiting as { reason?: unknown; since?: unknown } | undefined;
  return w && typeof w.reason === "string" && typeof w.since === "number"
    ? { reason: w.reason, since: w.since }
    : null;
}

/** What `am start` / `am status` say about a dev session waiting for a fix:
 *  the reason, what the failed relaunch printed (`said`), and the ways out.
 *  Pure — the wording is pinned by a test. */
export function waitingMessage(
  appId: string,
  pid: number,
  w: { reason: string },
  said: readonly string[],
): string {
  return `${appId} is waiting for a fix — ${w.reason} (dev session pid ` +
    `${pid}).` +
    (said.length > 0
      ? `\n  it said:\n${said.map((l) => `      ${l}`).join("\n")}`
      : "") +
    `\n  fix it and save: the session relaunches the app. am stop ends the ` +
    `session; am restart starts the app afresh.`;
}

/** What the failed relaunch printed, from `stdout.log` — only when that log
 *  moved around the wait (a dev session in a terminal writes elsewhere, and
 *  an old crash must not be passed off as this one). */
export function waitingSaid(appId: string, since: number): string[] {
  const path = stdoutLogPath(appId);
  const m = logMtime(path);
  if (m === null || m < since - 5_000) return [];
  // The session's own "waiting" lines follow the error — they repeat what
  // the message already says.
  return crashTail(readLogTail(path)).filter((l) =>
    !/^\d{4}-\d\d-\d\d \S+\s+\w+\s+watch\s/.test(l)
  );
}

/** A file's mtime in epoch ms, or null when it cannot be read. */
export function logMtime(path: string): number | null {
  try {
    return Deno.statSync(path).mtime?.getTime() ?? null;
  } catch {
    // aio-ok: no log is a fact `bootStalled` handles ("no progress"), not an
    // error — the lock's own age still decides.
    return null;
  }
}

/** Whether a client can hand a URL to the desktop's browser at all. Only
 *  `server-only` and `cli` cannot; everything else (browser, electron's
 *  external links, the framework default) can. Pure, pinned by a test. */
export function clientOpensTabs(client: string | undefined): boolean {
  return client !== "server-only" && client !== "cli";
}

/** How long `am start` waits when the child's log shows a first-run download
 *  in progress. Generous on purpose: a 100 MB fetch on a slow line is minutes,
 *  and the alternative is exit 1 for an app that is about to be fine. */
export const SLOW_START_WAIT_MS = 180_000;

/** How long `am start` waits in all, as of one look at the child's log:
 *  the long wait while a reason holds (`why`); once it has ended (`was`, and
 *  no `why`), the default wait again, counted from now; else as it was.
 *  Never moved by a look that changes nothing, so the loop's own deadline
 *  stands between two changes.
 *  Pure. @internal */
export function startWaitMs(
  was: string | null,
  why: string | null,
  elapsedMs: number,
  waitMs: number,
  defaultMs: number,
): number {
  if (why) return SLOW_START_WAIT_MS;
  // Whole seconds: the number is said ("still starting after 11s").
  return was ? Math.ceil((elapsedMs + defaultMs) / 1000) * 1000 : waitMs;
}

/** Why a boot may legitimately take longer than the default wait, read from
 *  the child's log — or null when nothing in it says so. Pure, so the rule is
 *  testable without a spawn. Two reasons exist. The Electron runtime
 *  download (`downloading runtime <v> for <slug> (~100 MB, once per machine)…`,
 *  src/electron/electron-runtime-fetch.ts) that has not yet reported
 *  `runtime … — cached` or failed. And Deno's own first-run fetch of the
 *  app's modules, before a line of the app has run: the log's LAST line is
 *  one of its `Download <url>` / `Initialize <package>` lines (measured: 80
 *  of them for a one-import entry on an empty cache) — the app had not
 *  started to start, and on a loaded machine that alone outlasted the
 *  default wait. @internal */
export function slowStartReason(log: string, err = ""): string | null {
  // deno-lint-ignore no-control-regex
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  // `err`: the child's stderr where that is a file of its own (Windows,
  // `detachedSpawnSpec`). Deno's lines are there and the app's `console.log`
  // is not, so no order between them is left: read one after the other,
  // Deno's line stayed "the last" after the app had spoken, and every new
  // app's start was "downloading the app's modules" for as long as it took
  // (measured on Windows 11: a 25 s boot was waited for, exit 0, where the
  // answer is "still starting", exit 1). There Deno is still fetching while
  // its line ends ITS file and the app has written nothing to the other.
  const last = plain(err) || plain(log);
  // Any line ending: Windows writes CRLF, and a bare CR is still a new line.
  if (
    /(^|[\r\n])\s*(Download|Initialize) \S+$/.test(last) &&
    !(err && plain(log))
  ) {
    return "first run: Deno is downloading the app's modules";
  }
  if (err) log = `${log}\n${err}`;
  const at = log.lastIndexOf("downloading runtime ");
  if (at < 0) return null;
  const after = log.slice(at);
  // Finished (cached) or failed since — the download is no longer the reason.
  if (/— cached|could not download|Error:|\[ERROR\]/.test(after)) return null;
  return "first run: the app is downloading the Electron runtime (~100 MB, " +
    "once per machine)";
}

/** The last 64 KB of a log, or "" when it cannot be read — a probe, not a
 *  requirement: no log means no reason to wait longer. */
/** What a child that died left in its log: the text (ANSI stripped) and the
 *  files it is in. Both `logFile` and `<logFile>.err` — on Windows stderr is
 *  split off there (`detachedSpawnSpec`), and the reason a boot failed is
 *  usually THERE: naming only the stdout log ("it wrote nothing to …") sent
 *  the reader to the empty file. @internal */
export function childSaid(logFile: string): { text: string; files: string[] } {
  const files: string[] = [];
  const texts: string[] = [];
  for (const f of [logFile, `${logFile}.err`]) {
    // deno-lint-ignore no-control-regex
    const t = readLogTail(f).replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (t) {
      files.push(f);
      texts.push(t);
    }
  }
  return { text: texts.join("\n"), files };
}

function readLogTail(path: string): string {
  try {
    const st = Deno.statSync(path);
    const f = Deno.openSync(path);
    try {
      const from = Math.max(0, st.size - 65536);
      f.seekSync(from, Deno.SeekMode.Start);
      const buf = new Uint8Array(st.size - from);
      let got = 0;
      while (got < buf.length) {
        const n = f.readSync(buf.subarray(got));
        if (n === null) break;
        got += n;
      }
      return new TextDecoder().decode(buf.subarray(0, got));
    } finally {
      f.close();
    }
  } catch {
    // aio-ok: no log yet, or none readable — "nothing says the boot is slow"
    // is the answer, and the default wait applies.
    return "";
  }
}

/** How to name the door `am start` waited at, for the message when the wait
 *  runs out. Reads the child's OWN lock first: it is the only record of what
 *  the process actually bound, and for a `--client=electron` app that is a
 *  unix socket and no port at all. */
export const waitedAt = (
  lock: Pick<LockData, "port" | "socketPath"> | null,
  probed: number | undefined,
): string => {
  if (lock?.socketPath && !lock.port) return `on socket ${lock.socketPath}`;
  const p = lock?.port || probed;
  return p ? `on port ${p}` : "— it recorded neither a port nor a socket";
};

/** Where am looked for the lock, and the one env var that decides it.
 *
 *  "app not running (no lock file)" named neither, and `lockDir()` is derived
 *  from XDG_RUNTIME_DIR|/tmp plus an AIO_APPS_DIR-shaped suffix — so two shells
 *  with different AIO_APPS_DIR genuinely search different directories and the
 *  message was true in both while explaining neither. */
export function noLockMessage(appId: string): string {
  const apps = appsDirEnv(); // the value lockDir() scoped by, not the raw one
  // What IS running, said HERE. The message already pointed at `am instances`,
  // and a pointer costs a round trip at the exact moment someone is looking at
  // "not running" for an app they can see in their own browser (report 5 §6:
  // `am stop` missed a demonstrably running app while `--port=N` worked). The
  // id is almost always right there — a different cwd resolves a different
  // appId, and the running one is the answer.
  let live = "";
  try {
    const running = runningApps().filter((i) => i.alive);
    // THIS id, running from a home the target did not name (a profile, an
    // isolated boot). Listing it as "running right now: x, x — target one
    // with --app=<id>" repeated the id that had already resolved and left out
    // the only thing that tells the instances apart.
    const same = running.filter((i) => i.appId === appId);
    // Running in an `--instance` (another lock dir): what status / state /
    // dispatch already say. `am stop` listed every OTHER app instead.
    const inInstances = same.length ? [] : runningInstancesOf(appId);
    if (inInstances.length > 0) {
      live = `\n  "${appId}" IS ${inInstancesHint(inInstances)}`;
    } else if (same.length > 0) {
      const how = (i: (typeof same)[number]): string => {
        const home = i.home ?? appHome(appId);
        const profile = i.profile ?? profileOfHome(appId, home);
        if (profile) return `--profile=${profile}`;
        return resolve(home) === resolve(appHome(appId))
          ? "the default home (no --profile)"
          : `--home=${home}`;
      };
      live = `\n  "${appId}" IS running — from another data home; name it: ${
        same.map((i) => `${how(i)} (pid ${i.pid})`).join(" · ")
      }`;
    } else if (running.length === 1 && running[0]!.appId !== appId) {
      live = `\n  RUNNING RIGHT NOW: "${running[0]!.appId}" (pid ${
        running[0]!.pid
      }) — did you mean \`--app=${running[0]!.appId}\`?`;
    } else if (running.length > 1) {
      live = `\n  running right now: ${
        running.map((i) => i.appId).join(", ")
      } — target one with --app=<id>`;
    }
  } catch {
    // aio-ok: an unreadable lock dir is already the subject of this message;
    // the paths above are the answer and a throw here would replace a good
    // diagnosis with a worse one.
  }
  return `app not running: no lock file for "${appId}"\n` +
    `  searched: ${lockDir()}\n` +
    `  AIO_APPS_DIR=${apps ?? "unset"} (it scopes the lock dir — am and the ` +
    `app must share the same value)${live}\n` +
    `  see what IS running: am instances — or target the app by id ` +
    `(--app=<id>) or by port (--port=N, am reads the id from that port)`;
}

/** One app's restart: stop it, taking the durability verdict the way `am
 *  stop` does, wait for the port, start it again. Returns the verdict; it
 *  never exits on it (see {@linkcode restartAll}). */
/** `am start`'s placeholder lock for the child it just spawned (`data.pid`),
 *  written compare-and-swap: create it only while no lock is there, or
 *  replace a DEAD owner's — never a LIVE instance's (the child is refused by
 *  that one anyway, and overwriting its lock made it look stale to the next
 *  reader, which reclaimed it: two instances on one state.db), and never the
 *  child's own, which it may have written since `seen` was read. True when
 *  written. @internal exported for its test */
export function writeStartPlaceholder(
  seen: LockData | null,
  data: LockData,
): boolean {
  if (!seen) return replaceLockIf(null, data);
  if (isOwnLock(seen, data.pid) || isLockOwnerAlive(seen)) return false;
  return replaceLockIf(seen, data);
}
