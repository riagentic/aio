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
  cellDefaults: { persist: "all", visible: "all" },
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

**Direct calling** -- call another cell's method (the coordination tool):

```ts
const analytics = cell("analytics", {
  state: { events: [] as string[] },
  methods: {
    track(s, event: string) {
      s.events.push(event);
    },
  },
});

// inside todos:
async add(s, text: string) {
  s.items.push({ text, done: false });
  await analytics.track("item_added"); // real action, visible in time-travel
},
```

Selectors to read, direct calls to coordinate — one explicit arrow instead of a
hidden listener table.

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

## 5. Multi-Step Workflows

A workflow is an async method — plain JavaScript, with `cancelOn` + `s.$signal`
for cancellation:

```ts
import { cell, type MethodDraftMeta } from "aio";
import { getPrice, submitOrder } from "./api.ts";

type OrderState = {
  status: string;
  orderId: string | null;
  error: string | null;
};

const order = cell("order", {
  state: {
    status: "idle" as string,
    orderId: null as string | null,
    error: null as string | null,
  },
  // reset aborts a running place() — string form avoids self-reference (TS7022)
  cancelOn: { place: ["order:reset"] },
  methods: {
    async place(s: OrderState & MethodDraftMeta, item: string) {
      s.status = "processing";
      const price = await getPrice(item);
      if (price > 1000) {
        s.status = "failed";
        s.error = "too expensive";
        return;
      }
      const id = await submitOrder(item, price);
      if (s.$signal.aborted) return; // reset fired mid-flight
      s.orderId = id;
      s.status = "done";
    },
    reset(s) {
      s.status = "idle";
      s.orderId = null;
      s.error = null;
    },
  },
});
```

Every `await` boundary commits a batch that appears in time-travel. For waiting
on conditions and timeouts, add `until`/`race`/`sleep` from `aio` — see
[Workflows](../state/methods.md#workflows-in-async-methods).

## 6. Persistence and UI Visibility

Both `persist` and `ui` accept: `"all"` (default), `"none"`,
`{ include: [...] }`, or `{ exclude: [...] }`. Set app-wide defaults with
`cellDefaults`.

```ts
const settings = cell("settings", {
  state: { theme: "dark", apiKey: "", cache: {} },
  persist: { exclude: ["apiKey"] }, // don't write the secret to disk…
  visible: { exclude: ["apiKey"] }, // …and don't sync it to clients
  methods: {/* ... */},
});
```

> A secret needs **both** excludes: `persist` controls what reaches the
> persisted snapshot on disk, `ui` controls what reaches browsers. Excluding
> only one leaks it through the other.

```ts
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

## 7. Guard Lines

Guard which methods run in which state with plain code — a `status` field you
own plus one `if` per method. Invalid calls return early, no state change.

```ts
type UploadStatus = "idle" | "uploading" | "error";

const upload = cell("upload", {
  state: {
    status: "idle" as UploadStatus,
    progress: 0,
    error: null as string | null,
  },
  methods: {
    async start(s, file: string) {
      if (s.status !== "idle") return; // no double-start
      s.status = "uploading";
      try {
        await uploadFile(file, (p: number) => {
          s.progress = p;
        });
        s.status = "idle";
        s.progress = 100;
      } catch (e) {
        s.status = "error";
        s.error = String(e);
      }
    },
    retry(s) {
      if (s.status !== "error") return;
      s.status = "idle";
      s.progress = 0;
      s.error = null;
    },
  },
});
```

Read it as: "unless in X, do nothing." Calling `upload.start()` while uploading
is a no-op. Render the status directly in UI (`upload.status`), assert it in
tests with `t.expect.state((s) => s.status === "uploading")`.

## Next Steps

- [Core Concepts](concepts.md) -- the full mental model
- [API Reference](api-reference.md) -- every export
- [State Management](../state/README.md) -- methods, workflows, composition
- [Persistence](../persistence/README.md) -- SQLite, offline, delta sync
