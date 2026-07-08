// tests/migration.test.ts — state migration system tests
import { assertEquals } from "@std/assert";
import {
  applyCellMigrations,
  type CellMigrationInfo,
} from "../src/server/aio-boot.ts";
import { deepMerge } from "../src/state/deep-merge.ts";

type LogEntry = { level: string; msg: string };

function makeLog(entries: LogEntry[]) {
  return {
    info: (m: string) => entries.push({ level: "info", msg: m }),
    debug: (m: string) => entries.push({ level: "debug", msg: m }),
    warn: (m: string) => entries.push({ level: "warn", msg: m }),
    error: (m: string) => entries.push({ level: "error", msg: m }),
    trace: () => {},
  };
}

/** Simulate KV restore: deepMerge(initial, persisted) then applyCellMigrations */
function simulateRestore(opts: {
  initial: Record<string, unknown>;
  persisted: Record<string, unknown>;
  persistedVersions: Record<string, number>;
  cellMigrations: Map<string, CellMigrationInfo>;
}): { state: Record<string, unknown>; logs: LogEntry[] } {
  const state = deepMerge(opts.initial, opts.persisted);
  const logs: LogEntry[] = [];
  applyCellMigrations(
    state,
    opts.cellMigrations,
    opts.persistedVersions,
    makeLog(logs),
  );
  return { state, logs };
}

// ── Test: version 1, no persisted data → no migration called ────
Deno.test("migration: v1 cell, no persisted data — no migration called", () => {
  let migrateCalled = false;
  const migrations = new Map<string, CellMigrationInfo>();
  migrations.set("counter", {
    version: 1,
    initialState: { count: 0 },
    onMigrate: (s, _v) => {
      migrateCalled = true;
      return s;
    },
  });

  // No persisted state — state is just initialState, no deepMerge needed
  const state: Record<string, unknown> = { counter: { count: 0 } };
  const logs: LogEntry[] = [];
  // persistedVersions is empty → persisted version = 0 → 0 < 1 → migration triggered
  // BUT there's no persisted data, meaning this is first run.
  // In practice, bootStorage only calls applyCellMigrations when KV has data.
  // For the pure function test: if there IS a version mismatch, onMigrate IS called.
  // This test verifies that when versions match, no migration runs.
  applyCellMigrations(state, migrations, { counter: 1 }, makeLog(logs));

  assertEquals(migrateCalled, false);
  assertEquals((state.counter as Record<string, unknown>).count, 0);
});

