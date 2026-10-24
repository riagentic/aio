// am stop — resolving which instance is meant (appId, port, project),
// stopping one (ask, wait, final-persist verdict, force), and the command.
// Split out of am-cmd-process.ts, which re-exports every name here, so no
// importer changes.

import {
  deadOwnerWarning,
  foreignOwnerRefusal,
  instances,
  isLockOwnerAlive,
  killProcess,
  lockDir,
  lockKey,
  readLock,
  replaceLockIf,
  resolveAppId,
} from "../server/single-instance-lock.ts";
import type {
  InstanceInfo,
  LaunchInfo,
  LockData,
} from "../server/single-instance-lock.ts";
import { controlKeyPath } from "../server/app-key.ts";
import { STOP_REFUSED } from "../server/server-auth.ts";
import { join, resolve } from "@std/path";
import { cwdIsProject, isUnder, projectRoot } from "./am-project.ts";
import {
  appDirs,
  appHome,
  appsDirEnv,
  instanceOfAppsDir,
} from "../server/app-dirs.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError, sayErr } from "./am-output.ts";
import {
  appIsAmbiguous,
  liveLock,
  lockHasNoDoor,
  maintenanceMessage,
  maintenanceOp,
  noDoorMessage,
  otherRootRefusal,
  printable,
  removeLockKeyed,
  removePid,
  resolveAmAppId,
  runningApps,
} from "./am-utils.ts";
import { processPlan } from "./am-components.ts";
import {
  dropFreshHome,
  isFreshHome,
  notStartedByAmNote,
  startedByOf,
} from "./am-instance.ts";
import type { StartedBy } from "./am-instance.ts";
import { probePort, resolveControlPort, trojanPost } from "./am-http.ts";
import { logMtime, noLockMessage } from "./am-cmd-start.ts";
import {
  POLL_INTERVAL_MS,
  QUICK_TIMEOUT_MS,
  STOP_WAIT_DEFAULT_S,
} from "./am-launch.ts";
import { ENDED_HARD } from "./am-cmd-kill.ts";

/** Who `am stop` is about to talk to — resolved from the lock file, or, with
 *  `--port=N`, from the port itself. Split out of `cmdStop` so the resolution
 *  (and every refusal message) is testable without the process-exiting shell. */
export type StopTarget = { appId: string; port: number; pf: LockData | null };

/** The running instance holding `port`, from the LOCK FILES — whichever app
 *  it belongs to. `--port=N` is documented as a way to point at a listener, so
 *  it has to be able to name an app other than the cwd's. */
export function lockOnPort(port: number): LockData | null {
  // An app's, never a maintenance hold's: its record says port 0 and it
  // holds none, so `--port=0` named whichever app was being backed up.
  return runningApps().find((i) => i.port === port) ?? null;
}

/** WHICH instance a process verb is about, decided from the lock files alone —
 *  ONE resolver for `stop`, `kill` and `restart`.
 *
 *  There used to be two. `stop` honoured `--port=N` (it identifies the app),
 *  while `kill` read `flags.port` only under `--stale` and otherwise resolved
 *  the cwd's app id — so `am kill --port=<another app's port>` killed the cwd's
 *  app, and `am kill --port=1`, a port nobody holds, killed it too. A flag the
 *  help lists as global, silently ignored by one verb of three, is worse than a
 *  flag that does not exist: it reads as a targeted command and acts as an
 *  untargeted one.
 *
 *  `probe` is not a failure — it means `--port=N` names no lock, which `stop`
 *  can still resolve by asking the port itself (an app started outside `am`
 *  holds no lock). `kill` cannot: it signals a pid, and only a lock has one. */
export type LockTarget =
  | { kind: "target"; target: StopTarget }
  | { kind: "probe"; port: number }
  | { kind: "none"; error: string };

export function resolveLockTarget(flags: GlobalFlags): LockTarget {
  const cwdAppId = resolveAmAppId(flags.app);
  // Wherever the instance's home is — `am stop` must stop the app
  // `am instances` lists, including one booted from its own `appDir`.
  const pf = liveLock(cwdAppId);

  // No --port: the lock file is the only decider.
  if (flags.port === undefined) {
    return pf
      ? { kind: "target", target: { appId: cwdAppId, port: pf.port, pf } }
      : { kind: "none", error: noLockMessage(cwdAppId) };
  }

  // --port that matches our own lock — nothing to discover.
  if (pf && pf.port === flags.port) {
    return {
      kind: "target",
      target: { appId: cwdAppId, port: flags.port, pf },
    };
  }

  // Some OTHER app's lock holds it: that app is the target, and `--app=X`
  // disagreeing with it is a refusal rather than a silent choice of one.
  const other = lockOnPort(flags.port);
  if (other) {
    const wanted = flags.app ? resolveAppId(flags.app) : undefined;
    if (wanted && wanted !== other.appId) {
      return {
        kind: "none",
        error: `port ${flags.port} belongs to app "${other.appId}", not ` +
          `"${wanted}" (--app) — refusing to act on a different app`,
      };
    }
    return {
      kind: "target",
      target: { appId: other.appId, port: flags.port, pf: other },
    };
  }
  return { kind: "probe", port: flags.port };
}

