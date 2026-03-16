# API Reference

All exports are one import: `import { feature, call, aio } from 'aio'`

---

## Core

| API | Description |
|-----|-------------|
| `feature(name, config)` | Define a feature with state, methods/generators, machine, selectors |
| `testFeature(def, config?)` | Create isolated test harness for a feature |

---

## Runtime

| API | Description |
|-----|-------------|
| `aio.run(config)` | Start the app — see Config section for options |
| `aio.middleware.logger()` | Log all actions to console (dev mode) |
| `aio.middleware.validate(defs)` | Validate action shapes before reduce |
| `call(fn)` | Call a function — pass-through, for symmetry with options form |
| `call(opts, fn)` | Call callback with `{ timeout?, retries? }`, returns Promise |
| `markAsync(fn)` | Explicitly mark a method as async — for minified bundles where constructor names are stripped |

---

## Advanced

| API | Description |
|-----|-------------|
| `composeFeatures(entries)` | Combine features manually — for custom composition |
| `composeMiddleware(...fns)` | Compose beforeReduce functions — return null to drop action |
| `draft(state, fn)` | Immer wrapper for `actions/reduce` style — returns `{ state, effects }` |
| `matchEffect(effect, handlers, fallback?)` | Typed effect dispatch — alternative to switch/case in execute |
| `deepFreeze(obj)` | Deep freeze for dev-mode immutability checks |

---

## Generators (GenCtx)

| API | Description |
|-----|-------------|
| `yield* ctx.call(name, fn)` | Async call — dispatches action, executes fn, returns result |
| `yield* ctx.mutate(name, fn)` | State mutation — dispatches action, applies Immer draft update |
| `yield* ctx.step(name, fn)` | Deprecated alias for `ctx.mutate()` |
| `yield* ctx.done(fn?)` | Terminal success — dispatches done action, optional final mutation |
| `yield* ctx.fail(reason)` | Terminal failure — dispatches fail action with reason |
| `yield* ctx.dispatch(action)` | Dispatch arbitrary action to any feature |
| `yield* ctx.send(creator, payload?)` | Shorthand dispatch — pass bound method or type string |
| `yield* ctx.all(...gens)` | Run multiple calls in parallel, wait for all |
| `yield* ctx.all({...gens})` | Named form — destructure by name instead of position |
| `yield* ctx.race({...gens})` | Race multiple calls — first to complete wins |
| `yield* ctx.sleep(name, ms)` | Sleep for N ms — dispatches named action for visibility |
| `yield* ctx.waitFor(creator, timeout?)` | Wait for action to arrive, returns `{ type, payload }` |
| `ctx.getState()` | Read current feature state (fresh after each step) |

---

## Types

| Type | Description |
|------|-------------|
| `FeatureDef` | Return type of `feature()` — contains name, A, E, selectors, _config |
| `FeatureEntry` | Feature or `{ feature, dependsOn? }` for dependency ordering |
| `MachineConfig` | `{ initial, states: { state: { action: target } } }` |
| `Catalog<Prefix, Creators>` | Action/effect catalog — labels + typed creators with `.type` |
| `ActionUnion<Prefix, Actions>` | Discriminated union of all actions for switch/case narrowing |
| `ScopedApp<S>` | App context for init/destroy/execute — `{ dispatch, getState, getFullState? }` |
| `DirectCalling<M>` | Flattened method signatures for direct calling after `aio.run()` |
| `GenCtx<S>` | Generator context — S is inferred from feature's state |
| `Gen<T>` | Generator return type for flows — `Generator<FlowStep, T, unknown>` |
| `TypedCreator<P>` | Action creator with `.type` — pass to `waitFor` for typed payload |
| `CallOptions` | `{ timeout?: number; retries?: number }` for `call()` |
| `ScheduleEffect` | `{ _schedule: true, key, type, ... }` returned from sync methods |
| `TestContext` | Test harness — `{ dispatch, getState, expect, settle }` |
| `LogConfig` | `{ level?, dir?, console?, heartbeat?, suppressTypes?, rotate? }` |
| `LogLevel` | `'trace' \| 'debug' \| 'info' \| 'warn' \| 'error'` |

---

## Feature Config

