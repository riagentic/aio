// deno-lint-ignore-file
// browser-air: AIR renderer entry point for aio.
// Thin barrel — delegates to focused modules.

// ── Transport (side-effectful — must import to wire up WS/IPC) ──────
import "./browser/browser-air-transport.ts";
import type {
  serverAuth as ServerAuth,
  serverRequest as ServerRequest,
  serverUser as ServerUser,
} from "./server/auth-context.ts";
import type { blocking as ServerBlocking } from "./state/blocking.ts";
import { blockingServerOnly } from "./state/blocking-reason.ts";
export {
  // Documented in docs/persistence/offline.md and docs/clients/browser.md as
  // the way to drive a "reconnecting / slow connection" indicator — but it was
  // exported from no public entry, so the import in those docs could not
  // resolve. A capability the docs promise and the package does not expose is
  // a broken promise either way; exporting it is the additive half of the fix.
  isConnectionDegraded,
  setSyncMessageHandler,
} from "./browser/browser-air-transport.ts";
/** serverFn seam (B3) — typed WS proxy to serverFns registered on the server. */
export { serverFn, serverFns } from "./browser/server-fns-client.ts";

// ── Protocol re-exports (public API surface) ────────────────────────
export {
  _accessedPaths,
  _BLOCKED_KEYS,
  _checkStateIntegrity,
  _checkWastedRenders,
  _collapsePaths,
  _coreGetState,
  _coreHandleMessage,
  _coreHasState,
  _coreResendSubs,
  _coreSetConnected,
  _coreSetTransport,
  _getArrayRefStats,
  type _HandleResult,
  _incStateVersion,
  _memoCompare,
  _preserveArrayRefs,
  _projectWithSharing,
  _resetArrayRefStats,
  _resetTracking,
  _resolveStateReady,
  _setClientSend,
  _setConnectFn,
  _setSubscribeTriggers,
  _setTeardownFn,
  _shallowEqual,
  _subscribe,
  _trackingProxy,
  _useAioSubscribe,
  _w,
  _waitForState,
  aio,
  cell,
  client,
  connectReduxDevTools,
  disconnectReduxDevTools,
  ensureConnected,
  type LinkProps,
  log,
  matchPath,
  navigate,
  routePath,
  type RouteProps,
  routeSearch,
  type RouteState,
} from "./browser/browser-protocol.ts";

// ── Time travel ─────────────────────────────────────────────────────
export { useTimeTravel } from "./air/time-travel-air.ts";

// ── AIR renderer primitives (AIO-70) ────────────────────────────────
export {
  afterRender,
  type Context,
  createContext,
  hydrate,
  mount,
  type MountHandle,
  onCleanup,
  onGlobalKey,
  onMount,
  onWindowEvent,
  setDevMode,
  useContext,
  useContextSelector,
  useId,
  useOptimistic,
  useRef,
  useSignal,
} from "./air/aio-renderer.ts";
export {
  type ComponentFn,
  h,
  type NodeAction,
  type VChild,
  type VNode,
} from "./air/vdom.ts";
export {
  batch,
  type Computed,
  computed,
  effect,
  type Signal,
  signal,
  trackedMemo,
  untrack,
} from "./state/signal.ts";
export { Show } from "./air/show.ts";
export { ErrorBoundary, Fragment, lazy, Portal, Suspense } from "./air/vdom.ts";

// ── Transitions and animations ──────────────────────────────────────
export {
  Transition,
  type TransitionProps,
} from "./air/transition-component.ts";
export {
  TransitionGroup,
  type TransitionGroupProps,
} from "./air/transition-group.ts";
export {
  fade,
  scale,
  slide,
  type TransitionFn,
  type TransitionOptions,
} from "./air/transition.ts";
export {
  type SpringConfig,
  type SpringValue,
  useSpring,
} from "./air/animation.ts";

// ── Island (external framework mounting) ────────────────────────────
export { island, type IslandConfig, type IslandHandle } from "./air/island.ts";

// ── Trigger-based lazy loading ──────────────────────────────────────
export { Defer, type DeferProps, type DeferTrigger } from "./air/defer.ts";

// ── Async data as signals ────────────────────────────────────────────
export { type Resource, resource } from "./air/resource.ts";
// A keyed resource you HOLD (a camera, a socket, a pipeline) and the reaction
// that decides when to swap it — see air/use-resource.ts.
export {
  type Dispose,
  onChange,
  type OnChangeOptions,
  type ResourceHandle,
  type ResourceKey,
  useResource,
  type UseResourceConfig,
} from "./air/use-resource.ts";
// ── Per-page <head> ───────────────────────────────────────────────────────
// `useHead` owns document.title and its meta/link tags while a component is
// mounted; `collectHead` is the SSR half — see air/head.ts.
export {
  collectHead,
  type HeadInput,
  type HeadTag,
  useHead,
} from "./air/head.ts";

// ── Reactive element dimensions ──────────────────────────────────────
export { type DimensionsState, useDimensions } from "./air/dimensions.ts";

// ── Managed requestAnimationFrame loop ───────────────────────────────
export { useInterval, useRaf } from "./air/raf.ts";

// ── Component test harness (symmetric with testCell) ─────────────────
export {
  setDocument,
  testComponent,
  type TestComponentHandle,
  type TestComponentOptions,
} from "./testing/test-component.ts";

