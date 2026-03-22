# Multi-Feature Checkout Workflow

Build an e-commerce checkout: cart, inventory, payment -- three features coordinating through generators, direct calling, and machine guards. Covers generators, cross-feature `call()`, `cancelOn`, machine guards, error recovery, and testing.

Prerequisites: [quickstart.md](../quickstart.md) done, one feature under your belt.

---

## Step 1: Cart feature

The cart is pure sync state -- add items, remove them, compute a total.

```ts
// features/cart/index.ts
import { feature } from 'aio'

export type CartItem = { id: string; name: string; price: number; qty: number }

export const cart = feature('cart', {
  state: {
    items: [] as CartItem[],
    total: 0,
  },
  methods: {
    add(s, item: CartItem) {
      const existing = (s.items as CartItem[]).find(i => i.id === item.id)
      if (existing) {
        existing.qty += item.qty
      } else {
        (s.items as CartItem[]).push(item)
      }
      s.total = (s.items as CartItem[]).reduce((sum, i) => sum + i.price * i.qty, 0)
    },
    remove(s, id: string) {
      s.items = (s.items as CartItem[]).filter(i => i.id !== id)
      s.total = (s.items as CartItem[]).reduce((sum, i) => sum + i.price * i.qty, 0)
    },
    clear(s) {
      s.items = []
      s.total = 0
    },
  },
})
```

No async, no machine. Methods mutate via Immer drafts. `clear` matters later -- it becomes a cancellation trigger for the payment generator.

---

## Step 2: Inventory feature

`reserve` is async (API call) and can fail. The payment generator needs to know when it does.

```ts
// features/inventory/index.ts
import { feature } from 'aio'
import type { CartItem } from '../cart/index.ts'

type StockMap = Record<string, number>

export const inventory = feature('inventory', {
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

Notice `reserve` throws on insufficient stock. The payment generator will catch this. `release` exists for cleanup -- if payment fails after reservation, we return the stock. Both are single-step operations, so async methods are the right tool. Save generators for multi-step workflows.

---

## Step 3: Payment feature with generator

Payment is a multi-step workflow: reserve inventory, charge card, confirm. Each step is observable, cancellable, and recoverable.

```ts
// features/payment/index.ts
import { feature } from 'aio'
import { inventory } from '../inventory/index.ts'
import { cart } from '../cart/index.ts'
import type { CartItem } from '../cart/index.ts'

// Simulated payment API
async function chargeCard(total: number): Promise<{ chargeId: string }> {
  await new Promise(r => setTimeout(r, 500))
  if (total > 10000) throw new Error('Card declined')
  return { chargeId: `ch_${Date.now()}` }
}

export const payment = feature('payment', {
  state: {
    status: 'idle' as 'idle' | 'processing' | 'confirmed' | 'failed',
    chargeId: null as string | null,
    error: null as string | null,
  },
  methods: {
    reset(s) {
      s.status = 'idle'
      s.chargeId = null
      s.error = null
    },
  },
  generators: {
    *process(ctx, items: CartItem[], total: number) {
      yield* ctx.mutate('start', s => { s.status = 'processing' })

      // Step 1: Reserve inventory
      try {
        yield* ctx.call('reserve', () => inventory.reserve(items))
      } catch (e) {
        yield* ctx.mutate('reserveFailed', s => {
          s.status = 'failed'
          s.error = (e as Error).message
        })
        yield* ctx.fail('inventory reservation failed')
        return
      }

      // Step 2: Charge the card
      try {
        const result = yield* ctx.call('charge', () => chargeCard(total))
        const { chargeId } = result as { chargeId: string }

        // Step 3: Confirm
        yield* ctx.done(s => {
          s.status = 'confirmed'
          s.chargeId = chargeId
        })
      } catch (e) {
        // Charge failed -- release inventory before reporting failure
        yield* ctx.call('releaseInventory', () => inventory.release(items))
        yield* ctx.mutate('chargeFailed', s => {
          s.status = 'failed'
          s.error = (e as Error).message
        })
        yield* ctx.fail('payment charge failed')
      }
    },
  },
  cancelOn: {
    process: [cart.clear],
  },
})
```

Read this top to bottom -- that is the checkout flow. Three steps, two failure paths, automatic cleanup.

The framework auto-generates actions from each `yield*`: `payment:process` (trigger), `payment:__flow:reserve`, `payment:__flow:charge`, `payment:__flow:done` or `payment:__flow:failed`. Every step appears in time-travel.

> **`cancelOn: { process: [cart.clear] }`** -- if the user clears their cart mid-payment, the generator is cancelled immediately. No charge, no stuck state. Pass bound methods (not strings) for refactor safety.

---

## Step 4: Cross-feature coordination

The payment generator calls inventory directly via `ctx.call('reserve', () => inventory.reserve(items))`. After `aio.run()`, this dispatches a real `inventory:reserve` action through the store -- typed, awaitable, visible in time-travel.

For resilience, add timeout and retries:

```ts
// In generators:
yield* ctx.call('reserve', () => inventory.reserve(items), { timeout: 5000, retries: 2 })

