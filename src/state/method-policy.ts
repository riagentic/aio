/**
 * @module
 * `concurrency:` and `ttl:` — what happens when the same async method is
 * called again while it is still running.
 *
 * One field report had THREE different hand-written answers to that one
 * question in a single app, and the comment on one of them records that the
 * original first-wins guard was itself a bug (llama.master §15). It is a
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

const _inflight = new Map<string, Inflight>();
const _cache = new Map<string, { at: number; value: unknown }>();
const _queueTail = new Map<string, Promise<unknown>>();

/** Stable key for one call's arguments.
 *
 *  `JSON.stringify` on purpose, and its limits are the point: an argument it
 *  cannot serialize (a function, a cycle) produces NO key, and a call with no
 *  key is never cached and never deduped — it just runs. Silently treating two
 *  different calls as the same one is the failure mode a cache must not have. */
export function argsKey(args: readonly unknown[]): string | null {
  // A function or a symbol INSIDE AN ARRAY serializes as `null`, not as
  // `undefined` — so `scan(fnA)` and `scan(fnB)` would both key on `[null]`
  // and answer each other. That is the data bug a cache must not have, and
  // `JSON.stringify` alone does not catch it: only a top-level function
  // returns undefined, and these are never top level.
  for (const a of args) {
    if (typeof a === "function" || typeof a === "symbol") return null;
  }
  try {
    const s = JSON.stringify(args);
    return typeof s === "string" ? s : null;
  } catch {
    return null; // aio-ok: a cycle or a BigInt means "do not cache"
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
): PolicyDecision {
  const key = `${prefix}:${method}`;
  const ak = argsKey(args);
  const cacheKey = ak === null ? null : `${key}|${ak}`;

  // TTL first: a fresh result answers whatever the concurrency mode is, and
  // checking it second would start a call the cache was there to avoid.
  if (ttlMs !== undefined && cacheKey) {
    const hit = _cache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttlMs) {
      return {
        kind: "adopt",
        outcome: Promise.resolve({ value: hit.value }),
        why: "ttl",
      };
    }
  }

  // `first`: dedup against the RUNNING call, keyed by args like the cache —
  // `scan("/a")` must not be answered by a running `scan("/b")`.
  const inflightKey = cacheKey ?? key;
  if (mode === "first") {
    const running = _inflight.get(inflightKey);
    if (running) {
      return { kind: "adopt", outcome: running.promise, why: "first" };
    }
  }

  let settleFn: (o: CallOutcome) => void = () => {};
  const promise = new Promise<CallOutcome>((res) => {
    settleFn = res;
  });
  const entry: Inflight = { promise, settle: settleFn };
  _inflight.set(inflightKey, entry);

  const settle = (o: CallOutcome) => {
    // Only the entry THIS call registered — a later call that replaced it owns
    // the slot now, and clearing it would strand that one's adopters.
    if (_inflight.get(inflightKey) === entry) _inflight.delete(inflightKey);
    if (ttlMs !== undefined && cacheKey && o.error === undefined) {
      // Successes only. Caching a failure would make one bad minute last for
      // the whole ttl, which is the opposite of what a ttl is for.
      _cache.set(cacheKey, { at: Date.now(), value: o.value });
    }
    entry.settle(o);
  };

  if (mode === "queue") {
    const after = _queueTail.get(key) ?? Promise.resolve();
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
): void {
  _queueTail.set(`${prefix}:${method}`, tail);
}

/** Clear everything — teardown, and between tests. */
export function resetMethodPolicy(): void {
  _inflight.clear();
  _cache.clear();
  _queueTail.clear();
}

/** @internal tests — how many entries are live. */
// aio-ok: test seam — tests/method-policy.test.ts asserts the maps do not leak
export function _policySizes(): { inflight: number; cache: number } {
  return { inflight: _inflight.size, cache: _cache.size };
}
