# State Management

Defining cells, managing state, and coordinating workflows.

> v2: methods is the one style — see
> [docs/upgrade/restructure.md](../upgrade/restructure.md) for migration from
> `actions:`/`reduce:`/`machine:`/`generators:`.

## Core

Start here. Covers what every app needs.

- [Cells](cells.md) — cell() anatomy and config reference
- [Methods](methods.md) — sync/async methods, workflows, cancellation,
  selectors, Immer
- [The bridge](the-bridge.md) — what crosses client↔server, what doesn't, what
  freezes
- [Cell contexts](cell-contexts.md) — which code runs where (server, client
  replay, worker, tests), what each option means there, refused combinations

## Going further

- [Lifecycle](lifecycle.md) — onInit, onDestroy, aio.run(), runtime control
- [Composition](composition.md) — cross-cell communication
- [Scheduling](scheduling.md) — timers, intervals, cron
- [Cell Visibility](cell-visibility.md) — per-cell ui/persist filters
