// deno-lint-ignore-file no-explicit-any
/**
 * @module
 * Framework-agnostic canonical state store.
 *
 * Owns: Immer patch application, subscription tracking, send logic,
 * transport abstraction. Delta generation uses Immer's produceWithPatches
 * in feature-compose.ts; patch application uses Immer's applyPatches here.
 * Both the React and AIR adapters consume this module.
 *
 * @example
 * ```ts
 * import { getFeatureSignal, send, setTransport } from "aio/state-core";
 * ```
 */
// ZERO framework dependencies (no React, no DOM).
//
// Extracted from browser.ts's battle-tested delta pipeline (34 resolved issues)
// combined with aio-hooks.ts's signal-based state management.

import { batch, type Signal, signal } from "./signal.ts";
import { applyPatches, enablePatches, type Patch } from "immer";

enablePatches();

// ── Types ───────────────────────────────────────────────────────────

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

/** Feature reference — the __aio metadata from feature() factory. */
export interface FeatureRef {
  __aio: {
    id: string;
    actionKeys?: string[];
    actions?: Record<string, unknown>;
    state?: any;
  };
}

// ── Constants ───────────────────────────────────────────────────────

/** Prototype pollution guard — keys blocked from proxy/patch traversal. */
export const _BLOCKED_KEYS: Set<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const MAX_OFFLINE_QUEUE = 100;

// ── Module state ────────────────────────────────────────────────────

let _transport: Transport | null = null;

// Signals
let _stateSignal: Signal<Record<string, any>> = signal({});
let _connected: Signal<boolean> = signal<boolean>(false);
const _featureSignals = new Map<string, Signal<any>>();

// Ready promise
let _initialStateReceived = false;
let _readyResolve: ((state: any) => void) | null = null;
let _readyPromise = new Promise<any>((resolve) => {
  _readyResolve = resolve;
});

// Identity-keyed array maps: "feature.arrayKey" -> { ids: Map<id, element>, order: id[] }
const _idMaps = new Map<
  string,
  { ids: Map<string, unknown>; order: string[] }
>();

// Offline action queue (memory-only, no IndexedDB — framework-agnostic)
const _offlineQueue: any[] = [];

// ── Array ref stats (AIO-11 wasted render detection) ────────────────

/** Stats from `_preserveArrayRefs` — tracks how many references were preserved vs changed. */
export interface ArrayRefStats {
  preserved: number;
  changed: number;
  total: number;
  cycles: number;
}

let _arrayRefStats: ArrayRefStats = {
  preserved: 0,
  changed: 0,
  total: 0,
  cycles: 0,
};

/** Returns a snapshot of current array reference preservation stats. */
export function _getArrayRefStats(): ArrayRefStats {
  return { ..._arrayRefStats };
}

export function _resetArrayRefStats(): void {
  _arrayRefStats = { preserved: 0, changed: 0, total: 0, cycles: 0 };
}

/** Check if wasted renders are likely based on arrayRefStats + render status.
 *  Returns a warning string or null. Resets stats after check. */
export function _checkWastedRenders(status: string): string | null {
  const stats = _getArrayRefStats();
  _resetArrayRefStats();
  if (
    stats.total === 0 || stats.cycles < 3 ||
    status === "healthy" || status === "recovered"
  ) {
    return null;
  }
  const ratio = stats.preserved / stats.total;
  if (ratio <= 0.5) return null;
  return `[aio] WASTED RENDERS: _preserveArrayRefs preserved ${stats.preserved}/${stats.total} element refs (${
    Math.round(ratio * 100)
  }%), but render is ${status}. Your memo() comparators may be checking container references instead of element values. Use useProjection() for derived state and import { memo } from "aio" (not React). See docs/ui.md#derived-state--memo`;
}

// ── Shallow equality ────────────────────────────────────────────────

/** Shallow-equal comparison for one level of properties. */
export function _shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== "object" || typeof b !== "object" || a === null || b === null
  ) return false;
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  for (const k of ka) {
    if (!Object.hasOwn(objB, k) || objA[k] !== objB[k]) return false; // AIO-237: key-existence check
  }
  return true;
}

// ── Structural sharing for arrays ───────────────────────────────────

