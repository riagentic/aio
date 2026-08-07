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
// The db module owns the "is this a missing worker?" verdict — importing the
// predicate keeps ONE decider for a failure that surfaces in two places.
import { dbWorkerMissingHint } from "../db/async-db.ts";
import { assertIdent, type TableDef } from "./sql.ts";
import { deepMerge } from "../state/deep-merge.ts";
import { resolveKvPath } from "./paths.ts";
import { resolve } from "@std/path";
import { appDirs } from "./app-dirs.ts";
import {
  AioError,
  createAioError,
  reportError as reportAioError,
  type ReportErrorOpts,
} from "../diagnostics/error.ts";
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
 *  came back with EMPTY sync cells (silent data loss; a non-admin-login
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

// ── `db:` table ↔ state bindings ──────────────────────────────────────
//
// A `db:` table auto-syncs ONE array in state. With the cells API every
// top-level state key is a CELL ID whose slice is an object (`cell()` refuses
// anything else), so the array a table stores is always a FIELD of a cell —
// never a root key. Addressing the root was therefore unreachable: a table
// named after a cell threw at boot (AIO-419), and any other name bound to
// nothing at all, silently, while injecting an unowned root key into state and
// broadcasting it (v1.0.0-alpha45 — `examples/contacts` could not boot).
//
// A `db:` key now names the state array it stores:
//   - `field`        — the array field `field` of the ONE cell that declares
//                      it (or a root array, for the engine-level API). SQL
//                      table name = the key. This is the documented shape
//                      (`db: { contacts: table(…) }` ↔ `contacts.contacts`).
//   - `cell.field`   — explicit, for disambiguation. SQL table = `cell_field`.
//   - no match       — the table is SQL-only: it is created and left to
//                      `app.db`, and NOTHING is written into state for it.
// Every outcome is announced at boot; ambiguity and a failed explicit binding
// are hard errors. Nothing is ever assigned over a cell's slice.

/** One `db:` table's wiring to state. `path: []` = SQL-only (no auto-sync). */
export type DbBinding = {
  /** The SQL table name (what `app.db` queries). */
  table: string;
  /** Path to the state array this table mirrors; `[]` when unbound. */
  path: string[];
};

const _isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Array fields a cell declares — the candidates a `db:` table can bind to. */
function _arrayFields(state: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const cell of Object.keys(state)) {
    const slice = state[cell];
    if (Array.isArray(slice)) out.push(cell);
    else if (_isObj(slice)) {
      for (const f of Object.keys(slice)) {
        if (Array.isArray(slice[f])) out.push(`${cell}.${f}`);
      }
    }
  }
  return out;
}

/** Resolve every `db:` key to a SQL table name + the state path it mirrors.
 *  Pure except for the boot log — extracted so the whole decision table is
 *  testable without booting a server. Throws on an ambiguous or impossible
 *  binding; never returns a binding that would overwrite a cell's slice. */
