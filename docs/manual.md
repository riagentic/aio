# aio Reference Manual

Documentation index for the aio framework (v1.0).

## New to AIO?

**Start here:** [howto.md](howto.md) — Every concept explained from zero. No
framework experience needed.

## Docs

| Doc                                      | Contents                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| [howto.md](howto.md)                     | **Start here** — Concepts explained simply, with examples                          |
| [quickstart.md](quickstart.md)           | From scratch in 5 minutes                                                          |
| [syntax.md](syntax.md)                   | Feature anatomy — public interface, internals, call graph, reuse patterns          |
| [core.md](core.md)                       | `feature()`, `generators`, `aio.run({ features })`, `call()`, `useFeature()`       |
| [reactivity.md](reactivity.md)           | `feature({ methods })` — sync/async methods, Immer proxy, machine guards, batching |
| [generators.md](generators.md)           | Sequential async workflows — `generators` key, `cancelOn()`, `GenCtx` API          |
| [features.md](features.md)               | Inter-feature patterns (Observe/Read/Coordinate), runtime control, architecture    |
| [ui.md](ui.md)                           | `useAio()`, `useFeature()`, `useLocal()`, URL routing, Redux DevTools, time-travel |
| [electron.md](electron.md)               | Desktop app setup, UDS transport, window persistence, thin client                  |
| [persistence.md](persistence.md)         | Deno.Kv auto-persist, SQLite auto-sync, offline queue, incremental sync            |
| [sqldb.md](sqldb.md)                     | SQLite schema, async query/execute/transaction, WAL mode, read replicas            |
| [scheduling.md](scheduling.md)           | `schedule.after/every/at/cron`, cancel by ID, dynamic vs static schedules          |
| [auth.md](auth.md)                       | `--expose`, multi-user tokens, per-user authorization, security model              |
| [testing.md](testing.md)                 | `testFeature()`, `TestContext` API, async testing, `settle()`                      |
| [linter.md](linter.md)                   | `aiol` — static analysis, 12 check areas, `--safe-fix`, CI integration             |
| [api.md](api.md)                         | Complete API reference — exports, types, config, hooks, SQLite, middleware         |
| [cli.md](cli.md)                         | CLI flags, verbose mode, startup linter, live reload, CSS hot reload               |
| [am.md](am.md)                           | App manager — process control, state inspection, dispatch, snapshots, logs         |
| [builds.md](builds.md)                   | All compile targets, build flags, Android/Electron packaging, systemd              |
| [structure.md](structure.md)             | Project file organization, naming conventions                                      |
| [scaling.md](scaling.md)                 | Architecture at scale, bottlenecks, best practices, capacity                       |
| [vitals.md](vitals.md)                   | Client freeze detection — probes, hint engine, thresholds, alerts                  |
| [troubleshooting.md](troubleshooting.md) | **Start here when stuck** — symptom-based guide, decision tree, fix paths          |
| [debugging.md](debugging.md)             | Error interpretation, time-travel forensics, feature health                        |
| [migration.md](migration.md)             | Adopting aio into an existing app                                                  |
| [upgrade.md](upgrade.md)                 | Version upgrade guides                                                             |
| [faq.md](faq.md)                         | When NOT to use aio — design decisions, patterns for common requests               |
| [changelog.md](changelog.md)             | Version history                                                                    |

## Tutorials

| Tutorial                                                    | What you build                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| [01-dashboard.md](examples/01-dashboard.md)                 | Real-time metrics dashboard — scheduling, SQLite, auth, React UI         |
| [02-checkout-workflow.md](examples/02-checkout-workflow.md) | Multi-feature checkout — generators, cross-feature calls, machine guards |
| [03-cli-service.md](examples/03-cli-service.md)             | Headless task queue — `connectCli`, `am` CLI, systemd deployment         |
| [04-electron-app.md](examples/04-electron-app.md)           | Desktop note-taking app — SQLite, URL routing, single-instance, AppImage |
