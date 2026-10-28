// Phase 2 — opening storage: the bodies `_runPhases` (aio.ts) calls through its stubs.
// Moved out of that one function as they were; every local of the boot they
// use is read and written through `ctx` (boot-ctx.ts), live.
import {
  createAioError,
  reportError as reportAioError,
} from "../diagnostics/error.ts";
import { count, thrownText } from "../diagnostics/fmt.ts";
import { log } from "../diagnostics/logger-api.ts";
import { deepMerge } from "../state/deep-merge.ts";
import { takeRejectionFor } from "../state/rejection-tracker.ts";
import { getCompactedTs, settleOp } from "../sync/server-store.ts";
import {
  cleanStopThrough,
  getSyncReplayContext,
  issuedThrough,
  moveJournalAside,
  reactionsFormat,
  replaySyncOps,
  runCellRestore,
  seedSyncReactions,
  unwrapReduced,
} from "./aio-boot.ts";
import {
  chargeReplayAcrossBoots,
  isLegacyTail,
  type JournalEntry,
  type JournalGap,
  journalWatermarkKey,
  replayJournal,
  SYNC_APPLIED_TYPE,
  SYNC_INTENT_TYPE,
  syncJournalSnapshotKey,
  syncJournalWatermarkKey,
  type TimeTravelRestore,
  TT_RESTORE_TYPE,
  workerPatchCell,
} from "./journal.ts";
import { inFlightVerdict, opKey, placeOps } from "./op-placement.ts";
import { recordStoreGen } from "./store-gen.ts";
import { dirname } from "@std/path";
import { produce } from "immer";
import type { BootCtx } from "./boot-ctx.ts";

