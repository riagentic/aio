// deno-lint-ignore-file no-explicit-any
/**
 * @module
 * Transport management, action dispatch, send proxy, and tracking proxy.
 * Owns: Transport interface, offline queue, send(), createSendProxy(), _trackingProxy().
 */

import { diagEmit } from "../diagnostics/diagnostic-bus.ts";
import { enc } from "../protocol/envelope.ts";
import { _BLOCKED_KEYS } from "./state-array-utils.ts";
import { _setSubsSendFn, trackPath } from "./state-subs.ts";
import { offlineQueue } from "./offline-queue.ts";
import { log } from "../diagnostics/logger-api.ts";

// ── Types ────────────────────────────────────────────────────────────

/** Abstract transport — WS, IPC, or any send/close pair. */
export interface Transport {
  send(data: string): void;
  close(): void;
}

/** IPC bridge for Electron (injected by preload script).
 *  @internal Cross-module wiring — not public API, stripped from the snapshot. */
export interface AioIPC {
  send: (json: string) => void;
  ready: () => void;
  onMessage: (fn: (line: string) => void) => void;
  onOpen: (fn: () => void) => void;
  onClose: (fn: () => void) => void;
}

/** Cell reference — the __aio metadata from cell() factory.
 *  @internal Cross-module wiring — not public API, stripped from the snapshot. */
