# UI & Browser

React hooks, components, styling, DevTools, and browser-side concerns.

For the docs index, see [manual.md](manual.md). For the core API (`feature`,
`useFeature`), see [core.md](core.md). For Electron & thin client, see
[electron.md](electron.md).

## `useAio<S>()` — full state hook

React hook for **root layout, routing, and cross-feature views** — full app
state + untyped `send`. For feature components, use
[`useFeature(ref)`](core.md#usefeatureref--react-hook-for-features) — scoped
state, typed `send`, machine `status`, and selective re-renders.

React hook — connects to the server via WebSocket, syncs state, provides `send`.

```tsx
import { useAio } from "aio";
import type { AppState } from "./state.ts";

export default function App() {
  const { state, send } = useAio<AppState>();

  // state is null until first message arrives
  if (!state) return <div>Connecting...</div>;

  // send() takes any { type, payload } — use action creators for type safety
  return <button onClick={() => send(A.increment())}>+</button>;
}
```

**Details:**

- `state: S | null` — `null` until WebSocket connects and server sends initial
  state
- `send(action)` — sends action to server via WebSocket. Actions sent before the
  initial connect are queued and flushed. Actions sent while disconnected are
  **dropped** — a "Reconnecting…" indicator tells the user why
- **Singleton** — all `useAio()` calls share a single WebSocket connection per
  page. Call it from any component — no prop drilling, no duplicate connections
- Auto-reconnects on disconnect with exponential backoff (1s → 2s → 4s → 8s base
  max, ±20% jitter). If the server restarted, reconnect triggers a page reload
  to pick up fresh code
- Connection is cleaned up when the last connected component unmounts
- Generic `<S>` types the state — use your `AppState` type

**No boilerplate needed in App.tsx:**

- No `import React` — JSX transforms are automatic
- No `createRoot` — the framework mounts your default export
- No WebSocket setup — `useAio` handles it
- Just `export default function App()` and you're done

## `useLocal<T>(initial)`

Client-only state hook — not synced to server, not persisted. For ephemeral UI
concerns like "which item am I editing", form inputs, dropdown open/closed.

```tsx
import { useAio, useLocal } from "aio";

export default function App() {
  const { state, send } = useAio<AppState>();
  const { local, set } = useLocal({ editing: null as string | null });

  if (!state) return <div>Connecting...</div>;

  return (
    <ul>
      {state.todos.map((t) => (
        <li
          key={t.id}
          onClick={() => set({ editing: t.id })}
        >
          {local.editing === t.id ? <input /> : t.text}
        </li>
      ))}
    </ul>
  );
}
```

`useLocal` is just a typed `useState` wrapper with a consistent API. Use it when
state doesn't need to survive page reload or be shared across tabs.

## `page(current, routes)`

Renders the component matching a page key from state. Simple state-based routing
with no URL sync needed.

```tsx
import { page, useAio } from "aio";
import { Home } from "./pages/Home.tsx";
import { Settings } from "./pages/Settings.tsx";

export default function App() {
  const { state, send } = useAio<AppState>();
  if (!state) return <div>Connecting...</div>;

  return (
    <div>
      <nav>
        <button onClick={() => send(A.navigate("home"))}>Home</button>
        <button onClick={() => send(A.navigate("settings"))}>Settings</button>
      </nav>
      {page(state.page, { home: Home, settings: Settings })}
    </div>
  );
}
```

Returns `null` if no route matches. Page components call `useAio()` internally
if they need state — since it's a singleton, each page component gets the same
shared connection.

## URL-based routing

For real web apps with browser URLs, deep links, and back/forward navigation.
Uses the History API — no page reloads.

**When to use `page()` vs URL routing:**

- `page()` — Electron, kiosk, or single-tab apps where URL doesn't matter
- URL routing — public websites, apps that need shareable links, native browser
  navigation

### SPA fallback

The dev server automatically serves the app shell for any extensionless path
that doesn't exist as a file (`/users`, `/users/42`, `/dashboard/settings`).
Deep links just work without server configuration.

### `useRoute(pattern?)`

Subscribe to the current URL. Re-renders the component on navigation.

```tsx
import { useRoute } from "aio";

// No pattern — track path and search params
function Layout() {
  const { path, search } = useRoute();
  return <div>Current: {path} {search.get("tab")}</div>;
}

// With pattern — extract named params, check if matched
function UserPage() {
  const { params, matched } = useRoute("/users/:id");
  if (!matched) return <NotFound />;
  return <div>User {params.id}</div>;
}
```

`RouteState` fields:

| Field     | Type                     | Description                         |
| --------- | ------------------------ | ----------------------------------- |
| `path`    | `string`                 | Current `location.pathname`         |
| `params`  | `Record<string, string>` | Named params from pattern (decoded) |
| `search`  | `URLSearchParams`        | Current query string                |
| `matched` | `boolean`                | Whether the pattern matched         |

### `navigate(to, opts?)` / `useNavigate()`

Programmatic navigation. Use `<Link>` for user-initiated navigation; use
`navigate`/`useNavigate` for code-driven navigation (after form submit, auth
redirect, etc).

```tsx
import { navigate, useNavigate } from "aio";

// Direct call (outside components)
navigate("/dashboard");
navigate(-1); // browser back
navigate("/login", { replace: true }); // no history entry

// Inside a component
function SaveButton() {
  const nav = useNavigate();
  async function handleSave() {
    await save();
    nav("/dashboard");
  }
  return <button onClick={handleSave}>Save</button>;
}
```

Relative paths resolve against `location.href` — so `navigate('./edit')` from
`/users/42` goes to `/users/edit`.

### `<Route>` and `<Outlet>`

Declarative route matching. Routes can be flat or nested into layout trees.

**Flat routes:**

```tsx
import { Route, useAio } from "aio";
import { UserList } from "./pages/UserList.tsx";
import { UserDetail } from "./pages/UserDetail.tsx";
import { Settings } from "./pages/Settings.tsx";
import { NotFound } from "./pages/NotFound.tsx";

export default function App() {
  const { state } = useAio<AppState>();
  if (!state) return <div>Connecting...</div>;

  return (
    <div>
      <Nav />
      <Route path="/users" element={<UserList />} />
      <Route path="/users/:id" element={<UserDetail />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="*" element={<NotFound />} />
    </div>
  );
}
```

**Nested layout routes:**

```tsx
import { Outlet, Route } from "aio";
import { DashboardLayout } from "./layouts/DashboardLayout.tsx";

// DashboardLayout.tsx
export function DashboardLayout() {
  return (
    <div className="dashboard">
      <Sidebar />
      <main>
        <Outlet /> {/* matched child renders here */}
      </main>
    </div>
  );
}

// In App.tsx
<Route path="/dashboard" element={<DashboardLayout />}>
  <Route index element={<Overview />} /> {/* /dashboard */}
  <Route path="users" element={<UserList />} /> {/* /dashboard/users */}
  <Route path="settings" element={<Settings />} />
  {/* /dashboard/settings */}
</Route>;
```

`index` marks the default child — renders when the parent path matches exactly.

**`RouteProps`:**

| Prop       | Type        | Description                                    |
| ---------- | ----------- | ---------------------------------------------- |
| `path`     | `string`    | Pattern — supports `:param` and `*`            |
| `index`    | `boolean`   | Default child (matches parent path exactly)    |
| `element`  | `ReactNode` | What to render on match                        |
| `children` | `ReactNode` | Nested `<Route>` elements (enables `<Outlet>`) |

### `<Link>` and `<NavLink>`

Client-side navigation anchors. Both prevent full page reload and use the
History API.

```tsx
import { Link, NavLink } from 'aio'

// Link — basic navigation
<Link to="/users">All users</Link>
<Link to="/users/42">User 42</Link>
<Link to="/users" replace>Replace history entry</Link>

// Active styling
<Link to="/settings" activeClass="active">Settings</Link>
<Link to="/" exact activeClass="selected">Home</Link>

// NavLink — automatic 'active' class (prefix match by default, exact for '/')
<NavLink to="/dashboard">Dashboard</NavLink>
<NavLink to="/settings" activeClass="current-page">Settings</NavLink>
```

**Active matching rules:**

- `exact={true}` or `to="/"` → exact match only
- Default → prefix match: `/users` is active on `/users` and `/users/42`

**`LinkProps`:**

| Prop          | Type        | Default  | Description                               |
| ------------- | ----------- | -------- | ----------------------------------------- |
| `to`          | `string`    | required | Target path                               |
| `replace`     | `boolean`   | `false`  | Use `replaceState` instead of `pushState` |
| `exact`       | `boolean`   | `false`  | Exact match for active detection          |
| `activeClass` | `string`    | —        | CSS class added when active               |
| `activeStyle` | `object`    | —        | Inline styles merged when active          |
| `children`    | `ReactNode` | —        | Link content                              |

All other props (`className`, `style`, `aria-*`, etc.) pass through to the `<a>`
element.

### `<Redirect>`

Navigate on mount — useful for auth guards and conditional redirects. Does not
render anything.

```tsx
import { Redirect, useAio } from "aio";

function ProtectedPage() {
  const { state } = useAio<AppState>();
  if (!state) return null;
  if (!state.user) return <Redirect to="/login" />;
  return <Dashboard />;
}
```

`replace` defaults to `true` — the redirect does not add a history entry.

### Path pattern syntax

Used by `<Route path>`, `useRoute(pattern)`, and `matchPath()`:

| Pattern               | Matches                             | Params                   |
| --------------------- | ----------------------------------- | ------------------------ |
| `/users`              | `/users` or `/users/` exactly       | `{}`                     |
| `/users/:id`          | `/users/42`                         | `{ id: '42' }`           |
| `/a/:x/b/:y`          | `/a/foo/b/bar`                      | `{ x: 'foo', y: 'bar' }` |
| `*`                   | any path                            | `{ '*': '/the/path' }`   |
| `/dashboard` (prefix) | `/dashboard`, `/dashboard/settings` | `{}`                     |

Params are URL-decoded automatically. Routes with children use prefix matching;
leaf routes use exact matching.

### Full example

```tsx
import { Link, NavLink, Redirect, Route, useAio } from "aio";

export default function App() {
  const { state } = useAio<AppState>();
  if (!state) return <div>Connecting...</div>;

  return (
    <div>
      <nav>
        <NavLink to="/">Home</NavLink>
        <NavLink to="/users">Users</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>

      <Route path="/" element={<Home />} />
      <Route path="/users" element={<UserList users={state.users} />} />
      <Route path="/users/:id" element={<UserDetail users={state.users} />} />
      <Route path="/settings" element={<Settings />} />

      {/* Auth guard */}
      {!state.user && <Redirect to="/login" />}
    </div>
  );
}
```

## Redux DevTools integration

Connect to the Redux DevTools browser extension for state inspection and action
history.

```tsx
// In App.tsx
import { connectDevTools, useAio } from "aio";

export default function App() {
  const { state, send } = useAio<AppState>();

  // Connect to DevTools in development
  useEffect(() => {
    if (import.meta.env.DEV) {
      connectDevTools();
    }
  }, []);

  // ... rest of component
}
```

**What you see:**

- State tree in DevTools inspector
- Action history with type and payload
- State diffs on each action

**Limitations:**

- Time-travel via DevTools is not supported (use `Ctrl+.` panel instead)
- DevTools must be installed and enabled in browser

## Bring Your Own Framework

The React hooks (`useAio`, `useFeature`, `useLocal`) are thin wrappers over a
framework-agnostic core. If you use Svelte, Vue, Solid, or anything else, use
`client` directly — it exposes the same singleton WebSocket connection, state,
and routing.

```ts
import { client } from "aio";

// Subscribe to state changes — returns unsubscribe
const unsub = client.subscribe((state) => {
  // state is the full app state object (same shape as useAio's state)
  console.log("counter:", state.counter);
});

// Send actions
client.send({ type: "counter:increment", payload: { by: 1 } });

// Read current state synchronously
client.getState(); // full state
client.getFeatureState("counter"); // single feature slice

// Routing
client.route.subscribe(() => {/* URL changed */});
client.route.getPath(); // current pathname
client.route.getSearch(); // URLSearchParams
client.route.navigate("/users/42");
client.route.navigate(-1); // browser back
```

**Lifecycle:** The WebSocket connects on the first `client.subscribe()` call and
disconnects when the last subscriber unsubscribes — same behavior as `useAio`.
React hooks and `client` share the same connection.

### Svelte 5 example (runes)

```svelte
<script>
  import { client } from 'aio'

  let state = $state(client.getState())
  $effect(() => {
    return client.subscribe(s => { state = s })
  })
</script>

<button onclick={() => client.send({ type: 'counter:increment', payload: {} })}>
  Count: {state?.counter?.count ?? '...'}
</button>
```

### Vue 3 example (composable)

```ts
import { onUnmounted, ref } from "vue";
import { client } from "aio";

export function useAio() {
  const state = ref(client.getState());
  const unsub = client.subscribe((s) => {
    state.value = s;
  });
  onUnmounted(unsub);
  return { state, send: client.send };
}
```

> **Note:** Non-React adapters are community-maintained. The `client` API is
> stable and supported — adapters built on it are your responsibility.

## UI state filtering

Use `stateForUI` to control what the browser sees. Useful for stripping
server-only data:

```ts
await aio.run({
  features: [myFeature],
  stateForUI: (s) => ({
    counter: s.counter,
    username: s.username,
    // s.apiKey is NOT sent to the browser
  }),
});
```

When `stateForUI` is set, `useAio<T>()` should use the filtered shape as its
generic, not the full `AppState`.

### Per-user stateForUI

`stateForUI` accepts an optional `user` — an `AioUser` object resolved from the
client's auth token. Useful for role-based state filtering:

```ts
await aio.run({
  features: [myFeature],
  users: {
    "alice-token": { id: "alice", role: "admin" },
    "bob-token": { id: "bob", role: "viewer" },
  },
  stateForUI: (state, user?) => {
    if (user?.role === "admin") return state; // admins see everything
    return { items: state.items.filter((i) => i.ownerId === user?.id) };
  },
});
```

**How it works:**

1. Each WebSocket connection resolves an `AioUser` from its auth token
2. On every broadcast, `stateForUI(state, user?)` is called per client
3. Delta patches are computed per client — each client has its own delta cache.
   For v0.5 namespaced state, patches are granular to sub-keys within feature
   slices (e.g. only `scrollY` is sent, not the entire feature)
4. `user` is `undefined` in public mode (no `users` config)

**Backwards compatible:** If your `stateForUI` doesn't use `user`, all clients
get the same state.

## Styling

AIO auto-detects `src/style.css` and injects it into the HTML `<head>`
automatically. No manual `<link>` tag needed.

**Option 1: `src/style.css`** (recommended) — create the file, it's
auto-injected:

```css
/* src/style.css */
body {
  font-family: system-ui;
  margin: 0;
}
.app {
  padding: 2rem;
}
button {
  padding: 0.5rem 1rem;
}
```

Use `@import` inside `style.css` to split into multiple files. Changes trigger
CSS hot reload in dev mode. Automatically copied to `dist/` during builds.

**Option 2: Inline styles** — simplest, no extra files:

```tsx
<button style={{ padding: "0.5rem", fontSize: "1rem" }}>Click</button>;
```

**Option 3: CDN CSS frameworks** — add `<link>` in App.tsx:

```tsx
<link
  rel="stylesheet"
  href="https://cdn.jsdelivr.net/npm/water.css@2/out/water.css"
/>;
```

**Note:** `import './style.css'` in TypeScript does **not** work — esbuild
transpiles TS/TSX only.

## Components

Split your UI into multiple files — just import them normally. All `.tsx` files
in `src/` are auto-transpiled.

```
src/
  App.tsx              ← entry (export default)
  components/
    Header.tsx
    Sidebar.tsx
```

```tsx
// src/App.tsx
import { useAio } from "aio";
import { Header } from "./components/Header.tsx";

export default function App() {
  const { state, send } = useAio<AppState>();
  if (!state) return <div>Connecting...</div>;
  return <Header title={state.title} />;
}
```

```tsx
// src/components/Header.tsx — no useAio needed, just props
export function Header({ title }: { title: string }) {
  return <h1>{title}</h1>;
}
```

**Guidelines:**

- `useAio()` is a singleton — call it from any component that needs state. No
  prop-drilling needed
- Sub-components can either take props (pure view) or call `useAio()` directly
  (connected)
- Use `useLocal()` for ephemeral UI state (editing flags, input focus,
  dropdowns) — not app data

## Electron

See [electron.md](electron.md) for the full reference — setup, configuration,
window persistence, thin client, and window metadata.

## Error overlay

When a `.ts` or `.tsx` file has a syntax error, AIO shows the error directly on
the page instead of a blank white screen.

**What you see in the browser:**

```
┌──────────────────────────────────────────────┐
│ Build Error                                   │
│                                               │
│ App.tsx: Error: Transform failed with 1 error │
│ <stdin>:5:0: ERROR: Unexpected "}"            │
└──────────────────────────────────────────────┘
```

**How it works:**

1. esbuild transpile fails → error stored server-side
2. The module returns `throw new Error(...)` so the bootstrap `import()` catches
   it
3. Bootstrap fetches the full error from `/__aio/error` and renders it on page
4. A WebSocket listener stays active on the error page for live reload
5. Fix the file → save → live reload triggers → page shows working app again

**The fix-save-reload cycle:**

1. You have a syntax error → error overlay appears
2. You fix the error in your editor and save
3. File watcher detects the change → sends `__reload`
4. Browser reloads → transpile succeeds → app renders normally

No manual refresh needed. Just fix and save.

## Time-Travel

In dev mode, aio records every action and state snapshot, letting you undo,
redo, and jump to any past state. Zero cost in prod.

### Built-in panel

Press **Ctrl+.** (Ctrl + Period) to toggle a floating panel — no code changes to
your App.tsx required. The panel shows action history with timestamps,
undo/redo/goto buttons, and pause/resume controls. It only appears in dev mode.
A styled console message confirms activation on connect.

The panel is pure DOM (not React) so it doesn't interfere with your app's
component tree or re-renders.

### `useTimeTravel()`

For custom UIs, use the `useTimeTravel()` hook instead of (or alongside) the
built-in panel.

Browser hook — returns TT controls in dev mode, `null` in prod.

```tsx
import { useAio, useTimeTravel } from "aio";

export default function App() {
  const { state, send } = useAio<AppState>();
  const tt = useTimeTravel();

  if (!state) return <div>Connecting...</div>;

  return (
    <div>
      <div>Count: {state.counter}</div>
      <button onClick={() => send(A.increment())}>+</button>

      {tt && (
        <div
          style={{
            marginTop: "1rem",
            padding: "1rem",
            background: "#1e1e1e",
            color: "#ccc",
            borderRadius: 8,
            fontFamily: "monospace",
          }}
        >
          <div>
            <b>Time Travel</b> — {tt.index + 1}/{tt.entries.length}
            {tt.paused && <span style={{ color: "#f44" }}>(paused)</span>}
          </div>
          <div style={{ marginTop: 8 }}>
            <button onClick={tt.undo} disabled={tt.index <= 0}>Undo</button>
            <button
              onClick={tt.redo}
              disabled={tt.index >= tt.entries.length - 1}
            >
              Redo
            </button>
            {tt.paused
              ? <button onClick={tt.resume}>Resume</button>
              : <button onClick={tt.pause}>Pause</button>}
          </div>
          <ul
            style={{
              maxHeight: 200,
              overflow: "auto",
              margin: "8px 0",
              padding: 0,
              listStyle: "none",
            }}
          >
            {tt.entries.map((e, i) => (
              <li
                key={e.id}
                onClick={() => tt.goto(e.id)}
                style={{
                  cursor: "pointer",
                  padding: "2px 4px",
                  background: i === tt.index ? "#333" : "transparent",
                }}
              >
                {e.type}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

### Return value

`useTimeTravel()` returns `null` in prod mode. In dev mode:

| Field      | Type                   | Description                                             |
| ---------- | ---------------------- | ------------------------------------------------------- |
| `entries`  | `{ id, type, ts }[]`   | Action history (type name only, no payload/state)       |
| `index`    | `number`               | Current position in history                             |
| `paused`   | `boolean`              | Whether dispatch is frozen                              |
| `undo()`   | `() => void`           | Step back one action (auto-pauses)                      |
| `redo()`   | `() => void`           | Step forward one action (stays paused)                  |
| `goto(id)` | `(id: number) => void` | Jump to specific entry by id (auto-pauses)              |
| `pause()`  | `() => void`           | Freeze state — new actions are dropped                  |
| `resume()` | `() => void`           | Unfreeze — truncates forward history (branch, not tree) |

### Behavior

- **Auto-pause on undo/goto**: Prevents new actions from overwriting the
  historical state you're inspecting
- **Resume truncates forward**: Standard undo/redo semantics — resuming from the
  middle discards the forward branch
- **200 entry cap**: Oldest entries are evicted. At ~1KB per state snapshot,
  that's ~200KB — negligible for local tools
- **Wire-safe**: Only action types are sent to the browser (no payloads, no
  state snapshots) — keeps WS messages small
- **Zero cost in prod**: TT code is only instantiated behind a dev-mode guard —
  no overhead in production

### WS protocol

The debugger uses `__tt:` prefixed messages over the existing WebSocket:

**Server → client:**
`__tt:{"entries":[{id,type,ts},...], "index":N, "paused":bool}` **Client →
server:** `__tt:undo`, `__tt:redo`, `__tt:goto:5`, `__tt:pause`, `__tt:resume`

These are handled transparently by `useTimeTravel()` — you don't need to
interact with the protocol directly.
