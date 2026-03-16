# AIO Upgrade Guide

How to upgrade between aio versions. Each section lists what changed, what breaks, and exact steps to update your code.

---

## v0.8 → v0.9

### Breaking changes

**`AioDB` / `AioTable<T>` removed — async `DB` replaces sync ORM**

All `app.db` calls must be awaited. The old synchronous API is gone.

```ts
// BEFORE (v0.8)
const users = app.db!.users.findAll()
app.db!.users.insert({ name: 'Alice' })

// AFTER (v0.9)
const { rows: users } = await app.db!.query<User>('SELECT * FROM users')
await app.db!.execute('INSERT INTO users (name) VALUES (?)', ['Alice'])
```

**`openDb()` / `loadTables()` / `syncTables()` / `reloadTable()` removed from public API**

These are now private internals. Schema is still declared the same way under `db:` in `aio.run()`.

**`lastInsertRowId` is now `bigint`** (was `number`)

```ts
// if you use lastInsertRowId, coerce it:
const id = Number(result.lastInsertRowId)
```

**Permissions: `--allow-ffi` no longer required**

Remove `--allow-ffi` from any launch scripts — it causes an error on some Deno versions now.

### New in v0.9

**Read replicas** — pass `readers: N` to `createDB()` for parallel query workers:

```ts
const db = await createDB('./data.db', { readers: 4 })
```

**`log` public singleton** — import and use anywhere after `aio.run()`:

```ts
import { log } from 'aio'
log.info('payments', 'charge processed', { amount: 99 })
```

**UI sync rate** — `ui.syncRate` added (default `10` ms = 100fps cap). Set `syncRate: 0` for the old unbounded behavior.

### Upgrade steps

1. Update `deno.json` — replace `"aio": "./dep/aio/mod.ts"` with `"aio": "jsr:@riagentic/aio@^0.9"` and update task commands to use `jsr:@riagentic/aio@^0.9/src/am` / `jsr:@riagentic/aio@^0.9/src/build`
2. Remove `dep/aio/` from your project (no longer needed)
3. Remove `--allow-ffi` from any launch scripts
4. Await all `app.db` calls (now async)
5. Coerce `lastInsertRowId` to `Number()` if used
6. Run `deno install && deno task dev`

---

## v0.7 → v0.8

### Breaking changes

**`reduce` and `execute` are now objects (named handlers)**

The function form with `{ A }` / `{ E }` context is removed from the default path.

```ts
// BEFORE (v0.7)
reduce(state, action, { A, E }) {
  switch (action.type) {
    case A.Increment:
      state.count += action.payload.by
      return [E.log(`count: ${state.count}`)]
    case A.Reset:
      state.count = 0
      break
  }
},
execute(app, effect, { E, A }) {
  switch (effect.type) {
    case E.Log:
      console.log(effect.payload.message)
      break
    case E.Persist:
      db.save(effect.payload.value).then(() => app.dispatch(A.saved()))
      break
  }
},

// AFTER (v0.8)
reduce: {
  increment(state, payload) {
    state.count += payload.by
    // effects wired via execute — no return needed
  },
  reset(state) {
    state.count = 0
  },
},
execute: {
  log(_app, payload) {
    console.log(payload.message)
  },
  async persist(app, payload) {
    await db.save(payload.value)
    app.dispatch(myFeature.A.saved())
  },
},
```

**Migration:**
1. Convert `reduce(state, action, { A, E }) { switch ... }` → `reduce: { handlerName(state, payload) {} }`
2. Convert `execute(app, effect, { E, A }) { switch ... }` → `execute: { handlerName(app, payload) {} }`
3. Remove all `{ A }` and `{ E }` destructuring from reduce/execute signatures

**For foreign action handling** — use the function form with `{ on }`:

```ts
// When your reducer needs to react to another feature's actions
reduce(state, action, { on }) {
  on(counter.increment, (payload) => {
    state.watchedCount = payload.by
  })
  // own actions still handled normally
},
```

---

**Lowercase action type strings**

Action types changed from `'Feature:Action'` to `'feature:action'` format.

```ts
// BEFORE (v0.7)
if (action.type === 'Counter:Increment') { ... }
listensTo: ['Counter:Increment', 'Wallet:Transfer']
cancelOn(['Counter:Stop'], fn)
ctx.waitFor('Payment:Complete')
machine: { states: { active: { 'Counter:Increment': 'active' } } }

// AFTER (v0.8) — use .type or pass function directly
if (action.type === counter.increment.type) { ... }
listensTo: [counter.increment, wallet.transfer]
cancelOn([counter.stop], fn)
ctx.waitFor(payment.complete)
machine: { states: { active: { [counter.increment.type]: 'active' } } }
```

**Migration:** Find all raw action type strings (pattern: `'Foo:Bar'`) and replace with bound method `.type` references or function references.

---

**`feature.A` scope — internal only**

`feature.A` is now considered internal. Application code should not use it. Remove all:

```ts
// REMOVE from application code:
send(counter.A.increment(5))     // → send.increment(5)
dispatch(counter.A.increment(5)) // → counter.increment(5) or use in ctx.dispatch only

// KEEP in generator ctx.dispatch (A catalog still needed here):
yield* ctx.dispatch(wallet.A.credit(100))  // fine — ctx.dispatch needs an action object

// KEEP in testFeature (A catalog used internally):
// testFeature handles this automatically
```

