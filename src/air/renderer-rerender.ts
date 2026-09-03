// renderer-rerender.ts — per-component reactive re-render, signal subscription, hooks factory.
// Provides: _scheduleComponentRender, _rerenderComponent, _subscribeComponentDeps, _createHooks.

import { nullSlot } from "./vdom-create.ts";
import { isDevMode, isDevModeExplicit } from "../state/dev-flag.ts";
import {
  _computedCollectEnd,
  _computedCollectStart,
  _computedDisposeAll,
  _effectCollectEnd,
  _effectCollectStart,
  _effectDisposeAll,
  _trackEnd,
  _trackStart,
} from "../state/signal.ts";
import type { ComponentFn, VDomHooks, VNode } from "./vdom.ts";
import { _diff } from "./vdom.ts";
import {
  _isDevToolsConnected,
  _recordRender,
} from "../diagnostics/devtools.ts";
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
} from "./renderer-state.ts";
import { _flushPending } from "./renderer-flush.ts";
import { _componentName } from "./hook-error.ts";
import { count } from "../diagnostics/fmt.ts";

// ── Schedule ──────────────────────────────────────────────────────────

export function _scheduleComponentRender(inst: ComponentInstance): void {
  if (inst.disposed) return;
  const root = inst._root;
  if (inst.pendingRender) {
    // Already flagged pending. Normally it is also sitting in the queue (or is an
    // in-flight batch item during an active flush) — nothing to do. But if it is
    // pending, NOT in the queue, and no flush is running, a prior flush stranded
    // it: without this it could never be re-queued (this early-return) and would
    // silently ignore every future signal change (AIO-408/409 class). Both known
    // causes are fixed at the source; this is a fail-safe that degrades any latent
    // strand to a one-tick delay instead of a permanent invisible freeze, and
    // makes it loud in dev so the real cause gets fixed.
    if (root.flushing || root.pendingComponents.has(inst)) return;
    if (isDevMode()) {
      const name = typeof inst.vnode.tag === "function"
        ? (inst.vnode.tag.name || "Anonymous")
        : "Component";
      console.error(
        `[aio-dev] Recovered a stranded <${name}> (flagged pending but absent ` +
          `from the render queue). This is an aio scheduler bug — please report; ` +
          `re-queueing so the update is not lost.`,
      );
    }
    // fall through to re-queue (pendingRender already true)
  } else {
    inst.pendingRender = true;
  }
  inst.selfTriggered = true;
  root.pendingComponents.add(inst);
  if (!root.flushScheduled) {
    root.flushScheduled = true;
    queueMicrotask(() => _flushPending(root));
  }
}

// ── Per-component re-render ───────────────────────────────────────────

const DEV_RENDER_LIMIT = 50;

/** Dev tripwire: the state hooks (`useRef`/`useSignal`/`useId`) are matched
 *  across renders BY CALL ORDER — index 0 is index 0 forever.
 *
 *  That makes a CONDITIONAL hook silently swap ref identities: skip one
 *  `useRef` on a later render and every ref after it shifts up one slot, so a
 *  component quietly starts reading someone else's ref. Nothing said so, while
 *  `docs/ui/air-lifecycle.md` opened by claiming the opposite ("Unlike React, you
 *  can call them conditionally or in loops") — true for `onMount`/`onCleanup`,
 *  which are collected as a list, and false for exactly these three.
 *
 *  Observe-only and dev-only, so prod behaves identically. */
function _checkHookOrder(
  inst: ComponentInstance,
  count: number,
  name: string,
): void {
  if (!isDevMode()) return;
  const prev = inst._hookCount;
  inst._hookCount = count;
  if (prev === undefined || prev === count) return;
  console.error(
    `[aio-dev] <${name}> called ${count} state hooks this render but ${prev} ` +
      `last render. useRef/useSignal/useId are matched by CALL ORDER, so a ` +
      `hook behind an \`if\` (or in a loop whose length changes) shifts every ` +
      `later hook onto a different slot — the component silently starts ` +
      `reading another ref's value. Call them unconditionally at the top of ` +
      `the body; put the condition inside the value instead.`,
  );
}

