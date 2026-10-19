// `s.$commit(minMs)` — the progress throttle every long method hand-rolled.
//
// One field report wrote the same shape twice in one app: `if (++ticks % 8 ===
// 0) s.$commit()` in a filesystem walk and `if (pct - published >= 0.01)
// s.$commit()` in a hasher. That is a counter, a threshold and a bookkeeping
// variable per method, all encoding one decision the framework can own —
// especially now that `long:` makes "runs for minutes" a first-class category,
// and publishing progress is what those methods all then have to do.
import { assert, assertEquals } from "@std/assert";
import { cell } from "aio";
import { bootCells } from "aio/testing";

const commits: number[] = [];

const job = cell("throttled", {
  transaction: true,
  state: { done: 0 },
  methods: {
    async run(s, steps: number, minMs: number) {
      for (let i = 0; i < steps; i++) {
        s.done = i + 1;
        s.$commit(minMs);
        await new Promise((r) => setTimeout(r, 2));
      }
    },
    async unthrottled(s, steps: number) {
      for (let i = 0; i < steps; i++) {
        s.done = i + 1;
        s.$commit();
        await new Promise((r) => setTimeout(r, 2));
      }
    },
  },
});

Deno.test({
  name: "$commit(ms) publishes far less often than it is called",
  async fn() {
    const h = await bootCells([job]);
    try {
      commits.length = 0;
      // Sample the published value while the method runs. Under a 200ms
      // throttle a 20-step, ~40ms loop publishes ONCE (the first call) and
      // then commits the rest at return.
      const seen = new Set<number>();
      const t = setInterval(() => seen.add(job.done), 3);
      await job.run(20, 200);
      clearInterval(t);
      await h.settle();
      assert(
        seen.size <= 4,
        `throttled to 200ms, a 40ms loop should publish once or twice — saw ` +
          `${seen.size} distinct values`,
      );
      // Whatever the publish count, the FINAL state is exact: throttling
      // changes WHEN the UI sees progress, never where the method ends up.
      assertEquals(job.done, 20);
    } finally {
      h.dispose();
    }
  },
});

Deno.test({
  name: "the first $commit(ms) always publishes",
  async fn() {
    // A progress bar that waits one full interval before its first frame
    // looks like a hang, which is exactly what a progress bar is there to
    // rule out.
    const h = await bootCells([job]);
    try {
      const p = job.run(3, 60_000); // an interval no test will ever reach
      await new Promise((r) => setTimeout(r, 10));
      assert(job.done >= 1, "the first step must be visible immediately");
      await p;
      await h.settle();
      assertEquals(job.done, 3);
    } finally {
      h.dispose();
    }
  },
});

Deno.test({
  name: "a bare $commit() is unchanged — publish, unconditionally",
  async fn() {
    const h = await bootCells([job]);
    try {
      const p = job.unthrottled(4);
      await new Promise((r) => setTimeout(r, 5));
      assert(job.done >= 1, "no argument means no throttle");
      await p;
      await h.settle();
      assertEquals(job.done, 4);
    } finally {
      h.dispose();
    }
  },
});

const stepped = cell("throttledStepBack", {
  transaction: true,
  state: { done: 0 },
  methods: {
    async run(s, steps: number, minMs: number, stepBackAt: number) {
      for (let i = 0; i < steps; i++) {
        s.done = i + 1;
        s.$commit(minMs);
        if (i === stepBackAt) {
          const real = Date.now;
          Date.now = () => real() - 3_600_000; // NTP steps the clock back an hour
        }
        await new Promise((r) => setTimeout(r, 30));
      }
    },
  },
});

Deno.test({
  name: "$commit(ms) keeps publishing after the wall clock steps back",
  async fn() {
    // The throttle measured `now - lastCommitAt`, which a backward step makes
    // negative — `< minMs` for as long as the step: a progress bar froze for
    // the hour the clock went back, not for the 20ms it asked.
    const realNow = Date.now;
    const h = await bootCells([stepped]);
    try {
      const p = stepped.run(6, 20, 0);
      await new Promise((r) => setTimeout(r, 110));
      assert(
        stepped.done >= 3,
        `progress must keep publishing — saw ${stepped.done}`,
      );
      await p;
      await h.settle();
      assertEquals(stepped.done, 6);
    } finally {
      Date.now = realNow;
      h.dispose();
    }
  },
});
