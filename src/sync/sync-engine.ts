// src/sync/sync-engine.ts — Client-side CRDT sync orchestrator
import { enc } from "../protocol/envelope.ts";
import { randomUuid } from "../rand.ts";
import type { HLC, SyncConfig, SyncOp, SyncStatus } from "./types.ts";
import { SYNC_DEFAULTS } from "./types.ts";
import type { OpBuffer } from "./op-buffer.ts";
import { compareHLC, createHLC, type HLClock } from "./hlc.ts";
import { rebase, type SyncReducer } from "./rebase.ts";
import type { SyncConflict } from "./types.ts";
import { mergeField } from "./merge.ts";

/**
 * Dependencies injected into the client-side sync engine.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export interface SyncEngineDeps {
  clientId: string;
  cells: Record<string, SyncConfig>;
  buffer: OpBuffer;
  send: (msg: string) => void;
  reducer: SyncReducer;
  getConfirmedState: () => Record<string, Record<string, unknown>>;
  /** Update confirmed state for a cell — called on remote ops and snapshots */
  setConfirmedState: (cell: string, state: Record<string, unknown>) => void;
  onStateUpdate: (cell: string, optimistic: Record<string, unknown>) => void;
  log?: {
    warn: (msg: string) => void;
    /** Observe-only dedup visibility — a dropped duplicate hints at a cursor
     *  bug upstream and must be visible in dev, never silent. */
    debug?: (msg: string) => void;
  };
}

/**
 * Client-side CRDT sync engine that buffers local ops, rebases on acks, and manages online/offline state.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export interface SyncEngine {
  handleLocalAction(
    cell: string,
    action: string,
    payload: unknown,
  ): Promise<void>;
  /** `serverTs` (alpha43+) is the op's cursor position — see the snapshot
   *  watermark in `handleAck`. A duplicate re-ack carries it too (the server
   *  reads the position back from the log row or its compaction tombstone);
   *  it is absent only from a server that cannot say. */
  handleAck(
    cell: string,
    opId: string,
    serverHlc: HLC,
    serverTs?: number,
  ): Promise<void>;
  /** D11: the server refused this op — drop it, rebase (optimistic view
   *  snaps back), log loudly, surface via the cell's sync.onRejected. */
  handleRejection(cell: string, opId: string, reason: string): Promise<void>;
  handleRemoteOp(op: SyncOp): Promise<void>;
  handleSyncResponse(response: {
    mode: string;
    ops?: SyncOp[];
    rebase?: SyncOp[];
    snapshot?: Record<string, Record<string, unknown>>;
    lowWater: HLC | Record<string, HLC>;
    /** Per-cell server_ts cursor echoed by the server. */
    lastServerTs?: Record<string, number>;
  }): Promise<void>;
  setOnline(online: boolean): void;
  getStatus(cell: string): SyncStatus;
  requestSync(): Promise<void>;
  isSyncCell(cellName: string): boolean;
}