export async function _recoverSyncLogs<S, A, E>(
  ctx: BootCtx<S, A, E>,
  asyncDb: NonNullable<typeof ctx.boot.asyncDb>,
): Promise<void> {
  let tail: JournalEntry[] = [];
  let lines: JournalEntry[] = [];
  try {
    tail = ctx.journal?.readTail() ?? [];
    lines = (ctx.journal ?? ctx.strayJournal)?.readSince(-Infinity) ?? [];
  } catch { /* aio-ok: an unreadable journal is refused, loudly, below */ }
  // Data an OLDER build (1.0.9 or earlier) last wrote holds no record of
  // the `listensTo` reactions of its sync ops on other cells — that build
  // re-derived them at its own boots, through the whole root, and saved
  // them or lost them in ways no record shows. None is re-derived here:
  // re-applying a reaction its save already held counted it twice (a
  // tally of 24 came back 45). Each cell's own ops fold into it, as
  // always, and every listener that may lack reactions is NAMED. Legacy
  // is this build's stamp missing from the op-log (a clean stop compacts
  // the journal empty, and a store may be off) and none of its records in
  // the journal; over data this build HAS run, an op an older build wrote
  // after a downgrade is found by its own missing records (journal.ts J3).
  const ours = await reactionsFormat(asyncDb) !== undefined ||
    lines.some((e) =>
      e.type === SYNC_INTENT_TYPE || e.type === SYNC_APPLIED_TYPE
    );
  const legacyTail = isLegacyTail(tail);
  // The latest clean stop (see `CLEAN_STOP_ROW`): the ops it covers, and
  // where this run's own ops start — continuing that range only when
  // nothing was issued since (no other run came between).
  const clean = await cleanStopThrough(asyncDb);
  const issuedAtBoot = await issuedThrough(asyncDb);
  ctx._cleanRunFrom = clean !== undefined && clean.to >= issuedAtBoot
    ? clean.from
    : issuedAtBoot;
  let legacy = false;
  try {
    legacy = !ours && (legacyTail ||
      (!tail.some((e) => e.fmt !== undefined) &&
        (await asyncDb.query<{ n: number }>(
            "SELECT (SELECT COUNT(*) FROM sync_ops) + " +
              "(SELECT COUNT(*) FROM sync_snapshots) AS n",
          )).rows[0]!.n > 0));
  } catch { /* aio-ok: an unreadable op-log is refused, loudly, below */ }
  // An older build's unstamped lines above the last upgrade marker are
  // CALLS, replayed as calls; the marker this boot writes after them
  // retires them (see `LEGACY_RECOVERED_TYPE`).
  ctx._legacyBoot = legacyTail ? ctx.state : null;
  const fa = ctx.config._cellForeignActions ?? {};
  const cellOf = (t: string) => t.slice(0, Math.max(0, t.indexOf(":")));
  if (legacy) {
    log.warn(
      `journal: this data was last run by an older aio build (1.0.9 or ` +
        `earlier), which recorded no listensTo reactions of its sync ops — ` +
        `none is re-derived, so nothing is counted twice; every listener ` +
        `that may lack some is named below`,
    );
  }
  /** Listener → what it may lack, in words. */
  const lacks = new Map<string, string[]>();
  const say = (k: string, what: string) =>
    lacks.set(k, [...lacks.get(k) ?? [], what]);
  const listenersOf = (src: string) =>
    Object.entries(fa).filter(([, types]) =>
      types.some((t) => cellOf(t) === src)
    ).map(([k]) => k);
  // Every listened op in the log, placed by the journal's records
  // (journal.ts J1–J7, op-placement.ts `placeOps`). Over legacy data none
  // has a record; with no journal this run records none — and names none,
  // its crash losing them as documented (docs/persistence/crdt.md).
  // With the journal off, a journal a crash left still holds the op
  // records: its ops caught in flight are resolved as a journal-on boot
  // resolves them — and nothing else is placed (`strayJournal`).
  /** COMMIT(X) records read (journal.ts) — `opKey`. */
  const commits = new Set<string>();
  if (ctx._marking || legacy || ctx.strayJournal !== null) {
    const intents = new Map<string, number>();
    // A journal that is moved aside unreplayed (below) takes its reaction
    // lines and its commits with it: none of them covers anything any
    // more — each op is named once here and committed anew.
    for (const e of lines) {
      if (e.type !== SYNC_INTENT_TYPE && e.type !== SYNC_APPLIED_TYPE) {
        continue;
      }
      if (e.type === SYNC_APPLIED_TYPE && ctx._retireForeign) continue;
      const p = e.payload as { id?: unknown; ts?: unknown };
      if (typeof p?.id !== "string" || typeof p.ts !== "number") continue;
      if (e.type === SYNC_INTENT_TYPE) intents.set(opKey(p.id, p.ts), e.seq);
      else commits.add(opKey(p.id, p.ts));
    }
    for (const c of ctx.syncCellIds) {
      const { rows } = await asyncDb.query<
        {
          id: string;
          action: string;
          payload: string;
          server_ts: number;
          settled: number | null;
        }
      >(
        "SELECT id, action, payload, server_ts, settled FROM sync_ops " +
          "WHERE cell = ? ORDER BY server_ts",
        [c],
      );
      const placed = placeOps(
        rows.map((r) => ({
          id: r.id,
          ts: r.server_ts,
          listened: ctx._listenedTypes.has(`${c}:${r.action}`),
        })),
        new Set(intents.keys()),
        commits,
      );
      const uncovered: number[] = [];
      for (const r of rows) {
        const p = placed.get(r.id);
        if (p === undefined || p === "covered") continue;
        // A row MARKED settled (server-store.ts `settleOp`) was accepted
        // and acknowledged, whatever the journal now holds: its commit
        // line is one the journal lost (a power cut, a restored or cut
        // file). Never in flight — so never removed by a refusal below:
        // it folds with its cell (`replaySyncOps` refuses or quarantines
        // on it, as on any settled row) and its listeners are named.
        if (p === "in-flight" && r.settled !== 1) {
          ctx._deferred.push({
            cell: c,
            id: r.id,
            action: r.action,
            payload: JSON.parse(r.payload),
            ts: r.server_ts,
            intentSeq: intents.get(opKey(r.id, r.server_ts))!,
          });
          continue;
        }
        if (!ctx._marking && !legacy) continue;
        // A run that stopped cleanly after it saved every record: the
        // reactions are in them, journal or not.
        if (
          !legacy && clean !== undefined && r.server_ts > clean.from &&
          r.server_ts <= clean.to
        ) {
          if (ctx._marking) {
            ctx._unmarked.push({ cell: c, id: r.id, ts: r.server_ts });
          }
          continue;
        }
        uncovered.push(r.server_ts);
        if (ctx._marking) {
          ctx._unmarked.push({ cell: c, id: r.id, ts: r.server_ts });
        }
      }
      const n = uncovered.length;
      const folded = legacy && await getCompactedTs(asyncDb, c) > 0;
      for (const k of listenersOf(c)) {
        if (n > 0) {
          say(
            k,
            `${count(n, `"${c}" op`)} in the op-log (server_ts ${
              uncovered[0]
            }–${uncovered[n - 1]})`,
          );
        }
        if (folded) say(k, `the "${c}" ops it folded out of the op-log`);
      }
    }
  }
  // A sync listener of a store CALL: the older build recorded its
  // reaction in no fold it can show — named with the rest.
  if (legacy) {
    for (const c of ctx.syncCellIds) {
      const calls = (fa[c] ?? []).filter((t) =>
        !ctx.syncCellIds.includes(cellOf(t))
      );
      if (calls.length > 0) {
        say(c, `the ${calls.map((t) => `"${t}"`).join(", ")} calls`);
      }
    }
  }
  for (const [k, what] of lacks) {
    log.warn(
      legacy
        ? `sync: "${k}"'s listensTo reactions to ${what.join(", and to ")} ` +
          `are in no record this boot can read — this data was last ` +
          `written by an older aio build (1.0.9 or earlier), which kept ` +
          `none. Nothing was re-applied, so nothing is counted twice; 1.0.9 ` +
          `may have saved these reactions or lost them — check "${k}".`
        : `sync: cannot tell whether "${k}" holds its listensTo reactions ` +
          `to ${what.join(", and to ")} — those ops were written by a run ` +
          `that recorded neither a journal of them nor a clean stop (an ` +
          `older aio build, or this one with the journal or persistence ` +
          `off), or the journal lost lines (deleted, restored from a ` +
          `backup, cut short). ${
            ctx.syncCellIds.includes(k)
              ? `"${k}"'s last fold`
              : "The store's last save"
          } may hold them or not. Nothing was re-applied, so nothing is ` +
          `counted twice — check "${k}".`,
    );
  }
  ctx.state = await replaySyncOps(
    asyncDb,
    ctx.syncCellIds,
    ctx.config.reduce as (
      s: S,
      a: { type: string; payload?: unknown },
    ) => S,
    ctx.state,
    log,
    undefined,
    {
      defer: new Map(ctx._deferred.map((d) => [d.cell, d.ts])),
      committed: commits,
    },
  );
}

/** The replayed state, with every cell the replay touched sent through the
 *  round trip a clean restart gives it: the slice is written exactly as the
 *  store writes it (filter, then `onPersist`, then JSON) and read back the
 *  way boot reads it (`_restartedSlice`).
 *
 *  This used to run for `onPersist`-shaped cells only — a shape names no
 *  fields, so `_keepUnpersistedFields` cannot read one (`onPersist: (s) =>
 *  ({ data: s.data })` kept `cache` off disk, and a `setBoth(7)` came back
 *  `cache: 0` after a clean stop and `cache: 7` after a SIGKILL). But a
 *  PLAIN cell's restore is `deepMerge(declared, stored)` too, and replay
 *  kept its slice as the method left it: `delete s.m.a; s.m.extra = 5` came
 *  back `{ b: 2, extra: 5 }` after a SIGKILL and `{ a: 1, b: 2 }` after a
 *  clean stop — the deleted declared key filled back in and the undeclared
 *  one dropped, as the write guard promises. Every cell takes the one read
 *  now, so the two stops cannot drift apart again one cell kind at a time.
 *
 *  A sync cell is not restored from the store (its op-log is its record —
 *  `replaySyncOps`), so it keeps what replay produced.
 *
 *  A shape that throws here is the same failure the persist path reports on
 *  its next write; the replayed slice is kept and the throw is said now. */
export function _roundTripReplayedCells<S, A, E>(
  ctx: BootCtx<S, A, E>,
  restored: S,
  replayed: S,
): S {
  if (replayed === restored) return replayed;
  const from = restored as Record<string, unknown>;
  const declared = ctx.initialState as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const cell of Object.keys(declared)) {
    const now = (replayed as Record<string, unknown>)[cell];
    if (
      now === from[cell] || !ctx._isRecord(now) ||
      !ctx._isRecord(declared[cell]) ||
      ctx.syncCellIds.includes(cell)
    ) continue;
    let disk: Record<string, unknown>;
    try {
      const stored = (ctx.getDBState({ [cell]: now } as S) as
        | Record<string, unknown>
        | undefined)?.[cell];
      disk = stored === undefined
        ? {}
        : JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
    } catch (e) {
      log.error(
        `journal: could not shape the replayed "${cell}" slice the way ` +
          `the store writes it — it keeps what replay produced, including ` +
          `whatever its onPersist keeps off disk: ${
            e instanceof Error ? e.message : String(e)
          }`,
      );
      continue;
    }
    out ??= { ...(replayed as Record<string, unknown>) };
    out[cell] = ctx._restartedSlice(cell, disk);
  }
  return (out ?? replayed) as S;
}

/** One cell's slice as a clean restart reads it back from `disk` (its
 *  stored form, already through JSON): the declared state with the stored
 *  fields merged over it — `bootStorage`'s `deepMerge`, so a declared key
 *  the store lacks is filled in and an undeclared one is dropped — and, for
 *  an `onPersist`-shaped cell, its `onRestore` handed the stored shape. A
 *  plain cell's `onRestore` runs in `_rerunRestoreHooks`, in boot's order.
 *  The one read every replay path shares (`_roundTripReplayedCells`,
 *  `_restoreStoredSlice`). */
export function _restartedSlice<S, A, E>(
  ctx: BootCtx<S, A, E>,
  cell: string,
  disk: Record<string, unknown>,
): Record<string, unknown> {
  const declared = (ctx.initialState as Record<string, unknown>)[cell];
  const slice = deepMerge(
    structuredClone(declared) as Record<string, unknown>,
    disk,
  );
  const hook = ctx.config._cellPersistShaped?.includes(cell)
    ? ctx.config._cellRestores?.get(cell)
    : undefined;
  return hook
    ? runCellRestore(cell, hook, slice, {
      stored: disk,
      declared,
      retyped: true,
    }, log)
    : slice;
}

/** A time-travel line's STORED fields as the cell's live slice (see
 *  `replayJournal`'s `restoreStored`): an `onPersist`-shaped cell is rebuilt
 *  the way a restart rebuilds it — declared state, the stored shape merged
 *  over it, the cell's `onRestore` — because the fields are its SHAPE, not
 *  its state, and spreading them over the live slice produced
 *  `{ n: 0, saved: 1 }` for `onPersist: (s) => ({ saved: s.n })`, which
 *  `_roundTripReplayedCells` then reshaped from `n: 0` (external review, rev4).
 *  Every other cell keeps the spread. */
export function _restoreStoredSlice<S, A, E>(
  ctx: BootCtx<S, A, E>,
  cell: string,
  stored: Record<string, unknown>,
  live: Record<string, unknown>,
): Record<string, unknown> {
  const declared = (ctx.initialState as Record<string, unknown>)[cell];
  if (!ctx._isRecord(declared)) return { ...live, ...stored };
  const disk = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
  if (!ctx.config._cellPersistShaped?.includes(cell)) {
    // Rebuilt as a restart rebuilds it — declared state, the stored fields
    // over it — and NOT spread over the live slice: a key the line's state
    // no longer has (a reaction that `delete`d or undefined'd it) is absent
    // from `stored`, and the spread kept the live value, i.e. the OLDER
    // store snapshot's (`err: "boom"` back after a crash, `""` after a
    // clean restart). Only what the persist filter keeps off disk comes
    // from the live slice: the line never had it to say.
    return ctx._unpersistedFromBoot(
      cell,
      ctx.config._cellPersist?.[cell] ?? "all",
      live,
      ctx._restartedSlice(cell, disk),
    );
  }
  return ctx._restartedSlice(cell, disk);
}

export function _warnUnstampedAcrossMigration<S, A, E>(
  ctx: BootCtx<S, A, E>,
  tail: JournalEntry[],
): void {
  const moved = new Map<string, { from: number; to: number }>();
  for (const r of ctx.migrationSummary?.report ?? []) {
    if (r.outcome === "migrated" || r.outcome === "downgrade") {
      moved.set(r.cell, { from: r.from, to: r.to });
    }
  }
  if (moved.size === 0) return;
  const hits = new Map<string, number[]>();
  for (const e of tail) {
    const cells = e.type === TT_RESTORE_TYPE
      ? ctx._ttStateCells(e.payload as Partial<TimeTravelRestore> | undefined)
      : [
        workerPatchCell(e.type, e.payload) ??
          (e.origin ?? e.type).slice(
            0,
            Math.max(0, (e.origin ?? e.type).indexOf(":")),
          ),
      ];
    for (const c of cells) {
      // Judged per cell: a stamped line that stamps some cells and not
      // this one cannot be judged for it either.
      if (!moved.has(c) || e.v?.[c] !== undefined) continue;
      const seqs = hits.get(c) ?? [];
      seqs.push(e.seq);
      hits.set(c, seqs);
    }
  }
  for (const [cell, seqs] of hits) {
    const m = moved.get(cell)!;
    reportAioError(
      createAioError(
        "PERSIST_ERROR",
        new Error(
          `journal: ${count(seqs.length, "line")} for "${cell}" (seq ${
            seqs.length > 8
              ? `${seqs.slice(0, 8).join(", ")}, …${seqs.at(-1)}`
              : seqs.join(", ")
          }) carry no version stamp — ` +
            `written by an aio build from before stamps existed — and this ` +
            `boot migrated "${cell}" v${m.from} → v${m.to}. They are ` +
            `REPLAYED through this build's methods on the migrated state, ` +
            `as before; if they ran under v${m.from}, the recovered ` +
            `"${cell}" may be wrong (a v${m.from} argument read with ` +
            `v${m.to} meaning). Check it against the journal with ` +
            `\`am timeline --from=<file>\`. ${ctx._keepJournalCopy()}`,
        ),
        { cellName: cell },
      ),
      ctx._reportOpts,
    );
  }
}

