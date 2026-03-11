# Reactive Features

> Write methods. Framework handles actions, dispatch, persistence, sync, time-travel.

`reactive()` is the simplest way to build aio features. No action catalogs, no effect catalogs, no switch/case, no executors. Just methods that mutate state.

---

## Quick example

```typescript
import { reactive, aio } from 'aio'

const todo = reactive('todo', {
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

After `aio.run()`, call methods and selectors directly on the feature — no `.A.` namespace, no `dispatch()`, no passing state. The framework binds everything automatically.

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

**All mutations within one method call = one atomic action.** The method name becomes the action type: `increment` → `Counter:Increment`. One entry in time-travel, one persistence write, one sync broadcast.

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
    return { _schedule: true, key: 'poll', type: 'Prices:Refresh', intervalMs: 30_000 }
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

## How async methods work

Async methods receive a **live Proxy** instead of an Immer draft. This is the key difference:

```typescript
methods: {
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
| Trigger | `send.checkout()` dispatched | `Checkout:Checkout` |
| ①②③④ | Proxy set traps fire, batched via microtask | `Checkout:__SetCheckout` `{mutations:[...]}` |
| await | New microtask frame — previous batch flushed | |
| after | Proxy writes in new sync frame | `Checkout:__SetCheckout` (second batch) |

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

When an async method throws, the framework dispatches a `{Prefix}:__error` action with `{ _method, error }` payload. This action is visible in time-travel, catchable by middleware, and observable by foreign listeners. For machine features, `__error` is auto-injected as a self-loop in all states (error doesn't change machine state).

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
const cart = reactive('cart', {
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
const total = cart.selectors.total(app.getState())
```

Selectors are scoped to the feature's state slice automatically. After `aio.run()` binds the feature, selectors read current state implicitly.

---

## Direct calling

After `aio.run()`, methods and selectors are callable directly on the feature object:

```typescript
const counter = reactive('counter', {
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

// Raw dispatch still works (backward compat)
app.dispatch(counter.A.increment(5))
```

Before boot, calling a method returns an action object without dispatching (same as `counter.A.increment()`). After boot, it dispatches automatically. The `A` catalog always returns action objects — useful for cross-feature wiring and tests.

This works for all three tiers — `reactive()`, `feature()`, and `flow()`.

---

## State machines

Reactive features support machines. Methods are gated by transitions — if a method call isn't allowed in the current state, it's silently dropped:

```typescript
const upload = reactive('upload', {
  state: { progress: 0, error: null as string | null },
  machine: {
    initial: 'idle',
    states: {
      idle:      { on: { start: 'uploading' } },
      uploading: { on: { complete: 'idle', fail: 'error' } },
      error:     { on: { retry: 'uploading', dismiss: 'idle' } },
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

For complex async workflows with strict per-step state machine control, use `flow()` instead — it was designed for exactly this case.

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

`useFeature()` works identically for `reactive()` and `feature()` features.

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

### `listensTo` — foreign listeners without a machine

The simplest way to listen to other features' actions:

```typescript
const analytics = reactive('analytics', {
  state: { events: [] as string[] },
  listensTo: ['Cart:AddItem', 'Cart:Clear'],
  methods: {
    track(s, event: string) { s.events.push(event) },
  },
})
```

`listensTo` auto-generates a minimal machine with self-loop transitions. The framework routes those actions to your reducer — combine with foreign action handling in your reduce logic or use it to gate method calls.

This is equivalent to writing a full machine with `{ active: { on: { 'Cart:AddItem': 'active', ... } } }` but without the boilerplate.

**Note:** `listensTo` is ignored if you provide an explicit `machine` — use the machine's `on` transitions instead.

### Full machine (manual)

For features that need machine states alongside foreign listeners:

```typescript
// reactive feature
const cart = reactive('cart', {
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
      active: { on: { noop: 'active', 'Cart:AddItem': 'active', 'Cart:Clear': 'active' } },
    },
  },
  reduce(state, action) {
    if (action.type === 'Cart:AddItem') state.events.push('item_added')
    if (action.type === 'Cart:Clear') state.events.push('cart_cleared')
  },
})
```

Selectors and bridges work the same way as with `feature()`.

---

## Composing all three tiers

Reactive, flow, and event-driven features compose freely:

```typescript
import { aio } from 'aio'
import { settings } from './features/settings'    // reactive()
import { checkout } from './features/checkout'    // flow()
import { analytics } from './features/analytics'  // feature()

await aio.run({
  features: [settings, checkout, analytics],
})
```

### When to use which

| Start with | Upgrade to | When |
|---|---|---|
| `reactive()` | — | Most features never need more |
| `reactive()` | `flow()` | Multi-step workflows, retries, auto-cancellation, step observability |
| `reactive()` | `feature()` | Complex reactive logic, multiple entry points, strict machine control |

**Rule: start reactive. Upgrade when you feel the pain, not before.**

---

## What reactive generates

Under the hood, `reactive()` creates a standard `FeatureDef` with auto-generated:

- **Actions**: one per method (`Cart:AddItem`, `Cart:Clear`) + method-tagged `Cart:__SetAddItem` for async writes
- **Reducer**: routes actions to method bodies (sync methods run in Immer, async mutations applied via `__setMethod`)
- **Executor**: runs async methods with live Proxy + microtask batcher

The dispatch loop, persistence, sync, time-travel, middleware — all unchanged. `reactive()` is a compiler, not a runtime change.

### Action naming

| Method | Action type |
|---|---|
| `addItem(s, item)` | `Cart:AddItem` |
| `clear(s)` | `Cart:Clear` |
| (async `save` writes) | `Cart:__setSave` (batched per sync frame) |
| (async method error) | `Cart:__error` `{ _method, error }` |

### Microtask batching

Consecutive Proxy writes in the same sync frame are grouped into one action via `queueMicrotask`. An `await` boundary flushes the current batch and starts a new one.

### What appears in time-travel

For sync methods: one action per method call with the method name.

For async methods: the trigger action (`Cart:Save`) plus one batched `Cart:__SetSave` per sync frame. Writes before an `await` are one batch, writes after are another.

---

## Patterns

### Form state

```typescript
const form = reactive('form', {
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
const prices = reactive('prices', {
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
const users = reactive('users', {
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

## Limitations

### Async Proxy writes are machine-gated by method

Async writes dispatch method-tagged `__setMethodName` actions. When a machine is configured, `reactive()` auto-injects `__setMethod` self-loop transitions in the **target** state of each async method's transition. This means writes are allowed as long as the method's transition was valid — but they don't trigger state machine transitions themselves. For strict per-write machine gating, use `feature()` with explicit actions or `flow()`.

### No structured concurrency

Reactive async methods are fire-and-forget. If you call `send.checkout()` twice, both run concurrently. Use a **state machine** to prevent re-entry:

```typescript
machine: {
  initial: 'idle',
  states: {
    idle: { on: { checkout: 'busy' } },
    busy: { on: { done: 'idle' } },  // checkout blocked while busy
  },
}
```

For auto-cancellation on re-trigger, use `flow()`.

### No step-level observability

In `flow()`, each `yield*` is a named checkpoint visible in time-travel. In `reactive()`, async methods show individual property assignments — useful but less structured. For workflow-level observability, use `flow()`.

### Not for long-lived processes

Async methods should complete or fail. They don't survive server restarts. For persistent workflows, use scheduled effects or external job queues.

---

## Comparison

| | `reactive()` | `flow()` | `feature()` |
|---|---|---|---|
| Boilerplate | Minimal | Low | Medium |
| Actions | Auto-generated | Auto-generated | Manual catalog |
| Effects | None needed | None needed | Manual catalog |
| Reducer | None needed | Optional | Required |
| Executor | None needed | None needed | Required (if effects) |
| State machine | Optional | Optional | Optional |
| Async model | Live Proxy | Generators (`yield*`) | Effects + dispatch |
| Cancellation | Manual | Automatic | Manual |
| Step observability | Per-property | Per-yield | Per-action |
| Best for | 80% of features | Workflows | Complex reactive logic |

---

## API reference

### `reactive(name, config)`

Creates a `FeatureDef` from plain methods.

**Parameters:**

- `name: string` — feature name (lowercase, becomes PascalCase prefix for actions)
- `config: ReactiveConfig` — state, methods, optional selectors/machine/listensTo/crossDispatch/init/destroy

**Returns:** `FeatureDef & FlatMethods<M> & FlatSelectors<Sel>` — standard feature definition with typed method senders and selectors, composable with `feature()` and `flow()` features. TypeScript provides autocomplete for all methods (with state parameter `s` stripped) and selectors (callable with no args after `aio.run()` binding)

**Exports from `'aio'`:**

```typescript
import { reactive } from 'aio'
import type { ReactiveConfig } from 'aio'
```
