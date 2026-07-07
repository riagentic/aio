# Upgrade: 1.0.0-alpha13 → 1.0.0-alpha14

Alpha14 applies the public-surface audit (roadmap A1,
`docs/specs/2026-07-04-public-surface-audit.md`). Breaking changes are
export-path and surface trims only — no runtime semantics changed.

## 1. Entry renames: `./src/build` → `./build`, `./src/am` → `./am`

Update your `deno.json` tasks:

```jsonc
// before
"am":              "deno run -A jsr:@riagentic/aio/src/am",
"compile:browser": "deno run -A jsr:@riagentic/aio/src/build --compile"
// after
"am":              "deno run -A jsr:@riagentic/aio/am",
"compile:browser": "deno run -A jsr:@riagentic/aio/build --compile"
```

Vendored projects (`aio create --vendored`) run file paths (`dep/aio/src/am.ts`,
`dep/aio/src/build.ts`) and are unaffected.

`aio/build` now exports `build(cfg?)` — importing it no longer runs a build as a
side effect. `aio/am` is a pure CLI entry with no library exports.

## 2. `aio/adapters/air` removed

Import the same hooks from `aio/air` instead:

```ts
// before
import { useAio, useConnected, useLocal } from "aio/adapters/air";
// after
import { useAio, useConnected, useLocal } from "aio/air";
```

(`useCell` was compat-only — use direct cell access: `counter.count`,
`counter.increment()`.)

## 3. `aio/air` surface trimmed (145 → 101 exports)

- **State moved to one obvious path:** `aio`, `cell`, `actions`, `effects`,
  `log`, `schedule`, `msg` are no longer re-exported from `aio/air` — import
  them from `aio`.
- **Protocol plumbing hidden:** all `_`-prefixed internals plus `bridge`,
  `client`, `matchPath`, `ensureConnected`, `setSyncMessageHandler` are gone
  from the public entry. If you used one, you were on internals — open an issue
  with the use case.
- Kept and now documented: `navigate`, `routePath`, `routeSearch`, `mount`,
  `Defer`, `connectDevTools`/`disconnectDevTools`, `connectAioDevTools`.
- `useTimeTravel` is now `@experimental`.

## 4. Stability tags (no code change needed)

- `aio/state-core`: whole entry `@experimental` (custom-transport authors).
- `aio/sync`: config-facing types stay stable (`SyncConfig`, `MergeStrategy`,
  `SyncConflict`, `SyncStatus`, `SyncStats`, `SyncOp`, `SyncReducer`,
  `SYNC_DEFAULTS`); engine internals are `@experimental`.
- `aio/db`: `WorkerRequest`/`WorkerResponse` (worker wire format) are no longer
  exported.
- `aio/air/compat`: `_resetHints` (test-only) removed from the public entry.

## 5. Additive

- `aio/testing` now also exports `testComponent`/`setDocument` — one import for
  all test APIs.
