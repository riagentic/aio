# API Reference

Main import: `import { feature, call, aio } from 'aio'`

---

## Core

| API                         | Description                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| `feature(name, config)`     | Define a feature with state, methods/generators, machine, selectors |
| `testFeature(def, config?)` | Create isolated test harness for a feature                          |

## Runtime

| API                         | Description                                                     |
| --------------------------- | --------------------------------------------------------------- |
| `aio.run(config)`           | Start the app -- see Feature Config for options                 |
| `aio.middleware.logger()`   | Log all actions to console (dev mode)                           |
| `aio.middleware.validate()` | Validate action shapes before reduce                            |
| `call(opts, fn)`            | Call with `{ timeout?, retries? }` -- wraps inter-feature calls |
| `markAsync(fn)`             | Mark a method as async for minified bundles                     |

### Dispatch Introspection

| API                           | Description                                         |
| ----------------------------- | --------------------------------------------------- |
| `dispatch.getQueueDepth()`    | Current number of pending actions in dispatch queue |
| `dispatch.getEffectBacklog()` | Number of async effects currently in-flight         |

## Advanced

| API                                        | Description                                           |
| ------------------------------------------ | ----------------------------------------------------- |
| `composeFeatures(entries)`                 | Combine features manually                             |
| `bindFeature(feature, dispatch, getState)` | Wire a feature to a custom dispatch bus               |
| `composeMiddleware(...fns)`                | Compose beforeReduce functions -- return null to drop |
| `draft(state, fn)`                         | Immer wrapper for actions/reduce style                |
| `matchEffect(effect, handlers, fallback?)` | Typed effect dispatch -- alternative to switch/case   |
| `deepFreeze(obj)`                          | Deep freeze for dev-mode immutability checks          |

---

## Generators (GenCtx)

| API                                     | Description                                                  |
| --------------------------------------- | ------------------------------------------------------------ |
| `yield* ctx.call(name, fn, opts?)`      | Async call with optional `{ timeout?, retries? }`            |
| `yield* ctx.mutate(name, fn)`           | State mutation via Immer draft                               |
| `yield* ctx.done(fn?)`                  | Terminal success, optional final mutation                    |
| `yield* ctx.fail(reason)`               | Terminal failure with reason                                 |
| `yield* ctx.dispatch(action)`           | Dispatch arbitrary action to any feature                     |
| `yield* ctx.send(creator, payload?)`    | Shorthand dispatch via bound method or type string           |
| `yield* ctx.all(...gens)`               | Run multiple calls in parallel (spread or named object form) |
| `yield* ctx.race({...gens})`            | Race multiple calls -- first to complete wins                |
| `yield* ctx.sleep(name, ms)`            | Sleep for N ms with named action for visibility              |
| `yield* ctx.waitFor(creator, timeout?)` | Wait for action, returns `{ type, payload }`                 |
| `yield* ctx.when(predicate, opts?)`     | Wait until state condition is true                           |
| `ctx.getState()`                        | Read current feature state (fresh after each step)           |
| `ctx.getFullState()`                    | Read full app state tree                                     |

---

## Feature Config

| Key          | Description                                                    |
| ------------ | -------------------------------------------------------------- |
| `state`      | Initial state object                                           |
| `methods`    | Sync/async methods -- `(s, ...args) => void \| Promise`        |
| `generators` | Sequential workflows -- `*name(ctx, ...args) { yield* ... }`   |
| `cancelOn`   | Cancellation triggers per generator -- `{ genKey: [actions] }` |
| `selectors`  | Derived state -- `{ getName: s => s.name }` (auto-scoped)      |
| `machine`    | State machine guards -- `{ initial, states }` or `false`       |
| `listensTo`  | Foreign action listeners -- `[otherFeature.action]`            |
| `actions`    | Action creators (explicit style)                               |
| `effects`    | Effect creators (explicit style)                               |
| `reduce`     | Reducer handlers (explicit style)                              |
| `execute`    | Effect handlers (explicit style)                               |
| `dispatchTo` | Cross-dispatch allowlist -- `[wallet, notifications]`          |
| `persist`    | KV persistence config -- `{ exclude: ['tempCache'] }`          |
| `onInit`     | Init hook -- `(app) => { ... }` runs after aio.run()           |
| `onDestroy`  | Destroy hook -- `(app) => { ... }` runs before shutdown        |