/** Preserve element references for unchanged items.
 *  Returns the previous array reference if ALL elements are unchanged. */
export function _preserveArrayRefs(
  newArr: unknown[],
  oldArr: unknown[],
): unknown[] {
  if (newArr.length !== oldArr.length) {
    _arrayRefStats.total += newArr.length;
    _arrayRefStats.changed += newArr.length;
    _arrayRefStats.cycles++;
    return newArr;
  }
  let allSame = true;
  let result: unknown[] | null = null; // AIO-257: lazy copy — never mutate input
  for (let i = 0; i < newArr.length; i++) {
    _arrayRefStats.total++;
    if (newArr[i] === oldArr[i]) {
      _arrayRefStats.preserved++;
      continue;
    }
    if (
      newArr[i] && typeof newArr[i] === "object" && !Array.isArray(newArr[i]) &&
      oldArr[i] && typeof oldArr[i] === "object" && !Array.isArray(oldArr[i])
    ) {
      if (_shallowEqual(newArr[i], oldArr[i])) {
        if (!result) result = newArr.slice();
        result[i] = oldArr[i]; // restore reference — element unchanged
        _arrayRefStats.preserved++;
        continue;
      }
    }
    _arrayRefStats.changed++;
    allSame = false;
  }
  _arrayRefStats.cycles++;
  return allSame ? oldArr : (result ?? newArr);
}

// ── Identity-keyed array maps ───────────────────────────────────────

/** @deprecated Legacy — remove after v1.0.0 stable. Only needed for $arr delta backward compat.
 *  Build _idMaps entries from a full state object. Called on full state receive and reconnect. */
export function _rebuildIdMaps(state: Record<string, unknown>): void {
  _idMaps.clear();
  for (const [fk, fv] of Object.entries(state)) {
    if (!fv || typeof fv !== "object" || Array.isArray(fv)) continue;
    for (const [sk, sv] of Object.entries(fv as Record<string, unknown>)) {
      if (!Array.isArray(sv) || sv.length === 0) continue;
      let allHaveId = true;
      for (const el of sv) {
        if (
          !el || typeof el !== "object" || Array.isArray(el) ||
          typeof (el as Record<string, unknown>).id !== "string"
        ) {
          allHaveId = false;
          break;
        }
      }
      if (!allHaveId) continue;
      const ids = new Map<string, unknown>();
      const order: string[] = [];
      for (const el of sv) {
        const id = (el as Record<string, unknown>).id as string;
        ids.set(id, el);
        order.push(id);
      }
      _idMaps.set(`${fk}.${sk}`, { ids, order });
    }
  }
}

/** @deprecated Legacy — remove after v1.0.0 stable. Server no longer produces $arr format.
 *  Apply a $arr identity-keyed array patch. Returns the reconstructed array. */
export function _applyArrPatch(
  mapKey: string,
  arrPatch: Record<string, unknown>,
): unknown[] {
  let entry = _idMaps.get(mapKey);
  if (!entry) {
    entry = { ids: new Map(), order: [] };
    _idMaps.set(mapKey, entry);
  }

  // Apply updates and additions
  for (const [k, v] of Object.entries(arrPatch)) {
    if (k === "$arr" || k === "$rm") continue;
    if (k.startsWith("$id:")) {
      const id = k.slice(4);
      if (!entry.ids.has(id)) {
        entry.order.push(id);
      }
      entry.ids.set(id, v);
    }
  }

  // Apply removals
  if (Array.isArray(arrPatch.$rm)) {
    for (const id of arrPatch.$rm) {
      if (typeof id === "string") {
        entry.ids.delete(id);
        const idx = entry.order.indexOf(id);
        if (idx !== -1) entry.order.splice(idx, 1);
      }
    }
  }

  // Reconstruct array from order — filter out any desynced entries
  const result: unknown[] = [];
  for (const id of entry.order) {
    const el = entry.ids.get(id);
    if (el !== undefined) {
      result.push(el);
    }
  }
  // Clean up desynced order entries
  entry.order = entry.order.filter((id) => entry!.ids.has(id));
  return result;
}

// ── Delta application ───────────────────────────────────────────────

/** @deprecated Legacy — remove after v1.0.0 stable. Server no longer produces $p/$d format.
 *  Apply a delta patch ($p + $d) to previous state. Handles nested feature patches (v0.5).
 *  Preserves object references for unchanged slices. */