export function resolveDbBindings(
  initialState: Record<string, unknown>,
  dbSchema: Record<string, TableDef>,
  log: Pick<Log, "info" | "warn">,
): { bindings: DbBinding[]; sqlSchema: Record<string, TableDef> } {
  const bindings: DbBinding[] = [];
  const sqlSchema: Record<string, TableDef> = {};
  const declaredBy = new Map<string, string>(); // sql table → the db: key
  const candidates = () => {
    const c = _arrayFields(initialState);
    return c.length ? c.join(", ") : "(no cell declares an array field)";
  };

  for (const [key, def] of Object.entries(dbSchema)) {
    let table: string;
    let path: string[];

    if (key.includes(".")) {
      // Explicit `cell.field` — an intent that must resolve or fail loud.
      const parts = key.split(".");
      const [cellId, field] = parts;
      const slice = cellId === undefined ? undefined : initialState[cellId];
      if (
        parts.length !== 2 || !cellId || !field || !_isObj(slice) ||
        !Array.isArray(slice[field])
      ) {
        throw new Error(
          `[aio] db: table key "${key}" must name an ARRAY field of a cell ` +
            `("<cell>.<field>"), but ${
              !_isObj(slice)
                ? `there is no cell "${cellId}"`
                : `cell "${cellId}" has no array field "${field}"`
            }. Available: ${candidates()}.`,
        );
      }
      table = `${cellId}_${field}`;
      path = [cellId, field];
    } else if (Array.isArray(initialState[key])) {
      // Root-level array (engine-level `aio.run` config — no cells).
      table = key;
      path = [key];
    } else {
      const owners = Object.keys(initialState).filter((c) =>
        _isObj(initialState[c]) && Array.isArray(
          (initialState[c] as Record<string, unknown>)[key],
        )
      );
      if (owners.length > 1) {
        throw new Error(
          `[aio] db: table "${key}" is ambiguous — cells ${
            owners.map((o) => `"${o}"`).join(" and ")
          } each declare an array field "${key}". Say which one: ` +
            `db: { "${owners[0]}.${key}": table({…}) }.`,
        );
      }
      table = key;
      path = owners.length === 1 ? [owners[0]!, key] : [];
    }

    assertIdent(table, "table name");
    const prev = declaredBy.get(table);
    if (prev !== undefined) {
      throw new Error(
        `[aio] db: keys "${prev}" and "${key}" both map to SQL table ` +
          `"${table}" — one of them would silently share the other's rows. ` +
          `Rename one.`,
      );
    }
    declaredBy.set(table, key);
    sqlSchema[table] = def;
    bindings.push({ table, path });

    if (path.length) {
      log.info(`db: table "${table}" ↔ state.${path.join(".")} (auto-sync)`);
    } else {
      // Not an error — declaring a table you drive with raw SQL is a real
      // pattern — but it is the shape a typo produces, so it is never silent.
      log.warn(
        `db: table "${table}" is SQL-only — no state array is bound to it, so ` +
          `nothing auto-syncs and nothing is added to state. Read/write it ` +
          `with app.db. To auto-sync a cell's array field, name the table ` +
          `after that field, or bind it explicitly: ` +
          `db: { "<cell>.<field>": table({…}) }. Available: ${candidates()}.` +
          (_isObj(initialState[table])
            ? ` (Cell "${table}" exists but has no array field "${table}" — ` +
              `its slice is NOT touched.)`
            : ""),
      );
    }
  }
  return { bindings, sqlSchema };
}

/** Write each loaded table's rows into the state path it is bound to.
 *  Copy-on-write: only the objects along a bound path are cloned, and an
 *  unbound (SQL-only) table adds nothing — a table can never overwrite a
 *  cell's slice.
 *
 *  An EMPTY table never empties a non-empty array: that combination means the
 *  rows have not been written to SQLite yet — a binding that is new (the app
 *  just added `db:`, or upgraded to a version where the binding finally
 *  resolves), or a `state:` seed on first run. The array is adopted instead,
 *  and the first sync writes it into the table. Deleting rows on purpose still
 *  works: the bound array is excluded from the KV snapshot, so an emptied table
 *  restores as the declared default, not as stale data. */
export function placeLoadedTables(
  state: Record<string, unknown>,
  bindings: readonly DbBinding[],
  loaded: Record<string, unknown[]>,
  log?: (msg: string) => void,
): Record<string, unknown> {
  let next = state;
  for (const b of bindings) {
    if (b.path.length === 0 || !(b.table in loaded)) continue;
    const rows = loaded[b.table]!;
    if (rows.length === 0) {
      const current = readPath(next, b.path);
      if (Array.isArray(current) && current.length > 0) {
        log?.(
          `db: table "${b.table}" is empty but state.${
            b.path.join(".")
          } holds ${current.length} item(s) — keeping them and writing them to ` +
            `the table on the next sync (a new binding or a seeded default; ` +
            `an empty table never empties a non-empty array).`,
        );
        continue;
      }
    }
    if (b.path.length === 1) {
      next = { ...next, [b.path[0]!]: rows };
    } else {
      const [cellId, field] = b.path as [string, string];
      const slice = next[cellId];
      if (!_isObj(slice)) continue; // cell vanished — never clobber a non-object
      next = { ...next, [cellId]: { ...slice, [field]: rows } };
    }
  }
  return next;
}

