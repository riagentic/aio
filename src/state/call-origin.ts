// call-origin.ts — "did this cell call come from SERVER code, or from a client?"
//
// `access:` gates network callers, and its contract says server-origin
// dispatches always bypass — "the server trusts itself" (cell-types.ts). On a
// real socket that needs no marker: a client's frame arrives at
// `dispatchNetwork` and a cell→cell call never does, so the transport IS the
// answer.
//
// Where server and client share ONE isolate there is no transport to read. The
// harness runs exactly that way (the standalone runtime, which is also the
// Android target), and it applies the same gate to the cell's bound methods so
// a test click is refused what a real click would be — the right instinct,
// with no way to tell a click from `unlock.unlockWith()`'s own
// `heavy.encrypt(...)`. So `access: () => false` — the natural rule for a cell
// no UI ever calls, and the case the feature is most obviously for — refused
// the app's own cells, and an audit's eight vault tests failed on it.
//
// The rule, therefore, is MARKED, never inferred:
//   • the framework runs a cell's own code (a method body, an `onInit`) inside
//     `inServerOrigin`, and every call made from in there — including after an
//     `await`, which is why this is a continuation-local scope and not a
//     counter — is server origin;
//   • everything else (a component, an event handler, test code) is not.
//
// It is unforgeable by construction: the marker is ambient runtime state, NOT
// a field on an action, so there is no frame a client could put it on. The
// network doors keep doing exactly what they did — strip and re-stamp
// `_user`/`_source`, then ask `cellAccessAllowed` — and this module is not in
// their path at all.
//
// This file stays isomorphic (it is in the browser bundle): the scope itself
// is an AsyncLocalStorage, which only a server-side runtime can hold, so it is
// INSTALLED from outside rather than imported here.

/** A continuation-local "run `fn` as server origin" scope. */
export type ServerOriginScope = {
  run: <T>(fn: () => T) => T;
  active: () => boolean;
  /** Run `fn` with the scope LEFT — and left for everything `fn` starts, a
   *  timer or a microtask included. A continuation-local scope reaches every
   *  continuation opened inside it, which is exactly right for `await` and
   *  exactly wrong for the framework's own deferred work on the client's
   *  behalf; `exit` is the door back out. `AsyncLocalStorage.exit` is it. */
  exit: <T>(fn: () => T) => T;
};

let _scope: ServerOriginScope | null = null;

/** Install the scope implementation (an `AsyncLocalStorage` one — see
 *  `src/testing/ui-test.ts`). Without it every call below is a pass-through,
 *  which is what the browser bundle and a plain server boot want: nothing in
 *  those asks who the origin was.
 *
 *  @internal */
export function _installServerOriginScope(
  scope: ServerOriginScope | null,
): void {
  _scope = scope;
}

/** Run `fn` — a cell's own code — as server origin. Pass-through (zero
 *  overhead, same call stack) when no scope is installed. */
export function inServerOrigin<T>(fn: () => T): T {
  return _scope ? _scope.run(fn) : fn();
}

/** Run `fn` — and everything it starts — as NOT server origin, whatever the
 *  caller was.
 *
 *  The scope is continuation-local so that a sibling called after an `await`
 *  is still the server calling itself. The same property carries it into
 *  every other continuation opened inside a method body, and the framework
 *  opens one there that runs CLIENT code: a live-proxy write commits inside
 *  the body, the commit flushes the signal graph, and the renderer queues its
 *  batched re-render from inside that flush — so the component body, and
 *  whatever it schedules, inherited "I am the server" and `access:` was
 *  bypassed for a call made straight from a render.
 *
 *  The rule: telling a signal's subscribers that a value changed is not the
 *  writer's continuation. Subscribers are arbitrary code — the view, above
 *  all — so they run out here, and a subscriber that IS server code re-enters
 *  through the front door (a dispatch runs the method body inside
 *  `inServerOrigin` again). Pass-through when no scope is installed. */
export function outsideServerOrigin<T>(fn: () => T): T {
  return _scope ? _scope.exit(fn) : fn();
}

/** Is the caller running inside server code? `false` when nothing is
 *  installed: unmarked is never trusted — the gate this answers must fail
 *  CLOSED, so a missing scope denies rather than grants. */
export function isServerOrigin(): boolean {
  return _scope ? _scope.active() : false;
}
