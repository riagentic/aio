// deno-lint-ignore-file
// Browser-side aio module — bundled into dist/app.js for prod builds
// DOM types provided via compilerOptions.lib in deno.json
// Dev mode uses the AIO_UI_JS string in server.ts instead (served at /__aio/ui.js)
import {
  type ComponentType,
  createContext,
  createElement,
  memo as _reactMemo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Listeners } from "./listeners.ts";
import {
  createRenderMeter,
  renderHint,
  type RenderMeterAPI,
} from "./vitals/render-meter.ts";
import { createTransportProbeClient } from "./vitals/transport-probe.ts";
import {
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_THRESHOLDS,
} from "./vitals/types.ts";
import { formatDiagEvent } from "./vitals/diag-formatter.ts";
import type { DiagEvent } from "./vitals/types.ts";

/** Window properties used by AIO diagnostics (avoids `declare global` for JSR compat). */
interface AioWindow {
  _aioDiag?: (ev: Record<string, unknown>) => void;
  __aioConfig?: {
    renderBudget?: { staleness?: number; pendingPatches?: number };
  };
}

/** Typed accessor — `window` with AIO diagnostic extensions. */
const _w = typeof window !== "undefined"
  ? window as unknown as AioWindow & typeof globalThis
  : undefined;

const WS_MAX_QUEUE = 100;
const OFFLINE_MAX_QUEUE = 100; // max actions queued while disconnected (post-connect)
const OFFLINE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const _BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Emit a browser-side diagnostic event to the health overlay (dev mode only, 5s dedup) */
const _diagLastEmit = new Map<string, number>();
function _diagEmit(ev: {
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

// ── Array ref stats (AIO-11 wasted render detection) ────────────────
import type { ArrayRefStats } from "./vitals/types.ts";

let _arrayRefStats: ArrayRefStats = {
  preserved: 0,
  changed: 0,
  total: 0,
  cycles: 0,
};

export function _getArrayRefStats(): ArrayRefStats {
  return { ..._arrayRefStats };
}

export function _resetArrayRefStats(): void {
  _arrayRefStats = { preserved: 0, changed: 0, total: 0, cycles: 0 };
}

/** Check if wasted renders are likely based on arrayRefStats + render status.
 *  Returns a warning string or null. Resets stats after check. */
export function _checkWastedRenders(
  status: string,
): string | null {
  const stats = _getArrayRefStats();
  _resetArrayRefStats(); // reset for next measurement window
  if (
    stats.total === 0 || stats.cycles < 3 ||
    status === "healthy" || status === "recovered"
  ) {
    return null;
  }
  const ratio = stats.preserved / stats.total;
  if (ratio <= 0.5) return null; // most elements genuinely changed — not wasted
  return `[aio] WASTED RENDERS: _preserveArrayRefs preserved ${stats.preserved}/${stats.total} element refs (${
    Math.round(ratio * 100)
  }%), but render is ${status}. Your memo() comparators may be checking container references instead of element values. Use useProjection() for derived state and import { memo } from "aio" (not React). See docs/ui.md#derived-state--memo`;
}

/** Structural sharing for arrays: preserve element references for unchanged items.
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
        newArr[i] = oldArr[i]; // restore reference — element unchanged
        _arrayRefStats.preserved++;
        continue;
      }
    }
    _arrayRefStats.changed++;
    allSame = false;
  }
  _arrayRefStats.cycles++;
  return allSame ? oldArr : newArr;
}

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
    if (objA[k] !== objB[k]) return false;
  }
  return true;
}

/** Registry of identity-keyed arrays for per-element delta patching.
 *  Key: "feature.arrayKey", Value: { ids: id→element map, order: insertion-order id array } */
const _idMaps = new Map<
  string,
  { ids: Map<string, unknown>; order: string[] }
>();

/** Build _idMaps entries from a full state object. Called on full state receive and reconnect. */
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

/** Apply a $arr identity-keyed array patch. Returns the reconstructed array. */
function _applyArrPatch(
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
    } else {
      // order/ids desync — self-heal by removing stale id from order
      _diagEmit({
        type: "idmap-desync",
        severity: "warning",
        source: "browser",
        message:
          `_idMaps order/ids desync for id "${id}" in "${mapKey}" — skipped`,
        hint:
          "This may indicate a missed delta patch. State will self-correct on next full sync.",
      });
    }
  }
  // Clean up desynced order entries
  entry.order = entry.order.filter((id) => entry!.ids.has(id));
  return result;
}

/** Apply a delta patch ($p + $d) to previous state. Handles nested feature patches (v0.5).
 *  Preserves object references for unchanged slices (important for useSyncExternalStore selectors). */
export function _applyPatch(
  prev: Record<string, unknown> | null,
  data: { $p: Record<string, unknown>; $d?: string[] },
): Record<string, unknown> {
  const next = prev ? { ...prev } : {} as Record<string, unknown>;
  // Apply patches — shallow merge for nested object patches (feature slices)
  for (const [k, v] of Object.entries(data.$p)) {
    if (_BLOCKED_KEYS.has(k)) {
      _diagEmit({
        type: "state-key-stripped",
        severity: "warning",
        source: "browser",
        message: "State key '" + k +
          "' stripped — reserved JavaScript property name",
        detail: { key: k },
        hint: "Rename this state key. Reserved names: " +
          [..._BLOCKED_KEYS].join(", "),
      });
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
  // Preserve references: copy unchanged keys from prev (next was spread from prev,
  // so unchanged keys already share references — just need to avoid spreading when no patch)
  return next;
}

// ── Offline queue persistence (IndexedDB) ─────────────────────────────

const _offlineDB = "__aio_offline";
const _offlineStore = "queue";
const _offlineVersion = 1;
interface _QueuedAction {
  id?: number;
  action: { type: string; payload?: unknown };
  ts: number;
}
let _idb: IDBDatabase | null = null;
let _idbPromise: Promise<IDBDatabase | null> | null = null;

function _openIDB(): Promise<IDBDatabase | null> {
  if (_idb) return Promise.resolve(_idb);
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(_offlineDB, _offlineVersion);
      req.onerror = () => {
        _idbPromise = null;
        resolve(null);
      };
      req.onsuccess = () => {
        _idb = req.result;
        resolve(req.result);
      };
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(_offlineStore)) {
          db.createObjectStore(_offlineStore, {
            keyPath: "id",
            autoIncrement: true,
          });
        }
      };
    } catch {
      _idbPromise = null;
      resolve(null);
    }
  });
  return _idbPromise;
}

async function _loadOfflineQueue(): Promise<_QueuedAction[]> {
  const db = await _openIDB();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(_offlineStore, "readonly");
      const store = tx.objectStore(_offlineStore);
      const req = store.getAll();
      req.onerror = () => resolve([]);
      req.onsuccess = () => {
        const actions = req.result as _QueuedAction[];
        const cutoff = Date.now() - OFFLINE_MAX_AGE;
        resolve(actions.filter((a) => a.ts >= cutoff));
      };
    } catch (e) {
      _diagEmit({
        type: "offline-storage-error",
        severity: "info",
        source: "browser",
        message: "IndexedDB operation failed — offline persistence unavailable",
        detail: { error: String(e) },
        hint:
          "Offline action queue will use memory only. Check browser storage quota.",
      });
      resolve([]);
    }
  });
}

const MAX_OFFLINE_ACTIONS = 1000;
async function _saveOfflineAction(
  action: { type: string; payload?: unknown },
): Promise<void> {
  const db = await _openIDB();
  if (!db) return;
  try {
    const tx = db.transaction(_offlineStore, "readwrite");
    const store = tx.objectStore(_offlineStore);
    // Cap queue size to prevent unbounded storage growth
    const countReq = store.count();
    countReq.onsuccess = () => {
      if (countReq.result >= MAX_OFFLINE_ACTIONS) return; // drop — queue full
      store.add({ action, ts: Date.now() });
    };
  } catch (e) {
    _diagEmit({
      type: "offline-storage-error",
      severity: "info",
      source: "browser",
      message: "IndexedDB operation failed — offline persistence unavailable",
      detail: { error: String(e) },
      hint:
        "Offline action queue will use memory only. Check browser storage quota.",
    });
  }
}

async function _clearOfflineQueue(): Promise<void> {
  const db = await _openIDB();
  if (!db) return;
  try {
    const tx = db.transaction(_offlineStore, "readwrite");
    const store = tx.objectStore(_offlineStore);
    store.clear();
  } catch (e) {
    _diagEmit({
      type: "offline-storage-error",
      severity: "info",
      source: "browser",
      message: "IndexedDB operation failed — offline persistence unavailable",
      detail: { error: String(e) },
      hint:
        "Offline action queue will use memory only. Check browser storage quota.",
    });
  }
}

// ── IPC transport detection (UDS mode via Electron) ──────────────────
// When running in Electron with UDS transport, window.__aioIPC is exposed
// by the preload script. State sync goes: Deno UDS ↔ Electron main ↔ IPC ↔ renderer
type AioIPC = {
  send: (json: string) => void;
  ready: () => void; // signal to main that IPC listeners are registered
  onMessage: (fn: (line: string) => void) => void;
  onOpen: (fn: () => void) => void;
  onClose: (fn: () => void) => void;
};
const _ipc: AioIPC | null = (typeof window !== "undefined" &&
  (window as unknown as Record<string, unknown>).__aioIPC as AioIPC) || null;

// Singleton WebSocket — shared across all useAio() calls (one connection per page)
let _ws: WebSocket | null = null;
let _state: unknown = null;
let _queue: Array<{ type: string; payload?: unknown }> = [];
const _listeners = new Listeners<unknown>();
let _retry = 0;
let _closed = false;
let _connecting = false; // guard against concurrent _connect() calls
let _wasConnected = false; // false during initial connect, true after first open
let _offlineReady = false; // true when offline queue loaded from IndexedDB
let _offlineQueue: Array<{ type: string; payload?: unknown }> = []; // persisted actions
let _lastAction: { type: string; payload?: unknown } | null = null; // for DevTools correlation

