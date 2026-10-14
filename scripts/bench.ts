// scripts/bench.ts — D12 benchmark suite (perfect-aio): boot, dispatch,
// persistence, patch compute, memory — tracked as CI infrastructure.
// "Correct but slower" fails the gate (scripts/check-bench.ts) like a broken
// test. Each timing metric: warmup + N iterations → median + p95.
// Run: deno task bench   (writes bench-results.json, gitignored)
//      deno task bench -- --only=boot,patch-10k   (those metrics alone,
//      merged into the existing results — the gate's retry of a red metric)
// Gate: deno task check:bench  (compares against scripts/bench-baselines.json)
import { aio, cell, composeCells } from "../mod.ts";
import { compactPatches } from "../src/state/patch-compact.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import type { ReduceResult } from "../src/state/cell-compose-reduce.ts";
import type { DB, QueryResult, Tx } from "../src/db/types.ts";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import type { WirePatch } from "../src/protocol/patch-ops.ts";

// ── stats ─────────────────────────────────────────────────────────────
type Metric = {
  unit: string;
  /** The ROBUST estimator, and what the gate compares. */
  p10: number;
  min: number;
  median: number;
  p95: number;
  n: number;
};
const metrics: Record<string, Metric> = {};

/** Record one metric.
 *
 *  `p10` exists because the gate was unusable without it. A median on a shared
 *  machine is dominated by whatever else is running: measured back-to-back on
 *  an idle-ish box, `proxy-array-10k`'s median ranged 53–70 ms across three
 *  runs of the SAME build — a 30% spread, which is wider than any regression
 *  worth catching. The same runs' p10 ranged 48.9–52.4 (7%), and the minimum
 *  tighter still.
 *
 *  That is not a quirk of this metric: a benchmark measures "how fast can this
 *  go", and every sample above the floor is contamination, not signal. The low
 *  quantile is the standard estimator for exactly that shape, and it is why
 *  the committed ceiling could sit 2x above the real number for a year without
 *  anyone noticing the drift underneath it. Median and p95 are still recorded
 *  — they say something about variance — but the GATE reads p10. */
function record(name: string, unit: string, samples: number[]): void {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
  metrics[name] = {
    unit,
    p10: at(0.1),
    min: s[0]!,
    median: at(0.5),
    p95: at(0.95),
    n: samples.length,
  };
}

/** `--only=a,b`: the metrics to measure; every one when absent. A section
 *  that records several runs when any of its names is asked for. */
const ONLY = Deno.args.find((a) => a.startsWith("--only="))?.slice(7)
  .split(",") ?? null;
const want = (...names: string[]) =>
  !ONLY || names.some((n) => ONLY.includes(n));

const gc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc
  ?.bind(globalThis);
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const baseDir = await Deno.makeTempDir({ prefix: "aio-bench-" });
const bootOpts = {
  client: "server-only",
  persist: false,
  libraryMode: true,
  baseDir,
} as const;

