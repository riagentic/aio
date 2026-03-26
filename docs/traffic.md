# UI Data Traffic Optimization

For the docs index, see [manual.md](manual.md). For vitals monitoring, see
[vitals.md](vitals.md). For scaling architecture, see [scaling.md](scaling.md).

This document covers every mechanism aio provides to minimize data flowing
between server and browser without losing functionality or reactivity. Read it
end-to-end before optimizing — most problems are solved by combining 2-3
techniques, not by reaching for one magic flag.

## How data flows

```
dispatch(action)
  → reduce(state, action) → new state
  → getUIState(state, user) → per-client view
  → _computeDelta(current, previous) → full | delta | skip
  → filter by client __subs paths → subscribed keys only
  → ws.send(json) → browser
  → _applyPatch(prev, delta) → merged state
  → Proxy (useAio) tracks reads → __subs sent back to server
  → React re-render
```

Every optimization targets one or more of these stages. The goal: send less
data, send it less often, and make the browser do less work when it arrives.

---

## 1. Filter state with `stateForUI`

The single biggest server-side win. Even though proxy-tracked subscriptions (see
section 8) automatically narrow what each client receives, `stateForUI` operates
earlier in the pipeline — it controls what the server _computes_ per client,
stripping sensitive or irrelevant data before delta comparison even begins.

```ts
await aio.run({
  stateForUI: (state, user) => ({
    // Public slice — everyone gets this
    prices: state.prices,
    status: state.status,

    // Per-user slice — admin sees more
    ...(user?.role === "admin"
      ? { orders: state.orders, audit: state.audit }
      : { myOrders: state.orders.filter((o) => o.userId === user?.id) }),
  }),
});
```

**What it does:** Called once per unique user per state change. The return value
is what gets delta-compared and sent over the wire.

**Memoization:** aio memoizes `stateForUI` per user ID — if the input state
reference hasn't changed, the previous result is returned without calling your
function. This means:

- If you dispatch 5 actions synchronously, `stateForUI` runs once (after the
  batch), not 5 times.
- If the state reference is identical (action produced no change), zero work.

**Rules:**

- Return a new object only when something changed. If you return `state`
  directly, delta compression handles the rest.
- Never do expensive computation here — use `createSelector` (see below).
- Never mutate the input state.
- Keep the return shape flat when possible — deeply nested objects produce
  larger JSON and slower delta comparison.

**Anti-pattern:**

```ts
// Bad — recomputes derived data on every call, even when inputs unchanged
stateForUI: ((state) => ({
  ...state,
  totalValue: state.positions.reduce((sum, p) => sum + p.value, 0),
  sortedTrades: [...state.trades].sort((a, b) => b.ts - a.ts),
}));

// Good — selectors cache until inputs change
const selectTotalValue = createSelector(
  (s: State) => s.positions,
  (positions) => positions.reduce((sum, p) => sum + p.value, 0),
);
const selectSortedTrades = createSelector(
  (s: State) => s.trades,
  (trades) => [...trades].sort((a, b) => b.ts - a.ts),
);

stateForUI: ((state) => ({
  ...state,
  totalValue: selectTotalValue(state),
  sortedTrades: selectSortedTrades(state),
}));
```

---

## 2. Delta compression

aio never sends full state twice (unless the delta is larger than full state).
The delta system is automatic — no configuration required for basic operation.

### How it works

1. **First broadcast** to a client: always full state (`kind: "full"`).
2. **Subsequent broadcasts**: each top-level key (and nested feature sub-key) is
   JSON-stringified and compared to the cached value from the previous send.
3. If fewer keys changed than the threshold → send a **delta patch**.
4. If more keys changed → send **full state** (patch overhead exceeds benefit).
5. If nothing changed → **skip** entirely.

### Delta patch format

```json
{
  "$p": { "counter": { "count": 42 }, "prices": { "BTC": 67000 } },
  "$d": ["removedFeature"]
}
```

- `$p` contains changed keys (nested for feature slices).
- `$d` lists deleted top-level keys.
- Nested features support their own `$d` for sub-key removal.

### Tuning the threshold

```ts
await aio.run({
  fullStateThreshold: 0.5, // default: 0.5 (50%)
});
```

- `0.5` means: if >50% of keys changed, send full state instead of a patch.
- **Lower** (e.g., `0.3`): more full-state sends, simpler browser-side merging.
- **Higher** (e.g., `0.8`): more delta patches, smaller payloads, slightly more
  CPU on both sides for patch computation.
