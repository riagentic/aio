// Boot sequence — KV, SQLite, persistence, sync, and state restoration
// Extracted from aio.ts _run() to keep the orchestrator lean. The sync replay
// (boot-sync-replay.ts), the `db:` bindings (boot-db-bindings.ts), the
// pre-restore scrub (boot-scrub.ts) and the snapshot restore (boot-restore.ts)
// live beside it and are re-exported here, so every name this module ever
// exported still imports from this path.

import {
  createPersistenceManager,
  type PersistenceManager,
} from "./persistence.ts";
import {
  createJournal,
  type Journal,
  journalHeldCellsKey,
  journalWatermarkKey,
  TT_RESTORE_TYPE,
} from "./journal.ts";
import type { SkvInstance } from "./skv.ts";
import { migrateLegacyKv, SKV_SCHEMA, sqliteKv } from "./skv-sqlite.ts";
import type { DB } from "../db/types.ts";
import { createDB } from "../db/async-db.ts";
import { initSchema, loadTables, readSyncedTables } from "../db/state-sync.ts";
// The db module owns the "is this a missing worker?" verdict — importing the
// predicate keeps ONE decider for a failure that surfaces in two places.
import { dbWorkerMissingHint } from "../db/async-db.ts";
import type { DbMapping, TableDef } from "./sql.ts";
import "./sql.ts"; // load order: evaluated here, as before the split
import { deepMerge } from "../state/deep-merge.ts";
import {
  createDeclaredShapeGuard,
  shapeDriftDeciders,
} from "../state/declared-shape-guard.ts";
// The migration/restore pass is ONE implementation for every runtime (the
// standalone/Android one runs it too) — re-exported so this module's importers
// are unchanged.
import {
  applyCellMigrations,
  type CellMigrationInfo,
  type CellMigrationOutcome,
  detectShapeDrift,
  downgradeParkKey,
  type MigrationReport,
  reattachUndeclared,
  refuseThenable,
  runCellRestore,
  type ShapeDriftEntry,
  shapeDriftSummary,
  shapeFingerprint,
} from "../state/cell-migrate.ts";
export {
  applyCellMigrations,
  type CellMigrationInfo,
  type CellMigrationOutcome,
  detectShapeDrift,
  downgradeParkKey,
  type MigrationReport,
  reattachUndeclared,
  runCellRestore,
  type ShapeDriftEntry,
  shapeDriftSummary,
};
import { resolveKvPath } from "./paths.ts";
import "./aio-cli.ts"; // load order: evaluated here, as before the split
import "../sync/compact.ts"; // load order: evaluated here, as before the split
import "../sync/state-patch.ts"; // load order: evaluated here, as before the split
import { dirname, join, resolve, SEPARATOR } from "@std/path";
import { appDirs, appsDirEnv } from "./app-dirs.ts";
import type { BudgetLedger } from "../state/budgets.ts";
import {
  AioError,
  createAioError,
  reportError as reportAioError,
  type ReportErrorOpts,
  teachableError,
} from "../diagnostics/error.ts";
import { makeRedactor } from "../diagnostics/redact.ts";
import "./persist-schema.ts"; // load order: evaluated here, as before the split
import type { Log } from "../diagnostics/logger-api.ts";
import type { CheckpointData, DiagnosticsHooks } from "../diagnostics/mod.ts";
import { staleCheckpointWarning } from "../diagnostics/mod.ts";
import "../state/state-filter.ts"; // load order: evaluated here, as before the split
import "../state/cell-persist-filter.ts"; // load order: evaluated here, as before the split
import type { CellFieldFilter } from "../state/cell-types.ts";
import type { ServerSyncHandler } from "../sync/server-handler.ts";
import { cloneState } from "../state/immutable.ts";
import "../sync/server-store.ts"; // load order: evaluated here, as before the split
import "../state/rejection-tracker.ts"; // load order: evaluated here, as before the split
import "./op-placement.ts"; // load order: evaluated here, as before the split
import { count } from "../diagnostics/fmt.ts";
import {
  bootStoreGen,
  planStoreGenRecord,
  recordStoreGen,
} from "./store-gen.ts";
import {
  _isObj,
  type DbBinding,
  omitPaths,
  placeLoadedTables,
  readPath,
  resolveDbBindings,
} from "./boot-db-bindings.ts";
import {
  isDevBoot,
  openStrayJournal,
  registerSyncReplayContext,
} from "./boot-sync-replay.ts";
import {
  fieldsAsRestart,
  persistedFields,
  persistOffButStored,
  restorableSlices,
  scrubbedCopiesKey,
  scrubStaleSlices,
  scrubStoreCopies,
  unstoredCells,
} from "./boot-scrub.ts";
import {
  detectNewFields,
  loadAndMigrateSnapshot,
  type MigrationSummary,
  newFieldsSummary,
  readStoredShapes,
  restoreDropWatcher,
  selfWrittenDrift,
  shapeDriftRefusal,
  withRestoreDropWatch,
} from "./boot-restore.ts";

// ── `db:` table ↔ state bindings — ./boot-db-bindings.ts, re-exported ──

export {
  omitPaths,
  placeLoadedTables,
  readPath,
  resolveDbBindings,
} from "./boot-db-bindings.ts";
export type { DbBinding } from "./boot-db-bindings.ts";

// ── Boot sync replay — ./boot-sync-replay.ts, re-exported ──

export {
  cleanStopThrough,
  dropOpHow,
  getSyncReplayContext,
  isDevBoot,
  issuedThrough,
  moveJournalAside,
  openStrayJournal,
  reactionsFormat,
  recordCleanStop,
  registerSyncReplayContext,
  replaySyncOps,
  seedSyncReactions,
  stampReactions,
  unwrapReduced,
} from "./boot-sync-replay.ts";
export type { SyncReplayContext } from "./boot-sync-replay.ts";

// ── Boot scrub — ./boot-scrub.ts, re-exported ──

export { persistOffButStored } from "./boot-scrub.ts";

// ── Boot restore — ./boot-restore.ts, re-exported ──

export {
  detectNewFields,
  loadAndMigrateSnapshot,
  newFieldsSummary,
  restoreDropWatcher,
  shapeDriftRefusal,
} from "./boot-restore.ts";
export type {
  DriftStore,
  MigrationSummary,
  ShapeAdditionEntry,
} from "./boot-restore.ts";

// ── `__aioDev` for the SERVER process ──────────────────────────────────────
//
// `__aioDev` is THE dev flag every isomorphic gate reads (`isDevMode`,
// `removalsAreFatal`, the dev freeze, the hidden-field guard, `own.set`'s
// replace warning…). The browser shell stamped it, the worker host copied it,
// the test harness armed it — and the dev SERVER never set it. So every
// "dev throws / dev warns" gate ran as prod in `deno task dev`: a retired
// `cell({ ui })` or `aio.run({ appVersion })` logged and booted "started"
// while the upgrade guide said dev refuses, and a method reading the flag got
// "undefined".
//
// Stamped HERE, at import, rather than in `aio.run`: `cell()` runs when the
// app's cell modules are imported — before `aio.run` is ever called — and it
// is where the cell-config retirements and the dev freeze of declared state
// fire. Every cell module imports `cell` from this graph, so this line has run
// before the first `cell()` does.
//
// Decided by `isDevBoot` — the same decider the boot uses for everything else,
// so dev here IS dev there. Only ever set to true, and only when nothing set
// it first: a harness, a worker that inherited the owner's flag, or a test
// that deliberately holds it off keeps its value. An unreadable environment
// (`isCompiled` reads $APPIMAGE) leaves it unset; `aio.run` needs that
// permission anyway and says so itself.
{
  const g = globalThis as Record<string, unknown>;
  if (g.__aioDev === undefined) {
    try {
      if (isDevBoot()) g.__aioDev = true;
    } catch { /* no --allow-env: see above */ }
  }
}

/** Inputs needed to run the boot/storage sequence */
export interface BootConfig<S> {
  appId: string;
  /** Where this app keeps everything it owns. Default `~/.<appId>` — `data/`
   *  inside it is the whole backup; `logs/` and `launch.json` are disposable.
   *  This is the AUTHOR's choice; whoever runs the app can move every app at
   *  once with `AIO_APPS_DIR=<root>` (→ `<root>/<appId>`).
   *  See docs/persistence/where-files-live.md. */
  appDir?: string;

