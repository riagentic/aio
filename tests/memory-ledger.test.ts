import { assertEquals, assertExists, assertThrows } from "@std/assert";
import {
  _resetMemoryLedger,
  budget,
  readGauges,
  registerGauge,
} from "../src/diagnostics/memory-ledger.ts";

// Every case resets first: the registry is process-global (subsystems register
// into it at boot), so a case must not inherit a series — or a spent counter —
// from the one before it.
function fresh(): void {
  _resetMemoryLedger();
}

// ── registerGauge / readGauges ─────────────────────────────────────

Deno.test("ledger: a registered gauge is read with its owner, unit and kind", () => {
  fresh();
  let n = 0;
  registerGauge({
    name: "broadcast.bufferedBytes",
    owner: "broadcast",
    unit: "bytes",
    kind: "level",
    read: () => (n += 1),
  });
  const first = readGauges();
  assertEquals(first.length, 1);
  assertEquals(first[0]!.name, "broadcast.bufferedBytes");
  assertEquals(first[0]!.owner, "broadcast");
  assertEquals(first[0]!.unit, "bytes");
  assertEquals(first[0]!.kind, "level");
  assertEquals(first[0]!.value, 1);
  // A snapshot, not a memo: the second read sees the second value.
  assertEquals(readGauges()[0]!.value, 2);
});

Deno.test("ledger: a second registration of a name does NOT re-point it", () => {
  fresh();
  registerGauge({
    name: "x",
    owner: "first",
    unit: "count",
    kind: "level",
    read: () => 1,
  });
  registerGauge({
    name: "x",
    owner: "second",
    unit: "count",
    kind: "level",
    read: () => 999,
  });
  const g = readGauges();
  assertEquals(g.length, 1, "one series per name");
  assertEquals(g[0]!.owner, "first", "first owner wins");
  assertEquals(g[0]!.value, 1, "the impostor's reader is never called");
});

Deno.test("ledger: a reader that throws reports unknown, not a crash", () => {
  fresh();
  registerGauge({
    name: "broken",
    owner: "o",
    unit: "count",
    kind: "level",
    read: () => {
      throw new Error("mid-teardown");
    },
  });
  const g = readGauges();
  assertEquals(g.length, 1);
  assertEquals(g[0]!.value, -1, "reported as unknown rather than thrown");
});

Deno.test("ledger: past the cap, a new name is ignored (a cap that will not evict silently)", () => {
  fresh();
  for (let i = 0; i < 64; i++) {
    registerGauge({
      name: `g${i}`,
      owner: "o",
      unit: "count",
      kind: "level",
      read: () => i,
    });
  }
  registerGauge({
    name: "one-too-many",
    owner: "o",
    unit: "count",
    kind: "level",
    read: () => 1,
  });
  const g = readGauges();
  assertEquals(g.length, 64);
  assertEquals(g.some((x) => x.name === "one-too-many"), false);
});

// ── budget ─────────────────────────────────────────────────────────

Deno.test("budget: spending below the ceiling is silent", () => {
  fresh();
  const b = budget("journal.replay.entries", 10);
  b.spend(4);
  b.spend(6);
  assertEquals(b.value(), 10);
  assertEquals(b.max, 10);
});

Deno.test("budget: crossing the ceiling throws, by name", () => {
  fresh();
  const b = budget("journal.replay.entries", 5);
  b.spend(5);
  const err = assertThrows(
    () => b.spend(1),
    Error,
    "journal.replay.entries",
  );
  // The message must say what to do, not just that it happened — a counter is
  // a control-flow bug, not a memory setting to raise.
  assertEquals(err.message.includes("passed its ceiling"), true);
  assertEquals(err.message.includes("control-flow bug"), true);
});

Deno.test("budget: a non-ceiling (0, NaN, Infinity) is refused loudly", () => {
  fresh();
  assertThrows(() => budget("x", 0), Error, "positive ceiling");
  assertThrows(() => budget("x", Number.NaN), Error, "positive ceiling");
  assertThrows(() => budget("x", Infinity), Error, "positive ceiling");
});

Deno.test("budget: the same name shares ONE counter and ceiling", () => {
  fresh();
  const a = budget("sync.ops", 100);
  a.spend(10);
  const b = budget("sync.ops", 999); // ignored — the name already has a ceiling
  assertEquals(b.value(), 10, "no second counter");
  assertEquals(b.max, 100, "the first ceiling stands");
  assertEquals(a, b, "the same budget object");
});

Deno.test("budget: registers a COUNTER gauge carrying its ceiling", () => {
  fresh();
  const b = budget("journal.replay.entries", 50, { owner: "journal" });
  b.spend(7);
  const g = readGauges();
  assertEquals(g.length, 1);
  assertEquals(g[0]!.name, "journal.replay.entries");
  assertEquals(g[0]!.kind, "counter");
  assertEquals(g[0]!.owner, "journal");
  assertEquals(g[0]!.value, 7);
  assertEquals(g[0]!.bound, 50, "the scrape can show how close it is");
});

Deno.test("budget: reset() rewinds the counter, not the ceiling", () => {
  fresh();
  const b = budget("x", 10);
  b.spend(9);
  assertEquals(b.reset(), 0);
  assertEquals(b.value(), 0);
  assertEquals(b.max, 10);
  b.spend(10); // the ceiling is unchanged
  assertThrows(() => b.spend(1), Error, "passed its ceiling");
});

Deno.test("ledger: _resetMemoryLedger drops gauges AND their counters", () => {
  fresh();
  const b = budget("x", 10);
  b.spend(10);
  _resetMemoryLedger();
  assertEquals(readGauges().length, 0);
  // A handle held across the reset is NOT grandfathered: it still enforces its
  // ceiling, and the series it registers is fresh (this is what lets a test
  // isolate without leaking a spent counter into the next case).
  assertThrows(() => b.spend(1), Error, "passed its ceiling");
});

// ── the real wiring: a replay registers its bounded counter ────────

Deno.test("ledger: replaying the journal registers its bounded counter", async () => {
  fresh();
  const { replayJournal } = await import("../src/server/journal.ts");
  const out = replayJournal({}, [], (s: unknown) => ({ state: s }));
  assertEquals(out.replayed, 0);
  const g = readGauges().find((x) => x.name === "journal.replay.entries");
  assertExists(g, "a replay must register the series it spends against");
  assertEquals(g!.owner, "journal");
  assertEquals(g!.kind, "counter");
  assertEquals(g!.unit, "count");
  assertEquals(g!.bound, 2_000_000, "the ceiling is visible to a scrape");
});
