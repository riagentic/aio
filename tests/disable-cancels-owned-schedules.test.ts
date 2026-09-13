// Disabling a cell cancels the schedules it ISSUED — not only the ones whose
// id happens to start with its name.
//
// docs/state/lifecycle.md: a disabled cell's "Scheduled effects cancelled".
// The runtime decided that by id prefix alone (`cancelByPrefix("poller")`), and
// docs/state/scheduling.md writes ids bare — `schedule.every("poll", …)` — so
// the documented spelling kept ticking after the circuit breaker tripped.
// Measured before the fix, 200 ms after the disable:
//
//   unprefixed 'poll'         +10 ticks
//   prefixed   'pollerx:poll'  +0
//
// The issuer is recorded beside the effect (a WeakMap), so what a test reads
// from `t.getEffects()` is still exactly the object `schedule.every()` built.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { schedule } from "../src/state/schedule.ts";
import { testCell } from "../src/cell-test.ts";
import * as standalone from "../src/standalone-air.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test({
  name: "circuit breaker: a disabled cell's bare-id schedules stop too",
  fn: async () => {
    const counter = cell("disown_counter", {
      state: { a: 0, b: 0, own: 0 },
      methods: {
        bumpA(s: Any) {
          s.a++;
        },
        bumpB(s: Any) {
          s.b++;
        },
        bumpOwn(s: Any) {
          s.own++;
        },
        // A schedule issued by a HEALTHY cell must survive another's disable.
        arm(s: Any) {
          s.$do(schedule.every("heartbeat", 10, counter.bumpOwn.action()));
        },
      },
    } as Any) as Any;
    const poller = cell("disown_poller", {
      state: { n: 0 },
      methods: {
        arm(s: Any) {
          s.$do(schedule.every("poll", 10, counter.bumpA.action()));
          s.$do(
            schedule.every("disown_poller:poll", 10, counter.bumpB.action()),
          );
        },
        boom(_s: Any) {
          throw new Error("bad");
        },
      },
    } as Any) as Any;
    standalone._resetState();
    const app: Any = await standalone.aio.run({
      appId: "disown",
      cells: [counter, poller],
      persist: false,
      circuitBreaker: { maxErrors: 2 },
    } as Any);
    try {
      await poller.arm();
      await counter.arm();
      await wait(60);
      assert(counter.a > 0 && counter.b > 0 && counter.own > 0, "all armed");
      for (let i = 0; i < 2; i++) await poller.boom().catch(() => {});
      await wait(30);
      const a0 = counter.a, b0 = counter.b, own0 = counter.own;
      await wait(150);
      assertEquals(counter.a - a0, 0, "the bare id the disabled cell issued");
      assertEquals(counter.b - b0, 0, "the prefixed id (unchanged behaviour)");
      assert(counter.own - own0 > 0, "a healthy cell's schedule keeps ticking");
    } finally {
      await app.close?.();
      standalone._resetState();
    }
  },
});

const shape = cell("disown_shape", {
  state: { n: 0 },
  methods: {
    arm(s: Any) {
      s.$do(schedule.every("tick", 1000, shape.arm.action()));
    },
  },
} as Any) as Any;

testCell(
  shape,
  "the emitted effect's shape is untouched by the bookkeeping",
  (t: Any) => {
    t.send.arm();
    assertEquals(t.getEffects(), [
      schedule.every("tick", 1000, shape.arm.action()),
    ]);
  },
);
