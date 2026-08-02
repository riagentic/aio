// a field report #2 + a field report #1 — once the costliest bug in that field
// report: an async method writes through a LIVE proxy, and spreading that
// proxy copies nested values as proxies:
//
//     s.job = { ...s.job, step: p.step }   // nested array → carried a proxy
//
// History of this line: it was silently DROPPED (the report's bug), then
// alpha38 made the refusal reject the caller loudly, and now it simply WORKS —
// recorded values are materialized to plain data at write time (LIVE_RAW), so
// the async path accepts exactly what the sync Immer-draft path always
// accepted. The footgun is gone rather than well-reported; sync/async parity
// is the contract, pinned here and by tests/proxy-differential.test.ts.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";

type Job = { step: number; log: string[] };
type S = { job: Job; other: number };

const builds = cell("builds-proxy", {
  state: { job: { step: 0, log: ["seed"] }, other: 0 } as S,
  methods: {
    // The report's exact line, in the shape that used to reproduce: `job`
    // holds a nested array, so the spread carries a nested proxy.
    async spreadBackAsync(s: S) {
      s.other = 1;
      await new Promise((r) => setTimeout(r, 1));
      s.job = { ...s.job, step: 2 };
    },
    // The old documented workaround — must keep working too.
    async snapshotFirst(s: S) {
      await new Promise((r) => setTimeout(r, 1));
      const job = JSON.parse(JSON.stringify(s.job)) as Job;
      job.step = 7;
      job.log.push("built");
      s.job = job;
      s.other = 9;
    },
    // A SYNC method gets an Immer draft — spreading it has always been legal.
    spreadBackSync(s: S) {
      s.job = { ...s.job, step: 3 };
    },
  },
});

Deno.test("async: spreading the live proxy back into state WORKS, same as sync", async () => {
  await using _app = await bootCells([builds]);
  await builds.spreadBackAsync();
  assertEquals(builds.job.step, 2, "the spread-back landed");
  assertEquals(
    builds.job.log,
    ["seed"],
    "the nested array survived materialization intact",
  );
  assertEquals(builds.other, 1);
});

Deno.test("async: the (historical) snapshot-first pattern still works", async () => {
  await using _app = await bootCells([builds]);
  await builds.snapshotFirst();
  assertEquals(builds.job.step, 7);
  assertEquals(builds.job.log, ["seed", "built"]);
  assertEquals(builds.other, 9);
});

Deno.test("sync: spreading an Immer draft is legal (parity target)", async () => {
  await using _app = await bootCells([builds]);
  await builds.spreadBackSync();
  assertEquals(builds.job.step, 3);
  assertEquals(builds.job.log, ["seed"]);
});
