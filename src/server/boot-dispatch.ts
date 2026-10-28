// Phase 3 — dispatch wiring: the bodies `_runPhases` (aio.ts) calls through its stubs.
// Moved out of that one function as they were; every local of the boot they
// use is read and written through `ctx` (boot-ctx.ts), live.
import { actionOrigin, isWriteSetAction } from "../diagnostics/action-kind.ts";
import { isDiagnosticsOptOut } from "../diagnostics/diagnostics-optout.ts";
import {
  createAioError,
  reportError as reportAioError,
} from "../diagnostics/error.ts";
import { count } from "../diagnostics/fmt.ts";
import { getLogger, log } from "../diagnostics/logger-api.ts";
import {
  pause,
  redo,
  resume,
  stateAt,
  travelTo,
  undo,
} from "../diagnostics/time-travel.ts";
import { withShapeGuard } from "../state/declared-shape-guard.ts";
import { perfBudgetFor } from "../state/dispatch.ts";
import { hasRejectionFor } from "../state/rejection-tracker.ts";
import { routeEffect } from "../state/route-effect.ts";
import { diffState } from "../sync/state-patch.ts";
import { _verdictLost } from "./action-ack.ts";
import {
  getSyncReplayContext,
  issuedThrough,
  recordCleanStop,
} from "./aio-boot.ts";
import {
  setupDispatch,
  showAppIconEffect,
  showNotifyEffect,
} from "./aio-dispatch.ts";
import { buildAppObject, guardMirroredWrites } from "./aio-run-helpers.ts";
import type { AioUser } from "./aio-types.ts";
import { createCellWorkerPool } from "./cell-worker-pool.ts";
import {
  LISTENS_TO_CMD,
  LISTENS_TO_SYNC_OP_CMD,
  SYNC_APPLIED_TYPE,
  SYNC_INTENT_TYPE,
  SYNC_REACTION_TYPE,
  type SyncReaction,
  type TimeTravelRestore,
  TT_RESTORE_TYPE,
  unstoredCellOf,
  workerPatchCell,
} from "./journal.ts";
import { PERSIST_REFUSED } from "./server-trojan.ts";
import { createShutdownOrchestrator } from "./shutdown.ts";
import { resolveAppId } from "./single-instance-lock.ts";
import { resolve } from "@std/path";
import type { BootCtx, SaveNow } from "./boot-ctx.ts";

export function handleTTCommand<S, A, E>(
  ctx: BootCtx<S, A, E>,
  cmd: string,
  arg?: number,
): void | Promise<string | undefined> {
  if (!ctx.tt) return;
  const prev = ctx.tt;
  switch (cmd) {
    case "undo":
      ctx.tt = undo(ctx.tt);
      break;
    case "redo":
      ctx.tt = redo(ctx.tt);
      break;
    case "goto":
      if (arg !== undefined) ctx.tt = travelTo(ctx.tt, arg);
      break;
    case "pause":
      ctx.tt = pause(ctx.tt);
      break;
    case "resume":
      ctx.tt = resume(ctx.tt);
      break;
    default:
      log.debug(`time-travel: unknown command '${cmd}'`);
      return;
  }
  if (ctx.tt === prev) return;
  // Only a MOVE replaces live state. `pause`/`resume` return a new TTState
  // (the flag) at the same position, and treating that as a jump rewound
  // live state to the last RECORDED entry — undoing every action
  // `skipActions` had let through since (they "dispatch, broadcast and
  // persist normally"), and journalling the rewind. Same position, same
  // entries: the flag changes, the state does not.
  const moved = ctx.tt.index !== prev.index || ctx.tt.entries !== prev.entries;
  const restored = moved ? stateAt(ctx.tt) : null;
  if (restored !== null) {
    const before = ctx.state;
    ctx.state = restored;
    // A worker cell's copy would otherwise keep mutating the state we just
    // discarded — re-seed it from the restored slice.
    ctx._reseedWorkerCells();
    if (restored !== before) {
      ctx._owedTo = ctx._ttOwed;
      try {
        ctx._recordTimeTravel(cmd, arg, before, restored);
        ctx._jumpSyncCells(before, restored);
      } finally {
        ctx._owedTo = null;
      }
    }
  }
  log.debug(
    `time-travel: ${cmd}${
      arg !== undefined ? ":" + arg : ""
    } → index ${ctx.tt.index}/${
      ctx.tt.entries.length - 1
    } paused=${ctx.tt.paused}`,
  );
  ctx.server.broadcastTT();
  ctx.server.broadcast();
  ctx.udsCtrl.broadcastFull();
  return ctx._durableFor(ctx._ttOwed);
}

export function _storedSlice<S, A, E>(
  ctx: BootCtx<S, A, E>,
  cell: string,
  slice: unknown,
): unknown {
  ctx._shapeThrew = false;
  try {
    return (ctx.getDBState({ [cell]: slice } as S) as
      | Record<string, unknown>
      | undefined)?.[cell];
  } catch (e) {
    ctx._shapeThrew = true;
    // A shape that throws is the same failure the persist path reports
    // on its next write. Nothing is written for the cell — a journal
    // line must never carry what the store refused to.
    log.error(
      `journal: could not shape the "${cell}" slice the way the store ` +
        `writes it, so the journal line carries none of it — a replay ` +
        `leaves the cell where it is: ${
          e instanceof Error ? e.message : String(e)
        }`,
    );
    return undefined;
  }
}

