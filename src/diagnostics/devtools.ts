// AIO DevTools — component tree inspection, re-render tracking, signal dependency visualization.
// Connects to Redux DevTools Extension if available.

import { type Signal, signal } from "../state/signal.ts";

// ── Types ───────────────────────────────────────────────────────────

/** One node of the live component tree exposed by {@linkcode DevToolsHandle}. */
export interface ComponentTreeNode {
  name: string;
  props: Record<string, unknown>;
  renderCount: number;
  signalCount: number;
  children: ComponentTreeNode[];
  lastRenderMs: number;
}

/** One re-render record in the {@linkcode DevToolsHandle} ring buffer. */
export interface RenderEvent {
  component: string;
  timestamp: number;
  durationMs: number;
  trigger: "signal" | "props" | "mount";
  signalNames?: string[];
}

/** Live inspection handle returned by {@linkcode connectAioDevTools}. */
export interface DevToolsHandle {
  /** The live component tree, walked from the mounted AIR roots when read. */
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
/** Reserved name prefix — lets `_recordRender` recognize a render that was
 *  triggered by devtools' own signals (see the self-observation note there). */
const DEVTOOLS_SIG_PREFIX = "__aioDevtools:";
/** Where the live component tree comes from. The renderer registers it at
 *  import time (`src/air/devtools-tree.ts`); nothing else can, because
 *  `diagnostics` may not import `air`.
 *
 *  PULL, not push, and deliberately so. This used to be a `_treeSig` signal fed
 *  by an exported `_updateTree` "called by the renderer periodically in dev
 *  mode" — which nothing ever called, so the documented `tree` handle returned
 *  an empty array for the life of the feature. Restoring it as a push channel
 *  would have been worse than dead: a component that RENDERS the tree
 *  subscribes to that signal, so publishing after each flush re-renders it,
 *  which bumps its own render count, which changes the tree, which publishes
 *  again — the self-observation loop `_recordRender` already has a guard
 *  against. Reading on demand cannot loop, costs nothing when no one asks, and
 *  is always current. */
let _treeSource: (() => ComponentTreeNode[]) | null = null;

/** @internal Register the renderer's component-tree walker. */
export function _setComponentTreeSource(
  fn: (() => ComponentTreeNode[]) | null,
): void {
  _treeSource = fn;
}
const _rendersSig: Signal<RenderEvent[]> = signal<RenderEvent[]>(
  [],
  `${DEVTOOLS_SIG_PREFIX}renders`,
);
const _totalRendersSig: Signal<number> = signal<number>(
  0,
  `${DEVTOOLS_SIG_PREFIX}totalRenders`,
);
const MAX_RENDER_EVENTS = 200;

// ── Redux DevTools bridge ───────────────────────────────────────────

function _tryConnectReduxDevTools(): boolean {
  if (typeof globalThis === "undefined") return false;
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  if (g.__REDUX_DEVTOOLS_EXTENSION__) {
    try {
      _reduxDevTools = g.__REDUX_DEVTOOLS_EXTENSION__.connect({
        name: "AIO Renderer",
        features: { jump: false, skip: false },
      });
      return true;
    } catch {
      // Extension port dead (reload/update mid-connect) — the local handle
      // still works; a diagnostic must never take the app down with it.
      _reduxDevTools = null;
      return false;
    }
  }
  return false;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Connect AIO DevTools. Returns a handle for reading component tree and render events.
 * Automatically connects to Redux DevTools Extension if available.
 *
 * ```ts
 * const devtools = connectAioDevTools();
 * // Read devtools.tree for component hierarchy
 * // Read devtools.renders for recent re-render events
 * ```
 */
export function connectAioDevTools(): DevToolsHandle {
  _connected = true;
  _tryConnectReduxDevTools();

  return {
    get tree() {
      // No AIR root mounted (or no renderer in this build) — an empty tree is
      // the honest answer, not a stand-in for one that was never collected.
      return _treeSource?.() ?? [];
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

  // A component that DISPLAYS devtools state (reads `renders`/`totalRenders`
  // in its render) is re-rendered BY these signals — recording that render
  // would set them again in the same flush, a self-feeding loop the renderer's
  // 25× cycle breaker then kills while blaming the app component. A render
  // whose triggers are ALL devtools' own signals is the observer observing
  // itself: drop it.
  if (
    event.signalNames !== undefined &&
    event.signalNames.every((n) => n.startsWith(DEVTOOLS_SIG_PREFIX))
  ) {
    return;
  }

  _totalRendersSig.set(_totalRendersSig.peek() + 1);

  const renders = _rendersSig.peek();
  const next = [...renders, event];
  if (next.length > MAX_RENDER_EVENTS) next.shift();
  _rendersSig.set(next);

  // Send to Redux DevTools
  if (_reduxDevTools) {
    try {
      _reduxDevTools.send(
        { type: `RENDER/${event.component}`, ...event },
        { renders: next.length, totalRenders: _totalRendersSig.peek() },
      );
    } catch {
      // The extension port died (reloaded/updated) — postMessage on it throws
      // on EVERY render from here on, out of the render path, misattributed
      // to the component being rendered. Drop the bridge; the local handle
      // (renders/tree/totalRenders) keeps working.
      _reduxDevTools = null;
    }
  }
}

/** Check if DevTools is currently connected. */
export function _isDevToolsConnected(): boolean {
  return _connected;
}