  /** THIS app's budget ledger (`setBudgets(...)` in aio.ts). Handed to the
   *  persistence manager explicitly: boot awaits between the app's
   *  `setBudgets` and the manager's construction, and a second app booting in
   *  the same process sets ITS ledger in that gap — so a `budgetsFor()` read
   *  there judged this app's cells by the other app's `cellState`. */
  budgets?: BudgetLedger;
  /** Override the SQLite file (":memory:" for hermetic tests). Default:
   *  `~/.<appId>/data/state.db` (see app-dirs.ts) unless overridden. */
  dbPath?: string;
  /** Override the PRAGMAs the app db opens with (default: DEFAULT_PRAGMAS,
   *  WAL + synchronous=NORMAL). An app whose data is expensive to lose — a
   *  wallet, a ledger — wants `synchronous = FULL`; a cache does not. */
  dbPragmas?: string[];
  /** Verify the app database at boot and recover from a snapshot if it is
   *  damaged — see db-integrity.ts. */
  checkIntegrityOnBoot?: boolean;
  /** Action types whose payload the journal must NOT record — forwarded from
   *  the app config (a passphrase argument must not land in a recovery file). */
  redactActions?: readonly string[];
  /** Action types some cell `listensTo` — a copied journal keeps such a
   *  `persist: "none"` call (see `scrubUnstoredLines`). */
  listenedTypes?: readonly string[];
  initialState: S;
  shouldPersist: boolean;
  /** Run the write guard although nothing persists (`_harnessShapeGuard`). */
  harnessShapeGuard?: boolean;
  persistKey: string;
  persistMode: "single" | "multi";
  persistDebounceMs: number;
  dbSchema: Record<string, TableDef | DbMapping> | undefined;
  syncCellIds: string[];
  /** Per-cell `sync.offline.retention` in ms — sizes compaction's id-tombstone
   *  window so a resend after a long offline stretch still hits the dedup. */
  syncRetentionMs?: Record<string, number>;
  /** Per-cell declarative access rules — enforced on the sync-op path (AUTH-1
   *  parity with the action-dispatch gate in aio-server.ts). */
  cellAccess?: Map<string, import("../state/cell-types.ts").Access>;
  /** Per-cell version + migration hooks — keyed by cell id */
  cellMigrations?: Map<string, CellMigrationInfo>;
  /** Every cell's declared `version`, migration or not — the complete map the
   *  persistence version stamp needs (see the note where it is used). */
  _cellVersions?: Record<string, number>;
  /** User hook — transform state after restore. Mutate it and return nothing,
   *  or return a replacement (see the call site). */
  onRestore?: (state: S) => S | void;
  /** Per-cell `onRestore` hooks — run BEFORE the app-level one, each scoped to
   *  its own slice. See CellConfig.onRestore. */
  cellRestores?: Map<
    string,
    (state: Record<string, unknown>) => Record<string, unknown> | void
  >;
  /** Diagnostics checkpoint restore callback */
  onCheckpointRestore?: (
    checkpoint: CheckpointData,
  ) => Record<string, unknown> | null;
  /** Diagnostics hooks (null if disabled) */
  diagHooks: DiagnosticsHooks | null;
  /** Health getter factory for diagnostics */
  healthGetter?: (
    state: unknown,
  ) => Record<string, { errors: number; enabled: boolean }>;
  /** KV state filter — excludes fields not meant for persistence */
  getDBState: (s: S) => unknown;
  /** Late-bound getState for persistence manager (reads live state from _run) */
  getState: () => Record<string, unknown>;
  /** The UI-visible projection of state — what a CLIENT may see (per-cell `ui`
   *  filters applied). The CRDT catch-up snapshot ships through this; raw state
   *  stays server-side for compaction/durability. Required, not optional: the
   *  snapshot path used to read raw `getState()` and shipped `ui: "none"` cells
   *  and excluded fields to any client that fell behind compaction. */
  getUIState: (s: Record<string, unknown>) => unknown;
  /** Late-bound reportOpts getter for persistence manager */
  getReportOpts: () => ReportErrorOpts;
  /** Opt-in durable action journal — SIGKILL/power-cut recovery of
   *  the debounce-window tail. bootStorage creates it, the persistence manager
   *  advances its watermark, _run appends + replays. Undefined/false ⇒ off. */
  journal?: boolean;
  /** Cell id → its `persist` filter (dot paths included) — the declared-shape
   *  write guard skips fields that are never restored. */
  cellPersist?: Record<
    string,
    import("../state/cell-types.ts").CellFieldFilter
  >;
  /** Ids of the cells whose `onPersist` SHAPES the stored slice — their
   *  stored keys are the shape's, not drift, and their `onRestore` is handed
   *  them (see {@linkcode runCellRestore}). */
  cellPersistShaped?: string[];
  /** The restore half of the persist rule (`persistingCellIds`, via the
   *  bridge): a declared cell outside it is never restored — a slice an older
   *  build or a downgrade left in the store stays there, unread. Absent (a raw
   *  boot with no cells) = restore everything, as before. */
  persistingCellIds?: readonly string[];
  log: Log;
}

/** Everything the boot sequence produces */
export interface BootResult<S> {
  state: S;
  kvDb: SkvInstance | null;
  asyncDb: DB | null;
  persistence: PersistenceManager;
  /** Durable action journal — null unless `journal: true`. */
  journal: Journal | null;
  /** With the journal OFF: a journal a crash left, opened for its op
   *  records only (`openStrayJournal`) — the orchestrator resolves them,
   *  then moves it aside. Never replayed. */
  strayJournal: Journal | null;
  /** A run that journals nothing saved the store after this build last
   *  recorded it (store-gen.ts) — the journal's tail is older than the
   *  store. */
  storeSavedElsewhere: boolean;
  /** Undeclared cells whose journal lines are held, not replayed (see
   *  `journalHeldCellsKey`) — the orchestrator leaves them out of replay and
   *  names them. */
  journalHeld: ReadonlySet<string>;
  /** Boot migration + shape-drift picture — undefined when nothing
   *  was restored. Surfaced live via `am migrations`. */
  migrations: MigrationSummary | undefined;
  syncHandler: ServerSyncHandler | undefined;
  /** Mutable ref — caller wires broadcast after server creation */
  syncBroadcastRef: { fn: (msg: string, exclude?: WebSocket) => void };
  syncDispatchRef: {
    fn: (a: { type: string; payload?: unknown }) => void;
    durableFor?: (a: object) => Promise<string | undefined> | undefined;
    heldBecause?: () => string | undefined;
  };
  /** Observe-only: call with each committed reduce's action type and patches
   *  — warns (dev and prod) about writes the next boot will undo. Absent when
   *  nothing persists. See declared-shape-guard.ts. */
  writeGuard?: (actionType: string, patches: unknown) => void;
  /** The cell's persist filter when the write guard REFUSES a type change in
   *  it (dev, persisting, not exempt) — a `worker: true` cell's reduce runs
   *  it in its own isolate, so it throws there as a main-isolate cell's does.
   *  `undefined` ⇒ no refusal for that cell. */
  strictTypeFilter?: (cell: string) => CellFieldFilter | undefined;
  /** The store held a saved state at boot — it has saved at least once. */
  storeHeldState?: boolean;
}

/** Runs the full storage boot sequence — SQLite, CRDT sync, KV restore,
 *  onRestore hook, checkpoint restore, SQLite table load, persistence manager. */
export async function bootStorage<S>(
  cfg: BootConfig<S>,
): Promise<BootResult<S>> {
  // A REFUSAL RELEASES WHAT THIS BOOT OPENED — every refusal, in one place.
  // The caller's undo list gets the database only when this function RETURNS,
  // so a throw anywhere below (a failed migration, `journal: true` with
  // nothing to journal to, a table load that fails) left `state.db` open and
  // its worker thread alive: the process could not exit, and on Windows the
  // "remove this directory" a refusal advises failed with "being used by
  // another process" (os error 32). `close()` on a closed handle is a no-op.
  const opened: DB[] = [];
  try {
    return await bootStorageOpening(cfg, opened);
  } catch (e) {
    await closeOpened(opened);
    throw e;
  }
}

/** Close every database a boot opened and is not going to hand over. */
async function closeOpened(opened: DB[]): Promise<void> {
  for (const db of opened.splice(0)) {
    await db.close().catch(() => {
      // aio-ok(silent-catch): the boot is already refusing, or degrading, for
      // the reason it reports; a close that fails has nothing to add.
    });
  }
}

/** {@link bootStorage}'s sequence. Every database it opens goes into
 *  `opened`, which the caller closes when this throws. */