export function _rerenderComponent(inst: ComponentInstance): void {
  if (inst.disposed) return;

  if (isDevMode()) {
    const now = performance.now();
    const window = inst._devRenderTimestamps ?? [];
    // Evict timestamps older than 1 second
    const cutoff = now - 1000;
    let i = 0;
    while (i < window.length && window[i]! < cutoff) i++;
    if (i > 0) window.splice(0, i);
    window.push(now);
    inst._devRenderTimestamps = window;
    if (window.length === DEV_RENDER_LIMIT) {
      const name = typeof inst.vnode.tag === "function"
        ? (inst.vnode.tag.name || "Anonymous")
        : "Component";
      console.warn(
        `[aio-dev] ${name} re-rendered ${DEV_RENDER_LIMIT} times in under a ` +
          `second — a render is WRITING state that the same render READS, so ` +
          `every render schedules the next one. Two fixes: move the write into ` +
          `an event handler or onMount (a render must only read), or wrap the ` +
          `read in untrack(() => …) if the value is genuinely a one-shot ` +
          `initialisation that must not subscribe.`,
      );
    }
  }

  const _devStart = _isDevToolsConnected() ? performance.now() : 0;
  const vnode = inst.vnode;
  const oldRendered = inst.oldRendered;
  inst._component = _componentName(vnode.tag);

  _runCleanups(inst.cleanupCallbacks, inst._component);
  inst.cleanupCallbacks = [];
  inst.mountCallbacks = []; // AIO-161: prevent accumulation on re-render

  for (const unsub of inst.unsubs) unsub();
  inst.unsubs = [];
  _computedDisposeAll(inst.computeds);
  _effectDisposeAll(inst.effectDisposes);

  // AIO-249: rebuild ancestor chain so useContext() can walk _instanceStack
  const ancestors: ComponentInstance[] = [];
  let ancestor = inst.parent;
  while (ancestor) {
    ancestors.push(ancestor);
    ancestor = ancestor.parent;
  }
  for (let i = ancestors.length - 1; i >= 0; i--) {
    _instanceStack.push(ancestors[i]!);
  }

  const collected = _computedCollectStart();
  const effectCollected = _effectCollectStart();
  const deps = _trackStart();
  inst.refIndex = 0;
  _setCurrentCollector(inst);
  let rendered: VNode | string | number | null;
  try {
    rendered = (vnode.tag as ComponentFn)({
      ...vnode.props,
      children: vnode.children.length > 0
        ? vnode.children
        : (vnode.props.children ?? vnode.children),
    });
  } catch (error) {
    // Error during signal-triggered re-render — keep old output (AIO-138)
    _setCurrentCollector(null);
    _trackEnd(deps);
    _computedCollectEnd(collected);
    _effectCollectEnd(effectCollected);
    // AIO-160: dispose orphaned computeds/effects from the failed render
    _computedDisposeAll(collected);
    _effectDisposeAll(effectCollected);
    const failedName = typeof vnode.tag === "function"
      ? (vnode.tag.name || "Anonymous")
      : "Component";
    console.error(
      `[aio-renderer] Component render error in <${failedName}>:`,
      error,
    );
    _subscribeComponentDeps(inst, deps);
    inst.deps = deps;
    return;
  } finally {
    // AIO-249: pop ancestor chain (both success and error paths)
    for (let _a = 0; _a < ancestors.length; _a++) {
      _instanceStack.pop();
    }
  }
  _setCurrentCollector(null);
  _checkHookOrder(inst, inst.refIndex ?? 0, inst._component ?? "Component");
  _trackEnd(deps);
  _computedCollectEnd(collected);
  _effectCollectEnd(effectCollected);

  // Nothing to render is still a POSITION — the same rule the create and diff
  // paths follow. This is the path a SIGNAL re-render takes, which is how a
  // component that had become visible once could lose its place the second
  // time (R-10): without the placeholder the element→null transition
  // removed the anchor entirely, so the next null→element insert had nothing
  // to insert before and appended.
  if (rendered == null) rendered = nullSlot();
  vnode._rendered = rendered;
  _instanceStack.push(inst);

  const ctx = inst._ctx;
  try {
    // The component's own `_dom` is BOTH the position of the output being
    // replaced and the answer for where it ended up: a component that renders
    // a bare string owns a text node that `getDom` cannot see, so recomputing
    // it from the output dropped the handle and the next signal re-render had
    // no position at all (it then patched whichever sibling held equal text).
    const dom = _diff(
      inst.parentDom,
      rendered ?? null,
      oldRendered ?? null,
      ctx,
      inst.isSvg,
      vnode._dom ?? null,
    );
    vnode._dom = dom ?? undefined;

    if (_devStart) {
      inst._dtRenders = (inst._dtRenders ?? 0) + 1;
      inst._dtLastMs = performance.now() - _devStart;
      const name = typeof vnode.tag === "function"
        ? (vnode.tag.name || "Anonymous")
        : "Component";
      _recordRender({
        component: name,
        timestamp: Date.now(),
        durationMs: performance.now() - _devStart,
        trigger: "signal",
        signalNames: inst._triggerSignals?.size
          ? [...inst._triggerSignals]
          : undefined,
      });
      inst._triggerSignals = undefined;
    }
  } finally {
    _instanceStack.pop();
    // AIO-180: update instance state regardless of _diff success
    inst.oldRendered = rendered;
    inst.deps = deps;
    inst.computeds = collected;
    inst.effectDisposes = effectCollected;
    inst.selfTriggered = false;
    _subscribeComponentDeps(inst, deps);
  }

  if (isDevMode() && typeof vnode.tag === "function") {
    _warnIfLostSubscription(vnode.tag as ComponentFn, inst, deps);
  }

  // AIO-167 diagnostic: warn if component has no signal deps after re-render
  if (isDevMode() && deps.size === 0 && inst.unsubs.length === 0) {
    const name = typeof vnode.tag === "function"
      ? (vnode.tag.name || "Anonymous")
      : "Component";
    console.warn(
      `[aio-dev] ${name} re-rendered with 0 signal deps — component will not respond to future signal changes.`,
    );
  }
}

