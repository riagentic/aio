# Migrating to AIO

You have an existing Deno application and want to integrate AIO.

## What AIO gives you

```
aio.run({ features: [...] }) ->
  Deno.Kv persistence + HTTP/WS server + UI (Electron or browser)
```

Data flow: **UI -> method call -> state mutation -> persist -> broadcast -> sync
all clients**

## Step 1: Add the framework

**Option A: JSR (recommended)** -- `deno add jsr:@riagentic/aio`

**Option B: Scaffolder** -- interactive project creation. See
[quickstart.md](quickstart.md).

## Step 2: Update deno.json

```jsonc
{
  "title": "My App",
  "unstable": ["kv"],
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "jsxImportSourceTypes": "@types/react"
  },
  "imports": {
    "aio": "jsr:@riagentic/aio@1.0.0-alpha8",
    "@types/react": "npm:@types/react@^18",
    "react": "npm:react@^18",
    "react-dom": "npm:react-dom@^18",
    "esbuild": "npm:esbuild@^0.24"
  },
  "tasks": {
    "dev": "deno run -A src/app.ts",
    "am": "deno run -A jsr:@riagentic/aio@1.0.0-alpha8/src/am",
    "test": "deno test -A --unstable-kv tests/",
    "compile:browser": "deno run -A jsr:@riagentic/aio@1.0.0-alpha8/src/build --compile",
    "compile:electron": "deno run -A jsr:@riagentic/aio@1.0.0-alpha8/src/build --compile --electron"
  }
}
```

Then run `deno install`.

## Step 3: Create features

Each domain concept is a **feature**. Start with `feature({ methods })`:

```ts
import { feature } from "aio";

export const counter = feature("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
    decrement(s, by = 1) {
      s.count -= by;
    },
    reset(s) {
      s.count = 0;
    },
  },
});
```

After `aio.run()`, call methods directly: `counter.increment(5)`.

### UI: `src/App.tsx`

```tsx
import { useFeature } from "aio/react";
import { counter } from "./features/counter/index.ts";

export default function App() {
  const { state, send, status } = useFeature(counter);
  if (!state) return <div>Connecting...</div>;
  return (
    <div>
      <h1>{state.count}</h1>
      <button onClick={() => send.increment()}>+</button>
    </div>
  );
}
```

### Entry point: `src/app.ts`

```ts
import { aio } from "aio";
import { counter } from "./features/counter/index.ts";
await aio.run({ features: [counter] });
```

---

## Coming from Redux / Zustand / MobX

### Redux -> aio

| Redux                                | aio                           | Notes                                                 |
| ------------------------------------ | ----------------------------- | ----------------------------------------------------- |
| `createSlice()`                      | `feature()`                   | One feature = one slice + effects + machine + persist |
| `slice.reducer`                      | `methods` or `reduce`         | Mutate directly in methods style                      |
| `slice.actions`                      | Auto-generated                | `counter.increment(5)` after `aio.run()`              |
| `configureStore()`                   | `aio.run({ features })`       | Composition, middleware, DevTools built-in            |
| `useSelector(s => s.counter)`        | `useFeature(counter)`         | Auto-scoped, selective re-renders                     |
| `useDispatch()` + `dispatch(action)` | `send.increment()`            | Typed, no raw dispatch                                |
| `createAsyncThunk`                   | `async` methods or generators | No thunk boilerplate                                  |
| `persistReducer`                     | Automatic                     | Deno.Kv persistence built-in                          |

### Zustand -> aio

| Zustand                  | aio                                   | Notes                     |
| ------------------------ | ------------------------------------- | ------------------------- |
| `create((set) => ...)`   | `feature('name', { state, methods })` | Similar Immer-style DX    |
| `set({ count: 1 })`      | `s.count = 1` inside a method         | Same mutation style       |
| `useStore(s => s.count)` | `useFeature(counter)`                 | Auto-scoped               |
| `persist` middleware     | Automatic                             | Built-in Deno.Kv + SQLite |
| Multiple stores          | Multiple features                     | One feature per domain    |

