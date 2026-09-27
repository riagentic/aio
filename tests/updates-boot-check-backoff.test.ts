// A failed BOOT check reschedules with the backoff it announces.
//
// The poll timer used to be armed at boot, before the boot check had answered,
// so its wait was always the plain interval: the boot check failed, logged
// "next attempt in 2s", and the next attempt came 1s later anyway.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { beginUpdates, startUpdates } from "../src/server/updates-boot.ts";
import type { UpdatesSlot } from "../src/state/updates-cell.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("updates: a failed boot check waits the backoff it logs", async () => {
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
  const data = await tempDir("aio-upd-bootbackoff-");
  const started = startUpdates({
    updates: { source: "https://example.invalid/rel", check: 1000 },
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
    // Interval 1s; after one failure the announced wait is 2s (+≤10% jitter).
    // At 1.6s a timer armed at the plain interval has already checked again.
    await new Promise((r) => setTimeout(r, 1600));
    assert(warns.length >= 1, "the boot check's failure was not logged");
    assertMatch(warns[0]!, /next attempt in 2s \(attempt 1 in a row/);
    assertEquals(
      checks,
      1,
      `checked again before the 2s it announced: ${warns.join(" | ")}`,
    );
  } finally {
    started.stop();
    await dropTempDir(data);
  }
});

// An auto-install that is REFUSED every pass (a broken seal, a translocated
// .app) was invisible: the cell's `apply()` puts the failure into state and
// resolves, so nothing was logged — and the successful CHECK before it reset
// the failure count, so the whole artifact was re-downloaded at full cadence.
Deno.test("updates: a refused auto-install is logged and backs off like any failure", async () => {
  const warns: string[] = [];
  const log = {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (_cat: string, msg: string) => warns.push(msg),
  } as unknown as Log;
  let applies = 0;
  const cell = {
    status: "idle",
    error: null as string | null,
    ready: () => {},
    check: () =>
      Promise.resolve({ kind: "offer", update: { version: "2.0.0" } }),
    apply: () => {
      applies++;
      cell.status = "error";
      cell.error = "the downloaded app's code signature does not verify";
      return Promise.resolve();
    },
  };
  const slot = { runtime: null, cell } as unknown as UpdatesSlot;
  const data = await tempDir("aio-upd-autofail-");
  const started = startUpdates({
    updates: {
      source: "https://example.invalid/rel",
      check: 1000,
      auto: true,
    },
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
    // Boot attempt at 0, the retry after 2s (+≤10%): at 2.6s exactly two.
    await new Promise((r) => setTimeout(r, 2600));
    const fails = warns.filter((w) =>
      w.includes("2.0.0 was NOT installed (1.0.0 keeps running)")
    );
    assertEquals(applies, 2, warns.join(" | "));
    assertEquals(fails.length, 2, warns.join(" | "));
    assertMatch(fails[0]!, /code signature does not verify/);
    assertMatch(fails[0]!, /next attempt in 2s \(attempt 1 in a row/);
    assertMatch(fails[1]!, /next attempt in 4s \(attempt 2 in a row/);
  } finally {
    started.stop();
    await dropTempDir(data);
  }
});

// ONE refusal, ONE line. The runtime logs every refused install (the button's
// included); the boot's unattended install says it in its own line together
// with the retry — so for that call the runtime keeps quiet, or every refused
// auto-install was said twice.
Deno.test("updates: a refused auto-install through the real runtime is ONE line", async () => {
  const warns: string[] = [];
  const errors: string[] = [];
  const log = {
    info: () => {},
    debug: () => {},
    error: (...a: unknown[]) => void errors.push(a.map(String).join(" ")),
    warn: (_cat: string, msg: string) => warns.push(msg),
  } as unknown as Log;
  const cell = {
    status: "idle",
    error: null as string | null,
    ready: () => {},
    check: () =>
      Promise.resolve({ kind: "offer", update: { version: "2.0.0" } }),
    // What the real cell does: call the runtime, keep its refusal in state.
    apply: async () => {
      try {
        await slot.runtime!.apply();
      } catch (e) {
        cell.status = "error";
        cell.error = (e as Error).message;
      }
    },
  };
  const slot = { runtime: null, cell } as unknown as UpdatesSlot;
  const data = await tempDir("aio-upd-autoonce-");
  const started = startUpdates({
    updates: {
      source: "https://example.invalid/rel",
      check: 60_000,
      auto: true,
    },
    dataDir: data,
    appName: "demo",
    appVersion: "1.0.0",
    local: { schema: 1, cells: {} },
    exposed: false,
    log,
    argv: [],
    slot,
  });
  const lines = () =>
    [...warns, ...errors].filter((l) => l.includes("NOT installed"));
  try {
    beginUpdates(slot);
    const t0 = Date.now();
    while (lines().length === 0 && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 100)); // a second line, if any
    assertEquals(lines().length, 1, [...warns, ...errors].join(" | "));
    assertMatch(lines()[0]!, /next attempt in/);
    // …and the same runtime still logs a refusal nobody else says (a button).
    await slot.runtime!.apply().catch(() => {});
    assertEquals(
      errors.filter((l) => l.includes("NOT installed")).length,
      1,
      errors.join(" | "),
    );
  } finally {
    started.stop();
    await dropTempDir(data);
  }
});
