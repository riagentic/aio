// AIO Renderer — mount, per-component reactive re-render, unmount, hydrate.
// Connects signal.ts (reactive tracking) + vdom.ts (h/diff/render) into a component renderer.
//
// Architecture: per-component signal tracking, per-mount isolation.
// This file is the thin orchestrator. Logic lives in:
//   renderer-types.ts    — shared interfaces and helpers
//   renderer-state.ts    — global mutable vars (collector, instanceStack, activeRoot)
//   renderer-lifecycle.ts — onMount, onCleanup, useRef, useSignal, useId, useOptimistic
//   renderer-context.ts  — createContext, useContext, useContextSelector
//   renderer-flush.ts    — afterRender, flush scheduler, full root re-render
//   renderer-rerender.ts — per-component re-render engine, hooks factory
//   renderer-hydrate.ts  — hydrate, _hydrateNode, _hydrateProps

import type { ComponentFn, RenderCtx, VNode } from "./vdom.ts";
import {
  _callRef,
  _cleanupSignalTextChildren,
  _render,
  _setDelegationRoot,
  _setDevA11yCheck,
  _setSsrStartHook,
  _teardownDelegation,
  h,
  setDevMode as _setDevModeVdom,
} from "./vdom.ts";
import { _cleanupActions } from "./vdom-helpers.ts";
import { _componentName } from "./hook-error.ts";
import { removeDom } from "./vdom-remove.ts";
import { Portal } from "./vdom-types.ts";
import { cleanupSignalBindings } from "./signal-binding.ts";
import { _getExitHandler, _setLifecycleHooks } from "./transition-component.ts";
import {
  _getGroupExitHandler,
  _setGroupAfterRender,
} from "./transition-group.ts";
import type { MountHandle, RootState } from "./renderer-types.ts";
import {
  _liveRoots,
  _registerRoot,
  _rootStateMap,
  _setActiveRoot,
} from "./renderer-state.ts";
import {
  _resetSsrIdCounter,
  _setLifecycleDevMode,
  onCleanup,
  onMount,
  useRef,
} from "./renderer-lifecycle.ts";
import {
  _flushAfterRender,
  _flushPending,
  _rerenderRoot,
  afterRender,
} from "./renderer-flush.ts";
import { _createHooks, _setFlushDevMode } from "./renderer-rerender.ts";
import { _setSignalDevMode } from "../state/signal.ts";
/** Re-export the reactive `signal` primitive so air consumers (e.g. the ui kit)
 *  get it through the air surface without reaching into `state` directly. */
export { signal } from "../state/signal.ts";
import { _setHydrateDoc } from "./renderer-hydrate.ts";

// -- Re-exports (public API -- all importers use aio-renderer.ts) ------
export type { MountHandle } from "./renderer-types.ts";
export {
  _resetSsrIdCounter,
  onCleanup,
  onGlobalKey,
  onMount,
  useId,
  useOptimistic,
  useRef,
  useSignal,
} from "./renderer-lifecycle.ts";
export type { Context } from "./renderer-context.ts";
export {
  createContext,
  useContext,
  useContextSelector,
} from "./renderer-context.ts";
export { afterRender } from "./renderer-flush.ts";

// -- Document reference ------------------------------------------------

// deno-lint-ignore no-explicit-any
type AnyDoc = any;

let _doc: AnyDoc = typeof globalThis !== "undefined" && "document" in globalThis
  // deno-lint-ignore no-explicit-any
  ? (globalThis as any).document
  : null;

/** Set document reference (for happy-dom testing). */
export function _setDocument(doc: AnyDoc): void {
  _doc = doc;
  _setHydrateDoc(doc);
}

/** The document AIR is rendering into. Components that need document-level
 *  access (listeners, focus) should use this instead of the global `document`,
 *  so they work under testUI/SSR where there is no global document.
 *  Returns null when there is no DOM at all — always guard the result. */
export function _getDocument(): AnyDoc {
  return _doc;
}

// -- Dev mode ----------------------------------------------------------

// a11y checks run on EVERY element on EVERY render — a single offending
// element in a component that re-renders would flood the console with the
// same message. Warn once per distinct message (cleared when dev mode is
// re-toggled, so a fresh session re-reports).
const _warnedA11y = new Set<string>();
function _warnA11yOnce(msg: string): void {
  if (_warnedA11y.has(msg)) return;
  _warnedA11y.add(msg);
  console.warn(msg);
}

/** @internal Dev-mode a11y checks on element creation. */
function _devA11yCheck(tag: string, props: Record<string, unknown>): void {
  if (tag === "img" && !("alt" in props)) {
    _warnA11yOnce(
      '[aio-dev] <img> missing "alt" attribute. Add alt="" for decorative images or descriptive text for meaningful ones.',
    );
  }
  if (
    props.onClick &&
    !props.onKeyDown &&
    !props.onKeyUp &&
    !props.onKeyPress &&
    tag !== "button" &&
    tag !== "a" &&
    tag !== "input" &&
    tag !== "select" &&
    tag !== "textarea"
  ) {
    _warnA11yOnce(
      `[aio-dev] <${tag}> has onClick but no keyboard handler. Add onKeyDown for keyboard accessibility.`,
    );
  }
  if (
    (tag === "input" || tag === "textarea" || tag === "select") &&
    !props["aria-label"] &&
    !props["aria-labelledby"] &&
    !props.id
  ) {
    _warnA11yOnce(
      `[aio-dev] <${tag}> has no label association. Add id (for <label htmlFor>), aria-label, or aria-labelledby.`,
    );
  }
}

