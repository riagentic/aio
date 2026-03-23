# AIO How-To: From Zero to "I Get It"

This doc explains every concept in aio. No prior framework knowledge needed.

---

## The Mental Model

AIO is a **state container**. That's it. Your entire app state lives in one
object:

```ts
// Your whole app state looks like this:
{
  counter: { count: 5 },
  user: { name: 'Alice', loggedIn: true },
  todos: { items: [...] }
}
```

**Nothing else stores state.** No `useState`, no Redux, no context. Just this
object.

When something changes, AIO:

1. Makes a copy of the state
2. Applies your change
3. Notifies everyone who's listening

That's the whole thing. Everything else is just ergonomics.

---

## Concept 1: Features

A **feature** is a piece of state + the functions that modify it.

Think of it like a module. Your `counter` feature owns `counter.count` and knows
how to change it.

### Syntax

```ts
import { feature } from "aio";

const counter = feature("counter", {
  state: { count: 0 }, // What data does this feature own?
  methods: { // How do we change it?
    increment(s, by = 1) { // 's' is the state you can mutate
      s.count += by; // mutate directly - AIO handles copying
    },
    reset(s) {
      s.count = 0;
    },
  },
});
```

### How to read this

```ts
const counter = feature("counter", { // Name: 'counter'
  state: { count: 0 }, // State: { count: 0 }
  methods: {
    increment(s, by = 1) {
      s.count += by;
    }, // Method: increment count
    reset(s) {
      s.count = 0;
    }, // Method: reset count
  },
});
```

- `state` — initial data. Can be any object.
- `methods` — functions that modify state. First arg is always `s` (state).
- `s` — you can mutate it directly. AIO uses Immer underneath.

### Run the app

```ts
import { aio } from "aio";

await aio.run({ appId: "my-app", features: [counter] });
```

Now `counter` is live. Call methods:

```ts
counter.increment(5); // Mutates state → { count: 5 }
counter.reset(); // Mutates state → { count: 0 }
```

---

## Concept 2: State Mutation

You don't return new state. You mutate the `s` object.

### This is WRONG (old React way)

```ts
// DON'T DO THIS
methods: {
  increment(s, by) {
    return { count: s.count + by }    // ❌ returning new state
  }
}
```

### This is RIGHT (aio way)

```ts
methods: {
  increment(s, by) {
    s.count += by    // ✓ mutate directly
  }
}
```

