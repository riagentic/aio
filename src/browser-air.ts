// deno-lint-ignore-file
// browser-air: AIR renderer entry point for aio.
// Thin barrel — delegates to focused modules.

// ── Transport (side-effectful — must import to wire up WS/IPC) ──────
import "./browser/browser-air-transport.ts";
export { setSyncMessageHandler } from "./browser/browser-air-transport.ts";
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
  bridge,
  cell,
  client,
  connectDevTools,
  disconnectDevTools,
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
  onMount,
  setDevMode,
  useContext,
  useContextSelector,
  useId,
  useOptimistic,
  useRef,
  useSignal,
} from "./air/aio-renderer.ts";
export {
  type Action,
  type ComponentFn,
  h,
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

// ── Reactive element dimensions ──────────────────────────────────────
export { type DimensionsState, useDimensions } from "./air/dimensions.ts";

// ── Managed requestAnimationFrame loop ───────────────────────────────
export { useRaf } from "./air/raf.ts";

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
export {
  actions,
  effects,
  msg,
  own,
  schedule,
} from "./browser/browser-shared.ts";

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
