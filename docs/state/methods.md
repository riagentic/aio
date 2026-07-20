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

### Returning a value

A sync method can **return a value**, and `await cell.method()` resolves with it
— no need to make the method `async` just to hand something back:

```ts
methods: {
  addItem(s, item: Item): string {
    const id = crypto.randomUUID()
    s.items.push({ ...item, id })
    return id                       // ← the new id
  },
}

const id = await cart.addItem({ name: "Book", price: 12 })
//    ^? string
```

- The type is inferred: `addItem` → `Promise<string>`, a void method →
  `Promise<void>`. Annotate the return (`: string`) when TS can't infer it.
- Returning a **schedule/own effect** (or an array of them) still schedules that
  effect — it is *not* treated as a value, so `await` resolves `undefined`. A
  method can't both schedule an effect and return a value in the same call.
- Returning a slice of draft state (`return s.items[id]`) is safe — the value is
  snapshotted, so it survives past the method (no revoked-proxy surprises).

### Returning schedule effects

Methods — sync **and** async (AIO-381) — can return schedule effects:

```ts
methods: {
  startPolling(s): ScheduleEffect {
    s.polling = true
    return schedule.every('poll', 30_000, poller.refresh.action())
  },
  stopPolling(s) {
    s.polling = false
    return schedule.cancel('poll')
  },
}
```

### Referencing the cell inside its own methods (the `: CellEffect` annotation)

When a method schedules an action on **its own cell**, it names the cell that is
still being defined:

```ts
const cycle = cell("cycle", {
  state: { phase: "work", n: 0 },
  methods: {
    tick(s) {
      s.n += 1;
    },
    skip(s) {
      // ⛔ references `cycle` inside `cycle`'s own initializer
      return schedule.after("cycle.next", 0, cycle.tick.action());
    },
  },
});
// TS7022: 'cycle' implicitly has type 'any' … referenced in its own initializer
// TS7023: 'skip' implicitly has return type 'any' …
```

This is a **TypeScript limitation**, not an aio bug: to infer `cycle`'s type TS
must infer `skip`'s return type, which evaluates `cycle.tick.action()`, which
needs `cycle`'s type — a cycle. (It can't be fixed framework-side without fixing
every method's return type and thereby losing real return types like
`await cell.checkStock()` → `Promise<Stock>`.)

**Fix: annotate the method's return** — that gives TS the type directly, so it
no longer infers it from the body. Use `CellEffect` (exported from `aio`), the
union of every effect a method may return:

```ts
import type { CellEffect } from "aio";

const cycle = cell("cycle", {
  state: { phase: "work", n: 0 },
  methods: {
    tick(s) {
      s.n += 1;
    },
    skip(s): CellEffect { // ← breaks the cycle
      return schedule.after("cycle.next", 0, cycle.tick.action());
    },
    maybeStop(s): CellEffect | void { // ← conditional returns
      if (s.n > 3) return schedule.cancel("cycle.next");
    },
    async poll(s): Promise<CellEffect | void> { // ← async methods
      await Promise.resolve();
      return schedule.after("cycle.retry", 500, cycle.tick.action());
    },
  },
});
```

Scheduling **another** cell's action needs no annotation — only self-reference
does. The same applies to a free helper that references the cell before its
declaration: annotate it `(): CellEffect`.

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

> ### ⚠️ Every `await` is a commit + render point
>
> This is the one async-method behavior to internalize. When your method hits an
> `await`, aio **commits everything you've written so far** — it dispatches, the
> store updates, and the UI **re-renders** before the awaited promise resolves.
> That's what makes `s.loading = true; await fetch()` show a spinner _during_
> the fetch — genuinely useful, and deliberate.
>
> Two consequences to hold in your head:
>
> 1. **Partial state is visible mid-method.** Everything before an `await` is
>    live to the UI and to other cells while you're still awaiting. If three
>    fields must change together, write them all **in one frame** (no `await`
>    between them), or the UI can render a half-updated state.
> 2. **State is not frozen across an `await`.** Reads after an `await` return
>    the _current_ store (with your pending writes overlaid) — another action
>    may have landed while you were suspended. Don't assume `s.x` is unchanged
>    just because you didn't touch it; re-read it after the `await` if it
>    matters.
>
> Rule of thumb: **gather async results first, then do a contiguous block of
> writes at the end.** Every write lands (writes after any await commit fine —
> the framework guarantees this), but grouping them keeps the intermediate UI
> honest.

