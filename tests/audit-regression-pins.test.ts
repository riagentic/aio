// Pins for the 5.2 audit fixes (2026-07-17) —
// each test locks a fixed behavior so the bug class stays dead. The dispatch
// reject-on-reducer-error contract is pinned in tests/dispatch.test.ts.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { createHLC } from "../src/sync/hlc.ts";
import type { HLC } from "../src/sync/types.ts";
import { cell } from "../src/state/cell-create.ts";
import { schedule } from "../src/state/schedule.ts";
import { createScheduleManager } from "../src/state/schedule.ts";

// ── hlc.ts — monotonic now(), drift rejection ────────────────

Deno.test("audit: HLC now() is strictly monotonic within one millisecond", () => {
  const clock = createHLC("node-a", () => 1000);
  const a = clock.now();
  const b = clock.now();
  const c = clock.tick();
  assert(
    a[1] < b[1] && b[1] < c[1],
    `counters must advance: ${a[1]}, ${b[1]}, ${c[1]}`,
  );
});

Deno.test("audit: HLC receive() rejects wall-clock drift beyond maxDrift", () => {
  const clock = createHLC("node-a", () => 1000, 60_000);
  const farFuture: HLC = [1000 + 3_600_000, 0, "attacker"];
  clock.receive(farFuture);
  const next = clock.now();
  assert(
    next[0] < 1000 + 60_000,
    `local clock must not be hijacked forward: ${next[0]}`,
  );
  // A remote within tolerance still merges normally.
  const near: HLC = [1500, 7, "peer"];
  clock.receive(near);
  const after = clock.now();
  assertEquals(after[0], 1500, "in-tolerance remote advances the clock");
});

// ── cell-create.ts — name + state validation ─────────────────

Deno.test("audit: cell() rejects invalid names at definition time", () => {
  for (
    const bad of [
      "",
      "__proto__",
      "constructor",
      "prototype",
      "has space",
      "1abc",
      "a:b",
    ]
  ) {
    assertThrows(
      () => cell(bad, { state: { n: 0 }, methods: {} }),
      Error,
      "invalid name",
      `name ${JSON.stringify(bad)} must be rejected`,
    );
  }
  // Identifier-safe names with hyphens stay valid.
  const ok = cell("audit-ok_1", { state: { n: 0 }, methods: {} });
  assertEquals(ok.__aio.id, "audit-ok_1");
});

Deno.test("audit: cell() rejects non-object state at definition time", () => {
  for (const bad of [42, "str", true, [1, 2]]) {
    assertThrows(
      // deno-lint-ignore no-explicit-any
      () =>
        cell(`audit-bad-state-${typeof bad}`, {
          state: bad as any,
          methods: {},
        }),
      Error,
      "plain object",
    );
  }
});

// ── cell-reactive.ts — duplicate registration warns in dev ───

Deno.test("audit: duplicate cell name warns loudly in dev mode", () => {
  const g = globalThis as Record<string, unknown>;
  const prevDev = g.__aioDev;
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a.join(" "));
  try {
    g.__aioDev = true;
    cell("audit-dup", { state: { a: 1 }, methods: {} });
    cell("audit-dup", { state: { b: 2 }, methods: {} });
    assert(
      warns.some((w) => w.includes("duplicate cell name 'audit-dup'")),
      `expected duplicate warning, got: ${warns.join("\n")}`,
    );
  } finally {
    console.warn = orig;
    g.__aioDev = prevDev;
  }
});

// ── schedule.ts — dynamic+dynamic same-id replacement warns ──

Deno.test("audit: two repeating schedules with one id warn once", async () => {
  const warns: string[] = [];
  const logger = {
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: () => {},
    debug: () => {},
  };
  const mgr = createScheduleManager(() => {}, logger);
  mgr.handle(schedule.every("audit-cleanup", 60_000, { type: "A" }));
  mgr.handle(schedule.every("audit-cleanup", 60_000, { type: "B" }));
  mgr.handle(schedule.every("audit-cleanup", 60_000, { type: "C" }));
  assertEquals(
    warns.filter((m) => m.includes("audit-cleanup")).length,
    1,
    "replacement warns exactly once per id",
  );
  // One-shot re-scheduling (replace semantics) stays silent.
  mgr.handle(schedule.after("audit-debounce", 60_000, { type: "D" }));
  mgr.handle(schedule.after("audit-debounce", 60_000, { type: "E" }));
  assertEquals(
    warns.filter((m) => m.includes("audit-debounce")).length,
    0,
    "after() same-id replace is the documented debounce pattern",
  );
  mgr.cancelAll();
  await Promise.resolve();
});
