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

// GOOD -- flag first, then hand the COMPUTE to a worker thread
methods: {
  async analyze(s) {
    s.analyzing = true                      // commits immediately, UI updates now
    s.results = await schedule.blocking("analyze", heavyComputation, s.data)
    s.analyzing = false
  },
},
```

> ⚠️ `await` is not an escape hatch for CPU work. Awaiting a function that
> computes for 250ms still blocks the isolate for 250ms — the `await` only
> yields once the work is already done. `await` helps for **I/O** (the runtime
> does the waiting elsewhere); for **compute** you need another thread — see
> [Move it off-thread](#move-it-off-thread).

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

## Move it off-thread

`schedule.blocking(id, fn, arg)` runs a function on a **worker pool** — a real
OS thread, not a promise — so it cannot block rendering, the dispatch loop, or
anyone else's actions. It is the answer whenever the work is CPU-bound, FFI, or
a sync API you can't avoid.

```ts
import { cell, schedule } from "aio";

type Row = { id: number; score: number };

export const report = cell("report", {
  state: { status: "idle", rows: [] as Row[] },
  methods: {
    async build(s, raw: number[]) {
      s.status = "building"; // instant — the UI reflects this immediately

      // Off-thread: the isolate stays free, other clients keep dispatching.
      // The function is SELF-CONTAINED — everything it needs is inside it or
      // arrives as `arg`. It cannot see `raw`, `s`, or any import up here.
      s.rows = await schedule.blocking("report:build", (input) => {
        const nums = input as number[];
        const out: { id: number; score: number }[] = [];
        for (const n of nums) out.push({ id: n, score: Math.sqrt(n) * n }); // seconds of CPU
        return out.sort((a, b) => b.score - a.score);
      }, raw);

      s.status = "done";
    },
    cancel() {
      schedule.blocking.cancel("report:build"); // terminates the worker
    },
  },
});
```

Need one of your own modules in there? Import it **inside** the function —
`const { crunch } = await import("./crunch.ts")` — the worker resolves it
itself. Closing over an outer `crunch` cannot work: only the function's source
crosses the thread boundary.

**The contract** (the price of a real thread):

- the function is **self-contained** — it is serialized to source and rebuilt in
  the worker, so it cannot close over outer variables; pass what it needs as
  `arg`
- `arg` and the result must be **structured-cloneable** (plain data)
- do FFI setup (`Deno.dlopen`) **inside** the function
- the pool is sized to `hardwareConcurrency - 1` and queues beyond that, so a
  burst backpressures instead of spawning unbounded threads
- `schedule.blocking.cancel(id)` drops a queued task or terminates a running one
  — the only way to stop a busy thread; `dispose()` tears the pool down

### In the browser

Cell methods run on the server, so most compute never touches the UI thread at
all. What can: work you do _inside a component_ (sorting a big list, parsing a
large document, chart math) and client-scoped cell methods.

- **Render is already frame-budgeted.** AIR renders until a 12ms deadline of the
  16ms frame, then yields and re-queues the rest — a burst of updates degrades
  into more frames, never into a frozen tab.
- **Derive once, not per render:** `useProjection(fn, deps)` keeps derived data
  structurally shared instead of rebuilt on every pass.
- **Genuinely heavy client compute belongs in a `Worker`** — the same rule as
  the server, without a framework wrapper (aio doesn't bundle one for you yet):

```ts
// worker.ts is bundled by your app; postMessage in, onmessage out.
const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});
```

aio tells you when the UI thread stalls: the render meter measures staleness and
frame time on every frame, and a stall surfaces as `UI_FREEZE` in the console
and at `/__aio/vitals`.

**Which tool for which work:**

| Work                                   | Do this                                                               |
| -------------------------------------- | --------------------------------------------------------------------- |
| I/O (fetch, file, DB)                  | `async` method + `await` — the runtime waits, not you                 |
| CPU (parse, crunch, encode, hash loop) | `schedule.blocking(...)`                                              |
| Blocking FFI / sync-only API           | `schedule.blocking(...)`                                              |
| A whole CELL that does dangerous work  | `worker: true` on the cell ([cell workers](../state/cell-workers.md)) |
| Slow work on a timer                   | `schedule.every(...)` whose action does the above                     |
| Big state clients don't need           | `ui: { exclude: [...] }` — don't ship it at all                       |

## Budget configuration

### Modes

| Mode             | Behavior                           |
| ---------------- | ---------------------------------- |
| `'on'` (default) | Logs perf violations to `perf.log` |
| `'off'`          | Disables perf measurement entirely |

**Dev is stricter on purpose.** The default reduce budget is **16ms (one frame)
in dev** and 100ms in prod. A reduce runs on the server's single dispatch path,
so the time it takes is time every connected client's next action waits — dev
tells you at one frame, while the app is small enough to fix cheaply. Reports
are throttled to one per action type per 10s, so a hot path won't spam. Override
either side with `perfBudget`.

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

## `am cost` — what aio moves on your behalf

aio warns that your state may be too big in three places (`aiol`'s typed-array
hint, its state-key count, and the pressure monitor) and ships three remedies
(`ui:` filters, `cellDefaults`, `syncIntervalMs`). This is how you find out
whether any of it applies to you.

```sh
am cost                     # last 60s, top 3 keys per cell
am cost --keys              # every key
am cost --cell=hw           # one cell
am cost --window=5m         # a longer window
am cost --json              # for scripts
```

```
cell  pushes/s    bytes/s     mean  p95 reduce   state  top keys by bytes
hw         1.0   7.7 KB/s   7.7 KB      0.4 ms  7.9 KB  cpuHistory 2.1 KB · coresUtil 1.8 KB · gpus 1.4 KB
chat       0.0          —        —      3.1 ms    15 B  (idle)
──────────────────────────────────────────────────────────────────────────────
per client             8.1 KB/s
clients connected         3  24.3 KB/s   (all surfaces)
frames       3.0/s   243.2 KB total
full resends       10%  2 of 20 state pushes (+5 acks/diagnostics)

