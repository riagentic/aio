# AIR Routing

AIR's router is signal-based — route changes auto-track like any other signal.
Uses the History API — no page reloads.

---

## SPA Fallback

The dev server automatically serves the app shell for any extensionless path
that doesn't exist as a file (`/users`, `/users/42`, `/dashboard/settings`).
Deep links just work without server configuration.

---

## useRoute()

```ts
function useRoute(pattern?: string): RouteState;
```

Subscribe to the current URL. Re-renders the component on navigation.

```tsx
import { useRoute } from "aio/air";
import { NotFound } from "./pages.tsx";

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

**RouteState:**

| Field     | Type                     | Description                         |
| --------- | ------------------------ | ----------------------------------- |
| `path`    | `string`                 | Current `location.pathname`         |
| `params`  | `Record<string, string>` | Named params from pattern (decoded) |
| `search`  | `URLSearchParams`        | Current query string                |
| `matched` | `boolean`                | Whether the pattern matched         |

---

## navigate() / useNavigate()

Programmatic navigation. Use `<Link>` for user-initiated navigation; use
`navigate`/`useNavigate` for code-driven navigation.

```tsx
import { navigate, useNavigate } from "aio/air";
import { save } from "./api.ts";

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

Relative paths resolve against `location.href`.

---

## Route and Outlet

Declarative route matching. Routes can be flat or nested into layout trees.

**Flat routes:**

```tsx
import { Route } from "aio/air";
import { Nav, NotFound, Settings, UserDetail, UserList } from "./pages.tsx";

const App = () => (
  <div>
    <Nav />
    <Route path="/users" element={<UserList />} />
    <Route path="/users/:id" element={<UserDetail />} />
    <Route path="/settings" element={<Settings />} />
    <Route path="*" element={<NotFound />} />
  </div>
);
```

**Nested layout routes:**

```tsx
import { Outlet, Route } from "aio/air";
import { Overview, Settings, Sidebar, UserList } from "./pages.tsx";

function DashboardLayout() {
  return (
    <div className="dashboard">
      <Sidebar />
      <main>
        <Outlet />
      </main>
    </div>
  );
}

// In App.tsx
<Route path="/dashboard" element={<DashboardLayout />}>
  <Route index element={<Overview />} />
  <Route path="users" element={<UserList />} />
  <Route path="settings" element={<Settings />} />
</Route>;
```

`index` marks the default child — renders when the parent path matches exactly.

**RouteProps:**

| Prop       | Type      | Description                                    |
| ---------- | --------- | ---------------------------------------------- |
| `path`     | `string`  | Pattern — supports `:param` and `*`            |
| `index`    | `boolean` | Default child (matches parent path exactly)    |
| `element`  | `VNode`   | What to render on match                        |
| `children` | `VNode`   | Nested `<Route>` elements (enables `<Outlet>`) |

---

## Link and NavLink

Client-side navigation anchors. Both prevent full page reload.

```tsx
import { Link, NavLink } from "aio/air";

export const nav = (
  <>
    <Link to="/users">All users</Link>
    <Link to="/users" replace>Replace history entry</Link>

    {/* Active styling */}
    <Link to="/settings" activeClass="active">Settings</Link>
    <Link to="/" exact activeClass="selected">Home</Link>

    {/* NavLink — automatic 'active' class */}
    <NavLink to="/dashboard">Dashboard</NavLink>
    <NavLink to="/settings" activeClass="current-page">Settings</NavLink>
  </>
);
```

**Active matching rules:**

- `exact={true}` or `to="/"` -> exact match only
- Default -> prefix match: `/users` is active on `/users` and `/users/42`

**LinkProps:**

| Prop          | Type      | Default  | Description                               |
| ------------- | --------- | -------- | ----------------------------------------- |
| `to`          | `string`  | required | Target path                               |
| `replace`     | `boolean` | `false`  | Use `replaceState` instead of `pushState` |
| `exact`       | `boolean` | `false`  | Exact match for active detection          |
| `activeClass` | `string`  | --       | CSS class added when active               |
| `activeStyle` | `object`  | --       | Inline styles merged when active          |
| `children`    | `VNode`   | --       | Link content                              |

All other props (`className`, `style`, `aria-*`) pass through to `<a>`.

---

## Redirect

Navigate on mount — useful for auth guards. Does not render anything.

```tsx
import { Redirect, useAio } from "aio/air";
import { Dashboard } from "./pages.tsx";

type AppState = { user: string | null };

function ProtectedPage() {
  const { state } = useAio<AppState>();
  if (!state) return null;
  if (!state.user) return <Redirect to="/login" />;
  return <Dashboard />;
}
```

`replace` defaults to `true` — no history entry added.

---

## Path Pattern Syntax

Used by `<Route path>` and `useRoute(pattern)`:

| Pattern               | Matches                             | Params                   |
| --------------------- | ----------------------------------- | ------------------------ |
| `/users`              | `/users` or `/users/` exactly       | `{}`                     |
| `/users/:id`          | `/users/42`                         | `{ id: '42' }`           |
| `/a/:x/b/:y`          | `/a/foo/b/bar`                      | `{ x: 'foo', y: 'bar' }` |
| `*`                   | any path                            | `{ '*': '/the/path' }`   |
| `/dashboard` (prefix) | `/dashboard`, `/dashboard/settings` | `{}`                     |

Params are URL-decoded automatically. Routes with children use prefix matching;
leaf routes use exact matching.

---

## Full Example

```tsx
import { Link, NavLink, Redirect, Route, useAio } from "aio/air";
import { Home, Settings, UserDetail, UserList } from "./pages.tsx";

type AppState = { user: string | null; users: unknown[] };

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

      {!state.user && <Redirect to="/login" />}
    </div>
  );
}
```

---

## page() — State-Based Routing

For Electron, kiosk, or single-tab apps where URL doesn't matter:

```tsx
import { page, useAio } from "aio/air";
import { Home, Settings } from "./pages.tsx";

type AppState = { page: string };

export default function App() {
  const { state, send } = useAio<AppState>();
  if (!state) return <div>Connecting...</div>;

  const go = (p: string) => send({ type: "nav:go", payload: { args: [p] } });

  return (
    <div>
      <button onClick={() => go("home")}>Home</button>
      <button onClick={() => go("settings")}>Settings</button>
      {page(state.page, { home: Home, settings: Settings })}
    </div>
  );
}
```

Returns `null` if no route matches.