/** What a verb that can only act on a LOCK says when `--port=N` names none. */
export function noLockOnPortMessage(port: number): string {
  const live = runningApps();
  return `no running app holds port ${port} — refusing to act on a ` +
    `different app than the one you named.\n` +
    (live.length
      ? `  running: ${live.map((i) => `${i.appId} @ :${i.port}`).join(", ")}\n`
      : `  nothing is running (lock dir: ${lockDir()})\n`) +
    `  an orphan SERVING with no lock is what \`am kill --stale --port=${port}\` reaps`;
}

/** The app `--port=N` names, for a verb that READS about it (`status`,
 *  `logs`): a lock holding the port first, else the port is asked
 *  (`/__aio/health`). Never the cwd's app — `--port` identifies. */
export async function appIdOnPort(
  flags: GlobalFlags,
): Promise<
  | { ok: true; appId: string }
  | { ok: false; error: string; nothingThere?: true }
> {
  const t = resolveLockTarget(flags);
  if (t.kind === "target") return { ok: true, appId: t.target.appId };
  if (t.kind === "none") return { ok: false, error: t.error };
  const p = await probePort(t.port);
  if (p.kind === "aio") {
    const wanted = flags.app ? resolveAppId(flags.app) : undefined;
    return wanted && wanted !== p.appId
      ? {
        ok: false,
        error: `port ${t.port} answers as app "${p.appId}", not "${wanted}" ` +
          `(--app) — refusing to report on a different app`,
      }
      : { ok: true, appId: p.appId };
  }
  // `nothingThere`: no aio app answers on N — the caller decides whether that
  // is "stopped" (status), a fallback (logs of a crashed app) or a refusal.
  return {
    ok: false,
    nothingThere: true,
    error: p.kind === "closed"
      ? `nothing is listening on port ${t.port} (running instances: am instances)`
      : `port ${t.port} is not an aio app (${p.kind}) — wrong port? ` +
        `(running instances: am instances)`,
  };
}

export async function resolveStopTarget(
  flags: GlobalFlags,
): Promise<{ ok: true; target: StopTarget } | { ok: false; error: string }> {
  const first = resolveLockTarget(flags);
  if (first.kind === "target") return { ok: true, target: first.target };
  if (first.kind === "none") return { ok: false, error: first.error };

  // `--port=N` IDENTIFIES the app; it never merely overrides the port of a
  // cwd-derived one. In a two-app repo the cwd's deno.json named the OTHER
  // app, so `am stop --port=N` addressed a lock that did not exist, fell back
  // to the main port, and reported the bare "app not running" — while the app
  // on N kept running.
  const probe = await probePort(first.port);
  switch (probe.kind) {
    case "aio": {
      const wanted = flags.app ? resolveAppId(flags.app) : undefined;
      if (wanted && wanted !== probe.appId) {
        return {
          ok: false,
          error: `port ${first.port} answers as app "${probe.appId}", not ` +
            `"${wanted}" (--app) — refusing to stop a different app`,
        };
      }
      return {
        ok: true,
        target: {
          appId: probe.appId,
          port: first.port,
          pf: liveLock(probe.appId),
        },
      };
    }
    case "tls":
      return {
        ok: false,
        error: `port ${first.port} speaks TLS (https) — under --expose the ` +
          `control endpoint is plain HTTP on a SEPARATE port, recorded only ` +
          `in the lock file, so no port on the TLS side can reach it. Target ` +
          `the app by id instead: am stop --app=<id> (ids: am instances; ` +
          `lock dir: ${lockDir()})`,
      };
    case "listening":
      return {
        ok: false,
        error: `port ${first.port} has a listener that answers neither HTTP ` +
          `nor TLS — not an aio app`,
      };
    case "http":
      return {
        ok: false,
        error: `port ${first.port} answers HTTP but is not an aio app ` +
          `(no /__aio/health) — wrong port?`,
      };
    case "closed":
      return {
        ok: false,
        error: `nothing is listening on port ${first.port} — no app to stop ` +
          `there (running instances: am instances)`,
      };
  }
}

