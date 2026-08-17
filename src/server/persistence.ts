// Persistence manager — KV + SQLite debounced persistence (AIO-52 Phase 2)
// Extracted from aio.ts to reduce monolith and enable isolated testing.

import type { SkvInstance, SkvStmt } from "./skv.ts";
import type { DB } from "../db/mod.ts";
import { planTables } from "../db/state-sync.ts";
import type { TableDef } from "./sql.ts";
import {
  createAioError,
  reportError as reportAioError,
} from "../diagnostics/error.ts";
import type { ReportErrorOpts } from "../diagnostics/error.ts";
import type { Log } from "../diagnostics/logger-api.ts";
import { PERSIST_SCHEMA_VERSION } from "./persist-schema.ts";
import {
  describeIssues,
  type PersistIssue,
  stringifyWithIssues,
} from "./persist-guard.ts";

// ── Per-cell size guardrails ─────────────────────────────────────────
//
// Cell state is the reactive WORKING SET: it is serialized on every persist
// flush and broadcast to every connected client, so an oversized cell does not
// fail here — it fails later, as slow flushes and dropped WS frames, far from
// the write that caused it. These thresholds make the wrong tier fail loudly
// AT WRITE TIME, naming the right tier instead (bulk rows → `db:` tables,
// binaries → files — see docs/persistence/big-data.md).
//
// Sizes are measured on the JSON the flush ALREADY produces (string length ≈
// bytes for the ASCII-dominant JSON that state serializes to) — no extra
// serialization pass.
// A config knob (`persist: { warnBytes, hardBytes }`) lands in alpha53; until
// then these exported constants are the single source of truth.

/** Warn threshold: a cell whose serialized state exceeds this gets ONE warning
 *  per process naming the cell, the size and the right tier. Chosen to match
 *  the default 1MB WS frame budget (`wsLimits`) — state that cannot ride in
 *  one frame is state in the wrong tier. */
export const PERSIST_CELL_WARN_BYTES = 1024 * 1024; // 1 MiB
/** Hard threshold: a cell over this is reported as an ERROR on EVERY flush.
 *  The write is never dropped — data loss is worse than any warning — but an
 *  app in this regime is degraded on every flush and every broadcast, so it
 *  stays loud until fixed. */
export const PERSIST_CELL_HARD_BYTES = 16 * 1024 * 1024; // 16 MiB
/** The tier guide every size guardrail points at. */
export const BIG_DATA_DOC = "docs/persistence/big-data.md";

/** The teachable part, shared by warn and hard messages (and mirrored at the
 *  broadcast seam in server-broadcast.ts). */
export const CELL_SIZE_TIER_HINT =
  `Cell state is the reactive working set — it is serialized on every ` +
  `persist flush and broadcast to every client. Bulk rows belong in db: ` +
  `tables, binaries in files — see ${BIG_DATA_DOC}.`;

const _fmtBytes = (n: number): string =>
  n >= 1024 * 1024
    ? `${(n / (1024 * 1024)).toFixed(1)}MB`
    : `${(n / 1024).toFixed(0)}KB`;

