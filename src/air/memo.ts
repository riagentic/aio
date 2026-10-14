// memo — the React-shaped no-op.
//
// AIR's renderer already skips a component whose props are shallow-equal
// (renderer-rerender.ts), so wrapping one in `memo()` changes nothing. It
// exists so React-shaped code compiles unchanged.
//
// It lives here, transport-free, rather than in browser/browser-air-hooks.ts:
// the android entry (src/standalone-air.ts) must expose the same `aio/air`
// surface, and it may not pull in the browser transport to get an identity
// function.

import { firstTime } from "../protocol/said-once.ts";

let _warnedCompare = false;

/** No-op in AIR — the renderer has built-in auto-memo via shallow prop
 *  comparison. Present so a React `memo(Component)` keeps compiling.
 *
 *  A CUSTOM `compare` is not a no-op, though: React code passes one precisely
 *  when shallow equality is the wrong answer (a deep compare over an object
 *  prop, or a deliberate "never re-render" `() => true`). Dropping it silently
 *  meant the component re-rendered on a rule the author had explicitly
 *  replaced — so it is reported rather than swallowed: dev with the way out,
 *  a production page with the fact, each once. */
export function memo<P extends Record<string, unknown>>(
  Component: (props: P) => unknown,
  _compare?: (prev: P, next: P) => boolean,
): (props: P) => unknown {
  // `_compare` keeps its underscore: it is still not USED to memoize anything
  // (AIR has no hook for a per-component comparator), only inspected so that
  // discarding it is REPORTED rather than silent.
  const dev = (globalThis as Record<string, unknown>).__aioDev === true;
  if (_compare && (dev ? !_warnedCompare : firstTime("memo.compare"))) {
    _warnedCompare ||= dev;
    console.warn(
      `[aio${dev ? "-dev" : ""}] memo(${
        Component.name || "Component"
      }, compare) — the custom comparator is IGNORED.` +
        (dev
          ? ` AIR's renderer memoizes ` +
            `every component by shallow prop equality already, and has no hook to ` +
            `swap that rule per component. If the comparator was doing real work ` +
            `(a deep compare, or "never re-render"), move it into the component: ` +
            `derive the value it was protecting and read that instead.`
          : ""),
    );
  }
  return Component;
}
