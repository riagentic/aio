// deno-lint-ignore-file
// browser-air: AIR renderer entry point for aio.
// Thin barrel — delegates to focused modules.

// ── Transport (side-effectful — must import to wire up WS/IPC) ──────
import "./browser-air-transport.ts";
export { setSyncMessageHandler } from "./browser-air-transport.ts";

// ── Protocol re-exports (public API surface) ────────────────────────
export {
  _accessedPaths,
  _applyPatch,
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
  _deepMergeFiltered,
  _getArrayRefStats,
  type _HandleResult,
  _incStateVersion,
  _memoCompare,
  _preserveArrayRefs,
  _projectWithSharing,
  _rebuildIdMaps,
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
} from "./browser-protocol.ts";

// ── Time travel ─────────────────────────────────────────────────────
export { useTimeTravel } from "./time-travel-air.ts";

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
  useContext,
  useContextSelector,
  useId,
  useOptimistic,
  useRef,
  useSignal,
} from "./aio-renderer.ts";
export {
  type Action,
  type ComponentFn,
  h,
  type VChild,
  type VNode,
} from "./vdom.ts";
export {
  batch,
  type Computed,
  computed,
  effect,
  type Signal,
  signal,
  untrack,
} from "./signal.ts";
export { Show } from "./show.ts";
export { ErrorBoundary, Fragment, lazy, Portal, Suspense } from "./vdom.ts";

// ── Transitions and animations ──────────────────────────────────────
export { Transition, type TransitionProps } from "./transition-component.ts";
export {
  TransitionGroup,
  type TransitionGroupProps,
} from "./transition-group.ts";
export {
  fade,
  scale,
  slide,
  type TransitionFn,
  type TransitionOptions,
} from "./transition.ts";
export {
  type SpringConfig,
  type SpringValue,
  type TransitionConfig,
  type TransitionState,
  useSpring,
  useTransition,
} from "./animation.ts";

// ── Island (external framework mounting) ────────────────────────────
export { island, type IslandConfig, type IslandHandle } from "./island.ts";

// ── Trigger-based lazy loading ──────────────────────────────────────
export { Defer, type DeferProps, type DeferTrigger } from "./defer.ts";

// ── Async data as signals ────────────────────────────────────────────
export { type Resource, resource } from "./resource.ts";

// ── Reactive element dimensions ──────────────────────────────────────
export { type DimensionsState, useDimensions } from "./dimensions.ts";

// ── Streaming SSR ──────────────────────────────────────────────────
export { renderToStream } from "./ssr-stream.ts";

// ── Shared utilities (AIO-47) ──────────────────────────────────────
export { actions, effects, msg, schedule } from "./browser-shared.ts";

// ── AIR hooks (signal-based) ────────────────────────────────────────
export {
  memo,
  useAio,
  useCell,
  useConnected,
  useLocal,
  useProjection,
} from "./browser-air-hooks.ts";

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
} from "./browser-air-router.ts";
