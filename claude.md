# claude.md

## What is aio

Full-stack TypeScript framework on Deno 2.6+. State-driven apps with auto
persistence (Deno.Kv), CRDT sync, AIR renderer, optional Electron/Android.
Elm-like: `(state, action) → { state, effects[] }`. v1.0.0-alpha17, 2150+ tests.

## Commands

```sh
deno task test              # all tests (-A --unstable-kv)
deno task test:core         # skip env-dependent tests (build, server, tls, electron)
deno task check             # type-check (mod.ts, aiol, init)
deno task lint              # lint src/
deno task lint:aio          # aiol custom linter
deno task am <cmd>          # app manager: start/stop/status/state/dispatch/tt/logs
```

Single file: `deno test -A --unstable-kv tests/signal.test.ts`

## Architecture

Source at repo root (`src/`, `mod.ts`). Public API: `mod.ts` exports map.
Example: `examples/counter/`. Docs: `docs/` (domain folders).

### Core flow

1. `aio.run({ cells })` boots KV, restores state, starts HTTP+WS server
2. Browser connects via WS, gets state, renders via AIR (`useCell()`) or React
3. User calls method → server reduces → persists → broadcasts delta → executes
   effects
4. Effects can dispatch follow-ups (re-entrant queue with overflow guard)

### Key modules

- **aio.ts** — orchestrator: CLI, KV, hooks, dispatch wiring, server
- **server.ts** — HTTP+WS, file watcher, TSX transpile, delta broadcast, trojan
  API
- **state-core.ts** — cell registry, dispatch, send(), sync routing
- **cell-create.ts** — `cell()` API: methods, machines, generators, lifecycle
- **aio-renderer.ts** — AIR: signal-driven JSX, mount/hydrate/diff
- **signal.ts** — reactive primitives: signal, computed, effect
- **browser.ts / browser-protocol.ts** — client runtime, WS, offline queue,
  routing
- **dispatch.ts** — action queue, reduce→effect loop, guardrails
- **sync/** — CRDT sync engine: HLC, merge, op buffer, rebase, compaction
- **vitals/** — observability: loop/render/transport probes, pressure monitor
- **build.ts** — esbuild + deno compile + Electron + Android APK + CLI
- **am.ts** — app manager CLI: process lifecycle, state, dispatch, time-travel
- **schedule.ts** — declarative timers/intervals/cron as effects

### Auth

Public (default), single auto-token (`--expose`), or per-user tokens. Token via
timing-safe comparison. User flows through hooks and `getUIState()`.

### Delta broadcasting

Per-client tracking. <50% changed keys → `$p` patch + `$d` deletes, else full
state.

## Conventions

- `factory` and `msg()` inlined in browser-shared.ts — must stay in sync
- Tests in `tests/` (not next to source)
- Lifecycle hooks: observe-only, error-guarded (never break dispatch)
- Server binds 127.0.0.1 by default; `--expose` for 0.0.0.0