// ── Deep proxy-tracked subscriptions ────────────────────────────────
// Records the exact state paths the UI reads during render. Leaf access
// (primitives, arrays) and ownKeys (iteration) record the full dot-path.
// Intermediate object access returns nested Proxies without recording.
// After render, paths are collapsed and sent to the server.

export const _accessedPaths = new Set<string>();
let _subsTimer: ReturnType<typeof setTimeout> | null = null;
let _currentSubs: string[] = [];

/** Deep recursive Proxy — tracks leaf access and iteration at any depth. */
export function _trackingProxy(obj: unknown, parentPath = ""): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  return new Proxy(obj as Record<string, unknown>, {
    get(target, prop: string | symbol) {
      if (typeof prop === "string" && !_BLOCKED_KEYS.has(prop)) {
        const fullPath = parentPath ? `${parentPath}.${prop}` : prop;
        const value = Reflect.get(target, prop);
        // Object (non-array) → return nested Proxy (user may go deeper)
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return _trackingProxy(value, fullPath);
        }
        // Leaf (primitive, array, null) → track the full path
        _accessedPaths.add(fullPath);
        _scheduleSyncSubs();
        return value;
      }
      return Reflect.get(target, prop);
    },
    ownKeys(target) {
      // Iterating keys = "I need everything at this level and below"
      _accessedPaths.add(parentPath || "*");
      _scheduleSyncSubs();
      return Reflect.ownKeys(target);
    },
  });
}

/** Collapse paths: if "a.b" and "a.b.c.d" both tracked, keep only "a.b" */
export function _collapsePaths(paths: Set<string>): string[] {
  const sorted = [...paths].sort();
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

function _scheduleSyncSubs(): void {
  if (_subsTimer !== null) return;
  _subsTimer = setTimeout(() => {
    _subsTimer = null;
    const collapsed = _collapsePaths(_accessedPaths);
    if (
      collapsed.length !== _currentSubs.length ||
      collapsed.some((s, i) => s !== _currentSubs[i])
    ) {
      _currentSubs = collapsed;
      _wsSendSubs(collapsed);
    }
  }, 16);
}

function _wsSendSubs(subs: string[]): void {
  const msg = "__subs:" + JSON.stringify(subs);
  if (_ws && _ws.readyState === WebSocket.OPEN) _ws.send(msg);
  if (_ipc && _ipcConnected) _ipc.send(msg);
}

/** Reset tracking state — for tests and _reset() */
export function _resetTracking(): void {
  _accessedPaths.clear();
  _currentSubs = [];
  if (_subsTimer !== null) {
    clearTimeout(_subsTimer);
    _subsTimer = null;
  }
}

// Time-travel state — populated when server sends __tt: messages (dev mode)
type TTMeta = {
  entries: {
    id: number;
    type: string;
    ts: number;
    perf?: {
      reduce: number;
      effects: number;
      budget: { reduce: number; effect: number };
    };
  }[];
  index: number;
  paused: boolean;
};
let _ttState: TTMeta | null = null;
const _ttListeners = new Listeners<TTMeta>();

// ── Vitals probes (client-side) ──────────────────────────────────────
let _vitalsRenderMeter: RenderMeterAPI | null = null;
let _vitalsUrlLogged = false;
let _vitalsTransportProbe:
  | ReturnType<typeof createTransportProbeClient>
  | null = null;
let _vitalsPingTimer: ReturnType<typeof setInterval> | null = null;
const _useAioWarned = new Set<string>();
let _useAioActiveCount = 0;
let _cleanupTimer: ReturnType<typeof setTimeout> | null = null;
let _listenerHighWater = 0; // peak listener count since last teardown — for diagnostics

// ── Built-in TT panel (pure DOM, no React) ────────────────────────
// Toggled via Ctrl+. (period), auto-registered on first __tt: message

let _ttPanel: HTMLElement | null = null;
let _ttPanelVisible = false;
let _ttKeyBound = false;

// ── Connection status indicator (pure DOM) ──────────────────────────
let _statusEl: HTMLElement | null = null;
let _statusTimer: ReturnType<typeof setTimeout> | null = null;
let _statusStyleInjected = false;

function _injectStatusStyle(): void {
  if (_statusStyleInjected) return;
  _statusStyleInjected = true;
  const style = document.createElement("style");
  style.textContent =
    "@keyframes __aio-pulse{0%,100%{opacity:1}50%{opacity:.5}}";
  document.head.appendChild(style);
}

function _showStatus(text: string, color: string, autohide?: number): void {
  if (
    (window as unknown as Record<string, unknown>).__aioShowStatus === false
  ) return;
  _injectStatusStyle();
  if (_statusTimer) {
    clearTimeout(_statusTimer);
    _statusTimer = null;
  }
  if (!_statusEl) {
    _statusEl = document.createElement("div");
    _statusEl.style.cssText =
      "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:99999;" +
      "font:12px/1 monospace;padding:6px 14px;border-radius:20px;" +
      "background:rgba(240,240,245,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);" +
      "border:1px solid rgba(0,0,0,.12);box-shadow:0 4px 16px rgba(0,0,0,.12);" +
      "transition:opacity .3s;pointer-events:none;";
    document.body.appendChild(_statusEl);
  }
  _statusEl.textContent = text;
  _statusEl.style.color = color;
  _statusEl.style.opacity = "1";
  _statusEl.style.animation = autohide
    ? "none"
    : "__aio-pulse 2s ease-in-out infinite";
  if (autohide) {
    _statusTimer = setTimeout(() => {
      if (_statusEl) _statusEl.style.opacity = "0";
    }, autohide);
  }
}

function _hideStatus(): void {
  if (_statusEl) _statusEl.style.opacity = "0";
  if (_statusTimer) {
    clearTimeout(_statusTimer);
    _statusTimer = null;
  }
}

function _sendTTCmd(cmd: string): void {
  if (_ws && _ws.readyState === WebSocket.OPEN) _ws.send(cmd);
}

function _renderTTPanel(): void {
  if (!_ttState) return;

  if (!_ttPanel) {
    _ttPanel = document.createElement("div");
    _ttPanel.id = "__aio-tt";
    _ttPanel.style.cssText =
      "position:fixed;bottom:12px;right:12px;z-index:99999;width:280px;max-height:420px;" +
      "background:rgba(240,240,245,.92);color:#333;border:1px solid rgba(0,0,0,.12);border-radius:10px;" +
      "font:12px/1.5 monospace;box-shadow:0 8px 32px rgba(0,0,0,.15);display:none;flex-direction:column;" +
      "overflow:hidden;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);";
    document.body.appendChild(_ttPanel);
  }

  const tt = _ttState;
  const atStart = tt.index <= 0;
  const atEnd = tt.index >= tt.entries.length - 1;

  _ttPanel.innerHTML = "";

  // Header — draggable
  const hdr = document.createElement("div");
  hdr.style.cssText =
    "padding:8px 10px;background:rgba(0,0,0,.05);border-bottom:1px solid rgba(0,0,0,.08);" +
    "display:flex;align-items:center;justify-content:space-between;cursor:grab;";
  hdr.innerHTML =
    `<span style="color:#666;font-weight:600">⏱ time-travel</span>` +
    `<span style="color:#999;font-size:11px">${
      tt.index + 1
    }/${tt.entries.length}${
      tt.paused ? ' <span style="color:#e25">🔒</span>' : ""
    }</span>`;
  _ttPanel.appendChild(hdr);

  // Drag logic
  let dragX = 0, dragY = 0;
  hdr.onmousedown = (e) => {
    e.preventDefault();
    dragX = e.clientX - _ttPanel!.offsetLeft;
    dragY = e.clientY - _ttPanel!.offsetTop;
    hdr.style.cursor = "grabbing";
    const onMove = (ev: MouseEvent) => {
      _ttPanel!.style.left = (ev.clientX - dragX) + "px";
      _ttPanel!.style.top = (ev.clientY - dragY) + "px";
      _ttPanel!.style.right = "auto";
      _ttPanel!.style.bottom = "auto";
    };
    const onUp = () => {
      hdr.style.cursor = "grab";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // Buttons
  const bar = document.createElement("div");
  bar.style.cssText =
    "padding:6px 10px;display:flex;gap:4px;border-bottom:1px solid rgba(0,0,0,.08);";
  const btnStyle =
    "padding:3px 8px;border:1px solid rgba(0,0,0,.12);border-radius:5px;background:rgba(0,0,0,.06);" +
    "color:#444;cursor:pointer;font:11px monospace;";
  const btnDisabled = btnStyle +
    "opacity:0.3;cursor:default;pointer-events:none;";

  const mkBtn = (
    label: string,
    onclick: () => void,
    disabled = false,
  ): HTMLButtonElement => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = disabled ? btnDisabled : btnStyle;
    if (!disabled) {
      b.onclick = onclick;
      b.onmouseenter = () => {
        b.style.background = "rgba(0,0,0,.1)";
      };
      b.onmouseleave = () => {
        b.style.background = "rgba(0,0,0,.06)";
      };
    }
    return b;
  };

  bar.appendChild(mkBtn("◀ undo", () => _sendTTCmd("__tt:undo"), atStart));
  bar.appendChild(mkBtn("redo ▶", () => _sendTTCmd("__tt:redo"), atEnd));
  bar.appendChild(
    mkBtn(
      tt.paused ? "🔓 unlock" : "🔒 lock",
      () => _sendTTCmd(tt.paused ? "__tt:resume" : "__tt:pause"),
    ),
  );
  _ttPanel.appendChild(bar);

  // Entry list
  const list = document.createElement("div");
  list.style.cssText = "overflow-y:auto;max-height:300px;padding:4px 0;";
  for (let i = tt.entries.length - 1; i >= 0; i--) {
    const e = tt.entries[i]!;
    const row = document.createElement("div");
    const isCurrent = i === tt.index;
    row.style.cssText =
      "padding:3px 10px;cursor:pointer;display:flex;justify-content:space-between;" +
      (isCurrent
        ? "background:rgba(0,0,0,.08);color:#111;font-weight:600;"
        : "color:#555;");
    row.onmouseenter = () => {
      if (!isCurrent) row.style.background = "rgba(0,0,0,.04)";
    };
    row.onmouseleave = () => {
      if (!isCurrent) row.style.background = "transparent";
    };
    row.onclick = () => _sendTTCmd("__tt:goto:" + e.id);

    const name = document.createElement("span");
    name.textContent = (isCurrent ? "▸ " : "  ") + e.type;
    name.style.cssText =
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;";
    row.appendChild(name);

    // Performance timing (dev mode)
    const right = document.createElement("span");
    right.style.cssText =
      "color:#aaa;flex-shrink:0;margin-left:8px;font-size:10px;display:flex;gap:6px;";

    if (e.perf) {
      const reduceColor = e.perf.reduce > e.perf.budget.reduce
        ? "#e25"
        : "#666";
      const effectColor = e.perf.effects > e.perf.budget.effect
        ? "#e25"
        : "#666";
      right.innerHTML =
        `<span style="color:${reduceColor}">${
          Math.round(e.perf.reduce)
        }ms</span>` +
        `<span style="color:${effectColor}">${
          Math.round(e.perf.effects)
        }ms</span>`;
    } else {
      const d = new Date(e.ts);
      right.textContent = `${String(d.getHours()).padStart(2, "0")}:${
        String(d.getMinutes()).padStart(2, "0")
      }:${String(d.getSeconds()).padStart(2, "0")}`;
    }
    row.appendChild(right);

    list.appendChild(row);
  }
  _ttPanel.appendChild(list);

  // Footer
  const foot = document.createElement("div");
  foot.style.cssText =
    "padding:4px 10px;border-top:1px solid rgba(0,0,0,.08);color:#aaa;font-size:10px;text-align:center;";
  foot.textContent = "Ctrl+. to toggle";
  _ttPanel.appendChild(foot);

  _ttPanel.style.display = _ttPanelVisible ? "flex" : "none";
}

let _ttKeyHandler: ((e: KeyboardEvent) => void) | null = null;
function _bindTTKey(): void {
  if (_ttKeyBound) return;
  _ttKeyBound = true;
  console.log(
    "%c[aio] ⏱ time-travel active — Ctrl+. to toggle panel",
    "color:#e94560;font-weight:bold",
  );
  _ttKeyHandler = (e: KeyboardEvent) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "Period") {
      e.preventDefault();
      _ttPanelVisible = !_ttPanelVisible;
      if (_ttPanelVisible) _renderTTPanel();
      if (_ttPanel) _ttPanel.style.display = _ttPanelVisible ? "flex" : "none";
    }
  };
  document.addEventListener("keydown", _ttKeyHandler);
}

