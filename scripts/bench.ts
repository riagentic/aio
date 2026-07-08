// Performance benchmarks with CI regression floors (roadmap B4).
// Each workload must sustain a minimum ops/sec — floors are set ~10x below
// a dev-laptop baseline so only real regressions (algorithmic, not machine
// noise) trip them. Run: deno task bench
import { batch, computed, signal } from "../src/state/signal.ts";
import { cell } from "../src/state/cell.ts";
import { composeCells } from "../src/state/cell-compose.ts";

type Result = { name: string; opsPerSec: number; floor: number; ok: boolean };
const results: Result[] = [];

function bench(name: string, floor: number, iters: number, fn: () => void) {
  // warmup
  for (let i = 0; i < Math.min(iters / 10, 1000); i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = performance.now() - t0;
  const opsPerSec = Math.round(iters / (ms / 1000));
  results.push({ name, opsPerSec, floor, ok: opsPerSec >= floor });
}

// ── 1. signal graph: 100 signals → 100 computeds → 1 aggregate ──────
{
  const sigs = Array.from({ length: 100 }, (_, i) => signal(i));
  const comps = sigs.map((s) => computed(() => s.value * 2));
  const agg = computed(() => comps.reduce((a, c) => a + c.value, 0));
  let i = 0;
  bench(
    "signal-graph: write + aggregate pull (100 wide)",
    20_000,
    50_000,
    () => {
      sigs[i % 100]!.set(i++);
      agg.value; // pull through the graph
    },
  );
}

// ── 2. batched signal writes: 100 writes per batch, one flush ────────
{
  const sigs = Array.from({ length: 100 }, (_, i) => signal(i));
  const total = computed(() => sigs.reduce((a, s) => a + s.value, 0));
  let round = 0;
  bench("signal-batch: 100 writes + flush", 10_000, 5_000, () => {
    batch(() => {
      for (const s of sigs) s.set(round);
    });
    total.value;
    round++;
  });
}

// ── 3. cell reduce throughput: real composed pipeline (Immer) ────────
{
  const bench_cell = cell("benchcell", {
    state: { count: 0, items: [] as number[] },
    methods: {
      inc(s: { count: number }, by = 1) {
        s.count += by;
      },
    },
  });
  const composed = composeCells([bench_cell]);
  let state = composed.initialState;
  const action = { type: "benchcell:inc", payload: { args: [1] } };
  bench("cell-reduce: composed Immer pipeline", 80_000, 30_000, () => {
    state = composed.reduce(state, action).state;
  });
}

// ── 4. persist write path: KV snapshot writes ────────────────────────
{
  const dir = await Deno.makeTempDir({ prefix: "aio-bench-kv-" });
  const kv = await Deno.openKv(`${dir}/bench.db`);
  const snapshot = {
    todos: Array.from({ length: 50 }, (_, i) => ({
      id: i,
      title: `todo ${i}`,
      done: i % 2 === 0,
    })),
  };
  let seq = 0;
  const t0 = performance.now();
  const WRITES = 500;
  for (let i = 0; i < WRITES; i++) {
    await kv.set(["bench", "state"], { ...snapshot, seq: seq++ });
  }
  const ms = performance.now() - t0;
  const opsPerSec = Math.round(WRITES / (ms / 1000));
  const floor = 200;
  results.push({
    name: "persist: KV snapshot write (50-item cell)",
    opsPerSec,
    floor,
    ok: opsPerSec >= floor,
  });
  kv.close();
  await Deno.remove(dir, { recursive: true });
}

// ── report ────────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
  const mark = r.ok ? "✓" : "✗";
  console.log(
    `${mark} ${r.name}: ${r.opsPerSec.toLocaleString()} ops/s (floor ${r.floor.toLocaleString()})`,
  );
  if (!r.ok) failed++;
}
if (failed) {
  console.error(`\n${failed} benchmark(s) below regression floor.`);
  Deno.exit(1);
}
console.log("\n✓ all benchmarks above regression floors");
