// deno-lint-ignore-file
// Diagnostics: _diagEmit, state integrity checks.

import type { AioWindow } from "./protocol-types.ts";

export const _w = typeof window !== "undefined"
  ? window as unknown as AioWindow & typeof globalThis
  : undefined;

export const _diagLastEmit = new Map<string, number>();

/** Deliver one diagnostic event to whatever sink the page has.
 *
 *  THE sink decision, in one place. `window._aioDiag` is the optional dev
 *  overlay; it is defined by `healthOverlayScript()` in the server's dev shell,
 *  which is currently not injected anywhere — so in practice the overlay is
 *  absent. Every call site used to be `if (typeof _w._aioDiag === "function")
 *  _w._aioDiag(ev)`, written out four times, which meant that with no overlay
 *  EVERY client-side diagnostic — the events whose entire job is to surface
 *  silent failures — was itself silently dropped. A framework's diagnostics
 *  going quiet is the one failure it must never have.
 *
 *  So: overlay when present, console otherwise — and an overlay that THROWS
 *  falls through to the console rather than eating the event: the sink whose
 *  job is surfacing silent failures must not have one of its own.
 *
 *  The 5s-per-type dedup lives HERE, not only in `_diagEmit`: the transport
 *  routers (WS `diag` frames, IPC, AIR commands) call `_deliverDiag`
 *  directly, and a repeating server diagnostic must not scroll the console
 *  either. Nothing here renders UI. */
export function _deliverDiag(ev: Record<string, unknown>): void {
  if (!_w) return;
  const type = typeof ev.type === "string" ? ev.type : "event";
  const now = Date.now();
  const last = _diagLastEmit.get(type);
  if (last && now - last < 5000) return;
  _diagLastEmit.set(type, now);
  if (typeof _w._aioDiag === "function") {
    try {
      _w._aioDiag(ev);
      return;
    } catch { /* buggy overlay — fall through to the console below */ }
  }
  try {
    const sev = ev.severity;
    const line = `[aio:diag] ${type} — ${ev.message ?? ""}` +
      (ev.hint ? `\n  → ${ev.hint}` : "");
    if (sev === "error") console.error(line);
    else if (sev === "warning") console.warn(line);
    else console.info(line);
  } catch { /* a malformed event must never break the transport */ }
}

export function _diagEmit(ev: {
  type: string;
  severity: "error" | "warning" | "info";
  source: string;
  message: string;
  detail?: unknown;
  hint?: string;
}): void {
  if (!_w) return;
  // Delivery dedups per type (5s) — see _deliverDiag.
  _deliverDiag({ ...ev, ts: Date.now() });
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
