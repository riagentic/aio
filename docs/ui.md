# UI & Browser

React hooks, components, styling, DevTools, and browser-side concerns.

For the docs index, see [manual.md](manual.md). For the core API (`feature`,
`useFeature`), see [core.md](core.md). For Electron & thin client, see
[electron.md](electron.md).

## `useAio<S>()` — smart state hook (recommended)

The **recommended default** for accessing app state. Returns a deep recursive
Proxy that automatically tracks which state paths your component reads. Only
subscribed paths trigger re-renders and delta updates from the server — zero
waste, zero config.

For scoped **React re-render optimization** (e.g. isolating a heavy component to
a single feature slice), see
[`useFeature(ref)`](core.md#usefeatureref--react-hook-for-features) — a
`useSyncExternalStore` selector that limits re-renders to one slice.

Connects to the server via WebSocket, syncs state, provides `send`.

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
  state. The returned object is a **Proxy** — property accesses are tracked
  automatically and sent to the server as `__subs:["path1","path2",...]` so only
  relevant deltas are broadcast back
- `send(action)` — sends action to server via WebSocket. Actions sent before the
  initial connect are queued and flushed. Actions sent while disconnected are
  **dropped** — a "Reconnecting…" indicator tells the user why
- **Singleton** — all `useAio()` calls share a single WebSocket connection per
  page. Call it from any component — no prop drilling, no duplicate connections
- Auto-reconnects on disconnect with exponential backoff (1s → 2s → 4s → 8s base
  max, ±20% jitter). If the server restarted, reconnect triggers a page reload
  to pick up fresh code
- Connection is cleaned up when the last connected component unmounts — with a
  **300ms grace period** to prevent transient teardown during React
  reconciliation or page switches. If a new subscriber arrives within 300ms, the
  connection stays alive. Both teardown and averted-teardown events emit
  `console.warn` and diagnostic events for full visibility
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

## Derived State & `memo` — preventing wasted renders

AIO's `_preserveArrayRefs` preserves element-level object references in state
arrays after delta patches (structural sharing). This enables `memo()` to skip
re-renders for unchanged elements. But if your component **transforms state**
before passing to child components, the transformation creates new container
objects that defeat structural sharing.

### The problem

```tsx
// BAD: buildGroups() creates new objects every render → all 160 rows re-render
function FleetTable() {
  const { state } = useFeature(fleet);
  const groups = buildGroups(state.members); // new refs!
  return groups.map((g) => <GroupRow key={g.id} group={g} />);
}
export default memo(FleetTable); // memo can't help — groups are always new
```

AIO preserved 145/160 member refs, but `buildGroups()` wrapped them in new group
objects. `memo()` sees new refs → re-renders everything → UI freezes.

### `useProjection(fn, deps)` — structural sharing for derived state

```tsx
import { memo, useFeature, useProjection } from "aio";

function FleetTable() {
  const { state } = useFeature(fleet);
  // useProjection applies _preserveArrayRefs to the OUTPUT
  const groups = useProjection(
    () => buildGroups(state.members),
    [state.members],
  );
  return groups.map((g) => <GroupRow key={g.id} group={g} />);
}
```

`useProjection` works like `useMemo` but goes one level deeper: when the
transform re-runs, it applies `_preserveArrayRefs` to the result. Unchanged
elements keep their previous refs — `memo()` skips them.

### `memo(Component)` — smarter default comparison

```tsx
import { memo } from "aio"; // NOT from "react"

// aio's memo uses _shallowEqual per prop (one level deeper than React.memo's ===)
export default memo(GroupRow);
```

|                                                  | `React.memo`              | `aio memo`               |
| ------------------------------------------------ | ------------------------- | ------------------------ |
| Default comparison                               | `===` per prop            | `_shallowEqual` per prop |
| `{ id: 1, name: "A" }` vs `{ id: 1, name: "A" }` | re-render (different ref) | skip (same values)       |
| Custom comparator                                | supported                 | supported (second arg)   |

### Best practice: combine both

```tsx
import { memo, useFeature, useProjection } from "aio";

function FleetTable() {
  const { state } = useFeature(fleet);
  const groups = useProjection(() => buildGroups(state.members), [
    state.members,
  ]);
  return groups.map((g) => <GroupRow key={g.id} group={g} />);
}

// memo() from aio — structural comparison as safety net
const GroupRow = memo(function GroupRow({ group }) {
  return <tr>...</tr>;
});
```

**Layer 1:** `useProjection` prevents new refs from being created. **Layer 2:**
`memo` from aio prevents re-renders even if new refs slip through. **Layer 3:**
aiol linter catches `React.memo` imports and missing `useProjection`. **Layer
4:** Runtime hint detects the symptom if all else fails.

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
shared connection. Each component's Proxy independently tracks only the paths it
reads.

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

AIO's hooks are thin wrappers over a framework-agnostic **state-core** module.
If you use Svelte, Vue, Solid, or anything else, import from `state-core`
directly and build your own adapter.

```ts
import {
  _resolveWithFallback,
  _trackingProxy,
  createSendProxy,
  type FeatureRef,
  flushOfflineQueue,
  getConnectedSignal,
  getFeatureSignal,
  getStateSignal,
  send,
  setTransport,
  trackPath,
} from "@riagentic/aio/state-core";

// Subscribe to a feature's state signal
const sig = getFeatureSignal("counter");
const unsub = sig.subscribe(() => {
  console.log("counter:", sig.peek());
});

// Send actions
send({ type: "counter:increment", payload: { by: 1 } });

// Read current state synchronously
sig.peek(); // feature state snapshot
getStateSignal().peek(); // full app state
```

**Transport:** Standalone adapters need a transport connected via
`setTransport({ send, close })`. After connecting, call `flushOfflineQueue()` to
deliver any actions queued before the transport was ready.

For the full adapter architecture, custom adapter guide, and state-core API
reference, see
[renderer.md — Adapter Architecture](renderer.md#adapter-architecture).

### Svelte 5 example (runes)

```svelte
<script>
  import { getStateSignal } from '@riagentic/aio/state-core'

  const sig = getStateSignal()
  let state = $state(sig.peek())
  $effect(() => {
    return sig.subscribe(() => { state = sig.peek() })
  })
</script>

<button onclick={() => send({ type: 'counter:increment', payload: {} })}>
  Count: {state?.counter?.count ?? '...'}
</button>
```

### Vue 3 example (composable)

```ts
import { onUnmounted, ref } from "vue";
import { getStateSignal, send } from "@riagentic/aio/state-core";

export function useAio() {
  const sig = getStateSignal();
  const state = ref(sig.peek());
  const unsub = sig.subscribe(() => {
    state.value = sig.peek();
  });
  onUnmounted(unsub);
  return { state, send };
}
```

> **Note:** Non-React/AIR adapters are community-maintained. The `state-core`
> API is stable and supported — adapters built on it are your responsibility.

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

## Delta sync and React performance

State travels from server to browser as JSON over WebSocket. JSON kills object
references — but aio restores them. Here's how it works and what it means for
your components.

### How patches preserve references

The server sends **delta patches** (only changed keys) by default. On the
browser side, `_applyPatch` shallow-merges patches into existing state and uses
`_shallowEqual` to check each slice. If a slice didn't actually change, **the
previous object reference is reused**. This means:

- `useFeature(ref)` selectors (a React re-render optimization) return the same
  reference for unchanged slices
- `React.memo` comparators work correctly — unchanged props keep identity
- You do **not** need extra `useMemo` wrappers around feature state

### When references break

Two cases cause full object replacement (all references lost):

1. **First connect** — no previous state exists, everything is new
2. **Full state message** — when >50% of flattened keys changed in one broadcast
   cycle, the server sends the full state instead of a patch (configurable via
   `fullStateThreshold`)

Design state so that a single action changes a small number of keys. If most
keys change every broadcast, all memos fail every time.

### Delta granularity

For namespaced state (`{ counter: { count }, dashboard: { items } }`), deltas
are computed one level deep — changing `counter.count` sends only that sub-key,
not the entire `counter` slice. This makes `useFeature` efficient even with
large feature slices.

### Built-in render diagnostics

aio detects performance problems automatically via the **Render Meter** — a
rAF-based monitor that tracks staleness (how far behind the UI is) and provides
actionable feedback:

- **Staleness gauge** — measures `now - lastPatchAt` for unpainted patches.
  Status transitions: healthy → degraded (≥1x threshold) → warning (≥2x) →
  frozen (≥5x) → recovered. Each transition emits a console warning with a
  diagnostic hint
- **Actionable hints** — when staleness is high, the meter identifies the likely
  cause: expensive components (high frame time), too many patches (high pending
  count), or main-thread blocking (neither high). Hints suggest specific fixes
  like `React.memo()`, `syncIntervalMs`, or profiling
- **Notification coalescing** — multiple WS patches within a single frame
  produce one React notification, reducing unnecessary reconciliation passes
- **Server backpressure** — the client reports staleness in its vitals ping; the
  server adapts per-client broadcast rate (1x/2x/4x multiplier) so struggling
  clients aren't overwhelmed with updates they can't paint
- **Capacity gauges** — four 0–100% gauges (staleness, frameTime,
  pendingPatches, paintRate) available at `/__aio/vitals` and via `getGauges()`
  for custom monitoring
- **Listener high-water mark** — peak listener count is tracked and reported
  during teardown. A sudden spike suggests a subscription leak

Check browser console for `[aio:vitals]` messages — they surface real issues
before users notice.

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
  prop-drilling needed. Each call-site's Proxy tracks only the paths that
  component actually reads
- Sub-components can either take props (pure view) or call `useAio()` directly
  (connected) — the Proxy ensures only accessed paths trigger updates
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
