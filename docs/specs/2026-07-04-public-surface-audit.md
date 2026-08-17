# Public-surface audit (roadmap A1)

Date: 2026-07-04 · Basis: `deno doc --json` over all 14 `deno.json` exports ·
~440 export declarations total.

Verdicts: **keep** (1.0 stable) · **fix-doc** (keep, add jsdoc) · **hide** (stop
exporting from the public entry; internals import via `src/` paths) · **delete**
(remove entry/export) · **@experimental** (exported, excluded from the 1.0
stability guarantee).

Rule adopted: `_`-prefixed names are never part of the public surface. Any that
must stay exported for cross-module wiring move behind non-public paths or get
`@internal` and are stripped from the API snapshot (A2).

---

## Verdict summary

| entry          | exports | verdict                                                        |
| -------------- | ------- | -------------------------------------------------------------- |
| `.` (mod.ts)   | 147     | keep · 3 `_`-types → `@internal` · fix-doc 5                   |
| `air`          | 145     | **worst offender**: hide ~30 `_`-internals, fix-doc ~15        |
| `air/compat`   | 6       | keep per A5 decision · hide `_resetHints` · fix-doc hooks      |
| `jsx-runtime`  | 5       | keep as-is (required JSX shape)                                |
| `adapters/air` | 6       | **delete entry** (superseded compat layer)                     |
| `state-core`   | 33      | **@experimental** entry (custom-transport authors only)        |
| `db`           | 11      | keep · hide `WorkerRequest`/`WorkerResponse`                   |
| `sync`         | 38      | trim to ~8 config-facing · rest **@experimental**              |
| `testing`      | 2       | keep · consider re-exporting `testComponent` here              |
| `schedule`     | 8       | keep · `createScheduleManager` → `@internal`                   |
| `selectors`    | 9       | keep                                                           |
| `src/build`    | 0       | **broken**: script w/ top-level await, lying jsdoc — rework    |
| `src/am`       | 23      | **delete from exports** (CLI internals, not a library surface) |
| `aiol`         | 5       | keep                                                           |

---

## Per-entry findings

### `.` (mod.ts) — 147

- [x] **keep (bulk)**: `aio`, `cell`, `call`, `actions`, `log`, `schedule`,
      `own`, `createDB` + column DSL (`table`, `pk`, `integer`, `real`, `text`,
      `ref`), `testCell`, `createSelector`, `createSliceSelector`, `markAsync`,
      `matchEffect`, `deepFreeze`, `draft`, `bindCell`, `composeCells`,
      `composeMiddleware`, `instances`, `lint`, `parseCli`, `connectCli`,
      `connectCliUDS`, `resolveAppId`, `AioError`, `VERSION`, `DEFAULT_PRAGMAS`,
      all documented type aliases.
- [x] **@internal**: `_CellBuiltins`, `_InferSend`, `_InferState` — needed for
      type inference, excluded from snapshot/stability guarantee.
- [x] **fix-doc**: `own` (re-export lost jsdoc), undocumented overloads of
      `actions` / `call` / `cell` / `createSelector`, `effects` reference.

### `air` — 145

- [x] **hide**: replace `export * from "./browser-air.ts"` (src/air.ts:17) with
      named exports. Leaked internals (consumed only by `src/*` + tests):
      `_coreGetState`, `_coreHandleMessage`, `_coreHasState`, `_coreResendSubs`,
      `_coreSetConnected`, `_coreSetTransport`, `_resolveStateReady`,
      `_subscribe`, `_useAioSubscribe`, `_waitForState`, `_setClientSend`,
      `_setConnectFn`, `_setTeardownFn`, `_setSubscribeTriggers`,
      `_checkStateIntegrity`, `_collapsePaths`, `_incStateVersion`,
      `_memoCompare`, `_projectWithSharing`, `_resetTracking`, `_trackingProxy`,
      `_accessedPaths`, `_BLOCKED_KEYS`, `_shallowEqual`, `_preserveArrayRefs`,
      `_getArrayRefStats`, `_resetArrayRefStats`, `_checkWastedRenders`, `_w`.
      Internal consumers import from `./browser-air.ts` directly; tests
      likewise.
