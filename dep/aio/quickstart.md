# AIO Quickstart

Start a new aio app from scratch.

## One-liner

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/init.sh)" -- my-app
```

Installs Deno if missing, then shows an interactive menu with 4 templates: empty (2 files), minimal (7 files), medium (feature folders), large (models + features + UI hierarchy). Creates project directory, downloads framework, installs dependencies.

## Manual setup

### Prerequisites

- [Deno 2.6+](https://deno.land)
- Electron (optional — for desktop window): `deno add npm:electron && deno approve-scripts npm:electron`

After creating `deno.json` and writing files, install dependencies:
```sh
deno install
```

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

## state.ts

```ts
export type AppState = { counter: number }
export const initialState: AppState = { counter: 0 }
```

## actions.ts

```ts
import { actions, type UnionOf } from 'aio'

export const A = actions({
  Increment: (by = 1) => ({ by }),
  Decrement: (by = 1) => ({ by }),
  Reset: () => ({}),
})

export type Action = UnionOf<typeof A>
```

## effects.ts

```ts
import { effects, type UnionOf } from 'aio'

export const E = effects({
  Log: (message: string) => ({ message }),
})

export type Effect = UnionOf<typeof E>
```

## reduce.ts

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

## execute.ts

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

## App.tsx

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

## app.ts

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

> **No Electron?** Add `--no-electron` to open in your browser instead: `deno task dev --no-electron`

### Window size

Set default Electron window dimensions in your `aio.run()` config:

```ts
await aio.run(initialState, {
  reduce, execute,
  ui: { title: 'My App', width: 1200, height: 800 },
})
```

Or via CLI: `deno task dev --width=1200 --height=800`. Window bounds persist across runs automatically.

## Next steps

- [migration.md](migration.md) — adopting aio into an existing app
- [manual.md](manual.md) — full API reference