// ── The memo that silently unsubscribes ──────────────────────────────
//
// One cell is one signal, so any list large enough to matter forces an app to
// memoize — and a cache that returns a HIT without touching the cell subscribes
// to nothing, permanently, for that component instance. The instance that got
// the miss works forever; the one that got the hit is dead forever. From the
// same cache, in the same frame.
//
// The existing zero-dep warning (below, AIO-167) cannot see it: it fires on the
// RE-render path, and this component never re-renders — that IS the symptom.
//
// A plain "0 deps on first render" warning would be noise: a static component
// legitimately reads nothing. What is NOT ambiguous is the same component
// function rendering with deps in one instance and none in another — a static
// component reads zero everywhere. So that comparison is the tell, and it costs
// one number per component function. Dev only, observe-only.
//
// Gated on `isDevMode()` — one flag for the whole runtime, defaulting to
// `__aioDev` (the flag the dev server and every test harness set). This site
// used to read `__aioDev` directly to escape the renderer's own `_devMode`,
// which nothing in the framework ever turned on; that flag now follows
// `__aioDev` too, so the escape hatch and the thing it escaped are one.
const _maxDepsSeen = new WeakMap<ComponentFn, number>();

function _warnIfLostSubscription(
  tag: ComponentFn,
  inst: ComponentInstance,
  deps: Set<unknown>,
): void {
  const seen = _maxDepsSeen.get(tag) ?? 0;
  if (deps.size > seen) {
    _maxDepsSeen.set(tag, deps.size);
    return;
  }
  // Subscribed through something other than a tracked read (a manual
  // `subscribe`) — not this bug.
  if (deps.size > 0 || seen === 0 || inst.unsubs.length > 0) return;
  if (_warnedLostSub.has(tag)) return;
  _warnedLostSub.add(tag);
  console.warn(
    `[aio-dev] <${
      tag.name || "Anonymous"
    }> rendered reading NO signals, while another instance of it read ` +
      `${count(seen, "signal")} — this instance will never re-render.\n` +
      `  A read is tracked only while the component body runs, so a cache ` +
      `that returns a HIT without touching the cell subscribes to nothing. ` +
      `Use \`trackedMemo\` from "aio/air", which replays the recorded read ` +
      `set on a hit, or read one key of every input cell on every call. ` +
      `See docs/ui/reactivity-tracking.md.`,
  );
}
const _warnedLostSub = new WeakSet<ComponentFn>();

