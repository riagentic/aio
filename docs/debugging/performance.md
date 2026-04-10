# Performance

Performance budgets, slow reducer/effect diagnosis, and budget configuration.

## Overview

AIO tracks how long reducers and effects take, warning when operations exceed
budget. This catches blocking work that makes the UI unresponsive.

Every action is timed:

- **reduce budget** (default: 100ms) -- if `reduce()` takes longer, it's flagged
  as `BUDGET_REDUCE`
- **effect budget** (default: 5ms) -- if sync portion of `execute()` takes
  longer, it's flagged as `BUDGET_EFFECT`

Async effects (promises) return immediately -- only the sync part is measured.

```ts
execute: {
  // GOOD -- async, returns in < 1ms
  fetch(app, payload) {
    fetch(payload.url).then(r => app.dispatch(myCell.loaded(r)))
  },

  // BAD -- sync work blocks
  process(_app, payload) {
    const data = heavyComputation(payload)  // 500ms sync -- blocks!
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

If `produce` dominates, your reducer is doing too much work:

```ts
// BAD -- blocks for 250ms
methods: { analyze(s) { s.results = heavyComputation(s.data) } }

// GOOD -- reducer sets flag, execute does work async
reduce: { analyze(state) { state.analyzing = true } },
execute: {
  async runAnalysis(app, payload) {
    const results = await heavyComputation(payload.data)
    app.dispatch(myCell.analysisDone(results))
  },
},
```

---

## Slow effect diagnosis

The _synchronous_ part of your effect is too slow. Return immediately and do
work asynchronously:

```ts
// BAD -- blocking file read
execute: {
  load(app) {
    const data = JSON.parse(Deno.readTextFileSync('big.json'))
    app.dispatch(myCell.done(data))
  },
}

// GOOD -- async
execute: {
  load(app) {
    Deno.readTextFile('big.json')
      .then(text => app.dispatch(myCell.done(JSON.parse(text))))
  },
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
