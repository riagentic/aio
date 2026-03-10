# Building with Generators

Sequential async workflows for aio features. Write top-to-bottom code — each step is observable, cancellable, and appears in time-travel.

For the core feature API, see [manual.md](manual.md). For getting started, see [quickstart.md](quickstart.md).

## Why generators

The standard reduce/execute pattern is **reactive** — great for "when X happens, do Y." But multi-step workflows get scattered:

```
action → reducer case → effect → executor case → action → reducer case → ...
```

The actual sequence is invisible. You reconstruct it by tracing across files.

Generators let you write the **same logic sequentially**:

```ts
function* checkout(ctx, action) {
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
| Reducer switch cases | 0 | `ctx.step()` mutates directly |
| Executor switch cases | 0 | `ctx.call()` runs inline |

### What the framework does at each yield

```
yield* ctx.call('fetchPrice', fn)
         │
         ├─ 1. dispatch({ type: 'Checkout:Flow:FetchPrice' })    ← time-travel visible
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

This is standard JavaScript (ES2015+). Works everywhere — Deno, Node, browsers.

## Complete example

```ts
import { feature, flow } from 'aio'

const checkout = feature('checkout', {
  state: {
    price: 0,
    orderId: null as string | null,
    error: null as string | null,
  },

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
      yield* ctx.step('setPrice', s => { s.price = price })

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
    }),
  },
})
```

**Auto-generated from this flow:**

Actions dispatched (visible in time-travel):
- `Checkout:Start` (trigger — from your action)
- `Checkout:Flow:FetchPrice`
- `Checkout:Flow:SetPrice`
- `Checkout:Flow:PlaceOrder`
- `Checkout:Flow:Done` or `Checkout:Flow:Failed`

You never define these. The flow is the source of truth.

## FlowCtx API

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

### `ctx.step(name, mutate)` — state mutation

Updates the feature's state slice via Immer draft. Dispatches a named action.

```ts
yield* ctx.step('updateBalance', s => {
  s.balance += amount
  s.lastUpdated = Date.now()
})

yield* ctx.step('addItem', s => {
  (s.items as string[]).push(newItem)
})
```

The mutation is applied immediately. Subsequent `ctx.call` or `ctx.step` calls see the updated state.

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
yield* ctx.step('unreachable', s => { s.x = 1 })
```

The `return` after `ctx.fail()` is for TypeScript — the flow runtime stops the generator regardless.

### `ctx.put(action)` — dispatch action

Dispatches a regular action into the system. Other features' reducers and foreign listeners react to it normally.

```ts
// Dispatch to own feature
yield* ctx.put({ type: 'Checkout:Reset', payload: {} })

// Dispatch to another feature (cross-feature)
yield* ctx.put(wallet.A.credit(100))

// Use the feature's own action creators
yield* ctx.put(checkout.A.start('widget'))
```

`ctx.put` doesn't wait for the action to be processed. It dispatches and continues.

### `ctx.all(...generators)` — parallel execution

Runs multiple calls in parallel, waits for all to complete. Returns results as an array.

```ts
const [user, orders, prefs] = yield* ctx.all(
  ctx.call('loadUser', () => fetchUser(id)),
  ctx.call('loadOrders', () => fetchOrders(id)),
  ctx.call('loadPrefs', () => fetchPrefs(id)),
)

// All three fetches run concurrently
// Each dispatches its own action for time-travel visibility
yield* ctx.step('loaded', s => {
  s.user = user
  s.orders = orders
  s.prefs = prefs
})
```

If any call throws, the flow errors.

### `ctx.race(entries)` — first wins

Runs multiple calls, returns when the first one resolves. The result has only the winner's key set.

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
      idle: { on: { deposit: 'idle', withdraw: 'idle', sync: 'syncing' } },
      syncing: { on: {} },
    },
  },

  // Reactive — instant state updates, no async
  reduce(state, action, { A }) {
    switch (action.type) {
      case A.Deposit:
        state.balance += (action.payload as { amount: number }).amount
        break
      case A.Withdraw:
        state.balance -= (action.payload as { amount: number }).amount
        break
    }
  },

  // Sequential — the sync workflow
  flows: {
    sync: flow('sync', function* (ctx) {
      yield* ctx.step('start', s => { s.syncing = true })

      const remote = yield* ctx.call('fetchRemote', () =>
        fetch('/api/balance').then(r => r.json())
      ) as { balance: number }

      yield* ctx.done(s => {
        s.balance = remote.balance
        s.syncing = false
        s.lastSync = new Date().toISOString()
      })
    }),
  },
})
```

