# aio Reference Manual

Documentation index for the aio framework (v0.7).

## Docs

| Doc | Contents |
|-----|----------|
| [quickstart.md](quickstart.md) | From scratch in 5 minutes |
| [core.md](core.md) | `feature()`, `flow()`, `reactive()`, `aio.run({ features })`, `bridge()`, `useFeature()`, design decisions |
| [features.md](features.md) | Feature fundamentals, all 5 interaction patterns, runtime control, architecture guide |
| [ui.md](ui.md) | `useAio()`, `useLocal()`, `page()`, Redux DevTools, UI state filtering, styling, components, error overlay, time-travel |
| [electron.md](electron.md) | Desktop app setup, configuration, window persistence, thin client, window metadata |
| [cli.md](cli.md) | CLI flags, verbose mode, startup linter, live reload, CSS hot reload, `am` app manager, app identity & instance management |
| [builds.md](builds.md) | All compile targets, build flags, Android/Electron packaging, systemd, `connectCli()` |
| [testing.md](testing.md) | `testFeature()`, `testBridge()`, `TestContext` API, async testing |
| [auth.md](auth.md) | Remote access (`--expose`), multi-user tokens, per-user authorization, security model |
| [persistence.md](persistence.md) | Deno.Kv auto-persist, SQLite 3-tier (auto-sync, ORM, raw SQL), offline queue, incremental sync |
| [scaling.md](scaling.md) | Architecture at scale, bottlenecks, best practices, capacity, design boundaries |
| [reactivity.md](reactivity.md) | Reactive features with `reactive()` |
| [generators.md](generators.md) | Sequential async workflows with `flow()` |
| [structure.md](structure.md) | Project file organization, naming conventions |
| [migration.md](migration.md) | Adopting aio into an existing app |
| [upgrade.md](upgrade.md) | Version upgrades |
| [debugging.md](debugging.md) | Error interpretation, time-travel forensics, feature health, common fix patterns |
| [classic.md](classic.md) | Classic v0.4 API — `aio.run(state, config)`, `actions()`, `effects()`, `draft()`, `matchEffect()`, `composeMiddleware()`, `createSelector()` |
| [a4.md](a4.md) | Architecture design document |
| [changelog.md](changelog.md) | Version history |
