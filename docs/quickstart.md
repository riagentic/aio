# AIO Quickstart

Start a new aio app from scratch.

## Option A: One-liner (recommended)

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/init.sh)" -- my-app
```

Installs Deno if missing, then shows an interactive menu for app type and template selection. Creates project directory, downloads framework, installs dependencies. You get the full toolchain: dev server, build system, app manager, all compile targets.

Skip the menus with flags:
```sh
sh -c "$(curl -fsSL ...)" -- my-app --type=electron --template=minimal
```

App types: `browser`, `electron`, `android`, `cli`, `service`, `remote-browser`, `remote-service`, `remote-electron`, `remote-cli`, `remote-android`. Templates: `empty`, `minimal`, `medium`, `large`.

## Option B: JSR dependency (library only)

If you want just the library (types, reactive, feature, flow, hooks) without the build toolchain:

```sh
deno add @riagentic/aio
```

Then import:
```ts
import { reactive, aio, feature, flow } from '@riagentic/aio'
```

> **Note:** JSR gives you the library API. The full development experience (dev server with hot reload, `deno task compile`, app manager, Electron/Android packaging) requires the scaffolder from Option A.

## Manual setup

### Prerequisites

- [Deno 2.6+](https://deno.land)
- Electron (optional — for desktop window): `deno add npm:electron && deno approve-scripts npm:electron`

After creating `deno.json` and writing files, install dependencies:
```sh
deno install
```

### deno.json

```json
{
  "title": "My App",
  "nodeModulesDir": "auto",
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

- `"title"` — app name, used as default window title and binary name (lowercased slug) when compiling. Optional, falls back to `"AIO App"`.
- `"esbuild"` — required for dev mode transpilation. Excluded from compiled binary automatically.

### File structure

```
deno.json
src/
  app.ts                       ← aio.run({ features }) — boot only
  App.tsx                      ← root UI — layout + routing only
  features/counter/index.ts    ← feature() — state, actions, machine, reduce, execute
  style.css                    ← (optional)
```

Features start as a single `index.ts`. As they grow, extract `types.ts`, `helpers.ts`, `reduce.ts`, `execute.ts`, `ui/`. See [structure.md](structure.md) for the full guide.

### features/counter/index.ts

```ts
import { reactive } from 'aio'

export const counter = reactive('counter', {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) { s.count += by },
    decrement(s, by = 1) { s.count -= by },
    reset(s) { s.count = 0 },
  },
})
```

### App.tsx

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

### app.ts

```ts
import { aio } from 'aio'
import { counter } from './features/counter/index.ts'

await aio.run({ features: [counter] })
```

### Run

```sh
deno task dev
```

That's it. Electron window opens, state persists across restarts, multiple browser tabs stay in sync.

> **No Electron?** Add `--no-electron` to open in your browser instead: `deno task dev --no-electron`

`aio.run()` returns an app object with runtime feature control — see [core.md](core.md#return-value--appfeatures) for `app.features.health()`, `enable()`, `disable()`, and more.

### Window size

Set default Electron window dimensions in your `aio.run()` config:

```ts
await aio.run({
  features: [counter],
  ui: { title: 'My App', width: 1200, height: 800 },
})
```

Or via CLI: `deno task dev --width=1200 --height=800`. Window bounds persist across runs automatically.

### Adding middleware & versioning

```ts
await aio.run({
  features: [counter],
  middleware: [aio.middleware.logger(), aio.middleware.validate()],
  version: 1,
  migrations: [],  // add migration functions as schema evolves
})
```

### Testing

```ts
import { testFeature } from 'aio'
import { counter } from './features/counter/index.ts'

// Sync tests
testFeature(counter, 'increment from idle', (t) => {
  t.init()
  t.send.increment(5)
  t.expect.state(s => s.count === 5)
  t.expect.status('idle')
})

// Async tests — for reactive async methods
testFeature(backup, 'runs backup', async (t) => {
  t.init()
  t.send.run()
  t.runEffects()       // execute pending effects
  await t.settle()     // wait for async completion
  t.expect.state(s => s.lastBackup !== null)
})
```

### Adding async methods

Async methods get a live Proxy — reads are always fresh, writes auto-dispatch:

```ts
import { reactive } from 'aio'

export const backup = reactive('backup', {
  state: { lastBackup: null as string | null, status: 'idle' },
  methods: {
    async run(s) {
      s.status = 'running'
      const data = await Deno.readTextFile('./data.json')
      await fetch('/api/backup', { method: 'POST', body: data })
      s.lastBackup = new Date().toISOString()
      s.status = 'idle'
    },
  },
})
```

Each property assignment dispatches a real action — persisted, synced, visible in time-travel. See [reactivity.md](reactivity.md) for the full guide.

### Upgrading to flows or feature()

When you need step-level observability, auto-cancellation, or complex reactive logic, upgrade individual features to `flow()` or `feature()`. See [generators.md](generators.md) and [core.md](core.md#feature) for details.

---

## Classic quickstart (v0.4)

The classic 7-file approach still works. Use this if you prefer explicit files over the all-in-one `feature()` API.

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

### state.ts

```ts
export type AppState = { counter: number }
export const initialState: AppState = { counter: 0 }
```

### actions.ts

```ts
import { actions, type UnionOf } from 'aio'

export const A = actions({
  Increment: (by = 1) => ({ by }),
  Decrement: (by = 1) => ({ by }),
  Reset: () => ({}),
})

export type Action = UnionOf<typeof A>
```

### effects.ts

```ts
import { effects, type UnionOf } from 'aio'

export const E = effects({
  Log: (message: string) => ({ message }),
})

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

### execute.ts

```ts
import { E, type Effect } from './effects.ts'
import type { AppState } from './state.ts'
import type { Action } from './actions.ts'
import type { AioApp } from 'aio'

export function execute(_app: AioApp<AppState, Action>, effect: Effect): void {
  switch (effect.type) {
    case E.Log:
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
      <button onClick={() => send(A.decrement())}>-</button>
      <button onClick={() => send(A.reset())}>Reset</button>
      <button onClick={() => send(A.increment())}>+</button>
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

## Next steps

- [reactivity.md](reactivity.md) — reactive features with `reactive()`
- [generators.md](generators.md) — sequential async workflows with `flow()`
- [structure.md](structure.md) — file & directory organization guide
- [migration.md](migration.md) — adopting aio into an existing app
- [manual.md](manual.md) — docs index
- [upgrade.md](upgrade.md) — version upgrade guide