/** Enable dev-mode warnings (excessive re-renders, also enables VDOM key warnings). */
export function setDevMode(enabled: boolean): void {
  _setFlushDevMode(enabled);
  _setDevModeVdom(enabled);
  _setSignalDevMode(enabled);
  _setLifecycleDevMode(enabled);
  _warnedA11y.clear(); // re-arm a11y warnings for the (re)enabled session
  _setDevA11yCheck(enabled ? _devA11yCheck : null);
}

// -- Wire lifecycle hooks ----------------------------------------------

// Wire lifecycle hooks to <Transition> and <TransitionGroup> (avoids circular import)
_setLifecycleHooks(onMount, onCleanup, afterRender);
_setGroupAfterRender(afterRender, useRef);

// Wire SSR ID counter reset into renderToString
_setSsrStartHook(_resetSsrIdCounter);

// -- Mount -------------------------------------------------------------

/**
 * Mount a component tree into a DOM element and start the reactive render
 * loop. Returns a {@linkcode MountHandle} (mainly useful in tests).
 *
 * @example
 * ```tsx
 * import { mount } from "aio/air";
 * mount(document.getElementById("app")!, App);
 * ```
 */
// deno-lint-ignore no-explicit-any
export function mount(root: any, App: ComponentFn): MountHandle {
  root.innerHTML = "";

  const state: RootState = {
    root,
    vnode: null,
    disposed: false,
    ctx: { doc: _doc },
    pendingComponents: new Set(),
    flushScheduled: false,
    App,
    afterRenderQueue: [],
    _idCounter: 0,
    _renderCounts: new Map(),
  };

  const handle: MountHandle = {
    _flush() {
      if (state.disposed) return;
      _flushPending(state);
    },
  };

  _registerRoot(handle, state);
  state.ctx.hooks = _createHooks(state);
  state.ctx.onLazyResolve = () => {
    if (state.disposed) return;
    _rerenderRoot(state);
  };
  state.ctx.onBeforeRemove = (el) => {
    const inner = _getExitHandler(el);
    const outer = _getGroupExitHandler(el);
    if (inner && outer) {
      return Promise.all([inner(el), outer(el)]).then(() => {});
    }
    const handler = inner ?? outer;
    return handler ? handler(el) : undefined;
  };

  _setActiveRoot(state);
  _setDelegationRoot(root);
  try {
    const vnode = h(App, null);
    _render(state.root, vnode, null, state.ctx);
    state.vnode = vnode;
    _flushAfterRender(state);
  } finally {
    _setActiveRoot(null);
    _setDelegationRoot(null);
  }

  return handle;
}

// -- Hydrate -----------------------------------------------------------

export { hydrate } from "./renderer-hydrate.ts";

// -- Unmount -----------------------------------------------------------

export function _unmount(handle: MountHandle): void {
  const state = _rootStateMap.get(handle);
  if (!state) return;

  _liveRoots.delete(state);
  state.disposed = true;
  state.pendingComponents.clear();
  state._renderCounts.clear(); // AIO-278

  if (state.vnode && typeof state.vnode === "object") {
    _unmountTree(state.vnode, state.ctx);
  }

  if (state.root && typeof state.root.addEventListener === "function") {
    _teardownDelegation(state.root);
  }

  state.root.innerHTML = "";
}

function _unmountTree(
  vnode: VNode | string | number | null,
  ctx: RenderCtx,
): void {
  if (vnode == null || typeof vnode !== "object") return;
  if (typeof vnode.tag === "function") {
    ctx.hooks?.unmountComponent(vnode);
    _unmountTree(vnode._rendered ?? null, ctx);
  } else if (vnode.tag === Portal) {
    // AIO-418: Portal children live in props.target, NOT under the mount root —
    // the final `root.innerHTML = ""` never touches them, so a full unmount
    // leaked them in the target forever. removeDom runs the same cleanups
    // (refs, actions, signal bindings, component unmount hooks) AND removes
    // the nodes from the target.
    const target = vnode.props.target as Node | undefined;
    if (target) {
      for (const child of vnode.children) removeDom(target, child, ctx);
    } else {
      for (const child of vnode.children) _unmountTree(child, ctx);
    }
  } else {
    if (vnode._dom && typeof (vnode._dom as Element).tagName === "string") {
      const dom = vnode._dom as Element;
      // AIO-78: dispose signal binding effects on element
      cleanupSignalBindings(dom);
      _cleanupSignalTextChildren(dom);
      // Mirror _removeDomCleanup (vdom-remove.ts): run action cleanups so
      // custom directives (window listeners, observers) release, and null out
      // ref callbacks so callers see the element is gone. Without this the
      // top-level unmount path (innerHTML="") leaked refs + action listeners.
      // Duck-type the element (setInputElement etc. live on HTMLElement) so we
      // don't depend on the HTMLElement global being defined (test envs may
      // install it on a non-global realm).
      if (typeof (dom as HTMLElement).setAttribute === "function") {
        _cleanupActions(dom as HTMLElement);
      }
      _callRef(vnode.props.ref, null, _componentName(vnode.tag));
    }
    for (const child of vnode.children) {
      _unmountTree(child, ctx);
    }
  }
}