---

## React Hooks

| Hook                        | Description                                            |
| --------------------------- | ------------------------------------------------------ |
| `useAio<S>()`               | Proxy-tracked state access                             |
| `useFeature(ref)`           | Scoped state + typed send, selective re-renders        |
| `useProjection(fn, deps)`   | Structural sharing for derived data                    |
| `memo(Component, compare?)` | `React.memo` replacement with `_shallowEqual` per prop |
| `useLocal(initial)`         | Client-only state (not synced) -- `{ local, set }`     |
| `useTimeTravel()`           | Dev-mode time-travel controls                          |
| `connectDevTools()`         | Connect to Redux DevTools browser extension            |
| `disconnectDevTools()`      | Disconnect from Redux DevTools                         |
| `page(current, routes)`     | State-based routing                                    |

## Framework-agnostic Client

| API                                | Description                                        |
| ---------------------------------- | -------------------------------------------------- |
| `client.subscribe(fn)`             | Subscribe to state changes, returns unsubscribe    |
| `client.getState()`                | Current state snapshot (null before first message) |
| `client.getFeatureState(name)`     | Single feature's state slice                       |
| `client.send(action)`              | Send action to server                              |
| `client.route.subscribe(fn)`       | Subscribe to URL changes                           |
| `client.route.navigate(to, opts?)` | Navigate -- string path or history delta           |

## URL Routing

| API                            | Description                                    |
| ------------------------------ | ---------------------------------------------- |
| `useRoute(pattern?)`           | Subscribe to URL -- `{ path, params, search }` |
| `useNavigate()`                | Returns `navigate` function                    |
| `navigate(to, opts?)`          | Programmatic navigation                        |
| `<Route>`                      | Renders `element` when `path` matches          |
| `<Outlet>`                     | Renders matched child route in layout          |
| `<Link to>`                    | SPA anchor with active class support           |
| `<NavLink to>`                 | Link with automatic `active` class             |
| `<Redirect to>`                | Navigate on mount (auth guards)                |
| `matchPath(pat, path, exact?)` | Pattern matching utility                       |

---

## SQLite

| API                     | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `createDB(path, opts?)` | Create async Worker-based DB                                 |
| `DEFAULT_PRAGMAS`       | Default pragma set applied by `createDB`                     |
| `table(columns)`        | Define a SQLite table -- `table({ id: pk(), name: text() })` |
| `pk()`                  | Primary key column                                           |
| `text()`                | Text column                                                  |
| `integer()`             | Integer column                                               |
| `real()`                | Float column                                                 |
| `ref(table)`            | Foreign key reference                                        |

### DB interface

| Method                                    | Returns                   | Description                          |
| ----------------------------------------- | ------------------------- | ------------------------------------ |
| `query<T>(sql, params?)`                  | `Promise<QueryResult<T>>` | SELECT -- rows in `.rows`            |
| `execute(sql, params?)`                   | `Promise<QueryResult>`    | INSERT/UPDATE/DELETE                 |
| `transaction(fn: (tx: Tx) => Promise<T>)` | `Promise<T>`              | Callback form with read-your-writes  |
| `transaction(stmts[])`                    | `Promise<QueryResult[]>`  | Batch form -- atomic multi-statement |
| `close()`                                 | `Promise<void>`           | Close all worker connections         |

`QueryResult<T>` = `{ rows: T[], changes: number, lastInsertRowId: bigint }`

---

## Selectors

| API                                   | Description                                        |
| ------------------------------------- | -------------------------------------------------- |
| `createSelector(...inputs, resultFn)` | Memoized selector -- recomputes when inputs change |
| `createSliceSelector(feature)`        | Scoped selector -- auto-wraps with feature slice   |

