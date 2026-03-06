# Migrating to AIO

You have an existing Deno application and want to integrate AIO. This guide covers what to change and how to map your existing patterns.

## What AIO gives you

One function boots everything:
```
aio.run(initialState, { reduce, execute }) →
  Deno.Kv persistence + HTTP/WS server + React UI (Electron or browser)
```

Data flow: **UI → action → reduce → new state + effects → persist → broadcast → execute effects**

## Step 1: Add dep/aio/

Copy or link the `dep/aio/` folder into your project root.

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

## Step 3: Create src/ files

Create the 7 files shown in [quickstart.md](quickstart.md), adapted to your domain. The file structure, patterns, and conventions are identical — just replace the counter example with your app's state and logic.

## Mapping existing patterns

| You have | AIO equivalent |
|----------|---------------|
| REST API endpoints | Actions (UI sends via WebSocket, no HTTP needed) |
| Database reads/writes | `getDBState`/`getUIState` filters + auto Deno.Kv |
| SQLite / shelling out to `sqlite3` | Built-in `app.db` — [3-tier SQLite](manual.md#sqlite) |
| `setInterval` / `setTimeout` | Declarative `schedule.every` / `schedule.after` — [Scheduled effects](manual.md#scheduled-effects) |
| cron jobs / external scheduler | `schedule.cron` — runs inside the process, no external deps |
| Event handlers | Action creators in `actions.ts` |
| Business logic | `reduce.ts` (sync state changes) |
| API calls, async ops | `effects.ts` + `execute.ts` |
| React state + useEffect | Replace with `useAio()` — all state lives on server |
| Multiple useState hooks | Single `AppState` object + `useLocal()` for ephemeral UI state |
| WebSocket setup | Delete it — `useAio()` handles everything |
| createRoot / ReactDOM | Delete it — framework mounts `export default` from App.tsx |
| HMR / hot reload setup | Delete it — built-in live reload watches `src/`, no config needed |

## Mental shift: state lives on the server

The biggest change: **all persistent state is server-side**. The UI is a pure view of server state. For ephemeral per-client concerns (which item am I editing, form focus, dropdown open/closed), use `useLocal()`:

```
BEFORE: Component → useState → fetch → setState → render
AFTER:  Component → useAio() → send(action) → server reduces → state broadcast → render
```

## Common patterns

**Async data loading:**
```ts
// actions.ts
LoadUsers: () => ({}),
UsersLoaded: (users: User[]) => ({ users }),

// reduce.ts
case A.LoadUsers:
  d.loading = true
  return [E.fetchUsers()]
case A.UsersLoaded:
  d.loading = false
  d.users = action.payload.users
  return []

// execute.ts
case E.FetchUsers:
  fetch('/api/users').then(r => r.json()).then(users => app.dispatch(A.usersLoaded(users)))
  break
```

**Timers / polling** — use scheduled effects instead of manual `setInterval`:
```ts
// reduce.ts — return a schedule effect, framework manages the timer
case A.StartPolling:
  return [schedule.every('poll', 5000, A.refresh())]
case A.StopPolling:
  return [schedule.cancel('poll')]
```

Or declare always-on schedules in config:
```ts
await aio.run(state, {
  reduce, execute,
  schedules: [{ id: 'heartbeat', every: 10_000, action: A.heartbeat() }],
})
```

**Structured data** — use built-in SQLite instead of shelling out to `sqlite3`:
```ts
import { table, pk, text, real } from 'aio'

await aio.run(state, {
  reduce, execute,
  db: {
    orders: table({ id: pk(), customer: text(), total: real() }),
  },
})
// Reducer: just push/filter arrays as normal — framework syncs to SQLite
// Effects: use app.db!.orders.where({ total: { gt: 100 } }) for queries
```

**Filtering what the browser sees** (hide secrets):
```ts
await aio.run(state, {
  reduce, execute,
  getUIState: (s) => ({ items: s.items, count: s.count }),  // s.apiKey stays server-only
})
```

## Checklist

- [ ] `dep/aio/` linked or copied into project
- [ ] `deno.json` updated with imports, compilerOptions, unstable
- [ ] `deno install` ran successfully
- [ ] `deno add npm:electron && deno approve-scripts npm:electron && deno install` (if using Electron)
- [ ] `src/state.ts` — state type + initial values
- [ ] `src/actions.ts` — action creators with `actions()` + `UnionOf`
- [ ] `src/effects.ts` — effect creators with `effects()` + `UnionOf`
- [ ] `src/reduce.ts` — reducer using `draft()`, returns `{ state, effects }`
- [ ] `src/execute.ts` — effect executor with `app.dispatch()` for async results
- [ ] `src/App.tsx` — `export default` component using `useAio()`
- [ ] `src/app.ts` — entry point calling `aio.run()`
- [ ] `src/style.css` — (optional) auto-injected into HTML
- [ ] `deno task dev` runs and shows startup checks passing
