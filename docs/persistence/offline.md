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

When the WebSocket disconnects, actions queue in IndexedDB and replay on
reconnect.

| Parameter          | Value                           |
| ------------------ | ------------------------------- |
| Max queued actions | 100                             |
| TTL per action     | 24 hours                        |
| Storage            | IndexedDB (`aio-offline-queue`) |
| Replay             | Automatic on reconnect          |

Past 100 queued actions the oldest are dropped — the cap is `OFFLINE_MAX_QUEUE`
in `src/protocol/protocol-types.ts`. (The AIR transport keeps its own in-memory
queue, capped at 1000, and reports `isConnectionDegraded()` once it passes 80%
full.)

On reconnect, all pending actions flush at once. Microtask coalescing ensures
this produces at most a few broadcasts, not N.

**CRDT sync cells** use a separate op buffer (not the offline queue) with
HLC-stamped ops, ack tracking, and rebase on reconnect. See
[CRDT Protocol](crdt-protocol.md) for the sync-specific reconnect flow.

## Transport selection

### WebSocket (browser)

Default for all browser clients. Persistent bidirectional connection.

Rate limits (server-enforced):

- 100 messages/sec per client
- 5MB/s bandwidth per client
- 1MB max message size
- 100 max concurrent connections (configurable via `maxConnections`)

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

Localhost is always allowed. Additional hostnames via `allowedOrigins`.

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

| Parameter                  | Default        | Source                       |
| -------------------------- | -------------- | ---------------------------- |
| `syncIntervalMs`           | 50ms           | `aio.ts:114`                 |
| `fullStateThreshold`       | 0.5            | `server.ts:331`              |
| `maxConnections`           | 100            | `server.ts:257`              |
| Max WS message size        | 1 MB           | `server.ts:256`              |
| Backpressure: moderate     | >100ms → 2x    | `server.ts:260`              |
| Backpressure: heavy        | >300ms → 4x    | `server.ts:259`              |
| Backpressure: recovery     | 3 healthy → /2 | `server.ts:261`              |
| Subscription grace period  | 300ms          | `browser.ts:744`             |
| Offline queue max          | 100            | `protocol/protocol-types.ts` |
| Offline queue TTL          | 24 hours       | `browser.ts`                 |
| Render staleness threshold | 300ms          | `vitals/render-meter.ts`     |
| Pressure: payload size     | 500 KB         | `vitals/pressure-monitor.ts` |
| Pressure: broadcast rate   | 30/sec         | `vitals/pressure-monitor.ts` |
| Pressure: client bandwidth | 1 MB/sec       | `vitals/pressure-monitor.ts` |

## Diagnosis workflow

1. **Check vitals**: `curl http://localhost:8000/__aio/vitals | jq .` — look for
   frozen clients, high staleness, payload warnings
2. **Console backpressure**: look for `[aio:vitals]` escalation messages
3. **Payload sizes**: `grep "pressure" log/perf.log` — >500KB means state too
   large or cell `ui` config not filtering enough
4. **Browser DevTools**: Network → WS filter. Watch message sizes vs
   `syncIntervalMs`
5. **Re-renders**: Use direct cell access (`counter.count`) to scope re-renders
6. **State shape**: `am state` CLI — look for hot data mixed with cold under
   same parent key
