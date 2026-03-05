# claude.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is aio

aio ("eye-oh") is a full-stack TypeScript framework on Deno 2.6+ for building state-driven apps with automatic persistence (Deno.Kv), WebSocket sync, and optional Electron/Android packaging. Elm-like architecture: `(state, action) → { state, effects[] }`.

## Commands

```sh
deno task test                    # run all tests (457, requires -A --unstable-kv)
deno task dev                     # dev mode: hot reload, time-travel, trojan API, error overlay
deno task am <cmd>                # app manager: start/stop/status/state/dispatch/tt/...
deno check dep/aio/mod.ts        # type-check framework
deno task compile                 # compile:browser — standalone binary
deno task compile:browser:remote  # exposed server + systemd (0.0.0.0 + auth)
deno task compile:electron        # desktop AppImage
deno task compile:electron:remote # thin client AppImage (no Deno)
deno task compile:cli             # headless server + CLI binary
deno task compile:cli:remote      # client-only CLI binary (no server)
deno task compile:android         # standalone APK with WebView
deno task compile:android:remote  # client APK — connect page, no local dispatch
deno task compile:service         # headless binary + systemd (127.0.0.1)
deno task compile:service:remote  # headless exposed server + systemd (0.0.0.0 + auth)
```

Single test file: `deno test -A --unstable-kv dep/aio/tests/server.test.ts`

### am — app manager CLI

Use `deno task am` (or `deno run -A dep/aio/src/am.ts`) for all process management and app control. Prefer `am` over raw `curl`, `ps`, `kill`.

```sh
deno task am start [--port=N]     # start app (singleton — kills zombies, refuses if running)
deno task am stop                 # graceful shutdown (trojan API → SIGTERM → SIGKILL)
deno task am status               # stopped|starting|started|stopping
deno task am state [path]         # read state (dot-path: fleet.0.stats)
deno task am dispatch Type k=v    # send action
deno task am tt undo|redo|goto N  # time-travel
deno task am logs [--filter=X]    # tail app log with optional filter
deno task am config               # server configuration
```

Output auto-detects: terminal → pretty, piped → JSON. Override with `--json` or `--quiet`.

## Architecture

Framework lives in `dep/aio/`, user app in `src/`. Public API surface is `dep/aio/mod.ts`.

### Core flow
1. `aio.run(initialState, config)` boots KV, restores state via `deepMerge`, starts HTTP+WS server
2. Browser connects via WebSocket, gets initial state, renders React via `useAio<S>()` hook
3. User dispatches action → server reduces → persists → broadcasts delta → executes effects
4. Effects can dispatch follow-up actions (re-entrant queue with overflow guard)

### Key modules
- **aio.ts** — orchestrator: CLI, KV, hooks, dispatch wiring, server creation
- **server.ts** — HTTP + WS server, file watcher, live TSX transpile (esbuild), delta broadcast, trojan API
- **browser.ts** — `useAio`, `useLocal`, `page`, WS singleton, reconnect, TT panel (inlined, not importable separately)
- **dispatch.ts** — action queue, reduce→effect loop, guardrails
- **time-travel.ts** — pure functions: record/undo/redo/travelTo/pause/resume
- **standalone.ts** — Android WebView runtime (duplicates some browser.ts, guarded by sync.test.ts)
- **schedule.ts** — declarative timers/intervals/cron as effects, schedule manager
- **electron.ts** — Electron launcher, aio-client connect page, window state persistence, AioMeta
- **cli-client.ts** — WS client for Deno CLI apps: connectCli(), delta patches, reconnect
- **build.ts** — esbuild bundling + deno compile + Electron AppImage + aio-client + CLI + Android APK
- **am.ts** — app manager CLI: process lifecycle, state inspection, dispatch, time-travel control

### Auth model
Three modes: public (default), single auto-token (`--expose`), per-user tokens (`users: Record<string, AioUser>`). Token checked via timing-safe comparison. User identity flows through hooks and `getUIState(state, user?)`.

### Delta broadcasting
Per-client `ClientMeta = { id, user?, lastState, lastKeyJsons }`. Changes <50% of keys → `$p` patch + `$d` deletes. Otherwise full state. CSS-only changes send `__css` signal (no page reload).

## Conventions

- `factory` and `msg()` are inlined in browser.ts — must stay in sync (sync.test.ts enforces)
- Tests colocated in `dep/aio/tests/` (not next to source — framework is a single dep)
- Lifecycle hooks are observe-only and error-guarded (never break dispatch)
- `_dispatchUser` module-level variable carries user context through effect chains
- Server binds 127.0.0.1 by default; `--expose` required for 0.0.0.0