export function _recordTimeTravel<S, A, E>(
  ctx: BootCtx<S, A, E>,
  cmd: string,
  arg: number | undefined,
  before: S,
  after: S,
): void {
  const ts = Date.now();
  const ttPayload = { cmd, ...(arg !== undefined ? { arg } : {}) };
  let seq: number;
  if (ctx.journal) {
    const cells: TimeTravelRestore["cells"] = {};
    let withheld = false;
    for (
      const [cell, slice] of Object.entries(after as Record<string, unknown>)
    ) {
      // A sync cell recovers from its own op-log, never from the journal.
      if (ctx._syncCellSet.has(cell)) continue;
      if (slice === null || typeof slice !== "object") continue;
      // A redacted cell's state goes in no sink — the store keeps the jump
      // (saved now, below), the journal does not.
      if (ctx.redact.redactsCell(cell)) {
        withheld = true;
        continue;
      }
      // WHAT THE STORE WOULD WRITE for this slice — the store's own getter,
      // not a second reading of the declaration. `persist` is TWO screens:
      // the include/exclude filter (dot paths included) and then
      // `onPersist`, which reshapes what goes to disk. Screening through
      // the flags map wrote `meta` whole for `exclude: ["meta.cache"]`;
      // screening through the filter alone still wrote the session token an
      // `onPersist` strips — the field the store has never once held, put
      // on disk by pressing undo. The replay side already asks this getter
      // (`_roundTripReplayedCells`); this is the write side asking it too.
      //
      // `persist: "none"` ⇒ nothing of this cell is stored, so the line
      // names it not at all; replay leaves such a cell where it is either
      // way.
      const kept = ctx._storedSlice(cell, slice);
      if (kept !== undefined) {
        cells[cell] = kept as Record<string, unknown>;
      }
    }
    const restore: TimeTravelRestore = { ...ttPayload, cells };
    seq = ctx._journalAppend({ type: TT_RESTORE_TYPE, payload: restore }, ts);
    if (withheld) ctx._saveNow({ clock: "kv" });
  } else seq = ctx.timeline.lastSeq() + 1;
  ctx.timeline.record(seq, TT_RESTORE_TYPE, ttPayload, before, after, ts);
}

