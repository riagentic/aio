```
  _v_
 (o>o)  ☠ aio
  )/   seven files to production
 /|
```

Full-stack TypeScript framework for [Deno](https://deno.com) 2.6+ — one function call boots a server, WebSocket, React UI, and persistent state.

```
 send(action) ──→ reduce(state, action) ──→ { state, effects }
                         │                        │
                    persist (Kv)          execute side effects
                         │
                  broadcast (WS delta)
                         │
                    all UIs update
```

- **One entry point** — `aio.run(state, config)` starts everything
- **Elm architecture** — state → actions → reducer → effects, fully typed
- **Real-time sync** — WebSocket with delta patches, multi-tab support
- **Live reload** — file watcher, instant refresh, error overlay
- **State persistence** — automatic Deno.Kv, deep merge on restart
- **Ship anywhere** — standalone binary, Electron AppImage, or Android APK

## Quickstart

**New project** — scaffolds with interactive template menu:

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/init.sh)" -- my-app
cd my-app
deno task dev
```

Installs Deno automatically if not present. Choose from 4 templates (empty → full architecture).

**Or clone the demo** — counter app that ships with the framework:

```sh
git clone https://github.com/riagentic/aio.git
cd aio && deno install && deno task dev
```

Opens `http://localhost:8000`. State persists across restarts. Open multiple tabs — they stay in sync.

## The 7 files

```
src/
  state.ts      ← state shape + initial values
  actions.ts    ← action types + creators
  effects.ts    ← effect types + creators
  reduce.ts     ← (state, action) → { state, effects }
  execute.ts    ← runs side effects
  App.tsx       ← React component
  app.ts        ← entry point (4 lines)
  style.css     ← (optional) auto-injected
```

### state.ts — define your state

```ts
export type AppState = { counter: number }
export const initialState: AppState = { counter: 0 }
```

### actions.ts — messages from UI

```ts
import { actions, type UnionOf } from 'aio'

export const A = actions({
  Increment: (by = 1) => ({ by }),
  Decrement: (by = 1) => ({ by }),
  Reset: () => ({}),
})

export type Action = UnionOf<typeof A>
```

`A.Increment` is a label (`"Increment"`) for switch/case. `A.increment(5)` is a creator: `{ type: "Increment", payload: { by: 5 } }`. One object, both uses.

### effects.ts — side effects the reducer can trigger

```ts
import { effects, type UnionOf } from 'aio'

export const E = effects({
  Log: (message: string) => ({ message }),
})

export type Effect = UnionOf<typeof E>
```

Same pattern as actions — `E.Log` label + `E.log()` creator.

### reduce.ts — pure function, returns new state + effects

```ts
import type { AppState } from './state.ts'
import { A, type Action } from './actions.ts'
import { E, type Effect } from './effects.ts'
import { draft } from 'aio'

export function reduce(state: AppState, action: Action): { state: AppState; effects: Effect[] } {
  return draft(state, d => {
    switch (action.type) {
      case A.Increment:
        d.counter += action.payload.by
        return [E.log(`incremented to ${d.counter}`)]
      case A.Decrement:
        d.counter -= action.payload.by
        return [E.log(`decremented to ${d.counter}`)]
      case A.Reset:
        d.counter = 0
        return []
      default:
        return []
    }
  })
}
```

`draft()` is Immer under the hood — mutate the draft, get an immutable result. Return effects array (or `[]` for none).

### execute.ts — runs effects server-side

```ts
import { E, type Effect } from './effects.ts'
import type { AppState } from './state.ts'
import type { Action } from './actions.ts'
import type { AioApp } from 'aio'

export function execute(app: AioApp<AppState, Action>, effect: Effect): void {
  switch (effect.type) {
    case E.Log:
      console.log(effect.payload.message)
      break
  }
}
```

The `app` parameter gives you `dispatch()` for follow-up actions and `getState()` to read current state.

