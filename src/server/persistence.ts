// Persistence manager — KV + SQLite debounced persistence (AIO-52 Phase 2)
// Extracted from aio.ts to reduce monolith and enable isolated testing.

import type { SkvInstance } from "./skv.ts";
import type { DB } from "../db/mod.ts";
import { syncTables } from "../db/mod.ts";
import type { TableDef } from "./sql.ts";
import {
  createAioError,
  reportError as reportAioError,
} from "../diagnostics/error.ts";
import type { ReportErrorOpts } from "../diagnostics/error.ts";
import type { Log } from "../diagnostics/logger.ts";
import { PERSIST_SCHEMA_VERSION } from "./persist-schema.ts";

/** Configuration for the persistence manager — KV/SQLite handles, debounce timing, and state accessors. */
export interface PersistenceConfig {
  kvDb: SkvInstance | null;
  asyncDb: DB | null;
  dbSchema: Record<string, TableDef> | undefined;
  persistKey: string;
  persistMode: "single" | "multi";
  persistMs: number;
  getState: () => Record<string, unknown>;
  getDBState: (s: Record<string, unknown>) => unknown;
  log: Log;
  getReportOpts: () => ReportErrorOpts;
  syncCells?: Set<string>;
  /** Cell version map — keyed by cell id. Persisted alongside state for migration detection. */
  cellVersions?: Record<string, number>;
  /** App ID — used as prefix for version key in KV */
  appId?: string;
  /** Opt-in journal (risoto #3): the current journal seq — captured at
   *  state-read time, so the persisted snapshot reflects actions up to it. */
  getJournalSeq?: () => number;
  /** Opt-in journal: called with that seq AFTER a successful state write, so the
   *  journal can advance its watermark + compact the persisted prefix. Undefined
   *  (journal off) ⇒ the persist path is byte-identical to before. */
  onPersisted?: (seq: number) => void;
  /** Stored-but-undeclared cell slices found at boot (space-invaders field
   *  report: a cell rename silently destroyed the leaderboard). Carried into
   *  EVERY persisted document verbatim, so user data is never dropped because
   *  a build stopped declaring its cell. */
  orphanCells?: Record<string, unknown>;
  /** Top-level keys present in the persisted snapshot at boot. Seeds the
   *  multi-mode delete tracking, so a cell whose slice onRestore deliberately
   *  CONSUMED (migrated and deleted) has its row removed on the first flush
   *  instead of resurfacing as an orphan on every boot. */
  storedKeys?: string[];
}

/** Persistence manager API — debounced state persistence to KV and/or SQLite. */
export interface PersistenceManager {
  schedulePersist(): void;
  flushPersist(): Promise<void>;
  setShuttingDown(): void;
  resetPrevState(): void;
}

