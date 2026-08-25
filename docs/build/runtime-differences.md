# Runtime differences

The same cell code runs in three places. Most behaviour is identical — these are
the differences that have bitten real apps.

| Concern            | Server (Deno, `aio.run`)                                               | Browser client                                | Standalone (testUI / electron / android)      |
| ------------------ | ---------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| Read cell state    | the bound cell object reads LIVE state (`app.getState()` equivalent)   | the cell object is reactive (`counter.count`) | the cell object is reactive                   |
| `ui.exclude`       | server code sees everything (routes, effects)                          | hidden — never broadcast                      | hidden — reads `undefined` + one-time warning |
| Persistence        | SQLite (aio_kv snapshot + tables + sync op-log)                        | server-driven (patches)                       | `localStorage` (`persist`)                    |
| Sync cells restore | op-log replayed at boot (headless)                                     | on (re)connect                                | via bundled server                            |
| `onRestore`        | runs after snapshot restore                                            | n/a                                           | n/a (use `onStart` seeding)                   |
| `onStart`          | runs **after** cell methods are bound — safe to seed via a cell method | n/a                                           | runs after bind                               |

## Reading state in a server route

A bound cell object reads LIVE state everywhere — a custom route can read
`members.roster` directly and gets the current dispatched value
(`tests/server-cell-reads.test.ts` pins this). `app.getState()` remains
equivalent and fine. Only an UNBOUND cell (before `aio.run`) reads its declared
initial state.

## `ui.exclude` is enforced at every client read seam

`ui.exclude` hides fields from CLIENT code everywhere — including standalone
(testUI / electron / android), where there is no broadcast: a client-context
read of an excluded field returns `undefined` and logs a one-time warning naming
the field. Selectors compute over the filtered slice too, so a computed read
can't leak an excluded value. Server code (routes, effects) always sees
everything. Keep true secrets out of cell state entirely when possible;
`ui.exclude` now behaves like the access boundary it looks like.

## Seeding across runtimes

- **Server:** seed in `onStart` (fires after the cell method surface is bound,
  so `members.seed()` works) or in `onRestore` (mutate the restored state
  directly).
- **Standalone:** `onRestore` does not run; seed in `onStart`.
- Idempotent seeding (check-then-write) is safest — `onStart` runs every boot.
- **Import the cell _inside_ `onStart`** when the entry file itself calls a
  method:
  `onStart: async () => { const { files } = await import("./cell.ts");
  await files.open(); }`.
  A static import at the top of the entry does not guarantee the cell is
  registered before `aio.run` reads the config (a field report found this by
  trial); the dynamic import inside the hook always runs after binding.

## See also

- [How persistence works](../persistence/how-it-works.md) — boot/restore order,
  sync op-log replay, dictionary merge.
- [App manager](../clients/app-manager.md) — `am surface`/`am trigger`, the one
  UI facility shared with `testUI`.
