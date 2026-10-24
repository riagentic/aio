// `skipIfRunning` with a HAND-WRITTEN action whose payload is not a plain
// object (`{ type: "c:poll", payload: 5 }`). The guard rides a `_callId` in
// the framework's `{ args }` envelope, which such a payload cannot carry, so
// it was released when the dispatch settled — the async method's first
// `await` — and every tick ran on top of the last. It now holds until no call
// of that method is in flight.
import { assertEquals } from "@std/assert";
import { cell, schedule } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const payload of [5, "x", [1, 2], null]) {
  Deno.test(`skipIfRunning holds for a hand-written action with payload ${JSON.stringify(payload)}`, async () => {
    const poller = cell("skipraw", {
      state: { polls: 0, running: 0, maxRunning: 0 },
      methods: {
        start(s) {
          s.$do(
            schedule.every("poll", 100, { type: "skipraw:poll", payload }, {
              skipIfRunning: true,
            }),
          );
        },
        stop(s) {
          s.$do(schedule.cancel("poll"));
        },
        async poll(s) {
          s.polls++;
          s.running++;
          s.maxRunning = Math.max(s.maxRunning, s.running);
          await sleep(60);
          s.running--;
        },
      },
    });
    await using h = await bootCells([poller]);
    await poller.start();
    await h.advance(600);
    assertEquals(poller.polls, 1, "ticks after the first are skipped");
    assertEquals(poller.maxRunning, 1);
    assertEquals(poller.running, 0);
    await h.advance(100);
    assertEquals(poller.polls, 2, "the guard releases when the method ends");
    await poller.stop();
  });
}
