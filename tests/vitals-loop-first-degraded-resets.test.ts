// `firstDegradedAt` is the start of the CURRENT degraded stretch. It used to
// be set once and never cleared (only `reset()` touched it), so one queue blip
// at boot stayed "the moment the loop first degraded" for the life of the
// process. Hint rule 2 orders that stamp against the transport's — "did the
// loop degrade BEFORE the network did?" — and with an hours-old stamp it
// always answered yes: a freeze that began on the network was blamed on the
// dispatch queue, with "debounce your dispatches" as the fix.
import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { createLoopProbe } from "../src/vitals/loop-probe.ts";
import { evaluateHints } from "../src/vitals/hints.ts";
import type { VitalThresholds } from "../src/vitals/types.ts";

const T: VitalThresholds = {
  render: { degraded: 50, warning: 200, frozen: 2000 },
  transport: { degraded: 100, warning: 500, frozen: 2000 },
  loop: { degraded: 100, warning: 500, frozen: 2000 },
  queue: { degraded: 50, warning: 200, frozen: 1000 },
};

Deno.test("vitals: loop firstDegradedAt clears on recovery, so a later stall is not blamed on an old queue blip", () => {
  using time = new FakeTime(1_000_000);
  const probe = createLoopProbe(T);

  // A blip at boot, and a full recovery.
  probe.updateQueueDepth(60);
  assertEquals(probe.getFirstDegradedAt(), 1_000_000);
  probe.updateQueueDepth(0);
  assertEquals(
    probe.getFirstDegradedAt(),
    null,
    "a healthy loop has no degraded stretch",
  );

  // An hour later the NETWORK stalls first (t0), and the queue backs up
  // behind it ten seconds after that.
  time.tick(3_600_000);
  const transportDegradedAt = Date.now();
  time.tick(10_000);
  probe.updateQueueDepth(1500);
  assertEquals(probe.getFirstDegradedAt(), transportDegradedAt + 10_000);

  const hint = evaluateHints({
    render: {
      status: "healthy",
      measured: 0,
      lastActionBefore: null,
      firstDegradedAt: null,
      visible: true,
    },
    transport: {
      status: "frozen",
      measured: 12_000,
      firstDegradedAt: transportDegradedAt,
    },
    loop: {
      ...probe.getVitals(),
      status: probe.getStatus(),
      firstDegradedAt: probe.getFirstDegradedAt(),
    },
  }, T);
  assertEquals(
    hint?.cause.startsWith("Dispatch queue backed up") ?? false,
    false,
    `the queue backed up AFTER the network stalled — not the cause: ${
      JSON.stringify(hint)
    }`,
  );
});
