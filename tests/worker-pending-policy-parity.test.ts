// `cell.$pending(m)` must read the same for a `worker: true` cell as for the
// same cell on the main isolate (dev == prod == worker).
//
// For a worker cell the executor runs in the other isolate, so the pool counts
// each call on main around the thread hop. It counted EVERY call — including a
// `concurrency: "first"` caller that only adopts the running call's result and
// a `ttl` cache hit that never runs at all. The main-isolate executor counts
// neither (`trackCall` runs only for a call that runs). So two overlapping
// `scan("a")` read 2 against a real worker and 1 in process, and a cached
// `get("k")` read 1 instead of 0.
//
// Differential: the same call sequence against the in-isolate harness and a
// real worker; every reading must agree. Readings are taken after a timer
// tick: the worker reports an adopted call one thread hop after the call is
// posted, and a read in the same synchronous turn as the call still sees it.
import { assert, assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { wpp } from "./fixtures/worker-pending-policy-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-pending-policy-app.ts");

type W = {
  scan: (k: string) => Promise<string>;
  get: (k: string) => Promise<string>;
  runs: number;
  $pending: (m?: string) => number;
};
const C = wpp as unknown as W;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readings(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  // `first`: two overlapping identical calls — one runs, one adopts.
  const a = C.scan("a");
  const b = C.scan("a");
  await tick(30);
  out.firstShared = C.$pending("scan");
  const c = C.scan("b"); // different args — a second RUNNING call
  await tick(10);
  out.firstDistinct = C.$pending("scan");
  // The shared pair settles while "b" still runs: exactly one left. (An
  // adopter released twice — once when adopted, again when its outcome
  // lands — took "b" off the count while it was still running.)
  const pair = await Promise.all([a, b]);
  await tick(5);
  out.pairDone = C.$pending("scan");
  out.scanResults = [...pair, await c];
  await tick(10);
  out.scanAfter = C.$pending("scan");
  // `ttl`: the first call runs, a repeat within the ttl is a cache hit.
  out.getMiss = await C.get("k");
  const hit = C.get("k");
  await tick(1);
  out.ttlHitTick = C.$pending("get");
  await tick(20);
  out.ttlHit = C.$pending("get");
  out.getHit = await hit;
  out.getAfter = C.$pending("get");
  out.cellWide = C.$pending();
  return out;
}

let real: Record<string, unknown> | undefined;

Deno.test("worker $pending: a REAL worker counts only calls that run", async () => {
  await using _srv = await testServer({
    cells: [wpp],
    workers: "real",
    workerEntry: ENTRY,
  });
  real = await readings();
  assertEquals(real.firstShared, 1, JSON.stringify(real));
  assertEquals(real.firstDistinct, 2, JSON.stringify(real));
  assertEquals(real.ttlHit, 0, JSON.stringify(real));
  assertEquals(real.pairDone, 1, JSON.stringify(real));
});

Deno.test("worker $pending: the in-isolate cell reads the same", async () => {
  assert(real, "runs after the real-worker case");
  await using _srv = await testServer({ cells: [wpp] });
  assertEquals(await readings(), real);
});
