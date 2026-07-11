# Lifecycle — Init, Destroy, Middleware, Runtime

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

|              | `app.getState()`             | `app.getFullState?.()`         |
| ------------ | ---------------------------- | ------------------------------ |
| Returns      | This cell's slice            | Entire app state               |
| Available in | `init`, `destroy`, `execute` | `init`, `destroy`, `execute`   |
| Use when     | Reading own state            | Coordinating with another cell |

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
  appVersion: "1.2.0",
});
```

### Key options

| Option                        | Type                                     | Description                                                                                                         |
| ----------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `cells`                       | `CellEntry[]`                            | Array of cells or `{ cell, dependsOn }` objects                                                                     |
| `middleware`                  | `MiddlewareFn[]`                         | Middleware chain applied before reduce                                                                              |
| `appVersion`                  | `string`                                 | App version — logged on startup                                                                                     |
| `isolate`                     | `string[]`                               | Only activate these cells (dev convenience)                                                                         |
| `beforeReduce`                | `fn`                                     | Intercept actions before reduce — return null to drop                                                               |
| `appId`                       | `string`                                 | Unique app identity for lock file, sockets, KV paths                                                                |
| `schedules`                   | `Schedule[]`                             | Static always-on schedules                                                                                          |
| `routes`                      | `Record<string, fn>`                     | Custom HTTP routes — `/path` or `/prefix/*` (uploads, webhooks); see [Integrations](../examples/05-integrations.md) |
| `dispatchStorm`               | `{ rate?, sustain?, breaker? } \| false` | Runaway-dispatch guard (default on: >200/s for 5s); `breaker` drops the storming action                             |
| `users` / `resolveUser`       | map / `fn`                               | Auth — static token map or dynamic provider hook; see [auth](../../docs/auth/auth.md)                               |
| `logging`                     | `LogConfig \| false`                     | Structured file logs — level (default `info`), dir (default `.aio/log`)                                             |
| `maxConnections` / `wsLimits` | `number` / obj                           | WS safety limits (hardened defaults)                                                                                |

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

---

## Middleware

Middleware intercepts all actions before they reach any reducer:

```ts
await aio.run({
  cells: [counter, wallet],
  middleware: [
    aio.middleware.logger(),
    aio.middleware.validate(),
    aio.middleware.metrics(),
  ],
});
```

Middleware runs in order. Each receives `(action, state, user?)` and returns the
action (possibly modified) or `null` to drop it.

### Custom middleware

```ts
aio.middleware.create((action, state, next, user) => {
  if (action.type.startsWith("Admin:") && user?.role !== "admin") return null;
  const start = performance.now();
  const result = next(action);
  const elapsed = performance.now() - start;
  if (elapsed > 50) {
    console.warn(`Slow action: ${action.type} (${elapsed.toFixed(1)}ms)`);
  }
  return result;
});
```

Built-in: `logger`, `validate`, `metrics`, `perfBudget`, `freeze`, `devtools`,
`create` (custom).

Middleware sees actions across all cells — the right place for cross-cutting
concerns like auth, logging, rate limiting.

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