/** Notifies all React subscribers of state change */
function _notify() {
  _listeners.notify(_state);
}

// ── useSyncExternalStore glue ───────────────────────────────────────
let _stateVersion = 0;

// ── State readiness — resolves when first state arrives ─────────────
let _stateReadyResolve: (() => void) | null = null;
let _stateReadyPromise: Promise<void> | null = null;

/** Returns a Promise that resolves when _state becomes non-null.
 *  Used by the HTML template to delay React mount until state is available. */
export function _waitForState(): Promise<void> {
  if (_state !== null) return Promise.resolve();
  if (!_stateReadyPromise) {
    _stateReadyPromise = new Promise<void>((resolve) => {
      _stateReadyResolve = resolve;
    });
  }
  // Eagerly start connection so state can arrive
  if (!_ws && !_ipcConnected && !_connecting) {
    _closed = false;
    _connecting = true;
    _connect();
  }
  return _stateReadyPromise;
}

/** Called from _notify() when state first arrives — resolves the readiness promise. */
function _resolveStateReady(): void {
  if (_stateReadyResolve) {
    _stateReadyResolve();
    _stateReadyResolve = null;
    _stateReadyPromise = null;
  }
}

/** Stable subscribe for useAio() — wraps _subscribe with active-count tracking.
 *  Module-scoped so useSyncExternalStore sees a stable reference (no re-subscription). */
export const _useAioSubscribe = (onStoreChange: () => void): () => void => {
  _useAioActiveCount++;
  const unsub = _subscribe(onStoreChange);
  return () => {
    _useAioActiveCount--;
    unsub();
  };
};

/** Subscribe callback for useSyncExternalStore — manages connection lifecycle */
export function _subscribe(onStoreChange: () => void): () => void {
  const unsub = _listeners.add(() => {
    onStoreChange();
  });
  // Track peak listener count for diagnostic context
  if (_listeners.size > _listenerHighWater) {
    _listenerHighWater = _listeners.size;
  }
  if (!_ws && !_ipcConnected && !_connecting) {
    _closed = false;
    _connecting = true;
    _connect();
    // Re-register popstate listener if it was cleaned up
    if (!_popstateHandler && typeof window !== "undefined") {
      _popstateHandler = _rSync;
      addEventListener("popstate", _popstateHandler);
    }
  }
  return () => {
    unsub();
    if (_listeners.size === 0) {
      if (_cleanupTimer) clearTimeout(_cleanupTimer);
      const peakCount = _listenerHighWater;
      _cleanupTimer = setTimeout(() => {
        _cleanupTimer = null;
        if (_listeners.size === 0) {
          // Legitimate teardown — 300ms with zero listeners
          console.warn(
            `[aio] teardown — no listeners for 300ms (peak was ${peakCount}). Closing connection, clearing state.`,
          );
          _diagEmit({
            type: "teardown",
            severity: "warning",
            source: "browser",
            message: "Full teardown — no listeners remained after grace period",
            detail: { graceMs: 300, peakListenerCount: peakCount },
          });
          _closed = true;
          _ws?.close();
          _ws = null;
          _ipcConnected = false;
          _connecting = false;
          _state = null;
          _stateReadyPromise = null;
          _stateReadyResolve = null;
          _queue = [];
          _retry = 0;
          _listenerHighWater = 0;
          _idMaps.clear();
          if (_vitalsRenderMeter) {
            _vitalsRenderMeter.destroy();
            _vitalsRenderMeter = null;
          }
          // Clean up global listeners to prevent leaks
          if (_ttKeyHandler) {
            document.removeEventListener("keydown", _ttKeyHandler);
            _ttKeyHandler = null;
            _ttKeyBound = false;
          }
          if (_popstateHandler) {
            removeEventListener("popstate", _popstateHandler);
            _popstateHandler = null;
          }
        } else {
          // Transient gap — listeners recovered within grace period
          console.warn(
            `[aio] teardown averted — listeners dropped to 0 but recovered to ${_listeners.size} within 300ms`,
          );
          _diagEmit({
            type: "teardown-averted",
            severity: "info",
            source: "browser",
            message: "Transient listener gap — teardown cancelled",
            detail: { recoveredCount: _listeners.size },
          });
        }
      }, 300);
    }
  };
}

function _getSnapshot(): unknown {
  return _state;
}
function _getServerSnapshot(): unknown {
  return null;
}

let _bootId: string | null = null; // server boot ID — reload page if server restarted

let _ipcConnected = false;
let _ipcPingTimer: ReturnType<typeof setInterval> | null = null;
const _IPC_PING_INTERVAL = 60_000; // 60s keepalive — defense-in-depth for UDS

