// A rollback that failed once and SUCCEEDED when the next boot retried it is
// a rollback that happened.
//
// The failed attempt writes its reason into the pending marker, so every boot
// says it until the retry works. The record kept once it did work was that
// same marker, reason included — and the boot after it, running the old
// version again, announced "ROLLBACK FAILED … this is still <new> … put it
// back by hand" about an install that was already put back.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  MAX_BOOT_ATTEMPTS,
  writePending,
} from "../src/server/updates-apply.ts";
import {
  judgePendingUpdate,
  startUpdates,
} from "../src/server/updates-boot.ts";
import type { UpdatesSlot } from "../src/state/updates-cell.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const quiet = {
  info() {},
  debug() {},
  warn() {},
  error() {},
} as unknown as Log;

Deno.test("rollback: one that succeeded on the retry is reported as rolled back, not as failed", async () => {
  const dir = await tempDir("aio-rollback-retry-");
  const data = await tempDir("aio-rollback-retry-data-");
  try {
    const current = join(dir, "notes");
    await Deno.writeTextFile(current, "2.0.0");
    await Deno.writeTextFile(`${current}.old-1.0.0`, "1.0.0");
    // The marker a boot leaves when its rollback could not move the artifact.
    writePending(data, {
      from: "1.0.0",
      to: "2.0.0",
      artifact: current,
      previous: `${current}.old-1.0.0`,
      attempts: MAX_BOOT_ATTEMPTS,
      startedAt: "2026-08-08T00:00:00.000Z",
      rollbackFailed: "the file was busy",
    });
    const stop = await judgePendingUpdate(data, quiet, "2.0.0", {
      os: "linux",
      exe: "1:200:5000:1700000099000",
    });
    assertEquals(stop, true, "the retry put the old version back");
    assertEquals(await Deno.readTextFile(current), "1.0.0");

    const errors: string[] = [];
    startUpdates({
      updates: { source: "https://example.invalid/rel", check: 1000 },
      dataDir: data,
      appName: "notes",
      appVersion: "1.0.0",
      local: { schema: 1, cells: {} },
      exposed: false,
      log: {
        ...quiet,
        error: (_c: string, m: string) => errors.push(m),
      } as unknown as Log,
      argv: [],
      slot: {
        runtime: null,
        cell: { status: "idle", error: null, ready: () => {} },
      } as unknown as UpdatesSlot,
      exe: "1:100:4000:1600000000000",
    }).stop();
    assertEquals(errors.filter((m) => m.includes("ROLLBACK FAILED")), []);
    assertEquals(errors.filter((m) => m.includes("was rolled back")).length, 1);
  } finally {
    await dropTempDir(dir);
    await dropTempDir(data);
  }
});