| Key | Description |
|-----|-------------|
| `state` | Initial state object — `{ count: 0, items: [] }` |
| `methods` | Sync/async methods — `(s, ...args) => void \| Promise` |
| `generators` | Sequential workflows — `*name(ctx, ...args) { yield* ... }` |
| `cancelOn` | Cancellation triggers per generator — `{ genKey: [actions] }` |
| `selectors` | Derived state — `{ getName: s => s.name }` (auto-scoped) |
| `machine` | State machine guards — `{ initial, states }` or `false` |
| `listensTo` | Foreign action listeners — `[otherFeature.A.action]` |
| `actions` | Action creators (explicit style) — `{ increment: (n) => ({ n }) }` |
| `effects` | Effect creators (explicit style) — `{ persist: (data) => ({ data }) }` |
| `reduce` | Reducer handlers (explicit style) — `{ increment(state, { n }) { ... } }` |
| `execute` | Effect handlers (explicit style) — `{ persist(app, { data }) { ... } }` |
| `dispatchTo` | Cross-dispatch allowlist — `[wallet, notifications]` |
| `persist` | KV persistence config — `{ exclude: ['tempCache'] }` |
| `onInit` | Init hook — `(app) => { ... }` runs after aio.run() |
| `onDestroy` | Destroy hook — `(app) => { ... }` runs before shutdown |

---

## React Hooks

| Hook | Description |
|------|-------------|
| `useAio<S>()` | Connect to server via WebSocket — `{ state, send }` |
| `useFeature(ref)` | Connect to one feature — `{ state, send, status }` |
| `useLocal(initial)` | Client-only state (not synced) — `{ local, set }` |
| `useTimeTravel()` | Dev-mode time-travel controls — `{ entries, undo, redo, ... }` |
| `connectDevTools()` | Connect to Redux DevTools browser extension |
| `disconnectDevTools()` | Disconnect from Redux DevTools |
| `page(current, routes)` | State-based routing — renders component for current page key |

---

## SQLite

| API | Description |
|-----|-------------|
| `createDB(path, opts?)` | Create async Worker-based DB — `opts: { readonly?, pragmas?, readers? }` |
| `DEFAULT_PRAGMAS` | Default pragma set applied by `createDB` |
| `table(columns)` | Define a SQLite table — `table({ id: pk(), name: text() })` |
| `pk()` | Primary key column — `id: pk()` |
| `text()` | Text column — `name: text()` |
| `integer()` | Integer column — `age: integer()` |
| `real()` | Float column — `price: real()` |
| `ref(table)` | Foreign key reference — `userId: ref('users')` |

### `DB` interface

| Method | Returns | Description |
|--------|---------|-------------|
| `query<T>(sql, params?)` | `Promise<QueryResult<T>>` | SELECT — rows in `.rows` |
| `execute(sql, params?)` | `Promise<QueryResult>` | INSERT/UPDATE/DELETE — changes in `.changes` |
| `transaction(stmts[])` | `Promise<QueryResult[]>` | Atomic multi-statement batch |
| `close()` | `Promise<void>` | Close all worker connections |

`QueryResult<T>` = `{ rows: T[], changes: number, lastInsertRowId: bigint }`

`app.db` is `DB | undefined` — `undefined` in standalone/Android mode.

---

## Selectors

| API | Description |
|-----|-------------|
| `createSelector(...inputs, resultFn)` | Memoized selector — recomputes when inputs change |
| `createSliceSelector(feature)` | Scoped selector — auto-wraps with feature state slice |

---

## Persistence

| Config | Description |
|--------|-------------|
| `persist: true` | Auto-persist state to Deno.Kv |
| `persist: { exclude: [...] }` | Per-feature persistence exclusion |
| `stateForDB: (state) => partial` | Transform state before persist (app-level) |
| `stateForUI: (state, user?) => partial` | Transform state before sending to UI (per-client filtering) |

---

## UI Config (`aio.run({ ui })`)

| Config | Description |
|--------|-------------|
| `ui.syncRate` | Throttle UI updates: max 1 push per N ms — default `10` (100fps). `0` = microtask-only coalescing (unbounded). Leading edge fires immediately; trailing flush ensures last state always arrives within N ms. |
| `ui.electron` | Open Electron window (default: `true`) |
| `ui.keepAlive` | Keep server running after Electron closes (default: `false`) |
| `ui.title` | Window title (default: `'AIO App'`) |
| `ui.width` / `ui.height` | Window dimensions (default: `800` / `600`) |
| `ui.showStatus` | Show reconnection indicator (default: `true`) |
| `ui.transport` | `'uds' \| 'ws' \| 'auto'` — IPC transport (default: `'auto'`) |

