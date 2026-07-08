// src/error.test.ts
import { assertEquals } from "@std/assert";
import {
  createAioError,
  reportError,
  setDiagEmit,
} from "../src/diagnostics/error.ts";

Deno.test("reportError emits to diagnostic bus when wired via setDiagEmit", () => {
  const captured: Array<{ type: string; severity: string; source: string }> =
    [];
  setDiagEmit((ev) =>
    captured.push({
      type: ev.type,
      severity: ev.severity as string,
      source: ev.source,
    })
  );

  const err = createAioError("REDUCE_ERROR", "test", { actionType: "foo:bar" });
  reportError(err);

  assertEquals(captured.length, 1);
  assertEquals(captured[0]!.type, "reduce-error");
  assertEquals(captured[0]!.severity, "error");
  assertEquals(captured[0]!.source, "reduce");

  // Clean up
  setDiagEmit(null as unknown as Parameters<typeof setDiagEmit>[0]);
});

Deno.test("reportError emits warning severity for WARN_CODES", () => {
  const captured: Array<{ type: string; severity: string }> = [];
  setDiagEmit((ev) =>
    captured.push({ type: ev.type, severity: ev.severity as string })
  );

  const err = createAioError("MACHINE_BLOCKED", "blocked", {
    machineState: "idle",
  });
  reportError(err);

  assertEquals(captured.length, 1);
  assertEquals(captured[0]!.severity, "warning");
  assertEquals(captured[0]!.type, "machine-blocked");

  setDiagEmit(null as unknown as Parameters<typeof setDiagEmit>[0]);
});

Deno.test("PERSIST_ERROR has correct source and tip", () => {
  const err = createAioError("PERSIST_ERROR", "disk full", {});
  assertEquals(err.source, "persist");
  assertEquals(err.code, "PERSIST_ERROR");
});
