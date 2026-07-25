// cell-reactive.ts — browser-side reactive cell binding
//
// Installs signal-backed getters on cell defs so that reading
// counter.count in a component auto-tracks and re-renders.
// Called from ensureConnected() for all registered cells.

import type { CellDef, CellFieldFilter } from "./cell-types.ts";
import { randomUuid } from "../rand.ts";
import { attachMeta } from "./cell-catalog.ts";
import { _cellSignals, getCellSignal } from "./state-signals.ts";
import { _registerAck } from "../protocol/browser-ack.ts";
import { trackPath } from "./state-subs.ts";
import {
  applyCellFieldFilter,
  deepExclude,
  uiKeyVisibility,
} from "./state-filter.ts";

// ── Cell registry ────────────────────────────────────────────────────
// Every cell() call registers here. Browser binding iterates this set.

const _cellRegistry = new Map<string, CellDef>();

/** Register a cell for reactive binding. Called by cell() at creation time.
 *  Same-id re-registration is allowed (HMR re-imports the module and re-runs
 *  cell()), but in dev mode a duplicate name warns loudly — two modules both
 *  defining `cell("counter", …)` would otherwise silently kill the first
 *  definition with no warning. The composeCells duplicate check only catches
 *  the case where both are passed explicitly to `aio.run({ cells })`; this
 *  catches the import-time registration overwrite. */
export function registerCell(def: CellDef): void {
  const id = def.__aio.id;
  if (
    _cellRegistry.has(id) &&
    (globalThis as Record<string, unknown>).__aioDev === true
  ) {
    // HMR re-import produces an identical def — only warn when the new def
    // differs from the registered one (genuine conflict, not hot reload).
    const existing = _cellRegistry.get(id);
    if (existing !== def) {
      console.warn(
        `[aio] duplicate cell name '${id}' — cell() called twice with this ` +
          `name. The previous definition is being replaced. If this is HMR, ` +
          `ignore; if two modules define the same cell name, rename one.`,
      );
    }
  }
  _cellRegistry.set(id, def);
}

/** Get all registered cells. */
export function getRegisteredCells(): ReadonlyMap<string, CellDef> {
  return _cellRegistry;
}

/** Clear registry (test isolation). */
export function _resetCellRegistry(): void {
  _cellRegistry.clear();
}

/**
 * Clear per-cell binding state so registered cells can re-bind to a fresh app
 * on the next mount — WITHOUT dropping the registry. Cells are module
 * singletons that bind once ("already bound" guard); a hermetic re-mount must
 * release them so their methods/getters rewire to the new runtime.
 */
export function _resetCellBindings(): void {
  for (const def of _cellRegistry.values()) {
    (def.__aio as Record<string, unknown>).bound = false;
    _reactivelyBound.delete(def);
  }
}

// ── Reactive binding ─────────────────────────────────────────────────

const _reactivelyBound = new WeakSet<CellDef>();

// ── Client-side ui visibility (TBD B7) ───────────────────────────────
// bindCellReactive IS the client read surface — it runs only in browser /
// standalone (electron, android, testUI) contexts, never on a pure server.
// Enforcing `ui:` visibility here gives ONE seam for both runtimes: over WS
// the server already filters at broadcast time; locally (standalone) there is
// no broadcast, so without this every "secret" was fully readable on the cell
// object. Reads of a hidden field return undefined AND warn once — loud, not
// silent. Server-side reads (routes/effects — bound via bindCell) see
// everything, by design.

const _uiReadWarned = new Set<string>();

/** Test isolation — clear the one-time hidden-read warning dedup. */
export function _resetUiReadWarnings(): void {
  _uiReadWarned.clear();
}

function warnHiddenRead(cellName: string, key: string, reason: string): void {
  const id = `${cellName}.${key}`;
  if (_uiReadWarned.has(id)) return;
  _uiReadWarned.add(id);
  console.warn(
    `[aio] ${id} read from client context → undefined — ${reason}. ` +
      `ui visibility is enforced on ALL client reads (browser and ` +
      `standalone/electron alike); keep secrets server-side and read them ` +
      `in server code (routes, effects, methods) instead.`,
  );
}

/** The ui filter that applies to CLIENT reads of a cell. Client-scoped cells
 *  are exempt: their state lives only in this client (never broadcast), so a
 *  ui filter has nothing to protect. */
function clientUiFilter(def: CellDef): CellFieldFilter | undefined {
  return def.__aio.scope === "client" ? undefined : def.__aio.ui;
}