/** Configuration for the persistence manager — KV/SQLite handles, debounce timing, and state accessors. */
export interface PersistenceConfig {
  kvDb: SkvInstance | null;
  asyncDb: DB | null;
  /** `db:` tables, keyed by SQL table name (see `resolveDbBindings`). */
  dbSchema: Record<string, TableDef> | undefined;
  /** State → `{ [sqlTable]: rows }` projection. A `db:` table mirrors an array
   *  INSIDE a cell (`contacts.contacts`), not a root key, so the diff input is
   *  a projection rather than raw state. Omitted (engine-level callers) ⇒ raw
   *  state, where a table name IS the root key. */
  getTableState?: (s: Record<string, unknown>) => Record<string, unknown>;
  /** What SQLite ACTUALLY holds at boot, keyed by SQL table name. The diff
   *  baseline is "what the database has", which is only the same thing as
   *  "what state has" when every row was already written — not when a binding
   *  is new or a `state:` seed was adopted over an empty table. Consumed by
   *  the first `resetPrevState()` (the orchestrator's post-boot re-seed). */
  dbBaselineOverride?: Record<string, unknown>;
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
  /** Opt-in journal: the current journal seq — captured at
   *  state-read time, so the persisted snapshot reflects actions up to it. */
  getJournalSeq?: () => number;
  /** Opt-in journal: called with that seq AFTER a successful state write, so the
   *  journal can advance its watermark + compact the persisted prefix. Undefined
   *  (journal off) ⇒ the persist path is byte-identical to before. */
  onPersisted?: (seq: number) => void;
  /** Stored-but-undeclared cell slices found at boot. Carried into
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
  // What SQLite sees: only the arrays bound to `db:` tables, keyed by table
  // name. Cloned so a later state commit can't retro-change the baseline the
  // next diff is measured against.
  const tablesOf = (s: Record<string, unknown>): Record<string, unknown> =>
    (cfg.getTableState ?? ((x) => x))(s) as Record<string, unknown>;
  const tableState = (): Record<string, unknown> =>
    structuredClone(tablesOf(getState()));
  // The live reference each table had when its baseline was taken.
  //
  // `syncTables` pre-filters with `state[name] !== prev[name]` — an IDENTITY
  // check, which is the right one: immer shares structure, so an untouched
  // table keeps its exact reference across commits. But cloning the whole
  // table set on every persist minted fresh objects for every table, so that
  // check was always true and EVERY table was re-diffed row by row on every
  // debounce window, however little had changed.
  //
  // Comparing live references restores the pre-filter without weakening the
  // guarantee the clone exists for: a table that really changed is still
  // cloned, so no baseline ever aliases live state. An unchanged table reuses
  // the clone already held, which is the same data by definition — committed
  // state is frozen (autoFreeze is never disabled), so an unchanged reference
  // cannot hide changed contents. A `getTableState` that rebuilds its arrays
  // each call simply sees every table as changed and gets today's behaviour.
  let prevLiveTables: Record<string, unknown> = {};
  let _baselineOverride = cfg.dbBaselineOverride;
  const baseline = (): Record<string, unknown> => {
    const v = tableState();
    if (_baselineOverride) {
      for (const [t, rows] of Object.entries(_baselineOverride)) v[t] = rows;
    }
    return v;
  };
  let prevDbState: Record<string, unknown> = baseline();

  // One report per offending path — a persist runs every debounce window, and
  // the same bad field would otherwise log on every one of them.
  const _warnedPersistPaths = new Set<string>();

  // Size guardrail bookkeeping: one WARN per cell per process; the HARD
  // overrun deliberately has no such set — it reports on every flush.
  const _warnedBigCells = new Set<string>();
  function _guardCellSize(cellName: string, size: number): void {
    if (size > PERSIST_CELL_HARD_BYTES) {
      // Loud on EVERY flush, and the write still happens: refusing it would
      // turn "too big" into data loss, which is strictly worse.
      const err = new Error(
        `persist: cell "${cellName}" serializes to ${_fmtBytes(size)} — over ` +
          `the ${_fmtBytes(PERSIST_CELL_HARD_BYTES)} hard limit. The write ` +
          `is NOT dropped (state is never lost), but every flush and every ` +
          `broadcast now pays this size. ${CELL_SIZE_TIER_HINT}`,
      );
      log.error(err.message);
      _reportPersistError(err);
    } else if (
      size > PERSIST_CELL_WARN_BYTES && !_warnedBigCells.has(cellName)
    ) {
      _warnedBigCells.add(cellName);
      log.warn(
        `persist: cell "${cellName}" serializes to ${_fmtBytes(size)} ` +
          `(warn threshold ${_fmtBytes(PERSIST_CELL_WARN_BYTES)}). ` +
          CELL_SIZE_TIER_HINT,
      );
    }
  }

  // Per-cell serialization cache, advanced ONLY when a write COMMITS.
  //
  // Committed state is frozen (immer autoFreeze is never disabled), so an
  // unchanged reference cannot hide changed contents — the same identity
  // argument `prevLiveTables` above rests on. A cell whose slice reference is
  // unchanged since the last committed write therefore serializes to the same
  // JSON, and re-stringifying (and re-upserting) it every debounce window was
  // pure waste: one small cell changing in an app with one big cell paid the
  // big cell's full serialization on every flush. A snapshot pipeline that
  // rebuilds its objects each call simply never hits the cache and gets the
  // old behaviour.
  const _cellSer = new Map<string, { ref: unknown; size: number }>();

  function _reportPersistError(e: unknown): void {
    const err = createAioError("PERSIST_ERROR", e, {});
    reportAioError(err, getReportOpts());
  }

  // A4: stamp schema + cell versions AFTER a successful state write — never
  // before, so a stamp can't describe state that was never saved. Closes the
  // loop applyCellMigrations() reads from at boot (`<appId>:__versions`).
  //
  // The stamp is MONOTONIC per cell. It used to write the RUNNING build's
  // versions unconditionally, so a rollback re-stamped the cell DOWNWARD
  // (v2 → v1) and the next roll-forward saw an "upgrade" that wasn't one:
  // `onMigrate` ran a SECOND time over already-migrated data — a v1→v2
  // money migration applied twice, silently. A version is a fact about the
  // stored SHAPE, and an older build cannot make newer data older; it can
  // only fail to understand it (which boot warns about, loudly).
  let _storedVersions: Record<string, number> | null = null;
  async function _stampVersions(): Promise<void> {
    if (!kvDb || !cfg.appId) return;
    try {
      await kvDb.set(`${cfg.appId}:__schema`, PERSIST_SCHEMA_VERSION);
      if (cfg.cellVersions) {
        const key = `${cfg.appId}:__versions`;
        if (_storedVersions === null) {
          _storedVersions = await kvDb.get<Record<string, number>>(key) ?? {};
        }
        const next = { ..._storedVersions };
        let changed = false;
        for (const [cell, v] of Object.entries(cfg.cellVersions)) {
          const highest = Math.max(v, next[cell] ?? 0);
          if (highest !== next[cell]) {
            next[cell] = highest;
            changed = true;
          }
        }
        if (changed) {
          await kvDb.set(key, next);
          _storedVersions = next;
        }
      }
    } catch (e) {
      log.error(`persist: version stamp failed — ${e}`);
      _reportPersistError(e);
    }
  }

  /** The `db:` table writes for ONE state read — built, not executed, so they
   *  can ride in the same transaction as the snapshot row below. `commit()`
   *  advances the diff baseline and is called only after that transaction
   *  lands; a throw here (a bad row) leaves both halves of the baseline put,
   *  so the next attempt still sees those tables as changed and retries. */
  function _planSqlite(
    snap: Record<string, unknown>,
  ): { stmts: SkvStmt[]; commit: () => void } | null {
    if (!asyncDb || !dbSchema) return null;
    // Clone only what moved (see prevLiveTables). Unchanged tables carry their
    // existing baseline object through by reference, so planTables' identity
    // pre-filter skips them instead of re-diffing every row.
    const live = tablesOf(snap);
    const stateSnapshot: Record<string, unknown> = {};
    const nextLive: Record<string, unknown> = {};
    for (const name of Object.keys(live)) {
      nextLive[name] = live[name];
      stateSnapshot[name] =
        live[name] === prevLiveTables[name] && name in prevDbState
          ? prevDbState[name]
          : structuredClone(live[name]);
    }
    const stmts = planTables(dbSchema, stateSnapshot, prevDbState);
    return {
      stmts,
      commit: () => {
        prevDbState = stateSnapshot;
        prevLiveTables = nextLive;
        log.debug("persist: sqlite synced");
      },
    };
  }

