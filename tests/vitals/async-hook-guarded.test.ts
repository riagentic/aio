// An ASYNC vitals hook that rejects is guarded like a sync one that throws.
//
// `onDiagnostic: async (e) => { await pager.send(e) }` type-checks against the
// `void` return, and its rejection escaped the try/catch around the call: an
// unhandled rejection from a timer-driven probe, with no line saying which
// hook failed. Same rule and same line as `onError` (tests/onerror-async-
// hook-guarded.test.ts): reported at the sync throw's level, never unhandled.
import { assertEquals } from "@std/assert";
import { createVitalsSystem } from "../../src/vitals/mod.ts";
import { createPressureMonitor } from "../../src/vitals/pressure-monitor.ts";
import { setLogger } from "../../src/diagnostics/logger-api.ts";
import type { LogSink } from "../../src/diagnostics/logger-types.ts";

function captureLog() {
  const lines: { lvl: string; msg: string }[] = [];
  setLogger(
    {
      pub: (lvl: string, _cat: string, msg: string) => lines.push({ lvl, msg }),
    } as unknown as LogSink,
  );
  return { lines, [Symbol.dispose]: () => setLogger(null) };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const rejecting = () => Promise.reject(new Error("pager is down"));

Deno.test("vitals: a rejecting onVitalAlert / onDiagnostic is reported, not unhandled", async () => {
  using log = captureLog();
  const sys = createVitalsSystem({
    onVitalAlert: rejecting as unknown as () => void,
    onDiagnostic: rejecting as unknown as () => void,
  });
  try {
    sys.loopProbe.updateQueueDepth(1500); // over the frozen threshold
    sys.checkAndAlert();
    await tick();
    await tick();
  } finally {
    sys.destroy();
  }
  const hit = (name: string) =>
    log.lines.filter((l) =>
      l.msg.includes(`${name} hook threw`) && l.msg.includes("pager is down")
    );
  assertEquals(hit("onVitalAlert").length, 1, JSON.stringify(log.lines));
  assertEquals(hit("onVitalAlert")[0]!.lvl, "error", "same as a sync throw");
  assertEquals(hit("onDiagnostic").length, 1, JSON.stringify(log.lines));
});

Deno.test("vitals: the pressure monitor's rejecting onDiagnostic is reported, not unhandled", async () => {
  using log = captureLog();
  const pm = createPressureMonitor({
    payloadThreshold: 100,
    onDiagnostic: rejecting as unknown as () => void,
    onConsole: () => {},
  });
  try {
    pm.onBroadcast("client-1", 150);
    await tick();
    await tick();
  } finally {
    pm.destroy();
  }
  const hit = log.lines.filter((l) =>
    l.msg.includes("onDiagnostic hook threw") && l.msg.includes("pager is down")
  );
  assertEquals(hit.length, 1, JSON.stringify(log.lines));
});
