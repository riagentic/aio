# Features

How features work, how they work together, and how to keep it all under control.

For the docs index, see [manual.md](manual.md). For the API reference (`feature()`, `reactive()`, `flow()`), see [core.md](core.md). For testing, see [testing.md](testing.md). For debugging, see [debugging.md](debugging.md).

## What is a feature?

A feature is a self-contained unit: its own state slice, actions, effects, machine guards, reducer, and executor. Features don't share state — they communicate through well-defined interaction patterns.

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   counter    │     │   wallet    │     │  analytics  │
│             │     │             │     │             │
│ state:      │     │ state:      │     │ state:      │
│  { count }  │     │  { balance }│     │  { events } │
│             │     │             │     │             │
│ actions:    │     │ actions:    │     │ actions:    │
│  increment  │     │  deposit    │     │  track      │
│  reset      │     │  withdraw   │     │             │
│             │     │             │     │ listens to: │
│ machine:    │     │ machine:    │     │  Counter:*  │
│  idle→saving│     │  idle→busy  │     │  Wallet:*   │
└─────────────┘     └─────────────┘     └─────────────┘
        │                   │                   ▲
        └───────────────────┴───────────────────┘
                    dispatch loop
```

Every feature produces a `FeatureDef` regardless of which tier you use (`reactive()`, `flow()`, `feature()`). They all compose the same way.

## The five ways features interact

| Pattern | Direction | What it does | When to use |
|---------|-----------|-------------|-------------|
| [Foreign listeners](#1-foreign-action-listeners) | A reacts to B | B's action triggers A's reducer | Observing, analytics, syncing derived state |
| [crossDispatch](#2-crossdispatch) | A dispatches to B | A's executor sends actions to B | Effects that need to trigger another feature |
| [bridge()](#3-bridges) | A ↔ B (request/response) | Managed request, response, timeout, retry | Async coordination between features |
| [Selectors](#4-selectors) | A reads from B | A calls B's selector to derive values | Computed state, UI display |
| [Flows + put](#5-flows--ctxput) | A dispatches globally | Flow step dispatches to any feature | Multi-step workflows crossing feature boundaries |

There is no sixth way. If you find yourself passing data between features outside these patterns, something is wrong.

---

## 1. Foreign action listeners

A feature's machine declares that it cares about another feature's actions. The framework routes that action to both the owner and all listeners.

```ts
import { counter } from '../counter/index.ts'

const analytics = feature('analytics', {
  state: { events: [] as string[] },
  actions: {
    trackEvent: (name: string) => ({ name }),
  },
  machine: {
    initial: 'active',
    states: {
      active: { on: {
        trackEvent: 'active',
        [counter.A.Increment]: 'active',   // listen to counter
        [counter.A.Reset]: 'active',       // listen to counter
      } },
    },
  },
  reduce(state, action, { A }) {
    switch (action.type) {
      case A.TrackEvent:
        (state.events as string[]).push(action.payload.name)
        break
      case counter.A.Increment:
      case counter.A.Reset:
        (state.events as string[]).push(action.type)
        break
    }
  },
})
```

**How it works:**
1. `counter.A.Increment` evaluates to `'Counter:Increment'` — a string constant
2. The framework detects the `:` and sees it doesn't start with `Analytics:` — it's foreign
3. When `Counter:Increment` is dispatched, the framework reduces it in `counter` first (the owner), then in `analytics` (the listener)
4. Both features see the same action; the listener runs after the owner

**Rules:**
- Foreign actions must be declared in the machine's `states.*.on` — the framework scans these at compose time
- The listener's reducer receives the full action (type + payload) from the owner
- If the listener is disabled, it's skipped
- Order: owner reduces first, then listeners (in compose order)

**Use `feature.A.ActionName` instead of string literals** — you get autocomplete, refactor safety, and no typo risk.

### Reactive features as listeners

Reactive features can listen too. The simplest way is `listensTo`:

```ts
const logger = reactive('logger', {
  state: { log: [] as string[] },
  listensTo: [counter.A.Increment, counter.A.Reset],
  methods: {
    clear(s) { s.log = [] },
  },
})
```

`listensTo` auto-generates a minimal machine with self-loop transitions — no need to write `machine: { initial: 'on', states: { on: { on: { ... } } } }` by hand.

For features that also need real machine states, declare foreign actions in the machine directly:

```ts
const logger = reactive('logger', {
  state: { log: [] as string[] },
  machine: {
    initial: 'on',
    states: {
      on: { on: {
        clear: 'on',
        [counter.A.Increment]: 'on',
      } },
    },
  },
  methods: {
    clear(s) { s.log = [] },
  },
})
```

---

## 2. crossDispatch

When an executor needs to tell another feature to do something, declare it in `crossDispatch`:

```ts
const checkout = feature('checkout', {
  // ...
  crossDispatch: ['wallet', 'inventory'],
  execute(app, effect, { E }) {
    switch (effect.type) {
      case E.PaymentComplete:
        app.dispatch(wallet.A.credit(effect.payload.amount))       // allowed
        app.dispatch(inventory.A.reserve(effect.payload.itemId))   // allowed
        app.dispatch(shipping.A.schedule(effect.payload.orderId))  // BLOCKED
        break
    }
  },
})
```

**What happens when blocked:**
```
[checkout] dispatch('Shipping:Schedule') blocked — add 'shipping' to crossDispatch
```

The action is dropped, an error is counted in the feature's health, and a console error is logged.

**Rules:**
- Without `crossDispatch`, an executor can only dispatch its own actions
- `crossDispatch` takes lowercase feature names: `['wallet']` not `['Wallet']`
- The dispatched action goes through the normal dispatch loop — the target's machine guards still apply
- `app.getState()` in an executor returns only this feature's slice, not the full state

### Why the restriction?

Without it, any feature could dispatch to any other feature. Debugging becomes "who changed my state?" with no trail. `crossDispatch` makes inter-feature data flow **explicit and grep-able** — you can trace every cross-feature dispatch by searching for `crossDispatch:`.

---

## 3. Bridges

When one feature needs to **request** something from another and **wait for the response**, use a bridge. Bridges handle the ceremony: pending tracking, timeouts, retries, circuit breaking, and metrics.

```ts
import { bridge } from 'aio'

