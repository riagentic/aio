# AIO Upgrade Guide

How to upgrade between aio versions. Each section lists what changed, what breaks, and exact steps to update your code.

---

## v0.1 → v0.2

### New features

- **CSS hot reload** — CSS-only changes inject without page reload (React state preserved)
- **`--expose` flag** — bind `0.0.0.0` with auto-generated UUID token for LAN access
- **`--version` / `--help` flags**
- **`--url` thin client** — launch Electron connecting to a remote aio server. See [manual.md — Thin client](manual.md#thin-client---url)
- **`--width` / `--height` flags** — override Electron window dimensions from CLI
- **Window config** — `ui: { width, height }` sets default Electron window size. Embedded as `<meta>` tags for thin client discovery
- **Window state persistence** — Electron remembers window bounds across runs via `window-state.json`
- **Configurable `persistDebounce`** — control KV write frequency (default: 100ms)
- **Per-user `getUIState(state, user?)`** — server-controlled per-user state filtering
- **Multi-user auth** — `users: Record<string, AioUser>` token map with per-user identity. See [manual.md — Multi-user auth](manual.md#multi-user-auth)
- **camelCase factory creators** — `A.increment()` alongside `A.Increment` label
- **Startup linter** — validates state, config, App.tsx, esbuild, electron on boot
- **Error overlay** — transpile errors shown on page instead of blank screen
- **Guardrail hardening** — bad reducer output, invalid effects, and reducer throws are caught and logged instead of crashing
- **Lifecycle hooks** — 6 optional `on*` callbacks with `user?` parameter: `onAction`, `onEffect`, `onConnect`, `onDisconnect`, `onStart`, `onStop`. Observe-only, error-guarded. See [manual.md — Lifecycle hooks](manual.md#lifecycle-hooks)
- **Time-travel** — dev mode records action history with undo/redo/goto. Press Ctrl+. for browser panel, or use `am tt undo`. `useTimeTravel()` hook for programmatic control. 200-entry cap, zero cost in prod. See [manual.md — Time-Travel](manual.md#time-travel)
- **am — app manager** — CLI for process lifecycle, state inspection, dispatch, time-travel, log tailing. `deno task am help`. Output: pretty for terminals, JSON for scripts/agents. See [manual.md — am](manual.md#am--app-manager)
- **Connection status indicator** — shows "Reconnecting..." pill on disconnect and "Connected" briefly on reconnect. Pure DOM, no user code. Disable with `ui: { showStatus: false }`
- **State snapshots** — `app.snapshot()` / `app.loadSnapshot(json)` + HTTP `GET/POST /__snapshot`. See [manual.md — State snapshots](manual.md#state-snapshots)
- **Scheduled effects** — `schedule.after/every/at/cron/cancel` — declarative timers, intervals, cron jobs as effects. See [manual.md — Scheduled effects](manual.md#scheduled-effects)
- **aio-client** — standalone Electron connect-page app (`compile:electron:remote`). Connects to any aio server without Deno
- **One-liner init** — `sh -c "$(curl -fsSL .../init.sh)" -- my-app` scaffolds a new project with interactive template menu
- **SQLite persistence** — 3-tier data layer for structured data. `db: { orders: table({...}) }` in config. Level 1: auto-sync arrays to/from SQLite. Level 2: `app.db.orders.where(...)` ORM. Level 3: `app.db.query(...)` raw SQL. Uses `node:sqlite` (built into Deno 2.2+, zero deps). See [manual.md — SQLite persistence](manual.md#sqlite-persistence)

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

`subscribe(keys)` was a client-side bandwidth filter. It's been replaced by `getUIState(state, user?)` — a server-controlled per-user filter that's more secure and doesn't leak the full state shape.

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
  // app.ts — ADD getUIState with per-user filtering
  await aio.run(initialState, {
    reduce, execute,
-   getUIState: (s) => s,
+   getUIState: (s, _user?) => ({ stats: s.stats }),  // server controls what clients see
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
2. **Remove subscribe:** Delete any `subscribe()` calls from App.tsx. If you need per-user filtering, add `getUIState: (s, user?) => ...` to your `aio.run()` config
3. **Update dep/aio/:** Copy the new `dep/aio/` folder over the old one
4. **Run `deno install`**
5. **Run `deno task dev`** — the startup linter will catch remaining issues

---

## v0.2 → v0.3

### New features

- **Performance budgets** — dispatch loop timing with configurable thresholds. `perfMode: 'strict' | 'soft'` and `perfBudget: { reduce?, effect? }` in config. Violations call `onError({ source: 'performance', ... })` or warn (soft). Per-action perf metrics recorded in time-travel history. See [manual.md — Performance budgets](manual.md#performance-budgets)
- **Redux DevTools** — connect to the Redux DevTools browser extension for state inspection and action history. `connectDevTools()` / `disconnectDevTools()` from `'aio'`. See [manual.md — Redux DevTools](manual.md#redux-devtools-integration)
- **Incremental SQLite sync** — tables with a `pk()` column now use row-level INSERT/UPDATE/DELETE diffs instead of full table replacement. Significantly faster for large datasets. No migration needed — PK detection is automatic
- **Memoized selectors** — `createSelector(...inputFns, resultFn)` and `createSliceSelector`. Caches derived values until inputs change, preventing redundant recalculations. See [manual.md — Selectors](manual.md#selectors)
- **`matchEffect(effect, handlers, fallback?)`** — typed alternative to switch/case in `execute()`. Scales better for large effect catalogs. See [manual.md — matchEffect](manual.md#matcheffect)
- **`composeMiddleware(...fns)`** — compose multiple `beforeReduce` functions into a single pipeline. Return `null` from any function to drop the action. See [manual.md — composeMiddleware](manual.md#composemiddleware)
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

## v0.5 → v0.6

### New features — generator-based flows

v0.6 adds `flow()` — sequential async workflows using generators. No breaking changes. All v0.5 code works unchanged.

- **`flow(trigger, generatorFn)`** — define a sequential workflow triggered by an action. Write top-to-bottom async code; each yield point dispatches an action visible in time-travel
- **`FlowCtx` API** — `ctx.call()` (async work), `ctx.step()` (state mutation), `ctx.done()` / `ctx.fail()` (terminal), `ctx.put()` (dispatch), `ctx.all()` (parallel), `ctx.race()` (first wins), `ctx.sleep()` (pause)
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

v0.5 introduces `feature()` — one function defines state, actions, effects, state machine, reducer, executor, and selectors. The old v0.4 API (`aio.run(initialState, config)`) still works unchanged for existing apps.

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
- **Lifecycle init/destroy** — `init(app)` and `destroy(app)` hooks per feature (`app` is a `ScopedApp` with `.dispatch()` and `.getState()`). Auto-generated `Counter:Init` / `Counter:Destroy` actions. Dependency-ordered init, reverse-ordered destroy
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

The legacy API still works, so updating `dep/aio/` alone is non-breaking. But **if you migrate to `feature()`**, these things change:

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

#### 5. UI hooks — `useFeature()` instead of `useAio()`

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
- `useAio()` still works for cross-feature dashboards or layout components

#### 6. State machines — new required field

Every feature needs a `machine:` declaration:

```ts
machine: {
  initial: 'idle',
  states: {
    idle:   { on: { increment: 'idle', save: 'saving' } },
    saving: { on: { saved: 'idle', saveFailed: 'error' } },
    error:  { on: { retry: 'saving', dismiss: 'idle' } },
  },
}
```

- Every action must appear in at least one state's `on:` transitions
- Action keys in `on:` must match declared action names exactly (typo → startup error)
- Every state must be reachable from `initial`
- `_status` is managed by the framework — never set it manually in reduce
- For trivial features with no lifecycle: `machine: 'simple'` (all actions valid in all states, no `_status`)

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
    getCount: (state: unknown) => (state as Record<string, any>).counter.count,
  },
})
// Usage from other features:
const count = counter.selectors.getCount(app.getState())
```

Selectors read from the full app state (not the feature slice) because they're the public read API for cross-feature data access.

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
  t.expect.effects(['Log'])
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

### Upgrade steps (keeping v0.4 code)

1. Replace `dep/aio/` with the v0.5 folder
2. Update `deno.json` version to `"0.5.0"`
3. Run `deno install`
4. Run `deno task dev` — existing code works unchanged

### Migration steps (converting to features)

Convert one feature at a time. Both patterns can coexist during migration.

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
      idle: { on: { increment: 'idle', reset: 'idle' } },
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
| **State machine** | None | Required (or `'simple'` escape hatch) |
| **State shape** | Flat: `{ count: 0 }` | Namespaced: `{ counter: { count: 0, _status: 'idle' } }` |
| **UI hook** | `useAio<AppState>()` → `{ state, send }` | `useFeature(counter)` → `{ state, send, status }` |
| **UI dispatch** | `send(A.increment(5))` | `send.increment(5)` |
| **Boot** | `aio.run(state, { reduce, execute })` | `aio.run({ features: [...] })` |
| **Testing** | Manual `Deno.test` | `testFeature(counter, name, fn)` |
| **Feature isolation** | By convention | Enforced: prefix routing, scoped dispatch |
| **Cross-feature** | Manual imports | Selectors, foreign action listening, bridge |

---

*Future versions will be documented here as they are released.*
