// deno-lint-ignore-file no-explicit-any
/**
 * @module
 * Message handling and lifecycle — processes server messages (full state, Immer patches).
 * Owns: handleMessage, ready(), isInitialStateReceived(), ready promise management.
 */

import { batch } from "./signal.ts";
import {
  applyWirePatches,
  type WirePatch as Patch,
} from "../protocol/patch-ops.ts";
import { enc } from "../protocol/envelope.ts";
import { _BLOCKED_KEYS } from "./state-array-utils.ts";
import {
  _applyFullState,
  _getOrCreateCellSignal,
  _stateSignal,
} from "./state-signals.ts";
import { _accessedPaths, cancelSubsTimer } from "./state-subs.ts";
import { _getTransport } from "./state-transport.ts";
import { log } from "../diagnostics/logger-api.ts";

// ── Module state ─────────────────────────────────────────────────────

let _initialStateReceived = false;
let _readyResolve: ((state: any) => void) | null = null;
let _readyPromise = new Promise<any>((resolve) => {
  _readyResolve = resolve;
});
let _readyTimeout: ReturnType<typeof setTimeout> | null = null;

// ── Types ────────────────────────────────────────────────────────────

/** Result of handleMessage — tells caller what happened.
 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export type HandleResult = "full" | "delta" | "noop" | "dropped";

// ── Message handling ─────────────────────────────────────────────────

/** Process a message from the server (full state, delta, or filtered).
 *  CALLER is responsible for routing control frames (reload, css, boot, etc.)
 *  before calling this — state-core has no browser-specific protocol knowledge.
 *  Returns what happened so caller can react (notify listeners, devtools, etc). */
export function handleMessage(data: any): HandleResult {
  // AIO-272: validate input — null/undefined messages crash transport
  if (!data || typeof data !== "object") return "noop";
  if (!_initialStateReceived) {
    // Delta before first state — drop (reconnect race)
    if (data.$patches) return "dropped";
    const firstEver = _accessedPaths.size === 0;
    _initialStateReceived = true;
    _applyFullState(data);
    // Clear ONLY on the true first state of the session.
    //
    // A reconnect re-enters this branch (`_resetInitialStateFlag()` runs on
    // every transport swap) while the server still holds the subscription list
    // from before the drop. Clearing here wiped the client's record of what it
    // had subscribed to, so the next path a component tracked — a route
    // change, a newly mounted component — collapsed to a subs frame containing
    // ONLY that path. The server REPLACES its list, and from then on the cells
    // dropped out of it were never pushed to this client again: silent,
    // permanent, and self-sustaining, since a cell that gets no updates cannot
    // re-render to re-track itself. This is AIO-170, which the second branch
    // below already carries a warning about; the first branch never got it.
    if (firstEver) {
      _accessedPaths.clear();
      cancelSubsTimer();
    }
    if (_readyResolve) {
      if (_readyTimeout !== null) {
        clearTimeout(_readyTimeout);
        _readyTimeout = null;
      }
      _readyResolve(data);
      _readyResolve = null;
    }
    return "full";
  }

  /** Ask the server for a full state frame.
   *
   *  THE one thing every "this delta was not applied" path must do. A dropped
   *  delta means the client and the server no longer agree about the state, and
   *  nothing after it can put them back: later patches apply to a base that is
   *  already wrong, so the UI renders confidently stale data with no error
   *  anywhere. Three paths reach that condition (a non-array `$patches`, a
   *  reserved path segment, an applier that threw) and only one of them used to
   *  ask for the fix.
   *
   *  Best effort by construction: with no transport there is nothing to ask, and
   *  the reconnect path sends a full state anyway. */
  function _requestResync(): void {
    const transport = _getTransport();
    if (transport) transport.send(enc("resync"));
  }

  // Immer patches: { $patches: [{op, path, value}, ...] }
  if (data.$patches) {
    if (!Array.isArray(data.$patches)) {
      // Safety: a message carrying $patches as a non-array is malformed wire
      // protocol — never fall through to full-state replacement with it.
      //
      // Dropped AND RESYNCED. A delta the client refuses is a delta the server
      // believes it delivered: from here on the two disagree about the state,
      // and every later patch applies to a base that is already wrong. This
      // used to warn and return, leaving a UI that renders confidently stale
      // data until some unrelated full-state frame happens along — the exact
      // "looks like it works" failure the applyPatches catch below already
      // resyncs for. One rule for every path that does not apply a delta.
      log.warn(
        "malformed $patches (not an array) — dropped, requesting resync",
      );
      _requestResync();
      return "dropped";
    }
    const prev = _stateSignal.peek();
    const patches: Patch[] = data.$patches;
    if (patches.length === 0) return "noop";

    // Defense-in-depth: reject patches whose path segments target reserved
    // prototype keys (__proto__, constructor, prototype). Immer 10 guards
    // these internally (throws), but we drop malformed wire data early with a
    // clear message rather than relying on Immer's throw + resync path — a
    // compromised/buggy server should never be able to probe these keys.
    for (const p of patches) {
      for (const seg of p.path) {
        if (typeof seg === "string" && _BLOCKED_KEYS.has(seg)) {
          // Refused, and resynced for the same reason as above: whatever the
          // server meant to send, this client did not apply it and is now
          // behind. (The refusal itself stands — a reserved prototype key is
          // never applied, however it got here.)
          log.warn(
            `dropped $patches with reserved path segment "${seg}" — requesting resync`,
          );
          _requestResync();
          return "dropped";
        }
      }
    }

    try {
      // `append` and Immer's ops alike — the ONE applier (patch-ops.ts).
      const next = applyWirePatches(prev, patches);
      if (next === prev) return "noop";

      // Determine which cells were affected
      const changedCells = new Set<string>();
      for (const p of patches) {
        if (p.path.length > 0 && typeof p.path[0] === "string") {
          changedCells.add(p.path[0]);
        }
      }

      batch(() => {
        _stateSignal.set(next);
        for (const cellName of changedCells) {
          if (_BLOCKED_KEYS.has(cellName)) continue;
          const cellState = (next as Record<string, unknown>)[cellName];
          _getOrCreateCellSignal(cellName, cellState).set(cellState);
        }
      });
      return "delta";
    } catch (e) {
      // applyPatches failed — client state desynced, request full state from server
      log.warn("applyPatches failed, requesting resync:", {
        detail: String(e),
      });
      _requestResync();
      return "noop";
    }
  }

  // Full state replacement (reconnect / subscription response)
  // Do NOT clear _accessedPaths here — that nukes "*" from useAio() and causes
  // subsequent __subs messages to exclude cells not read by useCell() (AIO-170)
  _applyFullState(data);
  return "full";
}

