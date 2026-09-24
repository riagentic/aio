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
  /** Set once a component of this render asked for anything in `<head>`. A
   *  render that asked for none can neither leak a head nor miss one, which
   *  is what keeps the refusal below off pages that do not use `useHead`. */
  hasHead: boolean;
  /** Set once this render's head has been handed to somebody — by key, or as
   *  the no-argument answer. An uncollected render is one whose caller may
   *  still be about to ask. */
  collected: boolean;
  /** Set when this render FINISHED while an earlier stream was still waiting
   *  to be asked for its head: from that moment the no-argument answer is
   *  this render for BOTH callers, so there is no honest one. */
  superseded: boolean;
  /** Its consumer returned the stream before the end — the client went away.
   *  Its caller will never ask, and its head is nobody else's answer. */
  aborted: boolean;
  /** The render epoch right after its own set-up (see `_ssrRenderSetUp`). */
  epoch: number;
  /** Set at a top-level call whose async context set the route and was NOT
   *  the last to set it (see {@linkcode _ssrRouteForeignNow}): the call site,
   *  said at the render's first route READ. Null otherwise. */
  routeForeign: Error | null;
  /** The route writer current in the call's async context (see
   *  {@linkcode RouteWriter}) — what a same-turn re-read is checked against. */
  routeCtx: RouteWriter | undefined;
  /** {@linkcode _ssrRouteWrites} at the call. */
  routeSince: number;
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

/** The most recently STARTED top-level render. Only the FALLBACK answer for a
 *  no-argument `collectHead()` — see {@linkcode _ssrRenderLastEnded} for why
 *  start order is the wrong question, and `_collectTarget` for the one case
 *  that still needs it (a collect while the first render is still open). */
let _last: SsrRender | null = null;
/** The most recently FINISHED top-level render — the one a no-argument
 *  `collectHead()` answers for.
 *
 *  START ORDER IS THE WRONG QUESTION, and this is the bug that hid behind the
 *  first version of this module. A caller always asks for its head AFTER its
 *  own render has ended; a render that STARTED after mine ended is therefore
 *  never mine, and pointing at it hands one response another's `<title>`,
 *  description and canonical URL — the exact defect per-render state was
 *  added to close, one window further along. Measured, two requests one after
 *  the other with an await between the body and the head:
 *
 *    for await (…renderToStream(<Page name="alice"/>)) …   // ends
 *    …request B starts streaming…
 *    collectHead()  →  <title>bob</title>     // alice's response
 *
 *  Nothing flagged it: the two renders never overlapped in time, so the
 *  "another render was live when this one started" test — which is all the
 *  first version had — was false for both. End order gets both callers right
 *  with no refusal at all, and {@linkcode SsrRender.superseded} covers what
 *  is left. */
let _lastEnded: SsrRender | null = null;
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
  return {
    kind,
    ids: 0,
    selects: [],
    hasHead: false,
    collected: false,
    superseded: false,
    aborted: false,
    epoch: 0,
    routeForeign: null,
    routeCtx: undefined,
    routeSince: 0,
  };
}

/** Top-level server renders SET UP so far (a stream's at its call, a string
 *  render's at its start). A render's `epoch` is this count right after its
 *  own set-up, so "has anything else been set up since?" is one comparison. */
let _setUps = 0;

/** A top-level render was set up: count it, and stamp it. */
export function _ssrRenderSetUp(r: SsrRender): void {
  r.epoch = ++_setUps;
}

/** The render epoch now — see `_ssrRenderSetUp`. */
export function _ssrRenderEpoch(): number {
  return _setUps;
}

/** Mark a top-level render as in progress. */
export function _ssrRenderStart(r: SsrRender): void {
  _last = r;
}

/** End the span {@linkcode _ssrRenderStart} opened.
 *
 *  NOT a liveness set. The first version kept one, and a stream the consumer
 *  pulled once and then dropped — a `Promise.race` that timed out, a manual
 *  `next()` loop that broke — never ran its `finally`, so it stayed "live"
 *  for the life of the process and every later render was flagged as having
 *  overlapped it: one abandoned generator turned every subsequent no-argument
 *  `collectHead()` into a permanent throw, for an app serving one request at
 *  a time. Nothing here now depends on a render ever ending, so a render that
 *  never does costs exactly one object. */
