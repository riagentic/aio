# Building with Generators

Sequential async workflows for aio features. Write top-to-bottom code — each step is observable, cancellable, and appears in time-travel.

For the core feature API, see [core.md](core.md). For reactive features (simpler), see [reactivity.md](reactivity.md). For getting started, see [quickstart.md](quickstart.md).

## Two ways to write generators

### Inline — `generators` key (recommended)

The simplest path. Add a `generators` key to any `feature({ methods })`:

```ts
import { feature } from 'aio'

const order = feature('order', {
  state: { status: 'idle' as string, orderId: null as string | null },
  methods: {
    reset(s) { s.status = 'idle'; s.orderId = null },
  },
  generators: {
    *place(ctx) {
      yield* ctx.mutate('processing', s => { s.status = 'processing' })
      const id = yield* ctx.call('submit', () => submitOrder())
      yield* ctx.done(s => { s.orderId = id as string; s.status = 'done' })
    },
  },
})

await aio.run({ features: [order] })

order.place()   // dispatches Order:Place, starts the generator
order.reset()   // plain method — still works
```

No `flow()` import. No trigger string. The action name is inferred from the generator name (`place` → `Order:Place`).

#### Cancellation with `cancelOn` config key

Declare which actions abort a generator using the `cancelOn` config key:

```ts
import { feature } from 'aio'

const gateway = feature('gateway', {
  state: { status: 'idle' },
  methods: { stop(s) { s.status = 'idle' } },
  generators: {
    // No cancellation — just a function
    fetch: function*(ctx) { ... },

    // Cancellable — declare in cancelOn config, pass bound method or string
    startup: function*(ctx) {
      yield* ctx.mutate('init', s => { s.status = 'starting' })
      yield* ctx.call('connect', () => openConnection())
      yield* ctx.done(s => { s.status = 'ready' })
    },
  },
  cancelOn: {
    startup: [gateway.stop],  // bound method (.type) or plain string
  },
})
```

`cancelOn` triggers accept:
- Bound methods directly (`gateway.stop`) — preferred, refactor-safe
- Bound methods with `.type` (`gateway.stop.type`) — also works
- Lowercase type strings (`'gateway:stop'`) — last resort

### With `feature({ actions })` — generators key matches action keys

Generators work in both feature styles. In actions-based features, the generator key must match an action key and receives the **payload object directly** — no casts, no positional indexing:

```ts
import { feature } from 'aio'

const checkout = feature('checkout', {
  state: { status: 'idle', orderId: null as string | null },
  actions: { start: (item: string) => ({ item }), cancel: () => ({}) },
  generators: {
    // action: start: (item: string) => ({ item })
    // generator receives the payload object: { item: string }
    start: function*(ctx, { item }: { item: string }) {
      const id = yield* ctx.call('submit', () => submitOrder(item))
      yield* ctx.done(s => { s.orderId = id as string })
    },
  },
  cancelOn: {
    start: [checkout.cancel],
  },
})
```

Methods-style generators (`feature({ methods })`) receive **spread args** matching the method signature — same parameter names and types, without the leading `s`:

```ts
// method: async place(s, item: string, qty: number)
generators: {
  place: function*(ctx, item: string, qty: number) {
    const price = yield* ctx.call('fetchPrice', () => getPrice(item))
    yield* ctx.done(s => { s.total = (price as number) * qty })
  },
}
```

> **Type annotations required.** TypeScript can't infer arg types from the method signature automatically — annotate them explicitly, same as you would on any function. Without annotations args are `unknown`. This is consistent with how methods work and serves as inline documentation.

> **Quick reference — generator arg styles:**
> - `feature({ methods })` → generators receive **spread args**: `*place(ctx, item: string, qty: number)`
> - `feature({ actions })` → generators receive **payload object**: `*place(ctx, { item, qty }: { item: string; qty: number })`
>
> Same `generators:` key, different arg shape. The style is determined by which of `methods` or `actions` the feature uses.

---

## Why generators

The standard reduce/execute pattern is **reactive** — great for "when X happens, do Y." But multi-step workflows get scattered:

```
action → reducer case → effect → executor case → action → reducer case → ...
```

The actual sequence is invisible. You reconstruct it by tracing across files.

Generators let you write the **same logic sequentially**:

```ts
function* checkout(ctx, { item }: { item: string }) {
  const price = yield* ctx.call('fetchPrice', () => fetchPrice(item))
  if (price > 1000) { yield* ctx.fail('too expensive'); return }
  const order = yield* ctx.call('placeOrder', () => placeOrder(price))
  yield* ctx.done(s => { s.orderId = order.id })
}
```

Read top-to-bottom. The framework handles actions, state transitions, and time-travel under the hood.

### What you stop writing

| With reduce/execute | With flow | Gone? |
|---|---|---|
| Intermediate actions (`priceLoaded`, `confirmed`, `failed`) | 0 | auto-generated from yield names |
| Effect catalog (`fetchPrice`, `placeOrder`) | 0 | inline in `ctx.call()` |
| Machine states (`fetching`, `confirming`, `done`) | 0 | auto-generated from yield names |
| Machine transitions | 0 | implied by sequential order |
| Reducer switch cases | 0 | `ctx.mutate()` mutates directly |
| Executor switch cases | 0 | `ctx.call()` runs inline |

