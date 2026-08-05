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

/** No-op in AIR — the renderer has built-in auto-memo via shallow prop
 *  comparison. Present so a React `memo(Component)` keeps compiling. */
export function memo<P extends Record<string, unknown>>(
  Component: (props: P) => unknown,
  _compare?: (prev: P, next: P) => boolean,
): (props: P) => unknown {
  return Component;
}
