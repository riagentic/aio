# Generators — Sequential Async Workflows

Write top-to-bottom code — each step is observable, cancellable, and appears in
time-travel.

## Why generators

The reduce/execute pattern is reactive — "when X happens, do Y." But multi-step
workflows get scattered across files. Generators let you write the same logic
sequentially:

```ts
function* checkout(ctx, { item }: { item: string }) {
  const price = yield* ctx.call("fetchPrice", () => fetchPrice(item));
  if (price > 1000) {
    yield* ctx.fail("too expensive");
    return;
  }
  const order = yield* ctx.call("placeOrder", () => placeOrder(price));
  yield* ctx.done((s) => {
    s.orderId = order.id;
  });
}
```

### What you stop writing

| With reduce/execute           | With generators | Gone?                           |
| ----------------------------- | --------------- | ------------------------------- |
| Intermediate actions          | 0               | auto-generated from yield names |
| Effect catalogs               | 0               | inline in `ctx.call()`          |
| Machine states/transitions    | 0               | implied by sequential order     |
| Reducer/executor switch cases | 0               | `ctx.mutate()` / `ctx.call()`   |

---

## Two syntax styles

### Inline — `generators` key (recommended)

```ts
const order = cell("order", {
  state: { status: "idle" as string, orderId: null as string | null },
  methods: {
    reset(s) {
      s.status = "idle";
      s.orderId = null;
    },
  },
  generators: {
    *place(ctx) {
      yield* ctx.mutate("processing", (s) => {
        s.status = "processing";
      });
      const id = yield* ctx.call("submit", () => submitOrder());
      yield* ctx.done((s) => {
        s.orderId = id as string;
        s.status = "done";
      });
    },
  },
});

order.place(); // dispatches Order:Place, starts the generator
```

### With `cell({ actions })` — payload object

In actions-based cells, the generator key matches an action key and receives the
**payload object** directly:

```ts
const checkout = cell("checkout", {
  state: { status: "idle", orderId: null as string | null },
  actions: { start: (item: string) => ({ item }), cancel: () => ({}) },
  generators: {
    start: function* (ctx, { item }: { item: string }) {
      const id = yield* ctx.call("submit", () => submitOrder(item));
      yield* ctx.done((s) => {
        s.orderId = id as string;
      });
    },
  },
  cancelOn: { start: [checkout.cancel] },
});
```

> **Arg styles:** `cell({ methods })` → spread args: `*place(ctx, item, qty)`.
> `cell({ actions })` → payload object: `*place(ctx, { item, qty })`.

---

## Syntax

```ts
// Regular async               Generator
async function run() {          function* run(ctx) {
  const a = await fetch(x)        const a = yield* ctx.call('fetch', () => fetch(x))
  return a                         return a
}                               }
```

### Why `yield*` (not `yield`)

`ctx.call()` returns a sub-generator. `yield*` delegates into it and unwraps the
result. `yield` gives you the generator object — useless.

```ts
const price = yield ctx.call(...)   // Generator{} — wrong
const price = yield* ctx.call(...)  // 42 — correct
```

---

## Complete example

```ts
const checkout = cell("checkout", {
  state: {
    price: 0,
    orderId: null as string | null,
    error: null as string | null,
  },
  methods: {},
  generators: {
    *place(ctx, item: string) {
      const res = yield* ctx.call(
        "fetchPrice",
        () => fetch(`/api/price?item=${item}`).then((r) => r.json()),
      );
      const price = (res as { price: number }).price;
      if (price > 1000) {
        yield* ctx.fail("too expensive");
        return;
      }
      yield* ctx.mutate("setPrice", (s) => {
        s.price = price;
      });
      const order = yield* ctx.call(
        "placeOrder",
        () =>
          fetch("/api/order", {
            method: "POST",
            body: JSON.stringify({ item, price }),
          })
            .then((r) => r.json()),
      );
      yield* ctx.done((s) => {
        s.orderId = (order as { id: string }).id;
      });
    },
  },
});
```

Auto-generated actions (visible in time-travel): `checkout:place`,
`checkout:__flow:fetchPrice`, `checkout:__flow:setPrice`,
`checkout:__flow:placeOrder`, `checkout:__flow:done` or
`checkout:__flow:failed`.

---

## Patterns

### Error handling

```ts
function* syncFlow(ctx: GenCtx) {
  try {
    const data = yield* ctx.call("fetch", () => fetchData());
    yield* ctx.done((s) => {
      s.data = data;
    });
  } catch {
    yield* ctx.mutate("setError", (s) => {
      s.error = "sync failed";
    });
    yield* ctx.fail("sync failed");
  }
}
```

### Retry with backoff

```ts
function* resilientFetch(ctx: GenCtx, url: string, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return yield* ctx.call(`fetch-${attempt}`, () =>
        fetch(url).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }));
    } catch {
      if (attempt === maxRetries) {
        yield* ctx.fail(`failed after ${maxRetries + 1} attempts`);
        return;
      }
      yield* ctx.sleep(`retry-wait-${attempt}`, 1000 * Math.pow(2, attempt));
    }
  }
}
```

### Polling

```ts
generators: {
  *startMonitor(ctx) {
    while (true) {
      const status = yield* ctx.call('check', () =>
        fetch('/api/health').then(r => r.json())) as { healthy: boolean }
      yield* ctx.mutate('update', s => { s.lastCheck = Date.now(); s.healthy = status.healthy })
      if (!status.healthy) yield* ctx.dispatch(alerts.trigger('System unhealthy'))
      yield* ctx.sleep('interval', 30_000)
    }
  },
}
```

---

## Cancellation

### Declarative — `cancelOn` config key

```ts
cancelOn: {
  healthCheck: [monitor.stop],  // bound method — preferred
}
```

Accepts: bound methods (`monitor.stop`), `.type` strings, or lowercase type
strings as last resort.

### Automatic re-trigger

If a generator is triggered while a previous instance runs, the old one is
automatically cancelled. Only the latest instance runs.

### Cell disable/destroy

All running generators are cancelled immediately when a cell is disabled.
Generators use structured concurrency — no manual cleanup needed.

---

## When NOT to use generators

| Problem shape                             | Best tool               |
| ----------------------------------------- | ----------------------- |
| Sequential: do A, then B, then C          | `generators`            |
| Reactive: when X happens, do Y            | `reduce`                |
| Long-lived: survives server restarts      | `machine` + persistence |
| Multi-entry: same state from many sources | `reduce`                |
| Mix of both                               | `reduce` + `generators` |

Generators handle ~95% of async workflows. The remaining 5% are problems shaped
differently, where reduce/execute is the simpler answer.
