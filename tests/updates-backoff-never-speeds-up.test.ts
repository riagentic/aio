// A failed update check backs the poll OFF — it never polls sooner.
//
// The one-hour cap bounded the whole wait, so on the prod cadence (6 h) a
// single failure cut the next wait to 1 h: a release host that was down got
// six times the traffic from every install. And at any cadence of 1 h or more
// there was no backoff at all.
import { assert, assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
  beginUpdates,
  startUpdates,
  updateBackoffMs,
} from "../src/server/updates-boot.ts";
import { CHANNEL_INTERVAL_MS } from "../src/server/updates-core.ts";
import type { UpdatesSlot } from "../src/state/updates-cell.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const HOUR = 60 * 60 * 1000;

Deno.test("updates backoff: never shorter than the configured interval", () => {
  for (
    const interval of [
      ...Object.values(CHANNEL_INTERVAL_MS),
      2 * HOUR,
      48 * HOUR,
    ]
  ) {
    for (let failures = 0; failures <= 10; failures++) {
      const wait = updateBackoffMs(interval, failures);
      assert(
        wait >= interval,
        `interval ${interval}ms, ${failures} failures → ${wait}ms`,
      );
    }
  }
  assertEquals(updateBackoffMs(48 * HOUR, 3), 48 * HOUR);
});

Deno.test("updates backoff: short cadences still grow, capped at an hour", () => {
  const dev = CHANNEL_INTERVAL_MS.dev!; // 1 min
  assertEquals(updateBackoffMs(dev, 0), dev);
  assertEquals(updateBackoffMs(dev, 1), 2 * dev);
  assertEquals(updateBackoffMs(dev, 3), 8 * dev);
  assertEquals(updateBackoffMs(dev, 10), HOUR);
});

Deno.test("updates backoff: an hourly-or-slower cadence backs off too, to 4× / 24 h", () => {
  assertEquals(updateBackoffMs(HOUR, 1), 2 * HOUR);
  assertEquals(updateBackoffMs(HOUR, 10), 4 * HOUR);
  const prod = CHANNEL_INTERVAL_MS.prod!; // 6 h
  assertEquals(updateBackoffMs(prod, 1), 12 * HOUR);
  assertEquals(updateBackoffMs(prod, 10), 24 * HOUR);
});

Deno.test("updates backoff: startUpdates waits what it announces, growing at 6 h", async () => {
  const warns: string[] = [];
  const log = {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (_cat: string, msg: string) => warns.push(msg),
  } as unknown as Log;
  let checks = 0;
  const slot = {
    runtime: null,
    cell: {
      ready: () => {},
      check: () => {
        checks++;
        return Promise.resolve({ kind: "error", error: "host down" });
      },
    },
  } as unknown as UpdatesSlot;
  const data = await tempDir("aio-upd-backoff-6h-");
  const time = new FakeTime();
  const started = startUpdates({
    updates: { source: "https://example.invalid/rel", check: 6 * HOUR },
    dataDir: data,
    appName: "demo",
    appVersion: "1.0.0",
    local: { schema: 1, cells: {} },
    exposed: false,
    log,
    argv: [],
    slot,
  });
  try {
    beginUpdates(slot);
    await time.runMicrotasks();
    assertEquals(checks, 1);
    // Each announced wait, and the poll honouring it (jitter ≤ 10%).
    for (const [n, hours] of [[1, 12], [2, 24], [3, 24]] as const) {
      assert(
        warns[n - 1]?.includes(`next attempt in ${hours * 3600}s`),
        `failure ${n}: ${warns[n - 1]}`,
      );
      await time.tickAsync(hours * HOUR - 1);
      assertEquals(checks, n, `checked before the ${hours} h it announced`);
      await time.tickAsync(0.1 * hours * HOUR + 2);
      assertEquals(checks, n + 1, `no check within ${hours} h + jitter`);
    }
  } finally {
    started.stop();
    time.restore();
    await dropTempDir(data);
  }
});
