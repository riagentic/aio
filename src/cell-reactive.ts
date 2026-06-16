// cell-reactive.ts — browser-side reactive cell binding
//
// Installs signal-backed getters on cell defs so that reading
// counter.count in a component auto-tracks and re-renders.
// Called from ensureConnected() for all registered cells.

import type { CellDef } from "./cell-types.ts";
import { getCellSignal } from "./state-signals.ts";
import { _registerAck } from "./browser-ack.ts";

// ── Cell registry ────────────────────────────────────────────────────
// Every cell() call registers here. Browser binding iterates this set.

const _cellRegistry = new Map<string, CellDef>();

/** Register a cell for reactive binding. Called by cell() at creation time. */
export function registerCell(def: CellDef): void {
  _cellRegistry.set(def.__aio.id, def);
}

/** Get all registered cells. */
export function getRegisteredCells(): ReadonlyMap<string, CellDef> {
  return _cellRegistry;
}

/** Clear registry (test isolation). */
export function _resetCellRegistry(): void {
  _cellRegistry.clear();
}

// ── Reactive binding ─────────────────────────────────────────────────

const _reactivelyBound = new WeakSet<CellDef>();

/** Install signal-backed getters on a cell for each state key, and wrap
 *  action creators with dispatch so `counter.increment()` sends to server.
 *  After this, `counter.count` reads from the cell signal (auto-tracked). */
export function bindCellReactive(
  def: CellDef,
  sendFn?: (
    action: { type: string; payload?: unknown; cid?: string },
  ) => void | Promise<void>,
): void {
  if (_reactivelyBound.has(def)) return;
  _reactivelyBound.add(def);

  const cellName = def.__aio.id;
  const initialState = def.__aio.state;
  const sig = getCellSignal(cellName, initialState);

  // Install signal-backed state getters
  for (const key of Object.keys(initialState)) {
    if (key in def && key !== "__aio") continue;

    Object.defineProperty(def, key, {
      get() {
        const s = sig.value; // tracked read — auto-tracked by AIR renderer
        if (s == null) return initialState[key];
        return (s as Record<string, unknown>)[key];
      },
      enumerable: false,
      configurable: true,
    });
  }

  // AIO-5.1: client-scoped cells — methods run locally against the cell signal,
  // synchronously, with no server dispatch. Each binding (tab) owns its slice.
  if (def.__aio.scope === "client") {
    const methods = def.__aio.clientMethods ?? {};
    for (const [key, method] of Object.entries(methods)) {
      const fn = (...args: unknown[]) => {
        const cur = (sig.value ?? initialState) as Record<string, unknown>;
        const next = structuredClone(cur);
        method(next, ...args);
        sig.set(next);
        return Promise.resolve();
      };
      (fn as unknown as Record<string, unknown>).type = `${cellName}:${key}`;
      Object.defineProperty(def, key, {
        value: fn,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    return; // no server wiring — client cells never dispatch
  }

  // Wrap action creators with dispatch so methods send to server.
  // Each call generates a client-side id (cid) and returns a Promise<void> that
  // resolves when the server acks the dispatch. Awaitable callers get
  // synchronization; unawaited callers (fire-and-forget) get a no-op .catch()
  // attached to silence unhandled-rejection warnings on disconnect.
  if (sendFn) {
    for (const key of def.__aio.actionKeys) {
      // Read from __aio.actions (raw catalog) — the def[key] surface is
      // wrapped in makeUnboundGuard and would throw if invoked.
      const creator = (def.__aio.actions as Record<string, unknown>)[key];
      if (typeof creator !== "function") continue;

      const type = (creator as unknown as { type: string }).type;
      const fn = (...args: unknown[]) => {
        const action = (creator as (...a: unknown[]) => {
          type: string;
          payload?: unknown;
        })(...args);
        const cid = crypto.randomUUID();
        const tagged = { ...action, cid };
        // AIO-2.2: register the ack BEFORE send so a fast server can't ack
        // before we listen. Then dispatch; the ack handler (wired in the
        // browser transport) will settle the registered promise.
        const promise = _registerAndSend(sendFn, tagged);
        // Attach a no-op .catch() so fire-and-forget callers don't get
        // unhandled-rejection console noise on disconnect.
        promise.catch(() => {});
        return promise;
      };
      (fn as unknown as { type: string }).type = type;
      (def as Record<string, unknown>)[key] = fn;
    }
  }
}

/** Register a pending ack for `cid`, then call the send function. The send
 *  function may be the browser transport's `send` (Promise-returning) or a
 *  legacy void-returning sendFn — both work. The returned promise resolves
 *  on _resolveAck, rejects on _rejectAck / timeout / disconnect. */
function _registerAndSend(
  sendFn: (
    action: { type: string; payload?: unknown; cid?: string },
  ) => void | Promise<void>,
  tagged: { type: string; payload?: unknown; cid: string },
): Promise<void> {
  const promise = _registerAck(tagged.cid);
  // Send in a microtask so a fast synchronous sendFn doesn't have its return
  // value clobbered by the pending map. The ack can come back as soon as
  // the dispatch completes server-side; the registration is in place.
  queueMicrotask(() => {
    try {
      sendFn(tagged);
    } catch { /* sendFn errors are surfaced via the ack timeout */ }
  });
  return promise;
}

/** Bind all registered cells reactively. Called once from ensureConnected(). */
export function bindAllCellsReactive(
  sendFn?: (action: { type: string; payload?: unknown }) => void,
): void {
  for (const def of _cellRegistry.values()) {
    bindCellReactive(def, sendFn);
  }
}