**Key difference:** Redux/Zustand state lives in the browser. aio state lives on
the server -- the browser gets a synced view via WebSocket.

### Quick example -- Redux slice -> aio feature

```ts
// BEFORE: Redux
const counterSlice = createSlice({
  name: "counter",
  initialState: { count: 0 },
  reducers: {
    increment: (state, action) => {
      state.count += action.payload;
    },
    reset: (state) => {
      state.count = 0;
    },
  },
});

// AFTER: aio
const counter = feature("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
    reset(s) {
      s.count = 0;
    },
  },
});
```

---

## Mapping existing patterns

| You have                          | AIO equivalent                                          |
| --------------------------------- | ------------------------------------------------------- |
| REST API endpoints                | Actions via WebSocket, no HTTP needed                   |
| Database reads/writes             | `stateForDB`/`stateForUI` filters + auto Deno.Kv        |
| SQLite / raw SQL                  | Built-in `app.db` -- [3-tier SQLite](../persistence.md) |
| `setInterval` / `setTimeout`      | Declarative `schedule.every` / `schedule.after`         |
| cron jobs                         | `schedule.cron` -- runs in-process                      |
| React state + useEffect           | `useFeature(f)` -- all state lives on server            |
| Multiple useState hooks           | Feature state + `useLocal()` for ephemeral UI           |
| WebSocket setup                   | Delete it -- `useFeature()` handles everything          |
| createRoot / ReactDOM             | Delete it -- framework mounts `export default` from App |
| HMR / hot reload                  | Delete it -- built-in, no config                        |
| State management (Redux, Zustand) | `feature()` replaces store + slices + selectors         |
| XState / state machines           | `machine:` config in `feature()`                        |
| Express middleware                | `aio.middleware.create(fn)`                             |
| Health checks                     | `GET /__aio/health` -- auto-generated                   |
| Feature flags                     | `app.features.enable/disable()` -- runtime control      |

## Mental shift: state lives on the server

```
BEFORE: Component -> useState -> fetch -> setState -> render
AFTER:  Component -> useFeature(f) -> send.action() -> server reduces -> broadcast -> render
```

For ephemeral per-client state (editing, focus, dropdowns), use `useLocal()`.

---

## Key concepts

### Cross-feature communication

**1. Selectors** -- read another feature's derived state:

```ts
selectors: {
  getTotal: (state) => state.items.reduce((sum, i) => sum + i.price, 0),
}
```

**2. Listening** -- react to another feature's actions:

```ts
const te = feature("te", {
  state: { lastPrice: 0 },
  listensTo: [dc.priceUpdated],
  methods: {
    priceUpdated(s, price: number) {
      s.lastPrice = price;
    },
  },
});
```

**3. Coordinate** -- call another feature's method directly:

```ts
import { call } from "aio";
const price = await call({ timeout: 5000 }, () => dc.getPrice("BTC"));
```

---

## Breaking change: `AioDB` -> `DB` (v0.9.0)

All `app.db` calls are now async. `AioDB`/`AioTable<T>` removed, replaced by
`DB` interface:

```ts
// Before (sync)
const orders = app.db!.orders.where({ status: "active" });

// After (async)
const { rows: orders } = await app.db!.query<Order>(
  "SELECT * FROM orders WHERE status = ?",
  ["active"],
);
```

Remove `--allow-ffi` from run/compile commands. Any `execute` handler calling
`app.db` must be `async`.

---

## Checklist

- [ ] Framework added (`deno add jsr:@riagentic/aio` or scaffolder)
- [ ] `deno.json` updated with imports, compilerOptions, unstable
- [ ] `deno install` ran successfully
- [ ] `src/features/<name>/index.ts` -- feature with state and methods
- [ ] `src/App.tsx` -- `export default` component using `useFeature()`
- [ ] `src/app.ts` -- entry point calling `aio.run({ features: [...] })`
- [ ] `deno task dev` runs and startup checks pass