export const _afterAction = <S, A, E>(
  ctx: BootCtx<S, A, E>,
  prev: S,
  next: S,
  action: A,
): void => {
  ctx._diagAfterAction?.(prev, next, action);
  // An async method's failure is its own frame, `cell:__error`, which is
  // not recorded (and usually changes nothing, so it would stop at the
  // no-op check below). Its CALL was recorded at call time — say on that
  // entry that it threw, before anything else can return.
  const errType = (action as { type?: unknown }).type;
  if (typeof errType === "string" && errType.endsWith(":__error")) {
    const callId = (action as { payload?: { _callId?: unknown } }).payload
      ?._callId;
    if (typeof callId === "string") ctx.timeline.markThrew(callId);
  }
  // Before anything can return: a reduced sync op, even a no-op one —
  // unless its cell refused it.
  ctx._markSyncApplied(action);
  if (prev === next) return; // no-op action — nothing to record
  const t = (action as { type?: string }).type ?? "";
  const ci = t.indexOf(":");
  const cell = ci >= 0 ? t.slice(0, ci) : "";
  const method = ci >= 0 ? t.slice(ci + 1) : t;
  // A `listensTo` reaction: ANOTHER sync cell changed inside this action's
  // reduce. It is not that cell's op (so not in its op-log), boot replay
  // re-folds only an op's own cell (replaySyncOps), and sync cells are out
  // of KV — so it is durable only once folded into the cell's own snapshot,
  // the same path every server-origin write takes (which also pushes it to
  // live clients). The action's own cell is handled just below.
  for (const c of ctx._syncCellSet) {
    if (
      c !== cell &&
      (prev as Record<string, unknown>)[c] !==
        (next as Record<string, unknown>)[c]
    ) {
      ctx._quarantinedWrite(c);
      ctx.syncHandler?.noteServerWrite(c);
    }
  }
  // How far this cell's live state holds its op-log — set at the commit of
  // each op, so a reaction journalled at any later instant knows exactly
  // which of the cell's ops it already contains (`SyncReaction.at`).
  // Honoured only on the sync handler's own op (`_syncOp`, which every
  // network door strips along with `_syncTs` — sanitizeClientAction): a
  // forged position must never move the mark.
  const isSyncOp = !!(action as { _syncOp?: boolean })._syncOp;
  const syncTs = (action as { _syncTs?: unknown })._syncTs;
  if (isSyncOp && typeof syncTs === "number" && ctx._syncCellSet.has(cell)) {
    ctx._appliedTs.set(cell, Math.max(ctx._appliedTs.get(cell) ?? 0, syncTs));
  }
  // `listensTo` reactions that land on a DIFFERENT save clock than the
  // action's own line (a sync cell folds on its own; see `_syncJournal`) are
  // journalled AS DATA — see `_journalReaction`, appended after the
  // action's own line below. A sync op has no journal line at all, so every
  // reaction to one counts; a store-persisted cell reacting to a
  // store-persisted action rides that action's own line.
  const reacted = ctx._syncJournal
    ? ctx._reactedKeys(prev, next, cell).filter((k) =>
      isSyncOp || ctx._syncCellSet.has(k) || ctx._syncCellSet.has(cell)
    )
    : [];
  const multiClock = reacted.length > 0;
  if (ctx._syncCellSet.has(cell)) {
    // A sync op is already durable in the op-log. Anything ELSE that
    // committed to a sync cell — an effect, cron, serverFn, a plain action,
    // an async method's `__set` batch — is durable NOWHERE (sync cells are
    // excluded from KV), so fold current state into the cell's sync
    // snapshot. Without this, a restart silently rewound every server-origin
    // write since the last compaction. `app.cells.disable`'s reset is such
    // a write: skipped, a restart brought the data back.
    if (
      method.startsWith("__") && !method.startsWith("__set") &&
      !ctx._isDisableReset(action)
    ) return;
    if ((action as { _syncOp?: boolean })._syncOp) {
      // The op is durable in the op-log already; its LISTENERS' reactions
      // are in no log at all — journal them (as data, never the op).
      if (reacted.length > 0) ctx._journalReaction(next, reacted, true);
    } else {
      ctx._quarantinedWrite(cell);
      ctx.syncHandler?.noteServerWrite(cell);
      // …and the fold is up to 500 ms away, while the caller was acked NOW.
      // A SIGKILL inside that window lost every acked write in it — all 36
      // of them in a 300 ms burst — under the one option that exists to
      // prevent exactly that. So `journal: true` journals it like any other
      // write, by the cell's own watermark (see `_syncJournal`), and boot
      // replays it after the op-log restore. A refused append closes the
      // window by folding now (the fold noted just above is what it flushes).
      if (ctx._syncJournal && ctx._quarantinedSkip(cell)) {
        // No line for the quarantined cell itself — its reactions on
        // other cells are journalled as usual.
        ctx._journalReaction(next, reacted, false);
      } else if (ctx._syncJournal) {
        const payload = (action as { payload?: unknown }).payload;
        ctx._journalAppend(
          {
            type: t,
            payload,
            origin: isWriteSetAction(t) ? actionOrigin(t, payload) : undefined,
            user: (action as { _user?: AioUser })._user,
            cause: ctx._causeOf(action),
            call: ctx._callOf(action),
          },
          Date.now(),
          { clock: "sync", cell },
        );
        // …and the state it left, AT its op-log position. Replayed as a
        // call after the whole op-log, the write landed after ops the
        // server applied AFTER it: `clear` then an acked `add("new")`,
        // SIGKILL → boot folded `add` and then cleared it (the op row stays,
        // so the client never resends — for good). As data at `at`, boot
        // puts it back BETWEEN the ops (`seedSyncReactions`), and the call
        // line above — kept for `am timeline`/`am replay` — is covered by
        // it (its seq is below the data line's).
        ctx._journalReaction(next, [cell, ...reacted], false, false, cell);
      }
    }
    return;
  }
  // Framework-internal actions are noise — EXCEPT the write-set commit.
  //
  // An async or transactional method publishes everything it wrote as one
  // atomic `cell:__setMethod` (cell-impl.ts's batcher). The outer
  // `cell:method` action IS recorded, but it commits at CALL time, before the
  // method has written anything — so filtering `__set` as "framework noise"
  // meant an async method's writes existed in NO sink at all. The costs were
  // not cosmetic: journal replay reconstructed the pre-write state while boot
  // still logged "recovered N action(s)"; `transaction: true` promised "a
  // single journal entry … boot replay reconstructs it" and delivered the
  // opposite; `am timeline` printed `"diff": []` for an action that changed
  // everything; and time-travel `undo` landed on a state the app never had,
  // which in one shape destroyed a committed write permanently.
  //
  // It is recorded as its OWN entry, attributed to the originating method via
  // `origin` — not folded into the `cell:method` entry, which was already
  // written and journalled at call time and cannot be amended (a method may
  // also commit several times via `s.$commit()`). `type` stays the action
  // that really ran, so replay re-reduces exactly what happened.
  //
  // The rest of the `__` family stays out on purpose: `__init` is
  // lifecycle, and replaying it would re-run a boot step ON TOP of the
  // restored snapshot. `__exec`/`__error` carry machine transitions, not
  // the app's writes. `app.cells.disable`'s `__destroy` IS one (the
  // shutdown's is teardown, and a breaker trip's keeps the state): a reset
  // left out of the journal came back after a crash under the writes made
  // since — `["a"]`, disable+enable, `add("b")`, SIGKILL → `["a","b"]`.
  //
  // A `worker: true` cell's commits are the other exception. Its method runs
  // in the worker and never reaches this hook; only the patches it commits
  // do, as `__aioWorkerPatch` — a type with no `cell:` prefix, so it read as
  // framework noise and a worker cell reached NO sink: a `journal: true` app
  // never created its journal file and lost acked writes to a SIGKILL, and
  // `am timeline` never showed the cell. The patch batch is that cell's
  // write-set; it is recorded under the type that really ran (replay applies
  // it exactly as the live reduce did) and attributed to the cell.
  const isWriteSet = isWriteSetAction(t);
  const payload = (action as { payload?: unknown }).payload;
  const workerCell = workerPatchCell(t, payload);
  if (
    method.startsWith("__") && !isWriteSet && workerCell === undefined &&
    !ctx._isDisableReset(action)
  ) {
    return;
  }
  // Who wrote it — from the ONE decider (diagnostics/action-kind.ts), which
  // the action log and the logger resolve the same fact with. It was computed
  // here by hand and again in the diagnostics sink, and the redactor depends
  // on it: an exact `redactActions` pattern matches the CALL, so a sink whose
  // copy of this drifts leaks the same secret under the write-set's type.
  const origin = isWriteSet
    ? actionOrigin(t, payload)
    : workerCell !== undefined
    ? `${workerCell}:__worker`
    : undefined;
  const ts = Date.now();
  const cause = ctx._causeOf(action);
  const call = ctx._callOf(action);
  const seq = ctx.journal
    ? ctx._journalAppend(
      {
        type: t,
        payload,
        origin,
        user: (action as { _user?: AioUser })._user,
        cause,
        call,
      },
      ts,
    )
    : ctx.timeline.lastSeq() + 1;
  // A `persist: "none"` cell's call went in with its arguments withheld
  // and is not replayed (`JournalEntry.unstored`) — so what it wrote to
  // PERSISTED cells (a `listensTo` reaction, an `s.$call`) rides no call
  // line: it is journalled as data, the way a reaction to a sync op is.
  const owner = unstoredCellOf(t, payload, origin);
  const asData = ctx.journal?.unstored?.(owner)
    ? ctx._reactedKeys(prev, next, owner).filter((k) =>
      !reacted.includes(k) && !ctx._syncCellSet.has(k) &&
      !ctx.journal!.unstored?.(k)
    )
    : [];
  if (ctx.journal && (multiClock || asData.length > 0)) {
    ctx._journalReaction(next, [...reacted, ...asData], false);
  }
  // `cell({ diagnostics: false })` covers `am timeline` too. A key by that
  // name that still listed the cell in the diagnostic surface people
  // actually read would be dishonest.
  //
  // AFTER the journal append, never instead of it: `journal: true` is a
  // durability promise, and dropping a cell's committed actions from the
  // replay log would be data loss dressed as a privacy feature.
  // By the origin when there is one: a worker batch's type names no cell.
  if (!isDiagnosticsOptOut(origin ?? t)) {
    ctx.timeline.record(seq, t, payload, prev, next, ts, origin, cause, call);
  }
};

