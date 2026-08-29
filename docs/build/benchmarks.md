# Benchmarks — the D12 perf gate

Performance is CI infrastructure (perfect-aio D12): boot time, dispatch
throughput, persistence writes, patch compute, and memory are tracked, and
"correct but slower" fails the gate like a broken test.

## Run

```sh
deno task bench          # measure → table + bench-results.json (gitignored)
deno task check:bench    # run bench, then gate against scripts/bench-baselines.json
deno task check:bench --cached   # gate the last bench-results.json, no re-run
```

Total runtime is a few seconds; everything is pure Deno, no external deps.

## What's measured

Each timing metric runs a warmup pass, then N iterations, and reports **p10**,
the **median** and **p95** (`scripts/bench.ts`). **p10 is what the gate reads**
— see [Noise policy](#noise-policy) for why a median could not be.

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

`scripts/bench-baselines.json` (committed) holds one **floor per metric** (under
the key `maxMedian`, whose name predates the estimator change).
`scripts/check-bench.ts` compares each measured **p10** against its floor and
exits 1 naming the metric, the measured value, and the floor. The median and p95
are recorded for context — they say something about variance — but the gate
reads p10.

It also **reports a floor sitting 3x or more above its number**, because a
ceiling that far up is not gating anything and the next person to look should be
told rather than have to notice.

## Noise policy

**Why p10 and not the median.** Measured on a shared machine, three back-to-back
runs of the _same build_ spread `proxy-array-10k`'s median across 53–70 ms — a
30% swing, wider than any regression worth catching. The same runs' p10 spread
48.9–52.4 (7%). A benchmark asks "how fast can this go", so every sample above
the floor is contamination rather than signal, and the low quantile is the
estimator for that question. The consequence of not having one: before alpha72
every floor sat 2.4–7.3x above its number to absorb the measurement, and
`proxy-array-10k` drifted 30 → 55 ms underneath a floor of 75 without anyone
being told.

- Floors are **2x the measured p10** — enough to cover a slower CI box, and
  nothing else. They are lowered whenever a metric gets faster.
- **Never ratchet on noise** (same policy as the coverage gate): a green run
  that happens to be fast is not a reason to lower floors, and a red run on a
  loaded machine is a reason to re-run, not to raise them. Running the full test
  suite concurrently is enough to push `proxy-array-10k` from 56 to 83.
- Raising a floor is an explicit decision: only for an understood, accepted
  cost, with the new measured numbers updated alongside it in
  `scripts/bench-baselines.json`.
