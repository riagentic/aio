// scripts/bench.ts — D12 benchmark suite (perfect-aio): boot, dispatch,
// persistence, patch compute, memory — tracked as CI infrastructure.
// "Correct but slower" fails the gate (scripts/check-bench.ts) like a broken
// test. Each timing metric: warmup + N iterations → median + p95.
// Run: deno task bench   (writes bench-results.json, gitignored)
// Gate: deno task bench:check  (compares against scripts/bench-baselines.json)
import { aio, cell, composeCells } from "../mod.ts";
import { compactPatches } from "../src/state/patch-compact.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import type { ReduceResult } from "../src/state/cell-compose-reduce.ts";
import type { DB, QueryResult, Tx } from "../src/db/types.ts";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import type { Patch } from "immer";

// ── stats ─────────────────────────────────────────────────────────────
type Metric = { unit: string; median: number; p95: number; n: number };
const metrics: Record<string, Metric> = {};

function record(name: string, unit: string, samples: number[]): void {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
  metrics[name] = {
    unit,
    median: at(0.5),
    p95: at(0.95),
    n: samples.length,
  };
}

const gc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc
  ?.bind(globalThis);
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const baseDir = await Deno.makeTempDir({ prefix: "aio-bench-" });
const bootOpts = {
  appVersion: "0.0.0",
  client: "server-only",
  persist: false,
  libraryMode: true,
  baseDir,
} as const;

// ── 1. boot: aio.run() resolve time (libraryMode, clean close) ────────
{
  const BOOT_N = 5;
  const samples: number[] = [];
  for (let i = 0; i <= BOOT_N; i++) { // i=0 is warmup
    const c = cell(`bench-boot-c${i}`, {
      state: { count: 0 },
      methods: {
        increment(s, by = 1) {
          s.count += by;
        },
      },
    });
    const t0 = performance.now();
    const app = await aio.run({ cells: [c], appId: "bench-boot", ...bootOpts });
    const dt = performance.now() - t0;
    await app.close();
    if (i > 0) samples.push(dt);
  }
  record("boot", "ms", samples);
  _resetAioRuntime();
}

// ── 2. dispatch: sync method throughput + async round-trips ───────────
{
  const d = cell("bench-dispatch", {
    state: { count: 0 },
    methods: {
      inc(s, by = 1) {
        s.count += by;
      },
      async ainc(s) {
        s.count += 1;
      },
    },
  });
  const app = await aio.run({
    cells: [d],
    appId: "bench-dispatch",
    ...bootOpts,
  });

  // sync: fire a batch, await the last call — per-op ms across the batch
  const SYNC_BATCH = 10_000;
  const syncSamples: number[] = [];
  for (let iter = 0; iter <= 3; iter++) { // iter=0 is warmup (smaller batch)
    const n = iter === 0 ? 1_000 : SYNC_BATCH;
    const t0 = performance.now();
    let last: Promise<unknown> = Promise.resolve();
    for (let i = 0; i < n; i++) last = d.inc(1);
    await last;
    if (iter > 0) syncSamples.push((performance.now() - t0) / n);
  }
  record("dispatch-sync", "ms/op", syncSamples);

  // async: full round-trip, awaited individually
  const ASYNC_N = 1_000;
  const asyncSamples: number[] = [];
  for (let iter = 0; iter <= 3; iter++) { // iter=0 is warmup (smaller batch)
    const n = iter === 0 ? 100 : ASYNC_N;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) await d.ainc();
    if (iter > 0) asyncSamples.push((performance.now() - t0) / n);
  }
  record("dispatch-async", "ms/op", asyncSamples);

  await app.close();
  _resetAioRuntime();
}

// ── 3. persistence: sqliteKv write path (in-memory DB, real payloads) ─
{
  // Same harness pattern as tests/skv-sqlite.test.ts — the framework's
  // SkvInstance on SQLite, minus disk variance.
  // deno-lint-ignore no-explicit-any
  const _p = (v: unknown[]): any[] => v;
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SKV_SCHEMA);
  const query = <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> =>
    Promise.resolve({
      rows: sqlite.prepare(sql).all(..._p(params ?? [])) as T[],
      changes: 0,
      lastInsertRowId: 0n,
    });
  const execute = (sql: string, params?: unknown[]): Promise<QueryResult> => {
    const r = sqlite.prepare(sql).run(..._p(params ?? []));
    return Promise.resolve({
      rows: [],
      changes: Number(r.changes),
      lastInsertRowId: BigInt(r.lastInsertRowid),
    });
  };
  const transaction = (async (arg: unknown) => {
    if (typeof arg === "function") {
      return await (arg as (tx: Tx) => Promise<unknown>)({ query, execute });
    }
    const out: QueryResult[] = [];
    for (const s of arg as { sql: string; params?: unknown[] }[]) {
      out.push(await execute(s.sql, s.params));
    }
    return out;
    // deno-lint-ignore no-explicit-any
  }) as any;
  const db: DB = {
    query,
    execute,
    transaction,
    close: () => Promise.resolve(),
  };
  const kv = sqliteKv(db);

  const snapshot = {
    todos: Array.from({ length: 50 }, (_, i) => ({
      id: i,
      title: `todo ${i}`,
      done: i % 2 === 0,
    })),
  };
  const WRITES = 500;
  const samples: number[] = [];
  for (let i = 0; i < 50; i++) await kv.set("state", { ...snapshot, seq: i }); // warmup
  for (let i = 0; i < WRITES; i++) {
    const t0 = performance.now();
    await kv.set("state", { ...snapshot, seq: i });
    samples.push(performance.now() - t0);
  }
  record("persist-write", "ms/op", samples);
  sqlite.close();
}

