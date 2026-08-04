/**
 * @module
 * Full-stack Deno framework — one state, propagated everywhere.
 *
 * ONE style: `cell({ state, methods })` — methods mutate a draft; async
 * methods do real work (await, until(), race()) and can be cancelled via
 * `cancelOn` + `s.$signal`. (the alpha27 restructure / perfect-aio D1: the legacy
 * actions/reduce/machine/generators layer was removed — see
 * docs/upgrade/restructure.md.)
 *
 * ```ts
 * import { aio, cell, race, until } from 'aio'
 *
 * const counter = cell('counter', {
 *   state: { count: 0 },
 *   methods: {
 *     increment(s, by = 1) { s.count += by },
 *   },
 * })
 *
 * const checkout = cell('checkout', {
 *   state: { status: 'idle', paid: false, orderId: null as string | null },
 *   cancelOn: { place: ['cart:clear'] },   // cart.clear aborts a running place()
 *   methods: {
 *     async place(s, item: string) {
 *       s.status = 'placing'
 *       // race a real branch against a deadline; until() polls LIVE state
 *       // (until's own timeout sits above the race's so the race decides)
 *       const r = await race({ paid: until(() => s.paid, { timeoutMs: 60_000 }), timeout: 30_000 })
 *       if (r.winner === 'timeout') { s.status = 'expired'; return }
 *       if (s.$signal.aborted) return        // cart.clear() ran while we waited
 *       s.orderId = await submitOrder(item)
 *       s.status = 'placed'
 *     },
 *   },
 * })
 *
 * await aio.run({ cells: [counter, checkout] })
 * counter.increment(5)       // direct call — dispatches through store
 * counter.count              // direct state read — reactive in components
 * await checkout.place('widget')
 * ```
 */
/** Framework core — `aio.run()` starts the app (see aio/extras for `lint`, `parseCli`) */
export { aio, VERSION } from "./src/server/aio.ts";
import type { AioApp } from "./src/server/aio.ts";
/** The running app instance returned by `aio.run()` — provides state access, dispatch, db, and lifecycle */
export type { AioApp };
/** Core configuration, error, and middleware types for `aio.run()` */
export type {
  AioError,
  AioUser,
  CellsConfig,
  PerfBudget,
  ResolveUserFn,
  UiConfig,
} from "./src/server/aio.ts";
/** Structured error code union (deep error detail types live in aio/extras) */
export type { AioErrorCode } from "./src/diagnostics/error.ts";
/** Memory monitor configuration and heap usage report types */
export type { MemoryConfig } from "./src/diagnostics/memory-monitor.ts";
/** Diagnostics configuration and checkpoint recovery types */
export type {
  DiagnosticsConfig,
  DiagnosticsOptions,
} from "./src/diagnostics/types.ts";
/** Vitals configuration (alert/threshold detail types live in aio/extras) */
export type { VitalsConfig } from "./src/vitals/types.ts";
/** Structured logger — `log.info()`, `log.warn()`, `log.error()`, `log.debug()` */
export { log } from "./src/diagnostics/logger.ts";
/** Logger configuration and level types */
export type { Log, LogConfig, LogLevel } from "./src/diagnostics/logger.ts";
/** Escalation for best-effort subsystems — `degraded("nft-cache").guard(fn)`
 *  reports once when an allowed-to-fail operation starts failing forever */
export { degraded, degradedReport } from "./src/diagnostics/degraded.ts";
/** Degraded-subsystem tracker type */
export type { Degraded } from "./src/diagnostics/degraded.ts";
/** Electron app metadata injected into the renderer process */
export type { AioMeta } from "./src/electron/electron.ts";
// slugify — internal (used by build.ts, not app code)

/** Bind a cell to an app instance; test a cell in isolation with testCell. */
export { bindCell, testCell } from "./src/state/cell.ts";
/** True inside a `worker: true` cell's worker (the app entry is re-imported
 *  there) — guard boot-time work in the entry with it. */
export { isCellWorker } from "./src/server/cell-worker-protocol.ts";
/** Define a cell — state + methods (+ selectors, sync, cancelOn). The atomic unit of aio. */
export { cell } from "./src/state/cell.ts";
/** Compose cells into a single dispatch/reduce/execute pipeline with dependency resolution. */
export { composeCells } from "./src/state/cell.ts";
/** Cell definition types — catalogs, compose, test context */
export type {
  Catalog,
  CellAio,
  CellDef,
  CellEntry,
  CellStatus,
  CircuitBreakerConfig,
  ComposedCells,
  DirectCalling,
  ExtractState,
  MethodsCellConfig,
  Msg,
  ScopedApp,
  SendOf,
  StateOf,
  TestContext,
} from "./src/state/cell.ts";

/**
 * Inter-cell coordination — async methods return Promises with the correct type.
 * Everything goes through the store (observable, time-travelable).
 *
 * Simple — preferred for most cases:
 * ```ts
 * const reserved = await inventory.reserve(items)  // direct calling
 * ```
 *
 * With timeout/retry:
 * ```ts
 * const result = await call({ timeout: 5000, retries: 2 }, () => inventory.reserve(items))
 * ```
 */
/** Wrap an inter-cell call with timeout and/or retry — `call({ timeout: 5000 }, () => f.method())`. */
export { call } from "./src/state/cell-impl.ts";
/** Method types for cell definitions — sync, async, call options */
export type {
  AsyncMethod,
  CallOptions,
  CellMethods,
  Method,
  SyncMethod,
} from "./src/state/cell-impl.ts";
/** Draft annotation for cancellation-aware async methods —
 *  `async place(s: State & Partial<MethodDraftMeta>) { … s.$signal … }` */
