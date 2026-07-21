# Migrating to AIO

You have an existing Deno application and want to integrate AIO.

## What AIO gives you

```
aio.run({ cells: [...] }) ->
  SQLite persistence + HTTP/WS server + UI (Electron or browser)
```

Data flow: **UI -> method call -> state mutation -> persist -> broadcast -> sync
all clients**

## Step 1: Add the framework

**Option A: Scaffolder (recommended)** -- interactive project creation that
generates a correct `deno.json`. See [quickstart.md](quickstart.md).

**Option B: Vendored** -- `git clone https://github.com/riagentic/aio dep/aio`,
then map `"aio": "./dep/aio/mod.ts"` (plus `immer`, `@std/path`).

**Option C: JSR** -- `deno add jsr:@riagentic/aio@1.0.0-alpha20` (pin the
version explicitly: alphas are semver pre-releases, so an unpinned install
resolves to an old stable).

## Step 2: Update deno.json

```jsonc
{
  "title": "My App",
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "aio"
  },
  "imports": {
    "aio": "jsr:@riagentic/aio@^1.0.0-alpha17",
    "aio/air": "jsr:@riagentic/aio@^1.0.0-alpha17/air",
    "aio/jsx-runtime": "jsr:@riagentic/aio@^1.0.0-alpha17/jsx-runtime",
    "esbuild": "npm:esbuild@^0.24"
  },
  "tasks": {
    "dev": "deno run -A src/app.ts",
    "am": "deno run -A jsr:@riagentic/aio@^1.0.0-alpha17/am",
    "test": "deno test -A tests/",
    "compile:browser": "deno run -A jsr:@riagentic/aio@^1.0.0-alpha17/build --compile",
    "compile:electron": "deno run -A jsr:@riagentic/aio@^1.0.0-alpha17/build --compile --electron"
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

| Redux                                | aio                      | Notes                                    |
| ------------------------------------ | ------------------------ | ---------------------------------------- |
| `createSlice()`                      | `cell()`                 | One cell = one slice + effects + persist |
| `slice.reducer`                      | `methods`                | Mutate the draft directly                |
| `slice.actions`                      | Auto-generated           | `counter.increment(5)` after `aio.run()` |
| `configureStore()`                   | `aio.run({ cells })`     | Composition, DevTools built-in           |
| `useSelector(s => s.counter)`        | `counter.count` (direct) | Auto-scoped, selective re-renders        |
| `useDispatch()` + `dispatch(action)` | `send.increment()`       | Typed, no raw dispatch                   |
| `createAsyncThunk`                   | `async` methods          | No thunk boilerplate                     |
| `persistReducer`                     | Automatic                | SQLite persistence built-in              |

### Zustand -> aio

| Zustand                  | aio                                | Notes                       |
| ------------------------ | ---------------------------------- | --------------------------- |
| `create((set) => ...)`   | `cell('name', { state, methods })` | Similar Immer-style DX      |
| `set({ count: 1 })`      | `s.count = 1` inside a method      | Same mutation style         |
| `useStore(s => s.count)` | `counter.count` (direct)           | Auto-scoped                 |
| `persist` middleware     | Automatic                          | Built-in SQLite persistence |
| Multiple stores          | Multiple cells                     | One cell per domain         |

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
| Database reads/writes             | Cell-level `persist`/`ui` config + auto SQLite persistence     |
| SQLite / raw SQL                  | Built-in `app.db` -- [3-tier SQLite](../persistence/sqlite.md) |
| `setInterval` / `setTimeout`      | Declarative `schedule.every` / `schedule.after`                |
| cron jobs                         | `schedule.cron` -- runs in-process                             |
| React state + useEffect           | Direct cell access -- all state lives on server                |
| Multiple useState hooks           | Cell state + `useLocal()` for ephemeral UI                     |
| WebSocket setup                   | Delete it -- direct cell access handles everything             |
| createRoot / ReactDOM             | Delete it -- framework mounts `export default` from App        |
| HMR / hot reload                  | Delete it -- built-in, no config                               |
| State management (Redux, Zustand) | `cell()` replaces store + slices + selectors                   |
| XState / state machines           | `status` state field + guard lines in methods                  |
| Express middleware                | `beforeReduce` in `aio.run()` config                           |
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

**2. Reacting** -- the acting cell calls the observer's method:

```ts
const te = cell("te", {
  state: { lastPrice: 0 },
  methods: {
    priceUpdated(s, price: number) {
      s.lastPrice = price;
    },
  },
});

// inside dc:
async fetchPrice(s) {
  s.price = await api.price("BTC");
  await te.priceUpdated(s.price); // explicit, typed, in time-travel
},
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

Remove `--allow-ffi` from run/compile commands. Any method calling `app.db` must
be `async`.

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
