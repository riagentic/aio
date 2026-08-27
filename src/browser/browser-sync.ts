/**
 * @module
 * Browser wiring for the client-side CRDT sync engine — the missing half of
 * `sync: true`. Boots automatically from `ensureConnected()` when any
 * registered cell has a sync config:
 *
 * - local method calls on sync cells become HLC-stamped ops (offline-queued
 *   in localStorage, replayed on reconnect) instead of plain actions,
 * - sync-ack / op / sync-res / op-rejected / sync-err frames feed the engine,
 * - the engine's optimistic view drives the cell signals the UI reads.
 *
 * The server stays the convergence authority: it applies every accepted op
 * through its normal dispatch, so regular state broadcasts and the op
 * stream agree.
 */
import { randomUuid } from "../rand.ts";
import { createSyncEngine, type SyncEngine } from "../sync/sync-engine.ts";
import { createOpBuffer, parseRetention } from "../sync/op-buffer.ts";
import { REDUCER_FAILED, type SyncReducerResult } from "../sync/rebase.ts";
import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
import { createLocalStorageOpStorage } from "../sync/browser-storage.ts";
import type { SyncConfig } from "../sync/types.ts";
import { resolveSyncCells } from "./sync-cells.ts";
import { getRegisteredCells } from "../state/cell-reactive.ts";
import { getCellSignal } from "../state/state-signals.ts";
import type { CellDef, Msg } from "../state/cell-types.ts";
import { produce } from "immer";
import { degraded } from "../diagnostics/degraded.ts";
import { _armAckTimer, _rejectAck, _resolveAck } from "./browser-ack.ts";

/** How long to wait before re-requesting a catch-up the server just failed.
 *  Short on purpose: a `sync-err` leaves this client stale until it asks
 *  again, and the server has already done the expensive part (it failed). */
const SYNC_ERR_RETRY_MS = 2_000;

let _engine: SyncEngine | null = null;
let _syncCells: Map<string, CellDef> | null = null;

/** Every sync frame the engine handles is fire-and-forget, and each one used to
 *  end in `.catch(() => {})`. Individually defensible — a dropped ack is
 *  retried, a bad remote op is the server's problem — but together they meant
 *  the CRDT layer could fail continuously while the app showed a clean console
 *  and stale data. Now a failure is always logged, and a REPEATING failure
 *  escalates once through the degraded tracker, which health output can see. */
function watch(op: string, p: Promise<unknown>): void {
  const d = degraded(op);
  p.then(() => d.ok(), (e) => {
    console.warn(`[aio:sync] ${op} failed: ${e}`);
    d.fail(e);
  });
}

/** Cells (by id) that route through the sync engine. Empty until init. */
export function syncCellNames(): Set<string> {
  return new Set(_syncCells?.keys() ?? []);
}

/** The live engine (null before init / when no sync cells exist). */
export function getBrowserSyncEngine(): SyncEngine | null {
  return _engine;
}

/** `localStorage` is unusable here — reported once, at the moment the sync
 *  engine boots without it.
 *
 *  Every localStorage access in the sync path catches and degrades: the op
 *  buffer reads as empty, writes go nowhere, and `clientId` falls back to a
 *  fresh uuid. Individually each is the right local decision; together they
 *  turn `sync: true` into something it does not claim to be, SILENTLY — the
 *  offline queue stops surviving a reload (unsent changes are simply gone),
 *  and this client gets a NEW HLC identity on every load, so the server sees a
 *  stranger each time. A private window, a browser set to block site data, or
 *  a page in a partitioned third-party context all land here, and none of them
 *  is exotic. Whatever the app can do about it, it is owed the fact. */
let _storageWarned = false;
function reportNoStorage(e: unknown): void {
  if (_storageWarned) return;
  _storageWarned = true;
  const why = e instanceof Error ? e.message : String(e);
  console.error(
    `[aio:sync] this browser has no usable localStorage (${why}) — sync is ` +
      `running WITHOUT durable offline state. Two consequences: unsent ` +
      `changes do not survive a reload (the offline queue is gone with the ` +
      `page), and this client gets a new sync identity on every load. Common ` +
      `causes: a private window, site data blocked, or a partitioned ` +
      `third-party context.`,
  );
  diagEmit({
    type: "sync-no-storage",
    severity: "error",
    source: "sync",
    message:
      "Sync booted without usable localStorage — no durable offline state",
    detail: { reason: why },
    hint:
      "Unsent changes are lost on reload and the client's HLC identity is " +
      "ephemeral. Site data must be available for offline durability.",
  });
}

/** Stable per-browser client id (persisted — HLC identity must survive reloads). */
function clientId(): string {
  const KEY = "__aio_sync:clientId";
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = randomUuid().slice(0, 8);
    localStorage.setItem(KEY, id);
    return id;
  } catch (e) {
    reportNoStorage(e);
    return randomUuid().slice(0, 8);
  }
}

