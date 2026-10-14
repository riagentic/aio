// AIO Renderer — mount, per-component reactive re-render, unmount, hydrate.
// Connects signal.ts (reactive tracking) + vdom.ts (h/diff/render) into a component renderer.
//
// Architecture: per-component signal tracking, per-mount isolation.
// This file is the thin orchestrator. Logic lives in:
//   renderer-types.ts    — shared interfaces and helpers
//   renderer-state.ts    — global mutable vars (collector, instanceStack, activeRoot)
//   renderer-lifecycle.ts — onMount, onCleanup, onUnmount, useRef, useSignal, useId, useOptimistic
//   renderer-context.ts  — createContext, useContext, useContextSelector
//   renderer-flush.ts    — afterRender, flush scheduler, full root re-render
//   renderer-rerender.ts — per-component re-render engine, hooks factory
//   renderer-hydrate.ts  — hydrate, _hydrateNode, _hydrateProps

import type { ComponentFn, RenderCtx, VNode } from "./vdom.ts";
import {
  _render,
  _setDelegationRoot,
  _setDevA11yCheck,
  _teardownDelegation,
  h,
  setDevMode as _setDevModeVdom,
} from "./vdom.ts";
import { _detachRef } from "./vdom-create.ts";
import { _cleanupActions, _unbindSignalText } from "./vdom-helpers.ts";
import { _componentName } from "./hook-error.ts";
import { saysOnce } from "../protocol/said-once.ts";
import { _cleanupChildren, removeDom } from "./vdom-remove.ts";
import { _SignalText, Portal } from "./vdom-types.ts";
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
import { onCleanup, onMount, useRef } from "./renderer-lifecycle.ts";
import {
  _flushAfterRender,
  _flushAll,
  _rerenderRoot,
  afterRender,
} from "./renderer-flush.ts";
import { _createHooks } from "./renderer-rerender.ts";
/** Re-export the reactive `signal` primitive so air consumers (e.g. the ui kit)
 *  get it through the air surface without reaching into `state` directly. */
export { signal } from "../state/signal.ts";
// Registers the renderer's component-tree walker with DevTools (import for
// the side effect — `connectAioDevTools().tree` reads through it).
import "./devtools-tree.ts";
import { _setHydrateDoc } from "./renderer-hydrate.ts";
import { devHooks } from "./dev-hooks.ts";

// -- Re-exports (public API -- all importers use aio-renderer.ts) ------
export type { MountHandle } from "./renderer-types.ts";
// Re-exported straight from its module: this file no longer calls it. The SSR
// start hook it used to serve is gone — a server render owns its own id
// sequence now (see air/ssr-render.ts), and this is the seam `aio/ui` uses to
// make control ids predictable in a test.
export { _resetSsrIdCounter } from "./renderer-lifecycle.ts";
export {
  onCleanup,
  onGlobalKey,
  onMount,
  onUnmount,
  onWindowEvent,
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

/** Enable dev-mode warnings (excessive re-renders, also enables VDOM key warnings). */
export function setDevMode(enabled: boolean | "auto"): void {
  // One flag for the whole runtime now (src/state/dev-flag.ts), so this no
  // longer fans out to five copies that could disagree — it forces the one,
  // and re-arms the caches that are this module's own.
  _setDevModeVdom(enabled);
  devHooks.rearm?.(); // a (re)enabled session hears its once-only lines again
  // A production bundle does not carry the dev layer (air/dev-air.ts), so
  // forcing dev mode on there turns on less than it does in a dev session —
  // and a session that believes a check ran is the failure worth one line.
  if (enabled === true && !devHooks.rearm) {
    saysOnce(
      "setDevMode(true) on a production bundle: the accessibility, key, " +
        "unknown-event, controlled-input and re-render-loop checks are not " +
        "in it — they run under `deno task dev` and in tests. The other dev " +
        "warnings are on.",
      "devmode-prod",
    );
  }
}

// The a11y check is wired wherever the dev layer is (air/dev-air.ts: every
// runtime that runs source — a dev page, a test, a server render) and asks
// `isDevMode()` itself. A production bundle has no dev layer, so the slot
// stays null and `createDom` does not even make the call.
_setDevA11yCheck(devHooks.a11y ?? null);

// -- Wire lifecycle hooks ----------------------------------------------

// Wire lifecycle hooks to <Transition> and <TransitionGroup> (avoids circular import)
_setLifecycleHooks(onMount, onCleanup, afterRender);
_setGroupAfterRender(afterRender, useRef);

// Nothing to wire at the start of a server render any more. The `useId`
// counter, the collected <head> and the <select> scope stack used to be
// module-wide and were RESET here per render — which is the same statement as
// "every render shares them", and is what let two concurrent `renderToStream`s
// hand each other's pages the wrong ids and the wrong <title> (see
// air/ssr-render.ts). Each render owns its own now.

// -- Mount -------------------------------------------------------------

/**
 * Mount a component tree into a DOM element and start the reactive render
 * loop. Returns a {@linkcode MountHandle} (mainly useful in tests).
 *
 * @example
 * ```tsx
 * import { h, mount } from "aio/air";
 * const App = () => h("p", null, "hello");
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
      _flushAll(state);
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
  devHooks.cancelDriftChecks?.(state.root);
}

function _unmountTree(
  vnode: VNode | string | number | null,
  ctx: RenderCtx,
): void {
  if (vnode == null || typeof vnode !== "object") return;
  if (vnode.tag === _SignalText) {
    _unbindSignalText(vnode);
  } else if (typeof vnode.tag === "function") {
    ctx.hooks?.unmountComponent(vnode);
    for (const child of _cleanupChildren(vnode)) _unmountTree(child, ctx);
  } else if (vnode.tag === Portal) {
    // AIO-418: Portal children live in props.target, NOT under the mount root —
    // the final `root.innerHTML = ""` never touches them, so a full unmount
    // leaked them in the target forever. removeDom runs the same cleanups
    // (refs, actions, signal bindings, component unmount hooks) AND removes
    // the nodes from the target.
    const target = vnode.props.target as Node | undefined;
    if (target) {
      // The Portal branch of `removeDom` is THE teardown for portal content —
      // it walks from the portal's own region anchor and takes that anchor
      // with it. Re-implementing the child loop here took `target.firstChild`
      // as the start, which is another portal's content when two share one.
      removeDom(target, vnode, ctx);
    } else {
      for (const child of vnode.children) _unmountTree(child, ctx);
    }
  } else {
    if (vnode._dom && typeof (vnode._dom as Element).tagName === "string") {
      const dom = vnode._dom as Element;
      // AIO-78: dispose signal binding effects on element
      cleanupSignalBindings(dom);
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
      _detachRef(vnode.props.ref, dom, _componentName(vnode.tag));
    }
    // `_cleanupChildren` (vdom-remove.ts) is THE rule for what lives under a
    // vnode — an ErrorBoundary/Suspense in FALLBACK state has its `_rendered`
    // there, not its children. Walking `children` blindly left every fallback
    // subtree mounted on a root unmount (leaked onCleanup + live signal
    // subscriptions, and `testUI` teardown goes through here).
    for (const child of _cleanupChildren(vnode)) {
      _unmountTree(child, ctx);
    }
  }
}
