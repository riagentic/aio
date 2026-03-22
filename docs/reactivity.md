# Method-Based Features (`feature({ methods })`)

The default way to build aio features. No action catalogs, no effect catalogs, no switch/case, no executors. Just methods that mutate state.

---

## Quick example

```typescript
import { feature, aio } from 'aio'

const todo = feature('todo', {
  state: {
    items: [] as { text: string; done: boolean }[],
    filter: 'all' as 'all' | 'active' | 'done',
  },
  methods: {
    add(s, text: string) {
      s.items.push({ text, done: false })
    },
    toggle(s, idx: number) {
      s.items[idx].done = !s.items[idx].done
    },
    remove(s, idx: number) {
      s.items.splice(idx, 1)
    },
    setFilter(s, filter: 'all' | 'active' | 'done') {
      s.filter = filter
    },
    async sync(s) {
      await fetch('/api/todos', {
        method: 'POST',
        body: JSON.stringify(s.items),
      })
    },
  },
  selectors: {
    filtered: (s) => s.filter === 'all' ? s.items
      : s.items.filter(i => s.filter === 'done' ? i.done : !i.done),
    remaining: (s) => s.items.filter(i => !i.done).length,
  },
})

await aio.run({ features: [todo] })

// After boot — methods dispatch, selectors read state
todo.add('buy milk')
todo.toggle(0)
const count = todo.remaining()   // → 0
```

That's a complete feature. State persists across restarts, syncs to all connected clients in real-time, every mutation appears in time-travel.

After `aio.run()`, call methods and selectors directly on the feature — no `dispatch()`, no passing state. The framework binds everything automatically.

---

## How sync methods work

Sync methods receive mutable state (Immer draft). Mutate in place:

```typescript
methods: {
  increment(s, by = 1) {
    s.count += by      // direct mutation — Immer tracks it
  },
  addItems(s, items: Item[]) {
    s.items.push(...items)   // array mutations work
    s.total = s.items.reduce((sum, i) => sum + i.price, 0)  // computed update
  },
}
```

**All mutations within one method call = one atomic action.** The method name becomes the action type: `increment` → `counter:increment`. One entry in time-travel, one persistence write, one sync broadcast.

### What you can do in sync methods

- Mutate any property: `s.count = 5`
- Mutate nested objects: `s.user.settings.theme = 'dark'`
- Array methods: `s.items.push()`, `s.items.splice()`, `s.items.sort()`
- Delete properties: `delete s.temp`
- Anything Immer supports

### Returning schedule effects

Sync methods can return schedule effects to set up timers, intervals, or other scheduled work:

```typescript
methods: {
  startPolling(s) {
    s.polling = true
    return { _schedule: true, key: 'poll', type: 'prices:refresh', intervalMs: 30_000 }
  },
  stopPolling(s) {
    s.polling = false
    return { _schedule: true, key: 'poll', cancel: true }
  },
}
```

Return a single `ScheduleEffect` or an array of them. The framework routes them through the same schedule pipeline as `feature()` effects.

### What you cannot do in sync methods

- Async operations (`await`) — use an async method instead
- Access other features' state — use selectors from those features

---

## Scheduling from methods

Returning a `ScheduleEffect` from a sync method is the only way to set up timers from within a feature. Async methods run as effects — return the schedule from the sync method that triggers them.

```typescript
import { feature, schedule } from 'aio'

const poller = feature('poller', {
  state: { data: null as unknown },
  methods: {
    // Sync method can return a schedule effect
    startPolling(s) {
      s.active = true
      return schedule.every('poll', 30_000, poller.refresh)  // ← return to schedule
    },
    stopPolling(s) {
      s.active = false
      return schedule.cancel('poll')
    },
    async refresh(s) {
      const data = await fetch('/api/data').then(r => r.json())
      s.data = data
    },
  },
})
```

