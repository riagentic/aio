# Cell workers (`worker: true`) — design

Status: **design** (nothing built). Date: 2026-07-25. Origin: the responsiveness
audit — "can aio keep an app responsive even when the developer does a poor
job?"

## The decision being designed

A cell may opt into running **its methods in its own Deno worker**, so a method
that blocks — a loop, an FFI call, a parser, anything data-dependent — can only
stall that cell. Every other cell, every other user, and the whole transport
keep running, and a runaway method can be killed and its cell restarted.

Explicitly **not** designed: automatic offloading. See "Why not automatic".

## What the developer sees

```ts
export const reports = cell("reports", {
  worker: true, // ← the entire opt-in
  state: { rows: [] as Row[] },
  methods: {
    async build(s, raw: number[]) {
      s.rows = crunch(raw); // `crunch` is a normal import — no serialization limits
    },
  },
});
```

The intended loop is **observe → flip**: aio already measures every reduce by
name (budget violations, p95, queue depth, pressure). When a cell keeps blowing
its budget, the diagnostic should say so _and name the flag_ — "cell `reports`
exceeded the reduce budget 12× in 60s — consider `worker: true`". The developer
decides; the framework does the noticing and makes the fix one word.

## Why this is cheap in aio specifically

| Already true                                           | Why it matters                                   |
| ------------------------------------------------------ | ------------------------------------------------ |
| State is **per cell**                                  | a cell is already the isolation unit             |
| Mutations already produce **Immer patches**            | patches are what would cross the thread boundary |
| Patches are already the **wire format**                | no new serialization to invent                   |
| The main isolate already applies patches for clients   | it becomes "just another client" of the cell     |
| Persistence + broadcast consume patches                | unchanged by construction                        |
| Workers are already used (SQLite, `schedule.blocking`) | the primitive and its failure modes are known    |

## Boot protocol

1. `aio.run()` sees `worker: true` on a cell and spawns
   `new Worker(<app entry>, { type: "module" })` with `AIO_CELL_WORKER=<name>`.
2. The worker imports the **app's own entry**, so every cell definition (and
   every helper the method closes over) exists exactly as in the main isolate.
   `aio.run()` in that context detects the marker and binds only the named cell
   instead of booting a server.
3. Dispatches for that cell are `postMessage`d in (structured-cloned args); the
   resulting patches (and the method's return value) come back the same way.
4. The main isolate keeps a **read-only replica** of the cell's state, updated
   by those patches — which is what `getUIState`, persistence and broadcast
   already read.

## Seams it touches

- **Ambient context** — `serverUser()` / `serverRequest()` are plain data; they
  forward with the dispatch and re-enter the worker's ALS.
- **Cross-cell access** — a sync read of another cell from inside a worker cell
  (`other.field`) must become async, or be rejected at boot with a clear error.
  Same for `listensTo` fan-out into a worker cell (already message-shaped).
- **Transactions** — `transaction: true` stays _within_ one cell; a transaction
  spanning a worker cell and a main-isolate cell is not expressible and must
  fail loudly at boot.
- **Module singletons** — the worker gets its own copy (a module-scope DB
  connection becomes two). Document it; `aio doctor` can warn when a worker
  cell's module graph opens a connection at import time.
- **Return values** — must be structured-cloneable, exactly like the existing
  ack-frame contract for browser calls.
- **Testing** — `testCell` should run a worker cell **in-process** by default
  (fast, debuggable) with an opt-in `{ worker: true }` to exercise the real
  boundary, mirroring how `libraryMode` already works.
- **Restart** — a method exceeding a hard ceiling terminates the worker; the
  cell reboots and restores from its last persisted state. "Let it crash",
  scoped to one cell. Needs a documented state-loss window (unpersisted writes
  since the last flush).

## Costs (why it must stay opt-in)

- a postMessage + structured clone per dispatch — noise next to heavy work, ~10×
  a direct call for a trivial one
- a few MB per worker isolate, plus the app module graph loaded again
- stack traces cross a thread boundary
- **a counter cell should never use it** — the flag should read as "this cell
  does dangerous work"

## Why not automatic

- **JS has no preemption.** Once a method runs, the isolate is captive until it
  returns or awaits; the only interrupt is killing the isolate. Slowness is
  measurable only _after_ the time was spent, so nothing can rescue the call
  that is currently blocking.
- **A closure can't migrate.** `schedule.blocking` works only because it
  serializes a self-contained function to source.
- **Silent mode-switching would break the dev==prod doctrine.** A method that is
  slow only for some inputs would change execution semantics mid-life —
  different singletons, different clone constraints, different failure modes —
  which trades a visible freeze for invisible heisenbugs.

## Rollout

1. **This spec + a prototype cell** in `examples/` that blocks on purpose, with
   a test proving other cells keep serving while it stalls.
2. `worker: true` behind the existing boot validation (loud, specific errors for
   every unsupported seam above).
3. The diagnostic that names the flag when a cell repeatedly blows its budget.
4. Field mileage on one real app before considering anything broader. No change
   to the default: cells stay in the main isolate unless flagged.

## Open questions

- Worker **pool per cell** (parallel methods of the same cell) or strictly one
  worker per cell (serialized, preserving today's per-cell ordering)? Ordering
  matters more than throughput — probably one, with the pool as a later flag.
- Does `db:`-backed state stay in the main isolate (one writer) with the worker
  cell reading through messages, or does the worker own its own DB handle?
- Hard ceiling for the kill: configurable per cell, or a single framework
  default with `perfBudget`-style override?
