# API Reference

Universal: `import { aio, cell, log } from "aio"` (state, lifecycle, logging)

Rendering: `import { signal } from "aio/air"`

Focused imports:

```ts
import { createDB } from "aio/db"; // SQLite only
import { testCell } from "aio/testing"; // Test harness only
import { schedule } from "aio/schedule"; // Scheduling only
import { createSelector } from "aio/selectors"; // Selectors only
```

### Start Here

Most apps only need these five APIs:

| API                         | What it does                       | Guide                                      |
| --------------------------- | ---------------------------------- | ------------------------------------------ |
| `cell(name, config)`        | Define a piece of state + behavior | [Cells](../state/cells.md)                 |
| `aio.run(config)`           | Boot the app                       | [Lifecycle](../state/lifecycle.md)         |
| `counter.count` (direct)    | Connect UI to cell state           | [AIR Setup](../ui/air-setup.md)            |
| `testCell(def, name, fn)`   | Test a cell in isolation           | [Cell Testing](../testing/cell-testing.md) |
| `log.info(tag, msg, data?)` | Structured logging                 | [Logging](#logging)                        |

Everything below is the full reference, organized by category.

---

## Core

| API                      | Description                                                                    |
| ------------------------ | ------------------------------------------------------------------------------ |
| `cell(name, config)`     | Define a cell — see [Cells](../state/cells.md), [Methods](../state/methods.md) |
| `testCell(def, config?)` | Isolated test harness — see [Cell Testing](../testing/cell-testing.md)         |

## Runtime

| API                         | Description                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `aio.run(config)`           | Start the app — see [Lifecycle](../state/lifecycle.md) and [Cell Config](#cell-config) |
| `aio.middleware.logger()`   | Log all actions to console (dev mode)                                                  |
| `aio.middleware.validate()` | Validate action shapes before reduce                                                   |
| `call(opts, fn)`            | Call with `{ timeout?, retries? }` -- wraps inter-cell calls                           |
| `markAsync(fn)`             | Mark a method as async for minified bundles                                            |

### Dispatch Introspection

| API                           | Description                                         |
| ----------------------------- | --------------------------------------------------- |
| `dispatch.getQueueDepth()`    | Current number of pending actions in dispatch queue |
| `dispatch.getEffectBacklog()` | Number of async effects currently in-flight         |

## Advanced

| API                                        | Description                                           |
| ------------------------------------------ | ----------------------------------------------------- |
| `composeCells(entries)`                    | Combine cells manually                                |
| `bindCell(cell, dispatch, getState)`       | Wire a cell to a custom dispatch bus                  |
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
| `yield* ctx.dispatch(action)`           | Dispatch arbitrary action to any cell                        |
| `yield* ctx.send(creator, payload?)`    | Shorthand dispatch via bound method or type string           |
| `yield* ctx.all(...gens)`               | Run multiple calls in parallel (spread or named object form) |
| `yield* ctx.race({...gens})`            | Race multiple calls -- first to complete wins                |
| `yield* ctx.sleep(name, ms)`            | Sleep for N ms with named action for visibility              |
| `yield* ctx.waitFor(creator, timeout?)` | Wait for action, returns `{ type, payload }`                 |
| `yield* ctx.when(predicate, opts?)`     | Wait until state condition is true                           |
| `ctx.getState()`                        | Read current cell state (fresh after each step)              |
| `ctx.getFullState()`                    | Read full app state tree                                     |

---

## Cell Config

| Key          | Description                                                    |
| ------------ | -------------------------------------------------------------- |
| `state`      | Initial state object                                           |
| `methods`    | Sync/async methods -- `(s, ...args) => void \| Promise`        |
| `generators` | Sequential workflows -- `*name(ctx, ...args) { yield* ... }`   |
| `cancelOn`   | Cancellation triggers per generator -- `{ genKey: [actions] }` |
| `selectors`  | Derived state -- `{ getName: s => s.name }` (auto-scoped)      |
| `machine`    | State machine guards -- `{ initial, states }` or `false`       |
| `listensTo`  | Foreign action listeners -- `[otherCell.action]`               |
| `actions`    | Action creators (explicit style)                               |
| `effects`    | Effect creators (explicit style)                               |
| `reduce`     | Reducer handlers (explicit style)                              |
| `execute`    | Effect handlers (explicit style)                               |
| `persist`    | KV persistence config -- `{ exclude: ['tempCache'] }`          |
| `onInit`     | Init hook -- `(app) => { ... }` runs after aio.run()           |
| `onDestroy`  | Destroy hook -- `(app) => { ... }` runs before shutdown        |

---

## AIR Hooks

| Hook                        | Description                                        |
| --------------------------- | -------------------------------------------------- |
| `useAio<S>()`               | Proxy-tracked state access                         |
| Direct cell access          | Scoped state + typed methods, selective re-renders |
| `useProjection(fn, deps)`   | Structural sharing for derived data                |
| `memo(Component, compare?)` | No-op (auto-memo via shallow prop compare)         |
| `useLocal(initial)`         | Client-only state (not synced) -- `{ local, set }` |
| `useTimeTravel()`           | Dev-mode time-travel controls                      |
| `connectDevTools()`         | Connect to Redux DevTools browser extension        |
| `disconnectDevTools()`      | Disconnect from Redux DevTools                     |
| `page(current, routes)`     | State-based routing                                |

## Framework-agnostic Client

| API                                | Description                                        |
| ---------------------------------- | -------------------------------------------------- |
| `client.subscribe(fn)`             | Subscribe to state changes, returns unsubscribe    |
| `client.getState()`                | Current state snapshot (null before first message) |
| `client.getCellState(name)`        | Single cell's state slice                          |
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

| API                     | Description                                                           |
| ----------------------- | --------------------------------------------------------------------- |
| `createDB(path, opts?)` | Create async Worker-based DB — see [SQLite](../persistence/sqlite.md) |
| `DEFAULT_PRAGMAS`       | Default pragma set applied by `createDB`                              |
| `table(columns)`        | Define a SQLite table -- `table({ id: pk(), name: text() })`          |
| `pk()`                  | Primary key column                                                    |
| `text()`                | Text column                                                           |
| `integer()`             | Integer column                                                        |
| `real()`                | Float column                                                          |
| `ref(table)`            | Foreign key reference                                                 |

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
| `createSliceSelector(cell)`           | Scoped selector -- auto-wraps with cell slice      |

## Persistence

| Config                                                   | Description                                    |
| -------------------------------------------------------- | ---------------------------------------------- |
| `persist: true`                                          | Auto-persist state to Deno.Kv                  |
| `persist: "all" \| "none" \| { include } \| { exclude }` | Per-cell persistence filter                    |
| `ui: "all" \| "none" \| { include } \| { exclude }`      | Per-cell UI visibility filter                  |
| `ui: { include, forUser }`                               | Per-cell UI visibility with per-user transform |
| `cellDefaults: { ui, persist }`                          | App-level defaults for all cells               |

## Middleware

| API                                                      | Description                            |
| -------------------------------------------------------- | -------------------------------------- |
| `beforeReduce: (action, state, user?) => action \| null` | Filter/transform actions before reduce |

---

## Types

| Type              | Description                                                      |
| ----------------- | ---------------------------------------------------------------- |
| `CellDef`         | Return type of `cell()` -- callable methods at top level         |
| `CellEntry`       | Cell or `{ cell, dependsOn? }`                                   |
| `MachineConfig`   | `{ initial, states: { state: { action: target } } }`             |
| `GenCtx<S>`       | Generator context -- S inferred from cell state                  |
| `Gen<T>`          | Generator return type for flows                                  |
| `TypedCreator<P>` | Action creator with `.type`                                      |
| `CallOptions`     | `{ timeout?: number; retries?: number }`                         |
| `ScopedApp<S>`    | App context for init/destroy/execute                             |
| `TestContext`     | Test harness -- `{ dispatch, getState, expect, settle }`         |
| `AioError`        | Error with `code`, `source`, `context`, `correlationId`          |
| `AioErrorCode`    | 16 error codes -- see [Errors](../debugging/errors.md)         |
| `LogConfig`       | Logging configuration                                            |
| `LogLevel`        | `'trace' \| 'debug' \| 'info' \| 'warn' \| 'error'`              |
| `VitalsConfig`    | Client diagnostic config -- see [Vitals](../debugging/vitals.md)     |
| `VitalAlert`      | `{ id, layer, status, duration, measured, threshold, hint, ts }` |
| `MemoryConfig`    | Heap monitoring config                                           |
| `ScheduleEffect`  | `{ _schedule: true, key, type, ... }` from sync methods          |

---

## Testing

`testCell(def, name, fn)` -- `t` is `TestContext<S, A>`:

| API                         | Description                                |
| --------------------------- | ------------------------------------------ |
| `t.send[key](...args)`      | Dispatch typed action                      |
| `t.getState()`              | Get current cell state                     |
| `t.expect.state(fn)`        | Assert state via predicate                 |
| `t.expect.status(expected)` | Assert machine status                      |
| `t.expect.effects(types[])` | Assert exact effect types from last action |
| `t.expect.effectCount(n)`   | Assert number of effects                   |
| `t.expect.invariant(fn)`    | Assert predicate holds                     |
| `t.settle(ms?)`             | Run effects + wait for async               |
| `t.getEffects()`            | Get effects from last action               |
| `t.randomActions(n)`        | Dispatch N random valid actions            |
| `t.init()`                  | Reset to initial state                     |
| `t.destroy()`               | Destroy cell                               |

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
| `log/app.log`     | Cell lifecycle, transitions, errors         |
| `log/debug.log`   | All dispatched actions + trace/debug        |
| `log/error.log`   | Errors only                                 |
| `log/warning.log` | Warnings                                    |
| `log/perf.log`    | Performance violations with phase breakdown |

## Utility

| API                    | Description                         |
| ---------------------- | ----------------------------------- |
| `VERSION`              | Framework version string            |
| `parseCli(args)`       | Parse CLI flags                     |
| `lint(cells)`          | Validate cell definitions           |
| `instances()`          | List running aio instances          |
| `resolveAppId(appDir)` | Resolve app identity from directory |