`schedule.every(key, intervalMs, action)` returns a `ScheduleEffect` — the framework routes it through the same pipeline as effects returned from `execute`. `schedule.cancel(key)` cancels a running interval.

---

## How async methods work

Async methods receive a **live Proxy** and a **context object**. This is the key difference:

```typescript
methods: {
  // Sync: (state, ...args)
  add(s, text: string) {
    s.items.push({ text, done: false })
  },

  // Async: (state, ...args) — same signature, live Proxy
  async checkout(s) {
    s.status = 'loading'                       // ① dispatches action immediately
    const order = await placeOrder(s.items)    // ② s.items reads CURRENT state
    s.orderId = order.id                       // ③ dispatches action after await
    s.status = 'done'                          // ④ dispatches action after await
  },
}
```

| Step | What happens | Action dispatched |
|---|---|---|
| Trigger | `send.checkout()` dispatched | `checkout:checkout` |
| ①②③④ | Proxy set traps fire, batched via microtask | `checkout:__setCheckout` `{mutations:[...]}` |
| await | New microtask frame — previous batch flushed | |
| after | Proxy writes in new sync frame | `checkout:__setCheckout` (second batch) |

**Writes are batched** — consecutive property assignments in the same sync frame produce one action. Each `await` boundary starts a new batch. Persisted, synced, time-traveled.

**Method-tagged actions** — async writes dispatch `__SetMethodName` actions (e.g., `__SetCheckout`), not a generic `__set`. This enables machine guards: if `checkout` is allowed in a state, its `__setCheckout` writes are also allowed (auto-injected self-loop in the target state).

**Every read = fresh state** from the store. If another action changed state during your `await`, you see the current value, not a stale copy.

### Nested writes

Deep property assignments work:

```typescript
async updateProfile(s) {
  const profile = await fetchProfile()
  s.user.name = profile.name               // batched into one __SetUpdateProfile action
  s.user.settings.theme = profile.theme     // same batch (same sync frame)
}
```

### Array mutations in async

Instrumented array methods are intercepted by the Proxy:

```typescript
async loadItems(s) {
  const items = await fetchItems()
  s.items.push(...items)     // batched mutation {path:['items'], op:'push', args:[...]}
  s.items.sort((a, b) => a.name.localeCompare(b.name))
}
```

Supported array mutators: `push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`, `copyWithin`.

### Error handling

If an async method throws, the error is caught and logged. State mutations before the error are already dispatched (they went through the dispatch loop individually):

```typescript
async riskyOp(s) {
  s.status = 'processing'    // dispatched ✅
  await mightFail()          // throws! 💥
  s.status = 'done'          // never reached
}
// Result: status is 'processing', error logged to console
```

