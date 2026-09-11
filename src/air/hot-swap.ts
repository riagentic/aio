// hot-swap.ts — replace the root component without reloading the document.
//
// A `.tsx` edit reloads the whole page. aio starts from a better position than
// anyone here — cell state lives on the server and already survives a reload —
// so what is lost is usually small: `useLocal`, scroll, focus, stateful DOM.
// But "small" included an embedded `<webview>` with its logged-in session
// (newjob §8.3), 760 MB of GPU weights (watcher §8.2) and a wallet's unlock
// (risoto §22.4). Those do not come back.
//
// AIR already preserves stateful nodes across a re-render: the diff PATCHES
// the DOM rather than replacing it, so a `<webview>`, a `<video>`, focus and
// scroll all survive a root re-render. `RootState.App` is the component the
// root renders. So the whole mechanism is: put a new function there and
// re-render.
//
// THE HARD PART IS KNOWING WHEN IT IS SAFE, and the answer is deliberately
// narrow. Re-importing a module gives a fresh copy; every module that imported
// the OLD one still holds the old one. For the UI ENTRY that is exactly right
// — nothing in the client graph imports it, so nothing can be left stale — and
// for anything else it is not, because the module that imports the changed
// file keeps the version it already has. A component that swaps on the entry
// and silently does not on a child is worse than a reload that always works,
// so the watcher only ever asks for this when the ENTRY, and nothing else, has
// changed. Everything else is a reload, exactly as before.
//
// Cells are untouched for the same reason, and that is the point rather than a
// limitation: `src/cell.ts` is not re-imported, so the stub a component holds
// is the bound one it has always held. Re-evaluating it would hand the new
// component an unbound twin of every cell — the failure that makes naive HMR
// "sometimes works".

import { _liveRoots } from "./renderer-state.ts";
import { _rerenderRoot } from "./renderer-flush.ts";
import type { ComponentFn } from "./vdom.ts";

/** Swap the component every live root renders, and re-render.
 *
 *  Returns how many roots were swapped. ZERO is a real answer — a page with no
 *  mounted root cannot be patched — and the caller is expected to fall back to
 *  a reload rather than treat it as success. */
export function swapRootComponent(next: ComponentFn): number {
  let swapped = 0;
  for (const root of _liveRoots) {
    if (root.disposed) continue;
    // RETAG THE OLD TREE FIRST, and this is the line that makes it a patch
    // rather than a remount. `_rerenderRoot` diffs `h(state.App)` against the
    // previous root vnode, and a vnode whose `tag` is a DIFFERENT function is
    // a different component — so the reconciler replaces the whole subtree,
    // taking every stateful node with it. Measured: a `<video>` really was a
    // new element afterwards, which is exactly the login this feature exists
    // to keep.
    //
    // Retagging says what actually happened: the same component, with a new
    // implementation. The instance is reused, the diff runs on the RENDERED
    // output, and a node that did not change is the node it already was.
    const old = root.vnode;
    if (old && typeof old === "object") {
      const v = old as {
        tag?: unknown;
        _instance?: { vnode?: { tag?: unknown } };
      };
      v.tag = next;
      if (v._instance?.vnode) v._instance.vnode.tag = next;
    }
    root.App = next;
    _rerenderRoot(root);
    swapped++;
  }
  return swapped;
}
