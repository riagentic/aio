# Methods — Sync, Async, and Selectors

The default way to build aio cells. No action catalogs, no effect catalogs, no
switch/case. Just methods that mutate state.

## Quick example

```ts
import { aio, cell } from "aio";

const todo = cell("todo", {
  state: {
    items: [] as { text: string; done: boolean }[],
    filter: "all" as "all" | "active" | "done",
  },
  methods: {
    add(s, text: string) {
      s.items.push({ text, done: false });
    },
    toggle(s, idx: number) {
      s.items[idx].done = !s.items[idx].done;
    },
    setFilter(s, filter: "all" | "active" | "done") {
      s.filter = filter;
    },
    async sync(s) {
      await fetch("/api/todos", {
        method: "POST",
        body: JSON.stringify(s.items),
      });
    },
  },
  selectors: {
    filtered: (s) =>
      s.filter === "all"
        ? s.items
        : s.items.filter((i) => (s.filter === "done" ? i.done : !i.done)),
    remaining: (s) => s.items.filter((i) => !i.done).length,
  },
});

await aio.run({ cells: [todo] });
todo.add("buy milk");
todo.toggle(0);
const count = todo.remaining(); // → 0
```

After `aio.run()`, call methods and selectors directly on the cell — no
`dispatch()`, no passing state.

---

## Sync methods

Receive mutable state (Immer draft). Mutate in place:

```ts
methods: {
  increment(s, by = 1) {
    s.count += by
  },
  addItems(s, items: Item[]) {
    s.items.push(...items)
    s.total = s.items.reduce((sum, i) => sum + i.price, 0)
  },
}
```

All mutations within one method call = one atomic action. The method name
becomes the action type: `increment` → `counter:increment`.

**What you can do:** mutate any property, nested objects, array methods (`push`,
`splice`, `sort`), delete properties — anything Immer supports.

**What you cannot do:** async operations, access other cells' state.

### Returning schedule effects

Sync methods can return schedule effects:

```ts
methods: {
  startPolling(s) {
    s.polling = true
    return schedule.every('poll', 30_000, poller.refresh)
  },
  stopPolling(s) {
    s.polling = false
    return schedule.cancel('poll')
  },
}
```

---

## Async methods

Same signature as sync, but the state argument is a **live Proxy** that batches
mutations:

```ts
methods: {
  async checkout(s) {
    s.status = 'loading'                       // dispatches immediately
    const order = await placeOrder(s.items)    // s.items reads CURRENT state
    s.orderId = order.id                       // dispatches after await
    s.status = 'done'                          // dispatches after await
  },
}
```

**Writes are batched** — consecutive assignments in the same sync frame produce
one action. Each `await` boundary starts a new batch.

**Method-tagged actions** — async writes dispatch `__SetMethodName` actions
(e.g., `__SetCheckout`). This enables machine guards: if `checkout` is allowed
in a state, its writes are also allowed.

**Every read = fresh state** from the store. No stale copies after `await`.

### Nested writes and arrays

```ts
async updateProfile(s) {
  const profile = await fetchProfile()
  s.user.name = profile.name               // batched into one action
  s.user.settings.theme = profile.theme     // same batch
}

async loadItems(s) {
  const items = await fetchItems()
  s.items.push(...items)     // instrumented array methods work
  s.items.sort((a, b) => a.name.localeCompare(b.name))
}
```

Supported array mutators: `push`, `pop`, `shift`, `unshift`, `splice`, `sort`,
`reverse`, `fill`, `copyWithin`.

### Error handling

If an async method throws, mutations before the error are already dispatched.
The framework dispatches a `{Prefix}:__error` action (hidden from time-travel):

```ts
async riskyOp(s) {
  s.status = 'processing'    // dispatched
  await mightFail()          // throws!
  s.status = 'done'          // never reached
}
// Result: status is 'processing', error logged
```

Use try/catch for cleanup:

```ts
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

Derived values from cell state:

```ts
const cart = cell("cart", {
  state: { items: [] as { price: number; qty: number }[] },
  methods: {/* ... */},
  selectors: {
    total: (s) => s.items.reduce((sum, i) => sum + i.price * i.qty, 0),
    itemCount: (s) => s.items.length,
    isEmpty: (s) => s.items.length === 0,
  },
});

// After aio.run():
const total = cart.total();
const empty = cart.isEmpty();
```

Selectors are scoped to the cell's state slice automatically. After `aio.run()`
binds the cell, selectors read current state implicitly.

---

## Direct calling

After `aio.run()`, methods and selectors are callable directly:

```ts
await aio.run({ cells: [counter] });

counter.increment(5); // dispatches counter:increment
counter.reset(); // dispatches counter:reset
counter.isPositive(); // reads state → true
counter.increment.type; // → 'counter:increment'
```

Before `aio.run()`, calling a method returns an action object without
dispatching. After `aio.run()`, calling dispatches automatically.

---

## Common Pitfalls

### Immer proxy restrictions (sync methods)

The `s` parameter is an Immer draft — a Proxy that records mutations. Some
JavaScript patterns don't work on proxies:

```ts
// DON'T — these read the proxy in ways Immer can't track:
methods: {
  bad(s) {
    const copy = { ...s }             // spread reads all keys — fails
    const keys = Object.keys(s)       // same issue
    const mapped = s.items.map(...)   // .map() returns proxy-wrapped results
    JSON.stringify(s)                 // reads entire tree through proxy
  },
}

// DO — access specific properties or snapshot first:
methods: {
  good(s) {
    const name = s.user.name          // direct access — works
    s.items.push({ text: "new" })     // mutator methods — works
    s.items.forEach(i => i.done = true)  // forEach — works
    const items = [...s.items]        // snapshot to plain array first
    const filtered = items.filter(i => !i.done)  // now safe
  },
}
```

**Rule of thumb:** mutate directly, read specific properties. If you need to
transform an array, snapshot it first with `[...s.array]`.

### Effects and state references

Sync methods can return schedule effects. Effect payloads can reference state
values directly — aio clones effects inside `produce()` before Immer revokes the
draft, so state references in effects work transparently:

```ts
methods: {
  snapshot(s) {
    return { type: "backup:save", payload: { items: s.items } } // ✅ works
  },
}
```

If an effect contains non-cloneable values (functions, symbols, circular refs),
aio logs a warning and keeps the original. Stick to plain serializable objects
in effect payloads for best results.

### Async batching and time-travel

Each `await` in an async method creates a new state snapshot:

```ts
async checkout(s) {
  s.status = "validating"  // snapshot 1: { status: "validating" }
  await validate()
  s.status = "charging"    // snapshot 2: { status: "charging" }
  await charge()
  s.status = "done"        // snapshot 3: { status: "done" }
}
```

Time-travel will show 3 separate entries: `__setCheckout` for each batch. This
is by design — each await returns control to the event loop, so the framework
captures state at each boundary.

---

## Generated actions

| Source                  | Action type               | Time-travel |
| ----------------------- | ------------------------- | ----------- |
| `increment(s, by)`      | `counter:increment`       | Yes         |
| `async save(s)`         | `counter:save` (trigger)  | Yes         |
| (async write)           | `counter:__setSave`       | Hidden      |
| (async error)           | `counter:__error`         | Hidden      |
| `*place(ctx)` generator | `counter:place` (trigger) | Yes         |
| (flow step)             | `counter:__flow:stepName` | Yes         |
