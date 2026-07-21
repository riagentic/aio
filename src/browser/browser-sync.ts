/**
 * @module
 * Browser wiring for the client-side CRDT sync engine — the missing half of
 * `sync: true`. Boots automatically from `ensureConnected()` when any
 * registered cell has a sync config:
 *
 * - local method calls on sync cells become HLC-stamped ops (offline-queued
 *   in localStorage, replayed on reconnect) instead of plain actions,
 * - `__ack` / `__op` / `__sync` wire messages feed the engine,
 * - the engine's optimistic view drives the cell signals the UI reads.
 *
 * The server stays the convergence authority: it applies every accepted op
 * through its normal dispatch, so regular state broadcasts and the op
 * stream agree.
 */
import { randomUuid } from "../rand.ts";
import { createSyncEngine, type SyncEngine } from "../sync/sync-engine.ts";
import { createOpBuffer } from "../sync/op-buffer.ts";
import { createLocalStorageOpStorage } from "../sync/browser-storage.ts";
import type { SyncConfig } from "../sync/types.ts";
import { getRegisteredCells } from "../state/cell-reactive.ts";
import { getCellSignal } from "../state/state-signals.ts";
import type { CellDef, Msg } from "../state/cell-types.ts";
import { produce } from "immer";

let _engine: SyncEngine | null = null;
let _syncCells: Map<string, CellDef> | null = null;

/** Cells (by id) that route through the sync engine. Empty until init. */
export function syncCellNames(): Set<string> {
  return new Set(_syncCells?.keys() ?? []);
}

/** The live engine (null before init / when no sync cells exist). */
export function getBrowserSyncEngine(): SyncEngine | null {
  return _engine;
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
  } catch {
    return randomUuid().slice(0, 8);
  }
}

/** Route a local action (already `{type: "cell:method", payload}`) through
 *  the engine. Returns true when handled (caller must not plain-send). */
export function handleSyncLocalAction(
  action: { type: string; payload?: unknown },
): boolean {
  if (!_engine || !_syncCells) return false;
  const idx = action.type.indexOf(":");
  if (idx <= 0) return false;
  const cell = action.type.slice(0, idx);
  if (!_syncCells.has(cell)) return false;
  const method = action.type.slice(idx + 1);
  if (method.startsWith("__")) return false; // framework-internal — plain path
  _engine.handleLocalAction(cell, method, action.payload).catch((e) =>
    console.warn(`[aio:sync] local op failed: ${e}`)
  );
  return true;
}

/** Wire-message router — plugged into the transport's sync handler seam. */
export function handleSyncMessage(msg: Record<string, unknown>): void {
  if (!_engine) return;
  if (msg.__ack) {
    const a = msg.__ack as { cell: string; opId: string; serverHlc: unknown };
    _engine.handleAck(a.cell, a.opId, a.serverHlc as [number, number, string])
      .catch(() => {});
    return;
  }
  if (msg.__op_rejected) {
    const r = msg.__op_rejected as {
      opId: string;
      cell: string;
      reason: string;
    };
    _engine.handleRejection(r.cell, r.opId, r.reason).catch(() => {});
    return;
  }
  if (msg.__op) {
    _engine.handleRemoteOp(
      msg.__op as Parameters<SyncEngine["handleRemoteOp"]>[0],
    )
      .catch(() => {});
    return;
  }
  if (msg.__sync) {
    _engine.handleSyncResponse(
      msg.__sync as Parameters<SyncEngine["handleSyncResponse"]>[0],
    ).catch(() => {});
    return;
  }
  if (msg.__sync_error) {
    // Server-side sync failure — without this branch the client hangs in
    // "syncing" forever. Log loudly, back off, re-request.
    const reason = (msg.__sync_error as { reason?: string }).reason ?? "?";
    console.error(`[aio:sync] server sync failed: ${reason} — retrying in 2s`);
    const engine = _engine;
    setTimeout(() => engine?.requestSync().catch(() => {}), 2000);
  }
}

/** Boot the engine for every registered sync cell. Idempotent. */
export function initBrowserSync(
  send: (raw: string) => void,
): SyncEngine | null {
  if (_engine) return _engine;
  const cells = new Map<string, CellDef>();
  for (const def of getRegisteredCells().values()) {
    if (def.__aio.syncConfig) cells.set(def.__aio.id, def);
  }
  if (cells.size === 0) return null;
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
  ): Record<string, unknown> | null => {
    const def = cell ? cells.get(cell) : undefined;
    if (!def) return null;
    try {
      return produce(state, (draft) => {
        def.__aio.reduce(
          draft,
          { type: `${def.__aio.id}:${action}`, payload } as Msg,
        );
      }) as Record<string, unknown>;
    } catch (e) {
      console.warn(`[aio:sync] reducer failed for ${cell}:${action}: ${e}`);
      return null;
    }
  };

  _engine = createSyncEngine({
    clientId: clientId(),
    cells: cfgs,
    buffer: createOpBuffer(createLocalStorageOpStorage()),
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
    log: { warn: (m) => console.warn(m) },
  });

  // Replay anything queued offline from a previous session.
  _engine.requestSync().catch(() => {});
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
}