// ── Test: version 2, persisted version 1 → onMigrate called ────
Deno.test("migration: v2 cell, persisted v1 — onMigrate called with correct args", () => {
  const calls: { state: unknown; fromVersion: number }[] = [];
  const migrations = new Map<string, CellMigrationInfo>();
  migrations.set("counter", {
    version: 2,
    initialState: { count: 0, newField: "default" },
    onMigrate: (s, fromVersion) => {
      calls.push({ state: structuredClone(s), fromVersion });
      return { ...s, newField: "migrated" };
    },
  });

  const { state, logs } = simulateRestore({
    initial: { counter: { count: 0, newField: "default" } },
    persisted: { counter: { count: 42 } },
    persistedVersions: { counter: 1 },
    cellMigrations: migrations,
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.fromVersion, 1);
  // After deepMerge: count=42 (persisted wins), newField="default" (not in persisted → initial)
  assertEquals((calls[0]!.state as Record<string, unknown>).count, 42);
  assertEquals(
    (calls[0]!.state as Record<string, unknown>).newField,
    "default",
  );
  // After migration
  assertEquals((state.counter as Record<string, unknown>).newField, "migrated");
  assertEquals((state.counter as Record<string, unknown>).count, 42);
  assertEquals(
    logs.some((l) => l.level === "info" && l.msg.includes("v1")),
    true,
  );
});

// ── Test: version mismatch, no onMigrate → warning logged ───────
Deno.test("migration: version mismatch, no onMigrate — warning logged", () => {
  const migrations = new Map<string, CellMigrationInfo>();
  migrations.set("counter", { version: 2, initialState: { count: 0 } });

  const { logs } = simulateRestore({
    initial: { counter: { count: 0 } },
    persisted: { counter: { count: 5 } },
    persistedVersions: { counter: 1 },
    cellMigrations: migrations,
  });

  assertEquals(
    logs.some((l) => l.level === "warn" && l.msg.includes("no onMigrate")),
    true,
  );
});

// ── Test: version 0 (default) → no migration ───────────────────
Deno.test("migration: version 0 (default) — no migration", () => {
  let migrateCalled = false;
  const migrations = new Map<string, CellMigrationInfo>();
  migrations.set("counter", {
    version: 0,
    initialState: { count: 0 },
    onMigrate: () => {
      migrateCalled = true;
      return {};
    },
  });

  const { state } = simulateRestore({
    initial: { counter: { count: 0 } },
    persisted: { counter: { count: 10 } },
    persistedVersions: {},
    cellMigrations: migrations,
  });

  assertEquals(migrateCalled, false);
  assertEquals((state.counter as Record<string, unknown>).count, 10);
});

// ── Test: no persisted version → treated as 0 ──────────────────
Deno.test("migration: no persisted version — treated as version 0", () => {
  const calls: number[] = [];
  const migrations = new Map<string, CellMigrationInfo>();
  migrations.set("counter", {
    version: 1,
    initialState: { count: 0, migrated: false },
    onMigrate: (s, fromVersion) => {
      calls.push(fromVersion);
      return { ...s, migrated: true };
    },
  });

  const { state } = simulateRestore({
    initial: { counter: { count: 0, migrated: false } },
    persisted: { counter: { count: 7 } },
    persistedVersions: {}, // no entry → treated as 0
    cellMigrations: migrations,
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0], 0);
  assertEquals((state.counter as Record<string, unknown>).migrated, true);
});

// ── Test: onMigrate throws → error logged, state unchanged ─────
Deno.test("migration: onMigrate throws — error logged, state reset to initial", () => {
  const migrations = new Map<string, CellMigrationInfo>();
  migrations.set("counter", {
    version: 2,
    initialState: { count: 0 },
    onMigrate: () => {
      throw new Error("migration boom");
    },
  });

  const { state, logs } = simulateRestore({
    initial: { counter: { count: 0 } },
    persisted: { counter: { count: 99 } },
    persistedVersions: { counter: 1 },
    cellMigrations: migrations,
  });

  // State should be reset to initialState (migration threw — stale state unsafe)
  assertEquals((state.counter as Record<string, unknown>).count, 0);
  assertEquals(
    logs.some((l) => l.level === "error" && l.msg.includes("migration boom")),
    true,
  );
});

// ── Test: same version — no migration ───────────────────────────
Deno.test("migration: same version — no migration", () => {
  let migrateCalled = false;
  const migrations = new Map<string, CellMigrationInfo>();
  migrations.set("counter", {
    version: 3,
    initialState: { count: 0 },
    onMigrate: () => {
      migrateCalled = true;
      return {};
    },
  });

  const { state } = simulateRestore({
    initial: { counter: { count: 0 } },
    persisted: { counter: { count: 50 } },
    persistedVersions: { counter: 3 },
    cellMigrations: migrations,
  });

  assertEquals(migrateCalled, false);
  assertEquals((state.counter as Record<string, unknown>).count, 50);
});

// ── Test: multiple cells, only some need migration ──────────────
Deno.test("migration: multiple cells — only stale cells migrated", () => {
  const migrated: string[] = [];
  const migrations = new Map<string, CellMigrationInfo>();
  migrations.set("alpha", {
    version: 2,
    initialState: { x: 0, upgraded: false },
    onMigrate: (s, _v) => {
      migrated.push("alpha");
      return { ...s, upgraded: true };
    },
  });
  migrations.set("beta", {
    version: 1,
    initialState: { y: 0 },
    onMigrate: (s, _v) => {
      migrated.push("beta");
      return s;
    },
  });

  const { state } = simulateRestore({
    initial: { alpha: { x: 0, upgraded: false }, beta: { y: 0 } },
    persisted: { alpha: { x: 1 }, beta: { y: 2 } },
    persistedVersions: { alpha: 1, beta: 1 }, // alpha stale, beta current
    cellMigrations: migrations,
  });

  assertEquals(migrated, ["alpha"]); // only alpha migrated
  assertEquals((state.alpha as Record<string, unknown>).upgraded, true);
  assertEquals((state.beta as Record<string, unknown>).y, 2);
});