/** The checkout a running instance was started from, when it is NOT this
 *  project — or null when it is (or when the lock predates the field).
 *
 *  The same app checked out twice (a worktree, a second clone) is one identity
 *  with one lock, and the lock records its cwd. Every command that names the
 *  instance used to say "pid, port" and nothing else, so `am start` refused
 *  with "already running" in a checkout where nothing was, `am status` said
 *  started, `am doctor` said nothing of this project was up, and `am restart`
 *  quietly relaunched the OTHER checkout's app from this one's tree. One
 *  predicate, read by all four, so they answer with the same fact. */
export function foreignCheckout(
  pf: Pick<LockData, "cwd">,
  root = projectRoot(),
): string | null {
  if (!pf.cwd) return null;
  return isUnder(root, pf.cwd) ? null : pf.cwd;
}

/** The "already running" sentence, naming the other checkout when the
 *  instance was started from one. Pure. */
export function alreadyRunningLine(
  pf: Pick<LockData, "appId" | "pid" | "port" | "cwd">,
  root = projectRoot(),
): string {
  if (maintenanceOp(pf)) return maintenanceMessage(pf.appId, pf);
  const other = foreignCheckout(pf, root);
  return `already running: ${pf.appId} (pid ${pf.pid}, port ${pf.port})` +
    (other
      ? ` — started from ${other}, not this checkout (${root}). ` +
        `am restart --force relaunches it from here; am stop ends it.`
      : "");
}

/** The `fix` beside "already running" — the private copy, so an agent does
 *  not `am stop` a person's window to get its own (jot §4). The `--json`
 *  document's `fix` field; the line under the error in a terminal. */
export const ALREADY_RUNNING_FIX =
  "for a private copy beside it (own data, own lock): " +
  "am start --instance=<name>";

/** {@linkcode ALREADY_RUNNING_FIX} for the scope this `am` runs in: inside an
 *  `--instance` the private copy is ANOTHER name — "--instance=<name>" told
 *  `am start --instance=a` to pass the flag it had passed. Pure over the env. */
export function alreadyRunningFix(): string {
  const own = instanceOfAppsDir(appsDirEnv());
  return own === undefined
    ? ALREADY_RUNNING_FIX
    : `for another private copy beside it (own data, own lock): ` +
      `am start --instance=<a name other than ${own}>`;
}

/** What `am start` and `am status` say about an instance that is alive, has
 *  a listener, and does not answer: ONE story — it is running, it is not
 *  answering, and ending it is the user's call. am ends a process only when
 *  nothing at all is listening where its record says (`zombieVerdict`). */
export function notAnsweringLine(
  pf: Pick<LockData, "appId" | "pid" | "port">,
): string {
  const app = printable(pf.appId);
  return `not answering: ${app} (pid ${pf.pid}${
    pf.port > 0 ? `, port ${pf.port}` : ""
  }) is running and listening, but does not answer — am does not end a ` +
    `process that is still listening. \`am stop --app=${app}\` asks it to ` +
    `quit; \`am kill --app=${app}\` ends it.`;
}

/** THE definition of "an instance of this project" — read by `stop --all`,
 *  `doctor` and `status`, so they cannot answer differently.
 *
 *  Two facts make an instance this project's, and it needs only one of them:
 *  it was LAUNCHED from under the project root, or it holds this project's own
 *  app id. The second half is not a nicety — an app id is a singleton across
 *  the machine, so the same app checked out twice has ONE lock, and the running
 *  process may well be the other checkout's. With the cwd test alone,
 *  `am status` called it started (it resolves by id) while `am doctor` said
 *  "no running instance of this project" and `stop --all` left it up.
 *
 *  Scoped rather than global either way. `am instances` is machine-wide, so a
 *  literal "stop all" would reach into every other aio app the developer has
 *  running — a different project's server going down because someone tidied up
 *  in this one is not a tidy-up, it is an outage with no obvious cause. */
export function instancesInProject(
  root = projectRoot(),
  appId = thisProjectAppId(),
): InstanceInfo[] {
  return instances()
    .filter((i) => launchedIn(root, i.cwd) || i.appId === appId)
    .sort((a, b) => a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0);
}

