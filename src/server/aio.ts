// Core runtime orchestrator — boots KV, server, electron, wires everything together.
// Phase logic lives in aio-boot, aio-dispatch, aio-server, aio-lifecycle, aio-run-helpers.
// Cell composition logic lives in aio-composition and aio-cells-bridge.

import { createShutdownOrchestrator, registerRuntime } from "./shutdown.ts";
import { _registerAuthStore } from "./auth-context.ts";
import type { ServerHandle } from "./server-types.ts";
import type { UDSHandle } from "./uds.ts";
import {
  createTT,
  pause,
  record,
  redo,
  resume,
  stateAt,
  toBroadcast,
  travelTo,
  type TTState,
  undo,
} from "../diagnostics/time-travel.ts";
import { createScheduleManager } from "../state/schedule.ts";
import { createOwnManager, isOwnEffect } from "../state/own.ts";
import { getLogger, log } from "../diagnostics/logger-api.ts";
import { timeTravelEnabled } from "../diagnostics/types.ts";
import { teachableError } from "../diagnostics/error.ts";

// Phase modules — extracted _run() logic
import { bootStorage, replaySyncOps } from "./aio-boot.ts";
import { replayJournal } from "./journal.ts";
import { createTimeline } from "./timeline.ts";
import { makeRedactor } from "../diagnostics/redact.ts";
import { actionOrigin, isWriteSetAction } from "../diagnostics/action-kind.ts";
import { setupDispatch } from "./aio-dispatch.ts";
import { hostedCellName, startCellWorkerHost } from "./cell-worker-host.ts";
import { createCellWorkerPool } from "./cell-worker-pool.ts";
import { isScheduleEffect } from "../state/schedule.ts";
import {
  currentHeapLimitBytes,
  describeHeapPolicy,
  physicalMemoryBytes,
  reportHeapCeiling,
} from "./heap-policy.ts";
import type { Provenance } from "./boot-facts.ts";
import {
  appDirs,
  checkUnpackLocation,
  ensureAppDirs,
  registerAppDirs,
  resolveAppDirs,
  sweepAppPayloadDir,
  writeAppMeta,
} from "./app-dirs.ts";
import { openBlobStore } from "./blobs.ts";
import { resolveDataDirLegacy } from "./paths.ts";
import { describeMigration, migrateLegacyLayout } from "./app-dirs-migrate.ts";
import { DEV_FRAME_BUDGET_MS } from "../state/dispatch.ts";
import { setupTransport } from "./aio-server.ts";
import { startLifecycle } from "./aio-lifecycle.ts";
import {
  acquireSingletonLock,
  appDenoJson,
  buildAppObject,
  buildOnPerf,
  buildReportOpts,
  createMemoizedUIState,
  createUdsBroadcastController,
  handleThinClient,
  initDiagAndVitals,
  resolveTitle,
  startVitalsCheck,
} from "./aio-run-helpers.ts";

// Cells-based API modules
import { composeCellsWiring } from "./aio-composition.ts";
import { _setCallTimeouts } from "../state/cell-impl.ts";
import {
  buildLegacyConfig,
  filterCellsByIsolate,
  initLogger,
  wrapAppWithCells,
} from "./aio-cells-bridge.ts";
import { getRegisteredCells } from "../state/cell-reactive.ts";
import { createUpdatesCell } from "../state/updates-cell.ts";
import { createFeedbackCell } from "../state/feedback-cell.ts";
import { createCostMeter } from "../vitals/cost-meter.ts";

// CLI + path resolution
import { parseCli, printHelp, VERSION, versionLine } from "./aio-cli.ts";
import { awaitPredecessor } from "./updates-apply.ts";
import { startFeedback } from "./feedback-boot.ts";
import {
  beginUpdates,
  confirmPendingUpdate,
  judgePendingUpdate,
  startUpdates,
  ttyPrompt,
} from "./updates-boot.ts";
import { PERSIST_SCHEMA_VERSION } from "./persist-schema.ts";
import { deriveDataContract } from "./updates-core.ts";
import {
  distCandidates,
  findFreePort,
  isCompiled,
  realDistCandidates,
} from "./paths.ts";
import { openSessionStore, type SessionStore } from "./sessions.ts";
import { openUserStore } from "./auth-users.ts";
import { resolveAppId } from "./single-instance-lock.ts";
import { appKeyPath, defaultAppKeyConfig, resolveAppKey } from "./app-key.ts";
import { assertDenoVersion } from "./deno-version.ts";
import { removalMessage, removalOf } from "../state/removals.ts";
import { dirname, join, resolve } from "@std/path";
import { lint, printLint } from "./lint.ts";

// ── Re-exports: public API surface ────────────────────────────────────
export { VERSION } from "./aio-cli.ts";
export { parseCli, printHelp } from "./aio-cli.ts";
export type { CliFlags } from "./aio-cli.ts";
export { createUDSListener, type UDSHandle } from "./uds.ts";
export type { AioError } from "../diagnostics/error.ts";
export type { PerfBudget, PerfCheck } from "../state/dispatch.ts";
export { checkCells, type Lint, lint } from "./lint.ts";
export {
  type CellDef,
  type CellEntry,
  type ComposedCells,
} from "../state/cell.ts";

// Re-export types (defined in aio-types.ts, re-exported here for consumers)
export type {
  AioApp,
  AioConfig,
  AioUser,
  CellsConfig,
  ResolveUserFn,
  UiConfig,
} from "./aio-types.ts";
import type {
  AioApp,
  AioConfig,
  AioUser,
  CellsConfig,
  UiConfig,
} from "./aio-types.ts";

// Re-export config validation (defined in config.ts)
export {
  VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  VALID_UI_KEYS,
  validateConfig,
} from "./config.ts";
import {
  misplacedDenoJsonKeys,
  VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  VALID_UI_KEYS,
  validateConfig,
} from "./config.ts";

/** Default broadcast throttle: 50ms = max 20 state pushes/sec */
export const DEFAULT_SYNC_INTERVAL_MS = 50;

// ── Module-level state ────────────────────────────────────────────────
let _electronProc: Deno.ChildProcess | null = null;

/** Validates that framework version matches deno.json version at build time */
function validateVersion(): void {
  try {
    const denoJson = new URL("../../deno.json", import.meta.url);
    const content = Deno.readTextFileSync(denoJson);
    const parsed = JSON.parse(content) as { version?: string };
    if (parsed.version && parsed.version !== VERSION) {
      log.warn(
        "aio",
        `version mismatch: aio.ts=${VERSION}, deno.json=${parsed.version}`,
      );
    }
  } catch { /* deno.json not accessible at runtime — skip */ }
}
validateVersion();

// ── Entry point ───────────────────────────────────────────────────────

/** THE decider for "is this app reachable off loopback?" — nothing else in the
 *  framework may answer that question its own way.
 *
 *  It used to be answered twice: `parseCli().expose` for the `ui:"all"` privacy
 *  warning, and `cli.expose ?? false` for the transport. That was survivable
 *  only while `--expose` was the sole source; the moment `expose` became a
 *  config key (a compiled binary in a service unit has no shell flags), a
 *  config-exposed app would have bound 0.0.0.0 with the privacy warning
 *  silently switched off — a quiet failure exactly where it costs most.
 *
 *  CLI wins over config: the operator running the binary overrides the author.
 *  Structural param so it works for both CellsConfig (outer `run`) and
 *  AioConfig (inner `_run`) without importing either. */
export function _exposeOf(
  cli: { expose?: boolean },
  config: { expose?: boolean },
): boolean {
  return cli.expose ?? config.expose ?? false;
}

/** The app's own `version` — from THE app-deno.json decider
 *  ({@link appDenoJson}), entry-relative and never the launch cwd. A compiled
 *  binary launched from an unrelated project's directory used to read THAT
 *  project's deno.json and report its version as its own: the exact
 *  identity-adoption bug `resolveAppId` guards against, one field down. */
/** One-time boot warning for aio-shaped keys at the top level of deno.json.
 *
 *  Once per process, like every other boot hint here: `parseCli`-adjacent code
 *  runs several times in one boot and a repeated diagnostic reads as a loop. */
