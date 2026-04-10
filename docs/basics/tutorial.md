# Tutorial -- Building with AIO Step by Step

Each section builds on the previous, but you can stop at any point.

## 1. Single Cell -- Counter

```ts
import { aio, cell } from "aio";

const counter = cell("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
    decrement(s, by = 1) {
      s.count -= by;
    },
    reset(s) {
      s.count = 0;
    },
  },
});

await aio.run({
  appId: "tutorial",
  cells: [counter],
  cellDefaults: { persist: "all", ui: "all" },
});
```

Every method's first arg is `s` -- an Immer draft. Mutate directly; AIO produces
an immutable snapshot behind the scenes. After `aio.run()`:
`counter.increment(5)`.

## 2. Multiple Cells -- Todo + Filter

```ts
const todos = cell("todos", {
  state: { items: [] as { text: string; done: boolean }[] },
  methods: {
    add(s, text: string) {
      s.items.push({ text, done: false });
    },
    toggle(s, idx: number) {
      s.items[idx].done = !s.items[idx].done;
    },
    remove(s, idx: number) {
      s.items.splice(idx, 1);
    },
  },
  selectors: {
    remaining: (s) => s.items.filter((i) => !i.done).length,
  },
});

const filter = cell("filter", {
  state: { mode: "all" as "all" | "active" | "done" },
  methods: {
    set(s, mode: "all" | "active" | "done") {
      s.mode = mode;
    },
  },
});

await aio.run({ appId: "tutorial", cells: [todos, filter] });
```

`aio.run()` merges cells into one tree. Each cell can only mutate its own slice.

## 3. Cross-Cell Communication

**Selectors** -- read derived state: `todos.remaining()`.

**listensTo** -- react when another cell acts:

```ts
const analytics = cell("analytics", {
  state: { events: [] as string[] },
  listensTo: [todos.add, todos.remove],
  reduce: {
    [todos.add.type](s) {
      s.events.push("item_added");
    },
    [todos.remove.type](s) {
      s.events.push("item_removed");
    },
  },
});
```

**Direct calling** -- call another cell's method (active coordination):

```ts
await todos.add("Buy milk"); // real action, visible in time-travel
```

Selectors to read, `listensTo` to observe, direct calls to coordinate.

## 4. Async Methods

```ts
const api = cell("api", {
  state: {
    data: null as string | null,
    loading: false,
    error: null as string | null,
  },
  methods: {
    async fetchData(s, url: string) {
      s.loading = true; // batch 1: dispatched immediately
      s.error = null;
      try {
        const res = await fetch(url); // other methods CAN run here
        s.data = await res.text(); // batch 2: dispatched after await
        s.loading = false;
      } catch (e) {
        s.error = String(e);
        s.loading = false;
      }
    },
  },
});
```

**Key insight: each `await` splits mutations into separate actions.** Between
awaits the app keeps running -- other methods can fire. Set loading flags before
your first await, use try/catch (pre-throw mutations are already dispatched),
and don't assume state is unchanged after an await.

## 5. Generators -- Multi-Step Workflows

When you need named checkpoints, cancellation, or multi-step coordination.

```ts
const order = cell("order", {
  state: { status: "idle", orderId: null as string | null },
  generators: {
    *place(ctx, item: string) {
      yield* ctx.mutate("processing", (s) => {
        s.status = "processing";
      });
      const price = yield* ctx.call("fetchPrice", () => getPrice(item));
      if (price > 1000) {
        yield* ctx.fail("too expensive");
        return;
      }
      const id = yield* ctx.call("submit", () => submitOrder(item, price));
      yield* ctx.done((s) => {
        s.orderId = id;
        s.status = "done";
      });
    },
  },
  cancelOn: { place: [order.reset] },
  methods: {
    reset(s) {
      s.status = "idle";
      s.orderId = null;
    },
  },
});
```

Every `yield*` step appears in time-travel. `ctx.call` runs async work,
`ctx.mutate` changes state, `ctx.done`/`ctx.fail` end the flow. `cancelOn`
cancels a running generator when a specified action dispatches.

## 6. Persistence and UI Visibility

Both `persist` and `ui` accept: `"all"`, `"none"` (default),
`{ include: [...] }`, or `{ exclude: [...] }`. Set app-wide defaults with
`cellDefaults`.

```ts
const settings = cell("settings", {
  state: { theme: "dark", apiKey: "", cache: {} },
  persist: "all", // persist entire state
  ui: { exclude: ["apiKey"] }, // hide apiKey from clients
  methods: {/* ... */},
});
```

When state shape changes between app versions, add a migration:

```ts
const wallet = cell("wallet", {
  state: { balance: 0, currency: "USD" },
  version: 2,
  onMigrate(state, fromVersion) {
    if (fromVersion < 2) state.currency = "USD";
    return state;
  },
  persist: "all",
  methods: {/* ... */},
});
```

`onMigrate` runs when persisted version < current `version`, receiving old state
(already deep-merged with defaults) and the old version number.

## 7. State Machines

Guard which methods are allowed in which state. Invalid actions are silently
dropped.

```ts
const upload = cell("upload", {
  state: { progress: 0, error: null as string | null },
  machine: {
    initial: "idle",
    states: {
      idle: { start: "uploading" },
      uploading: { complete: "idle", fail: "error" },
      error: { retry: "uploading", dismiss: "idle" },
    },
  },
  methods: {
    async start(s, file: string) {
      await uploadFile(file, (p) => {
        s.progress = p;
      });
    },
    complete(s) {
      s.progress = 100;
    },
    fail(s, err: string) {
      s.error = err;
    },
    retry(s) {
      s.progress = 0;
      s.error = null;
    },
    dismiss(s) {
      s.error = null;
      s.progress = 0;
    },
  },
});
```

Read it as: "when in X, only Y is allowed." Calling `upload.start()` while
uploading is dropped. Check status in UI via `registry.status()`. No machine
needed? Omit it -- all actions always run.

## Next Steps

- [Core Concepts](concepts.md) -- the full mental model
- [API Reference](api-reference.md) -- every export
- [State Management](../state/README.md) -- generators, machines, composition
- [Persistence](../persistence/README.md) -- SQLite, offline, delta sync
