// The perf gate measures a red metric AGAIN before it fails — and only then.
//
// `check:bench` compares each metric's p10 with a committed floor. One attempt
// on a shared machine is not "how fast can this go": the same build measured
// boot at 11–14 ms and at 9.4 ms minutes apart, with the floor at 10. A gate
// that is red by the neighbour's build is a gate people stop running, which is
// how the floor could sit broken for nine releases with nobody told. So a red
// metric is measured alone up to twice more and the BEST attempt is judged;
// a real regression is red three times out of three.
import { assertEquals } from "@std/assert";
import {
  measureWithRetries,
  type Metric,
  overFloor,
  RETRIES,
} from "../scripts/check-bench.ts";

const m = (p10: number): Metric => ({
  unit: "ms",
  p10,
  min: p10,
  median: p10,
  p95: p10,
  n: 5,
});
const FLOORS = { boot: 10, "patch-10k": 6.8, absent: 1 };

Deno.test("check:bench — a metric over its floor is red; a missing one is not retried", () => {
  assertEquals(
    overFloor({ boot: m(15), "patch-10k": m(3) }, FLOORS),
    ["boot"],
  );
  assertEquals(overFloor({ boot: m(10), "patch-10k": m(6.8) }, FLOORS), []);
});

Deno.test("check:bench — a red metric is measured again, alone, and the best attempt is judged", async () => {
  const asked: (string[] | undefined)[] = [];
  const said: string[] = [];
  const runs: Record<string, Metric>[] = [
    { boot: m(15), "patch-10k": m(3) }, // the suite: boot red
    { boot: m(17) }, // worse: the first attempt stays the best
    { boot: m(9) }, // the machine went quiet: within the floor
  ];
  const { metrics, retried } = await measureWithRetries(
    (only) => {
      asked.push(only);
      return Promise.resolve(runs[asked.length - 1]!);
    },
    FLOORS,
    (l) => said.push(l),
  );
  assertEquals(asked, [undefined, ["boot"], ["boot"]]);
  assertEquals(metrics.boot!.p10, 9);
  assertEquals(metrics["patch-10k"]!.p10, 3, "a green metric is left alone");
  assertEquals(retried, { boot: 2 });
  assertEquals(overFloor(metrics, FLOORS), []);
  // Each retry is said, with the machine's load beside it.
  assertEquals(said.length, 2);
  assertEquals(/^retry 1\/2: boot — load /.test(said[0]!), true, said[0]);
});

Deno.test("check:bench — a real regression is still red after every retry, and a green run is never re-measured", async () => {
  let calls = 0;
  const red = await measureWithRetries(
    () => {
      calls++;
      return Promise.resolve({ boot: m(15 - calls), "patch-10k": m(3) });
    },
    FLOORS,
  );
  assertEquals(calls, 1 + RETRIES, "exactly the suite plus the retries");
  assertEquals(red.metrics.boot!.p10, 12, "the best attempt, and it is red");
  assertEquals(overFloor(red.metrics, FLOORS), ["boot"]);

  calls = 0;
  await measureWithRetries(
    () => {
      calls++;
      return Promise.resolve({ boot: m(8), "patch-10k": m(3) });
    },
    FLOORS,
  );
  assertEquals(calls, 1);
});
