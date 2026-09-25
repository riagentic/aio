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
import { diffState, stateDigest } from "./state-patch.ts";
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
      /** The op's position in the op-log (its `server_ts`). */
      _syncTs?: number;
      /** The op's id. */
      _syncId?: string;
    },
    // Returns whatever the app's dispatch returns — a PROMISE that rejects
    // when the action could not be applied (REDUCE_ERROR, QUEUE_OVERFLOW,
    // DISPATCH_CLOSED). The handler awaits it: an op the server could not
    // apply must not be acked, broadcast or compacted. `unknown` (rather than
    // `void`) so a plain non-promise dispatch is still a valid dep — awaiting
    // one resolves immediately.
  ) => unknown;
  /** What must be durable before this action may be acked — the saves that
   *  stand in for a journal line the action's commit could not (or may not)
   *  write (a refused append, a redacted cell's state). Undefined: nothing
   *  outstanding. Awaited AFTER dispatch, before the ack; see `_parked` for
   *  why that wait cannot deadlock on another cell's lock. Optional so a
   *  handler double in a test stays valid. */
  durableFor?: (action: object) => Promise<string | undefined> | undefined;
  /** Why ops cannot be applied RIGHT NOW, if so (time travel paused): such
   *  an op is held — not persisted, not acked, not refused — and the client
   *  is sent `sync-err`, which it answers by re-requesting (its pending ops
   *  included) until the reason is gone. Optional: no reason ever. */
  heldBecause?: () => string | undefined;
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
   *  `sync: true` would be freely mutable by any connected client.
   *
   *  `method` and `args` are the op's OWN action and call args — the same two
   *  facts the action path hands a predicate rule. It used to be asked about a
   *  method called "sync" with no args, so a deny-list rule
   *  (`m !== "wipe" || admin`) or a row-level one passed, and the op then ran
   *  `wipe` for anyone. */
  accessCheck?: (
    cell: string,
    user: unknown,
    method: string,
    args: unknown[],
  ) => boolean;
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
   *  write of a clean exit is never inside the debounce window. `cells`
   *  limits it to those (a write that must be durable NOW, without folding
   *  every other pending cell with it). Resolves to why a fold failed, or
   *  undefined; without `cells`, a cell whose last fold failed earlier counts
   *  too (its snapshot still lacks it). */
  flushServerWrites: (cells?: readonly string[]) => Promise<string | undefined>;
  /** Record, INSIDE every snapshot fold's transaction, how far a write log is
   *  folded in — see {@linkcode SyncFoldWatermark}. `null` detaches. Optional
   *  so a handler double in a test stays valid. */
  setFoldWatermark?: (w: SyncFoldWatermark | null) => void;
  /** Called with every op's issued `server_ts` after it is issued and before
   *  its row is inserted, synchronously (see `persistOp`'s `onIssue`) — where
   *  the host records the op's intent. A throw keeps the op out of the log:
   *  it is not acked, and the client resends it. `null` detaches. Optional
   *  so a handler double in a test stays valid. */
  setOpIssueHook?: (
    fn:
      | ((op: { id: string; cell: string; action: string }, ts: number) => void)
      | null,
  ) => void;
}

/** A write log whose position rides in the fold that makes it durable.
 *
 *  A server-origin write to a sync cell is folded into the cell's snapshot up
 *  to 500 ms after it is acked (see `noteServerWrite`). `journal: true` closes
 *  that window by journalling the write — but replaying it on the next boot is
 *  only correct when the snapshot does NOT already hold it (replay re-reduces;
 *  `items.push(id)` twice is a duplicate). So the journal's position is taken
 *  at the instant the fold captures state, and written by the fold's own
 *  transaction: the snapshot and "it holds up to seq N" commit together or not
 *  at all.
 *
 *  @internal Engine/framework wiring — not public API. */
export interface SyncFoldWatermark {
  /** The log position the state being captured holds. Called synchronously,
   *  at the capture. */
  capture: (cell: string) => number;
  /** The statements that record `at`, run inside the fold's transaction. */
  plan: (cell: string, at: number) => { sql: string; params?: unknown[] }[];
  /** The fold that recorded `at` committed. */
  folded: (cell: string, at: number) => void;
}

/** Unread bytes one sync peer may hold before it is closed instead of written
 *  to — see `sendTo`. The SAME number as `WS_BUFFER_HIGH_WATER`
 *  (server/write-backlog.ts), which the WS broadcaster applies to the very
 *  same sockets; `sync/` may not import `server/` (check-boundaries), so it
 *  is spelled here and pinned equal by tests/sync-send-high-water.test.ts.
 *  @internal */
export const SYNC_SOCKET_HIGH_WATER = 4 * 1024 * 1024;

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

/** An op's positional call args (`payload.args`), as the action path reads
 *  them for an access predicate — `[]` when the payload carries none. Pure. */
