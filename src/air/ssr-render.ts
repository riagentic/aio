// One server render's own state — the thing SSR used to keep in module
// variables.
//
// THE BUG THIS CLOSES. `renderToStream` is an async generator: it calls each
// component when its chunk is PULLED, so two responses being written at once
// interleave at every `yield`. Everything the SSR path held module-wide was
// therefore ONE scope shared by both renders, and each render RESET it when it
// started. Measured, two interleaved streams of the same page:
//
//   ids      A: :r0: :r2:   B: :r1: :r3:     (one counter, handed out in turn)
//   <head>   collectHead() → B's title, description and canonical, for BOTH
//   <select> A: BOTH options `selected`      (B's open <select> scope leaked)
//
// The ids are a hydration mismatch. The head is one visitor's page title and
// canonical URL served inside another visitor's response — a privacy defect.
//
// A lock would have serialised SSR, which is a throughput regression and still
// leaves the ids wrong for a nested render. So a render carries its own state
// instead, in the context scope the writers ALREADY thread through every
// element and every component call (`SsrContexts`). Concurrency costs nothing:
// two renders never look at the same object.
//
// Leaf module by design — NO imports — so the writers (`vdom-ssr`,
// `ssr-stream`), the shared helpers (`ssr-utils`) and the hooks
// (`renderer-lifecycle`, `head`) can all reach it without a cycle.

/** The state of ONE top-level `renderToString` / `renderToStream`.
 *
 *  A render nested inside a server component call (a `renderToString` inside a
 *  streamed component) SHARES its parent's — it is one document, so it is one
 *  id sequence and one `<head>`. */
export interface SsrRender {
  /** Which entry point opened it. Only a stream can be overtaken by another
   *  render between its last chunk and the caller's next statement, which is
   *  what makes an unkeyed `collectHead()` ambiguous for it. */
  readonly kind: "string" | "stream";
  /** The `useId()` sequence — `:r0:`, `:r1:`, … per render, so hydration
   *  (which restarts at 0 for the root) reproduces exactly these. */
  ids: number;
  /** The values of the `<select>` elements open around the cursor, innermost
   *  last, so an `<option>` knows which select it is being compared against. */
  readonly selects: unknown[];
  /** Set once another top-level render was live at the same time as this one. */
  overlapped: boolean;
  /** Set when the render finishes (normally or by throwing). */
  ended: boolean;
}

/** The key the render travels under inside an SSR context scope. Not a context
 *  id: `useContext` can never name it. */
export const SSR_RENDER_KEY: unique symbol = Symbol("aio.ssrRender");

/** The render a scope belongs to, or null when the scope carries none. */
export function _ssrRenderOf(
  scope: ReadonlyMap<symbol, unknown> | null | undefined,
): SsrRender | null {
  return (scope?.get(SSR_RENDER_KEY) as SsrRender | undefined) ?? null;
}

/** The renders that have started and not yet finished. Only ever holds a
 *  render for the span of its own writer, so nothing accumulates: a stream
 *  that is created and never pulled never enters it. */
const _live = new Set<SsrRender>();
/** The most recently STARTED top-level render — the one a no-argument
 *  `collectHead()` answers for. */
let _last: SsrRender | null = null;
/** The render whose component body is executing RIGHT NOW. Set for the
 *  SYNCHRONOUS span of one component call only (see `_ssrScoped`), which is
 *  exactly when a hook body runs — no `yield` can happen inside it, so this
 *  one global cannot be two renders at once. */
let _current: SsrRender | null = null;

/** A render by the KEY its caller named it with — whatever object the request
 *  handler passed to `renderToStream` and later to `collectHead` (its
 *  `Request`, most naturally). That key is the only thing that identifies one
 *  response's render from outside it, which is what makes the head exact under
 *  concurrency. Weak: a key nobody holds is collected with its render. */
const _byKey = new WeakMap<object, SsrRender>();

/** Create a render. It is not live until {@linkcode _ssrRenderStart}. */
export function _ssrRenderNew(kind: SsrRender["kind"]): SsrRender {
  return { kind, ids: 0, selects: [], overlapped: false, ended: false };
}

/** Mark a top-level render as in progress. Any render already live and this
 *  one are flagged as having overlapped — the fact a no-argument
 *  `collectHead()` needs to know it cannot answer. */
export function _ssrRenderStart(r: SsrRender): void {
  if (_live.size > 0) {
    r.overlapped = true;
    for (const other of _live) other.overlapped = true;
  }
  _live.add(r);
  _last = r;
}

/** End the span {@linkcode _ssrRenderStart} opened. */
export function _ssrRenderFinish(r: SsrRender): void {
  r.ended = true;
  _live.delete(r);
}

/** The most recently started top-level render. */
export function _ssrRenderLast(): SsrRender | null {
  return _last;
}

/** The render whose component body is executing, or null outside one. */
export function _ssrRenderCurrent(): SsrRender | null {
  return _current;
}

/** Make `r` the executing render for a synchronous span; returns the previous
 *  one, which the caller MUST restore in a `finally`. */
export function _ssrRenderEnter(r: SsrRender | null): SsrRender | null {
  const prev = _current;
  _current = r;
  return prev;
}

/** Name a render with the caller's key. */
export function _ssrRenderBindKey(key: object, r: SsrRender): void {
  _byKey.set(key, r);
}

/** The render a key names, or null when that key named none. */
export function _ssrRenderForKey(key: object): SsrRender | null {
  return _byKey.get(key) ?? null;
}

/** @internal Test seam — forget every server render.
 *
 *  Module-scope state whose lifetime nobody owns is cross-test bleed: without
 *  this, a `collectHead()` in a test that rendered nothing would answer with
 *  the PREVIOUS test's page. `_resetHead` calls it, so the harness's head reset
 *  covers the server half too.
 */
// aio-ok: a test-only seam; a live render never forgets itself
export function _resetSsrRenders(): void {
  _live.clear();
  _last = null;
  _current = null;
}
