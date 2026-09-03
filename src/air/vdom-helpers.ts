// AIO VDOM helpers — signal text nodes and the action system.
// Leaf module with no deps on vdom-render/diff/remove.

import { effect } from "../state/signal.ts";
import type { Signal } from "../state/signal.ts";
import { _devWarn } from "./vdom-types.ts";
import { isDevMode } from "../state/dev-flag.ts";
import type { VNode } from "./vdom-types.ts";

// ── Signal text nodes ─────────────────────────────────────────────────
// A signal passed as a child is a `_SignalText` vnode (vdom-types.ts): one text
// node, one effect, owned by the vnode itself. The effect writes the node
// directly — no re-render, no diff — and is disposed with the vnode.

/** The text a signal child shows for `val` — the ONE rule, used by the effect,
 *  by SSR and by hydration, so all three agree byte for byte. */
export function _sigText(val: unknown): string {
  return val == null ? "" : String(val);
}

/** The dedup key for the "a signal child is not text" warning — ONE per signal
 *  INSTANCE.
 *
 *  It used to be the signal's `_name`, which is `undefined` for every signal
 *  nobody named: they all shared the id `"anon"`, so the first anonymous signal
 *  to hold an object silenced the warning for every other one in the process.
 *  A once-per-thing warning has to key on the thing. */
const _sigWarnIds = new WeakMap<object, string>();
let _sigWarnSeq = 0;
function _sigWarnId(sig: Signal<unknown>): string {
  let id = _sigWarnIds.get(sig as unknown as object);
  if (!id) {
    id = `signal-child-object-${sig._name ?? "anon"}-${_sigWarnSeq++}`;
    _sigWarnIds.set(sig as unknown as object, id);
  }
  return id;
}

/** Bind `vnode`'s signal to `node`: the text follows the signal from now on. */
export function _bindSignalText(vnode: VNode, node: Text): void {
  vnode._unbind?.();
  const sig = vnode._sig as Signal<unknown>;
  vnode._unbind = effect(() => {
    const val = sig.value;
    // Dev-only: a signal child renders as TEXT. A value that is an object, an
    // array or a vnode turns into "[object Object]" / "a,b" on screen, which
    // looks like a rendering bug when it is a shape mistake — say what it is
    // and what to do instead, once per signal.
    if (isDevMode() && val !== null && typeof val === "object") {
      _devWarn(
        _sigWarnId(sig),
        `A signal used as a child holds ${
          Array.isArray(val)
            ? "an array"
            : "tag" in (val as Record<string, unknown>)
            ? "a vnode"
            : "an object"
        } — a signal child renders as TEXT, so this shows as ${
          JSON.stringify(_sigText(val))
        }. To render nodes from a signal, read it inside the component ` +
          `({sig.value}) or derive a string (computed(() => …)).`,
      );
    }
    node.textContent = _sigText(val);
  });
}

/** Dispose a `_SignalText` vnode's effect (idempotent). */
export function _unbindSignalText(vnode: VNode): void {
  if (vnode._unbind) {
    vnode._unbind();
    vnode._unbind = undefined;
  }
}

// ── Action cleanup handles per element ──────────────────────────────
const _actionCleanups = new WeakMap<HTMLElement, (() => void)[]>();

/** Run action functions and store cleanup handles. */
export function _applyActions(el: HTMLElement, actions: unknown): void {
  if (!Array.isArray(actions)) return;
  // Dispose any prior action cleanups before overwriting — defends against
  // callers that re-apply actions without an explicit cleanup step (the diff
  // path cleans up first, but hydration/re-render paths may not).
  _cleanupActions(el);
  const cleanups: (() => void)[] = [];
  for (const action of actions) {
    if (typeof action !== "function") continue;
    try {
      const result =
        (action as (node: HTMLElement) => { cleanup?(): void } | void)(el);
      if (result && typeof result.cleanup === "function") {
        cleanups.push(result.cleanup);
      }
    } catch (e) {
      console.error("[aio:vdom] action execution error:", e);
    }
  }
  if (cleanups.length > 0) {
    _actionCleanups.set(el, cleanups);
  }
}

/** Run stored cleanup functions for an element's actions. */
export function _cleanupActions(el: HTMLElement): void {
  const cleanups = _actionCleanups.get(el);
  if (cleanups) {
    try {
      for (const fn of cleanups) {
        try {
          fn();
        } catch (e) {
          console.error("[aio:vdom] action cleanup error:", e);
        }
      }
    } finally {
      _actionCleanups.delete(el);
    }
  }
}
