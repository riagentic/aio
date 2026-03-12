# aio Reference Manual

Documentation index for the aio framework (v0.8).

## New to AIO?

**Start here:** [howto.md](howto.md) — Every concept explained from zero. No framework experience needed.

## Docs

| Doc | Contents |
|-----|----------|
| [howto.md](howto.md) | **Start here** — Concepts explained simply, with examples |
| [quickstart.md](quickstart.md) | From scratch in 5 minutes |
| [core.md](core.md) | `feature()`, `generators`, `aio.run({ features })`, `call()`, `useFeature()`, design decisions |
| [features.md](features.md) | Feature fundamentals, interaction patterns (Observe/Read/Coordinate), runtime control, architecture guide |
| [ui.md](ui.md) | `useAio()`, `useLocal()`, `page()`, Redux DevTools, UI state filtering, styling, components, error overlay, time-travel |
| [electron.md](electron.md) | Desktop app setup, configuration, window persistence, thin client, window metadata |
| [cli.md](cli.md) | CLI flags, verbose mode, startup linter, live reload, CSS hot reload, `am` app manager, app identity & instance management |
| [builds.md](builds.md) | All compile targets, build flags, Android/Electron packaging, systemd, `connectCli()` |
| [testing.md](testing.md) | `testFeature()`, `TestContext` API, async testing, `settle()` |
| [auth.md](auth.md) | Remote access (`--expose`), multi-user tokens, per-user authorization, security model |
| [persistence.md](persistence.md) | Deno.Kv auto-persist, SQLite 3-tier (auto-sync, ORM, raw SQL), offline queue, incremental sync |
| [scaling.md](scaling.md) | Architecture at scale, bottlenecks, best practices, capacity, design boundaries |
| [reactivity.md](reactivity.md) | `feature({ methods })` — sync/async methods, Immer proxy, machine guards, batching |
| [generators.md](generators.md) | Sequential async workflows — `generators` key, `cancelOn()`, `GenCtx` API |
| [structure.md](structure.md) | Project file organization, naming conventions |
| [migration.md](migration.md) | Adopting aio into an existing app |
| [upgrade.md](upgrade.md) | Version upgrades |
| [debugging.md](debugging.md) | Error interpretation, time-travel forensics, feature health, common fix patterns |
| [changelog.md](changelog.md) | Version history |