## Persistence

| Config                                  | Description                          |
| --------------------------------------- | ------------------------------------ |
| `persist: true`                         | Auto-persist state to Deno.Kv        |
| `persist: { exclude: [...] }`           | Per-feature persistence exclusion    |
| `stateForDB: (state) => partial`        | Transform state before persist       |
| `stateForUI: (state, user?) => partial` | Transform state before sending to UI |

## Middleware

| API                                                      | Description                            |
| -------------------------------------------------------- | -------------------------------------- |
| `beforeReduce: (action, state, user?) => action \| null` | Filter/transform actions before reduce |

---

## Types

| Type              | Description                                                      |
| ----------------- | ---------------------------------------------------------------- |
| `FeatureDef`      | Return type of `feature()` -- callable methods at top level      |
| `FeatureEntry`    | Feature or `{ feature, dependsOn? }`                             |
| `MachineConfig`   | `{ initial, states: { state: { action: target } } }`             |
| `GenCtx<S>`       | Generator context -- S inferred from feature state               |
| `Gen<T>`          | Generator return type for flows                                  |
| `TypedCreator<P>` | Action creator with `.type`                                      |
| `CallOptions`     | `{ timeout?: number; retries?: number }`                         |
| `ScopedApp<S>`    | App context for init/destroy/execute                             |
| `TestContext`     | Test harness -- `{ dispatch, getState, expect, settle }`         |
| `AioError`        | Error with `code`, `source`, `context`, `correlationId`          |
| `AioErrorCode`    | 16 error codes -- see [../debugging.md](../debugging.md)         |
| `LogConfig`       | Logging configuration                                            |
| `LogLevel`        | `'trace' \| 'debug' \| 'info' \| 'warn' \| 'error'`              |
| `VitalsConfig`    | Client diagnostic config -- see [../vitals.md](../vitals.md)     |
| `VitalAlert`      | `{ id, layer, status, duration, measured, threshold, hint, ts }` |
| `MemoryConfig`    | Heap monitoring config                                           |
| `ScheduleEffect`  | `{ _schedule: true, key, type, ... }` from sync methods          |

---

## Testing

`testFeature(def, name, fn)` -- `t` is `TestContext<S, A>`:

| API                         | Description                                |
| --------------------------- | ------------------------------------------ |
| `t.send[key](...args)`      | Dispatch typed action                      |
| `t.getState()`              | Get current feature state                  |
| `t.expect.state(fn)`        | Assert state via predicate                 |
| `t.expect.status(expected)` | Assert machine status                      |
| `t.expect.effects(types[])` | Assert exact effect types from last action |
| `t.expect.effectCount(n)`   | Assert number of effects                   |
| `t.expect.invariant(fn)`    | Assert predicate holds                     |
| `t.settle(ms?)`             | Run effects + wait for async               |
| `t.getEffects()`            | Get effects from last action               |
| `t.randomActions(n)`        | Dispatch N random valid actions            |
| `t.init()`                  | Reset to initial state                     |
| `t.destroy()`               | Destroy feature                            |

---

## Logging

```ts
import { log } from "aio";
log.info("payments", "charge processed", { amount: 99 });
log.warn("auth", "token expiring", { userId: "u_123" });
log.error("db", "connection lost", { error: "ECONNREFUSED" });
```

| File              | Content                                     |
| ----------------- | ------------------------------------------- |
| `log/app.log`     | Feature lifecycle, transitions, errors      |
| `log/debug.log`   | All dispatched actions + trace/debug        |
| `log/error.log`   | Errors only                                 |
| `log/warning.log` | Warnings                                    |
| `log/perf.log`    | Performance violations with phase breakdown |

## Utility

| API                    | Description                         |
| ---------------------- | ----------------------------------- |
| `VERSION`              | Framework version string            |
| `parseCli(args)`       | Parse CLI flags                     |
| `lint(features)`       | Validate feature definitions        |
| `instances()`          | List running aio instances          |
| `resolveAppId(appDir)` | Resolve app identity from directory |