// In async methods:
import { call } from 'aio'
const reserved = await call({ timeout: 5000, retries: 2 }, () => inventory.reserve(items))
```

> **Direct calling vs `dispatchTo`:** Direct calling is request/response -- you need the result. `dispatchTo` is fire-and-forget from executors. Payment needs to know if reservation succeeded, so direct calling is the right choice.

---

## Step 5: Machine guards

Prevent double-submit. A user clicking "Pay" twice shouldn't trigger two charges. Add a machine:

```ts
// Add these keys to the payment feature from Step 3:
export const payment = feature('payment', {
  // ... state, methods, generators, cancelOn from Step 3, plus:
  machine: {
    initial: 'idle',
    states: {
      idle:       { process: 'processing', reset: 'idle' },
      processing: { [cart.clear.type]: 'idle' },
      confirmed:  { reset: 'idle' },
      failed:     { process: 'processing', reset: 'idle' },
    },
  },
  listensTo: [cart.clear],
})
```

The machine controls what can happen when:

- **`idle`**: `process` allowed (start checkout), `reset` allowed
- **`processing`**: only `cart.clear` allowed (cancel). Second `process` call is silently dropped -- no double-submit
- **`confirmed`**: only `reset` allowed (start over)
- **`failed`**: `process` allowed (retry), `reset` allowed

Notice `[cart.clear.type]: 'idle'` in the `processing` state. This is a foreign action -- when `cart.clear` dispatches anywhere in the app, the payment machine transitions back to `idle`. Combined with `cancelOn`, this both cancels the generator and resets the machine state.

`listensTo: [cart.clear]` tells the framework to route `cart:clear` actions to this feature. Without it, foreign actions are ignored.

---

## Step 6: React UI

Wire the features into a React component:

```tsx
// App.tsx
import { useFeature } from 'aio'
import { cart, type CartItem } from './features/cart/index.ts'
import { payment } from './features/payment/index.ts'

export default function App() {
  const c = useFeature(cart)
  const p = useFeature(payment)
  if (!c.state || !p.state) return <div>Connecting...</div>

  return (
    <div>
      <h1>Checkout</h1>

      <section>
        <h2>Cart ({c.state.items.length} items)</h2>
        <button onClick={() => c.send.add({ id: 'widget', name: 'Widget', price: 25, qty: 1 })}>
          Add Widget ($25)
        </button>
        <ul>
          {c.state.items.map((item: CartItem) => (
            <li key={item.id}>
              {item.name} x{item.qty} = ${item.price * item.qty}
              <button onClick={() => c.send.remove(item.id)}>Remove</button>
            </li>
          ))}
        </ul>
        <p>Total: ${c.state.total}</p>
        {c.state.items.length > 0 && (
          <button onClick={() => c.send.clear()}>Clear Cart</button>
        )}
      </section>

      <section>
        <h2>Payment: {p.status}</h2>
        {p.state.error && <p style={{ color: 'red' }}>{p.state.error}</p>}
        {p.state.chargeId && <p>Charge ID: {p.state.chargeId}</p>}

        {p.status === 'idle' && c.state.items.length > 0 && (
          <button onClick={() =>
            p.send.process(c.state!.items as CartItem[], c.state!.total as number)
          }>Pay ${c.state.total}</button>
        )}
        {p.status === 'processing' && <p>Processing...</p>}
        {p.status === 'failed' && (
          <button onClick={() =>
            p.send.process(c.state!.items as CartItem[], c.state!.total as number)
          }>Retry</button>
        )}
        {(p.status === 'confirmed' || p.status === 'failed') && (
          <button onClick={() => p.send.reset()}>Start Over</button>
        )}
      </section>
    </div>
  )
}
```

`useFeature` gives you `state`, `send` (typed dispatchers), and `status` (current machine state). The machine status drives the UI -- the Pay button only renders in `idle` state, and the machine silently drops `process` in `processing` state. Defense in depth.

Boot it:

```ts
// app.ts
import { aio } from 'aio'
import { cart } from './features/cart/index.ts'
import { inventory } from './features/inventory/index.ts'
import { payment } from './features/payment/index.ts'

