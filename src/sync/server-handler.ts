// src/sync/server-handler.ts — Server-side CRDT sync relay
// Receives ops from clients, persists to op-log, broadcasts to other clients, sends acks.

import { enc } from "../protocol/envelope.ts";
import { _isFrameworkInternalActionType } from "../protocol/action-gate.ts";
import type { DB } from "../db/types.ts";
import { takeRejectionFor } from "../state/rejection-tracker.ts";
import type { HLC, SyncOp } from "./types.ts";
import { STALE_OP_REASON, SYNC_DEFAULTS } from "./types.ts";
import { createHLC, type HLClock } from "./hlc.ts";
import { compactSyncOps, tombstoneWindowMs } from "./compact.ts";
import {
  getCompactedTs,
  getLowWater,
  getOpServerTs,
  hasSyncSnapshot,
  isKnownOpId,
  loadOpsSince,
  persistOp,
  reserveServerTs,
} from "./server-store.ts";

/**
 * Dependencies injected into the server-side sync handler.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export interface SyncHandlerDeps {
  /** Apply an accepted op to the live app state (normal dispatch path) —
   *  without this the op-log and the server's own state diverge, and
   *  compaction snapshots (built from live state) would drop client ops. */
  dispatch: (
    action: {
      type: string;
      payload?: unknown;
      _user?: unknown;
      /** Origin marker: this action IS a persisted sync op — the afterAction
       *  hook must not schedule a durability snapshot for it. */
      _syncOp?: boolean;
    },
    // Returns whatever the app's dispatch returns — a PROMISE that rejects
    // when the action could not be applied (REDUCE_ERROR, QUEUE_OVERFLOW,
    // DISPATCH_CLOSED). The handler awaits it: an op the server could not
    // apply must not be acked, broadcast or compacted. `unknown` (rather than
    // `void`) so a plain non-promise dispatch is still a valid dep — awaiting
    // one resolves immediately.
  ) => unknown;
  db: DB;
  syncCellIds: string[];
  /** RAW cell state — server-internal only (compaction snapshots). Sync cells
   *  are excluded from KV persistence, so the compaction snapshot IS their
   *  durability: it must carry the whole slice, filters and all. Never send
   *  this to a client — use `getClientCellState`. */
  getCellState: (cell: string) => Record<string, unknown>;
  /** The UI-visible projection of a cell — the ONLY shape that may go out on a
   *  wire, and `null` when the cell must not be sent at all (`ui: "none"`).
   *
   *  Separate from `getCellState` (and required, not defaulted) because the two
   *  answers genuinely differ and the safe one must be chosen deliberately: a
   *  catch-up snapshot used to be wired straight to raw `getState()`, shipping
   *  `ui: "none"` cells and excluded fields to any client that fell behind
   *  compaction. A default here would just re-create that fail-open. */
  getClientCellState: (cell: string) => Record<string, unknown> | null;
  /** The cell's declared shape `version` (field report §3.1) — stamped on every op
   *  row and every compaction snapshot, so the boot replay can tell what shape
   *  a row was written under. Undefined ⇒ 0 (the default a cell declares). */
  cellVersion?: (cell: string) => number;
  /** A cell the boot replay QUARANTINED (its op-log could not be folded into
   *  the current shape): compaction must not write its live state over the
   *  snapshot — the log and the snapshot are the only surviving copies of the
   *  data. Undefined ⇒ nothing is quarantined. */
  isQuarantined?: (cell: string) => boolean;
  /** `sync.offline.retention` for a cell, in ms — how long a client may hold
   *  an unacked op. Compaction's id-tombstone window is sized from it, so a
   *  resend after a long offline stretch still hits the dedup instead of
   *  being applied a second time. Undefined ⇒ the 24h floor. */
  opRetentionMs?: (cell: string) => number | undefined;
  /** AUTH-1 parity for the sync path: may `user` mutate `cell` via a sync op?
   *  Undefined = no access rules (open). The `action` dispatch path is gated in
   *  aio-server.ts; sync ops route through a different dispatch, so the SAME
   *  rule must be enforced here or an `access`-gated cell that is also
   *  `sync: true` would be freely mutable by any connected client. */
  accessCheck?: (cell: string, user: unknown) => boolean;
  /** Send raw message to all connected clients except the given socket.
   *  Mutable ref: set after server creation to break circular dependency. */
  broadcastRaw: { fn: (msg: string, exclude?: WebSocket) => void };
  log: {
    debug: (msg: string, data?: Record<string, unknown>) => void;
    warn: (msg: string, data?: Record<string, unknown>) => void;
    error: (msg: string, data?: Record<string, unknown>) => void;
  };
}

/**
 * Server-side handler that persists ops, sends acks, and broadcasts to peers.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export interface ServerSyncHandler {
  handleOp: (
    op: unknown,
    meta: { id: string; user?: unknown },
    socket: WebSocket,
  ) => void | Promise<void>;
  handleSync: (
    sync: unknown,
    meta: { id: string; user?: unknown },
    socket: WebSocket,
  ) => void;
  /** A SERVER-ORIGIN write (effect, cron, serverFn, plain action — anything
   *  that is not a sync op) committed to this sync cell. Sync cells are
   *  excluded from KV persistence and only ops are replayed at boot, so
   *  without this the change was durable only if a compaction happened to run
   *  later — a restart silently rewound it. Debounced fold of current state
   *  into the cell's sync snapshot. */
  noteServerWrite: (cell: string) => void;
  /** Flush pending noteServerWrite debounces — called on shutdown so the last
   *  write of a clean exit is never inside the debounce window. */
  flushServerWrites: () => Promise<void>;
}

const FORBIDDEN = ["__proto__", "constructor", "prototype"];

/** One cell's cursor in a `sync-req`. The twin of {@link isValidSyncOp} for
 *  the OTHER half of the request — the map of what the client already has. */
function isValidCellCursor(
  v: unknown,
): v is { lastHlc: HLC | null; lastServerTs?: number } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const c = v as { lastHlc?: unknown; lastServerTs?: unknown };
  const hlcOk = c.lastHlc === null || c.lastHlc === undefined ||
    (Array.isArray(c.lastHlc) && c.lastHlc.length === 3 &&
      typeof c.lastHlc[0] === "number" && typeof c.lastHlc[1] === "number" &&
      typeof c.lastHlc[2] === "string");
  const tsOk = c.lastServerTs === undefined ||
    (typeof c.lastServerTs === "number" && Number.isFinite(c.lastServerTs));
  return hlcOk && tsOk;
}

