# Core API

The three-tier progressive API: `reactive()` → `flow()` → `feature()`. Start simple, upgrade when needed.

For the docs index, see [manual.md](manual.md). For reactive features in depth, see [reactivity.md](reactivity.md). For generator workflows in depth, see [generators.md](generators.md). For testing, see [testing.md](testing.md).

## `feature(name, config)` — the core building block

A feature is a self-contained state machine with its own state slice, typed actions, typed effects, state machine definition, reducer, and executor. One `feature()` call defines everything.

```ts
import { feature } from 'aio'

export const counter = feature('counter', {
  // ── State — this feature's slice of the global state tree
  state: { count: 0, lastUpdatedAt: 0, error: null as string | null },

  // ── Actions — messages from UI or effects → state changes
  actions: {
    increment: (by = 1) => ({ by }),
    decrement: (by = 1) => ({ by }),
    reset:     () => ({}),
    save:      () => ({}),
    saved:     () => ({}),
    saveFailed: (error: string) => ({ error }),
    retry:     () => ({}),
    dismiss:   () => ({}),
  },

  // ── Effects — async side effects returned by reducer
  effects: {
    persist: (value: number) => ({ value }),
    log:     (message: string) => ({ message }),
  },

  // ── Machine — which actions are allowed in which status
  machine: {
    initial: 'idle',
    states: {
      idle:   { on: { increment: 'idle', decrement: 'idle', reset: 'idle', save: 'saving' } },
      saving: { on: { saved: 'idle', saveFailed: 'error' } },
      error:  { on: { retry: 'saving', dismiss: 'idle' } },
    },
  },

  // ── Reduce — pure state changes (Immer draft — mutate directly)
  reduce(state, action, { A, E }) {
    switch (action.type) {
      case A.Increment:
        state.count += action.payload.by
        state.lastUpdatedAt = Date.now()
        return [E.log(`incremented to ${state.count}`)]
      case A.Decrement:
        state.count -= action.payload.by
        state.lastUpdatedAt = Date.now()
        break
      case A.Reset:
        state.count = 0
        break
      case A.Save:
        return [E.persist(state.count)]
      case A.SaveFailed:
        state.error = action.payload.error
        break
    }
  },

  // ── Execute — async side effects (scoped dispatch)
  execute(app, effect, { E, A }) {
    switch (effect.type) {
      case E.Persist:
        fetch('/api/save', {
          method: 'POST',
          body: JSON.stringify({ value: effect.payload.value }),
        })
          .then(() => app.dispatch(A.saved()))
          .catch(e => app.dispatch(A.saveFailed(e.message)))
        break
      case E.Log:
        console.log(effect.payload.message)
        break
    }
  },
})
```

### What `feature()` generates

From the name `'counter'` and action `increment`, you get:

| Generated | Value | Use |
|-----------|-------|-----|
| `counter.A.Increment` | `'Counter:Increment'` | String label for `switch/case` in reduce |
| `counter.A.increment(5)` | `{ type: 'Counter:Increment', payload: { by: 5 } }` | Creator for dispatch/send |
| `counter.E.Log` | `'Counter:Log'` | String label for `switch/case` in execute |
| `counter.E.log('hi')` | `{ type: 'Counter:Log', payload: { message: 'hi' } }` | Effect creator returned from reduce |

**Prefix convention:** feature name is capitalized → `Counter:ActionName`. Actions are routed by prefix — the framework knows `Counter:Increment` belongs to the `counter` feature.

**Direct calling:** Action creators are also flattened onto the feature object. After `aio.run()`, they dispatch automatically:

```ts
counter.increment(5)     // dispatches Counter:Increment — typed with autocomplete
counter.A.increment(5)   // returns action object (backward compat, cross-feature wiring)
```

`feature()` returns `FeatureDef & FlatActions<A>` — TypeScript infers correct parameter types for all flattened action creators.

### `machine` — state machine guards

The machine definition controls which actions are allowed in which status. Actions that aren't listed for the current status are **silently dropped** — no error, no state change.

```ts
machine: {
  initial: 'idle',
  states: {
    idle:   { on: { increment: 'idle', decrement: 'idle', save: 'saving' } },
    saving: { on: { saved: 'idle', saveFailed: 'error' } },
    error:  { on: { retry: 'saving', dismiss: 'idle' } },
  },
},
```

