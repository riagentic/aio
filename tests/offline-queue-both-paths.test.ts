// There are TWO offline queues, and "is this connection degraded" is ONE fact.
//
// Cell-method dispatch queues in `browser/browser-air-transport.ts`;
// `useCell().send` / `useAio().send` queue in the isomorphic core
// (`state/state-transport.ts`). Two queues is structural, not an oversight —
// the boundary matrix forbids `state` importing `browser`, so the core cannot
// delegate. But the health question they answer is shared, and
// `isConnectionDegraded()` — which docs/persistence/offline.md and
// docs/clients/browser.md both tell you to render as a "reconnecting"
// indicator — reported on the cell-method queue ALONE. A `send()` caller could
// back up to the point of dropping actions while the indicator said the
// connection was fine.
//
// A drop was also quieter on this side: the cell-method queue emits a
// diagnostic (reaching the bus, the dev overlay and `am`), while this one only
// ever wrote to the browser console.
import { assert, assertEquals } from "@std/assert";
import { _resetTransport, send } from "../src/state/state-transport.ts";
import { isConnectionDegraded } from "../src/air.ts";
import {
  diagSubscribe,
  initDiagnosticBus,
} from "../src/diagnostics/diagnostic-bus.ts";

/** Fill the core offline queue by sending with no transport attached. */
function fillCoreQueue(n: number): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) out.push(send({ type: `q:act${i}` }));
  return out;
}

Deno.test("isConnectionDegraded reflects the CORE queue too", () => {
  _resetTransport();
  try {
    assertEquals(
      isConnectionDegraded(),
      false,
      "a fresh client is not degraded",
    );
    // Below the 80% mark of the core queue (cap 100): still healthy.
    fillCoreQueue(50);
    assertEquals(
      isConnectionDegraded(),
      false,
      "half a queue is not degraded",
    );
    // Past 80%: the indicator must fire. It used to stay false forever here,
    // because only the cell-method queue was consulted.
    fillCoreQueue(40); // 90 total
    assertEquals(
      isConnectionDegraded(),
      true,
      "past 80% of the core offline queue the connection IS degraded — an " +
        "indicator that cannot see this queue lies to every send() caller",
    );
  } finally {
    _resetTransport();
  }
});

Deno.test("isConnectionDegraded clears when the core queue drains", () => {
  _resetTransport();
  try {
    fillCoreQueue(90);
    assertEquals(isConnectionDegraded(), true);
    _resetTransport(); // drops the queue, as a teardown would
    assertEquals(
      isConnectionDegraded(),
      false,
      "the indicator must clear once the queue is gone — a stuck-on warning " +
        "is as useless as one that never fires",
    );
  } finally {
    _resetTransport();
  }
});

Deno.test("a dropped send() emits a diagnostic, not just a console line", () => {
  initDiagnosticBus(true);
  const seen: string[] = [];
  const unsub = diagSubscribe((e) => seen.push(e.type));
  _resetTransport();
  try {
    // Overfill: the cap is 100, so the 101st is dropped.
    const results = fillCoreQueue(101);
    assertEquals(
      results[100],
      false,
      "send() must report the drop to its caller",
    );
    assert(
      seen.includes("state-transport:offline-queue-full"),
      `a dropped action must reach the diagnostic bus — the cell-method queue ` +
        `emits for the same event, and a console line is invisible to the dev ` +
        `overlay and to \`am\`. Saw: ${JSON.stringify(seen)}`,
    );
  } finally {
    unsub();
    _resetTransport();
  }
});
