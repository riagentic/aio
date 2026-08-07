// browser-air-hooks: AIR signal-based hooks (useAio, useLocal, useConnected, useProjection, memo)
// (`useCell` was REMOVED in alpha52 — read cells directly; see src/state/removals.ts)

import {
  useAio as _airUseAio,
  useConnected as _airUseConnected,
} from "../adapters/air.ts";
import { useRef } from "../air/aio-renderer.ts";
import { _projectWithSharing, ensureConnected } from "./browser-protocol.ts";

/** AIR useAio -- full global state, signal-based. Calls ensureConnected(). */
export function useAio<
  S extends Record<string, unknown> = Record<string, unknown>,
>(): {
  state: S;
  send: (action: { type: string; payload?: unknown }) => void;
} {
  ensureConnected();
  return _airUseAio<S>();
}

/** AIR useLocal -- signal-backed local state. No server connection needed.
 *  set() accepts value or updater function. patch() merges partial object
 *  updates.
 *
 *  Re-exported, not wrapped: it needs no transport, so every target ships the
 *  SAME function. A pass-through wrapper here is what let the android entry
 *  (src/standalone-air.ts, which `aio/air` resolves to on that target) carry a
 *  third `useLocal` with no tuple form and no patch() — the documented spelling
 *  threw, on one target only. */
export { useLocal } from "../adapters/air.ts";

/** AIR useConnected -- signal-based connection status. Calls ensureConnected(). */
export function useConnected(): boolean {
  ensureConnected();
  return _airUseConnected();
}

/** Derives state from a transformation, preserving element-level references.
 *  Signal-based -- reads auto-track in AIR renderer scope.
 */
export function useProjection<T>(fn: () => T, _deps?: unknown[]): T {
  // In AIR, fn() reads signals which auto-track (deps ignored).
  // useRef persists prev across renders for reference-stable memo.
  const prevRef = useRef<T | null>(null);
  const raw = fn();
  const projected = _projectWithSharing(raw, prevRef.current);
  prevRef.current = projected;
  return projected;
}

/** No-op in AIR -- the renderer has built-in auto-memo via shallow prop
 *  comparison. Defined in ../air/memo.ts so the android entry can export the
 *  SAME function without importing the browser transport. */
export { memo } from "../air/memo.ts";
