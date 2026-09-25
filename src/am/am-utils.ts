/**
 * @module
 * Utility functions for am — aio manager CLI.
 * Path resolution, payload parsing, entry/appId/port resolution.
 */

import { readDenoJsonSync } from "../server/deno-json.ts";
import { envPort, resolveEntryPath } from "../server/paths.ts";
import { envDefaultPort } from "../server/aio-cli.ts";
import {
  type AppLock,
  type InstanceInfo,
  instances,
  isHold,
  isLockOwnerAlive,
  type LockData,
  lockKey,
  noteDeadHolder,
  printable,
  readLock,
  removeLockIfOwner,
  resolveAppId,
  writeLock,
} from "../server/single-instance-lock.ts";
import { basename, join, resolve } from "@std/path";
import {
  appDirs,
  expandProfilePath,
  isProfilePath,
  profileHome,
  profileNameError,
  profileOfHome,
  registerAppDirs,
  registeredProfile,
  registerProfile,
  RESERVED_APP_NAMES,
} from "../server/app-dirs.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, fail, outError, outValue, sayErr } from "./am-output.ts";
import { trojanGet, trojanPost } from "./am-http.ts";
import { type Component, projectComponents } from "./am-components.ts";
import { cwdIsProject, projectRoot } from "./am-project.ts";

// ── Entry config cache ──────────────────────────────────────

/** Cached config extracted from entry file — appId + port from aio.run() call */
let _entryConfig: { appId?: string; port?: number } | null = null;

