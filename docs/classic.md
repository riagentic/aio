# Classic API (v0.4)

The two-argument `aio.run(state, config)` form and manual action/effect catalog factories. Still fully supported — use for simple apps or migration from v0.4.

For the v0.5+ feature-based API, see [core.md](core.md). For the docs index, see [manual.md](manual.md).

## `aio.run(initialState, config)` — classic entry point

The v0.4 two-argument form still works. Use this for simple apps or migration:

```ts
await aio.run(initialState, {
  reduce,           // required — state machine
  execute,          // required — side effect handler
  persist: true,    // default: true — auto Deno.Kv
  persistKey: 'state',  // KV key name
  getDBState: (s) => s, // filter what gets persisted
  getUIState: (s) => s, // filter what gets sent to UI
  port: 8000,
  baseDir: './src',     // where App.tsx lives (resolved to absolute path)
  ui: {
    electron: true,     // default: true
    keepAlive: false,   // default: false — keep server running after electron closes
    title: 'My App',
  },
})
```

### Return value (both modes)

```ts
const app = await aio.run(state, config)
app.dispatch(action)    // programmatic dispatch (timers, external events)
app.getState()          // read current state
app.snapshot()          // export state as JSON string
app.loadSnapshot(json)  // import state from JSON, broadcast to all clients
app.mode                // undefined (desktop) or 'standalone' (Android)
app.features            // v0.5: feature control API (enable/disable/status/health)
await app.close()       // graceful shutdown — flush KV, close KV handle, stop HTTP server
```

`close()` flushes any pending state to Deno.Kv before shutting down, so no data is lost. Signal handlers (SIGINT/SIGTERM) and Electron close also flush automatically — `close()` is for programmatic shutdown in tests or custom lifecycle management.

Use `app.mode` to branch effects that use Deno-specific APIs:
```ts
// in execute
case E.SAVE_FILE:
  if (app.mode === 'standalone') {
    console.log('file save not available on Android')
  } else {
    Deno.writeTextFile(effect.payload.path, effect.payload.data)
  }
  break
```

