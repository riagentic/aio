// Boot sequence — KV, SQLite, persistence, sync, and state restoration
// Extracted from aio.ts _run() to keep the orchestrator lean.

import {
  createPersistenceManager,
  type PersistenceManager,
} from "./persistence.ts";
import { createJournal, type Journal } from "./journal.ts";
import type { SkvInstance } from "./skv.ts";
import { migrateLegacyKv, SKV_SCHEMA, sqliteKv } from "./skv-sqlite.ts";
import { createDB, type DB, initSchema, loadTables } from "../db/mod.ts";
import type { TableDef } from "./sql.ts";
import { deepMerge } from "../state/deep-merge.ts";
import { resolveKvPath } from "./paths.ts";
import { resolve } from "@std/path";
import { appDirs } from "./app-dirs.ts";
import { AioError, type ReportErrorOpts } from "../diagnostics/error.ts";
import { makeRedactor } from "../diagnostics/redact.ts";
import { migrateSchema, PERSIST_SCHEMA_VERSION } from "./persist-schema.ts";
import type { Log } from "../diagnostics/logger.ts";
import type { CheckpointData, DiagnosticsHooks } from "../diagnostics/mod.ts";
import type { ServerSyncHandler } from "../sync/server-handler.ts";
import {
  getLowWater,
  loadOpsSince,
  loadSnapshot,
  seedSyncSnapshot,
} from "../sync/server-store.ts";

/** B1/AIO-416: replay each sync cell's committed op-log into state at boot.
 *  `sync: true` cells are excluded from KV, and their op-log was only ever
 *  replayed when a CLIENT connected — so a server restart with no client online
 *  came back with EMPTY sync cells (silent data loss; the TBD non-admin-login
 *  bug). This folds every committed op back through the composed reducer — the
 *  same path a live op takes — after KV restore + onRestore and before the first
 *  dispatch/broadcast. Pure fold: no broadcast, no effects, no server needed.
 *  Loud by design (logs a per-cell count) so the restore is never invisible. */
export async function replaySyncOps<S>(
  db: DB,
  syncCellIds: string[],
  reduce: (state: S, action: { type: string; payload?: unknown }) => S,
  state: S,
  log: Pick<Log, "info" | "error">,
): Promise<S> {
  let next = state;
  for (const cell of syncCellIds) {
    let ops;
    try {
      ops = await loadOpsSince(db, cell, null, null); // null cursor → all ops, dispatch (server_ts) order
    } catch (e) {
      log.error(`sync: op-log replay failed for cell "${cell}" — ${e}`);
      continue;
    }

    // Seed from the compaction snapshot FIRST. Compaction folds ops into
    // sync_snapshots and deletes them, so the surviving log is only the tail —
    // replaying it alone restored the cell to its initialState and then
    // broadcast that emptiness to clients as authoritative (silent data loss
    // on the first restart after 1000 ops).
    let seeded = false;
    try {
      const snap = await loadSnapshot(db, cell);
      if (snap) {
        (next as Record<string, unknown>)[cell] = snap.state;
        seeded = true;
        log.info(`sync: seeded cell "${cell}" from compaction snapshot`);
      } else if (await getLowWater(db, cell)) {
        // Compacted, but the snapshot is gone/unreadable: the pre-compaction
        // history is unrecoverable. Never pretend this is a clean start.
        log.error(
          `sync: cell "${cell}" was compacted but has no readable snapshot — ` +
            `state before the last compaction cannot be restored`,
        );
      } else if (ops.length === 0) {
        // The sync store has never seen this cell — it was JUST adopted
        // (localFirst flip or a new `sync: true`) and whatever state the KV
        // restore produced is about to lose its only durable home: sync cells
        // are excluded from KV on the next persist, so a later restart would
        // resurrect the cell as initialState and the pre-flip data would
        // exist nowhere. Make today's state the durable base first.
        const restored = (next as Record<string, unknown>)[cell];
        if (restored !== undefined) {
          try {
            await seedSyncSnapshot(db, cell, restored);
            log.info(
              `sync: cell "${cell}" newly adopted — seeded its sync snapshot ` +
                `from the restored state (KV stops persisting sync cells)`,
            );
          } catch (e) {
            log.error(`sync: seeding snapshot for "${cell}" failed — ${e}`);
          }
        }
      }
    } catch (e) {
      log.error(`sync: snapshot restore failed for cell "${cell}" — ${e}`);
    }

    if (ops.length === 0) {
      if (seeded) log.info(`sync: restored cell "${cell}" from snapshot only`);
      continue;
    }
    let applied = 0;
    for (const op of ops) {
      try {
        next = reduce(next, {
          type: `${op.cell}:${op.action}`,
          payload: op.payload,
        });
        applied++;
      } catch (e) {
        log.error(
          `sync: replay of op ${op.id} (${op.cell}:${op.action}) failed — ${e}`,
        );
      }
    }
    log.info(`sync: restored cell "${cell}" from ${applied} op(s)`);
  }
  return next;
}