- `1.0`: always delta (except first broadcast).
- `0.0`: always full state (disables delta — useful for debugging).

### Reference preservation

On the browser side, `_applyPatch` preserves object references for unchanged
slices. This is critical for React's `useSyncExternalStore` — if a feature slice
didn't change, the selector returns the same reference, and React skips the
re-render.

**Identity-keyed arrays** (arrays of objects where every element has a string
`id` field) get per-element delta patching automatically — no configuration
needed.

**How it works (server):** `flattenKeys` detects arrays where every element has
a stable string `id` field. Instead of serializing the whole array as one key,
it expands each element into its own flat key (`fleet.members.$id:SOL_15m`). The
existing `_computeDelta` then diffs per-element with zero changes to the diff
algorithm.

**Wire format:** Identity-keyed array patches use `$arr: true` as a marker with
`$id:` element patches for changed elements and `$rm` for removals:

```json
{
  "$p": {
    "fleet": {
      "members": {
        "$arr": true,
        "$id:SOL_15m": { "price": 142.5 },
        "$id:BTC_1h": { "volume": 8800 },
        "$rm": ["$id:ETH_old"]
      }
    }
  }
}
```

**Browser side:** `_applyPatch` maintains an `_idMaps` registry — an id→element
Map paired with an insertion-order array. Unchanged elements keep their exact
object reference without any comparison. Only changed elements arrive on the
wire and get new refs. Identity-patched arrays bypass `_preserveArrayRefs`
entirely — no shallow comparisons needed.

**Performance:** A 160-element array with 10 changes per tick: **120KB →
~7.5KB** per broadcast. The 150 unchanged elements produce zero wire traffic and
zero comparisons.

**State design:** To enable identity-keyed compression, ensure array elements
have a string `id` field:

```ts
// Good — flattenKeys detects this automatically
state: {
  members: [
    { id: "SOL_15m", price: 142.5, volume: 1200 },
    { id: "BTC_1h", price: 67000, volume: 500 },
  ];
}

// Won't trigger — no `id` field (uses _preserveArrayRefs fallback)
state: {
  prices: [142.5, 67000, 3200];
}
```

**Non-identity arrays** (primitives, mixed types, objects without `id`) use
`_preserveArrayRefs`: if the array has the same length and each element is
shallow-equal to the previous, the old array reference is kept. This prevents
re-renders for lists that haven't actually changed.

### JSON key caching

Each client tracks `lastKeyJsons` — a map of `dotPath → JSON string` for every
key sent in the previous broadcast. On the next broadcast:

- If the value reference is identical → reuse cached JSON (no re-stringify).
- If the reference changed → stringify and compare the JSON string.
- If the JSON string matches → key is unchanged, skip it.

This means: unchanged objects pay zero serialization cost after the first send.

---

## 3. Broadcast throttling

aio coalesces and throttles server→client broadcasts to prevent flooding.

### Mechanism

```
dispatch(A) ─┐
dispatch(B) ─┤  (same tick)
dispatch(C) ─┘
              └─→ queueMicrotask → ONE broadcast with final state
                  └─→ throttle window (50ms default)
                      └─→ trailing flush if dirty
```

1. **Microtask coalescing**: Multiple synchronous dispatches in the same tick
   produce exactly one broadcast. The UI always gets the final state, never
   intermediate states.
2. **Throttle window**: After sending, the next broadcast is delayed by
   `syncIntervalMs`. A trailing flush ensures the last state always arrives.
3. **Leading edge**: First broadcast in a burst fires immediately (after
   microtask coalesce) — no initial delay.

### Configuration

```ts
await aio.run({
  syncIntervalMs: 50, // default: 50ms = max 20 broadcasts/sec
});
```

| Value | Behavior                               | Use case                       |
| ----- | -------------------------------------- | ------------------------------ |
| `0`   | Microtask coalescing only, no throttle | Ultra-low latency (trading UI) |
| `16`  | ~60 broadcasts/sec, matches 60fps      | Gaming / animation             |
| `50`  | Default — good balance                 | Most apps                      |
| `100` | ~10 broadcasts/sec                     | Dashboard / monitoring         |
| `500` | ~2 broadcasts/sec                      | Slow-updating displays         |

