// Boot sync replay — the replay context registry, the dev/prod decider, and
// the replay of journalled sync ops and reactions into restored state, with
// the stray-journal and clean-stop bookkeeping around it. Split out of
// aio-boot.ts, which re-exports every name here, so no importer changes.

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
import type { DB } from "../db/types.ts";
import type {
  CellMigrationInfo,
  MigrationReport,
} from "../state/cell-migrate.ts";
import { isCompiled } from "./paths.ts";
import { prodRequested } from "./aio-cli.ts";
import { SYNC_VERSION_UNKNOWN } from "../sync/compact.ts";
import { applyStatePatch } from "../sync/state-patch.ts";
import { resolve } from "@std/path";
import { createAioError } from "../diagnostics/error.ts";
import type { Log } from "../diagnostics/logger-api.ts";
import {
  getCompactedTs,
  getLowWater,
  loadOpsSince,
  loadSnapshot,
  seedSyncSnapshot,
  settleOp,
} from "../sync/server-store.ts";
import { takeRejectionFor } from "../state/rejection-tracker.ts";
import { opKey } from "./op-placement.ts";
import { count } from "../diagnostics/fmt.ts";
import { _isObj } from "./boot-db-bindings.ts";

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
  /** Where the database is on disk, when it is — a repair the replay asks
   *  for by hand names the file. */
  dbPath?: string;
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
 *  `parseCli().prod` reads too; it is used directly because the `__aioDev`
 *  stamp in aio-boot.ts runs at import, before the app's own flags are
 *  declared.) */
