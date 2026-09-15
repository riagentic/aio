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
import type { ComponentFn, RenderCtx, VDomHooks, VNode } from "./vdom.ts";
import { _diff, ErrorBoundary, Portal, Suspense } from "./vdom.ts";
import { _cleanupChildren, _removeDomCleanup } from "./vdom-remove.ts";
import { _profilingOn } from "./component-profile.ts";
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
  _boundaryStack,
  _currentBoundary,
  _currentCollector,
  _discardEpochNow,
  _instanceStack,
  _isolationBases,
  _noteDiscard,
  _setCurrentCollector,
  _suspenseRetries,
} from "./renderer-state.ts";
import { _flushPending } from "./renderer-flush.ts";
import { _inEventHandler } from "./vdom-events.ts";
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
  // What asked for this render, for the dev burst tripwire below. A write made
  // by an event handler is INPUT and is allowed to be fast: typing 95 chars
  // (testUI / `am trigger … type`) is 95 handler→render steps in under a
  // second, and none of them is a render writing what it read (risoto §3).
  // The old `root.flushing || _currentCollector` clause punched through that
  // exemption — schedules queued while the event's flush ran were still
  // counted, so a fast typist got "move the write into an event handler" for
  // a write that was already there. Non-handler writes (render body,
  // afterRender, promise, socket) still count.
  if (isDevMode() && !_inEventHandler()) {
    inst._devLoopCandidate = true;
  }
  root.pendingComponents.add(inst);
  if (!root.flushScheduled) {
    root.flushScheduled = true;
    queueMicrotask(() => _flushPending(root));
  }
}

/** Instances whose next render was asked for by a signal they did not read —
 *  one LENT to them by a child whose first render threw (`abortComponent`,
 *  `isolateComponentError`), so the child is retried when it changes. */
const _lentRenders = new WeakSet<ComponentInstance>();