**Trade-off**: Lower = more responsive but more network traffic. Higher = less
traffic but visible update lag. 50ms is imperceptible for most UIs.

---

## 4. Per-client backpressure

When a client can't keep up (slow device, heavy DOM, network congestion), aio
automatically throttles broadcasts to that specific client without affecting
others.

### How it works

1. Browser vitals system sends periodic pings reporting **render staleness** —
   how long since the last painted frame after a state update.
2. Server reads staleness from the ping:
   - **>300ms** → backpressure multiplier set to **4x** (send every 200ms
     instead of 50ms)
   - **>100ms** → backpressure multiplier set to **2x** (send every 100ms
     instead of 50ms)
   - **3 consecutive healthy pings** → step multiplier down by half
3. Backpressure is per-client — fast clients keep getting updates at full rate.

### No configuration needed

This is fully automatic. The server tracks per-client metadata:

```ts
// Internal per-client state (managed automatically)
{
  bpMultiplier: 1,        // 1 = normal, 2 = moderate, 4 = heavy
  bpConsecutiveLow: 0,    // healthy pings since last escalation
  bpLastSentAt: number,   // timestamp of last send to this client
}
```

### What triggers backpressure

- Slow React renders (complex component trees).
- Large DOM updates (thousands of elements).
- Client device CPU saturation.
- Network latency spikes.

### Console output

When backpressure changes, you'll see:

```
[aio:vitals] client a3f2c901 — staleness 450ms, backpressure 1x→4x
[aio:vitals] client a3f2c901 — recovered, backpressure 4x→2x
```

### Recovery mechanics

Backpressure steps down gradually, not instantly:

1. Server tracks consecutive low-staleness pings per client (`bpConsecutiveLow`)
2. After **3 consecutive healthy pings** (staleness ≤ 100ms), multiplier halves:
   4x → 2x → 1x
3. Any staleness spike resets the consecutive counter to 0

This prevents oscillation — a client that briefly recovers then freezes again
won't flap between multipliers.

### Frozen client handling

When the RenderMeter classifies a client as `frozen` (staleness ≥ 5× threshold):

1. Server **skips** the client entirely during broadcast — no delta, no full
   state
2. Client receives nothing until it recovers
3. On recovery, the client resumes receiving deltas from the **next broadcast
   cycle** — accumulated state changes are captured in the next delta
   computation
4. No explicit "recovery snapshot" is sent — the normal delta mechanism handles
   it (if too many keys changed during the freeze, it automatically sends full
   state instead of a delta)

This prevents the "death spiral" where sending data to a frozen client makes it
freeze harder.

---

## 5. Memoized selectors

Selectors prevent both unnecessary computation on the server (`stateForUI`) and
unnecessary re-renders on the client (`useAio`).

### `createSelector` — server-side derived state

```ts
import { createSelector } from "aio/selector.ts";

// Recomputes ONLY when positions array reference changes
const selectPortfolioValue = createSelector(
  (s: State) => s.positions,
  (positions) => positions.reduce((sum, p) => sum + p.qty * p.price, 0),
);

// Recomputes ONLY when orders or filter changes
const selectFilteredOrders = createSelector(
  (s: State) => s.orders,
  (s: State) => s.orderFilter,
  (orders, filter) => orders.filter((o) => o.status === filter),
);

// Compose selectors — downstream only recomputes when upstream changes
const selectPortfolioSummary = createSelector(
  selectPortfolioValue,
  selectFilteredOrders,
  (value, orders) => ({ value, orderCount: orders.length }),
);
```

**How caching works:** Input selectors are called and compared by reference
(`===`). If all inputs return the same references as the previous call, the
cached result is returned without calling the combiner function.

Supports 1–6 input selectors.

### `useAio` — client-side state access (recommended)

`useAio()` returns a deep recursive Proxy that automatically tracks which state
paths each component reads. The tracked paths are sent to the server as
subscriptions — the server then only sends deltas for those paths. Zero API
change, zero manual selectors required.

```tsx
// Recommended — just use the state. Proxy tracks that you read counter.count.
const state = useAio();
return <div>{state.counter.count}</div>;

// Also fine — read multiple paths, all are tracked automatically
const state = useAio();
return (
  <div>
    <span>{state.prices.BTC}</span>
    <span>{state.user.name}</span>
  </div>
);
```

