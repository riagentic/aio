// method-cancel.ts — cancellation for async methods (perfect-aio D1: the
// method-native replacement for generator cancelOn).
//
//   cell("checkout", {
//     cancelOn: { place: [cart.clear] },   // cart.clear aborts a running place()
//     methods: {
//       async place(s, item) {
//         s.status = "placing";
//         const r = await fetch(url, { signal: s.$signal }); // signal-aware IO
//         if (s.$signal.aborted) return;                     // or check manually
//         s.status = "placed";
//       },
//     },
//   })
//
// The framework aborts the in-flight call's AbortController when a trigger
// action dispatches; the method observes it via `s.$signal` (and until()
// accepts it). Registry is per (cellPrefix, method) — module-scoped like the
// other runtime registries, reset via _resetMethodCancel for test isolation.

type Key = string; // `${cellPrefix}:${method}`

/** trigger action type → set of method keys it cancels */
const _triggers = new Map<string, Set<Key>>();
/** method key → in-flight AbortControllers */
const _inflight = new Map<Key, Set<AbortController>>();
/** Cells whose app is shutting down. `abortAllInflight` can only abort
 *  controllers that exist at sweep time — a `serialize: true` call queued
 *  behind the aborted one starts a moment LATER with a fresh controller and
 *  would stream unaware through the whole drain deadline, then lose its
 *  writes at the sealed queue. Tracking the shutdown here lets `trackCall`
 *  hand such a late starter an already-aborted signal: in-flight calls finish
 *  writing, queued ones take their cancellation path on the first check.
 *  `endShutdownAbort` clears it, so a later app booting the same cell names
 *  in this process (every sequential test does) starts clean. */
const _shutdownCells = new Set<string>();
let _shutdownAll = false;

/** Register cancel triggers for a method (called at cell creation).
 *
 *  `"self"` — bare or inside the list — resolves to the method's OWN action
 *  type: newest call wins, older ones abort. It can never abort the incoming
 *  call, because triggers fire during reduce and the new call is only tracked
 *  when its effect runs, one step later. */
export function registerCancelOn(
  cellPrefix: string,
  method: string,
  triggers: "self" | (string | { type: string })[],
): void {
  const key = `${cellPrefix}:${method}`;
  const list = triggers === "self" ? ["self"] : triggers;
  for (const t of list) {
    const raw = typeof t === "string" ? t : t.type;
    const type = raw === "self" ? key : raw;
    let set = _triggers.get(type);
    if (!set) _triggers.set(type, set = new Set());
    set.add(key);
  }
}

/** Track an in-flight async method call. Returns an untrack fn. */
export function trackCall(
  cellPrefix: string,
  method: string,
  controller: AbortController,
): () => void {
  const key = `${cellPrefix}:${method}`;
  if (_shutdownAll || _shutdownCells.has(cellPrefix)) controller.abort();
  let set = _inflight.get(key);
  if (!set) _inflight.set(key, set = new Set());
  set.add(controller);
  return () => {
    set!.delete(controller);
    // Identity check: notifyMethodCancel DELETES the map entry, so a later call
    // installs a NEW set under the same key. Without `=== set`, the older call
    // settling afterwards deleted that newer set — and the newer call silently
    // stopped being cancellable (cancelOn quietly stopped working).
    if (set!.size === 0 && _inflight.get(key) === set) _inflight.delete(key);
  };
}

/** Abort every in-flight call whose method lists this action as a trigger.
 *  Called from the composed reduce for every dispatched action. */
export function notifyMethodCancel(actionType: string): void {
  const keys = _triggers.get(actionType);
  if (!keys) return;
  for (const key of keys) {
    const set = _inflight.get(key);
    if (!set) continue;
    for (const c of set) c.abort();
    _inflight.delete(key);
  }
}

/** Every async call that has not finished writing yet — the WHOLE chain, past
 *  the method body's own `.finally(untrack)` to its final write-set commit. The
 *  dispatch loop cannot see these: a cell's `execute` runs the method and
 *  returns nothing, so `dispatch.drain()` has never had anything to wait for.
 *  Shutdown does, which is why the registry is here. */
const _pending = new Map<Promise<unknown>, string>();

/** Track a whole async call — body, commit and all — under its cell's prefix,
 *  so a shutting-down app can wait for ITS calls and no one else's. */
export function trackPending(p: Promise<unknown>, cellPrefix = ""): void {
  _pending.set(p, cellPrefix);
  const drop = () => _pending.delete(p);
  p.then(drop, drop);
}

/** How many async calls are still finishing. */
export function pendingCalls(): number {
  return _pending.size;
}

