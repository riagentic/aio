// deno-lint-ignore-file
// Types and constants for browser-protocol.

export const WS_MAX_QUEUE = 100;
export const OFFLINE_MAX_QUEUE = 100;
export const OFFLINE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

/** Window properties used by AIO diagnostics (avoids `declare global` for JSR compat). */
export interface AioWindow {
  _aioDiag?: (ev: Record<string, unknown>) => void;
  __aioConfig?: {
    renderBudget?: { staleness?: number; pendingPatches?: number };
  };
}

/** IPC transport (UDS mode via Electron) */
export type AioIPC = {
  send: (json: string) => void;
  ready: () => void;
  onMessage: (fn: (line: string) => void) => void;
  onOpen: (fn: () => void) => void;
  onClose: (fn: () => void) => void;
};

export type RouteState = {
  path: string;
  params: Record<string, string>;
  search: URLSearchParams;
  matched: boolean;
};

export type RouteProps = {
  path?: string;
  index?: boolean;
  element?: unknown;
  children?: unknown;
};

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

export interface DevToolsConnection {
  init: (state: unknown) => void;
  send: (action: { type: string; payload?: unknown }, state: unknown) => void;
  subscribe: (
    listener: (
      message: { type: string; payload?: unknown; state?: string },
    ) => void,
  ) => () => void;
  disconnect: () => void;
}