The Proxy records every property access during render. After render, the
component's accessed paths (e.g., `["counter.count", "prices.BTC"]`) are sent to
the server via a `__subs` WebSocket message. The server then only includes those
paths in delta broadcasts to that client.

**What about `useFeature`?** `useFeature(ref)` still works but serves a
different purpose — it's a React **re-render optimization** (scoped
`useSyncExternalStore` selector), not a subscription mechanism. Use it when you
want to isolate re-renders to a single feature's state within a component, but
`useAio()` handles subscriptions automatically regardless.

### Re-render optimization with `useFeature`

```tsx
// Scoped re-render — only re-renders when counter feature changes
const counter = useFeature(counterRef);
return <div>{counter.count}</div>;
```

`useFeature` narrows the `useSyncExternalStore` selector to a single feature
slice, so React skips re-renders when other features change. This is a
client-side rendering concern — subscription narrowing is handled automatically
by `useAio`'s proxy tracking.

---

## 6. State shape design

The shape of your state has a direct impact on traffic volume. Small changes to
structure can eliminate most unnecessary data transfer.

### Keep state flat

```ts
// Bad — changing one order re-sends the entire nested tree
type State = {
  users: {
    [id: string]: {
      profile: Profile;
      orders: Order[]; // changes here re-send profile too
      preferences: Prefs;
    };
  };
};

// Good — flat structure, each slice is independent
type State = {
  profiles: Record<string, Profile>;
  orders: Record<string, Order[]>;
  preferences: Record<string, Prefs>;
};
```

Delta compression works per top-level key (and one level into feature slices).
Flat structures produce smaller patches because only the changed key is
included.

### Separate hot and cold data

```ts
type State = {
  // Hot — changes every second (prices, ticks)
  prices: Record<string, number>;

  // Warm — changes per user action
  positions: Position[];

  // Cold — rarely changes
  config: AppConfig;
  userProfile: Profile;
};
```

Hot data should be in its own top-level key so delta patches only include that
key. If hot and cold data share a parent object, every hot update re-sends the
cold data too.

### Use IDs, not embedded objects

```ts
// Bad — changing a user name re-sends every order that references them
type Order = { user: User; items: Item[]; total: number };

// Good — orders hold ID, UI resolves from separate slice
type Order = { userId: string; items: Item[]; total: number };
```

### Exclude transient state from broadcast

Data that exists only for local UI state (modal open/closed, scroll position,
form drafts) should not be in server state. Use React local state or
feature-level `persist: { exclude }` for fields that don't need to cross the
wire.

```ts
feature("editor", {
  state: { content: "", cursorPos: 0, dirty: false },
  persist: { exclude: ["cursorPos"] }, // don't persist cursor
});
```

If a field shouldn't reach the UI at all, strip it in `stateForUI`:

```ts
stateForUI: ((state) => {
  const { internalCache, debugCounters, ...uiState } = state;
  return uiState;
});
```

---

## 7. Action batching

Every dispatch triggers the reduce→broadcast pipeline. Multiple rapid dispatches
in the same synchronous tick are coalesced (only one broadcast), but dispatches
spread across multiple ticks each trigger their own broadcast.

### Use feature methods

Feature methods batch multiple state changes into a single reduce cycle:

```ts
const counter = feature("counter", {
  state: { count: 0, total: 0, lastAction: "" },
  methods: {
    incrementAndTrack: (s) => ({
      ...s,
      count: s.count + 1,
      total: s.total + 1,
      lastAction: "increment",
    }),
  },
});
```

One method call = one action = one broadcast. Compare to dispatching three
separate actions for count, total, and lastAction.

### Batch in effects

If you need to dispatch multiple actions from an effect, do it synchronously:

```ts
execute: {
  async loadDashboard(app) {
    const [prices, orders, alerts] = await Promise.all([
      fetchPrices(),
      fetchOrders(),
      fetchAlerts(),
    ])
    // All three dispatches happen synchronously → one broadcast
    app.dispatch({ type: "prices:set", payload: { prices } })
    app.dispatch({ type: "orders:set", payload: { orders } })
    app.dispatch({ type: "alerts:set", payload: { alerts } })
  },
}
```

### Debounce high-frequency client actions

For actions triggered by typing, dragging, or scrolling, debounce on the client
before dispatching:

```tsx
// Client-side debounce — 150ms pause before sending
const debouncedSearch = useMemo(
  () => debounce((q: string) => dispatch({ type: "search:query", payload: { q } }), 150),
  [],
)

<input onChange={e => debouncedSearch(e.target.value)} />
```

This prevents 10+ dispatches/second from keyboard input, each of which would
trigger a state change and broadcast.

---

## 8. Proxy-tracked subscriptions

`useAio()` returns a deep recursive Proxy that intercepts every property access
during render. The collected paths tell the server exactly what each client
cares about.

### How it works

1. **Component renders** — the Proxy records accessed paths (e.g.,
   `counter.count`, `prices.BTC`, `user.name`).
2. **After render** — the client sends a `__subs` WebSocket message with the
   deduplicated path list: `["counter.count", "prices.BTC", "user.name"]`.
3. **Server filters** — on the next state change, the server only includes
   subscribed paths in that client's delta broadcast.
4. **Path updates accumulate** — as the user navigates and new components mount,
   their paths are added to the subscription set. Unmounted component paths are
   pruned after the grace period.

### Initial connect

On first connect, the server sends **full state** (primes the client cache).
Subsequent broadcasts are filtered to subscribed paths only.

### Backward compatibility

Old clients that don't send `__subs` messages continue to receive full deltas —
the server falls back to unfiltered broadcast. No migration required.

### Traffic impact

For apps with large state trees but focused UIs, proxy-tracked subscriptions
dramatically reduce payload size. A dashboard showing 3 metrics from a 200-key
state tree receives deltas for 3 keys, not 200.

---

## 9. Connection lifecycle

Every `useAio` hook registers a WebSocket listener. When all hooks unmount
(e.g., route change), the connection would normally close and reopen on the next
mount. aio prevents this with a grace period.

### 300ms grace period

When the last listener unsubscribes:

1. A 300ms timer starts.
2. If new listeners subscribe within 300ms → timer cancelled, connection kept.
3. If still zero after 300ms → full teardown (WebSocket closed, state cleared).

This handles React's mount/unmount cycle during route transitions — components
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

---

## 10. Offline queue

When the WebSocket disconnects, dispatched actions are queued in IndexedDB
instead of being lost. On reconnect, they're replayed in order.

| Parameter          | Value                           |
| ------------------ | ------------------------------- |
| Max queued actions | 1000                            |
| TTL per action     | 24 hours                        |
| Storage            | IndexedDB (`aio-offline-queue`) |
| Replay             | Automatic on reconnect          |

This means the client stays functional during brief disconnects without the user
noticing. Actions are replayed chronologically, and the server processes them as
if they arrived in real-time.

**Traffic implication:** On reconnect, the queue flushes all pending actions at
once. If you queued 100 actions during a 5-minute disconnect, all 100 dispatch
in rapid succession. Microtask coalescing ensures this produces at most a few
broadcasts, not 100.

---

## 11. Transport selection

### WebSocket (browser)

Default for all browser clients. Persistent bidirectional connection.

```
Browser ←→ WebSocket ←→ Deno Server
```

Rate limits (server-enforced):

- 100 messages/sec per client
- 5MB/s bandwidth per client
- 1MB max message size
- 100 max concurrent connections (configurable via `maxConnections`)

### UDS + IPC (Electron)

For Electron apps, aio uses Unix Domain Sockets instead of TCP WebSockets:

```
Renderer ←→ IPC bridge ←→ Electron Main ←→ UDS ←→ Deno Server
```

**Advantages:**

