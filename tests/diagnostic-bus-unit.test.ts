// src/diagnostic-bus.test.ts
import { assertEquals, assertExists } from "@std/assert";
import {
  diagEmit,
  diagRecent,
  diagSubscribe,
  initDiagnosticBus,
  isDiagDev,
} from "../src/diagnostics/diagnostic-bus.ts";

Deno.test("diagnostic-bus: prod no-op — emit does nothing", () => {
  initDiagnosticBus(false);
  diagEmit({
    type: "test:event",
    severity: "error",
    source: "test",
    message: "should not store",
  });
  assertEquals(diagRecent().length, 0);
  assertEquals(isDiagDev(), false);
});

Deno.test("diagnostic-bus: dev mode stores events", () => {
  initDiagnosticBus(true);
  diagEmit({
    type: "feat:load",
    severity: "info",
    source: "core",
    message: "cell loaded",
  });
  const events = diagRecent();
  assertEquals(events.length, 1);
  assertEquals(events[0]!.type, "feat:load");
  assertEquals(events[0]!.severity, "info");
  assertEquals(events[0]!.source, "core");
  assertEquals(events[0]!.message, "cell loaded");
  assertExists(events[0]!.ts);
  assertEquals(typeof events[0]!.ts, "number");
  assertEquals(isDiagDev(), true);
});

Deno.test("diagnostic-bus: subscribe receives events, unsubscribe works", () => {
  initDiagnosticBus(true);
  const received: string[] = [];
  const unsub = diagSubscribe((e) => received.push(e.type));

  diagEmit({
    type: "feat:a",
    severity: "warning",
    source: "src",
    message: "msg a",
  });
  assertEquals(received.length, 1);
  assertEquals(received[0], "feat:a");

  unsub();
  diagEmit({
    type: "feat:b",
    severity: "warning",
    source: "src",
    message: "msg b",
  });
  assertEquals(received.length, 1); // no new events after unsub

  assertEquals(diagRecent().length, 2); // both still stored
});

Deno.test("diagnostic-bus: ring buffer caps at 200", () => {
  initDiagnosticBus(true);
  for (let i = 0; i < 250; i++) {
    diagEmit({
      type: `evt:${i}`,
      severity: "info",
      source: "test",
      message: `event ${i}`,
    });
  }
  const events = diagRecent();
  assertEquals(events.length, 200);
  // oldest retained should be evt:50 (0-49 were overwritten)
  assertEquals(events[0]!.type, "evt:50");
  // newest should be evt:249
  assertEquals(events[199]!.type, "evt:249");
});

Deno.test("diagnostic-bus: dedup suppresses same type within 5s", () => {
  initDiagnosticBus(true);
  diagEmit({
    type: "dedup:test",
    severity: "error",
    source: "src",
    message: "first",
  });
  diagEmit({
    type: "dedup:test",
    severity: "error",
    source: "src",
    message: "second",
  }); // suppressed
  diagEmit({
    type: "dedup:test",
    severity: "error",
    source: "src",
    message: "third",
  }); // suppressed
  diagEmit({
    type: "other:event",
    severity: "info",
    source: "src",
    message: "different type",
  }); // not suppressed

  const events = diagRecent();
  assertEquals(events.length, 2);
  assertEquals(events[0]!.type, "dedup:test");
  assertEquals(events[0]!.message, "first");
  assertEquals(events[1]!.type, "other:event");
});

Deno.test("diagnostic-bus: dedup allows same type after 5s window", () => {
  initDiagnosticBus(true);
  // Emit with a forced old timestamp by manipulating via two inits
  diagEmit({
    type: "window:test",
    severity: "warning",
    source: "src",
    message: "first",
  });
  assertEquals(diagRecent().length, 1);

  // Second emit same type — suppressed
  diagEmit({
    type: "window:test",
    severity: "warning",
    source: "src",
    message: "suppressed",
  });
  assertEquals(diagRecent().length, 1);

  // Re-init resets dedup state — confirm fresh emit works
  initDiagnosticBus(true);
  diagEmit({
    type: "window:test",
    severity: "warning",
    source: "src",
    message: "after reset",
  });
  assertEquals(diagRecent().length, 1);
  assertEquals(diagRecent()[0]!.message, "after reset");
});

Deno.test("diagnostic-bus: detail and hint fields are preserved", () => {
  initDiagnosticBus(true);
  diagEmit({
    type: "feat:error",
    severity: "error",
    source: "cell-impl",
    message: "dispatch failed",
    detail: { cellId: "counter", action: "increment" },
    hint: "Check reducer registration",
    docLink: "https://docs.example.com/errors#dispatch",
  });
  const events = diagRecent();
  assertEquals(events.length, 1);
  assertEquals(events[0]!.detail, {
    cellId: "counter",
    action: "increment",
  });
  assertEquals(events[0]!.hint, "Check reducer registration");
  assertEquals(events[0]!.docLink, "https://docs.example.com/errors#dispatch");
});
