# Lifecycle — Init, Destroy, Runtime

> v2: methods is the one style — see
> [docs/upgrade/restructure.md](../upgrade/restructure.md) for migration (the
> `middleware` chain is gone; `beforeReduce` remains).

How cells boot, shut down, and how to intercept actions globally.

## onInit and onDestroy

```ts
const ws = cell("ws", {
  state: { connected: false },
  onInit(app, initState) {
    // Called after all dependencies are initialized
    // app.dispatch and app.getState scoped to this cell
    // initState: the cell's default state (app.getState() may not yet reflect __init)
    const config = (app.getFullState?.()?.config as { url?: string })?.url;
    connectWebSocket(config ?? "ws://localhost");
  },
  onDestroy(app) {
    // Called before cell state is reset
    closeWebSocket();
  },
});
```

**`app.getState()` vs `app.getFullState()`:**

|              | `app.getState()`      | `app.getFullState?.()`         |
| ------------ | --------------------- | ------------------------------ |
| Returns      | This cell's slice     | Entire app state               |
| Available in | `onInit`, `onDestroy` | `onInit`, `onDestroy`          |
| Use when     | Reading own state     | Coordinating with another cell |

---

## Cell dependencies

Declare init order when one cell needs another ready first:

```ts
await aio.run({
  cells: [
    counter,
    { cell: wallet, dependsOn: ["counter"] },
    { cell: analytics, dependsOn: ["counter", "wallet"] },
  ],
});
```

- Init runs in topological order: `counter` → `wallet` → `analytics`
- Destroy runs in reverse: `analytics` → `wallet` → `counter`
- Cycles throw: `dependency cycle: a → b → c → a`
- Missing deps throw: `[wallet] depends on unknown cell 'missing'`
- Duplicates throw: `duplicate cell name: 'counter'`

---

## aio.run() config

```ts
await aio.run({
  cells: [counter, wallet, analytics],
  ui: { title: "My App", width: 1200, height: 800 },
  transport: "auto", // top-level: 'uds' | 'ws' | 'auto'
});
```

### Key options

