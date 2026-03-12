# Migrating to AIO

You have an existing Deno application and want to integrate AIO. This guide covers what to change and how to map your existing patterns.

## What AIO gives you

One function boots everything:
```
aio.run({ features: [...] }) →
  Deno.Kv persistence + HTTP/WS server + React UI (Electron or browser)
```

Data flow: **UI → action → machine guard → reduce → new state + effects → persist → broadcast → execute effects**

## Step 1: Add the framework

**Option A: Full toolchain** — scaffold with the one-liner, or download the `dep/aio/` folder from the [aio repo](https://github.com/riagentic/aio) into your project root.

**Option B: Library only** — `deno add @riagentic/aio` for the API without build tooling.

For the full experience (dev server, compile targets, app manager), use Option A.

## Step 2: Update deno.json

Merge these into your existing `deno.json`:

```jsonc
{
  "title": "My App",               // app name — window title + binary name
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
    "dev": "deno run -A src/app.ts",
    "am": "deno run -A dep/aio/src/am.ts",
    "test": "deno test -A --unstable-kv dep/aio/tests/",
    "compile": "deno run -A dep/aio/src/build.ts --compile",
    "compile:electron": "deno run -A dep/aio/src/build.ts --compile --electron",
    "compile:electron:remote": "deno run -A dep/aio/src/build.ts --compile --electron --remote",
    "compile:android": "deno run -A dep/aio/src/build.ts --android"
  }
}
```

Then run `deno install`.

## Step 3: Create features

Each domain concept is a **feature**. Start with `feature({ methods })` (simplest), add `generators` when you need step-level workflows, or use `feature({ actions, reduce })` for explicit control.

### Feature file: `src/features/counter/index.ts`

```ts
import { feature } from 'aio'

export const counter = feature('counter', {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) { s.count += by },
    decrement(s, by = 1) { s.count -= by },
    reset(s) { s.count = 0 },
  },
})
```

After `aio.run()`, call methods directly: `counter.increment(5)` — typed with autocomplete.

For features that need explicit actions, effects, and machines, use `feature()`:

```ts
import { feature } from 'aio'

export const counter = feature('counter', {
  state: { count: 0 },
  actions: {
    increment: (by = 1) => ({ by }),
    decrement: (by = 1) => ({ by }),
    reset:     () => ({}),
  },
  effects: {
    log: (message: string) => ({ message }),
  },
  machine: {
    initial: 'idle',
    states: {
      idle: { increment: 'idle', decrement: 'idle', reset: 'idle' },
    },
  },
  reduce: {
    increment(state, payload) {
      state.count += payload.by
    },
    decrement(state, payload) {
      state.count -= payload.by
    },
    reset(state) {
      state.count = 0
    },
  },
  execute: {
    log(_app, payload) {
      console.log(payload.message)
    },
  },
})
```

### UI: `src/App.tsx`

```tsx
import { useFeature } from 'aio'
import { counter } from './features/counter/index.ts'

export default function App() {
  const { state, send, status } = useFeature(counter)
  if (!state) return <div>Connecting...</div>

  return (
    <div>
      <h1>{state.count}</h1>
      <p>Status: {status}</p>
      <button onClick={() => send.decrement()}>-</button>
      <button onClick={() => send.reset()}>Reset</button>
      <button onClick={() => send.increment()}>+</button>
    </div>
  )
}
```

### Entry point: `src/app.ts`

```ts
import { aio } from 'aio'
import { counter } from './features/counter/index.ts'

await aio.run({ features: [counter] })
```

## Mapping existing patterns

| You have | AIO equivalent |
|----------|---------------|
| REST API endpoints | Actions (UI sends via WebSocket, no HTTP needed) |
| Database reads/writes | `stateForDB`/`stateForUI` filters + auto Deno.Kv |
| SQLite / shelling out to `sqlite3` | Built-in `app.db` — [3-tier SQLite](persistence.md#sqlite-persistence) |
| `setInterval` / `setTimeout` | Declarative `schedule.every` / `schedule.after` — [Scheduled effects](core.md#scheduled-effects) |
| cron jobs / external scheduler | `schedule.cron` — runs inside the process, no external deps |
| Event handlers | Action creators: `send.increment()` or `A.increment()` |
| Business logic | `reduce()` inside `feature()` (sync state changes) |
| API calls, async ops | `effects` + `execute()` inside `feature()` |
| React state + useEffect | Replace with `useFeature(f)` — all state lives on server |
| Multiple useState hooks | Feature state + `useLocal()` for ephemeral UI state |
| WebSocket setup | Delete it — `useFeature()` handles everything |
| createRoot / ReactDOM | Delete it — framework mounts `export default` from App.tsx |
| HMR / hot reload setup | Delete it — built-in live reload watches `src/`, no config needed |
| State management (Redux, Zustand) | `feature()` replaces store + slices + selectors |
| XState / state machines | `machine:` config in `feature()` — enforced transitions |
| Express middleware | `aio.middleware.create(fn)` — intercepts actions before reduce |
| Health checks / readiness probes | `GET /__health` — auto-generated, zero config |
| Feature flags | `app.features.enable/disable()` — runtime feature control |
| DB migrations | `version: N` + `migrations: [...]` — state versioning on restore |

## File structure

See [structure.md](structure.md) for the complete guide. The short version:

```
src/
  app.ts              ← boot only
  App.tsx             ← layout + routing only
  features/           ← one folder per feature, index.ts is the feature()
  shared/             ← code used by 2+ features (promote from features when needed)
```

- Features start as a single `index.ts` — split when they grow past ~200 lines
- `shared/` contains types, utils, and UI components — never feature logic
- No `src/state.ts`, `src/actions.ts`, `src/reduce.ts` — those live inside features

## Mental shift: state lives on the server

The biggest change: **all persistent state is server-side**. The UI is a pure view of server state. For ephemeral per-client concerns (which item am I editing, form focus, dropdown open/closed), use `useLocal()`:

```
BEFORE: Component → useState → fetch → setState → render
AFTER:  Component → useFeature(f) → send.action() → server reduces → state broadcast → render
```

## Key concepts

### Reduce and execute — named handler objects

Every feature with explicit actions gets `reduce` and `execute` as plain objects — one named method per action/effect key:

```ts
// Named handlers — payload is typed from the action creator
reduce: {
  increment(state, payload) {
    state.count += payload.by  // payload.by typed from actions.increment creator
  },
},
execute: {
  log(_app, payload) {
    console.log(payload.message)  // payload.message typed from effects.log creator
  },
},
```

Action type strings use `featureName:actionKey` format (all lowercase):
```ts
counter.increment.type   // → 'counter:increment'
counter.reset.type       // → 'counter:reset'
```

### State machines — enforced, not optional

Every feature requires a `machine:` config. Invalid transitions are silently dropped:

```ts
machine: {
  initial: 'idle',
  states: {
    idle:   { save: 'saving' },          // only 'save' action allowed in 'idle'
    saving: { saved: 'idle', failed: 'error' },
    error:  { retry: 'saving', dismiss: 'idle' },
  },
}
```

The `_status` field is auto-managed — never set it manually. Access it via `useFeature()`:
```tsx
const { status } = useFeature(myFeature)  // 'idle' | 'saving' | 'error'
```

### Cross-feature communication

Features can interact in three ways:

**1. Selectors** — read another feature's derived state:
```ts
selectors: {
  getTotal: (state) => state.items.reduce((sum, i) => sum + i.price, 0),
}
// Other features: const total = cart.getTotal()
```

**2. Listening** — react to another feature's actions:
```ts
import { dc } from '../dc'

// Option A: listensTo (methods-style — simplest)
const te = feature('te', {
  state: { lastPrice: 0 },
  listensTo: [dc.priceUpdated],
  methods: {
    priceUpdated(s, price: number) { s.lastPrice = price },
  },
})

// Option B: computed key in object-form reduce (explicit style)
const te = feature('te', {
  // ...
  machine: {
    initial: 'idle',
    states: { idle: { update: 'idle', [dc.priceUpdated.type]: 'idle' } },
  },
  reduce: {
    update(state, payload) { /* ... */ },
    [dc.priceUpdated.type](state, payload) { state.lastPrice = payload.price },
  },
})
```

**3. Coordinate** — call another feature's async method directly:
```ts
import { call } from 'aio'
import { dc } from '../dc'

// In an async method or execute handler:
const price = await call({ timeout: 5000 }, () => dc.getPrice('BTC'))
```

## Common patterns

**Async data loading:**
```ts
const users = feature('users', {
  state: { list: [] as User[], loading: false },
  actions: {
    load:   () => ({}),
    loaded: (users: User[]) => ({ users }),
  },
  effects: {
    fetch: () => ({}),
  },
  machine: {
    initial: 'idle',
    states: {
      idle:    { load: 'loading' },
      loading: { loaded: 'ready' },
      ready:   { load: 'loading' },
    },
  },
  reduce: {
    load(state) {
      state.loading = true
    },
    loaded(state, payload) {
      state.loading = false
      state.list = payload.users
    },
  },
  execute: {
    fetch(app) {
      fetch('/api/users')
        .then(r => r.json())
        .then(data => app.dispatch(users.A.loaded(data)))
    },
  },
})
```

**Platform APIs in execute** — if your executor uses Deno/Node APIs (filesystem, shell, etc.), use dynamic import or call globals directly. The browser imports your feature for `useFeature()` but never calls `execute` — so platform code inside the function body is safe as long as there are no top-level imports of server-only modules:

```ts
const files = feature('files', {
  state: { content: '' },
  actions: {
    open:   (path: string) => ({ path }),
    loaded: (content: string) => ({ content }),
  },
  effects: {
    readFile: (path: string) => ({ path }),
  },
  machine: false,
  reduce: {
    open() {},   // no state change — effect triggered via execute.readFile
    loaded(state, payload) { state.content = payload.content },
  },

  // Deno globals — safe, browser never calls execute
  execute: {
    readFile(app, payload) {
      Deno.readTextFile(payload.path)
        .then(content => app.dispatch(files.A.loaded(content)))
    },
  },
})
```

If you need to **import** server-only modules (helper libraries, native bindings, etc.), split the feature into two files:

```ts
// features/files/def.ts — browser-safe (state, actions, machine, reduce)
export const files = feature('files', {
  state: { content: '' },
  actions: { open: (path: string) => ({ path }), loaded: (content: string) => ({ content }) },
  effects: { readFile: (path: string) => ({ path }) },
  machine: false,
  reduce: {
    open() {},   // triggers readFile effect via execute
    loaded(state, payload) { state.content = payload.content },
  },
})
```

```ts
// features/files/index.ts — server-only (adds execute)
import { files } from './def.ts'
import { openAndRead } from './helpers.ts'  // server-only import — safe here
export { files }

files.implement((app, effect) => {
  if (effect.type === 'files:readFile') {
    openAndRead(effect.payload.path)
      .then(content => app.dispatch(files.A.loaded(content)))
  }
})
```

```tsx
// App.tsx → import { files } from './features/files/def.ts'    (browser-safe)
// app.ts  → import { files } from './features/files/index.ts'  (full feature)
```

> **Why the split?** The aio dev server transpiles `.ts` files for the browser but doesn't tree-shake. Top-level `import` of server-only modules crashes the browser. The split keeps server-only imports in a file the browser never loads. This applies to Electron, browser, and Android builds — CLI and service targets run everything server-side and are unaffected.
>
> **When you don't need the split:** If execute only uses Deno globals (`Deno.readTextFile`, `Deno.Command`, etc.) without importing server-only modules, a single file works fine — globals aren't evaluated until execute is called, and the browser never calls it.

**Timers / polling** — use scheduled effects instead of manual `setInterval`:
```ts
// methods style — return schedule effect from sync method
methods: {
  startPolling(s) {
    s.polling = true
    return { _schedule: true, key: 'poll', type: 'myFeature:refresh', intervalMs: 5000 }
  },
  stopPolling(s) {
    s.polling = false
    return { _schedule: true, key: 'poll', cancel: true }
  },
},
```

**Structured data** — use built-in SQLite:
```ts
import { table, pk, text, real } from 'aio'

await aio.run({
  features: [orders],
  db: {
    orders: table({ id: pk(), customer: text(), total: real() }),
  },
})
```

**Filtering what the browser sees** (hide secrets):
```ts
await aio.run({
  features: [myFeature],
  stateForUI: (s) => ({ items: s.items, count: s.count }),  // s.apiKey stays server-only
})
```

## Production features

### Middleware

Chain middleware to intercept every action before it hits the reducer:

```ts
await aio.run({
  features: [counter],
  middleware: [
    aio.middleware.logger(),                    // log all actions
    aio.middleware.logger({ features: ['dc'] }),// log only 'dc' actions
    aio.middleware.validate(),                  // reject malformed actions
    aio.middleware.metrics(),                   // track dispatch counts/timing
    aio.middleware.freeze(),                    // deep-freeze state in dev
    aio.middleware.perfBudget({ reduce: 8, effect: 5 }), // ms budget per reduce/effect
    aio.middleware.create((action, state) => {  // custom middleware
      console.log('before:', action.type)
      return action  // return action to continue, undefined to drop
    }),
  ],
})
```

### Lifecycle — onInit & onDestroy

Features can declare `onInit` and `onDestroy` hooks. Called in dependency order (onInit) and reverse order (onDestroy):

```ts
const db = feature('db', {
  // ...
  onInit(app) {
    // runs on startup — app.dispatch() + app.getState()
    app.dispatch(A.connect())
  },
  onDestroy(app) {
    // runs on shutdown — close connections, flush buffers
    app.dispatch(A.disconnect())
  },
})
```

### State versioning & migrations

Persist state across schema changes:

```ts
await aio.run({
  features: [counter],
  version: 3,
  migrations: [
    (s) => ({ ...s, counter: { ...s.counter, newField: 0 } }),       // v1→v2
    (s) => ({ ...s, counter: { ...s.counter, renamed: s.counter.old } }), // v2→v3
  ],
})
```

Migrations run sequentially on restore. If any migration fails, falls back to initial state.

### Health endpoint

`GET /__health` returns feature status, uptime, and error counts:

```json
{ "status": "healthy", "uptime": 3600, "features": {
    "counter": { "status": "idle", "errors": 0 },
    "dc": { "status": "connected", "errors": 2 }
  }
}
```

### Feature runtime control

```ts
const app = await aio.run({ features: [counter, dc] })

app.features.disable('counter')  // stop processing, reset state
app.features.enable('counter')   // re-init
app.features.status('counter')   // 'idle' | 'saving' | ...
app.features.health()            // all features status + errors
app.features.list()              // ['counter', 'dc']
```

### Dev-mode isolation

Run only specific features during development:

```ts
await aio.run({ features: [counter, dc, te], isolate: ['counter'] })
// or: deno task dev --isolate=counter,dc
```

## Checklist — v0.5 feature-based

- [ ] Framework added (`dep/aio/` via scaffolder, or `deno add @riagentic/aio`)
- [ ] `deno.json` updated with imports, compilerOptions, unstable
- [ ] `deno install` ran successfully
- [ ] `deno add npm:electron && deno approve-scripts npm:electron && deno install` (if using Electron)
- [ ] `src/features/<name>/index.ts` — feature with state, actions, effects, machine, reduce, execute
- [ ] `src/App.tsx` — `export default` component using `useFeature()`
- [ ] `src/app.ts` — entry point calling `aio.run({ features: [...] })`
- [ ] `src/style.css` — (optional) auto-injected into HTML
- [ ] `deno task dev` runs and shows startup checks passing

