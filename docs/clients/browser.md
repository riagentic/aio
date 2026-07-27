# Browser

WebSocket client API, connection lifecycle, and UI state management for browser
clients.

For the core API (`cell`), see [Concepts](../basics/concepts.md). For Electron &
thin client, see [electron.md](electron.md).

## Direct cell access (recommended)

Import cells and use their properties directly — reactive and auto-tracked.
Reading `cell.field` does **two** things: it registers a re-render dependency
(the component updates when the value changes) **and** it registers a server
subscription for that cell (so its live deltas are broadcast back to this
client). You do not need a `useAio`/`useCell` anchor for a directly-read cell to
receive live updates — the read itself subscribes.

For full-state access, `useAio()` is also available but re-renders on any
change. For scoped re-render optimization, import and read from specific cells.

```tsx
import { useAio } from "aio/air";
import type { AppState } from "./state.ts";

export default function App() {
  const { state, send } = useAio<AppState>();

  if (!state) return <div>Connecting...</div>;

  return <button onClick={() => send({ type: "counter:increment" })}>+</button>;
}
```

**Details:**

- `state: S | null` — `null` until WebSocket connects and server sends initial
  state. The returned object is a **Proxy** — property accesses are tracked
  automatically and sent to the server as a `subs` frame
  (`{"subs":["path1",…]}`) so only relevant deltas are broadcast back
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

## Awaiting methods in the browser

Cell methods return a `Promise<void>` in the browser too. Awaiting the promise
guarantees the server has reduced the action and the patch has been broadcast —
reading state on the next line sees the new value.

```ts
async function addTodo(text: string) {
  await todo.add(text);
  // `todo.items` is fresh here — the server has acked the dispatch
  console.log(todo.items.length);
}
```

If you don't need the synchronization, the call is fire-and-forget — the
unawaited promise is harmless (a no-op `.catch()` is attached internally so
disconnects don't pollute the console).

Rejection happens on:

- **Server reject** — the dispatch was refused (validation, routing guard,
  etc.). The promise rejects with the server's error message.
- **Timeout** — 15 seconds elapse without an ack. The promise rejects with
  `method not acknowledged in 15000ms — server overloaded or disconnected`.
- **Disconnect** — the WebSocket closes while the action is in flight. The
  promise rejects with `connection lost`. (Fire-and-forget callers don't see
  this because of the internal `.catch()`.)

## `useLocal<T>(initial)`

Client-only state hook — not synced to server, not persisted. For ephemeral UI
concerns like "which item am I editing", form inputs, dropdown open/closed.

```tsx
import { useAio, useLocal } from "aio/air";
import type { AppState, Todo } from "./state.ts";

export default function App() {
  const { state } = useAio<AppState>();
  const { local, set } = useLocal({ editing: null as string | null });

  if (!state) return <div>Connecting...</div>;

  return (
    <ul>
      {state.todos.map((t: Todo) => (
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

- Keep at least one connected component mounted at the layout/root level if your
  app has routes that don't use state, to avoid connection churn. Any direct
  cell read (`cell.field`) or `useAio`/`useCell` counts — a directly-read cell
  in the root layout is enough; you don't need `useAio` specifically.

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

Browser console output is forwarded to the server **automatically** — the
transport installs the intercept at startup, no imports or setup. Read the logs
with `am logs` or in `~/.<appId>/logs/`.

Intercepts `console.log`, `info`, `warn`, `error`, `debug` plus global `error`
and `unhandledrejection` events. Each log entry is sent as a `__log` wire
message:

```ts
{ level: "error", msg: "Failed to fetch /api/users", ts: 1712000000000 }
```

- Max 4KB message body, 2KB stack trace (truncated if larger)
- Original console methods still work — intercept is additive
- Fire-and-forget — no ack, no retry, no impact on app performance

## Inspecting & driving a live client

aio has **one** UI facility for this — the semantic surface — used identically
by `testUI` (in tests) and by `am surface`/`am trigger` (against a live client).
It walks the live AIR vdom, so every component and interactive element is
addressed by NAME, never a CSS selector. See
[UI testing](../testing/ui-testing.md).

```sh
am surface <clientIdx>                      # every component + triggerable element, by name
am trigger <clientIdx> App:SubmitButton click       # drive it: the Component:name path + action
am trigger <clientIdx> App:Name type "Alice"
```

**Actions:** `click`, `type`, `select`, `focus`, `blur`, `scroll`, `hover`,
`press` — dispatched as faithful event sequences (e.g. click sends `pointerdown`

> `mousedown` > `pointerup` > `mouseup` > `click`), then the app is settled and
> the fresh post-action surface is returned. Because a test and an `am` session
> run the exact same trigger engine, they behave identically.

> The older selector/index/raw-DOM commands (`am interact`, `am click`,
> `am dom`) were removed — the semantic surface supersedes them.

## Delta sync and rendering

Server sends **delta patches** (only changed keys). The browser merges patches
and reuses object references for unchanged slices — `memo()` and selectors work
correctly without extra wrappers.

Full state is sent on first connect or when >50% of keys changed (configurable
via `fullStateThreshold`). Deltas are computed one level deep per cell slice.

The **Render Meter** tracks staleness and adapts broadcast rate via
backpressure. See [Delta](../persistence/delta.md) for compression details and
[Vitals](../debugging/vitals.md) for diagnostics.
