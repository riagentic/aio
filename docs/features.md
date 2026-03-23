# Features

How features work, how they work together, and how to keep it all under control.

For the docs index, see [manual.md](manual.md). For the API reference
(`feature()`, `call()`), see [core.md](core.md). For testing, see
[testing.md](testing.md). For debugging, see [debugging.md](debugging.md).

## What is a feature?

A feature is a self-contained unit: its own state slice, actions, effects,
machine guards, reducer, and executor. Features don't share state — they
communicate through well-defined interaction patterns.

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   counter    │     │   wallet    │     │  analytics  │
│             │     │             │     │             │
│ state:      │     │ state:      │     │ state:      │
│  { count }  │     │  { balance }│     │  { events } │
│             │     │             │     │             │
│ actions:    │     │ actions:    │     │ actions:    │
│  increment  │     │  deposit    │     │  track      │
│  reset      │     │  withdraw   │     │             │
│             │     │             │     │ listens to: │
│ machine:    │     │ machine:    │     │  counter:*  │
│  idle→saving│     │  idle→busy  │     │  wallet:*   │
└─────────────┘     └─────────────┘     └─────────────┘
        │                   │                   ▲
        └───────────────────┴───────────────────┘
                    dispatch loop
```

Every feature produces a `FeatureDef` regardless of which style you use
(`feature({ methods })`, `feature({ actions, reduce })`, or generators). They
all compose the same way.

## Three ways features interact

| Pattern                                              | What                                     | When                                     |
| ---------------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| [Observe](#1-observe--react-to-actions)              | React when another feature dispatches    | Sync state sync, analytics, side-effects |
| [Read](#2-read--selectors)                           | Read another feature's derived state     | UI display, computed values              |
| [Coordinate](#3-coordinate--trigger-another-feature) | Actively trigger or call another feature | Effects, async workflows, orchestration  |

**Observe** and **Read** are passive — your feature reacts to or reads other
features. **Coordinate** is active — your feature makes something happen in
another feature.

Within Coordinate, choose the right tool:

- **dispatchTo / ctx.dispatch** — fire-and-forget action (sync, no result)
- **call()** — async method call, awaits completion and return value
- **call({ timeout, retries })** — resilient request/response (replaces
  bridge())

---

## 1. Observe — react to actions

A feature's machine declares that it cares about another feature's actions. The
framework routes that action to both the owner and all listeners.

```ts
import { counter } from "../counter/index.ts";

const analytics = feature("analytics", {
  state: { events: [] as string[] },
  actions: {
    trackEvent: (name: string) => ({ name }),
  },
  machine: {
    initial: "active",
    states: {
      active: {
        trackEvent: "active",
        [counter.increment.type]: "active", // listen to counter — use .type
        [counter.reset.type]: "active", // listen to counter — use .type
      },
    },
  },
  reduce: {
    trackEvent(state, payload) {
      (state.events as string[]).push(payload.name);
    },
  },
});
```

**Object-form reduce supports computed keys for foreign actions** — no raw
strings or function form required:

```ts
import { counter } from '../counter'

