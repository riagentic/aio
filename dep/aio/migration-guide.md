# AIO Migration Guide

You are integrating AIO into an existing Deno application. AIO gives you a persistent backend (Deno.Kv), WebSocket server, and React UI from a single `aio.run()` call. Read this guide top to bottom, then follow the steps.

For full API reference, see `dep/aio/aio-manual.md`.

---

## What AIO does

One function boots everything:
```
aio.run(initialState, { reduce, execute }) →
  Deno.Kv persistence + HTTP/WS server + React UI (Electron or browser)
```

Data flow: **UI → action → reduce → new state + effects → persist → broadcast → execute effects**

- **Actions** = sync messages from UI that change state (user clicked, typed, etc.)
- **Effects** = async side effects the reducer wants (API calls, timers, logging)
- **State** = single object, persisted automatically, broadcast to all connected UIs
- **Live reload** = file watcher auto-refreshes browser on save (no state loss)
- **Error overlay** = transpile errors shown on page, auto-recovers on fix

## Prerequisites

- Deno 2.6+
- The `dep/aio/` folder must be in your project (linked or copied)

## dep/aio/ structure

```
dep/aio/
  mod.ts              ← public API entry (all imports resolve here)
  aio-manual.md       ← full API reference
  migration-guide.md  ← this file
  src/
    aio.ts            ← core runtime: aio.run(), dispatch loop, deep merge, startup linter, CLI flags
    browser.ts        ← browser-side: useAio, useLocal, msg, page (transpiled for dev, bundled for prod)
    server.ts         ← HTTP + WebSocket server, TSX transpilation (dev) / static serving (prod), delta broadcast
    build.ts          ← build script: bundle App.tsx + React, compile binary, AppImage packaging
    skv.ts            ← thin Deno.Kv wrapper (set/get/del/close with string keys)
    electron.ts       ← Electron launcher ($ELECTRON_PATH, packaged binary, dev fallback)
```

Users only import from `'aio'` — never from `dep/aio/src/` directly.

---

## Step 1: Update deno.json

Merge these into your existing `deno.json`:

```jsonc
{
  "title": "My App",               // app name — used for window title and binary name
  "unstable": ["kv"],
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "jsxImportSourceTypes": "@types/react"
  },
  "imports": {
    // ADD these — keep your existing imports
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

Key points:
- `"title"` — app display name, also used as binary name when compiling (lowercased, spaces→hyphens)
- `"aio"` must point to `./dep/aio/mod.ts`
- `"esbuild"` — required for dev mode TSX transpilation (excluded from compiled binary automatically)
- `"unstable": ["kv"]` is required for persistence
- `compilerOptions` are required for JSX type checking in editor
- Then run `deno install`

## Step 2: Create src/ files

You need 7 files. Here's the minimal version of each — adapt to your app's domain.

### src/state.ts — State shape

Define your state type and initial values. This is the single source of truth.

```ts
export type AppState = {
  // your state fields here
}

export const initialState: AppState = {
  // initial values
}
```

Rules:
- Must be a plain object (not a class, not null)
- Nested objects are supported — persistence uses deep merge on restart (new fields preserved, removed keys dropped)
- Avoid `$p` and `$d` as top-level keys (reserved for delta patches and key deletion)
- This type is used everywhere: reducer, executor, UI

### src/actions.ts — UI actions

Actions are sync messages the UI sends to change state. Use `msg()` to create typed `{ type, payload }` objects.

```ts
import { msg, type UnionOf } from 'aio'

// Private type constants — UPPER_CASE
const T = {
  DO_THING: "DO_THING",
  ANOTHER: "ANOTHER",
} as const

// Public action object — type strings + creator functions
export const A = {
  ...T,
  DoThing: (x: number) => msg(T.DO_THING, { x }),
  Another: () => msg(T.ANOTHER),
} as const

export type Action = UnionOf<typeof A>
```

Pattern:
- `T` = private type string constants
- `A` = public object with both `...T` (for switch cases) and creators (for dispatching)
- `A.DO_THING` = string `"DO_THING"` (use in `switch/case`)
- `A.DoThing(5)` = `{ type: "DO_THING", payload: { x: 5 } }` (use in UI `send()`)
- `UnionOf<typeof A>` = union of all creator return types

### src/effects.ts — Side effects

Same pattern as actions, but these are returned by the reducer and executed server-side.

```ts
import { msg, type UnionOf } from 'aio'

