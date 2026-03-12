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

If you want just the library (types, feature, flow, hooks) without the build toolchain:

```sh
deno add @riagentic/aio
```

Then import:
```ts
import { feature, aio, flow } from '@riagentic/aio'
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
  features/counter/index.ts    ← feature() — state, methods, machine
  style.css                    ← (optional)
```

### features/counter/index.ts

> **Start here.** 95% of features only need `methods`. The `actions + reduce` style
> exists for complex reactive logic — don't reach for it until you feel the pain.

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

// Async tests
testFeature(backup, 'runs backup', async (t) => {
  t.init()
  t.send.run()
  t.runEffects()       // execute pending effects
  await t.settle()     // wait for async completion
  t.expect.state(s => s.lastBackup !== null)
})
```

### Async methods and call()

Async methods have the same `(state, ...args)` signature as sync methods — a live Proxy replaces the state draft:

```ts
import { feature, call } from 'aio'

export const api = feature('api', {
  state: { data: null as string | null },
  methods: {
    // Sync and async — same signature
    clear(s) { s.data = null },

    async fetch(s, url: string) {
      const res = await fetch(url)
      s.data = await res.text()
    },

    // Direct cross-feature calling — import and call directly (typed)
    async saveAndNotify(s) {
      await notifications.send('Data saved!')  // or: await call({ timeout: 3000 }, () => notifications.send('Data saved!'))
      s.lastNotified = Date.now()
    },
  },
})
```

### Advanced / explicit control — actions + reduce

> **Don't start here.** Use `methods` first. Reach for `actions + reduce` only when you need
> complex reactive logic, multiple entry points to the same state change, or strict machine gating
> that methods can't express.

When you need fine-grained control over state transitions:

```ts
import { feature } from 'aio'

export const checkout = feature('checkout', {
  state: { step: 'idle' as 'idle' | 'processing' | 'done' },
  actions: {
    start: () => ({}),
    complete: () => ({}),
  },
  reduce: {
    start(state) {
      state.step = 'processing'
    },
    complete(state) {
      state.step = 'done'
    },
  },
})
```

---

## Next steps

- [core.md](core.md) — feature API reference, actions/reduce, flows
- [features.md](features.md) — inter-feature communication patterns
- [generators.md](generators.md) — sequential async workflows with generators
- [structure.md](structure.md) — file & directory organization guide
- [migration.md](migration.md) — adopting aio into an existing app
- [upgrade.md](upgrade.md) — version upgrade guide