reduce: {
  // Own actions — by name
  track(state, payload) { state.events.push(payload.event) },

  // Foreign actions — by computed .type key
  [counter.increment.type](state, payload) {
    state.events.push(`counter incremented by ${payload.by}`)
  },
},
```

For foreign action handling using the function form with `{ on }`:

```ts
reduce(state, action, { on }) {
  on(counter.increment, () => {
    (state.events as string[]).push('counter:increment')
  })
  on(counter.reset, () => {
    (state.events as string[]).push('counter:reset')
  })
},
```

**How it works:**

1. `counter.increment.type` evaluates to `'counter:increment'` — a string
   constant
2. The framework detects the `:` and sees it doesn't start with `analytics:` —
   it's foreign
3. When `counter:increment` is dispatched, the framework reduces it in `counter`
   first (the owner), then in `analytics` (the listener)
4. Both features see the same action; the listener runs after the owner

**Rules:**

- Foreign actions must be declared in the machine's `states.*.on` — the
  framework scans these at compose time
- The listener's reducer receives the full action (type + payload) from the
  owner
- If the listener is disabled, it's skipped
- Order: owner reduces first, then listeners (in compose order)

**Use `.type` on bound methods instead of raw strings** — you get autocomplete,
refactor safety, and no typo risk.

### Reactive features as listeners

Reactive features can listen too. The simplest way is `listensTo`:

```ts
const logger = feature("logger", {
  state: { log: [] as string[] },
  // Pass bound methods directly — refactor-safe, no raw strings
  listensTo: [counter.increment, counter.reset],
  methods: {
    clear(s) {
      s.log = [];
    },
  },
});
```

`listensTo` auto-generates a minimal machine with self-loop transitions — no
need to write `machine: { initial: 'on', states: { on: { action: 'on' } } }` by
hand.

For features that also need real machine states, declare foreign actions in the
machine directly:

```ts
const logger = feature("logger", {
  state: { log: [] as string[] },
  machine: {
    initial: "on",
    states: {
      on: {
        clear: "on",
        [counter.increment.type]: "on", // use .type
      },
    },
  },
  methods: {
    clear(s) {
      s.log = [];
    },
  },
});
```

---

## 2. Read — selectors

Selectors expose derived state that any component can read. They don't create
feature coupling — they're read-only views.

```ts
const counter = feature("counter", {
  state: { count: 0, limit: 100 },
  selectors: {
    remaining: (s: { count: number; limit: number }) => s.limit - s.count,
  },
});

// After aio.run(), callable directly:
counter.remaining(); // → 100
```

**Cross-feature selector use** — one component reads from multiple features:

```tsx
export default function Dashboard() {
  const c = useFeature(counter);
  const w = useFeature(wallet);
  if (!c.state || !w.state) return <div>Loading...</div>;

  return (
    <div>
      <p>Counter remaining: {counter.remaining()}</p>
      <p>Wallet balance: {w.state.balance}</p>
    </div>
  );
}
```

Selectors are memoized per render cycle. They don't push updates — React
re-evaluates them on each state change via `useFeature()`.

---

## 3. Coordinate — trigger another feature

### dispatchTo — fire and forget

When an executor needs to tell another feature to do something, declare it in
`dispatchTo`:

```ts
import { wallet } from "../wallet";
import { inventory } from "../inventory";

const checkout = feature("checkout", {
  // ...
  dispatchTo: [wallet, inventory],
  execute: {
    paymentComplete(app, payload) {
      app.dispatch(wallet.credit(payload.amount)); // allowed
      app.dispatch(inventory.reserve(payload.itemId)); // allowed
      app.dispatch(shipping.schedule(payload.orderId)); // BLOCKED
    },
  },
});
```

**What happens when blocked:**

```
[checkout] dispatch('shipping:schedule') blocked — add shipping to dispatchTo
```

The action is dropped, an error is counted in the feature's health, and a
console error is logged.

**Rules:**

- Without `dispatchTo`, an executor can only dispatch its own actions
- `dispatchTo` takes imported feature objects: `[wallet, inventory]` not
  `['wallet', 'inventory']`
- The dispatched action goes through the normal dispatch loop — the target's
  machine guards still apply
- `app.getState()` in an executor returns only this feature's slice, not the
  full state

### Why the restriction?

Without it, any feature could dispatch to any other feature. Debugging becomes
"who changed my state?" with no trail. `dispatchTo` makes inter-feature data
flow **explicit and grep-able** — you can trace every cross-feature dispatch by
searching for `dispatchTo:`.

---

### Direct cross-feature calling

Import any feature and call its async methods directly — fully typed, awaitable,
store-observable:

```ts
import { inventory } from "../inventory";
import { pricing } from "../pricing";

