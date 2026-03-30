import { assertEquals } from "@std/assert";
import {
  _diagDedupSize,
  diagEmit,
  initDiagnosticBus,
} from "../src/diagnostic-bus.ts";

Deno.test("AIO-123: _dedup Map prunes stale entries after DEDUP_WINDOW_MS", () => {
  initDiagnosticBus(true);

  // Emit 60 unique event types to exceed the prune threshold (50)
  for (let i = 0; i < 60; i++) {
    diagEmit({
      type: `dynamic:${i}`,
      severity: "info",
      source: "test",
      message: `event ${i}`,
    });
  }

  // All 60 should be in the dedup map
  assertEquals(_diagDedupSize(), 60);

  // Simulate time passing beyond the 5s dedup window by manipulating timestamps.
  // We need to use FakeTime or accept that we test via the prune trigger.
  // Instead: re-init with dev=true to reset, then use a different strategy.
  // The real test: after enough time passes + new emit, stale entries get pruned.

  // Since we can't easily fake Date.now without FakeTime, let's use Deno's
  // FakeTime from std/testing.
  initDiagnosticBus(true);

  // We'll directly test: emit 60 events with stale timestamps by using FakeTime
  // For now, just verify the size getter works and the prune logic fires.
  // Use a simpler approach: emit 60, wait 0ms (they're all "now"), emit one more.
  // Since none are stale (all just emitted), size should be 61 after threshold trigger.
  for (let i = 0; i < 60; i++) {
    diagEmit({
      type: `evt:${i}`,
      severity: "info",
      source: "test",
      message: `event ${i}`,
    });
  }
  assertEquals(_diagDedupSize(), 60);

  // None are stale yet, so prune won't remove any. Size stays 60 after one more.
  diagEmit({
    type: "evt:new",
    severity: "info",
    source: "test",
    message: "trigger prune",
  });
  // 61 entries, prune runs but nothing is stale -> still 61
  assertEquals(_diagDedupSize(), 61);
});

Deno.test("AIO-123: _dedup prunes entries older than DEDUP_WINDOW_MS", async () => {
  initDiagnosticBus(true);

  // Emit 55 unique events
  for (let i = 0; i < 55; i++) {
    diagEmit({
      type: `old:${i}`,
      severity: "info",
      source: "test",
      message: `old event ${i}`,
    });
  }
  assertEquals(_diagDedupSize(), 55);

  // Wait just over the dedup window (5s)
  await new Promise((r) => setTimeout(r, 5100));

  // Now emit one more to trigger prune — all 55 old entries are stale
  diagEmit({
    type: "fresh:0",
    severity: "info",
    source: "test",
    message: "fresh event",
  });

  // After prune: only the fresh entry should remain (old ones are stale)
  assertEquals(_diagDedupSize(), 1);
});