const priceBridge = bridge('priceBridge', {
  from: 'engine',
  to: 'dataCollector',
  channels: {
    price: {
      request: (symbol: string) => ({ symbol }),
      response: (price: number) => ({ price }),
      timeout: 5000,
      retries: 2,
    },
  },
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeout: 30_000,
  },
})
```

A bridge is itself a feature with auto-generated state, actions, and machine. Per channel it generates:

| Generated action | When |
|-----------------|------|
| `PriceBridge:PriceRequest` | Requesting feature dispatches |
| `PriceBridge:PriceResponse` | Responding feature dispatches |
| `PriceBridge:PriceTimeout` | Framework dispatches on timeout |

### Wiring

**Requester** — dispatches the request from its executor:

```ts
const engine = feature('engine', {
  crossDispatch: ['priceBridge'],
  execute(app, effect, { E }) {
    switch (effect.type) {
      case E.NeedPrice:
        app.dispatch(priceBridge.request!.price(effect.payload.symbol))
        break
    }
  },
})
```

**Responder** — listens for the request via foreign action:

```ts
const dataCollector = feature('dataCollector', {
  machine: {
    initial: 'ready',
    states: {
      ready: { on: {
        [priceBridge.A.PriceRequest]: 'ready',
      } },
    },
  },
  crossDispatch: ['priceBridge'],
  execute(app, effect, { E }) {
    switch (effect.type) {
      case E.FetchPrice:
        fetch(`/api/price?symbol=${effect.payload.symbol}`)
          .then(r => r.json())
          .then(data => app.dispatch(priceBridge.A.priceResponse(data.price)))
        break
    }
  },
})
```

### Bridge state and selectors

```ts
// Bridge auto-manages this state slice:
{
  priceBridge: {
    pending: { /* correlation ID → { channel, requestedAt, retryCount } */ },
    metrics: { totalRequests: 42, totalResponses: 40, totalTimeouts: 2, totalLatencyMs: 5040 },
    circuit: { state: 'closed', failures: 0, lastFailureAt: 0 },
  }
}

// Query with selectors:
priceBridge.selectors.getPendingCount(state)
priceBridge.selectors.getAverageLatency(state)
priceBridge.selectors.isCircuitOpen(state)
```

### Circuit breaker

| State | Behavior |
|-------|----------|
| **closed** | Requests flow normally |
| **open** | Requests rejected immediately (no dispatch) |
| **half-open** | One test request allowed — success closes, failure re-opens |

Opens after `failureThreshold` consecutive timeouts. Tries recovery after `resetTimeout` ms.

### When to use bridges vs simpler patterns

If you just need "fire and forget" — use foreign listeners or crossDispatch. Bridges add value when you need:
- Timeout detection (did the other feature respond in time?)
- Automatic retries
- Circuit breaking (stop hammering a failing feature)
- Latency metrics

---

## 4. Selectors

Selectors expose derived state that any component can read. They don't create feature coupling — they're read-only views.

```ts
const counter = feature('counter', {
  state: { count: 0, limit: 100 },
  selectors: {
    remaining: (fullState: unknown) => {
      const s = (fullState as Record<string, { count: number; limit: number }>).counter
      return s.limit - s.count
    },
  },
  // ...
})

