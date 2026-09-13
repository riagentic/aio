# Offline & Transport

Connection lifecycle, offline queue, transport selection, and monitoring.

## Connection lifecycle

### 300ms grace period

When the last `useAio` listener unsubscribes (e.g., route change):

1. A 300ms timer starts
2. New listeners within 300ms → timer cancelled, connection kept
3. Still zero after 300ms → full teardown (WebSocket closed, state cleared)

This handles the mount/unmount cycle during route transitions.

**Tip:** Keep at least one `useAio` hook at the layout/root level to prevent
connection churn on routes that don't use state.

## Offline queue

When the connection drops, dispatched actions queue **in memory** and replay, in
order, on reconnect.

| Parameter          | Value                                           |
| ------------------ | ----------------------------------------------- |
| Max queued actions | 1000                                            |
| Storage            | in memory (the page), **not persisted**         |
| Replay             | automatic on reconnect                          |
| Lost when          | the page reloads or closes before it reconnects |

**A queued action does not survive a reload.** The queue lives in the tab; a
refresh, a crash or a closed tab discards it. The client says so — the first
action queued after a disconnect logs a warning and emits a diagnostic — but if
an edit must outlive a reload, write it through a `sync` cell (CRDT ops are
persisted and rebased on reconnect, see [CRDT Protocol](crdt-protocol.md)) or
re-issue it from state your app owns.

Nothing is dropped quietly:

- past 1000 actions queued while offline the OLDEST is dropped and its caller's
  promise rejects immediately with the real reason (not a timeout 15s later).
  Calls the client had already accepted — still waiting on the send pacer when
  the connection dropped — are never evicted by that cap; they replay first
  (`connectCli`, cap 100, refuses the new call instead when only those are
  left);
- `isConnectionDegraded()` returns true once a queue passes 80% full — use it
  for a "reconnecting / slow connection" indicator;
- when the client tears down (or hits a protocol-version gap) the queue is
  discarded and every waiting caller is rejected, with a count logged.

**Two send paths, two queues.** The contract above is the one for CELL METHODS
(`await counter.increment()`), which is what most code uses. The lower-level
Direct method calls (`cell.method()`) and `useAio().send()` are fire-and-forget:
they are synchronous and return `false` rather than rejecting a promise, and
they queue separately — up to 100 actions, dropping the NEWEST (the one you just
sent) when full. Both queues feed `isConnectionDegraded()`, and both emit a
diagnostic on a drop, so nothing is invisible either way. If an action must not
be lost, prefer a cell method — its promise is what tells you the outcome. If
you use `send()`, check the return value.

### What `await cell.method()` means while offline

The promise is the ACTION's outcome, and it is settled only by something true of
its frame:

| Situation                            | The awaiting caller                               |
| ------------------------------------ | ------------------------------------------------- |
| queued, still offline                | keeps waiting (it has not been sent)              |
| written, then the connection dropped | **rejects** — the fate is unknown, re-check state |
| queued, then the client is torn down | **rejects** — the frame was discarded             |
| flushed on reconnect and acked       | resolves with the method's return value           |

The per-call timeout clock starts when the frame is **written**, never at
dispatch — an action queued for ten minutes does not "time out" while it is
sitting in the queue.

**CRDT sync cells** use a separate op buffer (not this queue) with HLC-stamped
ops, ack tracking, and rebase on reconnect. See
[CRDT Protocol](crdt-protocol.md) for the sync-specific reconnect flow.

## Transport selection

### WebSocket (browser)

Default for all browser clients. Persistent bidirectional connection.

Rate limits (server-enforced, `wsLimits`):

- 100 messages/sec per client
- 5MB/s bandwidth per client
- 1MB max message size
- 100 max concurrent connections (configurable via `maxConnections`)

