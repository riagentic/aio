# AIO Diagnostics Module — Design Spec

**Date:** 2026-03-23 **Status:** Reviewed — blockers resolved **Authors:** Zen +
AIO Team

## Problem

AIO has strong error classification (16 codes, correlation IDs, tips, state
snapshots) and structured logging (5 log files). But several observability gaps
remain:

- **No state diff logging** — actions fire but we don't know what changed
- **No action history file** — can't replay what happened before a bug
- **No crash recovery** — process dies, all state is lost
- **No global crash handler** — unhandled rejections produce zero aio context
- **~30 raw `console.*` calls** in runtime files bypass structured logger
- **Circuit breaker error counting** has no time window — 5 errors across a week
  trips it
- **Dev vs prod** defaults are implicit — no clear separation in config

## Goals

1. **Zero-config observability** — `aio.run({ features })` gives sensible
   defaults for dev and prod
2. **Full customizability** — two-level config: built-in defaults + explicit
   `dev`/`prod` overrides
3. **Small files** — no god-module, each component is independently testable
4. **Dev = full visibility, Prod = lean + safe** — clear separation
5. **Everything is customizable** — any default can be overridden per mode

## Non-Goals

- Production action recording (future, opt-in)
- Runtime API (`diagnostics.dump()` etc.) — config-only for now
- Deep diffs / JSON patches — key-level only
- Distributed tracing — correlation IDs don't cross service boundaries yet
- Half-open circuit breaker — manual re-enable only
- Metrics aggregation / time series
- Action replay CLI (future — will consume the JSONL file)

---

## Architecture

### New files

```
src/diagnostics/
  mod.ts              — entry point, wires all components, resolves config
  state-diff.ts       — key-level diff detection + formatting
  action-log.ts       — JSONL action recorder
  checkpoint.ts       — atomic state checkpoint + restore on startup
  crash-handler.ts    — unhandledrejection/uncaughtException last-words logger
  types.ts            — DiagnosticsConfig type + shared types
```

### Existing files (unchanged or minimally touched)