/** A server-origin write (a plain call, an effect, a cron, a listener's
 *  reaction) to a quarantined sync cell: client ops are refused at the
 *  door, but this one already committed in memory — and its cell can save
 *  nothing (no fold, no journal line), so the next restart loses it. Owed
 *  as a refused save, so every door's ack carries it as `unsaved`, and said
 *  in the log: the first at once, the rest counted and said within 10 s. */
export function _quarantinedWrite<S, A, E>(
  ctx: BootCtx<S, A, E>,
  cell: string,
): void {
  if (
    !ctx.asyncDb || !getSyncReplayContext(ctx.asyncDb)?.quarantined.has(cell)
  ) {
    return;
  }
  const why = `"${cell}" is quarantined (its op-log could not be folded ` +
    `at boot) — this write is applied in memory only and is lost on ` +
    `restart; fix its version/onMigrate and restart`;
  void ctx._owe(Promise.resolve(`${PERSIST_REFUSED} ${why}`));
  const said = ctx._quarantinedWrites.get(cell);
  const now = Date.now();
  if (said === undefined || now - said.at >= 10_000) {
    if (said?.timer !== undefined) clearTimeout(said.timer);
    const more = said?.n ? ` (and ${count(said.n, "earlier write")})` : "";
    ctx._quarantinedWrites.set(cell, { n: 0, at: now });
    log.error(`sync: a write to ${why}${more}`);
    return;
  }
  said.n++;
  if (said.timer !== undefined) return;
  const timer = setTimeout(() => {
    ctx._quarantinedWrites.set(cell, { n: 0, at: Date.now() });
    log.error(
      `sync: ${count(said.n, "more write")} to "${cell}" in the last 10 s ` +
        `applied in memory only — it is quarantined; they are lost on ` +
        `restart`,
    );
  }, said.at + 10_000 - now);
  said.timer = timer;
  Deno.unrefTimer(timer);
}

/** COMMIT(X) — a sync op on a listened action was REDUCED and not refused
 *  (journal.ts J1–J7). Written inside the op's `_atomically` block, so it and every
 *  reaction line of the op reach a reader together or not at all. */
export function _markSyncApplied<S, A, E>(
  ctx: BootCtx<S, A, E>,
  action: A,
): void {
  if (!ctx._syncJournal) return;
  const a = action as {
    type?: string;
    _syncOp?: boolean;
    _syncTs?: unknown;
    _syncId?: unknown;
  };
  if (
    !a._syncOp || typeof a._syncTs !== "number" ||
    typeof a._syncId !== "string"
  ) return;
  const type = a.type ?? "";
  if (!ctx._listenedTypes.has(type)) return;
  const c = type.slice(0, type.indexOf(":"));
  if (!ctx._syncCellSet.has(c) || ctx._quarantinedSkip(c)) return;
  // Reduced, and REFUSED by its own cell without a throw (a `validate`, a
  // guard): no commit. The commit is what the next boot takes as proof the
  // op was accepted — a kill before the refused row's delete then kept the
  // row, and its author's resend was acknowledged for an op in no state.
  // Uncommitted, the row is in flight (J4): that boot decides it again.
  if (hasRejectionFor(action, c)) return;
  ctx._journalAppend(
    {
      type: SYNC_APPLIED_TYPE,
      payload: { cell: c, id: a._syncId, ts: a._syncTs },
      only: [c],
    },
    Date.now(),
    { clock: "sync", cell: c },
  );
}

/** INTENT(X) — see journal.ts J3: after the op's value is issued, before
 *  its row is inserted. A refused append is reported and the op goes on:
 *  the next boot finds it uncovered and names it (never re-derives it). */
export function _intendSyncOp<S, A, E>(
  ctx: BootCtx<S, A, E>,
  op: { id: string; cell: string; action: string },
  ts: number,
): void {
  if (!ctx._listenedTypes.has(`${op.cell}:${op.action}`)) return;
  if (!ctx._syncCellSet.has(op.cell) || ctx._quarantinedSkip(op.cell)) return;
  try {
    ctx.journal!.append(
      {
        type: SYNC_INTENT_TYPE,
        payload: { cell: op.cell, id: op.id, ts },
        only: [op.cell],
      },
      Date.now(),
    );
    ctx._journalSaid.landed();
  } catch (e) {
    ctx._journalSaid.refused(e);
    reportAioError(
      createAioError("PERSIST_ERROR", e, { actionType: SYNC_INTENT_TYPE }),
      ctx._reportOpts,
    );
  }
}

