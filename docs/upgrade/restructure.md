# The aio restructure — alpha27/alpha28 breaking changes

This guide tracks **every breaking change** of the restructure
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
`listensTo: { onCleared: cart.clear }` runs the sync method `onCleared` whenever
`cart:clear` dispatches (the array form only routes). The foreign method's
arguments arrive SPREAD, so the handler mirrors its parameter list:
`listensTo: { onAdded: cart.add }` + `onAdded(s, item, qty) { … }` (alpha29: was
the raw `{ args }` envelope before).

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

## B2 — Multiple apps per process (instances)

**What changed.** The process-wide "aio.run() already called" gate is gone.
Several apps can now coexist in one process — each with an explicit, disjoint
`cells:` list:

```ts
const app1 = await aio.run({ cells: [a], appId: "one", libraryMode: true });
const app2 = await aio.run({ cells: [b], appId: "two", libraryMode: true });
```

- A cell def binds to exactly ONE app — binding it twice throws a loud error
  that explains the fix (factory pattern for shared shapes).
- Zero-config `aio.run()` (no `cells:`) binds EVERY imported cell — only the
  first app in a process can use it.
- `aio.run(initialState, config)` — the legacy 2-arg form — was removed (zero
  known callers). Use `cell()` + `aio.run({ cells })`.
- Tests: `_resetAioRuntime()` (one call) resets the module-scoped runtime.

## B3 (phase 1) — Explainable rejections + the server seam

No breaking changes — two additions:

- **`sync.onRejected`**: when the server refuses an optimistic op (validate
  failed on re-execution), the client no longer drifts silently — the op is
  pruned, state rebases, and your callback fires:

  ```ts
  sync: {
    onRejected: (({ reason }) => toast(`server said no: ${reason}`));
  }
  ```

- **`serverFns` / `serverFn`** — the explicit server/client seam. Define in a
  `*.server.ts` module; call from anywhere (browser gets a typed WS proxy):

  ```ts
  // api.server.ts
  export const api = serverFns("api", { hash: (s: string) => bcrypt(s) });
  // anywhere
  const fns = serverFn<typeof api>("api");
  await fns.hash("secret");
  ```

## B4a — SQLite-only persistence (Deno.Kv removed)

- Persisted cell state now lives in your app's single `data.db` (`aio_kv` table)
  — inspect it with `am sql`.
- **No code changes.** Legacy Deno.Kv data migrates automatically on first boot
  (the old store is left untouched); the `unstable: ["kv"]` flag can be deleted
  from your deno.json.
- Value size is no longer capped at Deno.Kv's 64 KiB.

## B4b — One typed wire catalog (D7, phase 1)

No app-facing changes. Every frame on every transport (WS browser/cli, UDS,
Electron IPC) is now catalogued and typed in ONE place —
`src/protocol/envelope.ts` — and a CI test pins the catalog against the live
transports: an undocumented frame fails the build. Defects fixed along the way:

- AIR's ack parse diverged from the shared one (`indexOf` vs `lastIndexOf`) — a
  cid containing `:` broke only on the AIR path. One parse now.
- `__sync_error` was emitted by the server but silently dropped by the client
  (which then hung in "syncing"). It now logs loudly and re-requests sync.
- AIR clients never sent the `__proto` version hello, so the protocol gate
  didn't apply to them. They do now.
- UDS silently dropped CRDT-sync/serverFn frames (WS-only features) — it now
  rejects them with a loud log naming the fix.
- The dead legacy `$p`/`$d` delta parse (no sender since the Immer-patches
  format) was removed from the CLI client.

Byte-level unification into a single JSON envelope is deferred to the next
`PROTOCOL_VERSION` bump — the catalog types the existing v1 bytes, so old and
new peers stay compatible.

## B4c — Core diet: periphery moved to `aio/extras`

The main `aio` entry now carries only the measured core. If an import breaks,
change the specifier — nothing was deleted:

```ts
// before                                   // after
import { deepFreeze, instances } from "aio";
import { deepFreeze, instances } from "aio/extras";
```

Moved: `lint`, `parseCli`, `draft`, `matchEffect`, `deepFreeze`, `markAsync`,
`instances`, `resolveAppId`, `connectCliUDS`, `createSliceSelector`,
`DEFAULT_PRAGMAS`, `UnionOf` + deep diagnostic/vitals detail types and the
low-level action/reduce plumbing types. `deno task lint` (aiol) flags old
imports with the exact fix.

## alpha29 — `ui.exclude` enforced at client read seams

Client-context reads (browser, standalone/electron/android, testUI) of a
ui-hidden field now return `undefined` with a one-time warning — previously
standalone exposed the real value and browsers showed the bundled initial value.
`ui: "none"` cells read `undefined` client-side; client selectors compute over
the filtered slice. Server code (routes, effects) still sees everything. If
client code legitimately needs a field, remove it from `ui.exclude`; if it's a
secret, it now actually stays secret.

Also alpha29: `listensTo` object-form handlers receive the foreign method's
arguments spread (`onAdded(s, item, qty)`) instead of the raw `{ args }`
envelope — update handlers that destructured the envelope by hand.
