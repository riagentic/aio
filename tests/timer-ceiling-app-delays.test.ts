// The app-supplied delays that do NOT pass through `clampTimerDelays` — the
// page's ack ceiling (the server's clamped budget PLUS a grace), the logger
// heartbeat, the memory monitor, the diagnostics checkpoint, a db request
// ceiling and the CLI client's ack/ready ceilings. Past setTimeout's int32
// ceiling each fired in ~1 ms: every call rejected at once, a heartbeat line
// per millisecond in app.log, a sampling loop per millisecond. The instrument
// (as in timer-ceiling-config-delays): no timer is ever ARMED past the ceiling.
import { assert, assertEquals } from "@std/assert";
import { MAX_TIMER_DELAY } from "../src/state/timer-ceiling.ts";
import {
  _registerAck,
  _resolveAck,
  _setAckGraceMs,
} from "../src/browser/browser-ack.ts";
import type { AioWindow } from "../src/protocol/protocol-types.ts";
import { AioLogger } from "../src/diagnostics/logger-core.ts";
import { createMemoryMonitor } from "../src/diagnostics/memory-monitor.ts";
import { createCheckpoint } from "../src/diagnostics/checkpoint.ts";
import { createDB } from "../src/db/async-db.ts";
import { connectCli } from "../src/server/cli-client.ts";
import { freePort } from "./e2e-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { captureConsoleAsync } from "./console-capture.ts";

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
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("page ack: a server ceiling clamped to MAX plus the grace does not reject at once", async () => {
  const w = globalThis as AioWindow;
  const prev = w.__aioConfig;
  _setAckGraceMs(5_000);
  w.__aioConfig = {
    callTimeouts: { default: MAX_TIMER_DELAY, methods: { "c:w": "warn" } },
  } as AioWindow["__aioConfig"];
  try {
    let rejected: unknown;
    const d = await armedDelays(() => {
      _registerAck("ceil-1", { methodKey: "c:m" }).catch((e) => rejected = e);
      _registerAck("ceil-2", { methodKey: "c:w" });
    });
    assertEquals(past(d), []);
    await tick(30);
    assertEquals(rejected, undefined, "the call was rejected at once");
  } finally {
    _resolveAck("ceil-1");
    _resolveAck("ceil-2");
    w.__aioConfig = prev;
  }
});

Deno.test("logging.heartbeat: 30 days is not a hot loop, and it is said", async () => {
  const dir = await tempDir("aio-hb-ceiling-");
  const l = new AioLogger({ dir, heartbeat: DAYS_30 / 1000, console: false });
  try {
    const d = await armedDelays(() => l.init());
    assertEquals(past(d), []);
    await l.flush();
    const log = await Deno.readTextFile(`${dir}/app.log`);
    assert(log.includes("logging.heartbeat"), `not said: ${log}`);
  } finally {
    l.onStop();
    await l.flush();
    await dropTempDir(dir);
  }
});

Deno.test("memory.interval: 30 days is not a hot loop, and it is said", async () => {
  let m: { stop: () => void } | undefined;
  const lines = await captureConsoleAsync(async () => {
    const d = await armedDelays(() => {
      m = createMemoryMonitor({
        enabled: true,
        interval: DAYS_30,
        warnThreshold: 0.7,
        criticalThreshold: 0.9,
        onReport: () => {},
        getMemoryUsage: () => ({
          heapUsed: 0,
          heapTotal: 1,
          rss: 0,
          external: 0,
        }),
        getHeapLimit: () => 1,
        getCellStates: () => [],
      });
    });
    m?.stop();
    assertEquals(past(d), []);
  });
  assert(lines.join("\n").includes("memory.interval"), lines.join("\n"));
});

Deno.test("checkpoint debounce: 30 days never arms a timer past the ceiling", async () => {
  const dir = await tempDir("aio-cp-ceiling-");
  try {
    await captureConsoleAsync(async () => {
      const cp = createCheckpoint(dir, DAYS_30);
      const d = await armedDelays(() =>
        cp.schedule({ ts: Date.now(), cells: {} } as never)
      );
      assertEquals(past(d), []);
      await cp.flush();
    });
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("db requestTimeoutMs: 30 days does not fail every request at once", async () => {
  await captureConsoleAsync(async () => {
    const db = createDB(":memory:", { requestTimeoutMs: DAYS_30 });
    try {
      const d = await armedDelays(async () => {
        await db.query("SELECT 1 AS x");
      });
      assertEquals(past(d), []);
    } finally {
      await db.close();
    }
  });
});

Deno.test("connectCli: ack/ready ceilings of 30 days are not armed past the ceiling", async () => {
  // deno-lint-ignore no-explicit-any
  let app: any;
  let rejected: unknown;
  await captureConsoleAsync(async () => {
    const d = await armedDelays(() => {
      app = connectCli(`http://127.0.0.1:${freePort()}`, {
        readyTimeoutMs: DAYS_30,
        ackTimeoutMs: DAYS_30,
      });
      app.ready.catch((e: unknown) => rejected ??= e);
    });
    await tick(30);
    const early = rejected;
    app.close();
    assertEquals(past(d), []);
    assertEquals(early, undefined, "ready rejected at once");
  });
});