/** Connects via Electron IPC bridge (UDS mode) — messages are NDJSON lines */
function _connectIPC() {
  if (!_ipc || _ipcConnected) return;
  _ipcConnected = true;

  _ipc.onOpen(() => {
    _retry = 0;
    if (_wasConnected) _showStatus("Connected", "#2a2", 2000);
    _wasConnected = true;
    // Drain memory queue
    const q = _queue;
    _queue = [];
    for (const a of q) _ipc!.send(JSON.stringify(a));
    // IPC keepalive — prevents stale connection detection in edge cases
    if (!_ipcPingTimer) {
      _ipcPingTimer = setInterval(() => {
        if (_ipc && _ipcConnected) _ipc.send("__ping");
      }, _IPC_PING_INTERVAL);
    }
  });

  _ipc.onMessage((line: string) => {
    if (line === "__reload") {
      location.reload();
      return;
    }
    if (line === "__css") {
      document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
        const el = link as HTMLLinkElement;
        if (el.href.startsWith(location.origin)) {
          el.href = el.href.split("?")[0] + "?t=" + Date.now();
        }
      });
      return;
    }
    if (line === "__getState") {
      try {
        _ipc!.send("__clientState:" + JSON.stringify(_walkReactTree()));
      } catch (err) {
        _ipc!.send('__clientState:{"error":"' + String(err) + '"}');
      }
      return;
    }
    if (line.startsWith("__click:")) {
      const result = _handleClick(line.slice(8));
      _ipc!.send("__clientState:" + JSON.stringify(result));
      return;
    }
    if (line.startsWith("__tt:")) {
      try {
        _ttState = JSON.parse(line.slice(5));
        _bindTTKey();
        _ttListeners.notify(_ttState!);
        if (_ttPanelVisible) _renderTTPanel();
      } catch (err) {
        console.warn("[aio] bad __tt: data:", err);
      }
      return;
    }
    if (line.startsWith("__diag:")) {
      try {
        const ev = JSON.parse(line.slice(7));
        if (_w && typeof _w._aioDiag === "function") _w._aioDiag(ev);
      } catch { /* ignore malformed diag */ }
      return;
    }
    if (line.startsWith("__boot:")) {
      const id = line.slice(7);
      if (_bootId && _bootId !== id) return location.reload();
      _bootId = id;
      return;
    }
    try {
      const data = JSON.parse(line);
      if (data === null || typeof data !== "object") return;
      const prev = _state;
      if (data.$p && typeof data.$p === "object") {
        if (_state === null) {
          _diagEmit({
            type: "delta-before-state",
            severity: "warning",
            source: "browser",
            message: "Delta patch received before full state (IPC) — dropped",
            hint:
              "This usually means a reconnect race. The next full state sync will correct this.",
          });
          return;
        }
        _state = _applyPatch(_state as Record<string, unknown>, data);
      } else {
        _state = data;
        // Full state — rebuild identity maps and reset path tracking
        // All components re-render on full state, so paths are re-collected naturally
        if (_state && typeof _state === "object" && !Array.isArray(_state)) {
          _rebuildIdMaps(_state as Record<string, unknown>);
        }
        _accessedPaths.clear();
      }
      if (_state === prev) return; // no-op patch — skip notification

      // Synchronous bookkeeping
      _stateVersion++;
      if (_state !== null) _resolveStateReady();

      // Deferred React notification via RenderMeter
      if (_vitalsRenderMeter) {
        _vitalsRenderMeter.recordPatch();
        _vitalsRenderMeter.markDirty();
      } else {
        // Fallback if meter not yet initialized (initial connect)
        _listeners.notify(_state);
      }

      // DevTools
      if (_devtoolsConnected && _lastAction) {
        _sendDevTools(_lastAction, _state);
        _lastAction = null;
      }
    } catch (err) {
      console.warn("[aio] bad state message:", err);
      _diagEmit({
        type: "state-sync-error",
        severity: "error",
        source: "browser",
        message: "Failed to parse state message from server",
        detail: { error: String(err) },
        hint:
          "Server sent malformed state. Check for serialization bugs on the server side.",
      });
    }
  });

  _ipc.onClose(() => {
    _ipcConnected = false;
    if (_ipcPingTimer) {
      clearInterval(_ipcPingTimer);
      _ipcPingTimer = null;
    }
    if (_closed || _listeners.size === 0) return;
    if (_wasConnected) _showStatus("Reconnecting\u2026", "#e25");
  });

  // Signal to Electron main that listeners are ready — triggers replay of buffered state
  _ipc.ready();
}

/** Opens connection to server — UDS+IPC when available, WebSocket otherwise */
function _connect() {
  if (_closed) return;

  // UDS mode: Electron IPC bridge — no WebSocket needed
  if (_ipc && !_ws) {
    _connectIPC();
    return;
  }

  if (_ws) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const tokenParam = new URLSearchParams(location.search).get("token");
  const wsUrl = proto + "//" + location.host + "/ws" +
    (tokenParam ? "?token=" + tokenParam : "");
  const ws = new WebSocket(wsUrl);
  ws.onopen = async () => {
    _connecting = false;
    _retry = 0;
    ws.send(
      "__type:" +
        (typeof navigator !== "undefined" &&
            /electron/i.test(navigator.userAgent)
          ? "electron"
          : "browser"),
    );
    if (_wasConnected) _showStatus("Connected", "#2a2", 2000);
    _wasConnected = true;

    // Re-send tracked subscriptions on reconnect
    if (_currentSubs.length > 0) {
      ws.send("__subs:" + JSON.stringify(_currentSubs));
    }

    // Flush memory queue (initial connect race)
    const q = _queue;
    _queue = [];
    for (const a of q) ws.send(JSON.stringify(a));

    // Load and replay offline queue (persisted during disconnect)
    if (!_offlineReady) {
      const persisted = await _loadOfflineQueue();
      _offlineQueue = persisted.map((p) => p.action);
      _offlineReady = true;
    }
    // Guard: socket may have closed during async _loadOfflineQueue
    if (ws.readyState !== WebSocket.OPEN) return;
    if (_offlineQueue.length) {
      console.log(`[aio] replaying ${_offlineQueue.length} offline actions`);
      for (const a of _offlineQueue) ws.send(JSON.stringify(a));
      _offlineQueue = [];
      _clearOfflineQueue().catch(() => {});
    }

    // Initialize vitals render meter
    if (!_vitalsRenderMeter) {
      const _rb = _w?.__aioConfig?.renderBudget;
      _vitalsRenderMeter = createRenderMeter({
        thresholds: _rb
          ? { staleness: _rb.staleness, pendingPatches: _rb.pendingPatches }
          : undefined,
        onNotify: _notify,
        onStatusChange: (status, gauges) => {
          if (status !== "healthy" && !_vitalsUrlLogged) {
            _vitalsUrlLogged = true;
            console.warn(
              `[aio:vitals] dashboard at ${location.origin}/__aio/vitals`,
            );
          }
          if (status === "frozen" || status === "recovered") {
            const kind = status === "frozen"
              ? "freeze" as const
              : "recovered" as const;
            const event: DiagEvent = {
              kind,
              severity: kind === "freeze" ? "likely" : "speculative",
              summary: kind === "freeze"
                ? `RENDER FROZEN — staleness ${
                  Math.round(gauges.staleness.current)
                }ms`
                : "render recovered",
              detail: {
                trigger: _vitalsRenderMeter?.getLastAction() ?? undefined,
              },
              timestamp: Date.now(),
            };
            const lines = formatDiagEvent(event);
            if (lines.length === 1) console.warn(lines[0]);
            else {
              console.group(lines[0]);
              for (let i = 1; i < lines.length; i++) console.warn(lines[i]);
              console.groupEnd();
            }
          } else if (status === "degraded" || status === "warning") {
            // AIO-11: Check for wasted renders (high preservation but still degraded)
            const wastedWarning = _checkWastedRenders(status);
            if (wastedWarning) {
              console.warn(wastedWarning);
            }
            const event: DiagEvent = {
              kind: "pressure",
              severity: status === "degraded" ? "speculative" : "possible",
              summary: `STALENESS ${status.toUpperCase()} — ${
                Math.round(gauges.staleness.current)
              }ms behind`,
              detail: {
                hint: renderHint(gauges) ??
                  "check component complexity and update frequency",
              },
              timestamp: Date.now(),
            };
            const lines = formatDiagEvent(event);
            if (lines.length === 1) console.warn(lines[0]);
            else {
              console.group(lines[0]);
              for (let i = 1; i < lines.length; i++) console.warn(lines[i]);
              console.groupEnd();
            }
          }
        },
      });
    }
    if (!_vitalsTransportProbe) {
      _vitalsTransportProbe = createTransportProbeClient({
        thresholds: DEFAULT_THRESHOLDS,
        interval: DEFAULT_HEARTBEAT_INTERVAL,
      });
    }
    if (!_vitalsPingTimer) {
      _vitalsPingTimer = setInterval(() => {
        if (_ws && _ws.readyState === WebSocket.OPEN && _vitalsTransportProbe) {
          const ping = _vitalsTransportProbe.createPing();
          const ms = _vitalsRenderMeter
            ? Math.round(_vitalsRenderMeter.getStaleness())
            : 0;
          _ws.send("__vitals:ping:" + JSON.stringify({ t1: ping.t1, ms }));
        }
      }, DEFAULT_HEARTBEAT_INTERVAL);
    }
  };
  ws.onmessage = (e) => {
    if (e.data === "__reload") {
      _closed = true;
      ws.close();
      return location.reload();
    }
    if (e.data === "__css") {
      document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
        const el = link as HTMLLinkElement;
        if (el.href.startsWith(location.origin)) {
          el.href = el.href.split("?")[0] + "?t=" + Date.now();
        }
      });
      return;
    }
    // Client UI request (dev mode) — respond with React component tree
    if (e.data === "__getState") {
      try {
        ws.send("__clientState:" + JSON.stringify(_walkReactTree()));
      } catch (err) {
        ws.send('__clientState:{"error":"' + String(err) + '"}');
      }
      return;
    }
    // Client click command (dev mode) — click a component's DOM node
    if (typeof e.data === "string" && e.data.startsWith("__click:")) {
      const result = _handleClick(e.data.slice(8));
      ws.send("__clientState:" + JSON.stringify(result));
      return;
    }
    // Time-travel metadata from server
    if (typeof e.data === "string" && e.data.startsWith("__tt:")) {
      try {
        _ttState = JSON.parse(e.data.slice(5));
        _bindTTKey();
        _ttListeners.notify(_ttState!);
        if (_ttPanelVisible) _renderTTPanel();
      } catch (err) {
        console.warn("[aio] bad __tt: data:", err);
      }
      return;
    }
    // Vitals pong from server
    if (typeof e.data === "string" && e.data.startsWith("__vitals:pong:")) {
      try {
        const pong = JSON.parse(e.data.slice(14));
        if (_vitalsTransportProbe) {
          _vitalsTransportProbe.processPong(pong);
        }
      } catch (err) {
        console.warn("[aio:vitals] bad pong:", err);
      }
      return;
    }
    // Diagnostic bus event from server (dev mode)
    if (typeof e.data === "string" && e.data.startsWith("__diag:")) {
      try {
        const ev = JSON.parse(e.data.slice(7));
        if (_w && typeof _w._aioDiag === "function") _w._aioDiag(ev);
      } catch { /* ignore malformed diag */ }
      return;
    }
    // Boot ID — reload page if server restarted (stale JS in memory)
    if (typeof e.data === "string" && e.data.startsWith("__boot:")) {
      const id = e.data.slice(7);
      if (_bootId && _bootId !== id) return location.reload();
      _bootId = id;
      return;
    }
    try {
      const data = JSON.parse(e.data);
      if (data === null || typeof data !== "object") {
        console.warn("[aio] unexpected state type:", typeof data);
        return;
      }
      const prev = _state;
      if (data.$p && typeof data.$p === "object") {
        if (_state === null) {
          _diagEmit({
            type: "delta-before-state",
            severity: "warning",
            source: "browser",
            message: "Delta patch received before full state (WS) — dropped",
            hint:
              "This usually means a reconnect race. The next full state sync will correct this.",
          });
          return;
        }
        _state = _applyPatch(_state as Record<string, unknown>, data);
      } else {
        _state = data;
        // Full state — rebuild identity maps and reset path tracking
        // All components re-render on full state, so paths are re-collected naturally
        if (_state && typeof _state === "object" && !Array.isArray(_state)) {
          _rebuildIdMaps(_state as Record<string, unknown>);
        }
        _accessedPaths.clear();
      }
      if (_state === prev) return; // no-op patch — skip notification

      // Synchronous bookkeeping
      _stateVersion++;
      if (_state !== null) _resolveStateReady();

      // Deferred React notification via RenderMeter
      if (_vitalsRenderMeter) {
        _vitalsRenderMeter.recordPatch();
        _vitalsRenderMeter.markDirty();
      } else {
        // Fallback if meter not yet initialized (initial connect)
        _listeners.notify(_state);
      }

      // DevTools
      if (_devtoolsConnected && _lastAction) {
        _sendDevTools(_lastAction, _state);
        _lastAction = null;
      }
    } catch (err) {
      console.warn("[aio] bad state message:", err);
      _diagEmit({
        type: "state-sync-error",
        severity: "error",
        source: "browser",
        message: "Failed to parse state message from server",
        detail: { error: String(err) },
        hint:
          "Server sent malformed state. Check for serialization bugs on the server side.",
      });
    }
  };
  ws.onerror = () => {
    _connecting = false;
    console.warn("[aio] connection error");
  };
  ws.onclose = () => {
    _ws = null;
    _connecting = false;
    if (_vitalsPingTimer) {
      clearInterval(_vitalsPingTimer);
      _vitalsPingTimer = null;
    }
    if (_closed || _listeners.size === 0) return;
    if (_wasConnected) _showStatus("Reconnecting\u2026", "#e25");
    // exponential backoff: 1s → 2s → 4s → 8s max, with ±20% jitter
    const base = Math.min(1000 * Math.pow(2, _retry), 8000);
    _retry++;
    console.warn(
      `[aio] disconnected, retrying in ${(base / 1000).toFixed(1)}s...`,
    );
    setTimeout(_connect, base * (0.8 + Math.random() * 0.4));
  };
  _ws = ws;
}