export function readEntryConfig(): { appId?: string; port?: number } {
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

// ── Resolve helpers ─────────────────────────────────────────

/** Resolve the appId for am commands — --app flag > deno.json appId > app.ts aio.run().
 *  am runs in dev only (not compiled), so deno.json is always available. */
/** The refusal for "which app?" in a project that has more than one.
 *
 *  Without it every command that needs ONE app silently resolved the PROJECT's
 *  inferred id — `mc-probe` from deno.json `title` — which is not any of the
 *  components and never runs. `am state` then reported "no app named
 *  \"mc-probe\" is running" and helpfully listed five unrelated apps from other
 *  projects: an answer about an app that does not exist, in a directory where
 *  three real ones do. Naming the parts and the flag is the whole fix. */
/** This project's components, or none when it has none / cannot be read. */
function components(): Component[] {
  try {
    return projectComponents(projectRoot());
  } catch {
    return []; // unreadable project — the inference below is still honest
  }
}

function refuseAmbiguousApp(labels: string[]): never {
  const list = labels.join(", ");
  // EVERY component's spelling, and every project-wide verb — "Pick one:
  // --app=web" named one of two, and the whole-project line left out restart.
  const pick = labels.map((l) => `--app=${l}`).join(" | ");
  const whole = "am start | am stop | am restart | am status";
  const msg = `this project has several components (${list}) and this ` +
    `command acts on one — pick one with ${pick}, or manage the ` +
    `project as a whole with ${whole}`;
  // Through THE failure path, so a scripted caller gets `{"error": …}` on
  // stdout like every other refusal instead of a human line it cannot parse.
  // `resolveAmAppId` is called too deep to be handed the parsed flags, so the
  // mode is read the way `detectMode` reads it.
  const mode: "json" | "pretty" = Deno.args.includes("--json") ||
      !Deno.stdout.isTerminal()
    ? "json"
    : "pretty";
  if (mode === "pretty") {
    sayErr(
      `[am] ✗ this project has several components (${list}) and this command ` +
        `acts on one.\n` +
        `    Pick one:  ${pick}\n` +
        `    Or manage the project as a whole: ${whole}`,
    );
    Deno.exit(1);
  }
  fail(msg, mode);
}

/** The `am start …` that starts `id` from THIS project, or null when `id` is
 *  not this project's to start.
 *
 *  Asked while composing the "not running" message, so it must ANSWER rather
 *  than refuse: `resolveAmAppId()` with no flag does not return "I cannot tell"
 *  for a project that declares components — it prints its own refusal and
 *  `Deno.exit(1)`s. Reached from here that turned `am state --app=agent` on a
 *  stopped component into "pick one with --app=agent", telling the caller to do
 *  the thing it had just done, out of a message-composition path that kills the
 *  process. A component IS this project's app, so it gets the same sentence
 *  with the part named: `am start agent`. */
function startCommandFor(id: string): string | null {
  if (!cwdIsProject()) return null;
  const cs = components();
  if (cs.length > 0) {
    const c = cs.find((c) => c.appId === id);
    return c ? `am start ${c.label}` : null;
  }
  try {
    return resolveAmAppId() === id ? "am start" : null;
  } catch {
    return null; // no id to infer here — the ambiguity message is the true one
  }
}

/** Whether `resolveAmAppId(flag)` has no ONE app to name — no `--app`, in a
 *  project that declares components — and would refuse. Asked BEFORE a
 *  command runs, so the refusal lands only on a command that acts on one app:
 *  `help`, `--version` and the project-wide `start | stop | restart | status`
 *  (see `processPlan`) have no app to resolve, and resolving one eagerly
 *  refused them all — the refusal's own "am stop | am status" included. */
export function appIsAmbiguous(flag?: string): boolean {
  return !flag && components().length > 0;
}

/** This project's component labels — none for a single-app repo. */
export function componentLabels(): string[] {
  return components().map((c) => c.label);
}

/** The refusal for `--profile` / `--home` with no ONE app to target: a
 *  profile is one app's instance, and a project of several components has no
 *  one app until `--app` names it. It must NOT recommend the project-wide
 *  `am stop | am status` — this refusal is what those very commands answer
 *  with a `--profile` beside them. Pure. */
export function ambiguousHomeError(
  opts: { profile?: string; home?: string },
  labels: readonly string[],
): string {
  const flag = opts.profile !== undefined
    ? `--profile=${opts.profile}`
    : `--home=${opts.home}`;
  return `${flag} targets ONE app's instance, and this project has several ` +
    `components (${labels.join(", ")}) — name the one: ` +
    `--app=${labels[0]} ${flag}`;
}

export function resolveAmAppId(flag?: string): string {
  if (flag) {
    // `--app` names an app identity, and in a project that declares COMPONENTS
    // a component LABEL is the name its developer knows it by. Process verbs
    // take the label positionally (`am start agent`); everything else cannot,
    // because its first positional is already a state path or an action — so
    // the label resolves here instead, and one flag works for every command.
    // A label that names no component falls through to today's behaviour, so
    // an ordinary `--app=<id>` is untouched.
    for (const c of components()) if (c.label === flag) return c.appId;
    return resolveAppId(flag);
  }
  // A project that declares COMPONENTS has no single "this app" to infer, and
  // inferring one anyway names something that never runs.
  //
  // The refusal is deliberately OUTSIDE the try that reads them: a `catch` wide
  // enough to swallow an unreadable deno.json is wide enough to swallow the
  // refusal's own control flow, and a guard that can be caught by the code
  // guarding it is not a guard.
  const cs = components();
  if (cs.length > 0) refuseAmbiguousApp(cs.map((c) => c.label));
  try {
    // JSONC-aware, like the server: a comment in deno.json made this throw
    // and `am` fell through to the directory name — a different app id from
    // the one the running app derived, so `am` addressed nothing.
    const cfg = readDenoJsonSync(projectRoot())?.config as
      | { appId?: string }
      | undefined;
    if (cfg?.appId) return resolveAppId(cfg.appId);
  } catch { /* no deno.json */ }
  const ec = readEntryConfig();
  if (ec.appId) return resolveAppId(ec.appId);
  // Zero-config apps (aio.run() with no appId) — mirror the server's
  // inference chain: deno.json title/name, then the project directory name.
  try {
    const cfg = readDenoJsonSync(projectRoot())?.config as
      | { title?: string; name?: string }
      | undefined;
    const fromCfg = cfg?.title ?? cfg?.name?.split("/").pop();
    if (fromCfg) return resolveAppId(fromCfg);
  } catch { /* no deno.json */ }
  // `basename`, not `split("/")`: the server infers the same last rung from a
  // `file:` URL (always `/`-separated), but `Deno.cwd()` on Windows is
  // `C:\proj\app` — which `split("/")` returns WHOLE, so `am` computed the
  // appId `c-proj-app` for the app the runtime calls `app`. Two identities for
  // one project means two lock files, and `am` talking past its own app.
  //
  // `projectRoot()`, not the cwd, everywhere above and here: from a
  // SUBDIRECTORY of the app the cwd has no deno.json and its basename is
  // "src" — a different app id from the one the running app derived, so
  // `cd src && am status` reported a stopped app called "src".
  const dir = basename(projectRoot());
  if (dir) return resolveAppId(dir);
  throw new Error(
    '[am] missing appId — pass --app=X, add "appId" to deno.json, or set appId in aio.run()',
  );
}

/** The port this app has DECLARED, or undefined when it has declared none.
 *
 *  THE SAME four rungs the runtime resolves, in the same order (`aio.ts`:
 *  `cli.port ?? envPort() ?? config.port ?? envDefaultPort() ?? await
 *  findFreePort()`): `--port` > `AIO_PORT` > the entry's `aio.run({ port })` >
 *  `AIO_DEFAULT_PORT`. The last one is what a generated systemd unit sets; `am`
 *  run with that environment used to say "the app picks a free port" about a
 *  service that binds 3000 on every restart.
 *
 *  Undefined is an answer, not a gap. It used to fall back to 8000 — so
 *  `am start` and `deno task dev` gave the SAME app two different ports, and
 *  `am` never told the child about its 8000 anyway. What the user saw:
 *  `deno task dev` on :49208, then `am start` refusing with `port 8000 in use
 *  by aio app "Remote Server"` — a refusal about a port the app was never
 *  going to bind, naming an unrelated app. One fact, one spelling: when
 *  nothing is declared, the RUNTIME decides and says so, and `am` reads the
 *  port back from the lock the app writes.
 *
 *  deno.json's top-level `port` was a fourth rung here and is now gone. The
 *  runtime never read it — `_warnMisplacedDenoJson` WARNS that aio config at
 *  deno.json's top level "is silently doing nothing", port included — so `am`
 *  was aiming at a number the app had already been told it was ignoring. */
export function declaredPort(flag?: number): number | undefined {
  if (flag !== undefined) return flag; // AIO-212: don't ignore --port=0
  const env = envPort(); // throws on a malformed AIO_PORT — see resolvePort
  if (env !== undefined) return env;
  _warnDenoJsonPort();
  // `AIO_DEFAULT_PORT=0` means "pick a free one" — no rung, as in `aio.ts`.
  return readEntryConfig().port ?? (envDefaultPort() || undefined);
}

/** Dropping a rung silently is the failure this codebase keeps fixing, so the
 *  key `am` no longer reads is NAMED once per invocation — with the same
 *  verdict the runtime already gives it (`_warnMisplacedDenoJson`: aio config
 *  at deno.json's top level "is silently doing nothing"). Nobody's app changes
 *  behaviour here; what changes is that `am` stops disagreeing with the app it
 *  is inspecting. stderr, so `--json` output stays machine-clean. */
let _warnedDenoJsonPort = false;
function _warnDenoJsonPort(): void {
  if (_warnedDenoJsonPort) return;
  try {
    // THE reader: JSONC, both filenames. `JSON.parse` of deno.json alone
    // said nothing for a deno.jsonc, or for a deno.json with one comment.
    const cfg = readDenoJsonSync(projectRoot())?.config as
      | { port?: unknown }
      | undefined;
    if (typeof cfg?.port !== "number") return;
    _warnedDenoJsonPort = true;
    sayErr(
      `[am] note: deno.json has a top-level "port": ${cfg.port} — aio never ` +
        `reads it there (deno.json carries identity and build only), so the ` +
        `app does not bind it and am no longer aims at it. Move it into ` +
        `aio.run({ port: ${cfg.port} }) in the app entry, or set AIO_PORT.`,
    );
  } catch { /* no deno.json, or unreadable — nothing to say */ }
}

/** Resolve entry point: --entry flag > deno.json "entry" > src/app.ts
 *  Convention: entry is src/app.ts. Override via deno.json "entry" if renamed. */
export function resolveEntry(flagEntry?: string): string | null {
  if (flagEntry) {
    try {
      Deno.statSync(flagEntry);
      return flagEntry;
    } catch {
      return null;
    }
  }
  // THE chain (server/paths.ts), not a fourth copy of it: an explicit `entry`,
  // else src/app.ts. It read the same way already — which is exactly how a
  // duplicate survives until the day one copy is updated and the others are not.
  let cfg: Record<string, unknown> | null = null;
  const root = projectRoot();
  try {
    cfg = readDenoJsonSync(root)?.config ?? {};
  } catch { /* no deno.json — the default still applies */ }
  // Anchored at the PROJECT, so the entry resolves from a subdirectory too;
  // absolute, so every reader (the launch, the config scan) agrees on it.
  const entry = resolve(root, resolveEntryPath(cfg));
  try {
    Deno.statSync(entry);
    return entry;
  } catch {
    return null;
  }
}

// ── Lock file helpers (pid compat layer) ────────────────────

/** `am --home=<dir>`: ONE decider, the app-dirs registry. Registering the home
 *  makes every `appDirs(id)` reader in this process — the lock key below, the
 *  control key, launch info, logs — follow that instance, exactly as the app's
 *  own process does after `aio.run()` resolved `appDir`. Nothing else in `am`
 *  needs to know the flag exists. */
export function targetHome(
  appId: string,
  home: string,
  profile?: string,
): void {
  registerAppDirs(appId, appDirs(appId, home));
  registerProfile(appId, profile ?? profileOfHome(appId, home));
  _homePinned = true;
}

/** Follow the RUNNING instance's data home, when there is exactly one and no
 *  `--home` pinned another.
 *
 *  Every `am` reader of an app's files — `am logs`, `am data`, `am report`,
 *  `am auth`, the error log — computed its directory from the INVOKING
 *  process's environment (`$HOME`, `$AIO_APPS_DIR`) and not from where the app
 *  it is inspecting actually lives. The two agree in the common case and part
 *  company exactly when it matters: an app booted with `appDir` (the packaged
 *  Electron shape), one started by a service manager, or an `am` run under a
 *  different user. `am logs` then reported "no log file at <a path that was
 *  never this app's>" while the app was up and writing. Reported twice, from
 *  two different apps — and it is the same root cause as a compiled binary
 *  serving `<cwd>/src` and the generated systemd unit's `User=$USER`: an
 *  environment that was true where the command was TYPED, applied to a process
 *  that lives somewhere else.
 *
 *  The lock already carries the answer (`LockData.home`), and `targetHome` is
 *  already the one seam that makes every `appDirs()` reader follow it. So this
 *  is not a new rule, it is the existing rule applied without being asked.
 *
 *  Deliberately narrow, and silent when it changes nothing:
 *   - `--home` pinned ⇒ untouched. That is the operator saying which instance.
 *   - nothing running ⇒ untouched. The default home is the only answer there,
 *     and it is the right one for `am remove` after a crash.
 *   - two instances of one id ⇒ untouched. That is a real ambiguity;
 *     {@linkcode liveLock} already names the `--home=` that resolves it, and
 *     picking one here would be the silent retarget `--home` exists to prevent.
 *   - the running home EQUALS the computed one ⇒ nothing to adopt. */
export function adoptRunningHome(appId: string): void {
  if (_homePinned) return;
  let running: InstanceInfo[];
  try {
    running = instances(appId);
  } catch {
    return; // no lock dir readable — the default home is the only answer
  }
  // A PROFILE instance is never adopted: `am stop` with no --profile means
  // the app's own instance, and must not stop `dev` because it is the only
  // one up.
  const live = notProfiles(appId, running).filter((i) => i.alive);
  if (live.length !== 1) return;
  const home = live[0]!.home;
  if (!home || home === appDirs(appId).home) return;
  registerAppDirs(appId, appDirs(appId, home));
}

/** Split `myapp@dev` — the `--app` / process-verb positional spelling of a
 *  profile — into its halves. A plain id comes back whole. Pure. */
export function splitAppProfile(v: string): { app: string; profile?: string } {
  const at = v.lastIndexOf("@");
  return at > 0
    ? { app: v.slice(0, at), profile: v.slice(at + 1) }
    : { app: v };
}

/** The data home `am` targets for `--profile` (a NAME or a PATH) and its
 *  path-only alias `--home`, or why neither can be used.
 *
 *  A name resolves to the RUNNING instance filed under it when there is one
 *  (its lock records the home the runtime chose — an app with `appDir` puts
 *  its profiles beside THAT), else to {@linkcode profileHome}. A tag that is
 *  a lock key's hash (`myapp@1a2b3c4d`, copied from `am instances`) resolves
 *  to the running instance filed under that key. Pure but for the lock read. */
export function amProfileHome(
  appId: string,
  opts: { profile?: string; home?: string },
): { home?: string; profile?: string; error?: string } {
  const live = (() => {
    try {
      return instances(appId).filter((i) => i.alive);
    } catch {
      return []; // aio-ok: no lock dir — nothing running to follow
    }
  })();
  type Hit = { home: string; profile?: string } | { error: string };
  const one = (v: string, pathOnly: boolean): Hit => {
    if (pathOnly || isProfilePath(v)) {
      const home = expandProfilePath(v);
      const running = live.find((i) => i.home && resolve(i.home) === home);
      const profile = running?.profile ?? profileOfHome(appId, home);
      return profile ? { home, profile } : { home };
    }
    if (/^[0-9a-f]{8}$/.test(v)) {
      const hit = live.find((i) =>
        lockKey(appId, i.home, i.profile) === `${appId}@${v}`
      );
      if (hit?.home) return { home: hit.home };
      return {
        error: `${appId}@${v} names no running instance (the tag is a lock ` +
          `key's, and nothing runs under it now — am instances lists them)`,
      };
    }
    const bad = profileNameError(v);
    if (bad) return { error: bad };
    const running = live.find((i) =>
      i.profile === v || (i.home && profileOfHome(appId, i.home) === v)
    );
    return { home: running?.home ?? profileHome(appId, v), profile: v };
  };
  const a = opts.profile !== undefined ? one(opts.profile, false) : undefined;
  const b = opts.home !== undefined ? one(opts.home, true) : undefined;
  for (const x of [a, b]) if (x && "error" in x) return x;
  const ha = a as { home: string; profile?: string } | undefined;
  const hb = b as { home: string; profile?: string } | undefined;
  if (ha && hb && resolve(ha.home) !== resolve(hb.home)) {
    return {
      error: `--profile=${opts.profile} (${ha.home}) and --home=${opts.home} ` +
        `(${hb.home}) name two different folders — give one. --home is the ` +
        `path-only spelling of --profile.`,
    };
  }
  return hb ?? ha ?? {};
}

/** `running` minus every PROFILE instance — and minus any other lock whose
 *  pid a profile's lock names (a start placeholder filed under another key
 *  is the same process, not a second instance). Pure. */
export function notProfiles(
  appId: string,
  running: readonly InstanceInfo[],
): InstanceInfo[] {
  const isProfile = (i: InstanceInfo) =>
    !!i.profile || !!(i.home && profileOfHome(appId, i.home));
  const pids = new Set(running.filter(isProfile).map((i) => i.pid));
  return running.filter((i) => !isProfile(i) && !pids.has(i.pid));
}

/** Whether `--home` named an instance. When it did, {@linkcode liveLock} must
 *  NOT widen to "any instance of this id": `am --home=X state` means X's
 *  instance, and answering with the default home's would be a silent
 *  retarget — the failure `--home` exists to prevent. */
let _homePinned = false;
/** @internal — tests only: forget a `--home` pin between cases. */
// aio-ok: test seam — tests/am-uds-only-app.test.ts resets the pinned home between cases
export function _resetHomePin(): void {
  _homePinned = false;
}

/** The lock key `am` targets for `appId`: the plain id for the default home,
 *  `<id>@<hash8(home)>` after {@linkcode targetHome}. */
export function amLockKey(appId: string): string {
  return lockKey(appId, appDirs(appId).home, registeredProfile(appId));
}

/** Read lock data for current app — replaces old readPid().
 *  Keyed by appId AND home (`lockKey`), so a `--home` call reads the lock of
 *  THAT instance and — because the socket path is in the lock — reaches that
 *  instance's control socket. */
export function readPid(appId?: string): LockData | null {
  const id = appId ?? resolveAmAppId();
  const lock = readLock(amLockKey(id));
  if (!lock) return null;
  // Backward compat: old lock files without status
  if (!lock.status) lock.status = "started";
  return lock;
}

/** THE lock of the instance an `am` command targets, wherever that instance
 *  keeps its home — or null when nothing is running under `appId`.
 *
 *  {@linkcode readPid} reads ONE lock: the one keyed by the home `am` computes
 *  for the id (the default home, or `--home`). An app booted with `appDir`
 *  — the packaged-Electron shape, and any isolated second boot — writes its
 *  lock as `<id>@<hash8(home)>`, which that key never matches. `am instances`
 *  scans the directory and listed such an app as running while, in the same
 *  breath, `am surface --app=<id>` refused with "no app named <id> is
 *  running" (a field report). Two readers of one fact disagreed; this is the
 *  one reader every target resolution goes through.
 *
 *  The widening is deliberately narrow: only when no home was pinned, and
 *  only when exactly ONE instance of the id is up. Two homes of one id is a
 *  real ambiguity, named with the `--home=` that resolves it — never picked. */
export function liveLock(appId?: string): LockData | null {
  const id = appId ?? resolveAmAppId();
  const own = readPid(id);
  if (own || _homePinned) return own;
  // A PROFILE instance is never "the app": with no --profile, `am stop` /
  // `am status` must not reach `dev` because it happens to be the only one.
  const running = notProfiles(id, instances(id));
  if (running.length === 0) return null;
  if (running.length === 1) return running[0]!;
  throw new Error(
    `app "${id}" is running from ${running.length} data homes — say which ` +
      `one: ${
        running.map((i) => `--home=${i.home} (pid ${i.pid})`).join(", ")
      }`,
  );
}

/** Write lock data — replaces old writePid() */
export function writePid(pf: LockData): void {
  writeLock(pf);
}

/** Remove the lock `pf` — the record a command actually READ (via
 *  {@linkcode liveLock}) — at that instance's key, wherever its home is, and
 *  only while it still names `pf`'s owner (compare-and-delete). Removing by id
 *  alone after reading by `liveLock` would miss an `<id>@<hash>` lock and
 *  leave the stale record `am status` just called stale. */
export function removePid(_appId?: string, pf?: LockData | null): void {
  // No record read, nothing judged: whatever lock sits at the key now was
  // written by an instance this command never looked at (a port-only stop,
  // or one that booted meanwhile). Removing it anyway is how a live lock
  // went and a second instance opened the same state.db.
  if (!pf) return;
  // A killed `am backup`/`am restore`: named before its lock goes.
  if (!isLockOwnerAlive(pf)) noteDeadHolder(pf);
  removeLockKeyed(pf);
}

/** Remove the lock `pf` was read from — ONLY while it still names `pf`'s
 *  owner, and saying nothing (the caller names it). By the time a command
 *  decides a lock is stale, a new instance may hold the same name; deleting
 *  whatever sits at the path removed ITS live lock, and a second instance
 *  then opened the same state.db. */
export function removeLockKeyed(pf: LockData): void {
  removeLockIfOwner(lockKey(pf.appId, pf.home, pf.profile), pf);
}

/** Names already reported by {@linkcode resolvePort}, so one `am` invocation
 *  says where it is pointing once, not once per lookup. */
const _targetNoted = new Set<string>();

/** THE target of an `am` command: `--port` > this app's lock > the ONE running
 *  instance > what the app DECLARED (`AIO_PORT`, `aio.run({ port })`) > refuse.
 *
 *  There is no final 8000 rung any more. 8000 was never a port aio binds — the
 *  runtime's own answer when nothing is declared is `findFreePort()` — so the
 *  last rung was a number invented by the tool, and every command that took it
 *  aimed at a listener that had no reason to exist. It read as a diagnosis
 *  ("app not running on port 8000") when the truth was "am does not know which
 *  app you mean". A tool that cannot find its target says so; it does not pick
 *  one. Refusing here is also the precondition for UDS-only apps, which bind
 *  no TCP port at all and must be addressed by appId, never by number.
 *
 *  The "one running instance" rung is the fix for a whole class of confusion.
 *  `am` resolves an appId from the cwd (deno.json `appId`, else title, else the
 *  directory name), and when that guess misses, every port-taking command
 *  silently fell through to **8000** — so `am state` answered "app not running
 *  on port 8000" while the app was serving on 8413, and `am dispatch` with no
 *  `--port` targeted (and sometimes STARTED) a different instance entirely: an
 *  Electron window appearing on a headless box, and minutes spent reading the
 *  state of another process. In the other direction, `am status` reported
 *  `stopped` for the resolved id while `am instances` listed the app as
 *  running — two liveness sources disagreeing, which is the bug class that
 *  makes you distrust your own measurements.
 *
 *  Both are the same defect: a GUESS with no way to see it. So the guess now
 *  falls back to the registry, and the resolution is ECHOED on stderr — stderr
 *  so `--json` output stays machine-clean — the first time it matters.
 *  Ambiguity is never resolved silently: with several instances up and no
 *  match, it says so and lists them rather than picking one. */
/** The app id `resolvePort` fell back to when the caller's own id matched
 *  nothing running. `undefined` unless that fallback actually fired — a
 *  user-supplied `--port` returns before it, so a genuinely stale port is
 *  still refused. */
let _discoveredTarget: string | undefined;

/** @internal — read by the identity gate in am-http.ts. */
export function _discoveredAppTarget(): string | undefined {
  return _discoveredTarget;
}

/** @internal — tests only: forget a fallback between cases. */
// aio-ok: test seam — tests/am-verb-target.test.ts resets the guess between cases
export function _resetTargetGuess(): void {
  _discoveredTarget = undefined;
  _targetNoted.clear();
}

/** The lock record of an `am` MAINTENANCE hold — `am backup` / `am restore`
 *  holding the app's lock so it cannot start while its data is copied or
 *  swapped. Status `maintenance` (+ the op) instead of the `starting` a boot
 *  writes: with `starting`, `am status` called it a booting app, `am stop`
 *  SIGTERMed the backup, and a real start was told to `am stop` it.
 *
 *  Additive on the wire: every reader so far validates appId/pid/port only
 *  (v1.0.9's `readLock` included), so an older `am` or app still sees a HELD
 *  lock — it just cannot name it. The record is `LockData.maintenance`, with
 *  `status: "starting"` for readers that predate it (see that field for why
 *  that value); the app's own boot refusal names the op
 *  (`_alreadyRunningMessage`). What `am status` REPORTS for it: */
export const MAINTENANCE_STATUS = "maintenance";

/** The partial `AppLock.update()` writes to turn a hold into a maintenance
 *  record. */
export function maintenanceMark(
  op: string,
  since: number = Date.now(),
  partial?: string,
): Parameters<AppLock["update"]>[0] {
  return {
    status: "starting",
    maintenance: { op, since, ...(partial ? { partial } : {}) },
  };
}

/** When the lock's holder really started (epoch ms): a maintenance hold's
 *  `since`, else `startedAt` — which a hold's heartbeat keeps rewriting.
 *  Pure. */
export function holderSince(
  pf: Pick<LockData, "startedAt" | "maintenance">,
): number {
  const s = pf.maintenance?.since;
  return typeof s === "number" && Number.isFinite(s) ? s : pf.startedAt;
}

/** The `am` operation holding `pf`, or null when it is an app. Pure. */
export function maintenanceOp(pf: unknown): string | null {
  const m = (pf as { maintenance?: unknown } | null | undefined)?.maintenance;
  if (!isHold(pf as { maintenance?: unknown } | null)) return null;
  const op = typeof m === "object" ? (m as { op?: unknown }).op : undefined;
  return typeof op === "string" && op ? printable(op) : "am";
}

/** The lock module's one print-safety helper, for `am`'s own callers. */
export { printable };

/** What every verb says about a maintenance hold. Pure. */
export function maintenanceMessage(
  appId: string,
  pf: { pid: number; maintenance?: unknown },
): string {
  return `${maintenanceOp(pf) ?? "am"} is running on "${appId}" (pid ` +
    `${pf.pid}) — the app cannot start, and has nothing to answer, until it ` +
    `finishes. Wait for it, or Ctrl-C it.`;
}

/** A lock that names NO DOOR: no socket and port 0. That is the placeholder
 *  `am start` files before the child binds anything ("starting", port 0) —
 *  and, should a lock ever say it while `started`, an instance there is still
 *  no way to reach. Port 0 alone is NOT this: a UDS-only app's lock says
 *  `port: 0` honestly and is reached over its socket. The ONE place that
 *  state is recognized; `resolvePort` refuses it by name. Pure. */
export function lockHasNoDoor(
  pf: Pick<LockData, "port" | "socketPath">,
): boolean {
  return !pf.socketPath && !(pf.port > 0);
}

/** What `am` says about a {@linkcode lockHasNoDoor} instance. Before this,
 *  every HTTP verb aimed at `:0` and printed the runtime's "Requests to port 0
 *  are blocked" — true of fetch, and no help about the app. Pure. */
export function noDoorMessage(
  appId: string,
  pf: Pick<LockData, "pid" | "status" | "maintenance">,
): string {
  if (maintenanceOp(pf)) return maintenanceMessage(appId, pf);
  return pf.status === "starting"
    ? `"${appId}" is still starting (pid ${pf.pid}) — it has not bound a ` +
      `port or socket yet, so there is nothing to ask. Retry in a moment ` +
      `(\`am status\` exits 2 while it starts, 0 once it is up).`
    : `"${appId}" (pid ${pf.pid}, ${pf.status}) has no port or socket in ` +
      `its lock — nothing to ask. \`am restart --app=${appId}\` gives it one.`;
}

/** The port of a live lock, or the named refusal when it has no door. */
function doorPort(appId: string, pf: LockData): number {
  if (lockHasNoDoor(pf)) throw new Error(noDoorMessage(appId, pf));
  return pf.port;
}

export function resolvePort(
  flag?: number,
  appId?: string,
  opts: { explicit?: boolean } = {},
): number {
  if (flag !== undefined) return flag;
  const id = appId ?? resolveAmAppId();
  // The lock wherever the instance's home is — so a UDS-only app booted with
  // `appDir` resolves here (its lock says `port: 0`, honestly: the transport
  // decider in am-http then reaches it over the socket, never over :0).
  const pf = liveLock(id);
  if (pf) return doorPort(id, pf);

  const live = instances();
  // The "one running instance" rung exists for a GUESSED id — a cwd with no
  // project in it, where the id came from a directory name. Two things are
  // NOT a guess: an id the user typed (`--app=X`), and the id of the project
  // the cwd sits in (its deno.json, its entry, its own name). When that app
  // is not running, the answer is "it is not running", never "so here is Y" —
  // measured: `am dispatch` typed in a real app's directory, with only some
  // OTHER app up, dispatched into that other app after a note on stderr.
  // The note is not consent. (am-http refuses a WRITE over a guess besides,
  // so even the no-project case can only ever read through this rung.)
  const explicit = opts.explicit === true || cwdIsProject();
  if (live.length === 1 && !explicit) {
    const only = live[0]!;
    // Remember WHICH app this port was chosen for. The caller already resolved
    // an app id (from the cwd) before asking for a port, and it does not learn
    // that the fallback aimed somewhere else — so the identity gate went on
    // comparing against the old expectation and refused the very instance this
    // note promises to use, one line after promising it. `am health` had no
    // such gate and worked, which is the same command pair disagreeing.
    _discoveredTarget = only.appId;
    if (!_targetNoted.has(only.appId)) {
      _targetNoted.add(only.appId);
      sayErr(
        `[am] note: no app named "${id}" is running — using the one that ` +
          `is: ` +
          `${only.appId} @ ${
            only.socketPath ? "uds" : `:${only.port}`
          } (pid ${only.pid}). ` +
          `Pin it with --app=${only.appId}, or run am from its directory.`,
      );
    }
    return doorPort(only.appId, only);
  }
  // Nothing is running under this id. The app's OWN declaration is still a
  // real answer — `am start` on a declared port, an app between restarts.
  const declared = declaredPort();
  if (declared !== undefined) return declared;

  // Out of rungs. Say which question failed, and list what IS running so the
  // next command can name it.
  //
  // A message must be TRUE: `liveLock` above already found any instance of
  // `id`, so reaching here means the registry holds none — but that is a
  // property of the code above, not of this sentence. If the two ever
  // disagree again (a new lock-key shape, a filter in one reader and not the
  // other), the sentence still must not say "no app named X is running" in
  // the breath that lists X as running. Name the real constraint instead.
  const same = live.filter((i) => i.appId === id);
  if (same.length) {
    const i = same[0]!;
    throw new Error(
      i.socketPath
        ? `"${id}" is running on a UDS socket (pid ${i.pid}, ${i.socketPath}) ` +
          `but am could not resolve its lock for this command (home ` +
          `${i.home}). Target that instance with --home=${i.home}.`
        : `"${id}" is running on :${i.port} (pid ${i.pid}) but am could not ` +
          `resolve its lock for this command (home ${i.home}). Target that ` +
          `instance with --home=${i.home}, or --port=${i.port}.`,
    );
  }
  const list = live.length
    ? ` ${live.length} app${live.length === 1 ? " is" : "s are"} running: ${
      live.map((i) => `${i.appId} @ ${i.socketPath ? "uds" : `:${i.port}`}`)
        .join(", ")
    }.`
    : " Nothing is running.";
  // Standing in an app's own directory with the app stopped is not an
  // ambiguity: the id came from THIS deno.json, `am status` in the same
  // directory answers "stopped", and the fix is to start it. Saying "am does
  // not know which app to target … none declares a port … Name one with
  // --app=<id>" there is a false sentence followed by two wrong fixes, with
  // every unrelated app on the machine listed underneath as if one of them
  // were the answer. Only a GUESSED id (a cwd with no project, or an --app=X
  // that names nothing here) leaves am genuinely without a target.
  const start = startCommandFor(id);
  if (start) {
    throw new Error(
      `"${id}" is not running — start it: ${start} (this project: ` +
        `${projectRoot()}).${list}`,
    );
  }
  throw new Error(
    `am does not know which app to target: no app named "${id}" is running ` +
      `and none declares a port (AIO_PORT, or aio.run({ port }) in the app ` +
      `entry).${list} Name one with --app=<id>, or point at a listener with ` +
      `--port=N.`,
  );
}

// ── State path resolution ───────────────────────────────────

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
    const rest = suffix.startsWith(".") ? suffix.slice(1) : suffix;
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
    // `.length` on a string is the one property worth reaching through a
    // non-object: `am state title.length` reported "not found" while
    // `am state items.length` (an array — an object) worked, which reads as
    // the path being wrong rather than as strings being excluded.
    if (typeof cur === "string" && seg === "length") {
      cur = cur.length;
      continue;
    }
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

/** Flags whose value names ONE thing, so giving two of them is a
 *  CONTRADICTION rather than a preference for the last. Pure data — the
 *  refusal is {@linkcode repeatedFlagError}. @internal */
const SINGLE_VALUE_FLAGS: readonly string[] = [
  "--app",
  "--home",
  "--profile",
  "--instance",
  "--entry",
  "--transport",
  "--port",
  "--lines",
  "--timeout",
  "--client-index",
  "--from",
  "--out",
  "--filter",
  "--body",
  "--args",
];

/** Flags where an EMPTY value is a mistake rather than a meaning: they name
 *  WHAT am acts on, and an empty one used to be dropped so am inferred a
 *  target instead (`am stop --app="$APP"` with `APP` unset stopped whatever
 *  the cwd looks like). `--filter=` is deliberately absent — "no filter" is a
 *  real thing to ask for. @internal */
const NEEDS_A_VALUE: Readonly<Record<string, string>> = {
  "--app": "--app needs an app id: --app=<id> (am instances lists them)",
  "--entry": "--entry needs a file: --entry=src/app.ts",
  "--profile":
    "--profile needs a name or a folder: --profile=dev, --profile=~/data/x",
  // `--body=` is falsy, so `am dispatch t:add --body="$PAYLOAD"` with an
  // unset variable fell through to the positional path and CALLED the method
  // with no arguments, {"ok":true}. `--args=` has always refused.
  "--body":
    `--body needs JSON: --body='{"type":"T","payload":{…}}' (or --body=@file.json)`,
};

/** The client INDEX has four spellings; this is the long one.
 *
 *  `-i 2` already arrives expanded, but `-i2` (attached) and the deprecated
 *  `--client=2` do not — so a second, different index carried by one of them
 *  went straight past {@linkcode repeatedFlagError}: `am trigger … -i2
 *  --client-index=3` drove client 3, and the same line with its two flags
 *  swapped drove client 2. Silent last-one-wins, in the command where that
 *  value decides which live client is acted on. `--client=<kind>` is the app
 *  runtime's own flag, not an index, and is left alone. Pure. @internal */
function longClientIndex(a: string): string {
  if (/^-i\d+$/.test(a)) return `--client-index=${a.slice(2)}`;
  const deprecated = /^--client=(\d+)$/.exec(a);
  return deprecated ? `--client-index=${deprecated[1]}` : a;
}

/** The refusal for a flag given twice with two different values, or null.
 *
 *  `am data --app=one --app=two` answered for `two`, in silence, and the verbs
 *  on the other side of that delete data directories. `am build` already
 *  refuses its own version of this ("targets were given twice … Use one");
 *  this is the same call, made once for every flag. The SAME value twice is
 *  not a contradiction and stays legal, so a wrapper script that adds a flag
 *  the line already had still runs. Pure — `expanded` is the command line
 *  after `--k v` has become `--k=v`, and after the `--` marker was cut off.
 *  @internal */
function repeatedFlagError(expanded: readonly string[]): string | null {
  const seen = new Map<string, string>();
  for (const raw of expanded) {
    const a = longClientIndex(raw);
    const eq = a.indexOf("=");
    if (eq === -1 || !a.startsWith("--")) continue;
    const name = a.slice(0, eq);
    if (!SINGLE_VALUE_FLAGS.includes(name)) continue;
    const value = a.slice(eq + 1);
    const prev = seen.get(name);
    if (prev === undefined) seen.set(name, value);
    else if (prev !== value) {
      return `${name} was given twice, with two different values ` +
        `("${prev}" and "${value}") — am cannot act on both. Pass one: ` +
        `${name}=${prev}`;
    }
  }
  return null;
}

/** Parse CLI arguments into command, positional args, and global flags (--json, --quiet, --port, --app) */
export function parseGlobalFlags(
  argv: string[],
): { command: string; args: string[]; flags: GlobalFlags } {
  const flags: GlobalFlags = {};
  const rest: string[] = [];

  // Flags that REQUIRE a value accept both `--k=v` and `--k v`. Only the
  // equals form used to be understood, so `am dispatch … --body '{"a":1}'`
  // silently passed the literal "--body" and the JSON as positional args —
  // the method then received "--body" as its first argument and failed inside
  // Immer, which reads like a bug in the app rather than a mistyped command.
  // Flags whose value is OPTIONAL (--wait, --client) are deliberately absent:
  // there, `--wait 5` cannot be told apart from `--wait` plus an argument.
  const takesValue = new Set([
    "--port",
    "--body",
    "--args",
    "--filter",
    "--lines",
    "--entry",
    "--transport",
    "--app",
    "--client-index",
    "--home",
    "--profile",
    "--timeout",
    "--instance",
    "--from",
    "--out",
  ]);
  const expanded: string[] = [];
  // A value flag consumes the next token — unless that token is itself a FLAG.
  // `am replay --from --dry` used to become `--from=--dry`: the value is
  // nonsense, `--dry` is gone, and the command runs as if neither had been
  // typed. Leaving the bare flag instead lets the verb say what is missing,
  // which is the whole difference between a typo and a silent wrong run. A
  // negative NUMBER is still a value (`--wait=-5` has its own bounds check).
  const looksLikeFlag = (t: string | undefined) =>
    t !== undefined && /^-[A-Za-z-]/.test(t);
  // `--` ends am's options: everything after it is an ARGUMENT, however it is
  // spelled. The flag gate (am-flags.ts `unknownFlags`) already stopped at it,
  // but this parser did not — so `am dispatch todo:add -- --force` consumed
  // `--force` as am's own flag and dispatched with no argument at all. The
  // marker itself stays in `rest`, so the gate still sees where options end;
  // {@linkcode argsForHandler} removes it before a verb reads its arguments.
  const end = argv.indexOf("--");
  const tail = end === -1 ? [] : argv.slice(end);
  const raw = end === -1 ? argv : argv.slice(0, end);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!;
    if (takesValue.has(a) && i + 1 < raw.length && !looksLikeFlag(raw[i + 1])) {
      expanded.push(`${a}=${raw[++i]}`);
    } else if (
      a === "-i" && i + 1 < raw.length && !looksLikeFlag(raw[i + 1])
    ) {
      // `-i N` — the short form of `--client-index=N`.
      expanded.push(`--client-index=${raw[++i]}`);
    } else if (a === "--wait" && /^\d+$/.test(raw[i + 1] ?? "")) {
      // `--wait` is the one value flag whose BARE form is legal, so it cannot
      // join `takesValue` — but `--wait 30` is not "the default wait, plus a
      // component called 30", which is what it parsed as; the refusal then
      // blamed the number. Name the spelling instead.
      flags.error ??= `--wait ${raw[i + 1]} is not a spelling am reads — ` +
        `write --wait=${raw[i + 1]}. A bare --wait means the default wait, ` +
        `and "${raw[i + 1]}" on its own is read as a component name.`;
      expanded.push(`--wait=${raw[++i]}`);
    } else expanded.push(a);
  }

  // TWO VALUES FOR ONE FLAG — refused before anything is read out of them, so
  // no verb has to grow its own opinion about which one was meant.
  const repeated = repeatedFlagError(expanded);
  if (repeated) flags.error ??= repeated;
  // AN EMPTY VALUE for a flag that names a target. `--app=` set `flags.app =
  // ""`, which is falsy, so the app id was INFERRED from the cwd and `am`
  // addressed something the caller never named. `--home=` and `--instance=`
  // have always refused; these two fell through.
  for (const a of expanded) {
    const eq = a.indexOf("=");
    if (eq === -1 || a.length !== eq + 1) continue;
    const msg = NEEDS_A_VALUE[a.slice(0, eq)];
    if (msg) flags.error ??= msg;
  }

  // A numeric flag that does not parse is recorded as `flags.error` (first
  // one wins) and `am` exits loud on it — `--lines=1O0` silently printing
  // the default line count is the same NaN bug class `parseNumArg` exists
  // for, and these flags predate it.
  // …WITH BOUNDS. `parseNumArg` takes `{ min, max, integer }` and every call
  // site here omitted them, so only NaN was refused and every out-of-range
  // value flowed through to something that could not act on it:
  // `--wait=-5` reached `setTimeout(-5000)` (Node's "Timeout duration was set
  // to 1" — a 1 ms poll, forever), `--lines=0` printed EVERY line because
  // `slice(-0)` is the whole array while the JSON said `"shown":0`,
  // `--lines=-5` reported `"shown":-5`, `--lines=1.5` produced
  // `"lines":[""]`, and `--port=0`/`--port=-1` leaked a raw Deno internal
  // ("Requests to port 0 are blocked", "Invalid URL") — which is exactly the
  // leak `cmdStart`'s comment says was fixed.
  const num = (
    raw: string,
    label: string,
    opts?: { min?: number; max?: number; integer?: boolean },
  ): number | undefined => {
    const r = parseNumArg(raw, label, opts);
    if (r.ok) return r.value;
    flags.error ??= r.error;
    return undefined;
  };
  for (const a of expanded) {
    if (a === "--json") flags.json = true;
    else if (a === "--data") flags.data = true;
    else if (a === "--print") flags.print = true;
    else if (a === "--tables") flags.tables = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--stale") flags.stale = true;
    else if (a === "--long" || a === "-l") flags.long = true;
    else if (a === "--as-server") flags.asServer = true;
    else if (a === "--quiet") flags.quiet = true;
    else if (a.startsWith("--port=")) {
      flags.port = num(a.slice(7), "--port", {
        min: 0, // 0 is real: `--port=0` means "pick a free one"
        max: 65535,
        integer: true,
      });
    } else if (a.startsWith("--body=")) flags.jsonBody = a.slice(7);
    else if (a.startsWith("--args=")) flags.jsonArgs = a.slice(7);
    else if (a.startsWith("--filter=")) flags.filter = a.slice(9);
    else if (a.startsWith("--lines=")) {
      flags.lines = num(a.slice(8), "--lines", { min: 1, integer: true });
    } else if (a.startsWith("--wait=")) {
      flags.wait = num(a.slice(7), "--wait", { min: 0 });
    } else if (a === "--wait") flags.wait = 0; // bare --wait = use default
    // `am start` waits by default; this is the opt-out for a script that only
    // wants the process spawned (see cmdStart).
    else if (a === "--no-wait") flags.noWait = true;
    else if (a === "--follow" || a === "-f") flags.follow = true;
    else if (a.startsWith("--entry=")) flags.entry = a.slice(8);
    else if (a.startsWith("--transport=")) flags.transport = a.slice(12);
    else if (a.startsWith("--app=")) flags.app = a.slice(6);
    else if (a.startsWith("--home=")) flags.home = a.slice(7);
    else if (a.startsWith("--profile=")) flags.profile = a.slice(10);
    else if (a.startsWith("--instance=")) flags.instance = a.slice(11);
    else if (a.startsWith("--timeout=")) {
      flags.timeout = num(a.slice(10), "--timeout", { min: 1, integer: true });
    } else if (a.startsWith("--client-index=")) {
      flags.client = num(a.slice(15), "--client-index", {
        min: 0,
        integer: true,
      });
    } else if (a === "--client-index") flags.client = 0;
    else if (a.startsWith("-i") && a.length > 2) {
      // `-i2` — attached short form of `--client-index=2`.
      flags.client = num(a.slice(2), "-i (client index)", {
        min: 0,
        integer: true,
      });
    } // ── deprecated spellings of the client INDEX (renamed in alpha52:
    // `--client=N` collides with the runtime's `--client=<kind>`, so an
    // `am`-vs-app confusion read as a valid flag on both sides). Accepted
    // through beta, with a hint naming the new one. ──
    else if (a.startsWith("--client=")) {
      // Numeric = the deprecated am client INDEX. Anything else is the
      // RUNTIME's --client=<kind> — forwarded as a positional so commands
      // that launch an app (`am ui --client=browser`) can pass it through.
      if (/^\d+$/.test(a.slice(9).trim())) {
        sayErr(
          "am: warning: --client=N is now --client-index=N (or -i N) — the old " +
            "spelling still works, but collides with the app runtime's " +
            "--client=<kind>",
        );
        flags.client = num(a.slice(9), "--client");
      } else {
        // Forwarded to the app (that is what this spelling is for) AND
        // remembered, so a command that asks "did the user mean the client?"
        // gets the right answer instead of a silent no.
        flags.clientKind = a.slice(9).trim();
        rest.push(a);
      }
    } else if (a.startsWith("-c") && a.length > 2) {
      // `-c2` was the short form of `--client=2`. `-c2x` used to fail the
      // isNaN test and fall through to the POSITIONAL args, where it became a
      // command argument — the same NaN class, silent one step further along.
      sayErr("am: warning: -cN is now -i N (client index)");
      flags.client = num(a.slice(2), "-c (client index)");
    } else if (a === "--client") flags.client = 0;
    else if (a === "--ui") flags.ui = true;
    else if (a === "--all") flags.all = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else rest.push(a);
  }
  rest.push(...tail);

  const command = rest[0] ?? "help";
  const args = rest.slice(1);
  return { command, args, flags };
}

