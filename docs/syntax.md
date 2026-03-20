# Feature Anatomy — Public Interface, Internals, and Call Graph

Everything a feature can contain, who can call what, and how to structure your code correctly.

---

## Part 1: The Public Interface (outside the feature)

After `feature()` returns a feature ref, this is what the outside world can access and use.

### What you can call

| What | How | Example |
|------|-----|---------|
| Sync method | Direct call | `counter.increment(5)` |
| Async method | Direct call (returns Promise) | `await api.fetch('/users')` |
| Generator | Direct call (starts workflow) | `checkout.place(item)` |
| Action (explicit style) | Direct call or dispatch | `cart.start()` |
| Selector | Direct call (after bind) | `counter.total()` |
| `.type` on any callable | Read property | `cart.clear.type` → `"cart:clear"` |

### What `.type` is for

Every method, generator, and action has a `.type` string property. You need it for cross-feature wiring:

```ts
// cancelOn — cancel generator when another feature's method fires
cancelOn: { place: [cart.clear] }

// listensTo — react to foreign actions in your machine
listensTo: [inventory.reserve]

// machine — foreign action transitions
machine: {
  states: {
    processing: { [cart.clear.type]: 'cancelled' }
  }
}
```

### What you cannot access

Everything prefixed with `_` is framework plumbing. You never need it:

- `__aio` — single namespace containing all framework plumbing (reducer, executor, machine, flows, actions, effects, bind state, method classifications)

All internals live under `__aio`. You can inspect them for debugging (`counter.__aio.machine`, `counter.__aio.actionKeys`) but never need to in normal code.

### Cross-feature calling

Features call each other through their public interface — direct method calls:

```ts
// In payment's generator — call inventory directly
yield* ctx.call('reserve', () => inventory.reserve(items))

// In an async method — await another feature
async save(s) {
  await notifications.send('Saved!')
}

// With timeout and retry
await call({ timeout: 5000, retries: 2 }, () => inventory.reserve(items))
```

This always goes through the dispatch loop — observable, time-travelable, machine-guarded.

---

## Part 2: Inside the Feature (implementation)

What each part of a feature can do, and what it cannot.

### Sync methods

The simplest building block. Receives an Immer draft of your feature's state.

```ts
methods: {
  increment(s, by = 1) { s.count += by },
}
```

**Can:**
- Mutate state (Immer draft — safe, immutable under the hood)
- Call plain helper functions
- Return effects array (optional)