/** Was an instance launched from THIS project — under `root`, with no other
 *  project in between?
 *
 *  "Under the root" alone was the test, and a project can hold projects. A
 *  stray `~/deno.json` makes `~` a project root, so `am stop --all` run from
 *  `~/Downloads` (no app there) resolved to `~` and stopped every app of every
 *  checkout beneath it — the outage `--all` is scoped to prevent, one level up.
 *  An instance belongs to the NEAREST project above where it was launched,
 *  which is `projectRoot`'s own rule, so a compiled app started from
 *  `dist/<app>/` (no deno.json of its own) is still its project's. */
function launchedIn(root: string, cwd: string | undefined): boolean {
  return !!cwd && isUnder(root, cwd) &&
    resolve(projectRoot(cwd)) === resolve(root);
}

/** Instances launched under `root` from inside a DIFFERENT project nested in
 *  it — the ones `stop --all` leaves alone, named so leaving them is said. */
export function instancesInNestedProjects(
  root = projectRoot(),
): { appId: string; project: string }[] {
  return instances()
    .filter((i) => !!i.cwd && isUnder(root, i.cwd) && !launchedIn(root, i.cwd))
    .map((i) => ({ appId: i.appId, project: projectRoot(i.cwd!) }))
    .sort((a, b) => a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0);
}

/** This project's own app id, or undefined when the cwd resolves to none
 *  (`resolveAmAppId` throws rather than guessing, and a listing must not). */
export function thisProjectAppId(): string | undefined {
  // A project that declares components has no ONE id, and `resolveAmAppId()`
  // does not throw there — it prints its refusal and EXITS, which no `catch`
  // sees. That killed the project-wide `am stop` the refusal recommends.
  if (appIsAmbiguous()) return undefined;
  try {
    return resolveAmAppId();
  } catch {
    return undefined;
  }
}

/** Stop one app. Returns what happened instead of exiting, so `--all` can carry
 *  on through a failure and report every app rather than dying on the first. */
/** The LAST chance to learn whether this app's state is on disk.
 *
 *  `am stop` exits 0 as soon as the app agrees to stop, and that exit code is
 *  the operator's final signal before the process is gone — so a shutdown that
 *  loses every write since the first refused persist window used to be
 *  indistinguishable from a clean one. The shutdown flush cannot report back
 *  (the reply leaves before it runs), so the verdict is taken BEFORE the door
 *  closes, through the one route whose whole contract is durability.
 *
 *  Returns the refusal message, or null when the state is on disk — or when
 *  this app has no persist route to ask (a production build, an older app, a
 *  transport that is already gone). Only a route that answered and REFUSED is
 *  a verdict; "I could not ask" is not data loss and must not be reported as
 *  it. */
async function finalPersistVerdict(
  port: number,
  appId: string,
): Promise<string | null> {
  const r = await trojanPost(port, "persist", undefined, appId);
  if (r.ok) return null;
  // `persist failed: …` is the trojan route's own wording for "the cycle
  // reported a failure" (a 500). Everything else — 404, 501 "persistence not
  // available", a connection error — means the question could not be put.
  return /persist failed:/.test(r.error) ? r.error : null;
}

/** Stop ONE resolved target. Exported for the no-door test only.
 *  @internal */
/** One `am stop`'s outcome. */
type StopResult =
  | {
    ok: true;
    appId: string;
    pid?: number;
    port: number;
    unsaved?: string;
    /** How it ended: the app accepted the stop and ran its own shutdown,
     *  or am signalled it — on Windows a signal is TerminateProcess, no
     *  `onStop`, no final flush ("killed"). */
    how: "graceful" | "signal" | "killed";
  }
  | { ok: false; appId: string; error: string };

/** What `am stop` says when the app REFUSED its stop — the server's own
 *  `STOP_REFUSED` answer, never a guess: an app with no stop at all (a
 *  production build before 1.0.17-beta: a bare 404, or 1.0.16's lockdown
 *  door) gets null, and the signal it always got. Pure. */
export function stopRefusalNote(
  appId: string,
  keyPath: string,
  error: string,
): string | null {
  if (!error.startsWith(STOP_REFUSED)) return null;
  return `[am] ${appId}: the app refused the stop credential — ${keyPath} ` +
    `is missing or does not match this boot (${error.split("\n")[0]}); ` +
    `ending it without a clean shutdown`;
}

