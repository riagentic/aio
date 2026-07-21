# Performance

Performance budgets, slow reducer/effect diagnosis, and budget configuration.

## Overview

AIO tracks how long reducers and effects take, warning when operations exceed
budget. This catches blocking work that makes the UI unresponsive.

Every action is timed:

- **reduce budget** (default: 100ms) -- if a sync method takes longer, it's
  flagged as `BUDGET_REDUCE`
- **effect budget** (default: 5ms) -- if the sync portion of the executor
  (async-method trigger, effect handling) takes longer, it's flagged as
  `BUDGET_EFFECT`

Async methods suspend at `await` -- only sync stretches are measured.

```ts
methods: {
  // GOOD -- awaits, each sync stretch returns in < 1ms
  async load(s, url: string) {
    s.data = await fetch(url).then((r) => r.json())
  },

  // BAD -- sync work blocks
  process(s, payload: Data) {
    s.result = heavyComputation(payload)  // 500ms sync -- blocks!
  },
},
```

---

## Slow reducer diagnosis

When a reduce exceeds its budget, the log includes a phase breakdown:

```
BUDGET_REDUCE in cell 'counter'
Action: counter:analyze
Duration: 250.0ms (budget: 100ms)
(produce=180ms clone=45ms spread=2ms routing=20ms listeners=3ms)
```

| Phase       | What it measures                                     | If slow                       |
| ----------- | ---------------------------------------------------- | ----------------------------- |
| `produce`   | Immer `produce()` + effect cloning (inside callback) | Move computation to effect    |
| `clone`     | Legacy — now included in `produce` timing            | N/A                           |
| `spread`    | State object construction                            | Too many cells?               |
| `routing`   | Owner cell lookup + reduce dispatch                  | Shouldn't be slow             |
| `listeners` | Foreign action listener fan-out                      | Too many cross-cell listeners |

If `produce` dominates, your sync method is doing too much work:

```ts
// BAD -- blocks for 250ms
methods: { analyze(s) { s.results = heavyComputation(s.data) } }

// GOOD -- async method: flag first, then work off the sync path
methods: {
  async analyze(s) {
    s.analyzing = true                            // commits immediately
    s.results = await heavyComputationAsync(s.data)
    s.analyzing = false
  },
},
```

---

## Slow effect diagnosis

A _synchronous_ stretch of an async method is too slow. Use async APIs so the
method suspends instead of blocking:

```ts
// BAD -- blocking file read inside an async method
async load(s) {
  s.data = JSON.parse(Deno.readTextFileSync('big.json'))  // sync block
}

// GOOD -- async API, event loop stays free
async load(s) {
  const text = await Deno.readTextFile('big.json')
  s.data = JSON.parse(text)
}
```

---

## Budget configuration

### Modes

| Mode             | Behavior                           |
| ---------------- | ---------------------------------- |
| `'on'` (default) | Logs perf violations to `perf.log` |
| `'off'`          | Disables perf measurement entirely |

### Custom budgets

```ts
await aio.run({
  cells: [counter],
  perfCheck: "on", // or 'off'
  perfBudget: { reduce: 50, effect: 10 }, // ms
});
```

Both modes apply the action -- state changes normally. This keeps your app
functional while surfacing issues.

### Catching performance errors

```ts
await aio.run({
  cells: [...],
  onError: (err) => {
    if (err.source === "performance") {
      console.error(
        `Slow ${err.actionType ?? err.effectType}: ${err.duration}ms > ${err.budget}ms`
      );
    }
  },
});
```

---

## Best practices

1. **Keep reduce fast** -- state updates should be instant. Move heavy
   computation to effects.
2. **Effects should return immediately** -- kick off async work, don't block.
3. **Use `perfCheck: 'on'` (default)** -- logs violations to `perf.log`
   automatically.
4. **Check the breakdown** -- `produce` dominating means reducer is doing too
   much. `clone` high means too many/large effects returned from reducer.
5. **Phase breakdown** is also available in the time-travel panel (dev mode) on
   every action's `PerfMetric`, and in `perf.log`.