**Why?** AIO uses [Immer](https://immerjs.github.io/immer/). It tracks your
mutations and creates a new state object automatically. You write "mutating"
code, but the result is immutable.

### You can mutate deep objects

```ts
state: {
  user: {
    profile: { name: 'Alice', age: 30 }
  }
},

methods: {
  setAge(s, age) {
    s.user.profile.age = age    // ✓ works
  },
  addItem(s, item) {
    s.items.push(item)          // ✓ works
  }
}
```

---

## Concept 3: Selectors

A **selector** is a function that computes derived state.

### Without selector

```ts
// In your component, you'd do this every time:
const doubled = counter.state.count * 2;
```

### With selector

```ts
const counter = feature('counter', {
  state: { count: 0 },
  methods: { ... },
  selectors: {
    doubled(s) {
      return s.count * 2
    }
  }
})

// After aio.run():
counter.doubled()   // → 0 (if count is 0)
```

**The `s` you receive is already scoped.** You don't write `s.counter.count`,
just `s.count`.

### This is memoized

```ts
selectors: {
  expensive(s) {
    // This only runs when s.count changes
    // If count is the same, cached result is returned
    return heavyComputation(s.count)
  }
}
```

### Selectors with dependencies

Need data from other features? Pass them as parameters after `s`:

```ts
const dashboard = feature("dashboard", {
  state: { summary: "" },

  selectors: {
    // s = dashboard state, counter and wallet injected after aio.run()
    summary(s, counter, wallet) {
      // counter.count and wallet.balance are typed
      return `Count: ${counter.count}, Balance: ${wallet.balance}`;
    },
  },
});

// After aio.run({ appId: 'my-app', features: [dashboard, counter, wallet] })
dashboard.summary(); // → 'Count: 5, Balance: 100'
```

The framework automatically injects other features' state based on parameter
names matching feature names.

---

## Concept 4: Async Methods

Methods can be `async`. They get a "live" state proxy.

### Sync method

```ts
methods: {
  increment(s, by) {
    s.count += by    // Runs immediately
  }
}
```

### Async method

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

**What happens:**

1. `s.status = 'saving'` → batched into an internal `Counter:__setSave` action
2. `await fetch(...)` → waits
3. `s.status = 'done'` → batched into another internal `Counter:__setSave`
   action

Each assignment after an `await` creates a separate batched action. These
`__set*` actions are internal bookkeeping — they are hidden from time-travel.
The trigger action (`counter:save`) appears in time-travel.

---

## Concept 5: State Machines

A **state machine** guards actions. Only certain actions allowed in certain
states.

### Without machine

```ts
// Any method can be called at any time
counter.reset(); // Works even if that doesn't make sense
```

### With machine

```ts
const door = feature("door", {
  state: { isOpen: false },

  machine: {
    initial: "closed",
    states: {
      closed: { open: "open" }, // Only 'open' allowed when closed
      open: { close: "closed" }, // Only 'close' allowed when open
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

// Start in 'closed' state
door.open(); // ✓ Works → machine moves to 'open'
door.open(); // ✗ Dropped! 'open' not allowed in 'open' state
door.close(); // ✓ Works → machine moves to 'closed'
```

### How to read the machine

```ts
machine: {
  initial: 'closed',              // Start in 'closed' state
  states: {
    closed: {                     // When in 'closed' state:
      open: 'open'                // 'open' action → move to 'open' state
    },
    open: {                       // When in 'open' state:
      close: 'closed'             // 'close' action → move to 'closed' state
    }
  }
}
```

### Check status in UI

```tsx
const { status } = useFeature(door);

// status is 'closed' or 'open' (string)
```

### No machine needed?

```ts
// Omit machine entirely — all actions always allowed
// or explicitly:
machine: false;
```

---

## Concept 6: Calling Other Features

Import and call directly — fully typed, store-observable.

### The solution

```ts
import { inventory } from "../inventory";
import { payment } from "../payment";

const checkout = feature("checkout", {
  state: { orderId: null },

  methods: {
    async placeOrder(s, items) {
      // Call another feature's async method directly
      await inventory.reserve(items); // typed, dispatches through store

      // Call and get return value
      const confirmed = await payment.charge(items.total); // Promise<ConfirmResult>

      s.orderId = confirmed.orderId;
    },
  },
});
```

### How this works

```ts
await inventory.reserve(items);
//     ↑ feature   ↑ method   ↑ args
```

**This dispatches a real action:**

- `inventory:reserve { args: [items] }`
- Time-travel sees it
- Machine guards apply
- Returns the async method's return value (typed)

### With timeout and retries

```ts
import { call } from "aio";

const result = await call(
  { timeout: 5000, retries: 2 },
  () => payment.charge(items.total), // callback form
);
```

### When to use `call()` vs direct calling

Use direct calling in almost all cases — it's fully typed, observable, and goes
through the store. Use `call(opts, fn)` only when you need timeout or retry
semantics:

```ts
// Direct — preferred
const reserved = await inventory.reserve(items);

// With timeout/retry — only when needed
const reserved = await call(
  { timeout: 5000, retries: 2 },
  () => inventory.reserve(items),
);
```

---

## Concept 7: Three Ways Features Communicate

### 1. Observe — React when another feature dispatches

```ts
import { counter } from "../counter";

const analytics = feature("analytics", {
  state: { events: [] },

  listensTo: [counter.increment], // pass bound methods — no raw strings

  methods: {
    trackEvent(s, name) {
      s.events.push(name);
    },
  },
});

// Now when counter.increment() is called:
// 1. Counter feature handles it
// 2. Analytics feature ALSO receives it
```

### 2. Read — Call another feature's selector

```ts
const dashboard = feature("dashboard", {
  selectors: {
    summary(s, counter, wallet) {
      // s = dashboard state (not used here)
      // counter and wallet passed automatically after aio.run()
      return `Count: ${counter.count}, Balance: ${wallet.balance}`;
    },
  },
});
```

### 3. Coordinate — Trigger another feature

Direct import and call (preferred), or `dispatchTo` in executor:

```ts
import { wallet } from "../wallet";

const checkout = feature("checkout", {
  dispatchTo: [wallet], // Allow dispatching to wallet — pass feature object

  execute: {
    paymentComplete(app, payload) {
      app.dispatch(wallet.credit(payload.amount)); // allowed via dispatchTo
    },
  },
});
```

---

## Concept 8: Actions and Reduce (Alternative Style)

The `methods` style is simpler. But sometimes you want more control.

### Methods style (simple)

```ts
const counter = feature("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
  },
});
```

### Actions/Reduce style (explicit)

```ts
const counter = feature("counter", {
  state: { count: 0 },

  actions: {
    increment: (by = 1) => ({ by }), // Action creator
  },

  // Object form — one named handler per action key
  reduce: {
    increment(state, payload) {
      state.count += payload.by;
    },
  },
});
```

### How to read actions/reduce

```ts
actions: {
  increment: (by = 1) => ({ by })
  //   ↑ name   ↑ parameters     ↑ what goes into action.payload
}

// This generates:
// counter.increment.type → 'counter:increment' (use this for matching, not raw strings)
// counter.increment.type → 'counter:increment' (use this for matching, not raw strings)

reduce: {
  increment(state, payload) {
    // state is an Immer draft
    // payload contains the typed data from the action creator
    state.count += payload.by
  },
}
```

### When to use which?

| Use methods when     | Use actions/reduce when             |
| -------------------- | ----------------------------------- |
| CRUD operations      | Complex reactive logic              |
| Simple state updates | Multiple actions trigger same logic |
| 80% of features      | You need explicit control           |

---

## Concept 9: Effects and Execute

**Effects** are things that happen _after_ state changes (API calls, timers,
etc).

### With actions/reduce

```ts
const counter = feature("counter", {
  state: { count: 0 },

  actions: {
    save: () => ({}),
  },

  effects: {
    persist: (value: number) => ({ value }),
  },

  // Named handler — no return needed; effects wired via execute object
  reduce: {
    save() {}, // state unchanged — side effect handled in execute
  },

  execute: {
    persist(_app, payload) {
      fetch("/api/save", { body: payload.value });
    },
  },
});
```

### Flow: action → reduce → effects → execute

```
dispatch(save())
    ↓
reduce: returns [E.persist(count)]
    ↓
execute: runs for each effect
```

### With methods style (simpler)

```ts
const counter = feature("counter", {
  state: { count: 0 },

  methods: {
    async save(s) {
      await fetch("/api/save", { body: s.count }); // Just do it inline
    },
  },
});
```

No need for effects/execute in most cases. Use methods style unless you have a
reason.

---

## Concept 10: Generators (Sequential Workflows)

When you have multi-step async logic, **generators** let you write it
top-to-bottom.

### Without generator (scattered)

```ts
// Step 1: fetch
// Step 2: validate
// Step 3: save
// Scattered across reduce, execute, multiple actions...
```

### With generator

```ts
import { feature } from "aio";

const checkout = feature("checkout", {
  state: { step: "idle", orderId: null },

  methods: {
    cancel(s) {
      s.step = "cancelled";
    }, // sync method alongside generator
  },

  generators: {
    // 'place' auto-creates the trigger action 'checkout:place'
    // methods-style: spread args matching method signature (minus s)
    *place(ctx, items: string[]) { // ← ctx and args are typed
      // Step 1
      const valid = yield* ctx.call("validate", () => validateItems(items));
      if (!valid) {
        yield* ctx.fail("invalid items");
        return;
      }

      // Step 2
      const orderId = yield* ctx.call("createOrder", () => createOrder(items));

      // Step 3 - state is automatically typed from feature state
      yield* ctx.mutate("save", (s) => {
        s.orderId = orderId;
        s.step = "done";
      });
    },
  },
});
```

### Generator arg styles

**Methods-style** (when feature has `methods`):

```ts
generators: {
  *place(ctx, item: string, qty: number) {   // ← spread args, same as method
    // item and qty are typed - no cast needed
  }
}
```

**Actions-style** (when feature has `actions`):

```ts
generators: {
  place: function* (ctx, { item, qty }: { item: string; qty: number }) {
    // ← payload object, same shape as action creator returns
  }
}
```

### State is typed automatically

```ts
const checkout = feature("checkout", {
  state: { orderId: null as string | null, status: "idle" },

  generators: {
    *place(ctx, item: string) {
      // s in ctx.mutate is typed as { orderId: string | null, status: string }
      yield* ctx.mutate("setOrderId", (s) => {
        s.orderId = "123";
      }); // ✓ typed
      yield* ctx.mutate("setStatus", (s) => {
        s.status = "done";
      }); // ✓ typed
      const current = ctx.getState(); // ✓ typed
    },
  },
});
```

No casts needed. The `s` parameter in `ctx.mutate`, `ctx.done`, and
`ctx.getState()` is inferred from your feature's state.

### How to read a generator

```ts
generators: {
  // actions-style: payload object | methods-style: spread args
  place: function* (ctx, { item }: { item: string }) {
    // ↑ key auto-creates action 'checkout:place'

    const result = yield* ctx.call('stepName', () => someAsyncWork())
    //                ↑ use yield* (not just yield)

    yield* ctx.mutate('updateState', s => { s.x = 1 })
    //   ↑ update state synchronously

    yield* ctx.done(s => { s.finished = true })
    //   ↑ terminal success
  },
}
```

### Generator context methods

| Method                                  | What it does                                  |
| --------------------------------------- | --------------------------------------------- |
| `yield* ctx.call(name, fn)`             | Run async work, return result                 |
| `yield* ctx.mutate(name, fn)`           | Update state synchronously                    |
| `yield* ctx.done(fn?)`                  | Mark generator complete, optional final state |
| `yield* ctx.fail(reason)`               | Mark generator failed                         |
| `yield* ctx.dispatch(action)`           | Dispatch an action                            |
| `yield* ctx.send(method, payload?)`     | Shorthand dispatch to another feature         |
| `yield* ctx.all(...gens)`               | Run multiple in parallel, wait for all        |
| `yield* ctx.all({...gens})`             | Named form - destructure by name              |
| `yield* ctx.race({...gens})`            | First to complete wins                        |
| `yield* ctx.sleep(name, ms)`            | Pause (visible in time-travel)                |
| `yield* ctx.waitFor(creator, timeout?)` | Pause until matching action arrives           |
| `ctx.getState()`                        | Read current feature state                    |

### Cancelling generators

Use `cancelOn` to abort a running generator when another action fires:

```ts
const checkout = feature("checkout", {
  state: { status: "idle" },

  methods: {
    cancel(s) {
      s.status = "cancelled";
    },
  },

  generators: {
    *place(ctx, items) {
      // Long-running workflow...
    },
  },

  // Abort 'place' generator when 'cancel' is dispatched
  cancelOn: {
    place: [checkout.cancel], // bound method with .type
  },
});
```

---

## Concept 11: Testing

### Test a feature in isolation

```ts
import { testFeature } from "aio";
import { counter } from "./counter.ts";

testFeature(counter, "increment adds to count", (t) => {
  t.init();
  t.send.increment(5);
  t.expect.state((s) => s.count === 5);
});
```

### Test async methods

```ts
testFeature(api, "fetch loads data", async (t) => {
  t.init();
  t.send.fetch("https://api.example.com");
  await t.settle(); // Wait for async to complete
  t.expect.state((s) => s.data !== null);
});
```

### Test state machine

```ts
testFeature(door, "cannot open when already open", (t) => {
  t.init();
  t.send.open();
  t.expect.status("open");

  t.send.open(); // Should be dropped
  t.expect.status("open"); // Still 'open'
  t.expect.noStateChange();
});
```

---

## Concept 12: Running the App

### Minimal

```ts
import { aio } from "aio";
import { counter } from "./features/counter.ts";

await aio.run({ appId: "my-app", features: [counter] });
```

### With UI (Electron)

```ts
await aio.run({
  appId: "my-app",
  features: [counter, todos],
  ui: {
    title: "My App",
    width: 1200,
    height: 800,
    transport: "auto", // 'auto' = Electron if available, else browser
  },
});
```

### Access the app object

```ts
const app = await aio.run({ appId: 'my-app', features: [...] })

app.getState()                     // Get full state
counter.increment(5)               // Dispatch via direct calling (preferred)
app.features!.status('counter')    // Get feature status
app.features!.disable('todos')     // Disable a feature
await app.close()                  // Shutdown
```

---

## Concept 13: React Integration

### useFeature hook

```tsx
import { useFeature } from "aio";
import { counter } from "./features/counter.ts";

function Counter() {
  const { state, send, status } = useFeature(counter);

  if (!state) return <div>Connecting...</div>;

  return (
    <div>
      <p>Count: {state.count}</p>
      <p>Status: {status}</p>
      <button onClick={() => send.increment()}>+</button>
      <button onClick={() => send.reset()}>Reset</button>
    </div>
  );
}
```

### What you get

| Property | Type                       | What it is                                    |
| -------- | -------------------------- | --------------------------------------------- |
| `state`  | `S \| null`                | Feature's state slice (null while connecting) |
| `send`   | `Record<string, Function>` | Typed method dispatchers                      |
| `status` | `string \| undefined`      | Current machine state (if machine exists)     |

---

## Concept 14: Composing Features

### Multiple features

```ts
await aio.run({
  appId: "my-app",
  features: [counter, todos, user],
});
```

### Dependencies

```ts
await aio.run({
  appId: "my-app",
  features: [
    counter,
    { feature: wallets, dependsOn: ["user"] }, // user must init first
    { feature: analytics, dependsOn: ["counter", "user"] },
  ],
});
```

---

## Quick Reference

### feature() config

```ts
feature('name', {
  // Required
  state: { ... },                    // Initial state object

  // Styles (can be mixed — all callable names must be unique):
  methods: { ... },                  // Simple: sync/async functions
  actions: { ... } + reduce: { ... }, // Explicit: action creators + handlers

  // Optional
  generators: { ... },               // Sequential workflows
  cancelOn: { ... },                  // Generator cancellation
  selectors: { ... },                // Derived state
  machine: { ... },                  // State guards
  effects: { ... },                  // For actions style
  execute: { ... },                  // Effect handlers
  listensTo: [...],                  // Foreign action listeners
  dispatchTo: [...],                 // Cross-dispatch allowlist
  persist: { exclude: [...] },       // KV persistence exclusion
  onInit: (app) => {},               // Lifecycle hook
  onDestroy: (app) => {},            // Lifecycle hook
})
```

### Methods style vs Actions style

|                | Methods           | Actions                                  |
| -------------- | ----------------- | ---------------------------------------- |
| State mutation | `s.count += 1`    | `reduce: { handler(state, payload) {} }` |
| Async work     | `async method(s)` | `execute: { handler(app, payload) {} }`  |
| Simplicity     | ✓ Simple          | ✗ More boilerplate                       |
| Control        | ✗ Less            | ✓ More explicit                          |
| Type inference | ✓ Automatic       | ✗ Manual casts                           |

### Generator context

```ts
generators: {
  *workflow(ctx, item: string) {           // typed args
    const result = yield* ctx.call('step', () => fetch(item))
    yield* ctx.mutate('update', s => { s.value = result })  // s is typed
    yield* ctx.done()
  }
}

// Cancellation
cancelOn: {
  workflow: [otherFeature.cancel],   // abort when this action fires
}
```

### call() syntax

```ts
// Direct — preferred, fully typed
await inventory.reserve(items);

// With timeout/retry
await call({ timeout: 5000, retries: 2 }, () => inventory.reserve(items));
```

---

## Common Patterns

### Pattern: Loading state

```ts
const todos = feature("todos", {
  state: { items: [], loading: false },

  methods: {
    async load(s) {
      s.loading = true;
      const res = await fetch("/api/todos");
      s.items = await res.json();
      s.loading = false;
    },
  },
});
```

### Pattern: Error handling

```ts
methods: {
  async load(s) {
    s.loading = true
    s.error = null
    try {
      s.items = await fetchData()
    } catch (e) {
      s.error = e.message
    }
    s.loading = false
  }
}
```

### Pattern: Form state with validation

Validation belongs in methods — check input, set errors, bail early. No special
`validate` hook needed.

```ts
const form = feature("form", {
  state: {
    email: "",
    password: "",
    errors: {} as Record<string, string>,
    submitting: false,
  },

  methods: {
    setEmail(s, email: string) {
      s.email = email;
      delete s.errors.email;
    },
    setPassword(s, password: string) {
      s.password = password;
      delete s.errors.password;
    },

    async submit(s) {
      // Validate before doing anything — errors go into state, UI reacts
      const errors: Record<string, string> = {};
      if (!s.email) errors.email = "required";
      if (!s.email.includes("@")) errors.email = "invalid email";
      if (s.password.length < 8) errors.password = "min 8 characters";
      if (Object.keys(errors).length) {
        s.errors = errors;
        return;
      }

      // Validation passed — proceed
      s.errors = {};
      s.submitting = true;
      const result = await submitForm(s.email, s.password);
      s.submitting = false;
      if (result.error) s.errors = { submit: result.error };
    },
  },
});
```

Validation is state mutation — the errors need to be in state so the UI can
render them. Methods are the natural place for "check input, update state, maybe
proceed."

### Pattern: Persistence

Exclude ephemeral state from Deno.Kv persistence:

```ts
const editor = feature("editor", {
  state: {
    content: "", // persisted
    htmlCache: "", // NOT persisted (regenerated from content)
    undoStack: [], // NOT persisted (cleared on reload)
  },

  persist: { exclude: ["htmlCache", "undoStack"] },

  methods: {
    setContent(s, text) {
      s.content = text;
    },
    clearUndo(s) {
      s.undoStack = [];
    },
  },
});

// After aio.run({ appId: 'my-app', features: [editor], persist: true })
// State is auto-saved to Deno.Kv
// htmlCache and undoStack are NOT saved
```

---

## Errors

### "Cannot mutate state outside of reducer"

You tried to mutate `state` outside a method. This happens when you:

```ts
// ❌ WRONG - mutating directly
const app = await aio.run({ appId: "my-app", features: [counter] });
app.getState().counter.count += 1;

// ✓ RIGHT - use a method
counter.increment(1);
```

### "Action not allowed in state 'X'"

Your machine blocked the action.

```ts
// Check what state you're in
const { status } = useFeature(door)
console.log(status)  // 'closed' or 'open'

// Check what actions are defined
machine: {
  closed: { open: 'open' },   // Only 'open' allowed
}
```

### "dispatch is not a function"

You forgot to `await aio.run()`. Methods are bound after the app starts.

```ts
// ❌ WRONG - called before run
counter.increment(); // Not bound yet!

// ✓ RIGHT - called after run
await aio.run({ features: [counter] });
counter.increment(); // Now it works
```

---

## That's It

You now know everything in AIO:

1. **Features** own state and methods
2. **Mutate `s` directly** — Immer handles details
3. **Direct import + call** invokes other features (no raw strings)
4. **Machines** guard actions
5. **Methods style** = simpler, **Actions/reduce style** = more control
6. **Generators** = sequential async workflows
7. **Test with `testFeature()`**

Start with `methods`. Add complexity only when you need it.
