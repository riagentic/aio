# claude.md

## What is aio

Full-stack TypeScript framework on Deno 2.9+ (latest stable). State-driven apps
with auto persistence (Deno.Kv), CRDT sync, AIR renderer, optional
Electron/Android. Elm-like: `(state, action) → { state, effects[] }`.
v1.0.0-alpha20, 2250+ tests.

## Commands

```sh
deno task test              # all tests (no flags — kv via deno.json, udp via node:dgram)
deno task test:core         # skip env-dependent tests (build, server, tls, electron)
deno task check             # type-check (mod.ts, aiol, init)
deno task lint              # lint src/
deno task lint:aio          # aiol custom linter
deno task am <cmd>          # app manager: start/stop/status/state/dispatch/tt/logs
deno task doctor            # config sanity checks (deno.json magic lines)
deno task coverage:check    # full suite + src/ line-coverage floor (CI gate)
deno task api:check         # public-surface snapshot gate (api:update to regen)
deno task boundaries        # src/ folder dependency matrix
```

Single file: `deno test -A tests/signal.test.ts`

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

Public (default, incl. `--expose`), single key (`key: true` persisted /
`key: "..."` fixed, enforced only under `--expose`; aio client pairs by PIN), or
per-user tokens (`users`/`resolveUser`). Token via timing-safe comparison. User
flows through hooks and `getUIState()`.

### Delta broadcasting

Per-client tracking. <50% changed keys → `$p` patch + `$d` deletes, else full
state.

## Testing UIs (agents: use this, not DOM scraping)

Every TSX component is exposed as a semantic API — observe and drive the UI
without selectors:

- In tests: `testUI(App, "name", async (ui) => { … })` from `aio/testing` — zero
  setup (auto happy-dom window, auto-boots the cells App imports, full
  teardown). Actions need no await
  (`ui.TitleInput.type("x"); ui.AddButton
  .click()` — ordered queue); await
  only observations (`expectCell`, `waitFor`, `settle` — they drain the queue
  and surface failures). Names are LABEL+ROLE from the TSX
  (`<div class="button">Submit</div>` → `SubmitButton`). Handle form:
  `await using ui = await testUI(App)`.
- On a live app: `am surface 0 --json` (full perception: components, elements,
  live text/value/checked) and `am trigger 0 "<path>" <action> [text]` — the
  reply includes the fresh post-action surface, and misses list available paths.
  Loop: observe → act → observe, one call per step.
- Guide: docs/testing/ui-testing.md.

## Conventions

- **Fail loud, never silent.** The #1 lesson from every field report (risoto,
  quant, mdview): the framework doing something implicitly and failing quietly
  is worse than any missing feature. A misconfig, a dropped write, an unmet
  invariant, an exposed-but-undiscoverable app → warn/throw at the site (dev),
  or make it a red gate. Never swallow. Prefer a property-test that makes a
  whole bug class un-shippable over a per-instance patch.
- `factory` and `msg()` inlined in browser-shared.ts — must stay in sync
- Tests in `tests/` (not next to source)
- Lifecycle hooks: observe-only, error-guarded (never break dispatch)
- Server binds 127.0.0.1 by default; `--expose` for 0.0.0.0
