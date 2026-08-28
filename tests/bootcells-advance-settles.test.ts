// `advance()` must settle the work it starts.
//
// Firing a timer STARTS the method; its real work — a dynamic import, a
// subprocess, a file read — lands on macrotasks the virtual clock does not
// own. So `await h.advance(ms)` used to return before anything had happened,
// and a field report ended up with
//
//     for (let i = 0; i < 100 && issues.last === first; i++) {
//       await new Promise((r) => setTimeout(r, 10));
//       await h.settle();
//     }
//
// which is the tell that a clock sold as deterministic is not.
import { assertEquals } from "@std/assert";
import { cell } from "aio";
import { bootCells } from "aio/testing";
import { schedule } from "aio";

const TICK_MS = 1000;

const monitor = cell("advmon", {
  state: { ticks: 0, measured: "" },
  methods: {
    start(s) {
      s.ticks = 0;
      s.$do(schedule.every("advmon.tick", TICK_MS, {
        type: "advmon:tick",
        payload: { args: [] },
      }));
    },
    // Real async work on a MACROTASK — the shape the virtual clock cannot see.
    async tick(s) {
      s.ticks++;
      const v = await new Promise<string>((r) =>
        setTimeout(() => r(`measure-${s.ticks}`), 5)
      );
      s.measured = v;
    },
  },
});

Deno.test({
  name: "advance() settles the async work the timer dispatched",
  async fn() {
    const h = await bootCells([monitor]);
    try {
      await monitor.start();
      await h.advance(TICK_MS);
      // No polling loop, no sleep: the measurement is here when advance returns.
      assertEquals(monitor.ticks, 1);
      assertEquals(monitor.measured, "measure-1");

      await h.advance(TICK_MS);
      assertEquals(monitor.ticks, 2);
      assertEquals(monitor.measured, "measure-2");
    } finally {
      h.dispose();
    }
  },
});

Deno.test({
  name: "settle() alone drains an async method already in flight",
  async fn() {
    const h = await bootCells([monitor]);
    try {
      monitor.tick(); // deliberately un-awaited
      await h.settle();
      assertEquals(monitor.measured.startsWith("measure-"), true);
    } finally {
      h.dispose();
    }
  },
});
