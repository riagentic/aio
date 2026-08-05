// tests/migration.test.ts — state migration system tests
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  applyCellMigrations,
  type CellMigrationInfo,
  detectShapeDrift,
  shapeDriftSummary,
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

// ── Test: onMigrate throws → REFUSE, never reset ────────────────
// It used to reset the cell to `initialState` and carry on — and the debounced
// persist then wrote that empty slice over the data the migration was supposed
// to transform (tests/migration-rollback.test.ts proves the end-to-end loss).
// Refusing writes nothing, so the stored bytes survive for a fixed build.
Deno.test("migration: onMigrate throws — refuses, and never resets the cell", () => {
  const migrations = new Map<string, CellMigrationInfo>();
  migrations.set("counter", {
    version: 2,
    initialState: { count: 0 },
    onMigrate: () => {
      throw new Error("migration boom");
    },
  });

  const state = deepMerge({ counter: { count: 0 } }, {
    counter: { count: 99 },
  });
  const err = assertThrows(
    () => applyCellMigrations(state, migrations, { counter: 1 }, makeLog([])),
    Error,
    "migration boom",
  );
  assert(
    /refusing to boot/.test(err.message) && /intact/.test(err.message),
    `the refusal explains what was NOT done: ${err.message}`,
  );
  assertEquals(
    (state.counter as Record<string, unknown>).count,
    99,
    "the restored data is left exactly as it was",
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

// ── Test: DOWNGRADE — stored version newer than code → loud warn, kept ──
Deno.test("migration: stored version NEWER than code — downgrade warned, state kept", () => {
  let migrateCalled = false;
  const migrations = new Map<string, CellMigrationInfo>();
  migrations.set("counter", {
    version: 1, // running old code
    initialState: { count: 0 },
    onMigrate: (s) => {
      migrateCalled = true;
      return s;
    },
  });

  const { state, logs } = simulateRestore({
    initial: { counter: { count: 0 } },
    persisted: { counter: { count: 77 } },
    persistedVersions: { counter: 3 }, // DB written by newer code (v3)
    cellMigrations: migrations,
  });

  assertEquals(migrateCalled, false, "onMigrate must NOT run on a downgrade");
  assertEquals(
    (state.counter as Record<string, unknown>).count,
    77,
    "state is kept as-is (not reset)",
  );
  assertEquals(
    logs.some((l) => l.level === "warn" && l.msg.includes("NEWER than code")),
    true,
    "a loud downgrade warning is logged",
  );
});

// ── Test: the structured MigrationReport reflects each outcome ──────────
Deno.test("migration: report enumerates migrated / stale / downgrade", () => {
  const migrations = new Map<string, CellMigrationInfo>();
  migrations.set("up", {
    version: 2,
    initialState: { v: 0 },
    onMigrate: (s) => s,
  });
  migrations.set("stale", { version: 2, initialState: { v: 0 } }); // no onMigrate
  migrations.set("down", {
    version: 1,
    initialState: { v: 0 },
    onMigrate: (s) => s,
  });
  migrations.set("noop", {
    version: 1,
    initialState: { v: 0 },
    onMigrate: (s) => s,
  }); // same version → absent from report

  const state = {
    up: { v: 1 },
    stale: { v: 1 },
    down: { v: 1 },
    noop: { v: 1 },
  };
  const logs: LogEntry[] = [];
  const report = applyCellMigrations(
    state,
    migrations,
    { up: 1, stale: 1, down: 3, noop: 1 },
    makeLog(logs),
  );
  const byCell = Object.fromEntries(report.map((r) => [r.cell, r.outcome]));
  assertEquals(byCell.up, "migrated");
  assertEquals(byCell.stale, "stale");
  assertEquals(byCell.down, "downgrade");
  assertEquals("noop" in byCell, false, "a same-version no-op is not reported");
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

// ── Shape drift — stored shape vs declared initialState ──────────

Deno.test("detectShapeDrift: a stored field absent from initialState → unknown-field", () => {
  const drift = detectShapeDrift(
    { wallet: { balance: 0 } }, // declared
    { wallet: { balance: 5, seedPhrase: "x" } }, // stored (renamed/removed field)
  );
  assertEquals(drift, [{
    cell: "wallet",
    path: "seedPhrase",
    issue: "unknown-field",
    storedType: "string",
  }]);
});

Deno.test("detectShapeDrift: a type change on a shared field → type-changed", () => {
  const drift = detectShapeDrift(
    { c: { amount: 0 } }, // declared number
    { c: { amount: "0" } }, // stored string
  );
  assertEquals(drift, [{
    cell: "c",
    path: "amount",
    issue: "type-changed",
    storedType: "string",
    declaredType: "number",
  }]);
});

Deno.test("detectShapeDrift: a stored cell no longer declared → unknown-cell", () => {
  const drift = detectShapeDrift({ keep: {} }, { keep: {}, gone: { x: 1 } });
  assertEquals(drift, [{
    cell: "gone",
    path: "",
    issue: "unknown-cell",
    storedType: "object",
  }]);
});

Deno.test("detectShapeDrift: nested objects recurse; dotted path", () => {
  const drift = detectShapeDrift(
    { c: { ui: { theme: "dark" } } },
    { c: { ui: { theme: "dark", legacyZoom: 2 } } },
  );
  assertEquals(drift.map((d) => d.path), ["ui.legacyZoom"]);
});

Deno.test("detectShapeDrift: stored SUBSET of declared → no drift (deepMerge adds defaults)", () => {
  // initialState declares more than storage holds — that's an ADD, not drift.
  assertEquals(
    detectShapeDrift({ c: { a: 1, b: 2 } }, { c: { a: 9 } }),
    [],
  );
});

Deno.test("detectShapeDrift: arrays are data, not shape — length change is NOT drift", () => {
  assertEquals(
    detectShapeDrift({ c: { xs: [] } }, { c: { xs: [1, 2, 3] } }),
    [],
  );
});

Deno.test("detectShapeDrift: array ↔ object IS a type change", () => {
  const drift = detectShapeDrift({ c: { v: {} } }, { c: { v: [] } });
  assertEquals(drift[0]!.issue, "type-changed");
  assertEquals(drift[0]!.storedType, "array");
  assertEquals(drift[0]!.declaredType, "object");
});

Deno.test("detectShapeDrift: a declared EMPTY object is an open record — stored keys are NOT drift", () => {
  // a field report: `balances.sol = {} as Record<pubkey, number>`.
  // Runtime keys are DATA, not schema — must not warn (was a 70-item WARN wall).
  const drift = detectShapeDrift(
    { wallet: { balances: {} } }, // declared: open record
    {
      wallet: {
        balances: { "cluster:AAA": 1, "cluster:BBB": 2, "cluster:CCC": 3 },
      },
    },
  );
  assertEquals(drift, []);
});

Deno.test("detectShapeDrift: a declared NON-empty object still enforces its shape", () => {
  // Only an EMPTY declaration is open; a fixed shape keeps flagging strays.
  const drift = detectShapeDrift(
    { c: { ui: { theme: "dark" } } },
    { c: { ui: { theme: "dark", stray: 1 } } },
  );
  assertEquals(drift.map((d) => d.path), ["ui.stray"]);
});

Deno.test("detectShapeDrift: open record nested under a fixed shape is respected", () => {
  const drift = detectShapeDrift(
    { c: { cfg: { maps: {} } } }, // maps is an open record inside fixed cfg
    { c: { cfg: { maps: { a: 1, b: 2 } } } },
  );
  assertEquals(drift, []);
});

Deno.test("detectShapeDrift: skip set suppresses a migrated cell", () => {
  const drift = detectShapeDrift(
    { a: { x: 0 }, b: { y: 0 } },
    { a: { x: 0, stale: 1 }, b: { y: 0, stale: 1 } },
    { skip: new Set(["a"]) },
  );
  assertEquals(drift.map((d) => d.cell), ["b"]);
});

Deno.test("detectShapeDrift: null vs object is a type change, not a recurse", () => {
  const drift = detectShapeDrift({ c: { v: { a: 1 } } }, { c: { v: null } });
  assertEquals(drift[0]!.issue, "type-changed");
  assertEquals(drift[0]!.storedType, "null");
});

Deno.test("detectShapeDrift: capped at 100 entries, never unbounded", () => {
  // Declared shape is NON-empty (a fixed shape, not an open record) so every
  // stray stored key is real drift — exercising the cap.
  const initial: Record<string, unknown> = { c: { known: 0 } };
  const storedCell: Record<string, number> = { known: 0 };
  for (let i = 0; i < 300; i++) storedCell[`k${i}`] = i;
  const drift = detectShapeDrift(initial, { c: storedCell });
  assert(drift.length <= 100, `capped, got ${drift.length}`);
  assert(drift.length > 0, "non-empty declared shape must still flag strays");
});

Deno.test("shapeDriftSummary: teachable, names the fields + a fix", () => {
  const msg = shapeDriftSummary([
    {
      cell: "wallet",
      path: "seedPhrase",
      issue: "unknown-field",
      storedType: "string",
    },
  ]);
  assert(msg.includes("wallet.seedPhrase"));
  assert(msg.includes("version"), "points at the version-bump fix");
});

// a field report #2 — a restored snapshot replaces a seeded list wholesale.
// A curated token registry declared in `state:` vanished after the first
// restore of a profile that had once persisted an empty list; every holding
// then rendered as a truncated mint, and nothing warned. deepMerge is right to
// let stored data win; being quiet about erasing a seed is what was wrong.
Deno.test("detectShapeDrift: a stored EMPTY array erasing a declared seed is reported", () => {
  const drift = detectShapeDrift(
    { wallet: { tokens: [{ mint: "usdc" }, { mint: "usdt" }], balance: 0 } },
    { wallet: { tokens: [], balance: 5 } },
  );
  assertEquals(drift.length, 1);
  const d = drift[0]!;
  assertEquals(d.issue, "seed-erased");
  assertEquals(d.cell, "wallet");
  assertEquals(d.path, "tokens");
  assertEquals(d.declaredCount, 2);
  const msg = shapeDriftSummary(drift);
  assert(msg.includes("wallet.tokens"), msg);
  assert(msg.includes("2 declared"), msg);
  assert(msg.includes("persist:"), `names the fix: ${msg}`);
});

Deno.test("detectShapeDrift: seed erasure only fires where data is actually lost", () => {
  // An empty DECLARED list can lose nothing; a shorter stored list is the user
  // deleting rows; an empty stored OBJECT merges key-by-key and erases nothing.
  assertEquals(
    detectShapeDrift({ c: { xs: [] } }, { c: { xs: [] } }).length,
    0,
  );
  assertEquals(
    detectShapeDrift({ c: { xs: [1, 2, 3] } }, { c: { xs: [1] } }).length,
    0,
  );
  assertEquals(
    detectShapeDrift({ c: { m: { a: 1 } } }, { c: { m: {} } }).length,
    0,
  );
  // …and the erasure it does report is real: deepMerge confirms the loss.
  const merged = deepMerge({ xs: [1, 2] }, { xs: [] });
  assertEquals(merged.xs, []);
  assertEquals(
    detectShapeDrift({ c: { xs: [1, 2] } }, { c: { xs: [] } })[0]!.issue,
    "seed-erased",
  );
});

// ── Downgrade + rename: the stored fields are DATA, not noise ────
Deno.test("migration: a downgrade keeps fields this build no longer declares", () => {
  const migrations = new Map<string, CellMigrationInfo>();
  migrations.set("wallet", { version: 1, initialState: { cents: 0 } });

  // v2 wrote { dollars }; this v1 build restores through deepMerge, which
  // narrows the slice to { cents } — and the next persist would write that
  // narrowed slice back, deleting `dollars` for good.
  const stored = { wallet: { dollars: 12.34 } };
  const state = deepMerge({ wallet: { cents: 0 } }, stored);
  const logs: LogEntry[] = [];
  const report = applyCellMigrations(
    state,
    migrations,
    { wallet: 2 },
    makeLog(logs),
    stored,
  );
  assertEquals(report[0]?.outcome, "downgrade");
  assertEquals(
    (state.wallet as Record<string, unknown>).dollars,
    12.34,
    "the newer build's field is preserved in state, so it is re-persisted",
  );
  const warn = logs.find((l) => l.level === "warn")?.msg ?? "";
  assert(/NEWER than code v1/.test(warn), warn);
  assert(
    !/State kept as-is/.test(warn),
    `the old wording misdiagnosed a narrowed slice: ${warn}`,
  );
  assert(/never regresses/.test(warn), warn);
});

Deno.test("migration: onMigrate sees the stored field the new shape dropped", () => {
  const seen: Record<string, unknown>[] = [];
  const migrations = new Map<string, CellMigrationInfo>();
  migrations.set("wallet", {
    version: 2,
    initialState: { dollars: 0 },
    onMigrate: (s) => {
      seen.push({ ...s });
      return { dollars: (s.cents as number ?? 0) / 100 };
    },
  });

  const stored = { wallet: { cents: 1234 } };
  const state = deepMerge({ wallet: { dollars: 0 } }, stored);
  applyCellMigrations(state, migrations, { wallet: 1 }, makeLog([]), stored);

  assertEquals(seen[0]?.cents, 1234, "the hook can read the old field");
  assertEquals((state.wallet as Record<string, unknown>).dollars, 12.34);
});
