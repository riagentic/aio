/**
 * @module
 * Utility functions for am — aio manager CLI.
 * Path resolution, payload parsing, entry/appId/port resolution.
 */

import { readDenoJsonSync } from "../server/deno-json.ts";
import { envPort, resolveEntryPath } from "../server/paths.ts";
import {
  type InstanceInfo,
  instances,
  type LockData,
  lockKey,
  readLock,
  removeLock,
  resolveAppId,
  writeLock,
} from "../server/single-instance-lock.ts";
import { basename, join } from "@std/path";
import { appDirs, registerAppDirs } from "../server/app-dirs.ts";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, fail, out, outError } from "./am-output.ts";
import { trojanGet, trojanPost } from "./am-http.ts";
import { type Component, projectComponents } from "./am-components.ts";

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
    return projectComponents(Deno.cwd());
  } catch {
    return []; // unreadable project — the inference below is still honest
  }
}

function refuseAmbiguousApp(labels: string[]): never {
  const list = labels.join(", ");
  const msg = `this project has several components (${list}) and this ` +
    `command acts on one — pick one with --app=${labels[0]}, or manage the ` +
    `project as a whole with am start | am stop | am status`;
  // Through THE failure path, so a scripted caller gets `{"error": …}` on
  // stdout like every other refusal instead of a human line it cannot parse.
  // `resolveAmAppId` is called too deep to be handed the parsed flags, so the
  // mode is read the way `detectMode` reads it.
  const mode: "json" | "pretty" = Deno.args.includes("--json") ||
      !Deno.stdout.isTerminal()
    ? "json"
    : "pretty";
  if (mode === "pretty") {
    console.error(
      `[am] ✗ this project has several components (${list}) and this command ` +
        `acts on one.\n` +
        `    Pick one:  --app=${labels[0]}\n` +
        `    Or manage the project as a whole: am start | am stop | am status`,
    );
    Deno.exit(1);
  }
  fail(msg, mode);
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
    const cfg = readDenoJsonSync(Deno.cwd())?.config as
      | { appId?: string }
      | undefined;
    if (cfg?.appId) return resolveAppId(cfg.appId);
  } catch { /* no deno.json */ }
  const ec = readEntryConfig();
  if (ec.appId) return resolveAppId(ec.appId);
  // Zero-config apps (aio.run() with no appId) — mirror the server's
  // inference chain: deno.json title/name, then the project directory name.
  try {
    const cfg = readDenoJsonSync(Deno.cwd())?.config as
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
  const dir = basename(Deno.cwd());
  if (dir) return resolveAppId(dir);
  throw new Error(
    '[am] missing appId — pass --app=X, add "appId" to deno.json, or set appId in aio.run()',
  );
}