- [x] **fix-doc or hide**: `Defer`/`DeferProps`, `bridge`, `mount`, `navigate`,
      `matchPath`, `msg`, `client`, `ensureConnected`,
      `connectDevTools`/`disconnectDevTools`/`DevToolsHandle`, `useTimeTravel`,
      `MountHandle`, `RenderEvent`, `ComponentTreeNode` — each is either a real
      public API (→ document) or plumbing (→ hide). Suggested: document `Defer`,
      `navigate`, `mount`; hide the rest; `useTimeTravel` → `@experimental`.
- [x] **decide duplication**: `aio`, `log`, `schedule`, `cell`, `actions`
      re-exported from `air` (NODOC) duplicate `.` — either document as the
      intended browser-side import or drop and require `from "aio"`.
      Recommended: drop (one obvious import path).
- [x] **fix-doc**: NODOC interfaces backing documented hooks (`FormState`,
      `FieldState`, `FieldArrayState`, `VirtualListConfig`, `VirtualListState`,
      `LinkProps`, `RouteProps`, `RouteState`, `ValidationRule`,
      `DeferTrigger`).
- [x] **keep**: components (`Show`, `Route`, `Link`, `NavLink`, `Outlet`,
      `Redirect`, `Transition`, `TransitionGroup`, `ErrorBoundary`, `Suspense`,
      `Portal`, `Fragment`), signals (`signal`, `computed`, `effect`, `batch`,
      `untrack`, `memo`), hooks (`useRaf`, `useRef`, `useSignal`, `useLocal`,
      `useForm`, `useFieldArray`, `useSpring`, `useVirtualList`,
      `useDimensions`, `useOptimistic`, `useProjection`, `useId`,
      `useContext`/`useContextSelector`, `useNavigate`, `useRoute`, `useAio`,
      `useConnected`), lifecycle (`onMount`, `onCleanup`, `afterRender`), SSR
      (`renderToString`, `renderToStream`, `hydrate`, `island`, `page`, `lazy`),
      test harness (`testComponent`, `setDocument`), transitions (`fade`,
      `scale`, `slide`), `resource`, `on`, `watch`, `createContext`,
      `connectAioDevTools`, documented types.

### `air/compat` — 6

- [x] **A5 decision applies** (permanent vs removed at beta1) — decided
      2026-07-06: **permanent** (module doc records it). If kept:
- [x] **fix-doc**: `useState`, `useEffect`, `useMemo`, `useCallback` (all
      NODOC).
- [x] **hide**: `_resetHints` (test-only reset).

### `jsx-runtime` — 5

- [x] **keep**: `jsx`, `jsxs`, `Fragment`, `JSX` namespace, `AirEvent` — shape
      mandated by the JSX transform.

### `adapters/air` — 6 → **delete**

- [x] Self-described "backward compat" layer; every hook (`useAio`, `useCell`,
      `useConnected`, `useLocal`) duplicates `aio/air`. React adapter was
      removed in alpha12; this is the same era. Delete the export + entry before
      beta1; migration note: import from `aio/air`.

### `state-core` — 33 → **@experimental**

- [x] Transport/protocol plumbing for custom-client authors (`Transport`,
      `AioIPC`, `setTransport`, `send`, `ready`, `handleMessage`, …) plus
      `_`-internals. Real use case (electron/CLI clients) but the API is not
      1.0-freeze material. Mark the whole entry `@experimental` in docs +
      snapshot; hide the `_`-prefixed subset outright.

### `db` — 11

- [x] **keep**: `createDB`, `DB`, `DBOpts`, `Tx`, `QueryResult`,
      `DEFAULT_PRAGMAS`, `initSchema`, `loadTables`, `syncTables`.
- [x] **hide**: `WorkerRequest`, `WorkerResponse` (worker wire format).

### `sync` — 38

- [x] **keep (config-facing ~8)**: `SyncConfig`, `MergeStrategy`,
      `SyncConflict`, `SyncStatus`, `SyncStats`, `SyncOp`, `SyncReducer`,
      `SYNC_DEFAULTS`.
- [x] **@experimental**: engine internals (`createSyncEngine`,
      `createServerSyncHandler`, `createOpBuffer`, `persistOp`, `loadOpsSince`,
      `compactSyncOps`, `rebase`, `mergeField`, HLC suite, `OpBuffer*`, `*Deps`,
      wire messages). Real but unfrozen.