export type { MethodDraftMeta } from "./src/state/cell-impl.ts";

/**
 * Connect to a remote aio server from a CLI app.
 * Returns a CliApp with state, send, subscribe, close, connected, and ready.
 * @param url - WebSocket URL of the aio server (e.g., 'ws://localhost:8000/ws')
 * @param opts - Optional { token?: string } for auth
 */
// `connectCli` moved to `aio/server` (alpha37) — see the note on createDB below.
/** CLI client connection type — state, send, subscribe, close, ready */
export type { CliApp } from "./src/server/cli-client.ts";

/**
 * Declarative schedules — timers, intervals, cron jobs as effects.
 * @see {@link https://aio.dev/manual#scheduled-effects}
 */
// Async-method workflow helpers (perfect-aio D1 — the method-native
// replacements for generator ctx.waitFor / ctx.race / ctx.sleep).
/** Explicit server/client seam (perfect-aio B3) — define server functions in
 *  a *.server.ts module with serverFns(ns, fns); resolve them anywhere with
 *  serverFn<typeof def>(ns) (browser gets a typed WS proxy). */
export { serverFn, serverFns } from "./src/server/server-fns.ts";
export type { ServerFnAccess } from "./src/server/server-fns.ts";
/** Ergonomic HTTP routes: `:id` params, a method guard, cookies, and a JSON
 *  helper on top of the `routes: {}` config. `route((ctx) => ctx.json(...))`. */
export { route } from "./src/server/route.ts";
export type {
  CookieOptions,
  RouteContext,
  RouteOptions,
} from "./src/server/route.ts";
export type { CellAccess } from "./src/state/cell-types.ts";
export type { SessionInfo, SessionStore } from "./src/server/sessions.ts";
export type { AuthUserRecord, UserStore } from "./src/server/auth-users.ts";
/** Client-side auth API — login/signup/logout/me against /__aio/auth/*. */
export { authClient, createAuthClient } from "./src/browser/auth-client.ts";
/** Ambient caller identity — who is invoking the current cell method /
 *  serverFn / effect. undefined = anonymous or server-origin. */
export { serverUser } from "./src/server/auth-context.ts";
/** Ambient request context — WHERE the current call came from (client IP,
 *  headers, cookies). Read-only: to SET a cookie/status/header use `route()`.
 *  undefined = server-origin work (schedules, boot, internal dispatch). */
export { serverRequest } from "./src/server/auth-context.ts";
export type { ServerRequest } from "./src/server/auth-context.ts";
/** TOTP (2FA) primitives — for a fully hand-rolled 2FA UI/flow when the
 *  built-in <SignIn/> isn't enough. Enrollment: `generateTotpSecret`
 *  + `totpUri` (→ QR); verification: `verifyTotp`. */
export {
  generateTotpSecret,
  totpUri,
  verifyTotp,
} from "./src/server/auth-totp.ts";
export {
  race,
  sleep,
  until,
  type UntilOptions,
  UntilTimeoutError,
} from "./src/state/async-helpers.ts";
export { schedule } from "./src/state/schedule.ts";
/** Schedule definition and effect types for timers, intervals, and cron */
export type { ScheduleDef, ScheduleEffect } from "./src/state/schedule.ts";

/**
 * Keyed disposer slots — own native resources (watchers, sockets) from
 * reducers/methods with schedule-like replace semantics. Disposed on cell
 * disable and app shutdown.
 */
export { own } from "./src/state/own.ts";
/** Own effect type for keyed resource slots */
export type { OwnDisposer, OwnEffect, OwnResource } from "./src/state/own.ts";
/** Union of everything a method may return as an effect — use as the return
 *  annotation when a method references its own cell (breaks TS7022/7023). */
export type { CellEffect } from "./src/state/cell-impl.ts";

/**
 * SQLite column helpers for defining table schemas.
 * @see {@link https://aio.dev/manual#sqlite-persistence}
 */
export { integer, pk, real, ref, table, text } from "./src/server/sql.ts";
/** SQL schema and query types — column definitions, table schemas, where clauses */
export type {
  ColumnDef,
  ColumnOpts,
  QueryOpts,
  TableDef,
  WhereClause,
  WhereOp,
} from "./src/server/sql.ts";

/**
 * Async SQLite — Worker-backed, non-blocking.
 * `createDB` is for direct use; `app.db` is the instance managed by the framework.
 */
// SERVER-ONLY VALUES LIVE ON `aio/server` (alpha37).
//
// `createDB` opens SQLite in a Worker and `connectCli` pulls in CLI/UDS
// transport — neither exists in a browser bundle, and a static import of either
// from an isomorphic module (a cell, or a lib a cell imports) poisons the client
// graph and blank-screens the app at boot. Re-exporting them here made that
// mistake a one-character difference from correct code, so the boundary is now
// where the docs always said it would be:
//
//   import { createDB } from "aio/server";
//   import { connectCli } from "aio/server";
//
// `aiol --safe-fix` rewrites the old imports. The TYPES stay on this entry —
// they are erased at build time, so they can't poison anything, and keeping
// them spares every `DB`-typed signature a needless import change.
/** Database types — DB instance, options, query results, transaction handle */
export type { DB, DBOpts, QueryResult, Tx } from "./src/db/mod.ts";

/**
 * Memoized selectors for expensive state derivations.
 * Caches results until input selectors return new values.
 */
/** Memoized selector — recomputes only when input selectors return new values. */
export { createSelector } from "./src/selector.ts";
/** Selector type — a function from state to derived value with memoization. */
export type { Selector } from "./src/selector.ts";