The current status is stored as `_status` in the feature's state slice. Use `useFeature(counter).status` in the UI to read it.

**Validation at definition time:**
- Initial state must exist in declared states
- All transition targets must be declared states
- All referenced action keys must be declared (own or foreign)
- Unreachable states are flagged
- Dead-end states (no outgoing transitions) get a console warning

Use `machine: 'simple'` (or `machine: false`) for features that don't need state machine guards — all actions are always allowed, no `_status` field.

### Foreign actions — cross-feature reactions

A feature's machine can declare actions from other features. This lets one feature react to another's state changes:

```ts
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
        'Counter:Increment': 'active',   // ← react to counter's increment
        'Wallet:Transfer': 'active',     // ← react to wallet's transfer
      } },
    },
  },
  reduce(state, action, { A }) {
    switch (action.type) {
      case A.TrackEvent:
      case 'Counter:Increment':
      case 'Wallet:Transfer':
        (state.events as string[]).push(action.type)
        break
    }
  },
})
```

Foreign actions are identified by containing `:` and not matching the feature's own prefix. The framework routes the action to both the owning feature and all listeners.

**Tip — use feature refs instead of string literals** for autocomplete and refactor safety:

```ts
import { counter } from '../counter/index.ts'

const analytics = feature('analytics', {
  // ...
  machine: {
    initial: 'active',
    states: {
      active: { on: {
        trackEvent: 'active',
        [counter.A.Increment]: 'active',   // ← autocomplete + rename-safe
      } },
    },
  },
  reduce(state, action, { A }) {
    switch (action.type) {
      case A.TrackEvent:
      case counter.A.Increment:            // ← same ref, no string duplication
        // ...
    }
  },
})
```

`counter.A.Increment` evaluates to `'Counter:Increment'` — it's the same string, just referenced through the feature object.

### `reduce` — pure state changes with Immer

The reducer receives an Immer `Draft<S>` — mutate it directly. Return an effects array (or `void` for no effects):

```ts
reduce(state, action, { A, E }) {
  switch (action.type) {
    case A.Increment:
      state.count += action.payload.by           // mutate the draft
      return [E.log(`count: ${state.count}`)]    // return effects
    case A.Reset:
      state.count = 0                            // no effects needed
      break
  }
}
```

Effects returned from reduce are detached from the Immer draft via `structuredClone`.

### `execute` — async side effects with scoped dispatch

The executor receives a `ScopedApp` with `dispatch` and `getState`:

```ts
execute(app, effect, { E, A }) {
  switch (effect.type) {
    case E.FetchData:
      fetch(effect.payload.url)
        .then(r => r.json())
        .then(data => app.dispatch(A.dataLoaded(data)))
        .catch(e => app.dispatch(A.fetchFailed(e.message)))
      break
  }
}
```

