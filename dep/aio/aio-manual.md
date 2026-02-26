# AIO Framework Manual

AIO is a full-stack TypeScript framework for Deno. One function call boots a persistent backend, WebSocket server, and React UI — in Electron or the browser. You write state, actions, a reducer, effects, and a React component. AIO handles the rest.

---

# Part 1: Quickstart

### Prerequisites

- [Deno 2.6+](https://deno.land)
- `npm:electron` (optional — for desktop window)

### File structure

```
deno.json
src/
  app.ts          ← entry point
  state.ts        ← state shape + initial values
  actions.ts      ← messages from UI → server
  effects.ts      ← side effects returned by reducer
  reduce.ts       ← (state, action) → new state + effects
  execute.ts      ← runs effects (API calls, logging, etc.)
  App.tsx          ← React UI component
  style.css       ← (optional) auto-injected into HTML
```

### deno.json

```json
{
  "title": "My App",
  "unstable": ["kv"],
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "jsxImportSourceTypes": "@types/react"
  },
  "imports": {
    "@types/react": "npm:@types/react@^18",
    "react": "npm:react@^18",
    "react-dom": "npm:react-dom@^18",
    "aio": "./dep/aio/mod.ts",
    "esbuild": "npm:esbuild@^0.24",
    "immer": "npm:immer@^10",
    "@std/path": "jsr:@std/path@^1"
  },
  "tasks": {
    "test": "deno test -A --unstable-kv dep/aio/tests/",
    "dev": "deno run -A src/app.ts --debug",
    "compile": "deno run -A dep/aio/src/build.ts --compile",
    "compile:electron": "deno run -A dep/aio/src/build.ts --compile --electron"
  }
}
```

- `"title"` — app name, used as default window title and binary name (lowercased slug) when compiling. Optional, falls back to `"AIO App"`.
- `"esbuild"` — required for dev mode transpilation. Excluded from compiled binary automatically.

### state.ts

```ts
export type AppState = { counter: number }
export const initialState: AppState = { counter: 0 }
```

### actions.ts

```ts
import { msg, type UnionOf } from 'aio'

const T = {
  INCREMENT: "INCREMENT",
  DECREMENT: "DECREMENT",
  RESET: "RESET",
} as const

export const A = {
  ...T,
  Increment: (by = 1) => msg(T.INCREMENT, { by }),
  Decrement: (by = 1) => msg(T.DECREMENT, { by }),
  Reset: () => msg(T.RESET),
} as const

export type Action = UnionOf<typeof A>
```

### effects.ts

```ts
import { msg, type UnionOf } from 'aio'

const T = {
  LOG: "LOG",
} as const

export const E = {
  ...T,
  Log: (message: string) => msg(T.LOG, { message }),
} as const

export type Effect = UnionOf<typeof E>
```

### reduce.ts

```ts
import type { AppState } from './state.ts'
import { A, type Action } from './actions.ts'
import { E, type Effect } from './effects.ts'
import { draft } from 'aio'

export function reduce(state: AppState, action: Action): { state: AppState; effects: Effect[] } {
  return draft(state, d => {
    switch (action.type) {
      case A.INCREMENT:
        d.counter += action.payload.by
        return [E.Log(`incremented to ${d.counter}`)]
      case A.DECREMENT:
        d.counter -= action.payload.by
        return [E.Log(`decremented to ${d.counter}`)]
      case A.RESET:
        d.counter = 0
        return []
      default:
        return []
    }
  })
}
```

### execute.ts

```ts
import { E, type Effect } from './effects.ts'
import type { AppState } from './state.ts'
import type { Action } from './actions.ts'
import type { AioApp } from 'aio'

export function execute(effect: Effect, _app: AioApp<AppState, Action>): void {
  switch (effect.type) {
    case E.LOG:
      console.log(effect.payload.message)
      break
  }
}
```

### App.tsx

```tsx
import { useAio } from 'aio'
import { A } from './actions.ts'
import type { AppState } from './state.ts'

export default function App() {
  const { state, send } = useAio<AppState>()
  if (!state) return <div>Connecting...</div>

  return (
    <div>
      <h1>{state.counter}</h1>
      <button onClick={() => send(A.Increment())}>+</button>
      <button onClick={() => send(A.Reset())}>Reset</button>
    </div>
  )
}
```

### app.ts

```ts
import { aio } from 'aio'
import { initialState } from './state.ts'
import { reduce } from './reduce.ts'
import { execute } from './execute.ts'

await aio.run(initialState, { reduce, execute })
```

### Run

```sh
deno task dev
```

That's it. Electron window opens, state persists across restarts, multiple browser tabs stay in sync.

---

# Part 2: Comprehensive Reference

## Architecture

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

### Data flow

1. User clicks button → `send(A.Increment())` → WebSocket → server
2. Action is validated (must have `type: string`) and queued
3. Server calls `reduce(state, action)` → returns new state + effects array
4. Effects execute — may dispatch follow-up actions (queued, not re-entrant)
5. After all queued actions drain: state persisted to Deno.Kv (debounced) and broadcast to all UIs
6. UI receives new state → React re-renders

**Error handling:** If `reduce()` throws, the error is logged and that action is skipped — the server continues running. Effects that throw are also caught and logged individually.

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

## The `'aio'` import

Everything comes from a single import. In **deno.json**, `"aio"` maps to `./dep/aio/mod.ts`. In the **browser**, it maps to `/__aio/ui.js` (a virtual route). Same import, different runtimes.

```ts
// Server-side (Deno) — full API
import { aio, msg, draft, type UnionOf, type AioApp, type AioConfig } from 'aio'

// Browser-side (App.tsx) — hooks + helpers
import { useAio, useLocal, msg, page } from 'aio'
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
await app.close()       // graceful shutdown — flush KV, close KV handle, stop HTTP server
```

`close()` flushes any pending state to Deno.Kv before shutting down, so no data is lost. Signal handlers (SIGINT/SIGTERM) and Electron close also flush automatically — `close()` is for programmatic shutdown in tests or custom lifecycle management.

### Config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `reduce` | `(state, action) => { state, effects }` | **required** | Pure state machine — takes state + action, returns new state + effects |
| `execute` | `(effect, app) => void` | **required** | Side effect handler — API calls, timers, logging |
| `persist` | `boolean` | `true` | Auto-persist state to Deno.Kv |
| `persistKey` | `string` | `"state"` | Key used in Deno.Kv |
| `getDBState` | `(state) => any` | identity | Filter state before persisting (strip transient data) |
| `getUIState` | `(state) => any` | identity | Filter state before sending to UI (strip secrets) |
| `port` | `number` | `8000` | HTTP/WS server port |
| `baseDir` | `string` | `./src` | Directory for static files and App.tsx (resolved to absolute path). **Note:** all files in this directory are publicly accessible via HTTP |
| `ui.electron` | `boolean` | `true` | Open Electron window on start |
| `ui.keepAlive` | `boolean` | `false` | Keep server running after Electron window closes |
| `ui.title` | `string` | deno.json `"title"` or `"AIO App"` | Browser/Electron window title. Precedence: CLI `--title=` > config > deno.json `"title"` > `"AIO App"` |
| `ui.width` | `number` | `800` | Electron window width |
| `ui.height` | `number` | `600` | Electron window height |

## `msg(type, payload?)`

Creates `{ type, payload }` objects — the universal message shape used by both actions and effects.

```ts
msg("INCREMENT")                    // { type: "INCREMENT", payload: {} }
msg("INCREMENT", { by: 5 })        // { type: "INCREMENT", payload: { by: 5 } }
```

Fully typed — the `type` string is preserved as a literal type for exhaustive switch matching.

## `UnionOf<T>`

Derives a union type from an object of creator functions. Skips non-function members (the `T` constants).

```ts
const A = {
  ...T,
  Increment: (by = 1) => msg(T.INCREMENT, { by }),
  Reset: () => msg(T.RESET),
} as const

type Action = UnionOf<typeof A>
// = { type: "INCREMENT"; payload: { by: number } }
// | { type: "RESET"; payload: Record<string, never> }
```

## Actions pattern

Actions are sync messages from the UI that trigger state changes. They follow this pattern:

```ts
import { msg, type UnionOf } from 'aio'

// 1. Type constants — UPPER_CASE strings
const T = {
  DO_THING: "DO_THING",
} as const

// 2. Creator object — spreads constants + adds factory functions
export const A = {
  ...T,                                    // A.DO_THING === "DO_THING" (for switch cases)
  DoThing: (x: number) => msg(T.DO_THING, { x }), // A.DoThing(5) (for dispatching)
} as const

// 3. Union type — for function signatures
export type Action = UnionOf<typeof A>
```

**Why this pattern?**
- `A.DO_THING` — string constant for `switch/case` matching
- `A.DoThing(x)` — typed creator for dispatching
- `as const` — ensures literal types flow through
- One object for both — no separate enum + creator files

## Effects pattern

Effects are async side effects the reducer wants to happen. Same `msg` pattern as actions, but different purpose:

- **Actions** = "what happened" (user clicked, timer fired) → sync state change
- **Effects** = "what should happen next" (call API, start timer, log) → async side effect

```ts
import { msg, type UnionOf } from 'aio'

const T = {
  FETCH_USER: "FETCH_USER",
  LOG: "LOG",
} as const

export const E = {
  ...T,
  FetchUser: (id: string) => msg(T.FETCH_USER, { id }),
  Log: (message: string) => msg(T.LOG, { message }),
} as const

export type Effect = UnionOf<typeof E>
```

Effects are returned by the reducer, not dispatched from UI:

```ts
// in reduce.ts
case A.LOAD_PROFILE:
  d.loading = true
  return [E.FetchUser(action.payload.userId)]  // ← effect
```

Then handled in `execute.ts`:

```ts
export function execute(effect: Effect, app: AioApp<AppState, Action>): void {
  switch (effect.type) {
    case E.FETCH_USER:
      fetch(`/api/users/${effect.payload.id}`)
        .then(r => r.json())
        .then(user => app.dispatch(A.UserLoaded(user)))  // ← dispatch back into the loop
      break
  }
}
```

The `app` parameter in `execute` gives you `dispatch` (to fire follow-up actions) and `getState` (to read current state).

**Parameter order:** `execute(effect, app)` — reads as "execute this effect on this app". Note this is the inverse of `reduce(state, action)` where the container comes first — the reducer *receives* state, but the executor *acts on* an effect.

## `draft(state, fn)`

Immer-powered immutable update. Mutate the draft, return effects.

```ts
import { draft } from 'aio'

return draft(state, d => {
  d.counter += 1           // mutate the draft (looks mutable, produces immutable result)
  d.lastUpdated = Date.now()
  return [E.Log("done")]   // return effects array (can be empty: return [])
})
// Returns: { state: <new immutable state>, effects: [{ type: "LOG", ... }] }
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
  return <button onClick={() => send(A.Increment())}>+</button>
}
```

**Details:**
- `state: S | null` — `null` until WebSocket connects and server sends initial state
- `send(action)` — sends action to server via WebSocket. If called before WS is ready, actions are queued and flushed on connect
- **Singleton** — all `useAio()` calls share a single WebSocket connection per page. Call it from any component — no prop drilling, no duplicate connections
- Auto-reconnects on disconnect with exponential backoff (1s → 2s → 4s → 8s max)
- Connection is cleaned up when the last subscribed component unmounts
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
        <button onClick={() => send(A.Navigate('home'))}>Home</button>
        <button onClick={() => send(A.Navigate('settings'))}>Settings</button>
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
| `--debug` | Verbose logging — actions, state, effects, WS, HTTP, persistence |
| `--prod` | Force prod mode — serve pre-built `dist/app.js` (auto-detected when `dist/app.js` exists) |

**Precedence:** CLI flags > config object > defaults

Active flags are logged on startup:
```
[12:00:00][INFO] ✓ state (1 keys) · reduce · execute · App.tsx
[12:00:00][INFO] cli: --port=3000 --no-electron
[12:00:00][INFO] running at http://localhost:3000 (dev, browser)
```

### Debug mode

`--debug` logs the entire pipeline in real time:

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

- `action → reduce:` = action entering the reducer
- `effect → execute:` = effect about to be executed
- `ws:` = WebSocket connections/messages
- `http:` = static file requests
- `persist:` = KV read/write
- `state:` = changed keys after each action (e.g. `state: changed [counter]`)
- `broadcast →` = state pushed to N clients
- `watch:` = file change detected in baseDir
- `reload →` = live reload signal sent to N clients

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
- `⚠` **Warnings** (app starts but may not work): App.tsx has no default export
- `·` **Hints** (suggestions): leftover `createRoot`, `import React`, old `'../dep/aio/'` imports, electron missing `deno approve-scripts`

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

**Works with:**
- TSX/TS changes (component code, actions, effects)
- CSS changes (via `<link>` tags)
- Any file in `baseDir`

**No configuration needed** — live reload is always on. There's no flag to disable it because it has zero cost (just a filesystem watcher).

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

Three modes: dev (live-transpile), compile (standalone binary), compile:electron (AppImage).

### Dev mode

```sh
deno task dev
```

Live-transpiles `.ts`/`.tsx` via esbuild on each request. React loaded from CDN via import map. File watcher auto-reloads the browser on save. Error overlay shows transpile errors. Opens Electron or browser.

### Compile (browser-only binary)

```sh
deno task compile
```

Bundles `src/App.tsx` + React + useAio into a fully self-contained `dist/app.js` (no CDN dependency), then runs `deno compile` to produce a standalone binary (~95MB). Dev-only packages (electron, esbuild, react, react-dom) are excluded from the binary automatically.

The binary name comes from deno.json `"title"` (lowercased, spaces→hyphens). Override with `--name=`:

```sh
./my-app                       # binary name derived from title "My App"
./my-app --port=3000           # custom port
deno run -A dep/aio/src/build.ts --compile --name=custom   # override
```

### Compile with Electron (AppImage)

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

### CSS in builds

If `src/style.css` exists, it's automatically:
- **Dev:** served from `src/` and injected as `<link>` in HTML
- **Compile:** copied to `dist/style.css` and included in the binary

### How exclusion works

The build script temporarily removes dev-only symlinks from `node_modules/` and passes `--exclude` flags to `deno compile` for the big directories (electron ~254MB, esbuild ~11MB, react ~5MB). Symlinks are restored after compile, even on failure.

## Limitations

- **State must be JSON-serializable** — no classes, functions, Dates, Uint8Arrays, or circular references
- **No CSS imports in TS** — use `src/style.css` (auto-injected) or `<link>` tags, not `import './style.css'`
- **Single CSS entry point** — only `src/style.css` is auto-detected. Use `@import` inside it for multiple files
- **`$p` and `$d` are reserved** — don't use `$p` or `$d` as top-level keys in your state (used internally for delta patches and key deletion)

## File reference

### Framework (`dep/aio/`)

| File | Purpose |
|------|---------|
| `dep/aio/mod.ts` | Public API — all `'aio'` imports resolve here (Deno-side), type declarations for browser-only functions |
| `dep/aio/src/aio.ts` | Core runtime — `aio.run()`, dispatch loop, deep merge, KV path resolution, startup linter |
| `dep/aio/src/browser.ts` | Browser-side module — `useAio`, `useLocal`, `msg`, `page` (transpiled for dev, bundled for prod) |
| `dep/aio/src/server.ts` | HTTP + WebSocket server, TSX transpilation (dev), static serving (prod), delta broadcasting |
| `dep/aio/src/build.ts` | Build script — bundles App.tsx + React, compiles binary, AppImage packaging |
| `dep/aio/src/msg.ts` | Shared `msg()` constructor — used by mod.ts (server) and browser.ts (client) |
| `dep/aio/src/skv.ts` | Thin Deno.Kv wrapper — `set`/`get`/`del`/`close` with string keys |
| `dep/aio/src/electron.ts` | Electron launcher — $ELECTRON_PATH, packaged binary, or dev fallback |

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
