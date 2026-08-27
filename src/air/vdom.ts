// AIO VDOM Engine — thin re-export facade. Implementation lives in vdom-*.ts modules.

// ── Types & constants (vdom-types.ts) ────────────────────────────────
export type {
  Action,
  ComponentFn,
  NodeAction,
  Ref,
  RenderCtx,
  VChild,
  VDomHooks,
  VNode,
} from "./vdom-types.ts";
export {
  _DOM_PROPS,
  _LAZY_PENDING,
  _Null,
  _setDevA11yCheck,
  ErrorBoundary,
  Fragment,
  Portal,
  setDevMode,
  Suspense,
  SVG_TAGS,
} from "./vdom-types.ts";

// ── Element creation (vdom-create.ts) ────────────────────────────────
export { _callRef, h } from "./vdom-create.ts";

// ── Rendering (vdom-render.ts) ───────────────────────────────────────
export { _render, createDom } from "./vdom-render.ts";

// ── Diffing / reconciliation (vdom-diff.ts) ──────────────────────────
export { _diff } from "./vdom-diff.ts";

// ── DOM removal (vdom-remove.ts) ─────────────────────────────────────
export { getDom } from "./vdom-remove.ts";

// ── Event delegation (vdom-events.ts) ────────────────────────────────
export {
  _ensureDelegation,
  _isDelegated,
  _mapEventName,
  _setDelegationRoot,
  _setWrapped,
  _teardownDelegation,
  _wrapHandler,
} from "./vdom-events.ts";

// ── Signal/action helpers (vdom-helpers.ts) ──────────────────────────
export {
  _applyActions,
  _bindSignalTextChildren,
  _cleanupSignalTextChildren,
} from "./vdom-helpers.ts";

// ── Lazy loading (vdom-lazy.ts) ──────────────────────────────────────
export { _getLazyListeners, lazy } from "./vdom-lazy.ts";

// ── SSR (vdom-ssr.ts) ───────────────────────────────────────────────
export {
  _invokeSsrStartHook,
  _setSsrStartHook,
  renderToString,
} from "./vdom-ssr.ts";