/** Per-cell migration metadata — version + optional onMigrate hook */
export interface CellMigrationInfo {
  version: number;
  initialState: Record<string, unknown>;
  onMigrate?: (
    state: Record<string, unknown>,
    fromVersion: number,
  ) => Record<string, unknown>;
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

  /** Override the SQLite file (":memory:" for hermetic tests). Default:
   *  `~/.<appId>/data/state.db` (see app-dirs.ts) unless overridden. */
  dbPath?: string;
  /** Override the PRAGMAs the app db opens with (default: DEFAULT_PRAGMAS,
   *  WAL + synchronous=NORMAL). An app whose data is expensive to lose — a
   *  wallet, a ledger — wants `synchronous = FULL`; a cache does not. */
  dbPragmas?: string[];
  /** Action types whose payload the journal must NOT record — forwarded from
   *  the app config (a passphrase argument must not land in a recovery file). */
  redactActions?: readonly string[];
  initialState: S;
  shouldPersist: boolean;
  persistKey: string;
  persistMode: "single" | "multi";
  persistDebounceMs: number;
  dbSchema: Record<string, TableDef> | undefined;
  syncCellIds: string[];
  /** Per-cell declarative access rules — enforced on the sync-op path (AUTH-1
   *  parity with the action-dispatch gate in aio-server.ts). */
  cellAccess?: Map<string, import("../state/cell-types.ts").CellAccess>;
  /** Per-cell version + migration hooks — keyed by cell id */
  cellMigrations?: Map<string, CellMigrationInfo>;
  /** User hook — transform state after restore */
  onRestore?: (state: S) => S;
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
  /** Late-bound reportOpts getter for persistence manager */
  getReportOpts: () => ReportErrorOpts;
  /** Opt-in durable action journal (risoto #3) — SIGKILL/power-cut recovery of
   *  the debounce-window tail. bootStorage creates it, the persistence manager
   *  advances its watermark, _run appends + replays. Undefined/false ⇒ off. */
  journal?: boolean;
  log: Log;
}

/** Everything the boot sequence produces */
export interface BootResult<S> {
  state: S;
  kvDb: SkvInstance | null;
  asyncDb: DB | null;
  persistence: PersistenceManager;
  /** Durable action journal (risoto #3) — null unless `journal: true`. */
  journal: Journal | null;
  /** Boot migration + shape-drift picture (risoto #1) — undefined when nothing
   *  was restored. Surfaced live via `am migrations`. */
  migrations: MigrationSummary | undefined;
  syncHandler: ServerSyncHandler | undefined;
  /** Mutable ref — caller wires broadcast after server creation */
  syncBroadcastRef: { fn: (msg: string, exclude?: WebSocket) => void };
  syncDispatchRef: { fn: (a: { type: string; payload?: unknown }) => void };
}

/** Runs the full storage boot sequence — SQLite, CRDT sync, KV restore,
 *  onRestore hook, checkpoint restore, SQLite table load, persistence manager. */
