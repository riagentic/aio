# AIR Setup & Server State

React syntax. No React baggage. AIR uses the same TSX you already know but
eliminates the boilerplate: no `useState`, no `useCallback`, no `useMemo`, no
dependency arrays, no stale closures. Signals handle reactivity automatically.

```tsx
import { mount, signal } from "aio/air";

const count = signal(0);

const App = () => (
  <button onClick={() => count.set(count.peek() + 1)}>
    Count: {count.value}
  </button>
);

mount(document.getElementById("root")!, App);
```

Zero dependencies. ~8KB total.

---

## Setup

Add to your `deno.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "aio"
  }
}
```

Write `.tsx` files. The JSX compiler maps `<div>` to AIR's virtual DOM — no
React import needed. AIO uses `@types/react` for HTML intrinsic element types.

```ts
import { computed, effect, mount, signal } from "aio/air";
```

**Import rule:**

- `"aio"` — server code: `cell`, `aio`, `log`, types. Cell imports are also used
  directly in components for state reads and method calls.
- `"aio/air"` — client code: `signal`, `mount`, `useLocal`, UI utilities

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                          Server (Deno)                           │
│                                                                  │
│   cell("counter", { state, methods })                         │
│   cell("todo",    { state, methods, persist })                │
│                                                                  │
│   aio.run({ cells: [...], baseDir })                          │
│   ─── dispatch loop ── reduce ── effects ── persist ── broadcast │
└──────────────────────┬───────────────────────────────────────────┘
                       │ WebSocket / IPC
                       │ State deltas + action acknowledgments
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Client (AIR Renderer)                          │
│                                                                  │
│   state-core: signals per cell ← server broadcasts            │
│   cell.count → signal-backed getter (auto-reactive)            │
│   aio-renderer: mount() → per-component signal tracking          │
│                                                                  │
│   signal() / computed() / effect() — local reactivity            │
│   useForm() / useVirtualList() / <Transition> — built-in UI      │
└──────────────────────────────────────────────────────────────────┘
```

**The server owns business logic and state.** Cells define methods, state shape,
persistence rules, and inter-cell communication.

**The client owns rendering and local interaction.** AIR reads server state via
signals, sends actions back, and handles everything visual.

---

## Two Files, Full App

**`app.ts` — Server entry point:**

```ts
import { aio, cell } from "aio";

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

await aio.run({ cells: [counter], baseDir: import.meta.dirname! });
```

**`App.tsx` — UI component:**

```tsx
import { counter } from "./app.ts";

export default function App() {
  return (
    <div>
      <h1>{counter.count}</h1>
      <button onClick={() => counter.increment()}>+</button>
      <button onClick={() => counter.decrement()}>-</button>
      <button onClick={() => counter.reset()}>Reset</button>
    </div>
  );
}
```

One import, zero ceremony. `counter.count` is reactive (signal-backed).
`counter.increment()` dispatches to the server. No hooks needed.

Run with `deno run -A app.ts`. AIO starts the server, compiles UI, opens a
browser, connects WebSocket, and streams state. Works across tabs.

---

## Data Flow

```
1. User clicks → onClick={() => counter.increment())
2. AIR batches the handler → batch(() => handler(event))
3. Action sent via WebSocket → { type: "counter:increment", ... }
4. Server dispatches through reduce() → s.count += 1
5. Server broadcasts delta → { counter: { count: 1 } }
6. state-core updates cell signal → batch(() => cellSignal.set(...))
7. AIR re-renders only components that read counter.count
```

---

## Connecting UI to Server State

### Direct cell access (preferred)

```tsx
import { counter } from "./app.ts";

const Counter = () => <span>{counter.count}</span>;
```

- `counter.count` is reactive — reading it in JSX auto-tracks the signal.
- `counter.increment(5)` dispatches to the server with typed args.
- **Only this component re-renders** when `counter.count` changes.
- No hooks, no destructuring, no loading guards. Just import and use.

### useAio — Subscribe to all state

```tsx
const Dashboard = () => {
  const { state } = useAio();
  return <span>{state.counter?.count} / {state.todo?.items.length}</span>;
};
```

Re-renders on **any** state change. Prefer direct cell access for scoped
updates.

### useLocal — Client-only state

```tsx
import { useLocal } from "aio/air";

const Tabs = () => {
  const { local: tab, set: setTab } = useLocal("overview");
  return (
    <div>
      <button onClick={() => setTab("overview")}>Overview</button>
      <button onClick={() => setTab("details")}>Details</button>
      <div>{tab === "overview" ? <Overview /> : <Details />}</div>
    </div>
  );
};
```

Signal-backed, not synced to server. Supports `set(value)`, `set(prev => next)`,
and `patch(partial)` for object state.

### useConnected — Connection status

```tsx
const StatusBadge = () => {
  const connected = useConnected();
  return <span className={connected ? "online" : "offline"} />;
};
```

---

## Local UI State with Signals

Use signals for transient UI concerns:

```tsx
import { computed, signal } from "aio/air";

const searchQuery = signal("");
const showFilters = signal(false);
const queryLength = computed(() => searchQuery.value.length);

const SearchBar = () => (
  <div>
    <input
      value={searchQuery.value}
      onInput={(e) => searchQuery.set(e.target.value)}
    />
    <span>{queryLength.value} characters</span>
  </div>
);
```

**When to use which:**

| State type                        | Use                        | Why                             |
| --------------------------------- | -------------------------- | ------------------------------- |
| Business data (persisted, shared) | Direct cell access         | Server is source of truth       |
| Component-local UI toggle         | `useLocal`                 | Signal-backed, component-scoped |
| Cross-component UI state          | `signal()` at module level | Shared without prop drilling    |
| Cached derivation                 | `computed()`               | Auto-tracked, no dep arrays     |

---

## What AIR Does Automatically

| React boilerplate              | AIR equivalent                      | Why it's automatic                                   |
| ------------------------------ | ----------------------------------- | ---------------------------------------------------- |
| `useState` + setter            | `signal` — read/write anywhere      | State lives outside components, no re-render cascade |
| `useMemo(() => ..., [deps])`   | `computed(() => ...)`               | Auto-tracks which signals are read, no dep array     |
| `useEffect(() => ..., [deps])` | `effect(() => ...)`                 | Auto-tracks dependencies, no stale closures          |
| `useCallback(fn, [deps])`      | Plain function                      | Signals read `.peek()` in handlers — always fresh    |
| `React.memo(Component)`        | Automatic                           | Props shallow-compared on every parent re-render     |
| Dependency arrays              | Nothing                             | Signals track reads automatically                    |
| Context re-render storms       | Doesn't happen                      | Context values are signals — only readers re-render  |
| `react-hook-form`              | Built-in `useForm`                  | Signal-based, field-level reactivity                 |
| `react-spring`                 | Built-in `useSpring`                | Signal-tracked spring physics                        |
| ErrorBoundary class (37 LOC)   | `<ErrorBoundary>`                   | Built-in, one line                                   |
| `<Show when={v}>`              | TypeScript narrows the truthy value | Conditional render + types                           |
| `useSWR` / `react-query`       | `resource()`                        | Signal-based async data with auto-refetch            |
