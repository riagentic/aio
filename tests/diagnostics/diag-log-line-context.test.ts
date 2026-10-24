// The diagnostic bus → logger bridge wrote only the MESSAGE: error.log read
// `ERROR diag {"code":"E_QUOTA"}` — no event type, no action — and an event
// whose dedup window had swallowed 40 copies logged as one.
import { assertEquals } from "@std/assert";
import { initDiagnostics } from "../../src/diagnostics/mod.ts";
import {
  diagEmit,
  initDiagnosticBus,
} from "../../src/diagnostics/diagnostic-bus.ts";
import { getLogger, setLogger } from "../../src/diagnostics/logger-api.ts";
import type { LogLevel, LogSink } from "../../src/diagnostics/logger-types.ts";
import { dropTempDir, tempDir } from "../../src/testing/temp-dir.ts";

Deno.test("diag → log: the line names the event type, the action and what dedup swallowed", async () => {
  const dir = await tempDir("aio-diag-line-");
  const lines: { lvl: LogLevel; cat: string; msg: string; data?: unknown }[] =
    [];
  const prev = getLogger();
  setLogger({
    logDir: dir,
    pub(lvl: LogLevel, cat: string, msg: string, data?: unknown) {
      if (cat === "diag") lines.push({ lvl, cat, msg, data });
    },
    perf() {},
    flush: () => Promise.resolve(),
  } as unknown as LogSink);
  initDiagnosticBus(true);
  const hooks = initDiagnostics(
    { dev: { crashHandler: false, checkpoint: false, actionLog: false } },
    false,
    dir,
  )!;
  try {
    const ev = {
      type: "reduce-error",
      severity: "error" as const,
      source: "reduce",
      message: "boom",
      detail: { actionType: "big:boom", cellName: "big" },
    };
    diagEmit(ev);
    diagEmit(ev); // inside the dedup window: swallowed, counted
    diagEmit(ev);
    assertEquals(lines.length, 1);
    assertEquals(lines[0]!.data, { type: "reduce-error", action: "big:boom" });
    // The next one through, after the window, carries the count.
    const realNow = Date.now;
    const later = realNow() + 6_000;
    Date.now = () => later;
    try {
      diagEmit(ev);
    } finally {
      Date.now = realNow;
    }
    assertEquals(lines.length, 2);
    assertEquals(lines[1]!.data, {
      type: "reduce-error",
      action: "big:boom",
      suppressed: 2,
    });
  } finally {
    await hooks.onStop();
    setLogger(prev);
    initDiagnosticBus(false);
    await dropTempDir(dir);
  }
});