export interface CellRef {
  __aio: {
    id: string;
    actionKeys?: string[];
    actions?: Record<string, unknown>;
    state?: any;
  };
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_OFFLINE_QUEUE = 100;

/** How full this queue is, 0..1. Read by the browser transport so
 *  `isConnectionDegraded()` answers for BOTH offline queues.
 *
 *  There are two, for a structural reason: this one lives in the isomorphic
 *  core (`useCell().send` / `useAio().send`), and the boundary matrix forbids
 *  `state` importing `browser`, so it cannot delegate to the cell-method
 *  queue in `browser/browser-air-transport.ts`. Two queues is therefore a
 *  given — but "how healthy is this connection" is ONE fact, and reporting it
 *  from only one of them made the documented indicator answer `false` no
 *  matter how backed up a `send()` caller was.
 *  @internal */
export function _offlineQueueFullness(): number {
  return _offlineQueue.fullness();
}

// ── Module state ─────────────────────────────────────────────────────

let _transport: Transport | null = null;

// Offline action queue (memory-only, no IndexedDB — framework-agnostic).
// The ONE implementation + drop policy shared with the browser transport's
// cell-method queue: at cap the OLDEST action is dropped, loudly (see
// offline-queue.ts). A drop here must be as visible as the same event on the
// cell-method queue — it reaches the diagnostic bus (dev overlay, `am`), not
// just the browser console.
const _offlineQueue = offlineQueue(MAX_OFFLINE_QUEUE, (dropped) => {
  log.warn(
    "state",
    `Action "${dropped.type}" dropped — offline queue full (${MAX_OFFLINE_QUEUE}), newest wins`,
  );
  diagEmit({
    type: "state-transport:offline-queue-full",
    severity: "error",
    source: "state-transport",
    message:
      `Action "${dropped.type}" was DROPPED — the offline send queue is full ` +
      `(${MAX_OFFLINE_QUEUE}); the oldest queued action gives way to the newest`,
    detail: { actionType: dropped.type, max: MAX_OFFLINE_QUEUE },
    hint: "The queue drops OLDEST-first (newest data wins). Use a cell " +
      "method (whose promise rejects on drop) for actions that must not be " +
      "lost.",
  });
});

/** Sync engine hook — set by sync-engine.ts when sync cells exist */
let _syncHandler:
  | ((action: { type: string; payload?: unknown }) => boolean)
  | null = null;

// ── Transport management ─────────────────────────────────────────────

/** Returns the current transport (for internal use by message handling). */
export function _getTransport(): Transport | null {
  return _transport;
}

/** Install (or clear with null) the CRDT sync intercept — returns true to claim an action before normal dispatch.
 *  @internal Cross-module wiring — not public API, stripped from the snapshot. */
export function setSyncHandler(
  handler: ((action: { type: string; payload?: unknown }) => boolean) | null,
): void {
  _syncHandler = handler;
}

/** Set the abstract transport (WS adapter, IPC adapter, etc). */
export function setTransport(
  transport: Transport | null,
  onConnected?: () => void,
): void {
  _transport = transport;
  // Wire subscription send function
  _setSubsSendFn(transport ? (msg) => transport.send(msg) : null);
  // AIO-183: reset initial state flag on reconnect so next message is
  // treated as full state, not patches applied to potentially stale state
  if (transport) {
    onConnected?.();
  }
}

// ── Offline queue ────────────────────────────────────────────────────

/** Flush queued offline actions through the current transport.
 *  @internal Cross-module wiring — not public API, stripped from the snapshot. */
export function flushOfflineQueue(): void {
  if (!_transport) return;
  for (const action of _offlineQueue.drain()) {
    _transport.send(enc("action", action));
  }
}

// ── Send ─────────────────────────────────────────────────────────────

/** Send an action via transport. Queues offline if no transport. The action
 *  is always accepted: at cap the OLDEST queued action is dropped instead
 *  (newest wins — the one policy, see offline-queue.ts), with a loud
 *  diagnostic naming what was lost. Returns true when handed to the
 *  transport or queued. */
export function send(action: { type: string; payload?: any }): boolean {
  // Sync cells route through CRDT engine
  if (_syncHandler && _syncHandler(action)) return true;

  const tagged = { ...action, _source: "UI" };

  if (_transport) {
    _transport.send(enc("action", tagged));
    return true;
  }
  // Queue for later — the drop policy + diagnostics live in the shared queue.
  _offlineQueue.push(tagged);
  return true;
}

/** Create a typed send proxy for a cell.
 *  Uses action creators from ref.__aio.actions when available (structured payloads),
 *  falls back to { args } wrapper for method-style dispatch.
 *  Optional sendFn overrides the default send (e.g. browser.ts injects its own for DevTools/vitals).
 *  @internal Cross-module wiring — not public API, stripped from the snapshot. */
export function createSendProxy(
  cellName: string,
  ref: CellRef,
  sendFn?: (action: { type: string; payload?: unknown }) => void,
): Record<string, (...args: unknown[]) => void> {
  const _sendAction = sendFn ?? send;
  return new Proxy({} as Record<string, (...args: unknown[]) => void>, {
    get(_target, methodName: string) {
      // Use action creator if available (produces correct payload shape for this action)
      const creator = ref.__aio.actions?.[methodName];
      if (typeof creator === "function") {
        return (...args: unknown[]) => {
          const action = (creator as (
            ...a: unknown[]
          ) => { type: string; payload?: unknown })(...args);
          _sendAction({
            ...action,
            type: action.type ?? `${cellName}:${methodName}`,
          });
        };
      }
      // Fallback: wrap args for spread-style dispatch
      return (...args: unknown[]) => {
        _sendAction({
          type: `${cellName}:${methodName}`,
          payload: { args },
        });
      };
    },
  });
}

// ── Tracking proxy ───────────────────────────────────────────────────

/**
 * Deep proxy that records accessed state paths for server subscription filtering.
 * @internal Cross-module wiring — not public API, stripped from the snapshot.
 */
export function _trackingProxy(
  obj: unknown,
  parentPath = "",
  depth = 0,
): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  if (depth > 100) return obj; // AIO-261: depth limit for circular references
  return new Proxy(obj as Record<string, unknown>, {
    get(target, prop: string | symbol) {
      if (typeof prop === "string" && !_BLOCKED_KEYS.has(prop)) {
        const fullPath = parentPath ? `${parentPath}.${prop}` : prop;
        const value = Reflect.get(target, prop);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          trackPath(fullPath); // AIO-206: track object access itself
          return _trackingProxy(value, fullPath, depth + 1);
        }
        trackPath(fullPath);
        return value;
      }
      return Reflect.get(target, prop);
    },
    ownKeys(target) {
      trackPath(parentPath || "*");
      return Reflect.ownKeys(target);
    },
  });
}

/** Resolve cell state with fallback/defaults (AIO-29 defense).
 * @internal Cross-module wiring — not public API, stripped from the snapshot.
 *  Merges incomplete cell state with defaults to prevent undefined crashes. */
export function _resolveWithFallback<S>(
  cellState: S | null | undefined,
  defaults: S | undefined,
): S {
  if (cellState == null) {
    return (defaults !== undefined ? defaults : cellState) as S;
  }
  if (
    defaults !== undefined &&
    typeof cellState === "object" && !Array.isArray(cellState) &&
    typeof defaults === "object" && !Array.isArray(defaults) &&
    defaults !== null
  ) {
    return {
      ...(defaults as Record<string, unknown>),
      ...(cellState as Record<string, unknown>),
    } as S;
  }
  return cellState as S;
}

/** Reset transport state (for test isolation). */
export function _resetTransport(): void {
  _transport = null;
  _offlineQueue.drain();
  _syncHandler = null;
  _setSubsSendFn(null);
}
