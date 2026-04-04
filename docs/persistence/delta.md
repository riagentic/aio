# Delta & Data Transport

How data flows from server to browser and how to optimize it.

## Data flow

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

## stateForUI filtering

The biggest server-side win. Controls what the server _computes_ per client:

```ts
await aio.run({
  stateForUI: (state, user) => ({
    prices: state.prices,
    ...(user?.role === "admin"
      ? { orders: state.orders }
      : { myOrders: state.orders.filter((o) => o.userId === user?.id) }),
  }),
});
```

Called once per unique user per state change. Memoized per user ID — if state
reference hasn't changed, the previous result returns without calling your
function. Never do expensive computation here — use `createSelector`.

## Delta compression

Automatic — no configuration required for basic operation.

1. **First broadcast**: always full state
2. **Subsequent**: each top-level key is JSON-stringified and compared to cached
3. Fewer changed keys than threshold → **delta patch**
4. More changed → **full state**
5. Nothing changed → **skip**

### Patch format

```json
{
  "$p": { "counter": { "count": 42 }, "prices": { "BTC": 67000 } },
  "$d": ["removedFeature"]
}
```

### Tuning threshold

```ts
await aio.run({
  fullStateThreshold: 0.5, // >50% keys changed → full state
});
```

`1.0` = always delta. `0.0` = always full (disables delta).

### Reference preservation

`_applyPatch` preserves object references for unchanged slices — critical for
React's `useSyncExternalStore`.

**Identity-keyed arrays** (objects with string `id`) get per-element delta
patching automatically:

```json
{
  "$p": {
    "fleet": {
      "members": {
        "$arr": true,
        "$id:SOL_15m": { "price": 142.5 },
        "$rm": ["$id:ETH_old"]
      }
    }
  }
}
```

A 160-element array with 10 changes per tick: **120KB → ~7.5KB** per broadcast.

**Non-identity arrays** use `_preserveArrayRefs`: same length + shallow-equal
elements → old reference kept.

## Broadcast throttling

```
dispatch(A) ─┐
dispatch(B) ─┤  (same tick)
dispatch(C) ─┘
              └─→ queueMicrotask → ONE broadcast
                  └─→ throttle window (50ms default)
```

1. **Microtask coalescing**: synchronous dispatches → one broadcast
2. **Throttle window**: next broadcast delayed by `syncIntervalMs`
3. **Leading edge**: first broadcast fires immediately

```ts
await aio.run({ syncIntervalMs: 50 }); // default: max 20 broadcasts/sec
```

| Value | Behavior        | Use case        |
| ----- | --------------- | --------------- |
| `0`   | No throttle     | Trading UI      |
| `16`  | ~60/sec (60fps) | Gaming          |
| `50`  | Default         | Most apps       |
| `500` | ~2/sec          | Slow dashboards |

## Backpressure

Per-client, automatic. Server reads render staleness from browser pings:

- **>300ms** → 4x multiplier (send every 200ms)
- **>100ms** → 2x multiplier (send every 100ms)
- **3 consecutive healthy pings** → step down by half

**Recovery**: gradual (4x → 2x → 1x), any spike resets counter.

**Frozen clients** (staleness >= 5x threshold): server skips entirely. On
recovery, normal delta mechanism handles catch-up.

## Memoized selectors

### `createSelector` — server-side

```ts
import { createSelector } from "aio/selector.ts";

const selectPortfolioValue = createSelector(
  (s: State) => s.positions,
  (positions) => positions.reduce((sum, p) => sum + p.qty * p.price, 0),
);

const selectFiltered = createSelector(
  (s: State) => s.orders,
  (s: State) => s.orderFilter,
  (orders, filter) => orders.filter((o) => o.status === filter),
);
```

Inputs compared by reference (`===`). Supports 1-6 input selectors. Compose by
passing selectors as inputs to other selectors.

### `useAio` — client-side (recommended)

Returns a deep Proxy that tracks property access during render. Tracked paths
sent to server as `__subs` — server only sends deltas for those paths.

```tsx
const state = useAio();
return <div>{state.counter.count}</div>;
```

### `useFeature` — re-render scoping

```tsx
const counter = useFeature(counterRef);
return <div>{counter.count}</div>;
```

Narrows `useSyncExternalStore` to one feature slice. Client-side rendering
concern — subscription narrowing handled by `useAio` automatically.

## Proxy-tracked subscriptions

1. Component renders — Proxy records accessed paths
2. After render — client sends `__subs` with deduplicated paths
3. Server filters — only subscribed paths in delta broadcasts
4. Paths accumulate as user navigates; unmounted paths pruned after grace period

First connect always sends full state. Old clients without `__subs` get
unfiltered broadcast (backward compatible).

## State shape design

### Keep state flat

```ts
// Bad — changing one order re-sends the entire nested tree
type State = { users: { [id: string]: { profile: Profile; orders: Order[] } } };

// Good — each slice independent
type State = {
  profiles: Record<string, Profile>;
  orders: Record<string, Order[]>;
};
```

### Separate hot and cold data

Hot data (prices, ticks) in its own top-level key. Cold data (config, profile)
separate. Prevents cold data re-sending on every hot update.

### Use IDs, not embedded objects

```ts
// Bad — user name change re-sends every order
type Order = { user: User; items: Item[] };
// Good
type Order = { userId: string; items: Item[] };
```

## Action batching

One method call = one action = one broadcast:

```ts
methods: {
  incrementAndTrack: (s) => ({
    ...s, count: s.count + 1, total: s.total + 1, lastAction: "increment",
  }),
},
```

Multiple synchronous dispatches from effects coalesce into one broadcast.
Debounce high-frequency client actions (typing, dragging) with 100-200ms delay.