// ── 1. boot: aio.run() resolve time (libraryMode, clean close) ────────
if (want("boot")) {
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
if (want("dispatch-sync", "dispatch-async")) {
  const d = cell("bench-dispatch", {
    // Explicit, not inherited: alpha52 made this the async default, so the
    // numbers below silently changed meaning when it landed. A benchmark that
    // does not state its semantics measures whatever the default happened to be
    // the day the baseline was recorded.
    transaction: true,
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
if (want("persist-write")) {
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
if (want("patch-10k")) {
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
    const ops: WirePatch[] = groups.flatMap((g) => g.ops);
    compactPatches(ops);
    if (i >= 3) samples.push(performance.now() - t0);
  }
  record("patch-10k", "ms/op", samples);
  _resetAioRuntime();
}

// ── 5. memory: heap delta after boot + 1k dispatches ──────────────────
if (want("memory-boot-1k")) {
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
if (want("proxy-array-10k")) {
  const N = 10_000;
  const big = cell("bench-proxy-arr", {
    transaction: true, // explicit — see bench-dispatch
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

// ── 7. read-your-writes overlay: a write loop over a 10k-key map ──────
// The other half of the live proxy's cost: every read AFTER a write resolves
// the overlay. It was rebuilt from a full structuredClone of the cell per
// write, which made this shape quadratic — a field report measured one sweep
// over ~11k keys at 70.7 s of structuredClone with the event loop stalled for
// 54 s. The overlay is incremental now; this metric is what keeps it so.
if (want("overlay-write-loop-10k")) {
  const N = 10_000;
  const seed: Record<string, number> = {};
  for (let i = 0; i < N; i++) seed[`k${i}`] = i;
  const sweeper = cell("bench-overlay", {
    state: { sol: seed, hits: 0 },
    methods: {
      async sweep(s: { sol: Record<string, number>; hits: number }) {
        await Promise.resolve(); // past the await: reads go via the overlay
        let n = 0;
        for (const k of Object.keys(s.sol)) {
          s.sol[k] = s.sol[k]! + 1; // read-your-writes, once per key
          n++;
        }
        s.hits = n;
      },
    },
  });
  const app = await aio.run({
    cells: [sweeper],
    appId: "bench-overlay",
    ...bootOpts,
  });
  const samples: number[] = [];
  for (let i = 0; i < 8; i++) { // first 2 are warmup
    const t0 = performance.now();
    // deno-lint-ignore no-explicit-any
    await (sweeper as any).sweep();
    if (i >= 2) samples.push(performance.now() - t0);
  }
  await app.close();
  _resetAioRuntime();
  record("overlay-write-loop-10k", "ms/op", samples);
}

// ── 8. SSR: stream a 10k-node page whose root is a Provider ───────────
// A Provider renders a Fragment, and the stream writer used to buffer a
// Fragment WHOLE: the first byte of such a page waited for its last component
// (measured ~18 ms on this page, vs ~1 ms for an element root). Fragments
// stream now; `ssr-provider-ttfb` keeps them streaming, and
// `ssr-provider-stream-10k` keeps the streaming cheap.
if (
  want(
    "ssr-provider-stream-10k",
    "ssr-provider-ttfb",
    "ssr-fragment-nest-ratio",
  )
) {
  const { createContext, Fragment, h, renderToStream } = await import(
    "../src/air.ts"
  );
  const Ctx = createContext(0);
  const Row = (p: { i: number }) =>
    h("li", { class: "r" }, "item ", String(p.i));
  const page = () =>
    h(
      Ctx.Provider,
      { value: 1 },
      h(
        "div",
        { id: "app" },
        ...Array.from({ length: 100 }, (_, j) =>
          h(
            "ul",
            { "data-j": j },
            ...Array.from({ length: 50 }, (_, i) => h(Row, { i: j * 100 + i })),
          )),
      ),
    );
  const whole: number[] = [];
  const first: number[] = [];
  for (let i = 0; i < 25; i++) { // first 5 are warmup
    let t0 = performance.now();
    for await (const _ of renderToStream(page())) { /* drain */ }
    if (i >= 5) whole.push(performance.now() - t0);
    const g = renderToStream(page());
    t0 = performance.now();
    await g.next();
    if (i >= 5) first.push(performance.now() - t0);
    await g.return();
  }
  record("ssr-provider-stream-10k", "ms/op", whole);
  record("ssr-provider-ttfb", "ms", first);

  // A chain of 60 nested Fragments (components returning Fragments, stacked
  // Providers), as a RATIO to the same chain built of <span>s, timed in the
  // same sample (each side the best of 3). A ratio is machine-independent, so
  // its floor can be tight — an absolute ms floor at 2x p10 let a +42%
  // slowdown of the Fragment path through. Measured ~0.8: a streamed Fragment
  // costs less than an element (no tag to write). Writing its region through
  // a helper generator (`yield* _streamRegion()`) cost ~1.3 here, and 1.0.9's
  // buffered Fragment ~1.1.
  const Item = (p: { n: number }) => h("li", null, h("b", null, "x"), p.n);
  const nest = (d: number, tag: unknown): ReturnType<typeof h> =>
    d === 0
      ? h(Item, { n: 0 })
      : h(tag as string, null, nest(d - 1, tag), h(Item, { n: d }));
  const time = async (tag: unknown) => {
    const t0 = performance.now();
    for (let k = 0; k < 10; k++) {
      for await (const _ of renderToStream(h("div", null, nest(60, tag)))) {
        /* drain */
      }
    }
    return performance.now() - t0;
  };
  const ratio: number[] = [];
  for (let i = 0; i < 25; i++) { // first 5 are warmup
    let f = Infinity, e = Infinity;
    for (let j = 0; j < 3; j++) {
      f = Math.min(f, await time(Fragment));
      e = Math.min(e, await time("span"));
    }
    if (i >= 5) ratio.push(f / e);
  }
  record("ssr-fragment-nest-ratio", "x", ratio);
}

// ── 9. the op door: one sync op over a real WebSocket, to its ack ─────
// What a local-first client waits for on every write: the frame in, the op
// persisted to the op-log (the ack is a durability promise — it follows the
// commit), the `sync-ack` out. One op at a time, each awaited, so the number
// is the round trip a single writer sees, not a batch's amortized share. Both
// durability settings an app can ask for: the default `synchronous = NORMAL`
// and `FULL` (an fsync per commit — the disk's number as much as ours, which
// is why it has its own floor).
for (const mode of ["NORMAL", "FULL"] as const) {
  const name = `op-door-${mode.toLowerCase()}`;
  if (!want(name)) continue;
  const notes = cell(`bench-${name}`, {
    sync: true,
    version: 1,
    state: { n: 0 },
    methods: {
      add(s, by: number) {
        s.n += by;
      },
    },
  });
  const port = freePort();
  const app = await aio.run({
    cells: [notes],
    appId: `bench-${name}`,
    client: "server-only",
    libraryMode: true,
    baseDir,
    appDir: `${baseDir}/${name}`,
    dbPragmas: [`PRAGMA synchronous = ${mode}`],
    // The per-client throttle (100 messages/s by default) drops the 101st op
    // of a second: the door is what is measured here, not the throttle.
    wsLimits: { messagesPerSec: 1_000_000 },
    port,
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const waiting = new Map<string, () => void>();
  ws.onmessage = (e) => {
    if (typeof e.data !== "string" || !e.data.includes('"sync-ack"')) return;
    const f = JSON.parse(e.data) as { t: string; d: { opId: string } };
    if (f.t === "sync-ack") waiting.get(f.d.opId)?.();
  };
  await new Promise<void>((ok, fail) => {
    ws.onopen = () => ok();
    ws.onerror = () => fail(new Error(`op-door: no WebSocket on :${port}`));
  });
  const OPS = 300;
  const samples: number[] = [];
  for (let i = 0; i < OPS + 30; i++) { // first 30 are warmup
    const id = `op-${mode}-${i}`;
    const acked = new Promise<void>((r) => waiting.set(id, r));
    const t0 = performance.now();
    ws.send(JSON.stringify({
      v: 2,
      t: "op",
      d: {
        id,
        hlc: [Date.now(), i, "bench"],
        cell: `bench-${name}`,
        action: "add",
        payload: { args: [1] },
      },
    }));
    // An ack that never comes is a failure with a name, not a gate that
    // hangs until its ceiling.
    let late: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      acked,
      new Promise<never>((_, fail) => {
        late = setTimeout(
          () => fail(new Error(`${name}: no sync-ack for ${id} within 10 s`)),
          10_000,
        );
      }),
    ]);
    clearTimeout(late);
    waiting.delete(id);
    if (i >= 30) samples.push(performance.now() - t0);
  }
  const closed = new Promise((r) => ws.onclose = r);
  ws.close();
  await closed;
  // Every op must have LANDED: an ack for an op the server refused would make
  // this a benchmark of the refusal path.
  const landed =
    (app.getState() as Record<string, { n: number }>)[`bench-${name}`]?.n;
  await app.close();
  _resetAioRuntime();
  if (landed !== OPS + 30) {
    throw new Error(
      `${name}: ${landed} of ${OPS + 30} ops applied — the bench is ` +
        `not measuring an accepted op`,
    );
  }
  record(name, "ms/op", samples);
}

// ── 10. one row of 10k: a dispatch that changes ONE flag in a big array ──
// The cost of a change must follow the change, not the state beside it. With
// the dev defaults on (state diffs, time travel, checkpoint — what a
// developer runs), toggling one row of a 10 000-row array cost 4.1 ms here:
// the state-diff line serialized the whole array twice to print 80
// characters of it. What is left is the state core's own share — Immer
// copies and finalizes the array the row is in (0.4 ms at 10k).
if (want("row-toggle-10k")) {
  const ROWS = 10_000;
  const rows = cell("bench-rows", {
    state: {
      items: Array.from(
        { length: ROWS },
        (_, i) => ({ id: i, done: false, title: `row ${i}` }),
      ),
    },
    methods: {
      toggle(s, i: number) {
        s.items[i]!.done = !s.items[i]!.done;
      },
    },
  });
  const app = await aio.run({
    cells: [rows],
    appId: "bench-rows",
    ...bootOpts,
  });
  const samples: number[] = [];
  for (let i = 0; i < 140; i++) { // first 20 are warmup
    const t0 = performance.now();
    await rows.toggle((i * 7) % ROWS);
    if (i >= 20) samples.push(performance.now() - t0);
  }
  await app.close();
  _resetAioRuntime();
  record("row-toggle-10k", "ms/op", samples);
}

// ── 11. an update patch applied to a 64 MiB install ────────────────────
// What a single-file install does instead of downloading the release: read
// the installed file and decode a zstd patch against it (updates-patch.ts).
// The cost is the copy — install and output share one buffer — so the time
// follows the artifact's size, and the memory is install + release.
if (want("update-patch-64m", "update-patch-64m-rss")) {
  const { applyPatch } = await import("../src/server/updates-patch.ts");
  const { patchOf } = await import("../tests/zstd-patch-helper.ts");
  const SIZE = 64 << 20;
  const from = new Uint8Array(SIZE);
  for (let at = 0; at < SIZE; at += 65536) {
    crypto.getRandomValues(from.subarray(at, at + 65536));
  }
  // A rebuild: the same file with a few kilobytes in the middle replaced.
  const to = from.slice();
  crypto.getRandomValues(to.subarray(SIZE / 2, SIZE / 2 + 20_000));
  const installed = `${baseDir}/installed`;
  await Deno.writeFile(installed, from);
  const patch = patchOf(from, to);
  const ms: number[] = [];
  for (let i = 0; i < 8; i++) { // first 2 are warmup
    const t0 = performance.now();
    const made = await applyPatch(installed, patch, SIZE);
    const took = performance.now() - t0;
    if (made[SIZE / 2 + 5] !== to[SIZE / 2 + 5] || made.length !== SIZE) {
      throw new Error("update-patch-64m: the patch made other bytes");
    }
    if (i >= 2) ms.push(took);
  }
  record("update-patch-64m", "ms/op", ms);
  // Memory, each time in a process of its own: in this one the buffer of
  // the run before is reused and the growth reads as zero.
  await Deno.writeFile(`${baseDir}/patch`, patch);
  const rss: number[] = [];
  for (let i = 0; i < 3; i++) {
    const run = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `import { applyPatch } from ${
          JSON.stringify(import.meta.resolve("../src/server/updates-patch.ts"))
        };
        const patch = Deno.readFileSync(${JSON.stringify(`${baseDir}/patch`)});
        const before = Deno.memoryUsage().rss;
        const made = await applyPatch(${
          JSON.stringify(installed)
        }, patch, ${SIZE});
        console.log((Deno.memoryUsage().rss - before) / 2 ** 20, made.length);`,
      ],
      stderr: "inherit",
    }).output();
    const [grew, size] = new TextDecoder().decode(run.stdout).split(" ").map(
      Number,
    );
    if (size !== SIZE) throw new Error("update-patch-64m-rss: no result");
    rss.push(grew!);
  }
  record("update-patch-64m-rss", "MiB", rss);
}

// ── report ────────────────────────────────────────────────────────────
const fmt = (v: number) => v >= 100 ? v.toFixed(1) : v.toFixed(3);
console.log(
  "\nmetric                 unit       p10   median      p95    n",
);
console.log("─".repeat(62));
for (const [name, m] of Object.entries(metrics)) {
  console.log(
    `${name.padEnd(22)} ${m.unit.padEnd(5)} ${fmt(m.p10).padStart(9)} ${
      fmt(m.median).padStart(8)
    } ${fmt(m.p95).padStart(8)} ${String(m.n).padStart(4)}`,
  );
}

const resultsPath = new URL("../bench-results.json", import.meta.url);
// `--only` replaces the metrics it measured and keeps the rest of the file.
const kept: Record<string, Metric> = ONLY
  ? (JSON.parse(await Deno.readTextFile(resultsPath)) as {
    metrics: Record<string, Metric>;
  }).metrics
  : {};
const out = {
  meta: {
    date: new Date().toISOString(),
    deno: Deno.version.deno,
    os: Deno.build.os,
    arch: Deno.build.arch,
  },
  metrics: { ...kept, ...metrics },
};
await Deno.writeTextFile(resultsPath, JSON.stringify(out, null, 2) + "\n");
console.log(`\nresults → bench-results.json`);
await Deno.remove(baseDir, { recursive: true }).catch(() => {});
