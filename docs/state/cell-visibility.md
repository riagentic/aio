# Cell-Level Visibility & Persistence

> Per-tab state that should NOT be shared or persisted belongs in a
> [client-scoped cell](cells.md#shared-vs-per-client-state) (`scope: "client"`)
> or `useLocal`.

Control what state each cell exposes to clients (`ui`) and persists to disk
(`persist`). Default for both: `"all"` — zero-config persists and exposes
everything. Opt out per cell (or via `cellDefaults`) for privacy or size tuning.

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

| Config                             | Effect                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `"all"`                            | Include everything (default)                                                           |
| `"none"`                           | Include nothing                                                                        |
| `{ include: ["a", "b"] }`          | Only these top-level fields                                                            |
| `{ exclude: ["cache"] }`           | Everything except these                                                                |
| `{ exclude: ["accounts.secKey"] }` | **Deep**: remove the field everywhere under `accounts` (arrays traversed element-wise) |

```ts
const trading = cell("trading", {
  state: { orders: [], positions: [], riskModel: {}, cache: {}, accounts: [] },
  methods: {/* ... */},
  persist: { exclude: ["cache", "riskModel"] },
  // secKey never reaches a client — stripped from full-state broadcasts AND
  // from Immer patch payloads (including patches that replace whole rows).
  ui: { include: ["orders", "positions"] }, // or exclude: ["accounts.secKey"]
});
```

`include` is a **top-level allowlist** — dot-paths are exclude-only (a dotted
include warns at boot).

## Resolution Order

Cell-level config wins over `cellDefaults`, which wins over the framework
default (`"all"`):

```
cell.persist > cellDefaults.persist > "all"
cell.ui      > cellDefaults.ui      > "all"
```

## Private (server-only) fields — scratch state

Need a field that lives in `state` (so methods read/write it) but is **never
broadcast to the browser and never persisted** — a delta-staging sample, a
re-entrancy guard, a cached derivation? Exclude it from **both** filters:

```ts
cell("net", {
  state: { rxMbps: 0, prevBytes: 0 }, // prevBytes = private sample
  ui: { exclude: ["prevBytes"] }, //      not sent to clients
  persist: { exclude: ["prevBytes"] }, // not written to disk
  methods: {
    tick(s, bytes: number) {
      s.rxMbps = (bytes - s.prevBytes) / 1e6; // read/write freely, server-side
      s.prevBytes = bytes;
    },
  },
});
```

That's "scratch" state — private, non-broadcast, non-persisted — with no new
concept: it's just a state field on both exclude lists. It stays in the
server-authoritative `getState()` (and `ui.fullState()` in tests), so methods,
effects and server routes use it normally; only the client and the DB never see
it.

## Secret-exposure warnings & `publicFields`

Two tiers, both on a field's **name**, checked at boot when the field is exposed
to the UI (broadcast to every client):

- **Ambiguous secret-ish names WARN** (`enc`/`secret`/`priv`/`key`/`seed`/
  `mnemonic`/`passphrase`/`password`) — a likely leak, but could be legit
  (`seeded`, `encoding`).
- **Unambiguous credentials REFUSE to boot in dev** — `password`, `passphrase`,
  `mnemonic`, and the compound forms `privateKey`/`apiKey`/`secretKey`/
  `accessToken`/`authToken` (and `_`-separated variants). A warning is too soft
  for a broadcast credential; dev fails fast. (In prod it logs a loud error
  rather than crashing a live deployment.)

Either way the fix is the same: **exclude it** (`ui: { exclude: ["password"] }`,
`ui.forUser`, or `ui: "none"`), or if it genuinely is public, **declare it**
(below). Names with a public hint (`pubKey`, `publicKey`) or an identifier
suffix (`seedId`, `apiKeyName`) are ignored, and a field whose secret sub-path
you've **deep-excluded** (`exclude: ["seeds.encSeed"]`) is not flagged — the
correct fix is never penalized.

For a field that genuinely is public but trips the name heuristic, **declare
it** instead of dancing around the regex or using a no-op `forUser`:

```ts
ui: {
  publicFields: ["masterKey", "seeds"];
} // "I know these look secret; they're public"
```

`publicFields` names are validated against the cell's state at creation — a typo
throws, so a misspelled opt-out can't silently fail to opt out.

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
4. If `forUser` throws — or returns something that is not an object — the cell
   is **omitted from that client's state entirely**, and the error is logged
   loudly

`forUser` **cannot** access fields removed by `include`/`exclude` — they're
already stripped.

> **It fails CLOSED.** A filter that throws used to fall back to "the structural
> filter result", which sounds safe and is not: with `ui: { forUser }` alone
> there is no structural filter, so the fallback was the **whole cell**. One
> missing field on a user record — a `TypeError` inside your filter — broadcast
> every row to everyone. Omitting the cell can never expose more than the filter
> would have returned, so that is what happens now; your UI sees the cell as
> absent, which is a visible bug rather than a silent leak.
>
> This also applies to **user-less** channels (UDS, `am state`, amui): a filter
> that requires a user omits the cell there too.

### `forUser` and `sync` cannot both hold

A cell with `sync` (or adopted by `localFirst`) is **refused at boot** if its
`ui` hides anything — `forUser`, `include`, `exclude`, or `"none"`:

```
[orders] sync + a ui filter cannot both hold — CRDT replication sends every op
to every peer, so a per-user view cannot survive it.
```

This is not a missing feature. Convergence requires every replica to see every
op; ops carry no user dimension, and `forUser` is an arbitrary function over
derived state, so "may this user see this op?" is undecidable from it. Filtering
the op stream would swap a silent leak for silent divergence. Choose one: drop
the filter, drop `sync` for that cell (`sync: false`), or split the private
fields into a server-only cell. `localFirst` declines to adopt a filtered cell
automatically and says so, rather than silently replicating it.

> **Typing.** `forUser`'s parameters are fully inferred — `(s, user) => …` just
> works, `s` is your cell's state type. Note the type shows ALL state fields,
> but at runtime `s` only carries what the `include`/`exclude` filter kept.
>
> **Pass it as an inline arrow.** Extracting the filter to a named, pre-typed
> function can collapse the cell's method inference — every method silently
> becomes `(...args: unknown[])`, and the errors surface far from the cause (a
> field report saw 29 unrelated type errors appear in a test file). Keep the
> filter separately testable by calling it from the arrow rather than passing it
> directly:
>
> ```ts
> ui: { forUser: viewFor },                          // ✗ can break inference
> ui: { forUser: (s, u) => viewFor(s, u) },          // ✓ inference intact
> ```

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

Both default to `"all"` but serve different purposes:

- **`persist`**: Controls what's saved to disk (the `aio_kv` snapshot in
  `state.db`). Default-on means restart safety. Opt out per cell for ephemeral
  or sensitive data.
- **`ui`**: Controls what's sent to browser clients. Default-on means
  zero-config client sync. Opt out (or narrow with `include`/`exclude`) for
  fields a client shouldn't see.

They're independent — a cell can persist everything but expose nothing to UI
(background worker), or expose everything but persist nothing (ephemeral UI
state).

## Interaction with Sync

Cells with `sync: true` use the SQLite op-log for their sync-managed fields. The
`persist` config only controls snapshot persistence for non-sync fields. Sync
manages its own persistence separately.