### Config options (classic mode)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `reduce` | `(state, action) => { state, effects }` | **required** | Pure state machine — takes state + action, returns new state + effects |
| `execute` | `(app, effect) => void` | **required** | Side effect handler — API calls, timers, logging |
| `persist` | `boolean` | `true` | Auto-persist state to Deno.Kv |
| `persistKey` | `string` | `"state"` | KV key prefix |
| `persistDebounce` | `number` | `100` | Milliseconds between KV writes |
| `persistMode` | `'single' \| 'multi'` | `'single'` | `'multi'` stores each top-level state key separately — no 65KB/key limit |
| `getDBState` | `(state) => any` | identity | Filter state before persisting (strip transient data) |
| `getUIState` | `(state, user?: AioUser) => unknown` | identity | Filter state before sending to UI (strip secrets, per-user filtering) |
| `port` | `number` | `8000` | HTTP/WS server port |
| `baseDir` | `string` | `./src` | Directory for static files and App.tsx (resolved to absolute path). **Note:** all files in this directory are publicly accessible via HTTP |
| `ui.electron` | `boolean` | `true` | Open Electron window on start |
| `ui.keepAlive` | `boolean` | `false` | Keep server running after Electron window closes |
| `ui.title` | `string` | deno.json `"title"` or `"AIO App"` | Browser/Electron window title. Precedence: CLI `--title=` > config > deno.json `"title"` > `"AIO App"` |
| `ui.width` | `number` | `800` | Electron window width |
| `ui.height` | `number` | `600` | Electron window height |
| `ui.showStatus` | `boolean` | `true` | Show connection status indicator (reconnecting/connected pill) |
| `onRestore` | `(state) => state` | — | Transform state after restore from KV, before server starts |
| `onAction` | `(action, state, user?) => void` | — | Observe actions before reduce |
| `onEffect` | `(effect, user?) => void` | — | Observe effects before execute |
| `onConnect` | `(user?) => void` | — | WS client connected |
| `onDisconnect` | `(user?) => void` | — | WS client disconnected |
| `onStart` | `(app) => void` | — | After server boots |
| `onStop` | `() => void` | — | Before shutdown |
| `users` | `Record<string, AioUser>` | — | Per-user token auth map (see [auth.md](auth.md)) |
| `schedules` | `ScheduleDef[]` | — | Config-level scheduled effects (see [core.md](core.md#scheduled-effects)) |
| `db` | `Record<string, TableDef>` | — | SQLite table definitions — arrays auto-sync (see [persistence.md](persistence.md)) |
| `beforeReduce` | `(action, state, user?) => action \| null` | — | Intercept actions before reduce — `user` is the WebSocket client's `AioUser` (undefined for server-side dispatches). Return modified action or `null` to drop |
| `deltaThreshold` | `number` | `0.5` | Ratio (0–1) of changed keys that triggers full broadcast instead of delta patch |
| `maxConnections` | `number` | `100` | Maximum concurrent WebSocket clients (503 beyond this) |
| `perfMode` | `'strict' \| 'soft'` | `'strict'` | How to report performance violations — strict calls `onError`, soft only warns |
| `perfBudget` | `{ reduce?, effect? }` | `{ reduce: 100, effect: 5 }` | Performance budgets in milliseconds |
| `effectTimeout` | `number` | `30000` | Warning timeout for async effects (ms) — logs if effect takes longer |
| `freezeState` | `boolean` | `true` (dev), `false` (prod) | Deep freeze state after reduce to catch mutations |

## `composeMiddleware(...fns)`

Compose multiple `beforeReduce` functions into one. Functions run in order; return `null` to drop an action. The optional `user` parameter receives the `AioUser` from the WebSocket connection (undefined for server-side dispatches).

```ts
import { composeMiddleware } from 'aio'
import type { AioUser } from 'aio'

const authorize = (action, state, user?: AioUser) => {
  if (action.type.startsWith('admin:') && user?.role !== 'admin') return null
  return action
}

const enrich = (action, state, user?: AioUser) => ({
  ...action,
  payload: { ...action.payload, timestamp: Date.now(), userId: user?.id }
})

await aio.run(initialState, {
  reduce,
  execute,
  beforeReduce: composeMiddleware(authorize, enrich),
})
```

## `createSelector(...inputSelectors, resultFunc)`

Memoized selector for expensive state derivations. Caches results until input selectors return new values.

```ts
import { createSelector } from 'aio'

const selectVisibleTodos = createSelector(
  (s: AppState) => s.todos,
  (s: AppState) => s.filter,
  (todos, filter) => todos.filter(t => t.status === filter)
)

// In getUIState — only recomputes if todos or filter changed
getUIState: (state) => ({
  visibleTodos: selectVisibleTodos(state),
})
```

Multiple input selectors supported (up to 6). Result function only runs when inputs change.

## `deepFreeze(state)`

Deep freezes an object for dev-mode immutability checking. Called automatically when `freezeState: true`.

```ts
import { deepFreeze } from 'aio'

const frozen = deepFreeze({ a: 1, b: { c: 2 } })
frozen.a = 2  // TypeError in dev mode
```

## `actions()` / `effects()` — catalog factories

Factory functions that create typed catalogs. You write payload functions, the framework generates PascalCase labels and camelCase `{ type, payload }` creators.

```ts
import { actions, type UnionOf } from 'aio'

export const A = actions({
  Increment: (by = 1) => ({ by }),
  Reset: () => ({}),
})

type Action = UnionOf<typeof A>
// = { type: "Increment"; payload: { by: number } }
// | { type: "Reset"; payload: Record<string, never> }
```

**What you get:**
- `A.Increment` — PascalCase **string constant** `"Increment"` — use in `switch/case`
- `A.increment(5)` — camelCase **function** → `{ type: "Increment", payload: { by: 5 } }` — use with `send()` / `dispatch()`
- `UnionOf<typeof A>` — discriminated union of all action shapes

**Rule of thumb:** uppercase first letter = label for matching, lowercase first letter = creator for dispatching.

## `UnionOf<T>`

Derives a union type from an object of creator functions. Skips non-function members (the generated constants).

```ts
type Action = UnionOf<typeof A>
// Use in reduce/execute signatures
```

## `msg(type, payload?)`

Low-level message constructor — used internally by the factory. Available if you need to create one-off messages:

```ts
msg("INCREMENT")                    // { type: "INCREMENT", payload: {} }
msg("INCREMENT", { by: 5 })        // { type: "INCREMENT", payload: { by: 5 } }
```

## Actions pattern

Actions are sync messages from the UI that trigger state changes:

```ts
import { actions, type UnionOf } from 'aio'

export const A = actions({
  DoThing: (x: number) => ({ x }),
  Reset: () => ({}),
})

export type Action = UnionOf<typeof A>
```

**What the factory generates:**
- `A.DoThing` — PascalCase label with value `"DoThing"` — use in `switch/case`
- `A.doThing(5)` — camelCase creator: `{ type: "DoThing", payload: { x: 5 } }` for dispatching
- One definition, both uses — no separate enum + creator files

## Effects pattern

Effects are async side effects the reducer wants to happen. Same factory pattern as actions, different purpose:

- **Actions** = "what happened" (user clicked, timer fired) → sync state change
- **Effects** = "what should happen next" (call API, start timer, log) → async side effect

```ts
import { effects, type UnionOf } from 'aio'

export const E = effects({
  FetchUser: (id: string) => ({ id }),
  Log: (message: string) => ({ message }),
})

export type Effect = UnionOf<typeof E>
```

Effects are returned by the reducer, not dispatched from UI:

```ts
// in reduce.ts
case A.LoadProfile:
  d.loading = true
  return [E.fetchUser(action.payload.userId)]  // ← effect
```

Then handled in `execute.ts`:

```ts
export function execute(app: AioApp<AppState, Action>, effect: Effect): void {
  switch (effect.type) {
    case E.FetchUser:
      fetch(`/api/users/${effect.payload.id}`)
        .then(r => r.json())
        .then(user => app.dispatch(A.userLoaded(user)))  // ← dispatch back into the loop
      break
  }
}
```

The `app` parameter in `execute` gives you `dispatch` (to fire follow-up actions) and `getState` (to read current state).

**Parameter order:** `execute(app, effect)` — container first, matching `reduce(state, action)`. Both put the "context" first and the "thing to process" second.

## `matchEffect(effect, handlers, fallback?)`

Typed effect dispatch — alternative to `switch/case` in `execute()`. Scales better when you have many effect types:

```ts
import { matchEffect } from 'aio'

export function execute(app: AioApp<AppState, Action>, effect: Effect): void {
  matchEffect(effect, {
    Log: (p) => console.log(p.message),
    FetchUser: (p) => fetch(`/api/${p.id}`).then(r => r.json())
      .then(user => app.dispatch(A.userLoaded(user))),
    Notify: (p) => sendNotification(p.title, p.body),
  })
}
```

Optional `fallback` handles unmatched effects:

```ts
matchEffect(effect, { Log: (p) => console.log(p.message) }, (e) => {
  console.warn(`unhandled effect: ${e.type}`)
})
```

For small apps (< 10 effect types), `switch/case` is fine. Use `matchEffect` when your effect catalog grows.

## `draft(state, fn)` — Immer wrapper

Immer-powered immutable update. Mutate the draft, return effects.

```ts
import { draft } from 'aio'

return draft(state, d => {
  d.counter += 1           // mutate the draft (looks mutable, produces immutable result)
  d.lastUpdated = Date.now()
  return [E.log("done")]   // return effects array (can be empty: return [])
})
// Returns: { state: <new immutable state>, effects: [{ type: "Log", ... }] }
```

The callback **must** return an `E[]` array. Return `[]` for no effects.