/**
 * Validate a sync op has required fields and no proto-pollution vectors —
 * and does not name a framework-internal action.
 *
 * This is the ONE decider for every op that reaches the sync layer: the `op`
 * frame (WS and UDS) AND every entry of `sync-req.pendingOps` (WS and UDS)
 * pass through it. The transport routers gate `op` frames with the same
 * predicate, but `pendingOps` — a reconnect's whole offline queue — was
 * forwarded unchecked, and a `cell:__setRefresh` in it dispatched through
 * `applyMutations` (any path, any value), was persisted, acked, broadcast to
 * every peer and replayed at the next boot. The gate belongs where all four
 * doors converge, not in each router.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export function isValidSyncOp(
  op: unknown,
): op is {
  id: string;
  hlc: HLC;
  cell: string;
  action: string;
  payload: unknown;
} {
  if (!op || typeof op !== "object") return false;
  const o = op as Record<string, unknown>;
  return (
    typeof o.id === "string" && o.id.length > 0 &&
    typeof o.cell === "string" && !FORBIDDEN.includes(o.cell) &&
    typeof o.action === "string" && !FORBIDDEN.includes(o.action) &&
    !_isFrameworkInternalActionType(o.action) &&
    Array.isArray(o.hlc) && o.hlc.length === 3 &&
    typeof o.hlc[0] === "number" && typeof o.hlc[1] === "number" &&
    typeof o.hlc[2] === "string"
  );
}

/**
 * Create a server-side sync handler that relays CRDT ops between clients.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export function createServerSyncHandler(
  deps: SyncHandlerDeps,
): ServerSyncHandler {
  const clock: HLClock = createHLC("server");
  const syncCells = new Set(deps.syncCellIds);

  /** Send ONE already-encoded frame to ONE client, and never lose the reason
   *  it did not arrive.
   *
   *  Every per-client reply in this file used to wrap `socket.send(enc(…))`
   *  in an empty catch labelled "client disconnected", which is only half
   *  true. `send` throws for one uninteresting reason — the peer
   *  went away between the last read and this write — and for interesting ones
   *  the same empty catch ate: a socket THIS server closed, a frame that could
   *  not be encoded at all. On a CRDT relay that is the worst possible place
   *  to guess: an ack that never goes out means the client resends the op
   *  forever, and nothing anywhere said so.
   *
   *  So the frame is encoded by the CALLER (an encode failure propagates to
   *  the caller's error path instead of masquerading as a disconnect), and the
   *  socket's own `readyState` decides which failure this was: a peer that is
   *  already gone is a debug line, anything else is a warning naming the frame
   *  that was lost. */
  const sendTo = (socket: WebSocket, frame: string, what: string): void => {
    const gone = socket.readyState !== WebSocket.OPEN;
    try {
      socket.send(frame);
    } catch (e) {
      if (gone) {
        deps.log.debug(
          `[sync:server] ${what} not delivered — client already disconnected`,
        );
      } else {
        deps.log.warn(
          `[sync:server] ${what} could not be sent on an open socket: ${e}`,
        );
      }
    }
  };

  // Per-cell async mutex — serializes handleOp + compact to prevent
  // race where an op is persisted between state capture and DELETE in compact.
  const _locks = new Map<string, Promise<void>>();
  function withLock(cell: string, fn: () => Promise<void>): Promise<void> {
    const prev = _locks.get(cell) ?? Promise.resolve();
    // F-8: mirror client-side sync-engine cleanup so the map doesn't retain
    // an entry per cell ever touched. Only delete if we're still the latest.
    const next = prev.then(fn, fn).finally(() => {
      if (_locks.get(cell) === next) {
        _locks.delete(cell);
      }
    });
    _locks.set(cell, next);
    return next;
  }

  // ── Quarantine: a cell whose log the boot replay could not fold ───────
  // The quarantine promise is "the cell runs at its last snapshot, its
  // snapshot is not rewritten and its op-log is not compacted, so nothing on
  // disk is lost". `tryCompact` kept the second half; NOTHING kept the first.
  // A quarantined cell went on accepting, persisting, dispatching, ACKING and
  // broadcasting ops — the client is told its write is durable while the boot
  // log says it is not, and the next restart replays a log that still cannot
  // be folded, so the write is gone. And because compaction stays off, the log
  // grows without bound and every boot re-quarantines: no escape without DB
  // surgery. A write it cannot make durable must be REFUSED, loudly, at the
  // door — the same `op-rejected` the client already knows how to surface.
  const _quarantineWarned = new Set<string>();
  function quarantineReason(cell: string): string {
    return `cell "${cell}" is quarantined since boot: its op-log could not be ` +
      `replayed into the shape this build declares, so a write cannot be made ` +
      `durable (the next restart would lose it). Fix the cell's \`version\` / ` +
      `onMigrate so the log folds, then restart the server — the log and the ` +
      `snapshot on disk are intact meanwhile.`;
  }
  /** Refuse a client write to a quarantined cell — reason on the wire, once
   *  per cell in the log. Returns true when the caller must stop. */
  function refuseIfQuarantined(
    opId: string,
    cell: string,
    socket: WebSocket,
  ): boolean {
    if (!deps.isQuarantined?.(cell)) return false;
    const reason = quarantineReason(cell);
    try {
      socket.send(enc("op-rejected", { opId, cell, reason }));
    } catch { /* client gone */ }
    deps.log.warn(`[sync:server] op ${opId} refused — ${reason}`);
    return true;
  }

  // ── Clock drift: an op stamped in the future ──────────────────────────
  // `HLClock.receive` refuses to follow a remote clock more than `maxDrift`
  // ahead — which protects the local clock and NOTHING else. The drifted op
  // itself was still persisted, dispatched, broadcast and kept with its future
  // HLC, so every last-write-wins comparison against it lost for the whole
  // drift window: one machine with a wrong clock quietly won every conflict,
  // everywhere, and nothing said why.
  //
  // Refused here rather than clamped. The server is the one place a decision
  // binds every replica, and clamping would rewrite the HLC of an op its
  // origin already holds under the original stamp — one op id with two
  // orderings is worse than the bug. The origin is told (`op-rejected`), its
  // optimistic view rolls back and `sync.onRejected` fires.
  //
  // FUTURE only. An op stamped in the past is the offline queue working as
  // designed (retention defaults to 4h) and loses LWW on merit; refusing it
  // would delete offline-first.
  //
  // And the refusal STICKS to the op id. `ahead` is measured against the
  // server's wall clock, which moves — so the identical op, delivered again a
  // minute later (a duplicate still in flight, or the pending buffer of a
  // `sync-req` that was already on the wire when the rejection went out),
  // measured under the limit and was ACCEPTED. The origin had already been
  // told the change was refused: `onRejected` fired, the optimistic view
  // rolled back, the op was pruned from its buffer — and then the change
  // landed on the server and every peer anyway. A refusal whose answer depends
  // on when the frame happens to arrive is not a decision, and D11 promises a
  // decision. (Found by the chaos suite, seed 724, 2026-08-27.)
  //
  // In-memory and bounded on purpose: the only way a refused op comes back is
  // a frame that was already in flight on THIS connection, and a restart drops
  // those with the socket. The reason text is remembered with the id so the
  // re-refusal says the same thing the first one did, rather than quoting a
  // drift that has since shrunk.
  const REFUSED_IDS_CAP = 4096;
  const _refusedForDrift = new Map<string, string>();
  function rememberRefusal(opId: string, reason: string): void {
    _refusedForDrift.set(opId, reason);
    if (_refusedForDrift.size > REFUSED_IDS_CAP) {
      // Maps iterate in insertion order — evict the oldest.
      _refusedForDrift.delete(_refusedForDrift.keys().next().value!);
    }
  }
  function refuseIfDrifted(
    opId: string,
    cell: string,
    hlc: HLC,
    socket: WebSocket,
  ): boolean {
    const remembered = _refusedForDrift.get(opId);
    const ahead = hlc[0] - Date.now();
    if (remembered === undefined && ahead <= SYNC_DEFAULTS.maxDrift) {
      return false;
    }
    const reason = remembered ??
      `clock drift: this change is stamped ${Math.round(ahead / 1000)}s ` +
        `ahead of the server (limit ${
          SYNC_DEFAULTS.maxDrift / 1000
        }s). It is ` +
        `refused because it would win every last-write-wins comparison until ` +
        `the clocks meet. Correct this device's system clock (turn on ` +
        `automatic time sync) and the change can be made again.`;
    rememberRefusal(opId, reason);
    try {
      socket.send(enc("op-rejected", { opId, cell, reason }));
    } catch { /* client gone */ }
    deps.log.warn(`[sync:server] op ${opId} (${cell}) refused — ${reason}`);
    return true;
  }

  // ── Staleness: an op older than the tombstone window ──────────────────
  // Compaction tombstones the ids it deletes so a resend after a lost ack
  // still dedups, and sweeps the tombstones after `tombstoneWindowMs` (24h,
  // or the cell's `offline.retention` when longer). That sweep was justified
  // by the client's retention — "the longest a client may hold an op before
  // re-sending it" — but the client evicts unconfirmed ops ONLY when its
  // buffer reaches `pendingCap`, and re-sends every unconfirmed op on every
  // reconnect whatever its age. So a phone that lost one ack and came back two
  // days later re-sent the op, the server — its tombstone swept — took it for
  // a new change, and it was inserted, dispatched, applied a SECOND time,
  // acked and broadcast. A counter drifted, an append appended twice, and
  // nothing on either side said so.
  //
  // Past the window the server cannot tell such a resend from a genuinely new
  // change; that is precisely what the tombstone was for. So it does not
  // guess: an UNKNOWN op (no live row, no standing tombstone — `isKnownOpId`)
  // stamped older than the window is refused with `op-rejected`, the reason
  // prefixed `STALE_OP_REASON` so the client drops it from its buffer under
  // that name and stops re-sending it, and naming `offline.retention` as the
  // knob that widens the window. A KNOWN op is re-acked exactly as before,
  // however old — the standing tombstone IS the proof it was applied.
  //
  // The threshold carries `maxDrift` of slack. A tombstone is swept when
  // `compacted_at < now - window`, and the door accepts an op stamped up to
  // `maxDrift` AHEAD of the server's clock, so the newest op whose tombstone
  // can already be gone is stamped `now - window + maxDrift`. Refusing only
  // strictly older ops would leave a `maxDrift`-wide sliver in which a swept
  // resend is still applied twice.
  //
  // Checked INSIDE the cell's lock, right before the persist: the known-id
  // answer must be read in the same critical section that would insert the
  // row, or two concurrent deliveries of one old op could be refused by one
  // path and acked by the other.
  async function refuseIfStale(
    opId: string,
    cell: string,
    hlc: HLC,
    socket: WebSocket,
  ): Promise<boolean> {
    const window = tombstoneWindowMs(deps.opRetentionMs?.(cell));
    const age = Date.now() - hlc[0];
    if (age <= window - SYNC_DEFAULTS.maxDrift) return false;
    if (await isKnownOpId(deps.db, opId)) return false;
    const hours = (ms: number) => `${Math.round(ms / 3600_000)}h`;
    const reason = `${STALE_OP_REASON}: this change is stamped ${hours(age)} ` +
      `ago, older than the ${hours(window)} this server keeps the record ` +
      `that tells a resend from a new change. It may already have been ` +
      `applied (a resend after a lost ack), and applying it now could apply ` +
      `it twice — so it is refused rather than guessed at. If clients may ` +
      `stay offline this long, raise sync.offline.retention on "${cell}" ` +
      `(the record is kept at least that long) — or, if this device's clock ` +
      `is wrong, correct it; the change can be made again.`;
    sendTo(
      socket,
      enc("op-rejected", { opId, cell, reason }),
      `op-rejected for ${opId}`,
    );
    deps.log.warn(`[sync:server] op ${opId} (${cell}) refused — ${reason}`);
    return true;
  }

  /** The op's cursor position for an ack. A fresh insert already knows it; a
   *  duplicate (resend after a lost ack) has to ask the store — the row, or
   *  the tombstone if compaction rolled the row over. `null` only when the
   *  store genuinely cannot say, and the ack then omits the field exactly as a
   *  pre-alpha43 server would. */
  function ackServerTs(
    opId: string,
    inserted: number | null,
  ): number | Promise<number | null> {
    return inserted ?? getOpServerTs(deps.db, opId);
  }

  async function tryCompact(cell: string, force = false): Promise<void> {
    // A quarantined cell's live state is NOT the data (the replay could not
    // fold the log; the slice is the last snapshot, or the defaults). Writing
    // it into sync_snapshots and DELETING the ops it "contains" would be the
    // exact data loss the quarantine exists to prevent. Refused here — the ONE
    // path every snapshot write takes (op-count, server-write, shutdown flush).
    if (deps.isQuarantined?.(cell)) {
      deps.log.warn(
        `[sync:server] compaction of "${cell}" skipped — the cell is ` +
          `quarantined since boot (its op-log could not be replayed into the ` +
          `current shape); fix the cell's version/onMigrate and restart`,
      );
      return;
    }
    try {
      await compactSyncOps({
        db: deps.db,
        cell,
        getState: () => deps.getCellState(cell),
        serverHlc: clock.now(),
        cellVersion: deps.cellVersion?.(cell) ?? 0,
        retentionMs: deps.opRetentionMs?.(cell),
        log: deps.log,
        // force: fold current state into the snapshot regardless of op count —
        // the durability path for server-origin writes (see noteServerWrite).
        ...(force ? { compactOps: 0 } : {}),
      });
    } catch (e) {
      deps.log.error(`[sync:server] compact failed for ${cell}: ${e}`);
    }
  }

  // ── Server-origin write durability ─────────────────────────────────
  // Same debounce scale as KV persistence (100ms): a crash inside the window
  // loses at most the last write — identical exposure to KV cells — and a
  // clean shutdown flushes (aio-lifecycle calls flushServerWrites).
  const SERVER_WRITE_DEBOUNCE_MS = 100;
  const _pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

  function noteServerWrite(cell: string): void {
    if (!syncCells.has(cell)) return;
    const existing = _pendingWrites.get(cell);
    if (existing !== undefined) clearTimeout(existing);
    _pendingWrites.set(
      cell,
      setTimeout(() => {
        _pendingWrites.delete(cell);
        void withLock(cell, () => tryCompact(cell, true));
      }, SERVER_WRITE_DEBOUNCE_MS),
    );
  }

  async function flushServerWrites(): Promise<void> {
    const cells = [..._pendingWrites.keys()];
    for (const t of _pendingWrites.values()) clearTimeout(t);
    _pendingWrites.clear();
    await Promise.all(
      cells.map((cell) => withLock(cell, () => tryCompact(cell, true))),
    );
  }

  // Clients already told their cursor is foreign (see `foreign` in
  // handleSync) — a client built before `reset` keeps re-sending the same
  // stale cursor every round, and the warning is one per client, not per round.
  const _foreignWarned = new WeakSet<object>();

  return {
    noteServerWrite,
    flushServerWrites,
    async handleOp(raw, meta, socket) {
      if (!isValidSyncOp(raw)) {
        deps.log.warn(`[sync:server] invalid op from ${meta.id} — dropping`);
        return;
      }
      const op = raw;
      if (!syncCells.has(op.cell)) {
        deps.log.warn(
          `[sync:server] op for unknown cell "${op.cell}" — rejecting`,
        );
        // TELL the client. An op this server can NEVER accept — reachable on
        // any client/server build skew: an open tab against a redeployed
        // server, an older Electron/Android bundle — used to be dropped with
        // nothing said to its origin. The client re-sent it on every
        // reconnect forever, `onRejected` never fired, and the pending count
        // never drained. D11: the origin is always told.
        sendTo(
          socket,
          enc("op-rejected", {
            opId: op.id,
            cell: op.cell,
            reason: `unknown cell "${op.cell}" — this server does not sync it`,
          }),
          `op-rejected for ${op.id}`,
        );
        return;
      }
      // Refuse before persist: an ack is a durability promise, and a
      // quarantined cell cannot keep it (see `refuseIfQuarantined`).
      if (refuseIfQuarantined(op.id, op.cell, socket)) return;
      if (refuseIfDrifted(op.id, op.cell, op.hlc, socket)) return;
      // AUTH-1: enforce the cell's declarative `access` rule on the sync path
      // too. Without this, a client that passes /ws (any authed user in
      // per-user mode) could mutate an `access:"admin"` cell via an op frame,
      // bypassing the gate the `action` path enforces. Reject before persist.
      if (deps.accessCheck && !deps.accessCheck(op.cell, meta.user)) {
        deps.log.warn(
          `[sync:server] op for access-gated cell "${op.cell}" denied for ${
            (meta.user as { id?: string })?.id ?? "anonymous client"
          } — dropping`,
        );
        try {
          socket.send(enc("op-rejected", {
            opId: op.id,
            cell: op.cell,
            reason: "access denied",
          }));
        } catch { /* client gone */ }
        return;
      }

      await withLock(op.cell, async () => {
        // Under the lock, before the persist — see `refuseIfStale`.
        if (await refuseIfStale(op.id, op.cell, op.hlc, socket)) return;
        clock.receive(op.hlc);
        const serverHlc = clock.tick();

        // Persist → ack → broadcast (await persist before ack — AIO-audit3)
        let serverTs: number | null = null;
        try {
          serverTs = await persistOp(
            deps.db,
            op,
            deps.cellVersion?.(op.cell) ?? 0,
          );
        } catch (e) {
          deps.log.error(`[sync:server] failed to persist op ${op.id}: ${e}`);
          return; // Don't ack — client will retry
        }

        // Apply to live server state BEFORE ack/compact — the op-log and
        // the state must agree (compaction snapshots live state). Duplicate
        // delivery (client retry after a lost ack) must NOT re-dispatch:
        // persistOp is INSERT OR IGNORE, so `serverTs === null` means the
        // op's effect is already in live state — re-applying would double it.
        let rejectedReason: string | null = null;
        if (serverTs === null) {
          // Observe-only: a duplicate here is the client re-sending after a
          // lost ack (normal) — or a cursor bug upstream (worth seeing).
          deps.log.debug(
            `[sync:server] duplicate op ${op.id} (${op.cell}:${op.action}) — re-acked, not re-applied`,
          );
        }
        if (serverTs !== null) {
          try {
            // AWAITED. `dispatch` reports failure by REJECTING (REDUCE_ERROR,
            // QUEUE_OVERFLOW, DISPATCH_CLOSED), never by throwing
            // synchronously, so an un-awaited call left this `catch` dead:
            // when a reducer threw for this payload, the op was still acked
            // (origin believes it landed), still broadcast (peers apply it),
            // and later compacted — and compaction snapshots LIVE state, which
            // never got the effect, while deleting the op row. The change
            // existed on every machine except the one that owns the truth, and
            // nothing anywhere said so.
            // The action object is held, not inlined: the rejection is keyed
            // to it. `await` hands the event loop to every other op chain, and
            // a process-wide "last rejection" slot was whichever dispatch ran
            // most recently — this one's refusal erased by a neighbour, or a
            // neighbour's refusal charged to this one.
            const action = {
              type: `${op.cell}:${op.action}`,
              payload: op.payload,
              _user: meta.user, // trusted connection identity (server-resolved)
              // Origin marker: this write IS a persisted op — afterAction must
              // not schedule a durability snapshot for it.
              _syncOp: true,
            };
            await deps.dispatch(action);
            // D11: the server's re-execution is the authority — if the
            // validate hook refused this op, the op is POISON: delete it
            // from the log (state and log must agree) and tell the origin
            // WHY instead of acking.
            const rejection = takeRejectionFor(action, op.cell);
            if (rejection) {
              rejectedReason = rejection.reason;
              await deps.db.execute("DELETE FROM sync_ops WHERE id = ?", [
                op.id,
              ]);
            }
          } catch (e) {
            // Same poison treatment as a validate refusal: the server could
            // not apply it, so the log must not keep it and no one must be
            // told it succeeded.
            rejectedReason = `dispatch failed: ${
              e instanceof Error ? e.message : String(e)
            }`;
            deps.log.error(
              `[sync:server] dispatch of op ${op.id} failed: ${e}`,
            );
            await deps.db.execute("DELETE FROM sync_ops WHERE id = ?", [op.id])
              // A failed cleanup is NOT cosmetic: the op stays in `sync_ops`,
              // so the next drain picks up the same already-failed op and
              // retries it — forever, silently. That is the server twin of the
              // browser bug `browser-sync.ts` was written to kill, and it hid
              // behind an empty catch.
              .catch((delErr: unknown) =>
                deps.log.error(
                  `[sync:server] could not delete failed op ${op.id} — it ` +
                    `will be retried on every drain until removed: ${delErr}`,
                )
              );
          }
        }

        if (rejectedReason !== null) {
          sendTo(
            socket,
            enc("op-rejected", {
              opId: op.id,
              cell: op.cell,
              reason: rejectedReason,
            }),
            `op-rejected for ${op.id}`,
          );
          deps.log.warn(
            `[sync:server] op ${op.id} (${op.cell}:${op.action}) rejected: ${rejectedReason}`,
          );
          return;
        }

        // Always ack — for a duplicate this is the retransmit of the ack the
        // client lost, and it's what lets the client stop resending the op.
        // The op's cursor position rides along, duplicate or not: the client
        // compares it against the snapshot it last installed, and an ack that
        // predates the snapshot describes an op the snapshot ALREADY contains
        // (re-applying it to confirmed state would double it). A duplicate
        // re-ack used to go out bare — precisely the ack most likely to follow
        // a snapshot, since it means the first ack was lost.
        const ackTs = await ackServerTs(op.id, serverTs);
        sendTo(
          socket,
          enc("sync-ack", {
            cell: op.cell,
            opId: op.id,
            serverHlc,
            ...(ackTs !== null ? { serverTs: ackTs } : {}),
          }),
          `sync-ack for ${op.id}`,
        );

        if (serverTs !== null) {
          // ONE frame, identical for every peer — and that is only sound
          // because of an invariant enforced upstream: a sync cell may not
          // have a `ui` filter that hides state (aio-composition.ts,
          // refuseFilteredSyncCells). There is no per-user variant of this
          // frame and there cannot be one: peers that receive different ops do
          // not converge, and an op is an opaque {cell, action, payload} with
          // no user dimension to filter on. A cell whose data is not for
          // everyone must not be replicated to everyone — that is refused at
          // compose time, not patched here.
          //
          // Broadcast carries serverTs so peers advance their sync cursor as
          // they apply it — otherwise the next catch-up re-delivers this op
          // (it sits above their cursor) and they double-apply it.
          deps.broadcastRaw.fn(
            enc("op", {
              id: op.id,
              hlc: op.hlc,
              cell: op.cell,
              action: op.action,
              payload: op.payload,
              serverTs,
            }),
            socket,
          );

          await tryCompact(op.cell);
        }

        deps.log.debug(
          `[sync:server] persisted op ${op.id} for ${op.cell}:${op.action}`,
        );
      });
    },

    handleSync(raw, meta, socket) {
      const r = raw as Record<string, unknown>;
      if (
        !r || typeof r !== "object" ||
        typeof r.clientId !== "string" || !r.clientId ||
        (r.cells !== undefined &&
          (typeof r.cells !== "object" || r.cells === null)) ||
        (r.pendingOps !== undefined && !Array.isArray(r.pendingOps))
      ) {
        deps.log.warn("[sync:server] handleSync: invalid envelope — dropping");
        return;
      }
      // …and every ENTRY of `cells`, here, where the envelope is checked —
      // not in the loop that reads them. The loop destructures
      // `{ lastHlc, lastServerTs }` straight off the value, so a null entry
      // (`cells: { todos: null }`) threw `Cannot read properties of null` out
      // of the async body: an ERROR line blaming the server, and the raw
      // TypeError shipped BACK to the client as the sync failure. A cursor is
      // `{ lastHlc: HLC|null, lastServerTs?: number }` and nothing else — a
      // string `lastServerTs` compares wrong rather than throwing, which is
      // worse. One shape check at the door, naming what was wrong.
      const badCell = Object.entries(
        (r.cells ?? {}) as Record<string, unknown>,
      ).find(([, v]) => !isValidCellCursor(v));
      if (badCell) {
        deps.log.warn(
          `[sync:server] handleSync: invalid cursor for cell "${
            badCell[0]
          }" — dropping the request. A cell entry must be ` +
            `{ lastHlc: [number, number, string] | null, lastServerTs?: number }.`,
        );
        return;
      }
      const sync = r as {
        clientId: string;
        /** Monotonic id of THIS request, echoed on the response so the client
         *  can tell which request it answers (see SyncRequest.reqId). */
        reqId?: number;
        /** The requester's per-session nonce (see SyncRequest). Absent from a
         *  client built before it existed. */
        session?: string;
        cells: Record<string, { lastHlc: HLC | null; lastServerTs?: number }>;
        pendingOps: SyncOp[];
      };
      // "Ops of the client asking" — by SESSION when it says which, because
      // the client id alone is a persisted UUID that two clones of one profile
      // share, and filtering on it made each clone's ops invisible to the
      // other forever. The op id carries the nonce (`clientId-session-n`), so
      // the prefix IS the answer; without a session we keep the old client-id
      // rule rather than start echoing an old client's ops back at it.
      const ownPrefix = typeof sync.session === "string" && sync.session !== ""
        ? `${sync.clientId}-${sync.session}-`
        : null;
      const isRequestersOwnOp = (o: SyncOp): boolean =>
        ownPrefix !== null
          ? o.id.startsWith(ownPrefix)
          : o.hlc[2] === sync.clientId;

      (async () => {
        // The log's durable high-water mark BEFORE this request writes
        // anything — the reference for `foreign` below. Every cursor this log
        // ever issued was ≤ its high-water at the time, so a cursor above
        // THIS value was not issued here. Measured after the pending ops are
        // persisted it is not: a reconnect's own offline queue stamps above
        // the client's cursor, the mark moves over it, and a client holding a
        // different history's cursor is served "incrementally" — it keeps
        // every op the other history had (tests/sync/foreign-cursor.test.ts).
        const highWaterBefore = await reserveServerTs(deps.db);
        // Persist pending ops under per-cell lock (prevents compact race)
        for (const pending of sync.pendingOps ?? []) {
          if (!isValidSyncOp(pending)) {
            deps.log.warn(
              "[sync:server] handleSync: invalid pending op — skipping",
            );
            continue;
          }
          if (!syncCells.has(pending.cell)) {
            // Same door as handleOp, and it was the quieter of the two: this
            // path carries a reconnect's whole offline queue, so a build skew
            // parked every queued op here with not one line in the log.
            deps.log.warn(
              `[sync:server] pending op for unknown cell "${pending.cell}" — rejecting`,
            );
            sendTo(
              socket,
              enc("op-rejected", {
                opId: pending.id,
                cell: pending.cell,
                reason:
                  `unknown cell "${pending.cell}" — this server does not sync it`,
              }),
              `op-rejected for pending op ${pending.id}`,
            );
            continue;
          }
          // Same quarantine gate as handleOp: this is the path that carries a
          // reconnect's whole offline queue, so it is the one that would put
          // the most undurable writes into a log nobody can fold.
          if (refuseIfQuarantined(pending.id, pending.cell, socket)) continue;
          if (
            refuseIfDrifted(pending.id, pending.cell, pending.hlc, socket)
          ) continue;
          // Same access gate as handleOp — pending ops are client-submitted.
          if (deps.accessCheck && !deps.accessCheck(pending.cell, meta.user)) {
            deps.log.warn(
              `[sync:server] pending op for access-gated cell "${pending.cell}" denied — dropping`,
            );
            // TELL the client, exactly as handleOp does. A silent drop left the
            // op in its pending buffer forever: never applied, never cleared,
            // re-sent on every reconnect, re-evaluated against the access gate
            // every round. A denial the client never hears about is a
            // leak that looks like a hang.
            sendTo(
              socket,
              enc("op-rejected", {
                opId: pending.id,
                cell: pending.cell,
                reason: "access denied",
              }),
              `op-rejected for pending op ${pending.id}`,
            );
            continue;
          }
          await withLock(pending.cell, async () => {
            // The path that carries the OLDEST ops — a reconnect's whole
            // offline queue — so the one most likely to hold a resend the
            // store no longer recognises. See `refuseIfStale`.
            if (
              await refuseIfStale(pending.id, pending.cell, pending.hlc, socket)
            ) return;
            clock.receive(pending.hlc);
            const serverHlc = clock.tick();
            let serverTs: number | null = null;
            try {
              serverTs = await persistOp(
                deps.db,
                pending,
                deps.cellVersion?.(pending.cell) ?? 0,
              );
            } catch (e) {
              deps.log.error(
                `[sync:server] failed to persist pending op ${pending.id}: ${e}`,
              );
              return; // Don't ack — client keeps it pending and retries
            }
            // Reconnect-queued ops must reach live state too (same contract
            // as handleOp) — but only ONCE. A pending op is re-sent on every
            // sync round until acked; dispatching a duplicate would re-apply
            // its effect to live state each round (counter drift). Peers get
            // the same broadcast as the handleOp path (serverTs included so
            // their cursor advances — see handleOp).
            if (serverTs === null) {
              deps.log.debug(
                `[sync:server] duplicate pending op ${pending.id} (${pending.cell}:${pending.action}) — re-acked, not re-applied`,
              );
            }
            let rejectedReason: string | null = null;
            if (serverTs !== null) {
              try {
                const action = { // held for the rejection key — see handleOp
                  type: `${pending.cell}:${pending.action}`,
                  payload: pending.payload,
                  _user: meta.user,
                  _syncOp: true,
                };
                await deps.dispatch(action); // awaited — see handleOp
                // D11, same as handleOp: the server's re-execution is the
                // authority. Without this check a reconnect-flushed op that
                // the validate hook REFUSED was still broadcast to every peer,
                // acked to its origin (which then marked it confirmed), and
                // left in the op log to be replayed at the next boot — the
                // rejected effect applied everywhere except the one place that
                // decided it was invalid. This path carries the STALEST
                // ops, so it is the most likely to fail validation and was the
                // least likely to say so.
                const rejection = takeRejectionFor(action, pending.cell);
                if (rejection) {
                  rejectedReason = rejection.reason;
                  await deps.db.execute("DELETE FROM sync_ops WHERE id = ?", [
                    pending.id,
                  ]);
                }
              } catch (e) {
                rejectedReason = `dispatch failed: ${
                  e instanceof Error ? e.message : String(e)
                }`;
                deps.log.error(
                  `[sync:server] dispatch of pending op ${pending.id} failed: ${e}`,
                );
                await deps.db.execute("DELETE FROM sync_ops WHERE id = ?", [
                  pending.id,
                  // Same as the drain path above: a swallowed delete leaves the
                  // op to be reprocessed on every pass, with nothing said.
                ]).catch((delErr: unknown) =>
                  deps.log.error(
                    `[sync:server] could not delete failed pending op ` +
                      `${pending.id} — it will be retried on every drain ` +
                      `until removed: ${delErr}`,
                  )
                );
              }
              if (rejectedReason === null) {
                deps.broadcastRaw.fn(
                  enc("op", {
                    id: pending.id,
                    hlc: pending.hlc,
                    cell: pending.cell,
                    action: pending.action,
                    payload: pending.payload,
                    serverTs,
                  }),
                  socket,
                );
              }
            }
            if (rejectedReason !== null) {
              sendTo(
                socket,
                enc("op-rejected", {
                  opId: pending.id,
                  cell: pending.cell,
                  reason: rejectedReason,
                }),
                `op-rejected for pending op ${pending.id}`,
              );
              deps.log.warn(
                `[sync:server] pending op ${pending.id} (${pending.cell}:${pending.action}) rejected: ${rejectedReason}`,
              );
              return; // no ack — the op was refused, not applied
            }
            // Ack ALWAYS (duplicate = retransmit of a lost ack). Without this
            // the client never confirms reconnect-flushed ops: it re-sends
            // them forever and keeps rebasing them on top of confirmed state
            // that already includes them (permanent double-apply in the UI).
            const ackTs = await ackServerTs(pending.id, serverTs);
            sendTo(
              socket,
              enc("sync-ack", {
                cell: pending.cell,
                opId: pending.id,
                serverHlc,
                ...(ackTs !== null ? { serverTs: ackTs } : {}), // see handleOp
              }),
              `sync-ack for pending op ${pending.id}`,
            );
          });
        }

        // Build response per cell (read under lock to get consistent view)
        const responseOps: SyncOp[] = [];
        let useSnapshot = false;
        const snapshot: Record<string, Record<string, unknown>> = {};
        const lowWaterMap: Record<string, HLC> = {};
        const serverTsMap: Record<string, number> = {};
        // Cells whose cursor this server has never issued — see `foreign`.
        const resetCells: string[] = [];

        for (
          const [cell, { lastHlc, lastServerTs }] of Object.entries(
            sync.cells ?? {},
          )
        ) {
          if (!syncCells.has(cell)) continue;
          // A quarantined cell is served NOTHING — not a snapshot, not a
          // cursor. Its live state is the pre-quarantine snapshot (the log did
          // not fold), so sending it would overwrite the client's confirmed
          // state with older data, and echoing a cursor would seal the ops the
          // server could not fold ABOVE it — the client would never ask again.
          // Silence here leaves the client on what it already has, which is at
          // least not wrong, and its cursor unmoved so a fixed build catches it
          // up. Said once per cell: this repeats on every sync round.
          if (deps.isQuarantined?.(cell)) {
            if (!_quarantineWarned.has(cell)) {
              _quarantineWarned.add(cell);
              deps.log.warn(
                `[sync:server] serving no state for "${cell}" — ` +
                  `${quarantineReason(cell)} (logged once per cell)`,
              );
            }
            continue;
          }

          await withLock(cell, async () => {
            // Reserve the cell's cursor FIRST, inside its lock: persists for
            // this cell are serialized by the same lock, so every op already
            // persisted is ≤ the reservation (and returned/snapshotted below)
            // and every later op is strictly above it. That makes echoing this
            // value race-free — the client can't be told a cursor that covers
            // ops it was never sent.
            serverTsMap[cell] = await reserveServerTs(deps.db);

            const cellLW = await getLowWater(deps.db, cell);
            if (cellLW) lowWaterMap[cell] = cellLW;

            // ONE decider for "is this client still servable from the log":
            // its server_ts cursor against `compacted_ts`, the highest
            // server_ts compaction has DELETED. Delivery reads by server_ts,
            // so a cursor at or below that mark cannot be served incrementally
            // — the rows are gone — and the client would be told "nothing new"
            // while its confirmed state silently diverged forever.
            //
            // This used to be scoped to clients with NO `lastHlc`, on the
            // theory that a client with an HLC watermark was already judged
            // correctly by the low-water rule below. It is not: `lastHlc` is
            // the MAXIMUM HLC seen, not a coverage watermark. A client that
            // missed ops while offline and then takes ONE post-compaction
            // broadcast (its lastHlc jumps above low_water) while its
            // server_ts cursor still sits below the compaction boundary fell
            // to the incremental branch and never heard about the deleted ops
            // again. Two cursors deciding one fact, disagreeing exactly where
            // it mattered.
            //
            // The reason the scoping existed — snapshots doubling the client's
            // own in-flight ops when their acks arrived — is fixed at its own
            // root instead: every ack now carries the op's server_ts (even a
            // duplicate re-ack, see `ackServerTs`), so `handleAck` can tell an
            // op the snapshot already contains from one it doesn't. Extra
            // snapshots are bandwidth; a missed op is data loss.
            const compactedTs = await getCompactedTs(deps.db, cell);
            const cursorBelowCompaction = compactedTs > 0 &&
              (lastServerTs ?? 0) < compactedTs;

            // …and the snapshot this log cannot NAME a position for.
            //
            // `compacted_ts = 0` means three different things: no snapshot, a
            // SEEDED one (`seedSyncSnapshot` leaves sync_meta alone on
            // purpose, so no live client is forced into a resync), and a row
            // written before the column existed (the migration adds it
            // `DEFAULT 0`). The test above read all three as "no snapshot",
            // so a client with NO cursor took the incremental branch and
            // rebuilt the cell from its own declared `initialState` plus the
            // ops — which is not what this log's base is.
            //
            // Two live paths, both silent: a `localFirst` cell adopted with
            // existing KV data painted correctly from the plain `state` frame
            // and then LOST that data on the first local edit (server kept
            // it); and after an upgrade from a pre-`compacted_ts` aio, every
            // reloaded client (browser cursors are session-scoped, so
            // `lastHlc` is null too and the legacy HLC rule cannot fire)
            // rebuilt from a base whose ops were already deleted.
            //
            // Scoped to a CURSORLESS client, which is exactly the one that
            // cannot prove coverage: a client holding a cursor took it from
            // this log after the snapshot was written, so its state already
            // contains it. That is one snapshot per fresh client per cell —
            // the same cost a post-compaction catch-up already pays.
            const cursorless = lastServerTs == null && lastHlc == null;
            const snapshotUnnamed = cursorless && compactedTs === 0 &&
              await hasSyncSnapshot(deps.db, cell);

            // A cursor ABOVE this log's high-water mark (as it stood before
            // this request wrote anything — `highWaterBefore`) was never
            // issued by this log: `reserveServerTs` IS the durable maximum,
            // and every position a client can hold — an echoed cursor, an
            // ack, a broadcast stamp — was taken from it. So the client synced
            // with a different history: the server restarted on a restored
            // backup, a wiped data dir, or another app now answering on the
            // same port. Its cursor is meaningless here, and serving it
            // "incrementally" sent nothing (no op is above a position that
            // does not exist) while the client kept its stale cursor under
            // the never-regress rule — silent, permanent divergence, with no
            // line in any log. Send a snapshot and tell the client to RESET
            // its cursor (see `reset` in the response): the client cannot
            // tell a foreign cursor from an out-of-order response, the server
            // can. (A foreign cursor BELOW this mark — the other history was
            // older than a write this log has since taken — is not
            // detectable from positions alone; the client then folds this
            // log's newer ops onto the other history's state. Known gap; a
            // history identity on the log would close it.)
            const foreign = (lastServerTs ?? 0) > highWaterBefore;
            if (foreign) {
              resetCells.push(cell);
              if (!_foreignWarned.has(socket)) {
                _foreignWarned.add(socket);
                deps.log.warn(
                  `[sync:server] client ${meta.id} holds a cursor for "${cell}" ` +
                    `(${lastServerTs}) above this log's high-water mark ` +
                    `(${highWaterBefore}) — it synced with a different ` +
                    `history (restored backup, wiped data dir, or another app ` +
                    `on this port). Sending a snapshot and resetting its ` +
                    `cursor; its unsent changes are kept. (Once per client.)`,
                );
              }
            }

            // Client's lastHlc older than low_water → compacted, send snapshot
            if (
              cursorBelowCompaction || snapshotUnnamed || foreign ||
              (cellLW && lastHlc &&
                (lastHlc[0] < cellLW[0] ||
                  (lastHlc[0] === cellLW[0] && lastHlc[1] < cellLW[1])))
            ) {
              // Read AFTER reserveServerTs above, and inside this cell's lock:
              // every op already persisted has server_ts <= the reserved
              // cursor and is therefore in this state, and anything persisted
              // later gets a strictly greater one. That makes
              // `lastServerTs[cell]` an exact watermark for "what this
              // snapshot contains" — which is what lets the client tell an
              // ack for an op the snapshot already holds from an ack for one
              // it doesn't.
              //
              // CLIENT-visible projection, never raw state: this frame goes out
              // on a socket. `null` = the cell is not sendable at all, so we
              // send nothing for it rather than a slice a filter said to hide.
              // (Compose refuses sync + a hiding ui filter, so reaching the
              // null branch means something bypassed that gate — say so.)
              const clientState = deps.getClientCellState(cell);
              if (clientState === null) {
                deps.log.error(
                  `[sync:server] refusing to snapshot "${cell}" — its ui config ` +
                    `hides it from clients, and a catch-up snapshot goes out on ` +
                    `a socket. This client cannot converge on this cell: drop ` +
                    `sync or drop the ui filter.`,
                );
                // The cursor was RESERVED above, before we knew the cell could
                // not be served. Leaving it in the echo tells the client
                // "everything up to here is covered" for a cell it was sent
                // nothing about — it advances past ops it never received and
                // never asks for them again. Take the promise back with the
                // data it was standing for.
                delete serverTsMap[cell];
                delete lowWaterMap[cell];
                const i = resetCells.indexOf(cell);
                if (i !== -1) resetCells.splice(i, 1);
                return;
              }
              useSnapshot = true;
              snapshot[cell] = clientState;
            } else {
              // server_ts cursor when the client has one (strictly monotonic,
              // no concurrency ambiguity); HLC cursor as legacy fallback.
              const ops = await loadOpsSince(
                deps.db,
                cell,
                lastHlc,
                lastServerTs ?? undefined,
              );
              // Don't echo the client's own ops back (hlc node = clientId):
              // they reach its confirmed state via the __ack path, and a
              // reducer re-apply here would double their effect.
              //
              // …unless the client has NO cursor. Then it is not a live client
              // with a few ops in flight, it is one rebuilding the cell from
              // nothing — a page reload throws confirmed state away, and the
              // cursor is deliberately thrown away with it (see
              // browser-storage's session scoping). The ack path cannot bring
              // back ops that were acked and dropped in an earlier session, so
              // filtering them here deleted every edit the user had ever made
              // from their own screen, while the server and every peer kept
              // them. The client re-applies only the ones it is not already
              // waiting on an ack for (`foldCatchupOp`).
              const rebuilding = !(lastServerTs != null && lastServerTs > 0);
              responseOps.push(
                ...(rebuilding
                  ? ops
                  : ops.filter((o) => !isRequestersOwnOp(o))),
              );
            }
          });
        }

        // Echo the request id when the client sent one: with two catch-ups in
        // flight, a response that cannot say which request it answers opened
        // the client's ordering gate for BOTH (see the engine's `hold`).
        const reqId =
          typeof sync.reqId === "number" && Number.isFinite(sync.reqId)
            ? { reqId: sync.reqId }
            : {};
        const response = useSnapshot
          ? {
            mode: "snapshot" as const,
            snapshot,
            ops: responseOps,
            lowWater: lowWaterMap,
            lastServerTs: serverTsMap,
            ...(resetCells.length ? { reset: resetCells } : {}),
            ...reqId,
          }
          : {
            mode: "incremental" as const,
            ops: responseOps,
            lowWater: lowWaterMap,
            lastServerTs: serverTsMap,
            ...reqId,
          };

        sendTo(socket, enc("sync-res", response), "sync-res");

        deps.log.debug(
          `[sync:server] sync response: ${response.mode}, ${responseOps.length} ops`,
        );
      })().catch((e) => {
        deps.log.error(`[sync:server] handleSync failed: ${e}`);
        // Notify client so it can back off and retry instead of hanging in "syncing"
        sendTo(socket, enc("sync-err", { reason: String(e) }), "sync-err");
      });
    },
  };
}