// After aio.run(), callable directly:
counter.remaining()  // → 100
```

**Reactive selectors** receive scoped state (just the feature's slice):

```ts
const counter = reactive('counter', {
  state: { count: 0, limit: 100 },
  selectors: {
    remaining: (s) => s.limit - s.count,
  },
  // ...
})
```

**Cross-feature selector use** — one component reads from multiple features:

```tsx
export default function Dashboard() {
  const c = useFeature(counter)
  const w = useFeature(wallet)
  if (!c.state || !w.state) return <div>Loading...</div>

  return (
    <div>
      <p>Counter remaining: {counter.remaining()}</p>
      <p>Wallet balance: {w.state.balance}</p>
    </div>
  )
}
```

Selectors are memoized per render cycle. They don't push updates — React re-evaluates them on each state change via `useFeature()`.

---

## 5. Flows + `ctx.put`

Flows can dispatch actions to any feature via `ctx.put()`:

```ts
const order = feature('order', {
  // ...
  flows: {
    checkout: flow('start', function* (ctx, action) {
      const payment = yield* ctx.call('pay', () =>
        processPayment(action.payload.amount)
      )

      // Dispatch to another feature
      yield* ctx.put(inventory.A.reserve(action.payload.itemId))
      yield* ctx.put(analytics.A.trackEvent('checkout_complete'))

      yield* ctx.done(s => { s.orderId = payment.id })
    }),
  },
})
```

**`ctx.put()` bypasses `crossDispatch`** — it dispatches directly to the global dispatch loop. The action is tagged with `_source: 'Effect'` and appears in time-travel history.

### `ctx.waitFor` — pause until external action

Flows can also wait for actions from other features:

```ts
const checkout = feature('checkout', {
  // ...
  flows: {
    purchase: flow('start', function* (ctx, action) {
      yield* ctx.put(payment.A.charge(action.payload.amount))

      // Pause until payment completes or times out
      try {
        const result = yield* ctx.waitFor('Payment:Complete', 10_000)
        yield* ctx.done(s => { s.paid = true })
      } catch {
        yield* ctx.fail('payment timed out')
      }
    }),
  },
})
```

`ctx.waitFor(actionType, timeout?)` registers a one-shot listener on the dispatch loop. When the matching action fires, the flow resumes with the full action object. Optional timeout throws on expiry (catchable via try/catch).

Use this for orchestration flows that need to coordinate multiple features in sequence.

---

## Composition and startup

### Feature array

```ts
await aio.run({
  features: [counter, wallet, analytics, priceBridge],
})
```

### Dependencies

Declare init order when one feature needs another to be ready first:

```ts
await aio.run({
  features: [
    counter,
    { feature: wallet, dependsOn: ['counter'] },
    { feature: analytics, dependsOn: ['counter', 'wallet'] },
  ],
})
```

- Init runs in topological order: `counter` → `wallet` → `analytics`
- Destroy runs in reverse: `analytics` → `wallet` → `counter`
- Cycles throw: `dependency cycle: a → b → c → a`
- Missing deps throw: `[wallet] depends on unknown feature 'missing'`
- Duplicates throw: `duplicate feature name: 'counter'`

### Init and destroy hooks

```ts
const ws = feature('ws', {
  init(app) {
    // Called after all dependencies are initialized
    // app.dispatch and app.getState are scoped to this feature
    startWebSocket(app)
  },
  destroy(app) {
    // Called before feature state is reset
    closeWebSocket()
  },
})
```

---

## Runtime control

After `aio.run()`, you can inspect and control features at runtime:

```ts
const app = await aio.run({ features: [counter, wallet, analytics] })