let _hintedMisplacedDenoJson = false;
function _warnMisplacedDenoJson(): void {
  if (_hintedMisplacedDenoJson) return;
  const stray = misplacedDenoJsonKeys(appDenoJson());
  if (stray.length === 0) return;
  _hintedMisplacedDenoJson = true;
  log.warn(
    `deno.json has aio config at the TOP LEVEL — aio never reads it there, ` +
      `so ${stray.map((k) => `"${k}"`).join(", ")} ${
        stray.length === 1 ? "is" : "are"
      } silently doing nothing. Move ${
        stray.length === 1 ? "it" : "them"
      } into aio.run({ ${stray.join(", ")} }) in your app entry. ` +
      `(deno.json carries only identity and build: appId, title, client, ` +
      `entry, build, version.)`,
  );
}

function _denoJsonVersion(): string | undefined {
  const v = appDenoJson()?.version;
  return typeof v === "string" ? v : undefined;
}

/** The version string the boot report prints and `__aio.appVersion` carries.
 *
 *  It used to fall back to `"0.0.0"` — a CONFIDENT WRONG NUMBER, printed
 *  exactly when "which build is this?" matters most: a hand-compiled binary
 *  embeds no deno.json at all, so every one of them claimed 0.0.0 and looked
 *  like a real answer. An unknown version must SAY unknown and say what to do
 *  about it. Same string in dev and prod; only the hint differs, because the
 *  fix differs (a binary has to be rebuilt). Pure — tested directly. */
export function _resolveAppVersion(
  configured: string | undefined,
  fromDenoJson: string | undefined,
  compiled: boolean,
): string {
  // A blank/whitespace value is ABSENT, not a version — otherwise
  // `appVersion: ""` would print an empty field that reads as a real answer.
  const v = (configured ?? "").trim() || (fromDenoJson ?? "").trim();
  if (v) return v;
  return compiled
    ? 'unknown (compiled binary — set appVersion in aio.run(), or "version" ' +
      "in deno.json, and rebuild with aio's builder)"
    : 'unknown (no "version" in the app\'s deno.json — set it, or pass ' +
      "appVersion to aio.run())";
}

/** The app's `client` from ITS OWN deno.json (written by `am create
 *  --target=…`) as a client-mode default. Makes the scaffolded `deno task dev`
 *  (no --client flag) run the CHOSEN target instead of the framework's electron
 *  fallback. `server` → `server-only` (aio's name for "no client UI");
 *  `android` → the browser client (the android dev flow's emulator connects to
 *  the same dev server).
 *
 *  The key was called `target` before alpha52 (renamed: deno.json also carries
 *  `build.targets`, a DIFFERENT axis — two meanings of "target" in one file).
 *  The old spelling still works, with a one-time boot hint; `client` wins when
 *  both are present.
 *
 *  Entry-relative via {@link appDenoJson}, like `version` and `title`: read
 *  from the launch cwd, a compiled `"client": "browser"` app started anywhere
 *  else fell back to ELECTRON and began downloading a ~100MB runtime on a
 *  headless server — or picked up an unrelated project's target. */
/** @internal exported for its test — the mapping AND its entry-relative source
 *  are both load-bearing, and a compiled binary cannot be asked from inside. */
let _hintedDenoJsonTargetKey = false;
export function _denoJsonTargetClient():
  | "browser"
  | "electron"
  | "cli"
  | "server-only"
  | undefined {
  const dj = appDenoJson();
  const raw = dj?.client ?? dj?.target;
  if (dj?.target !== undefined && !_hintedDenoJsonTargetKey) {
    _hintedDenoJsonTargetKey = true;
    // Two spellings at once must not resolve SILENTLY — say which one won.
    log.warn(
      dj?.client !== undefined
        ? `deno.json has BOTH "client" (${JSON.stringify(dj.client)}) and ` +
          `the deprecated "target" (${JSON.stringify(dj.target)}) — ` +
          `"client" wins; delete "target" (\`am fix\` does it)`
        : 'deno.json "target" is now "client" (same value — renamed so it ' +
          "can't be confused with build.targets) — `am fix` rewrites it",
    );
  }
  switch (raw) {
    case "browser":
    case "android":
      return "browser";
    case "electron":
      return "electron";
    case "cli":
      return "cli";
    case "server":
      return "server-only";
    default:
      return undefined;
  }
}

function _inferBaseDir(): string {
  try {
    const main = new URL(Deno.mainModule);
    if (main.protocol === "file:" && !isCompiled()) {
      const dir = main.pathname.split("/").slice(0, -1).join("/");
      if (dir) return dir;
    }
  } catch { /* unusual entry — fall through */ }
  return join(Deno.cwd(), "src");
}

/** Single entry point — boots KV, server, electron, wires everything. CLI
 *  args override config. (perfect-aio D9: the legacy 2-arg
 *  `aio.run(initialState, config)` overload was removed — zero callers
 *  existed; `aio.run({ cells })` / zero-config `aio.run()` is the API.)
 *
 *  Optionally TYPED (alpha52, additive): `aio.run<MyAppState>({ cells })`
 *  types `app.state` / `app.getState()` instead of `any`. The default stays
 *  `any` for compatibility — existing untyped calls infer exactly as before. */
// deno-lint-ignore no-explicit-any
async function run(fc?: CellsConfig): Promise<AioApp<any, any>>;
// Typed overload — selected only by an explicit type argument, so untyped
// calls keep the exact pre-alpha52 `any` inference (no new circularity in
// configs whose closures reference the resulting app).
async function run<S extends Record<string, unknown>>(
  fc?: CellsConfig,
  // deno-lint-ignore no-explicit-any
): Promise<AioApp<S, any>>;
// deno-lint-ignore no-explicit-any
async function run(a?: any, b?: any): Promise<AioApp<any, any>> {
  // Fail fast on an unsupported Deno — aio uses ≥2.9 behavior directly.
  assertDenoVersion();
  if (b !== undefined) {
    // Message comes from the removal registry — one decider for every
    // "that spelling is gone" the framework prints (src/state/removals.ts).
    throw new Error(removalMessage(removalOf("aio.run(initialState, config)")));
  }

  // Cells-based API: aio.run(cellsConfig) — zero-config: aio.run()
  const fc = (a ?? {}) as CellsConfig;
  validateConfig(
    fc as unknown as Record<string, unknown>,
    VALID_FEATURES_CONFIG_KEYS,
    "CellsConfig",
  );
  if (fc.ui) {
    validateConfig(fc.ui as Record<string, unknown>, VALID_UI_KEYS, "ui");
  }
  // …and the OTHER file people put aio config in. `aio.run()` refuses an
  // unknown key loudly; deno.json accepted `ui: { width, height }` at the top
  // level, did nothing with it, and said nothing about it — the shape a field
  // report called "the worst available behaviour", and it became a bullet in
  // their project docs instead of a message from us. Warn (not throw): the
  // file belongs to Deno and other tools keep their own sections in it, so the
  // right answer is to name the key and where it belongs.
  _warnMisplacedDenoJson();
  // Multi-instance (perfect-aio D2): several aio.run() calls may coexist in
  // one process — each app's cells bind exclusively (bindCell throws on a
  // def already bound to another app), each appId takes its own singleton
  // lock, and zero-config auto-cells only work for the FIRST app (later apps
  // must pass explicit disjoint `cells:` lists — the bind error says so).

  try {
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
    if (fc.updates) createUpdatesCell();
    if (fc.feedback) createFeedbackCell();

    // Isolate filter
    const cliIsolate = parseCli().isolate;
    const isolate = fc.isolate ?? cliIsolate;
    // Zero-config cells: every cell() self-registers on definition — boot
    // whatever the entry imported (same behavior as the standalone runtime).
    const allCells = fc.cells && fc.cells.length > 0
      ? fc.cells
      : [...getRegisteredCells().values()];
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
          __aio: { id: string; methodKeys?: string[]; actionKeys?: string[] };
        };
        const id = def.__aio.id;
        for (
          const m of def.__aio.methodKeys ?? def.__aio.actionKeys ?? []
        ) known.add(`${id}:${m}`);
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
      autoGetUIState,
      cellPatchStrategies,
      cellFilterFields,
      beforeReduce,
      onRestore,
      cellReportOpts,
      visibilityReport,
    } = composeCellsWiring({
      cellEntries,
      cellDefaults: fc.cellDefaults,
      localFirst: fc.localFirst,
      circuitBreaker: fc.circuitBreaker,
      perfCheck: fc.perfCheck,
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
        ? (parseCli().expose ? "--expose" : "expose: true")
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
    const _earlyAppId = resolveAppId(fc.appId);
    registerAppDirs(
      _earlyAppId,
      resolveAppDirs({
        appId: _earlyAppId,
        appDir: fc.appDir,
        libraryMode: fc.libraryMode,
        baseDir: fc.baseDir,
      }),
    );

    // Logger
    const logger = await initLogger(fc);
    (globalThis as Record<string, unknown>).__aioCells = composed;

    // Mutable app ref for closures
    const appRef = {
      current: null as AioApp<Record<string, unknown>, unknown> | null,
    };

    // Bridge to legacy _run() config
    const config = buildLegacyConfig({
      fc,
      composed,
      beforeReduce,
      onRestore,
      autoGetUIState,
      autoGetDBState,
      cellPatchStrategies,
      cellFilterFieldsMap: cellFilterFields,
      cellReportOpts,
      logger,
      appRef,
    });

    const app = await _run(composed.initialState, config);
    appRef.current = app;

    // Post-run: memory monitor, cells API, bindCell
    await wrapAppWithCells(app, composed, fc, cellReportOpts);

    // Cells are bound — the update check can now call cell methods. Armed in
    // _run, fired here, because dispatching before binding throws.
    beginUpdates();

    // AIO-418: fire the user's onStart NOW — after the callable cell
    // method surface is bound — so seeding via a cell method (members.seed())
    // works instead of throwing "cell runtime not booted". Error-guarded: a
    // throwing onStart must not abort a successful boot.
    if (fc.onStart) {
      try {
        fc.onStart(app);
      } catch (e) {
        log.error(`onStart hook error: ${e}`);
      }
    }
    return app;
  } catch (e) {
    throw e;
  }
}

