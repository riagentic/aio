// Boot sequence — KV, SQLite, persistence, sync, and state restoration
// Extracted from aio.ts _run() to keep the orchestrator lean.

import {
  createPersistenceManager,
  type PersistenceManager,
} from "./persistence.ts";
import {
  CLEAN_STOP_ROW,
  createJournal,
  type Journal,
  type JournalEntry,
  journalWatermarkKey,
  REACTIONS_FORMAT_ROW,
  SYNC_REACTION_TYPE,
  syncJournalWatermarkKey,
  type SyncReaction,
} from "./journal.ts";
import type { SkvInstance } from "./skv.ts";
import { migrateLegacyKv, SKV_SCHEMA, sqliteKv } from "./skv-sqlite.ts";
import type { DB } from "../db/types.ts";
import { createDB } from "../db/async-db.ts";
import { initSchema, loadTables } from "../db/state-sync.ts";
// The db module owns the "is this a missing worker?" verdict — importing the
// predicate keeps ONE decider for a failure that surfaces in two places.
import { dbWorkerMissingHint } from "../db/async-db.ts";
import {
  assertIdent,
  type DbBoundShape,
  type DbMapping,
  dbMappingOf,
  pkColumn,
  type TableDef,
} from "./sql.ts";
import {
  deepMerge,
  MAX_DEPTH as DEEP_MERGE_MAX_DEPTH,
} from "../state/deep-merge.ts";
import { createDeclaredShapeGuard } from "./declared-shape-guard.ts";
import { isCompiled, resolveKvPath } from "./paths.ts";
import { prodRequested } from "./aio-cli.ts";
import { SYNC_VERSION_UNKNOWN } from "../sync/compact.ts";
import { applyStatePatch } from "../sync/state-patch.ts";
import { dirname, join, resolve, SEPARATOR } from "@std/path";
import { appDirs, appsDirEnv } from "./app-dirs.ts";
import {
  AioError,
  createAioError,
  reportError as reportAioError,
  type ReportErrorOpts,
  teachableError,
} from "../diagnostics/error.ts";
import { makeRedactor } from "../diagnostics/redact.ts";
import { migrateSchema, PERSIST_SCHEMA_VERSION } from "./persist-schema.ts";
import type { Log } from "../diagnostics/logger-api.ts";
import type { CheckpointData, DiagnosticsHooks } from "../diagnostics/mod.ts";
import type { ServerSyncHandler } from "../sync/server-handler.ts";
import { cloneState } from "../state/immutable.ts";
import {
  getCompactedTs,
  getLowWater,
  loadOpsSince,
  loadSnapshot,
  seedSyncSnapshot,
} from "../sync/server-store.ts";
import { count } from "../diagnostics/fmt.ts";
import {
  bootStoreGen,
  planStoreGenRecord,
  recordStoreGen,
} from "./store-gen.ts";

/** What the boot replay needs to know about the app beyond the reducer —
 *  built by `bootStorage` (which has the cell metadata) and looked up by
 *  `replaySyncOps` (which the orchestrator calls with the db only). ONE object,
 *  keyed by the database it describes; tests pass it explicitly. */
export interface SyncReplayContext {
  /** Declared shape `version` per cell — absent means undeclared (0). */
  versions: Record<string, number>;
  /** Per-cell `onMigrate` hooks (cells that declared one or a version). */
  migrations: Map<string, CellMigrationInfo>;
  /** The KV version stamp of the build that last persisted — the best evidence
   *  for rows written before the op/snapshot stamp existed (`-1`). */
  stampedVersions: Record<string, number>;
  /** Cells whose op-log could NOT be folded into the current shape. MUTATED
   *  by the replay; compaction and the boot seed consult it and skip. */
  quarantined: Set<string>;
  /** Dev refuses to boot on a failed replay (the data is still on disk); prod
   *  quarantines the cell and continues. Dev-stricter, never the reverse. */
  dev: boolean;
  /** The boot report `am migrations` prints — entries appended when present. */
  report?: MigrationReport;
  /** Declared defaults — fills fields a filtered snapshot left out. */
  initialState: Record<string, unknown>;
}

const _syncContexts = new WeakMap<DB, SyncReplayContext>();

/** Register the replay context for a database (bootStorage) — see
 *  {@linkcode SyncReplayContext}. @internal */
export function registerSyncReplayContext(
  db: DB,
  ctx: SyncReplayContext,
): void {
  _syncContexts.set(db, ctx);
}

/** The replay context a boot registered for `db` — the SAME `report` array
 *  the trojan `migrations` route (and so `am migrations`) serves. Read-only
 *  by contract; the e2e in tests/sync-migration-e2e.test.ts reads it because
 *  the trojan is dev-only and quarantine is a prod outcome. @internal */
export function getSyncReplayContext(db: DB): SyncReplayContext | undefined {
  return _syncContexts.get(db);
}

/** The ONE dev/prod decider for the boot replay: the same signal composition
 *  uses for its security refusals — a source run without `--prod` is dev, a
 *  compiled binary or `--prod` is prod. (`prodRequested` is what
 *  `parseCli().prod` reads too; it is used directly because the stamp below
 *  runs at import, before the app's own flags are declared.) */
export function isDevBoot(): boolean {
  return !prodRequested() && !isCompiled();
}

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

/** `{ state, effects }` (the composed reducer) → state; a bare state passes. */
export function unwrapReduced<S>(r: S | { state: S; effects?: unknown[] }): S {
  return _isObj(r) && "state" in r && Array.isArray(r.effects)
    ? (r as { state: S }).state
    : r as S;
}

/** Fill fields the durable projection dropped from a snapshot with their
 *  declared defaults (top level — the shape a `persist: { exclude }` names).
 *  A snapshot is assigned as the slice verbatim; without this an excluded
 *  field came back ABSENT rather than at its default. */
function withDefaults(
  initial: unknown,
  slice: Record<string, unknown>,
): Record<string, unknown> {
  return _isObj(initial) ? { ...initial, ...slice } : slice;
}

/** Put each sync cell's journalled `listensTo` reactions back where they
 *  happened — BETWEEN its own ops (`SYNC_REACTION_TYPE`, journal `tail` past
 *  each cell's watermark). Runs after `replaySyncOps` and before the rest of
 *  the journal is replayed.
 *
 *  The newest such line for a cell is the cell's live state at the instant of
 *  its last unsaved reaction, holding exactly its ops up to `at` (the host
 *  records `at` at each op's commit) — resolved from its chain: the newest
 *  keyframe, then each delta whose `base` is the line before it (a break is
 *  said, and the state of the last whole link is used; see `SyncReaction`).
 *  So the cell is rebuilt as that state
 *  plus its ops ABOVE `at`, folded through the composed reducer and taken
 *  for this cell only — every reaction, and every op acked after one, in
 *  their live order. Returns the seq each cell was seeded from: the journal
 *  replay that follows must not write the cell from any line at or below it
 *  (that line's state already holds them).
 *
 *  Refused per cell, loudly, and the op-log result kept: a quarantined cell,
 *  a line stamped with another shape version, an op that no longer folds. */