// ── Subscribe component instance to its deps ─────────────────────────

const _warnedMissingDeps = new WeakMap<ComponentInstance, Set<string>>();

export function _subscribeComponentDeps(
  inst: ComponentInstance,
  // deno-lint-ignore no-explicit-any
  deps: Set<any>,
): void {
  if (isDevMode() && inst.parent) {
    const parentDeps = inst.parent.deps;
    for (const dep of deps) {
      if (parentDeps.has(dep)) continue;
      if (!dep._name) continue;
      let warned = _warnedMissingDeps.get(inst);
      if (!warned) {
        warned = new Set();
        _warnedMissingDeps.set(inst, warned);
      }
      if (warned.has(dep._name)) continue;
      warned.add(dep._name);
      const parentName = typeof inst.parent.vnode.tag === "function"
        ? (inst.parent.vnode.tag.name || "Anonymous")
        : "Component";
      const childName = typeof inst.vnode.tag === "function"
        ? (inst.vnode.tag.name || "Anonymous")
        : "Component";
      // AIO-7.5: child subscriptions are independent of the parent (tested in
      // child-signal-subscription.test.ts) — this is a debug breadcrumb, not advice.
      console.debug(
        `[aio-dev] Child "${childName}" reads signal "${dep._name}" not read by parent "${parentName}" — fine since AIO-7.5.`,
      );
    }
  }

  for (const dep of deps) {
    const subscriber = {
      execute: () => {
        if (!inst._triggerSignals) inst._triggerSignals = new Set();
        inst._triggerSignals.add(dep._name ?? "anonymous");
        _scheduleComponentRender(inst);
      },
    };
    dep._subscribers.add(subscriber);
    inst.unsubs.push(() => dep._subscribers.delete(subscriber));
  }
}