  // Exclude sync cells from KV — they use their own SQLite op-log
  const kvGetState = cfg.syncCells?.size
    ? (s: Record<string, unknown>) => {
      const c = { ...s };
      for (const f of cfg.syncCells!) delete c[f];
      return c;
    }
    : (s: Record<string, unknown>) => s;

  /** The snapshot-row write for the SAME state read. `stmts` is null only for
   *  a store that cannot express itself as SQL (there is none today) — then
   *  `write()` is the old direct path. */
  function _planKv(snap: Record<string, unknown>): {
    stmts: SkvStmt[] | null;
    write: () => Promise<boolean>;
    commit: () => Promise<void>;
  } | null {
    if (!kvDb) return null;
    // Journal watermark: the seq the ABOUT-TO-BE-WRITTEN snapshot
    // reflects. Captured before the (synchronous) state read so no action can
    // slip between; advanced only AFTER the write commits. No-op when off.
    const seq = cfg.getJournalSeq?.() ?? 0;
    const dbState = cfg.orphanCells
      ? {
        ...cfg.orphanCells,
        ...(getDBState(kvGetState(snap)) as Record<string, unknown>),
      }
      : getDBState(kvGetState(snap));
    // ONE per-cell scan of the document about to be written, feeding three
    // consumers from the same pass:
    //   1. round-trip issues — name every value JSON would corrupt on the way
    //      to disk (observe-only, identically in dev and prod: it reports once
    //      per offending path and still writes — refusing the write would turn
    //      one corrupted field into total data loss);
    //   2. the size guardrail (_guardCellSize);
    //   3. in multi mode, the changed-cell set the write below is narrowed to.
    // A cell whose committed reference is unchanged (see _cellSer) skips
    // serialization entirely — its size is already known and its row already
    // holds exactly these bytes.
    const doc = dbState as Record<string, unknown>;
    const perCell = doc !== null && typeof doc === "object" &&
      !Array.isArray(doc);
    const changed: Record<string, unknown> = {};
    const pendingSer: [string, { ref: unknown; size: number }][] = [];
    const freshIssues: PersistIssue[] = [];
    if (perCell) {
      for (const [cellName, v] of Object.entries(doc)) {
        const hit = _cellSer.get(cellName);
        if (hit && hit.ref === v) {
          _guardCellSize(cellName, hit.size); // hard overruns stay loud
          continue;
        }
        const { json, issues } = stringifyWithIssues(v);
        for (const i of issues) {
          // Same dotted-from-the-root paths the whole-document scan produced.
          freshIssues.push({
            ...i,
            path: i.path ? `${cellName}.${i.path}` : cellName,
          });
        }
        _guardCellSize(cellName, json.length);
        changed[cellName] = v;
        pendingSer.push([cellName, { ref: v, size: json.length }]);
      }
    } else {
      freshIssues.push(...stringifyWithIssues(dbState).issues);
    }
    {
      const fresh = freshIssues.filter((i) => !_warnedPersistPaths.has(i.path));
      if (fresh.length > 0) {
        for (const i of fresh) _warnedPersistPaths.add(i.path);
        const err = new Error(`persist: ${describeIssues(fresh)}`);
        log.error(err.message);
        _reportPersistError(err);
      }
    }

    if (persistMode === "multi") {
      // Multi mode: one SQLite row per top-level cell, and ONLY the changed
      // cells are rewritten (the cache above). No size ceiling — the store is
      // SQLite, whose TEXT values hold ~1GB. (The old ~64KB "over-limit
      // degrade" was a Deno.Kv-era vestige; Deno.Kv was retired in D4
      // precisely to escape that limit, so refusing large cells only lost
      // data SQLite would keep.)
      const keys = Object.keys(doc);
      // Keys that left the document entirely (a consumed/renamed cell) — the
      // ONLY deletes. Unchanged cells must NOT ride in the prev-keys list:
      // planSetMulti deletes every prev key absent from its object, so the
      // full prev list next to the narrowed object would delete every
      // unchanged cell's row.
      const removedKeys = prevPersistedKeys.filter((k) => !(k in doc));
      const toWrite = perCell ? changed : doc;
      return {
        stmts: kvDb.planSetMulti?.(persistKey, toWrite, removedKeys) ?? null,
        write: async () =>
          (await kvDb!.setMulti(persistKey, toWrite, removedKeys)).ok,
        commit: async () => {
          prevPersistedKeys = keys;
          for (const [k, e] of pendingSer) _cellSer.set(k, e);
          for (const k of removedKeys) _cellSer.delete(k);
          await _stampVersions();
          cfg.onPersisted?.(seq); // watermark advances only on a committed write
          log.debug(
            `persist: saved multi (${
              Object.keys(toWrite).length
            }/${keys.length} cells written)`,
          );
        },
      };
    }
    // Single mode: one JSON blob. Any size — SQLite, not Deno.Kv. The write
    // is the whole document by contract (one row), so only the scan above
    // benefits from the cache.
    return {
      stmts: kvDb.planSet?.(persistKey, dbState) ?? null,
      write: async () => {
        await kvDb!.set(persistKey, dbState);
        return true;
      },
      commit: async () => {
        for (const [k, e] of pendingSer) _cellSer.set(k, e);
        await _stampVersions();
        cfg.onPersisted?.(seq); // watermark advances only on a committed write
        log.debug("persist: saved single");
      },
    };
  }

