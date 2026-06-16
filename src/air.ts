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

// ── Full AIR runtime (hooks, routing, signals, rendering, protocol) ──
export * from "./browser-air.ts";

// ── VDOM extras not in browser-air ───────────────────────────────────
export {
  ErrorBoundary,
  Fragment,
  lazy,
  Portal,
  renderToString,
  Suspense,
} from "./vdom.ts";
export type { Action, Ref } from "./vdom.ts";

// ── AIR component utilities ──────────────────────────────────────────
export { useFieldArray, useForm } from "./form.ts";
export type {
  FieldArrayState,
  FieldState,
  FormState,
  ValidationRule,
} from "./form.ts";
export { useSpring } from "./animation.ts";
export type { SpringConfig, SpringValue } from "./animation.ts";
// ── Transitions ─────────────────────────────────────────────────────
export { fade, scale, slide } from "./transition.ts";
export type {
  TransitionFn,
  TransitionOptions,
  TransitionResult,
} from "./transition.ts";
export { Transition } from "./transition-component.ts";
export type { TransitionProps } from "./transition-component.ts";
export { TransitionGroup } from "./transition-group.ts";
export type { TransitionGroupProps } from "./transition-group.ts";
export { Show } from "./show.ts";
export { useVirtualList } from "./virtual-list.ts";
export type { VirtualListConfig, VirtualListState } from "./virtual-list.ts";
export { connectAioDevTools } from "./devtools.ts";
export type {
  ComponentTreeNode,
  DevToolsHandle,
  RenderEvent,
} from "./devtools.ts";

// ── Island (external framework mounting) ────────────────────────────
export { island, type IslandConfig, type IslandHandle } from "./island.ts";

// ── Async data as signals ────────────────────────────────────────────
export { type Resource, resource } from "./resource.ts";

// ── Signal utilities ─────────────────────────────────────────────────
export { on, watch } from "./watch.ts";
export type { WatchOptions } from "./watch.ts";

// React migration compat hooks (useState/useEffect/useMemo/useCallback) live
// at "aio/air/compat" only — off the main surface. `useRef` is a native AIR
// primitive and remains exported via ./browser-air.ts above.
