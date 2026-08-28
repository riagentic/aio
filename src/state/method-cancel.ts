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
// accepts it). Registry is per (app, cellPrefix, method) — module-scoped like
// the other runtime registries, reset via _resetMethodCancel for test
// isolation.
//
// APP IDENTITY (alpha70). Two apps in one process cannot share a cell DEF
// (bindCell refuses it), but they can each hold a different def with the SAME
// id — a factory returning `cell("ledger", …)`, which is exactly what a client
// binding a remote cell does. Keyed by cell name alone, app A's `cart.clear`
// aborted app B's `checkout.place`, and A's shutdown counted, waited on and
// aborted B's calls. Every entry point therefore takes the owning app's
// identity. `""` is the WILDCARD — "app unknown" — and matches every app: a
// caller that has not been threaded an identity yet behaves exactly as the
// name-keyed registry did, and a caller that has is precise. Mixing the two is
// monotone (a wildcard side never hides a scoped one), so the threading can
// land one runtime at a time without a window where cancelOn is silently
// inert.

/** The owning app's identity. `""` = unknown, matches every app. */
export type AppScope = string;

/** True when two scopes name the same app — or either does not know. */
function sameApp(a: AppScope, b: AppScope): boolean {
  return a === "" || b === "" || a === b;
}

type MethodKey = string; // `${cellPrefix}:${method}` — what a human wrote

type Trigger = { app: AppScope; key: MethodKey };
type Inflight = {
  app: AppScope;
  prefix: string;
  key: MethodKey;
  set: Set<AbortController>;
};

/** trigger action type → the (app, method) pairs it cancels */
const _triggers = new Map<string, Set<Trigger>>();
/** in-flight AbortControllers, one entry per (app, method) */
const _inflight = new Set<Inflight>();
/** Cells whose app is shutting down. `abortAllInflight` can only abort
 *  controllers that exist at sweep time — a `serialize: true` call queued
 *  behind the aborted one starts a moment LATER with a fresh controller and
 *  would stream unaware through the whole drain deadline, then lose its
 *  writes at the sealed queue. Tracking the shutdown here lets `trackCall`
 *  hand such a late starter an already-aborted signal: in-flight calls finish
 *  writing, queued ones take their cancellation path on the first check.
 *  `endShutdownAbort` clears it, so a later app booting the same cell names
 *  in this process (every sequential test does) starts clean. */
const _shutdownCells: { app: AppScope; prefix: string }[] = [];

/** `prefix === ""` is "every cell of that app" (the unscoped sweep). */
function shuttingDown(prefix: string, app: AppScope): boolean {
  return _shutdownCells.some((s) =>
    (s.prefix === "" || s.prefix === prefix) && sameApp(s.app, app)
  );
}

function inflightEntry(
  prefix: string,
  method: string,
  app: AppScope,
): Inflight | undefined {
  const key = `${prefix}:${method}`;
  for (const e of _inflight) if (e.key === key && e.app === app) return e;
  return undefined;
}

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
  app: AppScope = "",
): void {
  const key = `${cellPrefix}:${method}`;
  const list = triggers === "self" ? ["self"] : triggers;
  for (const t of list) {
    const raw = typeof t === "string" ? t : t.type;
    const type = raw === "self" ? key : raw;
    let set = _triggers.get(type);
    if (!set) _triggers.set(type, set = new Set());
    // One edge per (app, method) — re-registering is idempotent.
    let dup = false;
    for (const e of set) if (e.key === key && e.app === app) dup = true;
    if (!dup) set.add({ app, key });
  }
}

/** Forget every cancel trigger a cell registered — what releasing the cell
 *  calls.
 *
 *  `registerCancelOn` runs on every compose and nothing ever undid it, so the
 *  registry only grew: an app that closed left its triggers behind, and the
 *  NEXT app in the same process (every sequential test, every dev restart, a
 *  second `testServer()`) inherited them. A cell named the same as a dead one
 *  had its methods aborted by an action it never listed, and a process that
 *  composes many short-lived cells grew one entry per name for its lifetime.
 *  Registration belongs to a binding, so it ends with the binding.
 *
 *  Scoped by cell prefix AND app: two apps in one process holding different
 *  defs with the same id release only their own. */