### `testing` — 2

- [x] **keep**: `testCell`, `TestContext`.
- [x] **consider**: re-export `testComponent`/`setDocument` here so all test
      APIs share one import (additive, non-breaking — may also wait post-1.0).

### `schedule` — 8

- [x] **keep**: `schedule`, `ScheduleDef`, `ScheduleEffect`, `isScheduleEffect`,
      `parseCron`, `nextCronTime`, `CronFields`.
- [x] **@internal**: `createScheduleManager` (runtime wiring).

### `selectors` — 9

- [x] **keep**: `createSelector`, `createSliceSelector`, `Selector`.
- [x] **fix-doc**: undocumented `createSelector` overload.

### `src/build` — 0 exports → **broken entry**

- [x] Top-level-await **script**: importing it runs a build; jsdoc advertises
      `import { build }` which does not exist. Rework: wrap in exported
      `build(cfg?)`, keep a thin `if (import.meta.main)` runner, and rename the
      export path `./src/build` → `./build`.

### `src/am` — 23 → **delete from exports**

- [x] Process-manager CLI internals (`readPid`, `writePid`, `out`, `outError`,
      `parseGlobalFlags`, `resolve*`, …). Users run `aio am`, they don't import
      it. Remove the `./src/am` export (keep the file as CLI entry). If a
      programmatic API is ever wanted, design it post-1.0.

### `aiol` — 5

- [x] **keep**: `lint`, `Issue`, `Report`, `Severity`, `SafeFixFn`.

---

## Cross-cutting

- [x] **Export-path style**: `./src/build`, `./src/am` are the only path-shaped
      names → `./build` (am's entry removed). Breaking; do in alpha.
- [x] **Duplication policy**: `.` re-exports `db`/`schedule`/`selectors`/
      `testing` symbols. Keep (convenience root) but the snapshot must treat
      each entry independently.
- [x] **After cuts land**: regenerate `deno doc --json` snapshot → this becomes
      the A2 gate baseline. (Done: `docs/api-snapshot.json`, CI-enforced via
      `deno task check:api`.)

## Applied 2026-07-06 — deviations from the recommendations

All verdicts applied except the following, each deviating for a provable reason
(checked items above reflect what actually shipped):

- **`MountHandle`, `DevToolsHandle`, `RenderEvent`, `ComponentTreeNode` kept
  (documented), not hidden** — referenced by the signatures of kept APIs
  (`mount`, `connectAioDevTools`); hiding them breaks JSR private-type-ref
  linting and leaves users unable to name return types.
- **`connectDevTools` / `disconnectDevTools` kept (documented), not hidden** —
  Redux DevTools integration is a documented user feature
  (`docs/ui/air-lifecycle.md`).
- **`routePath` / `routeSearch` kept (documented)** — signal-based routing is
  documented user surface (`docs/ui/air-comparison.md`).
- **state-core `_`-subset kept exported with `@internal` tags** instead of moved
  — 11 internal/test import sites; the audit's own rule (`@internal` + stripped
  from the A2 snapshot) applies.
- **`./src/am` replaced by a runnable zero-export `./am` entry** instead of full
  removal — `deno run -A jsr:@riagentic/aio/am` tasks (quickstart jsr flow) need
  an export path to run. All 23 symbol exports removed; `parseGlobalFlags` moved
  to `am-utils.ts`.
- **`src/adapters/air.ts` file retained as internal implementation** (it backs
  `browser-air-hooks.ts`); only the `./adapters/air` export entry was deleted.
- **`testing` re-export of `testComponent`/`setDocument` done now** (additive).
- `air` public surface after the cut: **101 documented symbols** (was 145, zero
  `_`-leaks, zero NODOC) — enforced by `tests/air-entry.test.ts`.

## Estimated impact

- Hidden/deleted: ~60 declarations (~14% of surface) — all internals, zero
  documented-user breakage expected except `adapters/air` + `./src/am` imports
  (upgrade note each).
- Doc-fixed: ~25 declarations.
- `@experimental`: `state-core` (33) + sync internals (~30).
- Frozen 1.0 surface after audit: ~320 documented declarations.
