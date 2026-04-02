// Persistence manager — KV + SQLite debounced persistence (AIO-52 Phase 2)
// Extracted from aio.ts to reduce monolith and enable isolated testing.

import type { SkvInstance } from "./skv.ts";
import type { DB } from "./db/mod.ts";
import { syncTables } from "./db/mod.ts";
import type { TableDef } from "./sql.ts";
import { createAioError, reportError as reportAioError } from "./error.ts";
import type { ReportErrorOpts } from "./error.ts";
import type { Log } from "./logger.ts";

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
}

export interface PersistenceManager {
  schedulePersist(): void;
  flushPersist(): Promise<void>;
  setShuttingDown(): void;
  resetPrevState(): void;
}

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

  async function _syncKv(): Promise<void> {
    if (!kvDb) return;
    try {
      const dbState = getDBState(getState());
      if (persistMode === "multi") {
        const obj = dbState as Record<string, unknown>;
        const keys = Object.keys(obj);
        try {
          const result = await kvDb.setMulti(
            persistKey,
            obj,
            prevPersistedKeys,
          );
          if (result.ok) prevPersistedKeys = keys;
          log.debug(`persist: saved multi (${keys.length} keys)`);
        } catch (e) {
          log.error(`persist: failed to save — ${e}`);
          _reportPersistError(e);
        }
      } else {
        const serialized = JSON.stringify(dbState);
        const bytes = new TextEncoder().encode(serialized).byteLength;
        if (bytes > 63_000) {
          log.error(
            `persist: state is ${
              (bytes / 1024).toFixed(1)
            }KB — exceeds Deno KV 65KB limit. Use persistMode:'multi', stateForDB filter, or db:{} (SQLite)`,
          );
          return;
        }
        if (bytes > 50_000) {
          log.warn(
            `persist: state is ${
              (bytes / 1024).toFixed(1)
            }KB — approaching 65KB KV limit. Consider persistMode:'multi', stateForDB, or SQLite`,
          );
        }
        try {
          await kvDb.set(persistKey, dbState);
          log.debug(`persist: saved (${(bytes / 1024).toFixed(1)}KB)`);
        } catch (e) {
          log.error(`persist: failed to save — ${e}`);
          _reportPersistError(e);
        }
      }
    } catch (e) {
      log.error(`persist: stateForDB threw — ${e}`);
      _reportPersistError(e);
    }
  }

  let persistRunning = false; // AIO-148: guard against concurrent persist ops

  function schedulePersist(): void {
    if ((!kvDb && !asyncDb) || persistTimer || shuttingDown || persistRunning) {
      return;
    }
    persistTimer = setTimeout(async () => {
      persistTimer = null;
      if (persistRunning) return;
      persistRunning = true;
      try {
        await _syncSqlite();
        await _syncKv();
      } finally {
        persistRunning = false;
      }
    }, persistMs);
  }

  async function flushPersist(): Promise<void> {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    // Wait for any running persist to finish before flushing (AIO-148)
    if (persistRunning) {
      await new Promise<void>((r) => {
        const check = () => {
          if (!persistRunning) r();
          else setTimeout(check, 5);
        };
        check();
      });
    }
    persistRunning = true;
    try {
      // Flush SQLite
      if (asyncDb && dbSchema) {
        const stateSnapshot = structuredClone(getState());
        try {
          await syncTables(asyncDb, dbSchema, stateSnapshot, prevDbState);
          prevDbState = stateSnapshot;
        } catch (e) {
          log.error(`persist: sqlite flush failed — ${e}`);
        }
      }
      // Flush KV
      if (kvDb) {
        try {
          const dbState = getDBState(getState());
          if (persistMode === "multi") {
            const obj = dbState as Record<string, unknown>;
            const keys = Object.keys(obj);
            const result = await kvDb.setMulti(
              persistKey,
              obj,
              prevPersistedKeys,
            );
            if (result.ok) prevPersistedKeys = keys;
          } else {
            await kvDb.set(persistKey, dbState);
          }
          log.debug("persist: flushed");
        } catch (e) {
          const msg = String(e);
          if (
            msg.includes("too large") || msg.includes("65536") ||
            msg.includes("value too")
          ) {
            log.warn(
              `persist: state exceeds Deno KV 65KB limit — set persistMode:'multi' or use stateForDB / db:{} (SQLite)`,
            );
          }
          log.error(`persist: flush failed — ${e}`);
          _reportPersistError(e);
        }
      }
    } finally {
      persistRunning = false;
    }
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
