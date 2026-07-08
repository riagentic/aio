// src/diagnostic-bus-integration.test.ts — Integration tests for bus ↔ reportError bridge
import { assertEquals } from "@std/assert";
import {
  diagEmit,
  diagRecent,
  diagSubscribe,
  initDiagnosticBus,
} from "../src/diagnostics/diagnostic-bus.ts";
import {
  createAioError,
  reportError,
  setDiagEmit,
} from "../src/diagnostics/error.ts";

// Helper to set up bus + bridge for each test
function setupBus() {
  initDiagnosticBus(true);
  setDiagEmit(diagEmit);
}

function teardownBus() {
  setDiagEmit(null as unknown as Parameters<typeof setDiagEmit>[0]);
  initDiagnosticBus(false);
}

Deno.test("reportError auto-emits to diagnostic bus via bridge", () => {
  setupBus();
  const captured: Array<{ type: string; severity: string; source: string }> =
    [];
  diagSubscribe((ev) =>
    captured.push({ type: ev.type, severity: ev.severity, source: ev.source })
  );

  const err = createAioError("REDUCE_ERROR", "test reduce failure", {
    cellName: "counter",
    actionType: "counter:increment",
  });
  reportError(err);

  assertEquals(captured.length, 1);
  assertEquals(captured[0]!.type, "reduce-error");
  assertEquals(captured[0]!.severity, "error");
  assertEquals(captured[0]!.source, "reduce");
  teardownBus();
});

Deno.test("PERSIST_ERROR emits correct bus event", () => {
  setupBus();
  const captured: string[] = [];
  diagSubscribe((ev) => captured.push(ev.type));

  const err = createAioError("PERSIST_ERROR", "disk full", {});
  reportError(err);

  assertEquals(captured.includes("persist-error"), true);
  teardownBus();
});

Deno.test("WARN_CODES emit with warning severity", () => {
  setupBus();
  const captured: Array<{ type: string; severity: string }> = [];
  diagSubscribe((ev) =>
    captured.push({ type: ev.type, severity: ev.severity })
  );

  const err = createAioError("MACHINE_BLOCKED", "blocked", {
    machineState: "idle",
  });
  reportError(err);

  assertEquals(captured.length, 1);
  assertEquals(captured[0]!.severity, "warning");
  assertEquals(captured[0]!.type, "machine-blocked");
  teardownBus();
});

Deno.test("bus bridge is no-op when not wired", () => {
  initDiagnosticBus(true);
  setDiagEmit(null as unknown as Parameters<typeof setDiagEmit>[0]);

  const captured: string[] = [];
  diagSubscribe((ev) => captured.push(ev.type));

  const err = createAioError("REDUCE_ERROR", "test", {});
  reportError(err);

  // reportError itself doesn't crash, and no bus event emitted
  assertEquals(captured.length, 0);
  teardownBus();
});

Deno.test("standalone diagEmit works independently of reportError", () => {
  setupBus();
  const captured: string[] = [];
  diagSubscribe((ev) => captured.push(ev.type));

  diagEmit({
    type: "action-dropped",
    severity: "warning",
    source: "browser",
    message: "test action dropped",
  });

  assertEquals(captured.length, 1);
  assertEquals(captured[0], "action-dropped");

  const recent = diagRecent();
  assertEquals(recent.length >= 1, true);
  assertEquals(recent[recent.length - 1]!.type, "action-dropped");
  teardownBus();
});

Deno.test("diagRecent returns events from both bridge and standalone", () => {
  setupBus();

  // Bridge event
  const err = createAioError("EFFECT_ERROR", "clone failed", {
    actionType: "foo:bar",
  });
  reportError(err);

  // Standalone event
  diagEmit({
    type: "state-sync-error",
    severity: "error",
    source: "browser",
    message: "parse failed",
  });

  const recent = diagRecent();
  const types = recent.map((e) => e.type);
  assertEquals(types.includes("effect-error"), true);
  assertEquals(types.includes("state-sync-error"), true);
  teardownBus();
});
