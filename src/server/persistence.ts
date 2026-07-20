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
  let prevPersistedKeys: string[] = [];
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

  // AIO-420 (risoto): per-cell KV sizes, largest first — so an over-limit warning
  // can NAME the offending cell instead of failing anonymously (or, in single
  // mode, nuking the whole persist with no clue which cell to move to SQLite).
  const KV_LIMIT = 63_000; // Deno KV per-value hard limit is ~64KB; stay under.
  const _cellSizes = (obj: Record<string, unknown>): { cell: string; bytes: number }[] =>
    Object.entries(obj)
      .map(([cell, v]) => ({
        cell,
        bytes: new TextEncoder().encode(JSON.stringify(v)).byteLength,
      }))
      .sort((a, b) => b.bytes - a.bytes);
  const _fmt = (l: { cell: string; bytes: number }[]): string =>
    l.map((x) => `${x.cell} (${(x.bytes / 1024).toFixed(1)}KB)`).join(", ");

  async function _syncKv(): Promise<void> {
    if (!kvDb) return;
    try {
      const dbState = getDBState(kvGetState());
      if (persistMode === "multi") {
        const obj = dbState as Record<string, unknown>;
        // AIO-420: a single over-limit cell would fail the WHOLE atomic commit
        // (nuking every cell's persistence). Degrade instead — persist the
        // healthy cells, keep each over-limit cell's LAST-SAVED value (don't
        // delete it), and name them loudly so the dev moves them to SQLite.
        const over = new Set(
          _cellSizes(obj).filter((c) => c.bytes > KV_LIMIT).map((c) => c.cell),
        );
        let toPersist = obj;
        let prevForCommit = prevPersistedKeys;
        if (over.size) {
          log.error(
            `persist: cell(s) exceed the ~64KB Deno KV limit and were NOT ` +
              `updated (last-saved value kept): ${
                _fmt(_cellSizes(obj).filter((c) => over.has(c.cell)))
              } — move to db:{} (SQLite) or add a cell-level persist filter.`,
          );
          _reportPersistError(
            new Error(`persist: KV over-limit cells: ${[...over].join(", ")}`),
          );
          toPersist = Object.fromEntries(
            Object.entries(obj).filter(([k]) => !over.has(k)),
          );
          prevForCommit = prevPersistedKeys.filter((k) => !over.has(k));
        }
        const keys = Object.keys(toPersist);
        try {
          const result = await kvDb.setMulti(
            persistKey,
            toPersist,
            prevForCommit,
          );
          if (result.ok) {
            // B-7: only advance the persisted-key set and log "saved" when the
            // atomic commit actually succeeded. Preserve over-limit cells that
            // still hold a prior KV value.
            prevPersistedKeys = [
              ...keys,
              ...prevPersistedKeys.filter((k) => over.has(k)),
            ];
            await _stampVersions();
            log.debug(`persist: saved multi (${keys.length} keys)`);
          } else {
            // B-7: a failed atomic commit is NOT success — report it and keep
            // persistNeeded so the next cycle retries, instead of silently
            // declaring the keys persisted (future data loss once .check()s
            // are added to the atomic op).
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
        const serialized = JSON.stringify(dbState);
        const bytes = new TextEncoder().encode(serialized).byteLength;
        if (bytes > 63_000) {
          // AIO-420: name the biggest cells — the whole single-key blob can't
          // persist, so tell the dev exactly which cell(s) to move / filter,
          // instead of dropping everything anonymously.
          const top = _cellSizes(dbState as Record<string, unknown>).slice(0, 3);
          log.error(
            `persist: state is ${
              (bytes / 1024).toFixed(1)
            }KB — exceeds the ~64KB Deno KV limit; NOTHING saved this cycle. ` +
              `Largest cells: ${_fmt(top)}. Use persistMode:'multi' (isolates ` +
              `cells), a cell-level persist filter, or db:{} (SQLite).`,
          );
          _reportPersistError(
            new Error(
              `persist: single-key state ${(bytes / 1024).toFixed(1)}KB over KV limit`,
            ),
          );
          return;
        }
        if (bytes > 50_000) {
          log.warn(
            `persist: state is ${
              (bytes / 1024).toFixed(1)
            }KB — approaching 65KB KV limit. Consider persistMode:'multi', cell-level persist filters, or SQLite`,
          );
        }
        try {
          await kvDb.set(persistKey, dbState);
          await _stampVersions();
          log.debug(`persist: saved (${(bytes / 1024).toFixed(1)}KB)`);
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
          if (kvDb) {
            try {
              const dbState = getDBState(kvGetState());
              if (persistMode === "multi") {
                const obj = dbState as Record<string, unknown>;
                const keys = Object.keys(obj);
                const result = await kvDb.setMulti(
                  persistKey,
                  obj,
                  prevPersistedKeys,
                );
                if (result.ok) {
                  prevPersistedKeys = keys;
                  await _stampVersions();
                } else {
                  // B-7: failed atomic commit on the final flush — surface it
                  // rather than reporting "flushed".
                  const err = new Error(
                    "persist: multi-key atomic commit returned ok:false on flush — state not saved",
                  );
                  log.error(err.message);
                  _reportPersistError(err);
                }
              } else {
                await kvDb.set(persistKey, dbState);
                await _stampVersions();
              }
              log.debug("persist: flushed");
            } catch (e) {
              const msg = String(e);
              if (
                msg.includes("too large") || msg.includes("65536") ||
                msg.includes("value too")
              ) {
                log.warn(
                  `persist: state exceeds Deno KV 65KB limit — set persistMode:'multi', cell-level persist filters, or db:{} (SQLite)`,
                );
              }
              log.error(`persist: flush failed — ${e}`);
              _reportPersistError(e);
            }
          }
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