The client paces itself to the budget the server advertises in its hello: every
frame the page writes (method calls, `send()`, sync ops, `serverFn`, forwarded
logs) leaves through one writer held to 80% of `messagesPerSec`. A burst —
`Promise.all` over 1000 `cell.method()` calls — queues and resolves late, never
refused. A frame the server still drops over a per-second budget is answered
with `retryAfterMs`; the client holds that call and re-sends it (up to 8 times,
then the caller gets the server's refusal). A frame refused for what it is (too
large, not allowed, or bigger than the whole `bytesPerSec` — no re-send could
ever fit) rejects at once, without holding the calls behind it; a refused frame
is not charged to the byte window. A server whose `maxMessageBytes` exceeds its
`bytesPerSec` says so at startup.

A peer that ignores all of that — 50 dropped frames in a row — is closed with
`1008` and its address refused (HTTP 429, `Retry-After`) for 5 s, doubling per
repeat within 10 minutes up to 60 s. Both are logged on the server. The aio
client reconnects with its normal backoff (≤ 8 s) once the block ends.

The per-client budget is checked first; a frame it refuses is not counted
against the server-wide fuse (`messagesPerSec` × clients, from 2 up to 50
clients' worth). When that fuse trips, only a client that has sent more than its
even share of it this second is refused (with `retryAfterMs`, never closed), so
one flooding socket cannot starve the others at any budget.

### UDS + IPC (Electron)

For Electron apps, Unix Domain Sockets instead of TCP WebSockets:

```
Renderer ←→ IPC bridge ←→ Electron Main ←→ UDS ←→ Deno Server
```

- Zero TCP overhead (no handshake, no Nagle's algorithm)
- ~2-5x lower latency than localhost WebSocket
- No network exposure (socket file, not port)
- Works completely offline

Wire format: NDJSON (newline-delimited JSON). Same throttling, delta
compression, and backpressure as WebSocket.

## Vitals monitoring

Three measurement layers for traffic health.

### Render meter (client)

| Metric           | What it measures                      |
| ---------------- | ------------------------------------- |
| `staleness`      | ms since last unpainted state update  |
| `frameTime`      | ms since last `requestAnimationFrame` |
| `pendingPatches` | unprocessed delta patches waiting     |
| `paintRate`      | frames per second                     |
| `memory`         | JS heap size (Chrome/Edge only)       |

Status: `healthy` (< 300ms) → `degraded` → `warning` (>= 2x) → `frozen` (>= 5x).
Frozen clients receive no data from the server.

### Transport probe

Ping/pong round-trip latency between client and server via WebSocket.

### Pressure monitor (server)

| Metric                     | Default threshold |
| -------------------------- | ----------------- |
| Payload size per broadcast | 500 KB            |
| Broadcast rate             | 30/sec            |
| Per-client bandwidth       | 1 MB/sec          |

### Vitals dashboard

```
GET /__aio/vitals
```

Returns per-client breakdown, current status, and recent alerts.

## Connection limits

### Server-side

```ts
await aio.run({
  maxConnections: 100, // default
});
```

New connections beyond limit get HTTP 503.

### Message size

Server rejects WebSocket messages > 1MB. Oversized actions are dropped with a
debug log.

### Origin restrictions

```ts
await aio.run({
  allowedOrigins: ["app.example.com"],
});
```

A WebSocket is admitted from the app's own origin — the host it was reached as
AND the scheme it serves — and from whatever `allowedOrigins` admits. There is
no blanket localhost exemption: another port on `localhost` is another origin.
See [Cross-origin requests](../auth/auth.md#cross-origin-requests).

## Optimization checklist

### High impact

- Use cell-level `ui` config — send only what each client needs
- Use `useAio()` (proxy-tracked) — automatic subscriptions
- Flatten state shape — independent top-level keys
- Separate hot/cold data

### Medium impact

- `createSelector` for derived data in cell `ui.forUser`
- Batch related actions in cell methods
- Debounce client input (100-200ms)
- Tune `syncIntervalMs` for your use case
- Strip internal state from UI

### Low impact

- Tune `fullStateThreshold`
- Root-level `useAio` hook to prevent teardown
- Use IDs instead of embedded objects
- Monitor `/__aio/vitals`

### Don't do

- `syncIntervalMs: 0` unless you need sub-frame latency
- `fullStateThreshold: 0` in production (disables delta)
- Large datasets in state — query SQLite on demand
- Manual selectors to narrow `useAio` — proxy handles it
- Manual compression — WebSocket handles HTTP-level compression

### Real-time apps (games, editors, cursors)

`syncIntervalMs` is the server's broadcast coalescing window — the floor on how
often a client hears about a change, not how often your app may change it.

| Cadence                          | Setting                             |
| -------------------------------- | ----------------------------------- |
| Turn-based / forms / dashboards  | leave it (50ms)                     |
| Cursors, presence, drag previews | 16–33ms, and keep the payload small |
| 60 Hz simulation state           | don't sync it at all — see below    |

A 60 Hz tick does not belong on the wire in any configuration: at that rate the
coalescer is not the cost, the op/patch stream is. Keep per-frame state in a
`scope: "client"` cell (never synced, never persisted, one copy per tab) and
sync the OUTCOME — the move, the score, the final position. That is also what
keeps a replay honest: see the input-tape pattern in
[time travel](../debugging/time-travel.md).

## Test isolation — one knob

Everything an app owns lives under `~/.<appId>`, and **`AIO_APPS_DIR` moves all
of it** — data, locks, sockets, TLS, logs. That is the whole isolation story:
one env var per test run (aio's own suite sets it in its `deno test` task), and
the harnesses sandbox it automatically when the runner has not. There is no
second knob to remember and no per-subsystem path to override.

## Defaults reference

Sources are FILES, not line numbers: every line number in this table had
drifted, and three named a `browser.ts` that does not exist.

| Parameter                   | Default        | Source                             |
| --------------------------- | -------------- | ---------------------------------- |
| `syncIntervalMs`            | 50ms           | `server/aio.ts`                    |
| `fullStateThreshold`        | 0.5            | `server/server-broadcast.ts`       |
| `maxConnections`            | 100            | `server/server-ws.ts`              |
| Max WS message size         | 1 MB           | `server/server-ws.ts`              |
| Backpressure: moderate      | >100ms → 2x    | `server/server-ws.ts`              |
| Backpressure: heavy         | >300ms → 4x    | `server/server-ws.ts`              |
| Backpressure: recovery      | 3 healthy → /2 | `server/server-ws.ts`              |
| Subscription grace period   | 300ms          | `browser/protocol-subscription.ts` |
| Offline queue max — methods | 1000 actions   | `browser/browser-air-transport.ts` |
| Offline queue max — `send`  | 100 actions    | `protocol/protocol-types.ts`       |
| Render staleness threshold  | 300ms          | `vitals/render-meter.ts`           |
| Pressure: payload size      | 500 KB         | `vitals/pressure-monitor.ts`       |
| Pressure: broadcast rate    | 30/sec         | `vitals/pressure-monitor.ts`       |
| Pressure: client bandwidth  | 1 MB/sec       | `vitals/pressure-monitor.ts`       |

There are TWO offline queues and one drop policy: a cell-method call queues in
the browser transport (1000), `useCell().send` / `useAio().send` queue in the
isomorphic core (100). Neither has a TTL — the queue stores `{action, seq}` and
holds no timestamp at all, so nothing can expire. (The 24 hours that used to
appear here is the CRDT tombstone window, a different subsystem.)

## Diagnosis workflow

1. **Check vitals**: `curl http://localhost:$PORT/__aio/vitals | jq .` (`$PORT`
   from `am instances`) — look for frozen clients, high staleness, payload
   warnings
2. **Console backpressure**: look for `[aio:vitals]` escalation messages
3. **Payload sizes**: `grep -i "pressure" logs/warning.log` — >500KB means state
   too large or cell `ui` config not filtering enough
4. **Browser DevTools**: Network → WS filter. Watch message sizes vs
   `syncIntervalMs`
5. **Re-renders**: Use direct cell access (`counter.count`) to scope re-renders
6. **State shape**: `am state` CLI — look for hot data mixed with cold under
   same parent key
