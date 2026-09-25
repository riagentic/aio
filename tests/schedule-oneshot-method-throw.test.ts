// A one-shot whose METHOD throws is not re-run.
//
// The one-shot retry (3 × 5s) exists for a tick the dispatch door refused —
// nothing ran, so trying again is the only way the job ever happens. A SYNC
// method that throws is not that: it ran, its answer was "no" (the log even
// says the caller's await is rejected), and the scheduler then ran it three
// more times, 5s apart — four error boxes for one fault, and a refusal
// (`throw new Error("card declined")`) that could quietly turn into a success
// fifteen seconds later. The same method written `async` ran exactly once,
// so a keyword decided whether a job was repeated.
import { assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell, schedule, self } from "../mod.ts";

let syncRuns = 0;
let asyncRuns = 0;

const oneShotThrow = cell("oneShotThrow", {
  state: { n: 0 },
  methods: {
    arm(s) {
      s.$do(schedule.after("sync", 10, self("failSync")));
      s.$do(schedule.after("async", 10, self("failAsync")));
    },
    failSync() {
      syncRuns++;
      throw new Error("not now");
    },
    async failAsync() {
      asyncRuns++;
      await Promise.resolve();
      throw new Error("not now");
    },
  },
});

Deno.test("schedule: a one-shot whose method throws runs it once, sync or async", async () => {
  await using h = await bootCells([oneShotThrow]);
  await oneShotThrow.arm();
  await h.advance(30_000); // past every 5s retry the scheduler would make
  assertEquals(asyncRuns, 1, "the async method ran more than once");
  assertEquals(syncRuns, 1, "the sync method was re-run by the retry");
});
