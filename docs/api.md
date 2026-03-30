# API Reference

Main import: `import { feature, call, aio } from 'aio'`

Additional export paths for framework adapters and advanced use:

| Path                 | Import                                                                 | Use                                                         |
| -------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| `aio/state-core`     | `import { getFeatureSignal, setTransport, ... } from 'aio/state-core'` | Framework-agnostic state signals, transport, tracking proxy |
| `aio/adapters/react` | `import { useFeature, useAio, useLocal } from 'aio/adapters/react'`    | React hooks (re-exported from main `aio` for convenience)   |
| `aio/adapters/air`   | `import { useFeature, useAio } from 'aio/adapters/air'`                | AIR renderer hooks — signal-based, no React dependency      |
| `aio/jsx-runtime`    | JSX transform target                                                   | AIR JSX runtime — set `jsxImportSource` in tsconfig         |

> **Most apps only need the main `'aio'` import.** The sub-paths exist for
> custom framework adapters, tree-shaking, or using AIR without React.

---

## Core

| API                         | Description                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| `feature(name, config)`     | Define a feature with state, methods/generators, machine, selectors |
| `testFeature(def, config?)` | Create isolated test harness for a feature                          |

---

## Runtime

| API                             | Description                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `aio.run(config)`               | Start the app — see Config section for options                                                |
| `aio.middleware.logger()`       | Log all actions to console (dev mode)                                                         |
| `aio.middleware.validate(defs)` | Validate action shapes before reduce                                                          |
| `call(opts, fn)`                | Call with `{ timeout?, retries? }` — wraps inter-feature calls                                |
| `markAsync(fn)`                 | Explicitly mark a method as async — for minified bundles where constructor names are stripped |

### Dispatch Introspection

Available on the dispatch function returned by `aio.run()`:

| API                           | Description                                         |
| ----------------------------- | --------------------------------------------------- |
| `dispatch.getQueueDepth()`    | Current number of pending actions in dispatch queue |
| `dispatch.getEffectBacklog()` | Number of async effects currently in-flight         |

These are primarily used internally by the vitals system (LoopProbe polls them
on each heartbeat). Direct use is for custom monitoring or testing.

---

## Advanced

| API                                        | Description                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `composeFeatures(entries)`                 | Combine features manually — for custom composition                      |
| `composeMiddleware(...fns)`                | Compose beforeReduce functions — return null to drop action             |
| `draft(state, fn)`                         | Immer wrapper for `actions/reduce` style — returns `{ state, effects }` |
| `matchEffect(effect, handlers, fallback?)` | Typed effect dispatch — alternative to switch/case in execute           |
| `deepFreeze(obj)`                          | Deep freeze for dev-mode immutability checks                            |

### `composeMiddleware(...fns)`

Chains multiple `beforeReduce` middleware functions into one. Functions run
left-to-right — each receives the (potentially modified) action from the
previous one. Return `null` from any function to drop the action entirely
(short-circuits, remaining functions are skipped).

```ts
import { aio, composeMiddleware } from "aio";

const rateLimit = (action, state) => state.requestCount > 100 ? null : action;

const enrich = (action, state) => ({ ...action, _ts: Date.now() });

const authorize = (action, state, user) =>
  user?.role === "admin" || action.type !== "admin:delete" ? action : null;

aio.run({
  features: [myFeature],
  beforeReduce: composeMiddleware(rateLimit, enrich, authorize),
});
```

### `matchEffect(effect, handlers, fallback?)`

Typed alternative to switch/case for dispatching effects in `execute()`. Matches
on `effect.type` and passes `effect.payload` to the handler. Unmatched effects
go to the optional `fallback`, or are silently ignored.

```ts
import { matchEffect } from "aio";

// In actions-style execute:
execute: ((app, effect) => {
  matchEffect(effect, {
    SendEmail: (p) => sendEmail(p.to, p.subject, p.body),
    Persist: (p) => saveToFile(p.path, p.data),
    Notify: (p) => pushNotification(p.userId, p.message),
  }, (unhandled) => {
    console.warn(`unhandled effect: ${unhandled.type}`);
  });
});
```