export const orders = feature("orders", {
  state: { orderId: null as string | null, total: 0 },
  methods: {
    async placeOrder(s, items: Item[]) {
      const reserved = await inventory.reserve(items); // typed Promise<ReserveResult>
      const price = await pricing.calculate(reserved); // typed Promise<PriceResult>
      s.orderId = reserved.orderId;
      s.total = price.total;
    },
  },
});
```

Each `await feature.method()` dispatches a real action through the store
(`inventory:reserve`), appears in time-travel, and resolves with the method's
return value. No strings, no `call()` import needed.

> **Self-imports are safe.** Importing your own feature file
> (`import { orders } from './index'`) looks circular but works correctly in
> Deno and Node — the module is fully initialized before any method is called.
> This is the intended pattern for calling your own feature's methods.

### call() with timeout and retries

When you need timeout/retry on top of direct calling, use `call()` callback
form:

```ts
import { call } from 'aio'

async placeOrder(s, items: Item[]) {
  // Callback form — direct call wrapped with resilience
  const reserved = await call({ timeout: 5000, retries: 2 }, () => inventory.reserve(items))
  s.step = 'done'
}
```

- **`timeout`** — rejects after N ms, cleans up the pending entry
- **`retries`** — retries on any failure up to N times

For circuit breaking, implement it as a regular feature — it's observable,
testable, and appears in time-travel like any other state.

---

### ctx.dispatch in generators

Generators can dispatch actions to any feature via `ctx.dispatch()`:

```ts
const order = feature("order", {
  // ...
  actions: {
    start: (amount: number, itemId: string) => ({ amount, itemId }),
  },
  generators: {
    // actions-style: payload object passed directly — destructure it
    start: function* (
      ctx,
      { amount, itemId }: { amount: number; itemId: string },
    ) {
      const payment = yield* ctx.call("pay", () => processPayment(amount));

      // Dispatch to another feature
      yield* ctx.dispatch(inventory.reserve(itemId));
      yield* ctx.dispatch(analytics.trackEvent("checkout_complete"));

      yield* ctx.done((s) => {
        s.orderId = payment.id;
      });
    },
  },
});
```

**`ctx.dispatch()` bypasses `dispatchTo`** — it dispatches directly to the
global dispatch loop. The action is tagged with `_source: 'Effect'` and appears
in time-travel history.

### `ctx.waitFor` — pause until external action

Generators can also wait for actions from other features:

```ts
const checkout = feature("checkout", {
  // ...
  actions: {
    start: (amount: number) => ({ amount }),
  },
  generators: {
    start: function* (ctx, { amount }: { amount: number }) {
      yield* ctx.dispatch(payment.charge(amount));

      // Pause until payment completes or times out
      // Pass the bound function directly — no strings
      try {
        const result = yield* ctx.waitFor(payment.complete); // bound fn — preferred
        yield* ctx.done((s) => {
          s.paid = true;
        });
      } catch {
        yield* ctx.fail("payment timed out");
      }
    },
  },
});
```

`ctx.waitFor(actionType, timeout?)` registers a one-shot listener on the
dispatch loop. When the matching action fires, the generator resumes with the
full action object. Optional timeout throws on expiry (catchable via try/catch).

Use this for orchestration generators that need to coordinate multiple features
in sequence.

---

### Cross-feature calling — the complete picture

**Default: direct import + call (80% of cases)**

```ts
import { inventory } from "../inventory";
import { notifications } from "../notifications";