### What the framework does at each yield

```
yield* ctx.call('fetchPrice', fn)
         │
         ├─ 1. dispatch({ type: 'checkout:flow:fetchPrice' })    ← time-travel visible
         ├─ 2. execute fn()                                      ← actual async work
         └─ 3. return result to generator                        ← sequential code continues
```

Every step is an action in history. Other features can listen to flow actions via foreign listeners.

## Syntax

Generators use `function*` and `yield*`:

```ts
// Regular async               Generator flow
async function run() {          function* run(ctx) {
  const a = await fetch(x)        const a = yield* ctx.call('fetch', () => fetch(x))
  return a                         return a
}                               }
```

The tax: `yield* ctx.call('name', () => ...)` instead of `await`. The logic — ifs, loops, variables, early returns — is identical.

### Why `yield*` (not `yield`)

`ctx.call()` returns a sub-generator (not a value). `yield*` delegates into it and unwraps the result. `yield` would give you the generator object — useless.

```ts
const price = yield ctx.call(...)   // Generator{} — wrong
const price = yield* ctx.call(...)  // 42 — correct
```

> ⚠️ **Common mistake:** `yield ctx.call(...)` (without `*`) returns the generator object, not the value. Always use `yield*` with all ctx methods. There's no compile-time guard — this fails silently at runtime.

This is standard JavaScript (ES2015+). Works everywhere — Deno, Node, browsers.

## Complete example

```ts
import { feature } from 'aio'

const checkout = feature('checkout', {
  state: {
    price: 0,
    orderId: null as string | null,
    error: null as string | null,
  },
  methods: {},
  generators: {
    // methods-style: spread args (no payload wrapper)
    *place(ctx, item: string) {
      // Step 1 — fetch price
      const res = yield* ctx.call('fetchPrice', () =>
        fetch(`/api/price?item=${item}`).then(r => r.json())
      )
      const price = (res as { price: number }).price

      // Step 2 — validate
      if (price > 1000) {
        yield* ctx.fail('too expensive')
        return
      }

      // Step 3 — update state
      yield* ctx.mutate('setPrice', s => { s.price = price })

      // Step 4 — place order
      const order = yield* ctx.call('placeOrder', () =>
        fetch('/api/order', {
          method: 'POST',
          body: JSON.stringify({ item, price }),
        }).then(r => r.json())
      )

      // Step 5 — done
      yield* ctx.done(s => {
        s.orderId = (order as { id: string }).id
      })
    },
  },
})
```

**Auto-generated from this flow:**

Actions dispatched (visible in time-travel):
- `checkout:place` (trigger — from the generator name)
- `checkout:flow:fetchPrice`
- `checkout:flow:setPrice`
- `checkout:flow:placeOrder`
- `checkout:flow:done` or `checkout:flow:failed`

You never define these. The flow is the source of truth.

## GenCtx API

### `ctx.call(name, fn)` — async work

Executes `fn`, dispatches a named action, returns the result.

```ts
// Async
const user = yield* ctx.call('loadUser', () =>
  fetch(`/api/users/${id}`).then(r => r.json())
)

// Sync (works too)
const hash = yield* ctx.call('computeHash', () => md5(data))

// Destructure the result
const { price, currency } = yield* ctx.call('getPrice', () =>
  fetchPrice(item)
) as { price: number; currency: string }
```

**What happens internally:**
1. Dispatches `{Feature}:Flow:{Name}` action (time-travel, foreign listeners)
2. Calls `fn()` and awaits the result
3. Returns result to the generator

If `fn` throws, the flow catches it and dispatches `{Feature}:Flow:Error`.

### `ctx.mutate(name, mutate)` — state mutation

Updates the feature's state slice via Immer draft. Dispatches a named action.

```ts
yield* ctx.mutate('updateBalance', s => {
  s.balance += amount
  s.lastUpdated = Date.now()
})

yield* ctx.mutate('addItem', s => {
  (s.items as string[]).push(newItem)
})
```

The mutation is applied immediately. Subsequent `ctx.call` or `ctx.mutate` calls see the updated state.

`ctx.step` is a deprecated alias for `ctx.mutate` — same behavior.

---

**State is typed automatically.** The `s` parameter in `ctx.mutate`, `ctx.done`, and `ctx.getState()` is typed as your feature's state — no casts needed when generators are defined inside `feature()`.

```ts
const counter = feature('counter', {
  state: { count: 0 },
  generators: {
    *tick(ctx) {
      yield* ctx.mutate('inc', s => { s.count += 1 })  // s.count is number ✓
    },
  },
})
```

For standalone reusable generators, annotate `ctx: GenCtx<{ count: number }>` explicitly. Default is `GenCtx<Record<string, unknown>>`.

### `ctx.done(mutate?)` — terminal success

Marks the flow as complete. Dispatches `{Feature}:Flow:Done`. Optional final state mutation.