- Zero TCP overhead (no handshake, no Nagle's algorithm).
- ~2-5x lower latency than localhost WebSocket.
- No network exposure (socket file, not port).
- Works completely offline.

**Wire format:** NDJSON (newline-delimited JSON) — one JSON object per line.

UDS broadcast uses the same throttling (`syncIntervalMs`) and delta compression
as WebSocket. The same backpressure multiplier logic applies.

---

## 12. Vitals monitoring

aio's vitals system monitors traffic health in real-time and surfaces problems
before users notice them.

### Three measurement layers

**Render meter (client):** Measures how quickly the browser paints after
receiving state updates.

| Metric           | What it measures                      |
| ---------------- | ------------------------------------- |
| `staleness`      | ms since last unpainted state update  |
| `frameTime`      | ms since last `requestAnimationFrame` |
| `pendingPatches` | unprocessed delta patches waiting     |
| `paintRate`      | frames per second                     |
| `memory`         | JS heap size (Chrome/Edge only)       |

Status classification:

| Staleness           | Status     |
| ------------------- | ---------- |
| < threshold (300ms) | `healthy`  |
| >= threshold        | `degraded` |
| >= 2x threshold     | `warning`  |
| >= 5x threshold     | `frozen`   |

When a client is `frozen`, the server skips sending to it entirely — no point
sending data that won't be painted.

**Transport probe (ping/pong):** Measures round-trip latency between client and
server. Reported via vitals ping messages on the WebSocket.

**Pressure monitor (server):** Watches for payload size and broadcast rate
violations.

| Metric                     | Default threshold |
| -------------------------- | ----------------- |
| Payload size per broadcast | 500 KB            |
| Broadcast rate             | 30/sec            |
| Per-client bandwidth       | 1 MB/sec          |

### Vitals dashboard

Production-safe JSON endpoint:

```
GET /__aio/vitals
```

Returns current status of all three layers, per-client breakdown, and recent
alerts.

### Diagnostic events

The vitals system emits structured diagnostic events:

```ts
{
  kind: "pressure",
  severity: "likely",
  summary: "Payload 820KB exceeds 500KB threshold",
  detail: { trigger: "payload", payloadBytes: 820000 },
}
```

Severity levels: `likely` (high confidence problem), `possible` (worth
investigating), `speculative` (might be fine).

---

## 13. Connection limits

### Server-side limits

```ts
await aio.run({
  maxConnections: 100, // default: 100 WebSocket clients
});
```

When the limit is reached, new connections get HTTP 503. This prevents a single
server from being overwhelmed by too many clients.

### Message size limit

The server rejects WebSocket messages larger than 1MB. If a client tries to send
an oversized action, it's dropped with a debug log.

### Origin restrictions

```ts
await aio.run({
  allowedOrigins: ["app.example.com"], // restrict beyond localhost
});
```

Localhost is always allowed. `allowedOrigins` adds additional allowed hostnames.
This prevents unauthorized clients from connecting and consuming broadcast
bandwidth.

---

## 14. Optimization checklist

Use this checklist when optimizing an aio app's UI traffic. Items are ordered by
typical impact — start at the top.

### High impact

- [ ] **Use `stateForUI`** — send only what each client needs, not the full
      state tree. This is the single biggest lever.
- [ ] **Use `useAio()` (proxy-tracked)** — subscriptions are automatic. The
      server only sends deltas for paths your components actually read.
- [ ] **Flatten state shape** — keep top-level keys independent so delta patches
      are small.
- [ ] **Separate hot/cold data** — prices in one key, config in another.

### Medium impact

- [ ] **Use `createSelector`** for derived data in `stateForUI` — prevents
      recomputation and preserves references.
- [ ] **Batch related actions** — use feature methods or synchronous dispatch
      sequences.
- [ ] **Debounce client input** — 100-200ms debounce on search, drag, scroll
      actions.
- [ ] **Tune `syncIntervalMs`** — increase for dashboards, decrease for
      real-time UIs.
- [ ] **Strip internal state** — remove caches, debug counters, and intermediate
      computation from what reaches the UI.

### Low impact (fine-tuning)

- [ ] **Tune `fullStateThreshold`** — raise toward 0.8 if most updates touch few
      keys; lower toward 0.3 if updates are broad.
- [ ] **Keep a root-level `useAio` hook** — prevents WebSocket
      teardown/reconnect during route transitions.
- [ ] **Use IDs instead of embedded objects** — reduces duplication across state
      slices.
- [ ] **Monitor with vitals** — check `/__aio/vitals` and console for
      backpressure warnings.
- [ ] **Profile with `renderBudget`** — set staleness/pendingPatches thresholds
      to surface slow rendering early.

### Don't do

- Don't set `syncIntervalMs: 0` unless you genuinely need sub-frame latency. The
  default 50ms is faster than humans perceive.
- Don't set `fullStateThreshold: 0` in production — you lose delta compression.
- Don't put large datasets in state. Query from SQLite on demand, keep only the
  active view in state.
- Don't write manual selectors to narrow `useAio` subscriptions — proxy tracking
  handles this automatically. Use `useFeature` only for re-render scoping.
- Don't manually compress state (gzip, etc.) — the WebSocket layer already
  handles HTTP-level compression, and delta patches are usually small enough
  that compression overhead isn't worth it.

---

## 15. Defaults reference

All traffic-related defaults in one place:

| Parameter                  | Default                     | Source                       |
| -------------------------- | --------------------------- | ---------------------------- |
| `syncIntervalMs`           | 50ms                        | `aio.ts:114`                 |
| `fullStateThreshold`       | 0.5                         | `server.ts:331`              |
| `maxConnections`           | 100                         | `server.ts:257`              |
| Max WS message size        | 1 MB                        | `server.ts:256`              |
| Backpressure: moderate     | staleness > 100ms → 2x      | `server.ts:260`              |
| Backpressure: heavy        | staleness > 300ms → 4x      | `server.ts:259`              |
| Backpressure: recovery     | 3 healthy pings → step down | `server.ts:261`              |
| Subscription grace period  | 300ms                       | `browser.ts:744`             |
| Offline queue max          | 1000 actions                | `browser.ts`                 |
| Offline queue TTL          | 24 hours                    | `browser.ts`                 |
| Render staleness threshold | 300ms                       | `vitals/render-meter.ts`     |
| Pressure: payload size     | 500 KB                      | `vitals/pressure-monitor.ts` |
| Pressure: broadcast rate   | 30/sec                      | `vitals/pressure-monitor.ts` |
| Pressure: client bandwidth | 1 MB/sec                    | `vitals/pressure-monitor.ts` |

---

## 16. Diagnosis workflow

When you suspect traffic problems, follow this sequence:

**Step 1: Check vitals dashboard**

```
curl http://localhost:8000/__aio/vitals | jq .
```

Look for: `frozen` clients, high staleness, payload warnings.

**Step 2: Check console for backpressure**

```
[aio:vitals] client a3f2c901 — staleness 450ms, backpressure 1x→4x
```

If you see backpressure escalating, the client can't keep up with updates.

**Step 3: Check payload sizes in `perf.log`**

```
grep "pressure" log/perf.log
```

If payloads exceed 500KB, your state is too large or `stateForUI` isn't
filtering enough.

**Step 4: Measure from the browser**

Open DevTools → Network tab → WS filter. Watch message sizes and frequency.
Compare to your `syncIntervalMs` setting.

**Step 5: Profile re-renders**

If React DevTools shows frequent re-renders, check that components read only the
state paths they need. `useAio()` tracks paths automatically, but reading broad
objects (e.g., `state.orders` when you only need `state.orders.length`) widens
the subscription. Use `useFeature` to scope re-renders to a single feature.

**Step 6: Check state shape**

If delta patches are large, inspect what's changing. Use `am state` (the CLI
tool) to see current state structure. Look for hot data mixed with cold data
under the same parent key.

