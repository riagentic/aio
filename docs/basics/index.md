# AIO Documentation

## Getting Started

- [Architecture](architecture.md) — module map, data flow, key boundaries
- [Quickstart](quickstart.md) — install and run your first app
- [Core Concepts](concepts.md) — mental model and framework rules
- [Where does this code run?](where-code-runs.md) — the six execution contexts,
  one table: `Deno.*`, hidden fields, tracked reads, and what refuses you
- [Project Structure](project-structure.md) — file organization
- [API Reference](api-reference.md) — all exports, types, configs
- [Tutorial](tutorial.md) — step-by-step from zero to running app
- [FAQ](faq.md) — design decisions and non-goals
- [Common Pitfalls](pitfalls.md) — the traps people actually hit, each with the
  avoiding rule
- [Changelog](../../CHANGELOG.md) — version history
- [Positioning & non-goals](positioning.md) — what aio is for, what it isn't
- [Versioning policy](semver-policy.md) — what counts as breaking, deprecation
  lifecycle, release phases
- [Migration Guide](migration.md) — adopting aio in an existing app

## State Management

- [Cells](../state/cells.md) — cell() config and anatomy
- [Cell Visibility](../state/cell-visibility.md) — per-cell ui/persist filters
- [Methods](../state/methods.md) — sync/async methods, workflows, cancellation,
  selectors
- [Composition](../state/composition.md) — cross-cell communication
- [Scheduling](../state/scheduling.md) — timers, intervals, cron
- [Lifecycle](../state/lifecycle.md) — hooks, aio.run(), runtime control
- [Migrating to v2](../upgrade/restructure.md) — from
  actions/reduce/machine/generators to methods

## Rendering

- [AIR Setup](../ui/air-setup.md) — connecting UI to server state
- [Signals](../ui/air-signals.md) — reactive primitives
- [Components](../ui/air-components.md) — props, lists, refs, events
- [Lifecycle](../ui/air-lifecycle.md) — hooks, context, devtools
- [Forms](../ui/air-forms.md) — form handling and validation
- [Routing](../ui/air-routing.md) — Route, Link, patterns
- [Animation](../ui/air-animation.md) — transitions and springs
- [Advanced](../ui/air-advanced.md) — SSR, portals, islands
- [API Reference](../ui/air-reference.md) — cheat sheet
- [Migration from React](../ui/comparison.md) — comparison and migration
- [AIR vs Frameworks](../ui/air-comparison.md) — detailed comparison with Solid,
  Svelte, Vue

## Persistence & Data

- [How It Works](../persistence/how-it-works.md) — end-to-end persistence
  architecture
- [Auto-Persist](../persistence/auto-persist.md) — SQLite state persistence
- [SQLite](../persistence/sqlite.md) — schema, queries, transactions
- [CRDT](../persistence/crdt.md) — conflict-free sync
- [CRDT Protocol](../persistence/crdt-protocol.md) — wire protocol
- [Delta](../persistence/delta.md) — compression and filtering
- [Offline](../persistence/offline.md) — offline queue, transport

## Clients

- [Browser](../clients/browser.md) — WebSocket client
- [Electron](../clients/electron.md) — desktop setup
- [App Manager](../clients/app-manager.md) — am commands

## Debugging

- [Errors](../debugging/errors.md) — AioError, codes, logs
- [Vitals](../debugging/vitals.md) — freeze detection, probes
- [Troubleshooting](../debugging/troubleshooting.md) — symptom decision tree
- [Performance](../debugging/performance.md) — budgets, profiling
- [Production](../debugging/production.md) — failure scenarios

## Testing

- [Cell Testing](../testing/cell-testing.md) — testCell, assertions
- [Linter](../testing/linter.md) — aiol static analysis

## Auth & Security

- [Auth](../auth/auth.md) — tokens, TLS, multi-user

## Build & Deploy

- [Dev Mode](../build/dev-mode.md) — CLI flags, live reload
- [Compile Targets](../build/targets.md) — 10 build targets
- [Scaling](../build/scaling.md) — production architecture
- [Import Rules](../build/imports.md) — server vs browser

## Upgrade Guides

- [All upgrades](../upgrade/README.md) — version-by-version migration

## Tutorials

- [Dashboard](../examples/01-dashboard.md) — real-time metrics
- [Checkout](../examples/02-checkout-workflow.md) — multi-cell e-commerce
- [CLI Service](../examples/03-cli-service.md) — headless task queue
- [Electron App](../examples/04-electron-app.md) — local-first notes
