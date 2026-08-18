// deno-lint-ignore-file
/**
 * @module
 * AIR renderer — `aio/air`.
 *
 * Browser-side rendering: signals, hooks, routing, forms, animation,
 * virtual scrolling, and devtools. For server/universal APIs, import from `aio`.
 *
 * @example
 * ```ts
 * import { aio, cell } from "aio";            // state (universal)
 * import { signal, onMount } from "aio/air";  // rendering (browser)
 * ```
 */

// Curated named surface (roadmap A1). Everything routed through
// ./browser-air.ts so its transport side-effect import still runs.
// Internals (`_`-prefixed, protocol plumbing) stay in ./browser-air.ts /
// ./browser-protocol.ts for src/* and tests — they are not public API.

// ── Signals ──────────────────────────────────────────────────────────
export {
  batch,
  type Computed,
  computed,
  effect,
  memo,
  type Signal,
  signal,
  untrack,
} from "./browser-air.ts";

// ── Rendering primitives + lifecycle ─────────────────────────────────
// `NodeAction` is the `use`-prop signature (alpha52 rename; `Action` is its
// deprecated alias through beta — the bare name collided with the state
// layer's action vocabulary).
export {
  type Action,
  afterRender,
  type ComponentFn,
  type Context,
  createContext,
  h,
  hydrate,
  mount,
  type MountHandle,
  type NodeAction,
  onCleanup,
  onGlobalKey,
  onMount,
  setDevMode,
  type VChild,
  type VNode,
} from "./browser-air.ts";

// ── Hooks ────────────────────────────────────────────────────────────
export {
  type DimensionsState,
  useAio,
  useConnected,
  useContext,
  useContextSelector,
  useDimensions,
  useId,
  useInterval,
  useLocal,
  useOptimistic,
  useProjection,
  useRaf,
  useRef,
  useSignal,
} from "./browser-air.ts";
export type { UseLocalResult } from "./browser-air.ts";
// `useCell` was REMOVED in alpha52 (deprecated since alpha41): `.state` was a
// LIVE proxy, so the natural stash-and-diff idiom silently compared state to
// itself. Read the cell directly (`counter.count`) — aiol reports remaining
// uses and `--safe-fix` rewrites the mechanical `useCell(c).state.x` form.

// ── Time travel ──────────────────────────────────────
export { useTimeTravel } from "./browser-air.ts";

// ── Components ───────────────────────────────────────────────────────
export {
  Defer,
  type DeferProps,
  type DeferTrigger,
  ErrorBoundary,
  Fragment,
  lazy,
  Portal,
  Show,
  Suspense,
} from "./browser-air.ts";

// ── Router ───────────────────────────────────────────────────────────
export {
  Link,
  type LinkProps,
  navigate,
  NavLink,
  Outlet,
  Redirect,
  Route,
  routePath,
  type RouteProps,
  routeSearch,
  type RouteState,
  useNavigate,
  useRoute,
} from "./browser-air.ts";

// ── Auth UI — drop-in <SignIn/> + reactive useUser() (AUTH-2) ────────
export { SignIn, type SignInProps, signOut, useUser } from "./browser-air.ts";

// ── SSR + islands ────────────────────────────────────────────────────
export {
  island,
  type IslandConfig,
  type IslandHandle,
  page,
  renderToStream,
} from "./browser-air.ts";
// React (and other framework) components as islands — the blessed path.
export { reactIsland, type ReactIslandConfig } from "./air/react-island.ts";
export { renderToString } from "./air/vdom.ts";
export type { Ref } from "./air/vdom.ts";

// ── Transitions and animation ────────────────────────────────────────
export {
  fade,
  scale,
  slide,
  type SpringConfig,
  type SpringValue,
  Transition,
  type TransitionFn,
  TransitionGroup,
  type TransitionGroupProps,
  type TransitionOptions,
  type TransitionProps,
  useSpring,
} from "./browser-air.ts";
export type { TransitionResult } from "./air/transition.ts";

// ── Async data as signals ────────────────────────────────────────────
export { type Resource, resource } from "./browser-air.ts";

// ── Signal utilities ─────────────────────────────────────────────────
export { on, watch } from "./state/watch.ts";
export type { WatchOptions } from "./state/watch.ts";

// ── Offline / connection health ──────────────────────────────────────
// `isConnectionDegraded()` is how docs/persistence/offline.md and
// docs/clients/browser.md tell you to drive a "reconnecting / slow connection"
// indicator — and both pages import from `aio/air`, which did not export it.
// The function was real and correct the whole time; only the door was missing.
export { isConnectionDegraded } from "./browser-air.ts";

// ── Forms ────────────────────────────────────────────────────────────
export { useFieldArray, useForm } from "./air/form.ts";
export type {
  FieldArrayState,
  FieldState,
  FormState,
  ValidationRule,
} from "./air/form.ts";

// ── Virtual scrolling ────────────────────────────────────────────────
export { useVirtualList } from "./air/virtual-list.ts";
export type {
  VirtualListConfig,
  VirtualListState,
} from "./air/virtual-list.ts";

// ── DevTools ─────────────────────────────────────────────────────────
export { connectAioDevTools } from "./diagnostics/devtools.ts";
export type {
  ComponentTreeNode,
  DevToolsHandle,
  RenderEvent,
} from "./diagnostics/devtools.ts";
export { connectDevTools, disconnectDevTools } from "./browser-air.ts";

// ── Component test harness (symmetric with testCell) ─────────────────
export {
  setDocument,
  testComponent,
  type TestComponentHandle,
  type TestComponentOptions,
} from "./browser-air.ts";

// React migration compat hooks (useState/useEffect/useMemo/useCallback) live
// at "aio/air/compat" only — off the main surface. `useRef` is a native AIR
// primitive and remains exported above.
