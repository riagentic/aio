# Architecture

AIO is a full-stack Deno/TypeScript application framework built around **cells**
— self-contained units of state + behavior. Everything flows through cells: UI
reads cells, persistence saves cells, sync replicates cells, testing isolates
cells.

## Core Data Flow

```
User action → dispatch → reduce (Immer) → new state → subscribers notified
                                       ↘ effects → execute (async side-effects)
```

Every state change follows this pipeline. Methods wrap it for ergonomics;
generators extend it for sequential workflows; actions/reduce exposes it
directly.

## Module Map

| Directory / Prefix | Purpose                                                 | Key files                                                  |
| ------------------ | ------------------------------------------------------- | ---------------------------------------------------------- |
| `cell-*`           | Cell definition, catalog, methods, machine, composition | `cell-create.ts`, `cell-impl.ts`, `cell-compose.ts`        |
| `aio-*`            | App bootstrap, lifecycle, dispatch, server wiring       | `aio.ts` (entry), `aio-run-helpers.ts`, `aio-lifecycle.ts` |
| `dispatch.ts`      | Action queue, middleware, effect scheduling             | Single file — the dispatch loop                            |
| `state-*`          | State subscriptions, signals, filtering, transport      | `state-core.ts`, `state-signals.ts`, `state-subs.ts`       |
| `vdom-*`           | Virtual DOM: create, diff, patch, events, SSR           | `vdom.ts` (entry), `vdom-diff.ts`, `vdom-render.ts`        |
| `renderer-*`       | AIR renderer: hooks, hydration, flush, lifecycle        | `renderer-hooks.ts`, `renderer-flush.ts`                   |
| `browser-*`        | Browser client: transport, router, hooks, protocol      | `browser-transport.ts`, `browser-air.ts`                   |
| `server-*`         | HTTP server, WebSocket, static files, HTML gen          | `server.ts`, `server-ws.ts`, `server-html.ts`              |
| `sync/`            | CRDT sync engine: HLC, merge, rebase, compaction        | `sync-engine.ts`, `merge.ts`, `hlc.ts`                     |
| `db/`              | Async SQLite via worker thread                          | `async-db.ts`, `db-worker.ts`                              |
| `vitals/`          | Runtime diagnostics: freeze detection, memory, hints    | `render-probe.ts`, `pressure-monitor.ts`                   |
| `protocol-*`       | Wire protocol messages (client ↔ server)                | One file per message category                              |
| `build-*`          | Build system: bundling, compilation, targets            | `build.ts` (entry), `build-bundle.ts`                      |
| `electron.ts`      | Electron integration: scripts, IPC, spawning            | Single file (desktop target)                               |
| `am-*`             | App Manager CLI: inspect, state, process mgmt           | `am.ts` (entry), `am-cmd-*.ts`                             |
| `adapters/`        | Renderer adapters                                       | `air.ts`                                                   |
| `signal.ts`        | Reactive signal primitives                              | Standalone signal implementation                           |
| `transition*.ts`   | CSS transitions and animation                           | Transition components + groups                             |
| `time-travel*.ts`  | Dev-mode time-travel debugging                          | Panel UI + state snapshots                                 |

## Key Boundaries

```
┌──────────────────────────────────────────────────┐
│                    SERVER                         │
│  aio.ts → cells → dispatch → state-core          │
│           ↕              ↕                        │
│     persistence    server-ws (broadcast)          │
│           ↕              ↕                        │
│     db/async-db    sync/sync-engine               │
└──────────────────────────────────────────────────┘
            ↕ WebSocket / IPC
┌──────────────────────────────────────────────────┐
│                    CLIENT                         │
│  browser-transport → state-core → renderer        │
│       ↕                   ↕                       │
│  browser-router      vdom / signal                │
│       ↕                   ↕                       │
│  browser-air         direct cell / useAio            │
└──────────────────────────────────────────────────┘
```

**Server owns state.** Cells live server-side. The client receives state patches
over WebSocket and renders them. Client actions flow back to the server for
processing.

**Sync is optional.** CRDT sync (`sync/`) runs alongside persistence when
`sync: true` on a cell. It handles HLC timestamps, op-log, merge strategies, and
conflict resolution.

**AIR is the renderer.** AIR (`browser-air.ts`, `vdom-*`, `renderer-*`) uses the
state subscription API. Custom adapters can be built on `state-core.ts`.

## File Naming Conventions

- `cell-*.ts` — Cell internals (not user-facing)
- `aio-*.ts` — App bootstrap and lifecycle
- `browser-*.ts` — Client-side only (browser/Electron)
- `server-*.ts` — Server-side only
- `state-*.ts` — State management primitives
- `vdom-*.ts` — Virtual DOM implementation
- `renderer-*.ts` — AIR renderer internals
- `protocol-*.ts` — Wire protocol types
- `build-*.ts` — Build tooling
- `am-*.ts` — App Manager CLI

## Extension Points

| Extension         | Mechanism                                              | Docs                               |
| ----------------- | ------------------------------------------------------ | ---------------------------------- |
| Custom middleware | `beforeReduce` in aio.run config                       | [lifecycle.md](state/lifecycle.md) |
| Lifecycle hooks   | `onInit`, `onDestroy` per cell                         | [lifecycle.md](state/lifecycle.md) |
| Sync strategies   | `merge` config per field (lww, counter, set-add, etc.) | [crdt.md](persistence/crdt.md)     |
| Custom SQL schema | `table()` definitions in cell config                   | [sqlite.md](persistence/sqlite.md) |
| Client transport  | WebSocket (default) or UDS (Unix Domain Socket)        | [browser.md](clients/browser.md)   |

## Programming Model Tiers

| Tier                   | Style                                                  | When to use                                   |
| ---------------------- | ------------------------------------------------------ | --------------------------------------------- |
| **L1: Methods**        | `methods: { add(s, item) { s.items.push(item) } }`     | 90% of cells. Start here.                     |
| **L2: Generators**     | `generators: { *fetch(ctx) { yield* ctx.call(...) } }` | Sequential multi-step workflows               |
| **L3: Actions/Reduce** | `actions → reduce → execute → effects`                 | Time-travel, action replay, strict separation |

See [State Management](state/README.md) for the full decision guide.
