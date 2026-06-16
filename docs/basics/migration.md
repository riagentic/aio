# Migrating to AIO

You have an existing Deno application and want to integrate AIO.

## What AIO gives you

```
aio.run({ cells: [...] }) ->
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
    "jsxImportSource": "aio"
  },
  "imports": {
    "aio": "jsr:@riagentic/aio@^1.0.0-alpha13",
    "aio/air": "jsr:@riagentic/aio@^1.0.0-alpha13/air",
    "aio/jsx-runtime": "jsr:@riagentic/aio@^1.0.0-alpha13/jsx-runtime",
    "esbuild": "npm:esbuild@^0.24"
  },
  "tasks": {
    "dev": "deno run -A src/app.ts",
    "am": "deno run -A jsr:@riagentic/aio@^1.0.0-alpha13/src/am",
    "test": "deno test -A --unstable-kv tests/",
    "compile:browser": "deno run -A jsr:@riagentic/aio@^1.0.0-alpha13/src/build --compile",
    "compile:electron": "deno run -A jsr:@riagentic/aio@^1.0.0-alpha13/src/build --compile --electron"
  }
}
```

Then run `deno install`.

## Step 3: Create cells

Each domain concept is a **cell**. Start with `cell({ methods })`:

```ts
import { cell } from "aio";

export const counter = cell("counter", {
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
import { counter } from "./cell/counter/index.ts";

export default function App() {
  return (
    <div>
      <h1>{counter.count}</h1>
      <button onClick={() => counter.increment()}>+</button>
    </div>
  );
}
```

### Entry point: `src/app.ts`

```ts
import { aio } from "aio";
import { counter } from "./cell/counter/index.ts";
await aio.run({ cells: [counter] });
```

---

## Coming from Redux / Zustand / MobX

### Redux -> aio

| Redux                                | aio                           | Notes                                              |
| ------------------------------------ | ----------------------------- | -------------------------------------------------- |
| `createSlice()`                      | `cell()`                      | One cell = one slice + effects + machine + persist |
| `slice.reducer`                      | `methods` or `reduce`         | Mutate directly in methods style                   |
| `slice.actions`                      | Auto-generated                | `counter.increment(5)` after `aio.run()`           |
| `configureStore()`                   | `aio.run({ cells })`          | Composition, middleware, DevTools built-in         |
| `useSelector(s => s.counter)`        | `counter.count` (direct)      | Auto-scoped, selective re-renders                  |
| `useDispatch()` + `dispatch(action)` | `send.increment()`            | Typed, no raw dispatch                             |
| `createAsyncThunk`                   | `async` methods or generators | No thunk boilerplate                               |
| `persistReducer`                     | Automatic                     | Deno.Kv persistence built-in                       |

### Zustand -> aio

| Zustand                  | aio                                | Notes                     |
| ------------------------ | ---------------------------------- | ------------------------- |
| `create((set) => ...)`   | `cell('name', { state, methods })` | Similar Immer-style DX    |
| `set({ count: 1 })`      | `s.count = 1` inside a method      | Same mutation style       |
| `useStore(s => s.count)` | `counter.count` (direct)           | Auto-scoped               |
| `persist` middleware     | Automatic                          | Built-in Deno.Kv + SQLite |
| Multiple stores          | Multiple cells                     | One cell per domain       |

**Key difference:** Redux/Zustand state lives in the browser. aio state lives on
the server -- the browser gets a synced view via WebSocket.

### Quick example -- Redux slice -> aio cell

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
const counter = cell("counter", {
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

| You have                          | AIO equivalent                                                 |
| --------------------------------- | -------------------------------------------------------------- |
| REST API endpoints                | Actions via WebSocket, no HTTP needed                          |
| Database reads/writes             | Cell-level `persist`/`ui` config + auto Deno.Kv                |
| SQLite / raw SQL                  | Built-in `app.db` -- [3-tier SQLite](../persistence/sqlite.md) |
| `setInterval` / `setTimeout`      | Declarative `schedule.every` / `schedule.after`                |
| cron jobs                         | `schedule.cron` -- runs in-process                             |
| React state + useEffect           | Direct cell access -- all state lives on server                |
| Multiple useState hooks           | Cell state + `useLocal()` for ephemeral UI                     |
| WebSocket setup                   | Delete it -- direct cell access handles everything             |
| createRoot / ReactDOM             | Delete it -- framework mounts `export default` from App        |
| HMR / hot reload                  | Delete it -- built-in, no config                               |
| State management (Redux, Zustand) | `cell()` replaces store + slices + selectors                   |
| XState / state machines           | `machine:` config in `cell()`                                  |
| Express middleware                | `aio.middleware.create(fn)`                                    |
| Health checks                     | `GET /__aio/health` -- auto-generated                          |
| Cell flags                        | `app.cells.enable/disable()` -- runtime control                |

## Mental shift: state lives on the server

```
BEFORE: Component -> useState -> fetch -> setState -> render
AFTER:  Component -> counter.count -> counter.action() -> server reduces -> broadcast -> render
```

For ephemeral per-client state (editing, focus, dropdowns), use `useLocal()`.

---

## Key concepts

### Cross-cell communication

**1. Selectors** -- read another cell's derived state:

```ts
selectors: {
  getTotal: (state) => state.items.reduce((sum, i) => sum + i.price, 0),
}
```

**2. Listening** -- react to another cell's actions:

```ts
const te = cell("te", {
  state: { lastPrice: 0 },
  listensTo: [dc.priceUpdated],
  methods: {
    priceUpdated(s, price: number) {
      s.lastPrice = price;
    },
  },
});
```

**3. Coordinate** -- call another cell's method directly:

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
- [ ] `src/cell/<name>/index.ts` -- cell with state and methods
- [ ] `src/App.tsx` -- `export default` component using direct cell access
- [ ] `src/app.ts` -- entry point calling `aio.run({ cells: [...] })`
- [ ] `deno task dev` runs and startup checks pass

## Migrating from React

During migration, React's hooks are available from the compat entry — each logs
a one-time dev hint pointing at the AIR-native equivalent:

```ts
import { useEffect, useState } from "aio/air/compat";
```

| React         | AIR native                                                  |
| ------------- | ----------------------------------------------------------- |
| `useState`    | `useLocal()` for object state, `signal()` for module-scoped |
| `useEffect`   | `onMount()` for setup/teardown, `effect()` for reactive     |
| `useMemo`     | `computed()`                                                |
| `useCallback` | unnecessary — components are auto-optimized                 |

React compat hooks live **only** at `aio/air/compat` — they are not exported
from `aio/air`. (`useRef` is a native AIR primitive and stays on `aio/air`.)