/** The restore hooks a clean restart runs, run again on what journal
 *  replay produced — so a crash and a clean stop come back the same.
 *
 *  Boot ran them on the SNAPSHOT, and the tail then replayed on top: after a
 *  clean stop the hooks see every action (the final snapshot holds them);
 *  after a SIGKILL the tail's actions landed AFTER them, so what a hook
 *  repairs ("nobody is online after a restart") was undone by the replayed
 *  action that set it — measured `online: false` after a clean stop and
 *  `online: true` after a crash. Only when replay changed state, in the
 *  clean restart's order: each plain cell's `onRestore` whose slice the
 *  replay touched (a shaped cell's already ran in its round trip), then the
 *  app-level one. Error-guarded like boot's own run: a throw is logged and
 *  the state kept as the replay left it. */
export function _rerunRestoreHooks<S, A, E>(
  ctx: BootCtx<S, A, E>,
  restored: S,
  replayed: S,
): S {
  if (replayed === restored) return replayed;
  let next = replayed;
  const restores = ctx.config._cellRestores;
  if (restores?.size) {
    const shaped = new Set(ctx.config._cellPersistShaped ?? []);
    const was = restored as Record<string, unknown>;
    next = produce(next, (d) => {
      const s = d as Record<string, unknown>;
      for (const [id, hook] of restores) {
        if (shaped.has(id) || !ctx._isRecord(s[id])) continue;
        if ((replayed as Record<string, unknown>)[id] === was[id]) continue;
        s[id] = runCellRestore(
          id,
          hook,
          s[id] as Record<string, unknown>,
          undefined,
          log,
        );
      }
    });
  }
  const appHook = ctx.config.onRestore;
  if (appHook) {
    try {
      next = produce(next as unknown, (d: unknown) => {
        const r = appHook(d as S) as unknown;
        // Mutated in place (or handed the draft back) ⇒ the draft's edits.
        return r === undefined || r === d ? undefined : r;
      }) as S;
    } catch (e) {
      log.error(
        `hook onRestore (after journal replay): ${thrownText(e)}`,
      );
    }
  }
  return next;
}