```ts
// With final mutation
yield* ctx.done(s => {
  s.status = 'complete'
  s.completedAt = Date.now()
})

// Without mutation
yield* ctx.done()
```

After `ctx.done()`, the generator returns normally. No more steps execute.

### `ctx.fail(reason)` — terminal failure

Marks the flow as failed. Dispatches `{Feature}:Flow:Failed` with the reason. Stops the generator.

```ts
if (!valid) {
  yield* ctx.fail('validation failed')
  return  // TypeScript needs this, but the generator is already stopped
}

// This code never executes after ctx.fail
yield* ctx.mutate('unreachable', s => { s.x = 1 })
```

The `return` after `ctx.fail()` is for TypeScript — the flow runtime stops the generator regardless.

### `ctx.dispatch(action)` — dispatch action

Dispatches a regular action into the system. Other features' reducers and foreign listeners react to it normally.

```ts
// Dispatch to own feature — use A catalog in ctx.dispatch
yield* ctx.dispatch(checkout.A.reset())

// Dispatch to another feature (cross-feature)
yield* ctx.dispatch(wallet.A.credit(100))

// Use the feature's own action creators
yield* ctx.dispatch(checkout.A.start('widget'))
```

`ctx.dispatch` doesn't wait for the action to be processed. It dispatches and continues.

### `ctx.send(creatorOrType, payload?)` — shorthand dispatch

Shorthand for dispatching to another feature. Accepts a bound method (with `.type`) or a plain type string:

```ts
// Bound method — no raw strings, refactor-safe
yield* ctx.send(analytics.log, { msg: 'order placed' })

// Type string — when you only have the string
yield* ctx.send('analytics:log', { msg: 'order placed' })
```

Equivalent to `ctx.dispatch({ type: ..., payload: ... })` but shorter. `ctx.dispatch` is still available for full action objects (e.g. when you need to pass `payload` as a nested structure).

### `ctx.all(...generators)` — parallel execution

Runs multiple calls in parallel, waits for all to complete. Returns results as an array.

```ts
// Spread form — destructure by position
const [user, orders, prefs] = yield* ctx.all(
  ctx.call('loadUser', () => fetchUser(id)),
  ctx.call('loadOrders', () => fetchOrders(id)),
  ctx.call('loadPrefs', () => fetchPrefs(id)),
)

// Named form — destructure by name (cleaner for 2+ calls)
const { user, orders } = yield* ctx.all({
  user:   ctx.call('loadUser', () => fetchUser(id)),
  orders: ctx.call('loadOrders', () => fetchOrders(id)),
})

// All three fetches run concurrently
// Each dispatches its own action for time-travel visibility
yield* ctx.mutate('loaded', s => {
  s.user = user
  s.orders = orders
  s.prefs = prefs
})
```

Both forms run all calls in parallel. Named form is more readable when you have 2+ calls and want to avoid positional confusion.

If any call throws, the flow errors.

**Limitation:** `ctx.all()` only accepts single-step generators (`ctx.call`, `ctx.sleep`). Multi-step generators (custom composed flows) are not supported and will throw at runtime.

### `ctx.race(entries)` — first wins

Runs multiple calls, returns when the first one resolves. The result has only the winner's key set. Same single-step limitation as `ctx.all()`.

```ts
const result = yield* ctx.race({
  data: ctx.call('fetch', () => fetchData(id)),
  timeout: ctx.sleep('timeout', 5000),
})

if (result.timeout !== undefined) {
  yield* ctx.fail('request timed out')
  return
}

// result.data has the fetched data
yield* ctx.done(s => { s.data = result.data })
```

Common patterns:
- **Timeout**: race a fetch against a sleep
- **User cancellation**: race work against waiting for a cancel action
- **Fastest source**: race multiple APIs, take whichever responds first

**Alternative:** If you don't need per-call time-travel visibility, use `Promise.all` inside a single `ctx.call`:

```ts
const [a, b] = yield* ctx.call('fetchBoth', () =>
  Promise.all([fetchA(), fetchB()])
) as [TypeA, TypeB]
```

One action in time-travel instead of two. Use `ctx.all` when you want each call individually visible.

### `ctx.getState()` — read current feature state

Returns the current state of the flow's feature. Always fresh — reads the latest committed state after any preceding `ctx.mutate` or external dispatch.

```ts
yield* ctx.mutate('increment', s => { s.count++ })
const s = ctx.getState()   // fresh state after the step — typed as feature state
if (s.count >= 10) {
  yield* ctx.done()
  return
}
```

Not a generator — call it directly (no `yield*`). Use it when you need to read state for control flow decisions without another `ctx.mutate`.

### `ctx.waitFor(actionType, timeout?)` — wait for external action

Pauses the flow until a matching action is dispatched anywhere in the system. Returns the full action object.

```ts
// Preferred: bound method — works directly, .type is used, payload untyped
const msg = yield* ctx.waitFor(payment.complete)
const { orderId } = msg.payload as { orderId: string }

// With timeout
try {
  const msg = yield* ctx.waitFor(payment.complete, 30_000)
  yield* ctx.done(s => { s.orderId = (msg.payload as { orderId: string }).orderId })
} catch {
  yield* ctx.fail('payment timeout')
}

// A catalog creator — if you need typed payload inference
const msg = yield* ctx.waitFor(payment.A.complete)
const { orderId } = msg.payload  // typed — no cast needed
```