function _scheduleLentRender(inst: ComponentInstance): void {
  _lentRenders.add(inst);
  _scheduleComponentRender(inst);
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
  // Taken now, whatever this render does: the mark belongs to THIS render.
  const lent = _lentRenders.delete(inst);

  const loopCandidate = inst._devLoopCandidate === true;
  inst._devLoopCandidate = false;
  if (isDevMode() && loopCandidate) {
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

  // Timed when anything is WATCHING — a connected Redux DevTools, or a
  // profile someone asked for. Two `performance.now()` calls per render are
  // not free at 60fps, so an app that does neither pays nothing.
  const _devStart = _isDevToolsConnected() || _profilingOn()
    ? performance.now()
    : 0;
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
  // The chain stays on the stack through the DIFF, not just the body: a child
  // the diff MOUNTS (`{open && <Themed/>}`) calls useContext from inside
  // `_diff`, and with the chain popped before it the child saw only this
  // instance — every Provider above it vanished and it read the context
  // DEFAULT. The router is the loud case: a nested <Route> mounted by this
  // re-render read basePath "" and never matched again.
  let chainPushed = true;
  const popChain = (): void => {
    if (!chainPushed) return;
    chainPushed = false;
    for (let _a = 0; _a < ancestors.length; _a++) _instanceStack.pop();
  };

  const collected = _computedCollectStart();
  const effectCollected = _effectCollectStart();
  const deps = _trackStart();
  inst.refIndex = 0;
  _setCurrentCollector(inst);
  let rendered: VNode | string | number | null;
  try {
    const pending = inst._fallbackError as Error | undefined;
    if (pending !== undefined) {
      // This pass renders the enclosing boundary's fallback. The error is NOT
      // cleared here but on SUCCESS: it is what tells the catch below that the
      // fallback is the thing that just threw, so a throwing fallback lands on
      // the stale-output path instead of re-entering forever.
      rendered = _boundaryFallback(inst._boundary)!(pending) as
        | VNode
        | string
        | number
        | null;
    } else {
      rendered = (vnode.tag as ComponentFn)({
        ...vnode.props,
        children: vnode.children.length > 0
          ? vnode.children
          : (vnode.props.children ?? vnode.children),
      });
    }
  } catch (error) {
    // Popped FIRST: the fallback re-entry below rebuilds its own chain.
    popChain();
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
    // …and TELL THE HARNESS. A throw on the FIRST render propagates out of
    // mount and fails the test; every render error after that was
    // `console.error`'d and dropped, so `testUI` showed stale content and an
    // assertion on the OLD value passed "correctly". Prod keeps its graceful
    // degradation (keep the last good output) — this is dev-stricter-only,
    // category (b).
    _renderErrorSink?.(
      error instanceof Error ? error : new Error(String(error)),
      failedName,
    );
    // `<ErrorBoundary>` on the RE-RENDER path. Mount already unwinds to the
    // boundary; a later throw did not, so the subtree kept its last good
    // output and silently stopped updating — a panel that quietly stops being
    // true, which is the failure report 1 §22.1 describes from the other side.
    //
    // The failing component renders the boundary's FALLBACK this time, which
    // reuses the whole existing diff path below rather than adding a second
    // way to replace a subtree's DOM. The boundary's other children are
    // untouched: containing the failure where it happened loses less than
    // replacing everything beside it.
    const fb = _boundaryFallback(inst._boundary);
    if (fb && inst._fallbackError === undefined) {
      // Re-enter, rendering the fallback instead of the component. Re-entry
      // rather than a second DOM-patching path: everything below — the diff,
      // the position bookkeeping, the subscription rebuild — is what makes a
      // render land correctly, and a boundary that reimplemented it would be a
      // second renderer that drifts.
      //
      // THE DEPS OF THE FAILED RENDER COME ALONG. A fallback typically reads
      // no signals at all, so subscribing to only its deps would subscribe to
      // NOTHING and the component could never be asked to render again — the
      // fallback would be permanent, which is a worse stale than the one this
      // replaces. The signal that made it throw is the signal that will fix
      // it, and it is in `deps` because the render read it before throwing.
      inst._fallbackDeps = deps;
      inst._fallbackError = error instanceof Error
        ? error
        : new Error(String(error));
      _rerenderComponent(inst);
      return;
    }
    // Either there is no boundary (AIO-138: keep the last good output) or the
    // FALLBACK is what just threw. Clearing means the next re-render attempts
    // the component again rather than re-running a fallback already known to
    // fail — a boundary cannot make things worse than the failure it caught.
    inst._fallbackError = undefined;
    _mergeFallbackDeps(inst, deps);
    _subscribeComponentDeps(inst, deps);
    inst.deps = deps;
    return;
  }
  _setCurrentCollector(null);
  _checkHookOrder(inst, inst.refIndex ?? 0, inst._component ?? "Component");
  _trackEnd(deps);
  // A render that SUCCEEDED clears the pending boundary error, so the very
  // next re-render tries the component again — that is what makes a boundary
  // recoverable rather than a one-way door.
  inst._fallbackError = undefined;
  _mergeFallbackDeps(inst, deps);
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
  inst._sweepEpoch = _discardEpochNow();
  _isolationBases.push(_boundaryStack.length);
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
    // Before the pops: the owner a discarded subtree's signals are lent to is
    // found on the instance stack.
    if (inst._sweepEpoch !== _discardEpochNow()) {
      _sweepAfterRender(rendered, ctx);
    }
    _isolationBases.pop();
    _instanceStack.pop();
    popChain(); // AIO-249: the ancestors under it, on success and throw alike
    // AIO-180: update instance state regardless of _diff success
    inst.oldRendered = rendered;
    inst.deps = deps;
    inst.computeds = collected;
    inst.effectDisposes = effectCollected;
    inst.selfTriggered = false;
    _subscribeComponentDeps(inst, deps);
    // …AND the onMount callbacks this render collected.
    //
    // There are TWO re-render paths and only the diff one drained them. This
    // path clears `inst.mountCallbacks` on the way in (AIO-161, so they cannot
    // accumulate) and then threw away anything the body registered on the way
    // out — so an `onMount` reached on a SELF-triggered re-render never ran.
    // That is the ordinary shape of a component that gates its own
    // subscription behind its own state: the kit's `ConfirmButton` holds
    // `open` in a `useSignal`, so clicking it re-renders itself, `Modal`'s
    // Escape-to-close listener was collected here and dropped, and the
    // documented "focus / Escape / ARIA come for free" was false for that one
    // component while `Modal` and `Confirm` were fine.
    //
    // Same gate as `afterSubtree`, and for the same reasons written there:
    // `mounted` means "this instance's onMount has run", so an instance that
    // collected NOTHING stays unmounted and keeps its one chance.
    if (inst.mountCallbacks.length > 0) {
      if (inst.mounted) {
        inst.mountCallbacks = []; // once per instance, never per render
      } else {
        inst.mounted = true;
        const cbs = inst.mountCallbacks;
        inst.mountCallbacks = [];
        (inst._root.pendingMounts ??= []).push({
          inst,
          cbs,
          component: inst._component ?? "Component",
        });
      }
    }
  }

  if (isDevMode() && typeof vnode.tag === "function") {
    _warnIfLostSubscription(vnode.tag as ComponentFn, inst, deps);
  }

  // AIO-167 diagnostic: warn if component has no signal deps after re-render
  //
  // Not when the render was asked for by a LENT signal. A boundary's owner that
  // reads nothing re-renders to retry the child that threw, and ends with zero
  // deps by design — "will not respond to future signal changes" was printed on
  // the very render that had just brought the page back. Its own signals were
  // never the reason it rendered, so their absence says nothing.
  if (isDevMode() && !lent && deps.size === 0 && inst.unsubs.length === 0) {
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

/** Where a re-render throw is reported, on top of the console line.
 *
 *  `testUI` installs this: a render error after the first render used to be
 *  logged and dropped, so the harness could not see it and a test asserting
 *  the STALE value passed. @internal */
let _renderErrorSink: ((e: Error, component: string) => void) | null = null;

/** Install (or clear, with `null`) the render-error sink. @internal */
/** Fold the deps of a render that threw into this render's deps, once.
 *  See the re-entry comment in the catch below. @internal */
// deno-lint-ignore no-explicit-any
function _mergeFallbackDeps(inst: ComponentInstance, deps: Set<any>): void {
  const prior = inst._fallbackDeps;
  if (!prior) return;
  inst._fallbackDeps = undefined;
  for (const d of prior) deps.add(d);
}

/** The fallback renderer of a boundary vnode, or null when it has none (or
 *  the instance mounted outside any boundary). @internal */
/** The on-screen instance that renders the `<ErrorBoundary>` which will catch
 *  the throw in progress — or null outside one.
 *
 *  The catching boundary is the innermost one WITH a fallback (one without
 *  rethrows to the next). Its owner is found by output, not by position: every
 *  instance above the first one whose rendered tree holds that boundary vnode
 *  was built inside the boundary, and goes when the fallback replaces the
 *  children. Of the unbroken run of holders below, the OUTERMOST is the one
 *  that called `h(ErrorBoundary…)`: a boundary handed through a layout's
 *  `children` is held by the layout too, but re-rendering the layout hands the
 *  very same vnode back, which the diff skips — only its creator makes a new
 *  one. Only reached when a component throws, so the walk costs nothing on a
 *  render that succeeds. */
function _boundaryOwner(): ComponentInstance | null {
  for (let i = _boundaryStack.length - 1; i >= 0; i--) {
    if (_boundaryFallback(_boundaryStack[i])) {
      return _regionOwner(_boundaryStack[i]);
    }
  }
  return null;
}

/** The on-screen instance that OWNS the region vnode `target` — see
 *  `_boundaryOwner` for why it is the outermost of the unbroken run of
 *  instances whose output holds it. A region nested inside another region's
 *  FALLBACK is held too: the fallback is that region's output. */
function _regionOwner(target: unknown): ComponentInstance | null {
  const holds = (node: unknown): boolean => {
    if (node === target) return true;
    if (!node || typeof node !== "object") return false;
    const v = node as VNode;
    if (
      (v.tag === ErrorBoundary || v.tag === Suspense) && v._rendered != null &&
      holds(v._rendered)
    ) return true;
    return Array.isArray(v.children) && v.children.some(holds);
  };
  let owner: ComponentInstance | null = null;
  for (let i = _instanceStack.length - 1; i >= 0; i--) {
    const inst = _instanceStack[i]!;
    if (holds(inst.vnode?._rendered)) owner = inst;
    else if (owner) break;
  }
  return owner;
}

// ── Work a boundary threw away ───────────────────────────────────────
//
// An `<ErrorBoundary>` that catches (or a `<Suspense>` that falls back) swaps
// its fallback in for its children — but the failed attempt had already BUILT
// part of them: the wrapper components above the thrower, every sibling that
// rendered before it, their signal children and refs. The vnodes stay on
// `region.children`, and every teardown walk follows the fallback instead
// (`_cleanupChildren`), so nothing ever unmounted them. Each one stayed
// subscribed: measured, `<ErrorBoundary><Wrapper reads w><Thrower/></Wrapper>`
// retried 200 times left `w` with 201 subscribers, every `w.set` re-rendered
// all 201 dead wrappers into detached DOM (10051 renders for 50 sets), and an
// unmount released none of them. A `useResource` in such a wrapper stayed open
// for good, and a ref pointed at a detached element.
//
// Swept by the component whose output HOLDS the region, once its subtree is
// built — the one point every creation path (mount, diff, hydrate, a signal
// re-render) passes through after the boundary has decided. Only a render in
// which something threw walks at all (`_noteDiscard`).

/** A vnode the teardown walks can follow — not the malformed child (`{}`, an
 *  array, a promise) a failed render may have THROWN on, which stays in the
 *  discarded tree exactly where the build stopped. Every walk below checks it:
 *  a sweep that threw on it would unwind the render's `finally` half-way and
 *  leave the global instance and isolation stacks corrupt. */
function _isNode(n: unknown): n is VNode {
  return !!n && typeof n === "object" && (n as VNode).tag !== undefined &&
    Array.isArray((n as VNode).children);
}

/** `_sweepDiscarded` from inside a render's `finally`, where a throw would
 *  replace the error in flight and skip the pops that follow. A sweep that
 *  fails is an aio bug, reported as one; the render it cleans up after stands. */
function _sweepAfterRender(output: unknown, ctx: RenderCtx): void {
  try {
    _sweepDiscarded(output, ctx);
  } catch (e) {
    console.error(
      "[aio-renderer] retiring the work a boundary discarded threw — its " +
        "subscriptions may outlive it. This is an aio bug; please report:",
      e,
    );
  }
}

/** Retire the discarded children of every region in `output` that is showing
 *  its fallback. Stops at component vnodes: each sweeps its own output. */
function _sweepDiscarded(output: unknown, ctx: RenderCtx): void {
  if (!_isNode(output) || typeof output.tag === "function") return;
  if (
    (output.tag === ErrorBoundary || output.tag === Suspense) &&
    output._rendered != null
  ) {
    _retireDiscarded(output, ctx);
  }
  for (const child of _cleanupChildren(output)) _sweepDiscarded(child, ctx);
}

/** Unmount what a region's failed attempt built, and lend the signals those
 *  instances read to the region's owner.
 *
 *  The lending is the same rule `abortComponent` applies to the thrower: a
 *  signal a discarded WRAPPER read can be the one that decides whether its
 *  child throws (`<Wrapper>` passing `mode` down), and with the wrapper gone
 *  nothing else would ever ask for the retry — the fallback stayed after
 *  `mode` changed. */
function _retireDiscarded(region: VNode, ctx: RenderCtx): void {
  const children = region.children;
  if (children.length === 0) return;
  // A fallback may render the very vnodes it replaces
  // (`fallback={() => <>{kids}</>}`); those are live again, not discarded.
  const live = new Set<unknown>();
  const collect = (n: unknown): void => {
    if (!_isNode(n) || live.has(n)) return;
    live.add(n);
    for (const c of _cleanupChildren(n)) collect(c);
  };
  collect(region._rendered);
  // deno-lint-ignore no-explicit-any
  const deps = new Set<any>();
  /** Gathers what the subtree's instances read; false when it holds a
   *  malformed node. */
  const readBy = (n: unknown): boolean => {
    if (!n || typeof n !== "object") return true;
    if (!_isNode(n)) return false;
    const inst = n._instance as ComponentInstance | undefined;
    if (inst && !inst.disposed) { for (const d of inst.deps) deps.add(d); }
    let formed = true;
    for (const c of _cleanupChildren(n)) formed = readBy(c) && formed;
    return formed;
  };
  for (const child of children) {
    if (!_isNode(child) || live.has(child)) continue;
    // A region nested in the discarded work that ALSO fell back holds its own
    // discarded children, which the teardown below cannot see — it follows
    // that region's fallback. `<Suspense>` over `[<ErrorBoundary>…, <Lazy/>]`
    // kept one wrapper per retry.
    _sweepDiscarded(child, ctx);
    if (readBy(child)) _removeDomCleanup(child, ctx);
    else _removeAroundMalformed(child, ctx);
  }
  if (deps.size === 0) return;
  const owner = _regionOwner(region);
  if (!owner || owner.disposed) return;
  for (const dep of deps) {
    const subscriber = { execute: () => _scheduleLentRender(owner) };
    dep._subscribers.add(subscriber);
    owner.unsubs.push(() => dep._subscribers.delete(subscriber));
  }
}

/** `_removeDomCleanup` for a discarded subtree that holds the malformed node
 *  its render threw on, which that walk cannot step over: each node on the way
 *  down is torn down ALONE (a shell with nothing under it) and its well-formed
 *  children whole. The Portal branch needs its children to find its DOM, so a
 *  portal on that path only has its content retired, not moved out. */
function _removeAroundMalformed(n: unknown, ctx: RenderCtx): void {
  if (!_isNode(n)) return;
  const kids = _cleanupChildren(n);
  if (kids.every((k) => typeof k !== "object" || k === null || _formed(k))) {
    _removeDomCleanup(n, ctx);
    return;
  }
  if (n.tag !== Portal) {
    _removeDomCleanup({ ...n, children: [], _rendered: undefined }, ctx);
    if (typeof n.tag === "function") n._instance = undefined;
  }
  for (const k of kids) _removeAroundMalformed(k, ctx);
}

function _formed(n: unknown): boolean {
  if (!n || typeof n !== "object") return true;
  return _isNode(n) && _cleanupChildren(n).every(_formed);
}

/** The `<ErrorBoundary>` a component rendering RIGHT NOW lives inside.
 *
 *  `_boundaryStack` only holds the boundaries entered during the current
 *  render. On mount that is every one above the component; during a RE-RENDER
 *  pass it is only those entered inside the pass — the boundary around the
 *  component that re-rendered was pushed at ITS mount and is long gone. A
 *  component the pass mounts (`{open && <Panel/>}`) therefore recorded no
 *  boundary at all, and a later throw from it had nowhere to show a fallback.
 *  With nothing entered inside the pass, the answer is the nearest enclosing
 *  instance's boundary, which that instance recorded when the stack held it. */
function _enclosingBoundary(): unknown {
  const base = _isolationBases[_isolationBases.length - 1];
  if (base === undefined || _boundaryStack.length > Math.max(base, 0)) {
    return _currentBoundary();
  }
  const parent = _instanceStack[_instanceStack.length - 1];
  return parent ? parent._boundary ?? null : _currentBoundary();
}

function _boundaryFallback(
  boundary: unknown,
): ((e: Error) => VNode | string | number | null) | null {
  const props = (boundary as { props?: Record<string, unknown> } | null)?.props;
  const fb = props?.fallback;
  if (typeof fb === "function") {
    return fb as (e: Error) => VNode | string | number | null;
  }
  // A non-function fallback is a plain node — wrap it so both spellings reach
  // the same path, exactly as the mount branch treats them.
  if (fb !== undefined) return () => fb as VNode;
  return null;
}

export function _setRenderErrorSink(
  fn: ((e: Error, component: string) => void) | null,
): void {
  _renderErrorSink = fn;
}

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
      // The live tracking frame, so a lifecycle callback registered from this
      // body can be compared against what the body actually subscribed to.
      // Captured by REFERENCE and read at flush time, by which point the body
      // has finished filling it. Dev-only consumer (air/untracked-read.ts).
      collector._renderDeps = deps;
      _setCurrentCollector(collector);

      return {
        skip: false,
        deps,
        collected,
        effectCollected,
        parentDom,
        isSvg,
        collector,
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
          // Which boundary this component lives inside — captured at MOUNT,
          // because a re-render happens long after the stack has unwound.
          _boundary: _enclosingBoundary(),
          selfTriggered: false,
          _ctx: rootState.ctx,
          _root: rootState,
          mountCallbacks: collector.mountCallbacks,
          cleanupCallbacks: collector.cleanupCallbacks,
          // Carry the name over from the render collector, so a hook that
          // registers from INSIDE onMount (where the instance is the collector)
          // is named on the very first render too.
          _component: collector._component,
          mountCleanupCallbacks: collector.mountCleanupCallbacks ?? [],
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
      inst._sweepEpoch = _discardEpochNow();
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
      // First, while this instance is still on the stack: a boundary in its
      // output that threw work away gets it retired (see `_sweepDiscarded`).
      const owner = vnode._instance as ComponentInstance | undefined;
      if (owner && owner._sweepEpoch !== _discardEpochNow()) {
        _sweepAfterRender(vnode._rendered, owner._ctx);
      }

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

    abortComponent(vnode: VNode, state: unknown): void {
      // Whatever catches this throw may discard work already built around it.
      _noteDiscard();
      const hs = state as HookState | undefined;
      if (hs && !hs.skip && hs.deps) {
        _trackEnd(hs.deps);
        _computedCollectEnd(hs.collected!);
        _effectCollectEnd(hs.effectCollected!);
        // AIO-205: dispose orphaned computeds/effects from partial render
        _computedDisposeAll(hs.collected!);
        _effectDisposeAll(hs.effectCollected!);
        // …and what the body took for its whole lifetime (`_onUnmount` — a
        // `useResource` open). A FIRST render that throws never gets an
        // instance to unmount, so those holds are released here or never. A
        // re-render's collector is the live instance, whose holds stay.
        const fresh = hs.collector;
        if (fresh && !vnode._instance && fresh.mountCleanupCallbacks?.length) {
          const holds = fresh.mountCleanupCallbacks;
          fresh.mountCleanupCallbacks = [];
          _runCleanups(holds, _componentName(vnode.tag));
        }
        // KEEP THE FAILED RENDER'S DEPS ALIVE, inside a boundary.
        //
        // A component that throws at MOUNT never reaches `afterComponent`, so
        // it has no instance and nothing subscribes to the signals it read
        // before throwing. The enclosing ErrorBoundary shows its fallback, and
        // then nothing can ever ask the component to render again — the
        // fallback is PERMANENT. Measured: `<ErrorBoundary><Chart/>` where
        // Chart throws while `ready` is false stayed on the error screen when
        // `ready` turned true, and only recovered when some unrelated parent
        // happened to re-render.
        //
        // The re-render path already refuses to let this happen and says why:
        // "THE DEPS OF THE FAILED RENDER COME ALONG… subscribing to only its
        // deps would subscribe to NOTHING and the component could never be
        // asked to render again — the fallback would be permanent, which is a
        // worse stale than the one this replaces." The mount path is the same
        // sentence, and its comment claimed the throw "unwinds to the catch
        // below" as if that were equivalent.
        //
        // The subscription hangs off the PARENT instance, because that is the
        // one with a DOM position to re-render from — and a parent re-render
        // re-invokes the child, which is exactly what was observed to fix it.
        // It costs the parent a few extra subscriptions for the life of its
        // own mount, only for a component that threw, which is a small price
        // for a panel that can come back.
        //
        // Inside a `<Suspense>` retry (and no boundary entered since it began)
        // the region fails as a WHOLE: every instance the retry created is
        // thrown away with it, so the owner is the instance that was committed
        // before the retry — see `_suspenseRetries`.
        //
        // Inside an `<ErrorBoundary>` the same is true of every instance built
        // BELOW the boundary: when it catches, its children are discarded and
        // the fallback takes their place. The top of the stack is only the
        // owner when the thrower is the boundary's direct child; one wrapper
        // deeper it was the wrapper, subscribed and then thrown away, and the
        // fallback stayed after the signal changed. The owner is the instance
        // whose output holds the catching boundary — see `_boundaryOwner`.
        const retry = _suspenseRetries[_suspenseRetries.length - 1];
        const inRetry = retry !== undefined &&
          retry.boundaries === _boundaryStack.length;
        const parent = inRetry
          ? _instanceStack[retry.instances - 1]
          : _boundaryOwner() ?? _instanceStack[_instanceStack.length - 1];
        if (
          parent && !parent.disposed && (inRetry || _currentBoundary()) &&
          hs.deps.size
        ) {
          for (const dep of hs.deps) {
            const subscriber = {
              execute: () => _scheduleLentRender(parent),
            };
            dep._subscribers.add(subscriber);
            parent.unsubs.push(() => dep._subscribers.delete(subscriber));
          }
        }
      }
      _setCurrentCollector(null);
    },

    // A component body that throws while a PARENT's re-render diffs it — the
    // same failure `_rerenderComponent` already contains when the component
    // re-renders itself (AIO-138), reached from the other direction. It was
    // not contained: the throw unwound the parent's diff half-applied, AIO-180
    // then recorded the new tree as committed, and the next render mounted a
    // second copy of the child beside the stale one — `<p>Hi bob</p><p>Hi
    // ann</p>` forever, while a fresh mount showed one paragraph.
    //
    // Contained only when nothing inside this pass will catch it: an
    // `<ErrorBoundary>` entered during the pass is on `_boundaryStack` above
    // the pass's base and gets the throw exactly as before. Outside any pass
    // (mount) there is no base, and a first-render throw still propagates.
    isolateComponentError(
      vnode: VNode,
      oldVnode: VNode | null,
      error: unknown,
      state: unknown,
    ): boolean {
      const base = _isolationBases[_isolationBases.length - 1];
      // `-1`: a region that must fail as a whole (see `_diffSuspense`).
      if (base === undefined || base < 0) return false;
      for (let i = base; i < _boundaryStack.length; i++) {
        if (_boundaryFallback(_boundaryStack[i])) return false;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      const name = vnode.tag === Suspense
        ? "Suspense"
        : _componentName(vnode.tag);
      // Same two channels as the self-re-render path: the console, and the
      // harness sink so `testUI` fails instead of asserting on stale content.
      console.error(`[aio-renderer] Component render error in <${name}>:`, err);
      _renderErrorSink?.(err, name);
      const hs = state as HookState | undefined;
      // deno-lint-ignore no-explicit-any
      const deps: Set<any> | null = hs && !hs.skip ? hs.deps : null;
      const inst = vnode._instance as ComponentInstance | undefined;
      if (inst && oldVnode) {
        // The instance keeps its committed output (the reconciler reuses
        // `oldVnode`'s) and now lives on the vnode in the tree. It stays
        // subscribed to what the failed render read — that signal is the one
        // that will fix it — and this pass covers any render it had queued, so
        // the flush does not throw the same error a second time.
        inst.vnode = vnode;
        inst.selfTriggered = false;
        // The props this ATTEMPT was given become the memo key. Left at the
        // last GOOD props, a parent handing those back (`mode` good → bad →
        // good) matched the memo and skipped the child — the failed render had
        // read no signal, so nothing else could ever re-run it, and the stale
        // output (or a boundary's fallback) stayed for the life of the mount.
        // Same props as the failed attempt still skip: nothing that render
        // depended on has changed, and re-throwing on every parent render would
        // only repeat the error.
        inst.prevProps = { ...vnode.props };
        inst.prevChildren = vnode.children;
        if (inst.pendingRender) {
          inst.pendingRender = false;
          inst._root.pendingComponents.delete(inst);
        }
        if (deps) {
          inst.deps = deps;
          _subscribeComponentDeps(inst, deps);
        }
        // A boundary OUTSIDE this pass (above the component that re-rendered)
        // still owns the failure: render its fallback in the component's place
        // on the next flush turn, through the one path that already does that.
        if (
          _boundaryFallback(inst._boundary) && inst._fallbackError === undefined
        ) {
          inst._fallbackError = err;
          inst._fallbackDeps = deps ?? undefined;
          _scheduleComponentRender(inst);
        }
        return true;
      }
      // A NEW component: no instance, no output. Its failed deps hang off the
      // nearest instance, whose re-render retries it (see `abortComponent`).
      const parent = _instanceStack[_instanceStack.length - 1];
      if (parent && !parent.disposed && deps?.size) {
        for (const dep of deps) {
          const subscriber = {
            execute: () => _scheduleLentRender(parent),
          };
          dep._subscribers.add(subscriber);
          parent.unsubs.push(() => dep._subscribers.delete(subscriber));
        }
      }
      return true;
    },

    containedFallback(
      error: unknown,
    ): { fallback: VNode | string | number | null } | null {
      const fb = _boundaryFallback(_enclosingBoundary());
      if (!fb) return null;
      return {
        fallback: fb(error instanceof Error ? error : new Error(String(error))),
      };
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
