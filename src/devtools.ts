// AIO DevTools — component tree inspection, re-render tracking, signal dependency visualization.
// Connects to Redux DevTools Extension if available.

import { type Signal, signal } from "./signal.ts";

// ── Types ───────────────────────────────────────────────────────────

export interface ComponentTreeNode {
  name: string;
  props: Record<string, unknown>;
  renderCount: number;
  signalCount: number;
  children: ComponentTreeNode[];
  lastRenderMs: number;
}

export interface RenderEvent {
  component: string;
  timestamp: number;
  durationMs: number;
  trigger: "signal" | "props" | "mount";
  signalNames?: string[];
}

export interface DevToolsHandle {
  /** Current component tree (signal-tracked for live updates). */
  readonly tree: ComponentTreeNode[];
  /** Recent render events (signal-tracked, ring buffer). */
  readonly renders: RenderEvent[];
  /** Total render count since connection. */
  readonly totalRenders: number;
  /** Whether DevTools is connected. */
  readonly connected: boolean;
  /** Disconnect and clean up. */
  disconnect(): void;
}

// ── State ───────────────────────────────────────────────────────────

let _connected = false;
// deno-lint-ignore no-explicit-any
let _reduxDevTools: any = null;
const _treeSig: Signal<ComponentTreeNode[]> = signal<ComponentTreeNode[]>([]);
const _rendersSig: Signal<RenderEvent[]> = signal<RenderEvent[]>([]);
const _totalRendersSig: Signal<number> = signal<number>(0);
const MAX_RENDER_EVENTS = 200;

// ── Redux DevTools bridge ───────────────────────────────────────────

function _tryConnectReduxDevTools(): boolean {
  if (typeof globalThis === "undefined") return false;
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  if (g.__REDUX_DEVTOOLS_EXTENSION__) {
    _reduxDevTools = g.__REDUX_DEVTOOLS_EXTENSION__.connect({
      name: "AIO Renderer",
      features: { jump: false, skip: false },
    });
    return true;
  }
  return false;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Connect AIO DevTools. Returns a handle for reading component tree and render events.
 * Automatically connects to Redux DevTools Extension if available.
 *
 * ```ts
 * const devtools = connectDevTools();
 * // Read devtools.tree for component hierarchy
 * // Read devtools.renders for recent re-render events
 * ```
 */
export function connectAioDevTools(): DevToolsHandle {
  _connected = true;
  _tryConnectReduxDevTools();

  return {
    get tree() {
      return _treeSig.value;
    },
    get renders() {
      return _rendersSig.value;
    },
    get totalRenders() {
      return _totalRendersSig.value;
    },
    get connected() {
      return _connected;
    },
    disconnect() {
      _connected = false;
      if (_reduxDevTools) {
        // deno-lint-ignore no-explicit-any
        const g = globalThis as any;
        if (g.__REDUX_DEVTOOLS_EXTENSION__?.disconnect) {
          g.__REDUX_DEVTOOLS_EXTENSION__.disconnect();
        }
        _reduxDevTools = null;
      }
    },
  };
}

/**
 * Record a component render event (called by the renderer in dev mode).
 * @internal
 */
export function _recordRender(event: RenderEvent): void {
  if (!_connected) return;

  _totalRendersSig.set(_totalRendersSig.peek() + 1);

  const renders = _rendersSig.peek();
  const next = [...renders, event];
  if (next.length > MAX_RENDER_EVENTS) next.shift();
  _rendersSig.set(next);

  // Send to Redux DevTools
  if (_reduxDevTools) {
    _reduxDevTools.send(
      { type: `RENDER/${event.component}`, ...event },
      { renders: next.length, totalRenders: _totalRendersSig.peek() },
    );
  }
}

/**
 * Update the component tree snapshot (called by the renderer periodically in dev mode).
 * @internal
 */
export function _updateTree(tree: ComponentTreeNode[]): void {
  if (!_connected) return;
  _treeSig.set(tree);
}

/** Check if DevTools is currently connected. */
export function _isDevToolsConnected(): boolean {
  return _connected;
}