async function bootStorageOpening<S>(
  cfg: BootConfig<S>,
  opened: DB[],
): Promise<BootResult<S>> {
  const {
    appId,
    dbPath: dbPathOverride,
    dbPragmas,
    initialState,
    shouldPersist,
    persistKey,
    persistMode,
    persistDebounceMs,
    dbSchema,
    syncCellIds,
    onRestore,
    cellRestores,
    onCheckpointRestore,
    diagHooks,
    healthGetter,
    getDBState,
    getState,
    getReportOpts,
    log,
  } = cfg;

  // The dev checkpoint never holds what the store never holds — from the
  // first dispatch on (diagnostics/checkpoint.ts `CheckpointView`): no
  // `persist: "none"` cell, and no field a `persist: { exclude | include }`
  // keeps off disk (top-level or dot path). Never the store's SHAPE: the
  // checkpoint is handed to `onCheckpointRestore` and assigned into live
  // state with no `onRestore`, so an `onPersist`-shaped slice would land
  // there as-is. The fields it leaves out come back at restore exactly as a
  // restart brings them back (step 6).
  const persisting = cfg.persistingCellIds;
  if (persisting) {
    diagHooks?.setCheckpointView?.((s) =>
      persistedFields(
        restorableSlices(
          s,
          persisting,
          initialState as Record<string, unknown>,
        ),
        cfg.cellPersist,
      )
    );
  }

  // A MUTABLE working copy of the declaration.
  //
  // `composeCells` freezes `initialState` (so the state at t=0 behaves like
  // every state after it — see `cell-compose.ts`), and boot is the one place
  // that legitimately BUILDS state rather than reading it: the KV restore
  // merges slices into it, `onMigrate` rewrites shapes, and `onRestore` is a
  // documented MUTATION hook —
  //
  //     onRestore: (s) => { s.scores.entries = s.game.leaderboard;
  //                         delete s.game; return s }
  //
  // — which the rename recipe in the docs tells people to write. Handed the
  // frozen declaration, that assignment throws into the hook's own error guard
  // and the migration is reported as a log line while the data quietly does not
  // move. Caught by `tests/orphan-cell-preservation.test.ts` the first time the
  // freeze landed.
  //
  // Deep, not shallow: a cell whose slice was never persisted keeps the frozen
  // NESTED objects under a shallow copy, so `s.scores.entries = …` is exactly
  // the write that would still fail.
  let state = cloneState(initialState) as S;

  // Two homes are a trap, and a silent one. `dbPath` moves ONLY the database:
  // `auth.db`, `tls/`, `meta.json`, the journal and any previously-written
  // `state.db` stay under the app home — so an app that resolves its own data
  // root ends up with its files split across two places, one of which it is no
  // longer looking at. one app found a complete, stale, unguarded wallet
  // database that way (2026-07-28). `appDir` is the knob that moves everything;
  // say so once, at the moment the split is created.
  if (dbPathOverride && dbPathOverride !== ":memory:" && !cfg.appDir) {
    const home = appDirs(appId, cfg.appDir).home;
    // `SEPARATOR`, not "/": on Windows `resolve` answers with backslashes,
    // and a literal "/" made this warning fire for every path there.
    if (!resolve(dbPathOverride).startsWith(resolve(home) + SEPARATOR)) {
      log.warn(
        `dbPath puts the database at ${dbPathOverride}, but everything else ` +
          `(auth.db, tls/, meta.json, the journal) stays under ${home} — two ` +
          `homes, and files already written to the old one are still there. ` +
          `Pass appDir to move the whole app directory instead.`,
      );
    }
  }

  // ── 1. SQLite ─────────────────────────────────────────────────────
  // Resolve `db:` keys to SQL tables + the state arrays they mirror BEFORE any
  // file is opened: an ambiguous or impossible binding must fail before it can
  // create anything. `sqlSchema` is keyed by SQL table name from here on.
  const { bindings: dbBindings, sqlSchema } = dbSchema
    ? resolveDbBindings(initialState as Record<string, unknown>, dbSchema, log)
    : {
      bindings: [] as DbBinding[],
      sqlSchema: {} as Record<string, TableDef>,
    };
  const dbKeys = Object.keys(sqlSchema);
  const boundPaths = dbBindings.filter((b) => b.path.length > 0).map((b) =>
    b.path
  );
  // THE ONE DECIDER for "which tables does the persistence loop mirror": the
  // bindings that resolved to a state path. `sqlSchema` is every `db:` table
  // (all of them are CREATED); `syncSchema` is the subset that is loaded into
  // state at boot and diffed back on every window. An SQL-only table is in the
  // first and never in the second.
  //
  // It used to be the full schema in both places, while `getTableState` below
  // (correctly) reported only the bound arrays — so the planner met a table
  // whose bound value was `undefined`, threw by name on every window, and the
  // ENTIRE SQLite half stopped: rows pushed into the bound tables were written
  // nowhere, the snapshot half kept committing, and the app looked healthy.
  // One documented SQL-only table silently disabled all bound-table
  // persistence. The persistence manager now refuses at construction any
  // planned table the bindings do not vouch for, so this cannot regress
  // quietly.
  const syncSchema: Record<string, TableDef> = {};
  for (const b of dbBindings) {
    if (b.path.length > 0) syncSchema[b.table] = sqlSchema[b.table]!;
  }
  const syncKeys = Object.keys(syncSchema);
  for (const m of persistOffButStored(cfg, dbBindings)) log.warn(m);

  let asyncDb: DB | null = null;

  // THE opener for the app database — because there are TWO paths that open it
  // (this one, for `db:` tables and sync cells; and the persistence block in
  // section 4, for an app that only stores state) and `checkIntegrityOnBoot`
  // was wired into only ONE of them. So for the DEFAULT app shape — no `db:`
  // key, no sync cell — the documented integrity check was a silent no-op: a
  // corrupt `state.db` with a perfectly good `state.db.snapshot` beside it
  // threw `persistence unavailable: disk I/O error` and blamed file
  // permissions, quarantined nothing, restored nothing, and named a cause that
  // was not the cause. Verified end to end: with the check wired into both
  // paths the file is quarantined and the snapshot restored, as documented.
  // One opener means the two paths cannot disagree about this again.
  //
  // Integrity runs BEFORE any schema work: a damaged file must be dealt with
  // before anything writes to it. When the file was quarantined (and possibly
  // replaced from a snapshot) the handle is dead — reopen on what is there
  // now, which may be the restored snapshot or an empty database.
  // The file persistence actually opened — the drift refusal prints THIS, not
  // a re-derivation that could disagree with it.
  let openedDbPath: string | undefined;
  const openAppDb = async (dbPath: string): Promise<DB> => {
    openedDbPath = dbPath;
    // The file's directory is aio's to create, like the data dir it defaults
    // to. `--db-path=/srv/app/data/state.db` into a directory that did not
    // exist yet failed as "unable to open database file" with advice to fix
    // PERMISSIONS — a cause that was not the cause. Recursive and idempotent;
    // when even this fails the error names the directory, the real fault.
    if (dbPath !== ":memory:") {
      const dir = dirname(resolve(dbPath));
      try {
        Deno.mkdirSync(dir, { recursive: true });
      } catch (e) {
        throw new Error(
          `cannot create ${dir} for the database ${dbPath}: ${e}`,
          { cause: e },
        );
      }
    }
    const open = () => {
      const db = createDB(dbPath, dbPragmas ? { pragmas: dbPragmas } : {});
      opened.push(db);
      return db;
    };
    const onDisk = dbPath !== ":memory:" && !dbPath.startsWith("file::memory:");
    const recover = async (): Promise<DB> => {
      // BEFORE the open, and whatever `checkIntegrityOnBoot` says now: opening
      // creates an empty file at the live path, and a restore the previous
      // boot staged but did not live to install would then be dropped as
      // stale — the app booting EMPTY beside a verified snapshot
      // (db-integrity.ts).
      if (onDisk) {
        const { finishInterruptedRestore } = await import("./db-integrity.ts");
        await finishInterruptedRestore({
          dbPath,
          log: {
            warn: (m: string) => log.warn(m),
            error: (m: string) => log.error(m),
          },
        });
      }
      const db = open();
      if (!cfg.checkIntegrityOnBoot) return db;
      const { checkAndRecover } = await import("./db-integrity.ts");
      const outcome = await checkAndRecover({
        db,
        dbPath,
        log: {
          info: (m: string) => log.info(m),
          warn: (m: string) => log.warn(m),
          error: (m: string) => log.error(m),
        },
      });
      // Damaged, handle closed, and not movable: using the closed handle
      // failed later as "this handle is CLOSED" under advice to turn on the
      // check that found it; reopening would boot on a damaged file. Refused
      // here, by name.
      if (outcome.stuck) {
        throw createAioError("PERSIST_ERROR", new Error(outcome.stuck), {});
      }
      if (outcome.action !== "restored" && outcome.action !== "quarantined") {
        return db;
      }
      // The file underneath was replaced. Open it NOW, inside the recovery
      // lock: a restored snapshot is not in WAL mode yet, and the first open
      // switches it — an instance waiting on the lock that opened it at the
      // same moment was refused "database is locked" by that switch.
      const fresh = open();
      try {
        await fresh.query("SELECT 1");
      } catch (e) {
        await fresh.close().catch(() => {
          // aio-ok: the open itself failed; the throw below says why.
        });
        throw e;
      }
      return fresh;
    };
    if (!onDisk) return await recover();
    // One recovery per database at a time, across processes (`singleton:
    // false` shares a data dir): taken when this boot checks integrity or a
    // previous one left a recovery to finish — the only times there is
    // anything to race over.
    const integrity = await import("./db-integrity.ts");
    return cfg.checkIntegrityOnBoot || integrity.recoveryPending(dbPath)
      ? await integrity.withRecoveryLock(
        dbPath,
        recover,
        (lock) =>
          log.warn(
            `db: waiting for another process to finish checking/recovering ` +
              `${dbPath} (it holds ${lock}) — this boot continues when it ` +
              `is done`,
          ),
      )
      : await recover();
  };

  // Sync cells need the SQLite op-log even without user tables — a
  // `sync: true` cell must never silently degrade because `db:` is absent.
  if (dbKeys.length > 0 || syncCellIds.length > 0) {
    const dbPath = dbPathOverride ?? appDirs(appId, cfg.appDir).stateDb;
    // OPENING the file may legitimately degrade (no permission, read-only
    // medium): the app runs from memory and says so.
    try {
      asyncDb = await openAppDb(dbPath);
    } catch (e) {
      // Same classification as the persistence block below: a compiled binary
      // whose db worker was never embedded cannot be degraded around — the
      // app declared tables (or sync cells) that will never work. Fail loud
      // with the build fix instead of a warning nobody reads.
      const workerHint = dbWorkerMissingHint(e);
      if (workerHint) throw new Error(workerHint, { cause: e });
      log.warn(`sqlite: unavailable — ${e}`);
      // The app runs on from memory: a handle the failed open left behind
      // (an integrity check that threw after its first statement) is closed
      // here, not carried for the life of the process.
      await closeOpened(opened);
    }
    // ONE ordered, fatal schema runner (src/db/ddl.ts → runSchemaSetup):
    //   1. "ladder"  — aio's own versioned moves (private `aio_schema` table,
    //                  deliberately NOT `PRAGMA user_version`, which belongs to
    //                  the APP); refuses a file written by a NEWER aio.
    //   2. "tables"  — the DECLARED `db:` tables + drift reconciliation.
    //   3. "sync"    — the CRDT op-log tables + their migrations (sync cells).
    // Each step is idempotent; the first failure refuses the boot by step
    // name, with its fix — never a `sqlite: unavailable` warning and an app
    // serving traffic with none of the tables it declared (the boot used to
    // do exactly that: initSchema's refusal was caught, `asyncDb` nulled, and
    // the persistence block reopened the same file for the KV snapshot).
    if (asyncDb) {
      const { runDdlSteps, runSchemaSetup, applyDdl } = await import(
        "../db/ddl.ts"
      );
      const steps: import("../db/ddl.ts").SchemaStep[] = [
        {
          name: "ladder",
          fix: "upgrade aio to the version that wrote this file (or later), " +
            "or point the app at a backup taken by this version",
          run: async (db) => {
            await runDdlSteps(db);
          },
        },
      ];
      if (dbKeys.length > 0) {
        steps.push({
          name: "tables",
          fix: "the message above names the table and column SQLite refused " +
            "— rename the keyword, add the default, or drop the column it " +
            "names (docs/persistence/sqlite.md → Changing a table's schema)",
          run: (db) => initSchema(db, sqlSchema),
        });
      }
      if (syncCellIds.length > 0) {
        steps.push({
          name: "sync",
          fix: "the sync op-log tables could not be created or migrated — " +
            "check the file is writable; a schema this build cannot evolve " +
            "needs the aio version that wrote it",
          run: async (db) => {
            const { applySyncMigrations, SYNC_SCHEMA } = await import(
              "../sync/compact.ts"
            );
            for (const sql of SYNC_SCHEMA) {
              await applyDdl(db, sql, {
                ns: "sync",
                subject: "sync schema",
                source: 'runSchemaSetup step "sync", src/server/aio-boot.ts',
              });
            }
            // `CREATE TABLE IF NOT EXISTS` cannot add a column to a table an
            // older aio already created, so schema changes need their own
            // step.
            await applySyncMigrations(db, {
              debug: (m: string) => log.debug("sync", m),
              warn: (m: string) => log.warn("sync", m),
            });
          },
        });
      }
      try {
        const ran = await runSchemaSetup(asyncDb, steps);
        log.debug(`db: schema setup ran ${ran.join(" → ")}`);
      } catch (e) {
        const workerHint = dbWorkerMissingHint(e);
        await asyncDb.close().catch(() => {});
        asyncDb = null;
        if (workerHint) throw new Error(workerHint, { cause: e });
        throw e;
      }
    }
    if (asyncDb) {
      log.info(`sqlite: ${count(dbKeys.length, "table")} at ${dbPath}`);
    }
  }

  // ── 2. CRDT sync tables ───────────────────────────────────────────
  const syncBroadcastRef: { fn: (msg: string, exclude?: WebSocket) => void } = {
    fn: () => {},
  };
  // Late-bound like syncBroadcastRef — dispatch doesn't exist yet at boot.
  const syncDispatchRef: {
    fn: (a: { type: string; payload?: unknown }) => void;
    /** Late-bound like `fn` — aio.ts `_durableFor`. */
    durableFor?: (a: object) => Promise<string | undefined> | undefined;
    /** Late-bound like `fn` — why ops are held right now (time travel). */
    heldBecause?: () => string | undefined;
  } = { fn: () => {} };
  let syncHandler: ServerSyncHandler | undefined;
  // Cells the boot replay could not fold into the current shape (field report
  // §3.1). Created here so the handler can consult it; filled by
  // `replaySyncOps`, which the orchestrator runs after this function returns.
  const syncQuarantined = new Set<string>();
  // Declared shape version per cell — the stamp on every op row and snapshot.
  const declaredVersion = (cell: string): number =>
    cfg.cellMigrations?.get(cell)?.version ?? cfg._cellVersions?.[cell] ?? 0;
  // A sync cell's snapshot is its RAW slice: a `persist` filter on a sync cell
  // is refused at `cell()` and at compose time (the op-log cannot honour one),
  // so there is no durable projection to apply here — the projection that
  // used to live here was reachable only through the combination now refused.
  if (syncCellIds.length > 0) {
    if (asyncDb) {
      // The op-log tables were created by the "sync" step of runSchemaSetup
      // above — one runner, one order, one failure mode.
      const { createServerSyncHandler } = await import(
        "../sync/server-handler.ts"
      );
      // AUTH-1 parity: build the sync-path access checker from the same
      // per-cell rules the action path uses. A cell with no rule → open.
      const { cellAccessAllowed } = await import("./server-auth.ts");
      const cellAccess = cfg.cellAccess;
      const accessCheck = cellAccess && cellAccess.size > 0
        ? (cell: string, user: unknown, method: string, args: unknown[]) => {
          const rule = cellAccess.get(cell);
          return rule === undefined ||
            cellAccessAllowed(
              rule,
              user as import("./aio-types.ts").AioUser | undefined,
              method,
              args,
            );
        }
        : undefined;
      syncHandler = createServerSyncHandler({
        dispatch: (a) => syncDispatchRef.fn(a),
        durableFor: (a) => syncDispatchRef.durableFor?.(a),
        heldBecause: () => syncDispatchRef.heldBecause?.(),
        db: asyncDb,
        syncCellIds,
        accessCheck,
        // Server-internal (compaction snapshot = the durability record for
        // sync cells, which are excluded from KV persistence). Raw — see the
        // note above on why no persist projection applies.
        getCellState: (cell: string) =>
          (getState() as Record<string, Record<string, unknown>>)[cell] ?? {},
        cellVersion: declaredVersion,
        isQuarantined: (cell: string) => syncQuarantined.has(cell),
        opRetentionMs: (cell: string) => cfg.syncRetentionMs?.[cell],
        // Client-facing — the same projection every other wire uses. A cell
        // hidden by `ui: "none"` is absent from it, and `null` here means
        // "must not be sent", which the handler honours by sending nothing.
        getClientCellState: (cell: string) => {
          const ui = cfg.getUIState(getState()) as
            | Record<string, unknown>
            | undefined;
          const slice = ui?.[cell];
          return slice && typeof slice === "object" && !Array.isArray(slice)
            ? slice as Record<string, unknown>
            : null;
        },
        broadcastRaw: syncBroadcastRef,
        log,
      });
      log.info(`sync: ${count(syncCellIds.length, "cell")} with CRDT tables`);
    } else {
      log.warn(
        `sync: ${
          count(syncCellIds.length, "cell")
        } have sync: true but no SQLite DB — CRDT disabled`,
      );
    }
  }

  // ── 3. KV state filter (strip db-managed arrays) ─────────────────
  // SQLite owns a bound table's rows; a second copy in the KV snapshot would
  // be a stale twin restored before the tables load. Only the BOUND path is
  // removed — an SQL-only table takes nothing out of state, because it never
  // put anything in.
  const kvGetDBState = boundPaths.length
    ? (s: S) => {
      const full = getDBState(s);
      if (!full || typeof full !== "object" || Array.isArray(full)) return full;
      return omitPaths(full as Record<string, unknown>, boundPaths);
    }
    : getDBState;

  // ── 4. SQLite persistence + restore state (perfect-aio D4) ─────────
  // ONE store: the app's data.db holds tables, sync op-log AND the aio_kv
  // snapshot table (Deno.Kv retired — its local backend was SQLite anyway,
  // minus a 64KiB value limit we hit in the field). Legacy KV data
  // auto-migrates on first boot; the old file is left untouched.
  let kvDb: SkvInstance | null = null;
  // Whether this boot actually restored a persisted snapshot. A brand-new
  // install has none — and must not be "migrated".
  let hadPersistedState = false;
  // Raw stored snapshot (pre-deepMerge) — kept for boot-time shape-drift
  // detection against the declared `initialState`.
  let persistedSnapshot: Record<string, unknown> | null = null;
  // The keys the STORE holds, before the restore filter below drops any.
  // Persistence deletes rows by diffing these against what it writes, so a
  // `persist: "none"` row an older build left in multi mode has to be in this
  // list — or it is never deleted, and the secret stays on disk for good.
  let storedKeysOnDisk: string[] | null = null;
  /** A run that journals nothing saved the store after this build last
   *  recorded it (store-gen.ts). */
  let storeSavedElsewhere = false;
  // Migration + shape-drift summary, surfaced live via `am migrations`.
  let migrations: MigrationSummary | undefined;
  // The per-cell version stamp of the build that last persisted — also the
  // evidence the sync replay uses for rows that predate the op/snapshot stamp.
  let stampedVersions: Record<string, number> = {};
  /** The shape the drift check read the store against — reused for the
   *  persistence manager's per-cell shape stamp (one decider, one call of
   *  `shapeSchema`, which may warn). */
  let bootSchema: Record<string, unknown> | undefined;
  // Framework-parked slices (`__…` keys) this boot created — carried into
  // every persisted document alongside orphan cells, never into state.
  const parkedSlices: Record<string, unknown> = {};
  if (shouldPersist) {
    try {
      if (!asyncDb) {
        // Persistence needs the app db even without user tables/sync cells —
        // and this is the path the DEFAULT app takes, so it gets the same
        // integrity check as the one above (see `openAppDb`).
        const dbPath = dbPathOverride ?? appDirs(appId, cfg.appDir).stateDb;
        asyncDb = await openAppDb(dbPath);
        log.debug(`sqlite: opened for persistence at ${dbPath}`);
      }
      await asyncDb.execute(SKV_SCHEMA);
      // Before this build writes any store row (store-gen.ts): did a run
      // that journals nothing save the store since this build last did?
      storeSavedElsewhere = (await bootStoreGen(
        asyncDb,
        appId,
        persistKey,
        // Only the tables that MIRROR state: a SQL-only `db:` table is the
        // app's to write directly (`app.db`, `am sql`), and its writes are
        // not the store's saves.
        dbBindings.filter((b) => b.path.length > 0).map((b) => b.table),
        journalWatermarkKey(appId),
        !!cfg.journal && dbPathOverride !== ":memory:",
      )).foreign;
      await migrateLegacyKv(asyncDb, resolveKvPath(appId), log);
      kvDb = sqliteKv(asyncDb);
      log.debug(`persist: SQLite aio_kv mode=${persistMode}`);
      let migrated = await loadAndMigrateSnapshot(
        kvDb,
        appId,
        persistKey,
        persistMode,
        log,
      );
      if (migrated) storedKeysOnDisk = Object.keys(migrated);
      /** Slices of `persist: "none"` cells the live store still held. */
      let stale: string[] = [];
      if (migrated && cfg.persistingCellIds) {
        // `persist: "none"` means never written AND never read back. The
        // write half always held; this read did not — a blob an older build
        // (or a downgrade) wrote came straight back into a cell that asked to
        // keep nothing, and stayed there until the next write. The
        // standalone runtime closed the same hole (`restorableOnly`); the
        // server had none. Found by tests/hosts.test.ts.
        const kept = restorableSlices(
          migrated,
          cfg.persistingCellIds,
          initialState as Record<string, unknown>,
        );
        stale = Object.keys(migrated).filter((k) => !Object.hasOwn(kept, k));
        if (stale.length > 0) {
          await scrubStaleSlices(asyncDb, kvDb, persistKey, persistMode, stale)
            .then(() =>
              log.info(
                `persist: removed ${
                  count(stale.length, "stored slice")
                } of persist:"none" cell(s) ${stale.join(", ")} — left by an ` +
                  `older build; overwritten on disk, not just unlinked`,
              )
            )
            .catch((e) =>
              // Loud, never fatal: the slice is still not RESTORED, and the
              // first persist deletes the row the ordinary way.
              log.error(
                `persist: could not scrub the persist:"none" slice(s) ` +
                  `${stale.join(", ")} an older build left in the store — ` +
                  `they are not restored, and the next write drops them, but ` +
                  `their bytes may remain in the database file: ${e}`,
              )
            );
        }
        migrated = kept;
      }
      // The live file is only one copy: a snapshot or a backup taken under
      // an older build holds the same bytes. Checked on EVERY boot (each
      // copy once, until it changes) — not only when the live file was
      // stale, which a crash after the live scrub would never be again —
      // and not only when the store holds a snapshot: a crash before the
      // first save leaves none, and a backup taken then holds the journal.
      const none = [
        ...unstoredCells(
          initialState as Record<string, unknown>,
          cfg.persistingCellIds,
        ),
      ];
      if (
        cfg.persistingCellIds && none.length > 0 && openedDbPath &&
        openedDbPath !== ":memory:" &&
        !openedDbPath.startsWith("file::memory:")
      ) {
        await scrubStoreCopies(
          openedDbPath,
          appDirs(appId, cfg.appDir),
          persistKey,
          (stored) => {
            const keep = restorableSlices(
              stored,
              cfg.persistingCellIds!,
              initialState as Record<string, unknown>,
            );
            return Object.keys(stored).filter((k) => !Object.hasOwn(keep, k));
          },
          log,
          {
            kv: kvDb,
            key: scrubbedCopiesKey(appId),
            none,
            listened: cfg.listenedTypes,
            force: stale.length > 0,
          },
        ).catch((e) =>
          log.error(
            `persist: could not check the store's copies for the ` +
              `persist:"none" slice(s) an older build may have left in ` +
              `them — they may still hold those bytes: ${e}`,
          )
        );
      }
      // This boot's own store writes (a layout adopted, a legacy store
      // moved in, a stale slice scrubbed) are done: recorded now, so a boot
      // that fails after them never reads as a foreign save. A foreign save
      // found above stays flagged until the journal is dealt with.
      if (
        !storeSavedElsewhere && cfg.journal && dbPathOverride !== ":memory:"
      ) {
        await recordStoreGen(asyncDb, appId, journalWatermarkKey(appId));
      }
      if (migrated) {
        hadPersistedState = true;
        persistedSnapshot = migrated; // raw stored shape — for drift detection
        // The MUTABLE copy as the merge base, not the frozen declaration.
        // `deepMerge` hands a key that the store does not carry straight back
        // by reference, so merging from `initialState` would seed the runtime
        // state with frozen subtrees — and a new cell's slice (exactly the
        // shape a rename migration writes into) is precisely such a key.
        // `state` is that copy and nothing has written to it yet.
        state = deepMerge(
          state as Record<string, unknown>,
          migrated,
        ) as S;
        // Top-level keys the merge dropped as "removed from schema" are CELLS,
        // not fields — a renamed/undeclared cell's whole slice. They ride into
        // state here so onRestore can migrate them; section 5b then preserves
        // whatever remains (and strips it from runtime state). Field-level
        // schema-drop semantics inside declared cells are unchanged.
        for (const k of Object.keys(migrated)) {
          if (
            !Object.hasOwn(initialState as Record<string, unknown>, k) &&
            !k.startsWith("__")
          ) {
            (state as Record<string, unknown>)[k] = migrated[k];
          }
        }
        log.debug(
          `persist: loaded key="${persistKey}" (${persistMode})`,
        );
      } else {
        log.debug(`persist: no saved state, using initialState`);
      }
    } catch (e) {
      // RELEASE WHAT THIS BOOT OPENED, whatever the reason for leaving.
      //
      // `openAppDb` spawns the SQLite worker THREAD. A boot that got that far
      // and then refused — a corrupt file, a schema mismatch, a failed
      // migration — left the worker running, and a worker keeps the event loop
      // alive: measured, a `try { await aio.run(…) } catch {}` around a
      // corrupted `state.db` printed its refusal and then never exited. The
      // caller sees a clean error and a process that hangs forever, which is
      // the worst of both. A refusal is an exit path, so it releases like one.
      if (asyncDb) {
        await asyncDb.close().catch(() => {});
        asyncDb = null;
      }
      if (e instanceof AioError) throw e; // schema mismatch — already precise
      // A compiled binary that never embedded the SQLite worker fails here as
      // `Module not found: …/db-worker.ts`. The permissions advice below names
      // a cause that is NOT this one — it sends the reader to chmod the data
      // dir or turn persistence off, neither of which can fix a missing
      // module. Classified by the db module's own predicate (one decider).
      const workerHint = dbWorkerMissingHint(e);
      if (workerHint) throw new Error(workerHint, { cause: e });
      // The advice names the fixes that exist for the causes that reach here.
      // "Fix permissions or set persist: false" was attached to a malformed
      // or unreadable database as well — where neither is a fix, and the
      // second silently discards the data the reader is trying to keep.
      throw new Error(
        `persistence unavailable: ${e}\n` +
          `If the file is malformed or corrupt: boot with ` +
          `checkIntegrityOnBoot: true (quarantines it and restores from ` +
          `<db>.snapshot when one exists — docs/persistence/sqlite.md), or ` +
          `put a backup back with \`am restore <dir>\`. If it is a ` +
          `permissions error: make the data directory and the db file ` +
          `writable by this user. persist: false disables persistence ` +
          `entirely — it does not repair anything.`,
      );
    }
  }

  // ── 4b. State migration — check persisted versions vs current ────
  // ONLY when something was actually restored. On a fresh install there is no
  // old shape to migrate: running onMigrate against pristine initialState let
  // a hook rewrite defaults it was never meant to see (a v0→v1 rename turning
  // the app's own defaults into garbage on first launch). The first successful
  // persist stamps the current versions, so the next boot is a no-op anyway.
  // A cell whose `onPersist` SHAPES what it writes stores the SHAPE, not its
  // declared state (`onPersist: (s) => ({ key: s.thumbKey })` stores a `key`
  // the cell never declares; `({ items: Object.values(s.items) })` stores a
  // list where it declares a record). Its stored slice is read against what
  // this build's `onPersist` writes for the declared state — exactly as a
  // plain cell's is read against its declaration. Exempting "any path under a
  // top-level key the shape writes" instead hid every NESTED rename in the
  // commonest shape there is (`({ cache, ...rest }) => rest` writes every
  // key), and still refused a shape that changes a field's type.
  const shapedCells = new Set(cfg.cellPersistShaped ?? []);
  const shapeSchema = (): Record<string, unknown> => {
    const declared = initialState as Record<string, unknown>;
    const schema: Record<string, unknown> = { ...declared };
    for (const cell of shapedCells) {
      if (!Object.hasOwn(declared, cell)) continue;
      // The declared state first (its shape IS the schema); the restored
      // state when the hook cannot take the defaults (`s.list.at(-1).id`).
      const sources = [
        declared[cell],
        (state as Record<string, unknown>)[cell],
      ];
      let error: unknown;
      for (const src of sources) {
        try {
          const out = (kvGetDBState({ [cell]: src } as S) as
            | Record<string, unknown>
            | undefined)?.[cell];
          // As the store writes it: `undefined` keys are not stored.
          if (_isObj(out)) schema[cell] = JSON.parse(JSON.stringify(out));
          error = undefined;
          break;
        } catch (e) {
          error = e;
        }
      }
      // The persist path reports this same throw on its first write; here it
      // only means the slice is read against the declaration instead.
      if (error !== undefined) {
        log.warn(
          `persist: ${cell} onPersist threw while reading its shape — its ` +
            `stored slice is checked against the declared state: ${error}`,
        );
      }
    }
    return schema;
  };
  // Cells the migration pass handled this boot: their slice is the
  // migration's output, which a stored value must not overwrite.
  const migratedThisBoot = new Set<string>();
  /** A shaped cell's raw `onMigrate` output — in the STORED form when the
   *  migration kept it — handed to its `onRestore` in place of the stored
   *  slice the migration replaced. */
  const migratedRaw = new Map<string, Record<string, unknown>>();
  if (shouldPersist && kvDb && hadPersistedState && persistedSnapshot) {
    const VERSIONS_KEY = `${appId}:__versions`;
    const persistedVersions =
      await kvDb.get<Record<string, number>>(VERSIONS_KEY) ?? {};
    stampedVersions = persistedVersions;
    const stateObj = state as Record<string, unknown>;
    let report: MigrationReport = [];
    // A sync cell's shape ladder is the op-log replay's (`replaySyncOps`):
    // KV never stored its slice, so the slice here is the declared DEFAULTS —
    // running its onMigrate over those (and reporting "migrated") was a hook
    // call on data that never existed, before the replay ran the hook again
    // on the real data. One migration pass per cell, on its durable home.
    const kvMigrations = new Map(
      [...(cfg.cellMigrations ?? [])].filter(([c]) => !syncCellIds.includes(c)),
    );
    // Read ONCE, before a migration rewrites any slice: the shape is this
    // build's, and the drift walk below reads the stored slice against it.
    const schema = shapedCells.size
      ? shapeSchema()
      : initialState as Record<string, unknown>;
    bootSchema = schema;
    if (kvMigrations.size) {
      try {
        report = applyCellMigrations(
          stateObj,
          kvMigrations,
          persistedVersions,
          log,
          persistedSnapshot,
          initialState as Record<string, unknown>,
          shapedCells.size
            ? {
              schema: Object.fromEntries(
                [...shapedCells].filter((c) => Object.hasOwn(schema, c)).map((
                  c,
                ) => [c, schema[c]]),
              ),
              migratedRaw,
            }
            : undefined,
        );
      } catch (e) {
        // A failed migration refuses to boot (nothing is written, so the
        // stored data survives). It must reach `onError` too — the hook is
        // where an app pages a human; the console alone is not a channel.
        const err = e instanceof AioError
          ? e
          : createAioError("PERSIST_SCHEMA", e, {});
        // `getReportOpts` is late-bound by the orchestrator and may not be
        // wired this early in boot; the refusal must not be replaced by a
        // ReferenceError from the reporting path itself. Reporting is
        // best-effort, the throw is not.
        let opts: ReportErrorOpts = {};
        try {
          opts = getReportOpts();
        } catch { /* not wired yet — the throw below is still loud */ }
        reportAioError(err, opts);
        throw err;
      }
    }
    // A downgrade boot parks a VERBATIM copy of the stored slice before the
    // old build can write its narrower shape over it. Written once — a second
    // downgrade boot must never overwrite the park with already-narrowed data.
    for (const r of report) {
      if (r.outcome !== "downgrade") continue;
      const key = downgradeParkKey(r.cell);
      if (Object.hasOwn(persistedSnapshot, key)) continue;
      const slice = persistedSnapshot[r.cell];
      if (slice === undefined) continue;
      parkedSlices[key] = slice;
      log.warn(
        `persist: parked the pre-downgrade "${r.cell}" slice at "${key}" — ` +
          `it is carried into every future write, untouched, until you ` +
          `remove it.`,
      );
    }
    // Shape drift: the RAW stored snapshot vs the declared
    // `initialState`. Cells a migration already handled this boot are skipped;
    // the rest reveal a stored field the current shape no longer declares —
    // the silent stale-shape load a rename/removal without a version bump
    // leaves behind. Warned once (summarized), and kept for `am migrations`.
    // A shaped cell is read against its shape (see `shapeSchema`).
    const drift = detectShapeDrift(
      schema,
      persistedSnapshot,
      { skip: new Set(report.map((r) => r.cell)) },
    );
    if (drift.length > 0) {
      const summary = shapeDriftSummary(drift);
      // STRICT in dev (category b — dev stricter than prod): a persisted cell
      // whose on-disk shape drifted from its declared shape with no
      // `onMigrate` to account for it used to WARN forever, on every boot,
      // and every boot loaded the stale shape. Dev refuses to boot, naming
      // the cell, the drifted keys and the two fixes; prod keeps the warning
      // — refusing to serve a working app over a stale key is the worse
      // outcome there. Seed erasure and undeclared cells keep their own
      // remedies (warn), so only STRUCTURAL drift of a declared cell refuses.
      const allStructural = drift.filter((d) =>
        d.issue === "unknown-field" || d.issue === "type-changed"
      );
      // …but only drift a DECLARATION CHANGE left behind. A cell stamped with
      // this build's shape fingerprint was written under this very `state:`,
      // so its drift is what the app's own methods committed (`s.count +=
      // "abc"` from `am dispatch counter:increment abc`). Refusing there
      // bricked the app on state it accepted and persisted itself, and offered
      // only a migration for a schema that never moved, or deleting the data.
      // That drift degrades exactly like production — said by name below. An
      // unstamped cell (a store from before the stamp) keeps the refusal.
      const storedShapes = allStructural.length
        ? await readStoredShapes(kvDb, appId, log)
        : {};
      const selfWritten = allStructural.filter((d) =>
        Object.hasOwn(schema, d.cell) &&
        storedShapes[d.cell] === shapeFingerprint(schema[d.cell])
      );
      const structural = allStructural.filter((d) => !selfWritten.includes(d));
      if (selfWritten.length > 0) log.warn(selfWrittenDrift(selfWritten));
      if (isDevBoot() && structural.length > 0) {
        const dirs = appDirs(appId, cfg.appDir);
        const appsDir = appsDirEnv();
        const refusal = shapeDriftRefusal(structural, summary, {
          dataDir: dirs.data,
          dbPath: openedDbPath ?? dirs.stateDb,
          appsDir: appsDir && dirs.home === join(appsDir, appId)
            ? appsDir
            : undefined,
        });
        // The database is released by `bootStorage` (every refusal's one
        // exit), so the removal this message advises can succeed.
        throw new Error(refusal);
      }
      log.warn(summary);
    }
    // …and the SAFE direction, said out loud. Adding a field needs no
    // migration, but silence about it is indistinguishable from silence about
    // a problem nobody looked for — the complaint that produced this line.
    // A `db:`-bound path is omitted from the KV snapshot by design (SQLite
    // owns those rows — `kvGetDBState` above), so its absence from the stored
    // data is not news: without this, every restart of every app with a
    // `db:` binding said the table "is new, or a method deleted it".
    const added = detectNewFields(
      boundPaths.length ? omitPaths(schema, boundPaths) : schema,
      persistedSnapshot,
      {
        skip: new Set(report.map((r) => r.cell)),
        // A shaped cell's schema is already what its `onPersist` writes.
        persist: Object.fromEntries(
          Object.entries(cfg.cellPersist ?? {}).filter(([c]) =>
            !shapedCells.has(c)
          ),
        ),
      },
    );
    if (added.length > 0) log.info(newFieldsSummary(added));
    const declared: Record<string, number> = {};
    for (const [id, info] of cfg.cellMigrations ?? []) {
      declared[id] = info.version;
    }
    migrations = { declared, stored: persistedVersions, report, drift };
    // Only a slice an `onMigrate` (or a downgrade's widening) rewrote — a
    // first stamp or a hookless bump keeps the store's slice as it was.
    for (const r of report) {
      if (r.outcome === "migrated" || r.outcome === "downgrade") {
        migratedThisBoot.add(r.cell);
      }
    }
  }

  // ── 5. onRestore hooks ────────────────────────────────────────────
  //
  // Per-cell FIRST, each on its own slice: a repair belongs beside the state
  // it repairs, and the app-level hook then sees the repaired world. Without
  // the per-cell form, "this field does not survive a restart" (an undo
  // closure, a live handle, a socket) had to be fixed from the app entry's
  // `onStart` — in another file, away from the cell that owns it.
  //
  // Error-guarded like every lifecycle hook: a repair that throws is reported
  // and that cell keeps its restored slice. Losing the app because a cosmetic
  // repair failed would be the worse trade.
  // ONLY when something was actually restored — the same rule migration
  // follows, for the same reason: on a fresh install there is nothing to
  // repair, and a hook run against pristine defaults can only damage them
  // (a v0→v1 rename once turned an app's own defaults into garbage on first
  // launch, which is why `onMigrate` gained this guard).
  if (cellRestores?.size && hadPersistedState) {
    const s = state as Record<string, unknown>;
    for (const [id, hook] of cellRestores) {
      const slice = s[id];
      if (slice === undefined) continue;
      s[id] = runCellRestore(
        id,
        hook,
        slice as Record<string, unknown>,
        shapedCells.has(id)
          ? migratedRaw.has(id)
            // The migration's output IS this boot's stored slice.
            ? {
              stored: migratedRaw.get(id),
              declared: (initialState as Record<string, unknown>)[id],
              retyped: true,
            }
            : {
              stored: persistedSnapshot?.[id],
              declared: (initialState as Record<string, unknown>)[id],
              retyped: !migratedThisBoot.has(id),
            }
          : undefined,
        log,
      );
    }
  }
  if (onRestore) {
    try {
      // MUTATE OR REPLACE — the rule every other restore hook already follows:
      // `runCellRestore` keeps the slice it handed over when the hook returns
      // nothing, and so does the re-run journal replay does after a crash
      // (`_rerunRestoreHooks`). This one did `state = onRestore(state)`, so a
      // hook written the natural way — `(s) => { s.cell.online = false }` —
      // set the whole app state to `undefined` and boot died with
      // `TypeError: Cannot convert undefined or null to object`, on EVERY
      // boot including a fresh install, naming neither the hook nor the app.
      const next = onRestore(state) as unknown;
      refuseThenable(next);
      if (next !== undefined && next !== state) {
        if (next === null || typeof next !== "object") {
          // Not state and not a mutation: through the hook's own error guard,
          // named — the app keeps the state it restored.
          throw new Error(
            `returned ${
              next === null ? "null" : typeof next
            } — return the state, or mutate it and return nothing`,
          );
        }
        state = next as S;
      }
    } catch (e) {
      log.error(`hook onRestore: ${e}`);
    }
  }

  // ── 5b. Stored-but-undeclared cells: preserved, never dropped ─────
  // A cell rename/split used to destroy the old cell's data silently: the
  // slice was restored into state, no declared cell owned it, and the first
  // persist rewrote the document without it (a field report — a
  // leaderboard recovered from SQLite free pages). Now: the slice is carried
  // into every future persisted document verbatim, stripped from RUNTIME
  // state (no cell owns it — it must not broadcast), and announced at every
  // boot until the app migrates or re-declares it. onRestore runs FIRST, so a
  // rename migration is one hook: read `state.oldCell`, move what you need,
  // and `delete state.oldCell` — a deliberate delete there CONSUMES the slice
  // (its row is removed on the next flush).
  const orphanCells: Record<string, unknown> = { ...parkedSlices };
  if (persistedSnapshot) {
    const declared = new Set(
      Object.keys(initialState as Record<string, unknown>),
    );
    const s = state as Record<string, unknown>;
    for (const k of Object.keys(persistedSnapshot)) {
      // `__…` keys are framework-parked data (a pre-downgrade slice). They
      // never enter runtime state, and they must survive every future write —
      // single mode rewrites the whole document, so "not carried" means
      // "deleted".
      if (k.startsWith("__")) {
        orphanCells[k] = persistedSnapshot[k];
        continue;
      }
      if (declared.has(k)) continue;
      // OWN keys: `k in s` is true for every Object.prototype name, so an
      // undeclared stored cell named `toString` would park the native
      // function and warn about "preserving" it. See scripts/check-proto-in.ts.
      if (Object.hasOwn(s, k)) {
        orphanCells[k] = s[k];
        delete s[k];
        log.warn(
          `persist: stored cell "${k}" is not declared by this build — its ` +
            `data is PRESERVED in the store, untouched. Migrate it in ` +
            `onRestore (read state.${k}, move what you need, delete the key ` +
            `to consume it), re-declare the cell to get it back as-is, or — ` +
            `dev debris — drop it from the store: am persist --drop=${k}`,
        );
      } else {
        log.info(
          `persist: stored cell "${k}" was consumed by onRestore — its row ` +
            `will be removed on the next persist`,
        );
      }
    }
  }

  // ── 6. Checkpoint restore ─────────────────────────────────────────
  if (diagHooks?.getRecoveredState() && onCheckpointRestore) {
    try {
      const raw = diagHooks.getRecoveredState()!;
      // The hook is about to get this state — THE point where an old
      // snapshot is worth a WARN (with no hook nothing applies it: INFO only,
      // in diagnostics/mod.ts).
      const stale = staleCheckpointWarning(raw.ts);
      if (stale) log.warn(stale);
      // …and what comes BACK is the restore half of the same rule: a
      // checkpoint an older build wrote raw still holds `persist: "none"`
      // slices, and the app's hook would hand them straight back.
      //
      // Field filters too: a field `persist` keeps off disk comes back as a
      // RESTART brings it back — the value the store restore (+ `onRestore`)
      // just left in `state` — never the checkpoint's copy (an older build
      // wrote it raw, secrets included).
      const recovered = cfg.persistingCellIds
        ? {
          ...raw,
          state: fieldsAsRestart(
            restorableSlices(
              raw.state,
              cfg.persistingCellIds,
              initialState as Record<string, unknown>,
            ),
            cfg.cellPersist,
            state as Record<string, unknown>,
          ),
        }
        : raw;
      const restored = onCheckpointRestore(recovered);
      if (restored) {
        Object.assign(state as Record<string, unknown>, restored);
        log.info("checkpoint: state restored from checkpoint");
      }
    } catch (e) {
      log.error(`checkpoint: onCheckpointRestore threw — ${e}`);
    }
  }

  // Wire diagnostics health getter (state is now in scope)
  if (diagHooks && healthGetter) {
    diagHooks.setHealthGetter(() => healthGetter(getState()));
  }

  // ── 7. Load SQLite table data ─────────────────────────────────────
  // Rows land at the bound state path (a cell's array field), never as a
  // top-level key nothing owns.
  // Only the BOUND tables are read: an SQL-only table has no state home, so
  // reading it whole at boot was O(rows) of wasted I/O per start.
  let loadedTables: Record<string, unknown[]> | undefined;
  if (asyncDb && syncKeys.length > 0) {
    const loaded = await loadTables(asyncDb, syncSchema);
    loadedTables = loaded;
    state = placeLoadedTables(
      state as Record<string, unknown>,
      dbBindings,
      loaded,
      (m) => log.warn(m),
      await readSyncedTables(asyncDb),
    ) as S;
  }

  log.debug(
    `state: ${Object.keys(state as Record<string, unknown>).length} keys`,
  );

  // ── 8. Persistence manager ────────────────────────────────────────
  // Cell versions for persistence — EVERY cell that declares one, not only the
  // ones that also declare a migration. `_cellVersions` (built by the cells
  // bridge from each cell's `version`) was computed on every boot and read
  // nowhere, while this line derived a second, smaller map from
  // `cellMigrations`: a cell with `version: 3` and no `onMigrate` was stamped
  // by neither, so a later downgrade to a build that writes v2 had nothing on
  // disk to notice it. One source now, the complete one.
  const cellVersions: Record<string, number> | undefined = (() => {
    const v: Record<string, number> = { ...(cfg._cellVersions ?? {}) };
    for (const [id, info] of cfg.cellMigrations ?? []) v[id] = info.version;
    return Object.keys(v).length > 0 ? v : undefined;
  })();

  // Durable journal — opt-in, and only where there's a real file to
  // recover from (persisting, not :memory:). The persistence manager advances
  // its watermark after each committed snapshot; _run appends + replays.
  //
  // The watermark it resumes from is a ROW in the same SQLite file, written
  // inside the snapshot transaction (see `journalWatermarkKey`) — never the
  // post-commit side-file write it used to be, which replayed already-applied
  // actions after a kill in that window. Only when the store can plan its
  // statements; otherwise the legacy `.wm` file, which now fails loudly.
  const journalOn = !!cfg.journal && shouldPersist &&
    dbPathOverride !== ":memory:";
  // …and if it was ASKED FOR and is off anyway, say so HERE, where the three
  // inputs meet. `configConflicts` (server/config.ts) catches the config-only
  // spellings at validate time, but `shouldPersist` also folds in
  // `--no-persist` and `dbPathOverride` also folds in `--db-path=:memory:` —
  // and a CLI flag that silently disarms crash recovery is exactly the case
  // that costs data: the app boots, reports nothing, and the SIGKILL/power-cut
  // replay the author opted into is simply absent when it is needed.
  // Boot-fatal, like every other "your durability guarantee is not in force".
  if (cfg.journal && !journalOn) {
    const why = !shouldPersist
      ? "persistence is off (--no-persist, or persist: false)"
      : 'the database is ":memory:" (--db-path=:memory:, or dbPath)';
    throw teachableError(
      `journal: true asks for durable SIGKILL/power-cut recovery, but ${why}, ` +
        `so there is no file to replay from and the journal is not running`,
      !shouldPersist
        ? "drop journal: true for this run, or let persistence stay on"
        : "drop journal: true for in-memory runs, or point the database at a " +
          "real file",
      "docs/persistence/auto-persist.md",
    );
  }
  const journalWmStored = journalOn && !!asyncDb && !!kvDb?.planSet;
  const storedWatermark = journalWmStored
    ? await kvDb!.get<number>(journalWatermarkKey(appId)) ?? 0
    : undefined;
  const journal: Journal | null = journalOn
    ? createJournal(
      dbPathOverride
        ? dbPathOverride + ".journal"
        : appDirs(appId, cfg.appDir).journal,
      {
        redact: makeRedactor(cfg.redactActions),
        // A `persist: "none"` cell's calls are written with their arguments
        // withheld — for such a cell they ARE its state (JournalEntry.unstored).
        unstored: unstoredCells(
          initialState as Record<string, unknown>,
          cfg.persistingCellIds,
        ),
        ...(storedWatermark !== undefined ? { storedWatermark } : {}),
      },
    )
    : null;
  // Journal lines of cells this build does not declare: HELD by the watermark
  // the store's copy of each stands at, not replayed and not compacted, until
  // a build declares the cell again (see `journalHeldCellsKey`) — as its
  // stored slice is preserved (5b above). A re-declared cell is tracked by
  // its held mark for this one boot, so replay takes its lines onto the
  // preserved slice; the entry goes in the save that holds them.
  const journalHeld = new Set<string>();
  let heldRelease: string[] = [];
  /** The held map a save must write to drop the released entries. */
  let heldAfterRelease: Record<string, number> = {};
  /** The seq whose save carried the release — see `planPersisted`. */
  let heldReleasePlannedAt: number | undefined;
  if (journal && journalWmStored) {
    const declaredCells = initialState as Record<string, unknown>;
    const stored = await kvDb!.get<Record<string, number>>(
      journalHeldCellsKey(appId),
    ) ?? {};
    const held: Record<string, number> = { ...stored };
    for (const e of journal.readTail()) {
      if (e.unstored === true || e.type === TT_RESTORE_TYPE) continue;
      const i = e.type.indexOf(":");
      const cells = e.only?.length ? e.only : i > 0 ? [e.type.slice(0, i)] : [];
      for (const c of cells) {
        if (!Object.hasOwn(declaredCells, c) && !Object.hasOwn(held, c)) {
          held[c] = journal.watermark();
        }
      }
    }
    if (Object.keys(held).length > 0) {
      if (Object.keys(held).some((c) => stored[c] !== held[c])) {
        // Before the first save compacts anything this boot.
        await kvDb!.set(journalHeldCellsKey(appId), held);
      }
      journal.trackCells(held);
      heldRelease = Object.keys(held).filter((c) =>
        Object.hasOwn(declaredCells, c)
      );
      for (const c of Object.keys(held)) {
        if (!Object.hasOwn(declaredCells, c)) journalHeld.add(c);
      }
      heldAfterRelease = Object.fromEntries(
        Object.entries(held).filter(([c]) => !heldRelease.includes(c)),
      );
    }
  }
  const strayJournal = !journalOn && dbPathOverride !== ":memory:" &&
      (shouldPersist || asyncDb !== null)
    ? await openStrayJournal(
      dbPathOverride
        ? dbPathOverride + ".journal"
        : appDirs(appId, cfg.appDir).journal,
      appId,
      asyncDb && kvDb?.planSet ? kvDb : null,
      syncCellIds,
    )
    : null;

  // Said once per `cell.path`, whichever of the two write-time checks gets
  // there first (the guard names the method; the watcher sees every write).
  const _shapeSaid = new Set<string>();
  const _guardSkip = new Set([
    ...syncCellIds,
    ...(migrations?.report ?? []).map((r) => r.cell),
  ]);
  // A harness guards as the app it stands in for does: a dev app persists.
  const guarded = shouldPersist || cfg.harnessShapeGuard === true;
  const strictTypeFilter = guarded && isDevBoot()
    ? (cell: string): CellFieldFilter | undefined =>
      _guardSkip.has(cell) || shapedCells.has(cell)
        ? undefined
        : cfg.cellPersist?.[cell] ?? "all"
    : undefined;
  const writeGuard = guarded
    ? createDeclaredShapeGuard({
      template: initialState as Record<string, unknown>,
      persist: cfg.cellPersist,
      skip: _guardSkip,
      // The boot restore's own rules, at the write: an unknown key is said;
      // a type change is refused in dev, said in prod (category b).
      ...shapeDriftDeciders,
      shaped: shapedCells,
      strict: isDevBoot(),
      said: _shapeSaid,
      warn: (msg) => log.warn(msg),
    })
    : undefined;

  const persistence = createPersistenceManager({
    kvDb,
    asyncDb,
    // `:memory:` is SQLite's sentinel for "no file", never a path.
    ...(openedDbPath !== undefined && !openedDbPath.startsWith(":memory:") &&
        !openedDbPath.startsWith("file::memory:")
      ? { dbFile: resolve(openedDbPath) }
      : {}),
    // The BOUND schema (see `syncSchema`) — the same decider that feeds
    // `getTableState` below, so the planner never meets a table the view
    // omits.
    dbSchema: syncKeys.length > 0 ? syncSchema : undefined,
    // The diff input for `db:` tables: each bound state array, keyed by its
    // SQL table name. SQL-only tables are absent — nothing in state mirrors
    // them, so nothing may overwrite their rows.
    getTableState: (s: Record<string, unknown>) => {
      const view: Record<string, unknown> = {};
      for (const b of dbBindings) {
        if (b.path.length > 0) view[b.table] = readPath(s, b.path);
      }
      return view;
    },
    // Patch → row translation for the incremental diff (see persistence.ts).
    tableBindings: dbBindings,
    // The diff baseline is what SQLite HOLDS, not what state shows: an
    // adopted seed (empty table, non-empty array) must be written, not
    // assumed already there.
    ...(loadedTables ? { dbBaselineOverride: loadedTables } : {}),
    persistKey,
    persistMode,
    persistMs: persistDebounceMs,
    budgets: cfg.budgets,
    getState,
    // Dev (observe-only): say at WRITE time what the next boot will not
    // restore — see `restoreDropWatcher`.
    getDBState: isDevBoot()
      ? withRestoreDropWatch(
        kvGetDBState as (s: Record<string, unknown>) => unknown,
        restoreDropWatcher(
          initialState as Record<string, unknown>,
          new Set((migrations?.report ?? []).map((r) => r.cell)),
          (msg) => log.warn(msg),
          _shapeSaid,
        ),
        (msg) => log.warn(msg),
      )
      : kvGetDBState as (s: Record<string, unknown>) => unknown,
    log,
    getReportOpts,
    syncCells: syncCellIds.length > 0 ? new Set(syncCellIds) : undefined,
    cellVersions,
    // What this build's declaration looks like, per cell — stamped beside
    // every written slice so the next boot can tell drift the app wrote from
    // drift a declaration change left (see the drift check above).
    cellShapes: Object.fromEntries(
      Object.entries(
        bootSchema ??
          (shapedCells.size
            ? shapeSchema()
            : initialState as Record<string, unknown>),
      ).map(([c, decl]) => [c, shapeFingerprint(decl)]),
    ),
    appId,
    getJournalSeq: journal ? () => journal.capture() : undefined,
    onPersisted: journal
      ? (seq) => {
        // The save that held the re-declared cells' replay committed their
        // release with it: from here they go by the app-wide watermark.
        if (heldReleasePlannedAt === seq) {
          journal.releaseCells(heldRelease);
          heldRelease = [];
          heldReleasePlannedAt = undefined;
        }
        journal.setWatermark(seq);
      }
      : undefined,
    ...(journal && journalWmStored
      ? {
        planPersisted: (seq: number) => {
          const wm = kvDb!.planSet!(journalWatermarkKey(appId), seq);
          if (heldRelease.length === 0) return wm;
          heldReleasePlannedAt = seq;
          return [
            ...wm,
            ...kvDb!.planSet!(journalHeldCellsKey(appId), heldAfterRelease),
          ];
        },
        // Every journalled save ends by making the store its own again
        // (store-gen.ts).
        planSaveAfter: () =>
          planStoreGenRecord(appId, journalWatermarkKey(appId)),
      }
      : {}),
    ...(Object.keys(orphanCells).length ? { orphanCells } : {}),
    ...(persistedSnapshot
      ? {
        storedKeys: (storedKeysOnDisk ?? Object.keys(persistedSnapshot))
          .filter((k) => !k.startsWith("__")),
      }
      : {}),
  });

  // The replay context for this db — `replaySyncOps` (called by the
  // orchestrator with the db alone) finds its cell metadata here.
  if (asyncDb && syncCellIds.length > 0) {
    registerSyncReplayContext(asyncDb, {
      versions: Object.fromEntries(
        syncCellIds.map((c) => [c, declaredVersion(c)]),
      ),
      migrations: cfg.cellMigrations ?? new Map(),
      stampedVersions,
      quarantined: syncQuarantined,
      dev: isDevBoot(),
      report: migrations?.report,
      initialState: initialState as Record<string, unknown>,
      ...(openedDbPath !== undefined ? { dbPath: openedDbPath } : {}),
    });
  }

  return {
    state,
    kvDb,
    asyncDb,
    persistence,
    journal,
    migrations,
    syncHandler,
    syncBroadcastRef,
    syncDispatchRef,
    ...(writeGuard ? { writeGuard } : {}),
    ...(strictTypeFilter ? { strictTypeFilter } : {}),
    storeHeldState: hadPersistedState,
    strayJournal,
    storeSavedElsewhere,
    journalHeld,
  };
}
