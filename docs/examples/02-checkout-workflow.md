# Multi-Cell Checkout Workflow

> v2: methods is the one style — see
> [docs/upgrade/to-v2.md](../upgrade/to-v2.md) for migration.

Build an e-commerce checkout: cart, inventory, payment -- three cells
coordinating through async methods and direct calling. Covers workflow methods,
cross-cell `call()`, `cancelOn` + `s.$signal`, guard lines, error recovery, and
testing.

Prerequisites: [Quickstart](../basics/quickstart.md) done, one cell under your
belt.

---

## Step 1: Cart cell

The cart is pure sync state -- add items, remove them, compute a total.

```ts
// cell/cart/index.ts
import { cell } from "aio";

export type CartItem = { id: string; name: string; price: number; qty: number };

export const cart = cell("cart", {
  state: {
    items: [] as CartItem[],
    total: 0,
  },
  methods: {
    add(s, item: CartItem) {
      const existing = (s.items as CartItem[]).find((i) => i.id === item.id);
      if (existing) {
        existing.qty += item.qty;
      } else {
        (s.items as CartItem[]).push(item);
      }
      s.total = (s.items as CartItem[]).reduce(
        (sum, i) => sum + i.price * i.qty,
        0,
      );
    },
    remove(s, id: string) {
      s.items = (s.items as CartItem[]).filter((i) => i.id !== id);
      s.total = (s.items as CartItem[]).reduce(
        (sum, i) => sum + i.price * i.qty,
        0,
      );
    },
    clear(s) {
      s.items = [];
      s.total = 0;
    },
  },
});
```

No async. Methods mutate via Immer drafts. `clear` matters later -- it becomes a
cancellation trigger for the payment workflow.

---

## Step 2: Inventory cell

`reserve` is async (API call) and can fail. The payment workflow needs to know
when it does.

```ts
// cell/inventory/index.ts
import { cell } from 'aio'
import type { CartItem } from '../cart/index.ts'

type StockMap = Record<string, number>

export const inventory = cell('inventory', {
  state: { stock: {} as StockMap, reserved: {} as StockMap },
  methods: {
    check(s, itemId: string): number {
      return (s.stock as StockMap)[itemId] ?? 0
    },
    async reserve(s, items: CartItem[]) {
      await new Promise(r => setTimeout(r, 300)) // simulate API
      for (const item of items) {
        const available = (s.stock as StockMap)[item.id] ?? 0
        if (available < item.qty) {
          throw new Error(`Insufficient stock for ${item.name}`)
        }
      }
      for (const item of items) {
        (s.stock as StockMap)[item.id] -= item.qty
        (s.reserved as StockMap)[item.id] = ((s.reserved as StockMap)[item.id] ?? 0) + item.qty
      }
    },
    async release(s, items: CartItem[]) {
      await new Promise(r => setTimeout(r, 100))
      for (const item of items) {
        (s.stock as StockMap)[item.id] = ((s.stock as StockMap)[item.id] ?? 0) + item.qty
        (s.reserved as StockMap)[item.id] = ((s.reserved as StockMap)[item.id] ?? 0) - item.qty
      }
    },
  },
})
```

Notice `reserve` throws on insufficient stock. The payment workflow will catch
this. `release` exists for cleanup -- if payment fails after reservation, we
return the stock.

---

## Step 3: Payment cell with a workflow method

Payment is a multi-step workflow: reserve inventory, charge card, confirm. It is
one async method — read it top to bottom, that is the checkout flow. A guard
line prevents double-submit, `cancelOn` + `s.$signal` make it cancellable.

