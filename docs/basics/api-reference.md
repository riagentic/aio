# API Reference

> v2: methods is the one style — see
> [docs/upgrade/restructure.md](../upgrade/restructure.md) for the removed
> `actions`/`reduce`/`machine`/`generators`/middleware surface.

Universal: `import { aio, cell, log } from "aio"` (state, lifecycle, logging)

Rendering: `import { signal } from "aio/air"`

Focused imports:

```ts
import { createDB } from "aio/server"; // server-only values (SQLite, CLI)
import { testCell } from "aio/testing"; // Test harness only
import { createSelector, schedule } from "aio"; // scheduling + selectors live on the core entry
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

| API                       | Description                                                                    |
| ------------------------- | ------------------------------------------------------------------------------ |
| `cell(name, config)`      | Define a cell — see [Cells](../state/cells.md), [Methods](../state/methods.md) |
| `testCell(def, name, fn)` | Isolated test harness — see [Cell Testing](../testing/cell-testing.md)         |

## Runtime

| API               | Description                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aio.run(config)` | Start the app — see [Lifecycle](../state/lifecycle.md) and [Cell Config](#cell-config)                                                                                                                                    |
| `call(opts, fn)`  | Call with `{ timeoutMs?, retries? }` -- wraps inter-cell calls                                                                                                                                                            |
| `errorCode(err)`  | The failure CODE on a rejected call (`"ACCESS_DENIED"`, `"ACTION_REFUSED"`, …), or `undefined` -- branch on this, never on the message ([Errors](../debugging/errors.md#reading-the-code-off-a-failed-call-errorcodeerr)) |
| `markAsync(fn)`   | Mark a method as async for minified bundles                                                                                                                                                                               |

### `aio.run` keys not covered elsewhere

| Key               | Description                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `freezeState`     | Deep-freeze committed state after every reduce so an illegal mutation throws (default: `true` in dev, `false` in prod)                                  |
| `guardDispatches` | Supervised runtime: an unhandled promise rejection is logged, checkpointed and the process SURVIVES (default `true` since alpha61; `false` = fail-fast) |
| `childWindows`    | Let the Electron client open CHILD windows to arbitrary http(s) URLs via `__aioIPC.openWindow` (default `false` -- real attack surface, opt in)         |

### Dispatch introspection

There is no `dispatch` object to hold: `app.dispatch` is a plain function. Queue
depth and effect backlog are read from the loop probe, not from an import --
`GET /__aio/vitals` (`queueDepth`, `drainRate`, `effectBacklog`) or
`am metrics`. See [Vitals](../debugging/vitals.md#loopprobe-server).

## Server (HTTP + caller context)

| API                                     | Description                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `route(handler, opts?)`                 | A `routes: {}` handler with `:id` params, method guard, cookies, `ctx.json/text/redirect`                                            |
| `serverUser()`                          | Ambient caller identity — `undefined` = anonymous or server-origin                                                                   |
| `serverRequest()`                       | Ambient request facts — `{ ip, headers, cookies, url, method, via }`, read-only                                                      |
| `serverFns(ns, fns)`                    | DEFINE server-only functions (server side)                                                                                           |
| `serverFn<T>(ns)`                       | CALL them from the client — a typed proxy over the WS bridge (never queued: offline, or a connection lost mid-call, rejects at once) |
| `generateTotpSecret()` / `totpUri(...)` | TOTP enrollment primitives for a hand-rolled 2FA UI                                                                                  |
| `verifyTotp(secret, code)`              | Verify a TOTP code                                                                                                                   |

See [routes](../examples/05-integrations.md) and [auth](../auth/auth.md).

## Advanced

| API                                  | Description                                  |
| ------------------------------------ | -------------------------------------------- |
| `composeCells(entries)`              | Combine cells manually                       |
| `bindCell(cell, dispatch, getState)` | Wire a cell to a custom dispatch bus         |
| `deepFreeze(obj)`                    | Deep freeze for dev-mode immutability checks |

---

## Async workflow helpers

Method-native workflow tools — see
[Workflows](../state/methods.md#workflows-in-async-methods):

| API                      | Description                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `until(pred, opts?)`     | Wait for a state condition -- `{ timeoutMs?, intervalMs?, msg?, signal? }`                                                                               |
| `race(branches)`         | First named branch to settle wins -- `RaceResult`, one union member per branch, so narrowing `winner` narrows `value`; `timeout: ms` sugar               |
| `sleep(ms)`              | Promise pause                                                                                                                                            |
| `blocking(id, fn, arg?)` | Run CPU/FFI work on a worker pool — off the main thread; server-only, refuses by name elsewhere ([perf](../debugging/performance.md#move-it-off-thread)) |
| `UntilTimeoutError`      | Thrown when `until` exceeds its timeout (default 30s)                                                                                                    |

---

## Cell Config

| Key                     | Description                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`                 | Initial state object                                                                                                                                                 |
| `methods`               | Sync/async methods -- `(s, ...args) => void \| Promise`                                                                                                              |
| `selectors`             | Derived state -- `{ getName: s => s.name }` (auto-scoped)                                                                                                            |
| `cancelOn`              | Abort triggers per async method -- `{ method: [actions] }`                                                                                                           |
| `listensTo`             | Observed foreign actions -- `[otherCell.action]`                                                                                                                     |
| `validate`              | State validator -- `(s) => true \| string`                                                                                                                           |
| `persist`               | Persistence config -- `{ exclude: ['tempCache'] }`                                                                                                                   |
| `visible`               | READ side: what a client may see -- `"all" \| "none" \| { include \| exclude, forUser }` ([visibility](../state/cell-visibility.md))                                 |
| `access`                | CALL side: who may call methods over the network -- `true` / role / predicate ([visibility](../state/cell-visibility.md))                                            |
| `scope`                 | `"client"` runs the cell locally in the browser, `"server"` (default) on the server ([contexts](../state/cell-contexts.md))                                          |
| `long`                  | Method names exempt from the effect timeout -- long-running jobs ([methods](../state/methods.md))                                                                    |
| `sync`                  | `true \| SyncConfig` -- CRDT sync for this cell ([CRDT](../persistence/crdt.md))                                                                                     |
| `transaction`           | `true \| { serialize?, conflict? }` -- async methods read a pinned snapshot, read-set checked at commit ([transactional methods](../state/transactional-methods.md)) |
| `onRestore`             | Hook after persisted state is loaded -- `(state) => state \| void` ([persistence](../persistence/how-it-works.md))                                                   |
| `version` / `onMigrate` | State-shape versioning + migration hook                                                                                                                              |
| `worker`                | `true` runs this cell's methods on their own Deno worker thread ([cell workers](../state/cell-workers.md))                                                           |
| `onInit`                | Init hook -- `(app) => { ... }` runs after aio.run()                                                                                                                 |
| `onDestroy`             | Destroy hook -- `(app) => { ... }` runs before shutdown                                                                                                              |

---

## AIR Hooks

| Hook                        | Description                                                                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useAio<S>()`               | Proxy-tracked state access. Returns `{ state, send, ready }` — `ready` is true once a full state frame has landed, so `if (!ready) return <Spinner/>` replaces the hand-rolled one-arbitrary-slice loading gate                                    |
| Direct cell access          | Scoped state + typed methods, selective re-renders                                                                                                                                                                                                 |
| `useProjection(fn, deps)`   | Structural sharing for derived data                                                                                                                                                                                                                |
| `memo(Component, compare?)` | No-op (auto-memo via shallow prop compare)                                                                                                                                                                                                         |
| `useLocal(initial)`         | Client-only state (not synced). Two forms, neither "preferred": `const [v, setV] = useLocal(0)` for a scalar; `const f = useLocal({…})` when you want `f.patch({ name })` for a form draft                                                         |
| `useTimeTravel()`           | Dev-mode time-travel controls                                                                                                                                                                                                                      |
| `connectReduxDevTools()`    | Connect to the Redux DevTools browser extension — streams every state change (paired with the action that caused it); a no-op when the extension is absent. Not `connectAioDevTools()` (`aio/air`), which drives aio's own component-tree devtools |
| `disconnectReduxDevTools()` | Disconnect from Redux DevTools                                                                                                                                                                                                                     |
| `page(current, routes)`     | State-based routing                                                                                                                                                                                                                                |

## A non-AIR view layer

There is no public `client` object. `client` and `matchPath` exist on the
BROWSER bundle entry as plumbing for generated shells, and are deliberately kept
off `aio/air` -- `tests/air-entry.test.ts` and
`tests/browser-air-surface.test.ts` pin that decision, with the reason for each
name. Importing them is not supported and `deno check` refuses it.

To drive aio state from React, Vue or Svelte, mount the component as an island:
`reactIsland` (`aio/air`) for React, `island` for the rest. Everything else
reads state through `useAio()` / a cell handle.

## URL Routing

| API                   | Description                                    |
| --------------------- | ---------------------------------------------- |
| `useRoute(pattern?)`  | Subscribe to URL -- `{ path, params, search }` |
| `useNavigate()`       | Returns `navigate` function                    |
| `navigate(to, opts?)` | Programmatic navigation                        |
| `<Route>`             | Renders `element` when `path` matches          |
| `<Outlet>`            | Renders matched child route in layout          |
| `<Link to>`           | SPA anchor with active class support           |
| `<NavLink to>`        | Link with automatic `active` class             |
| `<Redirect to>`       | Navigate on mount (auth guards)                |

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

| Config                                                   | Description                                           |
| -------------------------------------------------------- | ----------------------------------------------------- |
| `persist: true`                                          | Auto-persist state to SQLite (`state.db`)             |
| `persist: "all" \| "none" \| { include } \| { exclude }` | Per-cell persistence filter                           |
| `visible: "all" \| "none" \| { include } \| { exclude }` | Per-cell visibility filter (`ui:` = deprecated alias) |
| `visible: { include, forUser }`                          | Per-cell visibility with per-user transform           |
| `cellDefaults: { visible, persist }`                     | App-level defaults for all cells (`ui` = deprecated)  |

## Action Interception

| API                                                      | Description                            |
| -------------------------------------------------------- | -------------------------------------- |
| `beforeReduce: (action, state, user?) => action \| null` | Filter/transform actions before reduce |

---

## Types

| Type                                                                                                                                                           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CellDef`                                                                                                                                                      | Return type of `cell()` -- callable methods at top level                                                                                                                                                                                                                                                                                                                                                                                              |
| `CellEntry`                                                                                                                                                    | Cell or `{ cell, dependsOn? }`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `CellEffect`                                                                                                                                                   | Union of schedule/own effects -- the type `s.$do(...)` takes                                                                                                                                                                                                                                                                                                                                                                                          |
| `MethodDraftMeta`                                                                                                                                              | `{ $signal, $commit, $live }` -- draft extras (cancellation, transactions)                                                                                                                                                                                                                                                                                                                                                                            |
| `UntilOptions`                                                                                                                                                 | `{ timeoutMs?, intervalMs?, msg?, signal? }`                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CallOptions`                                                                                                                                                  | `{ timeoutMs?: number; retries?: number }`                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ScopedApp<S>`                                                                                                                                                 | App context for init/destroy/execute                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `TestContext`                                                                                                                                                  | Test harness -- `{ state, send, expect, settle, init, destroy, as, getState, getEffects, runEffects, randomActions, invariant }`                                                                                                                                                                                                                                                                                                                      |
| `AioError`                                                                                                                                                     | Error with `code`, `source`, `context`, `correlationId`                                                                                                                                                                                                                                                                                                                                                                                               |
| `AioErrorCode`                                                                                                                                                 | Union of every framework error code -- see [Errors](../debugging/errors.md)                                                                                                                                                                                                                                                                                                                                                                           |
| `RaceResult<T>`                                                                                                                                                | What `race()` resolves to -- one union member per branch, so `winner` narrows `value`                                                                                                                                                                                                                                                                                                                                                                 |
| `CellVisibility` / `CellFieldFilter`                                                                                                                           | The declared types of the `visible:` and `persist:` cell keys                                                                                                                                                                                                                                                                                                                                                                                         |
| `SelectorDef<S>`                                                                                                                                               | One entry of a cell's `selectors: { … }`                                                                                                                                                                                                                                                                                                                                                                                                              |
| `AuthOptions` / `UiTheme` / `WsLimits` / `SecurityConfig` / `StormConfig` / `FeedbackInput` / `UpdatesInput` / `DbMapping` / `RawRouteHandler` / `RestartPlan` | The declared types of `aio.run()` keys and of what `app.restart()` resolves to                                                                                                                                                                                                                                                                                                                                                                        |
| `LogConfig`                                                                                                                                                    | Logging configuration                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `LogLevel`                                                                                                                                                     | `'trace' \| 'debug' \| 'info' \| 'warn' \| 'error'`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `VitalsConfig`                                                                                                                                                 | Client diagnostic config -- see [Vitals](../debugging/vitals.md)                                                                                                                                                                                                                                                                                                                                                                                      |
| `VitalAlert`                                                                                                                                                   | `{ id, layer, status, duration, measured, threshold, hint, ts }`                                                                                                                                                                                                                                                                                                                                                                                      |
| `MemoryConfig`                                                                                                                                                 | Heap monitoring config -- `{ enabled, interval, warnThreshold, criticalThreshold, trendWindow, machineWarnFraction, growthReportRatio, onMemoryPressure }`; `trendWindow` = samples kept for trend detection (default 10). Every key is read by the monitor; an unknown key is refused at boot with a did-you-mean, and the alpha70-removed `gcStressRatio` (accepted, never read) is refused by name -- see [Production](../debugging/production.md) |
| `ScheduleEffect`                                                                                                                                               | `{ _schedule: true, key, type, ... }` from sync methods                                                                                                                                                                                                                                                                                                                                                                                               |

---

## Testing

`testCell(def, name, fn)` -- `t` is `TestContext<S, A>`:

| API                         | Description                                |
| --------------------------- | ------------------------------------------ |
| `t.send[key](...args)`      | Dispatch typed action                      |
| `t.getState()`              | Get current cell state                     |
| `t.expect.state(fn)`        | Assert state via predicate                 |
| `t.expect.effects(types[])` | Assert exact effect types from last action |
| `t.expect.effectCount(n)`   | Assert number of effects                   |
| `t.expect.invariant(fn)`    | Assert predicate holds                     |
| `t.settle(ms?)`             | Run effects + wait for async               |
| `t.getEffects()`            | Get effects from last action               |
| `t.randomActions(n)`        | Dispatch N random valid actions            |
| `t.init()`                  | Reset to initial state                     |
| `t.destroy()`               | Destroy cell                               |

Beyond a single cell — all from `aio/testing`:

| API                       | Description                                                                     |
| ------------------------- | ------------------------------------------------------------------------------- |
| `testUI(App, name, fn)`   | Mount an app and drive it through its semantic surface (no DOM selectors)       |
| `testServer(config)`      | Boot a library-mode app on a free port + temp dir — `await using`, self-closing |
| `testBrowser(url, opts?)` | Managed headless Chromium — killed on dispose, even if the test crashes         |
| `findChromium()`          | Locate a browser binary (`$CHROMIUM_BIN` or the usual paths), or `null`         |
| `freePort()`              | A port the OS says is free — never hardcode or derive one                       |

---

## Logging

```ts
import { log } from "aio";
log.info("payments", "charge processed", { amount: 99 });
log.warn("auth", "token expiring", { userId: "u_123" });
log.error("db", "connection lost", { error: "ECONNREFUSED" });
```

| File               | Content                                     |
| ------------------ | ------------------------------------------- |
| `logs/app.log`     | Cell lifecycle, transitions, errors         |
| `logs/debug.log`   | All dispatched actions + trace/debug        |
| `logs/error.log`   | Errors only                                 |
| `logs/warning.log` | Warnings                                    |
| `logs/perf.log`    | Performance violations with phase breakdown |

Paths are under the app's data home, `~/.<appId>/logs/` (see
[where files live](../persistence/where-files-live.md)); `./.aio/log/` is only
the pre-boot fallback used before the home is resolved.

## Utility

| API                   | Description                                                      |
| --------------------- | ---------------------------------------------------------------- |
| `VERSION`             | Framework version string                                         |
| `parseCli(args)`      | Parse CLI flags                                                  |
| `checkCells(cells)`   | Validate cell definitions (its `lint` alias went out in alpha70) |
| `instances()`         | List running aio instances                                       |
| `resolveAppId(appId)` | Canonical app slug from the appId string (throws if missing)     |
