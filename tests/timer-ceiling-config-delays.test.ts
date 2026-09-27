// A delay past setTimeout's int32 ceiling (2^31-1 ms ≈ 24.8 days) fires in
// ~1 ms: a 30-day poll interval, persist debounce or vitals heartbeat became a
// hot loop. The instrument: no timer is ever ARMED past the ceiling.
import { assert, assertEquals } from "@std/assert";
import { until } from "../src/state/async-helpers.ts";
import { MAX_TIMER_DELAY } from "../src/state/timer-ceiling.ts";
import { startVitalsCheck } from "../src/server/aio-run-helpers.ts";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { clampTimerDelays } from "../src/server/config.ts";
import { _getCallTimeouts } from "../src/state/cell-impl.ts";
import { captureConsole, captureConsoleAsync } from "./console-capture.ts";

const DAYS_30 = 30 * 86_400_000;

/** Run `fn` recording every delay handed to setTimeout/setInterval. */
async function armedDelays(
  fn: () => Promise<void> | void,
  ids: number[] = [],
): Promise<number[]> {
  const seen: number[] = [];
  const st = globalThis.setTimeout, si = globalThis.setInterval;
  // deno-lint-ignore no-explicit-any
  const wrap = (orig: any) => (cb: any, ms?: number, ...a: any[]) => {
    seen.push(ms ?? 0);
    const id = orig(cb, ms, ...a);
    ids.push(id);
    return id;
  };
  globalThis.setTimeout = wrap(st) as typeof setTimeout;
  globalThis.setInterval = wrap(si) as typeof setInterval;
  try {
    await fn();
  } finally {
    globalThis.setTimeout = st;
    globalThis.setInterval = si;
  }
  return seen;
}

const past = (d: number[]) => d.filter((ms) => ms > MAX_TIMER_DELAY);

Deno.test("until({ intervalMs: 30 days }) polls no faster than the ceiling", async () => {
  const ids: number[] = [];
  const d = await armedDelays(() => {
    // Never settles: its only poll is 24.8 days away. The timer is cleared
    // below; the pending promise holds nothing.
    void until(() => false, { intervalMs: DAYS_30 });
  }, ids);
  ids.forEach(clearInterval);
  assertEquals(past(d), []);
});

Deno.test("startVitalsCheck({ heartbeatInterval: 30 days }) is not a hot loop", async () => {
  let t: ReturnType<typeof setInterval> | undefined;
  const d = await armedDelays(() => {
    t = startVitalsCheck({
      // deno-lint-ignore no-explicit-any
      vitalsSystem: { loopProbe: {}, checkAndAlert() {} } as any,
      heartbeatInterval: DAYS_30,
      dispatch: { getQueueDepth: () => 0, getEffectBacklog: () => 0 },
      getState: () => ({}),
    });
  });
  clearInterval(t);
  assertEquals(past(d), []);
});

Deno.test("persistDebounceMs: 30 days never arms a timer past the ceiling", async () => {
  const dir = await tempDir("aio-persist-ceiling-");
  _resetAioRuntime();
  const c = cell("pc", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });
  // deno-lint-ignore no-explicit-any
  let app: any;
  try {
    const d = await armedDelays(async () => {
      app = await aio.run({
        cells: [c],
        appId: "persist-ceiling",
        dbPath: `${dir}/data.db`,
        persistDebounceMs: DAYS_30,
        libraryMode: true,
        client: "server-only",
        baseDir: dir,
        // deno-lint-ignore no-explicit-any
      } as any);
      await c.inc();
    });
    assert(d.length > 0, "the instrument saw no timer at all");
    assertEquals(past(d), []);
  } finally {
    await app?.close();
    await dropTempDir(dir);
  }
});

Deno.test("clampTimerDelays: every config delay past the ceiling is clamped, and said", () => {
  let out: ReturnType<typeof clampTimerDelays> | undefined;
  const lines = captureConsole(() => {
    out = clampTimerDelays({
      effectTimeoutMs: DAYS_30,
      syncIntervalMs: DAYS_30,
      persistDebounceMs: DAYS_30,
      perfBudget: {
        methods: { slow: { timeout: DAYS_30 }, w: { timeout: "warn" } },
      },
    });
  });
  assertEquals(out, {
    effectTimeoutMs: MAX_TIMER_DELAY,
    syncIntervalMs: MAX_TIMER_DELAY,
    persistDebounceMs: MAX_TIMER_DELAY,
    perfBudget: {
      methods: { slow: { timeout: MAX_TIMER_DELAY }, w: { timeout: "warn" } },
    },
  });
  const warned = lines.join("\n");
  for (
    const key of [
      "effectTimeoutMs",
      "syncIntervalMs",
      "persistDebounceMs",
      'perfBudget.methods["slow"].timeout',
    ]
  ) {
    assert(
      warned.includes(`${key}: ${DAYS_30}`),
      `no warning names ${key}: ${warned}`,
    );
  }
});

Deno.test("clampTimerDelays: in-range delays pass through without a word", () => {
  const cfg = {
    effectTimeoutMs: 5_000,
    syncIntervalMs: MAX_TIMER_DELAY,
    persistDebounceMs: 0,
  };
  let out: unknown;
  const lines = captureConsole(() => {
    out = clampTimerDelays(cfg);
  });
  assertEquals(out, cfg);
  assertEquals(lines, []);
});

Deno.test("aio.run: 30-day effectTimeoutMs / perfBudget timeout / syncIntervalMs reach no timer and no page ceiling", async () => {
  const dir = await tempDir("aio-config-ceiling-");
  _resetAioRuntime();
  const c = cell("cc", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });
  // deno-lint-ignore no-explicit-any
  let app: any;
  try {
    let d: number[] = [];
    const lines = await captureConsoleAsync(async () => {
      d = await armedDelays(async () => {
        app = await aio.run({
          cells: [c],
          appId: "config-ceiling",
          dbPath: `${dir}/data.db`,
          effectTimeoutMs: DAYS_30,
          syncIntervalMs: DAYS_30,
          perfBudget: { methods: { "cc:inc": { timeout: DAYS_30 } } },
          libraryMode: true,
          client: "server-only",
          baseDir: dir,
          // deno-lint-ignore no-explicit-any
        } as any);
        await c.inc();
      });
    });
    assert(d.length > 0, "the instrument saw no timer at all");
    assertEquals(past(d), []);
    const t = _getCallTimeouts();
    assertEquals(t.default, MAX_TIMER_DELAY);
    assertEquals(t.methods?.["cc:inc"], MAX_TIMER_DELAY);
    assert(
      lines.some((l) => l.includes(`syncIntervalMs: ${DAYS_30}`)),
      `no warning for syncIntervalMs: ${lines.join("\n")}`,
    );
  } finally {
    await app?.close();
    await dropTempDir(dir);
  }
});