export function _ssrRenderFinish(r: SsrRender, returned = false): void {
  r.aborted = returned;
  const prev = _lastEnded;
  // The one case end order cannot separate: an earlier STREAM finished, its
  // caller has not asked yet (only a stream's caller can be separated from
  // its own render by an await), and now this render is the answer for both
  // of them. Only when both actually carry a head — a render that asked for
  // none can neither be robbed nor do the robbing, and a page with no head is
  // most apps.
  if (
    prev && prev !== r && prev.kind === "stream" && !prev.collected &&
    prev.hasHead && r.hasHead
  ) r.superseded = true;
  _lastEnded = r;
}

/** The most recently started top-level render. */
export function _ssrRenderLast(): SsrRender | null {
  return _last;
}

/** The most recently FINISHED top-level render — see {@linkcode _lastEnded}. */
export function _ssrRenderLastEnded(): SsrRender | null {
  return _lastEnded;
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

// ── An explicit route (`renderToString(v, { route })`) ─────────────────
// A render given its route never reads `routePath` / `routeSearch`: the route
// travels in its scope under this key (so nested renders and later stream
// pulls inherit it), and is exposed here for the synchronous span of each
// read the render makes — so the router and the route signals' own getters
// answer with it, and any computed over them is recomputed for it.

/** One render's explicit route. */
export interface SsrRoute {
  readonly path: string;
  readonly search: URLSearchParams;
}

/** The key an explicit route travels under inside an SSR scope. */
export const SSR_ROUTE_KEY: unique symbol = Symbol("aio.ssrRoute.explicit");

// The route in effect is the signals' READ SCOPE (state/signal.ts), entered
// by `_ssrIn` in air/vdom-ssr.ts around every read a render makes.

/** Name a render with the caller's key. */
export function _ssrRenderBindKey(key: object, r: SsrRender): void {
  _byKey.set(key, r);
}

/** The render a key names, or null when that key named none. */
export function _ssrRenderForKey(key: object): SsrRender | null {
  return _byKey.get(key) ?? null;
}

// ── Route warnings: said with a count, never silent for good ─────────
// Every route warning is keyed by kind + call site. Said the 1st, 2nd, 4th,
// 8th … time a site is hit, each repeat carrying how often it happened and
// how many went unsaid since the last line. "Once per call site per process"
// made the 2nd..Nth mis-render of a busy handler silent forever; this stays
// quiet under load (log2 lines) and still says it is happening.

/** Per key: times hit, and the count at which it was last said. */
const _routeSites = new Map<string, { n: number; said: number }>();

/** Count one hit at `key`. The suffix to append when it is said now ("" for
 *  the first), or null when this hit is only counted. */
export function _ssrRouteSaidAt(key: string): string | null {
  const e = _routeSites.get(key) ?? { n: 0, said: 0 };
  _routeSites.set(key, e);
  e.n++;
  if ((e.n & (e.n - 1)) !== 0) return null; // not a power of two: count only
  const unsaid = e.n - e.said - 1;
  e.said = e.n;
  return e.n === 1 ? "" : ` [${e.n} times at this call site; ${unsaid} more ` +
    `since the last warning]`;
}

// ── Who set the route ─────────────────────────────────────────────────
// `routePath` / `routeSearch` are one pair of signals for the whole process.
// Every write stamps the writer's ASYNC CONTEXT with a fresh token (and
// remembers it as the last writer); a top-level server render compares, at
// its call, the token of its own context with the last writer's. Different
// means the route this render reads may have been set outside its
// synchronous step — by another request, or by this one before an await — and
// is said at the render's first route READ (a page that never reads the route
// is never told). Observe-only; dev and prod alike.
//
// What a token can and cannot tell (measured on Deno 2.9):
//  • A context that never wrote the route may still CARRY a token: a write in
//    a `Deno.serve` handler's synchronous prefix lands on the accept loop, and
//    every request accepted after it starts with that token. So "no write, no
//    check" does not hold; the READ gate is what keeps a page that does not
//    use the route quiet.
//  • A write inside another library's `AsyncLocalStorage.run()` (a tracer's
//    active span) is dropped from the context when that `run()` returns, so
//    the render after it sees the token from BEFORE the write. Such a write
//    is excused when it was made in this tick (no microtask since) FROM this
//    context's token — the render's own synchronous step. The same rule
//    excuses a write by a context that inherited this one's token through
//    the accept-loop leak above; that is the one shape of "another request"
//    this cannot see.
//
// Server-only by construction: `node:async_hooks` is asked for at runtime
// (`process.getBuiltinModule`), never imported, so no browser bundle carries
// it; with no `process` (a browser) every function here is a no-op.

/** One route write, as seen from the async context that made it. Holds no
 *  other token — only ids — so nothing a write leaves behind keeps earlier
 *  writes alive (a static-site loop of 100k `set` + render retains one).
 *  `base` is the id the writer's context held before this tick's first write
 *  in it — shared by every write of one synchronous run of writes, however
 *  long. */
export interface RouteWriter {
  readonly id: number;
  readonly tick: number;
  readonly base: number;
}
interface RouteStore {
  getStore(): RouteWriter | undefined;
  enterWith(t: RouteWriter): void;
}
let _store: RouteStore | null | undefined;
function _routeStore(): RouteStore | null {
  if (_store !== undefined) return _store;
  _store = null;
  try {
    const p = (globalThis as {
      process?: { getBuiltinModule?: (id: string) => unknown };
    }).process;
    const m = p?.getBuiltinModule?.("node:async_hooks") as
      | { AsyncLocalStorage?: new () => RouteStore }
      | undefined;
    if (typeof m?.AsyncLocalStorage === "function") {
      _store = new m.AsyncLocalStorage();
    }
  } catch {
    // aio-ok: no async context API (a browser, a sandbox) — the check is off
  }
  return _store;
}
let _lastWriter: RouteWriter | undefined;
let _writerIds = 0;
/** Bumped by a microtask after any write: "no microtask since the write" is
 *  `writer.tick === _tick`. */
let _tick = 0;
let _tickArmed = false;
function _tickNow(): number {
  if (!_tickArmed) {
    _tickArmed = true;
    queueMicrotask(() => {
      _tick++;
      _tickArmed = false;
    });
  }
  return _tick;
}

/** A route signal was written: stamp the writer's async context. */
export function _ssrRouteWritten(): void {
  const s = _routeStore();
  if (s === null) return;
  const tick = _tickNow();
  const prev = s.getStore();
  const same = prev !== undefined && prev.tick === tick;
  const t: RouteWriter = {
    id: ++_writerIds,
    tick,
    base: same ? prev.base : prev?.id ?? 0,
  };
  s.enterWith(t);
  _lastWriter = t;
}

/** The route writer current in this async context (undefined: none). */
export function _ssrRouteContext(): RouteWriter | undefined {
  return _routeStore()?.getStore();
}

/** Was `t` written from `ctx`'s token — the first write after it in its
 *  context this tick, or a later one of the same run (same tick, same base:
 *  `ctx` and `t` both belong to that run of writes, whatever its length)? */
function _writtenFrom(t: RouteWriter, ctx: RouteWriter): boolean {
  return t.base === ctx.id || (ctx.tick === t.tick && ctx.base === t.base);
}

/** Did the route this call reads come from outside the call's context? Not
 *  when the last write was made in this very tick from the call's own token
 *  (a write inside another library's `run()` — see above). */
export function _ssrRouteForeign(ctx: RouteWriter | undefined): boolean {
  const last = _lastWriter;
  if (ctx === undefined || last === undefined || ctx === last) return false;
  return !(last.tick === _tick && _writtenFrom(last, ctx));
}

/** How many route writes so far — a render's call records it, so a later
 *  check can ask about writes made AFTER the call only. */
export function _ssrRouteWrites(): number {
  return _writerIds;
}

/** Was the LAST route write made after write number `since`, from `ctx`'s
 *  token, within the tick — the 1.0.9 create-then-set step
 *  (`renderToStream(…); routePath.set(p)`)? */
export function _ssrRouteWrittenSince(
  ctx: RouteWriter | undefined,
  since: number,
): boolean {
  const last = _lastWriter;
  return ctx !== undefined && last !== undefined && last.id > since &&
    _writtenFrom(last, ctx);
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
  _routeSites.clear();
  _lastWriter = undefined;
  _last = null;
  _lastEnded = null;
  _current = null;
}
