// risoto 2026-07-26 — best-effort subsystems can fail forever, silently. The
// nft-cache degraded by design (console.error + refetch), so a permanently
// broken open produced hours of stderr and ZERO in-app signal. One failure is
// routine; the same failure repeating is a dead feature, and that transition is
// what has to be reported — once, not per occurrence.
import { assert, assertEquals } from "@std/assert";
import {
  _resetDegraded,
  degraded,
  degradedReport,
} from "../src/diagnostics/degraded.ts";
import {
  diagSubscribe,
  initDiagnosticBus,
} from "../src/diagnostics/diagnostic-bus.ts";

function capture<T>(fn: () => T): { result: T; events: string[] } {
  const events: string[] = [];
  initDiagnosticBus(true);
  const off = diagSubscribe((e) => events.push(e.type));
  try {
    return { result: fn(), events };
  } finally {
    off();
  }
}

Deno.test("degraded: escalates ONCE at the threshold, never per failure", () => {
  _resetDegraded();
  const { events } = capture(() => {
    const d = degraded("cache", { after: 3 });
    d.fail(new Error("boom"));
    d.fail(new Error("boom"));
    assertEquals(d.isDegraded, false, "two failures is bad luck, not a signal");
    d.fail(new Error("boom"));
    assertEquals(
      d.isDegraded,
      true,
      "the third makes it a state, not an event",
    );
    for (let i = 0; i < 20; i++) d.fail(new Error("boom"));
    assertEquals(d.failures, 23);
  });
  assertEquals(
    events.filter((e) => e === "degraded:cache").length,
    1,
    `exactly one escalation for 23 failures, got ${events.join(",")}`,
  );
  _resetDegraded();
});

Deno.test("degraded: a success ends the episode and reports recovery", () => {
  _resetDegraded();
  const { events } = capture(() => {
    const d = degraded("cache", { after: 2 });
    d.fail("x");
    d.fail("x");
    assertEquals(degradedReport().length, 1, "visible while degraded");
    d.ok();
    assertEquals(d.failures, 0);
    assertEquals(d.isDegraded, false);
    assertEquals(degradedReport().length, 0, "gone from the report");
    d.ok(); // idempotent — no second recovery event
  });
  assertEquals(events.filter((e) => e.startsWith("degraded:")).length, 1);
  assertEquals(
    events.filter((e) => e.startsWith("degraded-recovered:")).length,
    1,
  );
  _resetDegraded();
});

Deno.test("degraded: the counter is CONSECUTIVE — a success in between resets it", () => {
  _resetDegraded();
  const { events } = capture(() => {
    const d = degraded("flaky", { after: 3 });
    d.fail("a");
    d.fail("a");
    d.ok(); // recovered before the threshold — nothing was ever escalated
    d.fail("a");
    d.fail("a");
    assertEquals(
      d.isDegraded,
      false,
      "an intermittent failure is not degraded",
    );
  });
  assertEquals(
    events.length,
    0,
    `no events for intermittent failures: ${events}`,
  );
  _resetDegraded();
});

Deno.test("degraded: guard() keeps best-effort control flow, minus the silence", async () => {
  _resetDegraded();
  const d = degraded("open", { after: 2 });
  assertEquals(await d.guard(() => 42), 42, "success passes the value through");
  assertEquals(
    await d.guard(() => {
      throw new Error("no file");
    }),
    undefined,
    "failure resolves undefined — the caller still degrades gracefully",
  );
  assertEquals(d.failures, 1);
  await d.guard(async () => {
    await Promise.resolve();
    throw new Error("no file");
  });
  assert(d.isDegraded, "…but it is now on the record");
  const [entry] = degradedReport();
  assertEquals(entry!.name, "open");
  assertEquals(entry!.lastError, "no file");
  await d.guard(() => 1);
  assertEquals(degradedReport().length, 0);
  _resetDegraded();
});

Deno.test("degraded: the same name is the same tracker across call sites", () => {
  _resetDegraded();
  degraded("shared", { after: 2 }).fail("x");
  const other = degraded("shared");
  other.fail("x");
  assert(other.isDegraded, "a module-level handle and a local one agree");
  _resetDegraded();
});