const checkout = feature("checkout", {
  state: { step: "idle" as string },
  methods: {
    async placeOrder(s, items: Item[]) {
      const reserved = await inventory.reserve(items); // Promise<ReserveResult> — typed
      await notifications.send("Order confirmed"); // dispatches through the store
      s.step = "done";
    },
  },
});
```

**How it works:**

1. Calling `inventory.reserve(items)` dispatches a real action
   (`inventory:reserve`) through the store
2. Fully observable — appears in time-travel, interceptable by middleware
3. Returns a `Promise<ReturnType>` — properly typed, no cast needed
4. Rejects if blocked by machine guard, feature disabled, or method not async

Every bound method also has a `.type` property — use it anywhere you need the
action type string:

```ts
// No raw strings anywhere:
if (action.type === inventory.reserve.type) { ... }    // 'inventory:reserve'
listensTo: [inventory.reserve, orders.place]           // pass functions directly
cancelOn: { start: [orders.cancel] }                   // config key, pass function not string
yield* ctx.waitFor(gateway.connected)                  // bound fn — preferred
```

**With timeout/retry:**

```ts
import { call } from "aio";

const reserved = await call(
  { timeout: 5000, retries: 2 },
  () => inventory.reserve(items),
);
```

| Option    | Type          | Effect                                     |
| --------- | ------------- | ------------------------------------------ |
| `timeout` | `number` (ms) | Rejects if method doesn't complete in time |
| `retries` | `number`      | Retries on failure up to N times           |

**Rules:**

- Usable anywhere after `aio.run()` — async methods, execute functions, app code
- Target method must be async
- TypeScript infers return type automatically from direct calling

---

## Composition and startup

### Feature array

```ts
await aio.run({
  features: [counter, wallet, analytics, priceBridge],
});
```

### Dependencies

Declare init order when one feature needs another to be ready first:

```ts
await aio.run({
  features: [
    counter,
    { feature: wallet, dependsOn: ["counter"] },
    { feature: analytics, dependsOn: ["counter", "wallet"] },
  ],
});
```

- Init runs in topological order: `counter` → `wallet` → `analytics`
- Destroy runs in reverse: `analytics` → `wallet` → `counter`
- Cycles throw: `dependency cycle: a → b → c → a`
- Missing deps throw: `[wallet] depends on unknown feature 'missing'`
- Duplicates throw: `duplicate feature name: 'counter'`

### onInit and onDestroy hooks

```ts
const ws = feature("ws", {
  onInit(app) {
    // Called after all dependencies are initialized
    // app.dispatch and app.getState are scoped to this feature
    startWebSocket(app);
  },
  onDestroy(app) {
    // Called before feature state is reset
    closeWebSocket();
  },
});
```

---

## Runtime control

After `aio.run()`, you can inspect and control features at runtime:

```ts
const app = await aio.run({ features: [counter, wallet, analytics] });