/** The value at `path`, or undefined. */
export function readPath(
  state: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let cur: unknown = state;
  for (const k of path) {
    if (!_isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** `obj` without the values at `paths` — copy-on-write along each path only.
 *  Used to keep a `db:`-backed array out of the KV snapshot: SQLite owns those
 *  rows, and a second stale copy in the snapshot is a restore-order trap. */
export function omitPaths(
  obj: Record<string, unknown>,
  paths: readonly (readonly string[])[],
): Record<string, unknown> {
  let out = obj;
  for (const path of paths) {
    if (path.length === 0) continue;
    const [head, ...rest] = path as [string, ...string[]];
    if (!(head in out)) continue;
    if (rest.length === 0) {
      out = { ...out };
      delete out[head];
    } else {
      const child = out[head];
      if (!_isObj(child)) continue;
      out = { ...out, [head]: omitPaths(child, [rest]) };
    }
  }
  return out;
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
  /** Verify the app database at boot and recover from a snapshot if it is
   *  damaged — see db-integrity.ts. */
  checkIntegrityOnBoot?: boolean;
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
  /** Boot migration + shape-drift picture — undefined when nothing
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
  // longer looking at. one app found a complete, stale, unguarded wallet
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

  let asyncDb: DB | null = null;
  // Sync cells need the SQLite op-log even without user tables — a
  // `sync: true` cell must never silently degrade because `db:` is absent.
  if (dbKeys.length > 0 || syncCellIds.length > 0) {
    const dbPath = dbPathOverride ?? appDirs(appId, cfg.appDir).stateDb;
    // OPENING the file may legitimately degrade (no permission, read-only
    // medium): the app runs from memory and says so.
    try {
      asyncDb = createDB(dbPath, dbPragmas ? { pragmas: dbPragmas } : {});
      // Integrity BEFORE schema: a damaged file must be dealt with before
      // anything writes to it. When the file was quarantined (and possibly
      // replaced from a snapshot) the handle is dead — reopen on what is there
      // now, which may be the restored snapshot or an empty database.
      if (cfg.checkIntegrityOnBoot) {
        const { checkAndRecover } = await import("./db-integrity.ts");
        const outcome = await checkAndRecover({
          db: asyncDb,
          dbPath,
          log: {
            info: (m: string) => log.info(m),
            warn: (m: string) => log.warn(m),
            error: (m: string) => log.error(m),
          },
        });
        if (outcome.action === "restored" || outcome.action === "quarantined") {
          asyncDb = createDB(dbPath, dbPragmas ? { pragmas: dbPragmas } : {});
        }
      }
    } catch (e) {
      // Same classification as the persistence block below: a compiled binary
      // whose db worker was never embedded cannot be degraded around — the
      // app declared tables (or sync cells) that will never work. Fail loud
      // with the build fix instead of a warning nobody reads.
      const workerHint = dbWorkerMissingHint(e);
      if (workerHint) throw new Error(workerHint);
      log.warn(`sqlite: unavailable — ${e}`);
      if (asyncDb) {
        await asyncDb.close().catch(() => {});
        asyncDb = null;
      }
    }
    // Versioned schema ladder (private `aio_schema` table, src/db/ddl.ts —
    // deliberately NOT `PRAGMA user_version`, which belongs to the APP):
    // apply any registered strictly-once move BEFORE the epoch reconcilers
    // touch the file. Empty ladder today — this call is what makes a future
    // registered step LIVE at boot instead of "registered in one surface,
    // invoked in none" (the key-in-2-of-3 trap). Fatal on failure, like all
    // DDL.
    if (asyncDb) {
      const { runDdlSteps } = await import("../db/ddl.ts");
      await runDdlSteps(asyncDb);
    }
    // Creating the DECLARED TABLES is not degradable, and never shared that
    // catch again. A schema SQLite refuses (a keyword column, a bad ref, a
    // migration that cannot apply) used to become one `sqlite: unavailable`
    // warning and `asyncDb = null` — after which the persistence block below
    // REOPENED the same file for the KV snapshot, so the app served traffic
    // and persisted state with none of the `db:` tables it declared: every
    // read empty, every write nowhere. initSchema's message already names the
    // table, the column and the fix; it is the boot's job to let it through.
    if (asyncDb && dbKeys.length > 0) {
      try {
        await initSchema(asyncDb, sqlSchema);
      } catch (e) {
        const workerHint = dbWorkerMissingHint(e);
        await asyncDb.close().catch(() => {});
        asyncDb = null;
        if (workerHint) throw new Error(workerHint);
        throw new Error(
          `db: schema setup failed for ${dbKeys.length} declared table(s) — ${
            e instanceof Error ? e.message : String(e)
          }`,
          { cause: e },
        );
      }
    }
    if (asyncDb) log.info(`sqlite: ${dbKeys.length} table(s) at ${dbPath}`);
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
      const { applySyncMigrations, SYNC_SCHEMA } = await import(
        "../sync/compact.ts"
      );
      for (const sql of SYNC_SCHEMA) {
        await asyncDb.execute(sql);
      }
      // `CREATE TABLE IF NOT EXISTS` cannot add a column to a table an older
      // aio already created, so schema changes need their own step.
      await applySyncMigrations(asyncDb, {
        debug: (m: string) => log.debug("sync", m),
        warn: (m: string) => log.warn("sync", m),
      });
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
        // Raw — server-internal (compaction snapshot = the durability record
        // for sync cells, which are excluded from KV persistence).
        getCellState: (cell: string) =>
          (getState() as Record<string, Record<string, unknown>>)[cell] ?? {},
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
      log.info(`sync: ${syncCellIds.length} cell(s) with CRDT tables`);
    } else {
      log.warn(
        `sync: ${syncCellIds.length} cell(s) have sync: true but no SQLite DB — CRDT disabled`,
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
  // Migration + shape-drift summary, surfaced live via `am migrations`.
  let migrations: MigrationSummary | undefined;
  // Framework-parked slices (`__…` keys) this boot created — carried into
  // every persisted document alongside orphan cells, never into state.
  const parkedSlices: Record<string, unknown> = {};
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
      // A compiled binary that never embedded the SQLite worker fails here as
      // `Module not found: …/db-worker.ts`. The permissions advice below names
      // a cause that is NOT this one — it sends the reader to chmod the data
      // dir or turn persistence off, neither of which can fix a missing
      // module. Classified by the db module's own predicate (one decider).
      const workerHint = dbWorkerMissingHint(e);
      if (workerHint) throw new Error(workerHint);
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
    let report: MigrationReport = [];
    if (cfg.cellMigrations?.size) {
      try {
        report = applyCellMigrations(
          stateObj,
          cfg.cellMigrations,
          persistedVersions,
          log,
          persistedSnapshot,
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
      if (key in persistedSnapshot) continue;
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
  // Rows land at the bound state path (a cell's array field), never as a
  // top-level key nothing owns.
  let loadedTables: Record<string, unknown[]> | undefined;
  if (asyncDb && dbKeys.length > 0) {
    const loaded = await loadTables(asyncDb, sqlSchema);
    loadedTables = loaded;
    state = placeLoadedTables(
      state as Record<string, unknown>,
      dbBindings,
      loaded,
      (m) => log.warn(m),
    ) as S;
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

  // Durable journal — opt-in, and only where there's a real file to
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
    dbSchema: dbKeys.length > 0 ? sqlSchema : undefined,
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
    // The diff baseline is what SQLite HOLDS, not what state shows: an
    // adopted seed (empty table, non-empty array) must be written, not
    // assumed already there.
    ...(loadedTables ? { dbBaselineOverride: loadedTables } : {}),
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
  const readCurrent = () =>
    persistMode === "multi"
      ? kvDb.getMulti<Record<string, unknown>>(persistKey)
      : kvDb.get<Record<string, unknown>>(persistKey);
  const readOther = () =>
    persistMode === "multi"
      ? kvDb.get<Record<string, unknown>>(persistKey)
      : kvDb.getMulti<Record<string, unknown>>(persistKey);
  const otherMode = persistMode === "multi" ? "single" : "multi";

  let persisted = await readCurrent();
  // `persistMode` decides the LAYOUT of the stored document (one JSON blob vs
  // one row per cell). Reading only the current layout meant that flipping the
  // mode — which docs/persistence/auto-persist.md actively recommends —
  // silently looked like a fresh install: the app booted EMPTY over a full
  // store (and, the other way round, resurrected the stale pre-switch blob).
  // Nothing is "not there" until BOTH layouts have been asked.
  const other = await readOther();

  if (!persisted && other) {
    // Adopt: copy into the current layout, verify it reads back, and only THEN
    // retire the source — so a crash anywhere in here leaves the data readable
    // in at least one layout, never in neither.
    log.warn(
      `persist: persistMode is "${persistMode}" but the stored document is in ` +
        `the "${otherMode}" layout (${
          Object.keys(other).length
        } key(s)) — migrating it to "${persistMode}" now. Booting empty over ` +
        `it is what this used to do, silently.`,
    );
    if (persistMode === "multi") await kvDb.setMulti(persistKey, other);
    else await kvDb.set(persistKey, other);
    const verified = await readCurrent();
    if (!verified) {
      throw new Error(
        `persist: failed to migrate the stored document from "${otherMode}" ` +
          `to "${persistMode}" layout — it was NOT copied, and nothing was ` +
          `removed. Set persistMode back to "${otherMode}" to boot on your ` +
          `data.`,
      );
    }
    // The copy is readable in the new layout; the old one is now a trap (a
    // later switch back would resurrect it as authoritative). Retire it.
    if (otherMode === "single") await kvDb.del(persistKey);
    else await kvDb.setMulti(persistKey, {}, Object.keys(other));
    log.info(
      `persist: migrated the stored document ${otherMode} → ${persistMode} ` +
        `(${Object.keys(other).length} key(s))`,
    );
    persisted = verified;
  } else if (persisted && other) {
    // Both layouts hold data — an older aio, or a hand-edited store. Never
    // guess which is newer; boot on the configured one and say what is being
    // ignored, byte for byte still on disk.
    log.warn(
      `persist: stored state exists in BOTH layouts. Booting on the ` +
        `"${persistMode}" one (persistMode); the "${otherMode}" copy (${
          Object.keys(other).length
        } key(s)) is IGNORED and left untouched — switch persistMode to read ` +
        `it, or delete it once you know which one you want.`,
    );
  }
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
    // whatever `state:` seeded (a field report #2 — a curated token registry
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
      //.
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
    // `__…` keys are framework-parked data, not app shape.
    if (cell.startsWith("__")) continue;
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
  | "stale" // version bumped but no onMigrate — kept as-is, may be stale
  | "downgrade"; // stored version NEWER than code — running old code on new data
// (There is no "reset": a throwing onMigrate used to reset the cell to its
//  defaults, and the debounced persist then wrote that emptiness over the data
//  the migration was supposed to transform. It now refuses to boot instead —
//  nothing is written, so the stored bytes are still there for a fixed build.)

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

/** Stored values the declared shape dropped, put back — deep, depth-capped.
 *  `deepMerge` uses `initialState` as the template and drops every stored key
 *  the running build does not declare. That is right for a rename; it is data
 *  loss for a DOWNGRADE, where the "unknown" fields are what a NEWER build
 *  wrote and a later roll-forward still needs. Declared keys are untouched —
 *  the running build's types win for anything it actually reads. */
export function reattachUndeclared(
  merged: Record<string, unknown>,
  stored: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth >= 32) return merged;
  let out = merged;
  for (const k of Object.keys(stored)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (!(k in out)) {
      out = { ...out, [k]: stored[k] };
    } else if (_isObj(out[k]) && _isObj(stored[k])) {
      const child = reattachUndeclared(
        out[k] as Record<string, unknown>,
        stored[k] as Record<string, unknown>,
        depth + 1,
      );
      if (child !== out[k]) out = { ...out, [k]: child };
    }
  }
  return out;
}

/** Key a downgrade boot parks the pre-downgrade slice under. Framework-owned
 *  (`__` prefix ⇒ never restored into state, always carried into every
 *  persisted document verbatim). */
export const downgradeParkKey = (cell: string): string =>
  `__downgraded:${cell}`;

export function applyCellMigrations(
  stateObj: Record<string, unknown>,
  cellMigrations: Map<string, CellMigrationInfo>,
  persistedVersions: Record<string, number>,
  log: Log,
  /** The RAW stored snapshot (pre-deepMerge) — lets a downgrade keep the
   *  fields the merge narrowed away. Omitted ⇒ no re-attachment. */
  storedSnapshot?: Record<string, unknown>,
): MigrationReport {
  const report: MigrationReport = [];
  for (const [cellId, info] of cellMigrations) {
    if (info.version === 0) continue; // default — no migration needed
    const persisted = persistedVersions[cellId] ?? 0;
    const cellState = stateObj[cellId] as Record<string, unknown> | undefined;
    if (persisted > info.version) {
      // Downgrade: the DB was written by NEWER code than is now running. The
      // stored shape is ahead of what this build understands, so proceeding
      // silently risks reading fields that moved or vanished. Loud + explicit —
      // mirrors the framework-schema downgrade guard, dev/prod alike.
      //
      // The old warning said "State kept as-is", which was a MISDIAGNOSIS: the
      // restore had already narrowed the slice to this build's shape (deepMerge
      // drops undeclared keys), and the next persist wrote that narrowed slice
      // back — the newer build's fields deleted, silently. Put them back before
      // anything can persist over them.
      const stored = storedSnapshot?.[cellId];
      let kept: string[] = [];
      if (_isObj(cellState) && _isObj(stored)) {
        const widened = reattachUndeclared(cellState, stored);
        kept = Object.keys(stored).filter((k) => !(k in cellState));
        stateObj[cellId] = widened;
      }
      log.warn(
        `migrate: ${cellId} stored v${persisted} is NEWER than code v${info.version} — ` +
          `running an older build against newer data. ${
            kept.length
              ? `Fields this build does not declare (${
                kept.join(", ")
              }) were kept — the restore had narrowed them away. `
              : ""
          }A verbatim copy of the stored slice is parked at ` +
          `"${downgradeParkKey(cellId)}", and the stored version stamp stays ` +
          `v${persisted} (it never regresses), so rolling forward will NOT ` +
          `re-run onMigrate over already-migrated data. Re-deploy the build ` +
          `that wrote it, or bump ${cellId}'s version and add an onMigrate ` +
          `that down-converts. Fields this build DOES declare may be misread.`,
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
          // What the hook is HANDED matters: the restore ran `deepMerge`
          // against the NEW `initialState`, which drops every stored key the
          // new shape no longer declares — i.e. exactly the old fields a
          // rename migration exists to read (`s.cents` was already gone by the
          // time `onMigrate` looked for it, so the value it was meant to carry
          // over was lost every time). The hook sees the declared shape PLUS
          // whatever the store still holds; declared fields keep the merged
          // (typed) value.
          const stored = storedSnapshot?.[cellId];
          const input = _isObj(stored)
            ? reattachUndeclared(cellState, stored)
            : cellState;
          stateObj[cellId] = info.onMigrate(input, persisted);
          log.info(`migrate: ${cellId} v${persisted} → v${info.version}`);
          report.push({
            cell: cellId,
            from: persisted,
            to: info.version,
            outcome: "migrated",
          });
        } catch (e) {
          // REFUSE TO BOOT. This used to reset the cell to `initialState` and
          // carry on — and ~5ms later the debounced persist wrote that empty
          // slice over the stored data and stamped the new version, so a FIXED
          // build found nothing left to migrate. The data the hook failed on is
          // still on disk right now; the only way to keep it that way is to
          // write nothing at all.
          throw createAioError(
            "PERSIST_SCHEMA",
            new Error(
              `migrate: ${cellId} onMigrate (v${persisted} → v${info.version}) ` +
                `threw — refusing to boot: ${e}\n` +
                `NOTHING was written: the stored v${persisted} data is intact ` +
                `on disk, and a build with a fixed onMigrate will migrate it. ` +
                `(Booting on defaults would have persisted an empty ` +
                `"${cellId}" over it within the debounce window.) Fix the ` +
                `hook, or take a backup and clear the cell's stored slice to ` +
                `start clean.`,
            ),
            { cellName: cellId },
          );
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
