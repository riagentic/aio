# Features — Config Shape and Anatomy

Everything is a feature. A feature is a self-contained unit: its own state
slice, actions, effects, machine guards, reducer, and executor.

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

## feature() config

| Key          | Type                                  | Required | Description                                                      |
| ------------ | ------------------------------------- | -------- | ---------------------------------------------------------------- |
| `state`      | `Record<string, unknown>`             | Yes      | Initial state                                                    |
| `methods`    | `Record<string, Function>`            | Yes*     | Sync or async methods — `(s, ...args) => void`                   |
| `generators` | `Record<string, GeneratorFn>`         | No       | Sequential workflows — auto-creates trigger action per generator |
| `actions`    | `Record<string, Function>`            | Yes*     | Action creators — `(arg) => ({ arg })`                           |
| `effects`    | `Record<string, Function>`            | No       | Effect creators — `(arg) => ({ arg })`                           |
| `reduce`     | `Record<string, Handler> \| Function` | No       | Named handlers or function form                                  |
| `execute`    | `Record<string, Handler> \| Function` | No       | Named effect handlers or function form                           |
| `selectors`  | `Record<string, (s) => T>`            | No       | Derived values, auto-scoped to feature state                     |
| `machine`    | `MachineConfig \| false`              | No       | State machine guards. `false` or omit = no guards                |
| `listensTo`  | `(Function \| string)[]`              | No       | Foreign actions to listen to — pass bound methods                |
| `dispatchTo` | `FeatureDef[]`                        | No       | Features this executor may dispatch to                           |
| `sync`       | `true \| SyncConfig`                  | No       | Enable CRDT sync — see [CRDT docs](../persistence/crdt.md)       |
| `persist`    | `{ exclude?: string[] }`              | No       | Per-feature persistence config                                   |
| `init`       | `(app) => void`                       | No       | Called when feature initializes                                  |
| `destroy`    | `(app) => void`                       | No       | Called when feature destroys                                     |

\* `methods` or `actions` required (or `generators` alone). All three styles can
coexist — all callable names must be unique within the feature.

---

## What feature() generates

From the name `'counter'` and action `increment`, you get:

| Generated                | Value                                            | Use                          |
| ------------------------ | ------------------------------------------------ | ---------------------------- |
| `counter.increment(5)`   | dispatches `counter:increment` after `aio.run()` | Direct calling from app code |
| `counter.increment.type` | `'counter:increment'`                            | Type string for matching     |

**Action type format:** `featureName:actionKey` — all lowercase.

---

## Public interface (outside the feature)

After `feature()` returns a feature ref, the outside world can access:

| What                    | How                           | Example                            |
| ----------------------- | ----------------------------- | ---------------------------------- |
| Sync method             | Direct call                   | `counter.increment(5)`             |
| Async method            | Direct call (returns Promise) | `await api.fetch('/users')`        |
| Generator               | Direct call (starts workflow) | `checkout.place(item)`             |
| Action (explicit style) | Direct call or dispatch       | `cart.start()`                     |
| Selector                | Direct call (after bind)      | `counter.total()`                  |
| `.type` on any callable | Read property                 | `cart.clear.type` → `"cart:clear"` |

### What `.type` is for

Every method, generator, and action has a `.type` string property for
cross-feature wiring:

```ts
cancelOn: { place: [cart.clear] }              // cancel generator
listensTo: [inventory.reserve]                 // react to foreign actions
machine: {
  states: {
    processing: { [cart.clear.type]: 'cancelled' }  // foreign transitions
  }
}
```

### What you cannot access

Everything under `__aio` is framework plumbing. You can inspect it for debugging
(`counter.__aio.machine`, `counter.__aio.actionKeys`) but never need it in
normal code.

---

## Internals by component

### Sync methods

Receives Immer draft. Mutate in place. All mutations = one atomic action.

**Can:** mutate state, return schedule effects. **Cannot:** async work, access
other features' state, call own methods.

### Async methods

Receives a live Proxy. Reads return fresh state. Writes auto-dispatch as
batches.

**Can:** mutate state, await async work, call other features' methods.
**Cannot:** call own methods directly, access selectors.

### Generators

The most powerful context — top-to-bottom orchestration with full observability.
Every `yield*` creates a named action in time-travel history.

**Can:** everything — mutate, call, dispatch, wait, sleep, parallel, race.

### Selectors

Pure functions deriving values from feature state.

**Can:** read full feature state, compose other selectors. **Cannot:** mutate,
dispatch, async, access other features' state.

### Lifecycle hooks

```ts
onInit(app) { app.dispatch(...) },
onDestroy(app) { /* cleanup */ },
```

Same capabilities as execute — dispatch and read state. One-time calls.

---

## Which style to use

| When to use                    | Style                                   |
| ------------------------------ | --------------------------------------- |
| CRUD, forms, simple state      | `feature({ methods })`                  |
| Simple async (fetch, save)     | `feature({ methods })` with async       |
| Multi-step orchestration       | `feature({ methods, generators })`      |
| Complex reactive cross-feature | `feature({ actions, reduce, execute })` |
| Machine guards on async        | `feature({ methods, machine })`         |

**Progression:** Start with `methods`. Add `generators` when a method becomes
multi-step. Add `actions/reduce/execute` for fine-grained action control.

### TypeScript inference

`feature({ methods })` returns
`FeatureDef & FlatMethods<M> & FlatSelectors<Sel>` — methods and selectors are
properly typed. The state parameter `s` is stripped from method signatures, so
`increment(s, by: number)` becomes `counter.increment(by: number)`.
