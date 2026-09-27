// `updates.check` longer than a timer can wait (2^31-1 ms ≈ 24.8 days).
//
// setTimeout truncates such a delay to ~1 ms, so `check: 30 days` polled the
// release host in a tight loop instead of monthly. Now it is clamped, and the
// log says so.
import { assert, assertEquals } from "@std/assert";
import { beginUpdates, startUpdates } from "../src/server/updates-boot.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import { MAX_TIMER_DELAY } from "../src/state/schedule.ts";
import type { UpdatesSlot } from "../src/state/updates-cell.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MONTH = 30 * 24 * 60 * 60 * 1000;

Deno.test("updates config: a check interval past the timer ceiling is clamped", () => {
  const r = resolveUpdates({ source: "https://r.example.com/a", check: MONTH });
  assertEquals(r.intervalMs, MAX_TIMER_DELAY);
});

Deno.test("updates: check: 30 days polls once, not in a tight loop, and warns", async () => {
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
        return Promise.resolve({ kind: "current", reason: "latest" });
      },
    },
  } as unknown as UpdatesSlot;
  const data = await tempDir("aio-upd-overflow-");
  const started = startUpdates({
    updates: { source: "https://example.invalid/rel", check: MONTH },
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
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(checks, 1, `polled ${checks} times in 300ms`);
    assert(
      warns.some((w) => w.includes(`${MONTH}ms is longer than a timer`)),
      warns.join("\n"),
    );
  } finally {
    started.stop();
    await dropTempDir(data);
  }
});