export function _journalReaction<S, A, E>(
  ctx: BootCtx<S, A, E>,
  next: S,
  reacted: readonly string[],
  bySyncOp: boolean,
  /** A time-travel jump's sync cells (`_jumpSyncCells`), not a reaction. */
  jump = false,
  /** The sync cell a server write changed: its line is the state that
   *  write left (`SyncReaction.write`), not a reaction. */
  wrote?: string,
): void {
  const cells: TimeTravelRestore["cells"] = {};
  const deltas: NonNullable<TimeTravelRestore["deltas"]> = {};
  const written: [string, unknown][] = [];
  let withheldKv = false;
  for (const k of reacted) {
    const slice = (next as Record<string, unknown>)[k];
    if (slice === null || typeof slice !== "object") continue;
    // A redacted cell's state is written to no diagnostic sink, and the
    // journal is one: made durable by its own save instead, now.
    if (ctx._syncCellSet.has(k) && ctx._quarantinedSkip(k)) continue;
    if (ctx.redact.redactsCell(k)) {
      if (ctx._syncCellSet.has(k)) ctx._saveNow({ clock: "sync", cell: k });
      else withheldKv = true;
      continue;
    }
    if (ctx._syncCellSet.has(k)) {
      const link = ctx._reactionChain.get(k);
      const at = ctx._appliedTs.get(k) ?? 0;
      const payload: SyncReaction = link
        ? {
          cell: k,
          at,
          ops: diffState(link.state, slice),
          ...(link.snapshotAt !== undefined
            ? { baseSnapshotAt: link.snapshotAt }
            : { base: link.seq }),
        }
        : { cell: k, at, state: slice as Record<string, unknown> };
      // A fold in flight: its snapshot may land before the next line.
      const inFlight = ctx._captured.get(k);
      if (inFlight !== undefined && !inFlight.lined) {
        inFlight.lined = true;
        if (link) {
          payload.alsoSnapshot = {
            at: inFlight.at,
            ops: diffState(inFlight.state, slice),
          };
        }
      }
      if (bySyncOp) payload.bySyncOp = true;
      if (jump) payload.jump = true;
      if (k === wrote) payload.write = true;
      ctx._appendOk = true;
      const seq = ctx._journalAppend(
        {
          type: SYNC_REACTION_TYPE,
          payload,
          only: [k],
          v: { [k]: ctx.config._cellVersions?.[k] ?? 0 },
        },
        Date.now(),
        { clock: "sync", cell: k },
      );
      // A line that did not land cannot be a base: the next one restarts.
      if (ctx._appendOk) ctx._reactionChain.set(k, { seq, state: slice });
      else ctx._reactionChain.delete(k);
      continue;
    }
    const kept = ctx._storedSlice(k, slice);
    if (kept === undefined) {
      // The shape threw: no line can carry it, and the store's own save
      // is the one that says so — owed, so the caller hears `unsaved`.
      if (ctx._shapeThrew) withheldKv = true;
      continue;
    }
    const link = ctx._kvChain.get(k);
    if (link) {
      deltas[k] = { base: link.seq, ops: diffState(link.stored, kept) };
    } else cells[k] = kept as Record<string, unknown>;
    written.push([k, kept]);
  }
  if (withheldKv) ctx._saveNow({ clock: "kv" });
  if (written.length === 0) return;
  ctx._appendOk = true;
  const seq = ctx._journalAppend(
    {
      type: TT_RESTORE_TYPE,
      payload: {
        cmd: bySyncOp ? LISTENS_TO_SYNC_OP_CMD : LISTENS_TO_CMD,
        // Empty on purpose — see `TimeTravelRestore.keyframes`: an older
        // reader must find nothing here to apply.
        cells: {},
        ...(Object.keys(cells).length > 0 ? { keyframes: cells } : {}),
        ...(Object.keys(deltas).length > 0 ? { deltas } : {}),
      } satisfies TimeTravelRestore,
      only: written.map(([k]) => k),
    },
    Date.now(),
    { clock: "kv" },
  );
  for (const [k, kept] of written) {
    if (ctx._appendOk) ctx._kvChain.set(k, { seq, stored: kept });
    else ctx._kvChain.delete(k);
  }
}

/** Resolves once `what` is durable — the caller's ack waits for it (see
 *  `_durableFor`). */
/** Resolves once `what` is saved — with why it is NOT (the fold's error,
 *  the store's `lastCycleError()`), or undefined when it is. The caller's
 *  ack waits for it and carries a failure as `unsaved` (see `_durableFor`,
 *  action-ack.ts). */
export function _saveNow<S, A, E>(
  ctx: BootCtx<S, A, E>,
  what: SaveNow,
): Promise<string | undefined> {
  const f = ctx._saving[what.clock];
  if (what.clock === "sync") {
    f.cells.add(what.cell);
    // A fold flushes only a cell with a write pending — and the line that
    // did not land may be the one a sync op's own cell owes (its reduced
    // mark, `SYNC_APPLIED_TYPE`), which no server write announced.
    ctx.syncHandler?.noteServerWrite(what.cell);
  }
  // A save that has not started yet reads the state when it does: it
  // covers this request too.
  if (f.queued !== null) return ctx._owe(f.queued);
  const start = (): Promise<string | undefined> => {
    const cells = [...f.cells];
    f.cells.clear();
    // `flushPersist()` never rejects by contract — a refused cycle is
    // reported inside it and read back through `lastCycleError()`, which
    // is what `am persist` and `/__aio/health` answer with. So a rejection
    // HERE is a broken contract, not a refused write, and the one thing it
    // must not be is silent.
    const run: Promise<string | undefined> = what.clock === "sync"
      ? ctx.syncHandler!.flushServerWrites(cells)
      : ctx.persistence.flushPersist().then(() =>
        ctx.persistence.lastCycleError()?.message
      );
    return run.then(
      (why) => why === undefined ? undefined : `${PERSIST_REFUSED} ${why}`,
      (err) => {
        log.error(
          `journal: the save that stands in for a journal line threw — ` +
            `${err}. The verdict is still lastCycleError(); ask \`am ` +
            `persist\`.`,
        );
        return `${PERSIST_REFUSED} ${
          err instanceof Error ? err.message : String(err)
        }`;
      },
    );
  };
  // One save at a time per clock: behind the running one, never beside it.
  const p: Promise<string | undefined> = f.tail === null
    ? start()
    : f.tail.then(() => {
      f.queued = null;
      return start();
    });
  if (f.tail !== null) f.queued = p;
  f.tail = p;
  void p.finally(() => {
    if (f.tail === p) f.tail = null;
  });
  return ctx._owe(p);
}