**Cannot:**
- Call other methods on the same feature (no `this`, no feature ref)
- Access selectors
- Dispatch actions
- Do async work
- Access full app state (only own feature's slice)

### Async methods

Same signature as sync, but the state argument is a live proxy that batches mutations.

```ts
methods: {
  async save(s, data: string) {
    s.saving = true                              // mutation 1 — batched
    await Deno.writeTextFile('./data.json', data) // async work
    s.saving = false                             // mutation 2 — batched
    s.lastSaved = Date.now()                     // mutation 3 — batched
  },
}
```

**Can:**
- Mutate state (live proxy — mutations auto-dispatch as batches)
- Call plain helper functions
- Await async work (fetch, file I/O, etc.)
- Call other features' methods (`await otherFeature.method()`)
- Return a value (resolved via Promise to the caller)

**Cannot:**
- Call own feature's other methods directly (no self ref)
- Access selectors
- Access full app state

### Generators

The most powerful context. Top-to-bottom orchestration with full observability.

```ts
generators: {
  *place(ctx, item: string) {
    // Step 1: reserve inventory (observable, named)
    const reserved = yield* ctx.call('reserve',
      () => inventory.reserve([item])
    )
    // Step 2: charge payment
    yield* ctx.call('charge',
      () => chargeCard(reserved.total)
    )
    // Step 3: finalize
    yield* ctx.done(s => { s.orderId = reserved.id })
  },
},
cancelOn: { place: [cart.clear] },
```

**Can:**
- `yield* ctx.call(label, fn)` — run async work (observable checkpoint)
- `yield* ctx.mutate(fn)` — mutate state (observable checkpoint)
- `yield* ctx.done(fn)` — final mutation + signal completion
- `yield* ctx.fail(reason)` — signal failure
- `ctx.dispatch(action)` — fire-and-forget action
- `ctx.send.ownMethod()` — call own feature's methods
- `otherFeature.method()` — call other features directly
- `yield* ctx.waitFor(actionType)` — pause until a specific action arrives
- `yield* ctx.sleep(ms)` — pause for a duration
- `yield* ctx.all([...])` — parallel execution
- `yield* ctx.race([...])` — first-to-finish wins
- Be cancelled externally via `cancelOn`

**Cannot:**
- Nothing — generators can do everything

**Every `yield*` point:**
- Creates a named action in history (time-travel visible)
- Can be inspected in the TT panel
- Marks a cancellation-safe boundary

### Selectors

Pure functions that derive values from full app state.

```ts
selectors: {
  total: (s) => s.items.reduce((sum, i) => sum + i.price, 0),
  isEmpty: (s) => s.items.length === 0,
},
```

**Can:**
- Read full feature state
- Compose other selectors
- Return any derived value

**Cannot:**
- Mutate state
- Dispatch actions
- Do async work
- Access other features' state (receives own slice only)

### Reduce handlers (explicit style)

Pure state transitions. Receive an Immer draft and the action payload.

```ts
reduce: {
  start(state) { state.step = 'processing' },
  complete(state, payload) { state.result = payload.data },
},
```

**Can / Cannot:** Same as sync methods.

### Execute handlers (explicit style)

Handle effects returned from reduce.

```ts
execute: {
  async Submit(app, payload) {
    const result = await fetch('/api/submit', { body: payload.data })
    app.dispatch(actions.complete({ data: await result.json() }))
  },
},
```

**Can:**
- `app.dispatch(action)` — dispatch actions (own or cross-feature)
- `app.getState()` — read own feature's current state
- Await async work
- Call other features' methods

**Cannot:**
- Mutate state directly (must dispatch)

### Lifecycle hooks

```ts
onInit(app) { app.dispatch(...) },
onDestroy(app) { /* cleanup */ },
```

**Can:** Same as execute — dispatch and read state. One-time calls.

---

## Part 3: Reuse Patterns

### Sharing logic between methods

Methods can't call each other. Extract shared logic into plain helper functions:

```ts
// helpers — pure functions operating on state drafts
function addItem(s: CartState, item: CartItem): void {
  s.items.push(item)
  s.total += item.price
}

function removeItem(s: CartState, id: string): void {
  const idx = s.items.findIndex(i => i.id === id)
  if (idx >= 0) {
    s.total -= s.items[idx]!.price
    s.items.splice(idx, 1)
  }
}

// feature — methods compose helpers
export const cart = feature('cart', {
  state: { items: [] as CartItem[], total: 0 },
  methods: {
    add(s, item: CartItem) { addItem(s, item) },
    remove(s, id: string) { removeItem(s, id) },
    replace(s, id: string, item: CartItem) {
      removeItem(s, id)
      addItem(s, item)
    },
    clear(s) { s.items = []; s.total = 0 },
  },
})
```

This is the data-oriented pattern: **data shape inside `feature()`, pure functions beside it**. Helpers are testable independently, have no hidden side effects, and compose freely.

### Sharing logic between features

For cross-feature shared utilities, use plain functions in a shared module:

```ts
// shared/money.ts
export function formatCurrency(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export function applyDiscount(price: number, percent: number): number {
  return Math.round(price * (1 - percent / 100))
}
```

Import and use in any feature's methods, selectors, or helpers. No framework coupling.

### When to escalate from methods to generators

Start with sync methods. Escalate when you need:

| Need | Use |
|------|-----|
| Mutate state | Sync method |
| Mutate state + async I/O | Async method |
| Multi-step with observable checkpoints | Generator |
| Cancellable workflow | Generator + `cancelOn` |
| Wait for external event mid-flow | Generator + `ctx.waitFor()` |
| Parallel async operations | Generator + `ctx.all()` |
| Complex error recovery | Generator + try/catch around `ctx.call()` |

> **Rule of thumb:** if you're chaining multiple async calls with state mutations between them, and you want each step visible in time-travel — use a generator. For a single async call, an async method is simpler.

### Composing selectors

Selectors can call other selectors for derived chains:

```ts
// Extract helpers for composition — selectors are just functions
const subtotal = (s: CartState) => s.items.reduce((sum, i) => sum + i.price * i.qty, 0)
const tax = (s: CartState) => subtotal(s) * 0.08

selectors: {
  subtotal,
  tax,
  total: (s) => subtotal(s) + tax(s),
},
```

Or use `createSelector` for memoized selectors that only recompute when inputs change:

```ts
import { createSelector } from 'aio'

const selectExpensiveItems = createSelector(
  (s: CartState) => s.items,
  (items) => items.filter(i => i.price > 100),
)
```

---

## Part 4: Reserved Names

Method, generator, action, and selector names must not collide with framework properties. Using a reserved name throws an error at feature creation time with a clear message.

**Reserved:** `state`, `A`, `E`, `__aio`

```ts
// This throws immediately:
feature('bad', {
  state: { n: 0 },
  methods: {
    state(s) { ... },  // ERROR: "state" collides with reserved property
  },
})
```

The error message lists all reserved names and suggests alternatives.

---

## Summary: Call Graph

```
Outside the feature
│
├── counter.increment(5)          sync method → dispatch → reduce → state
├── await api.fetch(url)          async method → dispatch → effect → proxy mutations
├── checkout.place(item)          generator → dispatch → flow runner → yield* steps
├── counter.total()               selector → pure derivation
└── counter.increment.type        string constant for cross-feature wiring

Inside the feature
│
├── sync method(state)
│   └── can: mutate draft, call helpers, return effects
│
├── async method(proxy)
│   └── can: mutate proxy, await, call helpers, call other features
│
├── *generator(ctx)
│   └── can: everything — mutate, await, dispatch, wait, sleep, parallel, cancel
│
├── selector(state)
│   └── can: derive values, compose other selectors
│
├── reduce(draft, payload)        [explicit style]
│   └── can: mutate draft, call helpers, return effects
│
├── execute(app, effect)          [explicit style]
│   └── can: dispatch, read state, await, call other features
│
└── plain helpers (outside feature)
    └── can: mutate drafts (when called from method/reduce), compute values
```