export function unregisterCancelOn(
  cellPrefix: string,
  app: AppScope = "",
): void {
  const prefix = `${cellPrefix}:`;
  for (const [type, set] of _triggers) {
    for (const t of set) {
      if (t.key.startsWith(prefix) && sameApp(t.app, app)) set.delete(t);
    }
    // A trigger whose last listener is gone is not a trigger any more; leaving
    // the empty Set behind would be the same unbounded growth one level down.
    if (set.size === 0) _triggers.delete(type);
  }
  for (const e of _inflight) {
    if (e.prefix === cellPrefix && sameApp(e.app, app)) _inflight.delete(e);
  }
}

/** @internal How many trigger→method edges the registry holds. Exists so the
 *  leak can be ASSERTED rather than argued about (tests/method-cancel). */
export function _cancelTriggerCount(): number {
  let n = 0;
  for (const set of _triggers.values()) n += set.size;
  return n;
}

/** Track an in-flight async method call. Returns an untrack fn. */
export function trackCall(
  cellPrefix: string,
  method: string,
  controller: AbortController,
  app: AppScope = "",
): () => void {
  if (shuttingDown(cellPrefix, app)) controller.abort();
  let entry = inflightEntry(cellPrefix, method, app);
  if (!entry) {
    entry = {
      app,
      prefix: cellPrefix,
      key: `${cellPrefix}:${method}`,
      set: new Set(),
    };
    _inflight.add(entry);
  }
  entry.set.add(controller);
  const mine = entry;
  return () => {
    mine.set.delete(controller);
    // Identity check: notifyMethodCancel DELETES the entry, so a later call
    // installs a NEW one under the same key. Without `_inflight.has(mine)`,
    // the older call settling afterwards deleted that newer entry — and the
    // newer call silently stopped being cancellable (cancelOn quietly stopped
    // working).
    if (mine.set.size === 0 && _inflight.has(mine)) _inflight.delete(mine);
  };
}

/** Abort every in-flight call whose method lists this action as a trigger.
 *  Called from the composed reduce for every dispatched action — with the
 *  dispatching app's identity, so app A's `cart.clear` never reaches app B's
 *  `checkout.place`. */
export function notifyMethodCancel(
  actionType: string,
  app: AppScope = "",
): void {
  const triggers = _triggers.get(actionType);
  if (!triggers) return;
  for (const t of triggers) {
    for (const e of _inflight) {
      if (e.key !== t.key) continue;
      // The trigger, the call and the dispatching action must all belong to
      // one app (or not know which) — app A's action never fires app B's
      // trigger, and never aborts app B's call through its own.
      const fires = sameApp(t.app, app) && sameApp(e.app, t.app) &&
        sameApp(e.app, app);
      if (!fires) continue;
      for (const c of e.set) c.abort();
      _inflight.delete(e);
    }
  }
}

/** Every async call that has not finished writing yet — the WHOLE chain, past
 *  the method body's own `.finally(untrack)` to its final write-set commit. The
 *  dispatch loop cannot see these: a cell's `execute` runs the method and
 *  returns nothing, so `dispatch.drain()` has never had anything to wait for.
 *  Shutdown does, which is why the registry is here. */
const _pending = new Map<
  Promise<unknown>,
  { prefix: string; app: AppScope }
>();

/** Track a whole async call — body, commit and all — under its cell's prefix
 *  and app, so a shutting-down app can wait for ITS calls and no one else's. */
export function trackPending(
  p: Promise<unknown>,
  cellPrefix = "",
  app: AppScope = "",
): void {
  _pending.set(p, { prefix: cellPrefix, app });
  const drop = () => _pending.delete(p);
  p.then(drop, drop);
}

/** How many async calls are still finishing. */
export function pendingCalls(): number {
  return _pending.size;
}