---

## Summary

| Layer              | Technique                   | Effect                              |
| ------------------ | --------------------------- | ----------------------------------- |
| **Server→Wire**    | `stateForUI`                | Send only relevant data per client  |
| **Server→Wire**    | Delta compression           | Send only changed keys              |
| **Server→Wire**    | Broadcast throttling        | Max N broadcasts/sec                |
| **Server→Wire**    | Per-client backpressure     | Slow clients get fewer updates      |
| **Server→Wire**    | Frozen client skip          | Don't send to unresponsive clients  |
| **Wire→Browser**   | Patch application           | Merge only changed keys             |
| **Wire→Browser**   | Reference preservation      | Keep unchanged object refs          |
| **Wire→Browser**   | Array ref preservation      | Keep unchanged array element refs   |
| **Browser→Server** | Proxy-tracked subscriptions | Server sends only accessed paths    |
| **Browser→React**  | `useFeature` scoping        | Re-render only when feature changes |
| **Browser→React**  | `createSelector`            | Cache derived computations          |
| **App design**     | Flat state shape            | Smaller delta patches               |
| **App design**     | Hot/cold separation         | Isolate frequent changes            |
| **App design**     | Action batching             | Fewer broadcasts per user action    |
| **App design**     | Client-side debounce        | Fewer dispatches per interaction    |
| **Lifecycle**      | Grace period                | Prevent teardown during transitions |
| **Lifecycle**      | Offline queue               | Buffer actions during disconnects   |
| **Monitoring**     | Vitals system               | Detect and adapt to problems        |
| **Transport**      | UDS (Electron)              | Lower latency than WebSocket        |