export async function stopOne(
  target: StopTarget,
  flags: GlobalFlags,
): Promise<StopResult> {
  const { appId, port, pf } = target;
  // Another apps root's app, listed here because the two roots share a lock
  // folder name: not this `am`'s to stop (or to restart).
  const otherRoot = pf && otherRootRefusal("stop", pf);
  if (otherRoot) return { ok: false, appId, error: otherRoot };
  // A lock with NO DOOR (`am start`'s "starting, port 0" placeholder — see
  // `lockHasNoDoor`) has nothing to ask for a graceful shutdown or a persist
  // verdict: both went to `:0` and came back as the runtime's "Requests to
  // port 0 are blocked". Stopping a booting app is still `stop`'s job — its
  // owner gets the SIGTERM the fallback below gives any app that cannot
  // answer; an owner already gone is reported by name, not by fetch.
  const noDoor = pf !== null && lockHasNoDoor(pf);
  if (noDoor && !isLockOwnerAlive(pf)) {
    // Said ONCE, then cleaned up like every other stale lock — left in
    // place, every later `am stop` repeated the warning forever.
    // `removeLockKeyed` rather than `removePid`: the error below is where
    // the killed op is named, and removePid would name it a second time.
    removeLockKeyed(pf);
    return {
      ok: false,
      appId,
      error: maintenanceOp(pf)
        ? `${appId} is not running — ${deadOwnerWarning(appId, pf)}`
        : `${appId} is not running — its lock (${pf.status}, no port or ` +
          `socket yet) names pid ${pf.pid}, which has exited`,
    };
  }

  // `am backup` / `am restore` holding the lock is not an app to stop: the
  // SIGTERM below ended the copy (and marked the lock `stopping` for good).
  if (pf && maintenanceOp(pf)) {
    return { ok: false, appId, error: maintenanceMessage(appId, pf) };
  }

  // Mark as stopping — only while the lock still names the OWNER read (same
  // pid and start identity; its status may have moved on — a booting app
  // flips `starting` → `started` under us, and that is still the app to
  // stop). A lock another process published since is not this stop's to
  // touch: marking it copied the old record over the new one, and the next
  // reader reclaimed a live instance's lock. Nothing is signalled either.
  const mark: { was?: LockData } = {};
  if (
    pf &&
    !replaceLockIf(pf, (now) => (mark.was = { ...now, status: "stopping" }))
  ) {
    const now = readLock(lockKey(pf.appId, pf.home, pf.profile));
    if (!now) {
      // Gone, AND its owner with it: the app exited between the read and
      // here — stopped. Gone but the owner LIVES (a lock removed by hand, an
      // exit still under way): nothing to mark, but the process is still
      // the one to stop — fall through to the stop below, as ever.
      if (!isLockOwnerAlive(pf)) {
        return { ok: true, appId, pid: pf.pid, port, how: "graceful" };
      }
    } else {
      return {
        ok: false,
        appId,
        error:
          `${appId}: its lock now names another process (pid ${now.pid}, ` +
          `was ${pf.pid}) — a new instance started while this stop was ` +
          `reading it. Nothing was stopped; run \`am status\` and stop again ` +
          `if you meant it.`,
      };
    }
  }

  const unsaved = noDoor ? undefined : await finalPersistVerdict(port, appId);

  // Try graceful shutdown via trojan API, fall back to SIGTERM
  const result = noDoor
    ? { ok: false as const, error: noDoorMessage(appId, pf!) }
    : await trojanPost(port, "shutdown", undefined, appId);
  // The SIGTERM fallback is for an app that has a lock ON THIS PORT and is not
  // answering. It must never fire on an identity refusal — killing our own pid
  // because someone ELSE holds the port is the same retargeting bug mirrored.
  let how: "graceful" | "signal" | "killed" = "graceful";
  if (
    !result.ok && pf && (noDoor || pf.port === port) && isLockOwnerAlive(pf) &&
    !foreignOwnerRefusal(pf)
  ) {
    how = Deno.build.os === "windows" ? "killed" : "signal";
    // The app SAID it refused the credential (`STOP_REFUSED`) — not an app
    // too old to have a stop. The user asked to stop, so it still ends; but
    // never silently without its clean shutdown.
    const note = stopRefusalNote(
      appId,
      controlKeyPath(appId, pf.home),
      result.error,
    );
    if (note) sayErr(note);
    try {
      Deno.kill(pf.pid, "SIGTERM");
    } catch { /* already dead */ }
  } else if (!result.ok) {
    // The real reason, not the generic literal that discarded it: "app not
    // running on port N", an identity refusal, or the app's own error.
    // We stopped nothing — undo the "stopping" mark, if it is still ours.
    if (pf && mark.was) {
      // …and only if the mark is still there: the app may have moved its own
      // status on since (it is the same owner, so the CAS lets us in).
      replaceLockIf(
        mark.was,
        (now) =>
          now.status === "stopping" ? { ...now, status: pf.status } : now,
      );
    }
    return { ok: false, appId, error: result.error };
  }

  // Without --wait: return immediately, user checks with `am status`
  if (flags.wait === undefined) {
    return {
      ok: true,
      appId,
      pid: pf?.pid,
      port,
      ...(unsaved ? { unsaved } : {}),
      how,
    };
  }

  // With --wait: poll until dead, then force kill if needed
  const timeout = (flags.wait || STOP_WAIT_DEFAULT_S) * 1000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pf) {
      // THE PID IS THE ANSWER when we have one. The loop used to probe HTTP
      // as well and treat any transport error as "dead" — but a `port: 0`
      // app (the default desktop shape: `--client=electron` binds a unix
      // socket and no network interface) has no HTTP door at all, so the
      // first probe always threw, the loop broke out at once, and the
      // still-alive process was SIGTERM+SIGKILLed with grace 0. Measured:
      // `--wait` on a UDS app returned in 0.57s and the app's `onStop` never
      // finished, while the same app WITHOUT `--wait` shut down cleanly.
      // `--wait` is the flag a script uses to be safe; it was the only one
      // that truncated shutdown. `am restart` forces it, so it inherited it.
      if (!isLockOwnerAlive(pf)) break;
    } else {
      // No pid to watch — the HTTP probe is the only evidence there is.
      try {
        const ctrlPort = resolveControlPort(port, appId);
        const resp = await fetch(`http://127.0.0.1:${ctrlPort}/`, {
          signal: AbortSignal.timeout(QUICK_TIMEOUT_MS),
        });
        await resp.body?.cancel();
      } catch {
        break;
      } // connection refused = dead
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Graceful timeout expired — escalate to SIGKILL
  if (pf && isLockOwnerAlive(pf)) {
    const foreign = foreignOwnerRefusal(pf);
    if (foreign) return { ok: false, appId, error: foreign };
    await killProcess(pf.pid, 0, pf); // already waited gracefully
    how = "killed";
    // Reported as it IS: "stopped" for a process still alive after SIGKILL
    // is the lie a script then starts a second copy on.
    if (isLockOwnerAlive(pf)) {
      return {
        ok: false,
        appId,
        error: `${appId} (pid ${pf.pid}) is still alive after SIGTERM and ` +
          `SIGKILL — not stopped`,
      };
    }
  }
  removePid(appId, pf);
  return {
    ok: true,
    appId,
    pid: pf?.pid,
    port,
    ...(unsaved ? { unsaved } : {}),
    how,
  };
}

