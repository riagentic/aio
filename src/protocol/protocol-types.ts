// deno-lint-ignore-file
// Types and constants for browser-protocol.

/** User identity — resolved from a static token map or the resolveUser hook.
 *  Lives in protocol/ because it crosses the wire: the server authenticates it
 *  and the browser renders it (`useUser()`), so neither layer owns it. Server
 *  code keeps importing it from `server/aio-types.ts`, which re-exports it. */
export type AioUser = { id: string; role: string };

/** Auth features `/__aio/auth/me` advertises — `<SignIn/>` adapts to them
 *  (no signup toggle under `signup: false`, an SSO button only with `oidc`).
 *  A test that stubs `/me` must answer this shape; it was previously
 *  reverse-engineered from what `<SignIn/>` reads (a field report). */
export type AuthFeatures = {
  signup: boolean;
  oidc: boolean;
  totp: boolean;
  mail: boolean;
};

export const WS_MAX_QUEUE = 100;

/** Maximum time a client waits for an ack before rejecting the method promise. */
export const ACK_TIMEOUT_MS = 15_000;

/** Per-action acknowledgement: when a client→server action carries `cid`, the
 *  server responds with an "ack" frame `{cid, ok}` after the dispatch has been reduced.
 *  The client side settles the corresponding pending promise. */
export type AckMessage = { cid: string; ok: boolean; error?: string };

/** Window properties used by AIO diagnostics (avoids `declare global` for JSR compat). */
export interface AioWindow {
  _aioDiag?: (ev: Record<string, unknown>) => void;
  __aioConfig?: {
    /** The app's identity. `localStorage` is per ORIGIN, so the offline sync
     *  queue scopes its key by this: without it two aio apps on one host:port
     *  shared pending CRDT ops for any same-named cell, and one app's first
     *  catch-up flushed the other's unsent mutations into its server. */
    appId?: string;
    renderBudget?: { staleness?: number; pendingPatches?: number };
    /** Cells whose methods run locally and propagate as CRDT ops — the
     *  server's `localFirst` decision, which the browser cannot derive from
     *  the cell definitions alone. */
    syncCells?: string[];
    /** Resolved `await cell.method()` ceilings — effectTimeoutMs +
     *  perfBudget.methods[...].timeout, so the browser waits from the SAME
     *  numbers as the server (0 = wait indefinitely). */
    callTimeouts?: CallTimeouts;
  };
}

/** The resolved `await cell.method()` ceilings as bridged to a client:
 *  `default` = effectTimeoutMs, `methods` = per-method overrides — a number
 *  (0 = wait indefinitely) or `"warn"` (report once at the default ceiling and
 *  keep waiting; `perfBudget.methods[key].timeout: "warn"`). ONE type for
 *  every emitter and the consumer, so a mode the server knows cannot be
 *  silently dropped on the way to the browser. */
export type CallTimeouts = {
  default?: number;
  methods?: Record<string, number | "warn">;
};

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

/** Renderable content — a VNode, text, or a list of them. Structural, so it stays
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

/** A namespace of server functions as the CALLER sees it.
 *
 *  Every member returns a promise, whatever the body was declared as. That is
 *  not a convenience: the hop IS asynchronous — over the wire in the browser,
 *  and `Promise.resolve(...)`-wrapped on the server so the two agree — and a
 *  type that says otherwise is simply wrong. It was wrong in a way that cost
 *  every consumer: `logout(token: string): void` typed as `void` on both
 *  sides, so the natural `await api.logout(t).catch(…)` failed to compile
 *  (`Property 'catch' does not exist on type 'void'`) and the workaround was
 *  to declare bodies `async` that have nothing to await — carrying a
 *  `deno-lint-ignore require-await` each — which made the SERVER-side type
 *  less accurate to buy back a client-side one.
 *
 *  `Awaited<R>` so an already-async body does not become `Promise<Promise<T>>`.
 */
// deno-lint-ignore no-explicit-any
export type Remote<T extends Record<string, (...a: any[]) => any>> = {
  [K in keyof T]: T[K] extends (...a: infer P) => infer R
    ? (...a: P) => Promise<Awaited<R>>
    : never;
};