  /** ONE persist cycle: ONE read of live state, ONE transaction.
   *
   *  Both halves used to read `getState()` for themselves, several awaits
   *  apart, and commit separately — even though the `db:` tables and the
   *  `aio_kv` snapshot live in the SAME file, opened through the same handle.
   *  So a cell whose method appends a row AND bumps a counter had the two
   *  written from two different moments, and a process that died in between
   *  (SIGKILL, OOM, `Deno.exit`, an unhandled rejection during shutdown) came
   *  back with N rows and a counter reading N+1 — or, when the death landed
   *  between the two commits, with the rows and NO snapshot at all. Nothing
   *  detected it and nothing said so, because from each half's own point of
   *  view the write had succeeded.
   *
   *  One read makes the two halves describe the same instant; one transaction
   *  makes them land together or not at all. */
  async function _persistOnce(): Promise<void> {
    const snap = getState();

    let sql: { stmts: SkvStmt[]; commit: () => void } | null = null;
    try {
      sql = _planSqlite(snap);
    } catch (e) {
      // A row SQLite refuses must not take the state snapshot down with it —
      // the table half fails alone and is retried, exactly as before.
      log.error(`persist: sqlite sync failed — ${e}`);
      _reportPersistError(e);
    }

    let kv: ReturnType<typeof _planKv> = null;
    try {
      kv = _planKv(snap);
    } catch (e) {
      log.error(`persist: getDBState threw — ${e}`);
      _reportPersistError(e);
    }

    // The atomic path — one file, one transaction. This is the path every
    // real app takes (`kvDb` is always `sqliteKv(asyncDb)`).
    if (asyncDb && kv && kv.stmts) {
      try {
        await asyncDb.transaction([...(sql?.stmts ?? []), ...kv.stmts]);
        sql?.commit();
        await kv.commit();
        return;
      } catch (e) {
        // Nothing advanced: both baselines still describe the last COMMITTED
        // state, so the next cycle retries the whole thing.
        log.error(`persist: failed to save — ${e}`);
        _reportPersistError(e);
      }
      // Rejected as a unit — and a shared transaction shares its failures.
      //
      // `checkRows` gates the rows it can see (bindability, a missing or
      // duplicate pk, a bound value that is not an array), but the CREATE
      // TABLE aio itself emits declares more than that: NOT NULL on every
      // non-`nullable` column, UNIQUE, REFERENCES. A NULL in a `text()`
      // column, a repeat in a `unique:` one, a `ref()` to a row that isn't
      // there yet — each is refused by SQLite, not by us, and rolls the batch
      // back. The offending array stays in state, so the SAME batch is
      // rebuilt and refused on every debounce window from then on.
      //
      // Sharing the transaction turned that from "this table stops syncing"
      // into "the app never persists anything again" — every other cell's
      // state, every session, every other table, gone at the next restart.
      // The atomicity this path exists for is a guarantee about a process
      // that DIES mid-write; it was never a reason to throw away the writes
      // that are perfectly valid. So the snapshot goes in alone, and the
      // table half — whose baseline is deliberately NOT advanced — is retried
      // whole on the next window, and lands the moment the row is fixed.
      if (!sql?.stmts.length) return; // the snapshot itself is what failed
      try {
        await asyncDb.transaction(kv.stmts);
        await kv.commit();
      } catch (e) {
        log.error(`persist: failed to save state snapshot — ${e}`);
        _reportPersistError(e);
      }
      return;
    }

    // Fallback for a store that cannot plan (none ships today) — the two
    // halves as they were, each reporting its own failure.
    if (sql) {
      try {
        if (sql.stmts.length) await asyncDb!.transaction(sql.stmts);
        sql.commit();
      } catch (e) {
        log.error(`persist: sqlite sync failed — ${e}`);
        _reportPersistError(e);
      }
    }
    if (kv) {
      try {
        if (await kv.write()) await kv.commit();
        else {
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
    }
  }

  // Audit F-10: track the currently running persist as an explicit Promise.
  // flushPersist() awaits it instead of busy-polling a boolean every 5ms.
  let inFlight: Promise<void> | null = null;
  let persistNeeded = false;

  async function _runPersistCycle(): Promise<void> {
    try {
      await _persistOnce();
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
          // ONE code path with the scheduled persist. This used to be a
          // hand-copy, and it had already drifted three ways: it never called
          // `_reportPersistError`, so a table sync that failed on SHUTDOWN —
          // the last chance to write anything — reached the log and never
          // reached `onError`; it cloned every table instead of only the
          // changed ones; and it advanced `prevDbState` without advancing the
          // live-reference map beside it, leaving the two halves of one
          // baseline disagreeing. It also had its OWN simpler KV write, so an
          // over-limit cell on shutdown failed the whole atomic commit and
          // lost EVERY cell's data (not just the oversized one).
          await _persistOnce();
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

  /** Adopt the BOOT picture of what SQLite holds — once, and only at boot.
   *
   *  The `db:` diff baseline answers one question: what does the table
   *  already contain? Boot is the only moment anything other than this
   *  manager knows the answer (`dbBaselineOverride` = the rows `loadTables`
   *  actually read), so the boot call adopts it and the override is spent.
   *
   *  Every later call is a no-op, and that is the whole point. This used to
   *  re-baseline to whatever state held AT THE TIME — i.e. assert "SQLite
   *  already contains this" — and `app.loadSnapshot()` (and `POST
   *  /__aio/snapshot`, which calls it) calls it right after replacing state
   *  wholesale, when the assertion is false by construction. The restore
   *  landed in state and was broadcast to every client, the debounced persist
   *  that followed diffed the restored rows against themselves and wrote
   *  NOTHING, and the tables still held the pre-restore rows — which is what
   *  the next boot read back. A backup restored, confirmed, and silently
   *  undone by a restart. After boot the only truth about the table's
   *  contents is `prevDbState` itself (the last COMMITTED write), so leaving
   *  it alone is both correct and what makes the next persist write the
   *  difference. */
  function resetPrevState(): void {
    if (!_baselineOverride) return;
    prevDbState = baseline();
    _baselineOverride = undefined; // the boot picture is used exactly once
  }

  return { schedulePersist, flushPersist, setShuttingDown, resetPrevState };
}
