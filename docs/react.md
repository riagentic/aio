# AIO React Renderer

Standard React hooks connected to aio's server state pipeline. Use your existing
React knowledge — aio handles the transport, persistence, and state
synchronization.

```tsx
import { useFeature } from "aio/react";
import { createRoot } from "react-dom/client";
import { counter } from "./features/counter.ts";

function App() {
  const { state, send } = useFeature(counter);
  return (
    <button onClick={() => send.increment()}>
      Count: {state.count}
    </button>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
```

---

## Table of Contents

- [Setup](#setup)
- [Import Path](#import-path)
- [Server State Hooks](#server-state-hooks)
  - [useFeature](#usefeature--subscribe-to-a-feature)
  - [useAio](#useaio--subscribe-to-all-state)
  - [useLocal](#uselocal--client-only-state)
  - [useConnected](#useconnected--connection-status)
  - [useProjection](#useprojection--derived-state)
  - [useTimeTravel](#usetimetravel--debug-time-travel)
- [Routing](#routing)
  - [useRoute](#useroute)
  - [useNavigate](#usenavigate)
  - [Route, Outlet, Link, NavLink, Redirect](#route-outlet-link-navlink-redirect)
- [Utilities](#utilities)
  - [memo](#memo)
  - [page](#page)
- [Server-Side Symbols](#server-side-symbols)
- [Architecture](#architecture)
- [Differences from Plain React](#differences-from-plain-react)
- [API Reference (Cheat Sheet)](#api-reference-cheat-sheet)

---

## Setup

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "jsxImportSourceTypes": "@types/react"
  },
  "imports": {
    "aio": "jsr:@riagentic/aio",
    "react": "npm:react@^18",
    "react-dom": "npm:react-dom@^18",
    "@types/react": "npm:@types/react@^18"
  }
}
```

## Import Path

```ts
// Components — all React hooks + aio state hooks + routing + server symbols
import { feature, log, useFeature, useLocal, useRoute } from "aio/react";

// Server-only code (features, types) — no renderer, no DOM
import { aio, feature, log } from "aio";
```

`aio/react` is a single import for everything a React component file needs:
aio's state hooks, routing components, and server-side symbols (feature, log,
types). You never need to import from both `aio` and `aio/react` in the same
component file.

---

## Server State Hooks

These hooks connect React components to aio's server state pipeline via
WebSocket/IPC. Under the hood, they use `useSyncExternalStore` to bridge aio's
signal-based state into React's rendering cycle.

### useFeature — Subscribe to a feature

```tsx
import { useFeature } from "aio/react";
import { counter } from "./features/counter.ts";

function CounterDisplay() {
  const { state, send } = useFeature(counter);
  return (
    <div>
      <span>Count: {state.count}</span>
      <button onClick={() => send.increment()}>+</button>
      <button onClick={() => send.decrement()}>-</button>
    </div>
  );
}
```

- `state` is reactive — component re-renders when the feature's state changes
- `send` has typed methods matching the feature's actions/methods
- Type inference: `state` and `send` are fully typed from the feature definition

### useAio — Subscribe to all state

```tsx
import { useAio } from "aio/react";

function Dashboard() {
  const { state, send } = useAio();
  return (
    <div>
      <span>Counter: {state.counter?.count}</span>
      <span>Todos: {state.todo?.items.length}</span>
    </div>
  );
}
```

Re-renders on **any** state change. Prefer `useFeature` for scoped updates.

### useLocal — Client-only state

```tsx
import { useLocal } from "aio/react";

function EditToggle() {
  const { local, set } = useLocal(false);
  return (
    <button onClick={() => set(!local)}>
      {local ? "Cancel" : "Edit"}
    </button>
  );
}
```

Not synced to server. Same API as AIR's `useLocal`. For objects, `patch()`
merges partial updates.

> **Note:** For purely local React state, standard `useState` works too. Use
> `useLocal` when you want the same API across AIR and React, or when you want
> `patch()` for object state.

### useConnected — Connection status

```tsx
import { useConnected } from "aio/react";

function StatusBar() {
  const connected = useConnected();
  return (
    <div className={connected ? "online" : "offline"}>
      {connected ? "Connected" : "Reconnecting..."}
    </div>
  );
}
```

### useProjection — Derived state

```tsx
import { useProjection } from "aio/react";
import { todos } from "./features/todos.ts";

function ActiveCount() {
  const active = useProjection(() => {
    const { state } = useFeature(todos);
    return state.items.filter((t) => !t.done);
  });
  return <span>{active.length} active</span>;
}
```

Derives state from a transformation, preserving element-level references for
stable React rendering. Uses array-ref preservation to minimize unnecessary
re-renders.

### useTimeTravel — Debug time travel

```tsx
import { useTimeTravel } from "aio/react";
import { counter } from "./features/counter.ts";

function DebugPanel() {
  const tt = useTimeTravel(counter);
  return (
    <div>
      <button onClick={tt.undo} disabled={!tt.canUndo}>Undo</button>
      <button onClick={tt.redo} disabled={!tt.canRedo}>Redo</button>
      <span>Step {tt.index + 1} / {tt.history.length}</span>
    </div>
  );
}
```

---

## Routing

AIO provides built-in routing that works with aio's server-side navigation
state. Signal-based internally but bridged to React via the hooks.

### useRoute

```tsx
import { useRoute } from "aio/react";

function UserPage() {
  const { path, params, search, matched } = useRoute("/users/:id");
  if (!matched) return null;
  return <div>User: {params.id}</div>;
}
```

**RouteState:**

| Member    | Type                     | Description              |
| --------- | ------------------------ | ------------------------ |
| `path`    | `string`                 | Current path             |
| `params`  | `Record<string, string>` | Matched route parameters |
| `search`  | `string`                 | Query string             |
| `matched` | `boolean`                | Whether pattern matched  |

### useNavigate

```tsx
import { useNavigate } from "aio/react";

function GoHome() {
  const nav = useNavigate();
  return <button onClick={() => nav("/")}>Home</button>;
}
```

Returns a function:
`(to: string | number, opts?: { replace?: boolean }) => void`

### Route, Outlet, Link, NavLink, Redirect

```tsx
import { Link, NavLink, Outlet, Redirect, Route } from "aio/react";

function App() {
  return (
    <div>
      <nav>
        <NavLink to="/" exact>Home</NavLink>
        <NavLink to="/about">About</NavLink>
      </nav>
      <Route path="about" element={<About />} />
      <Route path="users" element={<UsersLayout />}>
        <Route index element={<UserList />} />
        <Route path=":id" element={<UserDetail />} />
      </Route>
      <Route path="old" element={<Redirect to="/about" />} />
    </div>
  );
}

function UsersLayout() {
  return (
    <div>
      <h1>Users</h1>
      <Outlet />
    </div>
  );
}
```

**Route** renders its element when the path matches. Nested Routes support
layouts with `Outlet`.

**Link** navigates without page reload. **NavLink** adds `activeClass` (default
`"active"`) when the path matches. **Redirect** navigates on mount.

---

## Utilities

### memo

```tsx
import { memo } from "aio/react";

const ExpensiveList = memo(
  function ExpensiveList({ items }: { items: Item[] }) {
    return <ul>{items.map((i) => <li key={i.id}>{i.name}</li>)}</ul>;
  },
);
```

Standard `React.memo` behavior — prevents re-renders when props are shallowly
equal. Takes an optional comparison function.

### page

```tsx
import { page } from "aio/react";

function App() {
  const currentPage = "dashboard";
  return page(currentPage, {
    dashboard: () => <Dashboard />,
    settings: () => <Settings />,
  });
}
```

Renders the component matching the current page key.

---

## Server-Side Symbols

`aio/react` re-exports everything from the base `aio` package, so you can import
server-side symbols without a separate import:

```tsx
// One import does it all
import { createDB, feature, log, useFeature } from "aio/react";
```

Available server-side symbols include: `feature`, `aio`, `log`, `lint`,
`parseCli`, `VERSION`, `composeFeatures`, `bindFeature`, `testFeature`, `call`,
`markAsync`, `createDB`, `createSelector`, `createSliceSelector`,
`composeMiddleware`, `deepFreeze`, `draft`, `matchEffect`, `connectCli`,
`connectCliUDS`, and all framework types.

---

## Architecture

The React renderer uses `useSyncExternalStore` to bridge aio's signal-based
state into React's rendering cycle:

```
state-core.ts (signals, tracking proxy, send proxy)
  |
  +-- adapters/react.ts (useSyncExternalStore bridge)
  |
  +-- browser.ts (WS/IPC transport, vitals, devtools)
  |
  +-- src/react.ts (barrel: browser.ts + mod.ts re-exports)
```

The adapter subscribes to aio's state signals and triggers React re-renders when
state changes. `useSyncExternalStore` ensures React's concurrent features work
correctly — no tearing, no stale reads.

**Standalone adapter:** For embedding aio state into an existing React app
without aio's built-in transport, import from `aio/adapters/react` and provide
your own transport via `setTransport()`.

---

## Differences from Plain React

AIO's React renderer adds server state management on top of standard React.
Here's what's different:

| Aspect          | Plain React               | AIO React (`aio/react`)              |
| --------------- | ------------------------- | ------------------------------------ |
| **State**       | Local only (`useState`)   | Local + server-synced (`useFeature`) |
| **Transport**   | Manual (fetch, WebSocket) | Built-in WS/IPC with reconnect       |
| **Persistence** | Manual                    | Automatic (Deno.Kv)                  |
| **State sync**  | Manual                    | Automatic (server -> all clients)    |
| **Routing**     | react-router (external)   | Built-in signal-based                |
| **DevTools**    | React DevTools            | React DevTools + aio DevTools        |
| **Events**      | React synthetic events    | React synthetic events               |
| **JSX**         | React JSX                 | React JSX (same)                     |

Everything else is standard React. Use `useState`, `useEffect`, `useCallback`,
third-party libraries — all work normally. AIO's hooks (`useFeature`, `useAio`,
etc.) are additions, not replacements.

---

## API Reference (Cheat Sheet)

### Server State Hooks

| Function        | Signature                                  | Description                      |
| --------------- | ------------------------------------------ | -------------------------------- |
| `useFeature`    | `useFeature(ref): { state, send, status }` | Subscribe to a feature           |
| `useAio`        | `useAio(): { state, send }`                | Subscribe to all state           |
| `useLocal`      | `useLocal(init): { local, set, patch }`    | Client-only state                |
| `useConnected`  | `useConnected(): boolean`                  | Connection status                |
| `useProjection` | `useProjection(fn): T`                     | Derived state with ref stability |
| `useTimeTravel` | `useTimeTravel(ref): TimeTravelState`      | Debug time travel                |

### Routing

| Function      | Signature                          | Description              |
| ------------- | ---------------------------------- | ------------------------ |
| `useRoute`    | `useRoute(pattern?): RouteState`   | Current route state      |
| `useNavigate` | `useNavigate(): NavigateFn`        | Programmatic navigation  |
| `Route`       | `<Route path="..." element={...}>` | Conditional route render |
| `Outlet`      | `<Outlet />`                       | Nested route content     |
| `Link`        | `<Link to="...">`                  | Navigation link          |
| `NavLink`     | `<NavLink to="...">`               | Link with active class   |
| `Redirect`    | `<Redirect to="...">`              | Navigate on mount        |

### Utilities

| Function             | Signature                              | Description            |
| -------------------- | -------------------------------------- | ---------------------- |
| `memo`               | `memo(Component, compare?): Component` | Memoized component     |
| `page`               | `page(key, routes): VNode`             | Page-key routing       |
| `connectDevTools`    | `connectDevTools(): void`              | Connect Redux DevTools |
| `disconnectDevTools` | `disconnectDevTools(): void`           | Disconnect DevTools    |

### Shared (from aio base)

| Function                                          | Description                                            |
| ------------------------------------------------- | ------------------------------------------------------ |
| `feature(name, config)`                           | Define a feature                                       |
| `aio.run(config)`                                 | Start the server                                       |
| `log`                                             | Structured logger                                      |
| `msg(type)`, `actions(prefix)`, `effects(prefix)` | Action/effect creators                                 |
| `schedule`                                        | Effect scheduling (`.after`, `.every`, `.at`, `.cron`) |
| `createDB(opts)`                                  | SQLite database                                        |
| `call(opts, fn)`                                  | Async call with timeout/retry                          |
| `draft(state, fn)`                                | Immer-powered immutable updates                        |
| `createSelector(fn)`                              | Memoized state selector                                |
