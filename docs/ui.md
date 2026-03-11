# UI & Browser

React hooks, components, styling, DevTools, and browser-side concerns.

For the docs index, see [manual.md](manual.md). For the core API (`feature`, `reactive`, `useFeature`), see [core.md](core.md). For Electron & thin client, see [electron.md](electron.md).

## `useAio<S>()` — full state hook

> **v0.5+ apps:** Prefer [`useFeature(ref)`](core.md#usefeatureref--react-hook-for-features) — it gives you scoped state, typed `send`, machine `status`, and only re-renders when your feature's slice changes. Use `useAio()` when you need the full state tree or multiple features in one component.

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
3. Delta patches are computed per client — each client has its own delta cache. For v0.5 namespaced state, patches are granular to sub-keys within feature slices (e.g. only `scrollY` is sent, not the entire feature)
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

See [electron.md](electron.md) for the full reference — setup, configuration, window persistence, thin client, and window metadata.

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
