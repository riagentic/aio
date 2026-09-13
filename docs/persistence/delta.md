# Delta & Data Transport

How data flows from server to browser and how to optimize it.

## Data flow

```
method call → reduce → Immer patches for the cell
  → narrowed (a grown array → its adds, a grown string → its suffix)
  → coalesced with the round's other patches (microtask + syncIntervalMs)
  → per client: visible/forUser view, filtered to the cells it reads
  → patch smaller than fullStateThreshold × full state?
       yes → {"v":2,"t":"patches","d":[…ops]}
       no  → {"v":2,"t":"state","d":{…whole view}}
  → browser applies the ops (Immer, structural sharing) → cell signals
  → components that read a changed cell re-render
```

## Cell-level UI filtering

The biggest server-side win. Controls what the server _sends_ per client:

```ts
type Order = { id: string; userId: string };

const orders = cell("orders", {
  state: { items: [] as Order[], internal: [] as string[] },
  methods: {},
  visible: {
    exclude: ["internal"],
    forUser: (exposed, user?) => {
      if (user?.role === "admin") return exposed;
      return {
        ...exposed,
        items: exposed.items.filter((o) => o.userId === user?.id),
      };
    },
  },
});
```

Each cell declares its own `visible` config
([cell visibility](../state/cell-visibility.md)). `include`/`exclude` control
which keys are sent. `forUser` runs per distinct user per state change —
memoized on the whole user record, not just its id. A change to a `forUser` cell
cannot be a patch: it sends each client its **whole** view (every cell it reads,
not just that one). Never do expensive computation here.

## Delta compression

Automatic — no configuration required.

1. **On connect**: a full `state` frame — the client's whole view.
2. **Every broadcast round after that**: the Immer patches of every commit in
   the round, compacted (an op a later whole-value `replace` overwrites is
   dropped) and filtered to the cells the client reads.
3. **Patch or full state**: the patch is sent unless its JSON is larger than
   `fullStateThreshold` × the JSON of the client's full view — then the full
   view is sent instead. The comparison is in **bytes**, not changed keys.
4. **A lost round** (backpressure, a frozen client, a snapshot that failed)
   makes that client's next frame a full state, never a patch that assumes the
   skipped one landed. A frozen client that recovers is sent it at once.

### Wire format

Every frame is one JSON envelope `{ "v": 2, "t": "<kind>", "d": <payload> }`
(`src/protocol/envelope.ts`). State travels as two kinds:

```json
{ "v": 2, "t": "state", "d": { "fleet": { "members": [], "count": 0 } } }
```

```json
{
  "v": 2,
  "t": "patches",
  "d": [
    { "op": "replace", "path": ["fleet", "members", 16, "price"], "value": 17 },
    { "op": "add", "path": ["fleet", "candidates", 103], "value": 2007 },
    { "op": "remove", "path": ["fleet", "candidates", 50] },
    { "op": "append", "path": ["chat", "reply"], "value": " next chunk" }
  ]
}
```

`d` is a list of Immer patch ops whose path starts with the cell name, plus
aio's `append` (a string of 256+ characters that grew, sent as just the new
suffix). Every client applies them through the one applier in
`src/protocol/patch-ops.ts`; an op it cannot apply makes it ask for a full state
(`resync`) instead of rendering a diverged copy.

### Tuning threshold

```ts
await aio.run({
  fullStateThreshold: 0.5, // default: patch JSON > 50% of full-state JSON → send full state
});
```

`0` always sends full state. `1` sends a patch unless it is larger than the full
state itself.

### What a write costs on the wire

Measured on a 117 KB cell (160 rows of ~700 B each, plus a 100-number list and a
100-key map), one method call each, default threshold:

| Write                                               | Frame                            |
| --------------------------------------------------- | -------------------------------- |
| `s.members[i].price += 1` on 10 of the 160 rows     | `patches`, 691 B                 |
| `s.candidates.push(x)` for 3 new items              | `patches`, 207 B                 |
| `s.candidates = [...s.candidates, x, y, z]`         | `patches`, 207 B — the same adds |
| `s.candidates = s.candidates.filter(…)` (3 removed) | `patches`, 174 B                 |
| `s.candidates.splice(10, 1)`                        | `patches`, 5.7 KB                |
| `s.map.k5 = v`                                      | `patches`, 100 B                 |
| `delete s.map.k7`                                   | `patches`, 67 B                  |
| `s.map = { ...s.map, k6: v }`                       | `patches`, 12 KB — the whole map |
| rewrite a field on every row                        | `state`, 117 KB — over threshold |

The client keeps object identity for everything a patch did not touch, which is
what lets AIR's signal subscriptions and `memo()` components skip unchanged
slices.

## Arrays and objects: what gets re-sent

Immer patches describe _what changed_, and aio narrows a whole-array replacement
back to the edit it was. So for **arrays**, spreading and filtering cost the
same as pushing:

```ts
s.candidates = [...s.candidates, ...batch]; // ✅ sent as one `add` per new item
s.candidates = s.candidates.filter((c) => c.ok); // ✅ sent as one `remove` per dropped item
s.candidates.splice(10, 1); // ⚠️ Immer shifts every later index: one `replace` each
```

Narrowing matches elements **by identity**, so it keeps the whole-array
`replace` when it cannot be sure: a reorder (`sort`, `reverse`), duplicate
elements (the same primitive twice counts), rebuilt objects (`map` returning new
objects), or an edit whose ops would carry as much as the array itself.