const T = {
  FETCH_DATA: "FETCH_DATA",
  LOG: "LOG",
} as const

export const E = {
  ...T,
  FetchData: (url: string) => msg(T.FETCH_DATA, { url }),
  Log: (message: string) => msg(T.LOG, { message }),
} as const

export type Effect = UnionOf<typeof E>
```

### src/reduce.ts — Reducer

Pure function: takes state + action, returns new state + effects array. Uses `draft()` for immutable updates with mutable syntax.

```ts
import type { AppState } from './state.ts'
import { A, type Action } from './actions.ts'
import { E, type Effect } from './effects.ts'
import { draft } from 'aio'

export function reduce(state: AppState, action: Action): { state: AppState; effects: Effect[] } {
  return draft(state, d => {
    switch (action.type) {
      case A.DO_THING:
        d.someField = action.payload.x  // mutate the draft (immutable under the hood)
        return [E.Log(`did thing: ${action.payload.x}`)]  // return effects
      default:
        console.warn(`unknown action: ${(action as { type: string }).type}`)
        return []  // always return an array
    }
  })
}
```

Rules:
- Always return `E[]` from the draft callback (empty `[]` if no effects)
- Never do async work here — that's what effects are for
- The `d` parameter is an Immer draft: mutate it like normal JS, get immutable result
- Add a `default` case with `console.warn` to catch typos

### src/execute.ts — Effect executor

Runs side effects. This is where async work happens (API calls, timers, etc.).

```ts
import { E, type Effect } from './effects.ts'
import type { AppState } from './state.ts'
import type { Action } from './actions.ts'
import type { AioApp } from 'aio'

export function execute(effect: Effect, app: AioApp<AppState, Action>): void {
  switch (effect.type) {
    case E.FETCH_DATA:
      fetch(effect.payload.url)
        .then(r => r.json())
        .then(data => {
          // dispatch a follow-up action back into the reduce loop
          // (you'd define A.DataLoaded in actions.ts)
          app.dispatch({ type: 'DATA_LOADED', payload: { data } })
        })
        .catch(e => console.error('fetch failed:', e))
      break
    case E.LOG:
      console.log(effect.payload.message)
      break
  }
}
```

Key:
- Signature is `execute(effect, app)` — reads as "execute this effect on this app"
- `app.dispatch(action)` sends a new action back into reduce (for async results)
- `app.getState()` reads current state
- Handle errors in effects — don't let them throw

### src/App.tsx — React UI

Default export, uses `useAio()` hook. No React import needed, no createRoot, no WebSocket code.

```tsx
import { useAio } from 'aio'
import { A } from './actions.ts'
import type { AppState } from './state.ts'

export default function App() {
  const { state, send } = useAio<AppState>()
  if (!state) return <div>Connecting...</div>

  return (
    <div>
      <h1>{state.someField}</h1>
      <button type="button" onClick={() => send(A.DoThing(42))}>Do it</button>
    </div>
  )
}
```

Rules:
- Must be `export default` (framework mounts it automatically)
- `state` is `null` until WebSocket connects — always handle the loading case
- `send(action)` sends to server — use action creators for type safety
- No `import React` needed (automatic JSX transform)
- Actions queued before WS connect are flushed automatically
- WS auto-reconnects on disconnect
- `useAio()` is a **singleton** — call it from any component, they all share one WebSocket. No need to prop-drill `state`/`send` through the tree

### src/app.ts — Entry point

Wire everything together. This is what you run.

```ts
import { aio } from 'aio'
import { initialState } from './state.ts'
import { reduce } from './reduce.ts'
import { execute } from './execute.ts'