/** Sends action via IPC or WS — queues to memory during initial connect, persists to IndexedDB when disconnected */
function _send(action: { type: string; payload?: unknown }) {
  _lastAction = action; // track for DevTools
  if (_vitalsRenderMeter) {
    const actionType = typeof action === "object" && action !== null
      ? (action as Record<string, unknown>).type as string ?? ""
      : "";
    const feature = actionType.split("/")[0] ?? actionType.split(":")[0] ?? "";
    _vitalsRenderMeter.recordAction(actionType, feature);
  }
  // UDS+IPC mode — send via Electron IPC bridge
  if (_ipc && _ipcConnected) {
    _ipc.send(JSON.stringify(action));
    return;
  }
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(action));
  } else if (!_wasConnected && _queue.length < WS_MAX_QUEUE) {
    // Initial connect race — WS not ready yet
    _queue.push(action);
  } else if (_wasConnected) {
    // Disconnected after initial connection started — persist offline (capped to prevent OOM)
    if (_offlineQueue.length < OFFLINE_MAX_QUEUE) {
      _offlineQueue.push(action);
      _saveOfflineAction(action).catch(() => {}); // best-effort
    } else {
      _diagEmit({
        type: "action-dropped",
        severity: "warning",
        source: "browser",
        message: "Action '" + action.type + "' dropped — offline queue full (" +
          OFFLINE_MAX_QUEUE + ")",
        detail: { actionType: action.type, queueSize: _offlineQueue.length },
        hint:
          "Check network connection. Actions are queued when disconnected but the queue has a limit.",
      });
    }
  } else {
    _diagEmit({
      type: "action-dropped",
      severity: "warning",
      source: "browser",
      message: "Action '" + action.type + "' dropped — connect queue full (" +
        WS_MAX_QUEUE + ")",
      detail: { actionType: action.type, queueSize: _queue.length },
      hint: "Server may be slow to respond. Check terminal for errors.",
    });
  }
}

// ── Visibility guard — pause render meter when tab is hidden ────────
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (_vitalsRenderMeter) {
      _vitalsRenderMeter.setPaused(document.hidden);
    }
  });
}

// ── Redux DevTools Integration ─────────────────────────────────────

interface DevToolsConnection {
  init: (state: unknown) => void;
  send: (action: { type: string; payload?: unknown }, state: unknown) => void;
  subscribe: (
    listener: (
      message: { type: string; payload?: unknown; state?: string },
    ) => void,
  ) => () => void;
  disconnect: () => void;
}

let _devtools: DevToolsConnection | null = null;
let _devtoolsConnected = false;

function _initDevTools(): void {
  if (_devtoolsConnected) return;
  const ext =
    (window as unknown as Record<string, unknown>).__REDUX_DEVTOOLS_EXTENSION__;
  if (!ext) return;

  try {
    _devtools = (ext as { connect: () => DevToolsConnection }).connect();
    if (_devtools) {
      _devtoolsConnected = true;
      _devtools.subscribe((msg) => {
        if (msg.type === "DISPATCH") {
          const payload = msg.payload as { type?: string } | undefined;
          if (
            payload?.type === "JUMP_TO_STATE" ||
            payload?.type === "JUMP_TO_ACTION"
          ) {
            // DevTools time-travel request — we don't have the state history on client
            // The server handles time-travel via TT commands
            console.log(
              "[aio] DevTools time-travel: use Ctrl+. panel for client-side state navigation",
            );
          }
        }
      });
      // Send initial state
      if (_state !== null) {
        _devtools.init(_state);
      }
    }
  } catch {
    // DevTools not available or failed to connect
  }
}

function _sendDevTools(
  action: { type: string; payload?: unknown },
  state: unknown,
): void {
  if (_devtools && _devtoolsConnected) {
    try {
      _devtools.send(action, state);
    } catch {
      // DevTools disconnected
      _devtoolsConnected = false;
    }
  }
}

/** Connect to Redux DevTools extension (call after useAio in dev mode) */
export function connectDevTools(): void {
  _initDevTools();
  if (_devtools && _state !== null) {
    try {
      _devtools.init(_state);
    } catch { /* ignore */ }
  }
}

/** Disconnect from Redux DevTools */
export function disconnectDevTools(): void {
  if (_devtools) {
    try {
      _devtools.disconnect();
    } catch { /* ignore */ }
    _devtools = null;
    _devtoolsConnected = false;
  }
}

/** React hook — full app state + untyped send. Deep-proxy-tracked: only accessed paths
 *  are sent by the server. Use `useFeature(f)` for scoped re-renders (this hook
 *  re-renders on every state change; useFeature re-renders only when its feature changes). */
export function useAio<S = unknown>(): {
  state: S;
  send: (action: { type: string; payload?: unknown }) => void;
} {
  const state = useSyncExternalStore(
    _useAioSubscribe,
    _getSnapshot,
    _getServerSnapshot,
  ) as S | null;
  return { state: _trackingProxy(state) as S, send: _send };
}

// WHY DUPLICATED: msg() and factory() are inline copies of msg.ts and factory.ts.
// Dev mode serves browser.ts as a single transpiled file (no imports resolved).
// sync.test.ts verifies these stay in sync with the canonical implementations.

/** Creates { type, payload } objects — inline copy (dev mode single-file constraint) */
export function msg<T extends string>(
  type: T,
): { type: T; payload: Record<string, never> };
export function msg<T extends string, P>(
  type: T,
  payload: P,
): { type: T; payload: P };
export function msg(type: string, payload?: unknown) {
  return { type, payload: payload ?? {} };
}

/** Creates a typed action/effect catalog — inline copy (dev mode single-file constraint) */
// deno-lint-ignore no-explicit-any
type _Creators = Record<string, (...args: any[]) => any>;
type _LowerFirst<S extends string> = S extends `${infer C}${infer Rest}`
  ? `${Lowercase<C>}${Rest}`
  : S;
type _FactoryResult<T extends _Creators> =
  & {
    readonly [K in keyof T]: K;
  }
  & {
    readonly [K in keyof T as _LowerFirst<K & string>]: (
      ...args: Parameters<T[K]>
    ) => { type: K; payload: ReturnType<T[K]> };
  };
function _lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
function _factory<T extends _Creators>(creators: T): _FactoryResult<T> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(creators)) {
    result[key] = key;
    result[_lowerFirst(key)] = (...args: unknown[]) => ({
      type: key,
      payload: creators[key]!(...args) ?? {},
    });
  }
  return result as _FactoryResult<T>;
}
export { _factory as actions, _factory as effects };

// ── schedule stubs (browser-compatible — pure effect creators, no timers) ──

// deno-lint-ignore no-explicit-any
const _schedEffect = (
  kind: string,
  id: string,
  extra: Record<string, any> = {},
) => ({ type: "__schedule", kind, id, ...extra });

export const schedule = {
  after: (
    id: string,
    ms: number,
    action: { type: string; payload?: unknown },
  ) => _schedEffect("after", id, { ms, action }),
  every: (
    id: string,
    ms: number,
    action: { type: string; payload?: unknown },
  ) => _schedEffect("every", id, { ms, action }),
  at: (id: string, time: string, action: { type: string; payload?: unknown }) =>
    _schedEffect("at", id, { time, action }),
  cron: (
    id: string,
    pattern: string,
    action: { type: string; payload?: unknown },
  ) => _schedEffect("cron", id, { pattern, action }),
  cancel: (id: string) => _schedEffect("cancel", id),
};

