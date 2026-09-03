# Upgrading from alpha67 to alpha68

Nothing in your app code changes. If you run a `sync: true` cell, upgrade —
alpha66 and alpha67 quarantined (prod) or refused (dev) any sync cell that
restarted with uncompacted ops in its log; alpha68 fixes it, and the proof is
`tests/sync-migration-e2e.test.ts`, described line by line in
[crdt.md](../persistence/crdt.md#shape-changes-version--onmigrate).

## What to do

- **Sync cells**: declare `version: 1` (and `onMigrate` before you change the
  shape). An unversioned log warns at boot; a shape change without a hook
  refuses in dev and quarantines in prod — never applies blind.
- **Path pins**: `am pin /path` now writes `.aio/pin.local` (git-ignored). A
  `path:` value still in `deno.json` keeps working and warns once — run
  `am pin <path>` again to move it.
- **Screenshots**: start with `--cdp` (or `AIO_CDP=1` for `am start`), then
  `am shot out.png`. Opt-in; without it there is still no TCP port.

## Retire

| workaround you may have                                                   | fixed in    | what to do now                                                          |
| ------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| `sync: false` on a cell you turned off after a shape-change incident      | **alpha68** | turn it back on with `version` + `onMigrate`; the e2e test is the guard |
| A renamed fixture method to get past `am pin`'s removed-API scan          | **alpha68** | rename it back — strings, templates and comments are no longer scanned  |
| A committed `aioVersion: "path:…"` and a note telling clones to ignore it | **alpha68** | `am pin <path>` moves it to `.aio/pin.local`                            |
| Your own astral/CDP screenshot harness for "looks right"                  | **alpha68** | `--cdp` + `am shot` (keep yours for custom camera poses)                |

## Configuration is now as strict as `cell()`

`cell()` has refused an unknown key with a did-you-mean since alpha52. The CLI
and `aio.run()` warned-and-booted for the same class of mistake, so `--experse`
bound loopback while its author believed the app was on the LAN, and
`--width=1200px` produced no message at all and an 800px window. Both now
refuse, naming the value and the accepted form.

- **Unknown flags are refused.** If your app takes its own arguments, put them
  after a bare `--`: `myapp --verbose -- --my-flag=1`. aio stops parsing there.
- **Unusable flag values are refused** — `--port=abc`, `--client=Electron`,
  `--transport=tcp`, `--width=1200px`, `--host=` — instead of silently falling
  back to the default.
- **Enumerated config VALUES are checked.** `ENUM_VALUES` covered only `chrome`
  and `theme`; it now covers `client`, `transport`, `persistMode` and
  `perfCheck` too, so `client: "Electron"` is a boot error with a suggestion
  rather than a browser app nobody asked for.

## Config combinations that used to fail silently

Fourteen pairs of individually-valid keys contradicted each other and said
nothing. Each is now reported at boot, in one format (cause, then fix). The two
that cost data are refusals:

| combination                                                         | was                                                                              | now                                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `auth: { requireVerified: true }` with no `sendMail`                | signup answered `verificationSent: true` having sent nothing; login 403s forever | refused (and a **type error** — `requireVerified: true` now requires `sendMail`) |
| `journal: true` with `persist: false` / `dbPath: ":memory:"`        | journal resolved to `null`; no crash recovery, no message                        | refused (config **and** `--no-persist` / `--db-path=`)                           |
| `cellDefaults.visible`/`persist` with `include` **and** `exclude`   | `include` won, `exclude` was discarded                                           | refused                                                                          |
| `long` method + `perfBudget.methods["cell:method"].timeout`         | the timeout won; `long` did nothing                                              | refused                                                                          |
| `killExisting` with `singleton: false` / `libraryMode: true`        | no lock is taken, so nothing is killed                                           | refused                                                                          |
| `singleton: true` with `libraryMode: true`                          | libraryMode won                                                                  | refused                                                                          |
| `transport: "uds"` with a non-Electron `client`, or `expose`        | honoured as written; nothing could connect                                       | refused                                                                          |
| `serverUrl` with `client` other than `"electron"`                   | Electron launched anyway, then exited                                            | refused                                                                          |
| `sessions.ttlMs` **and** `auth.ttlMs`                               | the store used one, every login used the other                                   | refused                                                                          |
| `updates: { check: false, auto: true }`                             | nothing polls, so nothing auto-installs                                          | warned                                                                           |
| `ui.width`/`height` with `client: "cli"`/`"server-only"`            | read, then never used                                                            | warned                                                                           |
| git `updates.source` with `key`/`keys`/`allowUnsigned`/`prerelease` | read by nothing on the git path                                                  | warned                                                                           |

## Other changes

- **`deno.json` `build: {}` is typo-gated.** `build: { target: [...] }`
  (singular) built the default target set and said nothing; `deno task lint:aio`
  now names it with a did-you-mean, one level into object-form `targets` too.
- **`authClient` errors carry a sentence.** `Error.message` was the raw server
  code (`invalid_credentials`, `password_too_short`), so an app doing
  `catch (e) => setError(e.message)` showed its users snake_case. The message is
  now readable text and the code moved to `.code` — branch on that.
- **Three alias tasks are gone**: `deno task docs` → `update:api-ref`,
  `validate:matrix` → `check:matrix`, `discover` → `deno task am discover`. All
  three were announced in alpha64.
- **`teachMessage()` no longer prefixes `[aio]`.** Its output goes to
  `log.warn`/`log.error`, which already print the category they inferred from
  the call site — the prefix made every such line say the same thing twice.
  `teachableError()` still prefixes, because a thrown Error has no category
  column. Both are now exported from `aio/extras` so an app's own boot checks
  can speak the same format.
- **`AioError` carries its own remedy.** The 21 tips in `generateTip()` rendered
  only inside the dev error box, so `String(err)` in a terminal showed none of
  them. `err.tip` exposes the fix, `String(err)` appends it, and the prod
  compact line carries it too.
