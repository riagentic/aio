// src/sync/server-handler.ts — Server-side CRDT sync relay
// Receives ops from clients, persists to op-log, broadcasts to other clients, sends acks.

import type { DB } from "../db/types.ts";
import type { HLC, SyncOp } from "./types.ts";
import { createHLC, type HLClock } from "./hlc.ts";
import { compactSyncOps } from "./compact.ts";
import { getLowWater, loadOpsSince, persistOp } from "./server-store.ts";

/** Dependencies injected into the server-side sync handler. */
export interface SyncHandlerDeps {
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

/** Server-side handler that persists ops, sends acks, and broadcasts to peers. */
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

/** Validate a sync op has required fields and no proto-pollution vectors. */
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

/** Create a server-side sync handler that relays CRDT ops between clients. */
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
    const next = prev.then(fn, fn);
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
        try {
          await persistOp(deps.db, op);
        } catch (e) {
          deps.log.error(`[sync:server] failed to persist op ${op.id}: ${e}`);
          return; // Don't ack — client will retry
        }

        try {
          socket.send(JSON.stringify({
            __ack: { cell: op.cell, opId: op.id, serverHlc },
          }));
        } catch { /* client disconnected */ }

        deps.broadcastRaw.fn(
          JSON.stringify({
            __op: {
              id: op.id,
              hlc: op.hlc,
              cell: op.cell,
              action: op.action,
              payload: op.payload,
            },
          }),
          socket,
        );

        await tryCompact(op.cell);

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
        cells: Record<string, { lastHlc: HLC | null }>;
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
            await persistOp(deps.db, pending);
          });
        }

        // Build response per cell (read under lock to get consistent view)
        const responseOps: SyncOp[] = [];
        let useSnapshot = false;
        const snapshot: Record<string, Record<string, unknown>> = {};
        const lowWaterMap: Record<string, HLC> = {};

        for (
          const [cell, { lastHlc }] of Object.entries(
            sync.cells ?? {},
          )
        ) {
          if (!syncCells.has(cell)) continue;

          await withLock(cell, async () => {
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
              const ops = await loadOpsSince(deps.db, cell, lastHlc);
              responseOps.push(...ops);
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
            },
          }
          : {
            __sync: {
              mode: "incremental" as const,
              ops: responseOps,
              lowWater: lowWaterMap,
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
      });
    },
  };
}