**Objects** are not narrowed. Replacing the binding re-ships the whole object:

```ts
s.map = { ...s.map, [id]: v }; // ⚠️ the entire map, every commit
s.map[id] = v; // ✅ one `replace` of that key
delete s.map[id]; // ✅ one `remove`
```

A dictionary rebuilt by spreading is the usual cause of a `PRESSURE` vitals
warning on an otherwise small cell.

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
4. **Interactive priority**: a broadcast caused by a **client action** skips the
   window entirely — it flushes immediately and reopens the leading edge

Point 4 is what keeps typing and navigation feeling instant. The throttle exists
to pace _background_ churn (a poll loop, a schedule, a sync replay); without the
exception, every keystroke paid up to `syncIntervalMs` of latency before its own
patch came back — measured as a constant ~66ms per navigation key at the 50ms
default. Server-origin churn still coalesces exactly as before, so this costs no
extra broadcasts: it moves the ones a user is waiting on to the front.

```ts
await aio.run({ syncIntervalMs: 50 }); // default: max 20 broadcasts/sec
```

| Value | Behavior        | Use case        |
| ----- | --------------- | --------------- |
| `0`   | No throttle     | Trading UI      |
| `16`  | ~60/sec (60fps) | Gaming          |
| `50`  | Default         | Most apps       |
| `500` | ~2/sec          | Slow dashboards |

Raising `syncIntervalMs` therefore throttles background updates without dulling
the app: a user's own action is never delayed by it.

## Backpressure

Per-client, automatic. Server reads render staleness from browser pings:

- **>300ms** → 4x multiplier (send every 200ms)
- **>100ms** → 2x multiplier (send every 100ms)
- **3 consecutive healthy pings** → step down by half

**Recovery**: gradual (4x → 2x → 1x), any spike resets counter.

**Frozen clients** (no heartbeat for `transport.frozen`, default 2s): server
skips their rounds entirely. The moment one is heard from again it is sent the
whole state its skipped rounds carried, without waiting for the app's next
change: an idle app has none, and a background tab or a closed laptop lid would
otherwise stay stale until something else moved.

**Peers that stop reading** (more than 4 MB of unread frames held for one
socket, `WS_BUFFER_HIGH_WATER`): state rounds to them are skipped and owed a
full state, like a frozen client's. A sync `op` frame or server-write push has
no such in-band repair (a peer that misses op N and receives N+1 moves past N
for good), so a peer that would miss one is closed with `1013` instead; it
reconnects, and the handshake and sync catch-up bring it back to the server's
state. `/__aio/health` reports the backlog as `ws:write-backlog`.

## Memoized selectors

### `createSelector` — server-side

```ts
import { createSelector } from "aio";

type Position = { qty: number; price: number };
type Order = { status: string };
type State = { positions: Position[]; orders: Order[]; orderFilter: string };

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

### Direct cell access — re-render scoping

```tsx
import { counter } from "./app.ts";

export function Count() {
  return <div>{counter.count}</div>;
}
```

Reading `counter.count` auto-tracks via the cell signal. Only components that
read a specific cell's state re-render when it changes — and the read is also
what subscribes this client to the `counter` cell on the server (below).

`useAio()` hands back the whole state instead, and subscribes the client to
**every** cell. Prefer direct cell reads.

## Subscriptions: only the cells a client reads

1. A component reads `counter.count` — the client records the `counter` cell
2. Within ~16 ms it sends a `subs` frame
   (`{"v":2,"t":"subs","d":{"subs":["counter"]}}`)
3. The server sends that client only patches and full-state slices for the cells
   in its list; the paths accumulate for the life of the page
4. `useAio()` (or anything that walks the whole state) records `*` — everything

Filtering is per **cell**: a subscription to `orders.items` still receives every
patch for the `orders` cell. A client that has sent no `subs` frame yet — and
any client that never sends one (`connectCli`, a raw WebSocket) — receives all
cells. A `subs` list over 1024 paths, or an empty one, is refused whole with a
server warning, and the client keeps the list it had (initially: every cell).

## State shape design

### Split cells by who reads them

Subscription filtering, `forUser` full sends and the patch-vs-full comparison
all work at the **cell** level. A hot ticker in the same cell as a large, rarely
read catalog reaches every client that shows either; two cells reach each only
the clients that read them.

### Keep `forUser` cells quiet

Every change to a cell with `forUser` sends each client its **whole** view —
every cell it reads, as a `state` frame — because a per-user projection has no
patch. Measured: one counter bump in a `forUser` cell re-sent 18 KB, where the
same bump in a plain cell was a 71 B patch. Keep fast-changing fields out of
`forUser` cells.

### Use IDs, not embedded copies

```ts
// Bad — a user rename has to rewrite every order that embeds the user
type Order = { user: User; items: Item[] };
// Good — one write to the user, orders untouched
type Order = { userId: string; items: Item[] };
```

## Action batching

One method call = one commit = one set of patches. Write the fields on the draft
— a sync method's return value is a value for the caller, never the new state:

```ts
methods: {
  incrementAndTrack(s) {
    s.count += 1;
    s.total += 1;
    s.lastAction = "increment";
  },
},
```

Returning `{ ...s, count: s.count + 1 }` instead changes nothing: the caller's
`await` resolves with that object and the state stays as it was.

Commits in the same tick coalesce into one broadcast (see
[Broadcast throttling](#broadcast-throttling)). Debounce high-frequency client
actions (typing, dragging) with a 100–200 ms delay.