export function _owe<S, A, E>(
  ctx: BootCtx<S, A, E>,
  p: Promise<string | undefined>,
): Promise<string | undefined> {
  const a = ctx._owedTo;
  if (a !== null) {
    const owed = ctx._owedByAction.get(a) ?? new Set();
    ctx._owedByAction.set(a, owed.add(p));
    const call = ctx._callOf(a as A);
    // Its author's call — and, when the author is a guess (`_sureOf`),
    // every call open now.
    const calls = ctx._sureOf.has(a)
      ? [call]
      : new Set([call, ...ctx._openCalls]);
    for (const c of calls) {
      if (c === undefined) continue;
      if (ctx._owedByCall.size >= 1024 && !ctx._owedByCall.has(c)) {
        // Never silently: a call still waiting to be answered is told
        // its verdict is lost (action-ack.ts `_verdictLost`).
        const lost = ctx._owedByCall.keys().next().value!;
        ctx._owedByCall.delete(lost);
        _verdictLost(lost);
      }
      const byCall = ctx._owedByCall.get(c) ?? new Set();
      ctx._owedByCall.set(c, byCall.add(p));
    }
  }
  return p;
}

export function _journalAppend<S, A, E>(
  ctx: BootCtx<S, A, E>,
  entry: Parameters<NonNullable<typeof ctx.journal>["append"]>[0],
  ts: number,
  // What makes this write durable without its journal line: the persist
  // flush for a KV cell, the fold for a sync cell (whose state the KV
  // snapshot does not hold, so a persist flush would close nothing).
  save: SaveNow = { clock: "kv" },
): number {
  try {
    const v = ctx._journalVersions(entry.type, entry.payload, entry.origin);
    ctx._atomicOwed?.push(save);
    const seq = ctx.journal!.append(v ? { ...entry, v } : entry, ts);
    ctx._journalSaid.landed();
    return seq;
  } catch (e) {
    ctx._appendOk = false;
    // Not a PERSIST_ERROR: the snapshot below saves this change now. Only
    // if THAT is refused is anything at risk — and persistence says so.
    ctx._journalSaid.refused(e);
    ctx._saveNow(save);
    // The counter already advanced; the timeline keeps the same seq so its
    // entries and the journal's lines stay aligned for replay.
    return ctx.journal!.currentSeq();
  }
}

export function _setupDispatchCore<S, A, E>(ctx: BootCtx<S, A, E>) {
  return setupDispatch<S, A, E>({
    reduce: withShapeGuard(
      ctx.reduce,
      ctx._writeGuard,
      ctx.config._cellBreaker?.count,
    ),
    // Effects run inside the effect scope, so everything they dispatch — now,
    // or later from a timer, a promise or an async body they started — is
    // recorded as `cause: "effect"` (see `_effectScope`).
    execute: (app, e) =>
      ctx._effectScope.run(
        true,
        () =>
          ctx._inCallScope(
            e,
            (call, sure) => ctx.execute(ctx._callDoor(app, call, sure), e),
          ),
      ),
    beforeReduce: ctx.config.beforeReduce,
    onAction: ctx.onAction,
    onEffect: ctx.onEffect,
    getState: () => ctx.state,
    setState: (s) => {
      ctx.state = s;
    },
    getApp: () => ctx.app,
    getServer: () => ({
      broadcast: (patches) => ctx.server.broadcast(patches),
      broadcastTT: () => ctx.server.broadcastTT(),
      broadcastUi: (raw) => ctx.server.broadcastUi?.(raw) ?? 0,
    }),
    // A timer a method arms and a process it owns dispatch LATER, from their
    // own callbacks — which inherit the scope they were created in.
    scheduleManager: {
      handle: (e) =>
        ctx._effectScope.run(
          true,
          () => ctx._outsideCall(() => ctx.scheduleManager.handle(e)),
        ),
    },
    ownManager: {
      handle: (e) =>
        ctx._effectScope.run(
          true,
          () => ctx._outsideCall(() => ctx.ownManager.handle(e)),
        ),
    },
    schedulePersist: (p) => ctx.schedulePersist(p),
    getTT: () => ctx.tt,
    setTT: (t) => {
      ctx.tt = t;
    },
    reportOpts: ctx._reportOpts,
    cellPatchStrategies: ctx.config._cellPatchStrategies,
    cellFilterFields: ctx.config._cellFilterFields,
    onUdsBroadcast: ctx.udsCtrl.onUdsBroadcast,
    onPerf: ctx.onPerf,
    perfCheck: ctx.config.perfCheck,
    // Dev holds reduce to ONE FRAME (16ms) instead of the 100ms prod budget:
    // a reduce is on the server's single dispatch path, so every millisecond it
    // takes is a millisecond every client's next action waits. Dev-stricter is
    // the allowed direction (observe-only, throttled to one report per action
    // type per 10s) — it teaches the "keep actions instant, move compute
    // off-thread" habit while the app is still small. Prod keeps 100ms so a
    // deployed app doesn't chatter. An app's `perfBudget` merges over it per
    // field (setting `methods` alone keeps the dev reduce budget).
    perfBudget: perfBudgetFor(ctx.config.perfBudget, ctx.prod),
    perfLog: (source, type, duration, budget, breakdown) =>
      getLogger()?.perf(source, type, duration, budget, breakdown),
    freezeState: ctx.config.freezeState ?? !ctx.prod,
    effectTimeout: ctx.config.effectTimeoutMs,
    reduceBreakdown: ctx.config._reduceBreakdown,
    ttSkipActions: ctx.ttSkipActions,
    notifyCrossUser: ctx._notifyCrossUser,
    afterAction: ctx.afterActionHook,
    log,
    debug: ctx.VERBOSE,
  });
}