export function _applyPatch(
  prev: Record<string, unknown> | null,
  data: { $p: Record<string, unknown>; $d?: string[] },
): Record<string, unknown> {
  const next = prev ? { ...prev } : {} as Record<string, unknown>;
  // Apply patches — shallow merge for nested object patches (feature slices)
  for (const [k, v] of Object.entries(data.$p)) {
    if (_BLOCKED_KEYS.has(k)) {
      continue;
    }
    if (
      v && typeof v === "object" && !Array.isArray(v) && next[k] &&
      typeof next[k] === "object" && !Array.isArray(next[k])
    ) {
      // Nested feature patch — shallow merge sub-keys (filter unsafe keys)
      const sub = v as Record<string, unknown>;
      const prev_slice = next[k] as Record<string, unknown>;
      const merged = { ...prev_slice };
      const arrPatchedKeys = new Set<string>();
      for (const [sk, sv] of Object.entries(sub)) {
        if (_BLOCKED_KEYS.has(sk) || sk === "$d") continue;
        // Identity-keyed array patch ($arr marker)
        if (
          sv && typeof sv === "object" && !Array.isArray(sv) &&
          (sv as Record<string, unknown>).$arr === true
        ) {
          merged[sk] = _applyArrPatch(
            `${k}.${sk}`,
            sv as Record<string, unknown>,
          );
          arrPatchedKeys.add(sk);
        } else if (Array.isArray(sv) && Array.isArray(prev_slice[sk])) {
          // Structural sharing: preserve per-element references for atomic array sub-keys
          merged[sk] = _preserveArrayRefs(
            sv as unknown[],
            prev_slice[sk] as unknown[],
          );
        } else {
          merged[sk] = sv;
        }
      }
      // Handle nested deletions ($d within the sub-patch)
      if (Array.isArray(sub.$d)) {
        for (const sk of sub.$d) {
          if (typeof sk === "string" && !_BLOCKED_KEYS.has(sk)) {
            if (arrPatchedKeys.has(sk)) {
              continue; // $arr patch supersedes deletion
            }
            delete merged[sk];
          }
        }
        delete merged.$d;
      }
      next[k] = merged;
      // Preserve reference if patch didn't actually change anything
      if (prev && _shallowEqual(merged, prev[k])) {
        next[k] = prev[k] as Record<string, unknown>;
      }
    } else {
      // Sanitize new objects — filter unsafe keys even for new top-level entries
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const safe: Record<string, unknown> = {};
        for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
          if (!_BLOCKED_KEYS.has(sk)) safe[sk] = sv;
        }
        next[k] = safe;
        // Preserve reference if new object is shallow-equal to previous
        if (prev && _shallowEqual(safe, prev[k])) {
          next[k] = prev[k] as Record<string, unknown>;
        }
      } else {
        next[k] = v;
      }
    }
  }
  // Top-level deletions
  if (Array.isArray(data.$d)) {
    for (const k of data.$d) {
      if (typeof k === "string" && !_BLOCKED_KEYS.has(k)) delete next[k];
    }
  }
  return next;
}

// ── Recursive deep merge for $f (filtered) responses ────────────────
// AIO-31: Two-level merge lost sub-sub-keys. Recursive merge only overwrites
// leaf values (primitives/arrays), preserving all object keys at every depth.
/** @deprecated Legacy — remove after v1.0.0 stable. Server no longer produces $f format.
 *  Recursive deep merge for `$f` (filtered) responses — preserves sub-keys at every depth. */
export function _deepMergeFiltered(
  prev: Record<string, unknown>,
  incoming: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 32) return prev; // AIO-238: depth limit — prevent stack overflow from malicious payloads
  const result: Record<string, unknown> = { ...prev };
  for (const key of Object.keys(incoming)) {
    if (_BLOCKED_KEYS.has(key)) continue; // AIO-238: prototype pollution guard
    const oldVal = prev[key];
    const newVal = incoming[key];
    if (
      oldVal && typeof oldVal === "object" && !Array.isArray(oldVal) &&
      newVal && typeof newVal === "object" && !Array.isArray(newVal)
    ) {
      result[key] = _deepMergeFiltered(
        oldVal as Record<string, unknown>,
        newVal as Record<string, unknown>,
        depth + 1,
      );
    } else {
      result[key] = newVal;
    }
  }
  return result;
}