---

## CLI App (Remote Client)

| API | Description |
|-----|-------------|
| `connectCli(url, opts?)` | Connect to remote aio server via WebSocket — returns `CliApp` |
| `connectCliUDS(socketPath, opts?)` | Connect via Unix Domain Socket (Electron) — returns `CliApp` |

---

## Middleware

| API | Description |
|-----|-------------|
| `beforeReduce: (action, state) => action \| null` | Filter/transform actions before reduce |
| `afterReduce: (state, action) => void` | Side effects after state update |
| `onAction: (action, state) => void` | Observe all actions (logging, analytics) |

---

## Testing

| API | Description |
|-----|-------------|
| `t.dispatch(action)` | Dispatch action in test |
| `t.getState()` | Get current test state |
| `t.expect.state(feature)` | Get feature's state slice |
| `t.expect.status(expected)` | Assert machine status |
| `t.expect.matches(expected)` | Assert state matches partial object |
| `t.settle()` | Wait for all effects + async methods to complete |
| `t.spy(fn)` | Track calls to a function |
| `t.spy.calls` | Array of `[...args]` for each call |
| `t.spy.reset()` | Clear spy call history |

---

## Logging

### Configuration — `aio.run({ logging })`

| Config | Description |
|--------|-------------|
| `logging: true` | Enable structured logging with defaults |
| `logging.level` | Minimum level written to `debug.log` (default: `'debug'`) |
| `logging.dir` | Log directory (default: `'./logs'`) |
| `logging.console` | Pretty console output in dev (default: auto-detected) |
| `logging.heartbeat` | Heartbeat interval in seconds — 0 to disable (default: 3600) |
| `logging.suppressTypes` | Action types to exclude from all logs |
| `logging.rotate` | `{ keep?: number }` — archived logs to keep per file (default: 7, 0 = unlimited) |

### Public singleton — `log`

```ts
import { log } from 'aio'

log.info('payments', 'charge processed', { amount: 99 })
log.warn('auth', 'token expiring', { userId: 'u_123' })
log.error('db', 'connection lost', { error: 'ECONNREFUSED' })
log.debug('cache', 'miss', { key: 'user:42' })
log.trace('store', 'action dispatched')
```

All methods: `log.trace(cat, msg, data?)` / `log.debug` / `log.info` / `log.warn` / `log.error`.
No-ops silently when `logging` is not configured in `aio.run()`.

### Log outputs

| File | Content |
|------|---------|
| `logs/app.log` | Narrative: feature lifecycle, flow completions, state transitions, errors |
| `logs/debug.log` | All dispatched actions + `trace`/`debug` from `log.*` calls |
| `logs/errors.log` | Warn and error entries only — for ops/alerting |

### JSON entry format

```json
{
  "ts":   "2026-03-15 14:23:01.456",
  "lvl":  "info",
  "cat":  "payments",
  "msg":  "charge processed",
  "src":  "payments-effect.ts:42",
  "data": { "amount": 99 },
  "dur":  145
}
```

| Field | Description |
|-------|-------------|
| `ts` | Timestamp — `YYYY-MM-DD HH:mm:ss.SSS` |
| `lvl` | Severity level |
| `cat` | Category — feature name, flow name, or any string |
| `msg` | Human-readable message |
| `src` | Source file and line — auto-detected from call stack (e.g. `payments-effect.ts:42`) |
| `data` | Optional payload — omitted if empty |
| `dur` | Optional duration in ms — present on flow completions |

---

## Utility

| API | Description |
|-----|-------------|
| `VERSION` | Framework version string |
| `parseCli(args)` | Parse CLI flags — returns `{ command, flags, args }` |
| `lint(features)` | Validate feature definitions at startup |
| `instances()` | List running aio instances (from lock file) |
| `resolveAppId(appDir)` | Resolve app identity from directory |
| `slugify(name)` | Convert name to URL-safe slug |