export async function seedSyncReactions<S>(
  db: DB,
  syncCellIds: readonly string[],
  reduce: (
    state: S,
    action: { type: string; payload?: unknown },
  ) => S | { state: S; effects?: unknown[] },
  state: S,
  tail: readonly JournalEntry[],
  versionOf: (cell: string) => number,
  log: Pick<Log, "info" | "error" | "warn">,
  /** The cell's journal watermark — what `SyncReaction.baseSnapshotAt` must
   *  equal for a chain to start from the saved snapshot. Absent ⇒ never. */
  watermarkOf?: (cell: string) => number,
  /** Ops persisted but never reduced — left out, as `replaySyncOps` leaves
   *  them out (its `defer`). */
  defer?: ReadonlyMap<string, number>,
  /** The cell's `compacted_ts` as of its last fold that recorded a journal
   *  watermark (`syncJournalSnapshotKey`). Absent ⇒ no evidence either way. */
  foldedAt?: (cell: string) => number | undefined,
): Promise<{ state: S; seededAt: Map<string, number> }> {
  const seededAt = new Map<string, number>();
  const lines = new Map<string, JournalEntry[]>();
  for (const e of tail) {
    if (e.type !== SYNC_REACTION_TYPE) continue;
    const c = (e.payload as Partial<SyncReaction> | undefined)?.cell;
    if (typeof c !== "string" || !syncCellIds.includes(c)) continue;
    const chain = lines.get(c);
    if (chain) chain.push(e);
    else lines.set(c, [e]);
  }
  let next = state;
  for (const [cell, chain] of lines) {
    // The newest keyframe starts the chain that holds the newest state — or
    // the newest delta taken against the snapshot this boot restored from
    // (its capture is exactly the watermark the store holds for the cell).
    const wm = watermarkOf?.(cell);
    const snapshotOps = (r: SyncReaction): unknown[] | undefined =>
      wm === undefined
        ? undefined
        : r.baseSnapshotAt === wm && Array.isArray(r.ops)
        ? r.ops
        : r.alsoSnapshot?.at === wm && Array.isArray(r.alsoSnapshot.ops)
        ? r.alsoSnapshot.ops
        : undefined;
    const onSnapshot = (r: SyncReaction): boolean =>
      snapshotOps(r) !== undefined;
    let k = chain.length - 1;
    while (
      k >= 0 && !_isObj((chain[k]!.payload as SyncReaction).state) &&
      !onSnapshot(chain[k]!.payload as SyncReaction)
    ) k--;
    let snapshotStart: Record<string, unknown> | null = null;
    if (k >= 0 && !_isObj((chain[k]!.payload as SyncReaction).state)) {
      const snap = await loadSnapshot(db, cell).catch(() => null);
      snapshotStart = snap && _isObj(snap.state)
        ? applyStatePatch(
          snap.state as Record<string, unknown>,
          snapshotOps(chain[k]!.payload as SyncReaction)!,
        )
        : null;
      if (snapshotStart === null) {
        log.error(
          `journal: "${cell}"'s listensTo reaction chain starts on its saved ` +
            `snapshot (seq ${chain[k]!.seq}), which could not be read or ` +
            `patched — the op-log result is kept, without the reactions`,
        );
        continue;
      }
    }
    if (k < 0) {
      log.error(
        `journal: "${cell}"'s journalled listensTo reactions (seq ` +
          `${chain[0]!.seq}–${chain.at(-1)!.seq}) have no keyframe — the ` +
          `op-log result is kept, without them`,
      );
      continue;
    }
    const e = chain[k]!;
    if (_syncContexts.get(db)?.quarantined.has(cell)) {
      log.warn(
        `journal: "${cell}" is quarantined — its journalled listensTo ` +
          `reactions (seq ${e.seq}–${chain.at(-1)!.seq}) are not applied`,
      );
      continue;
    }
    const stamped = e.v?.[cell];
    if (stamped !== undefined && stamped !== versionOf(cell)) {
      log.warn(
        `journal: "${cell}"'s journalled listensTo reactions (seq ${e.seq}) ` +
          `were written by v${stamped}, this build declares ` +
          `v${versionOf(cell)} — not applied (their state is the older shape)`,
      );
      continue;
    }
    let slice = snapshotStart ?? (e.payload as SyncReaction).state!;
    let last = e;
    for (const d of chain.slice(k + 1)) {
      const r = d.payload as SyncReaction;
      const patched = r.base === last.seq && Array.isArray(r.ops)
        ? applyStatePatch(slice, r.ops)
        : null;
      if (patched === null) {
        log.error(
          `journal: "${cell}"'s listensTo reaction chain breaks at seq ` +
            `${d.seq} (base ${String(r.base)}, expected ${last.seq}) — ` +
            `restored up to seq ${last.seq}; the reactions after it are lost`,
        );
        break;
      }
      slice = patched;
      last = d;
    }
    const at = (last.payload as SyncReaction).at;
    // A snapshot written by a fold that recorded no journal watermark — a
    // run with the journal off (or a build that keeps none) — is newer than
    // every line here: the line would roll it back.
    const recorded = foldedAt?.(cell);
    const snapAt = recorded === undefined
      ? 0
      : await getCompactedTs(db, cell).catch(() => 0);
    if (recorded !== undefined && snapAt > recorded) {
      log.warn(
        `journal: "${cell}"'s journalled state (seq ${last.seq}) is older ` +
          `than its saved snapshot, which a run without the journal wrote — ` +
          `not applied, nor the cell's journalled actions up to it; the ` +
          `snapshot is kept`,
      );
      // …and neither are the action lines those states recorded.
      seededAt.set(cell, last.seq);
      continue;
    }
    try {
      let root = {
        ...(next as Record<string, unknown>),
        [cell]: slice,
      } as Record<
        string,
        unknown
      >;
      for (const op of await loadOpsSince(db, cell, null, at)) {
        if (defer?.get(cell) === op.serverTs) continue;
        const folded = unwrapReduced(
          reduce(root as S, {
            type: `${cell}:${op.action}`,
            payload: op.payload,
          }),
        ) as Record<string, unknown>;
        root = { ...root, [cell]: folded[cell] };
      }
      next = root as S;
      seededAt.set(cell, last.seq);
      log.info(
        `journal: "${cell}" restored its listensTo reactions (seq ` +
          `${last.seq}, op-log above ${at})`,
      );
    } catch (err) {
      log.error(
        `journal: "${cell}"'s journalled listensTo reaction (seq ` +
          `${last.seq}) could not be combined with its op-log — the op-log ` +
          `result is kept, without the reaction: ${err}`,
      );
    }
  }
  return { state: next, seededAt };
}

/** B1/AIO-416: replay each sync cell's committed op-log into state at boot.
 *  `sync: true` cells are excluded from KV, and their op-log was only ever
 *  replayed when a CLIENT connected — so a server restart with no client online
 *  came back with EMPTY sync cells (silent data loss; a non-admin-login
 *  bug). This folds every committed op back through the composed reducer — the
 *  same path a live op takes — after KV restore + onRestore and before the first
 *  dispatch/broadcast. Pure fold: no broadcast, no effects, no server needed.
 *  Loud by design (logs a per-cell count) so the restore is never invisible.
 *
 *  Shape changes (a field report, §3.1): every op row and every snapshot
 *  carries the cell `version` it was written under. Replay compares it with
 *  the version the running build declares:
 *    - equal            → applied as-is;
 *    - older + onMigrate → ops are folded in version order and the hook runs
 *                          at each boundary on the current slice;
 *    - older, no hook   → SKIPPED, loudly — never applied blind;
 *    - newer (downgrade) → skipped, loudly.
 *  A cell with a skipped or failed op is QUARANTINED: dev refuses to boot
 *  (nothing is written, the data is still on disk); prod keeps the cell at its
 *  last snapshot (never initialState), and compaction/seeding skip it so the
 *  emptiness can never be written over the log. Per cell, per op: one cell's
 *  failure never touches another cell's restore. */
