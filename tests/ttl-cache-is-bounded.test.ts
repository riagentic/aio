// A `ttl:` cache must not grow forever, and must not answer one call with
// another's result.
//
// `ttl: { fetchUser: 60_000 }` on a per-user or per-id method is the
// DOCUMENTED use, so every distinct argument cost memory for the life of the
// process. Nothing ever evicted: `resetMethodPolicy()` is called only by test
// harnesses, never by a shutdown or any production path. Measured — 5,000
// distinct calls left 5,000 entries, and 5,000 more after all of the first
// batch had EXPIRED left 10,000.
//
// And `argsKey` had the collision its own doc forbids. `JSON.stringify`
// erases `undefined` two different ways — an array element becomes `null`, an
// object property disappears — so `m(undefined)` was answered by `m(null)`,
// and `m({a:1, b:undefined})` by `m({a:1})`. The function-and-symbol guard
// right above it exists to stop exactly this ("`fetchUser(1)` and
// `fetchUser(2)` sharing one cache entry would be a data bug") and did not
// cover these cases.
import { assert, assertEquals } from "@std/assert";
import {
  _policySizes,
  argsKey,
  beginPolicyCall,
  resetMethodPolicy,
} from "../src/state/method-policy.ts";

Deno.test("ttl cache: expired entries are evicted, and it has a ceiling", async () => {
  resetMethodPolicy();
  try {
    const call = (i: number, ttl: number) => {
      const d = beginPolicyCall("cellx", "fetch", [i], undefined, ttl);
      if (d.kind !== "adopt") d.settle({ value: `v${i}` });
    };
    for (let i = 0; i < 6000; i++) call(i, 1);
    const first = _policySizes().cache;
    assert(
      first <= 5000,
      `the cache must have a ceiling — it held ${first} after 6,000 calls`,
    );

    // Let them all expire, then fill again.
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 6000; i < 12000; i++) call(i, 1);
    const second = _policySizes().cache;
    assert(
      second <= 5000,
      `expired entries must not accumulate — ${second} after 12,000 calls`,
    );
  } finally {
    resetMethodPolicy();
  }
});

Deno.test("ttl cache: a cached result still answers the call that made it", () => {
  // The control — a cache that evicted everything would pass the test above
  // and delete the feature.
  resetMethodPolicy();
  try {
    const first = beginPolicyCall("cellx", "fetch", [7], undefined, 60_000);
    assertEquals(first.kind, "run");
    if (first.kind === "run") first.settle({ value: "seven" });

    const again = beginPolicyCall("cellx", "fetch", [7], undefined, 60_000);
    assertEquals(again.kind, "adopt", "a fresh result must be reused");
  } finally {
    resetMethodPolicy();
  }
});

Deno.test("argsKey: undefined is not the same call as null, or as absent", () => {
  const k = (args: unknown[]) => argsKey(args);
  assert(k([undefined]) !== k([null]), "m(undefined) vs m(null)");
  assert(
    k([{ a: 1, b: undefined }]) !== k([{ a: 1 }]),
    "m({a:1,b:undefined}) vs m({a:1})",
  );
  // …and the ordinary case still keys the way it always did — a marker that
  // leaked into keys carrying no `undefined` would invalidate every cache
  // entry a running app already holds.
  assertEquals(k([1, "x"]), '[1,"x"]');
  assert(
    k([1]) !== k([2]),
    "fetchUser(1) and fetchUser(2) are different calls",
  );
  // A function still refuses to be cached at all.
  assertEquals(k([() => {}]), null);
});

Deno.test("ttl cache: m(undefined) is not answered by m(null)", () => {
  resetMethodPolicy();
  try {
    const a = beginPolicyCall("cellx", "m", [undefined], undefined, 60_000);
    if (a.kind === "run") a.settle({ value: "ran-with-undefined" });
    const b = beginPolicyCall("cellx", "m", [null], undefined, 60_000);
    assertEquals(
      b.kind,
      "run",
      "a different argument is a different call — adopting here hands one " +
        "caller another's answer",
    );
  } finally {
    resetMethodPolicy();
  }
});
