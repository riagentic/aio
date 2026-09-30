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
  /** The caller that started it, and what of that caller its run has read
   *  (`serverUser()`, `serverRequest()` fields). */
  who: CallerSnapshot;
  reads: ReadonlySet<string>;
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
  /** Per `cell:method`, every caller fact any run of it has read — from then
   *  on keyed on those from the start, so `"first"` never waits on a run it
   *  would only have to rerun. */
  reads: Map<string, Set<string>>;
};

/** A new, empty store — one per cell executor. @internal */
export function createPolicyStore(): PolicyStore {
  return {
    gen: _gen,
    inflight: new Map(),
    cache: new Map(),
    queueTail: new Map(),
    reads: new Map(),
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
    store.reads.clear();
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

/** Whether `v` is inside the domain `argsKey` can key faithfully.
 *
 *  `toJSON` widens it for a KEY built from a value (see {@linkcode
 *  isJsonKeyable}): an object JSON will replace via `toJSON` before the
 *  replacer sees it (a `Date`, a class with a `toJSON`) is keyed by that
 *  replacement, so it does not collide. It is OFF for a call's arguments,
 *  where the receiver gets the replacement rather than the value. */
function isKeyableData(
  v: unknown,
  stack: Set<object>,
  toJSON = false,
): boolean {
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
        // Set, Map, RegExp, a typed array, or a class instance: none is
        // faithfully described by its enumerable own keys. A `toJSON` DOES
        // describe the value the JSON carries — but only if the REPLACEMENT is
        // itself faithfully keyable. Answering true for "has a toJSON" was
        // wrong when that method returns a `Map`/`Set`/`RegExp`/typed array (or
        // `undefined`): JSON then carries an unfaithful replacement, and two
        // DIFFERENT records collided on `"{}"` — the very aliasing this
        // widening was meant to prevent.
        if (!toJSON) return false;
        const tj = (v as { toJSON?: unknown }).toJSON;
        if (typeof tj !== "function") return false;
        stack.add(v);
        let replaced: unknown;
        try {
          replaced = (tj as () => unknown).call(v);
        } catch {
          return false; // a throwing toJSON is no key (JSON.stringify throws too)
        } finally {
          stack.delete(v);
        }
        if (replaced === undefined) return false; // JSON drops it: no identity
        return isKeyableData(replaced, stack, true);
      }
      if (Object.getOwnPropertySymbols(v).length > 0) return false;
      const keys = Object.keys(v);
      // A hole serializes as `null`, and an extra named property on an array
      // not at all — either way a different array with the same JSON.
      if (isArr && keys.length !== (v as unknown[]).length) return false;
      stack.add(v);
      try {
        for (const k of keys) {
          if (
            !isKeyableData((v as Record<string, unknown>)[k], stack, toJSON)
          ) {
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

/** Whether `v`'s JSON is a faithful KEY for it — the domain a cache keyed on a
 *  VALUE needs (e.g. `userMemoKey`, which keyed a `Map`/`Set`/class field to
 *  `{}` and so aliased two different callers into one slot; and the `ttl` /
 *  `"first"` caller cache that shares the key).
 *
 *  Same walk as {@linkcode argsKey}'s, plus: an object JSON replaces via
 *  `toJSON` is keyed by that replacement, so a `Date` field in a user record
 *  remains keyed instead of silently disabling the cache. `false` means
 *  "produce no key and recompute", never "guess". @internal */
export function isJsonKeyable(v: unknown): boolean {
  return isKeyableData(v, new Set(), true);
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
  | {
    kind: "run";
    settle: (o: CallOutcome) => void;
    /** Run the call inside this — it learns whether the run read the caller. */
    track: <T>(fn: () => T) => T;
  }
  /** Run it AFTER `after` — or NOW when `after` is undefined (nothing of
   *  this method is queued or running). `settle` as above. */
  | {
    kind: "queue";
    after: Promise<unknown> | undefined;
    settle: (o: CallOutcome) => void;
    track: <T>(fn: () => T) => T;
  }
  /** Do not run: adopt this outcome instead (a `first` dedup or a `ttl` hit).
   *  `rerun`: the adopted run turned out to answer ANOTHER caller (it read
   *  `serverUser()`) — run this call after all. */
  | {
    kind: "adopt";
    outcome: Promise<CallOutcome & { rerun?: true }>;
    why: "first" | "ttl";
  };

/** One caller fact (`"user"`, `"ip"`, `"h:<header>"`, `"c:<cookie>"`, …) as
 *  a key, or null when it cannot be keyed. */
export type CallerSnapshot = (fact: string) => string | null;

/** Who is calling, and what of it a run read.
 *
 *  A method may answer from `serverUser()` or from `serverRequest()` (a
 *  cookie, a header), so one shared `ttl` answer or `"first"` adoption across
 *  two callers handed Alice's `myOrders()` to Bob. Keying EVERY call per
 *  caller closed that and broke the other half: a ttl as a shared upstream
 *  shield, `"first"` as a global single-flight. So a result is keyed on
 *  exactly the caller facts the run that produced it READ: `track` runs a call
 *  with a set that `serverUser()` and every field read of `serverRequest()`
 *  add to (and that of every call it runs inside). A run that reads the
 *  `session` cookie is shared by every request carrying that cookie, and by no
 *  other; one that reads nothing stays everyone's. Installed by the server
 *  runtime, which owns the ambient caller; with none (browser, standalone)
 *  there is one caller and no run can read it. */
export type CallerScope = {
  /** The calling context as it is NOW, to key facts on later. */
  snapshot: () => CallerSnapshot;
  track: <T>(reads: Set<string>, fn: () => T) => T;
  /** The running calls' read scope as it is NOW, to re-enter later — or
   *  undefined when no `ttl`/`"first"` call is running. */
  capture: () => Reenter | undefined;
};
/** Run `fn` inside a captured read scope. */
export type Reenter = <T>(fn: () => T) => T;
let _caller: CallerScope = {
  snapshot: () => () => "",
  track: (_r, fn) => fn(),
  capture: () => undefined,
};

/** The read scope of the calls running at the point a method is CALLED, for
 *  the dispatch loop to run that method's reduce and body in. A call made
 *  from inside a running method is queued and run by the loop that is already
 *  draining — outside the caller's scope — so a ttl'd `greet()` that awaited
 *  `profile.name()` never learned that `name()` read the caller's cookie.
 *  @internal */
export const _captureCaller = (): Reenter | undefined => _caller.capture();

/** @internal installed by `src/server/auth-context.ts`. */
export function _installCallerScope(scope: CallerScope): void {
  _caller = scope;
}

/** A snapshot that computes each fact at most once. */
function memoSnapshot(at: CallerSnapshot): CallerSnapshot {
  const seen = new Map<string, string | null>();
  return (f) => {
    if (!seen.has(f)) seen.set(f, at(f));
    return seen.get(f) ?? null;
  };
}

/** Decide, and register this call's in-flight entry when it is going to run. */
export function beginPolicyCall(
  prefix: string,
  method: string,
  args: readonly unknown[],
  mode: ConcurrencyMode | undefined,
  ttlMs: number | undefined,
  store: PolicyStore = _defaultStore,
): PolicyDecision {
  const { inflight, cache, queueTail, reads } = current(store);
  const key = `${prefix}:${method}`;
  const ak = argsKey(args);
  const who = memoSnapshot(_caller.snapshot());
  // A result from a run that read no caller fact is everyone's; one from a
  // run that did is shared only by callers equal on every fact it read (null:
  // an unkeyable fact shares nothing). The facts go BEFORE the args, and `ak`
  // is one JSON value, so no argument can spell another key.
  const sharedKey = ak === null ? null : `${key}|${ak}`;
  const keyOn = (facts: ReadonlySet<string> | undefined): string | null => {
    if (ak === null || !facts || facts.size === 0) return sharedKey;
    const pairs: [string, string][] = [];
    for (const f of [...facts].sort()) {
      const v = who(f);
      if (v === null) return null;
      pairs.push([f, v]);
    }
    return `${key}|${JSON.stringify(pairs)}|${ak}`;
  };
  const callerKey = keyOn(reads.get(key));

  // TTL first: a fresh result answers whatever the concurrency mode is, and
  // checking it second would start a call the cache was there to avoid.
  if (ttlMs !== undefined) {
    for (const k of new Set([sharedKey, callerKey])) {
      const hit = k === null ? undefined : cache.get(k);
      if (hit && Date.now() - hit.at < ttlMs) {
        return {
          kind: "adopt",
          outcome: Promise.resolve({ value: privateCopy(hit.value) }),
          why: "ttl",
        };
      }
    }
  }

  // `first`: dedup against the RUNNING call, keyed by args like the cache —
  // `scan("/a")` must not be answered by a running `scan("/b")`. A call with
  // NO key is not deduped at all. It used to fall back to the method name, so
  // every keyless call adopted whatever call of that method was running:
  // `scan(new Set(["/b"]))` resolved `scan:/a`.
  //
  // Whether a running call answers only its own caller is known when it ENDS,
  // so a method not yet seen reading the caller dedups on the shared key, and
  // an adopter whose runner turned out to read ANOTHER caller runs itself.
  const inflightKey = callerKey;
  if (mode === "first" && inflightKey !== null) {
    const running = inflight.get(inflightKey);
    if (running) {
      return {
        kind: "adopt",
        // Each adopter gets its own copy — see `privateCopy`.
        outcome: running.promise.then((o) =>
          [...running.reads].some((f) => {
              const v = who(f);
              return v === null || v !== running.who(f);
            })
            ? { rerun: true as const }
            : o.error === undefined
            ? { value: privateCopy(o.value) }
            : o
        ),
        why: "first",
      };
    }
  }

  let settleFn: (o: CallOutcome) => void = () => {};
  const promise = new Promise<CallOutcome>((res) => {
    settleFn = res;
  });
  const mark = new Set<string>();
  const entry: Inflight = { promise, settle: settleFn, who, reads: mark };
  if (inflightKey !== null) inflight.set(inflightKey, entry);
  const track = <T>(fn: () => T): T =>
    mode === "first" || ttlMs !== undefined ? _caller.track(mark, fn) : fn();

  const settle = (o: CallOutcome) => {
    // Only the entry THIS call registered — a later call that replaced it owns
    // the slot now, and clearing it would strand that one's adopters.
    if (inflightKey !== null && inflight.get(inflightKey) === entry) {
      inflight.delete(inflightKey);
    }
    let facts = reads.get(key);
    if (mark.size > 0) {
      if (!facts) reads.set(key, facts = new Set());
      for (const f of mark) facts.add(f);
    }
    // Keyed on EVERY fact this method is known to read, not only this run's:
    // the lookup above can only ask with that set.
    const cacheKey = mark.size > 0 ? keyOn(facts) : sharedKey;
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
    // No tail = nothing of this method is queued or running: it runs NOW, in
    // call order. An empty tail used to be `Promise.resolve()`, and chaining
    // on it still deferred the start a microtask — so `const p = c.read();
    // await c.set("b")` ran the SET first and the queued read saw "b", where
    // every other concurrency mode saw "a" (field report (a desktop map app) §2).
    const after = queueTail.get(key);
    // The tail is per METHOD, not per arguments: "queue" means this method
    // runs one at a time, and a per-argument tail would let two different
    // arguments interleave — which is the thing being asked for the opposite
    // of.
    return { kind: "queue", after, settle, track };
  }
  return { kind: "run", settle, track };
}

/** Record the new tail for a queued method. */
export function setQueueTail(
  prefix: string,
  method: string,
  tail: Promise<unknown>,
  store: PolicyStore = _defaultStore,
): void {
  const queueTail = current(store).queueTail;
  const key = `${prefix}:${method}`;
  queueTail.set(key, tail);
  // Settled and still the tail → the queue is empty again, so the next call
  // runs at once (see `decide`). Both outcomes: a failed call frees it too.
  const clear = () => {
    if (queueTail.get(key) === tail) queueTail.delete(key);
  };
  tail.then(clear, clear);
}

/** The queued call whose tail is `tail` has its outcome: if nothing queued
 *  behind it, the queue is empty now and the next call runs at once. */
export function releaseQueueTail(
  prefix: string,
  method: string,
  tail: Promise<unknown>,
  store: PolicyStore = _defaultStore,
): void {
  const queueTail = current(store).queueTail;
  const key = `${prefix}:${method}`;
  if (queueTail.get(key) === tail) queueTail.delete(key);
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
