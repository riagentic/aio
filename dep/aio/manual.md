# aio Reference Manual

Full API reference for the aio framework. For getting started, see [quickstart.md](quickstart.md). For adopting aio into an existing app, see [migration.md](migration.md). For upgrading between versions, see [upgrade.md](upgrade.md).

## Architecture

**Desktop (Deno + Electron/browser):**
```
┌─────────────────────────────────────────────────────┐
│ Browser / Electron                                  │
│  App.tsx → useAio() ──WebSocket──→ server            │
│           state ←────────────────── broadcast        │
│           send(action) ──────────→ dispatch          │
└─────────────────────────────────────────────────────┘
                                        │
┌─────────────────────────────────────────────────────┐
│ Deno Server (aio.run)                               │
│  dispatch(action)                                   │
│    → reduce(state, action) → { state, effects }     │
│    → persist to Deno.Kv                             │
│    → broadcast new state to all UIs                 │
│    → execute each effect                            │
└─────────────────────────────────────────────────────┘
```

**Android (standalone — no server):**
```
┌─────────────────────────────────────────────────────┐
│ Android WebView (standalone.ts)                     │
│  App.tsx → useAio() ──direct──→ dispatch loop        │
│  dispatch(action)                                   │
│    → reduce(state, action) → { state, effects }     │
│    → persist to localStorage                        │
│    → notify React listeners                         │
│    → execute each effect                            │
└─────────────────────────────────────────────────────┘
```

Same `src/` code runs in both modes. The `'aio'` import resolves to `browser.ts` (desktop) or `standalone.ts` (Android) at build time.

### Data flow

1. User clicks button → `send(A.increment())` → WebSocket → server
2. Action is validated (must have `type: string`) and queued
3. Server calls `reduce(state, action)` → returns new state + effects array
4. Effects execute — may dispatch follow-up actions (queued, not re-entrant)
5. After all queued actions drain: state persisted to Deno.Kv (debounced) and broadcast to all UIs
6. UI receives new state → React re-renders

**Error handling:** If `reduce()` throws, the error is logged and that action is skipped — the server continues running. **Important:** state remains unchanged when a reducer throws. The failed action has no effect on state, and subsequent actions process normally. Effects that throw are also caught and logged individually.

### What AIO handles automatically

- HTML generation with React (CDN in dev, bundled in prod)
- CSS injection — auto-detects `src/style.css` and adds `<link>` tag
- JSX compilation (no `import React` needed)
- App.tsx mounting (no `createRoot` needed)
- WebSocket connection + auto-reconnect with exponential backoff
- Delta state broadcasting — only changed top-level keys are sent (patches for small changes, full state for large ones)
- Live reload — file changes in `baseDir` trigger automatic browser refresh
- Error overlay — transpile errors shown on page instead of blank screen
- State persistence to Deno.Kv with deep merge on restart
- Electron window launch (with configurable lifecycle)
- Startup validation (including `deno approve-scripts` detection)
- CLI argument parsing

## Project layouts

aio ships 4 project templates (`sh init.sh my-app`). Pick the one that matches your app's complexity. **AI coding agents: use these layouts as-is — don't invent custom folder structures.**

### Empty — 2 files

Everything inline. For throwaway experiments and one-screen tools.

```
src/
  app.ts            ← entry + inline state/reduce/execute
  App.tsx           ← React UI
```

### Minimal — 7 files

Standard aio structure. Counter app. **This is the default for most apps.**

```
src/
  app.ts            ← entry point, wires state/reduce/execute
  state.ts          ← AppState type + initialState
  actions.ts        ← action catalog (A.Increment, A.Decrement, ...)
  effects.ts        ← effect catalog (E.Log, ...)
  reduce.ts         ← (state, action) → { state, effects }
  execute.ts        ← runs effects
  App.tsx           ← React UI
```

### Medium — feature folders + UI components

When you have 2+ features and reusable UI. Feature reducers get their own folder, UI components get `ui/`.

```
src/
  app.ts
  state.ts          ← imports feature types
  actions.ts
  effects.ts
  reduce.ts         ← router: delegates to feature reducers
  execute.ts
  App.tsx
  features/
    todo/
      todo-types.ts     ← TodoItem, TodoState
      todo-reduce.ts    ← feature reducer
  ui/
    TodoList.tsx
    AddTodo.tsx
```

### Large — models + features + UI hierarchy

Full architecture. Models hold pure types + functions. Features hold reducers. UI is grouped by domain.

```
src/
  app.ts
  state.ts          ← imports from model/ types
  actions.ts
  effects.ts
  reduce.ts         ← thin router → feature reducers
  execute.ts        ← thin router → feature effects
  App.tsx
  model/
    todo/
      todo-types.ts     ← types only (TodoItem, TodoState)
      todo-fn.ts        ← pure functions (createTodo, countRemaining)
    user/
      user-types.ts     ← types only (UserState)
  features/
    todo/
      todo-reduce.ts    ← feature reducer, imports model types + fns
    user/
      user-reduce.ts
  ui/
    layout/
      Header.tsx
    todo/
      TodoList.tsx
      AddTodo.tsx
    user/
      Settings.tsx
```

### When to use which

| Template | Files | Use when |
|----------|-------|----------|
| Empty | 2 | Quick experiment, single-screen tool |
| Minimal | 7 | Most apps — up to ~10 actions |
| Medium | 10+ | Multiple features, shared UI components |
| Large | 19+ | Complex domains, pure model logic, team conventions |

Start with **Minimal**. Move to **Medium** when your `reduce.ts` switch has 10+ cases. Move to **Large** when you have multiple domains with shared logic.

### Naming conventions

- Feature types: `<feature>-types.ts` (types only, no logic)
- Feature pure functions: `<feature>-fn.ts` (no imports from framework)
- Feature reducers: `<feature>-reduce.ts`
- Feature effects: `<feature>-effect.ts` (if split from main execute.ts)
- Top-level `reduce.ts` and `execute.ts` are thin routers — delegate to features

## The `'aio'` import

Everything comes from a single import. In **deno.json**, `"aio"` maps to `./dep/aio/mod.ts`. In the **browser**, it maps to `/__aio/ui.js` (a virtual route). Same import, different runtimes.

### Vendored by design

aio lives inside your project at `dep/aio/` — not in a registry, not behind a package manager. This is intentional:

- **Readable** — the entire framework is right there in your project. Open any file, read the source, understand what's happening
- **Hackable** — need a custom column type? A different reconnect strategy? A tweak to delta broadcasting? Edit the file directly. No forking repos, no publishing patches, no waiting for upstream
- **Portable** — `deno compile` bundles everything. No fetching packages at build time, no registry outages, no version resolution surprises
- **Simple** — one `dep/aio/` folder, one `"aio": "./dep/aio/mod.ts"` import map entry. No lockfiles, no transitive dependency trees, no `node_modules`

To update aio, replace the `dep/aio/` folder with the new version and check the [upgrade guide](upgrade.md). Your edits (if any) show up as a clean git diff.

```ts
// Server-side (Deno) — full API
import { aio, VERSION, actions, effects, draft, type UnionOf, type AioApp, type AioConfig } from 'aio'

// Browser-side (App.tsx) — hooks + helpers
import { useAio, useLocal, page, msg } from 'aio'
```

Never import from `'../dep/aio/...'` directly — always use `'aio'`. The startup linter will warn you if you forget.

## `aio.run(initialState, config)`

The single entry point. Boots everything, runs forever.

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

### Return value

```ts
const app = await aio.run(state, config)
app.dispatch(action)    // programmatic dispatch (timers, external events)
app.getState()          // read current state
app.snapshot()          // export state as JSON string
app.loadSnapshot(json)  // import state from JSON, broadcast to all clients
app.mode                // undefined (desktop) or 'standalone' (Android)
await app.close()       // graceful shutdown — flush KV, close KV handle, stop HTTP server
```

`close()` flushes any pending state to Deno.Kv before shutting down, so no data is lost. Signal handlers (SIGINT/SIGTERM) and Electron close also flush automatically — `close()` is for programmatic shutdown in tests or custom lifecycle management.

Use `app.mode` to branch effects that use Deno-specific APIs:
```ts
// execute.ts
case E.SAVE_FILE:
  if (app.mode === 'standalone') {
    console.log('file save not available on Android')
  } else {
    Deno.writeTextFile(effect.payload.path, effect.payload.data)
  }
  break
```