/** The tail minus the lines that write only a quarantined sync cell: its
 *  state is its last snapshot, and a line from before the crash applied to
 *  it would fold a write onto a shape it was never taken on. They stay on
 *  disk (`retireCells` spares them), and are NAMED — fixing the cell's
 *  version/onMigrate and restarting replays them.
 *
 *  The same for a cell this build does not DECLARE (`journalHeld`): it has
 *  no methods to re-run them through, and its stored slice is preserved
 *  untouched — so are its lines, held by the journal (`journalHeldCellsKey`)
 *  until a build declares the cell and replays them onto that slice. They
 *  used to be "replayed" as no-ops, counted recovered, and compacted away
 *  by the first save. */
export function _quarantinedTail<S, A, E>(
  ctx: BootCtx<S, A, E>,
  tail: JournalEntry[],
): JournalEntry[] {
  const sq = ctx.asyncDb
    ? getSyncReplayContext(ctx.asyncDb)?.quarantined
    : undefined;
  const q = new Set([...(sq ?? []), ...ctx.journalHeld]);
  if (!q.size || tail.length === 0) return tail;
  const own = (e: JournalEntry): string | undefined => {
    if (e.only?.length) {
      return e.only.every((k) => q.has(k)) ? e.only[0] : undefined;
    }
    const i = e.type.indexOf(":");
    const c = i > 0 ? e.type.slice(0, i) : undefined;
    return c !== undefined && q.has(c) ? c : undefined;
  };
  const held = new Map<string, number[]>();
  const rest = tail.filter((e) => {
    const c = own(e);
    if (c === undefined) return true;
    const seqs = held.get(c) ?? [];
    held.set(c, seqs);
    seqs.push(e.seq);
    return false;
  });
  for (const [c, seqs] of held) {
    if (ctx.journalHeld.has(c)) {
      log.warn(
        `journal: "${c}" is not declared by this build — ${
          count(seqs.length, "journalled line")
        } written for it (seq ${seqs[0]}–${seqs.at(-1)}) are KEPT in ` +
          `${
            ctx.journal!.path
          }, not applied, like its stored data. Re-declare ` +
          `"${c}" and restart: they are replayed onto that data then.`,
      );
      continue;
    }
    log.error(
      `journal: "${c}" is quarantined — ${
        count(seqs.length, "journalled line")
      } written for it before this boot (seq ${seqs[0]}–${seqs.at(-1)}) ` +
        `are KEPT in ${ctx.journal!.path}, not applied. Fix "${c}"'s ` +
        `version/onMigrate and restart: they are replayed then.`,
    );
  }
  return rest;
}

