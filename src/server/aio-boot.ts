// Boot sequence — KV, SQLite, persistence, sync, and state restoration
// Extracted from aio.ts _run() to keep the orchestrator lean.

import {
  createPersistenceManager,
  type PersistenceManager,
} from "./persistence.ts";
import { skv, type SkvInstance } from "./skv.ts";
import { createDB, type DB, initSchema, loadTables } from "../db/mod.ts";
import type { TableDef } from "./sql.ts";
import { deepMerge } from "../state/deep-merge.ts";
import { resolveDbPath, resolveKvPath } from "./paths.ts";
import { AioError, type ReportErrorOpts } from "../diagnostics/error.ts";
import { migrateSchema, PERSIST_SCHEMA_VERSION } from "./persist-schema.ts";
import type { Log } from "../diagnostics/logger.ts";
import type { CheckpointData, DiagnosticsHooks } from "../diagnostics/mod.ts";
import type { ServerSyncHandler } from "../sync/server-handler.ts";
import { loadOpsSince } from "../sync/server-store.ts";

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
      ops = await loadOpsSince(db, cell, null, null); // null cursor → all ops, HLC-ordered
    } catch (e) {
      log.error(`sync: op-log replay failed for cell "${cell}" — ${e}`);
      continue;
    }
    if (ops.length === 0) continue;
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
  initialState: S;
  shouldPersist: boolean;
  persistKey: string;
  persistMode: "single" | "multi";
  persistDebounceMs: number;
  dbSchema: Record<string, TableDef> | undefined;
  syncCellIds: string[];
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
  log: Log;
}

/** Everything the boot sequence produces */
export interface BootResult<S> {
  state: S;
  kvDb: SkvInstance | null;
  asyncDb: DB | null;
  persistence: PersistenceManager;
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
      const dbPath = resolveDbPath(appId);
      asyncDb = createDB(dbPath);
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
      syncHandler = createServerSyncHandler({
        dispatch: (a) => syncDispatchRef.fn(a),
        db: asyncDb,
        syncCellIds,
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

  // ── 4. Open KV + restore persisted state ──────────────────────────
  let kvDb: SkvInstance | null = null;
  if (shouldPersist) {
    try {
      const kvPath = resolveKvPath(appId);
      kvDb = skv(await Deno.openKv(kvPath));
      if (kvPath) log.debug(`persist: KV at ${kvPath} mode=${persistMode}`);
      const migrated = await loadAndMigrateSnapshot(
        kvDb,
        appId,
        persistKey,
        persistMode,
        log,
      );
      if (migrated) {
        state = deepMerge(
          initialState as Record<string, unknown>,
          migrated,
        ) as S;
        log.debug(
          `persist: loaded from KV key="${persistKey}" (${persistMode})`,
        );
      } else {
        log.debug(`persist: no saved state, using initialState`);
      }
    } catch (e) {
      if (e instanceof AioError) throw e; // schema mismatch — already precise
      throw new Error(
        `KV unavailable: ${e}\nFix permissions or set persist: false to disable persistence.`,
      );
    }
  }

  // ── 4b. State migration — check persisted versions vs current ────
  if (shouldPersist && kvDb && cfg.cellMigrations?.size) {
    const VERSIONS_KEY = `${appId}:__versions`;
    const persistedVersions =
      await kvDb.get<Record<string, number>>(VERSIONS_KEY) ?? {};
    const stateObj = state as Record<string, unknown>;
    applyCellMigrations(stateObj, cfg.cellMigrations, persistedVersions, log);
  }

  // ── 5. onRestore hook ─────────────────────────────────────────────
  if (onRestore) {
    try {
      state = onRestore(state);
    } catch (e) {
      log.error(`hook onRestore: ${e}`);
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
  });

  return {
    state,
    kvDb,
    asyncDb,
    persistence,
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
export function applyCellMigrations(
  stateObj: Record<string, unknown>,
  cellMigrations: Map<string, CellMigrationInfo>,
  persistedVersions: Record<string, number>,
  log: Log,
): void {
  for (const [cellId, info] of cellMigrations) {
    if (info.version === 0) continue; // default — no migration needed
    const persisted = persistedVersions[cellId] ?? 0;
    if (persisted < info.version) {
      const cellState = stateObj[cellId] as Record<string, unknown> | undefined;
      if (cellState && info.onMigrate) {
        try {
          stateObj[cellId] = info.onMigrate(cellState, persisted);
          log.info(`migrate: ${cellId} v${persisted} → v${info.version}`);
        } catch (e) {
          // Reset to initial state — stale persisted state can't be migrated
          log.error(
            `migrate: ${cellId} onMigrate threw — resetting to initial state: ${e}`,
          );
          stateObj[cellId] = info.initialState;
        }
      } else if (cellState && !info.onMigrate) {
        log.warn(
          `migrate: ${cellId} version ${persisted} → ${info.version} but no onMigrate hook — state may be stale`,
        );
      }
    }
  }
}