Note: bound methods dispatch (return void), so they don't carry payload type info — cast needed. A catalog creators return the action object, so TypeScript infers the payload type.

**String form** — use when you only have the type string:

```ts
// Untyped — payload is unknown, cast manually (use only when you have no bound function)
const confirm = yield* ctx.waitFor('checkout:confirm')
const { approved } = confirm.payload as { approved: boolean }
if (!approved) { yield* ctx.fail('user cancelled'); return }
```

**What happens internally:**
1. Dispatches `{Feature}:Flow:WaitFor` action (time-travel visible, includes `actionType` and `timeout`)
2. Registers a one-shot listener on the dispatch loop
3. When the matching action fires, the listener resolves and the flow continues
4. If `timeout` is provided and expires, throws an error (catchable via try/catch in the generator)

**Use cases:**
- Wait for user confirmation before proceeding
- Coordinate between features ("wait until payment completes")
- Race `ctx.waitFor` against `ctx.sleep` via `ctx.race` for custom timeout behavior

### `ctx.sleep(name, ms)` — observable pause

Pauses the flow for `ms` milliseconds. Dispatches a named action so the pause is visible in time-travel.

```ts
// Wait 3 seconds
yield* ctx.sleep('cooldown', 3000)

// Retry with delay
for (let i = 0; i < 3; i++) {
  try {
    const result = yield* ctx.call('attempt', () => riskyFetch())
    yield* ctx.done(s => { s.result = result })
    return
  } catch {
    if (i < 2) yield* ctx.sleep('retryDelay', 1000 * (i + 1))
  }
}
yield* ctx.fail('max retries exceeded')
```

## Mixing flows with reduce/execute

Flows and reducers coexist in the same feature. Use each for what it does best:

```ts
const wallet = feature('wallet', {
  state: { balance: 0, syncing: false, lastSync: null as string | null },

  actions: {
    deposit:  (amount: number) => ({ amount }),
    withdraw: (amount: number) => ({ amount }),
    sync:     () => ({}),
  },

  machine: {
    initial: 'idle',
    states: {
      idle: { deposit: 'idle', withdraw: 'idle', sync: 'syncing' },
      syncing: {},
    },
  },

  // Reactive — instant state updates, no async
  reduce: {
    deposit(state, payload) {
      state.balance += (payload as { amount: number }).amount
    },
    withdraw(state, payload) {
      state.balance -= (payload as { amount: number }).amount
    },
  },

  // Sequential — the sync workflow
  generators: {
    sync: function*(ctx) {
      yield* ctx.mutate('start', s => { s.syncing = true })

      const remote = yield* ctx.call('fetchRemote', () =>
        fetch('/api/balance').then(r => r.json())
      ) as { balance: number }

      yield* ctx.done(s => {
        s.balance = remote.balance
        s.syncing = false
        s.lastSync = new Date().toISOString()
      })
    },
  },
})
```

| Use case | Pattern |
|---|---|
| Instant state update (deposit, withdraw, toggle) | `reduce` |
| React to other features' actions | `reduce` + foreign listeners |
| Multi-step async sequence | `generators` |
| Request/response with retries | `call({ timeout, retries }, ...)` |

## Generator-only features

If your feature is entirely sequential, skip `reduce`, `effects`, and `machine`:

```ts
const importer = feature('importer', {
  state: { records: 0, status: 'idle' as 'idle' | 'running' | 'done' | 'error' },
  actions: {
    start: (file: string) => ({ file }),
  },
  generators: {
    // actions-style: payload object passed directly — destructure it
    start: function*(ctx, { file }: { file: string }) {
      yield* ctx.mutate('begin', s => { s.status = 'running' })

      const raw = yield* ctx.call('readFile', () => Deno.readTextFile(file))
      const rows = yield* ctx.call('parse', () => JSON.parse(raw as string))

      for (const row of rows as unknown[]) {
        yield* ctx.call('insert', () => db.insert(row))
      }

      yield* ctx.done(s => {
        s.records = (rows as unknown[]).length
        s.status = 'done'
      })
    },
  },
})
```

No reducer. No effect catalog. No executor. The generator handles everything.

## Patterns

### Self-dispatch from async methods

After `aio.run()`, feature methods are bound to the store. Async methods can call other methods on the same feature via closure — the call dispatches through the store, machine guards apply, and the action appears in time-travel:

```ts
export const gateway = feature('gateway', {
  state: { status: 'idle' as string, fails: 0 },
  methods: {
    async checkHealth(s) {
      const ok = await probe(s.url)
      if (!ok) s.fails++
      if (s.fails >= 3) gateway.restart()  // dispatches Gateway:Restart through the store
    },
    async restart(s) {
      s.status = 'restarting'
      // ...
    },
  },
})
```

This works because by the time `checkHealth` is called, `aio.run()` has already bound `gateway.restart`. No additional API needed.