Payload typing: handlers receive the raw `.payload` field. For full type safety
with discriminated unions, define typed effect creators and use
`ActionUnion`-style narrowing.

---

## Generators (GenCtx)

| API                                     | Description                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `yield* ctx.call(name, fn, opts?)`      | Async call — dispatches action, executes fn, returns result. opts: `{ timeout?, retries? }` |
| `yield* ctx.mutate(name, fn)`           | State mutation — dispatches action, applies Immer draft update                              |
| `yield* ctx.done(fn?)`                  | Terminal success — dispatches done action, optional final mutation                          |
| `yield* ctx.fail(reason)`               | Terminal failure — dispatches fail action with reason                                       |
| `yield* ctx.dispatch(action)`           | Dispatch arbitrary action to any feature                                                    |
| `yield* ctx.send(creator, payload?)`    | Shorthand dispatch — pass bound method or type string                                       |
| `yield* ctx.all(...gens)`               | Run multiple calls in parallel, wait for all                                                |
| `yield* ctx.all({...gens})`             | Named form — destructure by name instead of position                                        |
| `yield* ctx.race({...gens})`            | Race multiple calls — first to complete wins                                                |
| `yield* ctx.sleep(name, ms)`            | Sleep for N ms — dispatches named action for visibility                                     |
| `yield* ctx.waitFor(creator, timeout?)` | Wait for action to arrive, returns `{ type, payload }`                                      |
| `yield* ctx.when(predicate, opts?)`     | Wait until state condition is true — checks immediately, then after every dispatch          |
| `ctx.getState()`                        | Read current feature state (fresh after each step)                                          |
| `ctx.getFullState()`                    | Read full app state tree (all features). Fresh after each step.                             |

---

## Types

