// deno-lint-ignore-file
// Diagnostics: _diagEmit, state integrity checks.

import type { AioWindow } from "./protocol-types.ts";
import { log } from "../diagnostics/logger-api.ts";
export const _w = typeof window !== "undefined"
  ? window as unknown as AioWindow & typeof globalThis
  : undefined;

export const _diagLastEmit = new Map<
  string,
  { last: number; window: number; suppressed: number }
>();

/** Deliver one diagnostic event to whatever sink the page has.
 *
 *  THE sink decision, in one place. `window._aioDiag` is an optional hook a
 *  page (or an app's own dev tooling) may define to receive every diagnostic
 *  event; aio ships no overlay that defines it, so in practice it is absent.
 *  Every call site used to be `if (typeof _w._aioDiag === "function")
 *  _w._aioDiag(ev)`, written out four times, which meant that with no hook
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
  // Exponential backoff per type, not a flat window. A flat 5s dedup against a
  // PERSISTENT condition is a line every five seconds forever — one field
  // report's client.log carried thousands of identical `state-shape-drift`
  // lines over hours, burying the signal the log exists to carry. Now: 5s,
  // 10s, 20s, … capped at an hour, with the suppressed count attached when
  // the line does print, so "still happening, 719 times since the last line"
  // stays one line. A type that stays quiet for a full window resets to 5s —
  // a condition that STOPPED and came back is news again.
  const st = _diagLastEmit.get(type);
  if (st && now - st.last < st.window) {
    st.suppressed++;
    return;
  }
  const stale = !st || now - st.last >= st.window * 2;
  const next = st && !stale ? Math.min(st.window * 2, 3_600_000) : 5000;
  const suppressed = st && !stale ? st.suppressed : 0;
  _diagLastEmit.set(type, { last: now, window: next, suppressed: 0 });
  if (suppressed > 0 && typeof ev.message === "string") {
    ev = {
      ...ev,
      message: `${ev.message} (repeated ${suppressed}× since the last ` +
        `report; reporting again in ≤${Math.round(next / 1000)}s while it ` +
        `persists)`,
    };
  }
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
    if (sev === "error") log.error(line);
    else if (sev === "warning") log.warn(line);
    else log.info(line);
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
