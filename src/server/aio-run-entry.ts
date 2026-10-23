// Run entry — `aio.run()`: the app's own flags, config resolution, the
// per-app update/feedback slots and the boot-refusal line, around the call
// into aio.ts's `_run`. Split out of aio.ts, which re-exports every name here,
// so no importer changes. aio.ts and this module import each other: only
// function declarations cross back (`_run`, `electronRuntimeAnswer`), and no
// top-level statement of either reads the other, so evaluation order is that
// of the single file it was.

import { validateMemoryConfig } from "../diagnostics/memory-monitor.ts";
import { refuseRetired } from "../state/removals.ts";
import { runtimeCount } from "./shutdown.ts";
import {
  appLoggerInstalled,
  log,
  setLogger,
} from "../diagnostics/logger-api.ts";
import { teachableError } from "../diagnostics/error.ts";
import { isDevBoot } from "./aio-boot.ts";
import { hostedCellName, startCellWorkerHost } from "./cell-worker-host.ts";
import { validateSchedules } from "../state/schedule.ts";
import { dbPathOf, isolateOf } from "./config-sources.ts";
import {
  dbPathOutsideHomeError,
  homeRequested,
  planAppDirs,
  recordAppDirs,
  registerAppDirs,
} from "./app-dirs.ts";
import { composeCellsWiring } from "./aio-composition.ts";
import {
  buildLegacyConfig,
  filterCellsByIsolate,
  initLogger,
  runAsApp,
  wrapAppWithCells,
} from "./aio-cells-bridge.ts";
import { getRegisteredCells } from "../state/cell-reactive.ts";
import {
  _releaseUpdatesClaim,
  _updatesForApp,
  type UpdatesSlot,
} from "../state/updates-cell.ts";
import {
  _feedbackForApp,
  _releaseFeedbackClaim,
  type FeedbackSlot,
} from "../state/feedback-cell.ts";
import {
  declareAppFlags,
  homeRequest,
  instanceRequest,
  parseCli,
  printHelp,
  versionLine,
} from "./aio-cli.ts";
import { beginFeedback } from "./feedback-boot.ts";
import { beginUpdates, windowGate } from "./updates-boot.ts";
import {
  inferredIdFallbackWarning,
  resolveAppId,
} from "./single-instance-lock.ts";
import { assertDenoVersion } from "./deno-version.ts";
import { removalMessage, removalOf } from "../state/removals.ts";
import { resolve } from "@std/path";
import { composeAsyncHooks, composeHooks, resolvePlugins } from "./plugin.ts";
import { releaseProcessListenersIfIdle } from "./shutdown.ts";
import type { AioApp, CellsConfig } from "./aio-types.ts";
import {
  refuseWrongShapes,
  VALID_FEATURES_CONFIG_KEYS,
  VALID_UI_KEYS,
  validateCallableConfig,
  validateConfig,
} from "./config.ts";
import { describeThrown } from "../diagnostics/fmt.ts";
import { declaredHue } from "../build/app-icon.ts";
import { appDenoJson } from "./aio-run-helpers.ts";
import { _run, electronRuntimeAnswer } from "./aio.ts";
import {
  _appVersion,
  _configExit,
  _exposeOf,
  _helpFacts,
  _warnMisplacedDenoJson,
  exposeReason,
  stderrOnlyLogSink,
} from "./aio-run-config.ts";

/** Single entry point — boots KV, server, electron, wires everything. CLI
 *  args override config. (perfect-aio D9: the legacy 2-arg
 *  `aio.run(initialState, config)` overload was removed — zero callers
 *  existed; `aio.run({ cells })` / zero-config `aio.run()` is the API.)
 *
 *  Optionally TYPED (alpha52, additive): `aio.run<MyAppState>({ cells })`
 *  types `app.state` / `app.getState()` instead of `any`. The default stays
 *  `any` for compatibility — existing untyped calls infer exactly as before. */
// deno-lint-ignore no-explicit-any
export async function run(fc?: CellsConfig): Promise<AioApp<any, any>>;
// Typed overload — selected only by an explicit type argument, so untyped
// calls keep the exact pre-alpha52 `any` inference (no new circularity in
// configs whose closures reference the resulting app).
export async function run<S extends Record<string, unknown>>(
  fc?: CellsConfig,
  // deno-lint-ignore no-explicit-any
): Promise<AioApp<S, any>>;
// deno-lint-ignore no-explicit-any
export function run(a?: any, b?: any): Promise<AioApp<any, any>> {
  // AS ITS APP: every line, diagnostic and `degraded()` failure this boot —
  // and every handler, socket and timer it starts — belongs to this app, not
  // to whichever app in the process booted last (`runAsApp`). Before its
  // logger exists the app is console-only.
  return runAsApp(() => _runAsApp(a, b));
}

