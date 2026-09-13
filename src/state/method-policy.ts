/**
 * @module
 * `concurrency:` and `ttl:` — what happens when the same async method is
 * called again while it is still running.
 *
 * One field report had THREE different hand-written answers to that one
 * question in a single app, and the comment on one of them records that the
 * original first-wins guard was itself a bug (report 8 §15). It is a
 * policy, not a feature: every app needs an answer, most apps need two or
 * three different ones, and none of them should be writing the plumbing.
 *
 *   "newest"  the new call wins, the running one aborts. Already spelled
 *             `cancelOn: { m: "self" }` — `concurrency` registers exactly that,
 *             so there is ONE mechanism and not two that can disagree.
 *   "first"   the running call wins; the new caller ADOPTS its result rather
 *             than getting `undefined`. A first-wins guard that resolves the
 *             second caller with nothing is the bug that report shipped.
 *   "queue"   the new call waits for the running one, then runs.
 *
 * `ttl` is the other half of the same question: within N ms of a call that
 * SUCCEEDED, an identical call returns the previous value without running.
 * Keyed by the ARGUMENTS as well as the method — `fetchUser(1)` and
 * `fetchUser(2)` sharing one cache entry would be a data bug, not a cache.
 */

/** How a second call behaves while the first is still running. */
export type ConcurrencyMode = "first" | "newest" | "queue";

/** What a settled call produced. */
export type CallOutcome = { value?: unknown; error?: unknown };

type Inflight = {
  promise: Promise<CallOutcome>;
  settle: (o: CallOutcome) => void;
};

/** The bookkeeping `first`, `ttl` and `queue` keep — ONE PER CELL.
 *
 *  It was three process-wide maps keyed `cell:method`, and a process can hold
 *  two apps with a cell of the same name (library mode, `testApps`, a service
 *  and its rich client). App B's `users.fetchUser(1)` was answered from app
 *  A's ttl cache — B's method never ran and B was told `A-user-1` — and a
 *  running `scan` in A answered B's. A cell binds to exactly one app (D2
 *  exclusivity), so a store owned by the cell's executor is owned by exactly
 *  one app, with no app id to thread or to get wrong. */
export type PolicyStore = {
  /** `resetMethodPolicy()` generation this store was last cleared in. */
  gen: number;
  inflight: Map<string, Inflight>;
  cache: Map<string, { at: number; value: unknown; ttl: number }>;
  queueTail: Map<string, Promise<unknown>>;
};

/** A new, empty store — one per cell executor. @internal */
export function createPolicyStore(): PolicyStore {
  return {
    gen: _gen,
    inflight: new Map(),
    cache: new Map(),
    queueTail: new Map(),
  };
}

/** Bumped by `resetMethodPolicy()`. Stores are cleared when next touched
 *  rather than tracked in a registry, which would keep every cell ever
 *  created — and every result it cached — alive for the life of the process. */
let _gen = 0;

/** The store for callers that name none (unit tests of the policy itself). */
const _defaultStore: PolicyStore = createPolicyStore();

function current(store: PolicyStore): PolicyStore {
  if (store.gen !== _gen) {
    store.inflight.clear();
    store.cache.clear();
    store.queueTail.clear();
    store.gen = _gen;
  }
  return store;
}

/** How many cached results one cell keeps. `ttl: { fetchUser: 60_000 }` on
 *  a per-id method is the DOCUMENTED use, so every distinct argument used to
 *  cost memory for the life of the process — measured, 5,000 distinct calls
 *  left 5,000 entries, and 5,000 more after they had all expired left 10,000.
 *  Nothing evicted: `resetMethodPolicy()` is called only by test harnesses,
 *  never by a shutdown or any production path. */
const CACHE_MAX = 5_000;

/** Drop what is EXPIRED, and then the oldest, until the cache is under its
 *  ceiling. Called on write, so the work is proportional to the writes that
 *  caused the growth. */