// ── v0.5 feature system (browser-compatible stubs) ──────────────────
// Browser version: builds A/E catalogs for useFeature(). No Immer, no machine validation.

function _capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Browser-compatible feature() — builds catalogs for useFeature. Full version in feature.ts (server). */
// deno-lint-ignore no-explicit-any
export function feature(
  name: string,
  config: {
    state?: any;
    actions?: _Creators;
    methods?: Record<string, unknown>;
    generators?: Record<string, unknown>;
    effects?: _Creators;
    machine?: any;
    reduce?: any;
    execute?: any;
    selectors?: any;
  },
) {
  const prefix = name;
  // deno-lint-ignore no-explicit-any
  const buildCat = (creators: _Creators): Record<string, any> => {
    const cat: Record<string, unknown> = {};
    for (const key of Object.keys(creators)) {
      const label = `${prefix}:${key}`;
      cat[key] = Object.assign(
        (...args: unknown[]) => ({
          type: label,
          payload: creators[key]!(...args) ?? {},
        }),
        { type: label },
      );
    }
    return cat;
  };
  // methods-based feature (v0.8 reactive style) — payload shape is { args: [...] }
  if (config.methods) {
    const allKeys = [
      ...Object.keys(config.methods),
      ...Object.keys(config.generators ?? {}),
    ];
    const cat: Record<string, unknown> = {};
    for (const key of allKeys) {
      const label = `${prefix}:${key}`;
      cat[key] = Object.assign(
        (...args: unknown[]) => ({ type: label, payload: { args } }),
        { type: label },
      );
    }
    // deno-lint-ignore no-explicit-any
    const eCat = buildCat((config.effects ?? {}) as any);
    const def: Record<string, unknown> = {
      __aio: {
        state: config.state ?? {},
        machine: config.machine ?? false,
        selectors: config.selectors ?? {},
        actionKeys: allKeys,
        effectKeys: Object.keys(config.effects ?? {}),
        id: prefix,
        actions: cat,
        effects: eCat,
        bound: false,
      },
    };
    // Flatten methods onto feature object — parity with server-side feature()
    for (const [key, value] of Object.entries(cat)) {
      def[key] = value;
    }
    return def;
  }
  const aCat = buildCat(config.actions ?? {});
  const def: Record<string, unknown> = {
    __aio: {
      state: config.state ?? {},
      machine: config.machine ?? false,
      selectors: config.selectors ?? {},
      actionKeys: Object.keys(config.actions ?? {}),
      effectKeys: Object.keys(config.effects ?? {}),
      id: prefix,
      actions: aCat,
      effects: buildCat(config.effects ?? {}),
      bound: false,
    },
  };
  // Flatten actions onto feature object — parity with server-side feature()
  for (const [key, value] of Object.entries(aCat)) {
    def[key] = value;
  }
  return def;
}

/** Browser-compatible bridge() stub — delegates to feature() */
// deno-lint-ignore no-explicit-any
export function bridge(name: string, config: any) {
  const channels = Object.keys(config.channels ?? {});
  // deno-lint-ignore no-explicit-any
  const actions: Record<string, (...args: any[]) => Record<string, unknown>> =
    {};
  for (const ch of channels) {
    actions[`${ch}Request`] = (...args: unknown[]) => ({
      ...(config.channels[ch]?.request?.(...args) ?? {}),
      _channel: ch,
    });
    actions[`${ch}Response`] = (...args: unknown[]) => ({
      ...(config.channels[ch]?.response?.(...args) ?? {}),
      _channel: ch,
    });
    actions[`${ch}Timeout`] = () => ({ _channel: ch });
  }
  return feature(name, { actions, machine: false, reduce: () => {} });
}

// ── Browser-safe `aio` stub ──────────────────────────────────────────
// Server-side aio.run() starts an HTTP/WS server — impossible in browser.
// This stub lets shared files (feature definitions, etc.) do:
//   import { aio, feature } from "aio"
//   export const myFeature = feature("x", { ... })
//   await aio.run({ features: [myFeature], baseDir: "..." })
// Without crashing when the same module is loaded in the browser.
// deno-lint-ignore no-explicit-any
export const aio: Record<string, any> = {
  /** No-op in browser — server starts the runtime, browser connects to it */
  run() {
    return Promise.resolve();
  },
  middleware: {
    logger: () => () => null,
    devtools: () => () => null,
    perfBudget: () => () => null,
    validate: () => () => null,
    metrics: () => () => null,
    freeze: () => () => null,
    create: () => () => null,
  },
};

/** Cache for useFeature send objects (one per feature ref) */
// deno-lint-ignore no-explicit-any
const _featureSendCache = new WeakMap<
  Record<string, any>,
  Record<string, (...args: unknown[]) => void>
>();

/** v0.5 hook — connects UI to a specific feature with scoped state, typed send, and machine status.
 *  Uses selector-based subscription: only re-renders when this feature's slice changes (not on every WS message).
 *
 *  Pass `fallback` to skip the `state: S | null` guard — useful for Electron/local apps where
 *  connection is near-instant and you want components to render immediately with initial state:
 *
 *  ```tsx
 *  const { state, send } = useFeature(counter, { fallback: counter.__aio.state as CounterState })
 *  // state is CounterState, never null
 *  ```
 */
// deno-lint-ignore no-explicit-any
// deno-lint-ignore no-explicit-any
// deno-lint-ignore no-explicit-any
type FeatureRef = {
  __aio: { id: string; actions: Record<string, any>; actionKeys: string[] };
};
export function useFeature<S>(
  ref: FeatureRef,
  options: { fallback: S },
): {
  state: S;
  send: Record<string, (...args: unknown[]) => void>;
  status: string | undefined;
};
export function useFeature<S = unknown>(
  ref: FeatureRef,
  options?: { fallback?: never },
): {
  state: S | null;
  send: Record<string, (...args: unknown[]) => void>;
  status: string | undefined;
};
export function useFeature<S = unknown>(
  ref: FeatureRef,
  options?: { fallback?: S },
): {
  state: S;
  send: Record<string, (...args: unknown[]) => void>;
  status: string | undefined;
} {
  const name = ref.__aio.id;

  // Register feature path for proxy-tracked subscriptions.
  // Guarantees feature-level subscription even if component reads no leaf values.
  _accessedPaths.add(name);
  _scheduleSyncSubs();

  // Selector: extract just this feature's slice from global state
  const getSliceSnapshot = useCallback((): S | null => {
    if (_state === null) return null;
    return (_state as Record<string, unknown>)[name] as S | null;
  }, [name]);

  const featureState = useSyncExternalStore(
    _subscribe,
    getSliceSnapshot,
    _getServerSnapshot as () => S | null,
  );

  // State is guaranteed non-null because the framework waits for state before mounting React.
  // Feature slice may still be null if the feature name doesn't exist in state.
  const resolved = (featureState ??
    (options?.fallback !== undefined ? options.fallback : featureState)) as S;

  const status = resolved
    ? (resolved as Record<string, unknown>)._status as string | undefined
    : undefined;

  // Build send object (cached per feature ref) — auto-tags actions with _source: 'UI'
  let sendObj = _featureSendCache.get(ref);
  if (!sendObj) {
    sendObj = {};
    for (const key of ref.__aio.actionKeys) {
      const creator = ref.__aio.actions[key];
      if (typeof creator === "function") {
        sendObj[key] = (...args: unknown[]) => {
          const action = creator(...args);
          _send({ ...action, _source: "UI" });
        };
      }
    }
    _featureSendCache.set(ref, sendObj);
  }

  return { state: _trackingProxy(resolved, name) as S, send: sendObj, status };
}

/** Client-only state — not synced to server, not persisted. For UI-local concerns (editing flags, form inputs, etc.) */
export function useLocal<T>(
  initial: T,
): { local: T; set: (next: T | ((prev: T) => T)) => void } {
  const [local, setLocal] = useState<T>(initial);
  return { local, set: setLocal };
}

/** Core projection logic — testable without React.
 *  Applies `_preserveArrayRefs` to result if array, or `_shallowEqual` ref preservation if object. */
export function _projectWithSharing<T>(result: T, prev: T | null): T {
  if (prev === null) return result;
  if (Array.isArray(result) && Array.isArray(prev)) {
    return _preserveArrayRefs(
      result as unknown[],
      prev as unknown[],
    ) as unknown as T;
  }
  // Non-array object: preserve ref if shallow-equal
  if (
    result && typeof result === "object" && !Array.isArray(result) &&
    typeof prev === "object" && _shallowEqual(result, prev)
  ) {
    return prev;
  }
  return result;
}

/** Derives state from a transformation, preserving element-level references.
 *
 *  Like `useMemo`, but when the transform re-runs and returns an array,
 *  `_preserveArrayRefs` is applied to the output — unchanged elements keep
 *  their previous object reference, enabling `memo()` to skip re-renders.
 *
 *  ```tsx
 *  const groups = useProjection(() => buildGroups(state.members), [state.members]);
 *  ```
 */
export function useProjection<T>(fn: () => T, deps: unknown[]): T {
  const prevRef = useRef<T | null>(null);
  const result = useMemo(() => {
    const raw = fn();
    const projected = _projectWithSharing(raw, prevRef.current);
    prevRef.current = projected;
    return projected;
  }, deps);
  return result;
}

/** Per-prop comparison: uses _shallowEqual for object props, === for primitives/arrays.
 *  Exported for testing. */