export function _createWorkerPool<S, A, E>(ctx: BootCtx<S, A, E>) {
  return createCellWorkerPool({
    // The SAME resolved value the main isolate uses and the boot line
    // prints — one decider, so a worker cell is never freeze-checked more
    // loosely than a local one.
    freezeState: ctx.freezeEnabled,
    // …and the SAME `refusalsReject` the composed reduce was given, for the
    // same reason: it decides what an in-process `await cell.method()` sees
    // when the reduce refuses the write, and a worker that never learned it
    // answered its callers differently from the cell sitting next to it.
    refusalsReject: ctx.config._refusalsReject === true,
    // …and the SAME supervision of a stray rejection (see initDiagAndVitals
    // above): a worker cell survives what the main isolate survives.
    guardRejections: ctx.config.guardDispatches ?? true,
    // …and the dev refusal of a declared-type change, which a worker cell's
    // reduce must run itself (the owner sees only its committed patches).
    ...(ctx.boot.strictTypeFilter
      ? { strictTypeFilter: ctx.boot.strictTypeFilter }
      : {}),
    // EVERY worker cell, hosted or not: the pool refuses what a thread
    // boundary cannot honour (selectors, sync, listensTo, a machine) before it
    // decides whether to host. It used to be handed `[]` under libraryMode, so
    // `testServer` booted a `worker: true` + `selectors` cell that the real
    // app refused to start.
    cells: (ctx.config._workerCells ?? []) as unknown as Parameters<
      typeof createCellWorkerPool
    >[0]["cells"],
    host: ctx._hostWorkers,
    entry: ctx._workerEntry,
    prod: ctx.prod,
    getSlice: (cell) =>
      ((ctx.state as Record<string, unknown>)[cell] ?? {}) as Record<
        string,
        unknown
      >,
    dispatch: (a) => ctx.dispatch(a as unknown as A),
    // The SAME identity `composeCells` was given (aio-composition.ts), so the
    // pool scopes the cancel registry exactly as the composed reduce does.
    appId: ctx.appId,
    // The main door's paused-time-travel refusal, for calls routed around it.
    isPaused: () => ctx.tt?.paused === true,
    // A worker cell's INIT_ERROR / EFFECT_ASYNC_ERROR reaches the app's
    // `onError` exactly as the same cell's does on this isolate.
    reportError: (err) => reportAioError(err, ctx._reportOpts),
    // …and counts toward the app's `circuitBreaker`, as it does there.
    ...(ctx.config._cellBreaker ? { breaker: ctx.config._cellBreaker } : {}),
    // An effect handed back by a worker executes HERE, where the runtime lives.
    // A schedule effect is NOT an action — dispatching it would do nothing at
    // all, and the schedule would silently never fire.
    // Inside the effect scope, like a main-isolate effect: what it dispatches
    // or schedules is `cause: "effect"` (see `_effectScope`).
    runEffect: (effect) =>
      ctx._effectScope.run(true, () =>
        // ONE exhaustive classifier, the same one the dispatch loop and the
        // worker host use — a new framework effect kind is a compile error here
        // rather than something this router silently treats as an app action
        // (see route-effect.ts). This site hand-wrote the chain, and the kind it
        // had never been taught about was `notify`: a `notify()` from a worker
        // cell was posted home correctly and then dispatched here as an action
        // type no cell answers, so the notification simply never appeared.
        // `__own` had been exactly the same bug one kind earlier.
        routeEffect<unknown>(effect, {
          schedule: (e) => ctx.scheduleManager.handle(e),
          // Worker cells hold their resources in their own isolate
          // (cell-worker-host.ts), so nothing should arrive here — and if
          // anything ever does, the own manager says so out loud.
          own: (e) => ctx.ownManager.handle(e),
          // The clients live on this isolate; same semantics as a notify from a
          // main-isolate cell, because it is the same function.
          notify: (e) =>
            ctx._notifyCrossUser(
              showNotifyEffect(
                e,
                ctx.server?.broadcastUi,
                (m) => log.warn("aio", m),
              ),
              ctx._workerUserCalls > 0,
            ),
          appIcon: (e) =>
            void showAppIconEffect(
              e,
              ctx.server?.broadcastUi,
              (m) => log.warn("aio", m),
            ),
          app: (e) => void ctx.dispatch(e as unknown as A), // cross-cell action
        })),
  });
}