function opArgs(payload: unknown): unknown[] {
  const a = (payload as { args?: unknown } | null | undefined)?.args;
  return Array.isArray(a) ? a : [];
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
 *
 *  @decider
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
    // A peer that has stopped reading. Every frame this file sends is one a
    // client cannot do without — a `sync-res`, an op's ack or refusal, a
    // legacy client's whole-cell server-write push — so it cannot be SKIPPED
    // the way a state round is (no in-band repair: a missed ack is an op
    // resent forever, a missed push a cell that silently stays behind). And
    // it cannot be queued without limit either: the runtime holds it on the
    // server's heap for as long as the peer does not read. The repair a sync
    // client does have is the reconnect (catch-up resumes from its own
    // cursor), so it is closed — the same rule, code and reason as
    // `broadcastRaw` (server-broadcast.ts `_closeNotDraining`).
    const held = (socket as { bufferedAmount?: number }).bufferedAmount ?? 0;
    if (!gone && held > SYNC_SOCKET_HIGH_WATER) {
      deps.log.warn(
        `[sync:server] closing a sync client that is not draining its socket ` +
          `(${
            (held / 1048576).toFixed(1)
          } MB of unread frames held on the server) — ${what} cannot be ` +
          `skipped without leaving a gap, so it reconnects and catches up ` +
          `from its own cursor instead`,
      );
      try {
        socket.close(1013, "not draining: reconnect and resync");
      } catch {
        /* aio-ok: already closing — the next send sees it gone */
      }
      return;
    }
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
  /** Cells whose lock holder is WAITING for durability (`durableFor`) —
   *  dispatched, not yet acked, doing nothing else under the lock. An op on A
   *  whose reaction's stand-in is the fold of B waits under A's lock (the ack
   *  must stay where it is in the frame order); an op on B can wait for the
   *  fold of A the same way, and two such waits on each other's lock were a
   *  deadlock. A fold asked for a parked cell therefore runs AT ONCE, under
   *  the holder's lock (the holder is quiescent, and resumes only once every
   *  such fold is done). */
  const _parked = new Map<string, Promise<unknown>[]>();
  /** Folds queued for a cell's lock, to be run at once if its holder parks
   *  first (a fold asked for BEFORE the holder reached its wait). */
  const _parkWaiters = new Map<
    string,
    Set<(list: Promise<unknown>[]) => void>
  >();
  /** A fold of `cell`: under its lock, or — once its holder is parked —
   *  under the holder's, whichever comes first. */
  function foldLocked<T>(cell: string, fn: () => Promise<T>): Promise<T> {
    const parked = _parked.get(cell);
    if (parked !== undefined) {
      const run = fn();
      parked.push(run);
      return run;
    }
    let claimed = false;
    return new Promise<T>((resolve, reject) => {
      const waiters = _parkWaiters.get(cell) ?? new Set();
      _parkWaiters.set(cell, waiters);
      const viaPark = (list: Promise<unknown>[]): void => {
        if (claimed) return;
        claimed = true;
        const run = fn();
        list.push(run);
        run.then(resolve, reject);
      };
      waiters.add(viaPark);
      withLock(cell, async () => {
        waiters.delete(viaPark);
        if (waiters.size === 0 && _parkWaiters.get(cell) === waiters) {
          _parkWaiters.delete(cell);
        }
        if (claimed) return;
        claimed = true;
        await fn().then(resolve, reject);
      }).catch(reject);
    });
  }

  /** After an op's dispatch, under its cell's lock: wait until what its
   *  commit could not journal is durable (`durableFor`), parked (see
   *  `_parked`), and every fold that ran under this lock meanwhile is done. */
  async function waitDurable(
    cell: string,
    action: object,
  ): Promise<string | undefined> {
    const d = deps.durableFor?.(action);
    if (d === undefined) return undefined;
    const parked: Promise<unknown>[] = [];
    _parked.set(cell, parked);
    // Folds already queued for this lock run now, under it.
    for (const w of _parkWaiters.get(cell) ?? []) w(parked);
    _parkWaiters.delete(cell);
    try {
      const verdict = await d;
      while (parked.length > 0) {
        await parked.shift()!.catch(
          () => {
            /* aio-ok: its own verdict is the fold's log line and the stand-in's verdict */
          },
        );
      }
      return verdict;
    } finally {
      _parked.delete(cell);
    }
  }

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

  // ── Held: ops that cannot be applied RIGHT NOW (see `heldBecause`) ────
  /** Answer `sync-err` and hold the op(s): not persisted, not acked, not
   *  refused — the client keeps them and re-requests. */
  function holdIfHeld(socket: WebSocket): boolean {
    const why = deps.heldBecause?.();
    if (why === undefined) return false;
    sayHeld(socket, why);
    return true;
  }
  /** Sockets already told "held" since their last `sync-req` (or accepted
   *  op). A client meets EVERY `sync-err` with a retry, and one built before
   *  its single retry timer (v1.0.9 and earlier — a cached bundle after a
   *  deploy) runs one retry LOOP per frame: a held `sync-err` per op frame,
   *  during a pause or a shutdown drain, was N loops each resending the whole
   *  queue. One per socket until it asks again; its retry is the resend. */
  const _heldSaid = new WeakSet<WebSocket>();
  function sayHeld(socket: WebSocket, why: string): void {
    if (_heldSaid.has(socket)) return;
    _heldSaid.add(socket);
    sendTo(socket, enc("sync-err", { reason: why }), "sync-err (held)");
  }
  /** The backstop: dispatch refused an op because the server was not TAKING
   *  input — dispatch closed or draining (a shutdown in progress), or time
   *  travel paused (tagged DISPATCH_CLOSED) — and the in-lock check above
   *  did not see it coming. That is not the op's fault: refusing it
   *  (`op-rejected`) made the client prune the edit, so every deploy lost
   *  the edits in flight. It is held like the rest. */
  function isHeldRefusal(e: unknown): boolean {
    const code = (e as { code?: unknown } | null)?.code;
    return code === "DISPATCH_CLOSED" || code === "DISPATCH_DRAINING";
  }
  function sendHeld(socket: WebSocket): void {
    sayHeld(
      socket,
      deps.heldBecause?.() ??
        "the server is not taking input right now — sync ops are held " +
          "(not applied, not dropped) and resent",
    );
  }
  async function dropRow(id: string): Promise<void> {
    await deps.db.execute("DELETE FROM sync_ops WHERE id = ?", [id]).catch(
      (delErr: unknown) =>
        deps.log.error(
          `[sync:server] could not remove held op ${id} from the log — the ` +
            `next boot replays it, and the client's resend is then a ` +
            `duplicate (re-acked, not re-applied): ${delErr}`,
        ),
    );
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
  const _compactQuarantineSaid = new Set<string>();
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
    sendTo(
      socket,
      enc("op-rejected", { opId, cell, reason }),
      `op-rejected (${opId}, quarantined)`,
    );
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
  const _refused = new Map<string, string>();
  function rememberRefusal(opId: string, reason: string): void {
    _refused.delete(opId); // re-inserted: the newest refusal is evicted last
    _refused.set(opId, reason);
    if (_refused.size > REFUSED_IDS_CAP) {
      // Maps iterate in insertion order — evict the oldest.
      _refused.delete(_refused.keys().next().value!);
    }
  }
  /** Re-refuse an op this server already refused — same reason, same frame.
   *
   *  Every refusal the server DECIDES sticks to the op id, not only the drift
   *  one: a `validate` refusal or a method that threw on the server's state is
   *  just as much a decision the origin has already acted on (`onRejected`
   *  fired, the view rolled back, the op left its buffer). Those used to be
   *  forgotten with the deleted row, so the same op still in flight — the
   *  op frame and a `sync-req` carrying it as pending, or a duplicated frame —
   *  was dispatched AGAIN, and when the state had moved in between (a peer
   *  re-added the item the method needed) it was accepted: applied on the
   *  server and every peer, while its author had been told it was refused and
   *  kept a confirmed state without it, forever. (Found by the r3 sync hunt,
   *  2026-09-19; pinned by tests/sync/refusal-sticks.test.ts.)
   *
   *  Checked at the door AND again under the cell's lock: a duplicate queued
   *  behind the lock passed the door before the first delivery was refused. */
  function refuseIfRefusedBefore(
    opId: string,
    cell: string,
    socket: WebSocket,
  ): boolean {
    const reason = _refused.get(opId);
    if (reason === undefined) return false;
    sendTo(
      socket,
      enc("op-rejected", { opId, cell, reason }),
      `op-rejected (${opId}, refused before)`,
    );
    deps.log.debug(
      `[sync:server] op ${opId} (${cell}) arrived again — refused again: ${reason}`,
    );
    return true;
  }
  function refuseIfDrifted(
    opId: string,
    cell: string,
    hlc: HLC,
    socket: WebSocket,
  ): boolean {
    const ahead = hlc[0] - Date.now();
    if (ahead <= SYNC_DEFAULTS.maxDrift) return false;
    const reason =
      `clock drift: this change is stamped ${Math.round(ahead / 1000)}s ` +
      `ahead of the server (limit ${SYNC_DEFAULTS.maxDrift / 1000}s). It is ` +
      `refused because it would win every last-write-wins comparison until ` +
      `the clocks meet. Correct this device's system clock (turn on ` +
      `automatic time sync) and the change can be made again.`;
    rememberRefusal(opId, reason);
    sendTo(
      socket,
      enc("op-rejected", { opId, cell, reason }),
      `op-rejected (${opId}, clock drift)`,
    );
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

  // ── A session prefix belongs to the connection that announced it ──────
  // An op id is `<clientId>-<session>-<counter>.<random>`, and the prefix is
  // on every broadcast. Two filters read it as "this client's own op": the
  // client drops a broadcast under its own prefix as its echo, and the
  // catch-up leaves ops under the requester's prefix out. So a writer that
  // submitted an op under ANOTHER client's prefix had it applied on the
  // server and every other screen — and never on the victim's, silently,
  // until a compaction snapshot covered it (r5 sync hunt; pinned by
  // tests/sync/session-prefix-bound.test.ts).
  //
  // The prefix is public, so it cannot prove anything alone. Each engine
  // announces its session in its `sync-req` WITH a per-session key it never
  // sends anywhere else; the first announce binds the prefix to that key, and
  // a later announce with the same key moves it to the new connection — a
  // reconnect, even while the old socket still reads OPEN (half-open, until
  // the heartbeat notices). A different key never takes it over.
  //
  // An op taken from any OTHER connection under a bound prefix is remembered
  // as FOREIGN, and the owner's catch-up serves it instead of assuming it
  // already has it; the engine, for its part, drops as an echo only an id it
  // actually issued. Taken, not refused or held: the same shape is legitimate
  // — a twin tab flushing the shared queue, or the owner's own op frame
  // reaching its new connection ahead of the `sync-req` that moves the
  // session — and the op of a writer posing as another session is then
  // simply applied on every screen, the victim's included, which is exactly
  // what that writer could do under its own session anyway. (The owner's own
  // op served back to it is dropped by its id dedup, like any repeat.)
  //
  // In memory and bounded: a restart forgets every binding, and the engines
  // re-announce on their reconnect. An engine that sends no key (built
  // before it) binds nothing and is checked against nothing, as before.
  const SESSIONS_CAP = 8192;
  const _sessions = new Map<string, { key: string; socket: WebSocket }>();
  const FOREIGN_CAP = 4096;
  const _foreign = new Set<string>();
  function sessionPrefix(opId: string): string | undefined {
    return /^(.+-)[0-9a-z]+(?:\.[0-9a-z]+)?$/.exec(opId)?.[1];
  }
  function claimSession(prefix: string, key: string, socket: WebSocket): void {
    const held = _sessions.get(prefix);
    if (held === undefined || held.key === key) {
      _sessions.delete(prefix); // re-inserted: the newest is evicted last
      _sessions.set(prefix, { key, socket });
      if (_sessions.size > SESSIONS_CAP) {
        _sessions.delete(_sessions.keys().next().value!);
      }
      return;
    }
    if (held.socket === socket) return;
    deps.log.warn(
      `[sync:server] session "${prefix}" is announced by a second connection ` +
        `with a different key — it stays with the first, and this ` +
        `connection's ops under it are served to the first as a peer's. ` +
        `Either a client is posing as another's session, or its real owner ` +
        `lost the race after a restart (a reload gives it a new session).`,
    );
  }
  /** Is this op's session prefix bound to ANOTHER connection? */
  function sessionOwnedElsewhere(opId: string, socket: WebSocket): boolean {
    const prefix = sessionPrefix(opId);
    const held = prefix === undefined ? undefined : _sessions.get(prefix);
    return held !== undefined && held.socket !== socket;
  }
  function noteForeign(opId: string): void {
    _foreign.add(opId);
    if (_foreign.size > FOREIGN_CAP) {
      _foreign.delete(_foreign.values().next().value!);
    }
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

  /** Resolves with why the fold did not land (undefined: it did, or there
   *  was nothing to fold) — the verdict a stand-in save reports. */
  async function tryCompact(
    cell: string,
    force = false,
  ): Promise<string | undefined> {
    // A quarantined cell's live state is NOT the data (the replay could not
    // fold the log; the slice is the last snapshot, or the defaults). Writing
    // it into sync_snapshots and DELETING the ops it "contains" would be the
    // exact data loss the quarantine exists to prevent. Refused here — the ONE
    // path every snapshot write takes (op-count, server-write, shutdown flush).
    if (deps.isQuarantined?.(cell)) {
      // Once per cell: every write that reaches the cell (a listener's
      // reaction on each op of another) asks again, and the same line per
      // fold buried the one that explains it.
      if (!_compactQuarantineSaid.has(cell)) {
        _compactQuarantineSaid.add(cell);
        deps.log.warn(
          `[sync:server] compaction of "${cell}" skipped — the cell is ` +
            `quarantined since boot (its op-log could not be replayed into ` +
            `the current shape); fix the cell's version/onMigrate and ` +
            `restart (said once per cell)`,
        );
      }
      return `"${cell}" is quarantined — its snapshot is not written`;
    }
    // The fold watermark rides in the snapshot's own transaction
    // (`alsoWrite`, planned after the state capture). A fold that never reaches
    // it (below the op threshold, or it threw) records nothing and advances
    // nothing.
    const fw = _foldWatermark;
    let at: number | undefined;
    let planned = false;
    try {
      await compactSyncOps({
        db: deps.db,
        cell,
        getState: () => {
          const s = deps.getCellState(cell);
          // Same synchronous turn as the read: nothing can commit between.
          if (fw !== null) at = fw.capture(cell);
          return s;
        },
        serverHlc: clock.now(),
        cellVersion: deps.cellVersion?.(cell) ?? 0,
        retentionMs: sweepRetentionMs(),
        alsoWrite: fw === null ? undefined : () => {
          planned = true;
          return fw.plan(cell, at!);
        },
        log: deps.log,
        // force: fold current state into the snapshot regardless of op count —
        // the durability path for server-origin writes (see noteServerWrite).
        ...(force ? { compactOps: 0 } : {}),
      });
      if (fw !== null && planned) fw.folded(cell, at!);
    } catch (e) {
      deps.log.error(`[sync:server] compact failed for ${cell}: ${e}`);
      return `the fold of "${cell}" failed: ${
        e instanceof Error ? e.message : String(e)
      }`;
    }
    return undefined;
  }

  /** The retention a compaction's tombstone SWEEP must honour: the longest
   *  of ANY sync cell's, never the compacting cell's own.
   *
   *  `sync_compacted_ids` carries no cell, so the sweep in `compactSyncOps`
   *  deletes every cell's tombstones older than the window it is given. Fed
   *  the compacting cell's retention, a compaction of a default-retention
   *  cell (24h) swept the tombstones a `retention: "7d"` cell still needed:
   *  that cell's lost-ack resend two days later was younger than ITS window
   *  (so not refused as stale), unknown to the store (tombstone gone) — and
   *  applied a SECOND time, acked and broadcast. Keeping short-retention
   *  tombstones longer costs rows; sweeping long-retention ones early costs
   *  a double application. */
  function sweepRetentionMs(): number | undefined {
    let max: number | undefined;
    for (const c of syncCells) {
      const r = deps.opRetentionMs?.(c);
      if (typeof r === "number" && Number.isFinite(r) && (max ?? 0) < r) {
        max = r;
      }
    }
    return max;
  }

  let _foldWatermark: SyncFoldWatermark | null = null;
  /** See `ServerSyncHandler.setOpIssueHook`. */
  let _issueHook:
    | ((op: { id: string; cell: string; action: string }, ts: number) => void)
    | null = null;

  // ── Server-origin write durability ─────────────────────────────────
  // Same debounce scale as KV persistence (100ms), and a clean shutdown flushes
  // (aio-lifecycle calls flushServerWrites). A crash inside the window loses
  // every write in it — up to the max wait below, not "the last write": the
  // r3 chaos hunt lost 28 acked writes, the oldest 465 ms old. `journal: true`
  // closes it (see `SyncFoldWatermark`).
  //
  // With a MAX WAIT. A pure debounce restarts on every write, so a cell
  // written more often than every 100ms — a price feed, a cron at 50ms, a
  // progress counter — never settled at all: no compaction (a restart rewound
  // every one of those writes) and no push (measured: server at price 40,
  // every tab still at 0, for as long as the writes kept coming). The first
  // unsettled write starts a clock the later ones cannot reset.
  const SERVER_WRITE_DEBOUNCE_MS = 100;
  const SERVER_WRITE_MAX_WAIT_MS = 500;
  const _pendingWrites = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; since: number }
  >();
  /** Cells whose live state holds a server-origin write that is in no op and
   *  not yet in the snapshot — from `noteServerWrite` until its fold, which
   *  runs under the cell lock a catch-up also takes. The log cannot serve such
   *  a cell: a catch-up answered from it is ops only, and the write can have
   *  gone out already (a push another client's catch-up snapshot carried, see
   *  `pushCaptured`) while this client was away — so the fold finds nothing
   *  left to push, and the client stays without the write, connected and
   *  "synced", until some later push or reconnect repairs it. Found by the
   *  offline-replay property (tests/sync/properties/offline-replay.test.ts);
   *  pinned by tests/sync/server-write-catchup-window.test.ts. */
  const _unfolded = new Set<string>();
  /** Cells whose LAST fold failed: a failed fold is not retried until the
   *  cell is written again, so its snapshot lacks what that fold carried.
   *  A whole-handler flush (the shutdown's) reports them — a stop that left
   *  one behind is not clean. */
  const _foldFailed = new Map<string, string>();
  /** Folds in flight, per cell — what `flushServerWrites` also waits for. */
  const _settling = new Map<string, Set<Promise<string | undefined>>>();
  function track(
    cell: string,
    p: Promise<string | undefined>,
  ): Promise<string | undefined> {
    const set = _settling.get(cell) ?? new Set<Promise<string | undefined>>();
    _settling.set(cell, set);
    const done: Promise<string | undefined> = p.catch((e) => {
      deps.log.error(`[sync:server] fold of "${cell}" failed: ${e}`);
      return `the fold of "${cell}" failed: ${e}`;
    }).then((v) => {
      // Until a later fold of the cell lands, its snapshot lacks what this
      // one was folding (see `_foldFailed`).
      if (v === undefined) _foldFailed.delete(cell);
      else _foldFailed.set(cell, v);
      return v;
    }).finally(() => {
      set.delete(done);
      if (set.size === 0 && _settling.get(cell) === set) _settling.delete(cell);
    });
    set.add(done);
    return done;
  }

  function noteServerWrite(cell: string): void {
    if (!syncCells.has(cell)) return;
    // Synchronous with the commit (the afterAction hook): from here until a
    // push captures the cell's state, live clients do not have this write.
    _dirty.add(cell);
    // …and from here until the fold, the op-log cannot serve it (see
    // `_unfolded`).
    _unfolded.add(cell);
    const now = Date.now();
    const existing = _pendingWrites.get(cell);
    if (existing !== undefined) clearTimeout(existing.timer);
    const since = existing?.since ?? now;
    const delay = Math.max(
      0,
      Math.min(
        SERVER_WRITE_DEBOUNCE_MS,
        since + SERVER_WRITE_MAX_WAIT_MS - now,
      ),
    );
    _pendingWrites.set(cell, {
      since,
      timer: setTimeout(() => {
        _pendingWrites.delete(cell);
        track(cell, foldLocked(cell, () => settleServerWrite(cell)));
      }, delay),
    });
  }

  /** Make a server-origin write durable AND tell every live client about it.
   *  Caller holds the cell lock. */
  async function settleServerWrite(cell: string): Promise<string | undefined> {
    const failed = await tryCompact(cell, true);
    _unfolded.delete(cell);
    // Already pushed — a catch-up served meanwhile carried it out (see
    // `pushCaptured` in handleSync) — and nothing written since.
    if (!_dirty.has(cell)) return failed;
    // Under a PARKED holder of this very cell (see `_parked`): its op is
    // applied but not yet acked, so a push now would reach its origin as a
    // state holding the op BEFORE the op's ack — the client folds it and
    // rebases the still-pending op on top: applied twice until the ack.
    // Folded now, pushed once the holder has acked (`pushDeferred`).
    if (_parked.has(cell)) {
      _deferPush.add(cell);
      return failed;
    }
    await pushServerState(cell);
    return failed;
  }
  /** Cells whose push waits for their parked holder's ack. */
  const _deferPush = new Set<string>();
  /** Run at the end of an op's locked section — after its ack. */
  async function pushDeferred(cell: string): Promise<void> {
    if (!_deferPush.delete(cell)) return;
    if (_dirty.has(cell)) await pushServerState(cell);
  }

  // ── Server-origin writes reach LIVE clients ─────────────────────────
  // Durability alone was half the fix. A client's confirmed state is folded
  // from ops, and a server-origin write (an `am dispatch`, an effect, cron, a
  // serverFn, an ASYNC method — the browser sends those as plain actions)
  // produces no op. The plain `state` frame painted the change, and the very
  // next sync op rebased the view onto the engine's confirmed state, which had
  // never heard of it: the write vanished from every tab and STAYED gone while
  // the server kept it (measured: `am dispatch board:add from-cli`, then a
  // click in the tab → the tab showed only the tab's note). Only a reconnect's
  // catch-up snapshot ever brought it back.
  //
  // So the write is pushed as what it is: a state at a position. Taken under
  // the cell's lock, right after the reservation, it is exactly the shape a
  // catch-up snapshot has — every op already persisted is at or below the
  // position and inside the state, every later op is strictly above — so the
  // client folds it with the rules it already has for snapshots (the ack
  // watermark, the held-frame ordering). It rides a `sync-res` frame marked
  // `push`, the one frame kind every client transport already routes to the
  // engine; `reqId: 0` keeps a client built before `push` from treating it as
  // the answer to its outstanding catch-up.
  //
  // And it travels as a PATCH (see `pushCaptured`), because it first shipped
  // as the whole cell: five one-number writes to a 2000-note cell with ten
  // tabs open were 50 frames and 5.25 MB, where the plain state stream had
  // sent a few hundred bytes. The cost of a server write is now the size of
  // the write.
  async function pushServerState(cell: string): Promise<void> {
    // A quarantined cell's live state is not its data — never serve it (same
    // rule as the catch-up snapshot below).
    if (deps.isQuarantined?.(cell)) return;
    try {
      const serverTs = await reserveServerTs(deps.db);
      const state = deps.getClientCellState(cell);
      if (state === null) {
        deps.log.error(
          `[sync:server] a server-side write to "${cell}" cannot be pushed to ` +
            `clients — its ui config hides it, and sync clients then keep a ` +
            `state without it. Drop sync or drop the ui filter.`,
        );
        return;
      }
      pushCaptured(cell, serverTs, state);
    } catch (e) {
      deps.log.error(
        `[sync:server] could not push a server-side write to "${cell}" to ` +
          `live clients (${e}) — they catch up at their next reconnect.`,
      );
    }
  }

  // ── What a push costs ──────────────────────────────────────────────
  /** Same rule as the state broadcast (`fullStateThreshold` in
   *  server-broadcast.ts): a patch bigger than half the whole state goes as
   *  the whole state. */
  const PUSH_FULL_FRACTION = 0.5;
  /** Per cell, the client-visible state the last push carried — what the
   *  next patch is taken against. Committed state is frozen, so holding the
   *  reference costs nothing. */
  const _pushed = new Map<string, Record<string, unknown>>();
  /** Cells with a server write committed since the last push captured their
   *  state (see `noteServerWrite`). */
  const _dirty = new Set<string>();
  /** Sockets whose engine predates the patch push (`SyncRequest.pushPatch`
   *  absent). A patch frame means nothing to them — worse, it cannot carry the
   *  position they would read as a cursor — so each is sent the whole cell,
   *  as it always was. Pruned of closed sockets on every use; capped so a
   *  transport whose sockets never report closing cannot grow it forever. */
  const _legacySockets = new Set<WebSocket>();
  const LEGACY_SOCKETS_CAP = 1024;
  const _undiffableWarned = new Set<string>();
  let _legacyCapWarned = false;
  function pruneLegacySockets(): void {
    for (const s of _legacySockets) {
      if (
        s.readyState === WebSocket.CLOSING || s.readyState === WebSocket.CLOSED
      ) {
        _legacySockets.delete(s);
      }
    }
  }
  function noteSyncSocket(socket: WebSocket, patches: boolean): void {
    if (patches) {
      _legacySockets.delete(socket);
      return;
    }
    if (_legacySockets.has(socket)) return;
    pruneLegacySockets();
    _legacySockets.add(socket);
    if (_legacySockets.size > LEGACY_SOCKETS_CAP) {
      // Sets iterate in insertion order — the oldest goes.
      _legacySockets.delete(_legacySockets.values().next().value!);
      if (!_legacyCapWarned) {
        _legacyCapWarned = true;
        deps.log.warn(
          `[sync:server] more than ${LEGACY_SOCKETS_CAP} open sync clients run ` +
            `an engine older than this server — the oldest no longer receive ` +
            `server-side writes until they reconnect. Reload those clients.`,
        );
      }
    }
  }

  /** Push `state`, captured at `ts` under the cell's lock, to every live
   *  client. Synchronous: nothing may commit to the push base between the
   *  capture and the bookkeeping. */
  function pushCaptured(
    cell: string,
    ts: number,
    state: Record<string, unknown>,
  ): void {
    _dirty.delete(cell);
    const base = _pushed.get(cell);
    _pushed.set(cell, state);
    const whole = () =>
      enc("sync-res", {
        mode: "snapshot",
        push: true,
        reqId: 0,
        snapshot: { [cell]: state },
        ops: [],
        lowWater: {},
        lastServerTs: { [cell]: ts },
      });
    // The first push of a cell has nothing to be a patch against.
    let patchFrame: string | null = null;
    if (base !== undefined) {
      try {
        const sum = stateDigest(state);
        if (sum === null) {
          throw new TypeError("it holds a value JSON cannot carry");
        }
        const frame = enc("sync-res", {
          mode: "push",
          push: true,
          reqId: 0,
          ops: [],
          lowWater: {},
          patch: {
            [cell]: { ts, set: diffState(base, state), digest: sum.digest },
          },
        });
        if (frame.length <= sum.bytes * PUSH_FULL_FRACTION) patchFrame = frame;
      } catch (e) {
        // Not patchable: the whole cell, which is what the push always was —
        // and the reason, once per cell.
        if (!_undiffableWarned.has(cell)) {
          _undiffableWarned.add(cell);
          deps.log.warn(
            `[sync:server] server-side writes to "${cell}" are pushed as the ` +
              `whole cell — its state could not be diffed (${e}). Sync state ` +
              `must be plain JSON. (logged once per cell)`,
          );
        }
      }
    }
    if (patchFrame === null) {
      deps.broadcastRaw.fn(whole());
      return;
    }
    pruneLegacySockets();
    if (_legacySockets.size > 0) {
      const frame = whole();
      for (const s of _legacySockets) {
        sendTo(s, frame, `server-write push for "${cell}"`);
      }
    }
    deps.broadcastRaw.fn(patchFrame);
  }

  async function flushServerWrites(
    only?: readonly string[],
  ): Promise<string | undefined> {
    const wanted = (c: string) => only === undefined || only.includes(c);
    // A fold whose timer already fired is IN FLIGHT: a flush that returned
    // without it let a shutdown close the database under it (or a caller ack
    // a write that fold was still writing). Awaited with the rest.
    const inFlight = [..._settling].filter(([c]) => wanted(c)).flatMap((
      [, ps],
    ) => [...ps]);
    const cells = [..._pendingWrites.keys()].filter(wanted);
    for (const c of cells) {
      clearTimeout(_pendingWrites.get(c)!.timer);
      _pendingWrites.delete(c);
    }
    const verdicts = await Promise.all([
      ...inFlight,
      ...cells.map((cell) =>
        track(cell, foldLocked(cell, () => settleServerWrite(cell)))
      ),
    ]);
    return verdicts.find((v) => v !== undefined) ??
      (only === undefined ? [..._foldFailed.values()][0] : undefined);
  }

  // Clients already told their cursor is foreign (see `foreign` in
  // handleSync) — a client built before `reset` keeps re-sending the same
  // stale cursor every round, and the warning is one per client, not per round.
  const _foreignWarned = new WeakSet<object>();

  return {
    noteServerWrite,
    flushServerWrites,
    setOpIssueHook(fn) {
      _issueHook = fn;
    },
    setFoldWatermark(w) {
      _foldWatermark = w;
    },
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
      if (holdIfHeld(socket)) return;
      if (refuseIfRefusedBefore(op.id, op.cell, socket)) return;
      if (refuseIfDrifted(op.id, op.cell, op.hlc, socket)) return;
      // AUTH-1: enforce the cell's declarative `access` rule on the sync path
      // too. Without this, a client that passes /ws (any authed user in
      // per-user mode) could mutate an `access:"admin"` cell via an op frame,
      // bypassing the gate the `action` path enforces. Reject before persist.
      if (
        deps.accessCheck &&
        !deps.accessCheck(op.cell, meta.user, op.action, opArgs(op.payload))
      ) {
        deps.log.warn(
          `[sync:server] op for access-gated cell "${op.cell}" denied for ${
            (meta.user as { id?: string })?.id ?? "anonymous client"
          } — dropping`,
        );
        sendTo(
          socket,
          enc("op-rejected", {
            opId: op.id,
            cell: op.cell,
            reason: "access denied",
          }),
          `op-rejected (${op.id}, access denied)`,
        );
        return;
      }

      await withLock(op.cell, async () => {
        // Under the lock: the first delivery may have been refused while this
        // one waited for it (see `refuseIfRefusedBefore`).
        if (refuseIfRefusedBefore(op.id, op.cell, socket)) return;
        // Under the lock, before the persist — see `refuseIfStale`.
        if (await refuseIfStale(op.id, op.cell, op.hlc, socket)) return;
        // AGAIN, here: the door's check ran before this op queued on the
        // lock, and a pause (or a shutdown) that began meanwhile would meet it
        // at dispatch — a permanent op-rejected for an op that is only
        // early. The last moment before the persist is the one that counts.
        if (holdIfHeld(socket)) return;
        clock.receive(op.hlc);
        const serverHlc = clock.tick();

        // Persist → ack → broadcast (await persist before ack — AIO-audit3)
        let serverTs: number | null = null;
        try {
          serverTs = await persistOp(
            deps.db,
            op,
            deps.cellVersion?.(op.cell) ?? 0,
            (ts) => _issueHook?.(op, ts),
          );
        } catch (e) {
          deps.log.error(`[sync:server] failed to persist op ${op.id}: ${e}`);
          return; // Don't ack — client will retry
        }
        // Under another connection's session — see `_foreign`.
        if (serverTs !== null && sessionOwnedElsewhere(op.id, socket)) {
          noteForeign(op.id);
        }

        // Apply to live server state BEFORE ack/compact — the op-log and
        // the state must agree (compaction snapshots live state). Duplicate
        // delivery (client retry after a lost ack) must NOT re-dispatch:
        // persistOp is INSERT OR IGNORE, so `serverTs === null` means the
        // op's effect is already in live state — re-applying would double it.
        let rejectedReason: string | null = null;
        /** Refused because the server was not taking input — held. */
        let held = false;
        /** A stand-in save this op's commit owed did not land — said on
         *  the ack (`unsaved`), as every door says it. */
        let unsaved: string | undefined;
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
              // …and WHERE in the op-log it sits: the host tracks, at commit,
              // how far each cell's live state holds its log (the position a
              // journalled listener reaction is replayed at).
              _syncTs: serverTs,
              _syncId: op.id,
            };
            await deps.dispatch(action);
            unsaved = await waitDurable(op.cell, action);
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
            if (isHeldRefusal(e)) {
              // Not poison: the server was not TAKING input (see
              // `isHeldRefusal`). Out of the log, and held — never refused.
              held = true;
              await dropRow(op.id);
            } else {
              // Same poison treatment as a validate refusal: the server could
              // not apply it, so the log must not keep it and no one must be
              // told it succeeded.
              rejectedReason = `dispatch failed: ${
                e instanceof Error ? e.message : String(e)
              }`;
              deps.log.error(
                `[sync:server] dispatch of op ${op.id} failed: ${e}`,
              );
              await deps.db.execute("DELETE FROM sync_ops WHERE id = ?", [
                op.id,
              ])
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
        }

        if (held) {
          sendHeld(socket);
          if (_deferPush.has(op.cell)) await pushDeferred(op.cell);
          return;
        }
        if (rejectedReason !== null) {
          rememberRefusal(op.id, rejectedReason);
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
          if (_deferPush.has(op.cell)) await pushDeferred(op.cell);
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
        _heldSaid.delete(socket); // taking input again — see `_heldSaid`
        sendTo(
          socket,
          enc("sync-ack", {
            cell: op.cell,
            opId: op.id,
            serverHlc,
            ...(ackTs !== null ? { serverTs: ackTs } : {}),
            ...(unsaved !== undefined ? { unsaved } : {}),
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
        // A fold that ran under this op's parked lock pushes now, after the
        // ack and the broadcast (see `settleServerWrite`). Checked first:
        // nothing deferred, nothing awaited — the lock's timing is unchanged.
        if (_deferPush.has(op.cell)) await pushDeferred(op.cell);

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
        // ANSWER it. The `.catch` at the bottom of this method already states
        // the contract — "Notify client so it can back off and retry instead
        // of hanging in 'syncing'" — and only that exit honoured it. A
        // request refused AT THE DOOR sent nothing at all, and the client's
        // catch-up gate has no timeout and only three things that reopen it:
        // engine boot, going offline→online, and a `sync-err` frame. So on a
        // still-open connection the cell stopped receiving peer changes and
        // stopped confirming its own ops, permanently and silently: status
        // stuck at "syncing", the pending buffer growing toward `pendingCap`,
        // and past it the user's own mutations start throwing.
        sendTo(
          socket,
          enc("sync-err", {
            reason:
              "invalid sync request envelope — `clientId` must be a non-empty " +
              "string, `cells` an object and `pendingOps` an array",
          }),
          "sync-err",
        );
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
        // Same rule as the envelope refusal above: a refused request must be
        // ANSWERED, or the client waits for a frame that is never coming.
        sendTo(
          socket,
          enc("sync-err", {
            reason: `invalid cursor for cell "${badCell[0]}" — a cell entry ` +
              `must be { lastHlc: [number, number, string] | null, ` +
              `lastServerTs?: number }`,
          }),
          "sync-err",
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
        /** The session's private key (see SyncRequest.sessionKey). */
        sessionKey?: unknown;
        cells: Record<string, { lastHlc: HLC | null; lastServerTs?: number }>;
        pendingOps: SyncOp[];
        /** Cells the client asks to be served as a SNAPSHOT whatever its
         *  cursor says (see SyncRequest.resync). */
        resync?: unknown;
        /** The engine folds patch pushes (see SyncRequest.pushPatch). */
        pushPatch?: unknown;
      };
      noteSyncSocket(socket, sync.pushPatch === true);
      // Synchronously, before any op of this connection is looked at — see
      // `claimSession`.
      if (
        typeof sync.session === "string" && sync.session !== "" &&
        typeof sync.sessionKey === "string" && sync.sessionKey !== ""
      ) {
        claimSession(
          `${sync.clientId}-${sync.session}-`,
          sync.sessionKey,
          socket,
        );
      }
      _heldSaid.delete(socket); // it asked again — see `_heldSaid`
      // Held ops come back in this request's `pendingOps` — held again, the
      // whole request with them (the client retries it as one).
      if ((sync.pendingOps?.length ?? 0) > 0 && holdIfHeld(socket)) return;
      const resyncCells = new Set(
        Array.isArray(sync.resync)
          ? sync.resync.filter((c): c is string => typeof c === "string")
          : [],
      );
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
          // …except one another connection submitted under it while its
          // owner was away (see `_foreign`): the owner never had it.
          //
          // The WHOLE prefix, never `startsWith`: a client id may itself
          // contain `-` (it is a UUID), so a writer announcing clientId
          // `<victim>-<victimSession>` owns ops whose ids START with the
          // victim's prefix — and a prefix test served its ops to nobody but
          // the server and the other peers, hiding them from the victim's
          // catch-up for good.
          ? sessionPrefix(o.id) === ownPrefix && !_foreign.has(o.id)
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
        /** A pending op was held (see holdIfHeld): `sync-err` is sent, the
         *  rest of the request — its later ops, its response — waits for the
         *  client's resend. */
        let heldMid = false;
        // Persist pending ops under per-cell lock (prevents compact race)
        for (const pending of sync.pendingOps ?? []) {
          if (heldMid) return;
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
          if (refuseIfRefusedBefore(pending.id, pending.cell, socket)) continue;
          if (
            refuseIfDrifted(pending.id, pending.cell, pending.hlc, socket)
          ) continue;
          // Same access gate as handleOp — pending ops are client-submitted.
          if (
            deps.accessCheck &&
            !deps.accessCheck(
              pending.cell,
              meta.user,
              pending.action,
              opArgs(pending.payload),
            )
          ) {
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
            if (refuseIfRefusedBefore(pending.id, pending.cell, socket)) return;
            if (
              await refuseIfStale(pending.id, pending.cell, pending.hlc, socket)
            ) return;
            // Same last-moment check as handleOp: held, the whole request
            // with it (the client resends it as one).
            if (holdIfHeld(socket)) {
              heldMid = true;
              return;
            }
            // Another connection's session — see `_foreign`. Holding it
            // instead stalled a twin tab's whole flush behind an owner that
            // may never resend.
            const foreign = sessionOwnedElsewhere(pending.id, socket);
            clock.receive(pending.hlc);
            const serverHlc = clock.tick();
            let serverTs: number | null = null;
            try {
              serverTs = await persistOp(
                deps.db,
                pending,
                deps.cellVersion?.(pending.cell) ?? 0,
                (ts) => _issueHook?.(pending, ts),
              );
            } catch (e) {
              deps.log.error(
                `[sync:server] failed to persist pending op ${pending.id}: ${e}`,
              );
              return; // Don't ack — client keeps it pending and retries
            }
            if (foreign && serverTs !== null) noteForeign(pending.id);
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
            let pendingUnsaved: string | undefined; // see handleOp's `unsaved`
            if (serverTs !== null) {
              try {
                const action = { // held for the rejection key — see handleOp
                  type: `${pending.cell}:${pending.action}`,
                  payload: pending.payload,
                  _user: meta.user,
                  _syncOp: true,
                  _syncTs: serverTs, // see handleOp
                  _syncId: pending.id,
                };
                await deps.dispatch(action); // awaited — see handleOp
                pendingUnsaved = await waitDurable(pending.cell, action);
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
                if (isHeldRefusal(e)) { // see handleOp
                  heldMid = true;
                  await dropRow(pending.id);
                  sendHeld(socket);
                  if (_deferPush.has(pending.cell)) {
                    await pushDeferred(pending.cell);
                  }
                  return;
                }
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
                // Same fold as handleOp. This door never ran it, so a client
                // that writes mostly offline — every op arriving here — grew
                // its cell's op-log past `compactOps` for good
                // (tests/sync/pending-ops-compact.test.ts).
                await tryCompact(pending.cell);
              }
            }
            if (rejectedReason !== null) {
              rememberRefusal(pending.id, rejectedReason);
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
              if (_deferPush.has(pending.cell)) {
                await pushDeferred(pending.cell);
              }
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
                ...(pendingUnsaved !== undefined
                  ? { unsaved: pendingUnsaved }
                  : {}),
              }),
              `sync-ack for pending op ${pending.id}`,
            );
            if (_deferPush.has(pending.cell)) {
              await pushDeferred(pending.cell);
            }
          });
        }

        if (heldMid) return;
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

            // The first base a push can be a patch against. With no server
            // write unpushed, every live client holds this state plus the ops
            // after this position — the same thing a push base is — whether
            // this client is served a snapshot or the log. Without it the
            // first server write of a process went out as the whole cell.
            if (!_pushed.has(cell) && !_dirty.has(cell)) {
              const seen = deps.getClientCellState(cell);
              if (seen !== null) _pushed.set(cell, seen);
            }

            // Client's lastHlc older than low_water → compacted, send snapshot
            // The client KNOWS its confirmed state for this cell cannot be
            // trusted — it re-ran a method that does not give the same answer
            // twice (see the engine's `reduceChecked`) — and no cursor rule can
            // see that: its cursor is perfectly current, its state is not.
            const resync = resyncCells.has(cell);
            if (
              cursorBelowCompaction || snapshotUnnamed || foreign || resync ||
              _unfolded.has(cell) ||
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
              // A server write this state holds that the live clients have
              // not been pushed yet goes out NOW, at this same position and
              // state. Otherwise the next patch — taken against the last
              // push — would describe the write to a client whose snapshot
              // already has it, and a write that was then set back would be
              // missing from that patch while this client kept it: a re-sync
              // for this client, every time a catch-up lands in a write
              // burst. Pushed at one position with one state, the snapshot
              // and the push are the same fact (the held push is skipped as
              // covered by the snapshot).
              //
              // …but only a FOLDED state is one fact per position. A server
              // write takes no lock: it can land during this section's awaits,
              // after the position was reserved, and it changes the state
              // without moving the position. Two captures at one position then
              // carry two states, and a client that got the older as its
              // catch-up snapshot drops the newer, pushed at the same position,
              // as "covered" — the write missing from its screen for good
              // (found by the offline-replay property under scheduling
              // jitter). Unfolded, the snapshot goes to its requester alone;
              // the fold pushes the write to everyone at its own, higher,
              // position.
              if (_dirty.has(cell) && !_unfolded.has(cell)) {
                pushCaptured(cell, serverTsMap[cell], clientState);
              }
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
