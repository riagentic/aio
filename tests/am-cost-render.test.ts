// `am cost`'s presentation layer, tested without a running app: the table is a
// pure function of the report, and the flag parsing is a pure function of a
// string. What the numbers MEAN is tested against real sockets in
// tests/cost-wire-accuracy.test.ts; this is about the reader's experience of
// them — because a correct number nobody can read is not much better than a
// wrong one.
import { assert, assertEquals } from "@std/assert";
import { fmtBytes, parseWindow, renderCost } from "../src/am/am-cmd-cost.ts";

const report = (over: Record<string, unknown> = {}) => ({
  windowSec: 60,
  truncated: false,
  clients: 3,
  idleCells: ["chat"],
  stateBytes: { hw: 8123, srv: 412, chat: 15 },
  wire: {
    bytesPerSec: 24900,
    bytesPerSecPerClient: 8300,
    framesPerSec: 3,
    fullResendShare: 0.1,
    byKind: { patch: 18, full: 2, other: 5 },
    totalBytes: 249000,
    frames: 25,
  },
  cells: [
    {
      cell: "hw",
      pushesPerSec: 1,
      bytesPerSec: 7900,
      meanBytes: 7900,
      p95ReduceMs: 0.4,
      meanReduceMs: 0.2,
      fullResends: 0,
      keys: [
        { key: "cpuHistory", bytes: 2100, bytesPerSec: 2100, pushes: 60 },
        { key: "coresUtil", bytes: 1800, bytesPerSec: 1800, pushes: 60 },
        { key: "gpus", bytes: 1400, bytesPerSec: 1400, pushes: 60 },
        { key: "tempC", bytes: 12, bytesPerSec: 12, pushes: 60 },
      ],
    },
    {
      cell: "chat",
      pushesPerSec: 0,
      bytesPerSec: 0,
      meanBytes: 0,
      p95ReduceMs: 3.1,
      meanReduceMs: 3.1,
      fullResends: 0,
      keys: [],
    },
  ],
  ...over,
});

Deno.test("am cost: the table answers the question that was asked", () => {
  const out = renderCost(report());
  // "What does aio move on my behalf, and where does it come from."
  assert(out.includes("hw"), "the cell");
  // Sizes are binary KB (1024), as `du` and the rest of the tooling report them.
  assert(out.includes("7.7 KB/s"), "what it moves");
  assert(out.includes("cpuHistory 2.1 KB"), "…and which key it comes from");
  assert(out.includes("8.1 KB/s"), "per client — the unit price of a surface");
  assert(out.includes("3"), "how many surfaces");
});

Deno.test("am cost: top keys are capped at three unless --keys", () => {
  const brief = renderCost(report());
  assert(brief.includes("cpuHistory"), "the biggest is always shown");
  assert(!brief.includes("tempC"), "the 12-byte key is noise at a glance");
  assert(brief.includes("--keys"), "and the way to see it is offered");

  const full = renderCost(report(), { keys: true });
  assert(full.includes("tempC"), "--keys shows everything");
});

Deno.test("am cost: an idle cell is shown, and says so", () => {
  const out = renderCost(report());
  assert(out.includes("chat"), "a cell that pushed nothing is still listed");
  assert(
    out.includes("(idle)"),
    "…and labelled, so 'nothing here' is distinguishable from 'not measured'",
  );
});

Deno.test("am cost: acks are separated from full resends in the summary", () => {
  const out = renderCost(report());
  assert(
    out.includes("2 of 20 state pushes"),
    `the share is of pushes, not of all frames: ${out}`,
  );
  assert(out.includes("acks"), "and the rest is named rather than lumped in");
});

Deno.test("am cost: a full-resend majority is called out", () => {
  const out = renderCost(report({
    wire: {
      ...report().wire,
      fullResendShare: 0.9,
      byKind: { patch: 2, full: 18, other: 1 },
    },
  }));
  assert(
    out.includes("the whole state is going out"),
    "the single most actionable finding must not be a number to decode",
  );
  assert(
    out.includes("fullStateThreshold"),
    "and it names the knob that governs it",
  );
});

Deno.test("am cost: an app that pushed nothing says so plainly", () => {
  const out = renderCost(report({
    cells: [],
    idleCells: [],
    wire: {
      bytesPerSec: 0,
      bytesPerSecPerClient: 0,
      framesPerSec: 0,
      fullResendShare: 0,
      byKind: { patch: 0, full: 0, other: 0 },
      totalBytes: 0,
      frames: 0,
    },
  }));
  assert(
    out.includes("nothing was pushed"),
    `an empty report must explain itself: ${out}`,
  );
});

Deno.test("am cost: a wrapped ring admits the window is a floor", () => {
  const out = renderCost(report({ truncated: true }));
  assert(
    out.includes("ring wrapped"),
    "otherwise a partial total reads as complete",
  );
});

Deno.test("am cost: --window accepts s/m/h and rejects nonsense", () => {
  assertEquals(parseWindow("60"), 60);
  assertEquals(parseWindow("60s"), 60);
  assertEquals(parseWindow("5m"), 300);
  assertEquals(parseWindow("1h"), 3600);
  assertEquals(parseWindow("500ms"), 0.5);
  assertEquals(parseWindow("nonsense"), null);
  assertEquals(parseWindow("0"), null, "a zero window measures nothing");
  assertEquals(parseWindow("-5"), null);
  assertEquals(parseWindow(""), null);
});

Deno.test("am cost: byte formatting stays readable at every scale", () => {
  assertEquals(fmtBytes(0), "—", "zero is absence, not '0 B'");
  assertEquals(fmtBytes(412), "412 B");
  assertEquals(fmtBytes(8123), "7.9 KB");
  assertEquals(fmtBytes(2_500_000), "2.4 MB");
});
