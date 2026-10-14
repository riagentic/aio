# Runtime differences

The same cell code runs in three places. Most behaviour is identical — these are
the differences that have bitten real apps.

| Concern                        | Server (Deno, `aio.run`)                                                         | Browser client                                | Standalone (testUI / electron / android)      |
| ------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| Read cell state                | the bound cell object reads LIVE state (`app.getState()` equivalent)             | the cell object is reactive (`counter.count`) | the cell object is reactive                   |
| `ui.exclude`                   | server code sees everything (routes, effects)                                    | hidden — never broadcast                      | hidden — reads `undefined` + one-time warning |
| Persistence                    | SQLite (aio_kv snapshot + tables + sync op-log)                                  | server-driven (patches)                       | `localStorage` (`persist`)                    |
| Sync cells restore             | op-log replayed at boot (headless)                                               | on (re)connect                                | via bundled server                            |
| cell `onMigrate` / `onRestore` | run after the snapshot restore                                                   | n/a                                           | the same — same code, same `version` stamp    |
| app `onRestore` / `onStart`    | `onStart` runs **after** cell methods are bound — safe to seed via a cell method | n/a                                           | NOT run in a packaged APK (see below)         |
| `aio.run({...})` options       | all applied                                                                      | served by the server that ran them            | packaged APK / web: the data ones, baked in   |

## A packaged APK never runs `app.ts`

A local APK (`--android`, no `--remote`) and a `web` build bundle `App.tsx` and
what it imports — the bundle entry never imports the app's entry module. So the
**build** runs the entry once, far enough to read what it passes to
`aio.run({...})` (the call itself is intercepted: no server starts, nothing is
written), and bakes in the options that are plain data:

- `ui.theme`, `ui.layout`, `ui.lang`, `ui.dir`, `ui.head`, `ui.viewport` — into
  the packaged page, through the same head builder every other target uses;
- `persist`, `persistDebounceMs`, `cellDefaults.persist`, `circuitBreaker`,
  `refusalsReject`, `perfBudget`, `effectTimeoutMs` — handed to the runtime's
  boot.

The build prints the list (`✓ aio.run() options baked in: …`) and warns, by
name, about each option your entry sets that **cannot** travel:

- the hooks (`onStart`, `onStop`, `onError`, `onAction`, app-level `onRestore`,
  …) and any function inside an option (`cellDefaults.visible.forUser`) — they
  are server code. Seed and repair in the cell's own `onInit` / `onRestore`;
- `cellDefaults.visible` — no APK or web build ever applied it, and there a
  `visible` filter is enforced on the UI's own reads, so applying it now would
  blank state a shipped app shows. A cell's own `visible` applies, as it always
  did: set it there;
- `localFirst` (there is no server to sync with), `ui.showStatus`, `cells` (the
  APK holds the cells `App.tsx` imports) and everything server-only (`port`,
  `routes`, `auth`, …).

**How the build reads it.** The entry's top-level code runs once, in a separate
process that may only read — files, the environment, system facts. It has no
write, network, subprocess or native-library permission, so an entry that opens
a database, writes a file or calls out before `aio.run()` fails there instead of
doing it during a build. Nothing the entry prints reaches the build output, and
no file is written into the app. The process has `AIO_BUILD_PROBE=1` set, so an
entry can tell (`if (!Deno.env.get("AIO_BUILD_PROBE")) await warmCache()`).
Options computed from the environment are baked with the **build** machine's
values — a phone has no environment to read.

When the entry cannot be read this way (it throws, needs a permission, exits, or
does not reach `aio.run()` within a minute), the build does not fail: nothing is
baked, the result is what every build before 1.0.20 produced, and the warning
says why in one line and lists every option the source sets.

**An installed app keeps its saved state.** Every APK and web build before
1.0.20 saved every cell, whatever the entry said. So `persist: false` and
`cellDefaults.persist` — the two baked options that _narrow_ what is saved — are
applied only where they discard nothing: on an install whose store holds nothing
they would drop (a new install). An install that already holds such state keeps
it, keeps saving it, and says so once in the console (logcat on a phone). To
drop stored state for good, set `persist` on the cell itself — that was honoured
before and still scrubs the stored slice.

Or build `--android --remote`: that APK is a client of the server that runs
`app.ts`, so every option applies.

## A worker's own worker in a standalone APK

A browser `Worker` started by the page is the same everywhere. One started **by
a worker** is not, in a standalone APK: Android's WebView (133 and later)
fetches that script past the only thing that serves an APK's packaged files, so
it never loads. The build therefore makes each bundled worker in an APK start
its workers from a same-origin Blob that loads the real script (on every WebView
version — one path, not two).

| In a worker's worker     | Server-backed page, `web`, Electron | Standalone APK                       |
| ------------------------ | ----------------------------------- | ------------------------------------ |
| `import.meta.url`        | the worker's file                   | the worker's file                    |
| `self.location`          | the worker's file                   | a `blob:` URL                        |
| `fetch("x.json")`        | relative to the worker's file       | rejects — nothing to resolve against |
| a `blob:`/`data:` worker | as written                          | as written                           |

Write `new URL("x.json", import.meta.url)` and the code is the same on every
target. A worker file aio did not bundle (one started by plain path from an
`assets` mount) cannot start a worker of its own on that WebView — start it from
the page or from a bundled worker. A client APK (`--remote`) is a page of its
server: none of this applies. See
[Browser workers](../debugging/performance.md#browser-workers).

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
- **Standalone:** a packaged APK runs `App.tsx` and the cells it imports — never
  `app.ts` — so no hook passed to `aio.run({...})` reaches it (`onStart`, the
  app-level `onRestore`). Seed in a cell's `onInit`, and repair restored state
  in the cell's own `onRestore`: both run on every runtime, after the store
  restore and any `onMigrate`.
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