### Config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `reduce` | `(state, action) => { state, effects }` | **required** | Pure state machine — takes state + action, returns new state + effects |
| `execute` | `(app, effect) => void` | **required** | Side effect handler — API calls, timers, logging |
| `persist` | `boolean` | `true` | Auto-persist state to Deno.Kv |
| `persistKey` | `string` | `"state"` | Key used in Deno.Kv |
| `persistDebounce` | `number` | `100` | Milliseconds between KV writes |
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
| `users` | `Record<string, AioUser>` | — | Per-user token auth map (see [Multi-user auth](#multi-user-auth)) |
| `schedules` | `ScheduleDef[]` | — | Config-level scheduled effects (see [Scheduled effects](#scheduled-effects)) |
| `db` | `Record<string, TableDef>` | — | SQLite table definitions — arrays auto-sync (see [SQLite persistence](#sqlite-persistence)) |
| `beforeReduce` | `(action, state) => action \| null` | — | Intercept actions before reduce — return modified action or `null` to drop |
| `deltaThreshold` | `number` | `0.5` | Ratio (0–1) of changed keys that triggers full broadcast instead of delta patch |
| `maxConnections` | `number` | `100` | Maximum concurrent WebSocket clients (503 beyond this) |
| `perfMode` | `'strict' \| 'soft'` | `'strict'` | How to report performance violations — strict calls `onError`, soft only warns |
| `perfBudget` | `{ reduce?, effect? }` | `{ reduce: 100, effect: 5 }` | Performance budgets in milliseconds |
| `effectTimeout` | `number` | `30000` | Warning timeout for async effects (ms) — logs if effect takes longer |
| `freezeState` | `boolean` | `true` (dev), `false` (prod) | Deep freeze state after reduce to catch mutations |

## `composeMiddleware(...fns)`

Compose multiple `beforeReduce` functions into one. Functions run in order; return `null` to drop an action.

```ts
import { composeMiddleware } from 'aio'

const validate = (action, state) => {
  if (action.type === 'DeleteUser' && !state.isAdmin) return null
  return action
}

const enrich = (action, state) => ({
  ...action,
  payload: { ...action.payload, timestamp: Date.now() }
})

await aio.run(initialState, {
  reduce,
  execute,
  beforeReduce: composeMiddleware(validate, enrich),
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

Multiple input selectors supported (up to 5). Result function only runs when inputs change.

## `deepFreeze(state)`

Deep freezes an object for dev-mode immutability checking. Called automatically when `freezeState: true`.

```ts
import { deepFreeze } from 'aio'

const frozen = deepFreeze({ a: 1, b: { c: 2 } })
frozen.a = 2  // TypeError in dev mode
```

## `actions()` / `effects()`

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

## `draft(state, fn)`

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

## `useAio<S>()`

React hook — connects to the server via WebSocket, syncs state, provides `send`.

```tsx
import { useAio } from 'aio'
import type { AppState } from './state.ts'

export default function App() {
  const { state, send } = useAio<AppState>()

  // state is null until first message arrives
  if (!state) return <div>Connecting...</div>

  // send() takes any { type, payload } — use action creators for type safety
  return <button onClick={() => send(A.increment())}>+</button>
}
```

**Details:**
- `state: S | null` — `null` until WebSocket connects and server sends initial state
- `send(action)` — sends action to server via WebSocket. Actions sent before the initial connect are queued and flushed. Actions sent while disconnected are **dropped** — a "Reconnecting…" indicator tells the user why
- **Singleton** — all `useAio()` calls share a single WebSocket connection per page. Call it from any component — no prop drilling, no duplicate connections
- Auto-reconnects on disconnect with exponential backoff (1s → 2s → 4s → 8s base max, ±20% jitter). If the server restarted, reconnect triggers a page reload to pick up fresh code
- Connection is cleaned up when the last connected component unmounts
- Generic `<S>` types the state — use your `AppState` type

**No boilerplate needed in App.tsx:**
- No `import React` — JSX transforms are automatic
- No `createRoot` — the framework mounts your default export
- No WebSocket setup — `useAio` handles it
- Just `export default function App()` and you're done

## `useLocal<T>(initial)`

Client-only state hook — not synced to server, not persisted. For ephemeral UI concerns like "which item am I editing", form inputs, dropdown open/closed.

```tsx
import { useAio, useLocal } from 'aio'

export default function App() {
  const { state, send } = useAio<AppState>()
  const { local, set } = useLocal({ editing: null as string | null })

  if (!state) return <div>Connecting...</div>

  return (
    <ul>
      {state.todos.map(t => (
        <li key={t.id} onClick={() => set({ editing: t.id })}>
          {local.editing === t.id ? <input /> : t.text}
        </li>
      ))}
    </ul>
  )
}
```

`useLocal` is just a typed `useState` wrapper with a consistent API. Use it when state doesn't need to survive page reload or be shared across tabs.

## `page(current, routes)`

Renders the component matching a page key from state. Simple state-based routing with no URL sync needed.

```tsx
import { useAio, page } from 'aio'
import { Home } from './pages/Home.tsx'
import { Settings } from './pages/Settings.tsx'

export default function App() {
  const { state, send } = useAio<AppState>()
  if (!state) return <div>Connecting...</div>

  return (
    <div>
      <nav>
        <button onClick={() => send(A.navigate('home'))}>Home</button>
        <button onClick={() => send(A.navigate('settings'))}>Settings</button>
      </nav>
      {page(state.page, { home: Home, settings: Settings })}
    </div>
  )
}
```

Returns `null` if no route matches. Page components call `useAio()` internally if they need state — since it's a singleton, each page component gets the same shared connection.

## State persistence

By default, AIO auto-persists your entire state to Deno.Kv. On restart, persisted state is **deep-merged** with `initialState`:

```ts
// On first run:  state = initialState
// On restart:    state = deepMerge(initialState, persisted)
```

This means:
- New fields added to `initialState` appear automatically (at any nesting depth)
- Existing persisted values are restored
- Keys removed from `initialState` are dropped (schema wins)
- Arrays are replaced wholesale (not merged element-by-element)
- Type mismatches (e.g. persisted `null` where initial has an object) fall back to initial

Example: if `initialState` has `{ user: { name: "", age: 0 } }` and persisted has `{ user: { name: "Bob" } }`, the restored `user` will be `{ name: "Bob", age: 0 }` — the new `age` field is preserved.

### Filtering persisted state

Use `getDBState` to exclude transient data:

```ts
await aio.run(initialState, {
  reduce,
  execute,
  getDBState: (s) => ({ counter: s.counter }),  // only persist counter, not UI state
})
```

### Disabling persistence

```ts
await aio.run(initialState, {
  reduce,
  execute,
  persist: false,  // state resets on every restart
})
```

## SQLite persistence

For structured data (orders, products, users), aio supports SQLite alongside Deno.Kv. KV handles scalar UI state (page, flags, counters). SQLite handles arrays of records — queryable, indexed, relational. Three levels of access:

### Table definition

Define tables with column helpers in your `aio.run()` config:

```ts
import { aio, table, pk, text, real, integer, ref } from 'aio'

type Order = { id: number; customer: string; total: number; userId: number }
type User = { id: number; name: string; email: string }

type AppState = {
  page: string          // → KV (UI state)
  selectedId: number    // → KV (UI state)
  users: User[]         // → SQLite
  orders: Order[]       // → SQLite
}

await aio.run(initialState, {
  reduce, execute,
  db: {
    users: table({
      id:    pk(),
      name:  text(),
      email: text({ unique: true }),
    }),
    orders: table({
      id:       pk(),
      customer: text(),
      total:    real({ default: 0 }),
      userId:   ref('users'),
    }),
  },
})
```

Column helpers:

| Helper | SQL | Notes |
|--------|-----|-------|
| `pk()` | `INTEGER PRIMARY KEY` | One per table, user-assigned (not autoincrement) |
| `text(opts?)` | `TEXT NOT NULL` | `{ nullable, unique, default }` |
| `integer(opts?)` | `INTEGER NOT NULL` | Same opts |
| `real(opts?)` | `REAL NOT NULL` | Same opts |
| `ref(table, opts?)` | `INTEGER REFERENCES table(id)` | Foreign key |

### Level 1 — Auto-sync (zero SQL)

Reducer mutates arrays as normal. Framework syncs to SQLite automatically:

```ts
case A.AddOrder:
  d.orders.push({ id: d.nextId++, customer: action.payload.customer, total: 0, userId: action.payload.userId })
  return []
case A.RemoveOrder:
  d.orders = d.orders.filter(o => o.id !== action.payload.id)
  return []
```

On startup, SQLite data populates state arrays. After each reduce, changed arrays sync back. Reference equality (`!==`) determines which tables need writing — Immer guarantees new refs on mutation.

### Level 2 — ORM methods (typed CRUD)

For effects that need direct data access. Available on `app.db!.<tableName>`:

```ts
case E.LoadExpensiveOrders:
  const expensive = app.db!.orders.where({ total: { gt: 1000 } })
  app.dispatch(A.ordersFiltered(expensive))
  break
```

Methods:

| Method | Returns | Description |
|--------|---------|-------------|
| `.all()` | `T[]` | All rows |
| `.find(id)` | `T \| undefined` | By primary key |
| `.where(filter)` | `T[]` | Filtered rows |
| `.insert(row)` | `{ lastInsertRowId }` | Insert one |
| `.insertMany(rows)` | `void` | Insert many (transaction) |
| `.update(where, set)` | `{ changes }` | Update matching |
| `.delete(where)` | `{ changes }` | Delete matching |
| `.count(where?)` | `number` | Count rows |

Where filter supports equality (`{ field: value }`) and operators: `{ field: { gt, gte, lt, lte, ne, like, in } }`.

**Note**: Level 2 methods write directly to SQLite, bypassing the reducer. Use for effects like batch imports or external data loading — not for normal user-driven state changes.

### Level 3 — Raw SQL

For aggregation, joins, complex queries:

```ts
case E.RevenueReport:
  const stats = app.db!.query<{ customer: string; revenue: number }>(
    'SELECT customer, SUM(total) as revenue FROM orders GROUP BY customer'
  )
  app.dispatch(A.reportLoaded(stats))
  break
```

Raw methods:

| Method | Returns | Description |
|--------|---------|-------------|
| `.query<T>(sql, params?)` | `T[]` | SELECT rows |
| `.get<T>(sql, params?)` | `T \| undefined` | Single row |
| `.run(sql, params?)` | `{ changes, lastInsertRowId }` | INSERT/UPDATE/DELETE |
| `.exec(sql)` | `void` | DDL statements |
| `.transaction(fn)` | `R` | Wraps `fn(db)` in BEGIN/COMMIT (ROLLBACK on error) |

### How it works

- **Startup**: Opens SQLite at `./data.db` (dev) or `~/.local/share/<app>/data.db` (compiled). Creates tables with `IF NOT EXISTS`. Loads rows into state arrays
- **After reduce**: Changed arrays sync to SQLite (debounced, same timer as KV). Unchanged arrays (same ref) are skipped
- **Incremental sync**: Tables with primary keys use row-level INSERT/UPDATE/DELETE for efficiency. Tables without PK fall back to full table replacement
- **KV stripping**: Arrays managed by `db:` are auto-excluded from KV persistence — no double-storing
- **Shutdown**: Pending sync flushed, SQLite closed, then KV closed
- **WAL mode + foreign keys**: Enabled by default for performance and referential integrity
- **No migrations**: `CREATE TABLE IF NOT EXISTS` handles setup. Use `app.db!.exec('ALTER TABLE ...')` in `onStart` for schema changes
- **Standalone/Android**: `app.db` is `undefined` — SQLite is server-only

### Incremental sync

For tables with a primary key (`pk()`), SQLite sync uses row-level diffs instead of full table replacement. This is significantly faster for large datasets.

```ts
// With PK — incremental updates
db: {
  users: table({
    id: pk(),      // ← Primary key enables incremental sync
    name: text(),
  }),
}

// Without PK — full table replacement (slower for large tables)
db: {
  logs: table({
    ts: integer(),
    message: text(),
  }),
}
```

When you have a PK:
- **INSERT**: New rows (not in DB) are inserted
- **UPDATE**: Changed rows (same PK, different data) are updated
- **DELETE**: Removed rows (in DB, not in state) are deleted
- **UNCHANGED**: Skipped entirely

## Offline queue

When the WebSocket disconnects (network issues, server restart), actions are persisted to IndexedDB and replayed on reconnect.

**How it works:**
1. First connect: Actions queue in memory (max 100) until WS ready
2. After first connect: All subsequent disconnections persist actions to IndexedDB
3. On reconnect: Queued actions replay in order
4. Actions older than 24 hours are discarded before replay

**No configuration needed** — works automatically. The 24-hour `maxAge` prevents stale actions from accumulating indefinitely.

If you need custom behavior, handle it in your reducer (idempotency, conflict resolution).

## Redux DevTools integration

Connect to the Redux DevTools browser extension for state inspection and action history.

```tsx
// In App.tsx
import { useAio, connectDevTools } from 'aio'

export default function App() {
  const { state, send } = useAio<AppState>()

  // Connect to DevTools in development
  useEffect(() => {
    if (import.meta.env.DEV) {
      connectDevTools()
    }
  }, [])

  // ... rest of component
}
```

**What you see:**
- State tree in DevTools inspector
- Action history with type and payload
- State diffs on each action

**Limitations:**
- Time-travel via DevTools is not supported (use `Ctrl+.` panel instead)
- DevTools must be installed and enabled in browser

## UI state filtering

Use `getUIState` to control what the browser sees. Useful for stripping server-only data:

```ts
await aio.run(initialState, {
  reduce,
  execute,
  getUIState: (s) => ({
    counter: s.counter,
    username: s.username,
    // s.apiKey is NOT sent to the browser
  }),
})
```

When `getUIState` is set, `useAio<T>()` should use the filtered shape as its generic, not the full `AppState`.

### Per-user getUIState

`getUIState` accepts an optional `user` — an `AioUser` object resolved from the client's auth token. Useful for role-based state filtering:

```ts
await aio.run(initialState, {
  reduce, execute,
  users: {
    'alice-token': { id: 'alice', role: 'admin' },
    'bob-token':   { id: 'bob',   role: 'viewer' },
  },
  getUIState: (state, user?) => {
    if (user?.role === 'admin') return state  // admins see everything
    return { items: state.items.filter(i => i.ownerId === user?.id) }
  },
})
```

**How it works:**
1. Each WebSocket connection resolves an `AioUser` from its auth token
2. On every broadcast, `getUIState(state, user?)` is called per client
3. Delta patches are computed per client — each client has its own delta cache
4. `user` is `undefined` in public mode (no `users` config)

**Backwards compatible:** If your `getUIState` doesn't use `user`, all clients get the same state.

## Styling

AIO auto-detects `src/style.css` and injects it into the HTML `<head>` automatically. No manual `<link>` tag needed.

**Option 1: `src/style.css`** (recommended) — create the file, it's auto-injected:
```css
/* src/style.css */
body { font-family: system-ui; margin: 0; }
.app { padding: 2rem; }
button { padding: 0.5rem 1rem; }
```
Use `@import` inside `style.css` to split into multiple files. Changes trigger CSS hot reload in dev mode. Automatically copied to `dist/` during builds.

**Option 2: Inline styles** — simplest, no extra files:
```tsx
<button style={{ padding: '0.5rem', fontSize: '1rem' }}>Click</button>
```

**Option 3: CDN CSS frameworks** — add `<link>` in App.tsx:
```tsx
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/water.css@2/out/water.css" />
```

**Note:** `import './style.css'` in TypeScript does **not** work — esbuild transpiles TS/TSX only.

## Components

Split your UI into multiple files — just import them normally. All `.tsx` files in `src/` are auto-transpiled.

```
src/
  App.tsx              ← entry (export default)
  components/
    Header.tsx
    Sidebar.tsx
```

```tsx
// src/App.tsx
import { useAio } from 'aio'
import { Header } from './components/Header.tsx'

export default function App() {
  const { state, send } = useAio<AppState>()
  if (!state) return <div>Connecting...</div>
  return <Header title={state.title} />
}
```

```tsx
// src/components/Header.tsx — no useAio needed, just props
export function Header({ title }: { title: string }) {
  return <h1>{title}</h1>
}
```

**Guidelines:**
- `useAio()` is a singleton — call it from any component that needs state. No prop-drilling needed
- Sub-components can either take props (pure view) or call `useAio()` directly (connected)
- Use `useLocal()` for ephemeral UI state (editing flags, input focus, dropdowns) — not app data

## Electron

Electron is on by default. AIO looks for (in order):
1. `$ELECTRON_PATH` env var — custom path (used by AppImage)
2. `dist/linux-unpacked/aio-ui-electron` — packaged binary (electron-builder)
3. `node_modules/.bin/electron` — dev binary

Install for dev:
```sh
deno install npm:electron
deno approve-scripts    # required — Deno needs permission for electron's postinstall
deno install            # re-run to complete electron setup
```

The startup linter will warn you if electron is installed but `dist/` is missing (scripts not approved).

Disable Electron (browser-only mode):

```ts
await aio.run(initialState, {
  reduce,
  execute,
  ui: { electron: false },  // auto-opens browser instead
})
```

Keep server running after Electron closes:

```ts
await aio.run(initialState, {
  reduce,
  execute,
  ui: { keepAlive: true },  // server survives electron window close
})
```

Or use `--keep-alive` CLI flag. Useful for apps where the server is the primary process and electron is optional.

The HTTP server always runs regardless of Electron — you can access the app at `localhost:8000` in any browser, and multiple tabs stay in sync.

**Window state persistence:** Electron remembers window size and position across runs. Bounds are saved to `window-state.json` in the app's `userData` directory. The directory is derived from the slugified title (e.g. "My Dashboard" → `my-dashboard`), ensuring each app gets its own persistent state.

## CLI flags

`aio.run()` reads `Deno.args` automatically — no parsing code needed in your app. CLI flags override config values:

```sh
deno task dev --port=3000 --no-electron --no-persist --title="My App"
```

| Flag | Effect |
|------|--------|
| `--port=N` | Override server port |
| `--no-electron` | Skip Electron, open browser instead |
| `--no-persist` | Disable Deno.Kv state persistence |
| `--keep-alive` | Keep server running after Electron window closes |
| `--title=X` | Override window/page title |
| `--verbose` | Verbose logging — actions, state, effects, WS, HTTP, persistence |
| `--prod` | Force prod mode — serve pre-built `dist/app.js` (auto-detected in compiled binaries) |
| `--width=N` | Override Electron window width (default: 800) |
| `--height=N` | Override Electron window height (default: 600) |
| `--expose` | Bind `0.0.0.0` with auth token — share app with other devices on LAN |
| `--headless` | Server-only — no browser or Electron (for CLI apps using `connectCli()`) |
| `--url=URL` | Thin client mode — launch Electron connecting to remote aio server (no local server) |
| `--version` | Print aio version and exit |
| `--help` | Show available CLI flags and exit |

**Precedence:** CLI flags > config object > defaults

Active flags are logged on startup:
```
[12:00:00][INFO] ✓ state (1 keys) · reduce · execute · App.tsx
[12:00:00][INFO] cli: --port=3000 --no-electron
[12:00:00][INFO] running at http://localhost:3000 (dev, browser)
```

### Verbose mode

`--verbose` logs the entire pipeline in real time:

```
[12:00:00][DEBUG] config: port=8000 persist=true electron=false title="My App" baseDir=./src
[12:00:00][DEBUG] persist: loaded from KV key="state"
[12:00:00][DEBUG] state: 1 keys
[12:00:01][DEBUG] http: GET /
[12:00:01][DEBUG] http: GET /App.tsx
[12:00:01][DEBUG] http: GET /__aio/ui.js
[12:00:01][DEBUG] ws: connect (1 total)
[12:00:02][DEBUG] ws: recv {"type":"INCREMENT","payload":{"by":1}}
[12:00:02][DEBUG] action → reduce: INCREMENT {"by":1}
[12:00:02][DEBUG] state: changed [counter]
[12:00:02][DEBUG] persist: saved
[12:00:02][DEBUG] effect → execute: LOG {"message":"incremented by 1 to 6"}
[12:00:02][DEBUG] broadcast → 1 client(s)
[12:00:03][DEBUG] ws: disconnect (0 total)
```

## Startup linter

When `aio.run()` starts, it checks your app and reports issues:

**Clean startup:**
```
[12:00:00][INFO] ✓ state (1 keys) · reduce · execute · App.tsx
[12:00:00][INFO] running at http://localhost:8000
```

**Issues found:**
```
[12:00:00][INFO] ── checks ──
[12:00:00][INFO]   ✓ state (1 keys) · reduce · execute
[12:00:00][WARNING] App.tsx has no `export default` — add it so the framework can mount your component
[12:00:00][INFO]   · App.tsx has `import React` — not needed, JSX transforms are automatic
```

**What it checks:**
- `✗` **Errors** (prevents startup): state is null/not object, reduce/execute missing, App.tsx missing
- `⚠` **Warnings** (app starts but may not work): App.tsx has no default export, esbuild not installed, sync I/O in execute.ts
- `·` **Hints** (suggestions): leftover `createRoot`, `import React`, old `'../dep/aio/'` imports, electron missing `deno approve-scripts`

**Sync I/O warnings:**
The linter detects blocking operations in `execute.ts`:
- `Deno.readTextFileSync`, `Deno.writeTextFileSync`, `Deno.readDirSync`, `Deno.statSync` → warn to use async versions
- These operations block the dispatch loop and make the UI unresponsive

```
[WARNING] execute.ts: sync I/O (readTextFileSync) blocks the dispatch loop — use async versions (readTextFile) instead
```

## Live reload

AIO watches `baseDir` (default: `src/`) for file changes. When any `.ts`, `.tsx`, `.css`, or other file is modified or created, all connected browsers automatically reload.

```
[12:00:05][DEBUG] watch: changed /home/dev/code/gen/my-app/src/App.tsx
[12:00:05][DEBUG] reload → 2 client(s)
```

**How it works:**
1. `Deno.watchFs` monitors `baseDir` recursively
2. On file change, the transpile cache for that file is invalidated
3. After a 100ms debounce (to batch rapid saves), a `__reload` signal is sent over WebSocket
4. Browser receives the signal and calls `location.reload()`
5. Fresh page loads, `useAio()` reconnects, server sends current state

**No state is lost** — state lives on the server, so reloading the browser is free. The UI picks up exactly where it left off.

### Server restart detection

When the server restarts (crash, manual restart, `am restart`), existing browser tabs auto-reconnect via WebSocket. The server sends a boot ID on each WS connect — if the browser detects a different boot ID on reconnect, it triggers `location.reload()` to pick up fresh JS. No stale code in memory after restarts.

Additionally, browser open is delayed 1.5s on startup. If an existing tab reconnects within that window (common on fast restarts), no duplicate tab is opened.

### CSS hot reload

CSS changes are handled specially — instead of a full page reload, the browser injects the updated stylesheet without losing React state.

**How it works:**
1. File watcher detects a change
2. If only `.css` files changed in the debounce window, server sends `__css` signal (not `__reload`)
3. Browser finds the `<link>` tag for `style.css` and cache-busts it with `?t=<timestamp>`
4. Browser downloads the new CSS — no React unmount/remount, no state loss

If a CSS file and a TS/TSX file change in the same debounce window, a full `__reload` is sent instead (since the JS needs reloading anyway).

## Remote access (`--expose`)

By default, the server binds to `127.0.0.1` (localhost only). Use `--expose` to share with other devices on your local network:

```sh
deno task dev --expose
```

**What happens:**
1. Server binds to `0.0.0.0` (all network interfaces)
2. A random access token is generated and printed to the console
3. All HTTP and WebSocket requests require the token

```
[12:00:00][WARNING] --expose: server bound to 0.0.0.0 — accessible from network
[12:00:00][INFO] share: http://localhost:8000?token=a1b2c3d4-...
```

Share the URL with the token. The token is passed via `?token=` query parameter or `Authorization: Bearer` header. WebSocket connections also pass the token via query param — the browser client handles this automatically.

**Security notes:**
- Token auth is not production-grade — it's for local network sharing (demos, testing on phones, etc.)
- Origin validation is skipped when exposed (the token replaces it)
- The token is a `crypto.randomUUID()` — regenerated on each restart

## Multi-user auth

Three auth modes:

1. **Public** (default) — no auth, all clients are anonymous
2. **Single token** (`--expose`) — auto-generated UUID, all users are anonymous but verified
3. **Per-user tokens** (`users` config) — static token → user mapping with identity

### Per-user tokens

```ts
import type { AioUser } from 'aio'

const users: Record<string, AioUser> = {
  'alice-secret-123': { id: 'alice', role: 'admin' },
  'bob-secret-456':   { id: 'bob',   role: 'viewer' },
}

await aio.run(initialState, {
  reduce, execute,
  users,
  getUIState: (state, user?) => {
    if (user?.role === 'admin') return state
    return { publicData: state.publicData }
  },
})
```

**Token flow:**
- Browser: append `?token=alice-secret-123` to URL
- Or use `Authorization: Bearer alice-secret-123` header
- Token verified via timing-safe comparison (prevents timing attacks)
- Resolved `AioUser` available in hooks (`onAction`, `onEffect`, `onConnect`, `onDisconnect`)
- WebSocket connections without valid token are rejected with 401

**Startup log** (with `users`):
```
[12:00:00][INFO] share (alice/admin): http://0.0.0.0:8000?token=alice-secret-123
[12:00:00][INFO] share (bob/viewer): http://0.0.0.0:8000?token=bob-secret-456
```

### `AioUser` type

```ts
type AioUser = { id: string; role: string }
```

## Thin client (`--url`)

Connect to a remote aio server without running a local server:

```sh
deno task dev --url=http://192.168.1.100:8000
```

**What happens:**
1. No local HTTP server starts
2. Electron launches with a connect page (or directly navigates if `--url` is provided)
3. Fetches the remote server's HTML to extract metadata (`<title>`, `<meta aio:width>`, `<meta aio:height>`)
4. Tries to fetch `/icon.png` from the server for the window icon
5. Resizes window to the server's configured dimensions, sets title
6. Loads the remote URL — app runs as if it were local

**aio-client** — standalone Electron app with a connect page:

```sh
deno task compile:electron:remote   # builds aio-client AppImage
```

The client app shows a minimal connect page where users type a server address and hit Enter. No Deno runtime needed on the client machine — just a pure Electron app.

### Window metadata

The server embeds window config in HTML `<meta>` tags (set via `ui: { width, height }`):

```html
<meta name="aio:width" content="1200">
<meta name="aio:height" content="900">
```

The thin client reads these to auto-configure the Electron window. The `<title>` tag is used for the window title.

### Window state persistence

Electron windows remember their size and position across runs. Bounds are saved to `window-state.json` in Electron's `userData` directory (derived from `app.name`, which is the slugified title). On next launch, saved bounds are restored, falling back to the server's configured defaults.

## State snapshots

Export and import state for debugging, backup, or state transfer. **Server-only** — `snapshot()` and `loadSnapshot()` are `undefined` in standalone/Android mode.

```ts
const app = await aio.run(initialState, { reduce, execute })

// Export current state
const json = app.snapshot!()           // returns JSON string
console.log(json)

// Import state
app.loadSnapshot!('{"counter": 42}')   // replaces state, broadcasts to all clients
```

### HTTP endpoints

```sh
# Export
curl http://localhost:8000/__snapshot          # GET → JSON state

# Import (X-AIO header required for CSRF protection)
curl -X POST http://localhost:8000/__snapshot \
  -H 'Content-Type: application/json' \
  -H 'X-AIO: 1' \
  -d '{"counter": 42}'                        # replaces state
```

`loadSnapshot` triggers persistence (debounced KV write), broadcasts the new state to all connected clients, and records a `__snapshot` entry in the time-travel history (dev mode).

## Scheduled effects

Declarative timers, intervals, and cron jobs — returned as effects from the reducer or configured at startup.

### Config-level schedules

Always-on schedules defined in `aio.run()`:

```ts
import { schedule } from 'aio'

await aio.run(initialState, {
  reduce, execute,
  schedules: [
    { id: 'tick', every: 5000, action: { type: 'Tick', payload: {} } },
    { id: 'cleanup', cron: '0 3 * * *', action: { type: 'Cleanup', payload: {} } },
  ],
})
```

### Dynamic schedules (from reducer)

Return schedule effects from `reduce()` — they're intercepted by the framework:

```ts
import { schedule } from 'aio'

// In reduce.ts
case A.StartTimer:
  return { state, effects: [schedule.every('heartbeat', 1000, A.tick())] }

case A.StopTimer:
  return { state, effects: [schedule.cancel('heartbeat')] }
```

### Schedule API

| Function | Description |
|----------|-------------|
| `schedule.after(id, ms, action)` | One-shot delay — fires once after `ms` milliseconds |
| `schedule.every(id, ms, action)` | Repeating interval — fires every `ms` milliseconds |
| `schedule.at(id, isoTimestamp, action)` | One-shot at specific time (ISO 8601 string) |
| `schedule.cron(id, pattern, action)` | Cron schedule (5-field: `minute hour dom month dow`) |
| `schedule.cancel(id)` | Cancel any active schedule by ID |

**Cron patterns:**
- `* * * * *` — every minute
- `*/5 * * * *` — every 5 minutes
- `0 9 * * 1` — 9 AM every Monday
- `0,30 * * * *` — every 30 minutes
- `0 0 1 * *` — midnight on the 1st of each month

**Behavior:**
- Re-scheduling the same `id` replaces the previous schedule
- `schedule.after` auto-removes after firing
- `schedule.at` with a past timestamp fires immediately
- All schedules are cancelled on `app.close()`
- **Far-future scheduling:** For delays exceeding JavaScript's `setTimeout` limit (~24.8 days), the framework re-checks every 24 hours until the target time. This handles long-running processes like annual maintenance tasks.

## Error overlay

When a `.ts` or `.tsx` file has a syntax error, AIO shows the error directly on the page instead of a blank white screen.

**What you see in the browser:**
```
┌──────────────────────────────────────────────┐
│ Build Error                                   │
│                                               │
│ App.tsx: Error: Transform failed with 1 error │
│ <stdin>:5:0: ERROR: Unexpected "}"            │
└──────────────────────────────────────────────┘
```

**How it works:**
1. esbuild transpile fails → error stored server-side
2. The module returns `throw new Error(...)` so the bootstrap `import()` catches it
3. Bootstrap fetches the full error from `/__aio/error` and renders it on page
4. A WebSocket listener stays active on the error page for live reload
5. Fix the file → save → live reload triggers → page shows working app again

**The fix-save-reload cycle:**
1. You have a syntax error → error overlay appears
2. You fix the error in your editor and save
3. File watcher detects the change → sends `__reload`
4. Browser reloads → transpile succeeds → app renders normally

No manual refresh needed. Just fix and save.

## Building & compiling

Build targets follow `compile:<shell>:<topology>` — two axes: **shell** (what renders the UI) × **topology** (local or remote).

- **Local** (default) — self-contained binary, 127.0.0.1 or client-locked
- **Remote** — exposed server (0.0.0.0 + auth) or client-only binary

```
                    local (default)              remote
┌────────────┬─────────────────────────┬──────────────────────────┐
│ browser    │ compile:browser         │ compile:browser:remote   │
│            │ binary + system browser │ exposed server + systemd │
├────────────┼─────────────────────────┼──────────────────────────┤
│ electron   │ compile:electron        │ compile:electron:remote  │
│            │ AppImage, server inside │ client AppImage, no Deno │
├────────────┼─────────────────────────┼──────────────────────────┤
│ cli        │ compile:cli             │ compile:cli:remote       │
│            │ binary + WS client API  │ client binary, no server │
├────────────┼─────────────────────────┼──────────────────────────┤
│ android    │ compile:android         │ compile:android:remote   │
│            │ APK, server inside      │ client APK, no Deno      │
├────────────┼─────────────────────────┼──────────────────────────┤
│ service    │ compile:service         │ compile:service:remote   │
│            │ headless, 127.0.0.1     │ headless, 0.0.0.0 + auth │
└────────────┴─────────────────────────┴──────────────────────────┘

Aliases: compile = compile:browser
```

**v0.2:** all 10 targets implemented

### Dev mode

```sh
deno task dev
```

Live-transpiles `.ts`/`.tsx` via esbuild on each request. React loaded from CDN via import map. File watcher auto-reloads the browser on save. Error overlay shows transpile errors. Opens Electron or browser.

### compile:browser (standalone binary)

```sh
deno task compile
```

Bundles `src/App.tsx` + React + useAio into a fully self-contained `dist/app.js` (no CDN dependency), then runs `deno compile` to produce a standalone binary (~95MB). Dev-only packages (electron, esbuild, react, react-dom) are excluded from the binary automatically.

The binary name comes from deno.json `"title"` (lowercased, spaces→hyphens). Override with `--name=`:

```sh
./my-app                       # binary name derived from title "My App"
./my-app --port=3000           # custom port
deno run -A dep/aio/src/build.ts --compile --name=custom   # override
deno run -A dep/aio/src/build.ts --compile --force          # skip cache, rebuild from scratch
```

**Build flags:**

| Flag | Effect |
|------|--------|
| `--compile` | Compile standalone Deno binary |
| `--electron` | Build AppImage (implies `--compile`) |
| `--client` | Build client-only AppImage — no Deno runtime (`compile:electron:remote`) |
| `--cli` | Build CLI binary — no browser bundle, headless server (`compile:cli`) |
| `--cli --remote` | Build client-only CLI binary — no server (`compile:cli:remote`) |
| `--android` | Build APK via Gradle |
| `--android --remote` | Build client-only APK — connect page, no local dispatch (`compile:android:remote`) |
| `--compile --service` | Compile binary + generate systemd unit file |
| `--compile --service --remote` | Same, with `--expose` in systemd ExecStart (`compile:browser:remote`) |
| `--compile --service --headless` | Same, with `--headless` in systemd ExecStart (`compile:service`) |
| `--compile --service --headless --remote` | Same, with `--expose --headless` (`compile:service:remote`) |
| `--name=X` | Override binary name (default: from deno.json `"title"`) |
| `--force` | Skip bundle cache — always rebuild `dist/app.js` |
| `--release` | Android release build (default: debug) |

### compile:electron (desktop AppImage)

```sh
deno task compile:electron
```

Does everything `compile` does, plus packages the binary with Electron into a portable `.AppImage`:

1. Bundles `dist/app.js` (self-contained, React included)
2. Compiles deno binary → `dist/AppDir/<name>`
3. Copies `node_modules/electron/dist/` → `dist/AppDir/electron/`
4. Generates `AppRun`, `.desktop` file, icon (`src/icon.png` if present, otherwise SVG placeholder)
5. Downloads `appimagetool` (cached in `node_modules/.cache/`)
6. Produces `<name>-x86_64.AppImage` (~137MB)

```sh
./my-app-x86_64.AppImage      # runs with Electron window, fully offline
```

The AppImage sets `$ELECTRON_PATH` internally, so the deno binary finds the bundled Electron automatically. State is persisted to `~/.local/share/<app-name>/data.kv` (XDG spec) — not inside the read-only AppImage.

### compile:electron:remote (thin client AppImage)

```sh
deno task compile:electron:remote
```

Builds a standalone Electron app with a connect page — no Deno runtime, no app code bundled. Users type a server address and connect to any running aio server.

The output is `aio-client-x86_64.AppImage` (~80MB, Electron only). Supports `--url=` argument for direct connection without the connect page.

### compile:cli (terminal binary)

```sh
deno task compile:cli
```

Compiles a headless server + CLI client into a standalone binary. No browser bundle — skips esbuild entirely, just `deno compile` of `src/app.ts`. Your app uses `connectCli()` instead of `useAio()` to receive state and dispatch actions.

**Entry point** — `src/app.ts`:

```ts
import { aio, connectCli } from 'aio'
import { initialState } from './state.ts'
import { reduce } from './reduce.ts'
import { execute } from './execute.ts'
import type { AppState } from './state.ts'
import { A } from './actions.ts'

// Start server headless — no browser/electron
const app = await aio.run(initialState, { reduce, execute, headless: true })

// Connect CLI client to local server
const cli = connectCli<AppState>(`http://localhost:${app.port}`)
const state = await cli.ready

// Reactive — called on every state change
cli.subscribe(s => {
  console.clear()
  console.log(`Counter: ${s.counter}`)
})

// Developer builds whatever they want — REPL, TUI, daemon, etc.
```

`connectCli<S>(url, opts?)` returns a `CliApp<S>`:

| Property | Type | Description |
|----------|------|-------------|
| `state` | `S \| null` | Current state (null until connected) |
| `send(action)` | `(action) => void` | Dispatch action to server |
| `subscribe(fn)` | `(fn) => unsubscribe` | Listen to state changes (fires immediately if state exists) |
| `close()` | `() => void` | Close connection |
| `connected` | `boolean` | Whether WS is currently open |
| `ready` | `Promise<S>` | Resolves when first state arrives |

Options: `{ token?: string }` — auth token for `--expose` / multi-user servers.

### compile:cli:remote (client-only binary)

```sh
deno task compile:cli:remote
```

Compiles `src/client.ts` into a standalone binary with no server — just a WS client that connects to a remote aio server. Same `connectCli()` API.

**Entry point** — `src/client.ts`:

```ts
import { connectCli } from 'aio'
import type { AppState } from './state.ts'
import { A } from './actions.ts'

const url = Deno.args[0] ?? 'http://localhost:8000'
const cli = connectCli<AppState>(url)
await cli.ready

cli.subscribe(s => console.log('state:', JSON.stringify(s)))
```

### Standalone runtime (`initStandalone`)

For Android builds, aio uses a client-side dispatch loop instead of a server. The `initStandalone()` function replaces `aio.run()`:

```ts
import { initStandalone } from 'aio'

const app = initStandalone(initialState, {
  reduce,                    // (state, action) → { state, effects: (E | ScheduleEffect)[] }
  execute,
  persist: true,             // default: true — uses localStorage
  persistKey: 'aio_state',   // default: 'aio_state'
  persistDebounce: 100,      // ms between localStorage writes (default: 100)
  getDBState: (s) => s,      // which part of state to persist
  getUIState: (s) => s,      // which part of state to show in UI
  onRestore: (s) => s,       // transform state after loading from localStorage
})
```

Normally you don't call this directly — the Android build pipeline substitutes `standalone.ts` for `browser.ts` automatically. But it's useful for testing or custom setups.

**Differences from `aio.run()`:**
- No server, no WebSocket — dispatch loop runs in the browser
- Persistence via `localStorage` instead of Deno.Kv
- `app.snapshot`, `app.loadSnapshot`, and `app.db` are `undefined`
- `app.mode === 'standalone'`

### compile:android (standalone APK)

```sh
deno task compile:android
```

Bundles your app into a standalone Android APK that runs entirely in a WebView — no server, no Deno runtime on the device. The dispatch loop, reducer, and effects all run client-side with localStorage for persistence.

**Prerequisites:**
- Android SDK (`$ANDROID_HOME` set)
- Java 17+ (`$JAVA_HOME`)
- Gradle on `PATH`

**How it works:**
1. Bundles `dist/app.js` with `standalone.ts` instead of `browser.ts` — same React hooks, but dispatch loop runs locally
2. Generates a Kotlin WebView shell from `dep/aio/android-template/`
3. Copies `dist/app.js` + generated `index.html` + optional `style.css` into Android assets
4. Copies `src/icon.png` to mipmap resources (if present)
5. Runs `gradle assembleDebug` (or `assembleRelease` with `--release`)
6. Outputs `<name>.apk` in project root

```sh
deno task compile:android                  # debug APK
deno run -A dep/aio/src/build.ts --android --release  # release APK (needs signing config)
```

**Same src/ code for both platforms.** Your `state.ts`, `actions.ts`, `reduce.ts`, `execute.ts`, and `App.tsx` work identically on desktop and Android. The only difference: effects using Deno APIs (file system, network server, etc.) will fail in standalone mode. Use `app.mode === 'standalone'` to branch:

```ts
export function execute(app: AioApp<AppState, Action>, effect: Effect): void {
  switch (effect.type) {
    case E.Log:
      console.log(effect.payload.message)  // works everywhere
      break
    case E.READ_FILE:
      if (app.mode === 'standalone') return  // skip on Android
      // Deno API — desktop only
      break
  }
}
```

**Android WebView uses Chromium** (same engine as Electron), so your app renders identically on desktop and mobile.

### compile:android:remote (client APK)

```sh
deno task compile:android:remote
```

Builds an Android APK that acts as a thin client — no local state, no reducer, no Deno runtime. The APK shows a connect page where the user enters the server URL. The WebView then navigates to the remote aio server, which serves the full UI.

**How it works:**
1. Skips `esbuild` bundling entirely — no `dist/app.js` needed
2. Generates a connect page HTML with URL input (stored in `localStorage` for reconnection)
3. Packages the connect page into Android assets
4. Builds APK via Gradle — outputs `<name>-client.apk`

Same prerequisites as `compile:android` (Android SDK, Java, Gradle).

The remote server must be running with `--expose` for the APK to connect. Use `compile:browser:remote` or `compile:service:remote` for the server side.

### compile:browser:remote (exposed server + systemd)

```sh
deno task compile:browser:remote
```

Compiles a standalone binary + generates a systemd unit file with `--expose --port=3000`. The binary includes `dist/app.js` so browsers on the network can access the full UI.

**Systemd ExecStart:** `--expose --port=3000` (binds 0.0.0.0, auto-generates auth token)

Install and manage like any systemd service:

```sh
sudo cp aio-counter /usr/local/bin/
sudo cp aio-counter.service /etc/systemd/system/
sudo systemctl enable --now aio-counter
journalctl -u aio-counter -f  # view logs + auth token
```

### compile:service:remote (headless exposed server)

```sh
deno task compile:service:remote
```

Same as `compile:browser:remote` but headless — no browser auto-open.

**Systemd ExecStart:** `--expose --headless --port=3000`

Use this when the server only needs to serve API clients (CLI, Android, Electron remote), not browser users directly. The binary still includes `dist/app.js` so browser access works if needed.

> **Note:** `compile:service` (local) generates `--headless --port=3000` without `--expose` — binds 127.0.0.1 only.

### CSS in builds

If `src/style.css` exists, it's automatically:
- **Dev:** served from `src/` and injected as `<link>` in HTML
- **Compile:** copied to `dist/style.css` and included in the binary

### How exclusion works

The build script temporarily removes dev-only symlinks from `node_modules/` and passes `--exclude` flags to `deno compile` for the big directories (electron ~254MB, esbuild ~11MB, react ~5MB). Symlinks are restored after compile, even on failure.

## Lifecycle hooks

Optional `on*` callbacks on config — observe-only, error-guarded. Useful for logging, analytics, debugging, connection tracking, and setup/teardown.

```ts
await aio.run(state, {
  reduce, execute,
  onRestore:    (state) => ({ ...state, items: state.items.map(i => ({ score: 0, ...i })) }),
  onAction:     (action, state, user?) => console.log(`[${action.type}] by ${user?.id ?? 'anon'}`),
  onEffect:     (effect, user?) => console.log('effect:', effect.type),
  onConnect:    (user?) => console.log('connected:', user?.id ?? 'anonymous'),
  onDisconnect: (user?) => console.log('disconnected:', user?.id ?? 'anonymous'),
  onStart:      (app) => console.log('server ready'),
  onStop:       () => console.log('shutting down'),
})
```

| Hook | Fires | Arguments |
|------|-------|-----------|
| `onRestore` | After state restore from KV/localStorage | `(state)` — return transformed state. Runs before server starts, no race window |
| `onAction` | Before `reduce()` | `(action, state, user?)` — `state` is pre-reduce, `user` is the `AioUser` who dispatched |
| `onEffect` | Before `execute()` | `(effect, user?)` |
| `onConnect` | WS client connects | `(user?)` — `undefined` in public mode |
| `onDisconnect` | WS client disconnects | `(user?)` |
| `onStart` | After server boots | `(app)` — same `AioApp` as `run()` return value |
| `onStop` | Before shutdown | *(none)* |
| `onError` | When reduce or effect throws | `(error: AioError)` — see error handling below |

All hooks are:
- **Optional** — omit any you don't need
- **Observe-only** — void return, no transform/drop (except `onRestore` which returns new state)
- **Error-guarded** — a throwing hook is logged but doesn't crash the app
- **Sync** — hooks run synchronously in the lifecycle; async work should dispatch actions

### Error handling with `onError`

When `reduce()` throws or an effect throws, the error is caught and the app continues running. Use `onError` to observe these errors:

```ts
await aio.run(state, {
  reduce, execute,
  onError: (err) => {
    // err.source: 'reduce' | 'effect'
    // err.error: the thrown value
    // err.actionType?: string  — action that caused reduce error
    // err.effectType?: string — effect type that threw
    if (err.source === 'reduce') {
      console.error(`Reducer threw on ${err.actionType}:`, err.error)
    } else {
      console.error(`Effect ${err.effectType} threw:`, err.error)
    }
  },
})
```

**Key behaviors:**
- **Reduce errors:** Action is dropped, state unchanged, next action processes normally
- **Sync effect errors:** Logged, remaining effects continue
- **Async effect errors:** Caught via `.catch()`, logged, app continues
- Without `onError`, errors are only logged to console

> **Tip:** If you have arrays of objects with evolving schemas (e.g. adding new required fields), consider using [SQLite persistence](#sqlite-persistence) for those arrays — it handles schema via `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE`. For simpler cases, `onRestore` lets you patch missing fields after KV restore.

`onStop` fires on both `app.close()` and signal-triggered shutdown (SIGINT/SIGTERM).

**Need to intercept/transform actions?** Use `beforeReduce`:
```ts
await aio.run(state, {
  reduce, execute,
  beforeReduce: (action, state) => {
    if (action.type === 'Nope') return null          // drop
    if (action.type === 'Inc' && state.locked) return null  // conditional drop
    return action                                     // pass through
  },
})
```
`beforeReduce` runs before `onAction` and `reduce`. Return the action (optionally modified) to continue, or `null` to drop it silently. Errors in `beforeReduce` are logged and the action is dropped.

## Performance budgets

aio tracks how long your reducer and effects take, warning when operations exceed budget. This catches blocking work that makes the UI unresponsive.

### How it works

Every action is timed:
- **reduce budget** (default: 100ms) — if `reduce()` takes longer, it's flagged
- **effect budget** (default: 5ms) — if sync portion of `execute()` takes longer, it's flagged

Async effects (promises) return immediately — only the sync part is measured. If your effect does `fetch().then(...)`, the `fetch()` call takes microseconds, so it passes.

```ts
// ✅ GOOD — async, returns in < 1ms
case E.Fetch:
  fetch(url).then(r => app.dispatch(A.loaded(r)))
  break

// ❌ BAD — sync work blocks
case E.Process:
  const data = heavyComputation()  // 500ms sync
  return [E.done(data)]
```

### Modes

| Mode | Behavior |
|------|----------|
| `'strict'` (default) | Calls `onError({ source: 'performance', ... })` + logs error |
| `'soft'` | Only `console.warn()` — no callback |

### Custom budgets

```ts
await aio.run(state, {
  reduce, execute,
  perfMode: 'strict',           // or 'soft'
  perfBudget: {
    reduce: 50,   // warn if reduce > 50ms
    effect: 10,   // warn if sync effect > 10ms
  },
})
```

### Getting performance errors

Both modes apply the action — state changes normally. This keeps your app functional while surfacing issues.

```ts
await aio.run(state, {
  reduce, execute,
  onError: (err) => {
    if (err.source === 'performance') {
      console.error(`Slow ${err.actionType ?? err.effectType}: ${err.duration}ms > ${err.budget}ms`)
      // Show warning in UI, send to monitoring, etc.
    }
  },
})
```

### Best practices

1. **Keep reduce fast** — state updates should be instant. Move heavy computation to effects
2. **Effects should return immediately** — kick off async work, don't block
3. **Use `perfMode: 'soft'` in dev** — see warnings in console during development
4. **Use `perfMode: 'strict'` in prod** — log to monitoring via `onError`

### Example: Moving slow work out of reduce

```ts
// BAD — reduce takes 200ms
case A.Analyze:
  d.results = analyzeEverything(d.data)  // blocks 200ms!
  return []

// GOOD — reduce returns fast, effect does the work
case A.Analyze:
  d.analyzing = true
  return [E.runAnalysis(d.data)]

// In execute.ts
case E.RunAnalysis:
  const results = analyzeEverything(effect.payload.data)  // still 200ms
  app.dispatch(A.analysisDone(results))  // but doesn't block UI
  break
```

## Trojan — Control API

aio exposes a REST API at `/__trojan/*` for full inspection and control. Available in both dev and prod modes — use `am` (see below) or `curl` directly.

### Inspect (GET)

```sh
curl localhost:8000/__trojan/state        # raw full state (unfiltered)
curl localhost:8000/__trojan/ui           # UI state (default view)
curl localhost:8000/__trojan/ui?user=alice # UI state for specific user
curl localhost:8000/__trojan/clients      # connected WS clients
curl localhost:8000/__trojan/history      # time-travel entries
curl localhost:8000/__trojan/schedules    # active timer/cron IDs
curl localhost:8000/__trojan/metrics      # uptime, connections, schedule count
curl localhost:8000/__trojan/config       # port, title, expose, authMode, prod
```

### Control (POST)

```sh
# Dispatch action
curl -X POST localhost:8000/__trojan/dispatch \
  -H 'Content-Type: application/json' \
  -d '{"type":"INCREMENT","payload":{"by":1}}'

# Dispatch as specific user
curl -X POST localhost:8000/__trojan/dispatch \
  -d '{"type":"BUY","payload":{},"user":{"id":"alice","role":"admin"}}'

# Replace state
curl -X POST localhost:8000/__trojan/snapshot \
  -d '{"counter":99}'

# Time-travel commands
curl -X POST localhost:8000/__trojan/tt -d '{"cmd":"undo"}'
curl -X POST localhost:8000/__trojan/tt -d '{"cmd":"redo"}'
curl -X POST localhost:8000/__trojan/tt -d '{"cmd":"goto","arg":3}'

# SQL query (if db configured)
curl -X POST localhost:8000/__trojan/sql \
  -d '{"query":"SELECT * FROM users LIMIT 10"}'

# Force persist to KV/SQLite
curl -X POST localhost:8000/__trojan/persist
```

All endpoints return JSON. Errors return `{"error":"..."}` with appropriate status codes. Auth is inherited — tokens required when `--expose` is active.

## Time-Travel

In dev mode, aio records every action and state snapshot, letting you undo, redo, and jump to any past state. Zero cost in prod.

### Built-in panel

Press **Ctrl+.** (Ctrl + Period) to toggle a floating panel — no code changes to your App.tsx required. The panel shows action history with timestamps, undo/redo/goto buttons, and pause/resume controls. It only appears in dev mode. A styled console message confirms activation on connect.

The panel is pure DOM (not React) so it doesn't interfere with your app's component tree or re-renders.

### `useTimeTravel()`

For custom UIs, use the `useTimeTravel()` hook instead of (or alongside) the built-in panel.

Browser hook — returns TT controls in dev mode, `null` in prod.

```tsx
import { useAio, useTimeTravel } from 'aio'

export default function App() {
  const { state, send } = useAio<AppState>()
  const tt = useTimeTravel()

  if (!state) return <div>Connecting...</div>

  return (
    <div>
      <div>Count: {state.counter}</div>
      <button onClick={() => send(A.increment())}>+</button>

      {tt && (
        <div style={{ marginTop: '1rem', padding: '1rem', background: '#1e1e1e', color: '#ccc', borderRadius: 8, fontFamily: 'monospace' }}>
          <div>
            <b>Time Travel</b> — {tt.index + 1}/{tt.entries.length}
            {tt.paused && <span style={{ color: '#f44' }}> (paused)</span>}
          </div>
          <div style={{ marginTop: 8 }}>
            <button onClick={tt.undo} disabled={tt.index <= 0}>Undo</button>
            <button onClick={tt.redo} disabled={tt.index >= tt.entries.length - 1}>Redo</button>
            {tt.paused
              ? <button onClick={tt.resume}>Resume</button>
              : <button onClick={tt.pause}>Pause</button>}
          </div>
          <ul style={{ maxHeight: 200, overflow: 'auto', margin: '8px 0', padding: 0, listStyle: 'none' }}>
            {tt.entries.map((e, i) => (
              <li key={e.id}
                  onClick={() => tt.goto(e.id)}
                  style={{ cursor: 'pointer', padding: '2px 4px', background: i === tt.index ? '#333' : 'transparent' }}>
                {e.type}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
```

### Return value

`useTimeTravel()` returns `null` in prod mode. In dev mode:

| Field | Type | Description |
|-------|------|-------------|
| `entries` | `{ id, type, ts }[]` | Action history (type name only, no payload/state) |
| `index` | `number` | Current position in history |
| `paused` | `boolean` | Whether dispatch is frozen |
| `undo()` | `() => void` | Step back one action (auto-pauses) |
| `redo()` | `() => void` | Step forward one action (stays paused) |
| `goto(id)` | `(id: number) => void` | Jump to specific entry by id (auto-pauses) |
| `pause()` | `() => void` | Freeze state — new actions are dropped |
| `resume()` | `() => void` | Unfreeze — truncates forward history (branch, not tree) |

### Behavior

- **Auto-pause on undo/goto**: Prevents new actions from overwriting the historical state you're inspecting
- **Resume truncates forward**: Standard undo/redo semantics — resuming from the middle discards the forward branch
- **200 entry cap**: Oldest entries are evicted. At ~1KB per state snapshot, that's ~200KB — negligible for local tools
- **Wire-safe**: Only action types are sent to the browser (no payloads, no state snapshots) — keeps WS messages small
- **Zero cost in prod**: TT code is only instantiated behind a dev-mode guard — no overhead in production

### WS protocol

The debugger uses `__tt:` prefixed messages over the existing WebSocket:

**Server → client:** `__tt:{"entries":[{id,type,ts},...], "index":N, "paused":bool}`
**Client → server:** `__tt:undo`, `__tt:redo`, `__tt:goto:5`, `__tt:pause`, `__tt:resume`

These are handled transparently by `useTimeTravel()` — you don't need to interact with the protocol directly.

## Scaling

aio runs as a single Deno process with SQLite and WebSocket broadcast. That sounds limiting, but with the right approach it handles far more than you'd expect.

### Architecture at scale

```
Client → WebSocket → aio server (single process)
                        ├── state (in-memory, small)
                        ├── SQLite (on disk, WAL mode, fast)
                        └── Deno.Kv (UI scalars only)
```

A single modern server can handle thousands of concurrent WebSocket connections. SQLite in WAL mode does 100k+ reads/sec on NVMe. The framework already has delta patching (only changed keys are sent) and per-user filtering (`getUIState`). The question isn't whether aio can scale — it's whether your app design lets it.

### What limits scale

| Bottleneck | Cause | Ceiling |
|------------|-------|---------|
| In-memory state | Everything in state = everything in RAM | Depends on state size |
| Broadcast storm | Every action triggers broadcast to all clients | ~1000s of clients |
| SQLite writes | Single-writer (WAL allows concurrent reads) | ~10k writes/sec |
| Single process | One machine, one CPU core for dispatch | One machine's worth |

### Practices for maximum scale

**1. Keep state small — query on demand**

The #1 mistake: putting large datasets in state. State should hold what's *active*, not what *exists*.

```ts
// Bad — 100k orders in memory, broadcast to every client
type State = { orders: Order[] }

// Good — state holds current view, SQLite holds everything
type State = { page: string; currentOrders: Order[]; filters: Filters }

// In an effect: query only what's needed
case E.LoadOrders:
  const orders = app.db!.orders.where({
    status: 'active',
    total: { gt: action.payload.minTotal }
  })
  app.dispatch(A.ordersLoaded(orders))  // small, filtered result
  break
```

**2. Use `getUIState` aggressively**

Filter what each user sees. Less data per client = less bandwidth = more clients.

```ts
getUIState: (state, user?) => {
  // Admin sees everything, viewers see their own data
  if (user?.role === 'admin') return state
  return {
    page: state.page,
    orders: state.currentOrders.filter(o => o.userId === user?.id),
  }
}
```

**3. Use Level 2/3 for heavy lifting**

Don't route large data operations through the reducer. Use ORM methods or raw SQL in effects — they write directly to SQLite without touching state or broadcast.

```ts
// Batch import: 10k rows directly to SQLite, no state churn
case E.ImportCSV:
  app.db!.orders.insertMany(parsedRows)
  app.dispatch(A.importDone(parsedRows.length))
  break

// Aggregation: compute on SQLite, send result to state
case E.DashboardStats:
  const stats = app.db!.query<{ total: number; count: number }>(
    'SELECT SUM(total) as total, COUNT(*) as count FROM orders WHERE status = ?',
    ['active']
  )
  app.dispatch(A.statsLoaded(stats[0]))
  break
```

**4. Debounce high-frequency updates**

If your app processes rapid events (sensors, live data), batch them before dispatching.

```ts
// In effect: accumulate, then dispatch once
case E.SensorBatch:
  const readings = collectReadings(action.payload.buffer)
  app.db!.readings.insertMany(readings)  // bulk write to SQLite
  app.dispatch(A.readingsUpdated(readings.length))  // one broadcast
  break
```

**5. Design state keys for delta efficiency**

Delta patching works per top-level key. If one key changes out of many, only that key is sent. Structure state so frequently-changing data is in its own key.

```ts
// Good: counter changes don't resend the orders list
type State = {
  counter: number       // changes often → small delta
  orders: Order[]       // changes rarely
  filters: Filters      // changes sometimes
}
```

### Realistic capacity

With careful design (small state, filtered UI, SQLite for bulk data):

- **Concurrent clients**: 1,000–5,000 per server (WebSocket + delta patching)
- **SQLite rows**: Millions (reads are fast, writes batched in transactions)
- **Actions/sec**: Hundreds (reducer is synchronous, keep it fast)
- **Data on disk**: Limited by disk space, not framework

This comfortably serves tens of thousands of daily users on a single $20/month VPS. For most tools, dashboards, and business apps — that's more than enough.

### What aio is not designed for

- Horizontal scaling across multiple machines (no shared state protocol)
- Public-facing websites needing SEO (no server-side rendering)
- Sub-millisecond latency requirements (WebSocket adds ~1-5ms)
- Truly stateless APIs (aio is stateful by design)

For these, use a purpose-built tool. aio excels at stateful, interactive applications where the server owns the truth and clients render it.

## HTTP endpoints

| Endpoint | Availability | Purpose |
|----------|-------------|---------|
| `/` | always | HTML shell — entry point for browser/Electron |
| `/ws` | always | WebSocket — state sync, action dispatch, delta broadcasts, TT commands |
| `/__aio/ui.js` | dev only | Live-transpiled browser.ts — useAio, WS client, page(), msg() |
| `/__aio/error` | dev only | Error overlay — fetches last transpile error |
| `/__snapshot` GET | always | Full raw state dump — backup, debugging, export |
| `/__snapshot` POST | always | Load state from JSON — restore, import, testing |
| `/app.js` `/style.css` | prod only | Pre-bundled dist assets from `dist/` |
| `/__trojan/*` | always | Full control REST API — inspect state, dispatch, time-travel, SQL (see [Trojan](#trojan--control-api)) |

All endpoints inherit auth (token/user checks run before routing). In `--expose` mode, tokens are required.

## Limitations

- **State must be JSON-serializable** — no classes, functions, Dates, Uint8Arrays, or circular references
- **No CSS imports in TS** — use `src/style.css` (auto-injected) or `<link>` tags, not `import './style.css'`
- **Single CSS entry point** — only `src/style.css` is auto-detected. Use `@import` inside it for multiple files
- **CSS detection is startup-only** — if you create `src/style.css` after starting the server, restart to pick it up
- **`$p` and `$d` are reserved** — don't use `$p` or `$d` as top-level keys in your state (used internally for delta patches and key deletion)
- **WS message size limit** — messages over 1MB are silently dropped. Keep state and actions compact
- **Actions dropped while offline** — when the server is unreachable, `send()` silently drops actions. Only the initial connect race (WS not yet open) queues up to 100 actions
- **Max 100 concurrent WebSocket connections** — returns 503 beyond this limit
- **Dev mode CDN** — React loaded from esm.sh in dev (first load needs internet). Compiled builds are fully offline

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `JSX.IntrinsicElements` type error | Check `compilerOptions` in deno.json, run `deno install` |
| Blank page in browser | Check startup log — missing App.tsx or no `export default`. Syntax errors show an overlay automatically |
| Actions do nothing | Check browser console + `--verbose` log for WS messages |
| State resets on restart | `persist: true` (default) + `"unstable": ["kv"]` in deno.json |
| `import from '../dep/aio/'` error | Always use `import from 'aio'` — never relative paths |
| Port in use | Kill old process or use `--port=N` |
| Electron not found | `deno install npm:electron` then `deno approve-scripts` then `deno install` again. Or use `--no-electron` |
| Electron installed but no window | Run `deno approve-scripts` — electron's postinstall needs manual approval in Deno |
| Server dies when Electron closes | Use `--keep-alive` flag or `ui: { keepAlive: true }` in config |
| Build Error: could not find 'npm:esbuild' | Add `"esbuild": "npm:esbuild@^0.24"` to deno.json imports, then `deno install` |
| `am status` says "stopped" | No running process. Stale `.aio.pid` auto-cleaned. Check `.aio.log` for errors |
| `am start` says "port in use" | Non-aio process on the port. Use `--port=N`. (aio zombies are killed automatically) |

## am — App Manager

Manage your aio app without `ps`, `kill`, or `curl`. Works for humans and AI agents alike. **AI coding agents: use `am` for all process and state management — don't shell out to raw `curl` or `kill`.**

```sh
deno task am <command> [args] [--flags]
```

Output auto-detects: terminal → pretty text, piped → JSON. Override with `--json` or `--quiet`.

### Global flags

| Flag | Effect |
|------|--------|
| `--port=N` | Target a specific port (default: from `.aio.pid` or 8000) |
| `--wait[=N]` | start/stop: block until complete (default 10s/5s). state: poll every Ns (default 2s) |
| `--json` | Force JSON output |
| `--quiet` | Suppress output (exit code only) |

### Process management (singleton)

Each project runs at most one instance. `am start` enforces this automatically:

| Existing instance | Behavior |
|-------------------|----------|
| None | Start normally |
| Dead (stale PID file) | Clean up, start |
| Alive + responding | Refuse ("already running") |
| Alive + not responding (zombie) | Kill (SIGTERM → SIGKILL), then start |
| Status `stopping` | Wait up to 3s, force kill if stuck, then start |
| Status `starting` | Refuse ("instance is starting — use am restart") |

```sh
deno task am start                # start app (kills zombies, refuses if running)
deno task am start --wait         # start and block until healthy (default 10s timeout)
deno task am start --wait=30      # start with 30s timeout (slow boot apps)
deno task am start --port=9000    # start on specific port (passed through to app)
deno task am stop                 # graceful shutdown, return immediately
deno task am stop --wait          # stop and block until dead (default 5s timeout)
deno task am restart              # stop (waits internally) + start (returns immediately)
deno task am status               # stopped|starting|started|stopping
```

`start` and `stop` return immediately by default — use `--wait[=N]` to block until the action completes. `restart` always waits for stop internally (port must be free), then spawns and returns immediately. `status` cross-validates PID file against process liveness and port response. Exit code: `started` → 0, everything else → 1.

`start` writes `.aio.pid` with `status: starting`, logs to `.aio.log`. `stop` tries graceful shutdown via trojan API, falls back to SIGTERM, escalates to SIGKILL after timeout. Kill sequence is always graceful-first: SIGTERM → wait 2s → SIGKILL.

### State inspection

```sh
deno task am state                          # full state JSON
deno task am state fleet[0].stats           # JS-like path traversal
deno task am state fleet[0].{name,active}   # pick specific fields (destructuring)
deno task am state fleet[*].{pair,status}   # wildcard: pluck from every array element
deno task am state fleet[*].stats.pnl       # wildcard: nested traversal
deno task am state {counter,page}           # pick from root
deno task am state fleet[0].stats --wait=5  # poll every 5s, print each result
deno task am state fleet[*].pnl --wait     # poll every 2s (default)
deno task am ui                             # UI state (getUIState result)
deno task am ui alice                       # UI state for specific user
```

Path syntax mirrors TypeScript: `fleet[0].stats.pnl` for traversal, `{id,name}` for field picking (like destructuring), `[*]` for wildcard over arrays. Missing keys in brace-pick are silently skipped. `--wait[=N]` polls every N seconds (default 2s), printing each result (Ctrl+C to stop).

### Actions

```sh
deno task am dispatch Increment by=1       # type + key=value payload
deno task am dispatch Reset                # no payload
deno task am dispatch --body='{"type":"BUY","payload":{"symbol":"AAPL"}}'  # raw JSON
deno task am actions                       # last 20 actions from history
deno task am actions 50                    # last 50 actions
```

Values in `key=value` pairs are auto-parsed: numbers, booleans, `null` via `JSON.parse` fallback, strings otherwise.

### Time-travel

**In browser (dev mode only):**
- Press `Ctrl+.` (period) to toggle the time-travel panel
- Shows action history with timestamps
- **Performance metrics**: each action shows `reduce:ms effects:ms`
  - Times turn red when budget exceeded
  - Helps identify slow reducers or blocking effects

```
┌─ Time-travel ──────────────────────┐
│ ▸ Increment    2ms  0ms             │
│   LoadUsers    5ms  1ms             │
│   SaveFile     3ms  (async)         │
│ ◾ SetPage     12ms 150ms ⚠         │ ← slow!
└─────────────────────────────────────┘
```

**Via `am` CLI:**

### Persistence & snapshots

```sh
deno task am persist              # force flush to KV/SQLite
deno task am snapshot             # dump state to stdout
deno task am snapshot save backup.json   # save to file
deno task am snapshot load backup.json   # restore from file
```

### Other commands

```sh
deno task am clients              # connected WebSocket clients
deno task am sql "SELECT * FROM orders LIMIT 5"  # raw SQL query
deno task am tables               # list SQLite tables
deno task am schedules            # active timers/cron
deno task am log                  # tail last 50 lines of .aio.log
deno task am log --filter=ERROR   # filter log lines
deno task am log --lines=100      # show more lines
deno task am errors               # last transpile error (dev mode)
deno task am metrics              # uptime, connections, schedule count
deno task am health               # health check (exit 0 = ok)
deno task am config               # server config (port, title, auth mode, prod)
deno task am version              # aio version
deno task am help                 # full command list
```

### For AI agents

`am` is the primary interface for AI agents managing aio apps. Output is JSON when piped, making it easy to parse programmatically:

```sh
# Check if app is running
deno task am health && echo "up" || echo "down"

# Read state, parse with jq
deno task am state | jq '.fleet[0].stats'

# Dispatch and verify
deno task am dispatch BUY symbol=AAPL qty=10
deno task am state portfolio.positions
```

## File reference

### Framework (`dep/aio/`)

| File | Purpose |
|------|---------|
| `dep/aio/mod.ts` | Public API — all `'aio'` imports resolve here (Deno-side), type declarations for browser-only functions |
| `dep/aio/src/aio.ts` | Core runtime — `aio.run()`, dispatch loop, CLI parser, KV path resolution, startup linter |
| `dep/aio/src/browser.ts` | Browser-side module — `useAio`, `useLocal`, `msg`, `page` (transpiled for dev, bundled for prod) |
| `dep/aio/src/server.ts` | HTTP + WebSocket server, TSX transpilation (dev), static serving (prod), delta broadcasting |
| `dep/aio/src/build.ts` | Build script — bundles App.tsx + React, compiles binary, AppImage packaging |
| `dep/aio/src/msg.ts` | Shared `msg()` constructor — used by mod.ts (server) and browser.ts (client) |
| `dep/aio/src/factory.ts` | `actions()` / `effects()` catalog factory — generates PascalCase labels + camelCase creators |
| `dep/aio/src/time-travel.ts` | Time-travel debugger — pure functions for undo/redo/goto, active in dev mode |
| `dep/aio/src/dispatch.ts` | Shared dispatch loop — re-entrant queue with overflow guard, used by both aio.ts and standalone.ts |
| `dep/aio/src/deep-merge.ts` | Deep merge utility — restores persisted state while preserving schema structure |
| `dep/aio/src/skv.ts` | Thin Deno.Kv wrapper — `set`/`get`/`del`/`close` with string keys |
| `dep/aio/src/standalone.ts` | Standalone runtime — full client-side dispatch loop for Android WebView (replaces browser.ts) |
| `dep/aio/src/schedule.ts` | Scheduled effects — `schedule.after/every/at/cron/cancel`, cron parser, schedule manager |
| `dep/aio/src/am.ts` | `am` — app manager CLI. Process lifecycle, state inspection, dispatch, time-travel, log tailing |
| `dep/aio/src/electron.ts` | Electron launcher + aio-client connect page. Window state persistence, AioMeta extraction |
| `dep/aio/android-template/` | Kotlin/Gradle template for Android APK builds (placeholder tokens replaced at build time) |

### App (`src/`)

| File | Purpose |
|------|---------|
| `src/app.ts` | Your entry point — import state/logic, call `aio.run()` |
| `src/state.ts` | State type + initial values |
| `src/actions.ts` | Action type constants + creators (`A`) |
| `src/effects.ts` | Effect type constants + creators (`E`) |
| `src/reduce.ts` | Reducer — `(state, action) → { state, effects }` |
| `src/execute.ts` | Effect executor — runs side effects |
| `src/App.tsx` | React component — default export, uses `useAio()` |
| `src/style.css` | (optional) Auto-injected into HTML if present |
| `src/icon.png` | (optional) App icon used in AppImage builds |