/**
 * Create a client-side sync engine that coordinates op buffering, HLC clocks, and rebase.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  let _opCounter = 0;
  // Op identity must be unique for all time, not just for this session.
  // `clientId` is PERSISTED (localStorage — HLC identity has to survive a
  // reload) while `_opCounter` is not, so `clientId-counter` alone re-issued
  // the ids of the previous session after every page load: the server's op-id
  // dedup (`persistOp` INSERT OR IGNORE + the compaction tombstones) saw a
  // known id, skipped the dispatch — and still ACKED, so the client confirmed
  // and dropped it. Every op of a new session was silently swallowed until its
  // counter passed the previous session's high mark. A per-engine nonce makes
  // the id self-contained: no part of it depends on what survived storage.
  const _session = randomUuid().slice(0, 8);
  const clock: HLClock = createHLC(deps.clientId);
  let online = true;
  const statuses = new Map<string, SyncStatus>();

  // Per-cell async mutex — serializes all state mutations (local, ack, remote, sync)
  const _locks = new Map<string, Promise<void>>();

  // ── Op-id dedup (defense-in-depth) ────────────────────────────────────
  // The server_ts cursor is the PRIMARY re-delivery guard; this set catches
  // what the cursor cannot: an op racing in via broadcast while a catch-up
  // response that also contains it is already in flight, a duplicated sync
  // request producing two overlapping responses, or re-ordered responses.
  // BOUND: per-cell FIFO set capped at APPLIED_IDS_CAP ids (≈2048 × ~40 B ≈
  // 80 KB per cell worst case; cells are limited to the app's sync cells).
  // Eviction is safe: an id only needs to outlive the overlap window between
  // a broadcast and the catch-up rounds that could re-deliver it (a few
  // response batches, each ≤ pendingCap ops). Once evicted, cursor
  // correctness governs again — the set never becomes load-bearing.
  // The cursor each installed snapshot reflects, per cell.
  //
  // A snapshot IS the server's live state, so it already contains every op the
  // server had applied when it was taken — including the client's OWN ops
  // whose acks are still in flight. `handleAck` then applied such an op to
  // confirmed state a second time, and the client's confirmed state diverged
  // by one application (found while fixing one app's cursor gap: forcing snapshots
  // made the chaos suite fail with a doubled item). It is the one
  // confirmed-state mutator that cannot dedup by op id — the snapshot never
  // enumerates what it contains — so the server states the watermark instead
  // and the ack carries its own position for comparison.
  const _snapshotTs = new Map<string, number>();

  const APPLIED_IDS_CAP = 2048;
  const _appliedIds = new Map<string, Set<string>>();
  function alreadyApplied(cell: string, id: string): boolean {
    return _appliedIds.get(cell)?.has(id) ?? false;
  }
  function markApplied(cell: string, id: string): void {
    let set = _appliedIds.get(cell);
    if (!set) {
      set = new Set();
      _appliedIds.set(cell, set);
    }
    set.add(id);
    if (set.size > APPLIED_IDS_CAP) {
      // Sets iterate in insertion order — evict the oldest id.
      set.delete(set.values().next().value!);
    }
  }
  // Observe-only (dev/prod-equivalency doctrine): dropping a duplicate is
  // correct in prod AND worth seeing in dev — it means a duplicate got past
  // the cursor. Never silent state damage.
  function logDuplicate(cell: string, id: string, via: string): void {
    deps.log?.debug?.(
      `[sync] ${cell}: duplicate op ${id} dropped (${via}) — already applied`,
    );
  }

  // ── Catch-up ordering gate ────────────────────────────────────────────
  // Confirmed state is REPLAYED, one op at a time, through the cell's reducer.
  // It equals the server's state only if it is folded in the server's apply
  // order — the reducers real apps write (`s.value = x`,
  // `s.items = s.items.filter(...)`) are not commutative, so a different order
  // is a different state, permanently, and nothing on either side can see it.
  //
  // The fold order IS the frame-arrival order, and on a live connection that
  // matches: the server persists, dispatches and emits under one per-cell lock,
  // and TCP keeps the order. A catch-up RESPONSE breaks it — it is a batch of
  // ops the server applied in the PAST, so any confirmed-state frame emitted
  // between the request and the response is ahead of it:
  //   - a peer op broadcast into the gap (applied here, then the response
  //     replays older ops on top of it), and
  //   - the ack for our own op — including the queue `requestSync` just
  //     flushed, which the server persists BEFORE it reads the log, and acks
  //     before it answers. That one is not even a race: every reconnect with a
  //     queued op and a missed peer op folded its own edit first and the older
  //     peer ops over it, silently reverting the user's own change on their own
  //     screen while the server and every peer kept it.
  // So: while a catch-up is outstanding for a cell, HOLD those frames and
  // replay them after the response has been folded — the position the server
  // gave them.
  //
  // Nothing is lost if the response never comes (the connection died): a held
  // ack leaves its op UNCONFIRMED, so it is re-sent and re-acked on reconnect,
  // and a held broadcast sits above a cursor that only a response advances, so
  // the next catch-up re-delivers it. Both are dropped on disconnect for that
  // reason. And the queue is capped: past the cap frames apply immediately —
  // degrading to the previous (possibly misordered) behaviour is acceptable,
  // freezing a cell's updates forever is not.
  const DEFER_CAP = 4096;
  type Deferred =
    | { kind: "ack"; opId: string; serverHlc: HLC; serverTs?: number }
    | { kind: "op"; op: SyncOp };
  const _catchup = new Set<string>();
  const _deferred = new Map<string, Deferred[]>();
  /** Hold `item` until the outstanding catch-up for `cell` lands; false when
   *  there is none (or the hold is full) and the caller must apply it now. */
  function hold(cell: string, item: Deferred): boolean {
    if (!_catchup.has(cell)) return false;
    const q = _deferred.get(cell);
    if (q === undefined) {
      _deferred.set(cell, [item]);
      return true;
    }
    if (q.length >= DEFER_CAP) return false;
    q.push(item);
    return true;
  }
  function dropHeld(): void {
    _catchup.clear();
    _deferred.clear();
  }

  // A buggy reducer that returns undefined does so for EVERY op of that
  // action — warn once per cell:action instead of flooding on every ack/op.
  const _warnedUndef = new Set<string>();
  function _warnUndefReducer(cell: string, action: string): void {
    const key = `${cell}:${action}`;
    if (_warnedUndef.has(key)) return;
    _warnedUndef.add(key);
    console.warn(
      `[aio:sync] reducer returned undefined for action "${action}" in cell "${cell}". Expected state object or null. (logged once)`,
    );
  }

  for (const cell of Object.keys(deps.cells)) {
    statuses.set(cell, { status: "online", pending: 0, lastSync: 0 });
  }

  function updateStatus(cell: string, patch: Partial<SyncStatus>) {
    const current = statuses.get(cell);
    if (!current) return;
    statuses.set(cell, { ...current, ...patch });
  }

  /** Serialize async work per cell to prevent interleaved state. */
  function withLock(cell: string, fn: () => Promise<void>): Promise<void> {
    const prev = _locks.get(cell) ?? Promise.resolve();
    const next = prev.then(fn, fn).finally(() => {
      // Clean up completed lock entry to prevent unbounded memory growth.
      // Only remove if this promise is still the current one (no new work queued).
      if (_locks.get(cell) === next) {
        _locks.delete(cell);
      }
    });
    _locks.set(cell, next);
    return next;
  }

  async function rebaseCell(cell: string): Promise<Record<string, unknown>> {
    const confirmedState = deps.getConfirmedState()[cell] ?? {};
    const unconfirmed = await deps.buffer.getUnconfirmed(cell);
    const result = rebase(confirmedState, unconfirmed, deps.reducer);
    deps.onStateUpdate(cell, result.optimistic);
    updateStatus(cell, { pending: result.surviving.length });
    return result.optimistic;
  }

  /** Fold an ack into confirmed state. Caller holds the cell lock. */
  async function foldAck(
    cell: string,
    opId: string,
    serverHlc: HLC,
    serverTs?: number,
  ): Promise<void> {
    clock.receive(serverHlc);
    // Apply the acked op to confirmed state BEFORE marking it confirmed.
    // Otherwise rebaseCell(confirmed, unconfirmed-without-acked) drops the
    // op's effect from optimistic state — UI snaps back to pre-op value.
    const pending = (await deps.buffer.getUnconfirmed(cell)).find(
      (o) => o.id === opId,
    );
    // …unless a snapshot already brought it in. `serverTs <= snapshotTs`
    // means the op was persisted before the snapshot was taken, so the
    // snapshot's state includes it; applying it again would double it.
    // Confirm it, skip the apply. (No serverTs — duplicate re-ack, or an
    // older server — falls through to the original behaviour.)
    const snapTs = _snapshotTs.get(cell);
    const inSnapshot = pending !== undefined && serverTs !== undefined &&
      snapTs !== undefined && serverTs <= snapTs;
    if (pending && !inSnapshot) {
      const confirmed = deps.getConfirmedState()[cell] ?? {};
      const next = deps.reducer(
        confirmed,
        pending.action,
        pending.payload,
        cell,
      );
      // Reducer contract: null = no-op. undefined is treated as a bug.
      if (next === undefined) {
        _warnUndefReducer(cell, pending.action);
      } else if (next !== null) {
        deps.setConfirmedState(cell, next);
      }
    }
    await deps.buffer.confirm(cell, opId, serverHlc);
    await rebaseCell(cell);
    updateStatus(cell, { lastSync: Date.now() });
  }

  /** Fold one op from a catch-up response into confirmed state. Caller holds
   *  the cell lock. Unlike {@linkcode foldRemoteOp} this does not touch the
   *  HLC watermark or run conflict callbacks — the response advances the
   *  watermark once, from the whole batch. */
  function foldCatchupOp(
    cell: string,
    op: SyncOp,
    pendingIds: Set<string>,
  ): Promise<void> {
    // Self-origin guard — an op of ours that we are still waiting on an ack
    // for enters confirmed state through THAT ack, and folding it here too
    // would double it (see handleRemoteOp).
    //
    // An own op we are NOT waiting on is a different thing entirely: it is our
    // own history, from a session whose confirmed state is gone (a reload),
    // and this response is the only place it can come back from. The server
    // sends those only to a cursorless client — the one rebuilding from
    // nothing (see handleSync).
    if (op.hlc[2] === deps.clientId && pendingIds.has(op.id)) {
      logDuplicate(cell, op.id, "own-op in catch-up");
      return Promise.resolve();
    }
    // Dedup: the op may already have arrived via broadcast while our sync-req
    // (sent with an older cursor) was in flight — the response then contains
    // it a second time. Skipping the re-apply is the fix for that race; the
    // cursor still advances (the op IS covered).
    if (alreadyApplied(cell, op.id)) {
      logDuplicate(cell, op.id, "catch-up");
      return Promise.resolve();
    }
    markApplied(cell, op.id);
    const confirmed = deps.getConfirmedState()[cell] ?? {};
    const next = deps.reducer(confirmed, op.action, op.payload, op.cell);
    // Same guard the ack and remote-op paths carry: `null` is the contract's
    // no-op, `undefined` is a buggy reducer. Letting it through set confirmed
    // state to undefined, and the next rebase read
    // `getConfirmedState()[cell] ?? {}` — every confirmed field silently gone.
    if (next === undefined) {
      _warnUndefReducer(cell, op.action);
    } else if (next !== null) {
      deps.setConfirmedState(cell, next);
    }
    return Promise.resolve();
  }

  /** Fold a remote op into confirmed state. Caller holds the cell lock. */
  async function foldRemoteOp(op: SyncOp): Promise<void> {
    clock.receive(op.hlc);
    const meta = await deps.buffer.getMeta(op.cell);
    // Op-id dedup: same op delivered twice (duplicated broadcast, or a
    // broadcast racing a catch-up response that also contains it).
    // Deliberately id-based, NOT `serverTs <= cursor` — a cursor
    // advanced by a LATER op does not prove an earlier op was seen, so a
    // cursor guard could drop a never-applied op under reordered
    // delivery. The id set only skips provably-applied ops.
    const isDup = alreadyApplied(op.cell, op.id);
    const confirmed = deps.getConfirmedState()[op.cell] ?? {};
    let next: Record<string, unknown> | null | undefined = null;
    if (isDup) {
      logDuplicate(op.cell, op.id, "broadcast");
    } else {
      markApplied(op.cell, op.id);
      next = deps.reducer(confirmed, op.action, op.payload, op.cell);
      if (next === undefined) {
        _warnUndefReducer(op.cell, op.action);
      } else if (next !== null) {
        deps.setConfirmedState(op.cell, next);
      }
    }
    // Advance the compaction watermark (lastHlc, never regressing) — the
    // server uses it only to decide snapshot-vs-incremental. Deliberately
    // do NOT advance lastServerTs from broadcast stamps (chaos-suite
    // finding, 2026-07-21): on a fresh connection broadcasts arrive AHEAD
    // of the client's coverage (ops persisted while it was offline are
    // still undelivered), so a stamp jump seals that gap above the cursor
    // — permanent silent loss if the catch-up response is then dropped.
    // The server_ts cursor advances ONLY via a processed sync-res:
    // its reservation echo is self-contained coverage (everything ≤ it
    // was in that response, in a snapshot, or our own). Broadcasts the
    // next catch-up re-delivers are absorbed by the op-id dedup above.
    const lastHlc = !meta?.lastHlc || compareHLC(op.hlc, meta.lastHlc) > 0
      ? op.hlc
      : meta.lastHlc;
    if (lastHlc !== meta?.lastHlc) {
      await deps.buffer.saveMeta(op.cell, {
        lastHlc,
        lastServerTs: meta?.lastServerTs,
      });
    }
    if (isDup) return;
    const optimistic = await rebaseCell(op.cell);

    // Conflict handling: a field the remote op changed that surviving
    // local (unconfirmed) ops still override. Default semantics are
    // rebase-LWW — local replays on top — so `local` is what the user
    // sees and `remote` is the confirmed value underneath. Fields with a
    // configured merge strategy get a CRDT merge applied to the CLIENT
    // VIEW for the conflict window (the server stays the convergence
    // authority — its next snapshot/ack rebase replaces the view).
    const cfg = deps.cells[op.cell];
    const mergeCfg = cfg?.merge ?? {};
    const onConflict = cfg?.onConflict;
    const wantsConflictWork = onConflict !== undefined ||
      Object.keys(mergeCfg).length > 0;
    if (wantsConflictWork && next != null) {
      const after = next as Record<string, unknown>;
      const conflicts: SyncConflict[] = [];
      let mergedView: Record<string, unknown> | null = null;
      // Local-side timestamp for merges: the newest surviving local op.
      const unconfirmed = await deps.buffer.getUnconfirmed(op.cell);
      const localHlc = unconfirmed.reduce(
        (m: HLC | null, o) =>
          m === null || compareHLC(o.hlc, m) > 0 ? o.hlc : m,
        null,
      ) ?? clock.now();
      for (const field of Object.keys(after)) {
        const remoteChanged = confirmed[field] !== after[field];
        const localOverrides = after[field] !== optimistic[field];
        if (!remoteChanged || !localOverrides) continue;
        const strategy = mergeCfg[field] ?? "lww";
        if (strategy !== "lww") {
          try {
            const m = mergeField(
              strategy,
              optimistic[field],
              localHlc,
              after[field],
              op.hlc,
              confirmed[field],
              cfg?.identity?.[field] ?? "id",
            );
            mergedView ??= { ...optimistic };
            mergedView[field] = m.value;
          } catch (e) {
            deps.log?.warn(
              `[sync] ${op.cell}.${field}: ${strategy} merge failed (${e}) — keeping rebase-LWW view`,
            );
          }
        }
        conflicts.push({
          field,
          local: optimistic[field],
          remote: after[field],
          resolution: strategy,
        });
      }
      if (mergedView) deps.onStateUpdate(op.cell, mergedView);
      if (conflicts.length > 0 && onConflict) {
        try {
          onConflict(conflicts);
        } catch (e) {
          deps.log?.warn(`[sync] onConflict callback threw: ${e}`);
        }
      }
    }
  }

  const engine: SyncEngine = {
    handleLocalAction(cell, action, payload) {
      return withLock(cell, async () => {
        const hlc = clock.tick();
        const id = `${deps.clientId}-${_session}-${
          (++_opCounter).toString(36)
        }`;
        const op: SyncOp = {
          id,
          cell,
          action,
          payload,
          hlc,
          confirmed: false,
          _clientTs: Date.now(),
        };

        // Try to make room by pruning confirmed ops before rejecting
        let accepted = await deps.buffer.add(op);
        if (!accepted) {
          await deps.buffer.pruneConfirmed(cell);
          accepted = await deps.buffer.add(op);
        }
        if (!accepted) {
          updateStatus(cell, { status: "blocked" });
          deps.log?.warn(
            `[sync] ${cell}: op buffer full (pending cap reached) — op dropped. Reconnect or reduce mutation rate.`,
          );
          return;
        }

        await rebaseCell(cell);

        if (online) {
          deps.send(enc("op", { id, hlc, cell, action, payload }));
        }
      });
    },

    handleAck(cell, opId, serverHlc, serverTs) {
      // Held while a catch-up is outstanding — the op it confirms was applied
      // by the server AFTER the log that response carries (see `hold`). The op
      // stays unconfirmed meanwhile, so the optimistic view is unchanged and a
      // lost response costs nothing but a re-send.
      if (hold(cell, { kind: "ack", opId, serverHlc, serverTs })) {
        return Promise.resolve();
      }
      return withLock(cell, () => foldAck(cell, opId, serverHlc, serverTs));
    },

    handleRejection(cell, opId, reason) {
      return withLock(cell, async () => {
        // Drop the rejected op — it will never be confirmed.
        await deps.buffer.pruneStale(cell, opId);
        await rebaseCell(cell);
        // D11: silent rejection is a blank-screen-class bug — always loud.
        console.error(
          `[aio:sync] ${cell}: change rejected by the server — ${reason} ` +
            `(op ${opId}; optimistic view rolled back)`,
        );
        deps.cells[cell]?.onRejected?.({ opId, reason });
        updateStatus(cell, { lastSync: Date.now() });
      });
    },

    handleRemoteOp(op) {
      if (!this.isSyncCell(op.cell)) return Promise.resolve();
      // Self-origin guard (chaos-suite finding, 2026-07-21): a reconnect race
      // can echo our OWN op back as a "remote" broadcast — the server excludes
      // the socket the op arrived on, but after a reconnect we hold a NEW
      // socket, so the exclusion misses. Applying the echo would double the
      // op's effect: once here, once via the sync-ack path (the op is still
      // pending locally). Own ops only ever enter confirmed state through
      // handleAck.
      if (op.hlc[2] === deps.clientId) {
        logDuplicate(op.cell, op.id, "own-op echo");
        return Promise.resolve();
      }
      // Held while a catch-up is outstanding: this op is AHEAD of the response
      // in flight, and applying it first would make the response's older ops
      // replay on top of it (see `hold`).
      if (hold(op.cell, { kind: "op", op })) return Promise.resolve();
      return withLock(op.cell, () => foldRemoteOp(op));
    },

    async handleSyncResponse(response) {
      // Receive HLCs into global clock (safe outside per-cell lock)
      if (response.ops) {
        for (const op of response.ops) clock.receive(op.hlc);
      }
      if (response.rebase) {
        for (const op of response.rebase) clock.receive(op.hlc);
      }

      // Collect snapshot work per cell
      const snapshots = new Map<string, Record<string, unknown>>();
      if (response.mode === "snapshot" && response.snapshot) {
        for (const [f, s] of Object.entries(response.snapshot)) {
          snapshots.set(f, s);
        }
      }

      // Group ops by cell
      const opsByCell = new Map<string, SyncOp[]>();
      if (response.ops) {
        for (const op of response.ops) {
          const list = opsByCell.get(op.cell) ?? [];
          list.push(op);
          opsByCell.set(op.cell, list);
        }
      }

      // Resolve per-cell lowWater (supports both single HLC and per-cell map)
      const lw = response.lowWater;
      const isPerCell = lw && !Array.isArray(lw) && typeof lw === "object";
      const getLW = (f: string): HLC =>
        isPerCell ? (lw as Record<string, HLC>)[f] ?? clock.now() : lw as HLC;

      // The catch-up has landed, so the gate opens: take everything it held
      // and fold it WITH the response, in one ordered batch per cell (see
      // `hold` and the batch below). One sync-req covers every cell and
      // produces exactly this one response, so the whole gate clears here.
      const held = new Map(_deferred);
      dropHeld();

      // Process each affected cell: snapshot → ops → rebase (all under one lock)
      const affected = new Set([
        ...snapshots.keys(),
        ...opsByCell.keys(),
        ...held.keys(),
      ]);
      const cursorSaved = new Set<string>();
      for (const cell of affected) {
        await withLock(cell, async () => {
          const snap = snapshots.get(cell);
          const snapTs = snap === undefined
            ? undefined
            : response.lastServerTs?.[cell] ?? _snapshotTs.get(cell);
          if (snap) {
            deps.setConfirmedState(cell, snap);
            // The cursor this snapshot reflects — every op at or below it is
            // already in `snap`, which is what keeps a late ack from applying
            // one of them twice (see `_snapshotTs`).
            if (typeof snapTs === "number") _snapshotTs.set(cell, snapTs);
            await deps.buffer.saveSnapshot(cell, {
              state: snap,
              hlc: getLW(cell),
              ...(typeof snapTs === "number" ? { serverTs: snapTs } : {}),
            });
          }
          let newLastHlc: HLC | null = null;
          if (snap) newLastHlc = getLW(cell);
          const ops = opsByCell.get(cell) ?? [];
          const heldItems = held.get(cell) ?? [];
          // ── the fold, in the SERVER's apply order ───────────────────────
          // A catch-up answers two things at once: peer ops the client missed
          // AND the acks for the ops it just flushed — and it does not answer
          // them in one order. Its own ops are stamped when the server persists
          // them, which for a resent (already-known) op is where they sat in
          // the log ROUNDS ago, while the acks come back in resend order. Both
          // sides are replayed through the reducer, so folding them in arrival
          // order builds a state the server never had: for `s.value = x` or
          // `s.items.filter(...)` a different order is a different answer,
          // kept forever, on the client only.
          // Every item knows its position (`serverTs`), so sort by it — that
          // IS the server's order. If anything cannot say (a pre-alpha43
          // server), keep the previous arrival order rather than guess.
          // Ops of ours still awaiting an ack — read once, before the batch
          // folds anything (an ack in the batch confirms as it runs).
          const pendingIds = new Set(
            (await deps.buffer.getUnconfirmed(cell)).map((o) => o.id),
          );
          const batch: { ts?: number; run: () => Promise<void> }[] = [];
          for (const op of ops) {
            batch.push({
              ts: op.serverTs,
              run: () => foldCatchupOp(cell, op, pendingIds),
            });
          }
          for (const h of heldItems) {
            if (h.kind === "op") {
              // Held under a snapshot: it reached us BEFORE the response, so
              // on a FIFO connection the server applied it before capturing
              // the snapshot — replaying it would apply it twice (a snapshot
              // cannot enumerate what it holds, so the id dedup cannot see it).
              if (snapTs !== undefined) {
                logDuplicate(cell, h.op.id, "held under snapshot");
                continue;
              }
              batch.push({ ts: h.op.serverTs, run: () => foldRemoteOp(h.op) });
            } else {
              // Same argument for a held ack, except it must still RUN: the op
              // has to be confirmed and the buffer drained. Carrying the
              // snapshot's watermark tells `foldAck` the fold is already done.
              const ts = snapTs !== undefined
                ? Math.min(h.serverTs ?? snapTs, snapTs)
                : h.serverTs;
              batch.push({
                ts,
                run: () => foldAck(cell, h.opId, h.serverHlc, ts),
              });
            }
          }
          if (batch.every((b) => typeof b.ts === "number")) {
            batch.sort((a, b) => a.ts! - b.ts!);
          }
          for (const item of batch) await item.run();
          if (ops.length > 0) {
            const firstHlc = ops[0]?.hlc;
            if (firstHlc) {
              const highest = ops.reduce(
                (m: HLC, o) => compareHLC(o.hlc, m) > 0 ? o.hlc : m,
                firstHlc,
              );
              if (!newLastHlc || compareHLC(highest, newLastHlc) > 0) {
                newLastHlc = highest;
              }
            }
          }
          if (newLastHlc) {
            // Per-cell cursor from the server; preserve the stored one when
            // the response doesn't cover this cell — overwriting with
            // undefined would regress to the ambiguous HLC cursor and cause
            // re-delivery (double-apply through the reducer). NEVER regress
            // either cursor: two in-flight sync responses delivered out of
            // order would otherwise rewind lastServerTs and re-deliver every
            // op between the two cursors on the next catch-up.
            const prev = await deps.buffer.getMeta(cell);
            const lastHlc =
              prev?.lastHlc && compareHLC(prev.lastHlc, newLastHlc) > 0
                ? prev.lastHlc
                : newLastHlc;
            const respTs = response.lastServerTs?.[cell];
            const lastServerTs =
              respTs != null && respTs > (prev?.lastServerTs ?? 0)
                ? respTs
                : prev?.lastServerTs;
            await deps.buffer.saveMeta(cell, { lastHlc, lastServerTs });
            cursorSaved.add(cell);
          }
          // Rebase FIRST, then decide about status. Confirmed state was just
          // advanced (snapshot above, or the ops loop), and `rebaseCell`
          // recomputes optimistic = confirmed + unconfirmed and pushes it to
          // the UI. Returning early on "blocked" skipped that, so a blocked
          // cell kept showing a view built on the PRE-snapshot confirmed state
          // — stale precisely while its buffer is full and it most needs the
          // server's latest.
          await rebaseCell(cell);
          const s = statuses.get(cell);
          if (s?.status === "blocked") return;
          updateStatus(cell, { status: "syncing" });
          updateStatus(cell, {
            status: online ? "online" : "offline",
            lastSync: Date.now(),
          });
        });
      }

      // Cells the server echoed a cursor for but delivered nothing (e.g. the
      // only above-cursor ops were our own, filtered from the echo): advance
      // the stored cursor anyway — otherwise it stalls and the server
      // re-loads + re-filters those ops every round. Never regress.
      for (const [cell, ts] of Object.entries(response.lastServerTs ?? {})) {
        if (cursorSaved.has(cell)) continue;
        await withLock(cell, async () => {
          const prev = await deps.buffer.getMeta(cell);
          if (ts > (prev?.lastServerTs ?? 0)) {
            await deps.buffer.saveMeta(cell, {
              lastHlc: prev?.lastHlc ?? null,
              lastServerTs: ts,
            });
          }
        });
      }
    },

    setOnline(v) {
      const wasOffline = !online;
      online = v;
      // The connection died with a catch-up outstanding: whatever it was
      // holding is safe to drop (a held ack left its op unconfirmed → re-sent;
      // a held broadcast sits above a cursor only a response advances →
      // re-delivered). Keeping the gate closed would stall the cell instead.
      if (!v) dropHeld();
      for (const cell of Object.keys(deps.cells)) {
        if (!v) {
          updateStatus(cell, { status: "offline" });
        } else {
          const s = statuses.get(cell);
          if (s?.status === "offline") {
            updateStatus(cell, { status: "online" });
          }
        }
      }
      // Flush queued ops on offline→online transition
      if (v && wasOffline) {
        this.requestSync().catch(() => {
          // Revert to offline if sync request fails
          for (const cell of Object.keys(deps.cells)) {
            const s = statuses.get(cell);
            if (s?.status === "syncing") {
              updateStatus(cell, { status: "offline" });
            }
          }
        });
      }
    },

    getStatus(cell) {
      return statuses.get(cell) ??
        { status: "online", pending: 0, lastSync: 0 };
    },

    async requestSync() {
      if (!online) return; // don't send while offline
      const cells: Record<
        string,
        { lastHlc: HLC | null; lastServerTs?: number }
      > = {};
      const allPending: SyncOp[] = [];

      for (const cell of Object.keys(deps.cells)) {
        const meta = await deps.buffer.getMeta(cell);
        cells[cell] = {
          lastHlc: meta?.lastHlc ?? null,
          lastServerTs: meta?.lastServerTs,
        };
        const unconfirmed = await deps.buffer.getUnconfirmed(cell);
        allPending.push(...unconfirmed.slice(0, SYNC_DEFAULTS.pendingCap));
        updateStatus(cell, { status: "syncing" });
      }

      // From here until the response lands, anything that would mutate
      // confirmed state is AHEAD of that response — hold it (see `hold`).
      // Armed BEFORE the send: a transport that answers synchronously would
      // otherwise open the gate before it was closed and leave it shut with no
      // response left to open it.
      for (const cell of Object.keys(deps.cells)) _catchup.add(cell);
      try {
        deps.send(enc("sync-req", {
          clientId: deps.clientId,
          cells,
          pendingOps: allPending,
        }));
      } catch {
        dropHeld(); // no request went out — nothing will open the gate
        // Revert status on send failure
        for (const cell of Object.keys(deps.cells)) {
          const s = statuses.get(cell);
          if (s?.status === "syncing") {
            updateStatus(cell, { status: online ? "online" : "offline" });
          }
        }
      }
    },

    isSyncCell(cellName) {
      return cellName in deps.cells;
    },
  };
  return engine;
}