/** The port this app has DECLARED, or undefined when it has declared none.
 *
 *  THE SAME three rungs the runtime resolves, in the same order (`aio.ts`:
 *  `cli.port ?? envPort() ?? config.port ?? await findFreePort()`):
 *  `--port` > `AIO_PORT` > the entry's `aio.run({ port })`.
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
  return readEntryConfig().port;
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
    const cfg = JSON.parse(
      Deno.readTextFileSync(join(Deno.cwd(), "deno.json")),
    ) as { port?: number };
    if (typeof cfg.port !== "number") return;
    _warnedDenoJsonPort = true;
    console.error(
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
  try {
    cfg = readDenoJsonSync(Deno.cwd())?.config ?? {};
  } catch { /* no deno.json — the default still applies */ }
  const entry = resolveEntryPath(cfg);
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
export function targetHome(appId: string, home: string): void {
  registerAppDirs(appId, appDirs(appId, home));
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
  const live = running.filter((i) => i.alive);
  if (live.length !== 1) return;
  const home = live[0]!.home;
  if (!home || home === appDirs(appId).home) return;
  registerAppDirs(appId, appDirs(appId, home));
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
  return lockKey(appId, appDirs(appId).home);
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
  const running = instances(id);
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

/** Remove a lock. With `pf` — the lock a command actually READ (via
 *  {@linkcode liveLock}) — the removal targets that instance's key, wherever
 *  its home is; without it, the home-keyed key `am` computes. Removing by id
 *  alone after reading by `liveLock` would miss an `<id>@<hash>` lock and
 *  leave the stale record `am status` just called stale. */
export function removePid(appId?: string, pf?: LockData | null): void {
  removeLock(
    pf ? lockKey(pf.appId, pf.home) : amLockKey(appId ?? resolveAmAppId()),
  );
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
  if (pf) return pf.port;

  const live = instances();
  // The "one running instance" rung exists for a GUESSED id — the cwd's. An
  // id the user typed (`--app=X`) is not a guess: when X is not running, the
  // answer is "X is not running", never "so here is Y" — `am dispatch --app=X`
  // must not mutate Y after a note on stderr.
  if (live.length === 1 && !opts.explicit) {
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
      console.error(
        `[am] note: no app named "${id}" is running — using the one that ` +
          `is: ` +
          `${only.appId} @ ${
            only.socketPath ? "uds" : `:${only.port}`
          } (pid ${only.pid}). ` +
          `Pin it with --app=${only.appId}, or run am from its directory.`,
      );
    }
    return only.port;
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

/** Parse CLI arguments into command, positional args, and global flags (--json, --quiet, --port, --app) */
export function parseGlobalFlags(
  raw: string[],
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
    "--timeout",
  ]);
  const expanded: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!;
    if (takesValue.has(a) && i + 1 < raw.length) {
      expanded.push(`${a}=${raw[++i]}`);
    } else if (a === "-i" && i + 1 < raw.length) {
      // `-i N` — the short form of `--client-index=N`.
      expanded.push(`--client-index=${raw[++i]}`);
    } else expanded.push(a);
  }

  // A numeric flag that does not parse is recorded as `flags.error` (first
  // one wins) and `am` exits loud on it — `--lines=1O0` silently printing
  // the default line count is the same NaN bug class `parseNumArg` exists
  // for, and these flags predate it.
  const num = (raw: string, label: string): number | undefined => {
    const r = parseNumArg(raw, label);
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
    else if (a.startsWith("--port=")) flags.port = num(a.slice(7), "--port");
    else if (a.startsWith("--body=")) flags.jsonBody = a.slice(7);
    else if (a.startsWith("--args=")) flags.jsonArgs = a.slice(7);
    else if (a.startsWith("--filter=")) flags.filter = a.slice(9);
    else if (a.startsWith("--lines=")) flags.lines = num(a.slice(8), "--lines");
    else if (a.startsWith("--wait=")) flags.wait = num(a.slice(7), "--wait");
    else if (a === "--wait") flags.wait = 0; // bare --wait = use default
    // `am start` waits by default; this is the opt-out for a script that only
    // wants the process spawned (see cmdStart).
    else if (a === "--no-wait") flags.noWait = true;
    else if (a === "--follow" || a === "-f") flags.follow = true;
    else if (a.startsWith("--entry=")) flags.entry = a.slice(8);
    else if (a.startsWith("--transport=")) flags.transport = a.slice(12);
    else if (a.startsWith("--app=")) flags.app = a.slice(6);
    else if (a.startsWith("--home=")) flags.home = a.slice(7);
    else if (a.startsWith("--timeout=")) {
      flags.timeout = num(a.slice(10), "--timeout");
    } else if (a.startsWith("--client-index=")) {
      flags.client = num(a.slice(15), "--client-index");
    } else if (a === "--client-index") flags.client = 0;
    else if (a.startsWith("-i") && a.length > 2) {
      // `-i2` — attached short form of `--client-index=2`.
      flags.client = num(a.slice(2), "-i (client index)");
    } // ── deprecated spellings of the client INDEX (renamed in alpha52:
    // `--client=N` collides with the runtime's `--client=<kind>`, so an
    // `am`-vs-app confusion read as a valid flag on both sides). Accepted
    // through beta, with a hint naming the new one. ──
    else if (a.startsWith("--client=")) {
      // Numeric = the deprecated am client INDEX. Anything else is the
      // RUNTIME's --client=<kind> — forwarded as a positional so commands
      // that launch an app (`am ui --client=browser`) can pass it through.
      if (/^\d+$/.test(a.slice(9).trim())) {
        console.error(
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
      console.error("am: warning: -cN is now -i N (client index)");
      flags.client = num(a.slice(2), "-c (client index)");
    } else if (a === "--client") flags.client = 0;
    else if (a === "--ui") flags.ui = true;
    else if (a === "--all") flags.all = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else rest.push(a);
  }

  const command = rest[0] ?? "help";
  const args = rest.slice(1);
  return { command, args, flags };
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
  const legacy = join(Deno.cwd(), "data.db.journal");
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
  out(result.data, ctx.mode);
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
  out(result.data, ctx.mode);
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