| Use case | Pattern |
|---|---|
| Instant state update (deposit, withdraw, toggle) | `reduce` |
| React to other features' actions | `reduce` + foreign listeners |
| Multi-step async sequence | `flow()` |
| Request/response with retries | `bridge()` |

## Flow-only features

If your feature is entirely sequential, skip `reduce`, `effects`, and `machine`:

```ts
const importer = feature('importer', {
  state: { records: 0, status: 'idle' as 'idle' | 'running' | 'done' | 'error' },
  actions: {
    start: (file: string) => ({ file }),
  },
  flows: {
    import: flow('start', function* (ctx, action) {
      const { file } = action.payload as { file: string }

      yield* ctx.step('begin', s => { s.status = 'running' })

      const raw = yield* ctx.call('readFile', () => Deno.readTextFile(file))
      const rows = yield* ctx.call('parse', () => JSON.parse(raw as string))

      for (const row of rows as unknown[]) {
        yield* ctx.call('insert', () => db.insert(row))
      }

      yield* ctx.done(s => {
        s.records = (rows as unknown[]).length
        s.status = 'done'
      })
    }),
  },
})
```

No reducer. No effect catalog. No executor. The flow handles everything.

## Patterns

### Error handling

Errors in `ctx.call` automatically stop the flow and dispatch `{Feature}:Flow:Error`. For custom error handling, use try/catch:

```ts
function* syncFlow(ctx: FlowCtx) {
  try {
    const data = yield* ctx.call('fetch', () => fetchData())
    yield* ctx.done(s => { s.data = data })
  } catch {
    yield* ctx.step('setError', s => { s.error = 'sync failed' })
    yield* ctx.fail('sync failed')
  }
}
```

### Retry with backoff

```ts
function* resilientFetch(ctx: FlowCtx, url: string, maxRetries = 3) {
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
  flows: {
    fetch: flow('start', function* (ctx, action) {
      const { url } = action.payload as { url: string }
      const data = yield* resilientFetch(ctx, url)
      if (data) yield* ctx.done(s => { s.data = data })
    }),
  },
})
```

Reusable generator functions work as composable building blocks. Extract common patterns (retry, polling, pagination) into shared generators.

### Polling

```ts
flows: {
  monitor: flow('startMonitor', function* (ctx) {
    while (true) {
      const status = yield* ctx.call('check', () =>
        fetch('/api/health').then(r => r.json())
      ) as { healthy: boolean }

      yield* ctx.step('update', s => {
        s.lastCheck = Date.now()
        s.healthy = status.healthy
      })

      if (!status.healthy) {
        yield* ctx.put(alerts.A.trigger('System unhealthy'))
      }

      yield* ctx.sleep('interval', 30_000) // check every 30s
    }
    // This flow runs indefinitely until cancelled
    // (by feature disable, new trigger, or app shutdown)
  }),
}
```

### Pagination

```ts
flows: {
  loadAll: flow('start', function* (ctx) {
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

      // Update state progressively
      yield* ctx.step(`loaded-${page}`, s => {
        s.items = allItems
        s.loadedPages = page - 1
      })
    }

    yield* ctx.done(s => { s.loading = false })
  }),
}
```

### Conditional branching

```ts
flows: {
  onboard: flow('start', function* (ctx, action) {
    const { userId } = action.payload as { userId: string }

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
  }),
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
  crossDispatch: ['inventory', 'billing', 'notifications'],
  flows: {
    place: flow('placeOrder', function* (ctx, action) {
      const { item, qty } = action.payload as { item: string; qty: number }

      // Reserve stock (dispatch to inventory feature)
      yield* ctx.put(inventory.A.reserve(item, qty))

      // Charge payment
      const charge = yield* ctx.call('charge', () =>
        stripe.charge({ item, qty })
      )

      // Create order record
      const order = yield* ctx.call('createOrder', () =>
        db.orders.insert({ item, qty, chargeId: (charge as { id: string }).id })
      )

      // Notify user
      yield* ctx.put(notifications.A.send('Order confirmed!'))

      yield* ctx.done(s => {
        s.orderId = (order as { id: string }).id
      })
    }),
  },
})
```

`ctx.put` dispatches to other features. Declare them in `crossDispatch` for the scoped dispatch guard.

## Cancellation

### Automatic re-trigger cancellation

If a flow is triggered while a previous instance is still running, the old one is **automatically cancelled**:

```ts
// User clicks "sync" rapidly
dispatch(sync.A.start())  // flow starts
dispatch(sync.A.start())  // old flow cancelled, new one starts
dispatch(sync.A.start())  // old flow cancelled, new one starts
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
yield* ctx.step('validate', fn)
yield* ctx.call('placeOrder', fn)
yield* ctx.done(fn)
```

The framework dispatches these actions (visible in time-travel and devtools):

| Action dispatched | When |
|---|---|
| `Checkout:Start` | Trigger action (you defined this) |
| `Checkout:Flow:FetchPrice` | Before executing the fetch |
| `Checkout:Flow:Validate` | Before applying state mutation |
| `Checkout:Flow:PlaceOrder` | Before executing the order |
| `Checkout:Flow:Done` | Flow completed successfully |

On failure:
| `Checkout:Flow:Failed` | `ctx.fail()` called |
| `Checkout:Flow:Error` | Unhandled exception in flow |

All actions have `_source: 'Effect'` and include `_flow` and `_step` metadata in the payload.

### Foreign listeners

Other features can react to flow actions. They're regular actions:

```ts
const analytics = feature('analytics', {
  // ...
  machine: {
    initial: 'ready',
    states: {
      ready: { on: {
        'Checkout:Flow:Done': 'ready',        // listen to flow completion
        'Checkout:Flow:Failed': 'ready',      // listen to flow failure
      }},
    },
  },
  reduce(state, action, { A }) {
    if (action.type === 'Checkout:Flow:Done') {
      state.checkouts += 1
    }
  },
})
```

## Testing flows

Flows run in the same compose/dispatch system. Test them like any feature:

```ts
import { feature, flow, composeFeatures } from 'aio'

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
  app.dispatch(checkout.A.start('widget'))
  await app.flush()

  const s = app.getState().checkout
  assertEquals(s.orderId, 'abc-123')
  assertEquals(s.price, 42)

  // Verify steps were dispatched
  const types = app.dispatched.map(d => d.type)
  assert(types.includes('Checkout:Flow:FetchPrice'))
  assert(types.includes('Checkout:Flow:Done'))
})

Deno.test('checkout flow: too expensive', async () => {
  // Mock the fetch to return high price
  const app = testApp([checkout])
  app.dispatch(checkout.A.start('expensive-item'))
  await app.flush()

  const types = app.dispatched.map(d => d.type)
  assert(types.includes('Checkout:Flow:Failed'))

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
    step: function* (name, mutate) { yield { kind: 'step', name, mutate } },
    done: function* (mutate) { yield { kind: 'done', mutate } },
    fail: function* (reason) { yield { kind: 'fail', reason }; throw new Error(reason) },
    put: function* (action) { yield { kind: 'put', action } },
    all: function* (...gens) { return yield { kind: 'all', entries: [] } },
    race: function* (entries) { return yield { kind: 'race', entries: {} } },
    sleep: function* (name, ms) { yield { kind: 'sleep', name, ms } },
  }

  const action = { type: 'Checkout:Start', payload: { item: 'widget' } }
  const gen = checkoutFlow.generator(ctx, action)

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
      idle:       { on: { start: 'fetching' } },
      fetching:   { on: { priceLoaded: 'confirming', failed: 'idle' } },
      confirming: { on: { confirmed: 'done', failed: 'idle' } },
      done:       { on: { retry: 'idle' } },
    },
  },
  reduce(state, action, { A, E }) { /* 5 switch cases */ },
  execute(app, effect, { E, A }) { /* 2 switch cases */ },
})
```

### Flow (generator)

```ts
// 1 action, 0 effects, sequence is the code
const checkout = feature('checkout', {
  actions: { start: (item: string) => ({ item }) },
  flows: {
    checkout: flow('start', function* (ctx, action) {
      const price = yield* ctx.call('fetchPrice', () => fetchPrice(item))
      if (price > 1000) { yield* ctx.fail('too expensive'); return }
      yield* ctx.step('setPrice', s => { s.price = price })
      const order = yield* ctx.call('placeOrder', () => placeOrder(price))
      yield* ctx.done(s => { s.orderId = order.id })
    }),
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
reduce(state, action, { A }) {
  case dc.A.PriceUpdated:
    state.total = recalc(state)     // reacts to price changes from anywhere
  case A.TaxRateChanged:
    state.tax = state.total * rate  // reacts to tax rate changes from anywhere
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
    awaitingVerification: { on: { emailVerified: 'awaitingLogin' } },
    awaitingLogin:        { on: { firstLogin: 'active' } },
    active:               { on: { dayThree: 'nudgeSent' } },
    nudgeSent:            {},
  },
}
```