export function _memoCompare(
  prevProps: Record<string, unknown>,
  nextProps: Record<string, unknown>,
): boolean {
  const prevKeys = Object.keys(prevProps);
  const nextKeys = Object.keys(nextProps);
  if (prevKeys.length !== nextKeys.length) return false;
  for (const key of prevKeys) {
    const pv = prevProps[key];
    const nv = nextProps[key];
    if (pv === nv) continue;
    // For plain objects (not arrays), use _shallowEqual
    if (
      pv && nv && typeof pv === "object" && typeof nv === "object" &&
      !Array.isArray(pv) && !Array.isArray(nv)
    ) {
      if (!_shallowEqual(pv, nv)) return false;
      continue;
    }
    return false; // primitives or arrays: strict ===
  }
  return true;
}

/** Drop-in replacement for React.memo with smarter default comparison.
 *
 *  Uses `_shallowEqual` on each prop (one level deeper than React.memo's default `===`).
 *  This catches the case where a parent creates new container objects that are
 *  structurally identical to the previous props — e.g. `{ ...member, extra: val }`.
 *
 *  ```tsx
 *  import { memo } from "aio";  // instead of React.memo
 *  export default memo(MemberCard);  // _shallowEqual per prop, not ===
 *  ```
 */
export function memo<P extends Record<string, any>>(
  Component: ComponentType<P>,
  compare?: (prev: P, next: P) => boolean,
): ComponentType<P> {
  return _reactMemo(
    Component,
    compare ?? _memoCompare as (prev: P, next: P) => boolean,
  ) as unknown as ComponentType<P>;
}

/** Renders the component matching the current page key. Usage: page(state.page, { home: Home, settings: Settings }) */
export function page<K extends string>(
  current: K,
  routes: Record<K, ComponentType>,
): ReturnType<typeof createElement> | null {
  const Component = routes[current];
  return Component ? createElement(Component) : null;
}

/** Time-travel hook — returns null in prod mode */
export function useTimeTravel(): {
  entries: { id: number; type: string; ts: number }[];
  index: number;
  paused: boolean;
  undo: () => void;
  redo: () => void;
  goto: (id: number) => void;
  pause: () => void;
  resume: () => void;
} | null {
  const [tt, setTT] = useState<TTMeta | null>(_ttState);

  useEffect(() => {
    const unsub = _ttListeners.add((t) => setTT({ ...t }));
    if (_ttState) setTT({ ..._ttState });
    return unsub;
  }, []);

  if (!tt) return null;

  const sendTT = (cmd: string) => {
    if (_ws && _ws.readyState === WebSocket.OPEN) _ws.send(cmd);
  };

  return {
    entries: tt.entries,
    index: tt.index,
    paused: tt.paused,
    undo: () => sendTT("__tt:undo"),
    redo: () => sendTT("__tt:redo"),
    goto: (id: number) => sendTT("__tt:goto:" + id),
    pause: () => sendTT("__tt:pause"),
    resume: () => sendTT("__tt:resume"),
  };
}

/** Log stub for browser — no-op (logging writes to server-side files) */
export const log = {
  trace(_cat: string, _msg: string, _data?: Record<string, unknown>): void {},
  debug(_cat: string, _msg: string, _data?: Record<string, unknown>): void {},
  info(_cat: string, _msg: string, _data?: Record<string, unknown>): void {},
  warn(_cat: string, _msg: string, _data?: Record<string, unknown>): void {},
  error(_cat: string, _msg: string, _data?: Record<string, unknown>): void {},
};

// ── React fiber tree walker (dev mode) ──────────────────────────────
// Walks the React fiber tree from the root and extracts component names,
// useState hooks state, and props for each mounted component.

type _ComponentInfo = {
  component: string;
  state?: unknown;
  props?: Record<string, unknown>;
  children?: _ComponentInfo[];
};

/** Find React fiber root from the DOM */
function _findFiberRoot(): Record<string, unknown> | null {
  const root = document.getElementById("root") ??
    document.getElementById("app");
  if (!root) return null;
  const fiberKey = Object.getOwnPropertyNames(root).find((k) =>
    k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$") ||
    k.startsWith("__reactInternalInstance$")
  );
  if (!fiberKey) return null;
  let fiber = (root as unknown as Record<string, unknown>)[fiberKey] as
    | Record<string, unknown>
    | null;
  if (!fiber) return null;
  if (fiberKey.startsWith("__reactContainer$") && fiber.current) {
    fiber = fiber.current as Record<string, unknown>;
  }
  return fiber;
}

/** Walk React fiber tree and return component info list */
function _walkReactTree(): _ComponentInfo[] {
  const fiber = _findFiberRoot();
  if (!fiber) return [];
  const result: _ComponentInfo[] = [];
  _walkFiber(fiber, result);
  return result;
}

/** Find a component's fiber by name + index or name + prop match */
function _findComponentFiber(
  fiber: Record<string, unknown>,
  name: string,
  match: { index: number } | { prop: string; value: string },
  counter = { n: 0 },
): Record<string, unknown> | null {
  const tag = fiber.tag as number;
  const type = fiber.type as unknown;
  if (type && (tag === 0 || tag === 1 || tag === 11 || tag === 15)) {
    const cName = typeof type === "function"
      ? (type as { displayName?: string; name?: string }).displayName ??
        (type as { name?: string }).name
      : null;
    if (cName === name) {
      if ("index" in match) {
        if (counter.n === match.index) return fiber;
        counter.n++;
      } else {
        const props = fiber.memoizedProps as Record<string, unknown> | null;
        if (props && String(props[match.prop]) === match.value) return fiber;
      }
    }
  }
  let child = fiber.child as Record<string, unknown> | null;
  while (child) {
    const found = _findComponentFiber(child, name, match, counter);
    if (found) return found;
    child = child.sibling as Record<string, unknown> | null;
  }
  return null;
}

/** Find the nearest DOM node from a fiber (walk down to first HostComponent) */
function _fiberToDOM(fiber: Record<string, unknown>): HTMLElement | null {
  // stateNode on HostComponent (tag 5) is the DOM node
  if (fiber.tag === 5 && fiber.stateNode instanceof HTMLElement) {
    return fiber.stateNode;
  }
  // For function components, walk down to first child HostComponent
  let child = fiber.child as Record<string, unknown> | null;
  while (child) {
    if (child.tag === 5 && child.stateNode instanceof HTMLElement) {
      return child.stateNode as HTMLElement;
    }
    const found = _fiberToDOM(child);
    if (found) return found;
    child = child.sibling as Record<string, unknown> | null;
  }
  return null;
}

/** Handle __click: command — find component and click its DOM node */
function _handleClick(
  cmd: string,
): { ok: boolean; error?: string; clicked?: string } {
  const root = _findFiberRoot();
  if (!root) return { ok: false, error: "no React root found" };

  // Parse: "ComponentName:index" or "ComponentName:prop:value"
  const parts = cmd.split(":");
  const name = parts[0];
  if (!name) return { ok: false, error: "no component name" };

  let match: { index: number } | { prop: string; value: string };
  if (parts.length === 2 && /^\d+$/.test(parts[1]!)) {
    match = { index: Number(parts[1]) };
  } else if (parts.length === 3) {
    match = { prop: parts[1]!, value: parts[2]! };
  } else {
    match = { index: 0 }; // default: first instance
  }

  const fiber = _findComponentFiber(root, name, match);
  if (!fiber) return { ok: false, error: `component '${name}' not found` };

  const el = _fiberToDOM(fiber);
  if (!el) return { ok: false, error: `component '${name}' has no DOM node` };

  el.click();
  return { ok: true, clicked: `${name} → <${el.tagName.toLowerCase()}>` };
}

function _walkFiber(
  fiber: Record<string, unknown>,
  out: _ComponentInfo[],
): void {
  // tag 0 = FunctionComponent, 1 = ClassComponent, 11 = ForwardRef, 15 = SimpleMemoComponent
  const tag = fiber.tag as number;
  const type = fiber.type as ((...args: unknown[]) => unknown) | {
    displayName?: string;
    name?: string;
  } | null;

  if (type && (tag === 0 || tag === 1 || tag === 11 || tag === 15)) {
    const name = typeof type === "function"
      ? (type as { displayName?: string; name?: string }).displayName ??
        (type as { name?: string }).name ?? "Anonymous"
      : (type as { displayName?: string }).displayName ?? "Unknown";

    // Skip React internals
    if (name && !name.startsWith("__") && name !== "Fragment") {
      const info: _ComponentInfo = { component: name };

      // Extract useState hook state from memoizedState chain
      const hookState = _extractHookState(
        fiber.memoizedState as Record<string, unknown> | null,
      );
      if (hookState.length) {
        info.state = hookState.length === 1 ? hookState[0] : hookState;
      }

      // Extract props (skip children and internal keys)
      const props = fiber.memoizedProps as Record<string, unknown> | null;
      if (props) {
        const cleaned: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if (k === "children" || typeof v === "function") continue;
          try {
            JSON.stringify(v);
            cleaned[k] = v;
          } catch { /* non-serializable, skip */ }
        }
        if (Object.keys(cleaned).length) info.props = cleaned;
      }

      out.push(info);
    }
  }

  // Walk children
  let child = fiber.child as Record<string, unknown> | null;
  while (child) {
    _walkFiber(child, out);
    child = child.sibling as Record<string, unknown> | null;
  }
}

function _extractHookState(
  memoizedState: Record<string, unknown> | null,
): unknown[] {
  const states: unknown[] = [];
  let hook = memoizedState;
  while (hook) {
    // useState hooks have a queue with a lastRenderedState
    const queue = hook.queue as Record<string, unknown> | null;
    if (queue && "lastRenderedState" in queue) {
      const val = queue.lastRenderedState;
      // Only include serializable values
      try {
        JSON.stringify(val);
        states.push(val);
      } catch { /* skip */ }
    }
    hook = hook.next as Record<string, unknown> | null;
  }
  return states;
}