/** The arguments a verb's handler reads: `args` without the first `--`.
 *
 *  The marker is kept through `parseGlobalFlags` so the flag gate knows where
 *  options end, and removed here so `am dispatch t:add -- --force` hands the
 *  method `"--force"` rather than `"--"` and `"--force"`. A PASSTHROUGH verb
 *  (`am start`, …) keeps it: its surplus arguments are forwarded to another
 *  program, and whether `--` means something there is that program's call. */
export function argsForHandler(
  args: readonly string[],
  passthrough: boolean,
): string[] {
  const at = args.indexOf("--");
  return passthrough || at === -1
    ? [...args]
    : [...args.slice(0, at), ...args.slice(at + 1)];
}

/** Parse a numeric CLI argument, or say why it is not one. Never returns NaN.
 *
 *  `Number("2s")` is NaN, and NaN is the SILENT kind of wrong: handed to
 *  `setTimeout` it becomes 1ms, so `am discover --timeout=2s` swept the LAN for
 *  one millisecond and then reported "no aio apps found" — complete with a
 *  confident note about UDP being blocked on some networks. The typo was in the
 *  flag; the answer sent people to their firewall. A flag we cannot read is an
 *  error, never a default and never a plausible-looking result.
 *
 *  Pure: the caller renders the message with its own `outError(…, mode)`. */