// ── _run: thin orchestrator calling phase modules ─────────────────────

async function _run<S, A, E>(
  initialState: S,
  config: AioConfig<S, A, E>,
): Promise<AioApp<S, A>> {
  // --- Phase 1: resolve CLI, env, config validation, lint ---
  const cli = parseCli();
  if (cli.help) {
    printHelp();
    Deno.exit(0);
  }
  if (cli.version) {
    // An artifact has to be able to say what it IS and what it was built with —
    // a binary found on a server months later is otherwise unidentifiable, and
    // "which aio is this running?" is the first question when it misbehaves.
    // Same sources the app itself uses for its identity (resolveAppId handles
    // the compiled-binary case), so --version cannot describe a different app
    // than the one that would boot.
    log.info(
      versionLine(
        resolveAppId(config.appId),
        config.appVersion ?? _denoJsonVersion(),
      ),
      { detail: String() },
    );
    Deno.exit(0);
  }

  if (cli.dataContract) {
    // What this build promises about data already on disk. Derived from the
    // very same cell versions and onMigrate hooks the boot path uses, so a
    // published contract cannot drift from what the binary actually does.
    log.info(JSON.stringify(
      deriveDataContract(
        config._cellMigrations ?? new Map(),
        PERSIST_SCHEMA_VERSION,
      ),
      null,
      2,
    ));
    Deno.exit(0);
  }

  // An update hands over by starting the new artifact and exiting. aio refuses
  // to boot while another instance holds the app lock, so the successor is
  // launched with its predecessor's pid and waits here — BEFORE the lock is
  // taken, and before anything else can fail for a reason that is really just
  // this race.
  await awaitPredecessor(Deno.args);

  const appId = resolveAppId(config.appId);
  log.debug(`app-id: ${appId}`);

  // ── One data directory ──
  // Everything this app owns lives under `~/.<appId>` (overridable). Migrate a
  // legacy scattered layout FIRST — before anything opens a database — then
  // stamp meta.json so a backup of `data/` is self-describing. Skipped in
  // libraryMode (a test's cwd is not an app) and with --no-data-migrate.
  // libraryMode means a TEST or a host app owns the process — it must not write
  // into the user's home, so its data dir defaults under baseDir (which tests
  // already point at a temp dir). Everything else resolves to `~/.<appId>`.
  // Boot-report values assembled as the boot proceeds (printed by bootLines).
  let _heapLine: string | undefined;
  const _dirs = resolveAppDirs({
    appId,
    appDir: config.appDir,
    libraryMode: config.libraryMode,
    baseDir: config.baseDir,
  });
  // Register BEFORE anything else resolves a path, so every module in this
  // process (auth store, app key, profile export) agrees with this decision.
  registerAppDirs(appId, _dirs);
  // Always create them: auth.db / app.key / state.db all open files inside.
  ensureAppDirs(_dirs);
  // Did the last boot install something? Count this attempt, or — having spent
  // them — put the old artifact back and let the supervisor start it. Runs in
  // the NEW build, because it is the only thing present to judge itself.
  if (!config.libraryMode && await judgePendingUpdate(_dirs.data, log)) {
    Deno.exit(1);
  }
  if (!config.libraryMode) {
    // A packaged app unpacks itself BEFORE any of our code runs, so this can
    // only observe where that happened — and say so when it happened somewhere
    // other users on the host can reach. Never fatal (the app works either
    // way), never silent (running world-readable is not a detail), identical in
    // dev and prod. The sweep clears the empty mount stubs a crash leaves in
    // our own payload dir — the one upkeep `/tmp` used to do for us.
    // The heap ceiling this process actually got, against the policy. V8 fixed
    // it at isolate creation, so this can only REPORT — but running on the
    // ~4 GB default when the machine allows 47 GB is exactly the setup that
    // ends in "out of memory" with most of the machine free, and it must not be
    // discovered then. `am start`, run.sh and the build all size it correctly;
    // a bare `deno run src/app.ts` is the case that lands here.
    await reportHeapCeiling(log);
    // The same numbers the warning uses, stated unconditionally: an app that
    // died of "out of memory" with the machine half empty is a support thread
    // that starts with "what was the ceiling?".
    _heapLine = describeHeapPolicy(
      Math.floor(((await currentHeapLimitBytes()) ?? 0) / (1024 * 1024)) ||
        null,
      physicalMemoryBytes(),
    );
    sweepAppPayloadDir(_dirs);
    const unsafeUnpack = checkUnpackLocation(_dirs);
    if (unsafeUnpack) log.warn("security", unsafeUnpack);
    if (!cli.noDataMigrate) {
      const _m = migrateLegacyLayout({
        appId,
        dirs: _dirs,
        cwd: Deno.cwd(),
        legacyXdgDir: resolveDataDirLegacy(appId),
      });
      for (const line of describeMigration(_m, _dirs)) {
        if (line.includes("FAILED") || _m.refused) log.warn("data", line);
        else log.info("data", line);
      }
    }
    writeAppMeta(_dirs, {
      appId,
      aio: VERSION,
      app: (config as { appVersion?: string }).appVersion,
    });
  }
  const port = cli.port ?? config.port ?? await findFreePort();
  const portFrom: Provenance = cli.port
    ? "flag"
    : config.port
    ? "config"
    : "default"; // …i.e. picked by findFreePort — worth saying, since a port
  // that changes between runs is otherwise a mystery.

  // Singleton lock — libraryMode implies no lock (embeddable / testable).
  const singletonMode = config.libraryMode ? false : (config.singleton ?? true);
  const killExisting = (config.killExisting ?? false) ||
    (cli.killExisting ?? false);
  const appLock = await acquireSingletonLock(
    appId,
    port,
    singletonMode,
    killExisting,
  );

  // Thin client mode
  if (
    await handleThinClient(cli.serverUrl ?? config.serverUrl, (_v) => {
      /* multi-instance (D2): no process-wide running flag */
    })
  ) return null!;

  // Zero-config baseDir: the main module's directory — always right for
  // `deno run src/app.ts` regardless of cwd. Compiled binaries embed their
  // entry, so they keep the cwd/src fallback (build sets baseDir anyway).
  const baseDir = resolve(config.baseDir ?? _inferBaseDir());
  const VERBOSE = cli.verbose;

  // Prod detection
  let distDir = resolve(join(Deno.cwd(), "dist"));
  let prod = cli.prod ?? false;
  if (!prod && isCompiled()) {
    // Entry-relative (the binary's EMBEDDED dist/) first, real filesystem after
    // — so a compiled binary detects prod from ANY cwd. See distCandidates.
    const candidates = distCandidates({
      mainModule: Deno.mainModule,
      cwd: Deno.cwd(),
      execDir: dirname(Deno.execPath()),
      moduleDir: import.meta.dirname ?? null,
    });
    for (const dir of candidates) {
      try {
        await Deno.stat(join(dir, "app.js"));
        distDir = dir;
        prod = true;
        log.info("auto-detected dist/app.js → prod mode");
        break;
      } catch { /* not found */ }
    }
    // A HEADLESS build (`--service`/`--cli`) never bundles, so there is no
    // dist/app.js to find — but a compiled binary is prod by definition (dev
    // mode means running from source). Without this the service binary fell
    // through to dev: it emitted the "esbuild not installed" warning and ran
    // the dev lint, which demands src/App.tsx at cwd → crash on any real
    // server. `deno task compile:service` shipped exactly that.
    if (!prod) {
      prod = true;
      log.info("compiled binary without a bundle → prod mode (headless)");
    }
  }

  // Electron loads the page off disk via the aio:// protocol — from ITS OWN
  // process. `distDir` may be the binary's embedded VFS copy, which Electron
  // cannot open, so resolve a real-filesystem dist/ separately. Undefined here
  // means "Electron must load over HTTP" — and skipHttp below honors that
  // rather than leaving it with a dead localhost URL (blank window).
  let electronDistDir: string | undefined;
  if (prod) {
    for (
      const dir of realDistCandidates({
        cwd: Deno.cwd(),
        execDir: dirname(Deno.execPath()),
        moduleDir: import.meta.dirname ?? null,
      })
    ) {
      try {
        await Deno.stat(join(dir, "app.js"));
        electronDistDir = dir;
        break;
      } catch { /* not found */ }
    }
  }

  // One redaction predicate for every place an action is recorded — the
  // journal (disk), the timeline (`am timeline`) and the action log. Built
  // here, before any of them exists, so none can be created without it.
  const redact = makeRedactor(config.redactActions);

  // Diagnostics + vitals
  const { diagHooks, vitalsSystem, diagResolvedOpts } = initDiagAndVitals(
    config._diagnostics,
    prod,
    config._cellNames,
    config.guardDispatches,
    redact,
  );

  // Client mode: CLI flag > aio.run config > app deno.json `target` >
  // electron. The deno.json step is what makes `am create --target=X` +
  // `deno task dev` (no --client flag) actually run target X.
  const client = cli.client ?? config.client ?? _denoJsonTargetClient() ??
    "electron";
  // …and WHO decided, kept beside the decision so the two cannot drift. The
  // boot report says `client electron (deno.json)` instead of leaving someone
  // to grep three files for the one that won.
  const clientFrom: Provenance = cli.client
    ? "flag"
    : config.client
    ? "config"
    : _denoJsonTargetClient()
    ? "deno.json"
    : "default";
  const useElectron = client === "electron";
  const isHeadless = client === "server-only" || client === "cli";
  const { reduce, execute, onAction, onEffect, onStart, onStop, onError } =
    config;
  const shouldPersist = (cli.persist ?? config.persist) !== false;
  // autoGetUIState is always defined by composeCellsWiring (ui defaults to "all"),
  // so the (s) => s fallback here is a safety net, not the primary path.
  const _rawGetUIState = config._getUIState ?? ((s: S, _user?: AioUser) => s);
  const getUIState = createMemoizedUIState(_rawGetUIState);
  const getDBState = config._getDBState ?? ((s: S) => s);
  const persistKey = config.persistKey ?? "state";
  const persistMode = config.persistMode ?? "single";
  const ui = config.ui ?? {} as UiConfig;

  validateConfig(
    config as unknown as Record<string, unknown>,
    VALID_AIO_CONFIG_KEYS,
    "AioConfig",
  );
  if (config.ui) {
    validateConfig(config.ui as Record<string, unknown>, VALID_UI_KEYS, "ui");
  }
  printLint(
    await lint(initialState, config, baseDir, prod, isHeadless, useElectron),
  );

  const title = await resolveTitle(cli.title, ui.title);
  log.debug(
    `config: port=${port} persist=${shouldPersist} client=${client} title="${title}" baseDir=${baseDir}`,
  );

  // --- Phase 2: boot storage ---
  const syncCellIds = config._syncCellIds ?? [];
  let state = initialState;
  // Declared BEFORE bootStorage on purpose: boot is the phase most likely to
  // fail (a migration that throws, a corrupt database, a `db:` binding that
  // resolves to nothing), and those failures must reach the app's `onError`
  // sink like any other. Both used to be declared ~100 lines further down, so
  // `getReportOpts()` during boot hit the temporal dead zone and threw a
  // ReferenceError INSIDE the error path — the app never heard about the
  // failure it most needed to hear about, and the ReferenceError masked the
  // real cause. `getTT` stays a closure, so the only ordering that matters is
  // that `tt` is initialized before an error is reported, which it now is.
  let tt: TTState<S, { type: string }> | null = null;
  const _reportOpts = buildReportOpts({ onError, getTT: () => tt, prod });

  const boot = await bootStorage({
    appId,
    dbPath: config.dbPath ?? cli.dbPath,
    dbPragmas: config.dbPragmas,
    checkIntegrityOnBoot: config.checkIntegrityOnBoot,
    initialState,
    shouldPersist,
    persistKey,
    persistMode,
    persistDebounceMs: config.persistDebounceMs ?? 100,
    dbSchema: config.db,
    syncCellIds,
    cellAccess: config._cellAccess,
    cellMigrations: config._cellMigrations,
    onRestore: config.onRestore,
    onCheckpointRestore: config._onCheckpointRestore,
    diagHooks,
    healthGetter: config._healthGetter,
    getDBState: getDBState as (s: S) => unknown,
    getState: () => state as Record<string, unknown>,
    // What a CLIENT may see — the CRDT catch-up snapshot is a wire frame and
    // must go through the same projection every other wire uses (it used to
    // read raw state). No `user`: a sync cell may not carry a per-user filter
    // at all (aio-composition.ts refuses it), so this is exactly the
    // structural view.
    getUIState: (s: Record<string, unknown>) => getUIState(s as S),
    getReportOpts: () => _reportOpts,
    journal: config.journal,
    redactActions: config.redactActions,
    log,
  });
  state = boot.state as S;
  const { kvDb, asyncDb, persistence, journal, syncHandler, syncBroadcastRef } =
    boot;
  const migrationSummary = boot.migrations;
  const _syncDispatchRef = boot.syncDispatchRef;
  const { schedulePersist } = persistence;

  // B1/AIO-416: recover sync cells from their op-log at boot (after KV restore +
  // onRestore, before any dispatch/broadcast). Without this, sync cells came back
  // empty on a server restart until a client reconnected — silent data loss.
  if (asyncDb && syncCellIds.length > 0) {
    state = await replaySyncOps(
      asyncDb,
      syncCellIds,
      config.reduce as (
        s: S,
        a: { type: string; payload?: unknown },
      ) => S,
      state,
      log,
    );
  }

  // Journal recovery: replay the actions committed AFTER the last
  // snapshot (the debounce window a SIGKILL/power-cut would otherwise lose) on
  // top of the restored state — after sync-ops so cross-cell reads see recovered
  // sync state. State transitions only; effects are never re-run.
  if (journal) {
    const tail = journal.readSince(journal.watermark());
    if (tail.length > 0) {
      const replay = replayJournal(
        state,
        tail,
        config.reduce as (s: S, a: A) => { state: S },
      );
      state = replay.state;
      if (replay.replayed > 0) {
        log.info(
          `journal: recovered ${replay.replayed} action(s) past the last snapshot`,
        );
      }
      // A redacted entry cannot be replayed — its payload IS its arguments and
      // the redactor dropped them. Skipping is the only correct outcome, but a
      // SILENT skip would be the same lie in a quieter register: recovery would
      // report success while the recovered state is missing writes. Say
      // exactly which actions, and how many, so the operator can judge it.
      if (replay.skipped.length > 0) {
        const counts = new Map<string, number>();
        for (const s of replay.skipped) {
          counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
        }
        const what = [...counts]
          .map(([type, n]) => (n > 1 ? `${type} x${n}` : type))
          .join(", ");
        const seqs = replay.skipped.map((s) => s.seq);
        const threw = replay.skipped.filter((s) => s.reason === "threw");
        const why = threw.length === 0
          ? `their payload was dropped by redactActions, so the arguments ` +
            `needed to re-run them are gone`
          : threw.length === replay.skipped.length
          ? `the reducer REJECTED them: ${
            [...new Set(threw.map((s) => s.error ?? "threw"))].join("; ")
          }`
          : `some had their payload dropped by redactActions and ${threw.length} ` +
            `were rejected by the reducer: ${
              [...new Set(threw.map((s) => s.error ?? "threw"))].join("; ")
            }`;
        log.warn(
          `journal: ${replay.skipped.length} action(s) COULD NOT be replayed — ` +
            `${why}: ${what} (seq ${Math.min(...seqs)}–${
              Math.max(...seqs)
            }). ` +
            `Whatever those actions wrote after the last snapshot is NOT in ` +
            `the recovered state. Skipping is deliberate: an entry that cannot ` +
            `be replayed is still in the file at the next boot, so failing on ` +
            `it would make recovery the reason this app can never start.`,
        );
      }
    }
  }

  // The persistence manager captured its `db:` table baseline while `state`
  // was still initialState — restored rows only land here. Left stale, the
  // first flush after a restart diffs restored-rows-vs-nothing, re-INSERTs
  // every existing row, hits a UNIQUE violation, and rolls back the whole
  // transaction: every write after the first restart was lost, permanently
  // (the baseline only advances on success, so it never recovered). Re-seed
  // it now that `state` is what the database actually holds.
  persistence.resetPrevState();

  // Time-travel — dev only, AND only when diagnostics leave it on.
  //
  // `diagnostics.dev.timeTravel` was a declared option with no reader: it was
  // resolved, defaulted and documented, and then TT was created purely on
  // `!prod`. An app that turned it off — a wallet, say, whose reason is that
  // time-travel holds a full state history in memory — kept every action's
  // state anyway, and paid a `tt-state` broadcast on every dispatch for it.
  // The option now decides, and its dev default is still `true`.
  const ttEnabled = timeTravelEnabled(prod, diagResolvedOpts);
  // High-frequency app actions (a 60 fps `game:tick`) flood the bounded TT
  // window until it holds seconds instead of a session — `skipActions` keeps
  // them out of history (a field report).
  const ttSkipActions =
    typeof diagResolvedOpts === "object" && diagResolvedOpts.skipActions?.length
      ? new Set(diagResolvedOpts.skipActions)
      : undefined;
  if (ttEnabled) {
    tt = createTT<S, { type: string }>();
    tt = record(tt, { type: "__init" }, state);
    log.debug("time-travel: initialized");
  } else if (!prod) {
    log.debug("time-travel: disabled by diagnostics config");
  }

  if (config._onReportOptsReady) config._onReportOptsReady(_reportOpts);

  // --- Phase 3: wire dispatch ---
  const udsSyncIntervalMs = config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  // deno-lint-ignore prefer-const
  let server: ServerHandle;
  let udsHandle: UDSHandle | null = null;
  let _vitalsCheckTimer: ReturnType<typeof setInterval> | undefined;

  const scheduleManager = createScheduleManager(
    (action) => dispatch(action as A),
    log,
  );
  const ownManager = createOwnManager(log);
  if (config._onScheduleReady) {
    config._onScheduleReady((prefix) => {
      scheduleManager.cancelByPrefix(prefix);
      ownManager.disposeByPrefix(prefix);
    });
  }

  const udsCtrl = createUdsBroadcastController({
    getUdsHandle: () => udsHandle,
    syncIntervalMs: udsSyncIntervalMs,
  });
  // Cost meter (`am cost`): always on, bounded rings, zero configuration. The
  // question it answers — "what does aio move on my behalf, and where does it
  // come from" — is asked AFTER something feels slow, which is exactly when an
  // opt-in diagnostic is not enabled. See src/vitals/cost-meter.ts.
  const costMeter = createCostMeter();
  costMeter.setKnownCells(config._cellNames ?? []);
  // A GETTER, not the value: `record()` swaps in a new TTState per action.
  const onPerf = buildOnPerf(() => tt, vitalsSystem, costMeter);

  // Set once the worker pool exists (below); a jump before that has nothing
  // to re-seed.
  let _reseedWorkerCells: () => void = () => {};

  function handleTTCommand(cmd: string, arg?: number): void {
    if (!tt) return;
    const prev = tt;
    switch (cmd) {
      case "undo":
        tt = undo(tt);
        break;
      case "redo":
        tt = redo(tt);
        break;
      case "goto":
        if (arg !== undefined) tt = travelTo(tt, arg);
        break;
      case "pause":
        tt = pause(tt);
        break;
      case "resume":
        tt = resume(tt);
        break;
      default:
        log.debug(`time-travel: unknown command '${cmd}'`);
        return;
    }
    if (tt === prev) return;
    const restored = stateAt(tt);
    if (restored !== null) {
      state = restored;
      // A worker cell's copy would otherwise keep mutating the state we just
      // discarded — re-seed it from the restored slice.
      _reseedWorkerCells();
    }
    log.debug(
      `time-travel: ${cmd}${
        arg !== undefined ? ":" + arg : ""
      } → index ${tt.index}/${tt.entries.length - 1} paused=${tt.paused}`,
    );
    server.broadcastTT();
    server.broadcast();
    udsCtrl.broadcastFull();
  }

  // Every committed, state-changing, non-sync action feeds two sinks:
  //  • the durable journal — the crash-recovery tail (actions only),
  //    present only when `journal: true`; sync cells recover via their op-log.
  //  • the in-memory timeline — always on, bounded, carries the diff
  //    each action produced; the live view behind `am timeline`.
  // Both share the same seq (the journal's when journaling, else the timeline's
  // own counter) so a timeline entry and its journal line line up for replay.
  const _diagAfterAction = diagHooks?.afterAction as
    | ((prev: S, next: S, action: A) => void)
    | undefined;
  const _syncCellSet = new Set(syncCellIds);
  const timeline = createTimeline(500, redact);
  const afterActionHook = (prev: S, next: S, action: A): void => {
    _diagAfterAction?.(prev, next, action);
    if (prev === next) return; // no-op action — nothing to record
    const t = (action as { type?: string }).type ?? "";
    const ci = t.indexOf(":");
    const cell = ci >= 0 ? t.slice(0, ci) : "";
    const method = ci >= 0 ? t.slice(ci + 1) : t;
    if (_syncCellSet.has(cell)) {
      // A sync op is already durable in the op-log. Anything ELSE that
      // committed to a sync cell — an effect, cron, serverFn, a plain action,
      // an async method's `__set` batch — is durable NOWHERE (sync cells are
      // excluded from KV), so fold current state into the cell's sync
      // snapshot. Without this, a restart silently rewound every server-origin
      // write since the last compaction.
      if (method.startsWith("__") && !method.startsWith("__set")) return;
      if (!(action as { _syncOp?: boolean })._syncOp) {
        syncHandler?.noteServerWrite(cell);
      }
      return;
    }
    // Framework-internal actions are noise — EXCEPT the write-set commit.
    //
    // An async or transactional method publishes everything it wrote as one
    // atomic `cell:__setMethod` (cell-impl.ts's batcher). The outer
    // `cell:method` action IS recorded, but it commits at CALL time, before the
    // method has written anything — so filtering `__set` as "framework noise"
    // meant an async method's writes existed in NO sink at all. The costs were
    // not cosmetic: journal replay reconstructed the pre-write state while boot
    // still logged "recovered N action(s)"; `transaction: true` promised "a
    // single journal entry … boot replay reconstructs it" and delivered the
    // opposite; `am timeline` printed `"diff": []` for an action that changed
    // everything; and time-travel `undo` landed on a state the app never had,
    // which in one shape destroyed a committed write permanently.
    //
    // It is recorded as its OWN entry, attributed to the originating method via
    // `origin` — not folded into the `cell:method` entry, which was already
    // written and journalled at call time and cannot be amended (a method may
    // also commit several times via `s.$commit()`). `type` stays the action
    // that really ran, so replay re-reduces exactly what happened.
    //
    // The rest of the `__` family stays out on purpose: `__init`/`__destroy`
    // are lifecycle, and replaying `__init` would reset a cell to its initial
    // state ON TOP of the restored snapshot — recovery that destroys data.
    // `__exec`/`__error` carry machine transitions, not the app's writes.
    const isWriteSet = isWriteSetAction(t);
    if (method.startsWith("__") && !isWriteSet) return;
    const payload = (action as { payload?: unknown }).payload;
    // Who wrote it — from the ONE decider (diagnostics/action-kind.ts), which
    // the action log and the logger resolve the same fact with. It was computed
    // here by hand and again in the diagnostics sink, and the redactor depends
    // on it: an exact `redactActions` pattern matches the CALL, so a sink whose
    // copy of this drifts leaks the same secret under the write-set's type.
    const origin = isWriteSet ? actionOrigin(t, payload) : undefined;
    const ts = Date.now();
    const seq = journal
      ? journal.append(
        {
          type: t,
          payload,
          origin,
          user: (action as { _user?: AioUser })._user,
        },
        ts,
      )
      : timeline.lastSeq() + 1;
    timeline.record(seq, t, payload, prev, next, ts, origin);
  };

  const dispatch = setupDispatch<S, A, E>({
    reduce,
    execute,
    beforeReduce: config.beforeReduce,
    onAction,
    onEffect,
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    getApp: () => app,
    getServer: () => ({
      broadcast: (patches) => server.broadcast(patches),
      broadcastTT: () => server.broadcastTT(),
    }),
    scheduleManager,
    ownManager,
    schedulePersist: () => schedulePersist(),
    getTT: () => tt,
    setTT: (t) => {
      tt = t;
    },
    reportOpts: _reportOpts,
    cellPatchStrategies: config._cellPatchStrategies,
    cellFilterFields: config._cellFilterFields,
    onUdsBroadcast: udsCtrl.onUdsBroadcast,
    onPerf,
    perfCheck: config.perfCheck,
    // Dev holds reduce to ONE FRAME (16ms) instead of the 100ms prod budget:
    // a reduce is on the server's single dispatch path, so every millisecond it
    // takes is a millisecond every client's next action waits. Dev-stricter is
    // the allowed direction (observe-only, throttled to one report per action
    // type per 10s) — it teaches the "keep actions instant, move compute
    // off-thread" habit while the app is still small. Prod keeps 100ms so a
    // deployed app doesn't chatter. Override either with `perfBudget`.
    perfBudget: config.perfBudget ??
      (prod ? undefined : { reduce: DEV_FRAME_BUDGET_MS }),
    perfLog: (source, type, duration, budget, breakdown) =>
      getLogger()?.perf(source, type, duration, budget, breakdown),
    freezeState: config.freezeState ?? !prod,
    effectTimeout: config.effectTimeoutMs,
    reduceBreakdown: config._reduceBreakdown,
    ttSkipActions,
    afterAction: afterActionHook,
    cellNames: config._cellNames ? new Set(config._cellNames) : undefined,
    log,
    debug: VERBOSE,
  });
  // ONE ceiling for "how long may this async method run" — the effect side and
  // the `await cell.method()` side resolve from the same numbers. They used to
  // be two 30s timers with opposite semantics, so raising effectTimeoutMs left
  // the caller still giving up at 30s and blaming a crashed executor.
  _setCallTimeouts(
    config.effectTimeoutMs,
    config.perfBudget?.methods
      ? Object.fromEntries(
        Object.entries(config.perfBudget.methods)
          .filter(([, v]) => typeof v?.timeout === "number")
          .map(([k, v]) => [k, v!.timeout as number]),
      )
      : undefined,
  );

  // Sync ops apply through the normal dispatch path (late-bound at boot).
  _syncDispatchRef.fn = (a) => dispatch(a as unknown as A);

  const freezeEnabled = config.freezeState ?? !prod;
  log.info(
    `freezeState: ${freezeEnabled}${
      config.freezeState === undefined
        ? (prod ? " (prod default)" : " (dev default)")
        : ""
    }`,
  );

  // Vitals periodic check
  if (vitalsSystem) {
    const interval = (typeof diagResolvedOpts === "object" &&
      typeof diagResolvedOpts.vitals === "object" &&
      diagResolvedOpts.vitals.heartbeatInterval) || 1000;
    _vitalsCheckTimer = startVitalsCheck({
      vitalsSystem,
      heartbeatInterval: interval,
      dispatch,
      getState: () => state,
    });
  }

  // LAN discovery responder — late-bound (started in startLifecycle when
  // exposed), stopped by the shutdown orchestrator.
  const discoveryRef: { stop: (() => void) | null } = { stop: null };

  // AUTH-1/2: session + password-user stores — one auth.db in the data dir,
  // closed by the shutdown orchestrator. `auth: true` implies sessions (the
  // login flow issues them); `sessions: true` alone is just the token store.
  const authEnabled = !!config.auth;
  const authOpts = typeof config.auth === "object" ? config.auth : {};
  // The two stores are MUTUALLY bound, both ways, deliberately:
  //   users → sessions: a password change revokes every session (through the
  //     instance, so live WS sockets are disarmed, not just rows deleted).
  //   sessions → users: a session resolves its role from the users row at USE
  //     time, so `am auth role` reaches sessions that are already open.
  // One of the two edges has to be late-bound; the getter below is it.
  let sessionStore: SessionStore | null = null;
  const userStore = authEnabled
    ? openUserStore(appDirs(appId, config.appDir).authDb, {
      sessions: () => sessionStore,
    })
    : null;
  // serverAuth() ambience — released in shutdown() below.
  const _unregisterAuthStore = userStore ? _registerAuthStore(userStore) : null;
  sessionStore = (config.sessions || authEnabled)
    ? openSessionStore(
      appDirs(appId, config.appDir).authDb,
      typeof config.sessions === "object"
        ? config.sessions.ttlMs
        : authOpts.ttlMs,
      { roleOf: (id) => userStore?.get(id)?.role ?? null },
    )
    : null;

  // Shutdown orchestrator
  // ── Cell workers ──
  // Actions for a `worker: true` cell bypass the main queue entirely; only the
  // patches they commit come back through `dispatch`. Inert (identity routing)
  // when no cell is flagged.
  const workerPool = createCellWorkerPool({
    // libraryMode means the entry module is a TEST (or a host app), not this
    // app — spawning a worker on it would re-run the test file in another
    // thread. Worker cells then run in-isolate, exactly like testCell: same
    // behavior, no isolation, and it says so once.
    cells: (config.libraryMode
      ? []
      : config._workerCells ?? []) as unknown as Parameters<
        typeof createCellWorkerPool
      >[0]["cells"],
    entry: Deno.mainModule,
    prod,
    getSlice: (cell) =>
      ((state as Record<string, unknown>)[cell] ?? {}) as Record<
        string,
        unknown
      >,
    dispatch: (a) =>
      dispatch(a as unknown as A),
    // An effect handed back by a worker executes HERE, where the runtime lives.
    // A schedule effect is NOT an action — dispatching it would do nothing at
    // all, and the schedule would silently never fire.
    runEffect: (effect) => {
      if (isScheduleEffect(effect)) {
        scheduleManager.handle(effect);
        return;
      }
      // Same class, and it was live: `__own` fell through to `dispatch` as an
      // action type no cell answers, so an own effect from a worker vanished
      // without a log. Worker cells now hold their resources in their own
      // isolate (cell-worker-host.ts), so nothing should arrive here — and if
      // anything ever does, the own manager says so out loud instead.
      if (isOwnEffect(effect)) {
        ownManager.handle(effect);
        return;
      }
      void dispatch(effect as unknown as A); // cross-cell action
    },
  });
  if (
    config.libraryMode && (config._workerCells ?? []).length > 0 && !prod
  ) {
    log.info(
      "aio",
      `libraryMode: worker cells (${
        (config._workerCells ?? []).map((f) => f.__aio.id).join(", ")
      }) run in-isolate — a test owns the entry module, so there is nothing to ` +
        `host them from. Behavior is identical; isolation is not.`,
    );
  }
  _reseedWorkerCells = () => workerPool.reseed();
  const appDispatch = workerPool.size > 0
    ? (workerPool.route(
      (a) => dispatch(a as unknown as A),
    ) as unknown as typeof dispatch)
    : dispatch;
  if (workerPool.size > 0) {
    // Boot fails loudly if a host can't bind — a silently missing worker cell
    // would answer every call with a hang.
    await workerPool.ready();
  }

  const { shutdown: _shutdownRuntime } = createShutdownOrchestrator({
    sessionStore,
    userStore,
    flushPersist: async () => {
      await persistence.flushPersist();
      // Sync cells' server-origin writes debounce into their snapshot — a
      // clean exit must not leave the last write inside that window.
      await syncHandler?.flushServerWrites();
    },
    setShuttingDown: persistence.setShuttingDown,
    diagHooks,
    getVitalsCheckTimer: () => _vitalsCheckTimer,
    getVitalsSystem: () => vitalsSystem,
    onStop,
    appLock,
    scheduleManager,
    ownManager,
    dispatch,
    // Shutdown aborts + drains THIS app's cells only — another app sharing the
    // process (D2) keeps running its own in-flight methods.
    getCellNames: () => config._cellNames ?? [],
    getElectronProc: () => _electronProc,
    clearElectronProc: () => {
      _electronProc = null;
    },
    disposeUds: udsCtrl.dispose,
    getUdsHandle: () => udsHandle,
    getServer: () => server,
    getDiscoveryStop: () => discoveryRef.stop,
    asyncDb,
    kvDb,
    setRunning: (_v: boolean) => {
      /* multi-instance (D2): no process-wide running flag */
    },
    log,
  });

  /** Stop the worker threads BEFORE the rest of the runtime, and note that the
   *  order is load-bearing rather than incidental.
   *
   *  A worker's in-flight methods live in its own isolate, so Phase 1's
   *  `abortAllInflight` cannot see them; the worker host runs its own
   *  abort + settle on the `close` message and streams the final writes home as
   *  patches, which the ack cannot overtake (FIFO). Those writes arrive as
   *  ordinary dispatches — so they must land while dispatch is still OPEN,
   *  i.e. before `_shutdownRuntime()` closes it and takes the final snapshot.
   *  Closing the pool after the runtime would silently drop exactly the writes
   *  the worker just drained to produce.
   *
   *  `tests/shutdown-worker-cell-durability.test.ts` pins this end to end with
   *  a real worker (libraryMode runs worker cells in-isolate, so an in-process
   *  test cannot reach this path). */
  const shutdown = async (): Promise<void> => {
    await workerPool.close();
    await _shutdownRuntime();
    // A closed app owns nothing: release THIS app's cells so they can bind
    // again. Without it a cell def stayed claimed for the life of the process,
    // so two `testServer()` blocks in one file failed with "already bound" even
    // with `await using` — the second test had to move to its own file for no
    // visible reason. Scoped to our own cells, so a second app in
    // the same process is untouched.
    const release = (app as Record<string, unknown>)._releaseCells as
      | (() => void)
      | undefined;
    release?.();
    _unregisterAuthStore?.();
    _unregisterRuntime();
  };

  /** Tell the PROCESS about this app, so any process-wide exit (a signal,
   *  `am stop`, the Electron window closing) waits for THIS app's final
   *  snapshot too — not just for whichever app got there first. */
  const _unregisterRuntime = registerRuntime(() => shutdown());

  // Content-addressed blob store (tier ③) — resolved through the SAME
  // registered app dirs everything else uses; lazy (no dirs until first put).
  const blobStore = openBlobStore(appId, config.appDir);

  const app = buildAppObject<S, A>({
    dispatch: appDispatch,
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    port,
    asyncDb,
    initialState,
    persistence,
    schedulePersist: () => schedulePersist(),
    getTT: () => tt,
    setTT: (t) => {
      tt = t;
    },
    getServer: () => server,
    udsBroadcastFull: () => udsCtrl.broadcastFull(),
    onStateReplaced: () => workerPool.reseed(),
    shutdown,
    sessionStore,
    userStore,
    blobs: blobStore,
  });

  // --- Phase 4: start transport + lifecycle ---
  // ONE decider — same function the ui:"all" privacy warning uses, so a
  // config-exposed app can never be exposed-but-unwarned (see `_exposeOf`).
  const expose = _exposeOf(cli, config);
  const users = config.users;
  const _resolveUser = config.resolveUser
    ? (tok: string) => config.resolveUser!(tok, state)
    : undefined;
  const sessionResolver = sessionStore
    ? (tok: string) => sessionStore.get(tok)
    : undefined;
  // Per-user credentials (users / resolveUser / auth:true) and the shared app
  // key are mutually exclusive — an app in per-user mode never authenticates
  // anyone with `app.key`.
  const _perUserAuth = !!users || !!_resolveUser || authEnabled;
  // NOTE the condition here is deliberately NOT `_perUserAuth`. `token` means
  // two things downstream — "the credential to enforce" and "the author asked
  // for a shared key" — and server.ts's `key:`+`auth:` boot refusal reads the
  // second. Skipping resolution for an `auth: true` app therefore silenced that
  // refusal and booted an app whose advertised key gated nothing, which is the
  // exact failure the refusal exists to prevent.
  // alpha52: exposed with NO auth story at all (no users/resolveUser/auth,
  // `key` undecided) now defaults to `key: true` — a generated shared key,
  // persisted 0600, carried by the share link — instead of an app open to
  // everyone on the network. `key: false` is the explicit opt-out (aiol's
  // migration fix inserts it to preserve a pre-alpha52 open app).
  const _cfgKey = (config as { key?: string | boolean }).key;
  const { key: _effKey, defaulted: _keyDefaulted } = defaultAppKeyConfig({
    expose,
    perUserAuth: _perUserAuth,
    key: _cfgKey,
  });
  const _keyRes = (expose && !users && !_resolveUser)
    ? resolveAppKey(appId, _effKey)
    : { key: undefined, persisted: false, explicit: false };
  if (_keyDefaulted && _keyRes.key) {
    log.warn(
      `--expose with no \`key\` configured — generated a shared app key ` +
        `(persisted at ${appKeyPath(appId)}, mode 0600; stable across ` +
        `restarts). The share link below carries it; devices pair by PIN. ` +
        `This is the alpha52 default. To run OPEN to everyone on the ` +
        `network, say so explicitly: key: false.`,
    );
  }
  if (_cfgKey === false && expose && !_perUserAuth) {
    log.warn(
      `--expose with key: false — this app is OPEN: anyone who can reach ` +
        `the port can read broadcast state and call methods. If that is not ` +
        `intended, delete \`key: false\` (a shared key is generated) or add ` +
        `per-user auth (users/resolveUser/auth).`,
    );
  }
  // An app that MOVED from `key: true --expose` to per-user auth left its old
  // `app.key` on disk, and nothing ever cleared it: `resolveAppKey` owns "the
  // key file tells the truth" but only runs on the shared-key path. `am profile`
  // reads that file directly, so it kept exporting a dead credential as the
  // current one — and it would come back to life the moment the app switched
  // back. Per-user mode is the ONLY safe place to clear it: "not exposed right
  // now" does not mean the key is dead, and deleting it there would regenerate a
  // different one on the next `--expose` and break every already-paired device
  // ("one key, use forever").
  if (_perUserAuth && !_keyRes.key) {
    try {
      Deno.removeSync(appKeyPath(appId));
      log.debug(
        `auth: removed stale app.key — this app uses per-user credentials`,
      );
    } catch { /* none present: the normal case */ }
  }
  const token = _keyRes.key;
  const clientCounter = { value: 0 };
  const udsRef = { current: null as UDSHandle | null };

  const transport = await setupTransport<S, A>({
    appId,
    port,
    prod,
    distDir,
    electronDistDir,
    baseDir,
    expose,
    token,
    users,
    resolveUser: _resolveUser,
    sessionResolver,
    // AUTH-2/3: login-flow deps — aio-server adds the TLS-aware `secure` flag.
    authFlows: userStore && sessionStore
      ? {
        users: userStore,
        sessions: sessionStore,
        signup: authOpts.signup !== false,
        cookie: authOpts.cookie !== false,
        ttlMs: authOpts.ttlMs,
        appTitle: title,
        sendMail: authOpts.sendMail,
        requireVerified: authOpts.requireVerified,
        totp: authOpts.totp,
        oidc: authOpts.oidc,
      }
      : undefined,
    cliCert: cli.cert,
    cliKey: cli.key,
    cliNoTls: cli.noTls ?? false,
    cliTransport: cli.transport,
    ui,
    title,
    // HOP 2 of the config bridge — MECHANICAL, never a hand-copied literal.
    // The whole config rides across and `TransportConfig` (aio-server.ts) is
    // the single list of what may be read. The literal that used to stand here
    // silently dropped `serveDirs` (feature dead on arrival) and `_cellNames`
    // (browser drift warning unreachable), after strictOrigin/redactActions/
    // appDir/renderBudget did the same at hop 1. Gate:
    // tests/config-bridge-hop2.test.ts.
    config,
    getState: () => state,
    getUIState: (s, user?) => getUIState(s, user),
    // ROUTED dispatch: a network-borne action for a `worker: true` cell must
    // reach its worker, not be reduced here. The raw dispatcher would have run
    // the method on the main isolate — no isolation at all, and the worker's
    // copy of the slice would drift out of sync with ours.
    dispatch: (action) => appDispatch(action as A),
    app: {
      snapshot: () => app.snapshot!(),
      loadSnapshot: (json) => app.loadSnapshot!(json),
    },
    blobs: blobStore,
    vitalsSystem,
    costMeter,
    useElectron,
    tt: tt ? { handleTTCommand, getTTBroadcast: () => toBroadcast(tt!) } : null,
    syncHandler: syncHandler ?? null,
    syncBroadcastRef,
    shutdown,
    udsHandle: udsRef,
    schedulePersist: () => schedulePersist(),
    shouldPersist,
    scheduleManager,
    // Cell id → method names — trojan `cells` route (amui run-method buttons).
    cellMethods: config._cellMethods ?? {},
    cellFields: config._cellFields ?? {},
    asyncDb,
    // In-memory dispatch timeline — the trojan `timeline` route.
    getTimeline: (after?: number, limit?: number) =>
      timeline.entries(after, limit),
    // Boot migration + shape-drift picture — trojan `migrations`.
    migrations: migrationSummary,
    appLock,
    clientCounter,
    log,
  });

  server = transport.server;
  udsHandle = transport.udsHandle;
  udsRef.current = udsHandle;

  // `asyncDb` is optional; bind it once so the narrowing survives into the
  // callback that takes the pre-migration backup.
  const _snap = asyncDb?.snapshot?.bind(asyncDb);
  const _snapshotDb = _snap ? (path: string) => _snap(path) : undefined;

  // Whatever was pending has now booted far enough to serve — confirm it, so a
  // later boot does not roll back a version that works.
  if (!config.libraryMode) confirmPendingUpdate(_dirs.data, log);

  // Updates: opt-in, and off by default in libraryMode (a test or a host app
  // owns this process; nothing it did should replace a binary).
  const _updates = config.updates && !config.libraryMode
    ? await startUpdates({
      updates: config.updates,
      dataDir: _dirs.data,
      appVersion: _resolveAppVersion(
        config.appVersion,
        _denoJsonVersion(),
        isCompiled(),
      ),
      stamp: (appDenoJson()?.build as { channel?: string } | undefined)
        ?.channel,
      flag: cli.channel,
      local: {
        schema: PERSIST_SCHEMA_VERSION,
        cells: migrationSummary?.stored ?? {},
      },
      exposed: expose,
      log,
      argv: Deno.args,
      snapshot: _snapshotDb,
      shutdown: () => _shutdownRuntime().catch(() => {}),
      prompt: ttyPrompt(),
    })
    : undefined;

  // Problem reports: user-filed and automatic. Off in libraryMode — a test or
  // a host app owns this process, and its failures are not the app's to file.
  const _feedback = config.feedback && !config.libraryMode
    ? await startFeedback({
      feedback: config.feedback,
      log,
      redact,
      sources: {
        appId,
        appVersion: _resolveAppVersion(
          config.appVersion,
          _denoJsonVersion(),
          isCompiled(),
        ),
        aioVersion: VERSION,
        dataDir: _dirs.data,
        logsDir: _dirs.logs,
        exposed: expose,
        persist: shouldPersist,
        cells: Object.keys(config._cellMethods ?? {}),
        channel: _updates?.channel,
        getState: () => app.getState() as Record<string, unknown>,
        getTimeline: () => timeline.entries(),
      },
    })
    : undefined;

  // Lifecycle: globals, onStart, schedules, logging, client launch
  startLifecycle({
    // Boot-report auth label — "password+totp+oidc", "sessions", or fallback.
    authMode: authEnabled
      ? [
        "password",
        authOpts.totp !== false ? "totp" : "",
        authOpts.oidc ? "oidc" : "",
        authOpts.requireVerified ? "verified-email" : "",
      ].filter(Boolean).join("+")
      : sessionStore
      ? "sessions"
      : undefined,
    // Facts the report cannot read off the process: where this app keeps what
    // it owns, and what it is actually running.
    bootExtras: {
      pid: Deno.pid,
      client: { value: client, from: clientFrom },
      port: { value: port, from: portFrom },
      entry: {
        // What is RUNNING, read from the process — not what a config said
        // should run. Those differ exactly when someone is confused.
        value: Deno.mainModule.replace(/^file:\/\//, ""),
        from: "default",
      },
      heap: _heapLine,
      dataDir: _dirs.home,
      logs: { dir: _dirs.logs, level: cli.verbose ? "debug" : "info" },
      journal: config.journal
        ? (typeof config.journal === "string" ? config.journal : _dirs.journal)
        : undefined,
      cells: Object.keys(config._cellMethods ?? {}),
      // What is NOT ordinary about a cell: its own thread, or a second writer.
      // Both change how a symptom is read, and neither was visible without
      // opening the source.
      workers: [...getRegisteredCells().values()]
        .filter((c) => (c as { __aio?: { worker?: boolean } }).__aio?.worker)
        .map((c) => (c as { __aio: { id: string } }).__aio.id),
      syncCells: [...getRegisteredCells().values()]
        .filter((c) => {
          const sync = (c as { __aio?: { sync?: unknown } }).__aio?.sync;
          return sync !== undefined && sync !== false;
        })
        .map((c) => (c as { __aio: { id: string } }).__aio.id),
      routes: config.routes ? Object.keys(config.routes).length : 0,
      feedback: _feedback
        ? {
          auto: _feedback.auto,
          keep: _feedback.keep,
          destination: _feedback.url ??
            (_feedback.hasSink ? "custom sink" : undefined),
        }
        : undefined,
      updates: _updates
        ? {
          source: _updates.source,
          kind: _updates.kind,
          channel: _updates.channel,
          intervalMs: _updates.intervalMs,
          auto: _updates.auto,
        }
        : undefined,
    },
    appId,
    appVersion: _resolveAppVersion(
      config.appVersion,
      _denoJsonVersion(),
      isCompiled(),
    ),
    title,
    prod,
    electronDistDir,
    baseDir,
    expose,
    singletonMode,
    childWindows: !!config.childWindows,
    client,
    useElectron,
    isHeadless,
    transport: transport.transport,
    skipHttp: transport.skipHttp,
    port,
    token,
    users,
    perUserAuth: _perUserAuth,
    tlsCert: transport.tlsCert,
    shareUrl: transport.shareUrl,
    localUrl: transport.localUrl,
    advertiseHost: transport.advertiseHost,
    server,
    udsHandle,
    app,
    onStart,
    fatalOnStart: config.fatalOnStart,
    scheduleManager,
    schedules: config.schedules,
    shouldPersist,
    persistMode,
    asyncDb,
    db: config.db,
    maxConnections: config.maxConnections,
    cli: { width: cli.width, height: cli.height, keepServer: cli.keepServer },
    // The FULL head-shaped config, not just the window box: the dev Electron
    // aio:// shell is templated at launch and has no other way to learn
    // ui.head/ui.viewport/ui.showStatus. Dropping them here made an app that
    // respected ui.head under `deno task dev` (HTTP) ship it in the packaged
    // window but NOT in the dev Electron window — two dev surfaces, two heads
    // (WYSIDIWYSIP).
    ui: {
      width: ui.width,
      height: ui.height,
      showStatus: ui.showStatus,
      viewport: ui.viewport,
      head: ui.head,
    },
    keepServer: config.keepServer,
    setElectronProc: (proc) => {
      _electronProc = proc;
    },
    setDiscoveryStop: (stop) => {
      discoveryRef.stop = stop;
    },
    appLock,
    log,
  });

  return app;
}

/** Main aio namespace — `aio.run(config)` starts the server. */
export const aio = { run };
