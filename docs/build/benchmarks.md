# Benchmarks — the D12 perf gate

Performance is CI infrastructure (perfect-aio D12): boot time, dispatch
throughput, persistence writes, patch compute, and memory are tracked, and
"correct but slower" fails the gate like a broken test.

## Run

```sh
deno task bench          # measure → table + bench-results.json (gitignored)
deno task bench:check    # run bench, then gate against scripts/bench-baselines.json
deno task bench:check --cached   # gate the last bench-results.json, no re-run
```

Total runtime is a few seconds; everything is pure Deno, no external deps.

## What's measured

Each timing metric runs a warmup pass, then N iterations, and reports the
**median** and **p95** (`scripts/bench.ts`):

| metric            | unit  | what                                                                                                                                   |
| ----------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `boot`            | ms    | `aio.run()` resolve time — libraryMode, server-only, no persist — then clean `app.close()`                                             |
| `dispatch-sync`   | ms/op | sync method calls on a bound cell (10k increments per batch, awaiting the last)                                                        |
| `dispatch-async`  | ms/op | async method full round-trips, awaited individually (1k per batch)                                                                     |
| `persist-write`   | ms/op | `sqliteKv().set()` — the SkvInstance SQLite path, in-memory DB, real snapshot payloads                                                 |
| `patch-10k`       | ms/op | the pure compute half of broadcast: Immer `produceWithPatches` for a 1k-key mutation on a 10k-key cell + `compactPatches` (no sockets) |
| `memory-boot-1k`  | MB    | heap delta (`Deno.memoryUsage().heapUsed`) after boot + 1k dispatches, GC-forced via `--expose-gc`                                     |
| `proxy-array-10k` | ms/op | an async method crunching a 10k-item array through the live proxy (reduce + filter-reassign + length) — the hot-cell commit cost       |

Results go to stdout (compact table) and `bench-results.json` (gitignored).

**The hot-cell number, plainly:** a cell method's commit cost scales with the
cell's **tree size** (Immer draft + finalize + freeze over the whole slice), not
with the size of the change — a real game measured ≈1.8 ms/tick on a ~330-object
tree against 0.03 ms of actual logic. Fine at 60 fps, but it is the number that
decides whether a given cadence is viable in a server cell; when it stops
fitting, the structural move is `scope: 'client'` — see
[real-time state](../state/real-time.md).

## Baselines & the gate

`scripts/bench-baselines.json` (committed) holds one **floor per metric**:
`maxMedian` — the maximum acceptable median. `scripts/check-bench.ts` compares
each measured median against its floor and exits 1 naming the metric, measured
value, and floor on any violation. p95 is recorded for context but not gated
(too noisy for a shared machine).

## Noise policy

- Floors carry **at least 2x headroom** over the measured medians recorded in
  the baselines file (small/jittery metrics like `persist-write` and
  `memory-boot-1k` get more). The gate exists to catch **2x+ regressions** —
  algorithmic mistakes, accidental sync-in-loop, leaked per-op allocations — not
  machine noise.
- **Never ratchet on noise** (same policy as the coverage gate): a green run
  that happens to be fast is not a reason to lower floors, and a red run on a
  loaded machine is a reason to re-run, not to raise them.
- Raising a floor is an explicit decision: only for an understood, accepted
  cost, with the new measured medians updated alongside it in
  `scripts/bench-baselines.json`.
