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
function useRoute(pattern?: string): RouteState; // as before
function useRoute<const S extends string>(
  pattern: S,
): RouteState<RouteParams<S>>;
```

Subscribe to the current URL. Re-renders the component on navigation.

**A literal pattern types its own params.** `useRoute("/users/:id")` gives
`params.id`, and `params.idd` is a compile error rather than `undefined` at
runtime:

```tsx
const { params } = useRoute("/users/:id/posts/:postId");
params.postId; // string
params.postld; // ✗ compile error — that key is not in the pattern
```

Everything is still `string` — that is what a URL segment is. What you gain is
the KEY SET. A computed (non-literal) pattern keeps the open
`Record<string, string>`, because a pattern nobody typed promises nothing about
its keys.

The hand-spelled form still works exactly as before —
`useRoute<{ id: string }>("/users/:id")` — and so does every existing call: the
previous signature is the first overload.

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

| Field     | Type              | Description                                                                                      |
| --------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `path`    | `string`          | Current `location.pathname`                                                                      |
| `params`  | `RouteParams<S>`  | Named params from pattern (decoded) — `Record<string, string>` when the pattern is not a literal |
| `search`  | `URLSearchParams` | Current query string                                                                             |
| `matched` | `boolean`         | Whether the pattern matched                                                                      |

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

## Standalone (Android) builds

The router is the same on every target — routing is state (a signal over
`location`) plus the history API, and a WebView has both. `<Route>`, `<Link>`,
`<NavLink>`, `<Outlet>`, `<Redirect>`, `useRoute()`, `useNavigate()` and
`navigate()` import from `aio/air` exactly as in the browser build; the
standalone runtime boots the cells before the first route renders.

Two things are specific to a packaged app:

- **The shell's document is `/`.** The APK's asset loader serves
  `…/assets/index.html`, so `location.pathname` does not start at `/`. The
  runtime adopts the shell's directory as the route base at boot:
  `<Route
  path="/">` matches the first screen, `navigate("/settings")` writes
  `/assets/settings` to history, and `routePath.value` reads `/settings`. No app
  code changes.
- **Back is the hardware button.** The Android shell maps it to
  `history.back()`, so every `navigate()` is a real history entry and back
  behaves as in a browser. A recreated activity (rotation, process death)
  reloads the shell and starts at `/` again — keep screen identity in cell state
  if it must survive that, exactly as you would for a browser reload.

## Per-page `<head>` — useHead()

A page owns its title, description and canonical link for as long as it is
mounted. Call it in the component body, like any hook:

```tsx
import { useHead } from "aio/air";

function Post({ id }: { id: string }) {
  const post = blog.posts[id];
  useHead({
    title: `${post.title} — My Blog`,
    meta: [{ name: "description", content: post.summary }],
    link: [{ rel: "canonical", href: `https://example.com/p/${id}` }],
  });
  return <article>…</article>;
}
```

- **Reactive.** `post.title` is read during render, so when it changes the
  component re-renders and the tab title follows.
- **Nested.** A layout can set the app's default (`title: "My Blog"`, an
  `og:site_name`); a page inside it overrides the title and replaces the tags
  that share an identity (`meta` by `name`/`property`, `link` by `rel`+`href`,
  `canonical`/`manifest`/`icon` by `rel` alone). Leave the page and the layout's
  values are back; unmount every owner and the document's original title is
  restored.
- **Render-driven, not router-driven.** It works with `<Route>`, `page()`, a tab
  switch or a modal — anything that mounts and unmounts — because the renderer
  already knows when that happens.
- **On the server**, inside `renderToString`, nothing is written; the entries
  are collected and `collectHead()` returns them as markup for your own
  `<head>`, exactly like `collectCss()`:

```ts
const body = renderToString(<App />); // sync — the head is known after it
const html =
  `<!doctype html><html><head>${collectHead()}${collectCss()}</head>` +
  `<body><div id="app">${body}</div></body></html>`;
```

The tags carry `data-aio-head`, so on hydration the client takes them over. With
`renderToStream` the head is complete only when the stream ends — render the
page once with `renderToString` for its head, or write the head after.

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