// ── Feature signal management ───────────────────────────────────────

function _getOrCreateFeatureSignal(name: string, initial?: any): Signal<any> {
  let sig = _featureSignals.get(name);
  if (!sig) {
    sig = signal(initial);
    _featureSignals.set(name, sig);
  }
  return sig;
}

// ── Full state application ──────────────────────────────────────────

function _applyFullState(state: Record<string, any>): void {
  batch(() => {
    _stateSignal.set(state);
    for (const [key, value] of Object.entries(state)) {
      _getOrCreateFeatureSignal(key, value).set(value);
    }
    // AIO-189: remove feature signals for features no longer in state
    for (const key of _featureSignals.keys()) {
      if (!(key in state)) {
        _featureSignals.delete(key);
      }
    }
  });
  _rebuildIdMaps(state); // needed for legacy $arr delta backward compat
}

// ── Path-based deletion (including $id: identity array elements) ─────

/** @deprecated Legacy — remove after v1.0.0 stable. Server no longer produces path-delete format.
 *  Mutate state object for deep path deletions. Signal notifications are handled
 *  by the caller's batch() — this function must NOT fire signals (AIO-101). */
function _applyPathDelete(state: Record<string, any>, path: string): void {
  const parts = path.split(".");

  // Identity array element deletion: "feature.field.$id:KEY"
  const idIdx = parts.findIndex((p) => p.startsWith("$id:"));
  if (idIdx >= 0) {
    const mapKey = parts.slice(0, idIdx).join(".");
    const id = parts[idIdx]!.slice(4);
    const idMap = _idMaps.get(mapKey);
    if (idMap) {
      idMap.ids.delete(id);
      const orderIdx = idMap.order.indexOf(id);
      if (orderIdx >= 0) idMap.order.splice(orderIdx, 1);
      const arr = idMap.order.map((oid) => idMap.ids.get(oid)).filter(Boolean);
      const featureName = parts[0]!;
      const fieldName = parts.slice(1, idIdx).join(".");
      const featureState = {
        ...(state[featureName] as Record<string, unknown>),
      };
      featureState[fieldName] = arr;
      state[featureName] = featureState;
    }
    return;
  }

  // Simple path deletion
  if (parts.length === 1) {
    delete state[parts[0]!];
  } else {
    const featureName = parts[0]!;
    const featureState = { ...(state[featureName] as Record<string, unknown>) };
    let current: Record<string, unknown> = featureState;
    for (let i = 1; i < parts.length - 1; i++) {
      const val = current[parts[i]!];
      if (!val || typeof val !== "object" || Array.isArray(val)) return;
      current[parts[i]!] = {
        ...(current[parts[i]!] as Record<string, unknown>),
      };
      current = current[parts[i]!] as Record<string, unknown>;
    }
    delete current[parts[parts.length - 1]!];
    state[featureName] = featureState;
  }
}

// ── @deprecated Legacy delta application (signal-wired) — remove after v1.0.0 stable ──