export function isDevBoot(): boolean {
  return !prodRequested() && !isCompiled();
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
    /** The ops whose COMMIT the journal holds (`opKey` — journal.ts
     *  `SYNC_APPLIED_TYPE`): reduced by the run that wrote them, their
     *  reactions replayed from the journal. Never one a kill caught in
     *  flight, whatever its row's mark says. */
    committed?: ReadonlySet<string>;
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
    // v0 means NEVER VERSIONED, not "an older shape" — the KV path's rule
    // (`firstStamp` in the KV migration). A cell that first declares a
    // `version` with no `onMigrate` is naming the shape it already has, which
    // is exactly what the unversioned-log hint (c) below tells the author to
    // do ("declare version: 1"). Following that advice used to REFUSE the boot
    // in dev and quarantine the cell in prod: every v0 op was "older, no hook".
    const adoptV0 = declared > 0 && !hook;
    let adoptedV0 = false;
    const resolveVersion = (v: number | undefined): number => {
      const r = v === undefined || v === SYNC_VERSION_UNKNOWN
        ? (ctx.stampedVersions[cell] ?? declared)
        : v;
      if (r === 0 && adoptV0) {
        adoptedV0 = true;
        return declared;
      }
      return r;
    };
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
    // The cell's LAST row, stored and never settled (`settleOp`): the process
    // died between its persist and the answer to its author — nobody was
    // told it landed. A refusal of it here is the refusal the live server
    // was about to give (or gave, and died before deleting the row): the row
    // goes, as the live server removes it, and its author's resend meets the
    // same decision. Only the last row: a cell's next op is persisted after
    // this one's dispatch settled, so an unmarked row with one after it was
    // decided by a run that went on — its mark or its delete failed, said
    // then — and is folded as any other. A row no build marked (NULL) is
    // never taken for one: nothing proves it was not acknowledged.
    const last = ops.at(-1);
    const lastId = last?.id;
    /** The last row's mark: 0 unsettled, 1 settled, null no build marked it. */
    let lastMark = last === undefined
      ? undefined
      : (await db.query<{ settled: number | null }>(
        "SELECT settled FROM sync_ops WHERE id = ?",
        [last.id],
      )).rows[0]?.settled;
    // …and never one the journal holds the COMMIT of: that run reduced it
    // and journalled its reactions (a kill between the commit and the mark).
    // The mark that run owed is written NOW, whether or not the cell folds:
    // the commit line is the only proof the op was accepted, and a clean
    // stop compacts it away — a cell quarantined at this boot met its next
    // one with an unmarked last row and no commit, and the row was removed
    // as one nobody accepted.
    if (
      lastMark === 0 &&
      opts.committed?.has(opKey(last!.id, last!.serverTs ?? NaN))
    ) {
      await settleOp(db, last!.id);
      lastMark = 1;
    }
    const inFlight = lastMark === 0;
    let refusedInFlight: string | undefined;
    /** Ops not in flight that this build's `validate` refuses — see the
     *  warning below. `key`: the op's commit, if the journal holds one. */
    const unvalidated: { id: string; key: string; said: string }[] = [];
    /** Ops a method threw on, and whether the cell's last row is one. */
    let threw = 0;
    let lastThrew = false;
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
          const action = {
            type: `${op.cell}:${op.action}`,
            payload: op.payload,
          };
          const folded = unwrapReduced(reduce(next, action)) as Record<
            string,
            unknown
          >;
          // A `validate` refusal does not throw — the live server reads it
          // here too (D11).
          const refusal = takeRejectionFor(action, cell)?.reason;
          if (refusal !== undefined) {
            if (inFlight && op.id === lastId) {
              refusedInFlight = refusal;
              continue;
            }
            // An op the server accepted: its fold is a no-op, as it always
            // was — and said (below).
            unvalidated.push({
              id: op.id,
              key: opKey(op.id, op.serverTs ?? NaN),
              said: `${op.id} (${op.cell}:${op.action}): ${refusal}`,
            });
          }
          next = {
            ...(next as Record<string, unknown>),
            [cell]: folded[cell],
          } as S;
          applied++;
        } catch (e) {
          if (inFlight && op.id === lastId) {
            refusedInFlight = String(e);
            continue;
          }
          threw++;
          lastThrew = op.id === lastId;
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

    if (adoptedV0) {
      log.info(
        `sync: stamping cell "${cell}" at version ${declared} — first time ` +
          `it declares one (no onMigrate), so its unversioned log/snapshot ` +
          `is taken as that same shape`,
      );
    }
    const total = ops.length - (refusedInFlight === undefined ? 0 : 1);
    const bad = failures.length > 0 || skipped.older > 0 || skipped.newer > 0;
    // A `validate` (or a machine guard) that changed since it accepted an op
    // refuses it WITHOUT a throw: the reducer returns the state unchanged,
    // so the op folds as nothing — where a method that throws on it
    // quarantines the cell. The state is what it always was in this case; it
    // is no longer silent.
    // "ACCEPTED" is said only of an op something proves was: its row's mark
    // (`settleOp`) or its commit in the journal. A row with neither — an
    // older build's (it marked nothing), or a refused one whose delete
    // failed while the run went on — was KEPT, and that is all that is known.
    if (unvalidated.length > 0) {
      const marked = new Set(
        (await db.query<{ id: string }>(
          "SELECT id FROM sync_ops WHERE cell = ? AND settled = 1",
          [cell],
        )).rows.map((r) => r.id),
      );
      const proven = unvalidated.filter((u) =>
        marked.has(u.id) || opts.committed?.has(u.key)
      );
      const kept = unvalidated.filter((u) => !proven.includes(u));
      for (
        const [group, accepted] of [[proven, true], [kept, false]] as const
      ) {
        const n = group.length;
        if (n === 0) continue;
        log.warn(
          `sync: "${cell}": ${count(n, "op")} in the op-log that the server ` +
            (accepted
              ? `ACCEPTED ${n === 1 ? "is" : "are"}`
              : `kept — nothing records that it accepted ${
                n === 1 ? "it" : "them"
              } (no settled mark, no journal commit) — ${
                n === 1 ? "is" : "are"
              }`) +
            ` refused by this build (a \`validate\` or a guard, no throw) — ` +
            `first: op ${group[0]!.said}. Each is folded as a NO-OP: ` +
            `"${cell}" is restored without its effect, while the op stays in ` +
            `the log and every client that applied it still holds it — and ` +
            `the next compaction of "${cell}" drops the op for good. If the ` +
            `op is valid, fix what refuses it and restart before that.`,
        );
      }
    }
    // Nothing is removed for a cell that does not fold (below) — its last
    // row included, though this boot's reduce refused it: an earlier op was
    // skipped or threw, so the state that refusal was decided on is not the
    // state the live server would decide on. The cell is quarantined
    // (read-only: no op is stored after that row), so it is still the last
    // row, still unsettled, at the boot that folds — and decided there.
    if (!bad && inFlight) {
      if (refusedInFlight !== undefined) {
        await db.execute("DELETE FROM sync_ops WHERE id = ?", [lastId]);
        log.warn(
          `sync: "${cell}"'s op ${lastId} was persisted but not yet settled ` +
            `when the server stopped, and its reduce is refused ` +
            `(${refusedInFlight}) — removed from the op-log and not ` +
            `acknowledged: this build refuses it`,
        );
      }
    }
    // Folded here (a deferred one is the caller's to reduce, and to mark):
    // it is in the state this boot serves, and its author's resend is
    // acknowledged as a duplicate.
    if (
      !bad && lastMark === 0 && refusedInFlight === undefined &&
      opts.defer?.get(cell) !== last!.serverTs
    ) await settleOp(db, last!.id);
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
    // The last row threw and no build marked it (NULL — `settleOp`): a kill
    // between storing an op and removing a refused one leaves exactly this.
    const unmarkedLast = lastThrew && lastMark == null;
    const lastHint = unmarkedLast
      ? ` If "${cell}" refuses op ${lastId} BY DESIGN (a guard, a validate): ` +
        `an older aio build stored it, and a server killed between storing ` +
        `an op and removing a refused one leaves exactly this row — its ` +
        `author was never told it landed. That build marked nothing that ` +
        `tells such a row from an accepted one, so it is not removed for ` +
        `you: stop the app, run \`DELETE FROM sync_ops WHERE id = ` +
        `'${lastId!.replaceAll("'", "''")}'\` on its state.db, and restart.` +
        dropOpHow(ctx.dbPath, lastId!)
      : "";
    const fix = (downgradeWrites > 0
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
        `converts the older shape, then restart.` +
        // No shape need be older for a throw: a version bump converts nothing.
        (threw > 0 && skipped.older === 0
          ? ` (If "${cell}"'s shape did not change, a method throws on an ` +
            `op it accepted when the op was written — fix the method so ` +
            `the op-log folds.)`
          : "")) + lastHint;
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

/** The same repair for a machine with no `sqlite3` — Deno's own SQLite, the
 *  file and the statement as arguments so one line is valid in sh, cmd and
 *  PowerShell. Empty when the database is not a file, or when a name in it
 *  would need quoting that differs between those shells. Pure. @internal */
export function dropOpHow(dbPath: string | undefined, id: string): string {
  if (dbPath === undefined || dbPath.includes(":memory:")) return "";
  const file = resolve(dbPath);
  if (/[\x22$\x60%!\r\n]/.test(file + id) || file.endsWith("\\")) {
    return ` The file: ${file}`;
  }
  return ` The file: ${file} — with no sqlite3 at hand: \`deno eval ` +
    `"import{DatabaseSync as D}from'node:sqlite';const d=new D(Deno.args[0]);` +
    `d.exec(Deno.args[1]);d.close()" "${file}" "DELETE FROM sync_ops WHERE ` +
    `id = '${id.replaceAll("'", "''")}'"\``;
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