/** The line `am stop` adds when the app did NOT get its clean shutdown on
 *  Windows: the stop request was not accepted (an app too old to have one, a
 *  refused credential, a door that never answered) and the fallback there is
 *  TerminateProcess. Elsewhere the fallback is SIGTERM — a clean stop — and
 *  nothing is added. Pure. */
export function hardStopNote(
  how: "graceful" | "signal" | "killed",
  os: string = Deno.build.os,
): string {
  return os === "windows" && how === "killed" ? `\n  ⚠ ${ENDED_HARD}` : "";
}

/** How long an app's log may stay still before "no lock" means stopped. */
export const RESTART_QUIET_MS = 3000;

/** The lock a dev restart is about to file, or null (network §3). A restart
 *  releases the old child's lock early in its shutdown, and the next child's
 *  appears only after that one exits — `am stop` in the gap said "not
 *  running". The log moving is the restart: wait for the lock while it moves
 *  (bounded), and answer at once when it is quiet or missing. */
export async function relockAfterRestart(
  lock: () => LockData | null,
  logMoved: () => number | null,
  limitMs = 30_000,
): Promise<LockData | null> {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    const m = logMoved();
    if (m === null || Date.now() - m >= RESTART_QUIET_MS) return lock();
    const l = lock();
    if (l) return l;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return lock();
}

/** Who started `inst` (see am-instance.ts `startedByOf`), from the launch
 *  record in ITS home — and the scope's default home, where `am start` files
 *  it for an app whose lock names another (`appDir`). A record that names
 *  THIS process wins; the pid match is what keeps reading two safe. */
