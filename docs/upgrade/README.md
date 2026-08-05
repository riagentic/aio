# Upgrade Guides

One guide per version migration. Find your current version and follow the steps.

## restructure (alpha27+)

- **[The aio restructure (alpha27+)](restructure.md)** — every restructure
  breaking change with before → after recipes (methods-only cells, instances,
  SQLite-only persistence, `aio/extras`, wire catalog)
- [alpha47 → alpha48](from-alpha47-to-alpha48.md) — the third hunt: a skewed
  clock cut a client off from every update, a rejected call was delivered
  anyway, async writes were missing from every observability sink, and the
  durable offline queue was never wired
- [alpha46 → alpha47](from-alpha46-to-alpha47.md) — the second hunt: a build
  that deleted your sources and reported success, four renderer defects that
  committed the wrong DOM in silence, a freshness cache that guessed at its
  inputs, and a binary that took its identity from the launch directory
- [alpha45 → alpha46](from-alpha45-to-alpha46.md) — the hunt: 27 defects, most
  silent — a flagship example that never booted, `ui.forUser` failing open, an
  unauthenticated control plane, migrations that deleted the data they failed to
  migrate, and `am`'s new owner-only credential
- [alpha44 → alpha45](from-alpha44-to-alpha45.md) — the network boundary: a
  per-user filter that really filters, a CLI call that tells you what happened,
  `--expose` certs the aio client can verify, `serveDirs`, `expose` in config,
  per-target build entry, and every app loses its white border
- [alpha43 → alpha44](from-alpha43-to-alpha44.md) — what you see is what you
  ship: one app-dir decider on every target, shutdown lets an in-flight method
  finish writing, the build cache works (and stamps per target), `client.log`
  rotates, `useInterval`/`useRaf` `active` is live, per-method perf budgets,
  `skipIfRunning`
- [alpha42 → alpha43](from-alpha42-to-alpha43.md) — silence into signal:
  boot-time database integrity + snapshots, sync ops that can no longer be acked
  without being applied, persistence that refuses to corrupt a `Date`,
  cross-platform builds, and a stricter test harness
- [alpha41 → alpha42](from-alpha41-to-alpha42.md) — the pin is the promise:
  `am fix` records `aioVersion` for unpinned apps, the one-liner builds with the
  aio the app pins, removal errors name the version that still ran the old
  spelling
- [alpha40 → alpha41](from-alpha40-to-alpha41.md) — catching up: appDir/
  renderBudget honored, proxy spread-back works, extras relics + flow residue
  removed, am identity checks, one-line `run.sh`
- [alpha39 → alpha40](from-alpha39-to-alpha40.md) — silence is the bug: a
  transactional lost update is now refused (`conflict`, `s.$live`), a hidden
  field read from the client throws in dev, the dev browser is dev-strict, one
  timeout for `await cell.method()`, plus `localFirst: true` and `degraded()`
- [alpha38 → alpha39](from-alpha38-to-alpha39.md) — pin it, price it, redact it:
  `journalRedact` → `redactActions` (and it now covers the timeline and action
  log too), `am pin` for per-app framework versions, `am cost` for what your app
  actually moves
- [alpha37 → alpha38](from-alpha37-to-alpha38.md) — one directory: everything an
  app writes moves to `~/.<appId>/`, migrated automatically on first boot;
  `am data` / `am backup` / `am restore`
- [alpha36 → alpha37](from-alpha36-to-alpha37.md) — say it at boot: a worker
  cell's peer read is reported by `aio doctor` with file:line instead of only
  throwing when it runs; one fewer false alarm from the boot linter
- [alpha35 → alpha36](from-alpha35-to-alpha36.md) — a thread of its own: cell
  workers (`worker: true`), interactive-priority broadcasts, a one-frame dev
  reduce budget, `aiol --safe-fix` upgrade rewrites, cell-edit dev restart; all
  additive, no code changes required
- [alpha34 → alpha35](from-alpha34-to-alpha35.md) — the edges: `route()`
  (params, method guard, cookies, JSON), ambient `serverRequest()`, row-level
  `access`, UI kit + safe `<Markdown/>`, `testServer`/`testBrowser`/`freePort`;
  all additive, no code changes required
- [alpha33 → alpha34](from-alpha33-to-alpha34.md) — the dream list: return
  values cross the bridge, transactional methods, durable journal + time travel
  (`am timeline`/`replay`/`record`), migration shape-drift + `am migrations`,
  reactive SQL, transport cassettes, `aio ship`; all opt-in/additive
- [alpha32 → alpha33](from-alpha32-to-alpha33.md) — `deno task build` (fleet
  builds), amui levelled up; portable binaries, embedded `.wasm`, a working
  systemd unit, sync-compaction + `db:`-table data-loss fixes
- [alpha31 → alpha32](from-alpha31-to-alpha32.md) — aui (visual app manager);
  transparent fixes: persist KV-limit removed, clean shutdown teardown, electron
  crash guard
- [alpha30 → alpha31](from-alpha30-to-alpha31.md) — sanity & cleanup: auth
  hardening, parameter consistency, persistence fix
- [alpha29 → alpha30](from-alpha29-to-alpha30.md) — built-in auth (opt-in),
  snapshot/trojan hardening
- [alpha28 → alpha29](from-alpha28-to-alpha29.md) — wire protocol v2
- [alpha27 → alpha28](from-alpha27-to-alpha28.md)
- [alpha26 → alpha27](from-alpha26-to-alpha27.md)

## v1.0.0-alpha

- [alpha17 → alpha18](from-alpha17-to-alpha18.md)
- [alpha13 → alpha14](from-alpha13-to-alpha14.md)
- [alpha12 → alpha13](from-alpha12-to-alpha13.md)
- [alpha11 → alpha12](from-alpha11-to-alpha12.md)
- [alpha10 → alpha11](from-alpha10-to-alpha11.md)
- [alpha9 → alpha10](from-alpha9-to-alpha10.md)
- [alpha8 → alpha9](from-alpha8-to-alpha9.md)
- [alpha7 → alpha8](from-alpha7-to-alpha8.md)
- [alpha6 → alpha7](from-alpha6-to-alpha7.md)
- [alpha5 → alpha6](from-alpha5-to-alpha6.md)
- [alpha4 → alpha5](from-alpha4-to-alpha5.md)
- [alpha3 → alpha4](from-alpha3-to-alpha4.md)
- [alpha2 → alpha3](from-alpha2-to-alpha3.md)
- [alpha1 → alpha2](from-alpha1-to-alpha2.md)

## v0.x → v1.0

- [v0.9 → v1.0.0-alpha](from-v0.9-to-v1.0.0-alpha.md)

## v0.x

- [v0.8 → v0.9](from-v0.8-to-v0.9.md)
- [v0.7 → v0.8](from-v0.7-to-v0.8.md)
- [v0.6 → v0.7](from-v0.6-to-v0.7.md)
- [v0.5 → v0.6](from-v0.5-to-v0.6.md)
- [v0.4 → v0.5](from-v0.4-to-v0.5.md)
- [v0.3 → v0.4](from-v0.3-to-v0.4.md)
- [v0.2 → v0.3](from-v0.2-to-v0.3.md)
- [v0.1 → v0.2](from-v0.1-to-v0.2.md)