await aio.run({ appId: 'checkout', features: [cart, inventory, payment] })
```

---

## Step 7: Testing the flow

```ts
// features/payment/payment.test.ts
import { testFeature } from 'aio'
import { payment } from './index.ts'

const ITEMS = [{ id: 'widget', name: 'Widget', price: 25, qty: 1 }]

testFeature(payment, 'happy path: reserve + charge + confirm', async (t) => {
  t.init()
  t.send.process(ITEMS, 25)
  await t.settle()
  t.expect.status('confirmed')
  t.expect.state(s => s.chargeId !== null)
  t.expect.state(s => s.error === null)
})

testFeature(payment, 'charge failure releases inventory', async (t) => {
  t.init()
  t.send.process(ITEMS, 15000)  // > 10000 triggers simulated card decline
  await t.settle()
  t.expect.status('failed')
  t.expect.state(s => s.error === 'Card declined')
})

testFeature(payment, 'cart clear cancels in-progress payment', async (t) => {
  t.init()
  t.send.process(ITEMS, 25)
  t.send.reset()  // cancel mid-flight (in full app, cart.clear() triggers cancelOn)
  t.expect.status('idle')
})

testFeature(payment, 'machine blocks double-submit', (t) => {
  t.init()
  t.send.process(ITEMS, 25)
  t.expect.status('processing')
  t.send.process(ITEMS, 25)           // silently dropped by machine
  t.expect.status('processing')       // not restarted
})
```

Each `testFeature` wraps `Deno.test` with a fresh instance. `t.settle()` runs effects and drains async. No teardown.

---

## Step 8: Time-travel debugging

Every generator step dispatches a named action. Open the time-travel panel (Ctrl+.) and you see the full checkout sequence:

```
1. payment:process              -- trigger
2. payment:__flow:start         -- status = 'processing'
3. payment:__flow:reserve       -- inventory.reserve() called
4. payment:__flow:charge        -- chargeCard() called
5. payment:__flow:done          -- status = 'confirmed', chargeId set
```

Click any step to see the state at that point. Click step 3 to see state after reservation but before charge. This is the power of generators -- each `yield*` is a named, observable checkpoint.

On failure, the trail tells the story: `payment:__flow:charge` (threw "Card declined"), then `payment:__flow:releaseInventory` (cleanup ran), then `payment:__flow:failed` (terminal). You see exactly where it failed and that cleanup happened. No log diving.

> **State snapshots.** Time-travel keeps the last 200 state snapshots in dev mode. Jump back to any step to inspect what items looked like before reservation, or what stock levels were before release.

---

## What you built

Three features, each self-contained, coordinating through typed method calls:

| Concept | Where it shows up |
|---------|-------------------|
| Generators | `payment.*process` -- multi-step async, top-to-bottom |
| Cross-feature calling | `inventory.reserve(items)` inside `ctx.call` |
| `cancelOn` | `cart.clear` cancels the payment generator |
| Machine guards | `processing` state drops duplicate `process` calls |
| Foreign actions | `[cart.clear.type]` transitions payment machine |
| Error recovery | Charge failure triggers `inventory.release()` cleanup |
| Time-travel | Every `yield*` is a named action in history |

The generator replaced what would otherwise be scattered across actions, effects, executor cases, and machine states. Read the `*process` function and you know the entire checkout flow.

---

## Next steps

- [generators.md](../generators.md) -- full GenCtx API, `ctx.all`, `ctx.race`, reusable generators
- [features.md](../features.md) -- all inter-feature patterns (observe, read, coordinate)
- [testing.md](../testing.md) -- TestContext API, property-based fuzzing
- [debugging.md](../debugging.md) -- error identification, performance debugging