/** Refuse a journal replay across a hole (see `JournalGap`), keep the
 *  journal, and say where both halves of the evidence went. Boot goes on:
 *  the database is consistent on its own, and the integrity check already
 *  said it is older. Replaying nothing is the one answer that invents
 *  nothing. */
export async function _refuseJournalAcrossGap<S, A, E>(
  ctx: BootCtx<S, A, E>,
  j: NonNullable<typeof ctx.journal>,
  gap: JournalGap,
): Promise<void> {
  const { integrityRecoveries } = await import("./db-integrity.ts");
  // The recovery this journal belongs with: its own database (`<db>.journal`)
  // or the one in its directory (`<data>/state.db` beside `<data>/journal`).
  const recoveries = [...integrityRecoveries()];
  const recovery = (recoveries.find(([db]) => j.path === `${db}.journal`) ??
    recoveries.find(([db]) => dirname(db) === dirname(j.path)))?.[1];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const to = recovery?.quarantinedTo
    ? `${recovery.quarantinedTo}.journal`
    : `${j.path}.gap-${stamp}`;
  const why = recovery?.restoredFrom
    ? `checkIntegrityOnBoot restored ${recovery.restoredFrom}; the damaged ` +
      `database is kept at ${recovery.quarantinedTo}`
    : recovery?.quarantinedTo
    ? `checkIntegrityOnBoot started it EMPTY; the damaged database is kept ` +
      `at ${recovery.quarantinedTo}`
    : `it was restored from a snapshot or a backup, or replaced`;
  const stream = gap.stream === "actions"
    ? "the app's actions"
    : `sync cell "${gap.stream}"`;
  let kept: string;
  try {
    j.quarantine(to);
    kept = `The journal is kept at ${to} (with ${to}.base)`;
  } catch (e) {
    kept = `The journal could NOT be moved aside (${e}) and is still at ` +
      `${j.path} — copy it away before the first snapshot compacts it`;
  }
  const msg =
    `journal: REFUSED to replay ${j.path} — the database holds ${stream} ` +
    `only up to seq ${gap.storeAt}, but the journal had already dropped ` +
    `everything up to seq ${gap.droppedThrough}: the database went back in ` +
    `time (${why}). Replaying the tail across that hole would re-run ` +
    `actions on a state they never ran on and record history that never ` +
    `happened, so nothing was replayed and the app boots on the database ` +
    `as it is. ${kept}.`;
  reportAioError(
    createAioError("PERSIST_ERROR", new Error(msg), {
      ...(gap.stream !== "actions" ? { cellName: gap.stream } : {}),
    }),
    ctx._reportOpts,
  );
}

