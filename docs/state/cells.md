# Cells — Config Shape and Anatomy

Everything is a cell. A cell is a self-contained unit: its own state slice,
actions, effects, machine guards, reducer, and executor.

## Architecture — Data Flow

```
  UI (AIR / Svelte / Vue)             Server (Deno)
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

## cell() config

| Key          | Type                                  | Required | Description                                                                       |
| ------------ | ------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `state`      | `Record<string, unknown>`             | Yes      | Initial state                                                                     |
| `methods`    | `Record<string, Function>`            | Yes*     | Sync or async methods — `(s, ...args) => void`                                    |
| `generators` | `Record<string, GeneratorFn>`         | No       | Sequential workflows — auto-creates trigger action per generator                  |
| `actions`    | `Record<string, Function>`            | Yes*     | Action creators — `(arg) => ({ arg })`                                            |
| `effects`    | `Record<string, Function>`            | No       | Effect creators — `(arg) => ({ arg })`                                            |
| `reduce`     | `Record<string, Handler> \| Function` | No       | Named handlers or function form                                                   |
| `execute`    | `Record<string, Handler> \| Function` | No       | Named effect handlers or function form                                            |
| `selectors`  | `Record<string, (s) => T>`            | No       | Derived values, auto-scoped to cell state                                         |
| `machine`    | `MachineConfig \| false`              | No       | State machine guards. `false` or omit = no guards                                 |
| `listensTo`  | `(Function \| string)[]`              | No       | Foreign actions to listen to — pass bound methods                                 |
| `sync`       | `true \| SyncConfig`                  | No       | Enable CRDT sync — see [CRDT docs](../persistence/crdt.md)                        |
| `persist`    | `CellFieldFilter`                     | No       | `"all"`, `"none"`, `{ include: [...] }`, `{ exclude: [...] }` — default `"all"`   |
| `ui`         | `CellVisibility`                      | No       | Same as persist, plus optional `forUser` for per-user filtering — default `"all"` |
| `init`       | `(app) => void`                       | No       | Called when cell initializes                                                      |
| `destroy`    | `(app) => void`                       | No       | Called when cell destroys                                                         |

\* `methods` or `actions` required (or `generators` alone). All three styles can
coexist — all callable names must be unique within the cell.

> ### ⚠️ Two TypeScript traps to know first
>
> **Don't `satisfies` your `state`.** `state: {...} satisfies MyState` narrows
> union fields to their literal type, so inside methods the Immer draft rejects
> assignment (`Type 'ViewMode' is not assignable to type '"grid"'`) — and the
> error points at the method body, not the annotation. Use `as` casts on the
> union-typed initial values instead:
>
> ```ts
> // ❌ narrows view to the literal "grid" — methods can't reassign it
> state: { view: "grid", items: [] } satisfies UiState,
> // ✅ keeps the union type
> state: { view: "grid" as ViewMode, items: [] },
> ```
>
> **Don't put generics on methods.** `setFilter<K extends keyof F>(s, k, v)`
> breaks inference for `s` (it falls back to `any`, which strict mode rejects).
> Keep methods non-generic; narrow inside the body, or take a concrete key type.
> (Selectors are callable everywhere — server *and* browser: `cell.count()`.)

---

## What cell() generates

From the name `'counter'` and action `increment`, you get:

| Generated                | Value                                            | Use                          |
| ------------------------ | ------------------------------------------------ | ---------------------------- |
| `counter.increment(5)`   | dispatches `counter:increment` after `aio.run()` | Direct calling from app code |
| `counter.increment.type` | `'counter:increment'`                            | Type string for matching     |

**Action type format:** `cellName:actionKey` — all lowercase.

---

## Public interface (outside the cell)

After `cell()` returns a cell ref, the outside world can access:

| What                    | How                           | Example                            |
| ----------------------- | ----------------------------- | ---------------------------------- |
| Sync method             | Direct call                   | `counter.increment(5)`             |
| Async method            | Direct call (returns Promise) | `await api.fetch('/users')`        |
| Generator               | Direct call (starts workflow) | `checkout.place(item)`             |
| Action (explicit style) | Direct call or dispatch       | `cart.start()`                     |
| Selector                | Direct call (after bind)      | `counter.total()`                  |
| `.type` on any callable | Read property                 | `cart.clear.type` → `"cart:clear"` |
| `.fx` effect catalog    | Typed creators                | `counter.fx.persist(value)`        |

### What `.type` is for

Every method, generator, and action has a `.type` string property for cross-cell
wiring:

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

### Type helper: StateOf

Extract a cell's state type without casts:

```ts
import type { StateOf } from "aio";

