# Upgrade: 1.0.0-alpha33 → 1.0.0-alpha34

The dream-list release — a large batch of new capabilities, all opt-in or purely
additive. **Most apps upgrade with no code changes.** No public API was removed;
the wire protocol is unchanged (alpha33 and alpha34 interoperate). The changes
worth adopting deliberately are the opt-in flags below.

## Return values now cross the client↔server bridge

`await cell.method()` in a browser (or Electron/CLI client) now resolves with
the method's **actual return value** — previously it resolved `undefined` across
the network. Sync and async methods both work; an async method settles on
completion.

```ts
// cells.ts (server)
methods: {
  addItem(s, item): string { const id = crypto.randomUUID(); s.items.push({ ...item, id }); return id },
}
// a browser component
const id = await cart.addItem({ name: "Book" }) // ← now the real id, not undefined
```

Only JSON-serializable returns cross the wire; a non-serializable one (function,
class instance, `BigInt`, cyclic) resolves `undefined` with a loud dev warning.
See [state/the-bridge](../state/the-bridge.md). **If you built a
state-projection workaround because returns didn't cross, you can now retire
it** — but nothing breaks if you don't.

## New opt-in flags (all default-off, inert when unused)

```ts
cell("cart", {
  state: { items: [] },
  transaction: true, // reads see a stable snapshot across awaits; writes commit atomically at return
  version: 2, // + onMigrate(state, from) — migrate persisted shape on boot
  methods: {/* … */},
});

await aio.run({ cells: [cart], journal: true }); // durable action journal — SIGKILL/power-cut recovery
```

- **`transaction: true`** — a method body is a transaction (stable reads, atomic
  commit, `s.$commit()` for mid-flight publish). Recommended on hot read-modify-
  write cells. See
  [state/transactional-methods](../state/transactional-methods.md).
- **`journal: true`** — a durable action journal replays the un-persisted tail
  at boot. Power-outage recovery.
- **`version` + `onMigrate`** — already existed; alpha34 adds a **downgrade
  guard** and **shape-drift** detection (a stored field your `initialState` no
  longer declares is flagged at boot and via `am migrations`). Dynamic-key maps
  declared as an empty object (`{} as Record<K,V>`) are treated as open records
  and never false-flagged.

## New CLI commands (`am`)

```sh
deno task am timeline          # recent dispatches + payload + state diff
deno task am replay 5..12      # deterministically re-dispatch a journal range (repro)
deno task am record flow.test.ts --from=data.db.journal   # journal → bootCells test
deno task am migrations        # cell versions (declared vs stored) + shape drift
deno task am expect counter.n eq 2   # assert over live state (e2e)
deno task am top               # live runtime observability
```

## New tasks & tooling

- `deno task test:e2e` — the blessed real-client e2e path.
- `aio ship` — reproducible signed single-binary build + a least-privilege
  capability manifest generated from what your cells declare (USB / net / fs),
  instead of running with `-A`.
- `aio doctor` now also runs the client/server boundary lint (a server-only
  import — `@std/`, `node:`, `aio/server`, `Deno.*` — reaching a browser-bundle
  module), so the pre-flight command catches it, not just `deno task lint`.

## Recommended after upgrading

1. Adopt `transaction: true` on read-modify-write cells and `journal: true` if
   durability matters.
2. If you kept a workaround for returns not crossing the bridge, remove it.
3. Run `deno task am migrations` once to check for shape drift on persisted
   cells.

Nothing here is required — alpha34 runs existing alpha33 apps unchanged.