function _sweepCache(cache: PolicyStore["cache"]): void {
  if (cache.size <= CACHE_MAX) return;
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.at >= v.ttl) cache.delete(k);
  }
  if (cache.size <= CACHE_MAX) return;
  // Still over: insertion order IS age order (a re-set deletes and re-adds
  // through `set`? it does not — so re-freshening an entry keeps its
  // position, which only makes this evict something slightly older. Good
  // enough for a ceiling; an LRU here would be a second decider for "what is
  // stale", and the ttl is the first).
  const drop = cache.size - CACHE_MAX;
  let n = 0;
  for (const k of cache.keys()) {
    if (n++ >= drop) break;
    cache.delete(k);
  }
}

/** Stable key for one call's arguments.
 *
 *  A key exists only for arguments that are PLAIN DATA — primitives, arrays
 *  and plain objects — because that is the only domain on which "the JSON is
 *  the same" means "the call is the same". Anything else produces NO key, and
 *  a call with no key is never cached and never deduped — it just runs.
 *  Silently treating two different calls as the same one is the failure mode
 *  a cache must not have; running a call the cache could have answered costs
 *  one call.
 *
 *  `JSON.stringify` alone answered many different calls with one key, which
 *  is why the domain is checked first rather than trusted to the serializer:
 *
 *    `new Set([1,2])`, `new Set([3])`, `new Map()`  → all `{}`
 *    `NaN`, `Infinity`, `null`                      → all `null`
 *    `-0`, `0`                                      → both `0`
 *    `{ pick: () => "alice" }`, `{ pick: () => "bob" }` → both `{}`
 *    a class instance                               → its own fields only
 *    `[ , 1]` (a hole), `[null, 1]`                 → both `[null,1]`
 *
 *  `ttl` handed `lookup(new Set([3]))` the answer computed for
 *  `lookup(new Set([1,2]))`, and `concurrency: "first"` answered a running
 *  `scan(new Set(["/b"]))` with `scan:/a`. */
const UNDEF = "\u0000aio:undefined";

/** Whether `v` is inside the domain `argsKey` can key faithfully. */
function isKeyableData(v: unknown, stack: Set<object>): boolean {
  switch (typeof v) {
    case "boolean":
      return true;
    case "undefined":
      return true;
    case "string":
      // The marker below must not be forgeable by an argument that spells it.
      return !v.startsWith("\u0000aio:");
    case "number":
      // NaN/±Infinity serialize as `null`, and `-0` as `0`: no key, not a
      // shared one.
      return Number.isFinite(v) && !Object.is(v, -0);
    case "object": {
      if (v === null) return true;
      // A cycle has no finite key; a value reached twice WITHOUT a cycle is
      // fine, so the set is a stack, not a visited-ever set.
      if (stack.has(v)) return false;
      const proto = Object.getPrototypeOf(v);
      const isArr = Array.isArray(v);
      if (
        isArr
          ? proto !== Array.prototype
          : proto !== Object.prototype && proto !== null
      ) {
        return false; // Set, Map, Date, a class instance, a typed array, …
      }
      if (Object.getOwnPropertySymbols(v).length > 0) return false;
      const keys = Object.keys(v);
      // A hole serializes as `null`, and an extra named property on an array
      // not at all — either way a different array with the same JSON.
      if (isArr && keys.length !== (v as unknown[]).length) return false;
      stack.add(v);
      try {
        for (const k of keys) {
          if (!isKeyableData((v as Record<string, unknown>)[k], stack)) {
            return false;
          }
        }
      } finally {
        stack.delete(v);
      }
      return true;
    }
    default:
      return false; // function, symbol, bigint
  }
}

