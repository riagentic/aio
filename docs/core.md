# Core API

Everything is a feature. This page covers all config options for `feature()`.

For the docs index, see [manual.md](manual.md). For generator workflows, see
[generators.md](generators.md). For testing, see [testing.md](testing.md).

## Architecture — Data Flow

```
  UI (React / Svelte / Vue)          Server (Deno)
  ─────────────────────────          ──────────────────────────────────

  user clicks button
       │
       ▼
  send(action) ──── WebSocket ────▶  dispatch(action)
                                          │
                                          ▼
                                     beforeReduce(action, state)
                                          │  (null → drop)
                                          ▼
                                     ┌─────────────┐
                                     │  Machine     │  state guard:
                                     │  (optional)  │  is this action
                                     │              │  allowed in the
                                     └──────┬───────┘  current state?
                                            │
                                            ▼
                                     reduce(state, action)
                                       │         │
                                       │         ▼
                                       │    returns effects[]
                                       ▼         │
                                     new state    ▼
                                       │    execute(app, effect)
                                       │         │
                                       │         ▼
                                       │    side effects:
                                       │    fetch, DB, dispatch
                                       │
                                       ▼
                                     broadcast delta ── WebSocket ──▶  UI re-renders
                                       │
                                       ▼
                                     persist to KV
                                     sync to SQLite
```

**One-sentence summary:** UI sends actions → server reduces state → effects run
→ deltas broadcast back.

---

## Advanced / explicit control — `feature(name, { actions, reduce, execute })`

> **Not the starting point.** Use `feature({ methods })` for most features. This
> style gives full explicit control — reach for it when methods can't express
> what you need.

A feature is a self-contained state machine with its own state slice, typed
actions, typed effects, state machine definition, reducer, and executor. One
`feature()` call defines everything.

```ts
import { feature } from "aio";

export const counter = feature("counter", {
  // ── State — this feature's slice of the global state tree
  state: { count: 0, lastUpdatedAt: 0, error: null as string | null },

  // ── Actions — messages from UI or effects → state changes
  actions: {
    increment: (by = 1) => ({ by }),
    decrement: (by = 1) => ({ by }),
    reset: () => ({}),
    save: () => ({}),
    saved: () => ({}),
    saveFailed: (error: string) => ({ error }),
    retry: () => ({}),
    dismiss: () => ({}),
  },

  // ── Effects — async side effects returned by reducer
  effects: {
    persist: (value: number) => ({ value }),
    log: (message: string) => ({ message }),
  },

  // ── Machine — which actions are allowed in which status
  machine: {
    initial: "idle",
    states: {
      idle: {
        increment: "idle",
        decrement: "idle",
        reset: "idle",
        save: "saving",
      },
      saving: { saved: "idle", saveFailed: "error" },
      error: { retry: "saving", dismiss: "idle" },
    },
  },

  // ── Reduce — object of named handlers; payload is typed from the action creator
  reduce: {
    increment(state, payload) {
      state.count += payload.by;
      state.lastUpdatedAt = Date.now();
    },
    decrement(state, payload) {
      state.count -= payload.by;
      state.lastUpdatedAt = Date.now();
    },
    reset(state) {
      state.count = 0;
    },
    save(state) {
      // no state mutation — effect returned via execute
    },
    saveFailed(state, payload) {
      state.error = payload.error;
    },
  },

  // ── Execute — object of named handlers per effect
  execute: {
    persist(app, payload) {
      fetch("/api/save", {
        method: "POST",
        body: JSON.stringify({ value: payload.value }),
      })
        .then(() => app.dispatch(counter.saved()))
        .catch((e) => app.dispatch(counter.saveFailed(e.message)));
    },
    log(_app, payload) {
      console.log(payload.message);
    },
  },
});
```