| Type                           | Description                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `FeatureDef`                   | Return type of `feature()` — public: callable methods/generators/actions at top level; internals under `__aio` (including `id`, `selectors`) |
| `FeatureEntry`                 | Feature or `{ feature, dependsOn? }` for dependency ordering                                                                                 |
| `MachineConfig`                | `{ initial, states: { state: { action: target } } }`                                                                                         |
| `Catalog<Prefix, Creators>`    | Action/effect catalog — typed creators with `.type` (internal)                                                                               |
| `ActionUnion<Prefix, Actions>` | Discriminated union of all actions for switch/case narrowing                                                                                 |
| `ScopedApp<S>`                 | App context for init/destroy/execute — `{ dispatch, getState, getFullState? }`                                                               |
| `DirectCalling<M>`             | Flattened method signatures for direct calling after `aio.run()`                                                                             |
| `GenCtx<S>`                    | Generator context — S is inferred from feature's state                                                                                       |
| `Gen<T>`                       | Generator return type for flows — `Generator<FlowStep, T, unknown>`                                                                          |
| `TypedCreator<P>`              | Action creator with `.type` — pass to `waitFor` for typed payload                                                                            |
| `CallOptions`                  | `{ timeout?: number; retries?: number }` for `call()`                                                                                        |
| `ScheduleEffect`               | `{ _schedule: true, key, type, ... }` returned from sync methods                                                                             |
| `TestContext`                  | Test harness — `{ dispatch, getState, expect, settle }`                                                                                      |
| `LogConfig`                    | `{ level?, dir?, console?, heartbeat?, suppressTypes?, backupLogs?, backupKeep? }`                                                           |
| `LogLevel`                     | `'trace' \| 'debug' \| 'info' \| 'warn' \| 'error'`                                                                                          |
| `AioError`                     | Error class — `{ code, source, context, original?, correlationId, timestamp, stateSnapshot? }`                                               |
| `AioUser`                      | `{ id: string; role: string }` — resolved user identity                                                                                      |
| `ResolveUserFn<S>`             | `(token: string, state: S) => AioUser \| null \| Promise<AioUser \| null>` — dynamic auth hook                                               |
| `AioErrorCode`                 | 16 error codes — `'REDUCE_ERROR' \| 'EFFECT_ERROR' \| ...` (see [debugging.md](debugging.md#error-codes-reference))                          |
| `AioErrorContext`              | `{ featureName?, actionType?, effectType?, flowName?, flowStep?, hookName?, duration?, budget?, machineState? }`                             |
| `MemoryConfig`                 | `{ enabled?, interval?, warnThreshold?, criticalThreshold?, onMemoryPressure? }`                                                             |
| `MemoryReport`                 | `{ level, heapUsed, heapTotal, heapPct, featureStates, trend }`                                                                              |
| `VitalsConfig`                 | `{ heartbeatInterval?, thresholds?, hints?, backpressure?, onVitalAlert? }` — see [vitals.md](vitals.md)                                     |
| `VitalAlert`                   | `{ id, layer, status, duration, measured, threshold, hint, ts, correlationId? }`                                                             |
| `VitalStatus`                  | `'healthy' \| 'degraded' \| 'warning' \| 'frozen' \| 'recovered'`                                                                            |
| `VitalHint`                    | `{ cause, evidence[], suggestion, severity }` — diagnostic root-cause hint                                                                   |
| `VitalThresholds`              | `{ render, transport, loop, queue }` — per-layer `{ degraded, warning, frozen }`                                                             |
| `LoopVitals`                   | `{ queueDepth, drainRate, lastReduceTime, lastReduceAction, lastReduceFeature, p95ReduceTime, effectBacklog, circuitBreakers }`              |

---

## Feature Config

| Key          | Description                                                               |
| ------------ | ------------------------------------------------------------------------- |
| `state`      | Initial state object — `{ count: 0, items: [] }`                          |
| `methods`    | Sync/async methods — `(s, ...args) => void \| Promise`                    |
| `generators` | Sequential workflows — `*name(ctx, ...args) { yield* ... }`               |
| `cancelOn`   | Cancellation triggers per generator — `{ genKey: [actions] }`             |
| `selectors`  | Derived state — `{ getName: s => s.name }` (auto-scoped)                  |
| `machine`    | State machine guards — `{ initial, states }` or `false`                   |
| `listensTo`  | Foreign action listeners — `[otherFeature.action]`                        |
| `actions`    | Action creators (explicit style) — `{ increment: (n) => ({ n }) }`        |
| `effects`    | Effect creators (explicit style) — `{ persist: (data) => ({ data }) }`    |
| `reduce`     | Reducer handlers (explicit style) — `{ increment(state, { n }) { ... } }` |
| `execute`    | Effect handlers (explicit style) — `{ persist(app, { data }) { ... } }`   |
| `dispatchTo` | Cross-dispatch allowlist — `[wallet, notifications]`                      |
| `persist`    | KV persistence config — `{ exclude: ['tempCache'] }`                      |
| `onInit`     | Init hook — `(app) => { ... }` runs after aio.run()                       |
| `onDestroy`  | Destroy hook — `(app) => { ... }` runs before shutdown                    |

---

## React Hooks

| Hook                        | Description                                                                  |
| --------------------------- | ---------------------------------------------------------------------------- |
| `useAio<S>()`               | Proxy-tracked state access — subscribes to what you read                     |
| `useFeature(ref)`           | Scoped state + typed send — re-renders only when feature changes             |
| `useProjection(fn, deps)`   | Like `useMemo` but preserves element-level refs via `_preserveArrayRefs`     |
| `memo(Component, compare?)` | Drop-in `React.memo` replacement — `_shallowEqual` per prop instead of `===` |
| `useLocal(initial)`         | Client-only state (not synced) — `{ local, set }`                            |
| `useTimeTravel()`           | Dev-mode time-travel controls — `{ entries, undo, redo, ... }`               |
| `connectDevTools()`         | Connect to Redux DevTools browser extension                                  |
| `disconnectDevTools()`      | Disconnect from Redux DevTools                                               |
| `page(current, routes)`     | State-based routing — renders component for current page key                 |

---

## Framework-agnostic Client

For non-React frameworks (Svelte, Vue, Solid, etc). Same singleton connection as
`useAio`/`useFeature`.

| API                                | Description                                                    |
| ---------------------------------- | -------------------------------------------------------------- |
| `client.subscribe(fn)`             | Subscribe to state changes — `fn(state)`, returns unsubscribe  |
| `client.getState()`                | Current state snapshot (null before first message)             |
| `client.getFeatureState(name)`     | Single feature's state slice by name                           |
| `client.send(action)`              | Send action to server — same queuing/offline behavior as hooks |
| `client.route.subscribe(fn)`       | Subscribe to URL changes, returns unsubscribe                  |
| `client.route.getPath()`           | Current pathname                                               |
| `client.route.getSearch()`         | Current `URLSearchParams`                                      |
| `client.route.navigate(to, opts?)` | Navigate — string path or history delta                        |

See [ui.md](ui.md#bring-your-own-framework) for examples.

---

## URL Routing

History API router — no page reloads, deep links work via SPA fallback.

| API                            | Description                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `useRoute(pattern?)`           | Subscribe to URL — `{ path, params, search, matched }`                       |
| `useNavigate()`                | Returns `navigate` function (hook form for components)                       |
| `navigate(to, opts?)`          | Programmatic navigation — string path or history delta                       |
| `<Route>`                      | Renders `element` when `path` matches; supports nested children + `<Outlet>` |
| `<Outlet>`                     | Renders the matched child route inside a layout component                    |
| `<Link to>`                    | SPA anchor — active class support, modifier key passthrough                  |
| `<NavLink to>`                 | Link with automatic `active` class (prefix match)                            |
| `<Redirect to>`                | Navigate on mount — for auth guards                                          |
| `matchPath(pat, path, exact?)` | Pattern matching utility — returns params or `null`                          |

See [ui.md](ui.md#url-based-routing) for full reference with examples.

---

## SQLite

| API                     | Description                                                              |
| ----------------------- | ------------------------------------------------------------------------ |
| `createDB(path, opts?)` | Create async Worker-based DB — `opts: { readonly?, pragmas?, readers? }` |
| `DEFAULT_PRAGMAS`       | Default pragma set applied by `createDB`                                 |
| `table(columns)`        | Define a SQLite table — `table({ id: pk(), name: text() })`              |
| `pk()`                  | Primary key column — `id: pk()`                                          |
| `text()`                | Text column — `name: text()`                                             |
| `integer()`             | Integer column — `age: integer()`                                        |
| `real()`                | Float column — `price: real()`                                           |
| `ref(table)`            | Foreign key reference — `userId: ref('users')`                           |

### `DB` interface

| Method                                    | Returns                   | Description                                                       |
| ----------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| `query<T>(sql, params?)`                  | `Promise<QueryResult<T>>` | SELECT — rows in `.rows`                                          |
| `execute(sql, params?)`                   | `Promise<QueryResult>`    | INSERT/UPDATE/DELETE — changes in `.changes`                      |
| `transaction(fn: (tx: Tx) => Promise<T>)` | `Promise<T>`              | Callback form — BEGIN/COMMIT, rollback on throw, read-your-writes |
| `transaction(stmts[])`                    | `Promise<QueryResult[]>`  | Batch form — atomic multi-statement, no branching                 |
| `close()`                                 | `Promise<void>`           | Close all worker connections                                      |

`QueryResult<T>` = `{ rows: T[], changes: number, lastInsertRowId: bigint }`

`Tx` =
`{ query<T>(sql, params?): Promise<QueryResult<T>>, execute(sql, params?): Promise<QueryResult> }`
— transaction-scoped handle; always routes to the writer.

`app.db` is `DB | undefined` — `undefined` in standalone/Android mode.

---

## Selectors

| API                                   | Description                                           |
| ------------------------------------- | ----------------------------------------------------- |
| `createSelector(...inputs, resultFn)` | Memoized selector — recomputes when inputs change     |
| `createSliceSelector(feature)`        | Scoped selector — auto-wraps with feature state slice |

---

## Persistence

| Config                                  | Description                                                 |
| --------------------------------------- | ----------------------------------------------------------- |
| `persist: true`                         | Auto-persist state to Deno.Kv                               |
| `persist: { exclude: [...] }`           | Per-feature persistence exclusion                           |
| `stateForDB: (state) => partial`        | Transform state before persist (app-level)                  |
| `stateForUI: (state, user?) => partial` | Transform state before sending to UI (per-client filtering) |

---

## Diagnostics Config (`aio.run({ diagnostics })`)

Zero-config observability — see [diagnostics.md](diagnostics.md) for full guide.

| Config                                       | Description                                                           |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `diagnostics: false`                         | Kill switch — disable all diagnostics                                 |
| `diagnostics: { dev: {...}, prod: {...} }`   | Override built-in defaults per mode                                   |
| `onCheckpointRestore: (cp) => state \| null` | Receive recovered state after crash — return state to restore or null |

**DiagnosticsOptions fields** (used in `dev` / `prod`):

| Field           | Type                               | Description                                          |
| --------------- | ---------------------------------- | ---------------------------------------------------- |
| `stateDiffs`    | `boolean`                          | Log key-level state changes after each action        |
| `actionLog`     | `boolean \| { max?: number }`      | Rolling JSONL action log (default max: 1000)         |
| `checkpoint`    | `boolean \| { debounce?: number }` | Periodic state snapshots (default debounce: 5000ms)  |
| `crashHandler`  | `boolean`                          | Global crash handler with emergency checkpoint       |
| `memoryMonitor` | `boolean \| MemoryConfig`          | Heap usage alerts                                    |
| `timeTravel`    | `boolean`                          | Time-travel debugger                                 |
| `console`       | `boolean`                          | Console output                                       |
| `vitals`        | `boolean \| VitalsConfig`          | Client freeze detection — see [vitals.md](vitals.md) |

### Performance Config (`aio.run()`)

| Config            | Type            | Default | Description                                             |
| ----------------- | --------------- | ------- | ------------------------------------------------------- |
| `perfCheck`       | `'on' \| 'off'` | `'on'`  | Enable/disable performance measurement and `perf.log`   |
| `perfBudget`      | `PerfBudget`    | —       | Override reduce/effect timing thresholds                |
| `effectTimeoutMs` | `number`        | `30000` | Hard timeout for async effects — fires `EFFECT_TIMEOUT` |

```ts
type PerfBudget = {
  reduce?: number; // ms — default: 100. Warn if reduce() exceeds this
  effect?: number; // ms — default: 5. Warn if sync effect exceeds this
};
```

**Queue safety limit:** The dispatch queue has a hard cap of 10,000 pending
actions (`QUEUE_MAX`). Exceeding this fires `QUEUE_OVERFLOW` error. This is not
configurable — if you hit it, you have an infinite dispatch loop.

---

## UI Config (`aio.run({ ui })`)

| Config                   | Description                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syncIntervalMs`         | Throttle state broadcasts: max 1 push per N ms — default `10` (100fps). `0` = microtask-only coalescing (unbounded). Leading edge fires immediately; trailing flush ensures last state always arrives within N ms. Top-level config (not in `ui`). |
| `client`                 | `'electron' \| 'browser' \| 'cli' \| 'server-only'` — which UI client to launch (top-level, replaces `ui.electron` + `headless`)                                                                                                                   |
| `keepServer`             | Keep server running after Electron closes (default: `false`) (top-level, replaces `ui.keepAlive`)                                                                                                                                                  |
| `transport`              | `'uds' \| 'ws' \| 'auto'` — IPC transport (default: `'auto'`) (top-level, replaces `ui.transport`)                                                                                                                                                 |
| `ui.title`               | Window title (default: `'AIO App'`)                                                                                                                                                                                                                |
| `ui.width` / `ui.height` | Window dimensions (default: `800` / `600`)                                                                                                                                                                                                         |
| `ui.showStatus`          | Show reconnection indicator (default: `true`)                                                                                                                                                                                                      |

---

## CLI App (Remote Client)

| API                                | Description                                                   |
| ---------------------------------- | ------------------------------------------------------------- |
| `connectCli(url, opts?)`           | Connect to remote aio server via WebSocket — returns `CliApp` |
| `connectCliUDS(socketPath, opts?)` | Connect via Unix Domain Socket (Electron) — returns `CliApp`  |

---

## Middleware

| API                                               | Description                              |
| ------------------------------------------------- | ---------------------------------------- |
| `beforeReduce: (action, state) => action \| null` | Filter/transform actions before reduce   |
| `afterReduce: (state, action) => void`            | Side effects after state update          |
| `onAction: (action, state) => void`               | Observe all actions (logging, analytics) |

---

## Testing

| API                          | Description                                      |
| ---------------------------- | ------------------------------------------------ |
| `t.dispatch(action)`         | Dispatch action in test                          |
| `t.getState()`               | Get current test state                           |
| `t.expect.state(feature)`    | Get feature's state slice                        |
| `t.expect.status(expected)`  | Assert machine status                            |
| `t.expect.matches(expected)` | Assert state matches partial object              |
| `t.settle()`                 | Wait for all effects + async methods to complete |
| `t.spy(fn)`                  | Track calls to a function                        |
| `t.spy.calls`                | Array of `[...args]` for each call               |
| `t.spy.reset()`              | Clear spy call history                           |

---

## Logging

### Configuration — `aio.run({ logging })`

Logging is enabled by default. Set `logging: false` to disable.

| Config                  | Description                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `logging: false`        | Disable logging entirely                                                                  |
| `logging.level`         | Minimum level written to `debug.log` (default: `'trace'`)                                 |
| `logging.dir`           | Log directory (default: `'./log'`)                                                        |
| `logging.console`       | Pretty console output in dev (default: auto-detected)                                     |
| `logging.heartbeat`     | Heartbeat interval in seconds — 0 to disable (default: 3600)                              |
| `logging.suppressTypes` | Action types to exclude from all logs                                                     |
| `logging.backupLogs`    | Keep previous logs on restart — rotates to .1, .2, etc. (default: false — wipe on start)  |
| `logging.backupKeep`    | How many backup archives to keep when `backupLogs` is enabled (default: 7, 0 = unlimited) |

### Public singleton — `log`

```ts
import { log } from "aio";

log.info("payments", "charge processed", { amount: 99 });
log.warn("auth", "token expiring", { userId: "u_123" });
log.error("db", "connection lost", { error: "ECONNREFUSED" });
log.debug("cache", "miss", { key: "user:42" });
log.trace("store", "action dispatched");
```

All methods: `log.trace(cat, msg, data?)` / `log.debug` / `log.info` /
`log.warn` / `log.error`. Falls back to console (info + error only) when
AioLogger is not active. No-ops when `logging: false`.

### Log outputs

| File              | Content                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| `log/app.log`     | Narrative: feature lifecycle, flow completions, state transitions, errors            |
| `log/debug.log`   | All dispatched actions + `trace`/`debug` from `log.*` calls                          |
| `log/error.log`   | Errors only — for ops/alerting                                                       |
| `log/warning.log` | Warnings — non-fatal issues requiring attention                                      |
| `log/perf.log`    | Performance violations with phase breakdown (produce/clone/spread/routing/listeners) |

### Plain text entry format

```
2026-03-15 14:23:01.456  INFO   payments    charge processed  amount=99  145ms  (payments-effect.ts:42)
```

| Field  | Description                                                                         |
| ------ | ----------------------------------------------------------------------------------- |
| `ts`   | Timestamp — `YYYY-MM-DD HH:mm:ss.SSS`                                               |
| `lvl`  | Severity level (uppercased, padded to 5 chars)                                      |
| `cat`  | Category (padded to 10 chars) — feature name, flow name, or any string              |
| `msg`  | Human-readable message                                                              |
| `data` | Optional key=value pairs — omitted if empty                                         |
| `dur`  | Optional duration in ms — present on flow completions                               |
| `src`  | Source file and line — auto-detected from call stack (e.g. `payments-effect.ts:42`) |

Columns separated by 2 spaces. Console output adds ANSI colors (level-coded,
keyword-highlighted).

---

## Utility

| API                    | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `VERSION`              | Framework version string                             |
| `parseCli(args)`       | Parse CLI flags — returns `{ command, flags, args }` |
| `lint(features)`       | Validate feature definitions at startup              |
| `instances()`          | List running aio instances (from lock file)          |
| `resolveAppId(appDir)` | Resolve app identity from directory                  |
| `slugify(name)`        | Convert name to URL-safe slug                        |
