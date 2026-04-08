// renderer-hooks.ts — VDomHooks factory for per-component reactive tracking.
// Provides: _createHooks (beforeComponent, afterComponent, afterSubtree, abortComponent, unmountComponent).

import {
  _computedCollectEnd,
  _computedCollectStart,
  _computedDisposeAll,
  _effectCollectEnd,
  _effectCollectStart,
  _effectDisposeAll,
  _trackEnd,
  _trackStart,
} from "./signal.ts";
import type { VDomHooks, VNode } from "./vdom.ts";
import {
  _childrenEqual,
  _runCleanups,
  _shallowEqual,
  type ComponentInstance,
  type HookState,
  type LifecycleCollector,
  type RootState,
} from "./renderer-types.ts";
import {
  _currentCollector,
  _instanceStack,
  _setCurrentCollector,
  _setInsideMount,
} from "./renderer-state.ts";
import { _subscribeComponentDeps } from "./renderer-rerender.ts";

// -- Dev mode ----------------------------------------------------------

let _devMode = false;
export function _setHooksDevMode(v: boolean): void {
  _devMode = v;
}

// -- Hooks factory -----------------------------------------------------

export function _createHooks(rootState: RootState): VDomHooks {
  return {
    beforeComponent(
      vnode: VNode,
      oldVnode: VNode | null,
      parentDom: Node,
      isSvg: boolean,
    ): HookState {
      const inst = vnode._instance as ComponentInstance | undefined;

      // Auto-memo: skip re-execution if props/children unchanged
      if (inst && oldVnode && !inst.selfTriggered) {
        if (
          _shallowEqual(vnode.props, inst.prevProps) &&
          _childrenEqual(vnode.children, inst.prevChildren)
        ) {
          return {
            skip: true,
            deps: null,
            collected: null,
            effectCollected: null,
            parentDom,
            isSvg,
          };
        }
      }

      if (inst) {
        _runCleanups(inst.cleanupCallbacks);
        inst.cleanupCallbacks = [];
        inst.mountCallbacks = []; // AIO-161
        for (const unsub of inst.unsubs) unsub();
        inst.unsubs = [];
        _computedDisposeAll(inst.computeds);
        _effectDisposeAll(inst.effectDisposes);
      }

      const collected = _computedCollectStart();
      const effectCollected = _effectCollectStart();
      const deps = _trackStart();

      const collector: LifecycleCollector = inst ??
        { mountCallbacks: [], cleanupCallbacks: [] };
      collector.refIndex = 0;
      _setCurrentCollector(collector);

      return {
        skip: false,
        deps,
        collected,
        effectCollected,
        parentDom,
        isSvg,
      };
    },

    afterComponent(
      vnode: VNode,
      rendered: VNode | string | number | null,
      state: unknown,
    ): void {
      const hs = state as HookState;
      if (hs.skip) {
        _setCurrentCollector(null);
        return;
      }

      _trackEnd(hs.deps!);
      _computedCollectEnd(hs.collected!);
      _effectCollectEnd(hs.effectCollected!);

      // Capture collector — set in beforeComponent, populated during component fn body
      const collector = _currentCollector!;
      _setCurrentCollector(null);

      let inst = vnode._instance as ComponentInstance | undefined;
      const isFirstRender = !inst;
      if (!inst) {
        inst = {
          deps: hs.deps!,
          unsubs: [],
          computeds: hs.collected!,
          effectDisposes: hs.effectCollected!,
          parentDom: hs.parentDom,
          vnode,
          oldRendered: rendered,
          isSvg: hs.isSvg,
          pendingRender: false,
          disposed: false,
          prevProps: { ...vnode.props },
          prevChildren: vnode.children,
          selfTriggered: false,
          _ctx: rootState.ctx,
          _root: rootState,
          mountCallbacks: collector.mountCallbacks,
          cleanupCallbacks: collector.cleanupCallbacks,
          mountCleanupCallbacks: [],
          mounted: false,
          contexts: collector.contexts,
          refs: collector.refs,
          refIndex: collector.refIndex,
          // AIO-249: capture parent for signal re-render ancestor chain
          parent: _instanceStack.length > 0
            ? _instanceStack[_instanceStack.length - 1]!
            : null,
        };
        vnode._instance = inst;
      } else {
        inst.deps = hs.deps!;
        inst.computeds = hs.collected!;
        inst.effectDisposes = hs.effectCollected!;
        inst.vnode = vnode;
        inst.oldRendered = rendered;
        inst.parentDom = hs.parentDom;
        inst.isSvg = hs.isSvg;
        inst.prevProps = { ...vnode.props };
        inst.prevChildren = vnode.children;
        inst.selfTriggered = false;
        // AIO-249: update parent in case component moved in tree
        inst.parent = _instanceStack.length > 0
          ? _instanceStack[_instanceStack.length - 1]!
          : null;
        // Clear pending render — this diff pass covers it (avoids double render)
        if (inst.pendingRender) {
          inst.pendingRender = false;
          inst._root.pendingComponents.delete(inst);
        }
      }

      _subscribeComponentDeps(inst, hs.deps!);
      _instanceStack.push(inst);

      if (isFirstRender && inst.mountCallbacks.length > 0) {
        const cbs = inst.mountCallbacks;
        inst.mountCallbacks = [];
        inst.mounted = true;
        // AIO-74: restore collector; AIO-76: route onCleanup to mountCleanupCallbacks
        _setCurrentCollector(inst as unknown as LifecycleCollector);
        _setInsideMount(true);
        try {
          for (const cb of cbs) cb();
        } finally {
          _setInsideMount(false);
          _setCurrentCollector(null);
        }
      } else if (isFirstRender) {
        inst.mounted = true;
      }
    },

    afterSubtree(vnode: VNode): void {
      // Stamp data-component on root DOM element in dev mode
      if (
        _devMode && typeof vnode.tag === "function" && vnode._dom &&
        (vnode._dom as { nodeType?: number }).nodeType === 1
      ) {
        const el = vnode._dom as Element;
        const name = (vnode.tag as { name?: string }).name;
        if (name && name !== "_" && name !== "Component") {
          el.setAttribute("data-component", name);
        }
      }
      _instanceStack.pop();
    },

    abortComponent(_vnode: VNode, state: unknown): void {
      const hs = state as HookState | undefined;
      if (hs && !hs.skip && hs.deps) {
        _trackEnd(hs.deps);
        _computedCollectEnd(hs.collected!);
        _effectCollectEnd(hs.effectCollected!);
        // AIO-205: dispose orphaned computeds/effects from partial render
        _computedDisposeAll(hs.collected!);
        _effectDisposeAll(hs.effectCollected!);
      }
      _setCurrentCollector(null);
    },

    unmountComponent(vnode: VNode): void {
      const inst = vnode._instance as ComponentInstance | undefined;
      if (!inst) return;
      _runCleanups(inst.cleanupCallbacks);
      inst.cleanupCallbacks = [];
      _runCleanups(inst.mountCleanupCallbacks);
      inst.mountCleanupCallbacks = [];
      inst.disposed = true;
      inst.pendingRender = false;
      inst._root.pendingComponents.delete(inst);
      for (const unsub of inst.unsubs) unsub();
      inst.unsubs = [];
      _computedDisposeAll(inst.computeds);
      _effectDisposeAll(inst.effectDisposes);
      vnode._instance = undefined;
    },
  };
}