/** Filter a full cell slice for client visibility ("none" → empty slice). */
function filterSlice(
  filter: CellFieldFilter | undefined,
  slice: Record<string, unknown>,
): Record<string, unknown> {
  if (!filter || filter === "all") return slice;
  return applyCellFieldFilter(filter, slice) ?? {};
}

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

  // Install signal-backed state getters. Overrides the creation-time default
  // getter (installDefaultStateGetters); skip only if a method/selector owns the
  // name (impossible per AIO-6.1, but defensive — a default getter reads as a
  // non-function and is correctly overridden).
  const uiFilter = clientUiFilter(def);
  for (const key of Object.keys(initialState)) {
    if (typeof (def as Record<string, unknown>)[key] === "function") continue;

    // TBD B7: ui visibility is enforced at THIS seam for client reads — a
    // hidden field reads as undefined (+ one-time loud warn), a dot-path
    // exclude strips the nested value, exactly like the broadcast filter.
    const vis = uiKeyVisibility(uiFilter, key);
    Object.defineProperty(def, key, {
      get() {
        if (vis.hidden) {
          warnHiddenRead(cellName, key, vis.reason!);
          return undefined;
        }
        // Register a SERVER subscription for this cell (risoto 2026-07-18):
        // reading a cell via direct access is documented as "reactive and
        // auto-tracked", but it only tracked the AIR *re-render* signal — it
        // never told the server to send this cell's deltas. So the moment the
        // client's subscription was narrowed to a partial set (by useCell/
        // useAio elsewhere), a directly-read cell silently stopped receiving
        // live updates — its signal never changed, freezing the UI at the
        // connect-time value. trackPath makes "auto-tracked" true for deltas
        // too. No-op on the server (never bound reactively) and harmless in
        // standalone/test (no transport → no __subs sent).
        trackPath(cellName);
        const s = sig.value; // tracked read — auto-tracked by AIR renderer
        const v = s == null
          ? initialState[key]
          : (s as Record<string, unknown>)[key];
        if (vis.deepSegs) {
          return vis.deepSegs.reduce((acc, segs) => deepExclude(acc, segs), v);
        }
        return v;
      },
      enumerable: false,
      configurable: true,
    });
  }

  // AIO-422 (realitio): bind selectors on the browser cell too — they're pure
  // functions over state, so `cell.count()` must work client-side exactly as it
  // does server-side. Before this they existed only on the server; the browser
  // cell had no accessor and `listings.count()` threw `is not a function` at
  // runtime with no boot warning — the "quiet lie" the docs promised against.
  // Mirrors the server bind (cell-catalog.ts): zero-arg accessor,
  // selectorFn(ownSlice, fullState). The `fullState` is a lazy Proxy so a
  // deps-form selector reading another cell tracks ONLY the cells it touches
  // (precise subscriptions), and a plain own-slice selector subscribes to just
  // its own cell.
  const selectors = def.__aio.selectors as
    | Record<string, (s: unknown, fullState?: unknown) => unknown>
    | undefined;
  if (selectors) {
    for (const [key, selectorFn] of Object.entries(selectors)) {
      if (typeof (def as Record<string, unknown>)[key] === "function") continue;
      Object.defineProperty(def, key, {
        value: (...args: unknown[]) => {
          trackPath(cellName);
          // TBD B7: selectors in client context see the ui-FILTERED slice —
          // same data a browser client would hold after a broadcast, so a
          // selector can't leak a ui-excluded secret in standalone/electron.
          const own = filterSlice(
            uiFilter,
            (sig.value ?? initialState) as Record<string, unknown>,
          );
          // Called WITH args → parameterized selector (`cell.byId(id)`).
          if (args.length > 0) {
            return (selectorFn as (s: unknown, ...a: unknown[]) => unknown)(
              own,
              ...args,
            );
          }
          const full = new Proxy({} as Record<string, unknown>, {
            get(_t, prop) {
              if (typeof prop !== "string") return undefined;
              if (prop === cellName) return own;
              const other = _cellSignals.get(prop);
              if (!other) return undefined;
              trackPath(prop);
              // Cross-cell reads honor the OTHER cell's ui filter too.
              const otherDef = _cellRegistry.get(prop);
              const otherSlice = (other.value ?? otherDef?.__aio.state ??
                {}) as Record<string, unknown>;
              return otherDef
                ? filterSlice(clientUiFilter(otherDef), otherSlice)
                : otherSlice;
            },
          });
          return selectorFn(own, full);
        },
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
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
      const label = `${cellName}:${key}`;
      const creator = Object.assign(
        (...args: unknown[]) => ({ type: label, payload: { args } }),
        { type: label },
      );
      (creator as unknown as Record<string, unknown>).action = creator;
      attachMeta(fn, creator);
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

      // Async methods carry `_callId` so the server correlates the completion
      // (its return value) back to this call over the wire (return-value
      // transport) — mirroring bindCell's direct-call path. Sync/void methods
      // get their value from the dispatch result on the server side.
      const isAsync = def.__aio.asyncMethods?.has(key) === true;
      const fn = (...args: unknown[]) => {
        const action = (creator as (...a: unknown[]) => {
          type: string;
          payload?: unknown;
        })(...args);
        const cid = randomUuid();
        const tagged = isAsync
          ? {
            ...action,
            cid,
            payload: {
              ...(action.payload as Record<string, unknown> ?? {}),
              _callId: cid,
            },
          }
          : { ...action, cid };
        // AIO-2.2: register the ack BEFORE send so a fast server can't ack
        // before we listen. Then dispatch; the ack handler (wired in the
        // browser transport) will settle the registered promise.
        const promise = _registerAndSend(sendFn, tagged);
        // Attach a no-op .catch() so fire-and-forget callers don't get
        // unhandled-rejection console noise on disconnect.
        promise.catch(() => {});
        return promise;
      };
      attachMeta(fn, creator);
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
): Promise<unknown> {
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