When an async method throws, the framework dispatches a `{Prefix}:__error` action with `{ _method, error }` payload. This action is catchable by middleware and observable by foreign listeners, but is **hidden from time-travel history** (internal bookkeeping action). For machine features, `__error` is auto-injected as a self-loop in all states (error doesn't change machine state).

If you need cleanup on failure, use try/catch:

```typescript
async riskyOp(s) {
  s.status = 'processing'
  try {
    await mightFail()
    s.status = 'done'
  } catch (e) {
    s.status = 'error'
    s.error = String(e)
  }
}
```

---

## Selectors

Derived values from feature state:

```typescript
const cart = feature('cart', {
  state: { items: [] as { price: number; qty: number }[] },
  methods: { ... },
  selectors: {
    total: (s) => s.items.reduce((sum, i) => sum + i.price * i.qty, 0),
    itemCount: (s) => s.items.length,
    isEmpty: (s) => s.items.length === 0,
  },
})

// After aio.run() — call directly, no state argument needed:
const total = cart.total()
const empty = cart.isEmpty()

// Before boot or from other features — pass state explicitly:
const total = cart.__aio.selectors.total(app.getState())
```

Selectors are scoped to the feature's state slice automatically. After `aio.run()` binds the feature, selectors read current state implicitly.

---

## Direct calling

After `aio.run()`, methods and selectors are callable directly on the feature object:

```typescript
const counter = feature('counter', {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) { s.count += by },
    reset(s) { s.count = 0 },
  },
  selectors: {
    doubled: (s) => s.count * 2,
  },
})

await aio.run({ features: [counter] })

// Methods dispatch actions automatically
counter.increment(5)
counter.reset()

// Selectors read current state automatically
counter.doubled()    // → 0

// Every bound method has .type — use it instead of raw strings
counter.increment.type   // → 'counter:increment'
counter.reset.type       // → 'counter:reset'

// Before boot, calling a method returns an action object without dispatching
// After boot, calling a method dispatches automatically
```

Before boot, calling a method returns an action object without dispatching. After boot, calling a method dispatches automatically. `.type` is always available on bound methods.

This works for all three tiers — `feature({ methods })`, `feature({ reduce })`, and `feature({ generators })`.

---

## State machines

Reactive features support machines. Methods are gated by transitions — if a method call isn't allowed in the current state, it's silently dropped:

```typescript
const upload = feature('upload', {
  state: { progress: 0, error: null as string | null },
  machine: {
    initial: 'idle',
    states: {
      idle:      { start: 'uploading' },
      uploading: { complete: 'idle', fail: 'error' },
      error:     { retry: 'uploading', dismiss: 'idle' },
    },
  },
  methods: {
    async start(s) {
      const file = await pickFile()
      await uploadFile(file, (pct) => { s.progress = pct })
      // Note: after await, this dispatches __set which doesn't match machine transitions
      // For machine-gated async, use complete() as a separate method
    },
    complete(s) { s.progress = 100 },
    fail(s, err: string) { s.error = err },
    retry(s) { s.progress = 0; s.error = null },
    dismiss(s) { s.error = null; s.progress = 0 },
  },
})
```

**Machine-gated writes**: Async Proxy writes dispatch method-tagged `__setMethodName` actions (e.g., `__setStart`). The framework auto-injects self-loop transitions in the target state — so if `start` transitions `idle→uploading`, then `__setStart` writes are allowed in the `uploading` state. If the method can't be triggered in the current state, neither can its writes.

For complex async workflows with strict per-step state machine control, use the `generators` key instead — each `yield*` checkpoint is a named action visible in time-travel.

---

## UI integration

```tsx
import { useFeature } from 'aio'
import { todo } from '../features/todo'

function TodoPage() {
  const { state, send, status } = useFeature(todo)
  if (!state) return <div>Loading...</div>

  return (
    <div>
      <ul>
        {state.items.map((item, i) => (
          <li key={i} onClick={() => send.toggle(i)}>
            {item.done ? '✓' : '○'} {item.text}
          </li>
        ))}
      </ul>
      <button onClick={() => send.add('New item')}>Add</button>
      <button onClick={() => send.sync()}>Sync</button>
    </div>
  )
}
```

`useFeature()` works for all feature styles.

---

## Testing

`testFeature()` works for both sync and async methods:

```typescript
import { testFeature } from 'aio'
import { counter } from './features/counter'

// Sync — same as before
testFeature(counter, 'increment by 5', (t) => {
  t.init()
  t.send.increment(5)
  t.expect.state(s => s.count === 5)
})

// Async — use runEffects + settle
testFeature(loader, 'fetch data', async (t) => {
  t.init()
  t.send.load()          // triggers reducer
  t.runEffects()         // runs executor (starts async method)
  await t.settle()       // wait for async to complete
  t.expect.state(s => s.data === 'loaded')
})
```

`t.runEffects()` executes pending effects (required for async reactive methods). `t.settle(ms?)` waits for async operations to complete (defaults to 50ms).

---

## Cross-feature communication

### Direct cross-feature calling

After `aio.run()`, all bound methods return Promises. Async methods return `Promise<T>` (the method's return value), sync methods return `Promise<void>` (resolves after reduce + effects). Import any feature and `await` its methods directly — no strings, no special syntax:

```typescript
// features/orders/index.ts
import { inventory } from '../inventory'
import { pricing } from '../pricing'

export const orders = feature('orders', {
  state: { orderId: null as string | null, total: 0 },
  methods: {
    async placeOrder(s, items: Item[]) {
      const reserved = await inventory.reserve(items)  // Promise<ReserveResult> — typed
      const price = await pricing.calculate(reserved)  // Promise<PriceResult> — typed
      s.orderId = reserved.orderId
      s.total = price.total
    },
  },
})
```

Each call dispatches a real action through the store (`Inventory:Reserve`) — fully observable in time-travel, interceptable by middleware. TypeScript infers the return type from the method signature — no cast needed.

**Calling own methods** works the same way via self-import (after `aio.run()` it's bound):

```typescript
import { orders } from './index'  // self-import

// Inside another method:
async checkout(s, cart: Cart) {
  await orders.validateCart(cart)   // dispatches Orders:ValidateCart through the store
  s.status = 'confirmed'
}
```

> **Self-imports are safe.** Importing your own feature file (`import { orders } from './index'`)
> looks circular but works correctly in Deno and Node — the module is fully initialized before
> any method is called. This is the intended pattern for calling your own feature's methods.

**With timeout/retry** — use the `call()` callback form when needed:

```typescript
import { call } from 'aio'

async placeOrder(s, items: Item[]) {
  const reserved = await call({ timeout: 5000, retries: 2 }, () => inventory.reserve(items))
  s.orderId = reserved.orderId
}
```

For timeout/retry, wrap the direct call:
```typescript
const reserved = await call({ timeout: 5000 }, () => inventory.reserve(items))
```

### Dispatch behavior by caller context

When a bound method calls another feature's method, the behavior depends on **where** the call happens. The dispatch loop is re-entrant-safe — if `dispatching=true` (inside a reducer), actions are queued. If `dispatching=false` (executor, effect, external), actions are processed immediately.

| Caller | Callee | Call style | Dispatching | Behavior |
|---|---|---|---|---|
| **Sync method** (reducer) | Sync | `other.reset()` | `true` | Queued, processed after current reduce finishes. Can't `await` (sync function). |
| **Sync method** (reducer) | Async | `other.fetch()` | `true` | Queued. Can't `await` (sync function). |
| **Async method** (executor) | Sync | `other.reset()` | `false` | Processed **immediately**. State updated after call. |
| **Async method** (executor) | Sync | `await other.reset()` | `false` | Works correctly. Resumes with state updated. |
| **Async method** (executor) | Async | `await other.fetch()` | `false` | Works. Full async pipeline. |
| **Effect handler** | Any | `other.method()` | `false` | Immediate. Can `await` if handler is async. |
| **External** (UI/test) | Sync | `counter.increment(5)` | `false` | Fire-and-forget. Promise ignored. |
| **External** (UI/test) | Any | `await counter.method()` | `false` | Works correctly. |

**Key insight:** Async methods run in the **executor**, not the reducer. By the time the method body executes, the dispatch loop has finished (`dispatching=false`). So cross-feature calls from async methods start a **new, independent dispatch cycle** — not a nested one.

Every cross-feature call dispatches a **real action** through the store — observable in time-travel, interceptable by middleware, triggers `listensTo` listeners. Nothing is lost compared to explicit dispatch.

### `listensTo` — foreign listeners without a machine

The simplest way to listen to other features' actions:

```typescript
import { cart } from '../cart'

const analytics = feature('analytics', {
  state: { events: [] as string[] },
  // Pass bound methods directly — refactor-safe, no raw strings
  listensTo: [cart.addItem, cart.clear],
  methods: {
    track(s, event: string) { s.events.push(event) },
  },
})
```

`listensTo` accepts bound methods only — pass the function reference directly for autocomplete and refactor safety.

`listensTo` auto-generates a minimal machine with self-loop transitions. The framework routes those actions to your reducer — combine with foreign action handling in your reduce logic or use it to gate method calls.

This is equivalent to writing a full machine with `{ active: { [cart.addItem.type]: 'active', ... } }` but without the boilerplate.

**Note:** `listensTo` is ignored if you provide an explicit `machine` — use the machine's `on` transitions instead.

### Full machine (manual)

For features that need machine states alongside foreign listeners:

```typescript
const cart = feature('cart', {
  state: { items: [] as string[] },
  methods: {
    addItem(s, item: string) { s.items.push(item) },
    clear(s) { s.items = [] },
  },
})

// event-driven feature reacting to cart actions
const analytics = feature('analytics', {
  state: { events: [] as string[] },
  actions: { noop: () => ({}) },
  machine: {
    initial: 'active',
    states: {
      active: { noop: 'active', [cart.addItem.type]: 'active', [cart.clear.type]: 'active' },
    },
  },
  // Object-form reduce — computed keys for foreign actions, no raw strings needed
  reduce: {
    noop() {},
    [cart.addItem.type](state) { state.events.push('item_added') },
    [cart.clear.type](state) { state.events.push('cart_cleared') },
  },
})
```

**Foreign actions in object-form `reduce`:** use a computed key `[feature.action.type]` — it evaluates to the full `'featureName:actionKey'` string at definition time. No raw strings, full refactor safety.

`listensTo` declares which foreign actions the machine allows through. The `reduce` object handles them. Both work together — `listensTo` for the guard, computed keys for the handler.

Selectors and bridges work the same way as with `feature()`.

---

## Composing and mixing styles

All feature styles compose freely — both across features in `aio.run()` and within a single feature. Methods, generators, and actions/effects can coexist in one feature. All callable names must be unique within the feature (validated at creation time).

```typescript
import { aio } from 'aio'
import { settings } from './features/settings'    // feature({ methods })
import { checkout } from './features/checkout'    // feature({ methods, generators })
import { analytics } from './features/analytics'  // feature({ methods, actions, reduce })

await aio.run({
  features: [settings, checkout, analytics],
})
```

### When to use which

| Start with | Upgrade to | When |
|---|---|---|
| `feature({ methods })` | — | Most features never need more |
| `feature({ methods })` | + `generators` | Multi-step workflows, auto-cancellation, step observability |
| `feature({ methods })` | + `actions/reduce` | Complex reactive logic, multiple entry points, strict machine control |

**Rule: start with methods. Add generators or actions when you feel the pain, not before.**

---

## Inter-feature coordination

Async methods call other features by direct import — no strings needed:

```typescript
import { api } from '../api'

const app = feature('app', {
  state: { lastSync: null as number | null },
  methods: {
    async sync(s) {
      await api.fetch('/api/data')    // typed, store-observable
      s.lastSync = Date.now()
    },
  },
})
```

Direct calling:
- Dispatches a real action through the store — observable, interceptable, time-travelable
- Returns a typed Promise — no cast needed
- **Rejects immediately** if blocked by machine guard, feature disabled, or method not async

For timeout/retry on top of direct calling:
```ts
import { call } from 'aio'
const count = await call({ timeout: 5000 }, () => inventory.checkStock(item))
```

---

## What feature() generates

Under the hood, `feature({ methods })` creates a standard `FeatureDef` with auto-generated:

- **Actions**: one per method (`cart:addItem`, `cart:clear`) + method-tagged `cart:__setAddItem` for async writes
- **Reducer**: routes actions to method bodies (sync methods run in Immer, async mutations applied via `__setMethod`)
- **Executor**: runs async methods with live Proxy + microtask batcher

The dispatch loop, persistence, sync, time-travel, middleware — all unchanged. `feature({ methods })` is a compiler, not a runtime change.

### Action naming

| Method | Action type |
|---|---|
| `addItem(s, item)` | `cart:addItem` |
| `clear(s)` | `cart:clear` |
| (async `save` writes) | `cart:__setSave` (batched per sync frame) |
| (async method error) | `cart:__error` `{ _method, error }` |

### Microtask batching

Consecutive Proxy writes in the same sync frame are grouped into one action via `queueMicrotask`. An `await` boundary flushes the current batch and starts a new one.

### What appears in time-travel

For sync methods: one action per method call with the method name.

For async methods: only the trigger action (`cart:save`) appears in time-travel. The internal `cart:__setSave` batched write actions are hidden from time-travel history (they are bookkeeping internals, not user-visible events).

---

## Patterns

### Form state

```typescript
const form = feature('form', {
  state: {
    name: '',
    email: '',
    errors: {} as Record<string, string>,
    submitting: false,
  },
  methods: {
    setField(s, field: string, value: string) {
      (s as Record<string, unknown>)[field] = value
      delete s.errors[field]
    },
    async submit(s) {
      s.submitting = true
      s.errors = {}
      try {
        await fetch('/api/submit', {
          method: 'POST',
          body: JSON.stringify({ name: s.name, email: s.email }),
        })
      } catch (e) {
        s.errors = { form: String(e) }
      }
      s.submitting = false
    },
  },
})
```

### Polling

```typescript
const prices = feature('prices', {
  state: { btc: 0, eth: 0, updatedAt: '' },
  methods: {
    async refresh(s) {
      const data = await fetch('/api/prices').then(r => r.json())
      s.btc = data.btc
      s.eth = data.eth
      s.updatedAt = new Date().toISOString()
    },
  },
})
// Trigger with schedule.every(30000) or setInterval
```

### CRUD

```typescript
const users = feature('users', {
  state: {
    list: [] as User[],
    loading: false,
    error: null as string | null,
  },
  methods: {
    async loadAll(s) {
      s.loading = true
      try {
        const data = await fetch('/api/users').then(r => r.json())
        s.list = data
        s.error = null
      } catch (e) {
        s.error = String(e)
      }
      s.loading = false
    },
    async create(s, user: Omit<User, 'id'>) {
      const created = await fetch('/api/users', {
        method: 'POST',
        body: JSON.stringify(user),
      }).then(r => r.json())
      s.list.push(created)
    },
    async remove(s, id: string) {
      await fetch(`/api/users/${id}`, { method: 'DELETE' })
      const idx = s.list.findIndex((u: User) => u.id === id)
      if (idx !== -1) s.list.splice(idx, 1)
    },
  },
  selectors: {
    count: (s) => s.list.length,
    byId: (s) => (id: string) => s.list.find((u: User) => u.id === id),
  },
})
```

---

## Adding sequential workflows — `generators`

When a method needs step-level observability, cancellation, or structured concurrency, add it as a generator instead. The `generators` key lives alongside `methods` in the same feature:

```typescript
const order = feature('order', {
  state: { status: 'idle' as string, orderId: null as string | null },
  methods: {
    cancel(s) { s.status = 'cancelled' },
  },
  generators: {
    *place(ctx) {
      yield* ctx.mutate('processing', s => { s.status = 'processing' })
      const id = yield* ctx.call('submit', () => submitOrder())
      yield* ctx.done(s => { s.orderId = id as string; s.status = 'done' })
    },
  },
})

order.place()   // dispatches Order:Place, runs the generator
order.cancel()  // plain method — still works alongside generators
```

Generators get the full `GenCtx` API: `ctx.call`, `ctx.mutate`, `ctx.done`, `ctx.fail`, `ctx.sleep`, `ctx.waitFor`, `ctx.all`, `ctx.race`. Each yield is a named checkpoint — visible in time-travel, cancellable, step-by-step observable.

**When to upgrade a method to a generator:**
- The async operation has multiple meaningful steps
- You need auto-cancellation on re-trigger (re-calling `order.place()` cancels the running workflow)
- You want structured observability beyond property-level writes

See [generators.md](generators.md) for the full generator API.

---

## Limitations

### Async Proxy writes are machine-gated by method

Async writes dispatch method-tagged `__setMethodName` actions. When a machine is configured, `feature({ methods })` auto-injects `__setMethod` self-loop transitions in the **target** state of each async method's transition. This means writes are allowed as long as the method's transition was valid — but they don't trigger state machine transitions themselves. For strict per-write machine gating, use `feature()` with explicit actions or a generator.

### No structured concurrency

Reactive async methods are fire-and-forget. If you call `send.checkout()` twice, both run concurrently. Use a **state machine** to prevent re-entry:

```typescript
machine: {
  initial: 'idle',
  states: {
    idle: { checkout: 'busy' },
    busy: { done: 'idle' },  // checkout blocked while busy
  },
}
```

For auto-cancellation on re-trigger, use a generator in the `generators` key.

### No step-level observability

Async methods show individual property assignments in time-travel — useful but less structured. Use the `generators` key for named checkpoints per `yield*`.

### Not for long-lived processes

Async methods should complete or fail. They don't survive server restarts. For persistent workflows, use scheduled effects or external job queues.

---

## Comparison

### Feature styles

| | `feature({ methods })` | `feature({ generators })` | `feature({ reduce })` |
|---|---|---|---|
| Boilerplate | Minimal | Minimal | Medium |
| Actions | Auto-generated | Auto-generated | Manual catalog |
| Effects | None needed | None needed | Manual catalog |
| Reducer | None needed | None needed | Required |
| Executor | None needed | None needed | Required (if effects) |
| State machine | Optional | Optional | Optional |
| Async model | Live Proxy | Generators (`yield*`) | Effects + dispatch |
| Cancellation | Manual | Automatic | Manual |
| Step observability | Per-property | Per-yield | Per-action |
| Mixable | Yes — all styles can coexist in one feature | Yes | Yes |
| Best for | 80% of features | Multi-step workflows | Complex reactive logic |

### Async methods vs generators

Both generate real actions for cross-feature calls. The key differences are in coordination and lifecycle:

| Capability | Async methods | Generators |
|---|---|---|
| Cross-feature calls | `await other.method()` | `yield* ctx.call('name', fn)` |
| State mutation | Proxy (`s.x = 1`) | `yield* ctx.mutate('name', fn)` |
| Wait for external event | Not possible | `yield* ctx.waitFor(action)` |
| Cancellation | Manual (AbortController) | Automatic (`cancelOn`, re-trigger, feature disable) |
| Parallel execution | `Promise.all(...)` | `yield* ctx.all(...)` |
| Race | `Promise.race(...)` | `yield* ctx.race(...)` |
| Named checkpoints | No (batched `__set` actions) | Yes (every `yield*` visible in time-travel) |
| Observable sleep | `await delay(ms)` (invisible) | `yield* ctx.sleep('name', ms)` |
| Complexity | Low | Medium |
| Best for | Simple orchestration, CRUD | Sagas, multi-step workflows, event-driven flows |

**Rule of thumb:** Use async methods unless you need `waitFor`, automatic cancellation, or named time-travel checkpoints. Generators add structure at the cost of `yield* ctx.` syntax.

---

## API reference

### `feature(name, config)`

Creates a `FeatureDef` from methods and/or generators.

**Parameters:**

- `name: string` — feature name (lowercase, becomes PascalCase prefix for actions)
- `config` — state, methods, generators, optional selectors/machine/listensTo/dispatchTo/onInit/onDestroy

**Returns:** `FeatureDef` — standard feature definition with typed method/generator dispatchers and selectors, composable with other `feature()` instances.

**Exports from `'aio'`:**

```typescript
import { feature } from 'aio'
import type { FeatureDef, GenCtx } from 'aio'
```