// ── 4. patch compute: reduce + produceWithPatches + compaction ────────
{
  // The pure compute half of the broadcast path (server-broadcast.ts):
  // Immer patch production for a mutation touching 1k of 10k keys, then
  // compactPatches — no sockets.
  const KEYS = 10_000;
  const TOUCH = 1_000;
  const bigState = Object.fromEntries(
    Array.from({ length: KEYS }, (_, i) => [`k${i}`, 0]),
  );
  const p = cell("bench-patch", {
    state: bigState,
    methods: {
      touch(s, seed: number) {
        for (let j = 0; j < TOUCH; j++) {
          s[`k${(seed * 7 + j) % KEYS}`] = seed + j;
        }
      },
    },
  });
  const composed = composeCells([p]);
  let state = composed.initialState;
  const samples: number[] = [];
  for (let i = 0; i < 33; i++) { // first 3 are warmup
    const t0 = performance.now();
    const r = composed.reduce(state, {
      type: "bench-patch:touch",
      payload: { args: [i] },
    }) as ReduceResult;
    state = r.state;
    const groups = r.patches
      ? (Array.isArray(r.patches) ? r.patches : [r.patches])
      : [];
    const ops: Patch[] = groups.flatMap((g) => g.ops);
    compactPatches(ops);
    if (i >= 3) samples.push(performance.now() - t0);
  }
  record("patch-10k", "ms/op", samples);
  _resetAioRuntime();
}

// ── 5. memory: heap delta after boot + 1k dispatches ──────────────────
{
  gc?.();
  await settle(50);
  const h0 = Deno.memoryUsage().heapUsed;
  const m = cell("bench-mem", {
    state: { count: 0 },
    methods: {
      inc(s) {
        s.count += 1;
      },
    },
  });
  const app = await aio.run({ cells: [m], appId: "bench-mem", ...bootOpts });
  let last: Promise<unknown> = Promise.resolve();
  for (let i = 0; i < 1_000; i++) last = m.inc();
  await last;
  await settle(100);
  gc?.();
  const deltaMB = (Deno.memoryUsage().heapUsed - h0) / (1024 * 1024);
  await app.close();
  _resetAioRuntime();
  record("memory-boot-1k", "MB", [Math.max(0, deltaMB)]);
  if (!gc) {
    console.error(
      "warn: --expose-gc not active — memory-boot-1k includes garbage " +
        "(run via `deno task bench` for accurate numbers)",
    );
  }
}

// ── 6. live-proxy over a 10k-item array (async method) ────────────────
// The proxy's cost center: array read-method snapshots + per-element access.
// A regression here means every fetch-then-render list app pays it.
{
  const N = 10_000;
  const big = cell("bench-proxy-arr", {
    state: {
      items: Array.from({ length: N }, (_, i) => ({ id: i, q: i % 97 })),
      sum: 0,
    },
    methods: {
      // deno-lint-ignore require-await
      async crunch(s: { items: { id: number; q: number }[]; sum: number }) {
        // read method over all elements + filter-reassign + length read —
        // the idiomatic shapes, all through the live proxy.
        s.sum = s.items.reduce((a, x) => a + x.q, 0);
        s.items = s.items.filter((x) => x.id !== -1);
        s.sum += s.items.length;
      },
    },
  });
  const app = await aio.run({
    cells: [big],
    appId: "bench-proxy-arr",
    ...bootOpts,
  });
  const samples: number[] = [];
  for (let i = 0; i < 13; i++) { // first 3 are warmup
    const t0 = performance.now();
    // deno-lint-ignore no-explicit-any
    await (big as any).crunch();
    if (i >= 3) samples.push(performance.now() - t0);
  }
  await app.close();
  _resetAioRuntime();
  record("proxy-array-10k", "ms/op", samples);
}

// ── report ────────────────────────────────────────────────────────────
const fmt = (v: number) => v >= 100 ? v.toFixed(1) : v.toFixed(3);
console.log("\nmetric           unit    median      p95    n");
console.log("─".repeat(46));
for (const [name, m] of Object.entries(metrics)) {
  console.log(
    `${name.padEnd(16)} ${m.unit.padEnd(5)} ${fmt(m.median).padStart(8)} ${
      fmt(m.p95).padStart(8)
    } ${String(m.n).padStart(4)}`,
  );
}

const out = {
  meta: {
    date: new Date().toISOString(),
    deno: Deno.version.deno,
    os: Deno.build.os,
    arch: Deno.build.arch,
  },
  metrics,
};
const resultsPath = new URL("../bench-results.json", import.meta.url);
await Deno.writeTextFile(resultsPath, JSON.stringify(out, null, 2) + "\n");
console.log(`\nresults → bench-results.json`);
await Deno.remove(baseDir, { recursive: true }).catch(() => {});
