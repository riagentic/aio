# Cells — Config Shape and Anatomy

> v2: methods is the one style — see
> [docs/upgrade/to-v2.md](../upgrade/to-v2.md) for migration from
> `actions:`/`reduce:`/`machine:`/`generators:`.

Everything is a cell. A cell is a self-contained unit: its own state slice plus
the methods and selectors that operate on it.

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
                                     method(draft, ...args)
                                       │         │
                                       │         ▼
                                       │    returned effects[]
                                       ▼    (schedule / own)
                                     new state    │
                                       │          ▼
                                       │    runtime performs them
                                       │
                                       ▼
                                     broadcast delta ── WebSocket ──▶  UI re-renders
                                       │
                                       ▼
                                     persist to KV
                                     sync to SQLite
```

**One-sentence summary:** UI sends actions → methods mutate state → returned
effects run → deltas broadcast back.

---

## cell() config

| Key         | Type                       | Required | Description                                                                                                   |
| ----------- | -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `state`     | `Record<string, unknown>`  | Yes      | Initial state                                                                                                 |
| `methods`   | `Record<string, Function>` | Yes      | Sync or async methods — `(s, ...args) => void`                                                                |
| `selectors` | `Record<string, (s) => T>` | No       | Derived values, auto-scoped to cell state                                                                     |
| `cancelOn`  | `{ method: [triggers] }`   | No       | Foreign actions that abort a running async method — see [Methods](methods.md#cancellation--cancelon--ssignal) |
| `listensTo` | `(Function \| string)[]`   | No       | Declare foreign actions this cell observes — pass bound methods                                               |
| `validate`  | `(s) => true \| string`    | No       | State validator, runs after every mutation — string = rejection message                                       |
| `sync`      | `true \| SyncConfig`       | No       | Enable CRDT sync — see [CRDT docs](../persistence/crdt.md)                                                    |
| `persist`   | `CellFieldFilter`          | No       | `"all"`, `"none"`, `{ include: [...] }`, `{ exclude: [...] }` — default `"all"`                               |
| `ui`        | `CellVisibility`           | No       | Same as persist, plus optional `forUser` for per-user filtering — default `"all"`                             |
| `version`   | `number`                   | No       | State-shape version — pairs with `onMigrate`                                                                  |
| `onMigrate` | `(state, from) => state`   | No       | Migration hook when persisted version < `version`                                                             |
| `onInit`    | `(app) => void`            | No       | Called when cell initializes                                                                                  |
| `onDestroy` | `(app) => void`            | No       | Called when cell destroys                                                                                     |

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
> (Selectors are callable everywhere — server _and_ browser: `cell.count()`.)

---

## What cell() generates

From the name `'counter'` and method `increment`, you get:

| Generated                     | Value                                            | Use                           |
| ----------------------------- | ------------------------------------------------ | ----------------------------- |
| `counter.increment(5)`        | dispatches `counter:increment` after `aio.run()` | Direct calling from app code  |
| `counter.increment.type`      | `'counter:increment'`                            | Type string for matching      |
| `counter.increment.action(5)` | `{ type, payload }` descriptor                   | Schedules, tests, composition |

**Action type format:** `cellName:methodKey` — all lowercase.

---

## Public interface (outside the cell)

After `cell()` returns a cell ref, the outside world can access:

| What                    | How                           | Example                            |
| ----------------------- | ----------------------------- | ---------------------------------- |
| Sync method             | Direct call                   | `counter.increment(5)`             |
| Async method            | Direct call (returns Promise) | `await api.fetch('/users')`        |
| Selector                | Direct call (after bind)      | `counter.total()`                  |
| `.type` on any method   | Read property                 | `cart.clear.type` → `"cart:clear"` |
| `.action` on any method | Action descriptor builder     | `cart.setQty.action(3)`            |

### What `.type` is for

Every method has a `.type` string property for cross-cell wiring:

```ts
cancelOn: {
  place: [cart.clear];
} // abort a running async method
listensTo: [inventory.reserve]; // observe foreign actions
```

### What you cannot access

Everything under `__aio` is framework plumbing. You can inspect it for debugging
(`counter.__aio.actionKeys`, `counter.__aio.actions`) but never need it in
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
cell's signal; each tab has its own copy. Async methods throw at `cell()` time
(v1 limitation) — do async work in the component, then call a sync method with
the result.

## Internals by component

### Sync methods

Receives Immer draft. Mutate in place. All mutations = one atomic action.

**Can:** mutate state, return schedule effects. **Cannot:** async work, access
other cells' state, call own methods.

### Async methods

Receives a live Proxy. Reads return fresh state. Writes auto-dispatch as
batches. Multi-step workflows live here — with `until`/`race`/`sleep` and
`cancelOn` + `s.$signal` for cancellation
([Methods](methods.md#workflows-in-async-methods)).

**Can:** mutate state, await async work, call other cells' methods. **Cannot:**
call own methods directly, access selectors.

### Selectors

Pure functions deriving values from cell state. Bound as accessors on the cell,
callable the same way **server-side and in the browser** (they run against the
live client signal). A plain selector's extra parameters (past the state slice)
become the accessor's arguments:

```ts
selectors: {
  count: (s) => s.items.length,          // cell.count()
  byId: (s, id: string) => s.items[id],  // cell.byId("a1") — parameterized
},
```

**Can:** read own cell state; take runtime arguments (parameterized form above);
read other cells via the **deps form**
(`{ deps: ["other"], fn: (s, other) => … }` — always zero-arg); compose.
**Cannot:** mutate, dispatch, or run async.

### Lifecycle hooks

```ts
onInit(app, initState) { app.dispatch(...) },
onDestroy(app) { /* cleanup */ },
```

Scoped app access — dispatch and read state. One-time calls. The second argument
`initState` is the cell's initial/default state object, provided because
`app.getState()` may not yet reflect the `__init` dispatch at the time `onInit`
runs.

---

## One style

`cell({ state, methods })` is the whole model:

| When you need             | Use                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| CRUD, forms, simple state | sync methods                                                                                                 |
| Async work (fetch, save)  | async methods                                                                                                |
| Multi-step orchestration  | async methods + [`until`/`race`/`sleep`](methods.md#workflows-in-async-methods)                              |
| State guards              | a [guard line](methods.md#guard-lines--machine-states-without-a-machine) — `if (s.status !== "idle") return` |
| Cancellation              | [`cancelOn` + `s.$signal`](methods.md#cancellation--cancelon--ssignal)                                       |

### TypeScript inference

`cell({ methods })` returns `CellDef & FlatMethods<M> & FlatSelectors<Sel>` —
methods and selectors are properly typed. The state parameter `s` is stripped
from method signatures, so `increment(s, by: number)` becomes
`counter.increment(by: number)`.

## Naming rules

State keys, methods, and selectors share the cell's namespace. Every name must
be unique — collisions throw at definition time.

### Not allowed — a state key sharing a name with any callable

```ts
const gateway = cell("gateway", {
  state: { error: null as string | null },
  methods: {
    error(s, msg: string) { // ❌ throws at cell() time
      s.error = msg;
    },
  },
});
// Error: [cell:gateway] state key 'error' collides with method 'error' —
// reading gateway.error in a component would return the function, not the
// state. Rename one (e.g. state key 'lastError').
```

The callable wins on the cell object, which makes the state silently unreachable
from components — so this is a definition-time error. Rename the state key:

```ts
const gateway = cell("gateway", {
  state: { lastError: null as string | null },
  methods: {
    error(s, msg: string) { // ✅
      s.lastError = msg;
    },
  },
});
```

| Collision                        | Allowed? | Reason                                  |
| -------------------------------- | -------- | --------------------------------------- |
| state ↔ method                   | ❌       | Callable wins, state unreachable (AIO4) |
| state ↔ selector                 | ❌       | Selector wins, state unreachable        |
| method ↔ method                  | ❌       | Duplicate — which runs?                 |
| method ↔ selector                | ❌       | Both flatten onto cell                  |
| any ↔ `__aio`, `A`, `E`, `state` | ❌       | Reserved for framework                  |

**Rule of thumb:** every name in a cell — state key or behavior — must be
unique. Collisions throw at `cell()` time with a rename suggestion.

## Troubleshooting

### TS2722: "Cannot invoke an object which is possibly 'undefined'" on `cell.method()`

Symptom: every direct call (`counter.increment()`, `fleet.startAll()`, …)
reports TS2722 under `noUncheckedIndexedAccess: true`.

Cause: something in your code is widening the `methods` object to an
index-signature type like `Record<string, …>` **before** `cell()` sees it. When
that happens, the typed return of `cell()` becomes an index signature, and under
`noUncheckedIndexedAccess` every property access is `Fn | undefined` — so
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

- Don't extract `methods` into a separate variable.
- Don't annotate the cell config with `MethodsCellConfig<…>` — let inference
  flow from the literal.
- If you need to split a large cell across files, export the cell itself, not
  its methods object.

To confirm you're hitting this, hover over a method in your editor: widened
cells show `((…args) => …) | undefined`; properly inferred cells show
`(…args) => …`.
