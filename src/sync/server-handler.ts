// src/sync/server-handler.ts — Server-side CRDT sync relay
// Receives ops from clients, persists to op-log, broadcasts to other clients, sends acks.

import type { DB } from "../db/types.ts";
import type { HLC, SyncOp } from "./types.ts";
import { createHLC, type HLClock } from "./hlc.ts";
import { compactSyncOps } from "./compact.ts";
import {
  getLowWater,
  loadOpsSince,
  persistOp,
  reserveServerTs,
} from "./server-store.ts";

/**
 * Dependencies injected into the server-side sync handler.
 * @experimental Excluded from the 1.0 stability guarantee.
 */
export interface SyncHandlerDeps {
  /** Apply an accepted op to the live app state (normal dispatch path) —
   *  without this the op-log and the server's own state diverge, and
   *  compaction snapshots (built from live state) would drop client ops. */
  dispatch: (action: { type: string; payload?: unknown }) => void;
  db: DB;
  syncCellIds: string[];
  getCellState: (cell: string) => Record<string, unknown>;
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
 * @experimental Excluded from the 1.0 stability guarantee.
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
}

const FORBIDDEN = ["__proto__", "constructor", "prototype"];

/**
 * Validate a sync op has required fields and no proto-pollution vectors.
 * @experimental Excluded from the 1.0 stability guarantee.
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
    Array.isArray(o.hlc) && o.hlc.length === 3 &&
    typeof o.hlc[0] === "number" && typeof o.hlc[1] === "number" &&
    typeof o.hlc[2] === "string"
  );
}

/**
 * Create a server-side sync handler that relays CRDT ops between clients.
 * @experimental Excluded from the 1.0 stability guarantee.
 */