app.features!.list()                // ['counter', 'wallet', 'analytics']
app.features!.status('counter')     // 'idle' | 'saving' | 'error' | ...
app.features!.health()              // [{ name, status, enabled, errors, lastAction, lastActionAt }]
app.features!.disable('analytics')  // stops routing, cancels flows, dispatches Destroy
app.features!.enable('analytics')   // re-enables, dispatches Init, resets state
```

### What disable does

1. Feature's actions are no longer routed (own and foreign)
2. Feature's effects are not executed
3. Running flows are cancelled
4. Scheduled effects are cancelled
5. Destroy hook runs, `Feature:Destroy` action dispatches
6. Feature state resets to initial

### What enable does

1. Feature is re-added to routing
2. Error counter resets
3. `Feature:Init` action dispatches
4. Init hook runs
5. State starts fresh from initial state

### Health monitoring

```ts
const health = app.features!.health()
// [
//   { name: 'counter', status: 'idle', enabled: true, errors: 0,
//     lastAction: 'Counter:Increment', lastActionAt: 1710000000000 },
//   { name: 'wallet', status: 'saving', enabled: true, errors: 1,
//     lastAction: 'Wallet:Save', lastActionAt: 1710000001000 },
// ]
```

Also available over HTTP: `GET /__health` returns the same data as JSON.

**Error tracking:** Every blocked `crossDispatch`, init/destroy failure, or executor crash increments the feature's error count. Check `errors` in health output to spot features that are misbehaving.

---

## Middleware

Middleware intercepts all actions before they reach any feature's reducer:

```ts
await aio.run({
  features: [counter, wallet],
  middleware: [
    aio.middleware.logger(),      // log all actions
    aio.middleware.validate(),    // reject malformed actions
    aio.middleware.metrics(),     // track action counts per feature
  ],
})
```

Middleware runs in order. Each receives `(action, state, user?)` and returns the action (possibly modified) or `null` to drop it. The `user` parameter is the `AioUser` from the WebSocket connection.

### Custom middleware

```ts
aio.middleware.create((action, state, next, user) => {
  // Drop admin actions from non-admin users
  if (action.type.startsWith('Admin:') && user?.role !== 'admin') return null
  // Log slow actions
  const start = performance.now()
  const result = next(action)
  const elapsed = performance.now() - start
  if (elapsed > 50) console.warn(`Slow action: ${action.type} (${elapsed.toFixed(1)}ms)`)
  return result
})
```

Middleware sees actions across all features — it's the right place for cross-cutting concerns like auth, logging, and rate limiting.

---

## State filtering for clients

`getUIState` controls what each browser client receives:

```ts
await aio.run({
  features: [shop, auth, admin],
  getUIState: (state, user?) => ({
    auth: state.auth,
    shop: state.shop,
    admin: user?.role === 'admin' ? state.admin : undefined,
  }),
})
```

- Called per client on every state broadcast
- Each client has its own delta cache — filtered features cost zero bandwidth
- `user` is `undefined` in public mode (no `users` config)
- If `getUIState` throws, that client is skipped

---

## Architecture decision guide

### How should my features talk to each other?

```
Feature A needs to...          → Use this pattern
──────────────────────────────────────────────────────
Know when B did something      → Foreign listener
Tell B to do something         → crossDispatch
Ask B for something + wait     → bridge()
Read B's derived state         → Selector
Orchestrate A, B, C in order   → flow() + ctx.put
Filter what clients see        → getUIState
Intercept all actions globally → Middleware
```

### Keep features independent

The best feature is one that doesn't know other features exist. The second-best feature is one that knows about others through a single, explicit pattern.

**Signs of healthy architecture:**
- Most features have no `crossDispatch` and no foreign listeners
- Bridges are rare (1-2 per app, not per feature)
- `getUIState` is a flat mapping, not complex logic
- You can `testFeature()` each feature in isolation without mocking others

**Signs of trouble:**
- A feature has `crossDispatch: ['a', 'b', 'c', 'd']` — it's doing too much
- Multiple features listen to each other's actions in a circle — untangle the dependency
- A bridge exists between features that could just use a foreign listener — bridges are for async coordination, not observation
- `getUIState` is 50 lines of conditional logic — split features differently

### Tracking data flow

Every interaction is visible:

1. **Time-travel panel** (Ctrl+.) — see every action, who dispatched it, and what state changed
2. **`app.features.health()`** — error counts, last action per feature
3. **`GET /__health`** — same health data over HTTP
4. **`aio.middleware.logger()`** — logs every action with feature prefix
5. **`crossDispatch` errors** — blocked dispatches are logged with the exact fix needed

The action type prefix (`Counter:Increment`, `Wallet:Transfer`) tells you which feature owns the action. The `_source` field tells you who dispatched it (`UI`, `Effect`, `System`, `Test`). Together they answer "what happened and why" for every state change.

---

## State versioning and migrations

When your feature state shapes evolve over time:

```ts
await aio.run({
  features: [counter, wallet],
  version: 2,
  migrations: [
    // v0 → v1: add wallet feature
    (state) => ({ ...state, wallet: { balance: 0 } }),
    // v1 → v2: rename field
    (state) => {
      const w = state.wallet as Record<string, unknown>
      w.totalBalance = w.balance
      delete w.balance
      return state
    },
  ],
})
```

Migrations run sequentially on restore from persistence. If a migration fails, the framework falls back to initial state and logs the error.