For cross-feature calls, import the target feature and call directly — it dispatches through the store, respects machine guards, and returns a typed Promise. Use `call({ timeout, retries }, () => feature.method())` when you need resilience.

### Error handling

Errors in `ctx.call` automatically stop the flow and dispatch `{Feature}:Flow:Error`. For custom error handling, use try/catch:

```ts
function* syncFlow(ctx: GenCtx) {
  try {
    const data = yield* ctx.call('fetch', () => fetchData())
    yield* ctx.done(s => { s.data = data })
  } catch {
    yield* ctx.mutate('setError', s => { s.error = 'sync failed' })
    yield* ctx.fail('sync failed')
  }
}
```

### Retry with backoff

```ts
function* resilientFetch(ctx: GenCtx, url: string, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = yield* ctx.call(`fetch-${attempt}`, () =>
        fetch(url).then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        })
      )
      return result
    } catch {
      if (attempt === maxRetries) {
        yield* ctx.fail(`failed after ${maxRetries + 1} attempts`)
        return
      }
      // Exponential backoff: 1s, 2s, 4s
      yield* ctx.sleep(`retry-wait-${attempt}`, 1000 * Math.pow(2, attempt))
    }
  }
}

const fetcher = feature('fetcher', {
  state: { data: null, error: null as string | null },
  actions: { start: (url: string) => ({ url }) },
  generators: {
    start: function*(ctx, { url }: { url: string }) {
      const data = yield* resilientFetch(ctx, url)
      if (data) yield* ctx.done(s => { s.data = data })
    },
  },
})
```

Reusable generator functions work as composable building blocks. Extract common patterns (retry, polling, pagination) into shared generators.

### Polling

```ts
generators: {
  startMonitor: function*(ctx) {
    while (true) {
      const status = yield* ctx.call('check', () =>
        fetch('/api/health').then(r => r.json())
      ) as { healthy: boolean }

      yield* ctx.mutate('update', s => {
        s.lastCheck = Date.now()
        s.healthy = status.healthy
      })

      if (!status.healthy) {
        yield* ctx.dispatch(alerts.A.trigger('System unhealthy'))  // A catalog used in ctx.dispatch
      }

      yield* ctx.sleep('interval', 30_000) // check every 30s
    }
    // Runs indefinitely until cancelled
    // (by feature disable, new trigger, or app shutdown)
  },
}
```

### Pagination

```ts
generators: {
  start: function*(ctx) {
    let page = 1
    let hasMore = true
    const allItems: unknown[] = []

    while (hasMore) {
      const result = yield* ctx.call(`page-${page}`, () =>
        fetch(`/api/items?page=${page}`).then(r => r.json())
      ) as { items: unknown[]; hasMore: boolean }

      allItems.push(...result.items)
      hasMore = result.hasMore
      page++

      yield* ctx.mutate(`loaded-${page}`, s => {
        s.items = allItems
        s.loadedPages = page - 1
      })
    }

    yield* ctx.done(s => { s.loading = false })
  },
}
```

### Conditional branching

```ts
generators: {
  start: function*(ctx, { userId }: { userId: string }) {
    const user = yield* ctx.call('loadUser', () => fetchUser(userId))
    const plan = (user as { plan: string }).plan

    if (plan === 'trial') {
      yield* ctx.call('startTrial', () => startTrial(userId))
      yield* ctx.call('sendTrialEmail', () => sendEmail(userId, 'trial-welcome'))
    } else if (plan === 'pro') {
      yield* ctx.call('provision', () => provisionPro(userId))
      yield* ctx.call('sendProEmail', () => sendEmail(userId, 'pro-welcome'))
    }

    yield* ctx.call('logOnboard', () => analytics.track('onboard', { plan }))
    yield* ctx.done(s => { s.onboarded = true })
  },
}
```

Plain `if/else`, `for`, `while`, `switch`, `try/catch` — all work naturally. No special operators needed.

### Multi-feature orchestration

```ts
const orderFlow = feature('orderFlow', {
  state: { orderId: null as string | null },
  actions: {
    placeOrder: (item: string, qty: number) => ({ item, qty }),
  },
  dispatchTo: [inventory, billing, notifications],
  generators: {
    placeOrder: function*(ctx, { item, qty }: { item: string; qty: number }) {

      // Reserve stock (dispatch to inventory feature)
      yield* ctx.dispatch(inventory.A.reserve(item, qty))  // A catalog in ctx.dispatch

      // Charge payment
      const charge = yield* ctx.call('charge', () =>
        stripe.charge({ item, qty })
      )

      // Create order record
      const order = yield* ctx.call('createOrder', () =>
        db.orders.insert({ item, qty, chargeId: (charge as { id: string }).id })
      )

      // Notify user
      yield* ctx.dispatch(notifications.A.send('Order confirmed!'))  // A catalog in ctx.dispatch

      yield* ctx.done(s => {
        s.orderId = (order as { id: string }).id
      })
    },
  },
})
```

`ctx.dispatch` dispatches to other features. Declare them in `dispatchTo` for the scoped dispatch guard.

## Cancellation

### Declarative cancellation with `cancelOn` config key

Declare which actions abort a generator using the `cancelOn` config key:

```ts
import { feature } from 'aio'

feature('monitor', {
  // ...
  generators: {
    healthCheck: function*(ctx) {
      while (true) {
        yield* ctx.call('check', () => fetch('/health'))
        yield* ctx.sleep('wait', 30_000)
      }
    },
  },
  cancelOn: {
    healthCheck: [monitor.stop],  // bound method — preferred, refactor-safe
  },
})

// Dispatching monitor.stop() cancels the healthCheck generator
```

`cancelOn` accepts:
- Bound methods directly (`monitor.stop`) — preferred, refactor-safe
- Bound methods with `.type` (`monitor.stop.type`) — also works
- Lowercase type strings (`'monitor:stop'`) — last resort

The generator is cancelled immediately when any matching action is dispatched.

### Automatic re-trigger cancellation

If a flow is triggered while a previous instance is still running, the old one is **automatically cancelled**:

```ts
// User clicks "sync" rapidly
sync.start()  // flow starts
sync.start()  // old flow cancelled, new one starts
sync.start()  // old flow cancelled, new one starts
```

Only the latest instance runs. No duplicate work, no race conditions.

### Feature disable / destroy

When a feature is disabled or destroyed (`app.features.disable('checkout')`), all its running flows are cancelled immediately. Generators are cleaned up via `.return()`.

### No manual cancellation needed

Unlike async/await (where you wire AbortController manually), flows use structured concurrency — parent teardown cascades automatically. You never write cleanup code for cancellation.

## What the framework generates

For a flow with these yield points:

```ts
yield* ctx.call('fetchPrice', fn)
yield* ctx.mutate('validate', fn)
yield* ctx.call('placeOrder', fn)
yield* ctx.done(fn)
```

The framework dispatches these actions (visible in time-travel and devtools):

| Action dispatched | When |
|---|---|
| `checkout:start` | Trigger action (you defined this) |
| `checkout:flow:fetchPrice` | Before executing the fetch |
| `checkout:flow:validate` | Before applying the mutate |
| `checkout:flow:placeOrder` | Before executing the order |
| `checkout:flow:done` | Flow completed successfully |

On failure:
| `checkout:flow:failed` | `ctx.fail()` called |
| `checkout:flow:error` | Unhandled exception in flow |

All actions have `_source: 'Effect'` and include `_flow` and `_step` metadata in the payload.

### Foreign listeners

Other features can react to flow actions. They're regular actions:

```ts
const analytics = feature('analytics', {
  // ...
  machine: {
    initial: 'ready',
    states: {
      ready: {
        'checkout:flow:done': 'ready',        // listen to flow completion
        'checkout:flow:failed': 'ready',      // listen to flow failure
      },
    },
  },
  // Function-form reduce for flow action matching
  reduce(state, action) {
    if (action.type === 'checkout:flow:done') {
      state.checkouts += 1
    }
  },
})
```

### Foreign actions in object-form `reduce`

Computed keys let you react to foreign actions directly in the object-form reducer — no raw strings needed:

```ts
import { inventory } from '../inventory'

reduce: {
  // Own actions — by name
  increment(state, payload) { state.count += payload.n },

  // Foreign actions — by computed .type key
  [inventory.reserve.type](state, payload) {
    state.reserved = payload.items
  },
},
```

Note: `listensTo` declares what foreign actions the machine allows through; the `reduce` object handles them. Both work together — `listensTo` for the guard, computed keys for the handler.

## Testing generators

Generators run in the same compose/dispatch system. Test them like any feature:

```ts
import { feature, composeFeatures } from 'aio'

// Create a test harness
function testApp(features) {
  const composed = composeFeatures(features)
  let state = { ...composed.initialState }
  const dispatched = []

  const app = {
    dispatch(action) {
      dispatched.push(action)
      const result = composed.reduce(state, action)
      state = { ...result.state }
      for (const effect of result.effects) {
        composed.execute(app, effect)
      }
    },
    getState: () => state,
    dispatched,
    flush: () => new Promise(r => setTimeout(r, 50)),
  }
  return app
}

Deno.test('checkout flow: happy path', async () => {
  const app = testApp([checkout])
  app.dispatch(checkout.A.start('widget'))   // A catalog used in direct dispatch
  await app.flush()

  const s = app.getState().checkout
  assertEquals(s.orderId, 'abc-123')
  assertEquals(s.price, 42)

  // Verify steps were dispatched
  const types = app.dispatched.map(d => d.type)
  assert(types.includes('checkout:flow:fetchPrice'))
  assert(types.includes('checkout:flow:done'))
})

Deno.test('checkout flow: too expensive', async () => {
  // Mock the fetch to return high price
  const app = testApp([checkout])
  app.dispatch(checkout.A.start('expensive-item'))
  await app.flush()

  const types = app.dispatched.map(d => d.type)
  assert(types.includes('checkout:flow:failed'))

  const failAction = app.dispatched.find(d => d.type.includes('Failed'))
  assertEquals(failAction.payload.reason, 'too expensive')
})
```

### Step-level testing

For fine-grained testing, directly instantiate the generator:

```ts
Deno.test('checkout flow: step by step', () => {
  const ctx = {
    call: function* (name, fn) { return yield { kind: 'call', name, fn } },
    mutate: function* (name, mutate) { yield { kind: 'mutate', name, mutate } },
    step: function* (name, mutate) { yield { kind: 'mutate', name, mutate } },  // deprecated alias
    done: function* (mutate) { yield { kind: 'done', mutate } },
    fail: function* (reason) { yield { kind: 'fail', reason }; throw new Error(reason) },
    dispatch: function* (action) { yield { kind: 'dispatch', action } },
    all: function* (...gens) { return yield { kind: 'all', entries: [] } },
    race: function* (entries) { return yield { kind: 'race', entries: {} } },
    sleep: function* (name, ms) { yield { kind: 'sleep', name, ms } },
  }

  // actions-style: pass payload directly (no action wrapper)
  const gen = checkoutFlow.generator(ctx, { item: 'widget' })

  // Step 1: should yield a call to fetchPrice
  const step1 = gen.next()
  assertEquals(step1.value.kind, 'call')
  assertEquals(step1.value.name, 'fetchPrice')

  // Feed mock result
  const step2 = gen.next({ price: 42 })
  assertEquals(step2.value.kind, 'step')
  assertEquals(step2.value.name, 'setPrice')

  // ... continue stepping through
})
```

## Comparison: three ways to write async logic

### Event-driven (reduce + execute)

```ts
// 5 actions, 2 effects, 4 machine states, 5 reducer cases, 2 executor cases
// Sequence invisible — reconstruct by tracing action chains
const checkout = feature('checkout', {
  actions: {
    start:       (item: string) => ({ item }),
    priceLoaded: (price: number) => ({ price }),
    confirmed:   (orderId: string) => ({ orderId }),
    failed:      (error: string) => ({ error }),
    retry:       () => ({}),
  },
  effects: {
    fetchPrice: (item: string) => ({ item }),
    placeOrder: (price: number) => ({ price }),
  },
  machine: {
    initial: 'idle',
    states: {
      idle:       { start: 'fetching' },
      fetching:   { priceLoaded: 'confirming', failed: 'idle' },
      confirming: { confirmed: 'done', failed: 'idle' },
      done:       { retry: 'idle' },
    },
  },
  reduce: { /* named handlers */ },
  execute: { /* named handlers */ },
})
```

### Generator

```ts
// 1 action, 0 effects, sequence is the code
const checkout = feature('checkout', {
  actions: { start: (item: string) => ({ item }) },
  generators: {
    start: function*(ctx, { item }: { item: string }) {
      const price = yield* ctx.call('fetchPrice', () => fetchPrice(item))
      if (price > 1000) { yield* ctx.fail('too expensive'); return }
      yield* ctx.mutate('setPrice', s => { s.price = price })
      const order = yield* ctx.call('placeOrder', () => placeOrder(price))
      yield* ctx.done(s => { s.orderId = order.id })
    },
  },
})
```

### When to use which

| | Event-driven | Flow |
|---|---|---|
| **Readability** | Scattered across cases | Top-to-bottom |
| **Time-travel** | Every step (manual) | Every step (automatic) |
| **Boilerplate** | High (actions, effects, machine, cases) | Low (just the sequence) |
| **Best for** | Reactive logic, instant state updates | Sequential async workflows |
| **Use together?** | Yes — mix in the same feature | Yes |

## When NOT to use flows

Flows can do everything, but for some problems reduce/execute is the simpler tool. Use reduce when:

### Purely reactive logic — no sequence exists

"When price changes, recalculate totals. When totals change, update tax." There's no step 1→2→3 — it's independent reactions to state changes. A reducer with foreign listeners handles this naturally. A flow would force a sequence where none exists.

```ts
// Natural as a reducer — reacts to any source
reduce: {
  taxRateChanged(state) {
    state.tax = state.total * rate   // reacts to tax rate changes from anywhere
  },
  // For foreign actions, use function-form with { on }:
  // reduce(state, action, { on }) { on(dc.priceUpdated, () => { state.total = recalc(state) }) }
}

// Awkward as a flow — what triggers it? It's not a sequence.
```

### Long-lived processes that survive restarts

A flow lives in memory. If the server restarts mid-flow, it's gone. For a 3-second checkout, no problem. For a 24-hour onboarding workflow ("wait for email verification → wait for first login → send day-3 nudge"), use the machine + KV persistence — the state survives restarts because it's on disk, not in a generator's stack frame.

```ts
// Machine states persist across restarts — the right tool here
machine: {
  initial: 'awaitingVerification',
  states: {
    awaitingVerification: { emailVerified: 'awaitingLogin' },
    awaitingLogin:        { firstLogin: 'active' },
    active:               { dayThree: 'nudgeSent' },
    nudgeSent:            {},
  },
}
```

### Multiple entry points to the same state

A flow has one trigger. If the same state can be reached from 5 different actions (user click, WebSocket message, timer, other feature, system event), a reducer handles them all in one `switch`. Flows would mean 5 separate flows doing similar things.

