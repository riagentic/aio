# Browser

WebSocket client API, connection lifecycle, and UI state management for browser
clients.

For the core API (`cell`), see [Concepts](../basics/concepts.md). For Electron & thin
client, see [electron.md](electron.md).

## Direct cell access (recommended)

Import cells and use their properties directly — reactive and auto-tracked. For
full-state access, `useAio()` is also available but re-renders on any change.

For scoped re-render optimization, import and read from specific cells.

```tsx
import { useAio } from "aio/air";
import type { AppState } from "./state.ts";

export default function App() {
  const { state, send } = useAio<AppState>();

  if (!state) return <div>Connecting...</div>;

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
  **dropped** — a "Reconnecting..." indicator tells the user why
- **Singleton** — all `useAio()` calls share a single WebSocket connection per
  page. Call it from any component — no prop drilling, no duplicate connections
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

## Connection lifecycle

Every `useAio` hook registers a WebSocket listener. When all hooks unmount
(e.g., route change), the connection would normally close and reopen on the next
mount. aio prevents this with a grace period.

### Reconnect behavior

Auto-reconnects on disconnect with exponential backoff (1s -> 2s -> 4s -> 8s
base max, +/-20% jitter). If the server restarted, reconnect triggers a page
reload to pick up fresh code.

### 300ms grace period

When the last listener unsubscribes:

1. A 300ms timer starts.
2. If new listeners subscribe within 300ms -> timer cancelled, connection kept.
3. If still zero after 300ms -> full teardown (WebSocket closed, state cleared).

This handles the mount/unmount cycle during route transitions — components
unmount from the old route before mounting on the new route.

### What triggers teardown

- All `useAio` hooks unmount and stay unmounted for 300ms.
- The WebSocket is closed, state is cleared, retry counter resets.
- On next `useAio` mount, a fresh connection is established.

### Avoiding unnecessary teardowns

- Keep at least one `useAio` hook mounted at the layout/root level if your app
  has routes that don't use state.
- A simple `useAio()` in the root layout (reading e.g. `state.status`) prevents
  connection churn.

Connection is cleaned up when the last connected component unmounts — with the
300ms grace period to prevent transient teardown during component reconciliation
or page switches. Both teardown and averted-teardown events emit `console.warn`
and diagnostic events for full visibility.

## Offline queue

When the WebSocket disconnects, dispatched actions are queued in IndexedDB
instead of being lost. On reconnect, they're replayed in order.

| Parameter          | Value                           |
| ------------------ | ------------------------------- |
| Max queued actions | 1000                            |
| TTL per action     | 24 hours                        |
| Storage            | IndexedDB (`aio-offline-queue`) |
| Replay             | Automatic on reconnect          |

The client stays functional during brief disconnects without the user noticing.
Actions are replayed chronologically, and the server processes them as if they
arrived in real-time.

**Traffic implication:** On reconnect, the queue flushes all pending actions at
once. If you queued 100 actions during a 5-minute disconnect, all 100 dispatch
in rapid succession. Microtask coalescing ensures this produces at most a few
broadcasts, not 100.

## Transport selection

### WebSocket (browser)

Default for all browser clients. Persistent bidirectional connection.

```
Browser <-> WebSocket <-> Deno Server
```

Rate limits (server-enforced):

- 100 messages/sec per client
- 5MB/s bandwidth per client
- 1MB max message size
- 100 max concurrent connections (configurable via `maxConnections`)

### UDS + IPC (Electron)

For Electron apps, aio uses Unix Domain Sockets instead of TCP WebSockets:

```
Renderer <-> IPC bridge <-> Electron Main <-> UDS <-> Deno Server
```

- Zero TCP overhead (no handshake, no Nagle's algorithm)
- ~2-5x lower latency than localhost WebSocket
- No network exposure (socket file, not port)
- Works completely offline

Wire format: NDJSON (newline-delimited JSON). Same throttling and delta
compression as WebSocket.

## UI state filtering

Use cell-level `ui` config to control what the browser sees:

```ts
const myCell = cell("myCell", {
  state: { counter: 0, username: "", apiKey: "secret" },
  methods: {/* ... */},
  ui: { exclude: ["apiKey"] }, // apiKey is NOT sent to the browser
});
```

Or use `cellDefaults` to expose all cells, then tighten per-cell:

```ts
await aio.run({
  cells: [myCell],
  cellDefaults: { ui: "all" },
});
```

### Per-user UI filtering

Add `forUser` for role-based state filtering:

```ts
const orders = cell("orders", {
  state: { items: [], internal: {} },
  methods: {/* ... */},
  ui: {
    include: ["items"],
    forUser: (exposed, user?) =>
      user?.role === "admin"
        ? exposed
        : { items: exposed.items.filter((i) => i.ownerId === user?.id) },
  },
});
```

**How it works:**

1. Each WebSocket connection resolves an `AioUser` from its auth token
2. Structural filter (`include`/`exclude`) is applied once per state change
   (cached)
3. `forUser` runs per client on filtered clone — cannot access excluded fields
4. `user` is `undefined` in public mode (no `users` config)

## Client log forwarding

Forward browser console output to the server for centralized debugging:

```ts
import { installConsoleIntercept, uninstallConsoleIntercept } from "aio/air";