function _applyDeltaToSignals(
  data: { $p?: Record<string, any>; $d?: string[]; $f?: number },
): void {
  const prev = _stateSignal.peek();

  // $f (filtered) — deep merge into existing state
  if (data.$f === 1 && data.$p) {
    batch(() => {
      const next = { ...prev };
      for (const [featureName, patch] of Object.entries(data.$p!)) {
        const featurePrev = (prev[featureName] ?? {}) as Record<
          string,
          unknown
        >;
        const featureNext = _deepMergeFiltered(
          featurePrev,
          patch as Record<string, unknown>,
        );
        next[featureName] = featureNext;
        _getOrCreateFeatureSignal(featureName, featureNext).set(featureNext);
      }
      _stateSignal.set(next);
    });
    return;
  }

  // Standard delta: use _applyPatch for $p, then _applyPathDelete for deep $d
  if (data.$p || data.$d) {
    // Separate simple top-level deletions (handled by _applyPatch) from
    // deep path deletions including $id: (handled by _applyPathDelete)
    const simpleDeletions: string[] = [];
    const deepDeletions: string[] = [];
    if (data.$d) {
      for (const path of data.$d) {
        if (typeof path === "string") {
          if (path.includes(".")) {
            deepDeletions.push(path);
          } else {
            simpleDeletions.push(path);
          }
        }
      }
    }

    const patchData = {
      $p: data.$p ?? {},
      $d: simpleDeletions.length > 0 ? simpleDeletions : undefined,
    };
    const next = _applyPatch(
      prev,
      patchData as { $p: Record<string, unknown>; $d?: string[] },
    );

    // Apply deep path deletions (including $id: identity array element removal)
    for (const path of deepDeletions) {
      _applyPathDelete(next, path);
    }

    batch(() => {
      _stateSignal.set(next);
      // Update per-feature signals for changed features
      if (data.$p) {
        for (const featureName of Object.keys(data.$p)) {
          if (_BLOCKED_KEYS.has(featureName)) continue;
          const featureState = next[featureName];
          _getOrCreateFeatureSignal(featureName, featureState).set(
            featureState,
          );
        }
      }
      // Handle deletions — update affected feature signals
      if (data.$d) {
        for (const path of data.$d) {
          if (typeof path === "string") {
            const featureName = path.split(".")[0]!;
            if (!_BLOCKED_KEYS.has(featureName)) {
              const sig = _featureSignals.get(featureName);
              if (sig) sig.set(next[featureName]);
            }
          }
        }
      }
    });
  }
}

// ── Subscription tracking ───────────────────────────────────────────

/** Tracked state paths accessed by the current client — used for server subscription filtering. */
export const _accessedPaths: Set<string> = new Set<string>();
let _subsTimer: ReturnType<typeof setTimeout> | null = null;
let _currentSubs: string[] = [];

/** Collapse paths: if "a.b" and "a.b.c.d" both tracked, keep only "a.b" */
export function collapsePaths(paths: Set<string> | string[]): string[] {
  const arr = Array.isArray(paths) ? paths : [...paths];
  const sorted = [...arr].sort();
  const result: string[] = [];
  for (const path of sorted) {
    if (result.length > 0) {
      const last = result[result.length - 1];
      if (last === "*" || path.startsWith(last + ".")) continue;
    }
    result.push(path);
  }
  return result;
}

/** Cancel the pending subscription update timer. */
export function cancelSubsTimer(): void {
  if (_subsTimer !== null) {
    clearTimeout(_subsTimer);
    _subsTimer = null;
  }
}

function _scheduleSyncSubs(): void {
  if (_subsTimer !== null) return;
  _subsTimer = setTimeout(() => {
    _subsTimer = null;
    if (_accessedPaths.size === 0) return;
    const collapsed = collapsePaths(_accessedPaths);
    if (
      collapsed.length !== _currentSubs.length ||
      collapsed.some((s, i) => s !== _currentSubs[i])
    ) {
      _currentSubs = collapsed;
      _sendSubsMessage(collapsed);
    }
  }, 16);
}

function _sendSubsMessage(subs: string[]): void {
  if (!_transport) return;
  const msg = "__subs:" + JSON.stringify(subs);
  _transport.send(msg);
}

/** Track a path for subscription syncing. */
export function trackPath(path: string): void {
  if (_accessedPaths.has(path)) return;
  _accessedPaths.add(path);
  _scheduleSyncSubs();
}

/** Re-send current subscription paths (call after reconnect). */
export function resendSubscriptions(): void {
  if (_currentSubs.length > 0) _sendSubsMessage(_currentSubs);
}

// ── Transport ───────────────────────────────────────────────────────

/** Set the abstract transport (WS adapter, IPC adapter, etc). */
export function setTransport(transport: Transport | null): void {
  _transport = transport;
  // AIO-183: reset initial state flag on reconnect so next message is
  // treated as full state, not patches applied to potentially stale state
  if (transport) {
    _initialStateReceived = false;
    flushOfflineQueue();
  }
}

/** Update connection status signal. */
export function setConnected(v: boolean): void {
  _connected.set(v);
}

// ── State access ────────────────────────────────────────────────────

/** Returns the root state signal — the canonical reactive state container. */
export function getStateSignal(): Signal<Record<string, any>> {
  return _stateSignal;
}

