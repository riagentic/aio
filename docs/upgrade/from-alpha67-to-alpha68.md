# Upgrading from alpha67 to alpha68

Nothing in your app code changes. If you run a `sync: true` cell, upgrade —
alpha66 and alpha67 quarantined (prod) or refused (dev) any sync cell that
restarted with uncompacted ops in its log; alpha68 fixes it, and the proof is
`tests/sync-migration-e2e.test.ts`, described line by line in
[crdt.md](../persistence/crdt.md#shape-changes).

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