installConsoleIntercept(); // call once at app startup
```

Intercepts `console.log`, `info`, `warn`, `error`, `debug` plus global `error`
and `unhandledrejection` events. Each log entry is sent as a `__log` wire
message:

```ts
{ level: "error", msg: "Failed to fetch /api/users", ts: 1712000000000 }
```

- Max 4KB message body, 2KB stack trace (truncated if larger)
- Original console methods still work — intercept is additive
- Fire-and-forget — no ack, no retry, no impact on app performance
- Idempotent: calling `installConsoleIntercept()` twice is a no-op
- Call `uninstallConsoleIntercept()` to restore original console

## DOM snapshot

Capture a semantic snapshot of the current UI state from the server:

```ts
import { snapshotDOM } from "aio/air";

const nodes: UINode[] = snapshotDOM();
```

Walks the DOM tree (max 5000 nodes, depth 50) and builds a `UINode[]` array.
Each node captures: tag, text content, input value, classes, aria/data
attributes, disabled/checked state, href, src, placeholder, and a unique CSS
selector.

**Selector priority:** `#id` > `[data-testid]` > `[data-component]` >
`tag:nth-of-type(n)` path.

**Filtering:** Skips `<script>`, `<style>`, `<meta>`, `<link>`. Collapses pure
wrapper `<div>`s with no semantic content. Respects visibility (computed styles,
`offsetParent`, bounding rect).

## DOM interaction

Dispatch simulated user interactions from the server:

```ts
import { interact } from "aio/air";

interact({ action: "click", selector: "#submit-btn" });
interact({ action: "type", selector: "#name", value: "Alice" });
interact({ action: "type", selector: "#email", value: "a@b.com", clear: true });
interact({ action: "select", selector: "#role", value: "admin" });
interact({ action: "focus", selector: "#search" });
interact({ action: "scroll", selector: "#list", value: "500" }); // scrollTop
```

**Available actions:** `click`, `type`, `select`, `focus`, `blur`, `scroll`,
`hover`.

**Validation:** Each action checks selector validity, element visibility, and
disabled state before dispatching. Returns `{ ok: boolean, error?: string }`.

**Event sequences:** Dispatches full event chains (e.g., click sends
`pointerdown` > `mousedown` > `pointerup` > `mouseup` > `click`).

## Delta sync and rendering

Server sends **delta patches** (only changed keys). The browser merges patches
and reuses object references for unchanged slices — `memo()` and selectors work
correctly without extra wrappers.

Full state is sent on first connect or when >50% of keys changed (configurable
via `fullStateThreshold`). Deltas are computed one level deep per cell slice.

The **Render Meter** tracks staleness and adapts broadcast rate via
backpressure. See [Delta](../persistence/delta.md) for compression details and
[Vitals](../debugging/vitals.md) for diagnostics.