| File                 | Change                                                                                                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch.ts`        | Add `afterAction` callback to `DispatchDeps` — called at line ~189 after `setState()` with `(prevState, newState, action)`. This is the hook point for state-diff and action-log. ~5 lines added. The prev/next comparison already exists (lines 187-195) — we generalize it into a callback. |
| `memory-monitor.ts`  | No change — wired into diagnostics config                                                                                                                                                                                                                                                     |
| `error.ts`           | No change — already solid                                                                                                                                                                                                                                                                     |
| `time-travel.ts`     | No change — dev-only by default, can be enabled in prod via config                                                                                                                                                                                                                            |
| `logger.ts`          | No change                                                                                                                                                                                                                                                                                     |
| `aio.ts`             | Wire diagnostics init, pass `afterAction` hook to dispatch, remove raw `console.*` calls                                                                                                                                                                                                      |
| `feature-compose.ts` | Route raw `console.*` through `log.*`; change `featureErrors` from `Map<string, number>` to `Map<string, number[]>` (timestamps) for rolling window support                                                                                                                                   |
| `feature-create.ts`  | Route raw `console.*` through `log.*` (~2 calls)                                                                                                                                                                                                                                              |
| `flow.ts`            | Route raw `console.*` through `log.*`                                                                                                                                                                                                                                                         |
| `feature-machine.ts` | Route raw `console.*` through `log.*`                                                                                                                                                                                                                                                         |

CLI tools (`build.ts`, `am.ts`, `electron.ts`, `standalone.ts`) keep `console.*`
— they run outside the aio app lifecycle.

---

## Config Design

### Two levels only

1. **Built-in defaults** — what you get with zero config (mode-aware)
2. **App.ts overrides** — `diagnostics: { dev: {...}, prod: {...} }`

### API

```ts
aio.run({
  features: [...],
  diagnostics: {
    dev: {
      // overrides built-in dev defaults
      actionLog: { max: 5000 },
    },
    prod: {
      // overrides built-in prod defaults
      timeTravel: true,       // force time-travel on in prod
      console: false,         // silence console in prod
    }
  }
})
```

### Value types

Each diagnostics field accepts:

- `true` — on with default options
- `false` — explicitly off
- `{ ...options }` — on with custom options
- omitted — use built-in default for that mode

### Built-in defaults

| Feature                        | Dev default  | Prod default      |
| ------------------------------ | ------------ | ----------------- |
| Console logging                | on           | on (info + error) |
| Memory monitor                 | on           | off               |
| State diffs                    | on           | off               |
| Action log (JSONL)             | on           | off               |
| Checkpoint                     | on           | off               |
| Crash handler                  | on           | on                |
| Time-travel                    | on           | off               |
| Error counting per feature     | on           | on                |
| Circuit breaker (auto-disable) | off (opt-in) | off (opt-in)      |

---

## Component Specs

### 1. state-diff.ts (~50 lines)

**Purpose:** Log what changed after each action, not just that an action fired.

**Behavior:**

- Hooks into the new `afterAction` callback in `dispatch.ts` (called after
  `setState()` with prev/next state)
- Compares previous state slice vs. new state slice per feature
- Key-level only: detects which top-level keys changed
- Formats as one log line per feature that changed:
  ```
  [state-diff] counter: count 5→10, total 20→25
  ```
- Values over 80 chars are truncated with `…`
- Objects/arrays show `JSON.stringify` preview, truncated
- Logs through structured logger at `debug` level → appears in debug.log

**Input:** previous state, new state, action (from `afterAction` callback in
`dispatch.ts`) **Output:** log lines via `log.debug()`

**No output when:**

- State didn't change (referential equality check `prev === next` first — cheap)
- Feature is internal/framework action (same skip rules as logger)

### 2. action-log.ts (~60 lines)

**Purpose:** Rolling JSONL file of recent actions for post-bug investigation.

**Behavior:**

- Appends one JSON line per action to `log/actions.jsonl`:
  ```jsonl
  {"type":"counter:increment","payload":{"amount":5},"ts":1711152000000}
  {"type":"wallet:transfer","payload":{"to":"0x...","amount":100},"ts":1711152001000}
  ```
- Skips framework-internal actions (same `SKIP_SUFFIXES`/`SKIP_CONTAINS` as
  logger)
- Rolling cap: configurable `max` (default: 1000 lines)
- When file exceeds `max` lines, truncate oldest half (simple, no ring buffer
  complexity)
- Async file writes (same pattern as logger — fire-and-forget with error
  counter)

**Config:**

```ts
actionLog: boolean | { max?: number }  // default max: 1000
```

### 3. checkpoint.ts (~60 lines)

**Purpose:** Survive crashes. Write state periodically so post-crash
investigation (or restore) is possible.

**Behavior:**

- On state change: debounced write (default: 5000ms) of:
  ```json
  {
    "ts": 1711152000000,
    "state": { ...full app state... },
    "recentActions": ["counter:increment", "wallet:transfer", ...],
    "features": { "counter": { "errors": 0 }, "wallet": { "errors": 2 } }
  }
  ```
- `recentActions`: last 20 action types (no payloads — compact). Note: this
  overlaps with `actions.jsonl` intentionally — checkpoint survives crash (sync
  write), JSONL is for detailed post-mortem (has payloads, up to 1000 entries)
- Atomic write: write to `log/checkpoint.json.tmp` → `Deno.rename()` →
  `log/checkpoint.json`
- On startup: detect existing `checkpoint.json`, log recovery info:
  ```
  [checkpoint] recovered state from 2026-03-23T14:30:00Z (age: 45s)
  ```
- Expose recovered data via `getRecoveredState(): CheckpointData | null` in the
  diagnostics hooks
- `aio.ts` calls this before feature init and passes to an optional
  `onCheckpointRestore` callback in config
- App decides whether to use the recovered state — do NOT silently restore
- After reading, checkpoint file is kept (not deleted) — useful for post-mortem
  even if app chose not to restore

**Config:**

```ts
checkpoint: boolean | { debounce?: number }  // default debounce: 5000ms
```

**Recovery opt-in in app.ts:**

```ts
aio.run({
  features: [...],
  onCheckpointRestore: (checkpoint) => {
    // checkpoint: CheckpointData — state + recent actions + feature health
    // return the state to restore, or null to start fresh
    return checkpoint.state
  }
})
```

**Boot sequence for recovery:**

1. Diagnostics init → reads `checkpoint.json` if present
2. `getRecoveredState()` called before feature init
3. If `onCheckpointRestore` returns state → used as initial state instead of
   feature defaults
4. If `onCheckpointRestore` returns null or is not provided → normal fresh start
5. Features init with either recovered or fresh state

**Edge cases:**

- Corrupt/missing checkpoint file → log warning, `getRecoveredState()` returns
  null
- Partial write (crash during write) → `.tmp` exists but `.json` doesn't → log
  warning, no restore
- Stale checkpoint (age > 1h) → log warning with age, still offer to restore
  (app decides)

### 4. crash-handler.ts (~30 lines)

**Purpose:** When the process dies from unhandled errors, log useful context
before death.

**Behavior:**

- Installs `globalThis.addEventListener('unhandledrejection', handler)`
- Installs `globalThis.addEventListener('error', handler)`
- On trigger:
  1. Log error through structured logger with `error` level
  2. Log current feature health stats (error counts, enabled/disabled status)
  3. Write emergency checkpoint (synchronous `Deno.writeTextFileSync` — can't
     await during crash)
  4. Re-throw / let process die — do NOT swallow the error
- Always active (dev + prod) — zero overhead until the moment of death
- **Server-runtime only.** In browser/Electron contexts, logs to console but
  skips file write (no `Deno.writeTextFileSync`). Guard with
  `typeof Deno !== 'undefined'`.

**Config:**

```ts
crashHandler: boolean; // default: true in both dev and prod
```

### 5. types.ts (~40 lines)

**Purpose:** Shared types for the diagnostics module.

```ts
export type DiagnosticsConfig = false | {
  dev?: DiagnosticsOptions;
  prod?: DiagnosticsOptions;
};