// ── Streaming SSR ──────────────────────────────────────────────────
export { renderToStream } from "./air/ssr-stream.ts";

// ── Shared utilities (AIO-47) ──────────────────────────────────────
export { msg, notify, own, schedule } from "./browser/browser-shared.ts";
// `self("m")` is how a cell schedules its own method (docs/state/scheduling.md)
// and a cell module is in the client graph, so the name has to resolve HERE —
// mod.ts exporting it alone type-checked the doc example and then refused it at
// bundle time (report 9b §3). state/self.ts has no imports: nothing server-side
// rides along. tests/browser-air-mod-parity.test.ts gates the next such name.
export { self } from "./state/self.ts";
export type { SelfAction } from "./state/self.ts";
// The rest of that class: names mod.ts exports that a cell module (or a
// component) imports from "aio" in the docs' own examples — `race`/`until` in
// async methods (docs/state/methods.md), `call` (quickstart), `errorCode`
// (docs/debugging/errors.md), `createSelector`, `authClient`. Each one
// type-checked and then refused the browser bundle exactly as `self` did.
// Every module below is Deno-free and the SAME implementation mod.ts exports
// (tests/browser-air-mod-parity.test.ts pins identity and the ledger;
// tests/browser-bundle-self-export.test.ts bundles each for the browser).
export { call } from "./state/cell-impl.ts";
export {
  race,
  type RaceResult,
  sleep,
  until,
  type UntilOptions,
  UntilTimeoutError,
} from "./state/async-helpers.ts";
export { errorCode } from "./protocol/envelope.ts";
export { createSelector, type Selector } from "./selector.ts";
export { authClient, createAuthClient } from "./browser/auth-client.ts";
export {
  type Degraded,
  degraded,
  degradedReport,
} from "./diagnostics/degraded.ts";
// Server-side work a cell METHOD does, spelled in the cell module — which the
// UI imports. The method body never runs in the browser (a browser cell is a
// protocol stub), but the import has to resolve or the bundle is refused.
// `serverImport` is documented "in the cell" (docs/testing/ui-testing.md) and
// has no imports.
export { serverImport } from "./state/server-import.ts";

// ── Server-only names, as browser facades that refuse when CALLED ─────
// docs/auth/auth.md and docs/debugging/performance.md import these into a
// cell module, so the name has to resolve here or the bundle is refused.
// None can be a re-export: auth-context.ts needs node:async_hooks, and
// blocking.ts's facade assignments (`blocking.cancel = …`) are statements
// esbuild keeps, which would pin the whole worker pool on every page. Each
// facade is a pure-annotated const — 0 bytes unless a page uses it — and a
// call throws (a sync method replayed here under sync/localFirst fails loud
// instead of reading `undefined` as "anonymous").
// tests/browser-server-only-stubs.test.ts bundles the docs' examples.
const serverOnly = (name: string) => (): never => {
  throw new Error(
    `[aio] ${name}() is server-only — it ran in the browser; call it from ` +
      `an async method, a *.server.ts module or a route`,
  );
};
export const serverUser: typeof ServerUser = /* @__PURE__ */ serverOnly(
  "serverUser",
);
export const serverRequest: typeof ServerRequest = /* @__PURE__ */ serverOnly(
  "serverRequest",
);
export const serverAuth: typeof ServerAuth = /* @__PURE__ */ serverOnly(
  "serverAuth",
);
/** `blocking` in a browser: the same refusal blocking.ts gives any runtime
 *  without Deno (blocking-reason.ts), with an inert cancel/dispose — there is
 *  never a pool here to cancel. */
export const blocking: typeof ServerBlocking = /* @__PURE__ */ Object.assign(
  (id: string): Promise<never> =>
    Promise.reject(new Error(blockingServerOnly(id))),
  {
    cancel: (_id: string): boolean => false,
    disposeIdle: (): boolean => true,
    dispose: (): Promise<void> => Promise.resolve(),
  },
);
/** Ask for desktop-notification permission from a click handler — the one
 *  place a browser grants it. See `notify()`. */
export { requestNotificationPermission } from "./browser/desktop-notify.ts";

// ── AIR hooks (signal-based) ────────────────────────────────────────
export {
  memo,
  useAio,
  useConnected,
  useLocal,
  useProjection,
} from "./browser/browser-air-hooks.ts";
export type { UseLocalResult } from "./adapters/air.ts";

// ── Router (AIR signal-based) ───────────────────────────────────────
export {
  Link,
  NavLink,
  Outlet,
  page,
  Redirect,
  Route,
  useNavigate,
  useRoute,
} from "./browser/browser-air-router.ts";

// ── Auth UI (AUTH-2) — drop-in login/signup form + reactive identity ──
export {
  authUser,
  SignIn,
  type SignInProps,
  signOut,
  useUser,
} from "./browser/browser-auth-ui.ts";

// ── Unit formatters ───────────────────────────────────────────────────
// The browser half of `aio`'s `bytes`/`dur`/`count` (mod.ts). They are pure
// and isomorphic — a real re-export of the same module, not a stub — and they
// are here because this file IS `aio` inside a browser bundle: a tile showing
// a file size and the CLI row showing the same size have to agree, and the
// only way that holds is if both import the one implementation.
export { bytes, count, dur } from "./diagnostics/fmt.ts";