// ── Lifecycle ────────────────────────────────────────────────────────

/** Resolves with the first state message — or with **`null`** if none arrives
 *  within 30s. It does NOT reject.
 *
 *  The doc used to promise a rejection while the code resolved `null`, so a
 *  caller guarding with `.catch()` was never told about the timeout and
 *  proceeded as though state had arrived. Null-check the result:
 *
 *  ```ts
 *  const state = await ready();
 *  if (state === null) { /* never connected — show an offline state *\/ }
 *  ```
 *
 *  Resolving is deliberate: a rejection nobody caught would surface as an
 *  unhandled rejection 30 seconds into an otherwise working page. */
export function ready(): Promise<unknown> {
  if (_readyTimeout === null) {
    _readyTimeout = setTimeout(() => {
      if (_readyResolve) {
        _readyResolve(null); // resolve with null rather than hang
        _readyResolve = null;
      }
    }, 30_000);
  }
  return _readyPromise;
}

/** Whether initial state has been received.
 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export function isInitialStateReceived(): boolean {
  return _initialStateReceived;
}

/** Reset message handler state (for test isolation). */
export function _resetMessageState(): void {
  _initialStateReceived = false;
  if (_readyTimeout !== null) {
    clearTimeout(_readyTimeout);
    _readyTimeout = null;
  }
  _readyResolve = null;
  _readyPromise = new Promise<any>((resolve) => {
    _readyResolve = resolve;
  });
}

/** Mark initial state as received (called by _injectState in testing). */
export function _markInitialStateReceived(): void {
  _initialStateReceived = true;
}

/** Reset only the initial-state-received flag (for reconnect — AIO-183).
 *  Does NOT reset the ready promise — that stays resolved once fired. */
export function _resetInitialStateFlag(): void {
  _initialStateReceived = false;
}