```ts
// One reducer handles all entry points
// Object form for own actions:
reduce: {
  userClicked(state) { state.ready = true },
  wsMessage(state) { state.ready = true },
  timerFired(state) { state.ready = true },
}
// Foreign actions use function form with { on }:
// reduce(state, action, { on }) { on(otherFeature.completed, () => { state.ready = true }) }
```

### Summary

| Problem shape | Best tool |
|---|---|
| Sequential: do A, then B, then C | `generators` |
| Reactive: when X happens, do Y | `reduce` |
| Long-lived: survives server restarts | `machine` + persistence |
| Multi-entry: same state from many sources | `reduce` |
| Mix of both | `reduce` + `generators` in same feature |

Flows handle ~95% of async workflows. The remaining cases aren't limitations — they're just problems shaped differently, where reduce/execute is already the simpler answer.

## Internals

### How it works

1. Each `generators` entry creates a `FlowDef` internally — trigger key + generator function
2. `feature()` validates generator keys match declared actions (or auto-creates them in methods features)
3. `composeFeatures()` wires flow triggers into the reducer — when a trigger action is dispatched, the reducer emits an internal `__flow` effect
4. The root executor catches `__flow` effects and calls `runFlow()` asynchronously
5. `runFlow()` creates a `GenCtx`, instantiates the generator, and advances it step by step
6. At each yield, the runner dispatches actions and executes work
7. State mutations use `produce()` (Immer) and dispatch internal `__FlowState` actions
8. The root reducer handles `__FlowState` by replacing the feature's state slice

### Action naming convention

Flow actions follow the pattern: `{featureName}:flow:{stepName}`

- `featureName` — lowercase feature name (`checkout`, `wallet`)
- `flow:` — fixed namespace separator
- `stepName` — camelCase version of the name you pass to `ctx.call/mutate/sleep`
- `done` / `failed` / `error` — terminal action names

### Internal actions

| Action | Purpose | Visible in time-travel? |
|---|---|---|
| `{feature}:flow:{name}` | Step marker | Yes |
| `{feature}:flow:done` | Flow completed | Yes |
| `{feature}:flow:failed` | `ctx.fail()` called | Yes |
| `{feature}:flow:error` | Unhandled exception | Yes |
| `{feature}:flow:waitFor` | Waiting for external action | Yes |
| `{feature}:__flowState` | State mutation delivery | No (hidden — internal only, never appears in time-travel) |
| `{feature}:__flow` | Flow trigger effect | No (hidden — internal only, never appears in time-travel) |

### Cancellation internals

Active flows are tracked in a global `Map<string, FlowInstance>`. Each instance has an `aborted` flag. When cancelled:

1. `aborted` is set to `true`
2. `generator.return(undefined)` is called (cleans up any pending state in the generator)
3. The instance is removed from the active flows map
4. The runner's `while` loop checks `aborted` before each step and exits

Re-triggering the same flow cancels the previous instance before starting a new one. Feature disable/destroy cancels all flows for that feature.

## Types

```ts
import type { GenCtx, Gen, TypedCreator } from 'aio'

// GenCtx<S> — the context object passed to your generator
// S is the feature's state shape, inferred automatically inside feature()
type GenCtx<S = Record<string, unknown>> = {
  call: <T>(name: string, fn: () => T | Promise<T>) => Gen<Awaited<T>>
  mutate: (name: string, mutate: (draft: S) => void) => Gen<void>
  step: (name: string, mutate: (draft: S) => void) => Gen<void>  // deprecated alias for mutate
  done: (mutate?: (draft: S) => void) => Gen<void>
  fail: (reason: string) => Gen<never>
  dispatch: (action: { type: string; payload?: unknown }) => Gen<void>
  send: (creatorOrType: { type: string } | string, payload?: unknown) => Gen<void>
  all: {
    <T extends readonly Gen<unknown>[]>(...gens: T): Gen<{ [K in keyof T]: T[K] extends Gen<infer R> ? R : never }>
    <T extends Record<string, Gen<unknown>>>(entries: T): Gen<{ [K in keyof T]: T[K] extends Gen<infer R> ? R : never }>
  }
  race: <T extends Record<string, Gen<unknown>>>(entries: T) => Gen<{ [K in keyof T]?: T[K] extends Gen<infer R> ? R : never }>
  sleep: (name: string, ms: number) => Gen<void>
  waitFor: {
    <P>(creator: TypedCreator<P>, timeout?: number): Gen<{ type: string; payload: P }>
    (creatorOrType: { type: string } | string, timeout?: number): Gen<Msg>
  }
  getState: () => S
}

// Gen<T> — return type for generator functions
type Gen<T = void> = Generator<FlowStep, T, unknown>
```

Use `Gen<T>` as the return type when writing reusable generator functions:

```ts
// Standalone reusable generator — annotate state type explicitly
function* fetchWithRetry(ctx: GenCtx<{ result: unknown }>, url: string): Gen<unknown> {
  // ...
}

// Inside feature() — S is inferred from state:, no annotation needed
const fetcher = feature('fetcher', {
  state: { result: null },
  generators: {
    *start(ctx) {
      // ctx is GenCtx<{ result: null }> — typed automatically
    },
  },
})
```