/** Returns a signal scoped to a specific feature's state slice. Creates one if it doesn't exist. */
export function getFeatureSignal(name: string, fallback?: any): Signal<any> {
  return _getOrCreateFeatureSignal(name, fallback);
}

/** Returns the connection status signal — `true` when transport is connected. */
export function getConnectedSignal(): Signal<boolean> {
  return _connected;
}

// ── Filtered state application (wire format: { $f:1, feat1:{...}, ... }) ──

/** @deprecated Legacy — remove after v1.0.0 stable. */
function _applyFilteredToSignals(data: Record<string, any>): void {
  const prev = _stateSignal.peek();
  const next = _deepMergeFiltered(prev, data);
  batch(() => {
    _stateSignal.set(next);
    for (const featureName of Object.keys(data)) {
      if (_BLOCKED_KEYS.has(featureName)) continue;
      _getOrCreateFeatureSignal(featureName, next[featureName]).set(
        next[featureName],
      );
    }
  });
  _rebuildIdMaps(next); // needed for legacy $arr delta backward compat
}

// ── Message handling ────────────────────────────────────────────────

/** Result of handleMessage — tells caller what happened. */
export type HandleResult = "full" | "delta" | "noop" | "dropped";

/** Process a message from the server (full state, delta, or filtered).
 *  CALLER is responsible for filtering browser signals (__reload, __css, __boot, etc.)
 *  before calling this — state-core has no browser-specific protocol knowledge.
 *  Returns what happened so caller can react (notify listeners, devtools, etc). */
export function handleMessage(data: any): HandleResult {
  if (!_initialStateReceived) {
    // Delta before first state — drop (reconnect race)
    if (data.$p || data.$d || data.$patches) return "dropped";
    // First message is full state (clean $f marker if present)
    const cleaned = data.$f ? { ...data } : data;
    if (cleaned !== data) delete cleaned.$f;
    _initialStateReceived = true;
    _applyFullState(cleaned);
    _accessedPaths.clear();
    cancelSubsTimer();
    if (_readyResolve) {
      _readyResolve(cleaned);
      _readyResolve = null;
    }
    return "full";
  }

  // Immer patches: { $patches: [{op, path, value}, ...] }
  if (data.$patches && Array.isArray(data.$patches)) {
    const prev = _stateSignal.peek();
    const patches: Patch[] = data.$patches;
    if (patches.length === 0) return "noop";

    try {
      const next = applyPatches(prev, patches);
      if (next === prev) return "noop";

      // Determine which features were affected
      const changedFeatures = new Set<string>();
      for (const p of patches) {
        if (p.path.length > 0 && typeof p.path[0] === "string") {
          changedFeatures.add(p.path[0]);
        }
      }

      batch(() => {
        _stateSignal.set(next);
        for (const featureName of changedFeatures) {
          if (_BLOCKED_KEYS.has(featureName)) continue;
          const featureState = (next as Record<string, unknown>)[featureName];
          _getOrCreateFeatureSignal(featureName, featureState).set(
            featureState,
          );
        }
      });
      return "delta";
    } catch (e) {
      // applyPatches failed — client state desynced, request full state from server
      console.warn("[aio] applyPatches failed, requesting resync:", e);
      if (_transport) _transport.send("__resync");
      return "noop";
    }
  }

  // @deprecated Legacy delta patch: { $p: {...}, $d: [...] } — remove after v1.0.0 stable
  // Server no longer produces this format; kept for cached old-format clients only.
  if (data.$p || data.$d) {
    const prev = _stateSignal.peek();
    _applyDeltaToSignals({ $p: data.$p, $d: data.$d });
    return _stateSignal.peek() === prev ? "noop" : "delta";
  }

  // Filtered state (wire format): { $f: 1, feat1: {...}, ... }
  if (data.$f) {
    const prev = _stateSignal.peek();
    const payload = { ...data };
    delete payload.$f;
    _applyFilteredToSignals(payload);
    return _stateSignal.peek() === prev ? "noop" : "delta";
  }

  // Safety: reject objects with wire-protocol markers as full state — prevents stale
  // client JS from interpreting patch/delta messages as full state replacement
  if (data.$patches || data.$p || data.$d || data.$f) {
    console.warn("[aio] unexpected wire marker in full-state path — dropped");
    return "noop";
  }

  // Full state replacement (reconnect / subscription response)
  // Do NOT clear _accessedPaths here — that nukes "*" from useAio() and causes
  // subsequent __subs messages to exclude features not read by useFeature() (AIO-170)
  _applyFullState(data);
  return "full";
}