// deno-lint-ignore no-explicit-any
async function _runAsApp(a?: any, b?: any): Promise<AioApp<any, any>> {
  // ── the app's OWN flags join the vocabulary before argv is ever read ──
  //
  // This used to happen at the end of config composition, ~120 lines below —
  // long after the `--help` query on the very next line calls `parseCli()`,
  // which REFUSES an unknown flag by throwing. So `appFlags` never worked at
  // all: `aio.run({ appFlags: ["--sync"] })` invoked as `app --sync` died in
  // the parser before the declaration it needed was made. That is the escape
  // hatch every "unknown flag" error names ("declare it: aio.run({ appFlags:
  // [...] })"), so the remedy aio recommends was itself broken, and
  // `deno task soak`/`soak:72h` — a named beta gate — could not start.
  //
  // `declareAppFlags` clears the parse cache, so declaring here is what makes
  // every later `parseCli()` see the app's vocabulary. Plugins contribute no
  // flags (the merge below touches routes/schedules/origins/hooks only), so
  // the raw config is the whole truth at this point.
  if (typeof a === "object" && a && "appFlags" in a) {
    declareAppFlags((a as CellsConfig).appFlags);
  }
  // ── `--help` is a QUERY: it must not boot the app ──
  //
  // This check used to live in `_run`, three phases later — by which time the
  // composition report had printed ("cells: counter", "cells: counter
  // visible=all persist=all") and, worse, the logger had ROTATED the app's log
  // files: `app.log` → `app.log.1`, one generation lost off the end of `keep`
  // every time someone asked what the flags were. Asking a binary for its usage
  // is the safest thing anyone does with it; it must have no side effects at
  // all. Same reasoning as `--aio-data-contract` below, one step earlier.
  // A TYPO IS THE COMMONEST THING ANYONE GETS WRONG AT A CLI, and it got the
  // ugliest answer in the framework. The message `parseCli` throws is
  // carefully teachable — it names the flag, offers `appFlags`, and explains
  // why a bare `--` cannot help a compiled binary — and it reached the user
  // wrapped in `error: Uncaught (in promise)` with five frames of aio
  // internals above it (the shape a field report quoted, verbatim, in
  // tests/app-flags.test.ts's header). Every other refusal at this stage
  // ("Already running", a bad config) prints one line and exits.
  //
  // `console.error`, not the logger: installing the logger is a side effect
  // this phase deliberately avoids (see `--help` just below), and it would
  // stamp a timestamp and a category on the answer to "what did I type
  // wrong". `libraryMode` keeps the throw — an embedding host and the test
  // harness want the exception, not an exit, and `libraryMode` is the
  // documented flag for exactly that ("no Deno.exit, no SIGINT handlers, no
  // singleton lock"). Exiting when it is OFF follows the precedent already in
  // this file: `judgePendingUpdate` below ends the process the same way, under
  // the same `!config.libraryMode` guard, for the same kind of fatal pre-boot
  // condition.
  try {
    parseCli();
  } catch (e) {
    const cfg = typeof a === "object" && a !== null
      ? a as { libraryMode?: boolean }
      : null;
    if (cfg?.libraryMode) throw e;
    // aio-ok: the logger is not installed yet, and installing it is the side
    // effect this phase exists to avoid — `--help` and `--version` below take
    // the same exemption for the same reason. A levelled line would also stamp
    // a timestamp and a category on the answer to "what did I type wrong".
    console.error(e instanceof Error ? e.message : String(e));
    Deno.exit(1);
  }
  if (parseCli().help) {
    printHelp(_helpFacts(typeof a === "object" && a ? a.client : undefined));
    Deno.exit(0);
  }
  // ── …and `--version`, for the same reason and one of its own ──
  //
  // It sat three phases later, AFTER `resolveAppDirs` — so a compiled binary
  // asked for its version with `$HOME` unset answered with a stack trace out
  // of the directory resolver, and with `$HOME` set it printed two boot lines,
  // ROTATED the app's log files and ended with a stray empty `detail=` field.
  // Asking an artifact what it is must cost nothing and touch nothing.
  //
  // `console.log`, not `log.info`: this is the answer itself, and the logger
  // would stamp it with a timestamp and a category — and installing the logger
  // is the side effect being avoided.
  if (parseCli().version) {
    // An artifact has to be able to say what it IS and what it was built with
    // — a binary found on a server months later is otherwise unidentifiable,
    // and "which aio is this running?" is the first question when it
    // misbehaves. Same sources the app itself uses for its identity
    // (`resolveAppId` handles the compiled-binary case), so `--version` cannot
    // describe a different app than the one that would boot.
    // aio-ok: the answer itself — a log stamp would prefix what a script reads.
    console.log(
      versionLine(
        resolveAppId(typeof a === "object" && a ? a.appId : undefined),
        await _appVersion(),
      ),
    );
    Deno.exit(0);
  }
  // …and `--aio-electron-runtime` (aio-cli.ts): the same cost-nothing rule,
  // because an updater asks it of a build it has not installed yet.
  if (parseCli().electronRuntime) {
    // aio-ok: the machine-readable answer itself (read by updates-runtime.ts).
    console.log(JSON.stringify(await electronRuntimeAnswer()));
    Deno.exit(0);
  }
  // `--instance=<name>`: this process's apps root, set BEFORE anything
  // resolves a home, a lock or a socket — `AIO_APPS_DIR` is what scopes all
  // three, read live, so one variable set here isolates the whole boot (and
  // every process it starts inherits it), exactly as `am --instance` does
  // for its child. Not for an embedded app: the argv is its host's.
  if (!(typeof a === "object" && a?.libraryMode)) {
    const req = instanceRequest();
    const explicit = req ? Deno.env.get("AIO_APPS_DIR") : undefined;
    if (req && !explicit) Deno.env.set("AIO_APPS_DIR", req.appsDir);
    else if (req && resolve(explicit!) !== resolve(req.appsDir)) {
      // aio-ok: pre-logger (the `--help` exemption above) — and an ignored
      // isolation request must never pass silently.
      console.error(
        `warning: --instance=${req.name} is ignored — AIO_APPS_DIR is set ` +
          `(${explicit}) and wins, so this runs in that scope, not ` +
          `${req.appsDir}. Unset AIO_APPS_DIR to use --instance.`,
      );
    }
  }
  // Fail fast on an unsupported Deno — aio uses ≥2.9 behavior directly.
  assertDenoVersion();
  if (b !== undefined) {
    // Message comes from the removal registry — one decider for every
    // "that spelling is gone" the framework prints (src/state/removals.ts).
    throw new Error(removalMessage(removalOf("aio.run(initialState, config)")));
  }

  // Cells-based API: aio.run(cellsConfig) — zero-config: aio.run()
  let fc = (a ?? {}) as CellsConfig;
  // Hook authorship is read HERE, from the object the app actually wrote, and
  // nowhere later. Every rebuild below materialises omitted hooks — the plugin
  // merge writes `onStopping: fc.onStopping` and composes the rest, the cells
  // bridge spreads them again — so downstream "the key is present" stops
  // meaning "the app wrote it", and warning there fired on every boot of every
  // app about hooks it had never mentioned.
  validateCallableConfig(fc as unknown as Record<string, unknown>);
  // The SHAPE of every key, BEFORE the first reader of one — and the plugin
  // merge just below is that reader. It spreads `allowedOrigins` and `routes`,
  // and a spread bare string becomes its characters, so with a plugin loaded
  // `allowedOrigins: "https://app.example.com"` reached `validateConfig` as a
  // valid array of 23 one-character origins and the Origin gate became the
  // substring test SHAPE_VALUES exists to stop. `resolvePlugins(fc.plugins…)`
  // on the next line reads one more. Same function `validateConfig` runs
  // below — one decider, called at the moment the answer is first needed.
  refuseWrongShapes(fc as unknown as Record<string, unknown>, "CellsConfig");
  // ── Plugins ──
  //
  // FIRST, before any other config key is read, so every reader below sees one
  // merged config and no code path can be written that forgets plugins exist.
  //
  // Everything a plugin contributes goes through the SAME keys `aio.run()`
  // already has — cells, routes, schedules, allowedOrigins, the observe-only
  // hooks — so a plugin can never do anything the app could not have written
  // itself, and reading the merged config still explains the whole app. The
  // app's own values are applied OVER the plugins': adding a plugin can never
  // take a behaviour away. A collision between two plugins throws at boot,
  // naming both, because whichever loaded second would otherwise silently
  // shadow the first.
  const _plugins = await resolvePlugins(fc.plugins, {
    appId: resolveAppId(fc.appId),
    dev: isDevBoot(),
  });
  if (_plugins.names.length) {
    const _pluginErr = (e: unknown) => log.error(`plugin hook error: ${e}`);
    fc = {
      ...fc,
      routes: Object.keys(_plugins.routes).length
        // App FIRST, in insertion order, and a plugin entry only for a key the
        // app did not write. The matcher tries patterns in insertion order, and
        // `{ ...plugins, ...app }` put every plugin pattern ahead of the app's
        // (a key keeps its FIRST position even when a later spread overwrites
        // its value) — so a plugin's `/*` or `/files/:name` answered the app's
        // own `/files/*` and `/api/:thing`. An app route with the same key
        // still wins outright, as before.
        ? {
          ...(fc.routes ?? {}),
          ...Object.fromEntries(
            Object.entries(_plugins.routes).filter(([k]) =>
              !Object.hasOwn(fc.routes ?? {}, k)
            ),
          ),
        }
        : fc.routes,
      schedules: _plugins.schedules.length
        ? [..._plugins.schedules, ...(fc.schedules ?? [])]
        : fc.schedules,
      allowedOrigins: _plugins.allowedOrigins.length
        ? [
          ...new Set([
            ...(fc.allowedOrigins ?? []),
            ..._plugins.allowedOrigins,
          ]),
        ]
        : fc.allowedOrigins,
      onAction: composeHooks(_plugins.onAction, fc.onAction, _pluginErr),
      onEffect: composeHooks(_plugins.onEffect, fc.onEffect, _pluginErr),
      onConnect: composeHooks(_plugins.onConnect, fc.onConnect, _pluginErr),
      onDisconnect: composeHooks(
        _plugins.onDisconnect,
        fc.onDisconnect,
        _pluginErr,
      ),
      onStart: composeAsyncHooks(
        _plugins.onStart,
        fc.onStart,
        "start",
        _pluginErr,
      ),
      // Unwinding order: the app's own `onStop` runs FIRST, then plugins in
      // reverse, so a plugin that opened something in `onStart` closes it
      // after the app code that was using it has finished.
      // No plugin twin: `onStopping` quiesces the APP's own producers, and a
      // plugin that owns one closes it in its `onStop` as it always has.
      onStopping: fc.onStopping,
      onStop: composeAsyncHooks(_plugins.onStop, fc.onStop, "stop", _pluginErr),
      _pluginNames: _plugins.names,
    } as CellsConfig;
  }
  // ── `--aio-data-contract` is a QUERY, and its stdout is MACHINE-READ ──
  //
  // `aio ship` and `updates-rebuild` run `<binary> --aio-data-contract` and
  // JSON.parse its stdout. Booting normally wrote the composition report, the
  // log-rotation notice and the contract itself through the logger, so stdout
  // was four INFO lines plus a JSON body whose first line carried a timestamp
  // preamble — unparseable, and `ship` silently published every release with
  // "data NOT DECLARED", which is the guarantee the update feature leads with.
  // Silencing by level is not the fix either (it removed the contract too).
  // So: for this mode ONLY, every framework line goes to stderr for the whole
  // boot and stdout carries the JSON and nothing else (printed raw, below).
  // Observe-only, and identical in dev and prod.
  const _contractMode = parseCli().dataContract;
  if (_contractMode) setLogger(stderrOnlyLogSink());
  // `appVersion` is retired (alpha70): deno.json `version` is the ONE place
  // an app's version is decided (docs/build/versioning.md). Dev refuses;
  // prod logs the registry line and IGNORES the key — the derived version is
  // what every surface reports either way.
  if ("appVersion" in fc) {
    refuseRetired(removalOf("aio.run({ appVersion })"), "aio.run");
    delete (fc as Record<string, unknown>).appVersion;
  }
  // `killExisting` is retired (alpha76): the flag has been `--takeover` since
  // alpha52 and the key had not moved, so a COMPILED service binary — which
  // cannot pass a flag — was forced to write the deprecated spelling. Dev
  // refuses; prod logs the registry line and HONOURS the old key, because a
  // service that silently stopped taking over its own lock would fail to boot
  // rather than fail loudly.
  if ("killExisting" in fc) {
    refuseRetired(removalOf("aio.run({ killExisting })"), "aio.run");
    const legacy = (fc as Record<string, unknown>).killExisting;
    delete (fc as Record<string, unknown>).killExisting;
    if (fc.takeover === undefined) fc.takeover = legacy as boolean;
  }
  validateConfig(
    fc as unknown as Record<string, unknown>,
    VALID_FEATURES_CONFIG_KEYS,
    "CellsConfig",
    _configExit(fc.libraryMode),
  );
  // Statically knowable, so it is refused while it is still config — not out
  // of scheduleManager.start() once persistence is open and the port is bound.
  if (fc.schedules !== undefined) validateSchedules(fc.schedules);
  // Post-merge: refuse a non-function, but do not read absence as intent —
  // authorship was checked above, on the app's own object.
  validateCallableConfig(fc as unknown as Record<string, unknown>, false);
  // BEFORE anything reads argv. The app's own verbs join aio's vocabulary
  // here, so a declared flag is passed through rather than refused — and a
  // typo in one gets the same did-you-mean as a typo in aio's own.
  declareAppFlags(fc.appFlags);
  if (fc.ui) {
    validateConfig(
      fc.ui as Record<string, unknown>,
      VALID_UI_KEYS,
      "ui",
      _configExit(fc.libraryMode),
    );
  }
  // An app with `memory` and no `ui` had its memory keys accepted unchecked,
  // typos and all — the check lived inside the `ui` one. It still boots (the
  // surface is frozen: refusing what booted yesterday is a break), but the
  // typo is now said out loud. With `ui` it was always a refusal.
  if (fc.memory && !fc.ui) {
    try {
      validateMemoryConfig(fc.memory as Record<string, unknown>);
    } catch (e) {
      log.warn(`${(e as Error).message}\n  (ignored — this key does nothing)`);
    }
  } else if (fc.memory) {
    validateMemoryConfig(fc.memory as Record<string, unknown>);
  }
  // …and the OTHER file people put aio config in. `aio.run()` refuses an
  // unknown key loudly; deno.json accepted `ui: { width, height }` at the top
  // level, did nothing with it, and said nothing about it — the shape a field
  // report called "the worst available behaviour", and it became a bullet in
  // their project docs instead of a message from us. Warn (not throw): the
  // file belongs to Deno and other tools keep their own sections in it, so the
  // right answer is to name the key and where it belongs.
  _warnMisplacedDenoJson();
  // deno.json `hue` is refused at boot, not at the first icon it would draw.
  declaredHue(appDenoJson());
  // Multi-instance (perfect-aio D2): several aio.run() calls may coexist in
  // one process — each app's cells bind exclusively (bindCell throws on a
  // def already bound to another app), each appId takes its own singleton
  // lock, and zero-config auto-cells only work for the FIRST app (later apps
  // must pass explicit disjoint `cells:` lists — the bind error says so).

  // Hoisted out of the `try` so a boot that REFUSES can put back what it had
  // already started — see the catch below.
  let logger: Awaited<ReturnType<typeof initLogger>> = null;
  const appRef = {
    current: null as AioApp<Record<string, unknown>, unknown> | null,
  };
  // …and the builtin-cell slots, whose process-slot CLAIM the `finally` gives
  // back once this boot has bound them or refused (see `_feedbackForApp`).
  let _updatesSlot: UpdatesSlot | undefined;
  let _feedbackSlot: FeedbackSlot | undefined;
  // The app's data home — planned and registered ONCE per boot, by whichever
  // comes first: the boot itself, or a refusal thrown before it got there
  // (which needs the log directory to say why). Throws when the folder itself
  // is refused.
  let homeReady = false;
  /** Where the home would be — reads the disk, writes nothing. */
  const planHome = () => {
    const appId = resolveAppId(fc.appId);
    // `--profile` / `--home` (+ AIO_PROFILE): the RUNNER's say.
    const request = fc.libraryMode ? undefined : homeRequest();
    const plan = planAppDirs({
      appId,
      appDir: fc.appDir,
      libraryMode: fc.libraryMode,
      baseDir: fc.baseDir,
      request,
      profiles: fc.profiles,
    });
    return { appId, request, plan };
  };
  const readyHome = (): void => {
    if (homeReady) return;
    const { appId: _earlyAppId, request, plan } = planHome();
    // A zero-config id whose inference rule changed under an app that
    // already has data: the resolver kept the OLD id (never a silent fresh
    // start, never a refused boot) — said once per boot, with both paths
    // and both fixes (see legacyIdFallback). Only a DERIVED home moves.
    if (!fc.appId && !fc.appDir && !fc.libraryMode && !plan.requested) {
      const fallback = inferredIdFallbackWarning();
      if (fallback) log.warn(fallback);
    }
    // An explicit dbPath outside the requested home opens the DEFAULT
    // home's database under a profile's lock and logs — refused BEFORE the
    // plan is recorded, so a caught refusal leaves no profile behind.
    const split = plan.requested
      ? dbPathOutsideHomeError(
        dbPathOf(parseCli(), fc)?.value,
        plan.dirs.home,
        request?.source,
      )
      : null;
    if (split) throw new Error(split);
    const _earlyDirs = recordAppDirs(_earlyAppId, plan);
    registerAppDirs(_earlyAppId, _earlyDirs);
    // A requested home IS the appDir from here on: many readers call
    // `appDirs(appId, cfg.appDir)` with the author's value, which would name
    // the base home instead of the profile's.
    if (homeRequested(_earlyAppId)) fc = { ...fc, appDir: _earlyDirs.home };
    homeReady = true;
  };
  try {
    // A function of its own: see `_recoverSyncLogs` (an Error built under a
    // call site deep in one long function costs in step with that depth).
    return await _composeAndRun();
  } catch (e) {
    // A BOOT THAT REFUSES LEAVES NOTHING BEHIND.
    //
    // The logger is installed before `_run()` and torn down by the app's
    // shutdown — which a refusal (a lint error, a config conflict, a
    // persistence that will not open) never reaches. So a refused boot left
    // the heartbeat interval and the pending flush of its own refusal line
    // armed: the caller got a correct error and a process that would not
    // exit — the "worst of both" shape `logger-core.ts` describes, answered
    // there with an unref that only hides it from the event loop. The op
    // sanitizer named it in every test that asserts a refusal. Torn down
    // HERE, the same way shutdown does it: stop, drain, detach — and an app
    // that did come up before the throw (a hook after `_run`) closes fully.
    // The refusal itself is what the caller sees; a teardown fault is said
    // out loud beside it, never instead of it.
    // Refused BEFORE the logger existed (a cell that cannot be composed, a
    // read side left undecided): the log directory depends on neither, so
    // the logger is brought up for this one line — in a home that ALREADY
    // EXISTS. A refused start must not be what creates an app's home: with
    // `--home=<a typo>` that left a folder of log files wherever the typo
    // pointed. No home yet (a first start, a mistyped one) = the console
    // only, as before. Not for an embedded app or a query (their output is
    // the caller's), and not when the data folder itself is what was refused
    // — then there is no log directory at all.
    //
    // What is NOT covered: a refusal raised before this `try` — the command
    // line, the Deno version, the shape and keys of the `aio.run()` config,
    // its schedules, its plugins. The config is not accepted yet at that
    // point, so there is no app to plan a home for; those answer on the
    // console only.
    if (
      !logger && !_contractMode && !fc.libraryMode && runtimeCount() === 0
    ) {
      try {
        // `statSync` throws for a home that is not there: the same answer.
        if (homeReady || Deno.statSync(planHome().plan.dirs.home).isDirectory) {
          readyHome();
          logger = await initLogger(fc);
        }
      } catch {
        // aio-ok: no home yet, a refused data folder, no log directory — the
        // refusal below goes to the console, which is where it went before.
      }
    }
    // An embedded app's refusal is the exception its host catches: the host
    // decides whether that is an error at all, so nothing is printed for it.
    if (!fc.libraryMode) sayBootRefused(e);
    try {
      if (appRef.current) await appRef.current.close();
      // Still installed = no shutdown ran (a refusal inside `_run` after the
      // app's own shutdown existed has stopped and released it already; a
      // second stop here wrote a second "stopped" line).
      else if (logger && appLoggerInstalled(logger)) {
        logger.onStop();
        await logger.flush();
        setLogger(null);
      }
      // The SIGINT/SIGTERM listeners go in before `_run()`; with no runtime
      // ever registered, nothing else would take them out again.
      releaseProcessListenersIfIdle();
    } catch (teardown) {
      log.error(
        `boot refused, and the teardown after it failed too: ${teardown}`,
      );
    }
    throw e;
  } finally {
    _releaseUpdatesClaim(_updatesSlot);
    _releaseFeedbackClaim(_feedbackSlot);
  }

  // deno-lint-ignore no-explicit-any
  async function _composeAndRun(): Promise<AioApp<any, any>> {
    // Configuring `updates` registers the built-in cell — BEFORE the registry
    // is read below, because a cell that registers afterwards is never composed
    // and never bound.
    //
    // A CALL, not a dynamic import. These were `await import(…)`, chosen
    // because `cell()` self-registers and a static import would have put the
    // cell in every app that never asked for one. But a dynamic import from
    // inside a function the app top-level-awaits can deadlock module
    // evaluation — the app hangs at boot with no banner and Deno reporting
    // "module evaluation is still pending … This is a bug in Deno", which
    // names neither aio nor the app. The factories register on call, so the
    // opt-in property survives and the hazard does not.
    //
    // KEEP THE HANDLE. Registering is only half the job: an app that also
    // passes an explicit `cells:` list makes the registry unreadable below,
    // so aio created its own cell, dropped it on the floor, printed
    // `updates  prod · manifest · every 6h · ask first` in the boot report,
    // and only THEN called `beginUpdates()` — which threw as an unhandled
    // rejection, after the success banner, leaving the app running with the
    // feature dead. A field report (report 10) shipped a self-update that could
    // never run for the app's whole life, green in every test and every
    // `deno task dev`, because the config that reaches this branch only
    // exists in a released build.
    //
    // PER APP. The cell a single-app process gets is the one `aio/updates` /
    // `aio/feedback` export; a SECOND app in the same process used to be handed
    // that same, already-bound cell and refused to boot ("[updates] already
    // bound — use a factory"), a factory no app can write for a cell aio owns.
    // `_updatesForApp` gives it a cell (and a runtime slot) of its own.
    _updatesSlot = fc.updates ? _updatesForApp() : undefined;
    _feedbackSlot = fc.feedback ? _feedbackForApp() : undefined;
    const _builtins = [_updatesSlot?.cell, _feedbackSlot?.cell].filter(
      (c): c is NonNullable<typeof c> => c !== undefined,
    );

    // Isolate filter — the flag overrides the config (config-sources.ts).
    const isolate = isolateOf(parseCli(), fc)?.value;
    // Zero-config cells: every cell() self-registers on definition — boot
    // whatever the entry imported (same behavior as the standalone runtime).
    //
    // A plugin's cells are added to whichever list applies. A plugin cell
    // whose id the app ALSO declares is dropped, not deduplicated by ordering:
    // the app's definition is the one that survives, which is rule 1 (the app
    // always wins). Zero-config apps need this — every `cell()` self-registers
    // on import, so a plugin's cells are already in the registry list and
    // adding them again would be the same cell twice. `composeCells` still
    // refuses a genuine clash between two DIFFERENT cells sharing an id.
    const _declared = fc.cells && fc.cells.length > 0
      ? fc.cells
      : [...getRegisteredCells().values()];
    // aio's OWN cells are appended to whatever the app declared, deduped by
    // id — the app's definition still wins if it listed the same cell itself.
    // The config asked for the feature; dropping the cell that implements it
    // because the app also spelled out its own list serves no one, and the
    // plugin merge directly below has always worked exactly this way.
    const _ownCells = _builtins.length
      ? [
        ..._declared,
        ..._builtins.filter((b) => {
          const bid =
            (("__aio" in b ? b : b.cell) as { __aio: { id: string } }).__aio.id;
          return !_declared.some((o) =>
            (("__aio" in o ? o : o.cell) as { __aio: { id: string } }).__aio
              .id === bid
          );
        }) as unknown as typeof _declared,
      ]
      : _declared;
    const allCells = _plugins.cells.length
      ? [
        ...(_plugins.cells as typeof _ownCells).filter((p) =>
          !_ownCells.some((o) =>
            (("__aio" in o ? o : o.cell) as { __aio: { id: string } }).__aio
              .id ===
              (("__aio" in p ? p : p.cell) as { __aio: { id: string } }).__aio
                .id
          )
        ),
        ..._ownCells,
      ]
      : _ownCells;
    if (allCells.length === 0) {
      throw teachableError(
        "no cells to run",
        "define at least one cell() (importing its module is enough), or pass " +
          "cells: [...] to aio.run()",
        "docs/basics/quickstart.md",
      );
    }
    const cellEntries = filterCellsByIsolate(allCells, isolate);

    // ── Cell-worker host mode ──
    // A `worker: true` cell is hosted by a worker whose entry is THIS module,
    // so aio.run() runs again in that thread. Bind only the hosted cell and
    // serve calls — no server, no persistence, no client, no second app.
    const hostedCell = hostedCellName();
    if (hostedCell) {
      const defs = cellEntries.map((e) => "__aio" in e ? e : e.cell);
      const hosted = defs.find((f) => f.__aio.id === hostedCell);
      if (!hosted) {
        throw new Error(
          `[aio] cell worker for "${hostedCell}": the app entry booted without ` +
            `that cell (cells: ${
              defs.map((f) => f.__aio.id).join(", ") || "none"
            }). A worker cell must be in the same aio.run({ cells }) list as ` +
            `on the main isolate.`,
        );
      }
      // Never resolves — the worker lives as long as its owner.
      return await startCellWorkerHost(hosted) as never;
    }

    // A perf budget naming a method that does not exist never applies, and
    // nothing ever says so. One app declared 17 per-method budgets adopting the
    // feature and one of them — `builds:installRelease` — named no method at
    // all; the failure mode is a perf violation naming the METHOD, which sends
    // you to read the method instead of the config.
    //
    // Same class as `strictCells` one layer up: config that silently governs
    // nothing. The cells and their method names are all in hand here, so the
    // check is cheap. Throws under `strictCells` (the app asked for strict),
    // warns otherwise — a budget is an optimisation hint, not a correctness
    // requirement, so a stale key must not break someone's boot by default.
    const budgetMethods = fc.perfBudget?.methods;
    if (budgetMethods && cellEntries.length > 0) {
      const known = new Set<string>();
      for (const e of cellEntries) {
        const def = ("__aio" in e ? e : e.cell) as {
          __aio: { id: string; actionKeys?: string[] };
        };
        const id = def.__aio.id;
        for (const m of def.__aio.actionKeys ?? []) known.add(`${id}:${m}`);
      }
      const unknown = Object.keys(budgetMethods).filter((k) => !known.has(k));
      if (unknown.length > 0) {
        const q = unknown.map((k) => `"${k}"`).join(", ");
        const near = (k: string) => {
          const [cellId] = k.split(":");
          const sibs = [...known].filter((n) => n.startsWith(`${cellId}:`));
          return sibs.length > 0 ? ` (${cellId} has: ${sibs.join(", ")})` : "";
        };
        const msg = `perfBudget.methods names ${
          unknown.length === 1 ? "a method" : "methods"
        } that do not exist: ${q}${
          unknown.length === 1 ? near(unknown[0]!) : ""
        } — ${
          unknown.length === 1 ? "that budget" : "those budgets"
        } never applies to anything. Keys are exact "cell:method".`;
        if (fc.strictCells) throw new Error(`[aio] ${msg}`);
        log.warn(msg);
      }
    }

    // Imported-but-unregistered cells (opt-in `strictCells`): a cell() that ran
    // (its module was imported) but was left out of aio.run({ cells }) dispatches
    // into the void — no error, dead feature, green tests. Opt-in because the global registry accumulates across a process
    // (the supported disjoint-multi-app pattern, tests), so a default-on check
    // would false-fire. Compared within the same isolate on both sides.
    if (fc.strictCells && fc.cells && fc.cells.length > 0) {
      // CellEntry is `CellDef | { cell, dependsOn }` — normalize to the def id.
      const idOf = (e: typeof cellEntries[number]): string =>
        ("__aio" in e ? e : e.cell).__aio.id;
      const passed = new Set(cellEntries.map(idOf));
      const orphaned = filterCellsByIsolate(
        [...getRegisteredCells().values()],
        isolate,
      )
        .map(idOf)
        .filter((id) => !passed.has(id));
      if (orphaned.length > 0) {
        const one = orphaned.length === 1;
        const q = orphaned.map((n) => `"${n}"`).join(", ");
        throw new Error(
          `[aio] strictCells: ${one ? "cell" : "cells"} ${q} ${
            one ? "was" : "were"
          } defined (imported) but not passed to aio.run({ cells: [...] }) — ` +
            `${
              one ? "its" : "their"
            } dispatches would be SILENT NO-OPS (a dead ` +
            `feature with green tests). Add ${
              one ? "it" : "them"
            } to cells[], or remove the import.`,
        );
      }
    }

    // Compose cells + build state filters
    const {
      composed,
      autoGetDBState,
      persistingCellIds,
      autoGetUIState,
      cellPatchStrategies,
      cellFilterFields,
      beforeReduce,
      onRestore,
      cellReportOpts,
      visibilityReport,
    } = composeCellsWiring({
      appId: resolveAppId(fc.appId),
      cellEntries,
      cellDefaults: fc.cellDefaults,
      localFirst: fc.localFirst,
      circuitBreaker: fc.circuitBreaker,
      perfCheck: fc.perfCheck,
      refusalsReject: fc.refusalsReject,
      onError: fc.onError,
      beforeReduce: fc.beforeReduce,
      onRestore: fc.onRestore,
    });

    // `_exposeOf` — the ONE decider (see its doc comment). Reading
    // `parseCli().expose` here instead would silence this warning for an app
    // exposed via `aio.run({ expose: true })`.
    const _exposed = _exposeOf(parseCli(), fc);
    // ── ONE line per cell whose ENTIRE state reaches every client ──
    //
    // Two independent signals land here. The audience one (this app is exposed
    // or multi-user, so `ui: "all"` means strangers) was already warned about.
    // The stronger one was not: a cell that declares `access` has had its WRITE
    // side restricted by the author and its READ side left undecided.
    //
    // `access` gates method CALLS; `ui` gates what the state broadcast carries.
    // Neither derives the other — "only admins may edit, everyone may read" is
    // a real design, so the framework must not choose. But an author who writes
    // `access: false` and never writes `ui` has answered half the question, and
    // the unanswered half defaults to broadcasting the whole cell to every
    // socket, authenticated or not. That is worth saying out loud: it is the
    // one case where the author's own declaration contradicts what ships.
    //
    // Note the asymmetry this closes. Composition REFUSES TO BOOT on a guess (a
    // field whose NAME matches a credential regex) while the strongest signal
    // available — the author explicitly marking the cell restricted — was read
    // by nothing. Guessing harder than we listen is backwards.
    //
    // Emitted from one loop so a cell tripping both signals is told once, and
    // the `access` message wins because it is the more specific and the more
    // actionable of the two.
    // Per-user auth in ANY form (users map, resolveUser hook, auth flows)
    // means strangers with different privileges share this app's broadcast.
    const _multiUser = !!fc.users || !!fc.resolveUser || !!fc.auth;
    const _openCells: string[] = [];
    for (const r of visibilityReport) {
      if (r.ui !== "all" || r.fields.length === 0) continue;
      // An explicit `visible` — including `visible: "all"` — is an answer, and
      // silences this forever. Acknowledging costs one word, so the warning can
      // never become the kind of noise people mute wholesale.
      if (r.access !== undefined && !r.uiDecided) {
        const a = r.access;
        const what = a === false
          ? "access: false denies all network method calls on this cell, but it"
          : a === true
          ? "access: true requires an authenticated caller for method calls, " +
            "but it"
          : typeof a === "function"
          ? "This cell's access predicate gates method calls, but it"
          : `access: ${JSON.stringify(a)} restricts method calls to that ` +
            `role, but it`;
        const one = r.fields.length === 1;
        const msg =
          `[${r.cell}] ${what} does NOT hide state. With no \`visible\` ` +
          `declaration, ${
            one ? "its field" : `all ${r.fields.length} fields`
          } [${r.fields.map((k) => `"${k}"`).join(", ")}] ${
            one ? "is" : "are"
          } broadcast in full to every connected client — including ` +
          `unauthenticated ones. ` +
          // A sync cell CANNOT narrow its read side: CRDT replication sends
          // ops to every peer by construction, and composition refuses to
          // start a sync cell that hides state. Offering it a `visible`
          // filter would be advice that hard-fails at the next boot.
          (r.syncs
            ? `This cell is sync: true, so its reads cannot be narrowed — ` +
              `CRDT replication carries it to every peer, and a sync cell ` +
              `that hides state is refused at boot. Either drop sync on it, ` +
              `or confirm the audience is right and say so — visible: "all".`
            : `Decide the read side too: visible: "none" (state stays ` +
              `server-side), visible: { exclude: [...] }, or visible.forUser ` +
              `for a per-user view. If everyone really may read it, say so — ` +
              `visible: "all".`);
        // alpha52: on an app whose audience is real (exposed to the network,
        // or multi-user) an author-declared `access` with an undecided read
        // side REFUSES to boot — the author's own declaration contradicts what
        // would ship, and a warning under a real audience is shippable. On a
        // loopback single-user app the same finding stays a warning (dev
        // stays stricter than nothing, but a local tool must not brick).
        if (_exposed || _multiUser) {
          throw new Error(
            `[aio] refusing to start (${
              _exposed
                ? "this app is exposed to the network"
                : "multi-user auth is on"
            }). ${msg} One-word acknowledgement: visible: "all".`,
          );
        }
        log.warn(
          `${msg} (This becomes a boot refusal under --expose or ` +
            `multi-user auth.)`,
        );
        continue;
      }
      if (_exposed || _multiUser) _openCells.push(r.cell);
    }
    if (_openCells.length) {
      const mode = _exposed
        ? exposeReason(parseCli(), fc as { expose?: boolean; host?: string })
        : "multi-user auth";
      log.warn(
        `${mode} with visible="all" on cells: ${
          _openCells.join(", ")
        } — every authenticated client sees this state. Narrow with visible:{include:[...]} if needed.`,
      );
    }

    // Data directories FIRST: initLogger() resolves `~/.<appId>/logs` through
    // the same registry, so registering after it would send a libraryMode app's
    // logs into the user's home (the inner _run() registers again, harmlessly).
    try {
      readyHome();
    } catch (e) {
      // A refused data folder (profiles: false, another app's, a foreign
      // one) is an operator's answer, not a crash: one line, exit 1.
      if (fc.libraryMode || runtimeCount() > 0) throw e;
      log.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }

    // Logger — skipped in `--aio-data-contract` mode: installing it would
    // replace the stderr-only sink (putting boot lines back on the parsed
    // stdout) and rotate the app's log files for what is only a query.
    logger = _contractMode ? null : await initLogger(fc, {
      persisting: persistingCellIds,
      cells: composed.cellNames,
    });

    // Bridge to legacy _run() config
    const config = buildLegacyConfig({
      fc,
      composed,
      beforeReduce,
      onRestore,
      autoGetUIState,
      autoGetDBState,
      persistingCellIds,
      cellPatchStrategies,
      cellFilterFieldsMap: cellFilterFields,
      cellReportOpts,
      logger,
      appRef,
    });

    // Which cells `startUpdates`/`startFeedback` wire, handed to the boot by
    // the config object's identity rather than as a config KEY (which every
    // layer of validation would have to learn about).
    const slots: AppSlots = {
      updates: _updatesSlot,
      feedback: _feedbackSlot,
      window: windowGate(),
    };
    _appSlots.set(config, slots);
    const app = await _run(composed.initialState, config);
    appRef.current = app;

    // Post-run: memory monitor, cells API, bindCell
    await wrapAppWithCells(app, composed, fc, cellReportOpts);

    // Cells are bound — the update check can now call cell methods. Armed in
    // _run, fired here, because dispatching before binding throws.
    beginUpdates(_updatesSlot);
    beginFeedback(_feedbackSlot);

    // AIO-418: fire the user's onStart NOW — after the callable cell
    // method surface is bound — so seeding via a cell method (members.seed())
    // works instead of throwing "cell runtime not booted". Error-guarded: a
    // throwing onStart must not abort a successful boot.
    // Guarded for a sync throw AND an async rejection: an `async onStart` used
    // to bypass the catch entirely and surface as an unhandled rejection.
    // The pending update is confirmed only once the app's hook came through:
    // `failed` has already ended the process for a fatal one.
    // …and, for a desktop app, only once its main window has loaded: a start
    // whose Electron could not be had (a download refused, cancelled, Quit)
    // stays unconfirmed — a failed start the judge counts — even when it
    // exits cleanly.
    let confirmed = false;
    const confirmOnce = (atExit = false) => {
      if (confirmed || fc.libraryMode) return;
      if (slots.window.holds(atExit, () => confirmOnce())) return;
      confirmed = true;
      removeEventListener("unload", onCleanExit);
      slots.confirm?.(atExit);
    };
    // A CLEAN exit (code 0: the user quit, a one-shot `onStart` finished)
    // before the hook came through is a build that worked — left unconfirmed,
    // two quick quits rolled a healthy update back. A crash, a fatal
    // `onStart` and `Deno.exit(n)` exit non-zero and stay unconfirmed.
    const onCleanExit = () => {
      if (Deno.exitCode === 0) confirmOnce(true);
    };
    if (!fc.libraryMode) addEventListener("unload", onCleanExit);
    if (fc.onStart) {
      // `fatalOnStart` is documented to end the process when `onStart` fails
      // (docs/state/lifecycle.md), and it only ever guarded aio's OWN start
      // hook (aio-lifecycle.ts) — this, the app's hook, logged and carried on,
      // so `fatalOnStart: true` left the half-started app running. Same exit
      // as the lifecycle's; under `libraryMode` (no `Deno.exit` allowed) the
      // app is closed instead, so the embedder is not left holding a broken one.
      const failed = (e: unknown) => {
        log.error(`onStart hook error: ${e}`);
        if (!fc.fatalOnStart) return;
        log.error("fatalOnStart is true — exiting due to onStart failure");
        if (fc.libraryMode) void app.close();
        else Deno.exit(1);
      };
      try {
        const r = fc.onStart(app) as unknown;
        if (r && typeof (r as Promise<unknown>).then === "function") {
          // Confirmed when it settles (a fatal failure has exited by then),
          // or after the backstop for a hook that never settles.
          const backstop = fc.libraryMode
            ? undefined
            : setTimeout(() => confirmOnce(), CONFIRM_BACKSTOP_MS);
          if (backstop !== undefined) Deno.unrefTimer(backstop);
          (r as Promise<unknown>).catch(failed).finally(() => {
            clearTimeout(backstop);
            confirmOnce();
          });
        } else confirmOnce();
      } catch (e) {
        failed(e);
        confirmOnce();
      }
    } else confirmOnce();
    return app;
  }
}
/** The per-app `updates` / `feedback` slots `run()` chose, keyed by the
 *  config it hands `_run` — and the update confirmation `_run` hands back,
 *  which `run()` calls once the app's own `onStart` has come through. */