export async function _wireJournal<S, A, E>(
  ctx: BootCtx<S, A, E>,
  journal: NonNullable<typeof ctx.boot.journal>,
): Promise<void> {
  if (ctx._syncJournal) {
    const stored: Record<string, number> = {};
    for (const c of ctx.syncCellIds) {
      const key = syncJournalWatermarkKey(ctx.appId, c);
      const at = await ctx.kvDb!.get<number>(key);
      if (typeof at === "number") {
        stored[c] = at;
        continue;
      }
      // First boot with this cell journalled by its own watermark. Every line
      // the journal already holds for it was written while the app-wide
      // watermark governed it — the cell was not `sync: true`, or not
      // journalled — so the KV snapshot holds exactly those up to that mark.
      // Recorded BEFORE any write can be journalled under the new rule.
      stored[c] = journal.watermark();
      await ctx.kvDb!.set(key, stored[c]);
    }
    // Where each cell's snapshot stands as this run starts journalling it
    // — once; its folds keep it current from then on.
    for (const c of ctx.syncCellIds) {
      const key = syncJournalSnapshotKey(ctx.appId, c);
      const at = await ctx.kvDb!.get<number>(key);
      if (typeof at === "number") ctx._foldedAt.set(c, at);
      else await ctx.kvDb!.set(key, await getCompactedTs(ctx.asyncDb!, c));
    }
    journal.trackCells(stored);
    // …and the ones whose watermark will never move (see `retireCells`).
    // Only the lines this boot writes: the ones already there were written
    // before the cell was quarantined, and fixing its version recovers them
    // (kept by its own watermark, not replayed — see `_quarantinedTail`).
    journal.retireCells(
      getSyncReplayContext(ctx.asyncDb!)?.quarantined ?? [],
      journal.currentSeq(),
    );
    // Boot has restored every op the log holds: that is where each sync
    // cell's live state starts (`_appliedTs`).
    for (const c of ctx.syncCellIds) {
      const { rows } = await ctx.asyncDb!.query<{ m: number | null }>(
        "SELECT MAX(server_ts) AS m FROM sync_ops WHERE cell = ?",
        [c],
      );
      ctx._appliedTs.set(
        c,
        Math.max(rows[0]?.m ?? 0, await getCompactedTs(ctx.asyncDb!, c)),
      );
    }
    ctx.syncHandler!.setFoldWatermark!({
      capture: (c) => {
        // Same synchronous turn as the fold's own state read: this IS the
        // state its snapshot holds.
        const at = journal.capture(c);
        ctx._captured.set(c, {
          at,
          state: (ctx.state as Record<string, unknown>)[c],
          lined: false,
        });
        return at;
      },
      plan: (c, at) => [
        ...ctx.kvDb!.planSet!(syncJournalWatermarkKey(ctx.appId, c), at),
        // Last in the fold's transaction: the `compacted_ts` it just wrote.
        {
          sql: `INSERT INTO aio_kv (k, v)
                  SELECT ?, CAST(compacted_ts AS TEXT) FROM sync_meta
                  WHERE cell = ?
                  ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
          params: [syncJournalSnapshotKey(ctx.appId, c), c],
        },
      ],
      folded: (c, at) => {
        journal.setCellWatermark(c, at);
        // The snapshot is on disk, with its watermark: every line at or
        // below `at` is gone from the tail. A line written while the fold
        // was in flight is above it and resolves on its own (a keyframe,
        // or `alsoSnapshot`) — the chain goes on from it. Else the next
        // line is a delta against the snapshot (`baseSnapshotAt`).
        const cap = ctx._captured.get(c);
        ctx._captured.delete(c);
        if (cap?.at === at && cap.lined) return;
        if (cap?.at === at) {
          ctx._reactionChain.set(c, {
            seq: 0,
            state: cap.state,
            snapshotAt: at,
          });
        } else ctx._reactionChain.delete(c);
      },
    });
  }
  // A database that went BACK in time — `checkIntegrityOnBoot` restored its
  // snapshot, or a file was copied over it — is older than the journal's
  // tail, with a hole between the two. Replaying across the hole re-ran
  // actions on a state they never ran on: `withdrawAll()` after three
  // deposits, replayed onto the restored balance of 50, recorded a
  // withdrawal of 50 that never happened. Refused, loudly, and the journal
  // is kept — beside the damaged database when there is one.
  // A store saved by a run that journals nothing, after this tail was
  // written (store-gen.ts): the tail is older than the store — moved aside,
  // never replayed. An older build's own tail is the legacy path's.
  if (ctx._retireForeign) moveJournalAside(journal, "foreign-save", log);
  // …and from here, this boot's picture of the store is the record.
  if (ctx.asyncDb && ctx.kvDb?.planSet) {
    await recordStoreGen(
      ctx.asyncDb,
      ctx.appId,
      journalWatermarkKey(ctx.appId),
    );
  }
  let gap = journal.gap();
  // Nothing past the store's watermarks: the hole has nothing after it to
  // invent history with (a clean stop compacts the journal empty before a
  // backup is put back). The base moves back to the store instead — left
  // ahead of it, the next crash would refuse a tail this boot writes.
  if (gap && journal.readTail().length === 0) {
    try {
      journal.rebase();
    } catch (e) {
      log.warn(
        `journal: could not record ${journal.path}.base (${e}) — the ` +
          `database is older than the journal's last compaction, and until ` +
          `this succeeds a crash makes the next boot refuse to replay`,
      );
    }
    gap = null;
  }
  if (gap) await ctx._refuseJournalAcrossGap(journal, gap);
  const tail = ctx._quarantinedTail(gap ? [] : journal.readTail());
  // A tail an earlier boot already replayed, and no save since: charged.
  chargeReplayAcrossBoots(journal.path, tail[0]?.seq, tail.length);
  if (tail.length > 0) ctx._warnUnstampedAcrossMigration(tail);
  if (tail.length > 0) {
    // Sync cells' `listensTo` reactions first: each goes back BETWEEN the
    // cell's own ops (see `seedSyncReactions`), and no later line may write
    // the cell again from before that point.
    let seededAt = new Map<string, number>();
    if (ctx._syncJournal && ctx.asyncDb) {
      const seeded = await seedSyncReactions(
        ctx.asyncDb,
        ctx.syncCellIds,
        ctx.config.reduce as unknown as (
          s: S,
          a: { type: string; payload?: unknown },
        ) => { state: S },
        ctx.state,
        tail,
        (cell) => ctx.config._cellVersions?.[cell] ?? 0,
        log,
        (cell) => journal.watermarkFor(cell),
        new Map(ctx._deferred.map((d) => [d.cell, d.ts])),
        (cell) => ctx._foldedAt.get(cell),
      );
      ctx.state = seeded.state;
      seededAt = seeded.seededAt;
      for (const c of seededAt.keys()) ctx.syncHandler!.noteServerWrite(c);
    }
    const before = ctx.state;
    const replay = replayJournal(
      ctx.state,
      tail,
      ctx.config.reduce as (s: S, a: A) => { state: S },
      (key) => Math.max(journal.watermarkFor(key), seededAt.get(key) ?? 0),
      (cell) => ctx.config._cellVersions?.[cell] ?? 0,
      (cell) => !!ctx.config._cellMigrations?.get(cell)?.onMigrate,
      ctx._restoreStoredSlice,
    );
    ctx.state = ctx._rerunRestoreHooks(
      ctx.state,
      ctx._roundTripReplayedCells(
        ctx.state,
        ctx._keepUnpersistedFields(ctx.state, replay.state),
      ),
    );
    // A sync cell's replayed writes are live again but in no snapshot, and
    // no fold is pending for them: fold now, or a client catching up is
    // served a history without them and a second crash depends on the
    // journal alone.
    if (ctx._syncJournal) {
      for (const c of ctx.syncCellIds) {
        if (
          (before as Record<string, unknown>)[c] !==
            (ctx.state as Record<string, unknown>)[c]
        ) ctx.syncHandler!.noteServerWrite(c);
      }
    }
    if (replay.replayed > 0) {
      log.info(
        `journal: recovered ${
          count(replay.replayed, "action")
        } past the last snapshot`,
      );
    }
    // A redacted entry cannot be replayed — its payload IS its arguments and
    // the redactor dropped them. Skipping is the only correct outcome, but a
    // SILENT skip would be the same lie in a quieter register: recovery would
    // report success while the recovered state is missing writes. Say
    // exactly which actions, and how many, so the operator can judge it.
    if (replay.skipped.length > 0) {
      const counts = new Map<string, number>();
      for (const s of replay.skipped) {
        counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
      }
      const what = [...counts]
        .map(([type, n]) => (n > 1 ? `${type} x${n}` : type))
        .join(", ");
      const seqs = replay.skipped.map((s) => s.seq);
      // A version bump between the crash and this boot: those entries ran
      // through methods this build no longer has, on a snapshot this boot
      // just migrated — re-running them through the new methods is a
      // guess (a v1 "+5 units" replayed as "+5 cents").
      const stale = replay.skipped.filter((s) => s.reason === "version");
      const rest = replay.skipped.filter((s) => s.reason !== "version");
      const threw = rest.filter((s) => s.reason === "threw");
      const whyRest = rest.length === 0
        ? ""
        : threw.length === 0
        ? `their payload was dropped by redactActions, so the arguments ` +
          `needed to re-run them are gone`
        : threw.length === rest.length
        ? `the reducer REJECTED them: ${
          [...new Set(threw.map((s) => s.error ?? "threw"))].join("; ")
        }`
        : `some had their payload dropped by redactActions and ${threw.length} ` +
          `were rejected by the reducer: ${
            [...new Set(threw.map((s) => s.error ?? "threw"))].join("; ")
          }`;
      const whyStale = stale.length === 0
        ? ""
        : `${stale.length === replay.skipped.length ? "they" : stale.length} ` +
          `ran under a cell version this build has migrated away from (${
            [...new Set(stale.map((s) => s.error ?? "version"))].join("; ")
          }), so the methods that wrote them are not this build's and ` +
          `re-running them on the migrated state would guess`;
      const why = [whyRest, whyStale].filter(Boolean).join("; and ");
      log.warn(
        `journal: ${
          count(replay.skipped.length, "action")
        } COULD NOT be replayed — ` +
          `${why}: ${what} (seq ${Math.min(...seqs)}–${Math.max(...seqs)}). ` +
          `Whatever those actions wrote after the last snapshot is NOT in ` +
          `the recovered state. Skipping is deliberate: failing on an entry ` +
          `that cannot be replayed would make recovery the reason this app ` +
          `can never start. ${ctx._keepJournalCopy()}`,
      );
    }
  }
}

export async function _reduceDeferred<S, A, E>(
  ctx: BootCtx<S, A, E>,
  asyncDb: NonNullable<typeof ctx.boot.asyncDb>,
): Promise<void> {
  const quarantined = getSyncReplayContext(asyncDb)?.quarantined;
  // A store another run saved without journalling may hold anything: a
  // store-persisted listener's reaction is held, never applied.
  const storeWm = ctx.storeSavedElsewhere
    ? Infinity
    : (ctx.journal ?? ctx.strayJournal)?.watermark() ?? 0;
  /** Listener → reactions held back. */
  const held = new Map<string, number>();
  let reduced = 0;
  for (const d of [...ctx._deferred].sort((a, b) => a.ts - b.ts)) {
    if (quarantined?.has(d.cell)) continue;
    // A sync op, exactly as the live server dispatches it: the same
    // accept/refuse decision (a refusal discards this whole fold below).
    const action = {
      type: `${d.cell}:${d.action}`,
      payload: d.payload,
      _syncOp: true,
      _syncTs: d.ts,
      _syncId: d.id,
    };
    const was = ctx.state as Record<string, unknown>;
    let folded: Record<string, unknown> | undefined;
    let refusal: string | undefined;
    try {
      folded = unwrapReduced(
        (ctx.config.reduce as (
          s: S,
          a: { type: string; payload?: unknown },
        ) => S | { state: S })(ctx.state, action),
      ) as Record<string, unknown>;
      refusal = takeRejectionFor(action, d.cell)?.reason;
    } catch (e) {
      refusal = String(e);
    }
    if (refusal !== undefined || folded === undefined) {
      // The live server refuses such an op and deletes it (D11): so does
      // this boot — nothing acks it, and a resend meets the same decision.
      await asyncDb.execute("DELETE FROM sync_ops WHERE id = ?", [d.id]);
      log.warn(
        `sync: "${d.cell}"'s op ${d.id} was persisted but not yet ` +
          `committed when the server stopped, and its reduce is refused ` +
          `(${refusal}) — removed from the op-log and not acknowledged, ` +
          `as the live server does`,
      );
      continue;
    }
    const next = { ...was };
    for (const k of Object.keys(folded)) {
      if (folded[k] === was[k]) continue;
      if (k === d.cell) {
        next[k] = folded[k];
        continue;
      }
      // A quarantined listener's live state is not its data.
      if (quarantined?.has(k)) continue;
      const verdict = inFlightVerdict(
        ctx.syncCellIds.includes(k)
          ? { snapshotTs: await getCompactedTs(asyncDb, k) }
          : { storeWm },
        { ts: d.ts, intentSeq: d.intentSeq },
      );
      if (verdict === "held") {
        held.set(k, (held.get(k) ?? 0) + 1);
        continue;
      }
      next[k] = folded[k];
      ctx._rederivedCells.add(k);
    }
    ctx.state = next as S;
    reduced++;
    // In the state this boot serves: its author's resend is a duplicate,
    // acknowledged (server-store.ts `settleOp`).
    await settleOp(asyncDb, d.id);
    ctx._unmarked.push({ cell: d.cell, id: d.id, ts: d.ts });
  }
  if (reduced > 0) {
    log.info(
      `journal: reduced ${
        count(reduced, "sync op")
      } the crash caught between its persist and its commit${
        ctx._rederivedCells.size > 0
          ? ` (with its listensTo reactions on ${
            [...ctx._rederivedCells].join(", ")
          })`
          : ""
      }`,
    );
  }
  for (const [k, n] of held) {
    log.warn(
      `sync: "${k}": ${count(n, "listensTo reaction")} of the sync op${
        n === 1 ? "" : "s"
      } a crash caught between ` +
        `persist and commit held, not re-applied — ${
          ctx.syncCellIds.includes(k)
            ? `"${k}" was folded`
            : "the store was saved"
        } after the op was persisted, so it may already hold ${
          n === 1 ? "it" : "them"
        }; if not, ${n === 1 ? "it is" : "they are"} MISSING — check "${k}".`,
    );
  }
}
