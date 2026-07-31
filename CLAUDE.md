# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What is aio

All-in-one full-stack TypeScript framework on Deno ≥2.9 (`MIN_DENO` in
`src/server/deno-version.ts`). One `cell({ state, methods })` drives server
state, persistence (worker-thread SQLite, one `state.db`), CRDT sync, and the UI
(AIR — an ~8 KB signals+JSX renderer). One codebase builds to browser, Electron,
Android, CLI, and service targets. Elm-like core:
`(state, action) → { state, effects[] }`. v1.0.0-alpha40, ~3000 test blocks in
`tests/`.

## Commands

```sh
deno task test              # full suite (no flags needed)
deno task test:core         # skip env-dependent tests (build, server, tls, electron, chromium)
deno task test:e2e          # real-browser + subscription e2e
deno task test:onboard      # install→create→dev→compile→android E2E (release gate)
deno task test:build        # artifact E2E: every target's binary boots from a FOREIGN cwd
deno task check             # type-check src/ mod.ts aiol/ examples/ + amui
deno task lint              # deno lint src/
deno task lint:aio          # aiol — the custom project linter
deno task boundaries        # src/ folder dependency matrix gate
deno task api:check         # public-surface snapshot gate (api:update regenerates)
deno task docs:check        # doc accuracy gate (docs:index regenerates docs/content.md)
deno task coverage:check    # suite + src/ line-coverage floor
deno task preflight         # publish/install/scaffold sanity, end to end
deno task bench             # + bench:check against scripts/bench-baselines.json
deno task am <cmd>          # app manager: discover/start/stop/state/dispatch/surface/timeline/logs
deno task amui              # visual app manager (amui/)
deno task doctor            # config sanity checks
```

Single file: `deno test -A tests/signal.test.ts` · single case:
`deno test -A tests/signal.test.ts --filter "name"`.

The coverage floor is flaky by nature — e2e child-process coverage is
nondeterministic. Don't ratchet it on noise.

## Layout

Source lives at the repo root (`src/`, `mod.ts`); tests all live in `tests/`,
never beside their source. `mod.ts` plus the `exports` map in `deno.json` are
the public surface — `api:check` snapshots it, so any export change is a
deliberate, regenerated diff.

Peer top-level apps: `amui/` (visual app manager), `aiol/` (custom linter),
`examples/`, `docs/` (`docs/[domain]/[doc].md`), `.katana/` (katas =
project-quality specs, see below), `feedback/` (field reports from real apps
built on aio).

## Architecture

### Boot & dispatch flow

1. `aio.run({ cells })` (`src/server/aio.ts` → `aio-boot.ts`) parses CLI, opens
   persistence, restores state, starts HTTP+WS (`src/server/server.ts`,
   `server-ws.ts`).
2. A client connects over WS, receives state, and renders through AIR
   (`src/air/aio-renderer.ts`) — reads are reactive, calls dispatch.
3. Method call → reduce (`src/state/dispatch.ts`) → persist → broadcast delta →
   run effects. Effects may dispatch follow-ups (re-entrant queue with an
   overflow guard).
4. Deltas are tracked per client: a patch is sent as `$p`/`$d` unless it exceeds
   50% of the full-state size, then full state
   (`src/server/server-broadcast.ts`).

### Module boundaries — the load-bearing structural rule

