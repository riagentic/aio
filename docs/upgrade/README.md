# Upgrade Guides

One guide per version migration. Find your current version and follow the steps.

From alpha65 on, every guide ends with a **`## Retire`** section: the
workarounds an app may still carry for bugs that are now fixed, each with the
version that fixed it — so "nothing told us we could delete it" stops being a
reason to keep one (gated by `deno task check:docs`).

## restructure (alpha27+)

- **[The aio restructure (alpha27+)](restructure.md)** — every restructure
  breaking change with before → after recipes (methods-only cells, instances,
  SQLite-only persistence, `aio/extras`, wire catalog)
- [alpha71 → alpha72](from-alpha71-to-alpha72.md) — nothing breaks: the wire is
  compressed and revalidates (162 KB → 56 KB, then 304), security headers are
  derived from `allowedOrigins`, `plugins: []`, a `text` merge that keeps both
  edits, ten more `aio/ui` controls plus RTL — and an app that will not stop is
  stopped anyway, including a signal that arrives mid-boot.
- [alpha70 → alpha71](from-alpha70-to-alpha71.md) — nothing breaks: every
  artifact says which build it is (`1.2.<commit count>`, derived) and the
  installed file keeps the app's own name under `versions/<version>/`; a
  CommonJS dependency no longer fails a bundle that works; dev evaluates the
  prod client graph; a packaged renderer's errors reach the log.
- **[alpha69 → alpha70](from-alpha69-to-alpha70.md) — THE last compat break:**
  every alpha52-era alias and duplicate import path retired (`aiol --safe-fix`
  rewrites them all), `memory.gcStressRatio` removed, shape drift refuses in
  dev, sanitizers on in every test; plus `aio/cli`, `ios-client`, the router on
  android, `aio.stop()/restart()`, `retireData`, a workspace `share`, and
  O(change) persist windows.
- [alpha68 → alpha69](from-alpha68-to-alpha69.md) — no app-code break, but
  **five stricter security defaults** a reverse-proxied or `host: "0.0.0.0"`
  deployment must read; publishing becomes one command (`deno task publish`), a
  compiled binary's self-update is proven end to end in CI, a `<Markdown>` XSS
  bypass is closed, and three behaviours are corrected to match what their docs
  already said (`resource().value`, `<Link>`, hydration warnings).
- [alpha67 → alpha68](from-alpha67-to-alpha68.md) — nothing breaks; two released
  sync-replay bugs fixed by the new end-to-end migration proof, `am pin` scan
  tokenized, per-machine path pins, `am instances` aio column, `am shot`.
- [alpha66 → alpha67](from-alpha66-to-alpha67.md) — nothing breaks in your app
  code; Windows only: a local Electron app runs on a named pipe with no TCP port
  (`--port=N` opts out). Proven under Wine; real-Windows pass pending.
- [alpha65 → alpha66](from-alpha65-to-alpha66.md) — **three breaks**: a local
  Electron app binds no TCP port by default (`--port=N` opts out), hidden-field
  reads throw in prod too, `sync` + a `persist` filter is refused. Routes are
  served through `aio://`, sync cells carry a `version`, the lock follows the
  home. Retire: the op-log guard test, the no-I/O scanner, the graph/boot-smoke
  tests, the `__aio.methods` guard.
- [alpha64 → alpha65](from-alpha64-to-alpha65.md) — nothing breaks in your app
  code: aio stops opening your browser (it prints the URL; `--open` opts in), an
  Electron app never silently becomes a browser tab, `am` refuses instead of
  guessing port 8000, and an exposed app's certificate re-issues itself when the
  machine changes network. New: `AIO_PORT`, `am trust`, `--zero-port`. First
  guide with a `## Retire` list (bridge returns, worker returns, static
  subtrees, UDS throttle).
- [alpha63 → alpha64](from-alpha63-to-alpha64.md) — nothing breaks in your app
  code: `am` learned that a repo can hold several apps (`am start` means the
  project, `am start <label>` means one of it), `ui.theme: "none"` now really
  emits nothing, and `renderBudget` says at boot that it is not honoured yet.
- [alpha62 → alpha63](from-alpha62-to-alpha63.md) — nothing breaks: aio's
  default look is now opt-in (`ui.theme: "auto"`), so an app that never asked
  for it renders exactly as it would without a framework; `ui.theme: "full"`
  boots instead of exiting; two android-bundle fixes (`log` is exported, a
  module-level `new URL` no longer kills the bundle).
- [alpha61 → alpha62](from-alpha61-to-alpha62.md) — nothing breaks in your code:
  the default theme steps aside for your own stylesheet, a standalone Android
  build that cannot work is refused instead of shipped, and two new boot lines
  tell you which aio you are actually running.
