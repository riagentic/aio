// A malformed `schedules:` entry is refused while it is still CONFIG.
//
// tests/schedule.test.ts pins the validator itself. This pins the WIRING —
// that `aio.run()` actually calls it, and calls it early enough. Without this
// file, deleting the call from src/server/aio.ts leaves every validator test
// green while the app goes back to the old behaviour: `every: "5m"` threw out
// of scheduleManager.start() only after persistence was open, the port bound,
// cell init run and `started` logged (a half-started app, restarted forever by
// a supervisor), and a bare-string `action:` was not caught at all — it
// detonated on the first tick, which for an `at`/`cron` entry can be days
// after the deploy that broke it.
import { assert, assertRejects, assertStringIncludes } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";

const PORT = freePort();

/** Nothing is listening — so the refusal beat the server to it. */
function portIsFree(port: number): boolean {
  try {
    Deno.listen({ port }).close();
    return true;
  } catch {
    return false;
  }
}

Deno.test("aio.run: a bad schedule is refused before the port is bound", async () => {
  const { cell, aio } = await import("../mod.ts");
  const dir = Deno.makeTempDirSync();
  const jobs = cell("schedcfgjobs", {
    state: { n: 0 },
    methods: {
      tick(s: { n: number }) {
        s.n++;
      },
    },
  });

  const err = await assertRejects(
    () =>
      aio.run({
        cells: [jobs],
        appId: "test-sched-config",
        client: "server-only",
        persist: false,
        libraryMode: true,
        singleton: false,
        port: PORT,
        baseDir: dir,
        dbPath: ":memory:",
        // The exact shape a field report shipped: a duration string, which
        // slips past every numeric comparison ("1s" < 10 is false).
        schedules: [
          { id: "tick", every: "1s", action: { type: "schedcfgjobs:tick" } },
        ] as unknown as never,
      }),
    Error,
  );

  assertStringIncludes(err.message, "schedules 'tick'.every");
  assertStringIncludes(err.message, "300_000");
  assert(portIsFree(PORT), "run() bound the port before refusing the schedule");
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("aio.run: a bare-string action is refused at boot, not on the first tick", async () => {
  const { cell, aio } = await import("../mod.ts");
  const dir = Deno.makeTempDirSync();
  const jobs = cell("schedcfgjobs2", {
    state: { n: 0 },
    methods: {
      tick(s: { n: number }) {
        s.n++;
      },
    },
  });
  const port = freePort();

  const err = await assertRejects(
    () =>
      aio.run({
        cells: [jobs],
        appId: "test-sched-config-2",
        client: "server-only",
        persist: false,
        libraryMode: true,
        singleton: false,
        port,
        baseDir: dir,
        dbPath: ":memory:",
        schedules: [
          { id: "tick", every: 1000, action: "schedcfgjobs2:tick" },
        ] as unknown as never,
      }),
    Error,
  );

  assertStringIncludes(err.message, "schedules 'tick'.action");
  assertStringIncludes(err.message, "cell.method.action()");
  assert(portIsFree(port), "run() bound the port before refusing the schedule");
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("aio.run: a schedules: value that is not a list is refused, not skipped", async () => {
  // The call site guarded on `schedules?.length`, so an OBJECT — which has no
  // length — was skipped entirely and the config silently did nothing. The
  // guard is on presence now, and the validator checks the container.
  const { aio, cell } = await import("../mod.ts");
  const c = cell("schedcfgshape", { state: { n: 0 }, methods: {} });
  const dir = Deno.makeTempDirSync();
  try {
    const err = await assertRejects(() =>
      aio.run({
        cells: [c],
        appId: `sched-shape-${Deno.pid}`,
        client: "server-only",
        persist: false,
        libraryMode: true,
        port: 0,
        baseDir: dir,
        schedules: { id: "tick", every: 1000 },
      } as never)
    );
    assertStringIncludes((err as Error).message, "not an array");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