**Method-tagged actions** — async writes dispatch `__SetMethodName` actions
(e.g., `__SetCheckout`). This enables machine guards: if `checkout` is allowed
in a state, its writes are also allowed.

**Every read = fresh state + your pending writes** (read-your-writes). Reads
through `s` see the committed store with this method's unflushed writes
overlaid, so straight-line code behaves exactly like sync code:

```ts
async poll(s) {
  s.cpu = readCpu()
  s.history.push({ cpu: s.cpu })   // pushes the value set one line up
}
```

No stale copies after `await`, and no stale reads after your own writes — what
you read is exactly what commits.

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

### Read patterns

The live proxy supports the read patterns you'd expect:

- **Direct property reads** — `s.user.name`, `s.items.length`
- **Spread on objects** — `{ ...s }` returns a plain object with fresh values
- **`Object.keys(s)` / `Object.entries(s)`** — returns plain key/value arrays
- **`JSON.stringify(s)`** — works (ownKeys + getOwnPropertyDescriptor give a
  plain snapshot)
- **Array read methods** — `s.items.map`, `.filter`, `.find`, `.findIndex`,
  `.some`, `.every`, `.reduce`, `.slice`, `.concat`, `.includes`, `.indexOf`,
  `.flat`, `.flatMap`, `.forEach`, `.entries`, `.keys`, `.values`, `.join`,
  `.toSorted`, `.toReversed`, `.toSpliced`. These execute against a
  `structuredClone` snapshot of the array, so the result is plain data (not a
  live proxy). They see the **current** state plus your pending writes, fresh
  per call — re-read after an `await` and you get the new state.

For anything that isn't covered (function-valued properties on the state,
unusual array methods), the live proxy throws:

```
[mycell:myMethod] doSomething() is not supported on live async state — snapshot first: const items = [...s.items]
```

The fix is to take a plain snapshot of what you need before calling the
unsupported op: `const items = [...s.items]`, `const config = { ...s.config }`,
then call the op on the snapshot.

### Returning schedule effects from async methods (AIO-381)

Async methods can return schedule effects too — same as sync methods:

```ts
async fetchData(s): Promise<ScheduleEffect | void> {
  try {
    s.data = await api.getData()
  } catch {
    s.retries += 1
    return schedule.after('fetch.retry', s.retries * 2000, data.fetchData.action())
  }
}
```

Detection is conservative: only values that _are_ schedule effects (or an array
of them) count. Any other return value passes through untouched to direct
callers (`const stock = await inventory.checkStock(...)`), so data returns and
effect returns never collide.

### Follow-up actions: don't reach for setTimeout

To trigger another action when a method finishes, **never** write
`setTimeout(() => cell.other(), 0)` — it escapes the action log, time-travel,
and cancellation. The sanctioned tools:

| You want…                           | Use                                                   |
| ----------------------------------- | ----------------------------------------------------- |
| "after this, dispatch X"            | `return schedule.after('id', 0, cell.other.action())` |
| a multi-step sequential workflow    | a [generator](generators.md) with `ctx.dispatch()`    |
| debounce / retry / polling          | `schedule.after` / `schedule.every` (id = replace)    |
| own a watcher / socket / subprocess | `return own.set('cell:id', factory)` (AIO-382)        |

### Owning native resources: `own.set` (AIO-382)

Methods are reducers — they have no place to keep a file watcher, socket, or
subprocess handle. Don't park disposers in module-scope variables; return an
`own.set` effect. It has the exact replace contract `schedule.after` has for
timers, extended to disposables:

```ts
import { cell, own } from "aio";

const workspace = cell("workspace", {
  state: { dir: "" },
  methods: {
    async setWorkspace(s, dir: string) {
      s.dir = dir;
      // Same id ⇒ the previous watcher's disposer runs first. All slots are
      // disposed on cell disable and on app shutdown — no manual teardown.
      return own.set("workspace:watcher", () => watchDir(dir, onChange));
    },
    close(_s) {
      return own.dispose("workspace:watcher");
    },
  },
});
```

The factory runs in the runtime (not in the reducer) and may return a disposer
function or a closeable object (`{ close() }` / `{ dispose() }`). The effect
itself is plain data — the factory travels out-of-band, so on time-travel replay
the runtime skips re-acquisition instead of resurrecting watchers. Prefix ids
with the cell name (`cell:resource`) — disable cleanup matches on the `:`
delimiter, like schedule ids.

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

### Keyed map with default

Map-shaped state (`Record<string, T>`) returns `undefined` for keys that haven't
been populated yet, so direct reads need a guard at every call site:

```tsx
<span>{balances.sol[pubKey] ?? 0}</span>; // ?? 0 sprinkled at every read
```

Declare the guarded read once as a plain accessor function next to the cell —
each call reads the reactive getter, so it stays auto-tracked in JSX:

```ts
export const sol = (pubKey: string) => balances.sol[pubKey] ?? 0;
```

```tsx
<span>{sol(item.pubKey)}</span>; // one guard, every read safe
```

---

## Direct calling

After `aio.run()`, methods and selectors are callable directly:

```ts
await aio.run({ cells: [counter] });

await counter.increment(5); // Promise resolves once the dispatch is applied
// (browser: resolves on server ack — state read on the next line is fresh)
counter.reset(); // dispatches counter:reset
counter.isPositive(); // reads state → true
counter.increment.type; // → 'counter:increment'
```

Before `aio.run()`, calling a method does **not** dispatch. In development it
throws immediately with
`[counter] increment() called before aio.run() — add
this cell to aio.run({ cells: [...] })`;
in production it logs the same message once and resolves with `void`. The
intent: surface "I clicked and nothing happened, no error anywhere" as an
immediate failure.

To get the raw action object pre-binding (composition, tests, time-travel), use
the internal catalog: `counter.__aio.actions.increment(5)` returns
`{ type: "counter:increment", payload: { args: [5] } }`.

---

## Common Pitfalls

### State in sync methods is a standard Immer draft

The `s` parameter is an Immer draft. Plain JavaScript reads, spreads,
`.map`/`.filter`, `Object.keys`, and `JSON.stringify` all work — they read the
current state of the draft, just like a plain object. The only thing to watch is
that **values you take out of the method** (return values, effect payloads,
`JSON.stringify` results) are snapshots; the live draft stays in the method
body.

```ts
methods: {
  toggle(s) {
    s.done = !s.done;                          // mutation — tracked by Immer
    const count = s.items.length;               // read — works
    const filtered = s.items.filter((x) => x.active); // read — works
    const copy = { ...s, updatedAt: Date.now() };     // read + extend — works
    return { count, filtered, copy };            // values out are snapshots
  },
}
```

**One thing to know:** `JSON.stringify(s)` works for reading, but the result is
a string snapshot at that moment. If you need an object snapshot to pass to a
reducer, use `structuredClone(s)` — Immer drafts aren't structured- cloneable,
so this throws; use the `[...s.items]` / `{...s}` patterns above for cloning.

### Mutations on returned snapshots are ignored

If you do:

```ts
methods: {
  leak(s) {
    const snap = { ...s };
    snap.x = 99; // no-op — snap is a fresh plain object, not tracked
    return snap;
  },
}
```

The mutation to `snap` is harmless (no state change) because `snap` is a fresh
plain object. aio dispatches the return value as-is, and the caller gets a plain
object with `x: 99` that has no reactive effect. The draft itself was not
mutated; if you wanted to mutate the draft, do it before spreading.

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