### Multiple entry points to the same state

A flow has one trigger. If the same state can be reached from 5 different actions (user click, WebSocket message, timer, other feature, system event), a reducer handles them all in one `switch`. Flows would mean 5 separate flows doing similar things.

```ts
// One reducer handles all entry points
reduce(state, action, { A }) {
  case A.UserClicked:
  case A.WsMessage:
  case A.TimerFired:
  case otherFeature.A.Completed:
    state.ready = true   // same logic, any source
}
```

### Summary

| Problem shape | Best tool |
|---|---|
| Sequential: do A, then B, then C | `flow()` |
| Reactive: when X happens, do Y | `reduce` |
| Long-lived: survives server restarts | `machine` + persistence |
| Multi-entry: same state from many sources | `reduce` |
| Mix of both | `reduce` + `flow()` in same feature |

Flows handle ~95% of async workflows. The remaining cases aren't limitations — they're just problems shaped differently, where reduce/execute is already the simpler answer.

## Internals

### How it works

1. `flow('start', fn)` creates a `FlowDef` — a trigger action key + generator function
2. `feature()` validates the trigger exists in `actions` and stores the flow definition
3. `composeFeatures()` wires flow triggers into the reducer — when a trigger action is dispatched, the reducer emits an internal `__flow` effect
4. The root executor catches `__flow` effects and calls `runFlow()` asynchronously
5. `runFlow()` creates a `FlowCtx`, instantiates the generator, and advances it step by step
6. At each yield, the runner dispatches actions and executes work
7. State mutations use `produce()` (Immer) and dispatch internal `__FlowState` actions
8. The root reducer handles `__FlowState` by replacing the feature's state slice

### Action naming convention

Flow actions follow the pattern: `{Prefix}:Flow:{StepName}`

- `Prefix` — PascalCase feature name (`Checkout`, `Wallet`)
- `Flow:` — fixed namespace separator
- `StepName` — PascalCase version of the name you pass to `ctx.call/step/sleep`
- `Done` / `Failed` / `Error` — terminal action names

### Internal actions

| Action | Purpose | Visible in time-travel? |
|---|---|---|
| `{Prefix}:Flow:{Name}` | Step marker | Yes |
| `{Prefix}:Flow:Done` | Flow completed | Yes |
| `{Prefix}:Flow:Failed` | `ctx.fail()` called | Yes |
| `{Prefix}:Flow:Error` | Unhandled exception | Yes |
| `{Prefix}:__FlowState` | State mutation delivery | No (internal) |
| `{Prefix}:__flow` | Flow trigger effect | No (internal) |

### Cancellation internals

Active flows are tracked in a global `Map<string, FlowInstance>`. Each instance has an `aborted` flag. When cancelled:

1. `aborted` is set to `true`
2. `generator.return(undefined)` is called (cleans up any pending state in the generator)
3. The instance is removed from the active flows map
4. The runner's `while` loop checks `aborted` before each step and exits

Re-triggering the same flow cancels the previous instance before starting a new one. Feature disable/destroy cancels all flows for that feature.

## Types

```ts
import type { FlowCtx, FlowDef, Gen } from 'aio'

// FlowCtx — the context object passed to your generator
type FlowCtx = {
  call: <T>(name: string, fn: () => T | Promise<T>) => Gen<Awaited<T>>
  step: (name: string, mutate: (draft: Record<string, unknown>) => void) => Gen<void>
  done: (mutate?: (draft: Record<string, unknown>) => void) => Gen<void>
  fail: (reason: string) => Gen<never>
  put: (action: { type: string; payload: unknown }) => Gen<void>
  all: <T extends readonly Gen<unknown>[]>(...gens: T) => Gen<{ [K in keyof T]: T[K] extends Gen<infer R> ? R : never }>
  race: <T extends Record<string, Gen<unknown>>>(entries: T) => Gen<{ [K in keyof T]?: T[K] extends Gen<infer R> ? R : never }>
  sleep: (name: string, ms: number) => Gen<void>
}

// Gen<T> — return type for generator functions
type Gen<T = void> = Generator<FlowStep, T, unknown>

// FlowDef — returned by flow(), consumed by feature()
type FlowDef = {
  trigger: string
  generator: (ctx: FlowCtx, action: Msg) => Gen<unknown>
}
```

Use `Gen<T>` as the return type when writing reusable generator functions:

```ts
function* fetchWithRetry(ctx: FlowCtx, url: string): Gen<unknown> {
  // ...reusable generator logic
}
```