// ── Hooks factory ─────────────────────────────────────────────────────

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
          // Re-point the instance at the vnode that now lives in the TREE.
          // A parent re-render hands the diff a FRESH vnode for this
          // component; on skip, the tree keeps that fresh vnode while the
          // instance kept the old one — so a later SELF re-render (own
          // signal dep) wrote its new `_rendered` onto the detached old
          // vnode, and every tree walk (ui.surface(), testUI resolution)
          // kept seeing the skip-time snapshot: a structurally swapped
          // branch (login form → header) never appeared, while stale
          // elements stayed listed.
          inst.vnode = vnode;
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
        _runCleanups(inst.cleanupCallbacks, _componentName(vnode.tag));
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
      // Name the component for the whole body execution: afterRender/onMount/
      // onCleanup all register through the collector, so a callback that throws
      // later can be reported against the component that scheduled it.
      collector._component = _componentName(vnode.tag);
      _setCurrentCollector(collector);

      return {
        skip: false,
        deps,
        collected,
        effectCollected,
        parentDom,
        isSvg,
        // Only while someone is looking — `performance.now()` on every
        // component of every render is not free.
        dtStart: _isDevToolsConnected() ? performance.now() : undefined,
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
          // Carry the name over from the render collector, so a hook that
          // registers from INSIDE onMount (where the instance is the collector)
          // is named on the very first render too.
          _component: collector._component,
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

      _checkHookOrder(
        inst,
        collector.refIndex ?? 0,
        _componentName(vnode.tag),
      );
      // The mount/diff render path. `_recordRender` only ever saw the SIGNAL
      // path, so a component that renders because its parent did was invisible
      // to DevTools; the per-instance counters `devtools.tree` reports are
      // maintained on both.
      if (hs.dtStart !== undefined) {
        inst._dtRenders = (inst._dtRenders ?? 0) + 1;
        inst._dtLastMs = performance.now() - hs.dtStart;
      }
      _subscribeComponentDeps(inst, hs.deps!);
      if (isDevMode() && typeof vnode.tag === "function") {
        _warnIfLostSubscription(vnode.tag as ComponentFn, inst, hs.deps!);
      }
      _instanceStack.push(inst);

      // AIO-390: onMount must run AFTER the component's DOM subtree (and refs)
      // are committed. The subtree is built between afterComponent and
      // afterSubtree (createDom / diff of `rendered`), so firing is deferred to
      // afterSubtree — which reads `inst.mounted` as the once-per-instance gate
      // (AIO-400). We intentionally do NOT set `mounted` here: leaving it false
      // until afterSubtree lets that hook distinguish a true first mount from a
      // re-render that re-collected onMount, so onMount fires exactly once.
      void isFirstRender;
    },

    afterSubtree(vnode: VNode): void {
      // Stamp data-component on the component's root element — an explicit
      // opt-in, NOT ambient dev. It is the one dev feature here that changes
      // the DOM rather than observing it, and SSR does not write it, so
      // arming it with `__aioDev` made every hydrated component look like a
      // server/client divergence.
      if (
        isDevModeExplicit() && typeof vnode.tag === "function" && vnode._dom &&
        (vnode._dom as { nodeType?: number }).nodeType === 1
      ) {
        const el = vnode._dom as Element;
        const name = (vnode.tag as { name?: string }).name;
        if (name && name !== "_" && name !== "Component") {
          el.setAttribute("data-component", name);
        }
      }

      // AIO-390: QUEUE onMount now that the subtree's DOM + refs are built, so
      // `ref.current` is the real node inside onMount. Children queue before
      // their parent (bottom-up, matching React).
      //
      // Queued, not fired: `createDom` builds into a DocumentFragment and the
      // `appendChild` that puts it in the document happens AFTER this hook, so
      // firing here ran every onMount on a DETACHED tree — `isConnected` false,
      // `focus()` a no-op, `getBoundingClientRect()` all zeros, while
      // docs/ui/air-lifecycle.md promises focus and measurement work here. The
      // drain is `_flushAfterRender` (renderer-flush.ts), which every commit
      // path already calls and which `afterRender` was already correct on:
      // one decider for "the DOM is committed", two hooks.
      //
      // AIO-400: fire ONCE per instance. A re-render that re-executes the
      // component body (any non-memoized render — e.g. children changed) calls
      // onMount again and re-collects the callback; without the `!mounted` gate
      // this hook re-fired it every re-render, remounting every wrapper/layout
      // component that takes children (state loss, listener leaks, focus theft).
      // On a re-render we discard the freshly-collected callbacks instead.
      const inst = vnode._instance as ComponentInstance | undefined;
      if (inst && inst.mountCallbacks.length > 0) {
        if (inst.mounted) {
          inst.mountCallbacks = []; // re-render — onMount is once-per-instance
        } else {
          inst.mounted = true;
          const cbs = inst.mountCallbacks;
          inst.mountCallbacks = [];
          const root = inst._root;
          (root.pendingMounts ??= []).push({
            inst,
            cbs,
            component: _componentName(vnode.tag),
          });
        }
      }
      // NOTE: an instance that collected NO callbacks is deliberately left
      // `mounted: false`. `mounted` means "this instance's onMount has run",
      // and marking it on a render that collected nothing burned the one
      // chance a component gets: any component that returns early before its
      // `onMount(...)` line — `Modal`/`Confirm` while closed, the normal case —
      // registered nothing on render 1, and when it finally opened and DID
      // collect a callback, the gate above discarded it as a re-render. The
      // modal's Escape-to-close listener was never attached.

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
      const name = _componentName(vnode.tag);
      _runCleanups(inst.cleanupCallbacks, name);
      inst.cleanupCallbacks = [];
      _runCleanups(inst.mountCleanupCallbacks, name);
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
