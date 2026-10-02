// A stop that arrives as a signal says so BEFORE it stops anything.
//
// A desktop app's log ended `stopped uptime=204ms` with nothing above it: the
// handler went straight to the shutdown, so the one fact that explains a
// short-lived run — something outside asked it to stop, and which signal —
// was nowhere. The line is observe-only and the same in dev and production.
import { assertEquals } from "@std/assert";
import {
  _resetProcessSignals,
  _resetStopProcess,
  _setExitFn,
  installProcessSignals,
  stopProcess,
} from "../src/server/shutdown.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";

/** Run `fn` with the exit captured and every log line recorded in order. */
async function recorded(
  fn: () => Promise<void> | void,
): Promise<{ lines: string[]; exits: number[] }> {
  const lines: string[] = [];
  const exits: number[] = [];
  const prevLogger = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        lines.push(`${lvl} ${msg}`);
      },
    } as unknown as LogSink,
  );
  const restoreExit = _setExitFn((code: number) => {
    exits.push(code);
    lines.push(`exit ${code}`);
    return undefined as never;
  });
  try {
    await fn();
  } finally {
    restoreExit();
    _resetStopProcess();
    setLogger(prevLogger);
  }
  return { lines, exits };
}

Deno.test("SIGINT and SIGTERM: the handler names the signal, then stops", async () => {
  // The handlers as the process would receive them — captured, not delivered:
  // a real signal to the test runner is not this test's to send.
  const handlers = new Map<string, () => void>();
  const realAdd = Deno.addSignalListener;
  const realRemove = Deno.removeSignalListener;
  Deno.addSignalListener = (sig, h) => void handlers.set(sig, h);
  Deno.removeSignalListener = () => {};
  _resetProcessSignals();
  try {
    installProcessSignals();
    assertEquals([...handlers.keys()].sort(), ["SIGINT", "SIGTERM"]);
    for (const sig of ["SIGINT", "SIGTERM"]) {
      const seen = await recorded(async () => {
        handlers.get(sig)!();
        await stopProcess(0);
      });
      assertEquals(seen.exits, [0], sig);
      assertEquals(
        seen.lines.filter((l) => !l.startsWith("debug ")),
        [`info ${sig} received — stopping`, "exit 0"],
      );
    }
  } finally {
    _resetProcessSignals();
    Deno.addSignalListener = realAdd;
    Deno.removeSignalListener = realRemove;
  }
});

Deno.test("stopProcess: a reason is said once per ask; no reason, no line", async () => {
  const twice = await recorded(async () => {
    stopProcess(0, "SIGHUP received");
    await stopProcess(0, "SIGTERM received");
  });
  // A second ask joins the first exit — and is still said: it was received.
  assertEquals(twice.lines.filter((l) => !l.startsWith("debug ")), [
    "info SIGHUP received — stopping",
    "info SIGTERM received — stopping",
    "exit 0",
  ]);
  const bare = await recorded(async () => {
    await stopProcess(3);
  });
  assertEquals(bare.lines.filter((l) => !l.startsWith("debug ")), ["exit 3"]);
});
