# AIO Documentation

## Getting Started

- [Architecture](ARCHITECTURE.md) — module map, data flow, key boundaries
- [Quickstart](basics/quickstart.md) — install and run your first app
- [Core Concepts](basics/concepts.md) — mental model and framework rules
- [Project Structure](basics/project-structure.md) — file organization
- [API Reference](basics/api-reference.md) — all exports, types, configs
- [Tutorial](basics/tutorial.md) — step-by-step from zero to running app
- [FAQ](basics/faq.md) — design decisions and non-goals
- [Changelog](basics/changelog.md) — version history
- [Migration Guide](basics/migration.md) — adopting aio in an existing app

## State Management

- [Which Approach?](state/which-approach.md) — decision tree: methods vs
  generators vs actions/reduce
- [Cells](state/cells.md) — cell() config and anatomy
- [Cell Visibility](state/cell-visibility.md) — per-cell ui/persist filters
- [Methods](state/methods.md) — sync/async methods, selectors
- [State Machines](state/machines.md) — guards and transitions
- [Composition](state/composition.md) — cross-cell communication
- [Generators](state/generators.md) — sequential async workflows
- [Generators API](state/generators-api.md) — GenCtx method reference
- [Scheduling](state/scheduling.md) — timers, intervals, cron
- [Lifecycle](state/lifecycle.md) — hooks, middleware, aio.run()
- [Actions & Reduce](state/actions-reduce.md) — advanced: explicit action/reduce
  pipeline

## Rendering

- [AIR Setup](ui/air-setup.md) — connecting UI to server state
- [Signals](ui/air-signals.md) — reactive primitives
- [Components](ui/air-components.md) — props, lists, refs, events
- [Lifecycle](ui/air-lifecycle.md) — hooks, context, devtools
- [Forms](ui/air-forms.md) — form handling and validation
- [Routing](ui/air-routing.md) — Route, Link, patterns
- [Animation](ui/air-animation.md) — transitions and springs
- [Advanced](ui/air-advanced.md) — SSR, portals, islands
- [API Reference](ui/air-reference.md) — cheat sheet
- [Migration from React](ui/comparison.md) — comparison and migration
- [AIR vs Frameworks](ui/air-comparison.md) — detailed comparison with Solid,
  Svelte, Vue

## Persistence & Data

- [How It Works](persistence/how-it-works.md) — end-to-end persistence
  architecture
- [Auto-Persist](persistence/auto-persist.md) — Deno.Kv state persistence
- [SQLite](persistence/sqlite.md) — schema, queries, transactions
- [CRDT](persistence/crdt.md) — conflict-free sync
- [CRDT Protocol](persistence/crdt-protocol.md) — wire protocol
- [Delta](persistence/delta.md) — compression and filtering
- [Offline](persistence/offline.md) — offline queue, transport

## Clients

- [Browser](clients/browser.md) — WebSocket client
- [Electron](clients/electron.md) — desktop setup
- [App Manager](clients/app-manager.md) — am commands

## Debugging

- [Errors](debugging/errors.md) — AioError, codes, logs
- [Vitals](debugging/vitals.md) — freeze detection, probes
- [Troubleshooting](debugging/troubleshooting.md) — symptom decision tree
- [Performance](debugging/performance.md) — budgets, profiling
- [Production](debugging/production.md) — failure scenarios

## Testing

- [Cell Testing](testing/cell-testing.md) — testCell, assertions
- [Linter](testing/linter.md) — aiol static analysis

## Auth & Security

- [Auth](auth/auth.md) — tokens, TLS, multi-user

## Build & Deploy

- [Dev Mode](build/dev-mode.md) — CLI flags, live reload
- [Compile Targets](build/targets.md) — 10 build targets
- [Scaling](build/scaling.md) — production architecture
- [Import Rules](build/imports.md) — server vs browser

## Upgrade Guides

- [All upgrades](upgrade/README.md) — version-by-version migration

## Tutorials

- [Dashboard](examples/01-dashboard.md) — real-time metrics
- [Checkout](examples/02-checkout-workflow.md) — multi-cell e-commerce
- [CLI Service](examples/03-cli-service.md) — headless task queue
- [Electron App](examples/04-electron-app.md) — local-first notes
