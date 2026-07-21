// deno-lint-ignore-file
// Types and constants for browser-protocol.

export const WS_MAX_QUEUE = 100;
export const OFFLINE_MAX_QUEUE = 100;
export const OFFLINE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

/** Maximum time a client waits for an ack before rejecting the method promise. */
export const ACK_TIMEOUT_MS = 15_000;

/** Per-action acknowledgement: when a client→server action carries `cid`, the
 *  server responds with `__ack:<cid>:<ok>` after the dispatch has been reduced.
 *  The client side settles the corresponding pending promise. */
export type AckMessage = { cid: string; ok: boolean; error?: string };

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

/** Match state returned by {@linkcode useRoute}. Parameterize for typed
 *  route params: `useRoute<{ id: string }>("/users/:id").params.id`. */
export type RouteState<
  P extends Record<string, string> = Record<string, string>,
> = {
  path: string;
  params: P;
  search: URLSearchParams;
  matched: boolean;
};

/** Props for {@linkcode Route}. */
export type RouteProps = {
  path?: string;
  index?: boolean;
  element?: RenderableChild;
  children?: RenderableChildren;
};

/** Renderable content — a VNode, text, or a list of them (inews #13:
 *  `children: unknown` forced casts in strict apps). Structural, so it stays
 *  renderer-agnostic at the protocol layer. */
export type RenderableChild =
  | { tag: unknown }
  | string
  | number
  | boolean
  | null
  | undefined;
/** Children prop shape for router components. */
export type RenderableChildren = RenderableChild | RenderableChild[];

/** Props for {@linkcode Link} / {@linkcode NavLink}. */
export type LinkProps = {
  to: string;
  replace?: boolean;
  exact?: boolean;
  activeClass?: string;
  activeStyle?: Record<string, unknown>;
  children?: RenderableChildren;
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
