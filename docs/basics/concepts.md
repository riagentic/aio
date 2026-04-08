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

```ts
const dashboard = cell("dashboard", {
  state: { summary: "" },
  selectors: {
    summary(s, counter, wallet) {
      return `Count: ${counter.count}, Balance: ${wallet.balance}`;
    },
  },
});
// Parameter names match cell names -- auto-injected after aio.run()
```

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

## Concept 5: State Machines

Guard which actions are allowed in which states:

```ts
const door = cell("door", {
  state: { isOpen: false },
  machine: {
    initial: "closed",
    states: {
      closed: { open: "open" }, // only 'open' allowed when closed
      open: { close: "closed" }, // only 'close' allowed when open
    },
  },
  methods: {
    open(s) {
      s.isOpen = true;
    },
    close(s) {
      s.isOpen = false;
    },
  },
});

door.open(); // works -> machine moves to 'open'
door.open(); // dropped! 'open' not allowed in 'open' state
door.close(); // works -> machine moves to 'closed'
```

### How to read the machine

```ts
machine: {
  initial: 'closed',              // Start in 'closed' state
  states: {
    closed: { open: 'open' },     // When closed: 'open' -> move to 'open'
    open: { close: 'closed' },    // When open: 'close' -> move to 'closed'
  }
}
```

Check status in UI: `const { status } = useCell(door);`

No machine needed? Omit it entirely, or use `machine: false`.

---

## Framework Rules

Mandatory rules for correct AIO framework usage.

**AIO1** All app logic MUST live in cells created via `cell('name', {...})` --
no loose state, no ad-hoc logic outside cells.

**AIO2** State MUST only be mutated inside methods (sync/async) or reduce
handlers -- never directly from outside.

**AIO3** Single entry point: `aio.run({ appId, cells: [...] })` -- no manual
store creation, no manual server setup.

**AIO4** UI components MUST access state via `useCell(ref)` or `useAio()` hooks
-- never import or read state directly.

**AIO5** Cross-cell communication MUST use direct method calls or `listensTo` --
never raw dispatch with string action types.

**AIO6** All bound cell methods return Promise -- use `await` for
synchronization outside of sync methods.

**AIO7** Sync methods (reducers) MUST NOT contain side effects -- only state
mutations and fire-and-forget dispatches. No fetch, file I/O, or timers in sync
methods -- use async methods or execute handlers for those.
