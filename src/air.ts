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
  onCleanup,
  onMount,
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
  useLocal,
  useOptimistic,
  useProjection,
  useRaf,
  useRef,
  useSignal,
} from "./browser-air.ts";

// ── Time travel (@experimental) ──────────────────────────────────────
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

// ── SSR + islands ────────────────────────────────────────────────────
export {
  island,
  type IslandConfig,
  type IslandHandle,
  page,
  renderToStream,
} from "./browser-air.ts";
export { renderToString } from "./vdom.ts";
export type { Ref } from "./vdom.ts";

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
export type { TransitionResult } from "./transition.ts";

// ── Async data as signals ────────────────────────────────────────────
export { type Resource, resource } from "./browser-air.ts";

// ── Signal utilities ─────────────────────────────────────────────────
export { on, watch } from "./watch.ts";
export type { WatchOptions } from "./watch.ts";

// ── Forms ────────────────────────────────────────────────────────────
export { useFieldArray, useForm } from "./form.ts";
export type {
  FieldArrayState,
  FieldState,
  FormState,
  ValidationRule,
} from "./form.ts";

// ── Virtual scrolling ────────────────────────────────────────────────
export { useVirtualList } from "./virtual-list.ts";
export type { VirtualListConfig, VirtualListState } from "./virtual-list.ts";

// ── DevTools ─────────────────────────────────────────────────────────
export { connectAioDevTools } from "./devtools.ts";
export type {
  ComponentTreeNode,
  DevToolsHandle,
  RenderEvent,
} from "./devtools.ts";
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
