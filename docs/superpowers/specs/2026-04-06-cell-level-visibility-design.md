# Cell-Level Visibility & Persistence — Design Spec

## Goal

Move state visibility (UI) and persistence (DB) configuration from app-level to cell-level. Each cell declares what it exposes and what it persists. Default: nothing.

## Problem

Current architecture has two app-level config functions:

- `stateForDB: (state) => ...` — filters full composed state before KV write
- `stateForUI: (state, user) => ...` — filters full composed state before broadcast

Both are relics from pre-cell design. They centralize knowledge of every cell's internals in one place, violating cell encapsulation. They also force all-or-nothing: either you filter everything yourself, or everything leaks.

Current per-cell `persist: { exclude: ["field"] }` is a partial fix for DB only. No cell-level UI config exists.

## Design

### Unified API

Both `persist` and `ui` use the same declaration style (one of):

```ts
// persist — one of:
persist: "all",                          // persist everything
persist: "none",                         // persist nothing (default)
persist: { include: ["items"] },         // only these fields
persist: { exclude: ["cache"] },         // everything except these

// ui — one of:
ui: "all",                               // expose everything
ui: "none",                              // hidden cell (default)
ui: { include: ["items"] },              // only these fields
ui: { exclude: ["analytics", "cache"] }, // everything except these
```

### Defaults and `cellDefaults`

**Framework default** (when nothing specified): `"none"` for both `persist` and `ui`.

**App-level `cellDefaults`** — set once in `aio.run()` to override the framework default for all cells:

```ts
await aio.run({
  appId: "my-app",
  cells: [counter, auth, orders],
  cellDefaults: { ui: "all", persist: "all" },
});
```

**Resolution order:** cell-level config > `cellDefaults` > framework default (`"none"`)

```ts
// CellsConfig addition
cellDefaults?: {
  ui?: CellFieldFilter;      // default: "none"
  persist?: CellFieldFilter;  // default: "none"
};
```

| Config | Framework default | Rationale |
|--------|-------------------|-----------|
| `persist` | `"none"` | Breaking change — cells must now explicitly opt in. Previously app-level `persist: true` persisted all cells by default. Explicit is safer. |
| `ui` | `"none"` | Breaking change — cells must now explicitly opt in. Prevents accidental data leaks. Prevents MB-scale state blasting to clients. Service/CLI apps have no UI consumers. |

**Scaffolder integration:** `init.sh` generates `cellDefaults` appropriate for app type:
- `browser`, `electron`, `android`, `remote-*`: `cellDefaults: { ui: "all" }`
- `service`, `cli`, `server-only`: no `cellDefaults` (framework default `"none"`)
- All types: `persist` defaults to `"none"` (opt-in per cell or via `cellDefaults`)

### Type Definition

Note: `UiConfig` already exists in `src/aio.ts:110` for window settings (title, width, height). The cell-level type uses `CellVisibility` to avoid collision.

```ts
/** Shared filter type — used by both persist and ui */
type CellFieldFilter =
  | "all"
  | "none"
  | { include: string[] }
  | { exclude: string[] };

/** Cell-level UI visibility — extends CellFieldFilter with optional per-user transform */
type CellVisibility = CellFieldFilter | {
  include: string[];
  exclude?: never;
  forUser?: (exposed: Record<string, unknown>, user?: AioUser) => Record<string, unknown>;
} | {
  exclude: string[];
  include?: never;
  forUser?: (exposed: Record<string, unknown>, user?: AioUser) => Record<string, unknown>;
};
```

**Deferred:** Function forms of include/exclude (`(state) => ...`) are deferred to a future version. String arrays cover 99% of cases and keep the type simple. If a cell needs complex filtering, use `forUser` (for UI) or app-level `stateForDB` (for persistence).

### `forUser` — Per-User UI Filtering (Optional)

For cells that need user-aware visibility (admin vs regular user):

```ts
const orders = cell("orders", {
  state: { items: [], total: 0 },
  methods: { ... },
  ui: {
    include: ["items", "total"],
    forUser: (exposed, user) =>
      user?.role === "admin"
        ? exposed
        : { ...exposed, items: exposed.items.filter(o => o.userId === user?.id) },
  },
});
```

**Two-step pipeline:**
1. `include`/`exclude` — structural filter, evaluated once per state change, result cached
2. `forUser` — runtime transform, evaluated once per client per state change, receives already-filtered clone

**Safety rules:**
- `forUser` receives a `structuredClone` of the structurally-filtered state (never live state, deep clone prevents mutation of cached result)
- If `forUser` throws: log error, fall back to structural filter result
- `forUser` can narrow or transform the exposed state. It cannot access fields removed by `include`/`exclude` — they are already stripped before `forUser` runs

### `persist` — No `forUser` Equivalent

Persistence has no per-consumer variance. `persist` supports only `"all"` | `"none"` | `{ include }` | `{ exclude }`. No second step.

### Interaction with `sync`

Sync-enabled cells (`sync: true`) use SQLite op-log instead of KV for their managed fields. This takes precedence:

- If a cell has `sync: true` and `persist: "all"`: sync-managed fields go to SQLite, non-sync fields go to KV.
- If a cell has `sync: true` and no `persist`: sync fields still go to SQLite (sync manages its own persistence), non-sync fields are not persisted.
- `persist` config only controls KV persistence for non-sync fields. Same behavior as today, just explicit.