export function parseNumArg(
  raw: string | undefined,
  label: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): { ok: true; value: number } | { ok: false; error: string } {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(n)) {
    return {
      ok: false,
      error: `${label} must be a number (got "${raw}")` + appMeantHint(raw),
    };
  }
  if (opts.integer && !Number.isInteger(n)) {
    return {
      ok: false,
      error: `${label} must be a whole number (got "${raw}")`,
    };
  }
  if (opts.min !== undefined && n < opts.min) {
    return { ok: false, error: `${label} must be ≥ ${opts.min} (got ${n})` };
  }
  if (opts.max !== undefined && n > opts.max) {
    return { ok: false, error: `${label} must be ≤ ${opts.max} (got ${n})` };
  }
  return { ok: true, value: n };
}

/** " — did you mean `--app=x`?", when the unparseable value names a real app.
 *
 *  `am` takes its target through `--app`, because the first positional of most
 *  verbs is already a state path, an action or a client index. That is a
 *  defensible grammar and an easy one to forget, and the failure was worse
 *  than forgetting: `am surface my-app` answered
 *
 *      client index must be a number (got "my-app")
 *
 *  which is true, unhelpful, and says nothing about the flag that was meant.
 *  A message that knows the answer and does not say it costs a round trip.
 *
 *  Only fires when the value actually names something — a running instance or
 *  a declared component — so a genuine typo still gets the plain message.
 *  Never throws: a hint that can fail is worse than no hint. */