export function _createShutdown<S, A, E>(ctx: BootCtx<S, A, E>) {
  return createShutdownOrchestrator({
    sessionStore: ctx.sessionStore,
    userStore: ctx.userStore,
    flushPersist: async () => {
      await ctx.persistence.flushPersist();
      // Sync cells' server-origin writes debounce into their snapshot — a
      // clean exit must not leave the last write inside that window.
      const unfolded = await ctx.syncHandler?.flushServerWrites();
      // What a clean stop covers: every value this run issued (input is
      // closed by now) — read AFTER the folds, which take values of their
      // own, so the next run's first value continues the range. Only a run
      // that SAVES: with persist off no store holds a store-persisted
      // listener's reactions, so there is nothing to vouch for.
      const cleanTo =
        ctx.asyncDb && ctx.shouldPersist && ctx._cleanRunFrom !== undefined
          ? await issuedThrough(ctx.asyncDb).catch(() => undefined)
          : undefined;
      // The manager never rejects (the loop has to survive a bad window), so
      // the verdict is read back — and on the LAST flush there is no next
      // window to fix it in. A clean-looking exit that dropped every write
      // since the first refusal is exactly the shape this line exists to
      // break: the process is still going down (refusing to exit would strand
      // the operator), but it says what it is taking with it.
      const failed = ctx.persistence.lastCycleError();
      if (failed) {
        log.error(
          `shutdown: the FINAL persist was refused — ${failed.message}`,
        );
      } else if (
        !unfolded && cleanTo !== undefined && ctx._cleanRunFrom !== undefined &&
        ctx.asyncDb
      ) {
        // Every record is saved: say so, for the next boot (`CLEAN_STOP_ROW`).
        await recordCleanStop(ctx.asyncDb, ctx._cleanRunFrom, cleanTo).catch((
          e,
        ) => log.warn(`shutdown: could not record the clean stop — ${e}`));
      }
      if (!failed && ctx.shouldPersist) {
        // A clean verdict from the HANDLE is not a fact about the disk. Delete
        // the database out from under a running app (a cleared tmp dir, a
        // container volume that was not really persistent, `am remove --data
        // --force`) and POSIX keeps the inode alive for the open fd: SQLite
        // commits happily into a file no path can reach. Measured: every
        // window after the deletion reported success, `lastCycleError()` stayed
        // null, and the app exited `errors=0` having lost every write since.
        // Existence is the cheapest fact that catches it, and this is the one
        // moment it costs nothing — there is no next window to notice in.
        // `:memory:` is SQLite's SENTINEL for "there is no file", not a path.
        // Resolving it produced `<cwd>/:memory:`, which of course does not
        // exist, so every in-memory app ended a clean run with a FATAL-sounding
        // "the database file is GONE … NONE of them are on disk" — about a
        // database that was never meant to be on disk. A false alarm in the one
        // message that must be believed the day it is real is worse than no
        // message: it is how a reader learns to discount this exact line.
        const dbFile = ctx.dbPath ? resolve(ctx.dbPath) : ctx._dirs.stateDb;
        const inMemory = ctx.dbPath === ":memory:" ||
          ctx.dbPath === "file::memory:" ||
          String(ctx.dbPath ?? "").startsWith(":memory:");
        const gone = inMemory ? false : await Deno.stat(dbFile).then(
          () => false,
          (e) => e instanceof Deno.errors.NotFound,
        );
        if (gone) {
          log.error(
            `shutdown: the database file is GONE (${dbFile}) — it was deleted ` +
              `while the app was running, so writes since then committed into ` +
              `an unlinked file and NONE of them are on disk.`,
          );
        }
      }
    },
    setShuttingDown: ctx.persistence.setShuttingDown,
    diagHooks: ctx.diagHooks,
    getVitalsCheckTimer: () => ctx._vitalsCheckTimer,
    getVitalsSystem: () => ctx.vitalsSystem,
    onStopping: ctx.onStopping,
    // In the orchestrator's own sequence (after onStopping, before dispatch
    // closes) — so no shutdown path can skip it or run it out of order.
    closeWorkers: () => ctx.workerPool.close(),
    onStop: ctx.onStop,
    appLock: ctx.appLock,
    releaseFileSizeGuard: ctx.releaseFileSizeGuard,
    scheduleManager: ctx.scheduleManager,
    ownManager: ctx.ownManager,
    dispatch: ctx.dispatch,
    // Shutdown aborts + drains THIS app's cells only — another app sharing the
    // process (D2) keeps running its own in-flight methods.
    getCellNames: () => ctx.config._cellNames ?? [],
    getAppId: () => resolveAppId(ctx.config.appId),
    getElectronProc: () => ctx._electronProc,
    clearElectronProc: () => {
      ctx._electronProc = null;
    },
    disposeUds: ctx.udsCtrl.dispose,
    getUdsHandle: () => ctx.udsHandle,
    getServer: () => ctx.server,
    getDiscoveryStop: () => ctx.discoveryRef.stop,
    asyncDb: ctx.asyncDb,
    kvDb: ctx.kvDb,
    setRunning: (_v: boolean) => {
      /* multi-instance (D2): no process-wide running flag */
    },
    log,
  });
}

export const shutdown = async <S, A, E>(
  ctx: BootCtx<S, A, E>,
): Promise<void> => {
  // FIRST, before anything awaits: boot steps still in flight (the Electron
  // launch) read this and refuse to start what the shutdown would miss.
  ctx._stopCtl.abort();
  await ctx._shutdownRuntime(); // closes the worker cells too (`closeWorkers`)
  ctx._offCallSettle();
  // A closed app owns nothing: release THIS app's cells so they can bind
  // again. Without it a cell def stayed claimed for the life of the process,
  // so two `testServer()` blocks in one file failed with "already bound" even
  // with `await using` — the second test had to move to its own file for no
  // visible reason. Scoped to our own cells, so a second app in
  // the same process is untouched.
  // The closed worker cells' reasons ride along as plain data: released,
  // they keep answering by name, as the closed pool does.
  const release = (ctx.app as Record<string, unknown>)._releaseCells as
    | ((closedWorkers: Record<string, string | null>) => void)
    | undefined;
  release?.(ctx.workerPool.closedBy());
  ctx._unregisterAuthStore?.();
  ctx._unregisterRuntime();
};

export function _buildApp<S, A, E>(ctx: BootCtx<S, A, E>) {
  return buildAppObject<S, A>({
    dispatch: ctx.appDispatch,
    getState: () => ctx.state,
    // Only a snapshot load replaces state through here. Journalled as the
    // state it put in place, in the same turn, exactly like a time-travel
    // jump: the load only SCHEDULES a persist, so an action acked on the
    // loaded state and a crash inside the debounce replayed that action onto
    // the PRE-load database (5, load 1000, deposit(1), SIGKILL → 6).
    // tests/journal-snapshot-load-crash.test.ts.
    // …and its SYNC cells as a server write, as a jump's are: a sync cell is
    // durable only in its op-log and fold snapshot, which the scheduled KV
    // persist never writes — so `am snapshot load` answered "loaded" and a
    // restart brought back the writes it undid.
    // tests/snapshot-load-sync-cell-durable.test.ts.
    setState: (s) => {
      const before = ctx.state;
      ctx.state = s;
      if (s !== before) {
        ctx._recordTimeTravel("snapshot", undefined, before, s);
        ctx._jumpSyncCells(before, s);
      }
    },
    port: ctx.port,
    asyncDb: guardMirroredWrites(
      ctx.asyncDb,
      ctx.boot.mirroredTables,
      (m) => log.warn(m),
    ),
    initialState: ctx.initialState,
    persistence: ctx.persistence,
    schedulePersist: () => ctx.schedulePersist(),
    getTT: () => ctx.tt,
    setTT: (t) => {
      ctx.tt = t;
    },
    getServer: () => ctx.server,
    udsBroadcastFull: () => ctx.udsCtrl.broadcastFull(),
    onStateReplaced: () => ctx.workerPool.reseed(),
    shutdown: ctx.shutdown,
    sessionStore: ctx.sessionStore,
    userStore: ctx.userStore,
    blobs: ctx.blobStore,
  });
}