### App-Level Escape Hatch

`stateForUI` at `aio.run()` level is kept as an escape hatch for cross-cell derived state (joining two cells into one UI view). When set, it overrides all per-cell `ui` configs.

`stateForDB` at `aio.run()` level is kept similarly. When set, it overrides all per-cell `persist` configs.

Both are documented as "advanced overrides — prefer cell-level config."

### Performance: Patches Re-Enabled

**Implemented.** Each cell gets a patch strategy at composition time:

| Strategy | When | Behavior |
|---|---|---|
| `raw` | `ui: "all"` | Raw Immer patches pass through |
| `skip` | `ui: "none"` | Nothing sent to clients |
| `filter` | `ui: { include/exclude }` (no forUser) | Patches filtered by first path segment against field set |
| `full` | `ui: { ..., forUser }` | Full filtered state — patches discarded for this cell |

If any `full`-strategy cell emits patches in a tick, all patches are discarded
for that broadcast (full-state fallback). Otherwise, `raw` and `filter` cells
get surgical patches. Net effect: most apps regain patch-based delta updates.

### Broadcast Pipeline

```
dispatch → reduce → new state
  → per-cell structural filter (cached, shared across clients)
  → per-cell forUser transform (per client, on filtered clone)
  → compose filtered cells into client state object
  → compute delta (patches for structural-only cells, full for forUser cells)
  → filter by client __subs paths
  → ws.send()
```

### Persistence Pipeline

```
dispatch → reduce → new state
  → per-cell persist filter (include/exclude)
  → compose filtered cells into DB state object
  → debounced KV write
```

## What Changes

### Cell Config (both MethodsCellConfig and ActionsCellConfig)

| Before | After |
|--------|-------|
| `persist?: { exclude?: string[] }` | `persist?: CellFieldFilter` |
| *(no ui config)* | `ui?: CellVisibility` |

### CellAio Internal Type

| Before | After |
|--------|-------|
| `persistExclude?: string[]` | `persistFilter?: CellFieldFilter` |
| *(nothing)* | `uiFilter?: CellFieldFilter` |
| *(nothing)* | `uiForUser?: (exposed, user) => unknown` |

### aio.ts Composition

| Before | After |
|--------|-------|
| Build `autoGetDBState` from collected excludes | Build `autoGetDBState` from cell `persistFilter` |
| Use app-level `stateForUI` directly | Build `autoGetUIState` from cell `uiFilter` + `uiForUser` |
| Patches disabled when `stateForUI` set | Patches disabled only per-cell when `forUser` present |

### server.ts / uds.ts Broadcast

| Before | After |
|--------|-------|
| `getUIState(state, user)` returns one filtered blob | `getUIState(state, user)` composes per-cell filtered results |
| Patches always disabled when filtered | Patches work for structural-only cells |

## What Does NOT Change

- No new concepts — `persist` already exists, `ui` follows same pattern
- No runtime behavior change for cells without `persist`/`ui` config (they're invisible/not persisted, same as having no config before but now explicit)
- Selectors, methods, generators, machine — all untouched
- Transport layer (WebSocket, UDS) — untouched
- Client-side state-core, hooks, adapters — untouched

## Migration

1. **`persist: { exclude: [...] }`** — still works (same shape). No change needed.
2. **`stateForDB` at app level** — still works as override. Document as "advanced."
3. **`stateForUI` at app level** — still works as override. Document as "advanced."
4. **Default change (ui: "none")** — breaking. Easiest fix: add `cellDefaults: { ui: "all" }` to `aio.run()`. Or add `ui: "all"` to individual cells.
5. **Default change (persist: "none")** — breaking. Easiest fix: add `cellDefaults: { persist: "all" }` to `aio.run()`. Or add `persist: "all"` to individual cells.
6. **One-line migration for most apps:** add `cellDefaults: { ui: "all", persist: "all" }` to `aio.run()` to match previous behavior, then progressively tighten per-cell.

## Examples

### L1 — Simple counter (beginner)

```ts
// app.ts — cellDefaults covers all cells
await aio.run({
  appId: "my-app",
  cells: [counter],
  cellDefaults: { ui: "all", persist: "all" },
});

// cell/counter.ts — no ui or persist needed (covered by cellDefaults)
const counter = cell("counter", {
  state: { count: 0 },
  methods: {
    increment(s) { s.count++; },
  },
});
```

### L2 — Selective exposure

```ts
const trading = cell("trading", {
  state: { orders: [], positions: [], riskModel: {}, cache: {} },
  methods: { ... },
  persist: { exclude: ["cache", "riskModel"] },
  ui: { include: ["orders", "positions"] },
});
```

### Rare — Per-user filtering

```ts
const admin = cell("admin", {
  state: { users: [], audit: [] },
  methods: { ... },
  persist: { include: ["users", "audit"] },
  ui: {
    include: ["users"],
    forUser: (exposed, user) =>
      user?.role === "admin" ? exposed : { users: [] },
  },
});
```

### Background worker — no UI, persisted

```ts
const sync = cell("sync", {
  state: { queue: [], lastSync: null },
  methods: { ... },
  persist: "all",
  // ui not set → "none" (invisible to clients)
});
```