/** Route a local action (already `{type: "cell:method", payload}`) through
 *  the engine. Returns true when handled (caller must not plain-send).
 *
 *  THE ROUTE THAT CLAIMS A CALL ALSO SETTLES IT. An action reaching here was
 *  registered as a pending ack by the cell binding (`cell-reactive.ts` tags it
 *  with a `cid` and returns the caller a promise), and the op that leaves here
 *  carries NO cid — the server acks the op, not the call, so no ack frame can
 *  ever settle that promise. The send wrapper meanwhile inherits
 *  `ARMS_ACK_TIMER` from the plain transport, so no clock was armed either:
 *  `await todos.add("milk")` hung forever at every ceiling and left one
 *  permanent entry in the pending map per call. (Measured; the field reports of
 *  "sync cells just don't work" are this.)
 *
 *  A sync cell is LOCAL-FIRST, so the honest settle point is "the op is
 *  applied optimistically and durably queued" — exactly when
 *  `handleLocalAction` resolves — not "the server confirmed", which may be
 *  hours away on a queued offline op. The clock is armed too, so an engine that
 *  never resolves fails loudly instead of hanging. */
export function handleSyncLocalAction(
  action: { type: string; payload?: unknown; cid?: string },
): boolean {
  if (!_engine || !_syncCells) return false;
  const idx = action.type.indexOf(":");
  if (idx <= 0) return false;
  const cell = action.type.slice(0, idx);
  if (!_syncCells.has(cell)) return false;
  const method = action.type.slice(idx + 1);
  if (method.startsWith("__")) return false; // framework-internal — plain path
  const cid = typeof action.cid === "string" ? action.cid : undefined;
  if (cid) _armAckTimer(cid);
  _engine.handleLocalAction(cell, method, action.payload).then(
    () => {
      if (cid) _resolveAck(cid);
    },
    (e) => {
      console.warn(`[aio:sync] local op failed: ${e}`);
      if (cid) {
        _rejectAck(
          cid,
          e instanceof Error ? e : new Error(`local op failed: ${String(e)}`),
        );
      }
    },
  );
  return true;
}

/** Wire-frame router — plugged into the transport's sync handler seam.
 *  `t` is the envelope kind, `d` its already-decoded payload. */
export function handleSyncMessage(t: string, d: unknown): void {
  if (!_engine) return;
  switch (t) {
    case "sync-ack": {
      // `serverTs` MUST be forwarded. It is the op's position on the server's
      // cursor, and `handleAck` uses it to tell "this ack is for an op the
      // catch-up snapshot already contains" from "this is new" — the whole
      // snapshot guard. Dropping it here left that guard inert on the ONLY
      // surface it exists for, while every engine-level test stayed green
      // because they call `handleAck` directly and pass it.
      const a = d as {
        cell: string;
        opId: string;
        serverHlc: unknown;
        serverTs?: number;
      };
      watch(
        "sync:ack",
        _engine.handleAck(
          a.cell,
          a.opId,
          a.serverHlc as [number, number, string],
          a.serverTs,
        ),
      );
      return;
    }
    case "op-rejected": {
      const r = d as { opId: string; cell: string; reason: string };
      watch(
        "sync:rejection",
        _engine.handleRejection(r.cell, r.opId, r.reason),
      );
      return;
    }
    case "op":
      watch(
        "sync:remote-op",
        _engine.handleRemoteOp(
          d as Parameters<SyncEngine["handleRemoteOp"]>[0],
        ),
      );
      return;
    case "sync-res":
      watch(
        "sync:response",
        _engine.handleSyncResponse(
          d as Parameters<SyncEngine["handleSyncResponse"]>[0],
        ),
      );
      return;
    case "sync-err": {
      // Server-side sync failure — without this branch the client hangs in
      // "syncing" forever. Log loudly, back off, re-request.
      const reason = (d as { reason?: string } | undefined)?.reason ?? "?";
      console.error(
        `[aio:sync] server sync failed: ${reason} — retrying in 2s`,
      );
      const engine = _engine;
      setTimeout(() => {
        if (engine) watch("sync:request", engine.requestSync());
      }, SYNC_ERR_RETRY_MS);
      return;
    }
  }
}

/** The eviction TTL for one cell, from ITS OWN `sync: { offline: { retention } }`.
 *
 *  This wiring is the whole fix: the option was normalized, typed and
 *  documented, and then read by NOBODY — every cell evicted at the shared 4h
 *  default no matter what it asked for. `undefined` means "no opinion, use the
 *  buffer's default"; an unreadable value throws (see parseRetention) rather
 *  than silently becoming 4h.
 *  @internal */
export function _retentionMsOf(
  cells: Map<string, CellDef>,
  cell: string,
): number | undefined {
  const r = cells.get(cell)?.__aio.syncConfig?.offline?.retention;
  return r === undefined ? undefined : parseRetention(r);
}

