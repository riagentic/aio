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

/** The `use` prop as a list of actions, each with the arguments it is called
 *  with after the element — or null when the prop is not an action at all.
 *
 *  ONE reading of the prop, shared by the runner and by the diff's "did the
 *  actions change" question. The docs (docs/ui/air-advanced.md) promise three
 *  shapes — `use={fn}`, `use={[fn, value]}` calling `fn(el, value)`, and
 *  `use={[a, b]}` running both — and the runner used to honour only the last:
 *  a bare function was dropped without a word (`<input use={autoFocus}>`, the
 *  doc's own first example, focused nothing), and the value in `[tooltip,
 *  "text"]` never reached `tooltip`. Both were silent — no throw, no warning,
 *  a directive that "simply does nothing". The rule: every function in the
 *  list is an action, and the non-functions that FOLLOW it are its arguments. */
export function _actionList(
  actions: unknown,
): { fn: (...a: unknown[]) => unknown; args: unknown[] }[] | null {
  const list = typeof actions === "function"
    ? [actions]
    : Array.isArray(actions)
    ? actions
    : null;
  if (!list) return null;
  const out: { fn: (...a: unknown[]) => unknown; args: unknown[] }[] = [];
  for (const item of list) {
    if (typeof item === "function") {
      out.push({ fn: item as (...a: unknown[]) => unknown, args: [] });
    } else if (out.length > 0) {
      out[out.length - 1]!.args.push(item);
    }
  }
  return out;
}

/** True when two `use` props describe DIFFERENT actions.
 *
 *  Compared by CONTENT, not by identity. `use={[autoFocus]}` is a fresh array
 *  on every render, and an identity check made the diff tear the actions down
 *  and run them again on each re-render of the component that wrote them — a
 *  `use={[initEditor]}` destroyed and rebuilt its editor on every keystroke of
 *  an unrelated input in the same component, and the docs' "cleanup on
 *  unmount" promise ran on every parent update instead. Same functions, same
 *  arguments: same actions, nothing to redo. */
export function _actionsChanged(next: unknown, prev: unknown): boolean {
  if (next === prev) return false;
  const a = _actionList(next);
  const b = _actionList(prev);
  if (!a || !b) return a !== b;
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.fn !== y.fn || x.args.length !== y.args.length) return true;
    for (let j = 0; j < x.args.length; j++) {
      if (!Object.is(x.args[j], y.args[j])) return true;
    }
  }
  return false;
}

/** Run action functions and store cleanup handles. */
export function _applyActions(el: HTMLElement, actions: unknown): void {
  const list = _actionList(actions);
  if (!list) {
    // Not a function and not a list of them — the prop cannot mean anything,
    // and it used to be skipped in silence. Observe-only: prod still skips.
    if (actions != null && actions !== false) {
      _devWarn(
        "use-not-action",
        `A \`use\` prop holds ${typeof actions} — it must be an action function, or an array of them (with ` +
          `their arguments). Nothing was applied.`,
      );
    }
    return;
  }
  // Dispose any prior action cleanups before overwriting — defends against
  // callers that re-apply actions without an explicit cleanup step (the diff
  // path cleans up first, but hydration/re-render paths may not).
  _cleanupActions(el);
  const cleanups: (() => void)[] = [];
  for (const { fn, args } of list) {
    try {
      const result = fn(el, ...args) as
        | { cleanup?(): void }
        | (() => void)
        | void;
      // Two spellings of "here is my teardown": the `{ cleanup }` object the
      // NodeAction type names, and the bare function the docs show. Only the
      // first was honoured, so a documented cleanup never ran and the
      // listener/observer it released stayed attached to a removed element.
      if (typeof result === "function") cleanups.push(result);
      else if (result && typeof result.cleanup === "function") {
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
