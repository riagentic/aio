# Core Concepts

Everything you need to understand about how aio works.

---

## The Mental Model

AIO is a **state container**. Your entire app state lives in one object:

```ts
{
  counter: { count: 5 },
  user: { name: 'Alice', loggedIn: true },
  todos: { items: [...] }
}
```

**Nothing else stores state.** No `useState`, no Redux, no context.

When something changes, AIO: (1) makes a copy, (2) applies your change, (3)
notifies everyone listening. Everything else is ergonomics.

---

## Concept 1: Cells

A **cell** is a piece of state + the functions that modify it.

```ts
import { cell } from "aio";

const counter = cell("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
    reset(s) {
      s.count = 0;
    },
  },
});
```

- `state` -- initial data, any object
- `methods` -- functions that modify state. First arg is always `s` (state)
- `s` -- mutate directly, AIO uses Immer underneath

```ts
import { aio } from "aio";
import { counter } from "./counter.ts";

await aio.run({ appId: "my-app", cells: [counter] });

counter.increment(5); // { count: 5 }
counter.reset(); // { count: 0 }
```

---

## Concept 2: State Mutation

You mutate the `s` object directly. Don't return new state.

```ts
// WRONG (old React way)
methods: {
  increment(s, by) {
    return { count: s.count + by }    // returning new state
  }
}

// RIGHT (aio way)
methods: {
  increment(s, by) {
    s.count += by    // mutate directly
  }
}
```

AIO uses [Immer](https://immerjs.github.io/immer/). It tracks mutations and
creates a new immutable state object automatically. Deep mutations work:

```ts
methods: {
  setAge(s, age) { s.user.profile.age = age },
  addItem(s, item) { s.items.push(item) },
}
```

---

## Concept 3: Selectors

Derived state, memoized automatically.

```ts
const counter = cell('counter', {
  state: { count: 0 },
  methods: { ... },
  selectors: {
    doubled(s) { return s.count * 2 },
    expensive(s) { return heavyComputation(s.count) }, // only runs when s.count changes
  }
})

counter.doubled()   // 0
```

The `s` is scoped to the cell -- use `s.count`, not `s.counter.count`.

### Selectors with cross-cell dependencies

Use the **deps form** to read other cells' slices. The plain form (`(s) => ...`)
only sees the cell's own slice.

```ts
const counter = cell("counter", { state: { count: 0 } /* ... */ });
const wallet = cell("wallet", { state: { balance: 0 } /* ... */ });

const dashboard = cell("dashboard", {
  state: { theme: "dark" },
  selectors: {
    summary: {
      // List the cell names you want to read. The order is the order
      // of the extra arguments to fn.
      deps: ["counter", "wallet"],
      fn: (s, counter, wallet) =>
        `Count: ${counter.count}, Balance: ${wallet.balance}, theme=${s.theme}`,
    },
  },
});
```

Dep names are validated at `aio.run()` (composition time). An unknown dep throws
a clear error like
`[dashboard] selector 'summary' depends on unknown
cell 'walet' — known cells: counter, wallet`.

> The selector's first argument is always the cell's **own** slice. The
> remaining arguments are the dep cells' current slices in `deps` order.

---

## Concept 4: Async Methods

Methods can be `async`. They get a "live" state proxy:

```ts
methods: {
  async save(s) {
    s.status = 'saving'              // Batched into mutation #1
    const data = await fetch('/api')  // Pause here
    s.status = 'done'                // Batched into mutation #2
    s.data = await data.json()
  }
}
```

Each assignment after an `await` creates a separate batched action. The trigger
action (`cell:save`) appears in time-travel.

---

## Concept 5: Guard Lines

> v2: methods is the one style — the `machine:` config is gone; see
> [docs/upgrade/restructure.md](../upgrade/restructure.md).

Guard which methods run in which states with plain code — a status field you own
plus one `if` per method:

```ts
const door = cell("door", {
  state: { status: "closed" as "closed" | "open" },
  methods: {
    open(s) {
      if (s.status !== "closed") return; // ignored unless closed
      s.status = "open";
    },
    close(s) {
      if (s.status !== "open") return; // ignored unless open
      s.status = "closed";
    },
  },
});

door.open(); // works -> status 'open'
door.open(); // no-op -- guard line returns early
door.close(); // works -> status 'closed'
```

Check status in UI by reading the field: `door.status`. Assert it in tests with
`t.expect.state((s) => s.status === "open")`.

---

## Framework Rules

Mandatory rules for correct AIO framework usage.

**AIO1** All app logic MUST live in cells created via `cell('name', {...})` --
no loose state, no ad-hoc logic outside cells.

**AIO2** State MUST only be mutated inside methods (sync/async) — never directly
from outside. In dev, cell signal values are deep-frozen so a stray `cell.x = …`
from a component throws `TypeError: Cannot assign to read only property` and a
dev hint explains the rule.

**AIO3** Single entry point: `aio.run({ appId, cells: [...] })` -- no manual
store creation, no manual server setup.

**AIO4** UI components MUST access state via direct cell access (e.g.
`counter.count`) or `useAio()` hooks -- import the cell and read its properties.

**AIO5** Cross-cell communication MUST use direct method calls or `listensTo` --
never raw dispatch with string action types.

**AIO6** All bound cell methods return a Promise — sync methods resolve with
`void` once the dispatch is applied, async methods resolve with the return
value. Use `await` to read state after the change is applied. Unawaited calls
are fire-and-forget.

**AIO7** Sync methods (reducers) MUST NOT contain side effects -- only state
mutations and fire-and-forget dispatches. No fetch, file I/O, or timers in sync
methods -- use async methods (or returned schedule/own effects) for those.
