# Cell-Level Visibility & Persistence

Control what state each cell exposes to clients (`ui`) and persists to disk
(`persist`). Default for both: `"none"` — nothing leaks unless you opt in.

## Quick Start

```ts
// Expose everything, persist everything
await aio.run({
  cells: [counter, auth],
  cellDefaults: { ui: "all", persist: "all" },
});
```

For most apps, `cellDefaults` is all you need. Tighten per-cell when you have
sensitive or large data.

## Filter Options

Both `persist` and `ui` accept the same filter shapes:

| Config                    | Effect                    |
| ------------------------- | ------------------------- |
| `"all"`                   | Include everything        |
| `"none"`                  | Include nothing (default) |
| `{ include: ["a", "b"] }` | Only these fields         |
| `{ exclude: ["cache"] }`  | Everything except these   |

```ts
const trading = cell("trading", {
  state: { orders: [], positions: [], riskModel: {}, cache: {} },
  methods: {/* ... */},
  persist: { exclude: ["cache", "riskModel"] },
  ui: { include: ["orders", "positions"] },
});
```

## Resolution Order

Cell-level config wins over `cellDefaults`, which wins over the framework
default (`"none"`):

```
cell.persist > cellDefaults.persist > "none"
cell.ui      > cellDefaults.ui      > "none"
```

## Per-User Filtering (`forUser`)

For multi-user apps where different users see different data:

```ts
const orders = cell("orders", {
  state: { items: [], total: 0 },
  methods: {/* ... */},
  ui: {
    include: ["items", "total"],
    forUser: (filteredState, user) =>
      user?.role === "admin" ? filteredState : {
        ...filteredState,
        items: filteredState.items.filter(
          (o) => o.userId === user?.id,
        ),
      },
  },
});
```

### How `forUser` Works

1. `include`/`exclude` runs first — structural filter, result cached
2. `forUser` receives a `structuredClone` of the filtered state — never live
   state
3. `forUser` runs once per client per broadcast — return value sent to that
   client
4. If `forUser` throws, the structural filter result is sent instead (safe
   fallback)

`forUser` **cannot** access fields removed by `include`/`exclude` — they're
already stripped.

## Broadcast Performance

The framework picks the optimal broadcast strategy per cell automatically:

| Cell UI config            | Strategy | What's sent                    |
| ------------------------- | -------- | ------------------------------ |
| `ui: "all"`               | `raw`    | Immer patches (most efficient) |
| `ui: "none"`              | `skip`   | Nothing                        |
| `ui: { include/exclude }` | `filter` | Filtered Immer patches         |
| `ui: { ..., forUser }`    | `full`   | Full filtered state per client |

Cells without `forUser` get surgical patch-based updates. Adding `forUser` to a
cell disables patches for that cell (full state sent each time). Use it only
when you need per-user transforms.

## Common Patterns

### Background Worker (no UI)

```ts
const sync = cell("sync", {
  state: { queue: [], lastSync: null },
  methods: {/* ... */},
  persist: "all",
  // ui not set = "none" = invisible to clients
});
```

### Admin-Only Cell

```ts
const admin = cell("admin", {
  state: { users: [], audit: [] },
  methods: {/* ... */},
  persist: { include: ["users", "audit"] },
  ui: {
    include: ["users"],
    forUser: (state, user) => user?.role === "admin" ? state : { users: [] },
  },
});
```

### Large State with Selective Exposure

```ts
const analytics = cell("analytics", {
  state: { summary: {}, rawEvents: [], cache: {} },
  methods: {/* ... */},
  persist: { exclude: ["cache"] },
  ui: { include: ["summary"] }, // don't blast rawEvents to clients
});
```

## Persistence vs UI

Both default to `"none"` but serve different purposes:

- **`persist`**: Controls what's saved to KV on disk. Opt-in = data safety (only
  persist what you explicitly allow).
- **`ui`**: Controls what's sent to browser clients. Opt-in = security (prevents
  accidental data exposure).

They're independent — a cell can persist everything but expose nothing to UI
(background worker), or expose everything but persist nothing (ephemeral UI
state).

## Interaction with Sync

Cells with `sync: true` use SQLite for their sync-managed fields. The `persist`
config only controls KV persistence for non-sync fields. Sync manages its own
persistence separately.