export function startedByInstance(inst: LockData): StartedBy {
  const read = (path: string): LaunchInfo | null => {
    try {
      const info = JSON.parse(Deno.readTextFileSync(path)) as LaunchInfo;
      return Array.isArray(info.flags) ? info : null;
    } catch {
      return null; // aio-ok: no record — the absence is the answer
    }
  };
  const paths = [
    ...new Set([
      appDirs(inst.appId, inst.home ?? appHome(inst.appId)).launch,
      join(appHome(inst.appId), "launch.json"),
    ]),
  ];
  const seen = paths.map(read).filter((i): i is LaunchInfo => i !== null)
    .map((i) => startedByOf(inst, i));
  if (seen.includes("am")) return "am";
  if (seen.includes("unknown")) return "unknown";
  return "other";
}

/** What `am stop` adds about WHO it stopped and about a `--fresh` home it
 *  throws away: additive fields for `--json` (`startedBy`, `note`,
 *  `freshData`), lines for a terminal. Never a refusal — `am stop` stopping
 *  what it is asked to is frozen behaviour; an agent is TOLD it just ended a
 *  person's window (jot §4), so it can say so instead of finding out later. */
function stopExtras(
  pf: LockData | null,
  by: StartedBy | undefined,
  ok: boolean,
  flags: GlobalFlags,
  waited: boolean,
): { json: Record<string, unknown>; text: string } {
  if (!pf || by === undefined) return { json: {}, text: "" };
  const json: Record<string, unknown> = { startedBy: by };
  let text = "";
  if (ok && by === "other") {
    json.note = notStartedByAmNote(pf.appId, pf.pid);
    text += `\n  ⚠ ${json.note}`;
  }
  if (ok && isFreshHome(pf.home, flags.instance, pf.appId)) {
    if (waited && !isLockOwnerAlive(pf)) {
      const failed = dropFreshHome(flags.instance!, pf.appId);
      json.freshData = failed ? "kept" : "dropped";
      text += failed
        ? `\n  ⚠ --fresh: ${failed}`
        : `\n  fresh data thrown away (${pf.home})`;
    } else {
      // Still exiting (`--no-wait`): deleting under a live process is how
      // a half-written database survives. The next `--fresh` start drops it.
      json.freshData = "kept";
      text += `\n  fresh data kept while it exits — the next ` +
        `\`am start --instance=${flags.instance} --fresh\` throws it away`;
    }
  }
  return { json, text };
}