export function appMeantHint(raw: string | undefined): string {
  const v = raw?.trim();
  if (!v || /^[-\d.]/.test(v)) return "";
  try {
    const known = new Set<string>();
    for (const c of components()) {
      known.add(c.label);
      known.add(c.appId);
    }
    for (const i of instances()) known.add(i.appId);
    if (known.has(v)) {
      return ` — "${v}" is an app, not a ${""}value here. Did you mean \`--app=${v}\`?`;
    }
  } catch {
    // aio-ok: a hint is a convenience; failing to produce one must never turn
    // a readable error into an unreadable one.
  }
  return "";
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

// ── Command context (complexity audit) ──────────────────────────────
// The `mode/appId/port` preamble appeared 26× across am-cmd-* files, and the
// `if (!result.ok) { outError; exit(1) }` guard 18× — every new command
// re-typed both. One resolver + one guard.

/** Everything a command needs to talk to a running app. */
export type AmCtx = {
  mode: ReturnType<typeof detectMode>;
  appId: string;
  port: number;
};

/** Resolve the standard command context from global flags. */
/** Where an app's durable journal lives, for the commands that read one
 *  without being told (`am record`, `am timeline --from`, `am replay`).
 *
 *  `<data>/journal` is the answer for any app on the current layout. The legacy
 *  `./data.db.journal` is still accepted as a fallback so a developer sitting in
 *  an un-migrated project directory gets their file rather than a "no journal"
 *  error — the app itself migrates it on its next boot. */
export function defaultJournalPath(appId: string): string {
  const current = appDirs(appId).journal;
  try {
    Deno.statSync(current);
    return current;
  } catch { /* not there — try the pre-alpha38 location */ }
  const legacy = join(projectRoot(), "data.db.journal");
  try {
    Deno.statSync(legacy);
    return legacy;
  } catch { /* neither exists — report the current path in the error */ }
  return current;
}

export function amCtx(flags: GlobalFlags): AmCtx {
  const appId = resolveAmAppId(flags.app);
  return {
    mode: detectMode(flags),
    appId,
    port: resolvePort(flags.port, appId),
  };
}

/** GET a trojan route and print the result — exits(1) loudly on failure.
 *  The one-call body of most read-only am commands. */
export async function runTrojanGet(
  ctx: AmCtx,
  route: string,
  timeoutMs?: number,
): Promise<void> {
  const result = await trojanGet(ctx.port, route, ctx.appId, timeoutMs);
  if (!result.ok) {
    outError(result.error, ctx.mode);
    Deno.exit(1);
  }
  outValue(result.data, ctx.mode);
}

/** POST to a trojan route and print the result — exits(1) loudly on failure. */
export async function runTrojanPost(
  ctx: AmCtx,
  route: string,
  body: unknown,
): Promise<void> {
  const result = await trojanPost(ctx.port, route, body, ctx.appId);
  if (!result.ok) {
    outError(result.error, ctx.mode);
    Deno.exit(1);
  }
  outValue(result.data, ctx.mode);
}

// ── App names are names, never paths ────────────────────────

/** THE shape of an app name — one decider for every command that takes one.
 *
 *  `am create` has always validated its name; `am remove` and `am upgrade`
 *  took theirs raw and fed it straight to `join()`, which NORMALIZES. So
 *  `am remove ..` resolved `~/app/..` → `$HOME` and `~/.local/bin/..` →
 *  `~/.local` and deleted both, recursively, exit 0 (measured); `am remove .`
 *  took `~/app` (every installed app) and `~/.local/bin` (every symlink on the
 *  machine, aio's and not); `am remove . --data` resolved its data dir to
 *  `dirname($HOME)`. An app name that is not a plain name is never a typo
 *  worth guessing at — it is the only input that can turn a two-word command
 *  into `rm -rf $HOME`.
 *
 *  Leading `.` is excluded on purpose: that is what makes `.`, `..` and
 *  `../../..` unrepresentable rather than merely unlikely. */
export const APP_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/** `null` when `name` is a plain app name, else the refusal — cause AND fix. */
export function appNameError(name: string, verb: string): string | null {
  if (APP_NAME_RE.test(name)) return null;
  return `"${name}" is not an app name — ${verb} takes the NAME of an ` +
    `installed app, never a path.\n` +
    `  A name starts with a letter or digit, then letters, digits, '-', ` +
    `'_', '.'\n` +
    `  (".", ".." and "a/b" are refused because join() normalizes them: ` +
    `am remove .. would delete $HOME)\n` +
    `  fix: am installed   # lists the names this machine has`;
}

// `RESERVED_APP_NAMES` lives with the home rule it protects (app-dirs.ts),
// because the BOOT refuses those names too — `am create` is not the only way
// an app gets a name. Re-exported here so `am`'s import stays what it was.
export { RESERVED_APP_NAMES };

/** `null` when `name` may be an app's name, else the refusal — cause and fix.
 *  Case-insensitive: `~/.SSH` is `~/.ssh` on macOS and Windows. */
export function reservedAppNameError(
  name: string,
  verb: string,
): string | null {
  if (!RESERVED_APP_NAMES.has(name.toLowerCase())) return null;
  return `"${name}" is reserved — ${verb} would use ~/.${name} as the app's ` +
    `data directory, and that directory belongs to ${
      name.toLowerCase() === "aio"
        ? "aio itself (the machine CA and release keys)"
        : "another program"
    }.\n  fix: pick another name`;
}

/** Refuse to write over a file that is already there, unless `--force`.
 *
 *  `am backup` has always guarded exactly this: "already exists — pick another
 *  destination". `am snapshot save <path>` and `am record <path>` took an
 *  arbitrary path and clobbered it without a word — same command family, same
 *  kind of argument, opposite behaviour, and the difference is invisible until
 *  the file that vanishes is one someone needed. Returns the refusal, or null.
 *
 *  Pure over the filesystem's answer, so the message is testable. */
export function overwriteRefusal(
  path: string,
  force: boolean,
  what: string,
): string | null {
  if (force) return null;
  try {
    Deno.statSync(path);
  } catch {
    return null; // nothing there — free to write
  }
  return `${path} already exists — refusing to overwrite it with ${what}.\n` +
    `  fix: pick another path, or pass --force to replace it.`;
}