---

### Migration steps

1. **Convert reduce** — find all `reduce(state, action, { A` patterns, convert to object form
2. **Convert execute** — find all `execute(app, effect, { E` patterns, convert to object form
3. **Fix action type strings** — find all `'PascalCase:PascalCase'` strings, replace with `.type` references
4. **Fix listensTo** — replace string arrays with bound method arrays
5. **Fix cancelOn** — replace string triggers with bound method triggers
6. **Fix ctx.waitFor** — replace string form with bound method form
7. **Fix machine on keys** — replace raw string keys with computed `[feature.method.type]`
8. **Remove `send(feature.A.method(args))`** — replace with `send.method(args)`
9. Replace `dep/aio/` with the v0.8 folder
10. Run `deno install && deno task dev` — linter will flag remaining issues

### What doesn't break

- `feature({ methods })` — unchanged
- `feature({ generators })` — unchanged
- `useFeature` / `send.method()` — unchanged
- `call()` / direct cross-feature calling — unchanged
- All tests using `testFeature` — unchanged (send proxy unchanged)
- The function form `reduce(state, action, fn)` — available as escape hatch with `{ on }` / `{ emit }`
- `feature.A` still exists (internal) — `ctx.dispatch(feature.A.action())` still works

---

**`dispatchTo` accepts feature objects — string form removed** *(breaking)*

```ts
// BEFORE (v0.7)
dispatchTo: ['wallet', 'fleet']

// AFTER (v0.8)
import { wallet } from '../wallet'
import { fleet } from '../fleet'
dispatchTo: [wallet, fleet]
```

**Async method signature — `ctx` parameter removed**

Old async methods had `ctx` injected as the second parameter:
```ts
// v0.7 — ctx injected
async save(s, ctx, url: string) { ... }
async notify(s, ctx) { await ctx.call('notifications', 'send', 'done') }
```

In v0.8, async methods use the same `(s, ...args)` signature as sync methods:
```ts
// v0.8 — no ctx, direct import
async save(s, url: string) { ... }
async notify(s) { await notifications.send('done') }
```

**Migration:** remove `ctx` from all async method signatures. If you used `ctx.call('feature', 'method', ...)`, replace with a direct import and call: `import { notifications } from '../notifications'; await notifications.send('done')`.

**`machine: 'simple'` removed — use `machine: false`**

```ts
// before
feature('counter', { machine: 'simple', ... })

// after
feature('counter', { machine: false, ... })
```

**`flows:` key removed from `feature()` config — use `generators:` key instead**

```ts
// before (v0.7)
import { feature, flow } from 'aio'
feature('myFeature', {
  flows: {
    main: flow('start', function* (ctx) { ... }),
  },
})

// after (v0.8)
feature('myFeature', {
  generators: {
    start: function* (ctx) { ... },  // key matches action key
  },
})
```

**`flow()` export removed — use `generators` key directly**

`flow()` is no longer exported from `'aio'`. Wrap the generator function with `cancelOn(triggers, fn)` if you need declarative cancellation:

```ts
import { feature, cancelOn } from 'aio'

feature('healthCheck', {
  generators: {
    start: cancelOn([counter.stop], function* (ctx) { ... }),
  },
})
```

**`ctx.put` renamed to `ctx.dispatch` in generator context**

```ts
// before (v0.7)
yield* ctx.put(someFeature.A.doThing())

// after (v0.8)
yield* ctx.dispatch(someFeature.A.doThing())
```

**`t.expect.effects()` requires full type strings** *(breaking)*

```ts
// BEFORE (v0.7)
t.expect.effects(['log', 'persist'])

// AFTER (v0.8)
t.expect.effects(['counter:log', 'counter:persist'])
```

**Machine `on` is optional for terminal states**

```ts
// BEFORE — was required even when empty
states: { saving: {}, error: {} }

// AFTER — omit on entirely
states: { saving: {}, error: {} }
```

### What's NOT breaking

- `feature({ methods })` — unchanged
- `feature({ generators })` — unchanged
- `useFeature` / `send.method()` — unchanged
- `call()` / direct cross-feature calling — unchanged
- All tests using `testFeature` — unchanged (send proxy unchanged)
- The function form `reduce(state, action, fn)` — available as escape hatch with `{ on }` / `{ emit }`
- `feature.A` still exists (internal) — `ctx.dispatch(feature.A.action())` still works

### Migration steps

1. **Convert reduce** — find all `reduce(state, action, { A` patterns, convert to object form
2. **Convert execute** — find all `execute(app, effect, { E` patterns, convert to object form
3. **Fix action type strings** — find all `'PascalCase:PascalCase'` strings, replace with `.type` references
4. **Fix listensTo** — replace string arrays with bound method arrays
5. **Fix cancelOn** — replace string triggers with bound method triggers
6. **Fix ctx.waitFor** — replace string form with bound method form
7. **Fix machine on keys** — replace raw string keys with computed `[feature.method.type]`
8. **Remove `send(feature.A.method(args))`** — replace with `send.method(args)`
9. **Fix `dispatchTo`** — replace string arrays with imported feature refs
10. **Fix `t.expect.effects()`** — prefix all effect keys with `featureName:`
11. **Fix async method signatures** — remove `ctx` parameter
12. Replace `dep/aio/` with the v0.8 folder
13. Run `deno install && deno task dev` — linter will flag remaining issues

---