/** Resets module state — for testing only */
export function _reset(): void {
  _closed = true;
  _ws?.close();
  _ws = null;
  _state = null;
  _queue = [];
  _retry = 0;
  _closed = false;
  _listeners.clear();
  _ttState = null;
  _ttListeners.clear();
  _ttPanel?.remove();
  _ttPanel = null;
  _ttPanelVisible = false;
  _statusEl?.remove();
  _statusEl = null;
  if (_statusTimer) {
    clearTimeout(_statusTimer);
    _statusTimer = null;
  }
  _wasConnected = false;
  _bootId = null;
  _offlineReady = false;
  _offlineQueue = [];
  _idb = null;
  _idbPromise = null;
  _lastAction = null;
  _devtools = null;
  _devtoolsConnected = false;
  _ttKeyBound = false;
  _ipcConnected = false;
  if (_ipcPingTimer) {
    clearInterval(_ipcPingTimer);
    _ipcPingTimer = null;
  }
  _connecting = false;
  _stateReadyPromise = null;
  _stateReadyResolve = null;
  if (_cleanupTimer) {
    clearTimeout(_cleanupTimer);
    _cleanupTimer = null;
  }
  _listenerHighWater = 0;
  _stateVersion = 0;
  _idMaps.clear();
  _useAioActiveCount = 0;
  _diagLastEmit.clear();
  _resetArrayRefStats();
  _vitalsUrlLogged = false;
  if (_vitalsPingTimer) {
    clearInterval(_vitalsPingTimer);
    _vitalsPingTimer = null;
  }
  _vitalsTransportProbe = null;
  _resetTracking();
}

// ── Framework-agnostic client ─────────────────────────────────────────────
// Public API for non-React frameworks. Same singleton — shared with useAio/useFeature.

/** Framework-agnostic client — subscribe to state, send actions, access routing.
 *  Use this to wire aio into Svelte, Vue, Solid, or any other framework. */
export const client = {
  /** Subscribe to state changes. Calls `fn(state)` on every update. Returns unsubscribe. Manages WS lifecycle (connects on first, disconnects on last). */
  subscribe(fn: (state: unknown) => void): () => void {
    // Wrap into the same _subscribe lifecycle (connect on first, disconnect on last)
    const unsub = _subscribe(() => fn(_state));
    return unsub;
  },

  /** Current full state snapshot (null before first message). */
  getState(): unknown {
    return _state;
  },

  /** Get a single feature's state slice by name. */
  getFeatureState(name: string): unknown {
    return _state ? (_state as Record<string, unknown>)[name] ?? null : null;
  },

  /** Send an action to the server. Queued during initial connect, persisted offline after disconnect. */
  send: _send,

  /** Routing — subscribe to URL changes, navigate, match paths. */
  route: {
    /** Subscribe to URL changes. Returns unsubscribe. */
    subscribe(fn: () => void): () => void {
      return _rListeners.add(() => fn());
    },
    /** Current pathname. */
    getPath(): string {
      return _rPath;
    },
    /** Current search params. */
    getSearch(): URLSearchParams {
      return _rSearch;
    },
    /** Navigate to path or history delta. */
    navigate,
  },
};

// ── Router ────────────────────────────────────────────────────────────────
// Client-side routing — history API, nested routes, URL params, search params

let _rPath = typeof location !== "undefined" ? location.pathname : "/";
let _rSearch = typeof location !== "undefined"
  ? new URLSearchParams(location.search)
  : new URLSearchParams();
const _rListeners = new Listeners<void>();

function _rSync(): void {
  _rPath = location.pathname;
  _rSearch = new URLSearchParams(location.search);
  _rListeners.notify(undefined);
}

let _popstateHandler: (() => void) | null = null;
if (typeof window !== "undefined") {
  _popstateHandler = _rSync;
  addEventListener("popstate", _popstateHandler);
}

function _rSubscribe(fn: () => void): () => void {
  return _rListeners.add(() => fn());
}

function _rSnapshot(): string {
  return typeof location !== "undefined"
    ? location.pathname + location.search
    : "/";
}

/** Match a path pattern against a path string. Returns params or null. */
export function matchPath(
  pattern: string,
  path: string,
  exact = true,
): Record<string, string> | null {
  const keys: string[] = [];
  const segments = pattern.replace(/\/+$/, "").split("/");
  const regParts = segments.map((seg) => {
    if (seg.startsWith(":")) {
      keys.push(seg.slice(1));
      return "([^/]+)";
    }
    if (seg === "*") {
      keys.push("*");
      return "(.*)";
    }
    return seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  });
  const suffix = exact ? "\\/?$" : "(\\/|$)";
  const re = new RegExp("^" + regParts.join("\\/") + suffix);
  const m = re.exec(path);
  if (!m) return null;
  const params: Record<string, string> = {};
  keys.forEach((k, i) => {
    let v = decodeURIComponent(m[i + 1] ?? "");
    if (k === "*") v = v.replace(/\/$/, ""); // strip trailing slash (root path '/' → '')
    params[k] = v;
  });
  return params;
}

/** Navigate to path or step through history. */
export function navigate(
  to: string | number,
  opts?: { replace?: boolean },
): void {
  if (typeof to === "number") {
    history.go(to);
    return;
  }
  const url = new URL(to, location.href); // use href (not origin) so relative paths resolve correctly
  if (opts?.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  _rSync();
}

/** Current route state — path, params, search, and match status */
export type RouteState = {
  path: string;
  params: Record<string, string>;
  search: URLSearchParams;
  matched: boolean;
};

/** Current route. With pattern ('/users/:id') extracts params. */
export function useRoute(pattern?: string): RouteState {
  useSyncExternalStore(_rSubscribe, _rSnapshot, () => "/");
  const path = _rPath;
  const search = _rSearch;
  if (!pattern) return { path, params: {}, search, matched: true };
  const params = matchPath(pattern, path);
  return { path, params: params ?? {}, search, matched: params !== null };
}

/** Returns the navigate function. */
export function useNavigate(): (
  to: string | number,
  opts?: { replace?: boolean },
) => void {
  return navigate;
}

// ── Route context (nested routes + Outlet) ───────────────────────────────

type _RouteCtxType = {
  basePath: string;
  params: Record<string, string>;
  outlet: unknown;
};
const _RouteCtx = createContext<_RouteCtxType>({
  basePath: "",
  params: {},
  outlet: null,
});

/** Props for the Route component */
export type RouteProps = {
  path?: string;
  index?: boolean;
  element?: unknown;
  children?: unknown;
};

/** Renders element when path matches. Nest inside other Routes for layouts with Outlet. */
export function Route({ path, index, element, children }: RouteProps): unknown {
  useSyncExternalStore(_rSubscribe, _rSnapshot, () => "/"); // re-render on URL changes
  const { basePath, params: parentParams } = useContext(_RouteCtx);
  const currentPath = _rPath;

  if (index) {
    const base = basePath || "/";
    const match = currentPath === base ||
      currentPath === base.replace(/\/$/, "") ||
      base === "/" && currentPath === "/";
    if (!match) return null;
    return element ?? null;
  }

  if (!path) return null;
  const full =
    (basePath + "/" + path.replace(/^\//, "")).replace(/\/+/g, "/").replace(
      /(.)\/$/,
      "$1",
    ) || "/";
  const hasChildren = !!children;
  const params = matchPath(full, currentPath, !hasChildren);
  if (!params) return null;

  const allParams = { ...parentParams, ...params };
  return createElement(
    _RouteCtx.Provider as ComponentType<{ value: _RouteCtxType }>,
    {
      value: {
        basePath: full,
        params: allParams,
        outlet: hasChildren ? children : null,
      },
    },
    (hasChildren
      ? (element ?? createElement(Outlet as () => null))
      : element ?? null) as ReactNode,
  );
}

/** Renders the matching child route inside a parent Route's element. */
export function Outlet(): unknown {
  const { outlet } = useContext(_RouteCtx);
  return outlet ?? null;
}

/** Props for the Link component */
export type LinkProps = {
  to: string;
  replace?: boolean;
  exact?: boolean;
  activeClass?: string;
  activeStyle?: Record<string, unknown>;
  children?: unknown;
  className?: string;
  style?: Record<string, unknown>;
  [k: string]: unknown;
};

/** Anchor that navigates without page reload. Adds activeClass when path matches. */
export function Link(
  { to, replace: rep, exact, activeClass, activeStyle, children, ...rest }:
    LinkProps,
): unknown {
  useSyncExternalStore(_rSubscribe, _rSnapshot, () => "/");
  const path = _rPath;
  const isActive = (exact || to === "/")
    ? path === to
    : path === to || path.startsWith(to + "/");
  function handleClick(e: MouseEvent) {
    if (
      (e as MouseEvent & { button: number }).button !== 0 || e.metaKey ||
      e.ctrlKey || e.shiftKey || e.altKey
    ) return;
    e.preventDefault();
    navigate(to, { replace: rep });
  }
  const cls = isActive && activeClass
    ? [rest.className, activeClass].filter(Boolean).join(" ")
    : rest.className;
  const sty = isActive && activeStyle
    ? { ...rest.style, ...activeStyle }
    : rest.style;
  return createElement("a", {
    ...rest,
    href: to,
    onClick: handleClick,
    className: cls,
    style: sty,
  }, children as ReactNode);
}

/** Link with automatic 'active' class. Prefix match by default, exact for '/' and when exact=true. */
export function NavLink(
  { activeClass = "active", ...rest }: Omit<LinkProps, "activeClass"> & {
    activeClass?: string;
  },
): unknown {
  return createElement(
    Link as ComponentType<LinkProps>,
    { activeClass, ...rest } as LinkProps,
  );
}

/** Navigates to `to` on mount — use for auth redirects. Replace=true by default (no history entry). */
export function Redirect(
  { to, replace: rep = true }: { to: string; replace?: boolean },
): null {
  useLayoutEffect(() => {
    navigate(to, { replace: rep });
  }, [to]);
  return null;
}