export function argsKey(args: readonly unknown[]): string | null {
  try {
    if (!isKeyableData(args as unknown[], new Set())) return null;
    // `undefined` MARKED, because `JSON.stringify` erases it two different
    // ways: an array element becomes `null`, and an object property with an
    // undefined value disappears entirely. So `m(undefined)` answered
    // `m(null)`, and `m({a:1, b:undefined})` answered `m({a:1})`.
    const s = JSON.stringify(args, (_k, v) => v === undefined ? UNDEF : v);
    return typeof s === "string" ? s : null;
  } catch {
    return null; // aio-ok: a throwing getter means "do not cache"
  }
}

/** Whether `structuredClone` copies `v` WITHOUT changing it: primitives,
 *  arrays, plain objects, and the built-ins it reproduces exactly. A class
 *  instance comes back a plain object with its prototype gone and a function
 *  does not come back at all, so either one anywhere makes the answer no. */
function clonesFaithfully(v: unknown, stack: Set<object>): boolean {
  if (typeof v === "function" || typeof v === "symbol") return false;
  if (v === null || typeof v !== "object") return true;
  if (stack.has(v)) return true; // structuredClone keeps cycles and sharing
  if (
    v instanceof Date || v instanceof RegExp || v instanceof ArrayBuffer ||
    ArrayBuffer.isView(v)
  ) {
    return true;
  }
  stack.add(v);
  try {
    if (v instanceof Map) {
      for (const [k, x] of v) {
        if (!clonesFaithfully(k, stack) || !clonesFaithfully(x, stack)) {
          return false;
        }
      }
      return Object.getPrototypeOf(v) === Map.prototype;
    }
    if (v instanceof Set) {
      for (const x of v) if (!clonesFaithfully(x, stack)) return false;
      return Object.getPrototypeOf(v) === Set.prototype;
    }
    const proto = Object.getPrototypeOf(v);
    if (
      Array.isArray(v)
        ? proto !== Array.prototype
        : proto !== Object.prototype && proto !== null
    ) {
      return false;
    }
    if (Object.getOwnPropertySymbols(v).length > 0) return false;
    for (const k of Object.keys(v)) {
      // Through the DESCRIPTOR, never a read: a getter is flattened into a
      // value by structuredClone (not faithful), and reading it here and again
      // in the clone ran it twice — a result whose getter may run once was
      // turned into a rejection of the call that produced it.
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d || !("value" in d) || !clonesFaithfully(d.value, stack)) {
        return false;
      }
    }
    return true;
  } finally {
    stack.delete(v);
  }
}

/** A private copy of a result that more than one caller receives.
 *
 *  `ttl` and `"first"` hand ONE computed value to many callers, and each of
 *  them owns what its `await` returned the way it owns any other method result
 *  — so it must be a copy, or the first caller's `user.roles.push("admin")`
 *  is what every later caller within the ttl is told the server said. Plain
 *  data is copied. A value `structuredClone` would CHANGE (a class instance, a
 *  function — a client handle is the classic ttl'd return) is handed over by
 *  reference, as it always was: a copy that silently lost its methods would be
 *  a different value, and a shared handle is usually the point. */
function privateCopy(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  try {
    return clonesFaithfully(v, new Set()) ? structuredClone(v) : v;
  } catch {
    // aio-ok: a value the check cannot see into — a Proxy looks like a plain
    // object from outside and structuredClone refuses it; a revoked one throws
    // at the first look — is handed over by reference, like any other value
    // a copy would change. This runs inside a call that SUCCEEDED: a throw
    // here rejected `ttl`'s own caller, and crashed the process from a
    // `"first"` adopter's chain.
    return v;
  }
}

/** What the executor should do with this call. */
export type PolicyDecision =
  /** Run it. `settle` records the outcome for `first` / `ttl`. */
  | { kind: "run"; settle: (o: CallOutcome) => void }
  /** Run it AFTER `after`. `settle` as above. */
  | { kind: "queue"; after: Promise<unknown>; settle: (o: CallOutcome) => void }
  /** Do not run: adopt this outcome instead (a `first` dedup or a `ttl` hit). */
  | { kind: "adopt"; outcome: Promise<CallOutcome>; why: "first" | "ttl" };

