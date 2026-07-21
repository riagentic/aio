# State Management

Defining cells, managing state, and coordinating workflows.

> v2: methods is the one style — see
> [docs/upgrade/to-v2.md](../upgrade/to-v2.md) for migration from
> `actions:`/`reduce:`/`machine:`/`generators:`.

## Core

Start here. Covers what every app needs.

- [Cells](cells.md) — cell() anatomy and config reference
- [Methods](methods.md) — sync/async methods, workflows, cancellation,
  selectors, Immer

## Going further

- [Lifecycle](lifecycle.md) — onInit, onDestroy, aio.run(), runtime control
- [Composition](composition.md) — cross-cell communication
- [Scheduling](scheduling.md) — timers, intervals, cron
- [Cell Visibility](cell-visibility.md) — per-cell ui/persist filters