> **Note on `reduce`/`execute` form:** The object form (named handlers) is the
> default and covers 95% of use cases. For advanced cases — foreign action
> handlers, multiple entry points to the same state change — the function form
> is available as an escape hatch using `{ on }` / `{ emit }`. See
> [Advanced: function-form reduce/execute](#advanced-function-form-reduceexecute)
> below.

### What `feature()` generates

From the name `'counter'` and action `increment`, you get:

| Generated                | Value                                            | Use                                      |
| ------------------------ | ------------------------------------------------ | ---------------------------------------- |
| `counter.increment(5)`   | dispatches `counter:increment` after `aio.run()` | Direct calling from app code             |
| `counter.increment.type` | `'counter:increment'`                            | Type string for matching, no raw strings |

**Action type format:** `featureName:actionKey` — all lowercase.
`counter:increment`, `wallet:transfer`, `checkout:start`.

**Direct calling:** After `aio.run()`, methods dispatch automatically:

```ts
counter.increment(5); // dispatches counter:increment
```

`feature()` returns `FeatureDef & FlatActions<A>` — TypeScript infers correct
parameter types for all flattened action creators.

### `machine` — state machine guards

The machine definition controls which actions are allowed in which status.
Actions that aren't listed for the current status are **silently dropped** — no
error, no state change.

```ts
machine: {
  initial: 'idle',
  states: {
    idle:   { increment: 'idle', decrement: 'idle', save: 'saving' },
    saving: { saved: 'idle', saveFailed: 'error' },
    error:  { retry: 'saving', dismiss: 'idle' },
  },
},
```

The framework tracks the current machine state internally. Use
`useFeature(counter).status` in the UI or `t.expect.status('idle')` in tests —
never read `__aio_status` directly from state — use `registry.status()` or
`useFeature().status` in UI.

**Validation at definition time:**

- Initial state must exist in declared states
- All transition targets must be declared states
- All referenced action keys must be declared (own or foreign)
- Unreachable states are flagged
- Dead-end states (no outgoing transitions) get a console warning

Use `machine: false` for features that don't need state machine guards — all
actions are always allowed.

### Foreign actions — cross-feature reactions

A feature's machine can declare actions from other features. This lets one
feature react to another's state changes:

```ts
import { counter } from "../counter/index.ts";

const analytics = feature("analytics", {
  state: { events: [] as string[] },
  listensTo: [counter.increment, counter.reset], // bind functions, not strings
  reduce: {
    // Own action handler
    clear(state) {
      state.events = [];
    },
  },
});
```

Or with an explicit machine for features that also need real machine states:

```ts
import { counter } from "../counter/index.ts";

const analytics = feature("analytics", {
  state: { events: [] as string[] },
  actions: { clear: () => ({}) },
  machine: {
    initial: "active",
    states: {
      active: {
        clear: "active",
        [counter.increment.type]: "active", // ← use .type, not raw string
        [counter.reset.type]: "active",
      },
    },
  },
  // Function-form reduce for foreign action handling
  reduce(state, action, { on }) {
    on(counter.increment, () => {
      (state.events as string[]).push("incremented");
    });
    on(counter.reset, () => {
      (state.events as string[]).push("reset");
    });
    if (action.type === "analytics:clear") state.events = [];
  },
});
```

Foreign actions are identified by containing `:` and not matching the feature's
own prefix. The framework routes the action to both the owning feature and all
listeners.

**Always use `.type` or pass function directly** — never raw action type
strings. Bound methods have `.type` as a static property:

```ts
counter.increment.type; // → 'counter:increment'
counter.reset.type; // → 'counter:reset'
```

### `reduce` — named handlers (default form)

The object form is the standard: one method per action key, `payload` typed from
the action creator:

```ts
reduce: {
  increment(state, payload) {
    state.count += payload.by           // mutate the draft
  },
  reset(state) {
    state.count = 0                     // no payload
  },
  save(state) {
    // reducer returns effects via the execute object — no return needed here
  },
  saveFailed(state, payload) {
    state.error = payload.error
  },
},
```

Effects are returned from the `execute` object's handlers. The reduce object
cannot return effects — use `execute` for side effects.

### Advanced: function-form reduce/execute

For edge cases — foreign action handling, dynamic routing, multiple actions
triggering the same logic — the function form is available. It uses `{ on }` /
`{ emit }`:

```ts
reduce(state, action, { on, emit }) {
  // Handle foreign action
  on(counter.increment, (payload) => {
    state.watchedCount = payload.by
  })
  // Emit an effect
  if (action.type === 'myFeature:save') {
    emit('persist', { value: state.count })
  }
},
```

Use `{ on }` / `{ emit }` in function-form reduce/execute.

### `execute` — named handlers (default form)

One method per effect key. Receives `app` (scoped dispatch) and typed `payload`:

```ts
execute: {
  persist(app, payload) {
    fetch('/api/save', {
      method: 'POST',
      body: JSON.stringify({ value: payload.value }),
    })
      .then(() => app.dispatch(counter.saved()))
      .catch(e => app.dispatch(counter.saveFailed(e.message)))
  },
  log(_app, payload) {
    console.log(payload.message)
  },
},
```

**Scoped dispatch rules:**

- `app.dispatch(counter.ownAction())` — always allowed
- `app.dispatch(otherFeature.action())` — **blocked** unless declared in
  `dispatchTo`
- `app.getState()` — returns this feature's slice only (not the full state)
- `app.getFullState?.()` — returns the entire app state (available in `init`,
  `destroy`, and `execute`)

### `dispatchTo` — allow dispatching to other features

```ts
import { wallet } from "../wallet";
import { fleet } from "../fleet";

const te = feature("te", {
  // ...
  dispatchTo: [wallet, fleet], // pass feature objects, not strings
  execute: {
    transferComplete(app, payload) {
      app.dispatch(wallet.credit(payload.amount)); // allowed
    },
  },
});
```

Blocked dispatches log:
`[te] dispatch('wallet:credit') blocked — add wallet to dispatchTo`

### `selectors` — derived state

Selectors receive the feature's own state slice — no need to navigate
`state.featureName.field`:

```ts
const counter = feature("counter", {
  // ...
  selectors: {
    isPositive: (s: { count: number }) => s.count > 0,
  },
});

// After aio.run() — call directly, no state arg:
counter.isPositive(); // → boolean
```

### Lifecycle hooks — `init` / `destroy`

```ts
const ws = feature("ws", {
  // ...
  onInit(app) {
    // app.getState()        → this feature's slice
    // app.getFullState?.()  → full app state — read other features' state at startup
    const config =
      (app.getFullState?.()?.config as { url?: string } | undefined)?.url;
    connectWebSocket(config ?? "ws://localhost");
  },
  onDestroy(app) {
    closeWebSocket();
  },
});
```

Init runs in dependency order (dependsOn). Destroy runs in reverse order.

**`app.getState()` vs `app.getFullState()`:**

|              | `app.getState()`             | `app.getFullState?.()`                       |
| ------------ | ---------------------------- | -------------------------------------------- |
| Returns      | This feature's slice         | Entire app state                             |
| Available in | `init`, `destroy`, `execute` | `init`, `destroy`, `execute`                 |
| Use when     | Reading your own state       | Coordinating with another feature at startup |

### Server-only executors

When execute needs server-only imports, use an async method with dynamic
`import()`:

```ts
export const backup = feature("backup", {
  state: { lastBackup: null as string | null },
  methods: {
    async run(s) {
      const data = JSON.stringify(s);
      await Deno.writeTextFile("./backup.json", data);
      s.lastBackup = new Date().toISOString();
    },
  },
});
```

The browser never runs async method bodies — it dispatches via WebSocket.
Server-only code stays on the server naturally.

## `generators` — sequential async workflows

When a feature has a multi-step async workflow (fetch → validate → save →
notify), the standard reduce/execute pattern scatters the logic across actions,
reducer cases, and effects. The `generators` key lets you write it
top-to-bottom:

```ts
import { feature } from "aio";

const checkout = feature("checkout", {
  state: {
    price: 0,
    orderId: null as string | null,
    error: null as string | null,
  },
  actions: {
    start: (item: string) => ({ item }),
  },
  machine: {
    initial: "idle",
    states: {
      idle: { start: "busy" },
      busy: {},
    },
  },
  generators: {
    // key must match an action key when using actions style
    // actions-style: generator receives the payload object directly
    start: function* (ctx, { item }: { item: string }) {
      // Step 1 — async call (dispatches checkout:__flow:fetchPrice)
      const { price } = yield* ctx.call(
        "fetchPrice",
        () => fetch(`/api/price?item=${item}`).then((r) => r.json()),
      );

      // Step 2 — validation + state update (dispatches checkout:__flow:setPrice)
      if (price > 1000) {
        yield* ctx.fail("too expensive");
        return;
      }
      yield* ctx.mutate("setPrice", (s) => {
        s.price = price;
      });

      // Step 3 — another async call (dispatches checkout:__flow:placeOrder)
      const { orderId } = yield* ctx.call(
        "placeOrder",
        () =>
          fetch("/api/order", {
            method: "POST",
            body: JSON.stringify({ price }),
          })
            .then((r) => r.json()),
      );

      // Step 4 — done (dispatches checkout:__flow:done)
      yield* ctx.done((s) => {
        s.orderId = orderId;
      });
    },
  },
});
```

Each `yield*` is a checkpoint — the framework dispatches an action, other
features can react, and the step appears in time-travel history.

### What the framework generates

From the generator above, the framework auto-generates:

- **Actions**: `checkout:__flow:fetchPrice`, `checkout:__flow:setPrice`,
  `checkout:__flow:placeOrder`, `checkout:__flow:done`, `checkout:__flow:failed`
- **Machine transitions**: each step moves through corresponding flow states
- **Error handling**: if any `ctx.call` throws, `checkout:__flow:error` is
  dispatched

You don't define these manually — the generator is the source of truth.

### `GenCtx` API

| Method                                  | What it does                                                        |
| --------------------------------------- | ------------------------------------------------------------------- |
| `yield* ctx.call(name, fn)`             | Execute async work. Dispatches action, runs `fn`, returns result.   |
| `yield* ctx.mutate(name, fn)`           | Update state via Immer draft. Dispatches action.                    |
| `yield* ctx.done(mutate?)`              | Terminal success. Optional final state update.                      |
| `yield* ctx.fail(reason)`               | Terminal failure. Stops the generator.                              |
| `yield* ctx.dispatch(action)`           | Dispatch a regular action (other features react to it).             |
| `yield* ctx.all(gen1, gen2, ...)`       | Run multiple calls in parallel, wait for all.                       |
| `yield* ctx.race({ a: gen1, b: gen2 })` | Race — first to resolve wins.                                       |
| `yield* ctx.sleep(name, ms)`            | Pause for N ms. Dispatches action for visibility.                   |
| `yield* ctx.waitFor(fn, timeout?)`      | Pause until matching action dispatched (pass function, not string). |

### Mixing generators with reduce/execute

Generators are fully optional and composable with the traditional pattern:

```ts
const wallet = feature("wallet", {
  state: { balance: 0, syncing: false },
  actions: {
    deposit: (amount: number) => ({ amount }),
    withdraw: (amount: number) => ({ amount }),
    sync: () => ({}),
  },
  machine: {
    initial: "idle",
    states: {
      idle: { deposit: "idle", withdraw: "idle", sync: "syncing" },
      syncing: {},
    },
  },
  // Reactive: instant state updates
  reduce: {
    deposit(state, payload) {
      state.balance += payload.amount;
    },
    withdraw(state, payload) {
      state.balance -= payload.amount;
    },
    sync() {},
  },
  // Sequential: the sync workflow — generator key matches action key
  generators: {
    sync: function* (ctx) {
      yield* ctx.mutate("start", (s) => {
        s.syncing = true;
      });
      const remote = yield* ctx.call("fetch", () => fetchRemoteBalance());
      yield* ctx.done((s) => {
        s.balance = remote as number;
        s.syncing = false;
      });
    },
  },
});
```

Reactive logic (deposit/withdraw) stays in `reduce`. Sequential workflows (sync)
go in `generators`. Both work on the same state.

### Generator-only features

If your feature is entirely sequential, you can skip `reduce` and `machine`:

```ts
const importer = feature("importer", {
  state: { records: 0, status: "idle" },
  actions: {
    start: (file: string) => ({ file }),
  },
  generators: {
    start: function* (ctx, { file }: { file: string }) {
      const data = yield* ctx.call("read", () => Deno.readTextFile(file));
      const parsed = yield* ctx.call("parse", () => JSON.parse(data as string));
      yield* ctx.done((s) => {
        s.records = (parsed as unknown[]).length;
        s.status = "done";
      });
    },
  },
});
```

### Cancellation

When a generator is triggered while a previous instance is still running, the
old one is automatically cancelled. Use the `cancelOn` config key to declare
cancellation triggers per generator:

```ts
import { feature } from "aio";

const healthCheck = feature("healthCheck", {
  state: { ok: false },
  methods: {
    stop(s) {
      s.ok = false;
    },
  },
  generators: {
    start: function* (ctx) {
      while (true) {
        yield* ctx.call("check", () => fetch("/health"));
        yield* ctx.sleep("wait", 30_000);
      }
    },
  },
  cancelOn: {
    start: [healthCheck.stop], // bound method — refactor-safe
  },
});
```

`cancelOn` accepts:

- Bound methods with `.type` (`healthCheck.stop.type`) — preferred
- Bound methods directly (`healthCheck.stop`) — also works (`.type` is
  extracted)
- Full action type strings as last resort (`'healthCheck:stop'`) — lowercase
  format

Generators are also cancelled when a feature is disabled or destroyed.

### When to use generators vs reduce/execute

| Use case                                           | Pattern                           |
| -------------------------------------------------- | --------------------------------- |
| Instant state update (increment, toggle)           | `reduce`                          |
| React to other features' actions                   | `reduce` with foreign listeners   |
| Multi-step async workflow (fetch → process → save) | `generators`                      |
| Request/response with timeouts and retries         | `call({ timeout, retries }, ...)` |

## `feature(name, { methods })` — start here (reactive style)

> **Start here.** 95% of features only need `methods`. The `actions + reduce`
> style exists for complex reactive logic — don't reach for it until you feel
> the pain.

```ts
import { feature } from "aio";

const counter = feature("counter", {
  state: { count: 0, lastSaved: null as string | null },
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
    async save(s) {
      await Deno.writeTextFile("./data.json", String(s.count));
      s.lastSaved = new Date().toISOString();
    },
  },
  selectors: {
    isPositive: (s) => s.count > 0,
  },
});
```

### How it works

**Sync methods** receive a mutable state object (Immer draft). Mutate in place.
All mutations within one method call are batched into a single action.

**Async methods** receive a live Proxy. Reads always return fresh state from the
store. Writes auto-dispatch actions through the normal dispatch loop. Each
property assignment after an `await` is a separate action — persisted, synced,
visible in time-travel.

```ts
async checkout(s) {
  s.status = 'loading'                    // action dispatched immediately
  const order = await placeOrder(s.items) // s.items reads current state
  s.orderId = order.id                    // action dispatched after await
  s.status = 'done'                       // another action
}
```

### Config

| Key          | Type                                  | Required | Description                                                                                                                                                |
| ------------ | ------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`      | `Record<string, unknown>`             | Yes      | Initial state                                                                                                                                              |
| `methods`    | `Record<string, Function>`            | Yes*     | Sync or async methods — `(s, ...args) => void` or `async (s, ...args) => any`                                                                              |
| `generators` | `Record<string, GeneratorFn>`         | No       | Inline sequential workflows — actions-style: `*(ctx, payload) => Gen`, methods-style: `*(ctx, ...args) => Gen` — auto-creates trigger action per generator |
| `actions`    | `Record<string, Function>`            | Yes*     | Action creators — `(arg) => ({ arg })`                                                                                                                     |
| `effects`    | `Record<string, Function>`            | No       | Effect creators — `(arg) => ({ arg })`                                                                                                                     |
| `reduce`     | `Record<string, Handler> \| Function` | No       | Named handlers (object form) or function form for advanced use                                                                                             |
| `execute`    | `Record<string, Handler> \| Function` | No       | Named effect handlers (object form) or function form for advanced use                                                                                      |
| `selectors`  | `Record<string, (s) => T>`            | No       | Derived values, auto-scoped to feature state                                                                                                               |
| `machine`    | `MachineConfig \| false`              | No       | State machine guards. `false` or omit = no guards                                                                                                          |
| `listensTo`  | `(Function \| string)[]`              | No       | Foreign actions to listen to — pass bound methods, not strings                                                                                             |
| `dispatchTo` | `FeatureDef[]`                        | No       | Feature objects this executor may dispatch to — pass imported feature refs, not strings                                                                    |
| `persist`    | `{ exclude?: string[] }`              | No       | Per-feature persistence config — `exclude` omits named fields from KV persistence                                                                          |
| `init`       | `(app) => void`                       | No       | Called when feature initializes (after dependencies)                                                                                                       |
| `destroy`    | `(app) => void`                       | No       | Called when feature destroys (before dependencies)                                                                                                         |

\* `methods` or `actions` required (or `generators` alone). Methods, generators,
and actions/effects can coexist in one feature — all callable names must be
unique within the feature (validated at creation time).

### Which style to use?

| When to use                          | Style                                     | Why                                                         |
| ------------------------------------ | ----------------------------------------- | ----------------------------------------------------------- |
| CRUD, forms, simple state            | `feature({ methods })`                    | Minimal boilerplate, methods mutate state directly          |
| Simple async (fetch, save)           | `feature({ methods })` with async methods | Async methods auto-dispatch mutations                       |
| Multi-step orchestration             | `feature({ methods, generators })`        | Inline generators, step-level visibility, auto-cancellation |
| Complex reactive cross-feature logic | `feature({ actions, reduce, execute })`   | Explicit control over action flow                           |
| Need machine guards on async         | `feature({ methods, machine })`           | State machine gates async transitions                       |

**Progression:** Start with `feature({ methods })`. Add `generators` when a
method becomes multi-step and you want visibility or cancellation. Add
`actions/reduce/execute` when you need fine-grained control over action flow.
All three styles can be mixed in a single feature — all callable names must be
unique (validated at creation time).

### Generated actions

`feature({ methods })` auto-generates actions from method names:

| Source                  | Action type               | Payload                                         | Time-travel       |
| ----------------------- | ------------------------- | ----------------------------------------------- | ----------------- |
| `increment(s, by)`      | `counter:increment`       | `{ args: [by] }`                                | Yes               |
| `async save(s)`         | `counter:save` (trigger)  | `{ args: [] }`                                  | Yes               |
| (async write)           | `counter:__setSave`       | `{ mutations: [...] }` (batched per sync frame) | Hidden (internal) |
| (async error)           | `counter:__error`         | `{ _method, error }`                            | Hidden (internal) |
| `*place(ctx)` generator | `counter:place` (trigger) | `{ args: [...] }`                               | Yes               |
| (flow step)             | `counter:__flow:stepName` | internal                                        | Yes               |

Named actions (`counter:increment`, `counter:save`, flow steps) appear in
time-travel. Internal bookkeeping actions (`__set*`, `__error`, `__exec`,
`__FlowState`) are hidden from time-travel history.

### Direct calling

After `aio.run()`, methods and selectors are callable directly on the feature
object:

```ts
await aio.run({ features: [counter] });

counter.increment(5); // dispatches counter:increment
counter.reset(); // dispatches counter:reset
counter.isPositive(); // reads state → true

// .type gives the action type string — use instead of raw strings
counter.increment.type; // → 'counter:increment'
counter.reset.type; // → 'counter:reset'

// Before aio.run(), calling a method returns an action object without dispatching
// After aio.run(), calling a method dispatches automatically
```

This works for all three styles — `feature({ methods })`,
`feature({ actions, reduce })`, and `feature({ generators })`.

### Machines

Reactive features support state machines. Methods are gated by transitions:

```ts
const door = feature("door", {
  state: { opened: false },
  machine: {
    initial: "closed",
    states: {
      closed: { open: "open" },
      open: { close: "closed" },
    },
  },
  methods: {
    open(s) {
      s.opened = true;
    },
    close(s) {
      s.opened = false;
    },
  },
});
// door.open() in 'open' state → dropped (no open→open transition)
```

### Composing with other features

Reactive features produce standard `FeatureDef` objects. They compose freely
with all other `feature()` styles:

```ts
await aio.run({
  features: [reactiveCounter, featureWallet, generatorCheckout],
});
```

Other features can listen to reactive feature actions via foreign listeners,
read via selectors, and coordinate via `call()`.

### When to use methods vs generators vs reduce

| Use case                                         | API                                       |
| ------------------------------------------------ | ----------------------------------------- |
| CRUD, forms, simple state                        | `feature({ methods })`                    |
| Simple async (fetch, save)                       | `feature({ methods })` with async methods |
| Multi-step workflow with visibility/cancellation | `feature({ generators })`                 |
| Complex reactive cross-feature logic             | `feature({ reduce, execute })`            |

Start with `feature({ methods })`. Add `generators` inline when a workflow
becomes multi-step. Add `actions/reduce/execute` when you need explicit action
control. All three styles can be mixed in a single feature.

**TypeScript inference:** `feature({ methods })` returns
`FeatureDef & FlatMethods<M> & FlatSelectors<Sel>` — methods and selectors are
properly typed with autocomplete. The state parameter `s` is stripped from
method signatures, so `increment(s, by: number)` becomes
`counter.increment(by: number)`. Generator names are added to the same callable
surface.

See [reactivity.md](reactivity.md) for async method patterns and
[generators.md](generators.md) for the full generator API.

## `aio.run({ features })` — the entry point

Pass an array of features. The framework composes them into a single dispatch
loop:

```ts
import { aio } from "aio";
import { counter } from "./features/counter/index.ts";
import { wallet } from "./features/wallet/index.ts";
import { analytics } from "./features/analytics/index.ts";

await aio.run({
  features: [counter, wallet, analytics],
  ui: { title: "My App", width: 1200, height: 800, transport: "auto" },
});
```

### Feature dependencies

Declare dependencies for ordered initialization:

```ts
await aio.run({
  features: [
    counter,
    { feature: wallet, dependsOn: ["counter"] }, // wallet inits after counter
    { feature: analytics, dependsOn: ["counter", "wallet"] },
  ],
});
```

Dependencies are validated: missing names throw, cycles throw, topological sort
determines init order.

### Feature isolation (dev convenience)

Test a single feature in isolation:

```ts
await aio.run({
  features: [counter, wallet, analytics],
  isolate: ["counter"], // only counter is active
});
```

Or via CLI: `deno task dev --isolate=counter`

### Middleware

```ts
await aio.run({
  features: [counter],
  middleware: [
    aio.middleware.logger(), // log all actions
    aio.middleware.validate(), // reject malformed actions
    aio.middleware.metrics(), // track action counts per feature
  ],
});
```

All middleware receives `(action, state, user?)` — the `user` parameter is the
`AioUser` from the WebSocket connection (undefined for server-side dispatches).
Use `aio.middleware.create()` for per-user authorization:

```ts
aio.middleware.create((action, state, next, user) => {
  if (action.type.startsWith("admin:") && user?.role !== "admin") return null;
  return next(action);
});
```

Built-in middleware: `logger`, `validate`, `metrics`, `perfBudget`, `freeze`,
`devtools`, `create` (custom).

### App version

```ts
await aio.run({
  features: [counter, wallet],
  appVersion: "1.2.0",
});
```

### Return value — `app.features`

```ts
const app = await aio.run({ features: [counter, wallet] });

// Feature control API
app.features!.list(); // ['counter', 'wallet']
app.features!.status("counter"); // 'idle' | 'saving' | 'error' | ...
app.features!.health(); // [{ name, status, enabled, errors, lastAction, lastActionAt }]
app.features!.disable("wallet"); // disable at runtime (stops routing, dispatches Destroy)
app.features!.enable("wallet"); // re-enable (dispatches Init, resets state)
```

### FeaturesConfig options

| Option             | Type             | Default      | Description                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ---------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features`         | `FeatureEntry[]` | **required** | Array of features (or `{ feature, dependsOn }` objects)                                                                                                                                                                                                                                                                                                                                  |
| `middleware`       | `MiddlewareFn[]` | —            | Middleware chain applied before reduce                                                                                                                                                                                                                                                                                                                                                   |
| `appVersion`       | `string`         | **required** | App version string — logged on startup, stored in `__aio.appVersion`. Not persisted.                                                                                                                                                                                                                                                                                                     |
| `isolate`          | `string[]`       | —            | Only activate these features (dev convenience)                                                                                                                                                                                                                                                                                                                                           |
| `beforeReduce`     | `fn`             | —            | Intercept actions before reduce — return null to drop                                                                                                                                                                                                                                                                                                                                    |
| `appId`            | `string`         | —            | **Mandatory.** Unique app identity. Used for lock file, UDS socket, KV/SQLite paths, TLS cert dir. Must be in `aio.run()`, not `deno.json` (compiled builds can't read it). See [am.md](am.md#app-identity).                                                                                                                                                                             |
| `singleton`        | `boolean`        | `true`       | `true`: refuse if another instance running. `false`: allow multiple instances. Use `killExisting: true` alongside `singleton: true` to kill existing instance                                                                                                                                                                                                                            |
| `killExisting`     | `boolean`        | `false`      | When `true`, kill existing instance before starting (replaces `singleton: 'takeover'`)                                                                                                                                                                                                                                                                                                   |
| Additional options | —                | —            | `port`, `persist`, `persistKey`, `persistMode`, `persistDebounceMs`, `client`, `keepServer`, `transport`, `ui`, `baseDir`, `users`, `db`, `schedules`, `perfCheck`, `perfBudget`, `effectTimeoutMs`, `freezeState`, `fullStateThreshold`, `maxConnections`, `stateForUI`, `stateForDB`, `onRestore`, `onAction`, `onEffect`, `onConnect`, `onDisconnect`, `onStart`, `onStop`, `onError` |

## Inter-feature coordination

See [features.md](features.md) for the complete guide to feature interaction
patterns.

### Quick reference

| Pattern        | What                                            | When                           |
| -------------- | ----------------------------------------------- | ------------------------------ |
| **Observe**    | React when another feature dispatches an action | Sync state sync, analytics     |
| **Read**       | Call another feature's selector                 | UI display, computed values    |
| **Coordinate** | Trigger or call another feature                 | Async workflows, orchestration |

Within **Coordinate**, choose:

| Tool                                                     | Use case                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `dispatchTo`                                             | Fire-and-forget action from executor                       |
| `await feature.method(args)`                             | Direct call — typed, awaitable, store-observable (default) |
| `call({ timeout, retries }, () => feature.method(args))` | Direct call with resilience (timeout/retry)                |

### Direct cross-feature calling

After `aio.run()`, async methods return typed Promises. Import any feature and
call its methods directly — no strings, no special syntax:

```ts
import { inventory } from "../inventory";
import { pricing } from "../pricing";

export const orders = feature("orders", {
  state: { orderId: null as string | null, total: 0 },
  methods: {
    async placeOrder(s, items: Item[]) {
      const reserved = await inventory.reserve(items); // Promise<ReserveResult> — typed
      const price = await pricing.calculate(reserved); // Promise<PriceResult> — typed
      s.orderId = reserved.orderId;
      s.total = price.total;
    },
  },
});
```

Everything goes through the store — dispatches a real action
(`inventory:reserve`), observable in time-travel, intercepted by middleware.
TypeScript infers the return type — no cast needed.

Every bound method has a `.type` property. Use it anywhere you'd otherwise write
a raw action type string:

```ts
// Refactor-safe — no raw strings:
if (action.type === counter.increment.type) { ... }
listensTo: [inventory.reserve, orders.place]        // pass functions directly
cancelOn: { start: [counter.stop] }                 // config key, pass function not string
ctx.waitFor(counter.signal)                         // function, not string
```

### `call()` — timeout/retry wrapper

For resilience, use the callback form of `call()`:

```ts
import { call } from 'aio'

async placeOrder(s, items: Item[]) {
  // Wrap the direct call with timeout/retry — no duplicate dispatch
  const reserved = await call({ timeout: 5000, retries: 2 }, () => inventory.reserve(items))
  s.orderId = reserved.orderId
}
```

The callback form wraps the direct call with timeout/retry — the call inside
goes through the store as normal.

**Behavior:**

- Dispatches a real action (`feature:method`) through the store
- Observable in time-travel, intercepted by middleware
- Returns the async method's return value
- Throws on error, timeout, or if feature/method not found
- `timeout`: reject after N ms
- `retries`: retry on any failure

**When to use:**

- `await feature.method(args)` — default for cross-feature calls (80% of cases)
- `call({ timeout, retries }, () => feature.method(args))` — when you need
  resilience

**vs `dispatchTo`:** `dispatchTo` is fire-and-forget from executor. Direct
calling / `call()` awaits completion and returns values.

### `markAsync(fn)` — explicit async marking

Rarely needed. Standard `async function` syntax is auto-detected. Use
`markAsync` only when minification strips constructor names (bundled JS, not
standard Deno):

```ts
import { markAsync } from "aio";

const methods = {
  fetchData: markAsync(function (s, id: string) {
    return fetch(`/api/${id}`).then((r) => r.json());
  }),
};
```

## `useFeature(ref, options?)` — React hook for features

Connects a component to a specific feature with typed send and machine status:

```tsx
import { useFeature } from "aio/react";
import { counter } from "./features/counter/index.ts";

export default function App() {
  const { state, send, status } = useFeature(counter);
  if (!state) return <div>Connecting...</div>;

  return (
    <div>
      <h1>{state.count}</h1>
      <p>Status: {status}</p>
      <button onClick={() => send.decrement()}>-</button>
      <button onClick={() => send.reset()}>Reset</button>
      <button onClick={() => send.increment(5)}>+5</button>
      {status === "error" && (
        <>
          <p>Error: {state.error}</p>
          <button onClick={() => send.retry()}>Retry</button>
          <button onClick={() => send.dismiss()}>Dismiss</button>
        </>
      )}
    </div>
  );
}
```

**What you get:**

- `state: S | null` — the feature's state slice (null until connected)
- `send.<action>(...args)` — typed action dispatchers (camelCase, auto-tagged
  with `_source: 'UI'`)
- `status: string | undefined` — current machine status (`'idle'`, `'saving'`,
  etc.)

### `fallback` option — skip the null guard

For Electron and local apps where the WS connection is near-instant, you can
provide a fallback state to avoid the null check entirely:

```tsx
import { counter, type CounterState } from "./features/counter/index.ts";

export default function App() {
  // state is CounterState, never null
  const { state, send } = useFeature(counter, {
    fallback: counter.__aio.state as CounterState,
  });

  return <h1>{state.count}</h1>;
}
```

TypeScript overload: when `fallback` is provided, the return type is
`{ state: S }` (no null). Without fallback, it remains `{ state: S | null }`.

**vs `useAio()`:** `useFeature` gives you the feature slice directly (no
`state.counter.count`), typed `send.increment()` instead of
`send(A.increment())`, and the machine `status`. Use `useAio()` when you need
the full state or multiple features in one component.

## Testing

See [testing.md](testing.md) for the full testing reference — `testFeature()`,
TestContext API, async testing, and property-based fuzzing.

## Design decisions
