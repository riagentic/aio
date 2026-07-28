// Three defects `am cost` surfaced on its first real use against a live app,
// each pinned here.
//
// The app under test was a wallet reporting ~106 KB/s on the state socket while
// every cell in the table summed to under 1 KB/s. The gap was time-travel:
// broadcast in full on every dispatch, for an app that had explicitly turned
// time-travel OFF.

import { assertEquals } from "@std/assert";
import { renderCost } from "../src/am/am-cmd-cost.ts";
import { createCostMeter } from "../src/vitals/cost-meter.ts";

/** A report shaped like the live one: cheap cells, expensive `other` frames. */
function report(otherBytes: number, cellBytesPerSec: number) {
  return {
    windowSec: 10,
    truncated: false,
    cells: [{
      cell: "sync",
      pushesPerSec: 1.5,
      bytesPerSec: cellBytesPerSec,
      meanBytes: 492,
      p95ReduceMs: 2.3,
      meanReduceMs: 1,
      fullResends: 0,
      keys: [{ key: "labels", bytes: 4032, bytesPerSec: 400, pushes: 15 }],
    }],
    wire: {
      bytesPerSec: (otherBytes / 10) + cellBytesPerSec,
      bytesPerSecPerClient: (otherBytes / 10) + cellBytesPerSec,
      framesPerSec: 15.6,
      fullResendShare: 0,
      byKind: { patch: 165, full: 0, other: 302 },
      bytesByKind: { patch: 23_000, full: 0, other: otherBytes },
      totalBytes: otherBytes + 23_000,
      frames: 467,
    },
    clients: 1,
    idleCells: [],
    stateBytes: { sync: 272 },
  };
}

Deno.test("cost: traffic no cell accounts for is shown in BYTES", () => {
  // 3 MB of diagnostics over 10s against 772 B/s of actual cell pushes — the
  // live shape. Counting alone ("+302 acks/diagnostics") let a reader conclude
  // the app was cheap; the rate has to appear in the same units as the rows.
  const out = renderCost(report(3_000_000, 772));
  assertEquals(out.includes("unattributed"), true);
  assertEquals(out.includes("293.0 KB/s"), true, "the rate, not just a count");
  // …and when it dwarfs the cells, say so rather than leaving it to arithmetic.
  assertEquals(
    out.includes("more than every cell combined"),
    true,
    "the comparison is drawn for the reader",
  );
});

Deno.test("cost: a quiet socket says nothing about unattributed traffic", () => {
  const out = renderCost(report(0, 772));
  assertEquals(
    out.includes("unattributed"),
    false,
    "no line when there is none",
  );
});

Deno.test("cost meter: bytes are attributed per frame kind", () => {
  const m = createCostMeter({});
  m.setClientCount(1);
  m.recordSend(1000, "c1", "patch");
  m.recordSend(50, "c1", "full");
  m.recordSend(9000, "c1", "other");
  const r = m.report({ windowSec: 60 });
  assertEquals(r.wire.byKind, { patch: 1, full: 1, other: 1 });
  assertEquals(r.wire.bytesByKind, { patch: 1000, full: 50, other: 9000 });
  // The headline must still reconcile with the parts.
  assertEquals(
    r.wire.bytesByKind.patch + r.wire.bytesByKind.full +
      r.wire.bytesByKind.other,
    r.wire.totalBytes,
  );
});

// `diagnostics.dev.timeTravel` was declared, defaulted and documented — and
// read by nothing. TT was created purely on `!prod`, so an app that turned it
// off (a wallet, whose stated reason is that TT holds a full state history in
// memory) kept that history anyway and paid a full `tt-state` broadcast on
// every dispatch. Measured on the app that found this: 105.8 KB/s of socket
// traffic, 99% of it time-travel, against cells totalling under 1 KB/s.

import { timeTravelEnabled } from "../src/diagnostics/types.ts";

Deno.test("time-travel: the option decides, not just `!prod`", () => {
  // The bug: an app that set `timeTravel: false` still got time-travel.
  assertEquals(timeTravelEnabled(false, { timeTravel: false }), false);
  // Turning it into a real gate must not turn the feature off for every app
  // that never mentions it — dev default stays on.
  assertEquals(timeTravelEnabled(false, {}), true, "default dev keeps it");
  assertEquals(timeTravelEnabled(false, { timeTravel: true }), true);
  // Diagnostics off wholesale historically still ran TT in dev; preserved, so
  // only an EXPLICIT false turns it off.
  assertEquals(timeTravelEnabled(false, false), true);
  // Never in production, whatever the option says.
  assertEquals(timeTravelEnabled(true, { timeTravel: true }), false);
  assertEquals(timeTravelEnabled(true, false), false);
});