app.features!.list(); // ['counter', 'wallet', 'analytics']
app.features!.status("counter"); // 'idle' | 'saving' | 'error' | ...
app.features!.health(); // [{ name, status, enabled, errors, lastAction, lastActionAt }]
app.features!.disable("analytics"); // stops routing, cancels flows, dispatches Destroy
app.features!.enable("analytics"); // re-enables, dispatches Init, resets state
```

### What disable does

1. Feature's actions are no longer routed (own and foreign)
2. Feature's effects are not executed
3. Running flows are cancelled
4. Scheduled effects are cancelled
5. Destroy hook runs, `feature:__destroy` action dispatches
6. Feature state resets to initial

### What enable does

1. Feature is re-added to routing
2. Error counter resets
3. `feature:__init` action dispatches
4. Init hook runs
5. State starts fresh from initial state

### Health monitoring

```ts
const health = app.features!.health();
// [
//   { name: 'counter', status: 'idle', enabled: true, errors: 0,
//     lastAction: 'counter:increment', lastActionAt: 1710000000000 },
//   { name: 'wallet', status: 'saving', enabled: true, errors: 1,
//     lastAction: 'wallet:save', lastActionAt: 1710000001000 },
// ]
```

Also available over HTTP: `GET /__aio/health` returns the same data as JSON.

**Error tracking:** Every blocked `dispatchTo`, onInit/onDestroy failure, or
executor crash increments the feature's error count. Check `errors` in health
output to spot features that are misbehaving.

---

## Middleware

Middleware intercepts all actions before they reach any feature's reducer:

```ts
await aio.run({
  features: [counter, wallet],
  middleware: [
    aio.middleware.logger(), // log all actions
    aio.middleware.validate(), // reject malformed actions
    aio.middleware.metrics(), // track action counts per feature
  ],
});
```

Middleware runs in order. Each receives `(action, state, user?)` and returns the
action (possibly modified) or `null` to drop it. The `user` parameter is the
`AioUser` from the WebSocket connection.

### Custom middleware

```ts
aio.middleware.create((action, state, next, user) => {
  // Drop admin actions from non-admin users
  if (action.type.startsWith("Admin:") && user?.role !== "admin") return null;
  // Log slow actions
  const start = performance.now();
  const result = next(action);
  const elapsed = performance.now() - start;
  if (elapsed > 50) {
    console.warn(`Slow action: ${action.type} (${elapsed.toFixed(1)}ms)`);
  }
  return result;
});
```

Middleware sees actions across all features — it's the right place for
cross-cutting concerns like auth, logging, and rate limiting.

---

## State filtering for clients

`stateForUI` controls what each browser client receives:

```ts
await aio.run({
  features: [shop, auth, admin],
  stateForUI: (state, user?) => ({
    auth: state.auth,
    shop: state.shop,
    admin: user?.role === "admin" ? state.admin : undefined,
  }),
});
```

- Called per client on every state broadcast
- Each client has its own delta cache — filtered features cost zero bandwidth
- `user` is `undefined` in public mode (no `users` config)
- If `stateForUI` throws, that client is skipped

---

## Architecture decision guide

### How should my features talk to each other?

```
Feature A needs to...                  → Use this pattern
─────────────────────────────────────────────────────────────
React when B dispatches                → Observe: foreign listeners
Read B's derived state                 → Read: selectors
Tell B to do something (no result)     → Coordinate: dispatchTo or ctx.dispatch
Call B's async method, get result      → Coordinate: await b.method() — direct import
Request with retries/timeout           → Coordinate: call({ timeout, retries }, () => b.method())
Filter what clients see                → stateForUI
Intercept all actions globally         → Middleware
```

### Keep features independent

The best feature is one that doesn't know other features exist. The second-best
feature is one that knows about others through a single, explicit pattern.

**Signs of healthy architecture:**

- Most features have no `dispatchTo` and no foreign listeners
- `call()` with options is used sparingly (1-2 per app, not per feature)
- `stateForUI` is a flat mapping, not complex logic
- You can `testFeature()` each feature in isolation without mocking others

**Signs of trouble:**

- A feature has `dispatchTo: [a, b, c, d]` with 4+ targets — it's doing too much
- Multiple features listen to each other's actions in a circle — untangle the
  dependency
- A bridge exists between features that could just use a foreign listener —
  bridges are for async coordination, not observation
- `stateForUI` is 50 lines of conditional logic — split features differently

### Tracking data flow

Every interaction is visible:

1. **Time-travel panel** (Ctrl+.) — see every action, who dispatched it, and
   what state changed
2. **`app.features.health()`** — error counts, last action per feature
3. **`GET /__aio/health`** — same health data over HTTP
4. **`aio.middleware.logger()`** — logs every action with feature prefix
5. **`dispatchTo` errors** — blocked dispatches are logged with the exact fix
   needed

The action type prefix (`counter:increment`, `wallet:transfer`) tells you which
feature owns the action. The `_source` field tells you who dispatched it (`UI`,
`Effect`, `System`, `Test`). Together they answer "what happened and why" for
every state change.

---

## App version

Track your app version for startup logging:

```ts
await aio.run({
  features: [counter, wallet],
  appVersion: "2.0.0",
});
```

`appVersion` is a simple string logged on startup and stored in
`__aio.appVersion`. Default is `'0.1.0 (default)'`. It is not persisted.
