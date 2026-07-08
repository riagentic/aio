// deno-lint-ignore-file
// Diagnostics: _diagEmit, state integrity checks.

import type { AioWindow } from "./protocol-types.ts";

export const _w = typeof window !== "undefined"
  ? window as unknown as AioWindow & typeof globalThis
  : undefined;

export const _diagLastEmit = new Map<string, number>();

export function _diagEmit(ev: {
  type: string;
  severity: "error" | "warning" | "info";
  source: string;
  message: string;
  detail?: unknown;
  hint?: string;
}): void {
  if (!_w || typeof _w._aioDiag !== "function") {
    return;
  }
  const now = Date.now();
  const last = _diagLastEmit.get(ev.type);
  if (last && now - last < 5000) return;
  _diagLastEmit.set(ev.type, now);
  _w._aioDiag({ ...ev, ts: now });
}

let _initialShapeKeys: Set<string> | null = null;

export function _checkStateIntegrity(state: unknown): void {
  if (!state || typeof state !== "object" || Array.isArray(state)) return;
  const obj = state as Record<string, unknown>;
  if (_initialShapeKeys === null) {
    _initialShapeKeys = new Set(Object.keys(obj));
    return;
  }
  for (const k of _initialShapeKeys) {
    if (!(k in obj)) {
      _diagEmit({
        type: "state-shape-drift",
        severity: "warning",
        source: "browser",
        message: `State key "${k}" from initial shape is now missing`,
        detail: { missingKey: k, currentKeys: Object.keys(obj) },
        hint:
          "A key from the initial full state has disappeared. This may indicate a delta patch or merge bug.",
      });
    }
  }
}

/** Reset _initialShapeKeys — for _reset() */
export function _resetInitialShapeKeys(): void {
  _initialShapeKeys = null;
}