/** Create a persistence manager that debounces state writes to Deno KV and/or SQLite. */
export function createPersistenceManager(
  cfg: PersistenceConfig,
): PersistenceManager {
  const {
    kvDb,
    asyncDb,
    dbSchema,
    persistKey,
    persistMode,
    persistMs,
    getState,
    getDBState,
    log,
    getReportOpts,
  } = cfg;

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;
  let prevPersistedKeys: string[] = cfg.storedKeys ?? [];
  let prevDbState: Record<string, unknown> = structuredClone(getState());

  function _reportPersistError(e: unknown): void {
    const err = createAioError("PERSIST_ERROR", e, {});
    reportAioError(err, getReportOpts());
  }

  // A4: stamp schema + cell versions AFTER a successful state write — never
  // before, so a stamp can't describe state that was never saved. Closes the
  // loop applyCellMigrations() reads from at boot (`<appId>:__versions`).
  async function _stampVersions(): Promise<void> {
    if (!kvDb || !cfg.appId) return;
    try {
      await kvDb.set(`${cfg.appId}:__schema`, PERSIST_SCHEMA_VERSION);
      if (cfg.cellVersions) {
        await kvDb.set(`${cfg.appId}:__versions`, cfg.cellVersions);
      }
    } catch (e) {
      log.error(`persist: version stamp failed — ${e}`);
      _reportPersistError(e);
    }
  }

  async function _syncSqlite(): Promise<void> {
    if (!asyncDb || !dbSchema) return;
    const stateSnapshot = structuredClone(getState());
    try {
      await syncTables(asyncDb, dbSchema, stateSnapshot, prevDbState);
      prevDbState = stateSnapshot;
      log.debug("persist: sqlite synced");
    } catch (e) {
      log.error(`persist: sqlite sync failed — ${e}`);
      _reportPersistError(e);
    }
  }

  // Exclude sync cells from KV — they use their own SQLite op-log
  const kvGetState = cfg.syncCells?.size
    ? () => {
      const s = { ...getState() };
      for (const f of cfg.syncCells!) delete s[f];
      return s;
    }
    : getState;

  async function _syncKv(): Promise<void> {
    if (!kvDb) return;
    // Journal watermark (risoto #3): the seq the ABOUT-TO-BE-WRITTEN snapshot
    // reflects. Captured before the (synchronous) state read so no action can
    // slip between; advanced only AFTER the write commits. No-op when off.
    const seq = cfg.getJournalSeq?.() ?? 0;
    try {
      const dbState = cfg.orphanCells
        ? {
          ...cfg.orphanCells,
          ...(getDBState(kvGetState()) as Record<string, unknown>),
        }
        : getDBState(kvGetState());
      if (persistMode === "multi") {
        // Multi mode: one SQLite row per top-level cell (setMulti is atomic and
        // rewrites only changed cells). No size ceiling — the store is SQLite,
        // whose TEXT values hold ~1GB. (The old ~64KB "over-limit degrade" was
        // a Deno.Kv-era vestige; Deno.Kv was retired in D4 precisely to escape
        // that limit, so refusing large cells only lost data SQLite would keep.)
        const obj = dbState as Record<string, unknown>;
        const keys = Object.keys(obj);
        try {
          const result = await kvDb.setMulti(
            persistKey,
            obj,
            prevPersistedKeys,
          );
          if (result.ok) {
            prevPersistedKeys = keys;
            await _stampVersions();
            cfg.onPersisted?.(seq); // watermark advances only on a committed write
            log.debug(`persist: saved multi (${keys.length} keys)`);
          } else {
            // B-7: a failed atomic commit is NOT success — report and retry
            // next cycle instead of declaring the keys persisted.
            persistNeeded = true;
            const err = new Error(
              "persist: multi-key atomic commit returned ok:false — state not saved",
            );
            log.error(err.message);
            _reportPersistError(err);
          }
        } catch (e) {
          log.error(`persist: failed to save — ${e}`);
          _reportPersistError(e);
        }
      } else {
        // Single mode: one JSON blob. Any size — SQLite, not Deno.Kv.
        try {
          await kvDb.set(persistKey, dbState);
          await _stampVersions();
          cfg.onPersisted?.(seq); // watermark advances only on a committed write
          log.debug("persist: saved single");
        } catch (e) {
          log.error(`persist: failed to save — ${e}`);
          _reportPersistError(e);
        }
      }
    } catch (e) {
      log.error(`persist: getDBState threw — ${e}`);
      _reportPersistError(e);
    }
  }

  // Audit F-10: track the currently running persist as an explicit Promise.
  // flushPersist() awaits it instead of busy-polling a boolean every 5ms.
  let inFlight: Promise<void> | null = null;
  let persistNeeded = false;

  async function _runPersistCycle(): Promise<void> {
    try {
      await _syncSqlite();
      await _syncKv();
    } finally {
      inFlight = null;
      if (persistNeeded && !shuttingDown) {
        persistNeeded = false;
        schedulePersist();
      }
    }
  }

  function schedulePersist(): void {
    if ((!kvDb && !asyncDb) || shuttingDown) {
      return;
    }
    if (inFlight) {
      persistNeeded = true;
      return;
    }
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (inFlight) {
        persistNeeded = true;
        return;
      }
      inFlight = _runPersistCycle();
    }, persistMs);
  }

  async function flushPersist(): Promise<void> {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    // Wait for any in-flight scheduled persist to finish so we don't overlap.
    // Previously polled a boolean every 5ms (AIO-148); now we just await the
    // Promise directly — no CPU churn during slow shutdowns.
    if (inFlight) {
      await inFlight.catch(() => {/* errors already reported inside cycle */});
    }
    // B-10: loop until nothing is pending. A schedulePersist() that lands while
    // this flush is writing (a late effect changing state) sets persistNeeded;
    // unlike _runPersistCycle, the old flush ignored it, so that final write was
    // lost if the process then exited. We reset persistNeeded before each cycle
    // (the cycle reads fresh getState(), so it captures the latest state) and
    // re-run while a concurrent schedule marked more work.
    do {
      persistNeeded = false;
      const cycle = (async () => {
        try {
          if (asyncDb && dbSchema) {
            const stateSnapshot = structuredClone(getState());
            try {
              await syncTables(asyncDb, dbSchema, stateSnapshot, prevDbState);
              prevDbState = stateSnapshot;
            } catch (e) {
              log.error(`persist: sqlite flush failed — ${e}`);
            }
          }
          // ONE code path with the scheduled persist: _syncKv carries the
          // AIO-420 over-limit degrade (multi mode) and the single-key size
          // guard. The flush previously had its OWN simpler KV write with
          // NEITHER — so an over-limit cell on shutdown failed the whole atomic
          // commit and lost EVERY cell's data (not just the oversized one).
          if (kvDb) await _syncKv();
        } finally {
          inFlight = null;
        }
      })();
      inFlight = cycle;
      await cycle;
    } while (persistNeeded);
  }

  function setShuttingDown(): void {
    shuttingDown = true;
  }

  /** Reset prev-state tracking after snapshot load */
  function resetPrevState(): void {
    prevDbState = structuredClone(getState());
  }

  return { schedulePersist, flushPersist, setShuttingDown, resetPrevState };
}