`scripts/check-boundaries.ts` enforces a folder dependency matrix over `src/`: a
folder may import only itself, the folders whitelisted for it, and root entry
files (`src/*.ts`, which are the public surface and carry load-bearing side
effects such as `state-core`'s `enablePatches`). The shape that matters:

- `state`, `protocol`, `diagnostics`, `vitals` — isomorphic core,
  dependency-light.
- `air`, `browser`, `ui` — UI; **never import `server`**.
- `server` — may use everything except browser-only client code.
- `build`, `am`, `electron`, `db`, `sync`, `testing`, `adapters` — see the
  `ALLOWED` map for exact edges.

Adding a cross-folder import that isn't in the matrix is a red gate, not a style
nit. Widen the matrix deliberately, with a comment, or restructure.

### Where things live

| Area                                            | Path                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| Orchestrator, CLI, boot, lifecycle              | `src/server/aio.ts`, `aio-boot.ts`, `aio-cli.ts`, `aio-lifecycle.ts` |
| HTTP+WS, watcher, transpile, trojan API         | `src/server/server*.ts`                                              |
| Auth (sessions, users, TOTP, OIDC, pairing)     | `src/server/auth-*.ts`, `sessions.ts`, `pairing.ts`                  |
| Persistence (SQLite worker, schema, SQL)        | `src/server/persistence.ts`, `skv*.ts`, `sql.ts`, `src/db/`          |
| Cell API, machines, methods, workers            | `src/state/cell-*.ts`, `src/server/cell-worker*.ts`                  |
| Dispatch, signals, scheduling                   | `src/state/dispatch.ts`, `signal.ts`, `schedule.ts`                  |
| Cell registry / send / sync routing             | `src/state-core.ts`                                                  |
| Renderer (AIR): vdom, hydrate, diff             | `src/air/` (`aio-renderer.ts`, `vdom*.ts`, `renderer-*.ts`)          |
| Client runtime: WS, offline queue, routing      | `src/browser/`, `src/protocol/`                                      |
| Wire envelope + version stamp                   | `src/protocol/envelope.ts`, `protocol-version.ts`                    |
| CRDT sync (HLC, merge, rebase, compaction)      | `src/sync/`                                                          |
| Observability (loop/render/transport probes)    | `src/vitals/`, `src/diagnostics/`                                    |
| Build: esbuild, compile, Electron, Android      | `src/build.ts`, `src/build-all.ts`, `src/build/`                     |
| App manager CLI                                 | `src/am.ts`, `src/am/`                                               |
| Test helpers (`testCell`/`testUI`/`testServer`) | `src/testing/`, `src/cell-test.ts`                                   |

### Auth model

Public by default (including `--expose`); single key (`key: true` persisted /
`key: "…"` fixed, enforced only under `--expose`; the aio client pairs by PIN);
or per-user tokens (`users`/`resolveUser`, `auth: true` for full login flows).
Token comparison is timing-safe. The user flows through hooks and
`getUIState()`. The server binds 127.0.0.1 unless `--expose`.

## Testing UIs (use this, not DOM scraping)

Every TSX component is exposed as a semantic API — observe and drive the UI
without selectors:

- In tests: `testUI(App, "name", async (ui) => { … })` from `aio/testing` — zero
  setup (auto happy-dom window, auto-boots the cells `App` imports, full
  teardown). Actions need no await
  (`ui.TitleInput.type("x"); ui.AddButton.click()` — an ordered queue); await
  only observations (`expectCell`, `waitFor`, `settle` — they drain the queue
  and surface failures). Names are LABEL+ROLE from the TSX
  (`<div class="button">Submit</div>` → `SubmitButton`). Handle form:
  `await using ui = await testUI(App)`.
- On a live app: `am surface 0 --json` (components, elements, live
  text/value/checked) and `am trigger 0 "<path>" <action> [text]` — the reply
  includes the fresh post-action surface, and misses list available paths. Loop:
  observe → act → observe, one call per step.
- Guide: `docs/testing/ui-testing.md`.

Always dispatch-test cell methods (`testCell`, or a trojan POST) — SSR plus an
initial-state curl proves nothing about whether a method actually runs.

## Conventions

- **Fail loud, never silent.** The #1 lesson from every field report: the
  framework doing something implicitly and failing quietly is worse than any
  missing feature. A misconfig, a dropped write, an unmet invariant, an
  exposed-but-undiscoverable app → warn/throw at the site (dev), or make it a
  red gate. Never swallow. Prefer a property test that makes a whole bug class
  unshippable over a per-instance patch.
- **Dev == prod behavior. No forked code paths without a hard reason.** This is
  critical and load-bearing. Immer `autoFreeze` is NEVER disabled, so committed
  state is frozen identically in both and an illegal mutation throws in dev AND
  prod. A dev/prod difference is allowed ONLY when it is (a) observe-only —
  verbosity, log level, a one-time hint, a dev warn-timer, an error overlay vs
  graceful degradation — or (b) dev STRICTER than prod (dev throws where prod
  degrades), so dev/CI catches it first. NEVER the reverse, and never a silent
  behavioral divergence. Every `__aioDev`/`isDev()` gate must fall in (a) or
  (b). (`src/state/cell-methods-internals.ts`'s async-transpile guard is the one
  behavioral gate — dev throws, prod logs+degrades: category (b), protective.)
- **Tests are the STRICTEST environment, never the most permissive.** The
  harness (`testUI`/`testCell`/`bootCells`) runs dev-strict (`__aioDev`), so
  every tripwire that fires in dev and prod also fires in a test. A test env
  more lenient than production manufactures green-test-broken-prod. Never add a
  lenient-test shortcut. Corollary: the in-process harness still can't reproduce
  transport-boundary behavior — those need a loopback/browser path (tracked in
  `todo.md`).
- **Proxy-derived values assigned back into cell state are materialized to
  plain data at write time** (`LIVE_RAW` in `src/state/cell-impl.ts`), so
  `s.x = { ...s.x }` works identically in sync and async methods. The
  sync/async parity contract is pinned by `tests/proxy-differential.test.ts`
  (a randomized differential fuzzer) — extend ITS op set when adding proxy
  capabilities, never hand-reason about equivalence.
- Test servers take their port from `freePort()`, never a constant or a
  pid-derived formula (a guard test enforces this).
- `factory` and `msg()` are inlined in `src/browser/browser-shared.ts` — they
  must stay in sync with `src/state/`.
- Any per-method flag the browser branches on must be mirrored in the separate
  browser cell stub (`src/protocol/protocol-cell.ts`), not just the server stub.
- Lifecycle hooks are observe-only and error-guarded — they never break
  dispatch.

## Katas & release gates

`.katana/*.md` are the project's quality specs (core, docs, testing, targets,
examples, release, onboard, amui, goals, meta). `/use-katana` audits the repo
against them. `.katana/docs.md` defines what counts as documentation —
`CLAUDE.md`, `todo.md`, `perfect-aio.md`, `.katana/`, `feedback/`, and
`RELEASE_NOTES-*.md` are explicitly exempt; don't "tidy" them into `docs/`.

A release is code **plus every surface**, checked rather than assumed — see
`.katana/release.md` for the authoritative list. The version string must be
identical in `deno.json`, `src/server/aio-cli.ts` (`VERSION`), and the README
badge; `CHANGELOG.md` needs a dated entry; an upgrade guide must exist and be
listed; `docs/content.md` and `docs/api-snapshot.json` must be regenerated.
Gates: `fmt`, `check`, `lint`, `test`, `test:onboard`, `test:build`,
`api:check`, `docs:check`, `boundaries`, `deno publish --dry-run`.

`todo.md` is the live roadmap. `perfect-aio.md` holds the foundational design
decisions.
