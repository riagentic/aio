// deno-lint-ignore-file no-explicit-any
/**
 * @module
 * Transport management, action dispatch, send proxy, and tracking proxy.
 * Owns: Transport interface, offline queue, send(), createSendProxy(), _trackingProxy().
 */

import { _BLOCKED_KEYS } from "./state-array-utils.ts";
import { _setSubsSendFn, trackPath } from "./state-subs.ts";

// ── Types ────────────────────────────────────────────────────────────

/** Abstract transport — WS, IPC, or any send/close pair. */
export interface Transport {
  send(data: string): void;
  close(): void;
}

/** IPC bridge for Electron (injected by preload script). */
export interface AioIPC {
  send: (json: string) => void;
  ready: () => void;
  onMessage: (fn: (line: string) => void) => void;
  onOpen: (fn: () => void) => void;
  onClose: (fn: () => void) => void;
}

/** Cell reference — the __aio metadata from cell() factory. */
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

// ── Module state ─────────────────────────────────────────────────────

let _transport: Transport | null = null;

// Offline action queue (memory-only, no IndexedDB — framework-agnostic)
const _offlineQueue: any[] = [];

/** Sync engine hook — set by sync-engine.ts when sync cells exist */
let _syncHandler:
  | ((action: { type: string; payload?: unknown }) => boolean)
  | null = null;

// ── Transport management ─────────────────────────────────────────────

/** Returns the current transport (for internal use by message handling). */
export function _getTransport(): Transport | null {
  return _transport;
}

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

/** Flush queued offline actions through the current transport. */
export function flushOfflineQueue(): void {
  if (!_transport) return;
  for (const action of _offlineQueue) {
    _transport.send(JSON.stringify(action));
  }
  _offlineQueue.length = 0;
}

// ── Send ─────────────────────────────────────────────────────────────

/** Send an action via transport. Queues offline if no transport.
 *  Returns false if the action was dropped (offline queue full). */
export function send(action: { type: string; payload?: any }): boolean {
  // Sync cells route through CRDT engine
  if (_syncHandler && _syncHandler(action)) return true;

  const tagged = { ...action, _source: "UI" };
  const json = JSON.stringify(tagged);

  if (_transport) {
    _transport.send(json);
    return true;
  }
  // Queue for later
  if (_offlineQueue.length < MAX_OFFLINE_QUEUE) {
    _offlineQueue.push(tagged);
    return true;
  }
  // AIO-196: warn instead of silent drop
  console.warn(
    `[aio:state] Action "${action.type}" dropped — offline queue full (${MAX_OFFLINE_QUEUE})`,
  );
  return false;
}

/** Create a typed send proxy for a cell.
 *  Uses action creators from ref.__aio.actions when available (structured payloads),
 *  falls back to { args } wrapper for method-style dispatch.
 *  Optional sendFn overrides the default send (e.g. browser.ts injects its own for DevTools/vitals). */
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

/** Deep proxy that records accessed state paths for server subscription filtering. */
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
  _offlineQueue.length = 0;
  _syncHandler = null;
  _setSubsSendFn(null);
}