## v0.1 → v0.2

### New features

- **CSS hot reload** — CSS-only changes inject without page reload (React state preserved)
- **`--expose` flag** — bind `0.0.0.0` with auto-generated UUID token for LAN access
- **`--version` / `--help` flags**
- **`--url` thin client** — launch Electron connecting to a remote aio server. See [electron.md — Thin client](electron.md#thin-client---url)
- **`--width` / `--height` flags** — override Electron window dimensions from CLI
- **Window config** — `ui: { width, height }` sets default Electron window size. Embedded as `<meta>` tags for thin client discovery
- **Window state persistence** — Electron remembers window bounds across runs via `window-state.json`
- **Configurable `persistDebounce`** — control KV write frequency (default: 100ms)
- **Per-user `stateForUI(state, user?)`** — server-controlled per-user state filtering
- **Multi-user auth** — `users: Record<string, AioUser>` token map with per-user identity. See [auth.md — Multi-user auth](auth.md#multi-user-auth)
- **camelCase factory creators** — `A.increment()` alongside `A.Increment` label
- **Startup linter** — validates state, config, App.tsx, esbuild, electron on boot
- **Error overlay** — transpile errors shown on page instead of blank screen
- **Guardrail hardening** — bad reducer output, invalid effects, and reducer throws are caught and logged instead of crashing
- **Lifecycle hooks** — 6 optional `on*` callbacks with `user?` parameter: `onAction`, `onEffect`, `onConnect`, `onDisconnect`, `onStart`, `onStop`. Observe-only, error-guarded. See [core.md — Lifecycle hooks](core.md#lifecycle-hooks)
- **Time-travel** — dev mode records action history with undo/redo/goto. Press Ctrl+. for browser panel, or use `am tt undo`. `useTimeTravel()` hook for programmatic control. 200-entry cap, zero cost in prod. See [ui.md — Time-Travel](ui.md#time-travel)
- **am — app manager** — CLI for process lifecycle, state inspection, dispatch, time-travel, log tailing. `deno task am help`. Output: pretty for terminals, JSON for scripts/agents. See [cli.md — am](cli.md#am--app-manager)
- **Connection status indicator** — shows "Reconnecting..." pill on disconnect and "Connected" briefly on reconnect. Pure DOM, no user code. Disable with `ui: { showStatus: false }`
- **State snapshots** — `app.snapshot()` / `app.loadSnapshot(json)` + HTTP `GET/POST /__snapshot`. See [persistence.md — State snapshots](persistence.md#state-snapshots)
- **Scheduled effects** — `schedule.after/every/at/cron/cancel` — declarative timers, intervals, cron jobs as effects. See [core.md — Scheduled effects](core.md#scheduled-effects)
- **aio-client** — standalone Electron connect-page app (`compile:electron:remote`). Connects to any aio server without Deno
- **One-liner init** — `sh -c "$(curl -fsSL .../init.sh)" -- my-app` scaffolds a new project with interactive template menu
- **SQLite persistence** — 3-tier data layer for structured data. `db: { orders: table({...}) }` in config. Level 1: auto-sync arrays to/from SQLite. Level 2: `app.db.orders.where(...)` ORM. Level 3: `app.db.query(...)` raw SQL. Uses `node:sqlite` (built into Deno 2.2+, zero deps). See [persistence.md — SQLite](persistence.md#sqlite-persistence)

### Breaking changes

#### 1. `execute(app, effect)` parameter order swapped

**v0.1:** `execute(effect, app)`
**v0.2:** `execute(app, effect)`

This matches `reduce(state, action)` — context first, thing-to-process second.

```diff
- export function execute(effect: Effect, app: AioApp<AppState, Action>): void {
+ export function execute(app: AioApp<AppState, Action>, effect: Effect): void {
```

The startup linter warns if your first parameter is named `effect`.

#### 2. `subscribe()` removed

`subscribe(keys)` was a client-side bandwidth filter. It's been replaced by `stateForUI(state, user?)` — a server-controlled per-user filter that's more secure and doesn't leak the full state shape.

**If you used `subscribe()`:**

```diff
  // App.tsx — REMOVE subscribe call
- import { useAio, subscribe } from 'aio'
+ import { useAio } from 'aio'

  export default function App() {
    const { state, send } = useAio<UIState>()
-   useEffect(() => { subscribe(['stats']) }, [])
    // ...
  }
```

```diff
  // app.ts — ADD stateForUI with per-user filtering
  await aio.run(initialState, {
    reduce, execute,
-   stateForUI: (s) => s,
+   stateForUI: (s, _user?) => ({ stats: s.stats }),  // server controls what clients see
  })
```

#### 3. Factory creators are now camelCase

**v0.1:** Only PascalCase labels existed (`A.Increment` = string `"Increment"`)
**v0.2:** Also generates camelCase creators (`A.increment(5)` = `{ type: "Increment", payload: { by: 5 } }`)

No breaking change if you used the old `msg()` pattern — it still works. But the recommended pattern is now:

```ts
// Old (still works)
send(msg('Increment', { by: 5 }))

// New (recommended)
send(A.increment(5))
```

### Upgrade steps

1. **Swap execute params:** Find `execute(effect, app)` → change to `execute(app, effect)`
2. **Remove subscribe:** Delete any `subscribe()` calls from App.tsx. If you need per-user filtering, add `stateForUI: (s, user?) => ...` to your `aio.run()` config
3. **Update dep/aio/:** Copy the new `dep/aio/` folder over the old one
4. **Run `deno install`**
5. **Run `deno task dev`** — the startup linter will catch remaining issues

---

## v0.2 → v0.3

### New features

- **Performance budgets** — dispatch loop timing with configurable thresholds. `perfMode: 'strict' | 'soft'` and `perfBudget: { reduce?, effect? }` in config. Violations call `onError({ source: 'performance', ... })` or warn (soft). Per-action perf metrics recorded in time-travel history. See [scaling.md — Performance budgets](scaling.md#performance-budgets)
- **Redux DevTools** — connect to the Redux DevTools browser extension for state inspection and action history. `connectDevTools()` / `disconnectDevTools()` from `'aio'`. See [ui.md — Redux DevTools](ui.md#redux-devtools-integration)
- **Incremental SQLite sync** — tables with a `pk()` column now use row-level INSERT/UPDATE/DELETE diffs instead of full table replacement. Significantly faster for large datasets. No migration needed — PK detection is automatic
- **Memoized selectors** — `createSelector(...inputFns, resultFn)` and `createSliceSelector`. Caches derived values until inputs change, preventing redundant recalculations.
- **`matchEffect(effect, handlers, fallback?)`** — typed alternative to switch/case in `execute()`. Scales better for large effect catalogs.
- **`composeMiddleware(...fns)`** — compose multiple `beforeReduce` functions into a single pipeline. Return `null` from any function to drop the action.
- **Android schedule warning** — unsupported schedule effects on Android now log `console.warn` instead of silently dropping

### Breaking changes

None. All v0.2 code runs unchanged on v0.3.

### Upgrade steps

1. Replace `dep/aio/` with the v0.3 folder
2. Run `deno install`
3. Run `deno task dev` — no linter warnings expected for v0.2 code

### Optional improvements

Take advantage of new features at your own pace:

```ts
// Performance budgets (catch slow reducers in CI)
await aio.run(state, {
  reduce, execute,
  perfMode: 'strict',
  perfBudget: { reduce: 50, effect: 3000 },
  onError: ({ source, error }) => console.error(`[${source}]`, error),
})
```

```tsx
// Redux DevTools (add to App.tsx in dev)
import { useAio, connectDevTools } from 'aio'
export default function App() {
  const { state, send } = useAio<AppState>()
  useEffect(() => { connectDevTools() }, [])
  // ...
}
```

```ts
// Memoized selectors (avoid recomputing expensive derivations)
import { createSelector } from 'aio'
const selectFiltered = createSelector(
  (s: AppState) => s.items,
  (s: AppState) => s.filter,
  (items, filter) => items.filter(i => i.status === filter),
)
```

---

## v0.3 → v0.4

### New features

- **Zero-config HTTPS** — `--expose` now auto-generates a self-signed ECDSA P-256 cert (cached in `.aio-tls/`). Traffic is encrypted by default. Use `--cert=path.pem --key=path.pem` to bring your own CA-signed cert. Electron windows accept self-signed localhost certs automatically
- **`am watch [dir]`** — hot-restart on `.ts`/`.tsx` changes in `src/` (or custom dir). 300ms debounce, same as `am restart`. Usage: `deno task am watch` or `deno task am watch src/`
- **`am logs --follow` / `-f`** — stream log output live (like `tail -f`). Usage: `deno task am logs -f` or `deno task am logs --follow [filter]`
- **`am status` exit codes** — now explicit: `0`=started, `1`=stopped, `2`=transitional (starting/stopping). Useful for scripts and CI
- **`persistMode:'multi'`** — store each top-level state key as a separate Deno.Kv entry, bypassing the 65KB/key limit. Set `persistMode: 'multi'` in config
- **ORM additions** — `table.whereOr(filters[])` for OR-joined WHERE, `table.upsert(row)` for INSERT OR REPLACE, `QueryOpts` with `orderBy`, `limit`, `offset` on `all(opts?)` and `where(filter, opts?)`

### Bug fixes

- **`_computeDelta` threshold** — fixed denominator to `Math.max(newKeys, oldKeys)` — previously undercounted when state keys were removed, causing unnecessary full-state broadcasts
- **`scheduleReload` symlink** — resolves real path via `Deno.realPathSync` before cache lookup — fixes hot-reload on macOS (`/var` → `/private/var` symlink)
- **`syncTables` full scan** — eliminated `SELECT * FROM table` on every sync cycle; now diffs state vs previous in memory. Zero DB reads per sync

### Breaking changes

None. All v0.3 code runs unchanged on v0.4.

### Upgrade steps

1. Replace `dep/aio/` with the v0.4 folder
2. Run `deno install`
3. Run `deno task dev` — no changes required

### Optional improvements

```sh
# Hot-restart on file changes
deno task am watch

# Stream logs live
deno task am logs -f

# Check if app is running (exit code 0=yes, 1=no, 2=transitional)
deno task am status; echo $?
```

```ts
// Bypass 65KB KV limit for large state
await aio.run(state, {
  reduce, execute,
  persistMode: 'multi',
})
```

```ts
// ORM: OR queries, upsert, pagination
const adults = table.whereOr([{ role: 'admin' }, { role: 'mod' }])
table.upsert({ id: 1, name: 'alice' })
const page = table.all({ orderBy: 'name', limit: 20, offset: 40 })
```

```sh
# Expose with auto-HTTPS (zero config)
deno task dev --expose

# Expose with your own cert
deno task dev --expose --cert=/etc/ssl/myapp.pem --key=/etc/ssl/myapp.key
```

---

## v0.6 → v0.7

### New features — reactive features

v0.7 adds `reactive()`, improves `flow()`, and overhauls DX. No breaking changes. All v0.6 code works unchanged.

**reactive() — plain methods instead of reduce/execute** *(removed in v0.8 — use `feature({ methods })` instead)*
- Sync methods mutate state via Immer draft, can return schedule effects
- Async methods get live Proxy — reads always fresh, writes auto-dispatch
- Machine-gated async writes via method-tagged `__setMethod` actions
- Microtask batching — consecutive Proxy writes grouped into one action per sync frame
- `listensTo: string[]` — foreign action listeners without a full machine
- Selectors, dispatchTo, onInit/onDestroy hooks all work

**flow() improvements**
- `ctx.waitFor(actionType, timeout?)` — pause until external action dispatched
- `ctx.getState()` — read current feature state inside a flow
- `cancelOn: string[]` — declarative flow cancellation on arbitrary actions
- `ctx.dispatch()` accepts `{ type, payload? }` — payload optional
- Flow errors fed back into generator for try/catch support

**DX**
- Direct calling — `counter.increment(5)` after `aio.run()`, no `.A.` namespace (all three tiers)
- TypeScript inference — typed autocomplete for methods and selectors
- Pre-bind console.warn when methods called before `aio.run()`
- `machine: false` — no state machine guards, all actions always allowed
- FeatureDef phantom State type for testFeature inference
- `useSyncExternalStore` in useAio/useFeature for selective re-renders
- `useFeature(ref)` added — scoped state, typed send, machine status, selective re-renders
- Startup linter validates empty features, `_status` reserved key, empty actionKeys
- `--type` and `--template` CLI flags for non-interactive scaffolding
- Async `testFeature()` — `t.runEffects()` + `t.settle(ms?)`

**Infra**
- Nested delta patches for fine-grained state sync
- UDS transport — zero TCP ports in prod electron builds
- `Msg<P>` generic for typed payload access without casts
- WebSocket payload validation, per-user action authorization
- App identity with identity-based singleton lock

### What's NOT breaking

- `feature()` with reduce/execute works exactly as before
- `flow()` works exactly as before
- All existing tests pass unchanged
- Reactive features are fully optional — use any combination of reactive, flow, and feature

### Upgrade steps

1. Replace `dep/aio/` with the v0.7 folder
2. Update `deno.json` version to `"0.7.0"`
3. Done — no code changes required

### Using reactive (optional)

```ts
import { reactive } from 'aio'

const counter = reactive('counter', {
  state: { count: 0 },
  listensTo: ['Other:ActionType'],  // foreign listeners without a machine
  methods: {
    increment(s, by = 1) { s.count += by },
    startTimer(s) {
      s.active = true
      return { _schedule: true, key: 'tick', type: 'Counter:Tick', intervalMs: 1000 }
    },
    async save(s) {
      await Deno.writeTextFile('data.json', String(s.count))
      s.saved = true
    },
  },
})

await aio.run({ features: [counter] })
counter.increment(5)   // dispatches directly — no .A. needed
```

### Flow improvements (optional)

```ts
// cancelOn — declarative cancellation
healthCheck: flow('start', { cancelOn: ['stop'] }, function* (ctx) {
  while (true) {
    yield* ctx.call('check', () => fetch('/health'))
    yield* ctx.sleep('wait', 30_000)
  }
})

// ctx.waitFor — pause until external action
// actions-style: payload destructured directly (no action wrapper)
purchase: flow('start', function* (ctx, { amount }: { amount: number }) {
  yield* ctx.dispatch(payment.A.charge(amount))
  const result = yield* ctx.waitFor('Payment:Complete', 10_000)
  yield* ctx.done(s => { s.paid = true })
})

// ctx.getState — read fresh state
yield* ctx.mutate('inc', s => { s.count++ })
const s = ctx.getState()
if (s.count >= 10) { yield* ctx.done(); return }
```

See [reactivity.md](reactivity.md) and [generators.md](generators.md) for full guides.

---

## v0.5 → v0.6

### New features — generator-based flows

v0.6 adds `flow()` — sequential async workflows using generators. *(The `flows:` key and `flow()` function were removed in v0.8 — use the `generators` key instead.)* No breaking changes from v0.5. All v0.5 code works unchanged on v0.6.

- **`flow(trigger, generatorFn)`** — define a sequential workflow triggered by an action. Write top-to-bottom async code; each yield point dispatches an action visible in time-travel
- **`GenCtx` API** — `ctx.call()` (async work), `ctx.step()` (state mutation), `ctx.done()` / `ctx.fail()` (terminal), `ctx.dispatch()` (dispatch), `ctx.all()` (parallel), `ctx.race()` (first wins), `ctx.sleep()` (pause)
- **`reduce` and `machine` now optional** — flow-only features don't need a reducer or machine definition
- **Auto-generated actions** — each yield point dispatches `{Feature}:Flow:{StepName}` automatically. No manual action/effect catalog needed for flows
- **Auto-cancellation** — re-triggering a flow cancels the previous instance. Feature disable/destroy cancels all running flows

### What's NOT breaking

- `feature()` with reduce/execute works exactly as before
- All existing tests pass unchanged
- `machine`, `reduce`, `execute`, `effects`, `bridge` — all untouched
- Flows are fully optional — features can use reduce, flows, or both

### Upgrade steps

1. Replace `dep/aio/` with the v0.6 folder
2. Update `deno.json` version to `"0.6.0"`
3. Done — no code changes required

### Using flows (optional)

```ts
import { feature, flow } from 'aio'

const myFeature = feature('myFeature', {
  state: { result: null },
  actions: { start: () => ({}) },
  flows: {
    main: flow('start', function* (ctx) {
      const data = yield* ctx.call('fetch', () => fetchData())
      yield* ctx.done(s => { s.result = data })
    }),
  },
})
```

See [generators.md](generators.md) for the full guide.

---

## v0.4 → v0.5

### New features — feature-based architecture

v0.5 introduces `feature()` — one function defines state, actions, effects, state machine, reducer, executor, and selectors. The classic v0.4 API (`aio.run(initialState, config)`) has been removed as of v0.8 — migrate to `aio.run({ features })` using the steps below.

- **`feature(name, config)`** — one function replaces 7 files. Auto-prefixes action/effect types (`increment` → `'Counter:Increment'`). Wraps reducer in Immer `produce()` automatically
- **State machines** — required for every feature. Declares explicit states and transitions. Invalid transitions are dropped. Typos in machine keys cause startup errors. `_status` field auto-managed by framework
- **`A` and `E` dual-role objects** — labels for `switch/case` + creators for `dispatch/return`. `A.Increment` is the string, `A.increment(5)` creates the action
- **`aio.run({ features: [...] })`** — new overload. Auto-composes initial state, reducer, executor. Validates dependency graph. Topological sort for init
- **`useFeature(counter)`** — scoped React hook: `{ state, send, status }`. State = feature's slice only. Send = typed action senders. Status = current machine state
- **`bridge()`** — cross-feature request/response coordination with timeouts, retries, correlation IDs, metrics
- **`testFeature()`** — test harness with `send`, `expect.state()`, `expect.status()`, `expect.effects()`, `randomActions()`
- **Cross-feature communication** — selectors (read), listening (foreign actions in machine), bridge (request/response)
- **Scoped executor dispatch** — executor can only dispatch own feature's actions; foreign dispatch blocked at runtime
- **Single-instance lock** — `singleton: true` (default) prevents multiple instances on same port
- **Middleware system** — `aio.middleware.logger()`, `.validate()`, `.metrics()`, `.freeze()`, `.perfBudget()`, `.create(fn)`. Chain multiple middlewares via `middleware: [...]` in config
- **Lifecycle onInit/onDestroy** — `onInit(app)` and `onDestroy(app)` hooks per feature (`app` is a `ScopedApp` with `.dispatch()` and `.getState()`). Auto-generated `Counter:Init` / `Counter:Destroy` actions. Dependency-ordered onInit, reverse-ordered onDestroy
- **Source auto-tagging** — actions tagged with `_source: 'UI' | 'Effect' | 'System' | 'Test'` at dispatch points. `tagSource(action, source)` helper exported
- **Dead-end detection** — machine states with no outgoing transitions emit a console warning at definition time (not a hard error)
- **Circuit breaker runtime** — bridge circuit breaker tracks failures, opens after threshold, auto-resets after timeout. Half-open state allows one probe request. `isCircuitOpen` selector on bridge
- **Retry logic** — bridge channels support `retries: N` with automatic re-dispatch on timeout. Tracks `retryCount` per pending request
- **`testBridge()` harness** — test bridge channels with `request`, `respond`, `timeout`, `expect.pending()`, `expect.circuitOpen()` helpers
- **State versioning & migrations** — `version: N` + `migrations: [(s) => newS]` in config. Sequential migration on restore, falls back to initial state on error
- **`--isolate` flag** — `--isolate=counter,dc` or `isolate: ['counter']` in config. Filters active features in dev mode
- **Health endpoint** — `GET /__health` returns `{ status, uptime, features: { name: { status, errors } } }`
- **`app.features` API** — `.enable(name)`, `.disable(name)`, `.status(name)`, `.health()`, `.list()` on the returned `AioApp`
- **Feature registry** — tracks enabled/disabled state, error counts, last action per feature. Powers health endpoint and `app.features`

### Breaking changes when adopting features

**If you migrate to `feature()`**, these things change:

#### 1. State shape — feature-namespaced

**v0.4:** State is flat or manually namespaced:
```ts
const initialState = { count: 0, items: [] }
```

**v0.5:** Each feature's state lives under `state.featureName`:
```ts
// Framework auto-generates:
// { counter: { count: 0, _status: 'idle' }, items: { list: [], _status: 'idle' } }
```

**Impact: existing Deno.Kv persistence is incompatible.** The first run after migration will start from the new initial state. Your old persisted state will be ignored (different key structure). If you need to keep old data, export a snapshot before migrating, transform the JSON to the new shape, and import it.

#### 2. Action naming — camelCase keys, auto-prefixed

**v0.4:** You define PascalCase keys with optional domain prefix:
```ts
const A = actions('Counter', { Increment: (by: number) => ({ by }) })
// A.Increment = 'Counter:Increment'
// A.increment(5) = { type: 'Counter:Increment', payload: { by: 5 } }
```

**v0.5:** You define camelCase keys, prefix is auto-derived from feature name:
```ts
const counter = feature('counter', {
  actions: { increment: (by: number) => ({ by }) }
})
// counter.A.Increment = 'Counter:Increment'   — same string!
// counter.A.increment(5) = same { type, payload }
```

The dispatched type strings are the same (`'Counter:Increment'`). But the *definition* syntax changes: `Increment:` key → `increment:` key.

#### 3. Reducer — no more `draft()`, state is the draft

**v0.4:**
```ts
import { draft } from 'aio'

function reduce(state: AppState, action: Action) {
  return draft(state, d => {
    switch (action.type) {
      case A.Increment:
        d.count += action.payload.by
        return [E.log('inc')]
      default:
        return []
    }
  })
}
```

**v0.5:**
```ts
reduce(state, action, { A, E }) {
  switch (action.type) {
    case A.Increment:
      state.count += action.payload.by    // state IS the draft — mutate directly
      return [E.log('inc')]               // return effects or nothing
    case A.Reset:
      state.count = 0
      break                               // break = no effects
  }
  // no default needed — unhandled actions are a no-op
}
```

Key changes:
- No `draft()` import or wrapper — framework handles Immer automatically
- `state` parameter IS the Immer draft — mutate directly
- Return effects array to produce effects, or `break`/return nothing for no effects
- No need for `default: return []` — unhandled cases are ignored
- Receives `{ A, E }` context — no need to import action/effect catalogs
- Reducer only sees its feature's state slice, not the full app state

#### 4. Executor — receives scoped app + context

**v0.4:**
```ts
function execute(app: AioApp<AppState, Action>, effect: Effect) {
  switch (effect.type) {
    case E.Persist:
      Deno.writeTextFile('./data.json', String(effect.payload.value))
        .then(() => app.dispatch(A.saved()))
      break
  }
}
```

**v0.5:**
```ts
execute(app, effect, { E, A }) {
  switch (effect.type) {
    case E.Persist:
      Deno.writeTextFile('./data.json', String(effect.payload.value))
        .then(() => app.dispatch(A.saved()))
      break
  }
}
```

Key changes:
- Receives `{ E, A }` context — no need to import
- `app.dispatch()` only accepts this feature's actions — dispatching another feature's action throws an error
- `app.getState()` returns the full app state (for reading via selectors)

#### 5. UI hooks — `useFeature()` for feature components, `useAio()` for layout

**v0.4:**
```tsx
import { useAio } from 'aio'
import { A } from './actions.ts'
import type { AppState } from './state.ts'

function App() {
  const { state, send } = useAio<AppState>()
  if (!state) return <div>Loading...</div>
  return <button onClick={() => send(A.increment(5))}>+5</button>
}
```

**v0.5:**
```tsx
import { useFeature } from 'aio'
import { counter } from '../features/counter/index.ts'

function CounterPage() {
  const { state, send, status } = useFeature(counter)
  if (!state) return <div>Loading...</div>
  return (
    <div>
      <button onClick={() => send.increment(5)}>+5</button>
      <p>Status: {status}</p>
    </div>
  )
}
```

Key changes:
- `useFeature(counter)` replaces `useAio<AppState>()`
- `state` is scoped to this feature's slice — `state.count` not `state.counter.count`
- `send.increment(5)` replaces `send(A.increment(5))` — typed action senders directly on send
- `status` gives current machine state — `'idle'` | `'saving'` | etc.
- `useAio()` is the right choice for root layout, routing, and cross-feature views

#### 6. State machines — new required field

Every feature needs a `machine:` declaration:

```ts
machine: {
  initial: 'idle',
  states: {
    idle:   { increment: 'idle', save: 'saving' },
    saving: { saved: 'idle', saveFailed: 'error' },
    error:  { retry: 'saving', dismiss: 'idle' },
  },
}
```

- Every action must appear in at least one state's `on:` transitions
- Action keys in `on:` must match declared action names exactly (typo → startup error)
- Every state must be reachable from `initial`
- `_status` is managed by the framework — never set it manually in reduce
- For trivial features with no lifecycle: `machine: false` (all actions valid in all states, no `_status`)

#### 7. Selectors — feature-scoped

**v0.4:**
```ts
import { createSelector } from 'aio'
const getCount = (state: AppState) => state.count
```

**v0.5:**
```ts
const counter = feature('counter', {
  // ...
  selectors: {
    getCount: (s) => s.count,  // receives feature's own state slice
  },
})
// Usage (after bindFeature / aio.run — no state arg needed):
const count = counter.getCount()
```

Selectors receive the feature's own state slice (auto-scoped by the framework). After `aio.run()`, call them directly — no state argument.

#### 8. Boot — `aio.run()` config changes

**v0.4:**
```ts
await aio.run(initialState, { reduce, execute, persist: true, port: 8000 })
```

**v0.5:**
```ts
await aio.run({
  features: [counter, dc, { feature: te, dependsOn: ['dc'] }],
  persist: true,
  port: 8000,
})
```

- No `initialState` — auto-composed from feature states
- No `reduce` / `execute` — auto-composed from features
- `features:` array with optional dependency declarations
- `beforeReduce` still works (passed through to the composed reducer)
- All other config options unchanged: `persist`, `port`, `ui`, `db`, `users`, `schedules`, `perfMode`, lifecycle hooks, etc.

#### 9. Testing — `testFeature()` harness

**v0.4:** Manual Deno.test setup:
```ts
Deno.test('increment', () => {
  const { state } = reduce(initialState, A.increment(5))
  assertEquals(state.count, 5)
})
```

**v0.5:** Built-in test harness:
```ts
import { testFeature } from 'aio'
import { counter } from './features/counter/index.ts'

testFeature(counter, 'increment from idle', (t) => {
  t.init()
  t.send.increment(5)
  t.expect.state(s => s.count === 5)
  t.expect.effects(['counter:log'])
  t.expect.status('idle')
})

testFeature(counter, 'machine blocks invalid save', (t) => {
  t.init()
  t.send.save()                // → saving
  t.send.save()                // blocked by machine
  t.expect.status('saving')    // still saving, not double-saved
  t.expect.effectCount(0)      // second save produced no effects
})

testFeature(counter, 'invariant: count is always a number', (t) => {
  t.init()
  t.randomActions(1000)
  t.expect.invariant(s => typeof s.count === 'number')
})
```

### Migration steps (converting to features)

Convert one feature at a time.

**1. Create feature directory** (see [structure.md](structure.md) for the full file organization guide):
```
mkdir -p src/features/counter
```

**2. Create feature definition** (`src/features/counter/index.ts`):
```typescript
import { feature } from 'aio'

export const counter = feature('counter', {
  // Move state shape here (just the slice this feature owns)
  state: { count: 0 },

  // Move action creators here — change PascalCase keys to camelCase
  actions: {
    increment: (by = 1) => ({ by }),
    reset:     () => ({}),
  },

  // Move effect creators here — same key change
  effects: {
    persist: (value: number) => ({ value }),
  },

  // NEW: declare valid state transitions
  machine: {
    initial: 'idle',
    states: {
      idle: { increment: 'idle', reset: 'idle' },
    },
  },

  // Move reducer here — remove draft() wrapper, mutate state directly
  reduce(state, action, { A, E }) {
    switch (action.type) {
      case A.Increment:
        state.count += action.payload.by
        return [E.persist(state.count)]
      case A.Reset:
        state.count = 0
        break
    }
  },

  // Move executor here — A/E come from context
  execute(app, effect, { E, A }) {
    switch (effect.type) {
      case E.Persist:
        console.log('persisting:', effect.payload.value)
        break
    }
  },
})
```

**3. Update entry point** (`src/app.ts`):
```typescript
import { aio } from 'aio'
import { counter } from './features/counter/index.ts'

await aio.run({ features: [counter] })
```

**4. Update UI** (`src/App.tsx`):
```tsx
import { useFeature } from 'aio'
import { counter } from './features/counter/index.ts'

export default function App() {
  const { state, send, status } = useFeature(counter)
  if (!state) return <div>Connecting...</div>
  return <button onClick={() => send.increment(5)}>+5</button>
}
```

**5. Platform APIs in execute:**

If your executor uses Deno globals (`Deno.readTextFile`, `Deno.Command`, etc.), they work as-is — execute only runs server-side. If you need to **import** server-only modules, split into `def.ts` (browser-safe) + `index.ts` (adds execute with server imports). App.tsx imports `def.ts`, app.ts imports `index.ts`. This affects Electron, browser, and Android builds. CLI and service targets are unaffected. See [migration.md — Platform APIs](migration.md#common-patterns) for the full pattern.

**6. Delete old files** (once all features are migrated):
```
rm src/state.ts src/actions.ts src/effects.ts src/reduce.ts src/execute.ts
```

**7. Clear persistence** (state shape changed):
```sh
# Delete old Deno.Kv data (state keys are now feature-namespaced)
rm -f *.sqlite3  # or wherever your KV lives
```

**8. Run tests:**
```sh
deno task dev    # verify app works
deno task test   # verify framework tests pass
```

### Key differences summary

| Aspect | v0.4 | v0.5 features |
|---|---|---|
| **Definition** | 7 files: state/actions/effects/reduce/execute/App.tsx/app.ts | 1 file: `feature('name', { ... })` |
| **Action keys** | PascalCase: `{ Increment: ... }` | camelCase: `{ increment: ... }` |
| **Action types** | `'Counter:Increment'` | Same: `'Counter:Increment'` |
| **Reducer wrapper** | `draft(state, d => { ... })` | Auto-Immer: `state` IS the draft |
| **Reducer scope** | Full app state | Feature's state slice only |
| **Reducer context** | Import A/E manually | `{ A, E }` injected as 3rd param |
| **Executor scope** | Can dispatch any action | Scoped: own actions only |
| **State machine** | None | Required (or `false` to disable guards) |
| **State shape** | Flat: `{ count: 0 }` | Namespaced: `{ counter: { count: 0, _status: 'idle' } }` |
| **UI hook** | `useAio<AppState>()` → `{ state, send }` | `useFeature(counter)` → `{ state, send, status }` |
| **UI dispatch** | `send(A.increment(5))` | `send.increment(5)` |
| **Boot** | `aio.run(state, { reduce, execute })` | `aio.run({ features: [...] })` |
| **Testing** | Manual `Deno.test` | `testFeature(counter, name, fn)` |
| **Feature isolation** | By convention | Enforced: prefix routing, scoped dispatch |
| **Cross-feature** | Manual imports | Selectors, foreign action listening, bridge |

---

*Future versions will be documented here as they are released.*