await aio.run(initialState, {
  reduce,
  execute,
  ui: { title: 'My App' },
})
```

Optional config (all have sensible defaults):
```ts
await aio.run(initialState, {
  reduce,
  execute,
  persist: true,              // auto Deno.Kv (default: true)
  persistKey: 'state',        // KV key (default: "state")
  getDBState: (s) => s,       // filter what's persisted (default: full state)
  getUIState: (s) => s,       // filter what's sent to browser (default: full state)
  port: 8000,                 // server port (default: 8000)
  baseDir: './src',           // where App.tsx lives (resolved to absolute). All files here are publicly served!
  ui: {
    electron: true,           // open Electron window (default: true)
    keepAlive: false,         // keep server running after Electron closes (default: false)
    title: 'My App',          // window title (default: "AIO App")
    width: 800,               // Electron window width (default: 800)
    height: 600,              // Electron window height (default: 600)
  },
})
```

## Step 3: Run

```sh
deno task dev
```

CLI flags override config without code changes:
```sh
deno run -A src/app.ts --debug --no-electron --port=3000 --keep-alive
```

### Compile

```sh
deno task compile              # standalone binary (browser mode, ~95MB, fully offline)
deno task compile:electron     # AppImage with Electron (~137MB, fully offline)
```

## Live reload

Built-in — no config needed. The server watches `baseDir` (default: `src/`) for file changes and automatically reloads all connected browsers.

How it works:
1. `Deno.watchFs` detects `.ts`/`.tsx`/`.css` changes in `src/`
2. Transpile cache is invalidated for changed files
3. After 100ms debounce, server sends `__reload` to all WebSocket clients
4. Browser calls `location.reload()` — `useAio()` reconnects and gets current state instantly

Because state lives on the server, reload is free — no state loss, no HMR complexity. Edit a file, save, see it immediately.

## Error overlay

Syntax errors in `.ts`/`.tsx` files are shown directly on the page instead of a blank screen. No config needed.

- When a transpile fails, the error message is displayed in a dark-themed overlay in the browser
- The page stays connected via WebSocket — fix the error, save, and the page auto-reloads to the working version
- Works during the edit→save→reload cycle without manual browser refresh
- The `--debug` flag logs transpile errors server-side too

This means you never get a "blank white page with no clue what went wrong" during development.

---

## Migrating existing state/logic

If you already have application logic, here's how to map it to AIO:

| You have | AIO equivalent |
|----------|---------------|
| REST API endpoints | Actions (UI sends them via WebSocket, no HTTP needed) |
| Database reads/writes | `getDBState`/`getUIState` filters + auto Deno.Kv |
| Event handlers | Action creators in `actions.ts` |
| Business logic | `reduce.ts` (sync state changes) |
| API calls, async ops | `effects.ts` + `execute.ts` |
| React state + useEffect | Replace with `useAio()` — all state lives on server |
| Multiple useState hooks | Single `AppState` object + `useLocal()` for ephemeral UI state |
| WebSocket setup | Delete it — `useAio()` handles everything |
| createRoot / ReactDOM | Delete it — framework mounts `export default` from App.tsx |
| HMR / hot reload setup | Delete it — built-in live reload watches `src/`, no config needed |

### State lives on the server

The biggest mental shift: **all persistent state is server-side**. The UI is a pure view of server state. For ephemeral per-client concerns (which todo am I editing, form input focus, dropdown open/closed), use `useLocal()`:

```
BEFORE: Component → useState → fetch → setState → render
AFTER:  Component → useAio() → send(action) → server reduces → state broadcast → render
```

### Common patterns

**Async data loading:**
```ts
// actions.ts — add load + loaded actions
LoadUsers: () => msg(T.LOAD_USERS),
UsersLoaded: (users: User[]) => msg(T.USERS_LOADED, { users }),

// reduce.ts — set loading flag, return fetch effect
case A.LOAD_USERS:
  d.loading = true
  return [E.FetchUsers()]
case A.USERS_LOADED:
  d.loading = false
  d.users = action.payload.users
  return []

// execute.ts — do the fetch, dispatch result
case E.FETCH_USERS:
  fetch('/api/users').then(r => r.json()).then(users => app.dispatch(A.UsersLoaded(users)))
  break
```

**Timers / intervals:**
```ts
// execute.ts
case E.START_TIMER:
  setInterval(() => app.dispatch(A.Tick()), 1000)
  break
```

**Filtering what the browser sees** (hide secrets):
```ts
await aio.run(state, {
  reduce, execute,
  getUIState: (s) => ({ items: s.items, count: s.count }),  // s.apiKey stays server-only
})
```

---

## Checklist

- [ ] `dep/aio/` linked or copied into project
- [ ] `deno.json` updated with imports (including react/react-dom), compilerOptions, unstable
- [ ] `deno install` ran successfully
- [ ] `deno approve-scripts` + `deno install` again (if using Electron)
- [ ] `src/state.ts` — state type + initial values
- [ ] `src/actions.ts` — action creators with `msg()` + `UnionOf`
- [ ] `src/effects.ts` — effect creators with `msg()` + `UnionOf`
- [ ] `src/reduce.ts` — reducer using `draft()`, returns `{ state, effects }`
- [ ] `src/execute.ts` — effect executor with `app.dispatch()` for async results
- [ ] `src/App.tsx` — `export default` component using `useAio()`
- [ ] `src/app.ts` — entry point calling `aio.run()`
- [ ] `src/style.css` — (optional) auto-injected into HTML
- [ ] `deno task dev` runs and shows startup checks passing

## Styling

AIO auto-detects `src/style.css` and injects it into the HTML `<head>` automatically. No manual `<link>` tag needed.

**Option 1: `src/style.css`** (recommended) — create the file, it's auto-injected:
```css
/* src/style.css */
body { font-family: system-ui; margin: 0; }
.app { padding: 2rem; }
button { padding: 0.5rem 1rem; }
```
Use `@import` inside `style.css` to split into multiple files. Changes trigger live reload in dev mode. Automatically copied to `dist/` during builds.

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
    Button.tsx
```

