// The cost meter's arithmetic, pinned. Their condition for this feature was
// blunt and correct: "It must be correct, or not shipped. A cost number that is
// plausible but wrong is worse than no number, because people act on it."
//
// So the rates, the windowing and the attribution are tested against a
// controlled clock, and the wire total is tested against a real socket in
// tests/cost-wire-accuracy.test.ts.
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { createCostMeter } from "../src/vitals/cost-meter.ts";

/** A meter on a clock we drive, so rates are exact rather than timing-dependent. */
function meterAt(start = 1_000_000) {
  let t = start;
  const m = createCostMeter({ now: () => t });
  return {
    m,
    tick: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

Deno.test("cost: rates are per measured second, not per requested window", () => {
  const { m, tick, now } = meterAt();
  // Four pushes, then 2s of observed time, asked for a 60s window: the app has
  // only been running 2s, and dividing by 60 would under-report by 30×. The
  // divisor is the span actually observed — first sample to now.
  for (let i = 0; i < 4; i++) {
    m.recordSend(1000, "c0", "patch");
    m.recordAttribution("hw", "cpu", 800);
    tick(500); // …including after the last one: that time really did pass
  }
  const r = m.report({ windowSec: 60, now: now() });
  assertAlmostEquals(r.windowSec, 2, 0.01, "the span actually observed");
  assertAlmostEquals(r.wire.bytesPerSec, 4000 / 2, 1);
  assertAlmostEquals(r.cells[0]!.bytesPerSec, 3200 / 2, 1);
});

Deno.test("cost: the window excludes older samples", () => {
  const { m, tick, now } = meterAt();
  m.recordSend(9999, "c0", "full"); // ancient
  m.recordAttribution("old", "k", 9999);
  tick(30_000);
  m.recordSend(100, "c0", "patch");
  m.recordAttribution("hw", "cpu", 80);
  const r = m.report({ windowSec: 10, now: now() });
  assertEquals(
    r.wire.totalBytes,
    100,
    "the 30s-old frame is outside a 10s window",
  );
  assertEquals(r.cells.find((c) => c.cell === "old"), undefined);
});

Deno.test("cost: attribution counts PUSHES, not key-writes", () => {
  const { m, tick, now } = meterAt();
  // One broadcast round touching three keys of one cell is ONE push.
  for (let round = 0; round < 2; round++) {
    m.recordAttribution("hw", "cpu", 100);
    m.recordAttribution("hw", "gpu", 200);
    m.recordAttribution("hw", "ram", 300);
    tick(1000);
  }
  const hw = m.report({ windowSec: 60, now: now() }).cells[0]!;
  assertEquals(hw.pushesPerSec, 1, "2 pushes over the 2s measured span");
  assertEquals(hw.meanBytes, 600, "600 bytes per push, not 200 per key-write");
  assertEquals(hw.keys.length, 3);
});

Deno.test("cost: keys are ranked by bytes — the actionable ordering", () => {
  const { m, now } = meterAt();
  m.recordAttribution("hw", "cpuHistory", 2100);
  m.recordAttribution("hw", "coresUtil", 1800);
  m.recordAttribution("hw", "gpus", 1400);
  m.recordAttribution("hw", "tempC", 12);
  const hw = m.report({ now: now() }).cells[0]!;
  assertEquals(hw.keys.map((k) => k.key), [
    "cpuHistory",
    "coresUtil",
    "gpus",
    "tempC",
  ]);
  assertEquals(hw.keys[0]!.bytes, 2100);
});

Deno.test("cost: cells are ranked by cost, and idle cells stay visible", () => {
  const { m, now } = meterAt();
  m.setKnownCells(["hw", "srv", "chat", "models"]);
  m.recordAttribution("srv", "status", 400);
  m.recordAttribution("hw", "cpu", 8000);
  m.recordReduce("chat", 3.1);
  const r = m.report({ now: now() });
  assertEquals(r.cells.map((c) => c.cell).slice(0, 2), ["hw", "srv"]);
  // "Nothing here" is a result: a cell that pushed nothing must be shown, or
  // the reader cannot tell it from a cell that is missing.
  assertEquals(r.idleCells.includes("models"), true);
  assertEquals(
    r.idleCells.includes("chat"),
    true,
    "a cell that burns reduce time but pushes nothing is idle FOR COST — " +
      "'busy but free' is a useful thing for this report to be able to say",
  );
});

Deno.test("cost: p95 and mean reduce are per cell", () => {
  const { m, now } = meterAt();
  for (const ms of [1, 1, 1, 1, 1, 1, 1, 1, 1, 40]) m.recordReduce("hw", ms);
  m.recordReduce("srv", 5);
  const r = m.report({ now: now() });
  const hw = r.cells.find((c) => c.cell === "hw")!;
  assertEquals(hw.p95ReduceMs, 40, "the outlier is what p95 exists to show");
  assertAlmostEquals(hw.meanReduceMs, 4.9, 0.01);
  assertEquals(r.cells.find((c) => c.cell === "srv")!.p95ReduceMs, 5);
});

Deno.test("cost: full resends are counted and shared, not hidden", () => {
  const { m, now } = meterAt();
  m.recordSend(100, "c0", "patch");
  m.recordSend(9000, "c0", "full");
  m.recordAttribution("hw", "*", 9000); // "*" = the whole slice went
  const r = m.report({ now: now() });
  assertEquals(r.wire.fullResendShare, 0.5);
  assertEquals(r.cells[0]!.fullResends, 1);
  assertEquals(
    r.cells[0]!.keys[0]!.key,
    "*",
    'a whole-slice resend is reported as "*" — that IS the finding',
  );
});

Deno.test("cost: per-client rate divides by connected clients", () => {
  const { m, tick, now } = meterAt();
  m.setClientCount(3);
  for (let i = 0; i < 3; i++) {
    m.recordSend(1000, `c${i}`, "patch"); // the same round, to three sockets
  }
  tick(1000);
  const r = m.report({ now: now() });
  assertAlmostEquals(r.wire.bytesPerSec, 3000, 1);
  assertAlmostEquals(
    r.wire.bytesPerSecPerClient,
    1000,
    1,
    "what ONE extra surface costs — the number that decides a design",
  );
});

Deno.test("cost: --cell filters attribution and reduce alike", () => {
  const { m, now } = meterAt();
  m.recordAttribution("hw", "cpu", 100);
  m.recordAttribution("srv", "status", 200);
  m.recordReduce("hw", 1);
  m.recordReduce("srv", 2);
  const r = m.report({ cell: "hw", now: now() });
  assertEquals(r.cells.map((c) => c.cell), ["hw"]);
  assertEquals(r.cells[0]!.meanReduceMs, 1);
});

Deno.test("cost: memory is bounded, and truncation is admitted", () => {
  let t = 0;
  const m = createCostMeter({
    sends: 10,
    attributions: 10,
    reduces: 10,
    now: () => t,
  });
  for (let i = 0; i < 1000; i++) {
    t += 1;
    m.recordSend(10, "c0", "patch");
  }
  const r = m.report({ windowSec: 3600, now: t });
  assertEquals(r.wire.frames, 10, "the ring holds 10, not 1000");
  assertEquals(
    r.truncated,
    true,
    "a window that lost samples must SAY so — otherwise the totals read as complete",
  );
});

Deno.test("cost: an empty meter reports zeroes, not NaN", () => {
  const { m, now } = meterAt();
  m.setKnownCells(["hw"]);
  const r = m.report({ now: now() });
  assertEquals(r.wire.bytesPerSec, 0);
  assertEquals(r.wire.fullResendShare, 0);
  assertEquals(r.cells[0]!.meanBytes, 0);
  assertEquals(r.cells[0]!.p95ReduceMs, 0);
  assertEquals(r.idleCells, ["hw"]);
});

Deno.test("cost: reset clears every stream", () => {
  const { m, now } = meterAt();
  m.recordSend(100, "c0", "patch");
  m.recordAttribution("hw", "cpu", 50);
  m.recordReduce("hw", 1);
  m.reset();
  const r = m.report({ now: now() });
  assertEquals(r.wire.frames, 0);
  assertEquals(r.cells.filter((c) => c.bytesPerSec > 0), []);
});
