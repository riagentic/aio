# Migrating to aio v2 (the perfect-aio restructure)

This guide tracks **every breaking change** of the v2 restructure
([perfect-aio.md](../../perfect-aio.md), decisions D1–D12), in the order they
ship. Each section: what changed, why, and the exact before → after.

> Alpha policy: breaking changes are allowed and land here first. Where a change
> is mechanical, `aiol` gains an auto-fix (D10).

---

## B1 — One cell style: methods (Style B removed)

**What changed.** `cell()` accepts exactly one shape. The redux-era config keys
are gone: `actions:`, `reduce:`, `execute:`, `machine:`, `generators:`, and
middleware. (Evidence for removal: 2,943 LOC serving a style used by zero
examples and zero field apps.)

**Kept:** `state`, `methods`, `selectors`, `cancelOn`, `sync`, `persist`, `ui`,
`init`, `destroy`, schedule/own effects returned from methods. **Upgraded:**
`listensTo` gains an object form that actually runs a handler —
`listensTo: { onCleared: cart.clear }` runs the sync method
`onCleared(s,
payload)` whenever `cart:clear` dispatches (the array form only
routes).

### actions + reduce → methods

```ts
// BEFORE (Style B)
cell("counter", {
  state: { count: 0 },
  actions: { increment: (by: number) => ({ by }) },
  reduce: {
    increment: (s, p) => {
      s.count += p.by;
    },
  },
});

// AFTER — one thing instead of two
cell("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by: number) {
      s.count += by;
    },
  },
});
```

### execute / effects → just do it in the method

```ts
// BEFORE: reduce returns an effect, execute performs it
reduce:  { save: (s) => [cellRef.fx.persist(s.doc)] },
execute: { persist: async (app, p) => { await db.write(p); } },

// AFTER: the method does the work (async methods batch their writes)
methods: {
  async save(s) { await db.write(s.doc); s.savedAt = Date.now(); },
},
```

### machine guards → a guard line

```ts
// BEFORE
machine: { initial: "idle", states: { idle: { on: { start: "running" } } } },

// AFTER — plain code, same guarantee
methods: {
  start(s) {
    if (s.status !== "idle") return;   // ignored in any other state
    s.status = "running";
  },
},
```

`status` is now just a state field you own. (`t.expect.status(...)` in tests
becomes `t.expect.state((s) => s.status === "...")`.)

### generators → async methods + helpers

```ts
// BEFORE
generators: {
  checkout: function* (ctx) {
    yield* ctx.call("pay", () => api.pay());
    const r = yield* ctx.race({ ok: ctx.waitFor(bank.confirm), t: ctx.sleep("t", 30000) });
    yield* ctx.done((s) => { s.status = "paid"; });
  },
},

// AFTER — standard JavaScript
import { race, sleep, until } from "aio";

methods: {
  async checkout(s) {
    await api.pay();
    const r = await race({ ok: until(() => s.confirmed), timeout: 30_000 });
    if (r.winner === "timeout") { s.status = "expired"; return; }
    s.status = "paid";
  },
},
```

| generator ctx                                   | replacement                                        |
| ----------------------------------------------- | -------------------------------------------------- |
| `yield* ctx.call(name, fn)`                     | `await fn()`                                       |
| `yield* ctx.waitFor(action)` / `ctx.when(pred)` | `await until(() => predicateOverState)`            |
| `yield* ctx.race({...})`                        | `await race({...})` (`timeout: ms` sugar included) |
| `yield* ctx.all(...)`                           | `await Promise.all([...])`                         |
| `yield* ctx.sleep(name, ms)`                    | `await sleep(ms)`                                  |
| `yield* ctx.mutate/done(fn)`                    | mutate `s` directly                                |
| `yield* ctx.fail(reason)`                       | `throw new Error(reason)`                          |
| `yield* ctx.dispatch/send(a)`                   | call the other cell's method                       |

### cancellation → `cancelOn` + `s.$signal`

`cancelOn` survives (now for async methods):

```ts
cell("checkout", {
  cancelOn: { place: [cart.clear] }, // cart.clear aborts a running place()
  methods: {
    async place(s: CheckoutState & Partial<MethodDraftMeta>, item: Item) {
      s.status = "placing";
      const r = await fetch(url, { signal: s.$signal }); // abortable IO
      if (s.$signal!.aborted) {
        s.status = "cancelled";
        return;
      }
      s.status = "placed";
    },
  },
});
```

`s.$signal` is always present at runtime in async methods; annotate the draft
with `& Partial<MethodDraftMeta>` (from `aio`) to type it.

### Removed exports (compile-time list)

Gone from `aio`: `actions`, `effects` (the factory helpers),
`composeMiddleware`, `MiddlewareFn`, `ActionsCellConfig`, `ReduceHandlers`,
`ExecuteHandlers`, `FlatActions`, `MachineConfig`, `Gen`, `GenCtx`,
`SingleStepGen`, `FlowDef`, `FlowStep`, `TypedCreator`, and the
`aio.middleware.*` namespace. New in `aio`: `until`, `race`, `sleep`,
`UntilTimeoutError`, `MethodDraftMeta`.

`deno task lint` (aiol) detects removed config keys statically and prints the
exact migration mapping per cell — run it first on an old app.

### middleware → built-ins

The real uses of middleware are framework features now: logging → the logger +
`am log`; perf budgets → vitals; storm protection → the dispatch-storm detector
(on by default); validation → cell definition-time checks + `guard` lines in
methods.

---

_(Sections B2 — app instances, B3 — local-first, B4 — envelope/SQLite/extras
will be appended here as they land.)_
