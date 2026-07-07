# Composition — Cross-Cell Communication

Cells don't share state — they communicate through three interaction patterns.

| Pattern                     | What                              | When                                    |
| --------------------------- | --------------------------------- | --------------------------------------- |
| [Observe](#1-observe)       | React when another cell acts      | Sync state, analytics, side-effects     |
| [Read](#2-read--selectors)  | Read another cell's derived state | UI display, computed values             |
| [Coordinate](#3-coordinate) | Trigger or call another cell      | Effects, async workflows, orchestration |

**Observe** and **Read** are passive. **Coordinate** is active.

---

## 1. Observe

### listensTo — the simple way

```ts
const analytics = cell("analytics", {
  state: { events: [] as string[] },
  listensTo: [cart.addItem, cart.clear], // bound methods — refactor-safe
  methods: {
    track(s, event: string) {
      s.events.push(event);
    },
  },
});
```

`listensTo` auto-generates a minimal machine with self-loop transitions. Ignored
if you provide an explicit `machine`.

### Full machine — manual foreign listeners

For cells that need real machine states alongside foreign listeners:

```ts
const analytics = cell("analytics", {
  state: { events: [] as string[] },
  machine: {
    initial: "active",
    states: {
      active: {
        [cart.addItem.type]: "active",
        [cart.clear.type]: "active",
      },
    },
  },
  reduce: {
    [cart.addItem.type](state) {
      state.events.push("item_added");
    },
    [cart.clear.type](state) {
      state.events.push("cart_cleared");
    },
  },
});
```

**How it works:** Foreign actions are identified by the `:` separator not
matching the cell's prefix. The framework routes the action to both the owner
and all listeners — owner reduces first.

---

## 2. Read — selectors

Selectors expose derived state. They don't create coupling — read-only views:

```ts
const counter = cell("counter", {
  state: { count: 0, limit: 100 },
  selectors: {
    remaining: (s: { count: number; limit: number }) => s.limit - s.count,
  },
});

counter.remaining(); // → 100
```

> Bound selectors are a **server-side** surface — the browser binds state
> getters and methods, not selectors. For derived reads in UI, declare a plain
> accessor next to the cell; it stays auto-tracked because each call reads the
> reactive getters: `const remaining = () => counter.limit - counter.count;`

**Cross-cell in UI** — read from multiple cells:

```tsx
const remaining = () => counter.limit - counter.count;

export default function Dashboard() {
  return (
    <div>
      <p>Remaining: {remaining()}</p>
      <p>Balance: {wallet.balance}</p>
    </div>
  );
}
```

---

## 3. Coordinate

### Direct calling (default — 80% of cases)

Import any cell and call its methods directly:

```ts
import { inventory } from "../inventory";
import { pricing } from "../pricing";

const orders = cell("orders", {
  state: { orderId: null as string | null, total: 0 },
  methods: {
    async placeOrder(s, items: Item[]) {
      const reserved = await inventory.reserve(items); // typed Promise
      const price = await pricing.calculate(reserved);
      s.orderId = reserved.orderId;
      s.total = price.total;
    },
  },
});
```

Each call dispatches a real action through the store — observable in
time-travel, interceptable by middleware. TypeScript infers return types.

### call() with timeout and retries

```ts
import { call } from "aio";

async placeOrder(s, items: Item[]) {
  const reserved = await call(
    { timeout: 5000, retries: 2 },
    () => inventory.reserve(items)
  );
  s.orderId = reserved.orderId;
}
```

| Option    | Type          | Effect                                     |
| --------- | ------------- | ------------------------------------------ |
| `timeout` | `number` (ms) | Rejects if method doesn't complete in time |
| `retries` | `number`      | Retries on failure up to N times           |

### ctx.dispatch in generators

```ts
generators: {
  *start(ctx, { amount, itemId }: { amount: number; itemId: string }) {
    yield* ctx.dispatch(inventory.reserve(itemId));
    yield* ctx.dispatch(analytics.trackEvent("checkout_complete"));
    yield* ctx.done(s => { s.orderId = "..." });
  },
}
```

`ctx.dispatch()` dispatches directly to the global loop.

### ctx.waitFor — pause until external action

```ts
generators: {
  *start(ctx, { amount }: { amount: number }) {
    yield* ctx.dispatch(payment.charge(amount));
    try {
      const result = yield* ctx.waitFor(payment.complete);
      yield* ctx.done(s => { s.paid = true });
    } catch {
      yield* ctx.fail("payment timed out");
    }
  },
}
```

`ctx.waitFor(actionType, timeout?)` registers a one-shot listener. Pass bound
methods directly for refactor safety.

---

## Dispatch behavior by caller context

| Caller                      | Dispatching | Behavior                               |
| --------------------------- | ----------- | -------------------------------------- |
| **Sync method** (reducer)   | `true`      | Queued, processed after current reduce |
| **Async method** (executor) | `false`     | Processed immediately                  |
| **Effect handler**          | `false`     | Immediate                              |
| **External** (UI/test)      | `false`     | Fire-and-forget or await               |

**Key insight:** Async methods run in the executor. Cross-cell calls from async
methods start a new, independent dispatch cycle — not a nested one.

---

## .type — the universal wiring tool

Every bound method has a `.type` property. Use it everywhere:

```ts
if (action.type === inventory.reserve.type) { ... }
listensTo: [inventory.reserve, orders.place]
cancelOn: { start: [orders.cancel] }
yield* ctx.waitFor(gateway.connected)
```

No raw strings anywhere.