**Alternative:** Use `matchEffect()` from classic API for type-safe dispatch without switch/case — see [classic.md](classic.md#matcheffect).

**Scoped dispatch rules:**
- `app.dispatch(A.ownAction())` — always allowed
- `app.dispatch(otherFeature.A.action())` — **blocked** unless declared in `crossDispatch`
- `app.getState()` — returns this feature's slice only (not the full state)

### `crossDispatch` — allow dispatching to other features

```ts
const te = feature('te', {
  // ...
  crossDispatch: ['wallet', 'fleet'],  // lowercase feature names
  execute(app, effect, { E }) {
    switch (effect.type) {
      case E.TransferComplete:
        app.dispatch(wallet.A.credit(effect.payload.amount))  // allowed
        break
    }
  },
})
```

Blocked dispatches log: `[te] dispatch('Wallet:Credit') blocked — add 'wallet' to crossDispatch`

### `selectors` — derived state

```ts
const counter = feature('counter', {
  // ...
  selectors: {
    isPositive: (state: unknown) => {
      const s = (state as Record<string, { count: number }>).counter
      return s.count > 0
    },
  },
})
```

### Lifecycle hooks — `init` / `destroy`

```ts
const ws = feature('ws', {
  // ...
  init(app) {
    // called after feature is composed — start WebSocket, timers, etc.
    connectWebSocket(app)
  },
  destroy(app) {
    // called on shutdown or feature disable — cleanup
    closeWebSocket()
  },
})
```

Init runs in dependency order (dependsOn). Destroy runs in reverse order.

### Deferred `implement` — server-only executors

When execute needs server-only imports, use `implement()` to attach it separately:

```ts
// features/backup/index.ts — shared (browser + server)
export const backup = feature('backup', {
  state: { lastBackup: null as string | null },
  actions: { run: () => ({}), done: (at: string) => ({ at }) },
  effects: { doBackup: () => ({}) },
  machine: 'simple',
  reduce(state, action, { A, E }) {
    switch (action.type) {
      case A.Run: return [E.doBackup()]
      case A.Done: state.lastBackup = action.payload.at; break
    }
  },
  // no execute here — browser doesn't have Deno APIs
})

// features/backup/execute.ts — server only
import { backup } from './index.ts'
backup.implement((app, effect, { E, A }) => {
  switch (effect.type) {
    case E.DoBackup:
      Deno.writeTextFile('./backup.json', JSON.stringify(app.getState()))
        .then(() => app.dispatch(A.done(new Date().toISOString())))
      break
  }
})
```

## `flow()` — generator-based sequential workflows

When a feature has a multi-step async workflow (fetch → validate → save → notify), the standard reduce/execute pattern scatters the logic across actions, reducer cases, and effects. `flow()` lets you write it top-to-bottom:

```ts
import { feature, flow } from 'aio'

const checkout = feature('checkout', {
  state: { price: 0, orderId: null as string | null, error: null as string | null },
  actions: {
    start: (item: string) => ({ item }),
  },
  machine: {
    initial: 'idle',
    states: {
      idle: { on: { start: 'busy' } },
      busy: { on: {} },
    },
  },
  flows: {
    checkout: flow('start', function* (ctx, action) {
      const { item } = action.payload as { item: string }

      // Step 1 — async call (dispatches Checkout:Flow:FetchPrice)
      const { price } = yield* ctx.call('fetchPrice', () =>
        fetch(`/api/price?item=${item}`).then(r => r.json())
      )

      // Step 2 — validation + state update (dispatches Checkout:Flow:SetPrice)
      if (price > 1000) {
        yield* ctx.fail('too expensive')
        return
      }
      yield* ctx.step('setPrice', s => { s.price = price })

      // Step 3 — another async call (dispatches Checkout:Flow:PlaceOrder)
      const { orderId } = yield* ctx.call('placeOrder', () =>
        fetch('/api/order', { method: 'POST', body: JSON.stringify({ price }) })
          .then(r => r.json())
      )

      // Step 4 — done (dispatches Checkout:Flow:Done)
      yield* ctx.done(s => { s.orderId = orderId })
    }),
  },
})
```

Each `yield*` is a checkpoint — the framework dispatches an action, other features can react, and the step appears in time-travel history.

### What the framework generates

From the flow above, the framework auto-generates:

- **Actions**: `Checkout:Flow:FetchPrice`, `Checkout:Flow:SetPrice`, `Checkout:Flow:PlaceOrder`, `Checkout:Flow:Done`, `Checkout:Flow:Failed`
- **Machine transitions**: each step moves through corresponding flow states
- **Error handling**: if any `ctx.call` throws, `Checkout:Flow:Error` is dispatched

You don't define these manually — the flow is the source of truth.

### `FlowCtx` API

| Method | What it does |
|---|---|
| `yield* ctx.call(name, fn)` | Execute async work. Dispatches action, runs `fn`, returns result. |
| `yield* ctx.step(name, mutate)` | Update state via Immer draft. Dispatches action. |
| `yield* ctx.done(mutate?)` | Terminal success. Optional final state update. |
| `yield* ctx.fail(reason)` | Terminal failure. Stops the flow. |
| `yield* ctx.put(action)` | Dispatch a regular action (other features react to it). |
| `yield* ctx.all(gen1, gen2, ...)` | Run multiple calls in parallel, wait for all. |
| `yield* ctx.race({ a: gen1, b: gen2 })` | Race — first to resolve wins. |
| `yield* ctx.sleep(name, ms)` | Pause for N ms. Dispatches action for visibility. |

### Mixing flows with reduce/execute

Flows are fully optional and composable with the traditional pattern:

```ts
const wallet = feature('wallet', {
  state: { balance: 0, syncing: false },
  actions: {
    deposit:  (amount: number) => ({ amount }),
    withdraw: (amount: number) => ({ amount }),
    sync:     () => ({}),
  },
  machine: {
    initial: 'idle',
    states: {
      idle: { on: { deposit: 'idle', withdraw: 'idle', sync: 'syncing' } },
      syncing: { on: {} },
    },
  },
  // Reactive: instant state updates
  reduce(state, action, { A }) {
    switch (action.type) {
      case A.Deposit:  state.balance += (action.payload as { amount: number }).amount; break
      case A.Withdraw: state.balance -= (action.payload as { amount: number }).amount; break
    }
  },
  // Sequential: the sync workflow
  flows: {
    sync: flow('sync', function* (ctx) {
      yield* ctx.step('start', s => { s.syncing = true })
      const remote = yield* ctx.call('fetch', () => fetchRemoteBalance())
      yield* ctx.done(s => { s.balance = remote as number; s.syncing = false })
    }),
  },
})
```

Reactive logic (deposit/withdraw) stays in `reduce`. Sequential workflows (sync) go in `flows`. Both work on the same state.

### Flow-only features

If your feature is entirely sequential, you can skip `reduce` and `machine`:

```ts
const importer = feature('importer', {
  state: { records: 0, status: 'idle' },
  actions: {
    start: (file: string) => ({ file }),
  },
  flows: {
    import: flow('start', function* (ctx, action) {
      const { file } = action.payload as { file: string }
      const data = yield* ctx.call('read', () => Deno.readTextFile(file))
      const parsed = yield* ctx.call('parse', () => JSON.parse(data as string))
      yield* ctx.done(s => { s.records = (parsed as unknown[]).length; s.status = 'done' })
    }),
  },
})
```

### Cancellation

When a flow is triggered while a previous instance is still running, the old one is automatically cancelled. Flows are also cancelled when a feature is disabled or destroyed.

### When to use flows vs reduce/execute

| Use case | Pattern |
|---|---|
| Instant state update (increment, toggle) | `reduce` |
| React to other features' actions | `reduce` with foreign listeners |
| Multi-step async workflow (fetch → process → save) | `flow()` |
| Request/response with timeouts and retries | `bridge()` |

## `reactive(name, config)` — reactive features

The simplest way to define a feature. Write plain methods instead of actions, effects, reduce, execute.

```ts
import { reactive } from 'aio'

const counter = reactive('counter', {
  state: { count: 0, lastSaved: null as string | null },
  methods: {
    increment(s, by = 1) { s.count += by },
    decrement(s, by = 1) { s.count -= by },
    reset(s) { s.count = 0 },
    async save(s) {
      await Deno.writeTextFile('./data.json', String(s.count))
      s.lastSaved = new Date().toISOString()
    },
  },
  selectors: {
    isPositive: (s) => s.count > 0,
  },
})
```

### How it works

**Sync methods** receive a mutable state object (Immer draft). Mutate in place. All mutations within one method call are batched into a single action.

**Async methods** receive a live Proxy. Reads always return fresh state from the store. Writes auto-dispatch actions through the normal dispatch loop. Each property assignment after an `await` is a separate action — persisted, synced, visible in time-travel.

```ts
async checkout(s) {
  s.status = 'loading'                    // action dispatched immediately
  const order = await placeOrder(s.items) // s.items reads current state
  s.orderId = order.id                    // action dispatched after await
  s.status = 'done'                       // another action
}
```

### Config

| Key | Type | Required | Description |
|---|---|---|---|
| `state` | `Record<string, unknown>` | Yes | Initial state |
| `methods` | `Record<string, Function>` | Yes | Sync or async methods — `(s, ...args) => void` |
| `selectors` | `Record<string, (s) => T>` | No | Derived values, scoped to feature state |
| `machine` | `MachineConfig \| 'simple' \| false` | No | State machine guards (same as `feature()`). `false` is an alias for `'simple'` |
| `crossDispatch` | `string[]` | No | Feature names this executor may dispatch to |
| `init` | `(s) => void` | No | Called when feature initializes |
| `destroy` | `(s) => void` | No | Called when feature destroys |

### Generated actions

`reactive()` auto-generates actions from method names:

| Method | Action type | Payload |
|---|---|---|
| `increment(s, by)` | `Counter:Increment` | `{ args: [by] }` |
| `async save(s)` | `Counter:Save` (trigger) | `{ args: [] }` |
| (async write) | `Counter:__setSave` | `{ mutations: [...] }` (batched per sync frame) |
| (async error) | `Counter:__error` | `{ _method, error }` |

All generated actions are real actions — visible in time-travel, loggable, interceptable by foreign listeners.

### Direct calling

After `aio.run()`, methods and selectors are callable directly on the feature object:

```ts
await aio.run({ features: [counter] })

counter.increment(5)        // dispatches Counter:Increment
counter.reset()              // dispatches Counter:Reset
counter.isPositive()         // reads state → true

// A catalog still works (backward compat, cross-feature wiring)
counter.A.increment(5)      // returns action object without dispatching
counter.A.Increment          // string constant 'Counter:Increment'
```

This works for all three tiers — `reactive()`, `feature()`, and `flow()`.

### Machines

Reactive features support state machines. Methods are gated by transitions:

```ts
const door = reactive('door', {
  state: { opened: false },
  machine: {
    initial: 'closed',
    states: {
      closed: { on: { open: 'open' } },
      open: { on: { close: 'closed' } },
    },
  },
  methods: {
    open(s) { s.opened = true },
    close(s) { s.opened = false },
  },
})
// door.open() in 'open' state → dropped (no open→open transition)
```

### Composing with other features

Reactive features produce standard `FeatureDef` objects. They compose freely with `feature()` and `flow()` features:

```ts
await aio.run({ features: [reactiveCounter, featureWallet, flowCheckout] })
```

Other features can listen to reactive feature actions via foreign listeners, read via selectors, and coordinate via bridges.

### When to use reactive vs feature/flow

| Use case | API |
|---|---|
| CRUD, forms, simple state | `reactive()` |
| Simple async (fetch, save) | `reactive()` with async methods |
| Multi-step orchestration with retries | `flow()` |
| Complex reactive cross-feature logic | `feature()` with reduce/execute |

Start with `reactive()`. Upgrade individual features to `flow()` or `feature()` when you need more control.

**TypeScript inference:** `reactive()` returns `FeatureDef & FlatMethods<M> & FlatSelectors<Sel>` — methods and selectors are properly typed with autocomplete. The state parameter `s` is stripped from method signatures, so `increment(s, by: number)` becomes `counter.increment(by: number)`.

See [reactivity.md](reactivity.md) for the full guide.

## `aio.run({ features })` — the entry point

Pass an array of features. The framework composes them into a single dispatch loop:

```ts
import { aio } from 'aio'
import { counter } from './features/counter/index.ts'
import { wallet } from './features/wallet/index.ts'
import { analytics } from './features/analytics/index.ts'

await aio.run({
  features: [counter, wallet, analytics],
  ui: { title: 'My App', width: 1200, height: 800, transport: 'auto' },
})
```

### Feature dependencies

Declare dependencies for ordered initialization:

```ts
await aio.run({
  features: [
    counter,
    { feature: wallet, dependsOn: ['counter'] },   // wallet inits after counter
    { feature: analytics, dependsOn: ['counter', 'wallet'] },
  ],
})
```

Dependencies are validated: missing names throw, cycles throw, topological sort determines init order.

### Feature isolation (dev convenience)

Test a single feature in isolation:

```ts
await aio.run({
  features: [counter, wallet, analytics],
  isolate: ['counter'],  // only counter is active
})
```

Or via CLI: `deno task dev --isolate=counter`

### Middleware

```ts
await aio.run({
  features: [counter],
  middleware: [
    aio.middleware.logger(),              // log all actions
    aio.middleware.validate(),            // reject malformed actions
    aio.middleware.metrics(),             // track action counts per feature
  ],
})
```

All middleware receives `(action, state, user?)` — the `user` parameter is the `AioUser` from the WebSocket connection (undefined for server-side dispatches). Use `aio.middleware.create()` for per-user authorization:

```ts
aio.middleware.create((action, state, next, user) => {
  if (action.type.startsWith('admin:') && user?.role !== 'admin') return null
  return next(action)
})
```

Built-in middleware: `logger`, `validate`, `metrics`, `perfBudget`, `freeze`, `devtools`, `create` (custom).

### State versioning + migrations

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

### Return value — `app.features`

```ts
const app = await aio.run({ features: [counter, wallet] })

// Feature control API
app.features!.list()              // ['counter', 'wallet']
app.features!.status('counter')   // 'idle' | 'saving' | 'error' | ...
app.features!.health()            // [{ name, status, enabled, errors, lastAction, lastActionAt }]
app.features!.disable('wallet')   // disable at runtime (stops routing, dispatches Destroy)
app.features!.enable('wallet')    // re-enable (dispatches Init, resets state)
```

### FeaturesConfig options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `features` | `FeatureEntry[]` | **required** | Array of features (or `{ feature, dependsOn }` objects) |
| `middleware` | `MiddlewareFn[]` | — | Middleware chain applied before reduce |
| `version` | `number` | — | State version — triggers migrations on restore |
| `migrations` | `fn[]` | — | Migration functions: `(state) => state` |
| `isolate` | `string[]` | — | Only activate these features (dev convenience) |
| `beforeReduce` | `fn` | — | Intercept actions before reduce — return null to drop |
| `appId` | `string` | — | Canonical app identity — slugified, used for lock file, UDS socket, KV path, SQLite path, TLS cert dir. Resolution: `appId` > `deno.json "name"` > `ui.title` > `'aio-app'` |
| `singleton` | `boolean \| 'takeover'` | `true` | `true`: refuse if another instance running. `'takeover'`: kill existing, start new. `false`: allow multiple instances |
| All options from classic `aio.run` | — | — | `port`, `persist`, `persistKey`, `persistMode`, `persistDebounce`, `ui`, `baseDir`, `headless`, `users`, `db`, `schedules`, `perfMode`, `perfBudget`, `effectTimeout`, `freezeState`, `deltaThreshold`, `maxConnections`, `getUIState`, `getDBState`, `onRestore`, `onAction`, `onEffect`, `onConnect`, `onDisconnect`, `onStart`, `onStop`, `onError` |

## `bridge(name, config)` — cross-feature coordination

Bridges handle request/response patterns between features with timeout, retry, and circuit breaker support:

```ts
import { bridge } from 'aio'

const priceBridge = bridge('priceBridge', {
  from: 'engine',
  to: 'dataCollector',
  channels: {
    price: {
      request: (symbol: string) => ({ symbol }),
      response: (price: number) => ({ price }),
      timeout: 5000,    // ms before timeout
      retries: 2,       // retry on timeout
      backoff: 'exponential',
    },
  },
  circuitBreaker: {
    failureThreshold: 5,   // open circuit after 5 failures
    resetTimeout: 30_000,  // try half-open after 30s
  },
})
```

Bridge state includes `pending` (in-flight requests), `metrics` (counts, latency), and optional `circuit` (breaker state).

### Using a bridge

```ts
// In the requesting feature's executor:
const engine = feature('engine', {
  crossDispatch: ['priceBridge'],
  execute(app, effect, { E }) {
    case E.NeedPrice:
      app.dispatch(priceBridge.request!.price('BTC'))  // sends PriceBridge:PriceRequest
      break
  },
})

// In the responding feature's machine, listen for the request:
const dc = feature('dc', {
  machine: {
    initial: 'ready',
    states: {
      ready: { on: { fetch: 'ready', 'PriceBridge:PriceRequest': 'ready' } },
    },
  },
  // ...
})
```

### Bridge selectors

```ts
priceBridge.selectors.getPendingCount(state)    // number of in-flight requests
priceBridge.selectors.getAverageLatency(state)  // ms
priceBridge.selectors.isCircuitOpen(state)       // boolean
```

## `useFeature(ref)` — React hook for features

Connects a component to a specific feature with typed send and machine status:

```tsx
import { useFeature } from 'aio'
import { counter } from './features/counter/index.ts'

export default function App() {
  const { state, send, status } = useFeature(counter)
  if (!state) return <div>Connecting...</div>

  return (
    <div>
      <h1>{state.count}</h1>
      <p>Status: {status}</p>
      <button onClick={() => send.decrement()}>-</button>
      <button onClick={() => send.reset()}>Reset</button>
      <button onClick={() => send.increment(5)}>+5</button>
      {status === 'error' && (
        <>
          <p>Error: {state.error}</p>
          <button onClick={() => send.retry()}>Retry</button>
          <button onClick={() => send.dismiss()}>Dismiss</button>
        </>
      )}
    </div>
  )
}
```

**What you get:**
- `state: S | null` — the feature's state slice (null until connected)
- `send.<action>(...args)` — typed action dispatchers (camelCase, auto-tagged with `_source: 'UI'`)
- `status: string | undefined` — current machine status (`'idle'`, `'saving'`, etc.)

**vs `useAio()`:** `useFeature` gives you the feature slice directly (no `state.counter.count`), typed `send.increment()` instead of `send(A.increment())`, and the machine `status`. Use `useAio()` when you need the full state or multiple features in one component.

## Testing

See [testing.md](testing.md) for the full testing reference — `testFeature()`, `testBridge()`, TestContext API, async testing, and property-based fuzzing.

## Design decisions

Frequently asked questions about architectural choices.

### Why are selectors pull-based, not reactive?

Selectors are memoized functions called on demand — they don't push updates. This is intentional:

- **Server-side:** foreign listeners in `reduce()` handle "when X changes, update Y." The reducer IS the reactive layer.
- **Browser-side:** React re-renders on every state broadcast, which re-evaluates selectors via `useFeature()`.
- **Broadcast:** `getUIState()` can call selectors to compute derived state before sending to clients.

Push-based reactivity (like MobX/SolidJS) would add complexity with no benefit in this event-driven architecture.

### Why is `action.payload` typed as `unknown` in reducers?

Actions from different features flow through the same dispatch pipeline as `Msg = { type: string; payload: unknown }`. TypeScript can't narrow `payload` based on a `type` string match in `switch/case`.

**For `reactive()` features:** this doesn't matter — you write methods, not switch/case reducers.

**For `feature()` reducers:** cast payload at each case:

```ts
case A.Increment:
  state.count += (action.payload as { by: number }).by
```

The `A`/`E` catalogs carry full types at creation time (`A.increment(5)` returns a typed action), but the type is erased when routed through dispatch. This is a TypeScript limitation, not a framework bug.

### How are conflicts handled with multiple clients?

The server processes all actions **sequentially** in a single dispatch queue. Two clients sending conflicting actions is deterministic ordering, not a conflict — whichever arrives first is reduced first. This is by design:

- No concurrent state mutations — the dispatch loop is synchronous
- No need for CRDT, OT, or conflict resolution
- All clients converge to the same state via server-authoritative broadcast

### Can I filter state per feature for specific clients?

Yes, via `getUIState(state, user?)`:

```ts
await aio.run({
  features: [shop, auth, admin],
  getUIState: (state, user) => ({
    auth: state.auth,
    shop: state.shop,
    admin: user?.role === 'admin' ? state.admin : undefined,
  }),
})
```

The delta system automatically flattens one level for v0.5 namespaced state — if `mdview.scrollY` changes, only that sub-key is sent, not the entire `mdview` slice. Excluded features cost zero bandwidth. There's no need for per-feature subscription — `getUIState` is more flexible.

---

## Scheduled effects

Declarative timers, intervals, and cron jobs — returned as effects from the reducer or configured at startup.

### Config-level schedules

Always-on schedules defined in `aio.run()`:

```ts
import { schedule } from 'aio'

await aio.run(initialState, {
  reduce, execute,
  schedules: [
    { id: 'tick', every: 5000, action: { type: 'Tick', payload: {} } },
    { id: 'cleanup', cron: '0 3 * * *', action: { type: 'Cleanup', payload: {} } },
  ],
})
```

### Dynamic schedules (from reducer)

Return schedule effects from `reduce()` — they're intercepted by the framework:

```ts
import { schedule } from 'aio'

// In reduce.ts
case A.StartTimer:
  return { state, effects: [schedule.every('heartbeat', 1000, A.tick())] }

case A.StopTimer:
  return { state, effects: [schedule.cancel('heartbeat')] }
```

### Schedule API

| Function | Description |
|----------|-------------|
| `schedule.after(id, ms, action)` | One-shot delay — fires once after `ms` milliseconds |
| `schedule.every(id, ms, action)` | Repeating interval — fires every `ms` milliseconds |
| `schedule.at(id, isoTimestamp, action)` | One-shot at specific time (ISO 8601 string) |
| `schedule.cron(id, pattern, action)` | Cron schedule (5-field: `minute hour dom month dow`) |
| `schedule.cancel(id)` | Cancel any active schedule by ID |

**Cron patterns:**
- `* * * * *` — every minute
- `*/5 * * * *` — every 5 minutes
- `0 9 * * 1` — 9 AM every Monday
- `0,30 * * * *` — every 30 minutes
- `0 0 1 * *` — midnight on the 1st of each month

> **Timezone:** Cron patterns run in **UTC**. `0 9 * * *` fires at 09:00 UTC — convert to UTC when writing patterns. e.g. 9 AM London BST = `0 8 * * *`, 9 AM PST = `0 17 * * *`.

**Behavior:**
- Re-scheduling the same `id` replaces the previous schedule
- `schedule.after` auto-removes after firing
- `schedule.at` with a past timestamp fires immediately
- All schedules are cancelled on `app.close()`
- **Far-future scheduling:** For delays exceeding JavaScript's `setTimeout` limit (~24.8 days), the framework re-checks every 24 hours until the target time. This handles long-running processes like annual maintenance tasks.

## Lifecycle hooks

Optional `on*` callbacks on config — observe-only, error-guarded. Useful for logging, analytics, debugging, connection tracking, and setup/teardown.

```ts
await aio.run(state, {
  reduce, execute,
  onRestore:    (state) => ({ ...state, items: state.items.map(i => ({ score: 0, ...i })) }),
  onAction:     (action, state, user?) => console.log(`[${action.type}] by ${user?.id ?? 'anon'}`),
  onEffect:     (effect, user?) => console.log('effect:', effect.type),
  onConnect:    (user?) => console.log('connected:', user?.id ?? 'anonymous'),
  onDisconnect: (user?) => console.log('disconnected:', user?.id ?? 'anonymous'),
  onStart:      (app) => console.log('server ready'),
  onStop:       () => console.log('shutting down'),
})
```

| Hook | Fires | Arguments |
|------|-------|-----------|
| `onRestore` | After state restore from KV/localStorage | `(state)` — return transformed state. Runs before server starts, no race window |
| `onAction` | Before `reduce()` | `(action, state, user?)` — `state` is pre-reduce, `user` is the `AioUser` who dispatched |
| `onEffect` | Before `execute()` | `(effect, user?)` |
| `onConnect` | WS client connects | `(user?)` — `undefined` in public mode |
| `onDisconnect` | WS client disconnects | `(user?)` |
| `onStart` | After server boots | `(app)` — same `AioApp` as `run()` return value |
| `onStop` | Before shutdown | *(none)* |
| `onError` | When reduce or effect throws | `(error: AioError)` — see error handling below |

All hooks are:
- **Optional** — omit any you don't need
- **Observe-only** — void return, no transform/drop (except `onRestore` which returns new state)
- **Error-guarded** — a throwing hook is logged but doesn't crash the app
- **Sync** — hooks run synchronously in the lifecycle; async work should dispatch actions

### Error handling with `onError`

When `reduce()` throws or an effect throws, the error is caught and the app continues running. Use `onError` to observe these errors:

```ts
await aio.run(state, {
  reduce, execute,
  onError: (err) => {
    // err.source: 'reduce' | 'effect'
    // err.error: the thrown value
    // err.actionType?: string  — action that caused reduce error
    // err.effectType?: string — effect type that threw
    if (err.source === 'reduce') {
      console.error(`Reducer threw on ${err.actionType}:`, err.error)
    } else {
      console.error(`Effect ${err.effectType} threw:`, err.error)
    }
  },
})
```

**Key behaviors:**
- **Reduce errors:** Action is dropped, state unchanged, next action processes normally
- **Sync effect errors:** Logged, remaining effects continue
- **Async effect errors:** Caught via `.catch()`, logged, app continues
- Without `onError`, errors are only logged to console

> **Tip:** If you have arrays of objects with evolving schemas (e.g. adding new required fields), consider using [SQLite persistence](persistence.md) for those arrays — it handles schema via `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE`. For simpler cases, `onRestore` lets you patch missing fields after KV restore.

`onStop` fires on both `app.close()` and signal-triggered shutdown (SIGINT/SIGTERM).

**Need to intercept/transform actions?** Use `beforeReduce`:
```ts
await aio.run(state, {
  reduce, execute,
  beforeReduce: (action, state, user?) => {
    if (action.type === 'Nope') return null          // drop
    if (action.type === 'Inc' && state.locked) return null  // conditional drop
    if (action.type === 'Admin' && user?.role !== 'admin') return null  // per-user auth
    return action                                     // pass through
  },
})
```
`beforeReduce` runs before `onAction` and `reduce`. The `user` parameter is the `AioUser` from the WebSocket connection (undefined for server-side dispatches). Return the action (optionally modified) to continue, or `null` to drop it silently. Errors in `beforeReduce` are logged and the action is dropped.
