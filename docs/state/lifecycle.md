# Lifecycle — Init, Destroy, Middleware, Runtime

How features boot, shut down, and how to intercept actions globally.

## onInit and onDestroy

```ts
const ws = feature("ws", {
  state: { connected: false },
  onInit(app) {
    // Called after all dependencies are initialized
    // app.dispatch and app.getState scoped to this feature
    const config = (app.getFullState?.()?.config as { url?: string })?.url;
    connectWebSocket(config ?? "ws://localhost");
  },
  onDestroy(app) {
    // Called before feature state is reset
    closeWebSocket();
  },
});
```

**`app.getState()` vs `app.getFullState()`:**

|              | `app.getState()`             | `app.getFullState?.()`            |
| ------------ | ---------------------------- | --------------------------------- |
| Returns      | This feature's slice         | Entire app state                  |
| Available in | `init`, `destroy`, `execute` | `init`, `destroy`, `execute`      |
| Use when     | Reading own state            | Coordinating with another feature |

---

## Feature dependencies

Declare init order when one feature needs another ready first:

```ts
await aio.run({
  features: [
    counter,
    { feature: wallet, dependsOn: ["counter"] },
    { feature: analytics, dependsOn: ["counter", "wallet"] },
  ],
});
```

- Init runs in topological order: `counter` → `wallet` → `analytics`
- Destroy runs in reverse: `analytics` → `wallet` → `counter`
- Cycles throw: `dependency cycle: a → b → c → a`
- Missing deps throw: `[wallet] depends on unknown feature 'missing'`
- Duplicates throw: `duplicate feature name: 'counter'`

---

## aio.run() config

```ts
await aio.run({
  features: [counter, wallet, analytics],
  ui: { title: "My App", width: 1200, height: 800, transport: "auto" },
  appVersion: "1.2.0",
});
```

### Key options

| Option         | Type             | Description                                           |
| -------------- | ---------------- | ----------------------------------------------------- |
| `features`     | `FeatureEntry[]` | Array of features or `{ feature, dependsOn }` objects |
| `middleware`   | `MiddlewareFn[]` | Middleware chain applied before reduce                |
| `appVersion`   | `string`         | App version — logged on startup                       |
| `isolate`      | `string[]`       | Only activate these features (dev convenience)        |
| `beforeReduce` | `fn`             | Intercept actions before reduce — return null to drop |
| `appId`        | `string`         | Unique app identity for lock file, sockets, KV paths  |
| `schedules`    | `Schedule[]`     | Static always-on schedules                            |

### Feature isolation (dev)

```ts
await aio.run({
  features: [counter, wallet, analytics],
  isolate: ["counter"], // only counter is active
});
```

Or via CLI: `deno task dev --isolate=counter`

---

## Runtime control

After `aio.run()`, inspect and control features at runtime:

```ts
const app = await aio.run({ features: [counter, wallet, analytics] });

app.features!.list(); // ['counter', 'wallet', 'analytics']
app.features!.status("counter"); // 'idle' | 'saving' | 'error' | ...
app.features!.health(); // [{ name, status, enabled, errors, ... }]
app.features!.disable("analytics"); // stops routing, cancels flows
app.features!.enable("analytics"); // re-enables, resets state
```

### What disable does

1. Actions no longer routed (own and foreign)
2. Effects not executed
3. Running flows cancelled
4. Scheduled effects cancelled
5. Destroy hook runs, `feature:__destroy` dispatches
6. State resets to initial

### What enable does

1. Feature re-added to routing
2. Error counter resets
3. `feature:__init` dispatches
4. Init hook runs
5. State starts fresh

### Health monitoring

```ts
const health = app.features!.health();
// [{ name: 'counter', status: 'idle', enabled: true, errors: 0,
//    lastAction: 'counter:increment', lastActionAt: 1710000000000 }]
```

Also available over HTTP: `GET /__aio/health` returns the same data as JSON.

---

## Middleware

Middleware intercepts all actions before they reach any reducer:

```ts
await aio.run({
  features: [counter, wallet],
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

Middleware sees actions across all features — the right place for cross-cutting
concerns like auth, logging, rate limiting.

---

## Sync routing hook

When features have `sync` enabled, aio installs a sync routing hook in the
action dispatch path. Actions on sync-enabled features are routed to the sync
engine (op stamping, HLC, rebase) instead of the normal reducer. This is
transparent — no config needed beyond `sync: true` on the feature.

See [CRDT](../persistence/crdt.md) for sync configuration details.