window  last 60s
```

**What each number is, exactly**

| column         | meaning                                                             |
| -------------- | ------------------------------------------------------------------- |
| `pushes/s`     | broadcast rounds that carried a change from this cell               |
| `bytes/s`      | serialized size of that cell's changed values (payload **content**) |
| `mean`         | content bytes per push                                              |
| `p95 reduce`   | this cell's reduce time, 95th percentile, over the window           |
| `state`        | the cell's whole slice, serialized — what is THERE, not what moves  |
| `top keys`     | which keys those bytes came from, biggest first                     |
| `per client`   | **wire** bytes per second for ONE surface — the unit price of a tab |
| `full resends` | share of state pushes that sent the whole state instead of a diff   |

The wire totals are the exact byte length of every frame handed to a socket —
handshake, patches, full states, acks and diagnostics alike. A test holds them
against a real WebSocket client counting its own inbound bytes, and they must be
equal (`tests/cost-wire-accuracy.test.ts`). Per-cell `bytes/s` counts payload
**content**, which is smaller than the wire total because the envelope and the
JSON-Patch paths are not attributed to any one key. The two are reported
separately and never added.

**Reading it**

- `full resends` above ~50% means diffs are not being used: a `"full"`-strategy
  cell, or patches exceeding `fullStateThreshold` (default: patch > 50% of
  full). A small state often resends fully — that is cheaper, not a bug.
- A big `state` with a small `bytes/s` is fine: it is _there_, not moving.
- A big `bytes/s` from one key is the case `ui:` filters exist for.
- `(idle)` means the cell pushed nothing. A cell can burn reduce time and cost
  the wire nothing — "busy but free" is a real and useful answer.

It is always on (bounded rings on a path that already serializes), reports and
does not advise, and keeps no history — the journal and time-travel own "what
happened then".

### Per-method budgets — for the method that is MEANT to be slow

A budget is a claim about what should be fast. Some methods aren't: spawning
cmake, reading a 2 MB header, draining a subprocess pipe. Raising the global
budget to silence one of them blinds every tight reducer at the same time — one
app ended up at `{ reduce: 100, effect: 1000 }` plus a 30 s timeout "and lost
the signal everywhere to silence one poller".

Say it per method instead, keyed `"cell:method"`:

```ts
await aio.run({
  cells: [builds, hw],
  perfBudget: {
    effect: 5, // everything stays strict…
    methods: {
      "builds:compile": { effect: 5_000, timeout: 600_000 }, // …except this one
      "hw:poll": { effect: 250 },
    },
  },
});
```

`timeout` raises the hard "abandon this effect" deadline for that method alone,
so a four-minute build doesn't need a four-minute global timeout. A violation
report names the method (`builds:compile`), not the shared `builds:__exec`
effect type, so the log says which one to look at.

Reach for this when a method awaits I/O by design. If a method is slow because
it computes, the budget is telling you the truth — move the work with
`schedule.blocking` instead (see above).

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

1. **Keep reduce fast** -- state updates should be instant. Heavy computation
   goes off-thread (`schedule.blocking`), not into an effect on the same thread.
2. **Effects should return immediately** -- kick off async work, don't block.
3. **Use `perfCheck: 'on'` (default)** -- logs violations to `perf.log`
   automatically.
4. **Check the breakdown** -- `produce` dominating means reducer is doing too
   much. `clone` high means too many/large effects returned from reducer.
5. **Phase breakdown** is also available in the time-travel panel (dev mode) on
   every action's `PerfMetric`, and in `perf.log`.
