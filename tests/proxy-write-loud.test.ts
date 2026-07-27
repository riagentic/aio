// llama.md #2 + llama-master.md #1 — the costliest bug in that field report, and
// a direct violation of two of aio's own rules ("fail loud, never silent" and
// "tests are the STRICTEST environment").
//
// An async method writes through a LIVE proxy (reads see committed state across
// awaits). Spreading that proxy copies nested values as proxies, so assigning the
// result back into state hands the store an object it must refuse:
//
//     s.job = { ...s.job, step: p.step }   // job has a nested array → refused
//
// In `deno task dev` the write was refused and logged. Under testCell, testUI,
// bootCells and testServer the SAME write was refused and logged — and the
// method resolved anyway. So `await builds.update()` reported success, the write
// was gone, the build panel froze at step 0 with an empty log, and 239 tests
// stayed green. The report could not write a failing test for its own bug.
//
// The fix: the batcher keeps the store's promise for every write-set it
// dispatches and the async method awaits it before resolving. A refused write now
// rejects the method that made it — identically in dev, prod and every harness.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";

type Job = { step: number; log: string[] };
type S = { job: Job; other: number };

const builds = cell("builds-proxy", {
  state: { job: { step: 0, log: [] }, other: 0 } as S,
  methods: {
    // The report's exact line, in the shape that reproduces: `job` holds a
    // nested array, so the spread carries a proxy the store must refuse.
    async spreadBackAsync(s: S) {
      s.other = 1;
      await new Promise((r) => setTimeout(r, 1));
      s.job = { ...s.job, step: 2 };
    },
    // The documented fix: snapshot to a plain value, mutate that, assign it.
    async snapshotFirst(s: S) {
      await new Promise((r) => setTimeout(r, 1));
      const job = JSON.parse(JSON.stringify(s.job)) as Job;
      job.step = 7;
      job.log.push("built");
      s.job = job;
      s.other = 9;
    },
    // A SYNC method gets an Immer draft, not the live proxy — spreading a draft
    // is legal and always has been. Pinned so the two paths can't silently swap.
    spreadBackSync(s: S) {
      s.job = { ...s.job, step: 3 };
    },
  },
});

Deno.test("async: a refused write REJECTS the method that made it", async () => {
  await using _app = await bootCells([builds]);
  let err: Error | null = null;
  try {
    await builds.spreadBackAsync();
  } catch (e) {
    err = e as Error;
  }
  assert(
    err,
    "the caller was told this succeeded while the write was discarded — the " +
      "exact silence this test exists to prevent",
  );
  const m = err.message;
  assert(m.includes("builds-proxy"), `names the cell: ${m}`);
  assert(/spreadBackAsync/i.test(m), `names the method: ${m}`);
  assert(
    /snapshot|JSON\.parse|plain/i.test(m),
    `states the fix (snapshot to a plain copy first): ${m}`,
  );
  assertEquals(builds.job.step, 0, "the refused write did not land");
});

Deno.test("async: the documented fix is accepted", async () => {
  await using _app = await bootCells([builds]);
  await builds.snapshotFirst();
  assertEquals(builds.job.step, 7);
  assertEquals(builds.job.log, ["built"]);
  assertEquals(builds.other, 9);
});

Deno.test("sync: spreading an Immer draft is legal (different path)", async () => {
  await using _app = await bootCells([builds]);
  await builds.spreadBackSync();
  assertEquals(
    builds.job.step,
    3,
    "a sync method mutates an Immer draft, which spreads to plain values — " +
      "only the async live-proxy path can produce a refused write",
  );
});