export function createServerSyncHandler(
  deps: SyncHandlerDeps,
): ServerSyncHandler {
  const clock: HLClock = createHLC("server");
  const syncCells = new Set(deps.syncCellIds);

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

  async function tryCompact(cell: string): Promise<void> {
    try {
      await compactSyncOps({
        db: deps.db,
        cell,
        getState: () => deps.getCellState(cell),
        serverHlc: clock.now(),
        log: deps.log,
      });
    } catch (e) {
      deps.log.error(`[sync:server] compact failed for ${cell}: ${e}`);
    }
  }

  return {
    async handleOp(raw, meta, socket) {
      if (!isValidSyncOp(raw)) {
        deps.log.warn(`[sync:server] invalid op from ${meta.id} — dropping`);
        return;
      }
      const op = raw;
      if (!syncCells.has(op.cell)) {
        deps.log.warn(
          `[sync:server] op for unknown cell "${op.cell}" — dropping`,
        );
        return;
      }

      await withLock(op.cell, async () => {
        clock.receive(op.hlc);
        const serverHlc = clock.tick();

        // Persist → ack → broadcast (await persist before ack — AIO-audit3)
        let serverTs: number | null = null;
        try {
          serverTs = await persistOp(deps.db, op);
        } catch (e) {
          deps.log.error(`[sync:server] failed to persist op ${op.id}: ${e}`);
          return; // Don't ack — client will retry
        }

        // Apply to live server state BEFORE ack/compact — the op-log and
        // the state must agree (compaction snapshots live state). Duplicate
        // delivery (client retry after a lost ack) must NOT re-dispatch:
        // persistOp is INSERT OR IGNORE, so `serverTs === null` means the
        // op's effect is already in live state — re-applying would double it.
        if (serverTs !== null) {
          try {
            deps.dispatch({
              type: `${op.cell}:${op.action}`,
              payload: op.payload,
            });
          } catch (e) {
            deps.log.error(
              `[sync:server] dispatch of op ${op.id} failed: ${e}`,
            );
          }
        }

        // Always ack — for a duplicate this is the retransmit of the ack the
        // client lost, and it's what lets the client stop resending the op.
        try {
          socket.send(JSON.stringify({
            __ack: { cell: op.cell, opId: op.id, serverHlc },
          }));
        } catch { /* client disconnected */ }

        if (serverTs !== null) {
          // Broadcast carries serverTs so peers advance their sync cursor as
          // they apply it — otherwise the next catch-up re-delivers this op
          // (it sits above their cursor) and they double-apply it.
          deps.broadcastRaw.fn(
            JSON.stringify({
              __op: {
                id: op.id,
                hlc: op.hlc,
                cell: op.cell,
                action: op.action,
                payload: op.payload,
                serverTs,
              },
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

    handleSync(raw, _meta, socket) {
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
      const sync = r as {
        clientId: string;
        cells: Record<string, { lastHlc: HLC | null; lastServerTs?: number }>;
        pendingOps: SyncOp[];
      };

      (async () => {
        // Persist pending ops under per-cell lock (prevents compact race)
        for (const pending of sync.pendingOps ?? []) {
          if (!isValidSyncOp(pending)) {
            deps.log.warn(
              "[sync:server] handleSync: invalid pending op — skipping",
            );
            continue;
          }
          if (!syncCells.has(pending.cell)) continue;
          await withLock(pending.cell, async () => {
            clock.receive(pending.hlc);
            const serverHlc = clock.tick();
            let serverTs: number | null = null;
            try {
              serverTs = await persistOp(deps.db, pending);
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
            if (serverTs !== null) {
              try {
                deps.dispatch({
                  type: `${pending.cell}:${pending.action}`,
                  payload: pending.payload,
                });
              } catch (e) {
                deps.log.error(
                  `[sync:server] dispatch of pending op ${pending.id} failed: ${e}`,
                );
              }
              deps.broadcastRaw.fn(
                JSON.stringify({
                  __op: {
                    id: pending.id,
                    hlc: pending.hlc,
                    cell: pending.cell,
                    action: pending.action,
                    payload: pending.payload,
                    serverTs,
                  },
                }),
                socket,
              );
            }
            // Ack ALWAYS (duplicate = retransmit of a lost ack). Without this
            // the client never confirms reconnect-flushed ops: it re-sends
            // them forever and keeps rebasing them on top of confirmed state
            // that already includes them (permanent double-apply in the UI).
            try {
              socket.send(JSON.stringify({
                __ack: { cell: pending.cell, opId: pending.id, serverHlc },
              }));
            } catch { /* client disconnected */ }
          });
        }

        // Build response per cell (read under lock to get consistent view)
        const responseOps: SyncOp[] = [];
        let useSnapshot = false;
        const snapshot: Record<string, Record<string, unknown>> = {};
        const lowWaterMap: Record<string, HLC> = {};
        const serverTsMap: Record<string, number> = {};

        for (
          const [cell, { lastHlc, lastServerTs }] of Object.entries(
            sync.cells ?? {},
          )
        ) {
          if (!syncCells.has(cell)) continue;

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

            // Client's lastHlc older than low_water → compacted, send snapshot
            if (
              cellLW && lastHlc &&
              (lastHlc[0] < cellLW[0] ||
                (lastHlc[0] === cellLW[0] && lastHlc[1] < cellLW[1]))
            ) {
              useSnapshot = true;
              snapshot[cell] = deps.getCellState(cell);
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
              responseOps.push(
                ...ops.filter((o) => o.hlc[2] !== sync.clientId),
              );
            }
          });
        }

        const response = useSnapshot
          ? {
            __sync: {
              mode: "snapshot" as const,
              snapshot,
              ops: responseOps,
              lowWater: lowWaterMap,
              lastServerTs: serverTsMap,
            },
          }
          : {
            __sync: {
              mode: "incremental" as const,
              ops: responseOps,
              lowWater: lowWaterMap,
              lastServerTs: serverTsMap,
            },
          };

        try {
          socket.send(JSON.stringify(response));
        } catch { /* client disconnected */ }

        deps.log.debug(
          `[sync:server] sync response: ${response.__sync.mode}, ${responseOps.length} ops`,
        );
      })().catch((e) => {
        deps.log.error(`[sync:server] handleSync failed: ${e}`);
        // Notify client so it can back off and retry instead of hanging in "syncing"
        try {
          socket.send(JSON.stringify({
            __sync_error: { reason: String(e) },
          }));
        } catch { /* client disconnected */ }
      });
    },
  };
}
