// Nothing an app scheduled may fire into or after its `close()`, and a stopped
// app's logger never writes to disk again.
//
// Schedules were cancelled only in shutdown Phase 7, AFTER dispatch closed, the
// final persist and the onStop hook: an `every` tick landing in between reached
// a closed dispatch ("dispatch after close() — '…' ignored") and the warning
// went into the app's log. That line, flushed on the logger's timer after a
// test had dropped its sandbox, made the logger recreate the removed directory
// (a running logger puts a vanished log dir back, by design) — a temp dir that
// came back from the dead after its owner removed it.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import {
  AioLogger,
  closeLogger,
  flushAtExit,
  guestLogger,
} from "../src/diagnostics/logger-core.ts";
import { getLogger } from "../src/diagnostics/logger-api.ts";
import { createScheduleManager } from "../src/state/schedule.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const EVERY_MS = 10;

/** `n` firings of an `EVERY_MS` interval: an observation window counted on
 *  the same clock as the schedule, so "it did not fire" means it had every
 *  chance to. */
function intervals(n: number): Promise<void> {
  return new Promise((done) => {
    let k = 0;
    const t = setInterval(() => {
      if (++k >= n) {
        clearInterval(t);
        done();
      }
    }, EVERY_MS);
  });
}

const exists = (p: string) =>
  Deno.stat(p).then(() => true, (e) => {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  });

Deno.test("app stop: an armed `every` neither reaches the closing dispatch nor fires after close()", async () => {
  const dir = await tempDir("aio-stop-sched-");
  let beats = 0;
  let twoBeats!: () => void;
  const ticking = new Promise<void>((r) => twoBeats = r);
  const c = cell("stopsched", {
    state: { n: 0 },
    methods: {
      beat(s: { n: number }) {
        s.n++;
        if (++beats === 2) twoBeats();
      },
    },
  });
  const said: string[] = [];
  const warn = console.warn, error = console.error;
  const catchBeat = (orig: (...a: unknown[]) => void) => (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (line.includes("stopsched:beat")) said.push(line);
    else orig(...a);
  };
  console.warn = catchBeat(warn);
  console.error = catchBeat(error);
  try {
    const app = await aio.run({
      cells: [c],
      appId: "stop-sched-app",
      client: "server-only",
      libraryMode: true,
      appDir: dir,
      baseDir: dir,
      port: freePort(),
      schedules: [{
        id: "stopsched-beat",
        every: EVERY_MS,
        action: { type: "stopsched:beat" },
      }],
      // Holds the teardown open for several intervals AFTER dispatch closed:
      // the window a Phase-7-only cancel left a tick to land in.
      onStop: () => intervals(5),
      // deno-lint-ignore no-explicit-any
    } as any);
    await ticking;
    // The app's own logger, as a late callback would still hold it.
    const appLogger = getLogger();
    assert(appLogger, "the running app has a logger");
    await app.close();
    const atClose = beats;
    await dropTempDir(dir);
    appLogger.pub("warn", "app", "stopsched:beat from a late callback");
    await appLogger.flush(500);
    await intervals(10);
    assertEquals(beats, atClose, "the schedule fired after close()");
    assertEquals(
      said.filter((l) => !l.includes("late callback")),
      [],
      "a tick reached the closed dispatch",
    );
    assert(!(await exists(dir)), "the removed app dir came back");
  } finally {
    console.warn = warn;
    console.error = error;
    await dropTempDir(dir);
  }
});

Deno.test("app stop: a closed schedule manager arms nothing new, and says so once", () => {
  const warns: string[] = [];
  let armed = 0;
  const m = createScheduleManager(() => {}, {
    debug: () => {},
    info: () => {},
    warn: (s: string) => warns.push(s),
    error: () => {},
  } as never, {
    timers: {
      setTimeout: () => (armed++, 0),
      clearTimeout: () => {},
      setInterval: () => (armed++, 0),
      clearInterval: () => {},
      now: () => 0,
    } as never,
  });
  m.close();
  const every = {
    kind: "every",
    id: "late",
    ms: 50,
    action: { type: "x:y" },
  } as never;
  m.handle(every);
  m.handle(every);
  m.start([{ id: "late2", every: 50, action: { type: "x:y" } }] as never);
  assertEquals(armed, 0, "a schedule was armed after close()");
  assertEquals(m.active(), []);
  assertEquals(warns.length, 2, `one line per refused id: ${warns}`);
});

Deno.test("logger: a closed app's logger writes no file and never recreates its directory", async () => {
  const base = await tempDir("aio-log-closed-");
  const dir = join(base, "logs");
  const errors: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  const logger = new AioLogger({ dir, console: false, level: "info" });
  try {
    await logger.init();
    logger.pub("info", "app", "live line");
    await logger.flush(500);
    logger.onStop();
    await logger.flush(500);
    closeLogger(logger);
    await dropTempDir(base);
    logger.pub("warn", "app", "late line one");
    logger.pub("error", "app", "late line two");
    await logger.flush(500);
    flushAtExit(logger);
    assert(!(await exists(base)), "a closed logger recreated its directory");
    const late = errors.filter((e) => e.includes("[logger]"));
    assertEquals(late.length, 1, `one stderr line, not more: ${late}`);
    assert(late[0]?.includes("late line one"), String(late[0]));
  } finally {
    console.error = error;
    await dropTempDir(base);
  }
});

Deno.test("logger: lines still buffered when the app stops are not a reason to recreate its directory", async () => {
  const base = await tempDir("aio-log-closed-buf-");
  const dir = join(base, "logs");
  const error = console.error;
  console.error = () => {}; // the failed write is reported; not this test's point
  const logger = new AioLogger({ dir, console: false, level: "info" });
  try {
    await logger.init();
    logger.pub("info", "app", "buffered, not flushed");
    await dropTempDir(base);
    closeLogger(logger);
    await logger.flush(500);
    assert(!(await exists(base)), "closing flushed into a recreated directory");
  } finally {
    logger.onStop();
    console.error = error;
    await dropTempDir(base);
  }
});

Deno.test("logger: a stopped guest's exit write does not recreate a removed directory", async () => {
  const base = await tempDir("aio-log-closed-guest-");
  const dir = join(base, "logs");
  const error = console.error;
  console.error = () => {};
  const logger = new AioLogger({ dir, console: false, level: "info" });
  try {
    guestLogger(logger);
    logger.pub("error", "app", "the refusal, held for exit");
    closeLogger(logger);
    await dropTempDir(base);
    flushAtExit(logger);
    assert(!(await exists(base)), "the exit write recreated the directory");
  } finally {
    console.error = error;
    await dropTempDir(base);
  }
});