export async function replaySyncOps<S>(
  db: DB,
  syncCellIds: string[],
  /** The composed reducer. The Elm-shaped `{ state, effects }` return (what
   *  `aio.run`'s `config.reduce` actually produces) is unwrapped like the
   *  journal replay does; a bare state is taken as-is (the unit tests). The
   *  cast at the call site used to hide the wrapper: op 1 turned the ROOT
   *  state into `{ state, effects }`, op 2 found no cell slice and threw —
   *  every sync app with an uncompacted log booted quarantined (or refused). */
  reduce: (
    state: S,
    action: { type: string; payload?: unknown },
  ) => S | { state: S; effects?: unknown[] },
  state: S,
  log: Pick<Log, "info" | "error" | "warn">,
  /** Explicit context (tests); otherwise the one `bootStorage` registered for
   *  this db. Absent entirely ⇒ no versions declared, dev-strict. */
  context?: Partial<SyncReplayContext>,
  opts: {
    /** Sync cell → the `server_ts` of its last op when that op was persisted
     *  but never reduced (see journal.ts `SYNC_APPLIED_TYPE`): left out of
     *  the cell's own fold, for the caller to reduce whole. */
    defer?: Map<string, number>;
  } = {},
): Promise<S> {
  const ctx: SyncReplayContext = {
    versions: {},
    migrations: new Map(),
    stampedVersions: {},
    quarantined: new Set(),
    dev: isDevBoot(),
    initialState: {},
    ..._syncContexts.get(db),
    ...context,
  };
  let next = state;
  for (const cell of syncCellIds) {
    let ops;
    try {
      ops = await loadOpsSince(db, cell, null, null); // null cursor → all ops, dispatch (server_ts) order
    } catch (e) {
      log.error(`sync: op-log replay failed for cell "${cell}" — ${e}`);
      continue;
    }

    const declared = ctx.versions[cell] ?? 0;
    const hook = ctx.migrations.get(cell)?.onMigrate;
    // A row written before the stamp existed: the build that last persisted
    // is the best evidence of the shape it was written under; with no stamp
    // at all, the current shape (today's behaviour, and what (c) warns about).
    const resolveVersion = (v: number | undefined): number =>
      v === undefined || v === SYNC_VERSION_UNKNOWN
        ? (ctx.stampedVersions[cell] ?? declared)
        : v;
    // The slice the cell falls back to if its log cannot be folded: the
    // snapshot when there is one, else whatever restore produced (defaults).
    const before = (next as Record<string, unknown>)[cell];
    let fallback: unknown = before;

    // Seed from the compaction snapshot FIRST. Compaction folds ops into
    // sync_snapshots and deletes them, so the surviving log is only the tail —
    // replaying it alone restored the cell to its initialState and then
    // broadcast that emptiness to clients as authoritative (silent data loss
    // on the first restart after 1000 ops).
    let seeded = false;
    // The shape version the current slice is at — undefined until the
    // snapshot or the first op says.
    let current: number | undefined;
    const failures: string[] = [];
    const skipped: { older: number; newer: number } = { older: 0, newer: 0 };
    // Ops stamped with a version the slice has already been migrated past —
    // the downgrade signature, and its own remedy (see `fix` below).
    let downgradeWrites = 0;
    try {
      const snap = await loadSnapshot(db, cell);
      if (snap) {
        const slice = withDefaults(ctx.initialState[cell], snap.state);
        (next as Record<string, unknown>)[cell] = slice;
        fallback = slice;
        seeded = true;
        current = resolveVersion(snap.cellVersion);
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
            await seedSyncSnapshot(db, cell, restored, declared);
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

    // (c) A persisted log/snapshot and no declared version: the next shape
    // change replays blind. One line per cell, dev and prod alike — a refusal
    // would break every existing sync app at once.
    if (declared === 0 && (seeded || ops.length > 0)) {
      log.warn(
        `sync: cell "${cell}" has a persisted op-log and no \`version\` — a ` +
          `shape change will replay old ops blind; declare version: 1 (and ` +
          `onMigrate when the shape changes)`,
      );
      ctx.report?.push({
        cell,
        from: 0,
        to: 0,
        outcome: "sync-unversioned",
      });
    }

    const migrateSlice = (from: number): void => {
      if (!hook) return;
      const slice = (next as Record<string, unknown>)[cell];
      if (!_isObj(slice)) return;
      try {
        (next as Record<string, unknown>)[cell] = hook(slice, from);
        log.info(`sync: migrated cell "${cell}" v${from} → v${declared}`);
        ctx.report?.push({ cell, from, to: declared, outcome: "migrated" });
      } catch (e) {
        failures.push(`onMigrate(v${from}) threw: ${e}`);
      }
    };

    // The snapshot itself may predate the shape. With a hook it is NOT
    // migrated here: the ops written under the same version fold onto it
    // first, and the boundary (below) migrates the whole v-N world at once.
    if (seeded && current !== undefined) {
      if (current > declared) {
        skipped.newer++;
        failures.push(
          `snapshot was written by v${current}, this build declares v${declared} (downgrade)`,
        );
      } else if (current < declared && !hook) {
        // Parity with the KV path: kept as-is, said out loud.
        log.warn(
          `migrate: sync cell "${cell}" snapshot v${current} → v${declared} but no onMigrate hook — state may be stale`,
        );
        ctx.report?.push({
          cell,
          from: current,
          to: declared,
          outcome: "stale",
        });
        current = declared;
      }
    }

    let applied = 0;
    if (failures.length === 0 && ops.length > 0) {
      // CHRONOLOGICAL order — `server_ts`, which is the order the live server
      // applied them and the order `loadOpsSince` already returns. Nothing is
      // re-sorted here.
      //
      // This used to sort by the op's `version` first, on the theory that a
      // shape boundary is a migration point and version is monotonic in
      // server_ts. It is monotonic only while an older build never runs again
      // — and one does: a downgrade quarantines the cell and keeps stamping
      // fresh ops with the OLDER version, which then sorted ahead of
      // chronologically earlier ops. The replay folded a sequence the server
      // never applied (reducers are not commutative), silently, forever.
      // Version now drives the migration ladder only: it says WHEN to migrate
      // between ops, never what order to fold them in.
      const ordered = ops.map((op) => ({ op, v: resolveVersion(op.version) }));
      let first: string | null = null;
      for (const { op, v } of ordered) {
        if (v > declared) {
          skipped.newer++;
          first ??=
            `op ${op.id} (${op.cell}:${op.action}) was written by v${v}, this build declares v${declared} (downgrade)`;
          continue;
        }
        if (v < declared && !hook) {
          skipped.older++;
          first ??=
            `op ${op.id} (${op.cell}:${op.action}) was written by v${v}, this build declares v${declared} and has no onMigrate`;
          continue;
        }
        if (current === undefined) current = v;
        if (v > current) {
          // Boundary: everything at `current` is folded — migrate, then go on.
          migrateSlice(current);
          current = v;
          if (failures.length > 0) break;
        } else if (v < current) {
          // An op written under a shape the state has ALREADY been migrated
          // past — chronologically later, structurally older. There is no
          // honest way to fold it: `onMigrate` runs on the whole slice, not on
          // one op, and the slice is already forward. It means an older build
          // wrote to this log after a newer one did. Refuse it by name.
          skipped.older++;
          downgradeWrites++;
          first ??= `op ${op.id} (${op.cell}:${op.action}) was written by ` +
            `v${v} AFTER v${current} ops — an older build wrote to this ` +
            `log, and the state has already been migrated to v${current}`;
          continue;
        }
        // Persisted, never reduced: boot reduces it whole, later (aio.ts).
        if (opts.defer?.get(cell) === op.serverTs) continue;
        try {
          // Only THIS cell's slice is taken from the fold. The composed
          // reducer also runs every `listensTo` listener of the op, and each
          // of those reactions is already durable by its own cell's rule — a
          // non-sync listener in the KV store, a sync listener in its own
          // snapshot (the live hook folds a reaction there, see
          // `noteServerWrite` in aio.ts's afterAction). Taking the whole root
          // re-applied every surviving op to every non-sync listener on every
          // restart (a tally of 2 came back 4, then 6), and let one sync
          // cell's replay write into another's slice.
          const folded = unwrapReduced(reduce(next, {
            type: `${op.cell}:${op.action}`,
            payload: op.payload,
          })) as Record<string, unknown>;
          next = {
            ...(next as Record<string, unknown>),
            [cell]: folded[cell],
          } as S;
          applied++;
        } catch (e) {
          failures.push(`op ${op.id} (${op.cell}:${op.action}) threw: ${e}`);
        }
      }
      if (first) failures.unshift(first);
    }
    // The last boundary: the world the log/snapshot describe ends below the
    // declared shape (a snapshot-only cell counts — its ops were compacted).
    if (failures.length === 0 && current !== undefined && current < declared) {
      migrateSlice(current);
      current = declared;
    }

    const total = ops.length;
    const bad = failures.length > 0 || skipped.older > 0 || skipped.newer > 0;
    if (!bad) {
      if (total === 0) {
        if (seeded) {
          log.info(`sync: restored cell "${cell}" from snapshot only`);
        }
      } else {
        log.info(`sync: restored cell "${cell}" from ${count(applied, "op")}`);
      }
      continue;
    }

    // ── Quarantine — ONE decider for both modes ───────────────────────
    const failed = total - applied;
    // Three different remedies for three different causes — a wrong fix line
    // is worse than none (the reader trusts it and bumps a version that only
    // needed the newer build back).
    const fix = downgradeWrites > 0
      ? `An OLDER build wrote to "${cell}"'s op-log after a newer one — its ` +
        `ops cannot be folded onto a shape already migrated forward. Run only ` +
        `the newer build (or restore the log from before the downgrade), then ` +
        `restart.`
      : skipped.newer > 0 && skipped.older === 0 && failures.length === 0
      ? `This build declares "${cell}" version ${declared} but the ` +
        `log holds ops from a NEWER shape — run the build that wrote them ` +
        `(a downgrade never folds forward), or bump this build's version.`
      : hook
      ? `Fix "${cell}"'s onMigrate/methods so the op-log folds, then restart.`
      : `Bump "${cell}"'s \`version\` and add an onMigrate(state, from) that ` +
        `converts the older shape, then restart.`;
    const what =
      `${failed}/${count(total, "op")} could not be folded into "${cell}" ` +
      `(${skipped.older} older-shape skipped, ${skipped.newer} newer-shape ` +
      `skipped, ${failures.length} failed) — first: ${failures[0] ?? "n/a"}`;
    if (ctx.dev) {
      throw createAioError(
        "PERSIST_SCHEMA",
        new Error(
          `sync: refusing to boot — ${what}.\n` +
            `NOTHING was written: the op-log and snapshot for "${cell}" are ` +
            `intact on disk. ${fix} (In production the cell is quarantined ` +
            `at its last snapshot and compaction is skipped; dev refuses so ` +
            `you see it first.)`,
        ),
        { cellName: cell },
      );
    }
    (next as Record<string, unknown>)[cell] = fallback;
    ctx.quarantined.add(cell);
    ctx.report?.push({
      cell,
      from: current ?? declared,
      to: declared,
      outcome: "sync-quarantined",
    });
    log.error(
      `sync: cell "${cell}" QUARANTINED — ${what}. The cell runs at its ` +
        `${seeded ? "last snapshot" : "declared defaults"}; its snapshot ` +
        `will not be rewritten and its op-log not compacted, so nothing on ` +
        `disk is lost — and every client op to it is REFUSED at the door ` +
        `with an \`op-rejected\` carrying the reason, rather than ` +
        `acknowledged and then lost on the next restart; a server-origin ` +
        `write is applied in memory only, answered \`unsaved\` and logged. ` +
        `The cell is read-only until this is fixed. ${fix}`,
    );
  }
  return next;
}

/** The format a build that records its reactions stamped this op-log with
 *  (see `REACTIONS_FORMAT_ROW`); undefined when none did. */
export async function reactionsFormat(db: DB): Promise<number | undefined> {
  const { rows } = await db.query<{ v: string }>(
    "SELECT low_water AS v FROM sync_meta WHERE cell = ?",
    [REACTIONS_FORMAT_ROW],
  );
  return rows[0] ? Number(rows[0].v) : undefined;
}

/** A run with the journal OFF over a journal a crash left unreplayed.
 *
 *  Its records are writes (and op records) newer than the store's last save.
 *  This run does not replay them, and its own saves do not move the journal's
 *  watermarks — so left where they are, the next run with the journal on
 *  would replay them as the newest state, over everything this run saved
 *  (a sync cell's state line replaces the slice). So the boot reads the op
 *  records it needs from them (an op a crash caught in flight is resolved as
 *  a journal-on boot resolves it) and then moves them aside
 *  (`moveJournalAside`). Null when there is no such file, or it is empty. */
export async function openStrayJournal(
  path: string,
  appId: string,
  kv: SkvInstance | null,
  syncCellIds: readonly string[],
): Promise<Journal | null> {
  try {
    if (Deno.statSync(path).size === 0) return null;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
  const storedWatermark = kv
    ? await kv.get<number>(journalWatermarkKey(appId)) ?? 0
    : undefined;
  const j = createJournal(path, {
    ...(storedWatermark !== undefined ? { storedWatermark } : {}),
  });
  if (kv) {
    const stored: Record<string, number> = {};
    for (const c of syncCellIds) {
      const at = await kv.get<number>(syncJournalWatermarkKey(appId, c));
      if (typeof at === "number") stored[c] = at;
    }
    j.trackCells(stored);
  }
  return j;
}

/** Move a journal whose tail must never be replayed aside — kept for a
 *  person, never applied, and said loudly with the file named. Nothing when
 *  its tail is empty (the store holds every line). A refused move throws:
 *  running on would lose data silently. */
export function moveJournalAside(
  j: Journal,
  why: "journal-off" | "foreign-save",
  log: Pick<Log, "warn">,
): void {
  const tail = j.readTail();
  if (tail.length === 0) return;
  const to = `${j.path}.unreplayed-${
    new Date().toISOString().replace(/[:.]/g, "-")
  }`;
  j.quarantine(to);
  const what = `${count(tail.length, "record")} (seq ${tail[0]!.seq}–` +
    `${tail.at(-1)!.seq})`;
  log.warn(
    why === "journal-off"
      ? `journal: this run has the journal off, but ${j.path} held ${what} ` +
        `a crash left unreplayed — writes newer than the store's last save. ` +
        `They are NOT applied: this run starts from the saved store without ` +
        `them, and they are moved to ${to} (with ${to}.base) so that no ` +
        `later run replays them over newer data. To recover them, stop, move ` +
        `the file back to ${j.path} and start once with journal: true.`
      : `journal: the store was written outside aio's journalled saves — by ` +
        `an older aio build (the journal off), a tool, or the app's own SQL ` +
        `on a table that mirrors state — after ${j.path} recorded ${what}; ` +
        `replaying them now could roll that newer data back. They are NOT ` +
        `applied, and they are moved to ${to} (with ${to}.base); check what ` +
        `they held against the store.`,
  );
}

/** The ops a clean stop recorded (see `CLEAN_STOP_ROW`): `server_ts` in
 *  (from, to]. Undefined when none (or unreadable). */
export async function cleanStopThrough(
  db: DB,
): Promise<{ from: number; to: number } | undefined> {
  const { rows } = await db.query<{ v: string }>(
    "SELECT low_water AS v FROM sync_meta WHERE cell = ?",
    [CLEAN_STOP_ROW],
  );
  const m = /^(\d+):(\d+)$/.exec(rows[0]?.v ?? "");
  return m ? { from: Number(m[1]), to: Number(m[2]) } : undefined;
}

/** Record a clean stop over `server_ts` (from, to] (see `CLEAN_STOP_ROW`). */
export async function recordCleanStop(
  db: DB,
  from: number,
  to: number,
): Promise<void> {
  await db.execute(
    `INSERT INTO sync_meta (cell, low_water, last_compact, op_count, compacted_ts)
       VALUES (?, ?, 0, 0, 0)
       ON CONFLICT(cell) DO UPDATE SET low_water = excluded.low_water`,
    [CLEAN_STOP_ROW, `${from}:${to}`],
  );
}

/** The highest `server_ts` issued: an op's or a fold's. */
export async function issuedThrough(db: DB): Promise<number> {
  const { rows } = await db.query<{ m: number | null }>(
    "SELECT MAX(v) AS m FROM (SELECT MAX(server_ts) AS v FROM sync_ops " +
      "UNION ALL SELECT MAX(compacted_ts) FROM sync_meta)",
  );
  return rows[0]?.m ?? 0;
}

/** Stamp this op-log with the format this run records its reactions in (see
 *  `REACTIONS_FORMAT_ROW`). */
export async function stampReactions(db: DB, format: number): Promise<void> {
  await db.execute(
    `INSERT INTO sync_meta (cell, low_water, last_compact, op_count, compacted_ts)
       VALUES (?, ?, 0, 0, 0)
       ON CONFLICT(cell) DO UPDATE SET low_water = excluded.low_water`,
    [REACTIONS_FORMAT_ROW, String(format)],
  );
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
  /** Path to the state value this table mirrors; `[]` when unbound. */
  path: string[];
  /** How that value holds its rows (see `DbMapping.shape`). */
  shape: DbBoundShape;
  /** The pk column a `"map"` binding keys by (null for an array binding
   *  without one). */
  pk: string | null;
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
  dbSchema: Record<string, TableDef | DbMapping>,
  log: Pick<Log, "info" | "warn">,
): { bindings: DbBinding[]; sqlSchema: Record<string, TableDef> } {
  const bindings: DbBinding[] = [];
  const sqlSchema: Record<string, TableDef> = {};
  const declaredBy = new Map<string, string>(); // sql table → the db: key
  const candidates = () => {
    const c = _arrayFields(initialState);
    return c.length ? c.join(", ") : "(no cell declares an array field)";
  };

  for (const [key, entry] of Object.entries(dbSchema)) {
    if (entry === null || typeof entry !== "object") {
      throw new Error(
        `db: mapping "${key}" is ${
          entry === undefined
            ? "undefined"
            : `${typeof entry} ${JSON.stringify(entry)}`
        }, not a table. The usual cause is a typo'd or missing import — ` +
          `check the value you passed for "${key}". Each entry is a ` +
          `table({ … }) result, or { table, path, shape }.`,
      );
    }
    let table: string;
    let path: string[];
    const mapping = dbMappingOf(entry);
    const { shape } = mapping;
    const def: TableDef = { ...mapping.table, shape };
    const pk = pkColumn(def);
    // The value at the bound path must hold rows in the declared shape.
    const fits = (v: unknown): boolean =>
      shape === "map" ? _isObj(v) : Array.isArray(v);
    const noun = shape === "map" ? "a pk-keyed object map" : "an ARRAY";
    if (shape === "map" && !pk) {
      throw new Error(
        `db: mapping "${key}" has shape "map" but its table declares no ` +
          `pk() column — a map is keyed by the row's primary key, so there ` +
          `is nothing to key it by. Add \`id: pk()\` (or bind an array).`,
      );
    }
    if (mapping.path !== undefined && !key.includes(".")) {
      throw new Error(
        `db: mapping "${key}" sets path "${mapping.path}" but its key does ` +
          `not name a cell — a path is relative to a cell, so the key must ` +
          `be "<cell>.<field>".`,
      );
    }

    if (key.includes(".")) {
      // Explicit `cell.field` — an intent that must resolve or fail loud.
      const parts = key.split(".");
      const [cellId, field] = parts;
      const slice = cellId === undefined ? undefined : initialState[cellId];
      const inner = mapping.path?.split(".") ?? (field ? [field] : []);
      const target = _isObj(slice) ? readPath(slice, inner) : undefined;
      if (
        parts.length !== 2 || !cellId || !field || !_isObj(slice) ||
        inner.some((seg) => !seg) || !fits(target)
      ) {
        throw new Error(
          `db: table key "${key}" must name ${noun} ` +
            (mapping.path
              ? `at "${mapping.path}" inside a cell`
              : `field of a cell ("<cell>.<field>")`) +
            `, but ${
              !_isObj(slice)
                ? `there is no cell "${cellId}"`
                : `cell "${cellId}" has no ${
                  shape === "map" ? "object" : "array"
                } ${
                  mapping.path ? `at "${inner.join(".")}"` : `field "${field}"`
                }${
                  target !== undefined
                    ? ` (it is ${
                      Array.isArray(target) ? "an array" : typeof target
                    })`
                    : ""
                }`
            }. Available array fields: ${candidates()}.`,
        );
      }
      table = `${cellId}_${field}`;
      path = [cellId, ...inner];
    } else if (shape === "map" && _isObj(initialState[key])) {
      throw new Error(
        `db: mapping "${key}" has shape "map" and names a top-level key — a ` +
          `map binding must be explicit: db: { "<cell>.${key}": { table, ` +
          `shape: "map" } }.`,
      );
    } else if (Array.isArray(initialState[key])) {
      // Root-level array (engine-level `aio.run` config — no cells).
      table = key;
      path = [key];
    } else {
      const owners = Object.keys(initialState).filter((c) =>
        _isObj(initialState[c]) &&
        fits((initialState[c] as Record<string, unknown>)[key])
      );
      if (owners.length > 1) {
        throw new Error(
          `db: table "${key}" is ambiguous — cells ${
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
        `db: keys "${prev}" and "${key}" both map to SQL table ` +
          `"${table}" — one of them would silently share the other's rows. ` +
          `Rename one.`,
      );
    }
    declaredBy.set(table, key);
    sqlSchema[table] = def;
    bindings.push({ table, path, shape, pk });

    if (path.length) {
      log.info(
        `db: table "${table}" ↔ state.${path.join(".")} (auto-sync${
          shape === "map" ? `, map keyed by "${pk}"` : ""
        })`,
      );
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
  bindings: readonly (Pick<DbBinding, "table" | "path"> & Partial<DbBinding>)[],
  loaded: Record<string, unknown[]>,
  log?: (msg: string) => void,
): Record<string, unknown> {
  let next = state;
  for (const b of bindings) {
    if (b.path.length === 0 || !(b.table in loaded)) continue;
    const rows = loaded[b.table]!;
    if (rows.length === 0) {
      const current = readPath(next, b.path);
      const held = Array.isArray(current)
        ? current.length
        : _isObj(current)
        ? Object.keys(current).length
        : 0;
      if (held > 0) {
        log?.(
          `db: table "${b.table}" is empty but state.${
            b.path.join(".")
          } holds ${count(held, "item")} — keeping them and writing them to ` +
            `the table on the next sync (a new binding or a seeded default; ` +
            `an empty table never empties a non-empty ${
              b.shape === "map" ? "map" : "array"
            }).`,
        );
        continue;
      }
    }
    // A map binding is rebuilt from the rows' pk — the one fact the table
    // holds; the key is derived, never stored twice.
    const value: unknown = b.shape === "map" && b.pk
      ? Object.fromEntries(
        (rows as Record<string, unknown>[]).map((r) => [String(r[b.pk!]), r]),
      )
      : rows;
    const placed = writePath(next, b.path, value);
    if (placed !== undefined) next = placed;
  }
  return next;
}

/** `state` with `value` at `path`, copy-on-write along the path only; the
 *  parents on the way must be plain objects (a vanished cell, or a non-object
 *  parent, returns undefined — never clobbered). */
function writePath(
  state: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> | undefined {
  const [head, ...rest] = path as [string, ...string[]];
  if (rest.length === 0) return { ...state, [head]: value };
  const child = state[head];
  if (!_isObj(child)) return undefined;
  const next = writePath(child, rest, value);
  return next === undefined ? undefined : { ...state, [head]: next };
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
  /** The store held a saved state at boot — it has saved at least once. */
  storeHeldState?: boolean;
}

/** Delete the slices of `persist: "none"` cells that an OLDER build (or a
 *  downgrade) left in the store — and make the delete reach the disk.
 *
 *  A plain SQLite delete only unlinks: the row's bytes sit in a free page, and
 *  in the -wal, until something happens to reuse them. For the slice of a
 *  cell that declared it must never be kept (a session token, a passphrase),
 *  "gone from the table" is not "gone". So, for this one rare delete only:
 *  `secure_delete` ON (per connection — the app db is one writer worker, and
 *  nothing else runs this early in boot), delete, restore the previous
 *  setting, then `VACUUM` (older revisions of the slice sit in pages earlier
 *  saves already freed) and `wal_checkpoint(TRUNCATE)` so the old frames
 *  leave the -wal too. Every ordinary write keeps its speed. Single layout: the one blob is
 *  rewritten without the slice (the old blob's page is zeroed as it is freed);
 *  multi layout: the slice's rows are deleted. */
async function scrubStaleSlices(
  db: DB,
  kv: SkvInstance,
  persistKey: string,
  persistMode: "single" | "multi",
  stale: string[],
): Promise<void> {
  const was = (await db.query<{ secure_delete: number }>(
    "PRAGMA secure_delete",
  )).rows[0]?.secure_delete === 1;
  await db.execute("PRAGMA secure_delete = 1");
  try {
    if (persistMode === "multi") {
      await kv.setMulti(persistKey, {}, stale);
    } else {
      const doc = await kv.get<Record<string, unknown>>(persistKey);
      if (doc) {
        const rest = { ...doc };
        for (const k of stale) delete rest[k];
        await kv.set(persistKey, rest);
      }
    }
  } finally {
    await db.execute(`PRAGMA secure_delete = ${was ? 1 : 0}`);
  }
  // secure_delete zeroes what THIS delete frees — not the older revisions of
  // the slice, which every earlier save left in pages SQLite had already
  // freed (tests/hosts.test.ts plants several and finds them). VACUUM
  // rebuilds the file from the live rows only; the checkpoint then moves it
  // out of the WAL and truncates that too.
  await db.execute("VACUUM");
  await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
}

/** A stored document minus the declared cells that must never come back
 *  (outside `persistingCellIds` — i.e. `persist: "none"`). Undeclared keys
 *  (renamed cells, parked `__` slices) pass: boot handles those itself. */
function restorableSlices(
  stored: Record<string, unknown>,
  persisting: readonly string[],
  declared: Record<string, unknown>,
): Record<string, unknown> {
  const keep = new Set(persisting);
  return Object.fromEntries(
    Object.entries(stored).filter(([k]) => !(k in declared) || keep.has(k)),
  );
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
    cellRestores,
    onCheckpointRestore,
    diagHooks,
    healthGetter,
    getDBState,
    getState,
    getReportOpts,
    log,
  } = cfg;

  // The dev checkpoint never holds a `persist: "none"` cell — from the first
  // dispatch on (diagnostics/checkpoint.ts `CheckpointView`).
  // Whole cells only, never the store's SHAPE: the checkpoint is handed to
  // `onCheckpointRestore` and assigned into live state with no `onRestore`,
  // so an `onPersist`-shaped or field-filtered slice would land there as-is.
  const persisting = cfg.persistingCellIds;
  if (persisting) {
    diagHooks?.setCheckpointView?.((s) =>
      restorableSlices(s, persisting, initialState as Record<string, unknown>)
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
    const open = () =>
      createDB(dbPath, dbPragmas ? { pragmas: dbPragmas } : {});
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
      if (asyncDb) {
        await asyncDb.close().catch(() => {});
        asyncDb = null;
      }
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
        const stale = Object.keys(migrated).filter((k) => !(k in kept));
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
      if (!(cell in declared)) continue;
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
                [...shapedCells].filter((c) => c in schema).map((
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
      const structural = drift.filter((d) =>
        d.issue === "unknown-field" || d.issue === "type-changed"
      );
      if (isDevBoot() && structural.length > 0) {
        const dirs = appDirs(appId, cfg.appDir);
        const appsDir = appsDirEnv();
        throw new Error(shapeDriftRefusal(structural, summary, {
          dataDir: dirs.data,
          dbPath: openedDbPath ?? dirs.stateDb,
          appsDir: appsDir && dirs.home === join(appsDir, appId)
            ? appsDir
            : undefined,
        }));
      }
      log.warn(summary);
    }
    // …and the SAFE direction, said out loud. Adding a field needs no
    // migration, but silence about it is indistinguishable from silence about
    // a problem nobody looked for — the complaint that produced this line.
    const added = detectNewFields(
      schema,
      persistedSnapshot,
      { skip: new Set(report.map((r) => r.cell)) },
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
      const raw = diagHooks.getRecoveredState()!;
      // …and what comes BACK is the restore half of the same rule: a
      // checkpoint an older build wrote raw still holds `persist: "none"`
      // slices, and the app's hook would hand them straight back.
      const recovered = cfg.persistingCellIds
        ? {
          ...raw,
          state: restorableSlices(
            raw.state,
            cfg.persistingCellIds,
            initialState as Record<string, unknown>,
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
        ...(storedWatermark !== undefined ? { storedWatermark } : {}),
      },
    )
    : null;
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
  const writeGuard = shouldPersist
    ? createDeclaredShapeGuard({
      template: initialState as Record<string, unknown>,
      persist: cfg.cellPersist,
      skip: new Set([
        ...syncCellIds,
        ...(migrations?.report ?? []).map((r) => r.cell),
      ]),
      unknownKeys: (declared, written) =>
        detectShapeDrift({ c: declared }, { c: written })
          .filter((d) =>
            d.issue === "unknown-field" && d.storedType !== "undefined"
          )
          .map((d) => d.path),
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
    appId,
    getJournalSeq: journal ? () => journal.capture() : undefined,
    onPersisted: journal ? (seq) => journal.setWatermark(seq) : undefined,
    ...(journal && journalWmStored
      ? {
        planPersisted: (seq: number) =>
          kvDb!.planSet!(journalWatermarkKey(appId), seq),
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
    storeHeldState: hadPersistedState,
    strayJournal,
    storeSavedElsewhere,
  };
}

/** Same JSON document, key order aside — the two layouts read back through
 *  different paths (one blob vs rows ordered by key), so their key order can
 *  differ while every value agrees. */
function sameDocument(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
        Object.keys(v as Record<string, unknown>).sort().map((k) => [
          k,
          canon((v as Record<string, unknown>)[k]),
        ]),
      )
      : Array.isArray(v)
      ? v.map(canon)
      : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
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
  const retireOther = async (other: Record<string, unknown>) => {
    if (otherMode === "single") await kvDb.del(persistKey);
    else await kvDb.setMulti(persistKey, {}, Object.keys(other));
  };

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
          count(
            Object.keys(other).length,
            "key",
          )
        }) — migrating it to "${persistMode}" now. Booting empty over ` +
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
    await retireOther(other);
    log.info(
      `persist: migrated the stored document ${otherMode} → ${persistMode} ` +
        `(${count(Object.keys(other).length, "key")})`,
    );
    persisted = verified;
  } else if (persisted && other && sameDocument(persisted, other)) {
    // Both layouts, byte-for-byte the SAME document: not an ambiguity but the
    // exact signature of the migration above dying between its copy and its
    // retire. Left alone, this used to take the branch below on every boot —
    // the app wrote to its layout, the twin stayed frozen at the crash, and
    // the next switch back booted on the twin: every acknowledged write since
    // silently gone from view. Retiring an identical copy loses nothing.
    await retireOther(other);
    log.warn(
      `persist: finished an interrupted ${otherMode} → ${persistMode} ` +
        `layout migration — the "${otherMode}" copy was identical to the ` +
        `"${persistMode}" one and has been retired (${
          count(Object.keys(other).length, "key")
        })`,
    );
  } else if (persisted && other) {
    // Both layouts hold data — an older aio, or a hand-edited store. Never
    // guess which is newer; boot on the configured one and say what is being
    // ignored, byte for byte still on disk.
    log.warn(
      `persist: stored state exists in BOTH layouts. Booting on the ` +
        `"${persistMode}" one (persistMode); the "${otherMode}" copy (${
          count(
            Object.keys(other).length,
            "key",
          )
        }) is IGNORED and left untouched — switch persistMode to read ` +
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
// ONE cap with the restore: `deepMerge` prunes undeclared keys down to its
// stack guard and keeps everything below it verbatim (and says so). A drift
// walk that stopped earlier (it was 8) let the merge DROP a field 9+ levels
// down with no drift line — dev booted, prod did not warn. The merge starts
// at the whole state (depth 0 = the cells), this walk at one cell's slice, so
// the same cut is one level less here.
const DRIFT_MAX_DEPTH = DEEP_MERGE_MAX_DEPTH - 1;

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
    // `null` on either side carries NO shape, so there is nothing to compare
    // and nothing to migrate. `T | null` is how every app spells "not yet":
    // `user: null`, `vault: null`, `me: null` in `initialState`, holding an
    // object the moment someone signs in. Reading the declared `null` as a
    // schema made that ordinary case look like a type change, and dev REFUSED
    // TO BOOT for every app that had ever been used once — the drift this
    // check exists for is a field renamed or removed (declared `undefined`),
    // which is still caught below.
    if (dk === "null" || sk === "null") return;
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
  | "stamped" // first `version` this cell ever declared — nothing to convert
  | "downgrade" // stored version NEWER than code — running old code on new data
  | "sync-quarantined" // a sync cell's op-log could not be folded — held at its snapshot
  | "sync-unversioned"; // a sync cell has a persisted log and no `version` (field report §3.1)
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

/** One field the code declares that the stored snapshot does not have — a NEW
 *  state key. */
export type ShapeAdditionEntry = {
  cell: string;
  /** Dotted path within the cell. */
  path: string;
  /** The declared type, so the line can say what arrived. */
  declaredType: string;
};

/** Declared fields absent from the stored snapshot.
 *
 *  THE OTHER HALF OF `detectShapeDrift`, and the reason it exists: adding a
 *  field is SAFE — a stored blob without it deep-merges and the declared value
 *  fills the gap — but the author of one report had to reason that out from
 *  first principles, because the tool said nothing (report 8 §10). Silence
 *  on the safe case and a loud warning on the unsafe one are indistinguishable
 *  from "nobody checked": both are the absence of a sentence. The detector
 *  already walks both shapes; it simply threw this direction away.
 *
 *  A SEPARATE type and a separate line, not a fifth `issue` on
 *  `ShapeDriftEntry`, because the remedy is different — there isn't one — and
 *  because a reader scanning for problems must not have to filter the
 *  reassurance out of the warning.
 *
 *  Same caps and the same rules as the drift walk: an empty declared object is
 *  an open record (a dynamic-key map), so its keys are data rather than shape,
 *  and nothing inside one is reported. */
export function detectNewFields(
  initial: Record<string, unknown>,
  stored: Record<string, unknown>,
  opts: { skip?: Set<string> } = {},
): ShapeAdditionEntry[] {
  const out: ShapeAdditionEntry[] = [];
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
    if (out.length >= MAX_DRIFT || depth > DRIFT_MAX_DEPTH) return;
    if (!isPlainObj(decl)) return;
    // An open record declares no keys, so it has no new ones — everything in
    // it is data.
    if (Object.keys(decl).length === 0) return;
    if (!isPlainObj(stor)) return;
    for (const [k, dv] of Object.entries(decl)) {
      // CHECKED IN THE LOOP, not only on entry. A single level with 300 new
      // keys pushes 300 before the next call ever tests the cap, which is
      // exactly the unbounded report the cap exists to prevent.
      if (out.length >= MAX_DRIFT) return;
      const p = path ? `${path}.${k}` : k;
      if (!(k in stor)) {
        out.push({ cell, path: p, declaredType: kindOf(dv) });
        // Do not descend into a field that is wholly new: "cfg.retry arrived"
        // is the fact, and listing its five sub-keys as five more arrivals is
        // the same news five times.
        continue;
      }
      walk(cell, dv, stor[k], p, depth + 1);
    }
  };

  for (const [cellId, declState] of Object.entries(initial)) {
    if (skip.has(cellId)) continue;
    const storedCell = stored[cellId];
    // A cell absent from storage entirely is a NEW CELL, not a new field. It
    // is its own event (nothing was persisted for it yet), and reporting every
    // one of its keys as an addition would bury a real one on the first boot
    // after `am create`.
    if (storedCell === undefined) continue;
    walk(cellId, declState, storedCell, "", 0);
  }
  return out;
}

/** The reassuring counterpart to {@linkcode shapeDriftSummary}. */
export function newFieldsSummary(added: ShapeAdditionEntry[]): string {
  if (added.length === 0) return "";
  const show = added.slice(0, 5).map((a) =>
    `${a.cell}.${a.path} (${a.declaredType})`
  );
  const more = added.length > show.length
    ? ` …and ${added.length - show.length} more`
    : "";
  // NOT "new field(s)": the stored data cannot say WHY a declared key is
  // missing. A field this build added is one reason; a method that ran
  // `delete s.key` is the other — and calling that resurrection "new … safe"
  // hid that the delete never survived the restart.
  return `state shape: ${added.length} declared field(s) not in the stored ` +
    `data, filled from \`state:\` — no migration needed — ` +
    `${show.join(", ")}${more}. Either the field is new in this build ` +
    `(adding one is safe on its own), or a method deleted it — a deleted ` +
    `declared key always comes back with its default (write null to clear ` +
    `one). (Renaming or removing a field from \`state:\` is not safe — that ` +
    `is the "shape drift" line.)`;
}

/** A persisted-document getter that also shows each document to `watch`. The
 *  watcher is observe-only: a throw inside it is swallowed with a note, so a
 *  diagnostic can never become the reason a write did not happen. */
function withRestoreDropWatch(
  get: (s: Record<string, unknown>) => unknown,
  watch: (doc: unknown) => void,
  warn: (msg: string) => void,
): (s: Record<string, unknown>) => unknown {
  return (s) => {
    const doc = get(s);
    try {
      watch(doc);
    } catch (e) {
      warn(`persist (dev): the restore-drop check itself threw — ${e}`);
    }
    return doc;
  };
}

/** Dev only: name — once per path — a value this app WRITES that the next
 *  boot will not restore.
 *
 *  A method that adds a key to a declared non-empty object (`opts: { a: 1 }`,
 *  then `s.opts.b = 3`) or changes a field's type persisted it faithfully, and
 *  nothing was said until the NEXT boot: dev refused to start over it, and
 *  production restored without it and wrote that back, so it was gone. The
 *  same `detectShapeDrift` the boot check runs, pointed at the document being
 *  written instead of the one being read, says it while the code that wrote
 *  it is still on screen.
 *
 *  Only cells whose slice changed since the last write are walked, and the
 *  walk is the boot check's (depth- and count-capped). `skip` holds cells a
 *  migration handled this boot — a downgrade deliberately carries fields this
 *  build does not declare. */
export function restoreDropWatcher(
  initial: Record<string, unknown>,
  skip: ReadonlySet<string>,
  warn: (msg: string) => void,
  /** `cell.path` strings already said — shared with the write-time guard
   *  (declared-shape-guard.ts), which names the method, so one fact is one
   *  line. */
  said: Set<string> = new Set<string>(),
): (doc: unknown) => void {
  const lastSlice = new Map<string, unknown>();
  return (doc) => {
    if (!_isObj(doc)) return;
    const changed: Record<string, unknown> = {};
    for (const [cell, slice] of Object.entries(doc)) {
      if (skip.has(cell) || !(cell in initial)) continue;
      if (lastSlice.get(cell) === slice) continue;
      lastSlice.set(cell, slice);
      changed[cell] = slice;
    }
    // A `null` over a declared object is not drift to the boot check (`T |
    // null` is ordinary), but restore does not keep it — see
    // `reportNullHealed` in deep-merge.ts. Said here, where it is written.
    const nulls: string[] = [];
    const walkNulls = (decl: unknown, stor: unknown, at: string, depth = 0) => {
      if (!_isObj(decl) || !_isObj(stor) || depth > 8) return;
      if (Object.keys(decl).length === 0) return; // an open record: keys are data
      for (const k of Object.keys(stor)) {
        if (nulls.length >= 20 || !Object.hasOwn(decl, k)) continue;
        if (stor[k] === null && _isObj(decl[k])) nulls.push(`${at}.${k}`);
        else walkNulls(decl[k], stor[k], `${at}.${k}`, depth + 1);
      }
    };
    for (const [cell, slice] of Object.entries(changed)) {
      walkNulls(initial[cell], slice, cell);
    }
    for (const where of nulls) {
      if (said.has(where)) continue;
      said.add(where);
      warn(
        `persist (dev): ${where} is being written as null but is declared as ` +
          `an object in the cell's \`state:\` — the next boot restores the ` +
          `declared default instead of the null (a declared object never ` +
          `takes a stored null). If null is a value it holds, declare it ` +
          `\`null as T | null\`.`,
      );
    }
    for (const d of detectShapeDrift(initial, changed)) {
      if (d.issue !== "unknown-field" && d.issue !== "type-changed") continue;
      // An undeclared key holding `undefined` loses nothing: JSON never
      // stores the key, so the next boot reads it absent — `undefined`, the
      // value that was written. The boot check never sees it either, so
      // "dev refuses to boot over it … declare a default" was advice about a
      // refusal that cannot happen (`clear() { s.meta = { a: 2, b: undefined } }`).
      if (d.issue === "unknown-field" && d.storedType === "undefined") continue;
      const where = d.path ? `${d.cell}.${d.path}` : d.cell;
      if (said.has(where)) continue;
      said.add(where);
      const dot = where.lastIndexOf(".");
      const parent = dot > 0 ? where.slice(where.indexOf(".") + 1, dot) : "";
      // A DECLARED key written as `undefined` does come back different — the
      // key is dropped, so restore puts the declared default back — but again
      // nothing is stored for dev to refuse over, so it gets its own sentence.
      if (d.storedType === "undefined") {
        warn(
          `persist (dev): ${where} is being written as undefined, which JSON ` +
            `does not store — the key is dropped, so the next boot restores ` +
            `the declared ${d.declaredType} default instead. For "no value" ` +
            `write null (declare it \`null as T | null\`).`,
        );
        continue;
      }
      warn(
        d.issue === "unknown-field"
          ? `persist (dev): ${where} (${d.storedType}) is being written but is ` +
            `not declared in the cell's \`state:\` — the next boot will NOT ` +
            `restore it (dev refuses to boot over it; production boots without ` +
            `it and its next write deletes it). Declare it with a default` +
            `${
              parent
                ? `, or declare \`${parent}\` as \`{}\` if its keys are data`
                : ""
            }.`
          : `persist (dev): ${where} is being written as ${d.storedType} but ` +
            `is declared ${d.declaredType} in the cell's \`state:\` — the next ` +
            `boot restores the declared default instead (dev refuses to boot ` +
            `over it). Keep the declared type, or change the declaration.`,
      );
    }
  };
}

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
      `declared shape — ${show.join(", ")}${more}. ` +
      // This used to say the stale value stays on disk ("persistence
      // preserves it"). Measured: it does not. Restore drops an undeclared
      // field from live state and puts the DECLARED default back over a
      // changed type, and the first write after boot — which happens on boot,
      // before any method runs — stores exactly that. A warning promising the
      // data was safe is how the one copy of it was lost without anyone
      // looking.
      (drift.some((d) => d.issue !== "unknown-cell")
        ? `Those stored fields are NOT restored — live state drops an ` +
          `undeclared field and takes the declared default for a changed ` +
          `type — and the next write replaces them on disk too, so they are ` +
          `gone after this boot. If the app still writes the field, declare ` +
          `it in \`state:\` (or declare the object as \`{}\`, an open ` +
          `record). If it was renamed, bump the cell's version + add ` +
          `onMigrate to carry it over, before this build writes.`
        : "") +
      (drift.some((d) => d.issue === "unknown-cell")
        ? `${
          drift.some((d) => d.issue !== "unknown-cell") ? " " : ""
        }A stored cell no longer declared is kept on disk verbatim, but is ` +
          `not in live state — declare the cell again, or clear its data.`
        : ""),
  );
  return lines.join("\n");
}

/** The dev-mode refusal for unmigrated structural drift: per cell, the
 *  drifted keys, then the two ways out. Pure — testable without a boot. */
export function shapeDriftRefusal(
  structural: ShapeDriftEntry[],
  summary: string,
  store?: DriftStore,
): string {
  const byCell = new Map<string, string[]>();
  for (const d of structural) {
    const keys = byCell.get(d.cell) ?? [];
    keys.push(
      d.issue === "type-changed"
        ? `${d.path} (${d.storedType} stored, ${d.declaredType} declared)`
        : `${d.path} (stored, not declared)`,
    );
    byCell.set(d.cell, keys);
  }
  const cells = [...byCell].map(([cell, keys]) =>
    `  cell "${cell}": ${keys.join(", ")}`
  );
  return (
    `persist: REFUSING to boot (dev) — ${structural.length} stored field(s) ` +
    `no longer match the declared shape and no onMigrate accounts for ` +
    `them:\n${cells.join("\n")}\n` +
    `fix: bump the cell's \`version\` and add \`onMigrate\` to transform ` +
    `the stored slice — or, if the field is not meant to persist at all, ` +
    `exclude it (\`persist: { exclude: [...] }\`); if the app writes it on ` +
    `purpose, declare it in \`state:\`. In production this is a ` +
    `warning and those stored values are dropped by the first write; dev ` +
    `refuses so it is fixed before it ships.\n` +
    (store ? driftStoreLines(store) : "") +
    `(${summary})`
  );
}

/** Where the drifted data actually lives — the paths THIS boot opened. */
export type DriftStore = {
  /** The app's `data/` directory (appDirs(appId).data) — the backup unit. */
  dataDir: string;
  /** The SQLite file persistence read from (differs under `dbPath`). */
  dbPath: string;
  /** `AIO_APPS_DIR` when it placed the home, so an `am` run in a shell
   *  without it (which resolves `~/.<appId>`) is not a surprise. */
  appsDir?: string;
};

/** The refusal's "where, and the way out" lines (report 9b §2). The message
 *  named the cell, the key and the fix, and then "clear the stored data" with
 *  no path: the boot banner's `data` row would have answered it, but the
 *  refusal comes first, so the banner never prints. An agent spent six
 *  minutes in whole-disk `find` for a directory `appHome()` already knew.
 *  The path printed is the one opened, never re-derived. */
function driftStoreLines(store: DriftStore): string {
  const q = (p: string) => /^[\w./~:@+-]+$/.test(p) ? p : JSON.stringify(p);
  const inData = resolve(store.dbPath).startsWith(
    resolve(store.dataDir) + SEPARATOR,
  );
  const env = store.appsDir
    ? ` (placed by AIO_APPS_DIR=${store.appsDir} ` +
      `— run \`am\` with the same AIO_APPS_DIR)`
    : "";
  return (
    `data: ${store.dataDir}${env} — \`am data\` lists every path\n` +
    (inData ? "" : `db: ${store.dbPath} (dbPath — outside the data dir)\n`) +
    `start fresh (DISCARDS the stored state): \`am backup\`, then ` +
    (inData
      ? `\`rm -r ${q(store.dataDir)}\``
      : `\`rm ${q(store.dbPath)} ${q(store.dbPath + "-wal")} ${
        q(store.dbPath + "-shm")
      }\``) +
    `\n` +
    // The escape that keeps this data untouched. Not under AIO_APPS_DIR:
    // there `--instance` is ignored (said loudly), so offering it misleads.
    (store.appsDir
      ? ""
      : `or run this build against a PRIVATE, empty data home and leave ` +
        `this one untouched: \`am start --instance=<name>\`\n`)
  );
}

/** Stored values the declared shape dropped, put back — deep, depth-capped.
 *  `deepMerge` uses `initialState` as the template and drops every stored key
 *  the running build does not declare. That is right for a rename; it is data
 *  loss for a DOWNGRADE, where the "unknown" fields are what a NEWER build
 *  wrote and a later roll-forward still needs. Declared keys are untouched —
 *  the running build's types win for anything it actually reads. */
/** One cell's `onRestore`, run the way boot runs it — error-guarded: a throw
 *  is logged and the slice is kept as it was.
 *
 *  `shaped` is set for a cell whose `onPersist` SHAPES what it writes. The
 *  restore merge drops every stored key the cell does not declare, and a
 *  reshape stores exactly such keys: the documented pair —
 *  `onPersist: (s) => ({ key: s.thumbKey })`, `onRestore` reading `s.key` —
 *  had its `key` pruned before the hook ran, so the value was gone (and dev
 *  refused to boot over the "drift"). The hook is handed the declared shape
 *  PLUS what the store holds, the way `onMigrate` is, and what it returns is
 *  narrowed back to the declared shape with the restore's own merge.
 *
 *  `retyped`: a stored value whose TYPE differs from the declared one is
 *  handed over too. The merge keeps the declared value on a type mismatch
 *  (schema wins), and a shape that changes a type is the ordinary compact
 *  one — `onPersist: (s) => ({ items: Object.values(s.items) })` stores a
 *  list where a record is declared — so its partner was handed `items: {}`
 *  and the list was gone. Off for a cell the migration pass rewrote this
 *  boot: its slice is the migration's, not the store's. */
/** Throw when a restore hook handed back a THENABLE instead of state.
 *
 *  Restore runs before the server starts and is awaited nowhere, so
 *  `onRestore: async (s) => …` returns a Promise. A Promise is an object, so
 *  every shape check passed it: the app-level hook made the whole app state a
 *  Promise (`Object.keys` of one is `[]`, so boot reported "state: 0 keys" and
 *  started), and a cell's made that cell's slice one — every read `undefined`,
 *  every method writing into a Promise, and the first persist storing `{}`
 *  over the real data. Both hooks are error-guarded, so this is reported and
 *  the restored state kept. */
function refuseThenable(v: unknown): void {
  if (
    v !== null && typeof v === "object" &&
    typeof (v as { then?: unknown }).then === "function"
  ) {
    throw new Error(
      `returned a Promise — the restore hooks are SYNCHRONOUS (they run ` +
        `before the server starts and nothing awaits them), so an \`async\` ` +
        `hook hands back a Promise instead of state. Drop the \`async\` and ` +
        `do the awaiting work in \`onStart\` instead.`,
    );
  }
}

export function runCellRestore(
  id: string,
  hook: (state: Record<string, unknown>) => Record<string, unknown> | void,
  slice: Record<string, unknown>,
  shaped:
    | { stored: unknown; declared: unknown; retyped?: boolean }
    | undefined,
  log: Log,
): Record<string, unknown> {
  try {
    const input = shaped && _isObj(shaped.stored)
      ? reattachUndeclared(slice, shaped.stored, 0, shaped.retyped === true)
      : slice;
    const next = hook(input);
    refuseThenable(next);
    const out = next !== undefined ? next : input;
    return shaped && _isObj(shaped.declared) && _isObj(out) && out !== slice
      ? deepMerge(shaped.declared, out)
      : out;
  } catch (e) {
    log.error(`hook onRestore(${id}): ${e}`);
    return slice;
  }
}

export function reattachUndeclared(
  merged: Record<string, unknown>,
  stored: Record<string, unknown>,
  depth = 0,
  /** Also hand back a stored value the merge refused for its TYPE (never a
   *  stored `null`, which carries no type) — see `runCellRestore`. */
  retyped = false,
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
        retyped,
      );
      if (child !== out[k]) out = { ...out, [k]: child };
    } else if (
      retyped && out[k] !== null && stored[k] !== null &&
      kindOf(out[k]) !== kindOf(stored[k])
    ) {
      out = { ...out, [k]: stored[k] };
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
  /** The declared `initialState` — onMigrate's result is narrowed to it.
   *  Omitted ⇒ the result is taken as-is (the pure unit tests). */
  initialState?: Record<string, unknown>,
  /** Cells whose `onPersist` SHAPES what they store → what that shape looks
   *  like for the declared state (as stored). Their migration is handed the
   *  stored value even where its TYPE differs from the declared one (a record
   *  stored as a list), its output is read against the shape as well as the
   *  declaration, and the raw output is left in `migratedRaw` so the cell's
   *  `onRestore` receives it the way it receives a stored slice. */
  shaped?: {
    schema: Record<string, unknown>;
    migratedRaw: Map<string, Record<string, unknown>>;
  },
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
          // A shaped cell stores its SHAPE, whose field types may differ from
          // the declaration (a record stored as a list): the merge kept the
          // declared `{}` there, so hand the stored value back — the data the
          // migration exists to carry over.
          const shape = shaped && cellId in shaped.schema
            ? shaped.schema[cellId]
            : undefined;
          const input = _isObj(stored)
            ? reattachUndeclared(cellState, stored, 0, shape !== undefined)
            : cellState;
          const migrated = info.onMigrate(input, persisted);
          // The hook was HANDED the undeclared stored keys (so a rename can
          // read the old field) — whatever it leaves behind is not this
          // build's shape. Kept, it rode into the next write and the FOLLOWING
          // boot refused over "shape drift" the migration had just handled.
          // Narrow with the SAME merge the restore runs, so this boot's state
          // is exactly what the next boot will restore.
          const declared = initialState?.[cellId];
          if (_isObj(declared) && _isObj(migrated)) {
            const off = (schema: unknown) =>
              new Set(
                detectShapeDrift(
                  { [cellId]: schema },
                  { [cellId]: migrated },
                ).filter((d) =>
                  d.issue === "unknown-field" || d.issue === "type-changed"
                ).map((d) => d.path),
              );
            // A shaped cell's output may be in the STORED form (what it was
            // handed): a field is dropped only when it fits neither the
            // declaration nor the shape. What fits the shape is its
            // `onRestore`'s to turn back, exactly as on every other boot.
            const offShape = _isObj(shape) ? off(shape) : undefined;
            const dropped = detectShapeDrift(
              { [cellId]: declared },
              { [cellId]: migrated },
            ).filter((d) =>
              (d.issue === "unknown-field" || d.issue === "type-changed") &&
              (!offShape || offShape.has(d.path))
            );
            if (_isObj(shape)) shaped!.migratedRaw.set(cellId, migrated);
            if (dropped.length) {
              log.warn(
                `migrate: ${cellId} onMigrate (v${persisted} → ` +
                  `v${info.version}) left ${dropped.length} field(s) this ` +
                  `build does not declare — ${
                    dropped.map((d) => d.path).join(", ")
                  } — dropped from state, and from disk at the first write. ` +
                  `The migration owned this version, so that is taken as ` +
                  `meant; declare a field in \`state:\` to keep it.`,
              );
            }
            stateObj[cellId] = deepMerge(declared, migrated);
          } else {
            stateObj[cellId] = migrated;
          }
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
        // `persisted === 0` means NEVER STAMPED, not "version zero". The shape
        // on disk is the shape this build writes; nothing migrated, and there
        // is nothing a hook could have done. Warning here fired once per cell
        // on the first boot after an app adopts `version:` — twenty lines of
        // "may be stale" about data that is not, which is how the real warning
        // (a version GAP with no hook) gets skipped.
        const firstStamp = persisted === 0;
        if (firstStamp) {
          log.info(
            `migrate: stamping ${cellId} at version ${info.version} — first ` +
              `time this cell declares one, so there is no older shape to ` +
              `convert`,
          );
        } else {
          log.warn(
            `migrate: ${cellId} version ${persisted} → ${info.version} but no onMigrate hook — state may be stale`,
          );
        }
        report.push({
          cell: cellId,
          from: persisted,
          to: info.version,
          outcome: firstStamp ? "stamped" : "stale",
        });
      }
    }
  }
  return report;
}
