# ⚡ aio

**Seven files to production**

*all-in-one framework, pronounced "eye-oh"*

Full-stack TypeScript framework for Deno — one function call boots a server, WebSocket, React UI, and persistent state.

## What you get

- 🎯 **One entry point** — `aio.run(state, config)` starts everything
- 💾 **State persistence** — automatic Deno.Kv with deep merge on restart
- 🔄 **Real-time sync** — WebSocket with delta patches, multi-tab/multi-client
- 🔥 **Live reload** — file watcher + instant browser refresh, error overlay on syntax errors
- 🧩 **Elm-like architecture** — state → actions → reducer → effects, fully typed
- 🖥️ **Electron or browser** — auto-detects Electron, falls back to browser
- 📦 **Single binary** — `deno compile` to standalone executable (~95MB)
- 🐧 **AppImage** — `compile:electron` packages everything into a portable Linux app

## 🚀 Quickstart

Requires [Deno 2.6+](https://deno.land).

**Try the demo** — run the included counter app:

```sh
git clone https://github.com/riagentic/aio.git
cd aio
deno install
deno task dev
```

Opens `http://localhost:8000` in your browser (or an Electron window if installed). State persists across restarts. Open multiple tabs — they stay in sync.

**Start your own app** — grab the framework, build from scratch:

```sh
git clone --depth 1 https://github.com/riagentic/aio.git my-app
cd my-app
rm -rf .git src && mkdir src
git init
deno install
```

This gives you `dep/aio/` (the framework) and `deno.json` (pre-configured imports and tasks). Update `"title"` in `deno.json`, then create the [7 files](#-the-7-files-you-write) in `src/` — the code walkthrough below shows exactly what goes in each one.

## 🏗️ Architecture

```
┌──────────────────────────────────────────────┐
│  Browser / Electron                          │
│                                              │
│  App.tsx → useAio() ──── WebSocket ──→ server│
│            state ←──────────────── broadcast │
│            send(action) ────────→ dispatch   │
└──────────────────────────────────────────────┘
                                     │
┌──────────────────────────────────────────────┐
│  Deno Server (aio.run)                       │
│                                              │
│  dispatch(action)                            │
│    → reduce(state, action) → { state, fx }   │
│    → persist to Deno.Kv                      │
│    → broadcast to all UIs (delta patches)    │
│    → execute each effect                     │
└──────────────────────────────────────────────┘
```

1. User clicks button → `send(action)` → WebSocket → server
2. Server calls `reduce(state, action)` → new state + effects
3. State persisted to Deno.Kv, broadcast to all connected UIs
4. Effects execute — may dispatch follow-up actions

## 📁 The 7 files you write

```
src/
  app.ts        ← entry point (4 lines)
  state.ts      ← state shape + initial values
  actions.ts    ← action type constants + creators
  effects.ts    ← effect type constants + creators
  reduce.ts     ← (state, action) → { state, effects }
  execute.ts    ← runs side effects
  App.tsx       ← React component (default export)
  style.css     ← (optional) auto-injected
```

| File | What it does |
|------|-------------|
| `state.ts` | Defines `AppState` type and `initialState` — single source of truth |
| `actions.ts` | Messages from UI → server. Type constants + typed creators (`A.Increment()`) |
| `effects.ts` | Side effects returned by reducer. Same pattern as actions (`E.Log()`) |
| `reduce.ts` | Pure function: state + action → new state + effects array |
| `execute.ts` | Runs effects — API calls, logging, timers. Gets `app.dispatch` for follow-ups |
| `App.tsx` | React component. `export default`, use `useAio()` hook, done |
| `app.ts` | Wires it all together: `await aio.run(initialState, { reduce, execute })` |

## 🔍 Code walkthrough

Real code from the counter app in `src/`.

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

`A.INCREMENT` gives you the string for `switch/case`. `A.Increment(5)` gives you a typed message for dispatching. One object, both uses.

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

`draft()` is Immer under the hood — mutate the draft, get an immutable result. Return effects array (or `[]` for none).

### execute.ts

```ts
import { E, type Effect } from './effects.ts'
import type { AppState } from './state.ts'
import type { Action } from './actions.ts'
import type { AioApp } from 'aio'

export function execute(effect: Effect, app: AioApp<AppState, Action>): void {
  switch (effect.type) {
    case E.LOG:
      console.log(effect.payload.message)
      break
  }
}
```

Effects run server-side. The `app` parameter gives you `dispatch()` for follow-up actions and `getState()` to read current state.

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
      <button onClick={() => send(A.Decrement())}>-</button>
      <button onClick={() => send(A.Reset())}>Reset</button>
      <button onClick={() => send(A.Increment())}>+</button>
    </div>
  )
}
```

No `import React`. No `createRoot`. No WebSocket setup. Just `export default` and `useAio()`.

> `useAio()` is a singleton — call it from any component, they all share one WebSocket. No prop drilling needed.

### app.ts

```ts
import { aio } from 'aio'
import { initialState } from './state.ts'
import { reduce } from './reduce.ts'
import { execute } from './execute.ts'

await aio.run(initialState, { reduce, execute })
```

That's it. Ship it. 🚀

## 🪝 Browser hooks

All from `import { ... } from 'aio'` — same import on server and browser, different runtimes.

| Hook | Returns | Purpose |
|------|---------|---------|
| `useAio<S>()` | `{ state, send }` | Connect to server state via WebSocket. `state` is `null` until connected. Auto-reconnects with backoff. Singleton — safe to call from any component (one WS per page). |
| `useLocal<T>(init)` | `{ local, set }` | Client-only state — not synced, not persisted. For form inputs, UI toggles, ephemeral stuff. |
| `page(key, routes)` | `JSX.Element \| null` | State-based routing. `page(state.page, { home: Home, settings: Settings })` |
| `msg(type, payload?)` | `{ type, payload }` | Message constructor — same one used in actions/effects. Available browser-side too. |

## 🎛️ CLI flags

`aio.run()` reads `Deno.args` automatically — no parsing code needed.

```sh
deno task dev --port=3000 --no-electron --debug
```

| Flag | Effect |
|------|--------|
| `--port=N` | Override server port (default: 8000) |
| `--no-electron` | Skip Electron, open browser |
| `--no-persist` | Disable Deno.Kv persistence |
| `--keep-alive` | Server survives Electron close |
| `--title=X` | Override window/page title |
| `--debug` | Verbose logging — actions, state, effects, WS, HTTP |
| `--prod` | Serve pre-built `dist/app.js` instead of live-transpiling |

## 🚢 Build & ship

```sh
deno task dev                # dev — live-transpile, file watcher, error overlay
deno task compile            # standalone binary (~95MB), browser-only
deno task compile:electron   # AppImage with Electron (~137MB), fully offline
```

Binary name comes from `deno.json` `"title"` (lowercased, spaces → hyphens):

```sh
./aio-counter                        # compiled binary
./aio-counter --port=3000            # CLI flags work in compiled mode too
./aio-counter-x86_64.AppImage       # Electron AppImage
```

State in compiled/AppImage mode persists to `~/.local/share/<app-name>/data.kv`.

## 📖 Docs

Full reference (config options, persistence, delta patches, error overlay, build internals): [`dep/aio/aio-manual.md`](dep/aio/aio-manual.md)

## Thanks

To God and Jesus Christ — for everything, always.

To the brave ones who try it at v0.1 — enjoy! 🚀

Built with [Claude](https://claude.ai) by [Anthropic](https://anthropic.com), under my humble supervision.

## License

MIT