/** Framework-internal: the METHOD KEYS (`cell:method`) of every call still in
 *  flight, with how many of each.
 *
 *  A harness whose settle loop gives up has to say WHAT it was waiting for —
 *  "settle gave up" names no cause and no fix, and the pending PROMISES carry
 *  no label. `_inflight` is keyed by exactly the name a human wrote. */
export function _inflightMethodKeys(): string[] {
  const out: string[] = [];
  for (const e of _inflight) {
    out.push(e.set.size > 1 ? `${e.key} (×${e.set.size})` : e.key);
  }
  return out.sort();
}

/** Framework-internal: the pending method-call promises themselves. The
 *  testUI settle loop awaits these so "settled" includes a dispatch a method
 *  set in motion without awaiting it — HTML quiescence alone reads the gap
 *  between the outer and the nested call as done (a field report). */
export function _pendingCallPromises(): Promise<unknown>[] {
  return _pendingFor();
}

/** The pending calls belonging to `cells` of `app` (every call when `cells`
 *  is undefined and `app` is the wildcard — the process-wide view). */
function _pendingFor(
  cells?: Set<string>,
  app: AppScope = "",
): Promise<unknown>[] {
  const out: Promise<unknown>[] = [];
  for (const [p, { prefix, app: owner }] of _pending) {
    if (cells && !cells.has(prefix)) continue;
    if (!sameApp(owner, app)) continue;
    out.push(p);
  }
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
 *  `cells` scopes the wait to one app's cells, `app` to one app's identity.
 *  Two apps in one process are supported by design (D2: an instance-scoped
 *  runtime), and one of them shutting down must not sit on the other's work —
 *  or wait out its deadline for a call it does not own. */
export async function settlePending(
  timeoutMs: number,
  cells?: Set<string>,
  app: AppScope = "",
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let mine = _pendingFor(cells, app);
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
    mine = _pendingFor(cells, app);
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
 *  "Commit what it has" is true for NON-TRANSACTIONAL cells only, and that
 *  distinction is the point rather than a caveat: a `transaction: true` method
 *  commits atomically at the end, so an interrupted one commits NOTHING —
 *  which is the correct outcome, because half a transaction on disk is the
 *  state the transaction exists to prevent. Aborting still matters there: it
 *  ends the wait instead of holding the drain open for a reply that is not
 *  coming.
 *
 *  `cells` scopes it to one app's cells and `app` to one app's identity —
 *  omitting both aborts the whole process. Two apps can share a process (D2:
 *  an instance-scoped runtime, and every `testServer()` pair does it), so an
 *  unscoped abort would have one app's shutdown cancel another app's running
 *  methods mid-write. Cell bindings are already released this way
 *  (`_releaseCells`); cancellation is the same claim.
 *
 *  Returns how many calls were aborted, so the caller can say so in the log. */
export function abortAllInflight(
  cells?: Set<string>,
  app: AppScope = "",
): number {
  for (const c of cells ?? [""]) _shutdownCells.push({ app, prefix: c });
  let n = 0;
  for (const e of _inflight) {
    if (cells && !cells.has(e.prefix)) continue;
    if (!sameApp(e.app, app)) continue;
    for (const c of e.set) {
      if (!c.signal.aborted) {
        c.abort();
        n++;
      }
    }
    _inflight.delete(e);
  }
  return n;
}

/** Test isolation: forget all triggers and abort nothing. */
export function _resetMethodCancel(): void {
  _triggers.clear();
  _inflight.clear();
  _pending.clear();
  _shutdownCells.length = 0;
}

/** End the shutdown window opened by `abortAllInflight`: stop pre-aborting
 *  new calls for these cells. Called when the app's drain is over — a later
 *  app in the same process may legitimately reuse the names. */
export function endShutdownAbort(
  cells?: Set<string>,
  app: AppScope = "",
): void {
  for (let i = _shutdownCells.length - 1; i >= 0; i--) {
    const s = _shutdownCells[i]!;
    if (cells && s.prefix !== "" && !cells.has(s.prefix)) continue;
    if (!sameApp(s.app, app)) continue;
    _shutdownCells.splice(i, 1);
  }
}