type CounterState = StateOf<typeof counter>;
// { count: number }
```

---

## Shared vs per-client state

Three tools, one decision: who needs to see the state?

| Tool                                     | Lives                                             | Use when                                                                                         |
| ---------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| shared cell (default, `scope: "server"`) | server store, synced to every client, persists    | state is the app's truth: domain data, anything two clients or a restart must agree on           |
| client cell (`scope: "client"`)          | one browser tab, signal-backed, sync methods only | UI state that outlives one component but belongs to one tab: filters, panel layout, draft inputs |
| `useLocal`                               | one component instance                            | ephemeral interaction state: open/closed, hover, in-progress text                                |

A `scope: "client"` cell never registers with the server store, never syncs,
never persists to Deno.Kv. Methods run synchronously in the browser against the
cell's signal; each tab has its own copy. Async methods, generators, actions,
and machines throw at `cell()` time (v1 limitation) — do async work in the
component, then call a sync method with the result.

## Internals by component

### Sync methods

Receives Immer draft. Mutate in place. All mutations = one atomic action.

**Can:** mutate state, return schedule effects. **Cannot:** async work, access
other cells' state, call own methods.

### Async methods

Receives a live Proxy. Reads return fresh state. Writes auto-dispatch as
batches.

**Can:** mutate state, await async work, call other cells' methods. **Cannot:**
call own methods directly, access selectors.

### Generators

The most powerful context — top-to-bottom orchestration with full observability.
Every `yield*` creates a named action in time-travel history.

**Can:** everything — mutate, call, dispatch, wait, sleep, parallel, race.

### Selectors

Pure functions deriving values from cell state. Bound as zero-arg accessors on
the cell (`cell.count()`), callable the same way **server-side and in the
browser** (they run against the live client signal).

**Can:** read own cell state; read other cells via the **deps form**
(`{ deps: ["other"], fn: (s, other) => … }`); compose. **Cannot:** mutate,
dispatch, run async, or take runtime arguments (a selector is `(s) => T` — for
parameterized derivations, inline the logic or use a method).

### Lifecycle hooks

```ts
onInit(app, initState) { app.dispatch(...) },
onDestroy(app) { /* cleanup */ },
```

Same capabilities as execute — dispatch and read state. One-time calls. The
second argument `initState` is the cell's initial/default state object, provided
because `app.getState()` may not yet reflect the `__init` dispatch at the time
`onInit` runs.

---

## Which style to use

| When to use                 | Style                                |
| --------------------------- | ------------------------------------ |
| CRUD, forms, simple state   | `cell({ methods })`                  |
| Simple async (fetch, save)  | `cell({ methods })` with async       |
| Multi-step orchestration    | `cell({ methods, generators })`      |
| Complex reactive cross-cell | `cell({ actions, reduce, execute })` |
| Machine guards on async     | `cell({ methods, machine })`         |

**Progression:** Start with `methods`. Add `generators` when a method becomes
multi-step. Add `actions/reduce/execute` for fine-grained action control.

### TypeScript inference

`cell({ methods })` returns `CellDef & FlatMethods<M> & FlatSelectors<Sel>` —
methods and selectors are properly typed. The state parameter `s` is stripped
from method signatures, so `increment(s, by: number)` becomes
`counter.increment(by: number)`.

## Naming rules

State keys, methods, actions, effects, and selectors share the cell's namespace.
Every name must be unique — collisions throw at definition time.

### Not allowed — a state key sharing a name with any callable

```ts
const gateway = cell("gateway", {
  state: { error: null as string | null },
  actions: { error: (msg: string) => ({ msg }) }, // ❌ throws at cell() time
  reduce: {
    error(s, p) {
      s.error = p.msg;
    },
  },
});
// Error: [cell:gateway] state key 'error' collides with action 'error' —
// reading gateway.error in a component would return the function, not the
// state. Rename one (e.g. state key 'lastError').
```

The callable wins on the cell object, which makes the state silently unreachable
from components — so this is a definition-time error. Rename the state key:

```ts
const gateway = cell("gateway", {
  state: { lastError: null as string | null },
  actions: { error: (msg: string) => ({ msg }) }, // ✅
  reduce: {
    error(s, p) {
      s.lastError = p.msg;
    },
  },
});
```

| Collision                        | Allowed? | Reason                                  |
| -------------------------------- | -------- | --------------------------------------- |
| state ↔ method/action/effect     | ❌       | Callable wins, state unreachable (AIO4) |
| state ↔ selector                 | ❌       | Selector wins, state unreachable        |
| method ↔ method                  | ❌       | Duplicate — which runs?                 |
| method ↔ generator               | ❌       | Both dispatch, ambiguous                |
| method ↔ action                  | ❌       | Both create `prefix:name` type          |
| action ↔ effect                  | ❌       | Both use same type pattern              |
| action ↔ selector                | ❌       | Both flatten onto cell                  |
| any ↔ `__aio`, `A`, `E`, `state` | ❌       | Reserved for framework                  |

**Rule of thumb:** every name in a cell — state key or behavior — must be
unique. Collisions throw at `cell()` time with a rename suggestion.

## Troubleshooting

### TS2722: "Cannot invoke an object which is possibly 'undefined'" on `cell.method()`

Symptom: every direct call (`counter.increment()`, `fleet.startAll()`, …)
reports TS2722 under `noUncheckedIndexedAccess: true`.

Cause: something in your code is widening the `methods` (or `actions`) object to
an index-signature type like `Record<string, …>` **before** `cell()` sees it.
When that happens, the typed return of `cell()` becomes an index signature, and
under `noUncheckedIndexedAccess` every property access is `Fn | undefined` — so
TypeScript refuses the call.

`cell()` relies on **literal inference** to produce named, callable properties.
Anything that flattens the methods object into a `Record<…>` breaks it.

**Fix — inline the methods object at the call site:**

```ts
// ❌ Widens — `methods` is `Record<string, (s) => void>`, literal shape lost
const methods: Record<string, (s: State) => void> = {
  navigate(s, route: string) {
    s.route = route;
  },
};
const core = cell("core", { state, methods });
core.navigate("about"); // TS2722

// ❌ Also widens — explicit config type defaults M to the constraint
const cfg: MethodsCellConfig<"core", State> = {
  state,
  methods: {
    navigate(s, route: string) {
      s.route = route;
    },
  },
};
const core = cell("core", cfg);

// ✅ Inline — TypeScript infers the exact method shape
const core = cell("core", {
  state,
  methods: {
    navigate(s, route: string) {
      s.route = route;
    },
  },
});
core.navigate("about"); // OK
```

**Rules of thumb:**

- Don't extract `methods` (or `actions`) into a separate variable.
- Don't annotate the cell config with `MethodsCellConfig<…>` /
  `ActionsCellConfig<…>` — let inference flow from the literal.
- If you need to split a large cell across files, export the cell itself, not
  its methods object.

To confirm you're hitting this, hover over a method in your editor: widened
cells show `((…args) => …) | undefined`; properly inferred cells show
`(…args) => …`.
