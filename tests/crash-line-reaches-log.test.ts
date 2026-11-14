// The crash handler's last words never reached app.log / error.log: it logs
// through the BUFFERED file logger (250 ms timer), whose exit flush rides on
// `unload` — and Deno 2.9 ends the process on an uncaught error, or an
// unhandled rejection nothing prevents, WITHOUT firing `unload`. So a compiled
// or service app (console off) kept no record of its crash, and `am status`
// (`crashOfLog`) read the crash as a kill. The handler now flushes the
// loggers synchronously when the fault is fatal. Child processes, because the
// failure is the death.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { crashOfLog } from "../src/am/am-cmd-status.ts";
import { installCrashHandler } from "../src/diagnostics/crash-handler.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ENTRY = new URL("./fixtures/crash-after-boot-app.ts", import.meta.url);
const CONFIG = new URL("../deno.json", import.meta.url);

async function read(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return "";
    throw e;
  }
}

for (
  const [mode, label, cause] of [
    ["throw", "uncaughtException", "sync boom after boot"],
    ["rej-noguard", "unhandledrejection", "rejection boom after boot"],
  ] as const
) {
  Deno.test(`crash handler: a fatal ${label} reaches app.log and error.log`, async () => {
    const home = await tempDir("aio-crash-line-");
    try {
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          fromFileUrl(CONFIG),
          ENTRY.href,
          mode,
          `--home=${home}`,
          `--port=${freePort()}`,
        ],
        env: { NO_COLOR: "1" },
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      const out = await child.output();
      clearTimeout(killer);
      const stderr = new TextDecoder().decode(out.stderr);
      assert(out.code !== 0, `the process should have died:\n${stderr}`);
      const app = await read(join(home, "logs", "app.log"));
      const err = await read(join(home, "logs", "error.log"));
      const ctx = `app.log:\n${app}\nerror.log:\n${err}\nstderr:\n${
        stderr.slice(-1500)
      }`;
      assertStringIncludes(app, "started", ctx);
      assertStringIncludes(app, `[crash-handler] ${label}: ${cause}`, ctx);
      assertStringIncludes(err, `[crash-handler] ${label}: ${cause}`, ctx);
      // …and so `am status` reads it as the crash it was, not a kill.
      assertEquals(
        crashOfLog(app),
        `crash [crash-handler] ${label}: ${cause}`,
        ctx,
      );
    } finally {
      await dropTempDir(home);
    }
  });
}

// Which faults flush: exactly the fatal ones. A rejection the guard survives
// is not a death — the timer writes it like any other line.
Deno.test("crash handler: flushSync runs after the line, only when the fault is fatal", () => {
  const cases: {
    name: string;
    guard: boolean;
    booted: boolean;
    ev: () => Event;
    flushes: boolean;
  }[] = [
    {
      name: "uncaught error",
      guard: true,
      booted: true,
      ev: () => new ErrorEvent("error", { error: new Error("e") }),
      flushes: true,
    },
    ...[[false, true, true], [true, false, true], [true, true, false]].map(
      ([guard, booted, flushes]) => ({
        name: `rejection guard=${guard} booted=${booted}`,
        guard: guard!,
        booted: booted!,
        ev: () =>
          new PromiseRejectionEvent("unhandledrejection", {
            promise: Promise.resolve() as Promise<never>,
            reason: new Error("r"),
          }),
        flushes: flushes!,
      }),
    ),
  ];
  assertEquals(cases.length, 4);
  for (const c of cases) {
    const order: string[] = [];
    const uninstall = installCrashHandler({
      log: { error: () => order.push("log") },
      getHealthData: () => ({ cells: {} }),
      writeEmergencyCheckpoint: () => {},
      guardRejections: c.guard,
      isBootComplete: () => c.booted,
      flushSync: () => order.push("flush"),
    });
    try {
      globalThis.dispatchEvent(c.ev());
    } finally {
      uninstall();
    }
    assertEquals(order, c.flushes ? ["log", "flush"] : ["log"], c.name);
  }
});