- [alpha60 → alpha61](from-alpha60-to-alpha61.md) — nothing breaks: apps get a
  default theme + icon (`ui.theme: "none"` opts out), writes through
  `map()`/`filter()` results in async methods now land like their sync twins,
  three new aiol rules, a browser-bundle leak gate, and `am kill --stale` /
  `am dispatch --as-server`.
- [alpha59 → alpha60](from-alpha59-to-alpha60.md) — one grammar: the framework's
  gate tasks read verb-first (`check:api`, `update:docs`, `check:release`), a
  new `deno task install:android` puts a built APK on a connected phone, and
  `am` says what it does (`am upgrade` for both am and an app, `am open`,
  `am errors` finally showing runtime errors, four commands added to help).
  Every old spelling still works
- [alpha58 → alpha59](from-alpha58-to-alpha59.md) — every framework log line
  carries info/warn/error on the matching console channel (capture more than
  `console.log` if you assert on output); the one-liner INSTALLS into
  `~/app/<name>/` with `am installed` / `remove` / `upgrade`; a compiled binary
  no longer takes its identity from its file name — rebuild if you ever renamed
  one
- [alpha57 → alpha58](from-alpha57-to-alpha58.md) — logs are kept on restart
  instead of wiped (`.1`, `.2`, … bounded by `backupKeep` and the new
  `logBudget`); `stdout.log` rotates with them
- [alpha56 → alpha57](from-alpha56-to-alpha57.md) — `transaction` is opt-in
  again (add the line if you want it); module-level `signal()`s reset between
  tests, and `present`/`absent` answer about the element first
- [alpha55 → alpha56](from-alpha55-to-alpha56.md) — the empty desk: a 42-finding
  audit closed to zero (fixed or refused with reasons). Nothing to migrate; two
  things you might NOTICE — a route pattern with a non-trailing `*` is refused
  at boot (it was silently over-matching), and an OIDC token must name a `kid`
  that exists (a single published key no longer verifies anything). Shared-key
  apps now work in a browser
- [alpha54 → alpha55](from-alpha54-to-alpha55.md) — the memory a machine
  actually has: the heap ceiling scales with physical RAM (25%, floor 4 GB)
  instead of V8's flat ~4 GB, so an app stops dying with memory to spare;
  `memory.maxHeap` overrides it; the monitor separates pressure from
  machine-share from a leak. Nothing to migrate — rebuild to bake the new
  ceiling into a compiled artifact
- [alpha53 → alpha54](from-alpha53-to-alpha54.md) — the last mile: opt-in app
  updates (`updates: "<url>"`) with a signed data contract that never offers a
  release which cannot migrate your data, problem reports (`feedback: true`),
  `aio ship github`, and `aio/ship` as a published entry. Breaking only for
  anyone who already published `ship` manifests: v1 manifests signed the binary
  digest but not the channel, so they are refused and must be re-published
- [alpha52 → alpha53](from-alpha52-to-alpha53.md) — one address, one manager:
  `am ui` opens amui (the projection moved to `am state --ui`), `--host=`/
  `host:` binds one interface with a single bind-address decider
- [alpha51 → alpha52](from-alpha51-to-alpha52.md) — the last-call release: every
  approved break in one version, each with a working deprecated alias + one-time
  hint + mechanical fix (`aiol --safe-fix` / `am fix`): `s.$do` effect channel,
  `self()`, `transaction: true` async default, `ui:` → `visible:`,
  exposed-by-key default, entry diet, the one config/CLI/task vocabulary
  (`target` → `client`, `service` → `server`)
- [alpha50 → alpha51](from-alpha50-to-alpha51.md) — zero inbox: every open
  field-report item resolved or refused (testUI `{ user }`, denials reject,
  `serverAuth()`, `openExternal`, am/aiol honesty) + the two app architectures
  named, documented and build-checked
- [alpha49 → alpha50](from-alpha49-to-alpha50.md) — the quiet hunt: a `port: 0`
  app bricking itself on its own clean shutdown, dispatch-while-paused lying to
  the caller, deep-merge silent data loss, worker-cell shutdown durability with
  zero coverage, and a reconnecting indicator that only saw one of two queues
- [alpha48 → alpha49](from-alpha48-to-alpha49.md) — **SECURITY**: an
  unauthenticated whole-app DoS, a stolen session becoming an unrecoverable 2FA
  takeover, OIDC reaching local accounts, rescue paths that did not rescue, and
  scheduled tasks that never fired on Android
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