```ts
// cell/payment/index.ts
import { cell } from "aio";
import type { MethodDraftMeta } from "aio";
import { inventory } from "../inventory/index.ts";
import { cart } from "../cart/index.ts";
import type { CartItem } from "../cart/index.ts";

// Simulated payment API
async function chargeCard(total: number): Promise<{ chargeId: string }> {
  await new Promise((r) => setTimeout(r, 500));
  if (total > 10000) throw new Error("Card declined");
  return { chargeId: `ch_${Date.now()}` };
}

type PaymentState = {
  status: "idle" | "processing" | "confirmed" | "failed";
  chargeId: string | null;
  error: string | null;
};

export const payment = cell("payment", {
  state: {
    status: "idle" as PaymentState["status"],
    chargeId: null as string | null,
    error: null as string | null,
  },
  cancelOn: {
    process: [cart.clear], // clearing the cart aborts a running process()
  },
  methods: {
    reset(s) {
      s.status = "idle";
      s.chargeId = null;
      s.error = null;
    },
    async process(
      s: PaymentState & Partial<MethodDraftMeta>,
      items: CartItem[],
      total: number,
    ) {
      if (s.status === "processing") return; // guard line: no double-submit
      s.status = "processing";

      // Step 1: Reserve inventory
      try {
        await inventory.reserve(items);
      } catch (e) {
        s.status = "failed";
        s.error = (e as Error).message;
        return;
      }

      // Step 2: Charge the card
      try {
        const { chargeId } = await chargeCard(total);
        if (s.$signal?.aborted) {
          // cart.clear fired mid-charge -- release and stop
          await inventory.release(items);
          s.status = "idle";
          return;
        }
        // Step 3: Confirm
        s.status = "confirmed";
        s.chargeId = chargeId;
      } catch (e) {
        // Charge failed -- release inventory before reporting failure
        await inventory.release(items);
        s.status = "failed";
        s.error = (e as Error).message;
      }
    },
  },
});
```

Three steps, two failure paths, automatic cleanup — in standard JavaScript.

Each `await` boundary commits a batch: the trigger `payment:process` plus one
`payment:__setProcess` batch per step, all visible in time-travel.

> **`cancelOn: { process: [cart.clear] }`** -- if the user clears their cart
> mid-payment, the in-flight method's `s.$signal` aborts. Check
> `s.$signal?.aborted` after awaits before writing terminal state (and pass the
> signal to abortable IO like `fetch`). Pass bound methods (not strings) for
> refactor safety. The `& Partial<MethodDraftMeta>` annotation (from `aio`)
> types `s.$signal`.

---

## Step 4: Cross-cell coordination

The payment method calls inventory directly: `await inventory.reserve(items)`.
After `aio.run()`, this dispatches a real `inventory:reserve` action through the
store -- typed, awaitable, visible in time-travel.

For resilience, add timeout and retries with `call()`:

```ts
import { call } from "aio";
const reserved = await call(
  { timeout: 5000, retries: 2 },
  () => inventory.reserve(items),
);
```

> **Direct calling:** Request/response style — call a method, get a result.
> Cross-cell communication uses direct method calls.

---

## Step 5: Guard lines

Prevent double-submit. A user clicking "Pay" twice shouldn't trigger two
charges. The guard is already in the method — one line:

```ts
async process(s, items: CartItem[], total: number) {
  if (s.status === "processing") return; // second call is a no-op
  s.status = "processing";
  // ...
},
```

The `status` field controls what can happen when:

- **`idle`**: `process` runs (start checkout), `reset` allowed
- **`processing`**: second `process` call returns early -- no double-submit;
  `cart.clear` aborts via `cancelOn`
- **`confirmed`** / **`failed`**: `process` may run again (retry) or `reset`
  starts over

Server-side enforcement, plain code — the same `if` runs no matter which client
dispatched.

---

## Step 6: AIR UI

Wire the cells into a component:

```tsx
// App.tsx
import { cart, type CartItem } from "./cell/cart/index.ts";
import { payment } from "./cell/payment/index.ts";

export default function App() {
  return (
    <div>
      <h1>Checkout</h1>

      <section>
        <h2>Cart ({cart.items.length} items)</h2>
        <button
          onClick={() =>
            cart.add({ id: "widget", name: "Widget", price: 25, qty: 1 })}
        >
          Add Widget ($25)
        </button>
        <ul>
          {cart.items.map((item: CartItem) => (
            <li key={item.id}>
              {item.name} x{item.qty} = ${item.price * item.qty}
              <button onClick={() => cart.remove(item.id)}>Remove</button>
            </li>
          ))}
        </ul>
        <p>Total: ${cart.total}</p>
        {cart.items.length > 0 && (
          <button onClick={() => cart.clear()}>Clear Cart</button>
        )}
      </section>

      <section>
        <h2>Payment ({payment.status})</h2>
        {payment.error && <p style={{ color: "red" }}>{payment.error}</p>}
        {payment.chargeId && <p>Charge ID: {payment.chargeId}</p>}

        {cart.items.length > 0 && (
          <button
            onClick={() =>
              payment.process(
                cart.items as CartItem[],
                cart.total as number,
              )}
          >
            Pay ${cart.total}
          </button>
        )}
        <button onClick={() => payment.reset()}>Start Over</button>
      </section>
    </div>
  );
}
```