export async function cmdStop(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  // `am stop` WAITS by default, as `am start` does: it returned the moment
  // the shutdown was ASKED for, exit 0, while the process was still alive —
  // a binary started right after hit "Already running". Waited up to the
  // stop budget, then SIGKILL (the "SIGTERM → SIGKILL" help promises).
  // `--no-wait` keeps the old return-at-once.
  if (flags.wait === undefined && !flags.noWait) {
    flags = { ...flags, wait: STOP_WAIT_DEFAULT_S };
  }
  const waited = flags.wait !== undefined;

  // `am stop` in a multi-component project stops the PROJECT — which is what
  // `--all` already did, now the default where the project says it has parts.
  // `am stop <label>` stops one. A single-app repo is untouched.
  let stopAll = flags.all;
  {
    const plan = processPlan(_args, {
      app: flags.app,
      port: flags.port,
      entry: flags.entry,
    });
    if (plan.kind === "error") {
      outError(plan.message, mode);
      Deno.exit(1);
    }
    if (plan.kind === "one") {
      flags = { ...flags, app: plan.component.appId };
    } else if (plan.kind === "single" && plan.appId) {
      flags = { ...flags, app: plan.appId };
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
    // "This project" needs a project. Outside one, `projectRoot()` falls back
    // to the cwd itself — so `am stop --all` from `~` scoped to `~` and
    // stopped every app of every project checked out beneath it, while help
    // and `am agent` both promise "every app OF THIS PROJECT". Refused, and
    // the refusal names the two ways to say what was meant.
    if (!cwdIsProject()) {
      outError(
        `--all stops every app of THIS project, and ${Deno.cwd()} is not ` +
          "inside one (no deno.json here or above) — cd into the project " +
          "first, or name one app: am stop --app=<appId>",
        mode,
      );
      Deno.exit(1);
    }
    const root = projectRoot();
    const running = instancesInProject(root);
    const nested = instancesInNestedProjects(root);
    const nestedList = nested.map((n) => `${n.appId} (${n.project})`)
      .join(", ");
    if (running.length === 0 && nested.length > 0) {
      // Not "nothing running": apps ARE running below here, and a reader who
      // meant them needs to hear why they were not stopped.
      outError(
        `--all stops every app of THIS project (${root}), and none is ` +
          `running — the ${nested.length} app(s) running below it belong to ` +
          `other projects: ${nestedList}. cd into that project first, or ` +
          `name one app: am stop --app=<appId>`,
        mode,
      );
      Deno.exit(1);
    }
    if (nested.length > 0) {
      sayErr(
        `[am] note: left running — other projects below ${root}: ${nestedList}`,
      );
    }
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
    const extras: string[] = [];
    for (const i of running) {
      // `i` IS the lock — re-reading it by appId used the DEFAULT-home key,
      // so stopping a fleet that contained a `--home`-scoped instance sent
      // the shutdown (and the SIGTERM fallback) to the DEFAULT instance's
      // pid instead. The instance we already hold is the answer.
      const by = startedByInstance(i);
      const r = await stopOne({ appId: i.appId, port: i.port, pf: i }, flags);
      const x = stopExtras(i, by, r.ok, flags, waited);
      results.push({ ...r, ...x.json });
      extras.push(x.text);
    }
    const failed = results.filter((r) => !r.ok);
    const lost = results.filter((r) => r.ok && r.unsaved);
    if (mode === "pretty") {
      results.forEach((r, n) => {
        out(
          r.ok
            ? `${waited ? "stopped" : "stopping"} ${r.appId}` +
              hardStopNote(r.how) +
              (r.unsaved ? `\n  ⚠ NOT SAVED — ${r.unsaved}` : "") + extras[n]
            : `✗ ${r.appId}: ${r.error}`,
          mode,
        );
      });
    } else {
      out({ root, stopped: results }, mode);
    }
    // Non-zero when ANY app is still up: a script that stops a fleet and reads
    // exit 0 is entitled to believe the fleet is down. Same for an app whose
    // state did not reach disk — the data is what the fleet was for.
    if (failed.length || lost.length) Deno.exit(1);
    return;
  }

  let resolved = await resolveStopTarget(flags);
  if (!resolved.ok && flags.port === undefined && waited) {
    const appId = resolveAmAppId(flags.app);
    const pf = await relockAfterRestart(
      () => {
        const t = resolveLockTarget(flags);
        return t.kind === "target" ? t.target.pf : null;
      },
      // The path only: `stdoutLogPath` CREATES the folder, and a stop of an
      // app that is not running (a typo'd --app) left ~/.<id>/logs behind.
      () => logMtime(join(appDirs(appId).logs, "stdout.log")),
    );
    if (pf) {
      sayErr(`am: note: ${appId} was restarting — stopping its new process`);
      resolved = { ok: true, target: { appId, port: pf.port, pf } };
    }
  }
  if (!resolved.ok) {
    // Exit 1 stays (the CLI surface is frozen, and a typo'd --app reads
    // exactly like an app already down) — but the message says which of the
    // two outcomes a script is looking at, and the idempotent spelling.
    outError(
      resolved.error.startsWith("app not running: no lock file")
        ? `am stop: nothing to stop — ${resolved.error}\n  exit 1 all the ` +
          `same (a mistyped --app looks exactly like this); a script that ` +
          `only needs it down: \`am stop … || true\``
        : resolved.error,
      mode,
    );
    Deno.exit(1);
  }
  const pf = resolved.target.pf;
  // Read BEFORE the stop: a `--fresh` home (and the record in it) is thrown
  // away after it.
  const by = pf ? startedByInstance(pf) : undefined;
  const r = await stopOne(resolved.target, flags);
  if (!r.ok) {
    outError(r.error, mode);
    Deno.exit(1);
  }
  const x = stopExtras(pf, by, true, flags, waited);
  out(
    mode === "pretty"
      ? (waited
        ? `stopped ${r.appId}`
        : `stopping ${r.appId} (pid ${r.pid ?? "?"}, port ${r.port})`) +
        hardStopNote(r.how) +
        (r.unsaved ? `\n  ⚠ NOT SAVED — ${r.unsaved}` : "") + x.text
      : waited
      ? {
        appId: r.appId,
        status: "stopped",
        pid: r.pid,
        port: r.port,
        ...(r.unsaved ? { unsaved: r.unsaved } : {}),
        how: r.how,
        ...x.json,
      }
      : {
        appId: r.appId,
        status: "stopping",
        pid: r.pid,
        port: r.port,
        ...(r.unsaved ? { unsaved: r.unsaved } : {}),
        how: r.how,
        ...x.json,
      },
    mode,
  );
  // The app is stopping either way — but the exit code stops claiming the data
  // went with it. This is the operator's LAST signal before the process is
  // gone, and it read 0 through total loss of every write since the first
  // refused window.
  if (r.unsaved) Deno.exit(1);
}