```tsx
// src/App.tsx
import { useAio } from 'aio'
import { Header } from './components/Header.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import type { AppState } from './state.ts'

export default function App() {
  const { state, send } = useAio<AppState>()
  if (!state) return <div>Connecting...</div>

  return (
    <div style={{ display: 'flex' }}>
      <Sidebar items={state.items} onSelect={(id) => send(A.Select(id))} />
      <main>
        <Header title={state.title} />
        {/* ... */}
      </main>
    </div>
  )
}
```

```tsx
// src/components/Header.tsx — no useAio needed, just props
export function Header({ title }: { title: string }) {
  return <h1>{title}</h1>
}
```

**Guidelines:**
- `useAio()` is a singleton — call it from any component that needs state. No prop-drilling needed, no extra WebSocket connections
- Sub-components can either take props (pure view) or call `useAio()` directly (connected)
- Use `useLocal()` for ephemeral UI state (editing flags, input focus, dropdowns) — not app data
- All persistent/shared state goes through the server via actions

## Routing (state-based)

Use the `page()` helper with a page field in state:

```ts
// state.ts
export type AppState = {
  page: 'home' | 'settings' | 'detail'
  // ...
}
```

```ts
// actions.ts
Navigate: (page: string) => msg(T.NAVIGATE, { page }),
```

```tsx
// App.tsx
import { useAio, page } from 'aio'
import { Home } from './pages/Home.tsx'
import { Settings } from './pages/Settings.tsx'
import { Detail } from './pages/Detail.tsx'

export default function App() {
  const { state, send } = useAio<AppState>()
  if (!state) return <div>Connecting...</div>

  return (
    <div>
      <nav>
        <button type="button" onClick={() => send(A.Navigate('home'))}>Home</button>
        <button type="button" onClick={() => send(A.Navigate('settings'))}>Settings</button>
      </nav>
      {page(state.page, { home: Home, settings: Settings, detail: Detail })}
    </div>
  )
}
```

Page components call `useAio()` internally — since it's a singleton, each page shares the same WebSocket. No prop-drilling needed. This keeps routing in the same state flow as everything else — persisted, debuggable, synced across tabs.

## Limitations

- **State must be JSON-serializable** — no classes, functions, Dates, Uint8Arrays, or circular references. Use plain objects/arrays/strings/numbers/booleans/null
- **No CSS imports in TS** — use `src/style.css` (auto-injected) or `<link>` tags, not `import './style.css'`
- **`$p` and `$d` are reserved** — don't use `$p` or `$d` as top-level keys in your state (used internally for delta patches and key deletion)
- **Dev mode CDN** — React loaded from esm.sh in dev (first load needs internet). Compiled builds are fully offline

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `JSX.IntrinsicElements` type error | Check `compilerOptions` in deno.json, run `deno install` |
| Blank page in browser | Check startup log — missing App.tsx or no `export default`. Syntax errors show an overlay automatically |
| Actions do nothing | Check browser console + `--debug` log for WS messages |
| State resets on restart | `persist: true` (default) + `"unstable": ["kv"]` in deno.json |
| `import from '../dep/aio/'` error | Always use `import from 'aio'` — never relative paths |
| Port in use | Kill old process or use `--port=N` |
| Electron not found | `deno install npm:electron` then `deno approve-scripts` then `deno install` again. Or use `--no-electron` |
| Electron installed but no window | Run `deno approve-scripts` — electron's postinstall needs manual approval in Deno |
| Server dies when Electron closes | Use `--keep-alive` flag or `ui: { keepAlive: true }` in config |
| Build Error: could not find 'npm:esbuild' | Add `"esbuild": "npm:esbuild@^0.24"` to deno.json imports, then `deno install` |