export type DiagnosticsOptions = {
  stateDiffs?: boolean;
  actionLog?: boolean | { max?: number };
  checkpoint?: boolean | { debounce?: number };
  crashHandler?: boolean;
  memoryMonitor?: boolean | MemoryConfig;
  timeTravel?: boolean;
  console?: boolean;
};

export type CheckpointData = {
  ts: number;
  state: Record<string, unknown>;
  recentActions: string[]; // last 20 action types (no payloads)
  features: Record<string, { // per-feature health at checkpoint time
    errors: number;
    enabled: boolean;
  }>;
};
```

**Kill switch:** `diagnostics: false` disables the entire diagnostics subsystem
(useful for benchmarks or debugging diagnostics itself). Omitting `diagnostics`
or passing `{}` uses built-in defaults.

**Note:** File logging is NOT part of `DiagnosticsOptions` — it is controlled by
the existing top-level `logging: LogConfig` config. The diagnostics module does
not override or interact with file logging config.

### 6. mod.ts (~80 lines)

**Purpose:** Entry point. Resolves config, initializes components, returns
hooks.

**Behavior:**

- Receives `DiagnosticsConfig` + `isProd` flag
- Merges built-in defaults with mode-specific overrides
- Initializes enabled components
- Returns hooks object for `aio.ts` to wire:
  ```ts
  {
    afterAction: (prevState, newState, action) => void    // state-diff + action-log (wired into dispatch.ts)
    onStart: (featureNames) => void                       // init feature tracking maps
    onStop: () => Promise<void>                           // flush action log + write final checkpoint (async)
    onError: (featureName: string) => void                // error counting per feature
    getRecoveredState: () => CheckpointData | null        // for app restore
    setHealthGetter: (fn) => void                         // wire registry.health() after features init
    uninstallCrashHandler?: () => void                    // cleanup on shutdown
  }
  ```
- **Note:** `onStop` is async — `aio.ts` shutdown sequence must `await` it. The
  existing `logger.onStop()` is sync, so `diagnostics.onStop()` runs first
  (async flush), then `logger.onStop()` (sync).

---

## Raw console.* Cleanup

### Scope

Route raw `console.log/warn/error` calls in these runtime files through `log.*`:

| File                 | Raw calls | Target                              |
| -------------------- | --------- | ----------------------------------- |
| `aio.ts`             | 7         | `log.warn`, `log.error`, `log.info` |
| `feature-compose.ts` | 14        | `log.warn`, `log.error`             |
| `feature-create.ts`  | 2         | `log.error`, `log.debug`            |
| `flow.ts`            | 3         | `log.error`, `log.warn`             |
| `feature-machine.ts` | 1         | `log.warn`                          |

### Excluded (keep console.*)

CLI tools and build scripts that run outside the aio app lifecycle:

- `build.ts`, `build-helpers.ts` — build output
- `am.ts` — app manager CLI
- `electron.ts` — electron launcher
- `standalone.ts` — standalone browser mode (no server)
- `browser.ts` — client-side (runs in browser, no file logger)
- `server.ts` — server lifecycle messages (live reload watcher)
- `error.ts` — `reportError()` console output (this IS the error pipeline, not
  bypassing it)
- `logger.ts` — fallback console + write errors (bootstrapping)

---

## Circuit Breaker Rolling Window

### Current behavior

```ts
circuitBreaker: { maxErrors: 5, onTrip: (name, count) => {} }
```

Counts errors since app start. 5 errors across a week = trip. Not useful.

### New behavior

```ts
circuitBreaker: { maxErrors: 10, window: 60_000, onTrip: (name, count) => {} }
```

- `window` (optional, ms): rolling time window for error counting
- When `window` is set: only count errors within the last `window` ms
- Implementation: ring buffer of error timestamps per feature, evict expired
  entries on each new error
- When `window` is omitted: current behavior (cumulative count, backward
  compatible)
- Error counting per feature is always on regardless of circuit breaker config —
  it feeds the health endpoint

### Error counting (always on)

Separate from circuit breaker auto-disable:

- Every feature tracks error count + error timestamps
- Exposed via `GET /__aio/health` and `registry.health()`
- Feeds into checkpoint data
- No config needed — built-in

---

## Integration with aio.ts

### Initialization sequence

1. Logger init (existing)
2. Diagnostics init (`diagnostics/mod.ts`) — receives isProd, config, logger ref
3. Crash handler install (immediate — before features)
4. Check for recovered checkpoint (before feature init)
5. If `onCheckpointRestore` callback provided and checkpoint exists → call it,
   use returned state
6. Feature init (existing — with recovered or fresh state)
7. Wire `afterAction` callback into `DispatchDeps` (state-diff + action-log)
8. Wire `onError` hook (error counting)
9. Start memory monitor (existing, wired through diagnostics config)
10. Start time-travel (existing, now respects diagnostics config for prod
    override)

### Shutdown sequence

1. `await` Diagnostics `onStop()` — async flush of action log + final checkpoint
   write
2. Logger `onStop()` (existing, sync)
3. Memory monitor `stop()` (existing)

---

## Testing Requirements

Each diagnostics component gets its own test file:

| File                    | Tests                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `state-diff_test.ts`    | No change detected, single field change, multiple fields, truncation, referential equality skip        |
| `action-log_test.ts`    | Append, skip internal actions, rolling truncation at max, empty payload                                |
| `checkpoint_test.ts`    | Write + read, atomic rename, corrupt file recovery, missing file, debounce timing, recovery data shape |
| `crash-handler_test.ts` | Handler installation, log output on unhandled rejection, emergency checkpoint write                    |
| `mod_test.ts`           | Config merge (dev defaults, prod defaults, overrides, false=off, true=on, options object)              |

## Documentation

New file: `docs/diagnostics.md`

Contents:

- What's on by default (zero-config story)
- Dev vs prod defaults table
- How to customize (`diagnostics: { dev: {...}, prod: {...} }`)
- Reading the log files (what's in each file)
- Checkpoint recovery (how to use recovered state)
- Circuit breaker config (rolling window)
- Crash handler behavior
- FAQ: "How do I enable time-travel in prod?" etc.

---

## Summary

| Component                   | Lines (est.) | Complexity                                           |
| --------------------------- | ------------ | ---------------------------------------------------- |
| `types.ts`                  | ~40          | Types only                                           |
| `state-diff.ts`             | ~50          | Pure function + log hook                             |
| `action-log.ts`             | ~60          | File I/O + rolling cap                               |
| `checkpoint.ts`             | ~60          | Debounced file I/O + atomic write + recovery         |
| `crash-handler.ts`          | ~30          | Global event listeners, runtime-guarded              |
| `mod.ts`                    | ~80          | Config merge + component wiring                      |
| `dispatch.ts` change        | ~5           | Add `afterAction` callback to `DispatchDeps`         |
| `feature-compose.ts` change | ~15          | `featureErrors` → timestamp array for rolling window |
| Console cleanup             | ~27 changes  | Mechanical replacement in 5 runtime files            |
| Tests                       | ~5 files     | Coverage for each component                          |
| Docs                        | 1 file       | `docs/diagnostics.md` user-facing guide              |

**Total new code:** ~340 lines + tests + docs **Risk:** Low — additive, no
breaking changes, all features opt-in or backward compatible
