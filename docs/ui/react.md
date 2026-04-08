# AIO React Renderer

Standard React hooks connected to aio's server state pipeline. Use your existing
React knowledge — aio handles transport, persistence, and synchronization.

```tsx
import { useCell } from "aio/react";
import { createRoot } from "react-dom/client";
import { counter } from "./cell/counter.ts";

function App() {
  const { state, send } = useCell(counter);
  return (
    <button onClick={() => send.increment()}>
      Count: {state.count}
    </button>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
```

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
// Components — all hooks + routing + server symbols
import { cell, log, useCell, useLocal, useRoute } from "aio/react";

// Server-only code
import { aio, cell, log } from "aio";
```

`aio/react` is a single import for everything a component file needs.

---

## Server State Hooks

These hooks connect React to aio's server state via WebSocket/IPC. Under the
hood, they use `useSyncExternalStore` to bridge signal-based state into React.

### useCell

```tsx
import { useCell } from "aio/react";
import { counter } from "./cell/counter.ts";

function CounterDisplay() {
  const { state, send } = useCell(counter);
  return (
    <div>
      <span>Count: {state.count}</span>
      <button onClick={() => send.increment()}>+</button>
    </div>
  );
}
```

- `state` is reactive — component re-renders when the cell's state changes
- `send` has typed methods matching the cell's actions/methods
- Type inference from the cell definition

### useAio

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

Re-renders on **any** state change. Prefer `useCell` for scoped updates.

### useLocal

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
merges partial updates. Standard `useState` also works for purely local state.

### useConnected

```tsx
function StatusBar() {
  const connected = useConnected();
  return <div className={connected ? "online" : "offline"} />;
}
```

### useProjection — Derived state

```tsx
import { memo, useCell, useProjection } from "aio/react";

function FleetTable() {
  const { state } = useCell(fleet);
  const groups = useProjection(
    () => buildGroups(state.members),
    [state.members],
  );
  return groups.map((g) => <GroupRow key={g.id} group={g} />);
}
```

Derives state from a transformation, preserving element-level references for
stable React rendering via `_preserveArrayRefs`.

### useTimeTravel

```tsx
import { useTimeTravel } from "aio/react";

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

### useRoute

```tsx
function UserPage() {
  const { path, params, search, matched } = useRoute("/users/:id");
  if (!matched) return null;
  return <div>User: {params.id}</div>;
}
```

### useNavigate

```tsx
function GoHome() {
  const nav = useNavigate();
  return <button onClick={() => nav("/")}>Home</button>;
}
```

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
    </div>
  );
}
```

Same components as AIR — `Route`, `Outlet`, `Link`, `NavLink`, `Redirect`.

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

AIO's `memo` uses `_shallowEqual` per prop (one level deeper than `React.memo`'s
`===`).

### page

```tsx
import { page } from "aio/react";

function App() {
  return page(currentPage, {
    dashboard: () => <Dashboard />,
    settings: () => <Settings />,
  });
}
```

---

## Architecture

The adapter uses `useSyncExternalStore` to bridge aio's signals into React. For
embedding into an existing React app, import from `aio/adapters/react` and
provide your own transport via `setTransport()`.

## Differences from Plain React

| Aspect          | Plain React               | AIO React (`aio/react`)           |
| --------------- | ------------------------- | --------------------------------- |
| **State**       | Local only (`useState`)   | Local + server-synced (`useCell`) |
| **Transport**   | Manual (fetch, WebSocket) | Built-in WS/IPC with reconnect    |
| **Persistence** | Manual                    | Automatic (Deno.Kv)               |
| **State sync**  | Manual                    | Automatic (server -> all clients) |
| **Routing**     | react-router (external)   | Built-in signal-based             |
| **Events**      | React synthetic events    | React synthetic events            |

Everything else is standard React. `useState`, `useEffect`, third-party
libraries — all work normally. AIO's hooks are additions, not replacements.

---

## API Reference

### Server State Hooks

| Function        | Signature                               | Description       |
| --------------- | --------------------------------------- | ----------------- |
| `useCell`       | `useCell(ref): { state, send, status }` | Subscribe to cell |
| `useAio`        | `useAio(): { state, send }`             | Subscribe to all  |
| `useLocal`      | `useLocal(init): { local, set, patch }` | Client-only state |
| `useConnected`  | `useConnected(): boolean`               | Connection status |
| `useProjection` | `useProjection(fn): T`                  | Derived state     |
| `useTimeTravel` | `useTimeTravel(ref): TimeTravelState`   | Debug time travel |

### Routing

| Function      | Signature                          | Description             |
| ------------- | ---------------------------------- | ----------------------- |
| `useRoute`    | `useRoute(pattern?): RouteState`   | Current route state     |
| `useNavigate` | `useNavigate(): NavigateFn`        | Programmatic navigation |
| `Route`       | `<Route path="..." element={...}>` | Route render            |
| `Outlet`      | `<Outlet />`                       | Nested route content    |
| `Link`        | `<Link to="...">`                  | Navigation link         |
| `NavLink`     | `<NavLink to="...">`               | Link with active class  |
| `Redirect`    | `<Redirect to="...">`              | Navigate on mount       |

### Utilities

| Function             | Signature                              | Description      |
| -------------------- | -------------------------------------- | ---------------- |
| `memo`               | `memo(Component, compare?): Component` | Memoized render  |
| `page`               | `page(key, routes): VNode`             | Page-key routing |
| `connectDevTools`    | `connectDevTools(): void`              | Redux DevTools   |
| `disconnectDevTools` | `disconnectDevTools(): void`           | Disconnect       |