/** Decide, and register this call's in-flight entry when it is going to run. */
export function beginPolicyCall(
  prefix: string,
  method: string,
  args: readonly unknown[],
  mode: ConcurrencyMode | undefined,
  ttlMs: number | undefined,
  store: PolicyStore = _defaultStore,
): PolicyDecision {
  const { inflight, cache, queueTail } = current(store);
  const key = `${prefix}:${method}`;
  const ak = argsKey(args);
  const cacheKey = ak === null ? null : `${key}|${ak}`;

  // TTL first: a fresh result answers whatever the concurrency mode is, and
  // checking it second would start a call the cache was there to avoid.
  if (ttlMs !== undefined && cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttlMs) {
      return {
        kind: "adopt",
        outcome: Promise.resolve({ value: privateCopy(hit.value) }),
        why: "ttl",
      };
    }
  }

  // `first`: dedup against the RUNNING call, keyed by args like the cache —
  // `scan("/a")` must not be answered by a running `scan("/b")`. A call with
  // NO key is not deduped at all. It used to fall back to the method name, so
  // every keyless call adopted whatever call of that method was running:
  // `scan(new Set(["/b"]))` resolved `scan:/a`.
  const inflightKey = cacheKey;
  if (mode === "first" && inflightKey !== null) {
    const running = inflight.get(inflightKey);
    if (running) {
      return {
        kind: "adopt",
        // Each adopter gets its own copy — see `privateCopy`.
        outcome: running.promise.then((o) =>
          o.error === undefined ? { value: privateCopy(o.value) } : o
        ),
        why: "first",
      };
    }
  }

  let settleFn: (o: CallOutcome) => void = () => {};
  const promise = new Promise<CallOutcome>((res) => {
    settleFn = res;
  });
  const entry: Inflight = { promise, settle: settleFn };
  if (inflightKey !== null) inflight.set(inflightKey, entry);

  const settle = (o: CallOutcome) => {
    // Only the entry THIS call registered — a later call that replaced it owns
    // the slot now, and clearing it would strand that one's adopters.
    if (inflightKey !== null && inflight.get(inflightKey) === entry) {
      inflight.delete(inflightKey);
    }
    if (ttlMs !== undefined && cacheKey && o.error === undefined) {
      // Successes only. Caching a failure would make one bad minute last for
      // the whole ttl, which is the opposite of what a ttl is for.
      // A copy, taken NOW: the caller that ran is handed the original, and
      // what it does to that must not become every later hit's answer.
      cache.set(cacheKey, {
        at: Date.now(),
        value: privateCopy(o.value),
        ttl: ttlMs,
      });
      _sweepCache(cache);
    }
    entry.settle(o);
  };

  if (mode === "queue") {
    const after = queueTail.get(key) ?? Promise.resolve();
    // The tail is per METHOD, not per arguments: "queue" means this method
    // runs one at a time, and a per-argument tail would let two different
    // arguments interleave — which is the thing being asked for the opposite
    // of.
    return { kind: "queue", after, settle };
  }
  return { kind: "run", settle };
}

/** Record the new tail for a queued method. */
export function setQueueTail(
  prefix: string,
  method: string,
  tail: Promise<unknown>,
  store: PolicyStore = _defaultStore,
): void {
  current(store).queueTail.set(`${prefix}:${method}`, tail);
}

/** Clear everything, in every cell's store — teardown, and between tests. */
export function resetMethodPolicy(): void {
  _gen++;
  current(_defaultStore);
}

/** @internal tests — how many entries are live. */
// aio-ok: test seam — tests/method-policy.test.ts asserts the maps do not leak
export function _policySizes(
  store: PolicyStore = _defaultStore,
): { inflight: number; cache: number } {
  const { inflight, cache } = current(store);
  return { inflight: inflight.size, cache: cache.size };
}
