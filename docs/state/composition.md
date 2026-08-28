# Composition — Cross-Cell Communication

> v2: methods is the one style — see
> [docs/upgrade/restructure.md](../upgrade/restructure.md) for migration from
> `machine:`/`generators:` foreign-action patterns.

Cells don't share state — they communicate through three interaction patterns.

| Pattern                     | What                              | When                                    |
| --------------------------- | --------------------------------- | --------------------------------------- |
| [Observe](#1-observe)       | React when another cell acts      | Cancellation, analytics, side-effects   |
| [Read](#2-read--selectors)  | Read another cell's derived state | UI display, computed values             |
| [Coordinate](#3-coordinate) | Trigger or call another cell      | Effects, async workflows, orchestration |

**Observe** and **Read** are passive. **Coordinate** is active.

---

## 1. Observe

### React to another cell — one explicit call

The acting cell calls the observer's method — one visible arrow instead of a
hidden listener table:

```ts
const cart = cell("cart", {
  state: { items: [] as Item[] },
  methods: {
    async addItem(s, item: Item) {
      s.items.push(item);
      await analytics.track("item_added"); // explicit, typed, in time-travel
    },
  },
});
```

### cancelOn — abort in-flight work on a foreign action

```ts
const checkout = cell("checkout", {
  cancelOn: { place: [cart.clear] }, // bound methods — refactor-safe
  methods: {
    async place(s, item: Item) {/* observes abort via s.$signal */},
  },
});
```

See [Cancellation](methods.md#cancellation--cancelon--ssignal).

### listensTo — react to foreign actions (decoupled pub/sub)

**Object form (recommended)** — a SYNC method runs when the foreign action
dispatches; the SOURCE cell never knows about this one:

```ts
const stats = cell("stats", {
  state: { clears: 0 },
  listensTo: { onCartCleared: cart.clear }, // cart:clear → onCartCleared(s, payload)
  methods: {
    onCartCleared(s) {
      s.clears += 1;
    },
  },
});
```

The handler must be sync (it runs inside the reduce) and receives the foreign
action's payload. Unknown method names and async handlers fail loudly at
`cell()` time.

One form: the object, which names the method that reacts. (The bare array,
`listensTo: [cart.addItem]` — retired in alpha70 — routed the action through the
cell and ran nothing.) When the source naturally knows the target, direct
calling (above) stays the simplest wiring.

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
import { cell } from "aio";
import { inventory } from "../inventory/index.ts";
import { pricing } from "../pricing/index.ts";

type Item = { id: string; qty: number };

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
time-travel, interceptable by `beforeReduce`. TypeScript infers return types.

### call() with timeout and retries

```ts
import { call, cell } from "aio";
import { inventory } from "./cell/inventory/index.ts";

type Item = { id: string; qty: number };

export const orders = cell("orders", {
  state: { orderId: null as string | null },
  methods: {
    async placeOrder(s, items: Item[]) {
      const reserved = await call(
        { timeoutMs: 5000, retries: 2 },
        (): Promise<{ orderId: string }> => inventory.reserve(items),
      );
      s.orderId = reserved.orderId;
    },
  },
});
```

| Option    | Type          | Effect                                     |
| --------- | ------------- | ------------------------------------------ |
| `timeout` | `number` (ms) | Rejects if method doesn't complete in time |
| `retries` | `number`      | Retries on failure up to N times           |

### until — pause until another cell's state changes

Watch state, not actions — it doesn't matter which action caused the change:

```ts
import { cell, race, until } from "aio";
import { payment } from "./cell/payment/index.ts";

const checkout = cell("checkout", {
  state: { paid: false, status: "idle" },
  methods: {
    async start(s, amount: number) {
      await payment.charge(amount);
      const r = await race({
        paid: until(() => payment.chargeId !== null),
        timeout: 30_000,
      });
      if (r.winner === "timeout") {
        s.status = "failed";
        return;
      }
      s.paid = true;
    },
  },
});
```

See [Workflows in async methods](methods.md#workflows-in-async-methods).

---

## Dispatch behavior by caller context

| Caller                      | Dispatching | Behavior                               |
| --------------------------- | ----------- | -------------------------------------- |
| **Sync method** (reducer)   | `true`      | Queued, processed after current reduce |
| **Async method** (executor) | `false`     | Processed immediately                  |
| **External** (UI/test)      | `false`     | Fire-and-forget or await               |

**Key insight:** Async methods run in the executor. Cross-cell calls from async
methods start a new, independent dispatch cycle — not a nested one.

---

## .type — the universal wiring tool

Every bound method has a `.type` property. Use it everywhere:

```ts
if (action.type === inventory.reserve.type) { ... }
listensTo: { onReserve: inventory.reserve, onOrder: orders.place }
cancelOn: { start: [orders.cancel] }
```

No raw strings anywhere.