type AppSlots = {
  updates?: UpdatesSlot;
  feedback?: FeedbackSlot;
  confirm?: (atExit?: boolean) => void;
  /** A desktop app's confirm waits for its main window (`windowGate`). */
  window: ReturnType<typeof windowGate>;
};
export const _appSlots = new WeakMap<object, AppSlots>();
/** How long an `async onStart` that has not settled holds the confirmation
 *  back: a hook that serves forever still proves the build boots. */
const CONFIRM_BACKSTOP_MS = 30_000;
/** Refusals already written to the log, so one refusal is one line whichever
 *  catch saw it first. */
const _saidRefused = new WeakSet<object>();

/** A BOOT THAT REFUSES SAYS WHY IN THE LOG.
 *
 *  The refusal is thrown to the caller, and an app's entry lets it end the
 *  process: the reason reached stderr only. A desktop app started by a
 *  double-click has no stderr — its window never opened and `app.log` held
 *  "stopped" and nothing else. Written at ERROR while the logger is still up
 *  (the teardown that follows flushes it), on every OS, for every refusal. */
export function sayBootRefused(e: unknown): void {
  if (typeof e === "object" && e !== null) {
    if (_saidRefused.has(e)) return;
    _saidRefused.add(e);
  }
  log.error("boot", `refused — the app did not start: ${describeThrown(e)}`);
  // The stack beside it, for the file only: the caller prints its own.
  if (e instanceof Error && e.stack) log.debug("boot", e.stack);
}