### App.tsx — React component

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
      <button onClick={() => send(A.decrement())}>-</button>
      <button onClick={() => send(A.reset())}>Reset</button>
      <button onClick={() => send(A.increment())}>+</button>
    </div>
  )
}
```

No `import React`. No `createRoot`. No WebSocket setup. Just `export default` and `useAio()`.

> `useAio()` is a singleton — call it from any component, they all share one WebSocket. No prop drilling.

### app.ts — wire it up

```ts
import { aio } from 'aio'
import { initialState } from './state.ts'
import { reduce } from './reduce.ts'
import { execute } from './execute.ts'

await aio.run(initialState, { reduce, execute })
```

That's it. Ship it.

## Browser API

All from `import { ... } from 'aio'` — same import on server and browser.

| Function | Returns | Purpose |
|------|---------|---------|
| `useAio<S>()` | `{ state, send }` | Server state via WebSocket. `state` is `null` until connected. Auto-reconnects. |
| `useLocal<T>(init)` | `{ local, set }` | Client-only state — not synced, not persisted. For form inputs, UI toggles. |
| `page(key, routes)` | `JSX.Element \| null` | State-based routing. `page(state.page, { home: Home, settings: Settings })` |
| `connectCli<S>(url)` | `CliApp<S>` | Terminal WS client — same as `useAio` but for Deno CLI apps. |
| `msg(type, payload?)` | `{ type, payload }` | Message constructor. Available browser-side for inline dispatching. |

## CLI flags

`aio.run()` reads CLI args automatically — no parsing code needed.

```sh
deno task dev --port=3000 --no-electron --verbose
```

| Flag | Effect |
|------|--------|
| `--port=N` | Override server port (default: 8000) |
| `--no-electron` | Skip Electron, open browser |
| `--no-persist` | Disable Deno.Kv persistence |
| `--keep-alive` | Server survives Electron close |
| `--title=X` | Override window/page title |
| `--width=N` | Electron window width (default: 800) |
| `--height=N` | Electron window height (default: 600) |
| `--verbose` | Verbose logging (actions, state, effects, WS, HTTP) |
| `--prod` | Serve pre-built `dist/app.js` instead of live-transpiling |
| `--expose` | Bind `0.0.0.0` + generate auth token for LAN sharing |
| `--headless` | Server-only — no browser/Electron (for CLI apps) |
| `--url=URL` | Thin client — Electron connecting to a remote aio server |
| `--version` | Print version and exit |
| `--help` | Show available flags and exit |

Time-travel and the control API are always active in dev mode — no flags needed.

## Build & ship

Build targets: `compile:<shell>:<topology>` — shell (browser/electron/cli/android/service) × topology (local/remote).

```sh
deno task dev                       # dev — live-transpile, file watcher, error overlay
deno task compile                   # standalone binary (~95MB), opens browser
deno task compile:browser:remote    # exposed server + systemd unit (0.0.0.0 + auth)
deno task compile:electron          # desktop AppImage (~137MB), fully offline
deno task compile:electron:remote   # thin client AppImage — connect to any aio server
deno task compile:cli               # headless server + CLI app binary
deno task compile:cli:remote        # client-only CLI binary (no server)
deno task compile:android           # standalone APK with WebView
deno task compile:android:remote    # client APK — connect page, no local dispatch
deno task compile:service           # headless binary + systemd unit (127.0.0.1)
deno task compile:service:remote    # headless exposed server + systemd (0.0.0.0 + auth)
```

Binary name comes from `deno.json` `"title"` (lowercased, spaces → hyphens):

```sh
./aio-counter                        # compiled binary
./aio-counter --port=3000            # CLI flags work in compiled mode too
./aio-counter-x86_64.AppImage       # Electron AppImage
```

State in compiled mode persists to `~/.local/share/<app-name>/data.kv`.

## am — app manager

Manage your aio app without `ps`, `kill`, or `curl`. Singleton enforced — one instance per project.

```sh
deno task am start                # start app (kills zombies, refuses if running)
deno task am status               # stopped|starting|started|stopping
deno task am state                # full state JSON
deno task am state fleet.0.stats  # dot-path into nested data
deno task am dispatch Increment by=1  # send action
deno task am tt undo              # time-travel: undo last action
deno task am logs --filter=ERROR  # tail logs with filter
deno task am stop                 # graceful shutdown
```

Output auto-detects: terminal → pretty, piped → JSON. Override with `--json` or `--quiet`.

## More features

- **Multi-user auth** — per-user tokens, role-based state filtering via `getUIState(state, user?)`
- **Scheduled effects** — `schedule.after()`, `schedule.every()`, `schedule.cron()` as declarative effects
- **State snapshots** — `app.snapshot()` / `app.loadSnapshot(json)` + HTTP endpoints
- **SQLite persistence** — 3-tier column helpers, auto-sync arrays, ORM methods for large datasets
- **Time-travel** — undo/redo/goto/pause in dev mode, 200-entry history, zero cost in prod

## Limits & design decisions

aio is built for **stateful single-user/small-team apps** — dashboards, trading platforms, internal tools, desktop apps. It's not a general-purpose web framework. Here's what that means in practice:

### State persistence (Deno.Kv)

Deno.Kv has a **65KB per-value limit**. aio warns at 50KB and blocks writes above 63KB to prevent silent data loss. For large state:

- Use `getDBState` to filter what gets persisted (exclude caches, runtime data)
- Use `db: {}` (SQLite) for structured data — arrays auto-sync, ORM for CRUD, raw SQL for queries
- SQLite has no practical size limit and supports transactions via `app.db.transaction()`

### Connections

Default: **100 concurrent WebSocket clients** (configurable via `maxConnections`). Beyond that, new connections get 503. aio runs single-process, single-machine — designed for 1–50 users, not public-facing scale. Use Remix/Next/Fresh for that.

### Delta broadcasting

State changes are broadcast as delta patches (`$p` changed keys + `$d` deleted keys) when less than 50% of top-level keys changed. Otherwise, full state is sent. Configurable via `deltaThreshold` (0–1, default 0.5). Lower values = more deltas, less bandwidth; higher values = more full pushes, simpler client logic.

### Action interceptors

`beforeReduce(action, state)` lets you intercept, transform, or drop actions before they hit the reducer. Return the action (possibly modified) to continue, or `null` to drop it. Use for throttling, deduplication, or access control.

### Deep merge on restore

On restart, persisted state is deep-merged with `initialState`. Arrays are **replaced** (not concatenated), new keys from `initialState` are added, old keys in persisted state are kept. Use `onRestore(state)` for migrations or manual fixups when your state shape changes between versions.

### Effect handling

`execute(app, effect)` receives the full effect union. For small apps, switch/case works fine. At scale (40+ effect types), use `matchEffect()` for typed dispatch:

```ts
import { matchEffect } from 'aio'
matchEffect(effect, {
  Log: (p) => console.log(p.message),
  Fetch: (p) => fetch(p.url).then(...)
})
```

### structuredClone on effects

Effects are cloned after every reduce to prevent Immer draft reference leaks. This is a deliberate safety tradeoff — without it, effects built inside `draft()` can crash at runtime when draft proxies get revoked. The performance cost is real but the alternative (random crashes in production) is worse.

### `getUIState` returns `unknown`

Intentional — UI state may be a security-filtered subset of server state, with a different shape than `S`. The type system can't verify this boundary, so `unknown` forces explicit typing on the client side via `useAio<YourUIType>()`.

## Docs

- [`dep/aio/quickstart.md`](dep/aio/quickstart.md) — start a new app from scratch
- [`dep/aio/migration.md`](dep/aio/migration.md) — adopt aio into an existing app
- [`dep/aio/upgrade.md`](dep/aio/upgrade.md) — upgrade between aio versions
- [`dep/aio/manual.md`](dep/aio/manual.md) — full API reference

## Thanks

To God and Jesus Christ — for everything, always.

To the brave ones who try it early — enjoy!

## License

MIT