/** Boot the engine for every registered sync cell. Idempotent. */
export function initBrowserSync(
  send: (raw: string) => void,
): SyncEngine | null {
  if (_engine) return _engine;
  // One resolver, shared with the transport's load gate (sync-cells.ts).
  const cells = resolveSyncCells(
    getRegisteredCells().values(),
    (id) =>
      console.warn(
        `[aio:sync] localFirst adopted '${id}' but this cell cannot replay ops ` +
          `locally — it keeps round-tripping through the server. (Only ` +
          `methods-style cells can run local-first.)`,
      ),
  );
  if (cells.size === 0) return null;
  // The per-browser identity lives at `__aio_sync:clientId` — inside the
  // storage's per-cell document namespace. A sync cell with that name would
  // silently corrupt the identity (its queue document overwrites the id, and
  // the id read hands the engine a JSON blob as its HLC node id). Misconfig →
  // throw at the site, dev and prod alike.
  if (cells.has("clientId")) {
    throw new Error(
      `[aio:sync] a sync cell cannot be named "clientId" — its offline-queue ` +
        `document would collide with the sync identity key in localStorage. ` +
        `Rename the cell.`,
    );
  }
  _syncCells = cells;

  const cfgs: Record<string, SyncConfig> = {};
  for (const [id, def] of cells) cfgs[id] = def.__aio.syncConfig!;

  // Confirmed state lives engine-side, seeded from each cell's initial state.
  const confirmed: Record<string, Record<string, unknown>> = {};
  for (const [id, def] of cells) {
    confirmed[id] = { ...(def.__aio.state as Record<string, unknown>) };
  }

  // One reducer for all sync cells: replay the op through the cell's own
  // reducer (the same code the server dispatch runs) on an Immer draft.
  const reducer = (
    state: Record<string, unknown>,
    action: string,
    payload: unknown,
    cell?: string,
  ): SyncReducerResult => {
    const def = cell ? cells.get(cell) : undefined;
    // Not a cell we can replay: nothing to apply, and nothing was lost —
    // that IS the no-op case.
    if (!def) return null;
    try {
      return produce(state, (draft) => {
        def.__aio.reduce(
          draft,
          { type: `${def.__aio.id}:${action}`, payload } as Msg,
        );
      }) as Record<string, unknown>;
    } catch (e) {
      // REDUCER_FAILED, never `null`. `null` is the engine's "applied, changed
      // nothing" — returning it here reported success for a method that threw,
      // so the engine marked the op applied and advanced the cursor past it:
      // the server had the change, this client never would, and no
      // re-delivery could reach it again. The two facts get two values.
      console.warn(`[aio:sync] reducer failed for ${cell}:${action}: ${e}`);
      return REDUCER_FAILED;
    }
  };

  _engine = createSyncEngine({
    clientId: clientId(),
    cells: cfgs,
    // A dropped op is a LOCAL MUTATION THAT NEVER REACHED THE SERVER — the
    // one thing this buffer exists to prevent. `onDrop` existed but nothing
    // ever passed it, so every drop (capacity, or a stale unconfirmed op
    // evicted under backpressure) was invisible to the app AND to the console
    //. Report it: loudly, once per op, with the cell and action.
    buffer: createOpBuffer(createLocalStorageOpStorage(), {
      // A cell's `sync: { offline: { retention } }` reaches the eviction rule
      // HERE — it was normalized, typed and documented, and then read by
      // nobody, so every cell evicted at the 4h default no matter what it
      // asked for. Parsed per cell (the config is per cell), and a value the
      // parser cannot read throws rather than silently becoming 4h.
      staleAfterFor: (cell) => _retentionMsOf(cells, cell),
      onDrop: (op, reason) => {
        const what = `${op.cell}:${op.action}`;
        console.error(
          `[aio:sync] DROPPED an unsynced change (${reason}): ${what} — this ` +
            `mutation never reached the server and is now gone. The offline ` +
            `queue is full (or this op sat unconfirmed past its retention).`,
        );
        diagEmit({
          type: "sync-op-dropped",
          severity: "error",
          source: "sync",
          message: `Unsynced change dropped (${reason}): ${what}`,
          detail: { cell: op.cell, action: op.action, opId: op.id, reason },
          hint:
            "The client could not reach the server long enough to flush its " +
            "queue. Check connectivity/backpressure, or raise pendingCap.",
        });
      },
    }),
    send,
    reducer,
    getConfirmedState: () => confirmed,
    setConfirmedState: (cell, state) => {
      confirmed[cell] = state;
    },
    onStateUpdate: (cell, optimistic) => {
      // The optimistic view IS what the UI shows — push it into the cell
      // signal that reactive reads (counter.count) subscribe to.
      const def = cells.get(cell);
      if (def) getCellSignal(cell, def.__aio.state).set(optimistic);
    },
    log: { warn: (m) => console.warn(m), debug: (m) => console.debug(m) },
  });

  // Replay anything queued offline from a previous session.
  watch("sync:request", _engine.requestSync());
  return _engine;
}

/** Transport lifecycle: flush queued ops on reconnect, mark offline on drop. */
export function setSyncOnline(online: boolean): void {
  _engine?.setOnline(online);
}

/** Test hook — drop the engine so a fresh init can run. */
export function _resetBrowserSync(): void {
  _engine = null;
  _syncCells = null;
  _storageWarned = false;
}