/** How many of `cells`' async calls are still finishing (all when omitted).
 *  The drain gate must count ITS app's calls, not the process's: with two
 *  apps in one process (D2), app A's closed queue must not stay open on app
 *  B's in-flight work. */
export function pendingCallsFor(cells?: Set<string>): number {
  return _pendingFor(cells).length;
}

/** The pending calls belonging to `cells` (every call when `cells` is
 *  undefined — the process-wide view). */
function _pendingFor(cells?: Set<string>): Promise<unknown>[] {
  if (!cells) return [..._pending.keys()];
  const out: Promise<unknown>[] = [];
  for (const [p, prefix] of _pending) if (cells.has(prefix)) out.push(p);
  return out;
}

/** How long a shutting-down app waits, IN TOTAL, for aborted work to finish
 *  writing — in-flight cell calls and effect promises share this one budget.
 *  Long enough for an aborted fetch/subprocess to unwind, short enough that a
 *  method which ignores its signal cannot hold the window open.
 *
 *  It lives HERE, next to the primitives it bounds, because BOTH runtimes end
 *  a process: `src/server/shutdown.ts` Phase 1 and `src/standalone-air.ts`'s
 *  `close()` (the Android/WebView build). Two copies of this number would be
 *  two answers to "how long does closing take", and the second runtime already
 *  proved what a second answer costs — it had no drain at all. */
export const DRAIN_TIMEOUT_MS = 3000;

/** Wait for every in-flight call to finish writing, up to `timeoutMs`.
 *  Returns how many were still running when the wait ended.
 *
 *  `cells` scopes the wait to one app's cells. Two apps in one process are
 *  supported by design (D2: an instance-scoped runtime), and one of them
 *  shutting down must not sit on the other's work — or wait out its deadline
 *  for a call it does not own. */
export async function settlePending(
  timeoutMs: number,
  cells?: Set<string>,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let mine = _pendingFor(cells);
  while (mine.length > 0) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(mine),
      // aiol-ok: shutdown's drain deadline — a bare timer racing the settle is
      // the point; schedule.* is app-side and not importable here.
      new Promise((r) => t = setTimeout(r, left)),
    ]);
    if (t !== undefined) clearTimeout(t);
    mine = _pendingFor(cells);
  }
  return mine.length;
}

/** Abort EVERY in-flight async method, whatever its cancelOn triggers say.
 *
 *  Shutdown's one use: a method that streams (an SSE reply, a subprocess pipe)
 *  has no reason of its own to stop, and shutdown drains in-flight effects
 *  before it persists. Without this the drain waits for a reply that may be
 *  minutes away — or, worse, the effect is killed mid-write by a closed
 *  dispatch and its final state is lost. Aborting first lets each method take
 *  its own documented cancellation path (`s.$signal.aborted`) and commit what
 *  it has, which is exactly what the final persist should capture.
 *
 *  `cells` scopes it to one app's cells — omitting it aborts the whole
 *  process. Two apps can share a process (D2: an instance-scoped runtime, and
 *  every `testServer()` pair does it), so an unscoped abort would have one
 *  app's shutdown cancel another app's running methods mid-write. Cell
 *  bindings are already released this way (`_releaseCells`); cancellation is
 *  the same claim.
 *
 *  Returns how many calls were aborted, so the caller can say so in the log. */
export function abortAllInflight(cells?: Set<string>): number {
  if (cells) { for (const c of cells) _shutdownCells.add(c); }
  else _shutdownAll = true;
  let n = 0;
  for (const [key, set] of _inflight) {
    // key is `${cellPrefix}:${method}`, and a cell name carries no colon.
    if (cells && !cells.has(key.slice(0, key.indexOf(":")))) continue;
    for (const c of set) {
      if (!c.signal.aborted) {
        c.abort();
        n++;
      }
    }
    _inflight.delete(key);
  }
  return n;
}

/** Test isolation: forget all triggers and abort nothing. */
export function _resetMethodCancel(): void {
  _triggers.clear();
  _inflight.clear();
  _pending.clear();
  _shutdownCells.clear();
  _shutdownAll = false;
}

/** End the shutdown window opened by `abortAllInflight`: stop pre-aborting
 *  new calls for these cells. Called when the app's drain is over — a later
 *  app in the same process may legitimately reuse the names. */
export function endShutdownAbort(cells?: Set<string>): void {
  if (cells) { for (const c of cells) _shutdownCells.delete(c); }
  else {
    _shutdownCells.clear();
    _shutdownAll = false;
  }
}
