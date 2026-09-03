# Cell-Level Visibility & Persistence

> Per-tab state that should NOT be shared or persisted belongs in a
> [client-scoped cell](cells.md#shared-vs-per-client-state) (`scope: "client"`)
> or `useLocal`.

Control what state each cell exposes to clients (`visible`) and persists to disk
(`persist`). Default for both: `"all"` — zero-config persists and exposes
everything. Opt out per cell (or via `cellDefaults`) for privacy or size tuning.

> **Renamed in alpha52**: the cell key is `visible:` (READ side; `access:` gates
> CALLS). The old spelling `ui:` keeps working through beta with a one-time boot
> hint, and `aiol --safe-fix` renames it. App-level `aio.run({ ui: {...} })`
> (window config) is a different key and unchanged.

## Quick Start

```ts
// Expose everything, persist everything
await aio.run({
  cells: [counter, auth],
  cellDefaults: { visible: "all", persist: "all" },
});
```

For most apps, `cellDefaults` is all you need. Tighten per-cell when you have
sensitive or large data.

## Filter Options

Both `persist` and `visible` accept the same filter shapes:

| Config                             | Effect                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `"all"`                            | Include everything (default)                                                                       |
| `"none"`                           | Include nothing                                                                                    |
| `{ include: ["a", "b"] }`          | Only these top-level fields                                                                        |
| `{ exclude: ["cache"] }`           | Everything except these                                                                            |
| `{ exclude: ["accounts.secKey"] }` | **Deep**: remove the field everywhere under `accounts` (arrays traversed element-wise)             |
| `{ include: ["accounts.name"] }`   | **Deep**, the same spelling the other way round: keep only that field, everywhere under `accounts` |

A dot path through an ARRAY keeps the array's shape: the client sees a list of
the same length, one entry per row, holding only the included fields (`{}` for a
row that has none of them). An empty list stays an empty list. The length is
what index-addressed deltas resolve against, so a projection that dropped it
would leave the client unable to apply the next patch.

```ts
const trading = cell("trading", {
  state: { orders: [], positions: [], riskModel: {}, cache: {}, accounts: [] },
  methods: {/* ... */},
  persist: { exclude: ["cache", "riskModel"] },
  // secKey never reaches a client — stripped from full-state broadcasts AND
  // from Immer patch payloads (including patches that replace whole rows).
  visible: { include: ["orders", "positions"] }, // or exclude: ["accounts.secKey"]
});
```

`include` is a **top-level allowlist** — dot-paths are exclude-only (a dotted
include warns at boot).

## Resolution Order

Cell-level config wins over `cellDefaults`, which wins over the framework
default (`"all"`):

```
cell.persist > cellDefaults.persist > "all"
cell.visible > cellDefaults.visible > "all"
```

## Private (server-only) fields — scratch state

Need a field that lives in `state` (so methods read/write it) but is **never
broadcast to the browser and never persisted** — a delta-staging sample, a
re-entrancy guard, a cached derivation? Exclude it from **both** filters:

```ts
cell("net", {
  state: { rxMbps: 0, prevBytes: 0 }, // prevBytes = private sample
  visible: { exclude: ["prevBytes"] }, //      not sent to clients
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
server-authoritative `getState()` (and `ui.fullState()` in tests (the testUI
handle)), so methods, effects and server routes use it normally; only the client
and the DB never see it.

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

Either way the fix is the same: **exclude it**
(`visible: { exclude: ["password"] }`, `visible.forUser`, or `visible: "none"`),
or if it genuinely is public, **declare it** (below). Names with a public hint
(`pubKey`, `publicKey`) or an identifier suffix (`seedId`, `apiKeyName`) are
ignored, and a field whose secret sub-path you've **deep-excluded**
(`exclude: ["seeds.encSeed"]`) is not flagged — the correct fix is never
penalized.

For a field that genuinely is public but trips the name heuristic, **declare
it** instead of dancing around the regex or using a no-op `forUser`:

```ts
visible: {
  publicFields: ["masterKey", "seeds"];
} // "I know these look secret; they're public"
```

`publicFields` names are validated against the cell's state at creation — a typo
throws, so a misspelled opt-out can't silently fail to opt out.

## Per-User Filtering (`forUser`)

For multi-user apps where different users see different data:

```ts
type Order = { id: string; userId: string; total: number };

const orders = cell("orders", {
  // Type the array: `items: []` infers `never[]`, and `o.userId` inside the
  // filter below is then a compile error, not a runtime one.
  state: { items: [] as Order[], total: 0 },
  methods: {
    add(s, order: Order) {
      s.items.push(order);
      s.total += order.total;
    },
  },
  visible: {
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
> filter result", which sounds safe and is not: with `visible: { forUser }`
> alone there is no structural filter, so the fallback was the **whole cell**.
> One missing field on a user record — a `TypeError` inside your filter —
> broadcast every row to everyone. Omitting the cell can never expose more than
> the filter would have returned, so that is what happens now; your UI sees the
> cell as absent, which is a visible bug rather than a silent leak.
>
> This also applies to **user-less** channels (UDS, `am state`, amui): a filter
> that requires a user omits the cell there too.

### `forUser` and `sync` cannot both hold

A cell with `sync` (or adopted by `localFirst`) is **refused at boot** if its
`visible` hides anything — `forUser`, `include`, `exclude`, or `"none"`:

```
[orders] sync + a visible filter cannot both hold — CRDT replication sends every op
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
> visible: { forUser: viewFor },                     // ✗ can break inference
> visible: { forUser: (s, u) => viewFor(s, u) },     // ✓ inference intact
> ```

## Broadcast Performance

The framework picks the optimal broadcast strategy per cell automatically:

| Cell UI config                 | Strategy | What's sent                    |
| ------------------------------ | -------- | ------------------------------ |
| `visible: "all"`               | `raw`    | Immer patches (most efficient) |
| `visible: "none"`              | `skip`   | Nothing                        |
| `visible: { include/exclude }` | `filter` | Filtered Immer patches         |
| `visible: { ..., forUser }`    | `full`   | Full filtered state per client |

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
  // visible not set = "none" = invisible to clients
});
```

### Admin-Only Cell

```ts
const admin = cell("admin", {
  state: { users: [], audit: [] },
  methods: {/* ... */},
  persist: { include: ["users", "audit"] },
  visible: {
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
  visible: { include: ["summary"] }, // don't blast rawEvents to clients
});
```

## Persistence vs UI

Both default to `"all"` but serve different purposes:

- **`persist`**: Controls what's saved to disk (the `aio_kv` snapshot in
  `state.db`). Default-on means restart safety. Opt out per cell for ephemeral
  or sensitive data.
- **`visible`**: Controls what's sent to browser clients. Default-on means
  zero-config client sync. Opt out (or narrow with `include`/`exclude`) for
  fields a client shouldn't see.

They're independent — a cell can persist everything but expose nothing to UI
(background worker), or expose everything but persist nothing (ephemeral UI
state).

## Reading a hidden field on the client — throws, everywhere

A field hidden by `visible` is enforced at the **client read seam**, not only at
broadcast time: a component (browser, Electron, `testUI`), a selector, or the
client-side replay of a sync method that reads `cell.secret` **throws** — in dev
and in prod alike — naming the field, the cell, and the two fixes. It used to
return `undefined` with one warning in prod, and a warning does not stop the
read from type-checking as the field's declared type: a lock screen in a field
report asked "does a vault exist?", got `undefined` forever, and behaved. A
hidden field is never readable there, so any such read is a bug, and a bug that
yields a plausible value is worse than one that stops the page.

`visible: { exclude }` is doing its job. Either publish the non-secret **fact**
beside the secret (`hasVault: boolean`) and read that, or read the secret in a
server-side/async method (routes, effects, methods) — see
[cell contexts](cell-contexts.md).

**`aiol` names the read before anything runs.** Three shapes are decidable from
the source, and each is a lint error with `file:line` and the same two fixes: a
read in a `.tsx` file (client context by construction), a selector on any cell
(selectors run client-side), and a sync method of a `sync`/`localFirst`/
`scope: "client"` cell (its reducer replays in the browser). The runtime
tripwire stays the guarantee — it catches the reads no static rule can see, such
as one through a dynamically chosen key.

There is deliberately no _type-level_ version. `cell()` returns one type, and a
component body and an async method read it through the same binding — so
`Omit`ting the excluded keys would refuse every legitimate server-side read as
well. The context lives in the filename and in the cell config, which is where
the rules look; `am where <file>` answers the general question.

## Interaction with Sync

Cells with `sync: true` are excluded from the `aio_kv` snapshot: their durable
home is the SQLite op-log plus a compaction snapshot. A `persist` filter on such
a cell is **refused at `cell()`** (and a `cellDefaults.persist` filter that
would land on one is refused at `aio.run()`): an op is the method call's
payload, written raw, so no filter can apply to it, and `persist: "none"` would
restore an empty cell. The error names the cell, the fields and the ways out —
remove the filter, turn sync off, or keep the transient data in a separate
non-sync cell. Shape changes on a sync cell need `version` + `onMigrate` — see
[CRDT sync → Persistence](../persistence/crdt.md#persistence).
