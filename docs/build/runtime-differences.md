# Runtime differences

The same cell code runs in three places. Most behaviour is identical — these are
the differences that have bitten real apps. When in doubt, prefer the pattern in
the **Server** column for server code and treat `ui.exclude` as a broadcast
filter, not access control.

| Concern            | Server (Deno, `aio.run`)                                                                                      | Browser client                                | Standalone (testUI / electron / android)                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| Read cell state    | **In a route: `app.getState().<cell>`** — the cell _object_ reads its initial slice on the server (see below) | the cell object is reactive (`counter.count`) | the cell object is reactive                                               |
| `ui.exclude`       | filters fields OUT of the client broadcast                                                                    | never sees excluded fields                    | **excluded fields ARE readable locally** — there's no broadcast to filter |
| Persistence        | SQLite (aio_kv snapshot + tables + sync op-log)                                                               | server-driven (patches)                       | `localStorage` (`persist`)                                                |
| Sync cells restore | op-log replayed at boot (headless)                                                                            | on (re)connect                                | via bundled server                                                        |
| `onRestore`        | runs after snapshot restore                                                                                   | n/a                                           | n/a (use `onStart` seeding)                                               |
| `onStart`          | runs **after** cell methods are bound — safe to seed via a cell method                                        | n/a                                           | runs after bind                                                           |

## Reading state in a server route → use `app.getState()`

The reactive cell object (`members.roster`) is a **browser/standalone**
convenience. On the server, a custom route that reads the cell object directly
gets the cell's **initial** slice, not the live dispatched state — a silent
staleness trap. Read the composed live state instead:

```ts
const app = await aio.run({
  cells: [members],
  routes: {
    "/api/login": (req) => {
      const { roster, pins } = app.getState().members; // ✅ live state
      // const { roster } = members;                    // ❌ initial slice only
      // …
    },
  },
});
```

## `ui.exclude` is a broadcast filter, not access control

`ui.exclude` keeps fields out of the **server→client broadcast**. It is a
visibility filter for networked clients — not a local access guard. In
standalone (testUI / electron / android) the client and state live in one
process with no broadcast, so excluded fields (e.g. `pins`) are readable on the
cell object. Keep true secrets server-side (a `sync:false`/server-only cell, or
never in cell state at all); don't rely on `ui.exclude` to hide them from local
client code.

## Seeding across runtimes

- **Server:** seed in `onStart` (fires after the cell method surface is bound,
  so `members.seed()` works) or in `onRestore` (mutate the restored state
  directly).
- **Standalone:** `onRestore` does not run; seed in `onStart`.
- Idempotent seeding (check-then-write) is safest — `onStart` runs every boot.

## See also

- [How persistence works](../persistence/how-it-works.md) — boot/restore order,
  sync op-log replay, dictionary merge.
- [App manager](../clients/app-manager.md) — `am surface`/`am trigger`, the one
  UI facility shared with `testUI`.