export async function bootStorage<S>(
  cfg: BootConfig<S>,
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
    onCheckpointRestore,
    diagHooks,
    healthGetter,
    getDBState,
    getState,
    getReportOpts,
    log,
  } = cfg;

  let state = initialState;

  // Two homes are a trap, and a silent one. `dbPath` moves ONLY the database:
  // `auth.db`, `tls/`, `meta.json`, the journal and any previously-written
  // `state.db` stay under the app home — so an app that resolves its own data
  // root ends up with its files split across two places, one of which it is no
  // longer looking at. Risoto found a complete, stale, unguarded wallet
  // database that way (2026-07-28). `appDir` is the knob that moves everything;
  // say so once, at the moment the split is created.
  if (dbPathOverride && dbPathOverride !== ":memory:" && !cfg.appDir) {
    const home = appDirs(appId, cfg.appDir).home;
    if (!resolve(dbPathOverride).startsWith(resolve(home) + "/")) {
      log.warn(
        `dbPath puts the database at ${dbPathOverride}, but everything else ` +
          `(auth.db, tls/, meta.json, the journal) stays under ${home} — two ` +
          `homes, and files already written to the old one are still there. ` +
          `Pass appDir to move the whole app directory instead.`,
      );
    }
  }

  // ── 1. SQLite ─────────────────────────────────────────────────────
  const dbKeys = dbSchema ? Object.keys(dbSchema) : [];

  // AIO-419 (risoto): a `db:` table named after a cell's OBJECT slice silently
  // overwrites that slice with a raw row array at boot (loadTables does
  // `state[name] = rows`), so the cell's methods explode — `s.nfts.filter(…)`
  // when `s` is now the array. A table mapping to an ARRAY slice is the intended
  // auto-sync store and stays allowed. Fail loud at boot, naming both, instead of
  // leaving this trap to a code comment.
  if (dbSchema) {
    const init = initialState as Record<string, unknown>;
    for (const name of dbKeys) {
      const slice = init[name];
      if (
        name in init && slice !== null && typeof slice === "object" &&
        !Array.isArray(slice)
      ) {
        throw new Error(
          `[aio] db: table "${name}" collides with cell "${name}" — the table's ` +
            `rows would overwrite the cell's state slice at boot and break its ` +
            `methods. Rename the table (e.g. "${name}_rows"), or make the cell's ` +
            `"${name}" slice an array to use it as that table's auto-synced store.`,
        );
      }
    }
  }

  let asyncDb: DB | null = null;
  // Sync cells need the SQLite op-log even without user tables — a
  // `sync: true` cell must never silently degrade because `db:` is absent.
  if ((dbSchema && Object.keys(dbSchema).length) || syncCellIds.length > 0) {
    try {
      const dbPath = dbPathOverride ?? appDirs(appId, cfg.appDir).stateDb;
      asyncDb = createDB(dbPath, dbPragmas ? { pragmas: dbPragmas } : {});
      if (dbSchema && Object.keys(dbSchema).length) {
        await initSchema(asyncDb, dbSchema);
      }
      log.info(`sqlite: ${dbKeys.length} table(s) at ${dbPath}`);
    } catch (e) {
      log.warn(`sqlite: unavailable — ${e}`);
      if (asyncDb) {
        await asyncDb.close().catch(() => {});
        asyncDb = null;
      }
    }
  }

  // ── 2. CRDT sync tables ───────────────────────────────────────────
  const syncBroadcastRef: { fn: (msg: string, exclude?: WebSocket) => void } = {
    fn: () => {},
  };
  // Late-bound like syncBroadcastRef — dispatch doesn't exist yet at boot.
  const syncDispatchRef: {
    fn: (a: { type: string; payload?: unknown }) => void;
  } = { fn: () => {} };
  let syncHandler: ServerSyncHandler | undefined;

  if (syncCellIds.length > 0) {
    if (asyncDb) {
      const { SYNC_SCHEMA } = await import("../sync/compact.ts");
      for (const sql of SYNC_SCHEMA) {
        await asyncDb.execute(sql);
      }
      const { createServerSyncHandler } = await import(
        "../sync/server-handler.ts"
      );
      // AUTH-1 parity: build the sync-path access checker from the same
      // per-cell rules the action path uses. A cell with no rule → open.
      const { cellAccessAllowed } = await import("./server-auth.ts");
      const cellAccess = cfg.cellAccess;
      const accessCheck = cellAccess && cellAccess.size > 0
        ? (cell: string, user: unknown) => {
          const rule = cellAccess.get(cell);
          return rule === undefined ||
            cellAccessAllowed(
              rule,
              user as import("./aio-types.ts").AioUser | undefined,
              "sync",
            );
        }
        : undefined;
      syncHandler = createServerSyncHandler({
        dispatch: (a) => syncDispatchRef.fn(a),
        db: asyncDb,
        syncCellIds,
        accessCheck,
        getCellState: (cell: string) =>
          (getState() as Record<string, Record<string, unknown>>)[cell] ?? {},
        broadcastRaw: syncBroadcastRef,
        log,
      });
      log.info(`sync: ${syncCellIds.length} cell(s) with CRDT tables`);
    } else {
      log.warn(
        `sync: ${syncCellIds.length} cell(s) have sync: true but no SQLite DB — CRDT disabled`,
      );
    }
  }

  // ── 3. KV state filter (strip db-managed keys) ───────────────────
  const kvGetDBState = dbKeys.length
    ? (s: S) => {
      const full = getDBState(s);
      if (!full || typeof full !== "object" || Array.isArray(full)) return full;
      const filtered: Record<string, unknown> = {};
      for (const k of Object.keys(full as Record<string, unknown>)) {
        if (!dbKeys.includes(k)) {
          filtered[k] = (full as Record<string, unknown>)[k];
        }
      }
      return filtered;
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
  // Migration + shape-drift summary, surfaced live via `am migrations`.
  let migrations: MigrationSummary | undefined;
  if (shouldPersist) {
    try {
      if (!asyncDb) {
        // Persistence needs the app db even without user tables/sync cells.
        const dbPath = dbPathOverride ?? appDirs(appId, cfg.appDir).stateDb;
        asyncDb = createDB(dbPath, dbPragmas ? { pragmas: dbPragmas } : {});
        log.debug(`sqlite: opened for persistence at ${dbPath}`);
      }
      await asyncDb.execute(SKV_SCHEMA);
      await migrateLegacyKv(asyncDb, resolveKvPath(appId), log);
      kvDb = sqliteKv(asyncDb);
      log.debug(`persist: SQLite aio_kv mode=${persistMode}`);
      const migrated = await loadAndMigrateSnapshot(
        kvDb,
        appId,
        persistKey,
        persistMode,
        log,
      );
      if (migrated) {
        hadPersistedState = true;
        persistedSnapshot = migrated; // raw stored shape — for drift detection
        state = deepMerge(
          initialState as Record<string, unknown>,
          migrated,
        ) as S;
        // Top-level keys the merge dropped as "removed from schema" are CELLS,
        // not fields — a renamed/undeclared cell's whole slice. They ride into
        // state here so onRestore can migrate them; section 5b then preserves
        // whatever remains (and strips it from runtime state). Field-level
        // schema-drop semantics inside declared cells are unchanged.
        for (const k of Object.keys(migrated)) {
          if (
            !(k in (initialState as Record<string, unknown>)) &&
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
      if (e instanceof AioError) throw e; // schema mismatch — already precise
      throw new Error(
        `persistence unavailable: ${e}\nFix permissions or set persist: false to disable persistence.`,
      );
    }
  }

  // ── 4b. State migration — check persisted versions vs current ────
  // ONLY when something was actually restored. On a fresh install there is no
  // old shape to migrate: running onMigrate against pristine initialState let
  // a hook rewrite defaults it was never meant to see (a v0→v1 rename turning
  // the app's own defaults into garbage on first launch). The first successful
  // persist stamps the current versions, so the next boot is a no-op anyway.
  if (shouldPersist && kvDb && hadPersistedState && persistedSnapshot) {
    const VERSIONS_KEY = `${appId}:__versions`;
    const persistedVersions =
      await kvDb.get<Record<string, number>>(VERSIONS_KEY) ?? {};
    const stateObj = state as Record<string, unknown>;
    const report = cfg.cellMigrations?.size
      ? applyCellMigrations(
        stateObj,
        cfg.cellMigrations,
        persistedVersions,
        log,
      )
      : [];
    // Shape drift (risoto #1): the RAW stored snapshot vs the declared
    // `initialState`. Cells a migration already handled this boot are skipped;
    // the rest reveal a stored field the current shape no longer declares —
    // the silent stale-shape load a rename/removal without a version bump
    // leaves behind. Warned once (summarized), and kept for `am migrations`.
    const drift = detectShapeDrift(
      initialState as Record<string, unknown>,
      persistedSnapshot,
      { skip: new Set(report.map((r) => r.cell)) },
    );
    if (drift.length > 0) log.warn(shapeDriftSummary(drift));
    const declared: Record<string, number> = {};
    for (const [id, info] of cfg.cellMigrations ?? []) {
      declared[id] = info.version;
    }
    migrations = { declared, stored: persistedVersions, report, drift };
  }

  // ── 5. onRestore hook ─────────────────────────────────────────────
  if (onRestore) {
    try {
      state = onRestore(state);
    } catch (e) {
      log.error(`hook onRestore: ${e}`);
    }
  }

  // ── 5b. Stored-but-undeclared cells: preserved, never dropped ─────
  // A cell rename/split used to destroy the old cell's data silently: the
  // slice was restored into state, no declared cell owned it, and the first
  // persist rewrote the document without it (space-invaders field report — a
  // leaderboard recovered from SQLite free pages). Now: the slice is carried
  // into every future persisted document verbatim, stripped from RUNTIME
  // state (no cell owns it — it must not broadcast), and announced at every
  // boot until the app migrates or re-declares it. onRestore runs FIRST, so a
  // rename migration is one hook: read `state.oldCell`, move what you need,
  // and `delete state.oldCell` — a deliberate delete there CONSUMES the slice
  // (its row is removed on the next flush).
  const orphanCells: Record<string, unknown> = {};
  if (persistedSnapshot) {
    const declared = new Set(
      Object.keys(initialState as Record<string, unknown>),
    );
    const s = state as Record<string, unknown>;
    for (const k of Object.keys(persistedSnapshot)) {
      if (declared.has(k) || k.startsWith("__")) continue;
      if (k in s) {
        orphanCells[k] = s[k];
        delete s[k];
        log.warn(
          `persist: stored cell "${k}" is not declared by this build — its ` +
            `data is PRESERVED in the store, untouched. Migrate it in ` +
            `onRestore (read state.${k}, move what you need, delete the key ` +
            `to consume it), or re-declare the cell to get it back as-is.`,
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
      const recovered = diagHooks.getRecoveredState()!;
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
  if (asyncDb && dbSchema) {
    const loaded = await loadTables(asyncDb, dbSchema);
    state = { ...(state as Record<string, unknown>), ...loaded } as S;
  }

  log.debug(
    `state: ${Object.keys(state as Record<string, unknown>).length} keys`,
  );

  // ── 8. Persistence manager ────────────────────────────────────────
  // Build cell versions map for persistence (only cells with version > 0)
  const cellVersions: Record<string, number> | undefined =
    cfg.cellMigrations?.size
      ? (() => {
        const v: Record<string, number> = {};
        for (const [id, info] of cfg.cellMigrations!) v[id] = info.version;
        return Object.keys(v).length > 0 ? v : undefined;
      })()
      : undefined;

  // Durable journal (risoto #3) — opt-in, and only where there's a real file to
  // recover from (persisting, not :memory:). The persistence manager advances
  // its watermark after each committed snapshot; _run appends + replays.
  const journal: Journal | null =
    cfg.journal && shouldPersist && dbPathOverride !== ":memory:"
      ? createJournal(
        dbPathOverride
          ? dbPathOverride + ".journal"
          : appDirs(appId, cfg.appDir).journal,
        { redact: makeRedactor(cfg.redactActions) },
      )
      : null;

  const persistence = createPersistenceManager({
    kvDb,
    asyncDb,
    dbSchema,
    persistKey,
    persistMode,
    persistMs: persistDebounceMs,
    getState,
    getDBState: kvGetDBState as (s: Record<string, unknown>) => unknown,
    log,
    getReportOpts,
    syncCells: syncCellIds.length > 0 ? new Set(syncCellIds) : undefined,
    cellVersions,
    appId,
    getJournalSeq: journal ? () => journal.currentSeq() : undefined,
    onPersisted: journal ? (seq) => journal.setWatermark(seq) : undefined,
    ...(Object.keys(orphanCells).length ? { orphanCells } : {}),
    ...(persistedSnapshot
      ? {
        storedKeys: Object.keys(persistedSnapshot).filter((k) =>
          !k.startsWith("__")
        ),
      }
      : {}),
  });

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
  };
}

/** Load the persisted snapshot and bring it to the current persistence
 *  schema (A4). Alpha-era snapshots have no `<appId>:__schema` stamp and
 *  read as version 0; snapshots from a NEWER schema throw `PERSIST_SCHEMA`
 *  (loud downgrade refusal). The stamp itself is written by the persistence
 *  manager AFTER successful state writes, so it can never be newer than the
 *  state it describes. Returns null when nothing is stored. */
export async function loadAndMigrateSnapshot(
  kvDb: SkvInstance,
  appId: string,
  persistKey: string,
  persistMode: "single" | "multi",
  log: Log,
): Promise<Record<string, unknown> | null> {
  const persisted = persistMode === "multi"
    ? await kvDb.getMulti<Record<string, unknown>>(persistKey)
    : await kvDb.get<Record<string, unknown>>(persistKey);
  if (!persisted) return null;

  const storedSchema = await kvDb.get<number>(`${appId}:__schema`) ?? 0;
  if (storedSchema === PERSIST_SCHEMA_VERSION) return persisted;

  const result = migrateSchema(persisted, storedSchema); // throws on downgrade
  if (result.applied.length) {
    log.info(
      `persist: schema migrated v${storedSchema} → v${PERSIST_SCHEMA_VERSION} (${result.applied.length} step${
        result.applied.length === 1 ? "" : "s"
      })`,
    );
  }
  return result.state;
}

/** Apply cell migrations — pure logic, extracted for testability.
 *  Mutates stateObj in place for cells that need migration. */
/** One stored field whose shape no longer matches the declared `initialState`. */
export type ShapeDriftEntry = {
  cell: string;
  /** Dotted path within the cell ("" = the cell itself). */
  path: string;
  issue: "unknown-field" | "type-changed" | "unknown-cell" | "seed-erased";
  storedType: string;
  /** Declared type — present for "type-changed". */
  declaredType?: string;
  /** How many declared entries the stored empty collection erases —
   *  present for "seed-erased". */
  declaredCount?: number;
};

const MAX_DRIFT = 100;
const DRIFT_MAX_DEPTH = 8;

const kindOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

/** Diff persisted cell data against the declared shape (`initialState`) and
 *  report structural drift: a stored field the current shape no longer declares
 *  (a rename/removal that `deepMerge` would silently keep → stale-shape load),
 *  or a field whose type changed. This is "declared vs stored shape" using
 *  `initialState` as the schema — no separate schema declaration to drift from
 *  the code. Data-level differences (array lengths, values) are NOT drift; only
 *  structure is — and a declared EMPTY object is an open record (dynamic-key
 *  map), so its stored keys are data too, not drift. `skip` suppresses cells a
 *  migration already accounted for.
 *
 *  Pure + capped (MAX_DRIFT entries, DRIFT_MAX_DEPTH deep) so a large stored
 *  blob can't produce an unbounded or runaway report. */
export function detectShapeDrift(
  initial: Record<string, unknown>,
  stored: Record<string, unknown>,
  opts: { skip?: Set<string> } = {},
): ShapeDriftEntry[] {
  const out: ShapeDriftEntry[] = [];
  const skip = opts.skip ?? new Set<string>();

  const isPlainObj = (v: unknown): v is Record<string, unknown> =>
    kindOf(v) === "object";

  const walk = (
    cell: string,
    decl: unknown,
    stor: unknown,
    path: string,
    depth: number,
  ): void => {
    if (out.length >= MAX_DRIFT) return;
    const dk = kindOf(decl);
    const sk = kindOf(stor);
    if (dk !== sk) {
      out.push({
        cell,
        path,
        issue: "type-changed",
        storedType: sk,
        declaredType: dk,
      });
      return;
    }
    // A declared collection with entries, stored empty: the restore wipes
    // whatever `state:` seeded (risoto 2026-07-28 #2 — a curated token registry
    // vanished, every holding rendered as a raw mint, nothing said). `state:`
    // reads like a default and behaves like a first-run value; both are
    // legitimate, so this is reported rather than overruled — unless the cell
    // says which it meant with `persist: { seed: [...] }`.
    // Arrays only: they are the one shape `deepMerge` replaces wholesale, so an
    // empty stored array is the only value that can delete declared entries (an
    // empty stored OBJECT merges key-by-key and erases nothing).
    if (
      Array.isArray(decl) && decl.length > 0 && Array.isArray(stor) &&
      stor.length === 0
    ) {
      out.push({
        cell,
        path,
        issue: "seed-erased",
        storedType: sk,
        declaredCount: decl.length,
      });
      return;
    }
    // Same kind. Recurse into plain objects only — arrays/primitives are data.
    if (isPlainObj(decl) && isPlainObj(stor) && depth < DRIFT_MAX_DEPTH) {
      // An EMPTY declared object is an open record (`{} as Record<K,V>` — a
      // dynamic-key map whose keys are DATA, not schema, e.g. balances keyed by
      // pubkey). Its stored keys are all legitimate, so don't flag them and
      // don't recurse — exactly how an array's elements are treated as data
      // (risoto 2026-07-25 field report: this was a 70-warning wall on boot).
      if (Object.keys(decl).length === 0) return;
      for (const key of Object.keys(stor)) {
        if (out.length >= MAX_DRIFT) return;
        const child = path ? `${path}.${key}` : key;
        if (!(key in decl)) {
          out.push({
            cell,
            path: child,
            issue: "unknown-field",
            storedType: kindOf(stor[key]),
          });
          continue;
        }
        walk(cell, decl[key], stor[key], child, depth + 1);
      }
    }
  };

  for (const cell of Object.keys(stored)) {
    if (out.length >= MAX_DRIFT) break;
    if (skip.has(cell)) continue;
    if (!(cell in initial)) {
      out.push({
        cell,
        path: "",
        issue: "unknown-cell",
        storedType: kindOf(stored[cell]),
      });
      continue;
    }
    walk(cell, initial[cell], stored[cell], "", 0);
  }
  return out;
}

/** Per-cell outcome of the boot migration pass — inspectable + testable. */
export type CellMigrationOutcome =
  | "migrated" // onMigrate ran, version advanced
  | "reset" // onMigrate threw → state reset to initial
  | "stale" // version bumped but no onMigrate — kept as-is, may be stale
  | "downgrade"; // stored version NEWER than code — running old code on new data

/** Structured report of what the migration pass did — one entry per cell that
 *  was NOT a clean no-op. Returned for inspection (`am`/tests); also logged. */
export type MigrationReport = {
  cell: string;
  from: number;
  to: number;
  outcome: CellMigrationOutcome;
}[];

/** The boot migration picture, surfaced live via the trojan `migrations` route
 *  and `am migrations`: declared vs stored per-cell versions, what the pass did,
 *  and any unaccounted shape drift. */
export type MigrationSummary = {
  declared: Record<string, number>;
  stored: Record<string, number>;
  report: MigrationReport;
  drift: ShapeDriftEntry[];
};

/** One teachable line summarizing all shape drift found at boot.
 *  Seed erasure is reported separately — same detector, different remedy. */
export function shapeDriftSummary(drift: ShapeDriftEntry[]): string {
  const erased = drift.filter((d) => d.issue === "seed-erased");
  const structural = drift.filter((d) => d.issue !== "seed-erased");
  const lines: string[] = [];
  if (erased.length > 0) {
    const show = erased.slice(0, 5).map((d) =>
      `${
        d.path ? `${d.cell}.${d.path}` : d.cell
      } (${d.declaredCount} declared ` +
      `→ stored empty)`
    );
    const more = erased.length > show.length
      ? ` …and ${erased.length - show.length} more`
      : "";
    lines.push(
      `restore erased seeded data: ${erased.length} declared list(s) were ` +
        `replaced by an empty stored value — ${show.join(", ")}${more}. ` +
        `A persisted array replaces the declared one wholesale, so whatever ` +
        `\`state:\` seeded is gone. If the list is a fixed seed, keep it out ` +
        `of persistence (\`persist: { exclude: [...] }\`); if it is a cache ` +
        `that may legitimately empty, this is expected; if it must be merged, ` +
        `bump the cell version and re-seed it in \`onMigrate\`.`,
    );
  }
  if (structural.length === 0) return lines.join("\n");
  drift = structural;
  const show = drift.slice(0, 5).map((d) => {
    const where = d.path ? `${d.cell}.${d.path}` : d.cell;
    if (d.issue === "unknown-cell") {
      return `${where} (stored, no longer declared)`;
    }
    if (d.issue === "type-changed") {
      return `${where} (${d.storedType}≠declared ${d.declaredType})`;
    }
    return `${where} (${d.storedType}, not in initialState)`;
  });
  const more = drift.length > show.length
    ? ` …and ${drift.length - show.length} more`
    : "";
  lines.push(
    `shape drift: ${drift.length} stored field(s) no longer match the ` +
      `declared shape — ${
        show.join(", ")
      }${more}. A rename/removal without a ` +
      `version bump keeps the stale value (deepMerge preserves it). Bump the ` +
      `cell's version + add onMigrate to transform it, or clear the stored data.`,
  );
  return lines.join("\n");
}

export function applyCellMigrations(
  stateObj: Record<string, unknown>,
  cellMigrations: Map<string, CellMigrationInfo>,
  persistedVersions: Record<string, number>,
  log: Log,
): MigrationReport {
  const report: MigrationReport = [];
  for (const [cellId, info] of cellMigrations) {
    if (info.version === 0) continue; // default — no migration needed
    const persisted = persistedVersions[cellId] ?? 0;
    const cellState = stateObj[cellId] as Record<string, unknown> | undefined;
    if (persisted > info.version) {
      // Downgrade: the DB was written by NEWER code than is now running. The
      // stored shape can be ahead of what this build understands, so proceeding
      // silently risks reading fields that moved or vanished. Loud + explicit —
      // mirrors the framework-schema downgrade guard, dev/prod alike.
      log.warn(
        `migrate: ${cellId} stored v${persisted} is NEWER than code v${info.version} — ` +
          `running an older build against newer data. Re-deploy the build that ` +
          `wrote it, or bump ${cellId}'s version and add an onMigrate that ` +
          `down-converts. State kept as-is; fields may be misread.`,
      );
      report.push({
        cell: cellId,
        from: persisted,
        to: info.version,
        outcome: "downgrade",
      });
      continue;
    }
    if (persisted < info.version) {
      if (cellState && info.onMigrate) {
        try {
          stateObj[cellId] = info.onMigrate(cellState, persisted);
          log.info(`migrate: ${cellId} v${persisted} → v${info.version}`);
          report.push({
            cell: cellId,
            from: persisted,
            to: info.version,
            outcome: "migrated",
          });
        } catch (e) {
          // Reset to initial state — stale persisted state can't be migrated
          log.error(
            `migrate: ${cellId} onMigrate threw — resetting to initial state: ${e}`,
          );
          stateObj[cellId] = info.initialState;
          report.push({
            cell: cellId,
            from: persisted,
            to: info.version,
            outcome: "reset",
          });
        }
      } else if (cellState && !info.onMigrate) {
        log.warn(
          `migrate: ${cellId} version ${persisted} → ${info.version} but no onMigrate hook — state may be stale`,
        );
        report.push({
          cell: cellId,
          from: persisted,
          to: info.version,
          outcome: "stale",
        });
      }
    }
  }
  return report;
}