Direct cell access gives you typed state properties and typed methods. The
`status` field drives both the UI (`{payment.status}`) and the server-side guard
-- `process` while `processing` is a no-op. Defense in depth.

Boot it:

```ts
// app.ts
import { aio } from "aio";
import { cart } from "./cell/cart/index.ts";
import { inventory } from "./cell/inventory/index.ts";
import { payment } from "./cell/payment/index.ts";

await aio.run({ appId: "checkout", cells: [cart, inventory, payment] });
```

---

## Step 7: Testing the flow

```ts
// cell/payment/payment.test.ts
import { testCell } from "aio";
import { payment } from "./index.ts";

const ITEMS = [{ id: "widget", name: "Widget", price: 25, qty: 1 }];

testCell(payment, "happy path: reserve + charge + confirm", async (t) => {
  t.init();
  t.send.process(ITEMS, 25);
  await t.settle();
  t.expect.state((s) => s.status === "confirmed");
  t.expect.state((s) => s.chargeId !== null);
  t.expect.state((s) => s.error === null);
});

testCell(payment, "charge failure releases inventory", async (t) => {
  t.init();
  t.send.process(ITEMS, 15000); // > 10000 triggers simulated card decline
  await t.settle();
  t.expect.state((s) => s.status === "failed");
  t.expect.state((s) => s.error === "Card declined");
});

testCell(payment, "guard line blocks double-submit", async (t) => {
  t.init();
  t.send.process(ITEMS, 25);
  t.expect.state((s) => s.status === "processing");
  t.send.process(ITEMS, 25); // guard line returns early
  t.expect.state((s) => s.status === "processing"); // not restarted
  await t.settle();
});
```

Each `testCell` wraps `Deno.test` with a fresh instance. `t.settle()` runs
effects and drains async. No teardown.

---

## Step 8: Time-travel debugging

The trigger and every `await`-boundary batch dispatch a named action. Open the
time-travel panel (Ctrl+.) and you see the checkout sequence:

```
1. payment:process        -- trigger
2. payment:__setProcess   -- status = 'processing'
3. inventory:reserve      -- cross-cell call
4. payment:__setProcess   -- status = 'confirmed', chargeId set
```

Click any step to see the state at that point — what items looked like before
reservation, or what stock levels were before release.

On failure, the trail tells the story: `inventory:reserve` (threw "Insufficient
stock"), then `payment:__setProcess` (status = 'failed', error set). You see
exactly where it failed and that cleanup ran. No log diving.

> **State snapshots.** Time-travel keeps the last 200 state snapshots in dev
> mode.

---

## What you built

Three cells, each self-contained, coordinating through typed method calls:

| Concept            | Where it shows up                                        |
| ------------------ | -------------------------------------------------------- |
| Workflow method    | `payment.process` -- multi-step async, top-to-bottom     |
| Cross-cell calling | `await inventory.reserve(items)` inside the method       |
| `cancelOn`         | `cart.clear` aborts the payment method via `s.$signal`   |
| Guard line         | `if (s.status === "processing") return` -- no double-pay |
| Error recovery     | Charge failure triggers `inventory.release()` cleanup    |
| Time-travel        | Trigger + every `await` batch is a named action          |

The whole checkout flow is one async method. Read `process` top to bottom and
you know everything that can happen.

---

## Next steps

- [Methods](../state/methods.md) -- workflows (`until`/`race`/`sleep`),
  cancellation, guard lines
- [Cells](../state/cells.md) -- all inter-cell patterns (observe, read,
  coordinate)
- [Testing](../testing/cell-testing.md) -- TestContext API, property-based
  fuzzing
- [Debugging](../debugging/errors.md) -- error identification, performance
  debugging