// ── Send ────────────────────────────────────────────────────────────

/** Send an action via transport. Queues offline if no transport.
 *  Returns false if the action was dropped (offline queue full). */
export function send(action: { type: string; payload?: any }): boolean {
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

/** Flush queued offline actions through the current transport. */
export function flushOfflineQueue(): void {
  if (!_transport) return;
  for (const action of _offlineQueue) {
    _transport.send(JSON.stringify(action));
  }
  _offlineQueue.length = 0;
}

/** Create a typed send proxy for a feature.
 *  Uses action creators from ref.__aio.actions when available (structured payloads),
 *  falls back to { args } wrapper for method-style dispatch.
 *  Optional sendFn overrides the default send (e.g. browser.ts injects its own for DevTools/vitals). */
export function createSendProxy(
  featureName: string,
  ref: FeatureRef,
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
            type: action.type ?? `${featureName}:${methodName}`,
          });
        };
      }
      // Fallback: wrap args for spread-style dispatch
      return (...args: unknown[]) => {
        _sendAction({
          type: `${featureName}:${methodName}`,
          payload: { args },
        });
      };
    },
  });
}

// ── Tracking proxy ──────────────────────────────────────────────────
/** Deep proxy that records accessed state paths for server subscription filtering. */
export function _trackingProxy(obj: unknown, parentPath = ""): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  return new Proxy(obj as Record<string, unknown>, {
    get(target, prop: string | symbol) {
      if (typeof prop === "string" && !_BLOCKED_KEYS.has(prop)) {
        const fullPath = parentPath ? `${parentPath}.${prop}` : prop;
        const value = Reflect.get(target, prop);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          trackPath(fullPath); // AIO-206: track object access itself
          return _trackingProxy(value, fullPath);
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

/** Resolve feature state with fallback/defaults (AIO-29 defense).
 *  Merges incomplete feature state with defaults to prevent undefined crashes. */
export function _resolveWithFallback<S>(
  featureState: S | null | undefined,
  defaults: S | undefined,
): S {
  if (featureState == null) {
    return (defaults !== undefined ? defaults : featureState) as S;
  }
  if (
    defaults !== undefined &&
    typeof featureState === "object" && !Array.isArray(featureState) &&
    typeof defaults === "object" && !Array.isArray(defaults) &&
    defaults !== null
  ) {
    return {
      ...(defaults as Record<string, unknown>),
      ...(featureState as Record<string, unknown>),
    } as S;
  }
  return featureState as S;
}

// ── Lifecycle ───────────────────────────────────────────────────────

/** Promise resolving on first state. */
export function ready(): Promise<unknown> {
  return _readyPromise;
}

/** Whether initial state has been received. */
export function isInitialStateReceived(): boolean {
  return _initialStateReceived;
}

// ── Testing helpers ─────────────────────────────────────────────────

/** Inject state directly (for testing without transport). */
export function _injectState(state: Record<string, any>): void {
  _applyFullState(state);
  _initialStateReceived = true;
}

/** Inject a delta patch (for testing). */
export function _injectDelta(
  delta: { $p?: Record<string, any>; $d?: string[]; $f?: number },
): void {
  _applyDeltaToSignals(delta);
}

/** Get the current internal state (for testing). */
export function _getState(): Record<string, any> {
  return _stateSignal.peek();
}

/** Reset all internal state (for test isolation). */
export function _reset(): void {
  _transport = null;
  _stateSignal = signal({});
  _connected = signal(false);
  _featureSignals.clear();
  _idMaps.clear();
  _initialStateReceived = false;
  _offlineQueue.length = 0;
  _accessedPaths.clear();
  _currentSubs = [];
  cancelSubsTimer();
  // Reset ready promise
  _readyResolve = null;
  _readyPromise = new Promise<any>((resolve) => {
    _readyResolve = resolve;
  });
}