| Option                        | Type                                     | Description                                                                                                                                                                   |
| ----------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cells`                       | `CellEntry[]`                            | Cells to run — default: every imported `cell()` (they self-register)                                                                                                          |
| `isolate`                     | `string[]`                               | Only activate these cells (dev convenience)                                                                                                                                   |
| `beforeReduce`                | `fn`                                     | Intercept actions before reduce — return null to drop                                                                                                                         |
| `appId`                       | `string`                                 | App identity (locks, sockets, `state.db`) — default: deno.json `appId`/`title`/`name`, else the entry's directory name                                                        |
| `schedules`                   | `Schedule[]`                             | Static always-on schedules                                                                                                                                                    |
| `appDir`                      | `string`                                 | Where this app keeps everything — default `~/.<appId>`; see [Where Files Live](../persistence/where-files-live.md)                                                            |
| `dbPragmas`                   | `string[]`                               | SQLite PRAGMAs for the app db, used verbatim — default WAL + `synchronous=NORMAL`; a ledger wants `FULL` ([sqlite](../persistence/sqlite.md#choosing-your-own-durability))    |
| `routes`                      | `Record<string, fn>`                     | Custom HTTP routes — `/path` or `/prefix/*` (uploads, webhooks); see [Integrations](../examples/05-integrations.md)                                                           |
| `dispatchStorm`               | `{ rate?, sustain?, breaker? } \| false` | Runaway-dispatch guard (default on: >200/s for 5s); `breaker` drops the storming action                                                                                       |
| `users` / `resolveUser`       | map / `fn`                               | Auth — static token map or dynamic provider hook; see [auth](../../docs/auth/auth.md)                                                                                         |
| `logging`                     | `LogConfig \| false`                     | Structured file logs — level (default `info`), dir (default `~/.<appId>/logs`)                                                                                                |
| `maxConnections` / `wsLimits` | `number` / obj                           | WS safety limits (hardened defaults)                                                                                                                                          |
| `onStart`                     | `(app) => void \| Promise<void>`         | Runs once the cells are bound. A throw — sync or async — is logged (`fatalOnStart: true` exits instead)                                                                       |
| `onStop`                      | `() => void \| Promise<void>`            | Runs during shutdown and is **awaited**, inside the 5 s teardown budget — the place to finish your own writes (a flush, a handle, a child). **Must not dispatch** — see below |

### `onStop` must not dispatch

`onStop` runs at teardown **Phase 5** — after the dispatch drain (Phase 1) and
after the final persist (Phase 2). A cell method called from it is refused:

```
WARN aio  dispatch after close() — 'wallet:lockVault' ignored
  This came from your `onStop` hook. onStop runs AFTER the final persist, so a
  write from it could not be saved even if it were admitted …
```

The refusal is the honest answer, not a limitation to work around: admitting the
dispatch would move state the final snapshot has already read, so the write
would be lost on disk while looking applied in memory — worse than a refusal.

Call the plain function instead:

```ts
onStop: () => {
  ring.lock();          // ✅ a function — runs, every time
  // wallet.lockVault() // ❌ a dispatch — refused, and unsaveable anyway
},
```

If the work must reach the store, it belongs **before** shutdown — in the method
that decided it, or in a `schedules` entry — not in the hook that runs after the
last write.

### Cell isolation (dev)

```ts
await aio.run({
  cells: [counter, wallet, analytics],
  isolate: ["counter"], // only counter is active
});
```

Or via CLI: `deno task dev --isolate=counter`

---

## Runtime control

After `aio.run()`, inspect and control cells at runtime:

```ts
const app = await aio.run({ cells: [counter, wallet, analytics] });

app.cells!.list(); // ['counter', 'wallet', 'analytics']
app.cells!.status("counter"); // 'idle' | 'saving' | 'error' | ...
app.cells!.health(); // [{ name, status, enabled, errors, ... }]
app.cells!.disable("analytics"); // stops routing, cancels flows
app.cells!.enable("analytics"); // re-enables, resets state
```

### What disable does

1. Actions no longer routed (own and foreign)
2. Effects not executed
3. Running flows cancelled
4. Scheduled effects cancelled
5. Destroy hook runs, `cell:__destroy` dispatches
6. State resets to initial

### What enable does

1. Cell re-added to routing
2. Error counter resets
3. `cell:__init` dispatches
4. Init hook runs
5. State starts fresh

### Health monitoring

```ts
const health = app.cells!.health();
// [{ name: 'counter', status: 'idle', enabled: true, errors: 0,
//    lastAction: 'counter:increment', lastActionAt: 1710000000000 }]
```

Also available over HTTP: `GET /__aio/health` returns the same data as JSON.
Like every `/__aio/*` endpoint it sits behind auth when `token`, `users`, or
`resolveUser` is configured — health probes need the token too.

### Dying with the launcher — `AIO_PARENT_PID`

A spawned app is a plain child: when whatever started it is killed, times out or
crashes, the app is reparented to `init` and keeps running — holding its port
and its singleton lock, and (exposed) answering LAN discovery. A launcher that
wants the app to go when it goes sets `AIO_PARENT_PID=<its pid>`; the app then
watches that pid and runs its normal graceful shutdown (every phase, final
persist included) once it is gone. Opt-in, same in dev and prod. The test
harness sets it for every app it spawns (`childEnv()` in
`tests/e2e-app-harness.ts`), and `deno task check:orphans` is the gate that
nothing outlived the suite.

---

## Intercepting actions — `beforeReduce`

`beforeReduce` sees every action before it reaches any cell. Return the action
(possibly modified) or `null` to drop it:

```ts
await aio.run({
  cells: [counter, wallet],
  beforeReduce: (action, state, user) => {
    if (action.type.startsWith("admin:") && user?.role !== "admin") return null;
    return action;
  },
});
```

The middleware chain of v1 is gone — its real uses are framework features now:
logging → the structured logger + `am logs`; perf budgets → vitals; storm
protection → the `dispatchStorm` guard (on by default); validation → cell
definition-time checks + `validate` on the cell.

---

## Sync routing hook

When cells have `sync` enabled, aio installs a sync routing hook in the action
dispatch path. Actions on sync-enabled cells are routed to the sync engine (op
stamping, HLC, rebase) instead of the normal reducer. This is transparent — no
config needed beyond `sync: true` on the cell.

See [CRDT](../persistence/crdt.md) for sync configuration details.

---

## `fatalOnStart`

By default, if the `onStart` hook throws, the error is logged and the app
continues running (possibly in a partially initialized state). Set
`fatalOnStart: true` to terminate the process on `onStart` failure:

```ts
await aio.run({
  cells: [counter],
  fatalOnStart: true, // process exits if onStart throws
});
```
