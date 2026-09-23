// Standalone AIR runtime — signal-based client-side dispatch loop for Android WebView builds
// Replaces standalone.ts when building with --android + renderer: "aio". Same API, no React.
import { applyCellDefaults, applyLocalFirst } from "./state/cell-defaults.ts";
import { type Draft, produce } from "immer";
import { msg } from "./state/msg.ts";
import type { Msg } from "./state/cell-types.ts";
import { deepMerge } from "./state/deep-merge.ts";
import {
  createDispatch,
  type PerfBudget,
  type PerfCheck,
} from "./state/dispatch.ts";
import {
  createAioError,
  reportError as reportAioError,
  type ReportErrorOpts,
} from "./diagnostics/error.ts";
import type { AioApp } from "./server/aio.ts";
import {
  createScheduleManager,
  createVirtualTimers,
  type ScheduleEffect,
} from "./state/schedule.ts";
import { log } from "./diagnostics/logger-api.ts";
import { createOwnManager, type OwnEffect } from "./state/own.ts";
import { routeEffect } from "./state/route-effect.ts";
import { Listeners } from "./state/listeners.ts";
import { signal } from "./state/signal.ts";
import { _setCallDeadlineClock, _setCallTimeouts } from "./state/cell-impl.ts";
import { _setSleepClock } from "./state/async-helpers.ts";
import { bindCell, bindCellReactive, type CellDef } from "./state/cell.ts";
import { _whileCellsBoot, makeUnboundGuard } from "./state/cell-catalog.ts";
import { composeCells } from "./state/cell-compose.ts";
import {
  buildDBStateGetter,
  persistingCellIds,
} from "./state/cell-persist-filter.ts";
import {
  _resetCellBindings,
  _resetCellRegistry,
  getRegisteredCells,
} from "./state/cell-reactive.ts";
import {
  _applyFullState,
  _resetSignals,
  getReadySignal,
} from "./state/state-signals.ts";
import {
  abortAllInflight,
  DRAIN_TIMEOUT_MS,
  endShutdownAbort,
  settlePending,
} from "./state/method-cancel.ts";
import { _setRouterBoot } from "./air/router.ts";
import { _installRouterListeners } from "./air/router-core.ts";
import { _setRouteBase } from "./air/router-core.ts";
import type { SignInProps } from "./browser/browser-auth-ui.ts";
import type {
  serverAuth as ServerAuth,
  serverRequest as ServerRequest,
  serverUser as ServerUser,
} from "./server/auth-context.ts";
import type { blocking as ServerBlocking } from "./state/blocking.ts";
import { blockingServerOnly } from "./state/blocking-reason.ts";
import { showDesktopNotification } from "./browser/desktop-notify.ts";
import { notifyPayload } from "./state/notify.ts";
import type { AioUser } from "./protocol/protocol-types.ts";

// Re-exports for user code
export { msg };

// ── The `aio/air` surface, on the android target ──────────────────────
//
// The android bundle maps BOTH "aio" and "aio/air" to this module
// (src/build/build-bundle.ts), so everything an app imports from `aio/air` has
// to be visible here — and has to be THE SAME symbol, never a second copy with
// a narrower contract. It used to be a handful of lifecycle hooks plus a
// private `useLocal` that lacked the documented tuple form and patch(): an app
// written to the docs built green for browser and electron and threw
// `useLocal(...) is not iterable` on android alone. tests/android-air-surface.
// test.ts pins the parity and enumerates what android deliberately omits
// (server transport, auth UI, the browser-history router, SSR/islands,
// devtools) — none of which exist in a standalone app.
//
// Everything below is renderer/signal code with no transport dependency, so
// re-exporting it costs the bundle nothing it does not use (esbuild tree-shakes
// from the app entry).
export {
  afterRender,
  type Context,
  createContext,
  hydrate,
  mount,
  type MountHandle,
  onCleanup,
  // Every target ships the SAME global-key binding: a shortcut that works on
  // desktop and silently does nothing on android is the twin hazard this file
  // already carries two notes about (useLocal, useAio).
  onGlobalKey,
  onMount,
  onUnmount,
  onWindowEvent,
  // aio-renderer's setDevMode is the one `aio/air` exports — it turns on the
  // renderer's dev checks AND forwards to vdom's flag.
  setDevMode,
  useContext,
  useContextSelector,
  useId,
  useOptimistic,
  useRef,
  useSignal,
} from "./air/aio-renderer.ts";
// A keyed resource you HOLD and the reaction that swaps it. Both are pure
// signal + DOM work with no transport in them, so android is no different —
// and an app whose camera stops being reopened on ANDROID ONLY is exactly the
// silent-on-one-target hazard the notes above describe.
export {
  type Dispose,
  onChange,
  type OnChangeOptions,
  type ResourceHandle,
  type ResourceKey,
  useResource,
  type UseResourceConfig,
} from "./air/use-resource.ts";
// ── Per-page <head> ───────────────────────────────────────────────────────
// `useHead` owns document.title and its meta/link tags while a component is
// mounted; `collectHead` is the SSR half — see air/head.ts.
export {
  collectHead,
  type HeadInput,
  type HeadTag,
  useHead,
} from "./air/head.ts";

export {
  type ComponentFn,
  ErrorBoundary,
  Fragment,
  h,
  lazy,
  type NodeAction,
  Portal,
  type Ref,
  renderToString,
  Suspense,
  type VChild,
  type VNode,
} from "./air/vdom.ts";
export {
  batch,
  type Computed,
  computed,
  effect,
  type Signal,
  signal,
  trackedMemo,
  untrack,
} from "./state/signal.ts";
// `log` — the same call an app makes on the server.
//
// A standalone/Android bundle is still the whole app: it holds the cells, the
// network code and the session logic, and every one of those has something
// worth saying when it goes wrong. `aio` and the browser build both export
// this; without it here, `import { log } from "aio"` — code that compiled on
// three platforms — fails to BUNDLE for the fourth, with an esbuild error that
// names the framework's internal module rather than the app's own import.
// The implementation is already used above; only the export was missing.
export { log } from "./diagnostics/logger-api.ts";
export type { Log } from "./diagnostics/logger-api.ts";

// The rest of the `aio` surface an app uses INSIDE a method, none of which
// needs a server — and every one of which failed to BUNDLE for android, with
// an esbuild error naming a framework internal, because this entry never
// re-exported them. `until` and `race` appear in mod.ts's own header example,
// so the documented spelling of an async method did not build for a shipped
// target. Each module below is dependency-light and Deno-free (the gate in
// tests/bundle-load-time-throw.test.ts holds them to that).
export {
  race,
  sleep,
  until,
  UntilTimeoutError,
} from "./state/async-helpers.ts";
export type { UntilOptions } from "./state/async-helpers.ts";
export { own } from "./state/own.ts";
export { notify } from "./state/notify.ts";
/** Present so an app compiles for android too; the WebView has no
 *  Notification API, so it resolves "unsupported" there and says so once. */
export { requestNotificationPermission } from "./browser/desktop-notify.ts";
export type { OwnEffect } from "./state/own.ts";
export { self } from "./state/self.ts";
export { call } from "./state/cell-impl.ts";
export { bindCell, composeCells } from "./state/cell.ts";
export { createSelector } from "./selector.ts";
export { degraded, degradedReport } from "./diagnostics/degraded.ts";

export { Show } from "./air/show.ts";
export { on, watch } from "./state/watch.ts";
export type { WatchOptions } from "./state/watch.ts";
export { useFieldArray, useForm } from "./air/form.ts";
export type {
  FieldArrayState,
  FieldState,
  FormState,
  ValidationRule,
} from "./air/form.ts";
export { useVirtualList } from "./air/virtual-list.ts";
// React's hook spellings, first-class on `aio/air` since 1.0.6-beta (also on
// `aio/air/compat`, unchanged). The first thing a React-trained developer or
// agent writes is `import { useState } from "aio/air"` — it did not compile.
export { useCallback, useEffect, useMemo, useState } from "./air/compat.ts";
export type {
  VirtualListConfig,
  VirtualListState,
} from "./air/virtual-list.ts";
export {
  Transition,
  type TransitionProps,
} from "./air/transition-component.ts";
export {
  TransitionGroup,
  type TransitionGroupProps,
} from "./air/transition-group.ts";
export {
  fade,
  scale,
  slide,
  type TransitionFn,
  type TransitionOptions,
  type TransitionResult,
} from "./air/transition.ts";
export {
  type SpringConfig,
  type SpringValue,
  useSpring,
} from "./air/animation.ts";
export { Defer, type DeferProps, type DeferTrigger } from "./air/defer.ts";
export { type Resource, resource } from "./air/resource.ts";
export { type DimensionsState, useDimensions } from "./air/dimensions.ts";
export { useInterval, useRaf } from "./air/raf.ts";
/** Auto-memo is built into the renderer — `memo()` is the identity function on
 *  every target, and exists so React-shaped code compiles unchanged. */
export { memo } from "./air/memo.ts";
/** Client-only reactive state. ONE implementation, shared with every other
 *  target — `{ local, set, patch }` and the preferred tuple form
 *  `const [v, setV] = useLocal(init)`. */
export { useLocal, type UseLocalResult } from "./adapters/air.ts";

// ── Router — routing is state, not transport ──────────────────────────
//
// The SAME components the browser entry ships (src/air/router.ts): a signal
// over `location` plus the history API, both of which a WebView has. The one
// runtime-shaped step — boot before the first route renders — is installed
// below (`_setRouterBoot(ensureConnected)`), and the packaged shell's
// "/assets/index.html" is adopted as the app's "/" at boot (`_adoptShellPath`).
export {
  Link,
  type LinkProps,
  navigate,
  NavLink,
  Outlet,
  page,
  Redirect,
  Route,
  routePath,
  type RouteProps,
  routeSearch,
  type RouteState,
  useNavigate,
  useRoute,
} from "./air/router.ts";
import { count } from "./diagnostics/fmt.ts";

// ── Islands — client-side framework interop, no server involved ───────
//
// `island()` mounts an external framework's component into a DOM container
// the AIR vdom leaves alone; `reactIsland()` is that with React's loaders.
// The android ledger used to call these "a server-rendered-page concern" —
// false: neither touches SSR or the transport (island.ts imports vdom, signal
// and the renderer hooks, nothing else), so a chart or an editor written as an
// island works in the WebView exactly as in the browser.
export { island, type IslandConfig, type IslandHandle } from "./air/island.ts";
export { reactIsland, type ReactIslandConfig } from "./air/react-island.ts";

// ── Auth UI — resolved to the anonymous branch ────────────────────────
//
// A standalone app has no server session: nothing issues a cookie, nothing
// answers /__aio/auth/*. The honest shape is NOT a `<SignIn/>` that refuses
// ("this app has no server to sign in to" is a dead end drawn on the screen),
// and NOT a missing export (an app shared between browser and android then
// dies at APK bundle time) — it is the same three names, resolving to the
// state every server-backed app also has for a signed-out visitor:
//
//   useUser()  → null   (resolved, anonymous — never `undefined`/loading)
//   <SignIn/>  → renders nothing, and says so ONCE on the console
//   signOut()  → resolves; there is no session to end
//
// so a component written as `user ? <App/> : <SignIn/>` renders the anonymous
// branch and the author learns why from the log, not from a crash. An app
// that needs real users on the phone builds with `--android --remote`.

let _signInHinted = false;

/** The current user — always `null` on a standalone build (no server session).
 *  @tier Kit */
export function useUser(): AioUser | null | undefined {
  return null;
}

/** Ends the session — there is none on a standalone build; resolves. */
export function signOut(): Promise<void> {
  return Promise.resolve();
}

/** Drop-in sign-in UI — renders nothing on a standalone build (no server
 *  session to sign in to) and says so once. Same props as the browser one, so
 *  a shared component type-checks on every target. */
export function SignIn(_props: SignInProps = {}): null {
  if (!_signInHinted) {
    _signInHinted = true;
    log.warn(
      "<SignIn/> on a standalone build renders nothing: this app has no " +
        "server session (useUser() is always null here). Build with " +
        "`--android --remote` to sign in against a server.",
    );
  }
  return null;
}

// ── Server-only names, as standalone facades that refuse when CALLED ──
//
// The SAME gap the browser entry closed (src/browser-air.ts, and
// tests/browser-server-only-stubs.test.ts), on the target that had it left:
// docs/auth/auth.md's `serverUser` example and docs/debugging/performance.md's
// `blocking` example import the name into a CELL MODULE, and the UI imports
// that module — so on android, where `aio` resolves to THIS file, the name has
// to resolve here or the whole APK bundle is refused:
//
//   ✘ [ERROR] No matching export in "src/standalone-air.ts" for import
//     "serverUser"
//
// …an esbuild error naming a framework internal, which reads as a broken
// install rather than as "this call needs a server". Exactly the shape
// tests/android-air-surface.test.ts exists to stop.
//
// None can be a re-export: auth-context.ts needs node:async_hooks, and
// blocking.ts's facade assignments (`blocking.cancel = …`) are statements
// esbuild keeps, which would pin the whole Deno worker pool inside the APK.
// Each facade is a pure-annotated const — 0 bytes unless the app uses it — and
// a CALL throws, naming the runtime it actually ran on. Never a silent
// `undefined`: a method replayed here that reads `serverUser()` as "anonymous"
// is an authorization check that passed because there was nobody to check.
// tests/android-server-only-stubs.test.ts pins both halves.
const serverOnly = (name: string) => (): never => {
  throw new Error(
    `[aio] ${name}() is server-only — it ran in a standalone build (the ` +
      `Android WebView), which has no server: nothing authenticated this ` +
      `call and no request is behind it. Move the check to a server the app ` +
      `talks to (build with \`--android --remote\`), or drop the call.`,
  );
};
export const serverUser: typeof ServerUser = /* @__PURE__ */ serverOnly(
  "serverUser",
);
export const serverRequest: typeof ServerRequest = /* @__PURE__ */ serverOnly(
  "serverRequest",
);
export const serverAuth: typeof ServerAuth = /* @__PURE__ */ serverOnly(
  "serverAuth",
);
/** `blocking` in a standalone build: the same refusal blocking.ts gives any
 *  runtime without Deno (blocking-reason.ts — it already names the WebView),
 *  with an inert cancel/dispose. There is never a pool here to cancel. */
export const blocking: typeof ServerBlocking = /* @__PURE__ */ Object.assign(
  (id: string): Promise<never> =>
    Promise.reject(new Error(blockingServerOnly(id))),
  {
    cancel: (_id: string): boolean => false,
    disposeIdle: (): boolean => true,
    dispose: (): Promise<void> => Promise.resolve(),
  },
);

/** Makes the packaged shell's document the app's route root. The android
 *  asset loader serves `…/assets/index.html`, so `location.pathname` starts
 *  there and `<Route path="/">` would never match; adopt its directory as the
 *  route base and rewrite the URL (no load) to `<dir>/`. A no-op wherever the
 *  document is already served from a directory (dev server, browser, tests).
 *  Exported for the test that pins it. */
export function _adoptShellPath(): void {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  const p = location.pathname;
  if (!/\/index\.html$/.test(p)) return;
  const base = p.slice(0, -"/index.html".length);
  history.replaceState(null, "", base + "/" + location.search + location.hash);
  _setRouteBase(base);
}

/** Extracts return types of all function members into a union */
export type UnionOf<T> = {
  // deno-lint-ignore no-explicit-any
  [K in keyof T]: T[K] extends (...args: any[]) => infer R ? R : never;
}[keyof T];

// WHY DUPLICATED: draft() is a copy of mod.ts draft(). standalone-air.ts can't import mod.ts
// because it IS the aio entrypoint for Android AIR builds (replaces browser-air.ts + mod.ts).
/** Immutable state update — mutate the draft, return effects */
export function draft<S, E>(
  state: S,
  fn: (d: Draft<S>) => E[],
): { state: S; effects: E[] } {
  let effects: E[] = [];
  const next = produce(state, (d) => {
    const result = fn(d);
    // Clone inside produce() while draft is still alive — after produce()
    // returns, Immer revokes draft proxies making state refs unreadable.
    effects = result.length ? structuredClone(result) : result;
  });
  return { state: next, effects };
}

// ── Internal state (singleton) ──

const _listeners = new Listeners<unknown>();
let _state: unknown = null;
/** THIS runtime's cell names — late-bound by `bootStandalone`, exactly like the
 *  server's `getCellNames`. `close()` aborts and waits for ITS OWN cells: the
 *  in-process harnesses can hold a server app in the same process, and one
 *  runtime shutting down must never cancel the other's methods mid-write.
 *  Undefined (a raw `initStandalone`, no cells) has nothing to scope. */
let _standaloneCells: Set<string> | undefined;
let _app: AioApp | null = null;

// Owned resources (`own.set`) acquired in this runtime. Lazily created so the
// module stays side-effect-free, and disposed by _resetState() so a test that
// boots cells and disposes the handle leaves nothing running.
let _own: ReturnType<typeof createOwnManager> | null = null;
function _ownManager(): ReturnType<typeof createOwnManager> {
  if (!_own) _own = createOwnManager(log);
  return _own;
}

// ── Virtual-clock scheduler (test/standalone) ──────────────────────────
// The REAL `createScheduleManager`, driven by a virtual clock: firing on the
// wall clock would be non-deterministic and dropping the effects would be
// untestable (a field report), so the clock is swapped — and NOTHING ELSE is.
//
// It used to be a second, hand-written scheduler living right here, and every
// rule it did not re-implement became a rule tests could not see:
// `Math.max(1, ms)` where production THROWS below 1 (`after`) and below 10
// (`every`), no id validation, `skipIfRunning` ignored, `at`/`cron` dropped
// with a once-per-process console warn. An `every` with a 5ms period and a
// spaced id was green in the harness and refused twice over in production — a test
// environment more permissive than production, the one thing CLAUDE.md
// forbids outright ("tests are the STRICTEST environment").
//
// `_advanceSchedules(ms)` moves the virtual clock, so a test can still drive
// toast auto-dismiss, debounce, backoff and poll deterministically.
let _clock: ReturnType<typeof createVirtualTimers> | null = null;
let _sched: ReturnType<typeof createScheduleManager> | null = null;
/** Virtual time is a TEST affordance and must be opted into. This runtime is
 *  also the REAL Android standalone runtime: with a virtual clock as the
 *  default, nothing in a shipped APK ever advanced it, so every `after`,
 *  `every`, `at` and `cron` was registered and then silently never fired —
 *  a dead timer with no error anywhere. The harness opts in (below); an app
 *  gets the platform's timers. */
let _wantVirtual = false;

/** Test-only: use a virtual clock so `advance(ms)` drives schedules
 *  deterministically. MUST be called before the first schedule is registered
 *  — after that the manager exists and its timer host is fixed. */
export function _useVirtualSchedules(): void {
  _wantVirtual = true;
  // The call ceilings run on the same virtual clock (as well as the real one):
  // `advance(40_000)` past a hung method's 30s ceiling gives up on it, as the
  // app would. See `_setCallDeadlineClock`.
  _setCallDeadlineClock(() => {
    _scheduler();
    return _clock;
  });
  // `sleep()` / `race`'s `timeout` too — `advance(10_000)` ends a method's
  // `await sleep(10_000)`, as it would have ended by then in the app. Real
  // time still counts as well. See `_setSleepClock`.
  _setSleepClock(() => {
    _scheduler();
    return _clock;
  });
}

/** Put the real `Date` back — set while the virtual clock is ahead of it. */
let _undoVirtualDate: (() => void) | null = null;

/** ONE clock for app code and the scheduler, while virtual time is on.
 *
 *  The scheduler's clock moved only on `advance`; `Date.now()` in the app did
 *  not move at all. So after `h.advance(10_000)`, a method scheduling
 *  `schedule.at(new Date(Date.now() + 5000))` was refused as FIVE SECONDS IN
 *  THE PAST, cron computed its next run from a time the app never saw, and a
 *  TTL checked against `Date.now()` never expired however far a test advanced.
 *  Against a real server all three simply work.
 *
 *  So while the clock is ahead, `Date.now()`, `new Date()` and `Date()` read
 *  real time plus the virtual time advanced — exactly what the scheduler reads
 *  (`createVirtualTimers({ wall })`). Time still FLOWS between advances, so a
 *  deadline loop in the harness or the app cannot freeze. Everything else on
 *  `Date` (`parse`, `UTC`, the prototype, `instanceof`) is the real one: a
 *  Proxy, not a subclass, so a Date made before the swap is still a `Date`.
 *  Installed on the first advance and removed on reset; `performance.now()`
 *  is not touched — it measures, it does not tell the time. */
function _installVirtualDate(skew: () => number): () => void {
  const Real = globalThis.Date;
  const now = () => Real.now() + skew();
  const Virtual: DateConstructor = new Proxy(Real, {
    construct(target, args, newTarget) {
      return Reflect.construct(
        target,
        args.length === 0 ? [now()] : args,
        newTarget === Virtual ? target : newTarget,
      );
    },
    apply: () => new Real(now()).toString(),
    get: (target, prop) => prop === "now" ? now : Reflect.get(target, prop),
  });
  globalThis.Date = Virtual;
  return () => {
    if (globalThis.Date === Virtual) globalThis.Date = Real;
  };
}

function _scheduler(): ReturnType<typeof createScheduleManager> {
  if (!_sched) {
    // The wall clock as it is NOW — a previous clock's swap is undone by
    // `_resetSchedules` before a new one is ever made.
    const Real = globalThis.Date;
    _clock = _wantVirtual
      ? createVirtualTimers(Real.now(), { wall: () => Real.now() })
      : null;
    _sched = createScheduleManager(
      // The manager AWAITS this to know when a tick settles (skipIfRunning)
      // and to see a rejection — so hand back the dispatch promise itself.
      (action) => Promise.resolve(_cellApp?.dispatch(action as Msg)),
      log,
      _clock ? { timers: _clock } : undefined,
    );
  }
  return _sched;
}

/** Advance the virtual clock by `ms`, firing every schedule that comes due —
 *  `after` once, `every`/`cron` re-arming, exactly as production would, with
 *  microtasks draining between fires the way a real turn of the loop does. */
export function _advanceSchedules(ms: number): Promise<void> {
  // The clock moves even when nothing is scheduled yet: `advance(60_000)` is
  // a minute passing, whether or not a timer was waiting for it.
  if (_wantVirtual) _scheduler();
  const clock = _clock;
  if (!clock) return Promise.resolve();
  if (ms > 0 && !_undoVirtualDate) {
    _undoVirtualDate = _installVirtualDate(() => clock.elapsed());
  }
  return clock.advance(ms);
}

/** Fire the schedules ALREADY DUE on the virtual clock — a `schedule.next`
 *  or `after(id, 0)`, which a real event loop runs right after the method
 *  returns. `null` when nothing is due, so a settle loop that calls this on
 *  every round adds no await (and no reordering of microtasks) to the rounds
 *  where there is nothing to fire. */
export function _fireDueSchedules(): Promise<void> | null {
  return _clock?.hasDue() ? _clock.advance(0) : null;
}

/** Reset the virtual clock + pending schedules (per-mount test isolation). */
export function _resetSchedules(): void {
  _sched?.cancelAll();
  _sched = null;
  _clock = null;
  const undo = _undoVirtualDate;
  _undoVirtualDate = null;
  undo?.();
}

// Signal for AIR reactivity — updated on every state change
const _stateSignal = signal<unknown>(null);

/** Notifies all subscribers and updates signal */
function _notify(): void {
  _stateSignal.set(_state);
  _listeners.notify(_state);
}

// ── Standalone config ──

type StandaloneConfig<S, A, E> = {
  reduce: (
    state: S,
    action: A,
  ) => { state: S; effects: (E | ScheduleEffect | OwnEffect)[] };
  execute: (app: AioApp<S, A>, effect: E) => void;
  persist?: boolean;
  persistKey?: string;
  persistDebounceMs?: number;
  /** WHAT of the state reaches the store — the composed app's per-cell
   *  `persist` filters. Omitted (a raw `initStandalone`, which has no cells to
   *  read a filter off) means the whole state, as before. The rule itself is
   *  `buildDBStateGetter` in `state/cell-persist-filter.ts`, THE one the
   *  server's persistence uses: a second copy here is how the two runtimes
   *  came to disagree about `persist: "none"` in the first place. */
  getDBState?: (state: S) => unknown;
  /** The cells whose slices may come BACK out of the store. The write-side
   *  twin of `getDBState`, from the same module, so a slice that can never be
   *  written can never be restored either — a blob left by an older build (or
   *  by a downgrade) must not refill a cell that asked for `persist: "none"`. */
  restorable?: Set<string>;
  perfCheck?: PerfCheck;
  perfBudget?: PerfBudget;
  freezeState?: boolean;
  onRestore?: (state: S) => S;
  /** Fires after each committed state change (cell-based standalone uses it to
   *  push the new state into per-cell reactive signals). */
  onCommit?: (state: S) => void;
};

const STORAGE_KEY = "aio_state";

/** The global an aio Android APK injects (`addJavascriptInterface`, see
 *  `AioNativeStore` in android-template's MainActivity.kt). Named once, here,
 *  so the Kotlin side and this side cannot drift apart silently. */
const NATIVE_STORE_GLOBAL = "AioNativeStore";

/** The shape the Kotlin bridge exposes. `set` answers whether the bytes
 *  reached the disk — a native store that could not write must not look like
 *  one that did. */
type NativeStoreBridge = {
  get(key: string): string | null;
  set(key: string, value: string): boolean;
  /** Is a value for this key ON DISK, whether or not `get` could read it?
   *  `get` returns null for "never written" AND for "written, and this read
   *  threw", and the adoption path below must not read one as the other.
   *  Optional: a bridge overlaid by an app's own `<app>/android/` may predate
   *  it, and a missing answer means the path behaves exactly as it did. */
  has?(key: string): boolean;
  describe(): string;
};

/** Where a standalone app's state is kept, and whether that store is done
 *  writing by the time `write` returns. */
/** Underscored deliberately: this type is reachable as `aio` INSIDE a
 *  standalone/Android bundle, but `check:api` snapshots only the public
 *  entries — so a bare name here would be public-looking surface with no
 *  instrument guarding it. The underscore says "internal" in the one place
 *  the gate cannot. */
export type _PersistStore = {
  /** `"native"` = the Android file store (durable), `"localStorage"` = the
   *  browser's (lazy), `"none"` = neither exists. */
  readonly kind: "native" | "localStorage" | "none";
  /** True when `write` returning means the bytes are on disk. */
  readonly durable: boolean;
  /** One line for the boot log — it names the store AND its durability, so a
   *  developer reading devtools/logcat can see which one this run picked. */
  readonly describe: string;
  read(key: string): string | null;
  write(key: string, value: string): void;
};

/** THE decider for "which store does this standalone runtime persist to".
 *
 *  Measured on an API 35 emulator (standalone APK, examples/counter): the
 *  WebView commits localStorage to disk lazily, so a SIGKILL 122 ms after a
 *  committed change restored the state from BEFORE it — the change was gone,
 *  with nothing said. At 933 ms the same change survived. Silent data loss,
 *  which is the one thing this project refuses outright.
 *
 *  So an APK ships a native store: a file written temp → fsync → atomic
 *  rename, durable before `set` returns (MainActivity.kt). The same bundle
 *  opened in a desktop browser has no such object and falls back to
 *  localStorage, which is all a preview can offer.
 *
 *  Pure: everything it inspects arrives in `g`, and the choice is RETURNED,
 *  never stashed — `initStandalone` holds the one instance and both the
 *  restore and the writes go through it, so no second copy of this decision
 *  can exist to disagree with the first.
 *
 *  @decider */
export function _pickPersistStore(g: {
  [NATIVE_STORE_GLOBAL]?: unknown;
  localStorage?: {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
  };
}): _PersistStore {
  const native = g[NATIVE_STORE_GLOBAL] as NativeStoreBridge | undefined;
  if (
    native && typeof native.get === "function" &&
    typeof native.set === "function"
  ) {
    let where = "";
    try {
      where = ` at ${native.describe()}`;
    } catch {
      // aio-ok: describe() only decorates the boot line with a path. An
      // overlaid bridge that omits it must not stop the app from booting on
      // the store that does work — and the line still names the store.
    }
    return {
      kind: "native",
      durable: true,
      describe: `native file store${where} (fsync + atomic rename on every ` +
        `change — a kill right after a change cannot lose it)`,
      read: (k) => {
        const v = native.get(k);
        if (typeof v === "string") return v;
        // ADOPT what the previous build wrote.
        //
        // Every standalone APK before this one persisted through
        // `localStorage`. Android keeps an app's data across an upgrade, so
        // after the user installs the new build their state is still on the
        // device — in the store this one no longer reads. Without this the
        // app would come up EMPTY on first launch after an upgrade: the
        // silent data loss this whole change exists to end, reintroduced by
        // the change itself.
        //
        // One-way and one-time: the value is copied into the durable store,
        // so the next boot is a plain native read. The old copy is left where
        // it is — it costs nothing and it is the only thing a downgrade could
        // fall back to. If the copy fails, the value is still RETURNED and
        // the failure is loud: running on the data beats losing it, and the
        // next boot simply tries again.
        const old = g.localStorage?.getItem?.(k);
        if (typeof old !== "string") return null;
        // …but ONLY into a store that is genuinely empty for this key.
        //
        // `native.get` answers null for "nothing written yet" AND for
        // "written, and this read failed" (MainActivity.kt catches the read
        // and logs it). Adopting on the second meaning is the worst outcome
        // this file has: the app's real state is on disk, intact, and the
        // pre-upgrade copy that `localStorage` still holds — forever, because
        // adoption never clears it — is written straight over it, and the
        // console says it succeeded. `has` is a stat, not a read, so it
        // separates the two; an older/overlaid bridge without it behaves
        // exactly as before, and a `has` that throws answers "present", which
        // is the side that overwrites nothing.
        let present: boolean;
        try {
          present = typeof native.has === "function" && native.has(k) === true;
        } catch {
          present = true; // it exists and could not tell — do not overwrite
        }
        if (present) {
          console.error(
            `[aio] ⚠ persistence: the native store HAS "${k}" on disk but ` +
              `could not read it back (see logcat, tag "aio"). REFUSING to ` +
              `adopt the older localStorage copy over it — that would ` +
              `replace this app's state with a snapshot from before it was ` +
              `upgraded. Nothing has been overwritten; restart the app.`,
          );
          return null;
        }
        try {
          if (native.set(k, old) === false) {
            throw new Error(`the native store refused the write`);
          }
          console.info(
            `[aio] persistence: adopted "${k}" from localStorage into the ` +
              `native store — this app was upgraded from a build that used ` +
              `localStorage, and its state has been moved to durable storage.`,
          );
        } catch (e) {
          console.error(
            `[aio] ⚠ persistence: found "${k}" in localStorage but could NOT ` +
              `copy it into the native store (${e}). Running on the ` +
              `localStorage copy for now — nothing is lost, but until this ` +
              `succeeds a kill right after a change can still lose it.`,
          );
        }
        return old;
      },
      write: (k, v) => {
        // `false` = the native side caught an IO error and already logged it.
        // Throwing here puts it in front of the developer twice rather than
        // letting a failed save look like a save.
        if (native.set(k, v) === false) {
          throw new Error(
            `the native store refused the write (see logcat, tag "aio")`,
          );
        }
      },
    };
  }
  const ls = g.localStorage;
  if (ls && typeof ls.getItem === "function") {
    return {
      kind: "localStorage",
      durable: false,
      describe: "localStorage (the host commits it to disk on its own " +
        "schedule — a crash within a second of a change can lose it)",
      read: (k) => ls.getItem(k),
      write: (k, v) => ls.setItem(k, v),
    };
  }
  return {
    kind: "none",
    durable: false,
    describe: "NONE — no native store and no localStorage on this host",
    read: () => null,
    write: () => {
      throw new Error(
        "no storage on this host (no native store, no localStorage)",
      );
    },
  };
}

/** Drop the slices of a restored blob that this app would never WRITE.
 *
 *  A cell declaring `persist: "none"` is filtered out of every write
 *  (`getDBState`), so nothing it owns can be on disk — unless an older build,
 *  or a downgrade, put it there. Restoring it then would hand the cell state
 *  it explicitly refused to keep, and on a machine where the app has not
 *  changed since the downgrade it would stay there for good. Same set, both
 *  directions. `undefined` (a raw `initStandalone`) restores everything, as
 *  before. */
function restorableOnly(
  persisted: unknown,
  restorable: Set<string> | undefined,
): unknown {
  if (!restorable || !persisted || typeof persisted !== "object") {
    return persisted;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(persisted as Record<string, unknown>)) {
    if (restorable.has(k)) out[k] = v;
  }
  return out;
}

/** Initializes standalone runtime — call before AIR mounts */
export function initStandalone<S, A, E>(
  initialState: S,
  config: StandaloneConfig<S, A, E>,
): AioApp<S, A> {
  const { reduce, execute } = config;
  const shouldPersist = config.persist !== false;
  // aio-ok(persist-decider): the ONE whole-state default — a raw initStandalone has no cells, so no filter exists; composed apps pass buildDBStateGetter below.
  const getDBState = config.getDBState ?? ((s: S) => s as unknown);
  const getUIState = (s: S) => s;
  const persistKey = config.persistKey ?? STORAGE_KEY;

  // ONE store for this runtime — chosen once, used by the restore below and
  // by every write. See _pickPersistStore.
  const store = _pickPersistStore(
    globalThis as unknown as Parameters<typeof _pickPersistStore>[0],
  );
  if (shouldPersist) {
    // Observable at boot: which store, and whether it is durable. A developer
    // who cannot see which one a run picked cannot reason about what a crash
    // costs. Reaches Android logcat too (chromium relays page console lines).
    console.info(`[aio] persistence: ${store.describe}`);
  }

  // Restore
  let state = initialState;
  if (shouldPersist) {
    try {
      const raw = store.read(persistKey);
      if (raw) {
        const persisted = restorableOnly(JSON.parse(raw), config.restorable);
        state = deepMerge(
          initialState as Record<string, unknown>,
          persisted as Record<string, unknown>,
        ) as S;
      }
    } catch (e) {
      console.warn(`[aio] restore from ${store.kind} failed:`, e);
    }
  }

  const _reportOpts: ReportErrorOpts = {
    onError: undefined,
    prod: true,
  };

  // onRestore — let user transform/validate restored state before UI renders
  if (config.onRestore) {
    try {
      state = config.onRestore(state);
    } catch (e) {
      const err = createAioError("HOOK_ERROR", e, { hookName: "onRestore" });
      reportAioError(err, _reportOpts);
    }
  }

  _state = getUIState(state);
  _stateSignal.set(_state);

  // Persistence. A DURABLE store writes on the spot; a lazy one is debounced.
  const persistMs = config.persistDebounceMs ?? 100;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let slowWriteWarned = false;
  /** Set once close() has written the final snapshot — see schedulePersist. */
  let finalWritten = false;

  function writeNow(what: string): void {
    // The final snapshot is the LAST write — the server's order too. The
    // cells' `:__destroy` teardown dispatches after close() still commit, and
    // on the durable store each one wrote straight through (a lazy store's
    // background flush did the same later): every clean close replaced the
    // app's state with its teardown state. Pinned by tests/hosts.test.ts.
    if (finalWritten) return;
    try {
      const t0 = Date.now();
      store.write(persistKey, JSON.stringify(getDBState(state)));
      // An fsync per change is the price of "a kill cannot lose it". If it
      // ever costs more than two frames, say so ONCE rather than let the app
      // feel mysteriously heavy: that is a state big enough to want
      // `persist: "none"` on a cell, not a store to give up on.
      const ms = Date.now() - t0;
      if (store.durable && ms > 32 && !slowWriteWarned) {
        slowWriteWarned = true;
        console.warn(
          `[aio] ⚠ a durable save took ${ms}ms — the whole state is written ` +
            `and fsync'd on every change, so this cost is paid per ` +
            `keystroke. Keep less of it: \`persist: "none"\` on a cell whose ` +
            `state need not survive a restart, or ` +
            `\`persist: { exclude: ["big"] }\` on the fields that need not.`,
        );
      }
    } catch (e) {
      // A save that did not happen is data loss, not a warning. It used to be
      // `console.warn`, which in a logcat flood reads like a note — and this
      // path got a NEW way to be reached when `getDBState` started running
      // the app's own `persist`/`onPersist` on this runtime: a shaper that
      // throws persists NOTHING, every change, for as long as the app runs.
      // The server answers that with a PERSIST_ERROR; this is the loudest
      // thing a page has, and it says what it costs.
      console.error(
        `[aio] ✗ ${what} to ${store.kind} FAILED — THIS CHANGE IS NOT SAVED ` +
          `and no later change will be either until this stops:`,
        e,
      );
    }
  }

  function schedulePersist(): void {
    if (!shouldPersist) return;
    // Durable store: write here, synchronously, so the change is on disk
    // before the dispatch that made it returns — there is no window left for
    // a kill to land in. Debouncing it would put one back.
    if (store.durable) {
      writeNow("persist");
      return;
    }
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      writeNow("persist");
    }, persistMs);
  }

  function flushPersist(): void {
    if (!shouldPersist) return;
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    writeNow("flush");
  }
  _cancelPersist = () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
  };

  // Belt and braces for the LAZY store only: the app going to the background
  // (Android pauses the WebView, a browser tab is hidden or closed) is the
  // last moment before a kill, so spend it flushing the pending debounce. A
  // durable store has nothing pending — every change was already written.
  //
  // The listeners are installed ONCE per process and dispatch through
  // `_flushPersist`, the same shape as `_cancelPersist` above: a page runs
  // initStandalone once, but a test file runs it dozens of times, and a
  // listener added per call would pile up stale closures writing stale state.
  _flushPersist = shouldPersist && !store.durable ? flushPersist : null;
  _installBackgroundFlush();

  const standaloneLog = {
    debug: (_: string) => {},
    // The level is in the line, not only in the console method — this output
    // is read in a terminal transcript as often as in devtools.
    warn: (msg: string) => console.warn(`[aio] \u26a0 ${msg}`),
    error: (msg: string) => console.error(`[aio] \u2717 ${msg}`),
  };

  const dispatch = createDispatch<S, A, E>({
    reduce,
    execute: (effect) =>
      // ONE exhaustive classifier for all three effect runtimes — a new
      // framework effect kind is a compile error here (see route-effect.ts).
      routeEffect<E>(effect, {
        // Schedule effects: hold on the virtual clock so tests can fire them
        // deterministically with ui.advance(ms) / handle.advance(ms).
        schedule: (e) => _scheduler().handle(e),
        // No server between the method and the page: show it right here.
        notify: (e) => showDesktopNotification(notifyPayload(e)),
        // Really acquire and dispose. Ignoring `own` here made the in-process
        // harnesses (testCell / testUI / bootCells) more permissive than
        // production — a leaked or misfiring resource could not surface in the
        // one place a test boots and disposes cells, converting a whole class
        // of bug into a production-only bug. Tests are the strictest
        // environment; a warning that says "ignored" is not strictness.
        own: (e) => _ownManager().handle(e),
        app: (e) => execute(app, e),
      }),
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {
      _state = getUIState(state);
      _notify();
      config.onCommit?.(state);
      schedulePersist();
    },
    log: standaloneLog,
    debug: false,
    reportOpts: _reportOpts,
    perfCheck: config.perfCheck,
    perfBudget: config.perfBudget,
    freezeState: config.freezeState ?? true,
  });

  const app: AioApp<S, A> = {
    dispatch,
    getState: () => state,
    // THE SAME four steps as `src/server/shutdown.ts` Phase 1, in the same
    // order, on the same budget: close the door, ABORT every in-flight async
    // method so a stream takes its own `s.$signal.aborted` path, WAIT for the
    // writes it makes on the way out, and only then write the snapshot.
    //
    // It used to close-and-flush in one breath, so the snapshot was the state
    // as of the instant close() was called and everything an in-flight method
    // still had to write rode on a debounce timer — in a process that is being
    // torn down. On Android close() IS the process ending, so that timer never
    // fires: the streamed reply was simply missing on the next launch, exactly
    // the report `tests/shutdown-inflight.test.ts` exists for. What close()
    // returns has to be what the next launch reads.
    close: async () => {
      dispatch.close();
      abortAllInflight(_standaloneCells, _standaloneAppId);
      try {
        // ONE deadline for both waits — two budgets would double the time the
        // window takes to disappear.
        const deadline = Date.now() + DRAIN_TIMEOUT_MS;
        const left = () => Math.max(1, deadline - Date.now());
        const stuck = await settlePending(
          left(),
          _standaloneCells,
          _standaloneAppId,
        );
        if (stuck > 0) {
          standaloneLog.warn(
            `close: ${count(stuck, "call")} still running at the ` +
              `${DRAIN_TIMEOUT_MS}ms deadline (slow write, or an ignored ` +
              `abort signal) — their remaining writes are lost`,
          );
        }
        await dispatch.drain(left());
      } catch (e) {
        standaloneLog.error(`close: drain — ${e}`);
      } finally {
        // The drain is over: a later app in this process (every sequential
        // test) may legitimately reuse these cell names.
        endShutdownAbort(_standaloneCells, _standaloneAppId);
      }
      flushPersist();
      finalWritten = true;
    },
    mode: "standalone",
  };

  // Test-harness seam: install a starting state before the first render, so a
  // test can pin the state a cell would otherwise get from the machine it runs
  // on (real telemetry, a device, the clock). Without it, a test of "what does
  // the UI do when there are two GPUs" either runs against whatever the
  // developer's box reports that second, or doesn't run — one field report
  // ended up asserting whichever branch the hardware chose. Not part of the app surface: `_seedState` is only reachable from the
  // harness, and it is a plain state install, not a dispatch, precisely because
  // it must look like "the app started this way".
  _seed = (partial: Record<string, unknown>): void => {
    const merged = { ...(state as Record<string, unknown>) };
    for (const [cellName, slice] of Object.entries(partial)) {
      merged[cellName] = {
        ...(merged[cellName] as Record<string, unknown> ?? {}),
        ...(slice as Record<string, unknown>),
      };
    }
    state = merged as S;
    _applyFullState(merged);
  };

  _app = app as AioApp;
  return app;
}

// ── AIR hooks (signal-based) ──

/** Connects to standalone dispatch loop. Signal-based — auto-tracked by AIR.
 *  @tier Core */
export function useAio<S = unknown>(): {
  state: S | null;
  send: (action: { type: string; payload?: unknown }) => void;
  /** Has a full state frame landed? On this target the runtime IS local, so
   *  it is true from the first commit — but the flag has to EXIST, or a
   *  component written against `useAio().ready` renders a spinner forever on
   *  android alone. Same twin hazard the `useLocal` note below records. */
  ready: boolean;
} {
  const state = _stateSignal.value as S | null;

  const send = (action: { type: string; payload?: unknown }) => {
    if (_app) _app.dispatch(action);
    else {console.warn(
        "[aio] \u26a0 not initialized — call initStandalone() before rendering",
      );}
  };

  return {
    state,
    send,
    get ready(): boolean {
      return getReadySignal().value;
    },
  };
}

// `useLocal` used to be re-implemented here — see the re-export above. The copy
// was missing the documented tuple form and patch(), so android alone threw on
// the spelling docs call preferred.

/** Resets module state — for testing only */
/**
 * Reset runtime STATE only (keeps the cell registry) — for hermetic testUI
 * mounts. Nulls `_cellApp` so the next runStandalone() re-composes from the
 * cells' pristine declared initials, and resets signal VALUES in place (stable
 * identity, so reactive getter closures see the reset). This is what makes each
 * mount start clean without dropping the module-singleton cells themselves.
 */
export function _resetState(): void {
  // The one-time <SignIn/> hint belongs to a runtime instance, so a fresh
  // mount (testUI resets before each) says it again.
  _signInHinted = false;
  // Destroy the booted cells FIRST, while the app and its signals are still
  // alive — onDestroy hooks may read state or dispatch (dispatch is
  // synchronous here, so everything commits before the teardown below).
  // Nulled before the call so a re-entrant reset cannot loop.
  const destroyCells = _destroyCells;
  _destroyCells = null;
  destroyCells?.();
  // …then the persist debounce: a pending timer outliving the app it
  // persisted for was a wakeup with nothing to do and the reason a finished
  // test (or a torn-down page) was still running. Cancelled, never flushed —
  // a test seeds localStorage and THEN resets, and a flush here would write
  // the previous app's state over the seed.
  const cancelPersist = _cancelPersist;
  _cancelPersist = null;
  cancelPersist?.();
  // …and the background-flush hook, for the same reason: the process-wide
  // listeners stay, but they must not reach a torn-down app's writer.
  _flushPersist = null;
  _state = null;
  _app = null;
  _cellApp = null;
  _standaloneCells = undefined;
  _stateSignal.set(null);
  _listeners.clear();
  _resetSignals();
  _resetCellBindings(); // release module-singleton cells so they re-bind
  _seed = null;
  _resetSchedules(); // reset the virtual clock + pending schedules
  // Dispose every owned resource this runtime acquired. `await using ui` /
  // `h.dispose()` must leave no watcher, socket or child process behind — and a
  // disposer that throws is exactly the defect a test should catch.
  if (_own) {
    _own.disposeAll();
    _own = null;
  }
}

/** Full reset — state AND the cell registry. */
export function _reset(): void {
  _resetState();
  _resetCellRegistry();
}

// ── Cell-based standalone runtime (AIO-404) ─────────────────────────
// The scaffolded app code (`cell()` + `aio.run()`) must work in Android
// WebView builds too: compose the cells, run the composed reducer through
// the local dispatch loop, bind cell methods to it. No server, no sync —
// persistence is localStorage via initStandalone.
//
// The generated client bundle mounts App.tsx directly and never executes the
// user's app.ts (which calls the *server* aio.run()). So on standalone the
// runtime boots from the cell registry — every `cell()` self-registers, and
// ensureConnected()/aio.run() compose + bind whatever has been defined.

let _standaloneAppId = "app";
let _cellApp: AioApp<Record<string, unknown>, Msg> | null = null;

// Set by the running standalone app (see `_seed` above); cleared on reset.
let _seed: ((partial: Record<string, unknown>) => void) | null = null;

// Tears down the booted cells (composed.destroyAll — onDestroy hooks + the
// `:__destroy` reset dispatches). Installed by bootStandalone, idempotent, and
// fired from BOTH exits: `app.close()` (the production Android path) and
// `_resetState()` (the harness dispose/re-mount path). Null when no cell
// runtime is up.
let _destroyCells: (() => void) | null = null;
/** The running app's persist-debounce cancel — a reset that drops the app
 *  drops the write its debounce still held (a reset is a discard, `close()`
 *  is the flush) instead of leaving the timer to fire into a runtime that no
 *  longer exists. Set per boot, cleared by `_resetState`. */
let _cancelPersist: (() => void) | null = null;
/** The current runtime's pending-write flush, or null when its store is
 *  durable (nothing can be pending) or persistence is off. */
let _flushPersist: (() => void) | null = null;
let _backgroundFlushInstalled = false;
/** One pair of listeners for the whole process — see the call site.
 *
 *  Registered on the objects that actually EMIT these events: a document for
 *  `visibilitychange`, a window for `pagehide`. Never on the bare global: Deno
 *  has `globalThis.addEventListener`, so sniffing for that method alone
 *  attaches two listeners to a server/CLI/test process that can never fire —
 *  a flush that looks installed and saves nothing, which is the same silent
 *  loss this whole file exists to remove. No document means no DOM means
 *  nothing to install. */
function _installBackgroundFlush(): void {
  if (_backgroundFlushInstalled) return;
  const g = globalThis as unknown as {
    window?: { addEventListener?: (t: string, f: () => void) => void };
    document?: {
      visibilityState?: string;
      addEventListener?: (t: string, f: () => void) => void;
    };
  };
  const doc = g.document;
  if (!doc || typeof doc.addEventListener !== "function") return;
  _backgroundFlushInstalled = true;
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "hidden") _flushPersist?.();
  });
  const win = g.window;
  if (win && typeof win.addEventListener === "function") {
    win.addEventListener("pagehide", () => _flushPersist?.());
  }
}

/** Install a starting state for the booted cells — harness only.
 *
 *  Throws when a key names no booted cell: a silently-ignored seed is a test
 *  that asserts against the developer's machine while looking like it pins a
 *  fixture, which is worse than no seeding at all.
 *  @internal */
export function _seedState(partial: Record<string, unknown>): void {
  if (!_seed) {
    throw new Error(
      "[aio] seed: no standalone app is running — seed after the cells boot",
    );
  }
  const known = Object.keys(
    (_cellApp?.getState() ?? {}) as Record<string, unknown>,
  );
  const unknown = Object.keys(partial).filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    throw new Error(
      `[aio] seed: no booted cell named ${
        unknown.map((u) => `"${u}"`).join(", ")
      }` +
        ` — booted cells: ${known.join(", ") || "(none)"}`,
    );
  }
  _seed(partial);
}

function bootStandalone(
  cells: CellDef[],
  opts: {
    appId?: string;
    persist?: boolean | string;
    onRestore?: (s: Record<string, unknown>) => Record<string, unknown>;
    circuitBreaker?: import("./state/cell-compose.ts").CircuitBreakerConfig;
    /** App-level defaults, applied exactly as `aio.run` applies them. */
    cellDefaults?: import("./state/cell-defaults.ts").CellDefaults;
    localFirst?: boolean;
    /** The app's own `perfBudget`. The in-process harnesses pass it through
     *  for the same reason they pass `cellDefaults`: a harness measuring
     *  against a budget the app does not use reports violations the app has
     *  already answered, and a suite full of known-false warnings teaches
     *  everyone to skim past the real ones. */
    perfBudget?: PerfBudget;
    /** The app's `effectTimeoutMs` — with `perfBudget.methods[m].timeout`,
     *  the ceiling `await cell.method()` gives up at. */
    effectTimeoutMs?: number;
  } = {},
): AioApp<Record<string, unknown>, Msg> {
  if (_cellApp) return _cellApp; // idempotent — first caller wins
  // THE SAME call ceiling the server sets at boot (aio.ts), from the same two
  // knobs. Nothing here set it, so on this runtime every method waited the
  // built-in 30 s whatever the app configured: a method budgeted at 300 ms
  // resolved after 800 under bootCells/testUI (and in the APK) and rejected
  // at 300 against a real server — a test green over a timeout the app
  // enforces. Set on every boot, so a previous boot's numbers never carry.
  _setCallTimeouts(
    opts.effectTimeoutMs,
    callTimeoutsOf(opts.perfBudget),
  );
  // `circuitBreaker` rides through exactly like the server composition
  // (aio-composition.ts) — an app that configures a breaker gets the SAME
  // auto-disable behaviour on Android and in the in-process harnesses.
  _standaloneAppId = opts.appId ?? "app";
  const composed = composeCells(cells, {
    ...(opts.circuitBreaker ? { circuitBreaker: opts.circuitBreaker } : {}),
    appId: _standaloneAppId,
  });
  // The same two passes the server boot makes (aio-composition.ts), so a
  // cell's visibility and sync are decided identically on every runtime.
  applyCellDefaults(composed, opts.cellDefaults);
  applyLocalFirst(composed, opts.localFirst === true);
  // Client-scoped cells own their signal state locally (bindCellReactive runs
  // their methods against the signal directly, bypassing the dispatch loop).
  // The composed reducer never updates their slice, so a blanket
  // _applyFullState on every commit would overwrite the client signal with
  // the stale initial slice — e.g. a `session` cell's signed-in member gets
  // wiped the moment any server cell dispatches. Skip them on commit.
  const clientCellIds = new Set(
    cells.filter((f) => f.__aio.scope === "client").map((f) => f.__aio.id),
  );
  const app = initStandalone<Record<string, unknown>, Msg, Msg>(
    composed.initialState,
    {
      reduce: composed.reduce,
      execute: composed.execute,
      persist: opts.persist !== false && opts.persist !== "none",
      persistKey: `aio:${opts.appId ?? "app"}`,
      // WHAT is written, and what may come back — the SAME rule the server's
      // persistence runs (state/cell-persist-filter.ts). Without it this
      // runtime wrote the whole composed state: a cell that said
      // `persist: "none"` was fsync'd to the phone's disk on every change and
      // restored on the next launch, while `deno task dev` dropped it — and
      // the durable store's own ">32ms save" advice ("mark it `persist`")
      // was inert on the one runtime that prints it.
      getDBState: buildDBStateGetter(composed) as (
        s: Record<string, unknown>,
      ) => unknown,
      restorable: persistingCellIds(composed),
      onRestore: opts.onRestore,
      perfBudget: opts.perfBudget,
      // push each committed state into per-cell signals so `counter.count`
      // reads (upgraded to reactive below) re-render the AIR tree. Skip
      // client-scoped cells — they own their signal state (see note above).
      onCommit: (s) => {
        if (clientCellIds.size === 0) {
          _applyFullState(s as Record<string, unknown>);
          return;
        }
        const filtered: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
          if (!clientCellIds.has(k)) filtered[k] = v;
        }
        _applyFullState(filtered);
      },
    },
  );
  // The callable surface is bound AFTER every cell's `__init` — the server's
  // order (aio-cells-bridge.ts runs `initAll` in onStart; the cells runner
  // binds afterwards). It used to be bound first, so `proj.bump()` straight
  // from an `onInit` worked under bootCells/testUI and threw "called before
  // the cell's runtime is booted" the moment the app itself started. Until
  // then each method is the SAME guard a never-booted cell has — installed,
  // not just left over, because a module-singleton cell still carries the
  // PREVIOUS boot's binding (a dead app's dispatch) after a reset.
  for (const f of cells) {
    const target = f as unknown as Record<string, unknown>;
    for (const key of f.__aio.actionKeys) {
      const raw = (f.__aio.actions as Record<string, unknown>)[key];
      if (typeof raw === "function") {
        target[key] = makeUnboundGuard(f.__aio.id, key, raw);
      }
    }
  }
  const bindAll = () => {
    for (const f of cells) {
      // bindCell: wrap methods to dispatch through the local loop
      bindCell(
        f,
        (action) => Promise.resolve(app.dispatch(action)),
        () => app.getState() as Record<string, unknown>,
      );
      // bindCellReactive (no sendFn): upgrade the state getters to read the
      // per-cell signal — keeps the bound methods from bindCell intact
      bindCellReactive(f);
    }
  };
  // A disabled cell must stop owning things — the same contract the server
  // runtime wires in `aio.ts` (`config._onScheduleReady`), which nothing wired
  // here: a cell the registry disabled kept its timers ticking and its
  // resources open in the harness while production cancelled and disposed them
  // by prefix.
  composed.registry.setOnDisable((prefix: string) => {
    _scheduler().cancelByPrefix(prefix);
    _ownManager().disposeByPrefix(prefix);
  });
  // seed the cell signals with the restored/initial state
  _applyFullState(app.getState() as Record<string, unknown>);
  // Late-bind the cell names so `close()` can scope its abort + drain to this
  // runtime's own cells (see `_standaloneCells`).
  _standaloneCells = new Set(composed.cellNames);
  _cellApp = app;
  // ── Cell lifecycle — the SAME contract as the server (aio-cells-bridge
  // onStart/onStop) and the worker host (cell-worker-host.ts): initAll at
  // boot, destroyAll on teardown. This used to be skipped entirely, so
  // `onInit`/`onDestroy` never ran on this runtime AND `setCbApp` stayed
  // unset — the circuit breaker could not TRIP in-process. testUI/testCell/
  // bootCells boot through here, which made the harness MORE permissive than
  // production (the one thing CLAUDE.md forbids outright).
  const lifecycleApp = {
    dispatch: (a: Msg) => void app.dispatch(a),
    getState: () => app.getState() as unknown,
  };
  // wires setCbApp, runs each cell's onInit — marked as booting exactly as the
  // server marks it, so an early call is refused with the server's words.
  _whileCellsBoot(cells, () => composed.initAll(lifecycleApp));
  bindAll();
  let destroyed = false;
  _destroyCells = () => {
    if (destroyed) return; // close() then _resetState() must not destroy twice
    destroyed = true;
    // The `:__destroy` dispatches ride the System-teardown exception in
    // dispatch.ts, so they still apply after `dispatch.close()` — exactly like
    // the server's onStop destroyAll.
    composed.destroyAll(lifecycleApp);
  };
  // Production Android path: close() drains in-flight work first (see
  // initStandalone), THEN the cells are destroyed — the worker-host ordering
  // (abort → settle → destroyAll).
  const innerClose = app.close;
  app.close = async () => {
    await innerClose();
    _destroyCells?.();
  };
  return app;
}

/** `perfBudget.methods[key].timeout` as the per-method map `_setCallTimeouts`
 *  takes — the same projection the server boot makes (aio.ts): only the
 *  methods that declare a numeric or `"warn"` timeout. */
function callTimeoutsOf(
  perfBudget: PerfBudget | undefined,
): Record<string, number | "warn"> | undefined {
  if (!perfBudget?.methods) return undefined;
  return Object.fromEntries(
    Object.entries(perfBudget.methods)
      .filter(([, v]) =>
        typeof v?.timeout === "number" || v?.timeout === "warn"
      )
      .map(([k, v]) => [k, v!.timeout as number | "warn"]),
  );
}

/** Standalone builds have no server — instead, boot the local runtime from the
 *  cell registry. Called by the generated bundle entry before mount, so cell
 *  methods are bound by the time the first component renders. Idempotent. */
export function ensureConnected(): void {
  if (_cellApp) return;
  const cells = [...getRegisteredCells().values()];
  if (cells.length) bootStandalone(cells);
}
// The router's "boot before the first route renders" step, on this runtime.
// Installed at load AND on every run (below): a process that has loaded the
// browser entry too (the test suite) must route to whichever runtime is live.
_setRouterBoot(ensureConnected);

type StandaloneRunConfig = {
  appId: string;
  appVersion?: string;
  cells?: CellDef[];
  persist?: boolean | string;
  onRestore?: (state: Record<string, unknown>) => Record<string, unknown>;
  circuitBreaker?: import("./state/cell-compose.ts").CircuitBreakerConfig;
  /** App-level defaults, applied exactly as the server's `aio.run` applies
   *  them — the in-process harnesses pass these through. */
  cellDefaults?: import("./state/cell-defaults.ts").CellDefaults;
  localFirst?: boolean;
  /** `ui` is mostly server-only here, but two keys DO reach a standalone
   *  shell — `theme` and `lang` — because the packaged HTML could not be told
   *  them at build time. See {@linkcode applyShellUi}. */
  ui?: Record<string, unknown>;
  // other server-only options (baseDir, port, schedules, …) are accepted and
  // ignored so one app.ts can serve both server and standalone builds
  [key: string]: unknown;
};

/** Standalone `aio.run()` — cell-based apps in WebView/Android builds.
 *  Composes the given cells (or the whole registry) and binds their methods to
 *  a local dispatch loop. Server-only config (ui, port, schedules, db) is
 *  ignored. Idempotent with ensureConnected(). */
/** The `<head>` half of `ui` a packaged shell could not be told at BUILD time.
 *
 *  The android/standalone shell is written before `aio.run()` exists, so it
 *  cannot know `ui.theme` or `ui.lang`. Both travel with the bundle instead:
 *  the shell ships the default look DISABLED (`media="not all"`, see
 *  `server-html-gen.ts`) and this enables it when the app actually asked for
 *  it. Without this, a scaffolded android app — whose template markup uses
 *  `.card` / `.row` / `.stack` — was themed under `deno task dev` and unstyled
 *  in its own APK, which is the WYSIDIWYSIP break the shells exist to prevent.
 *
 *  Observe-only and defensive: no document (a test, a worker) means nothing to
 *  do, and a shell without the deferred sheet is simply left alone. */
export function _applyShellUi(
  ui: Record<string, unknown> | undefined,
): void {
  if (!ui || typeof document === "undefined") return;
  const lang = typeof ui.lang === "string" ? ui.lang.trim() : "";
  if (lang) document.documentElement.lang = lang;
  // `ui.dir` travels the same way `ui.lang` does, and for the same reason: one
  // attribute flips the whole default UI, and the packaged shell is written
  // before the config exists. It reached NO target before this — the server's
  // own generators dropped it too — so an app shipping Arabic or Hebrew set
  // it, got no error, and stayed LTR everywhere.
  const dir = typeof ui.dir === "string" ? ui.dir.trim() : "";
  if (dir === "ltr" || dir === "rtl" || dir === "auto") {
    document.documentElement.dir = dir;
  }
  const theme = ui.theme;
  // `"none"` means no aio CSS on the page AT ALL — "not even the two-rule
  // box-model baseline… The switch for bringing an existing stylesheet, which
  // `border-box` on `*` would silently re-lay-out." The packaged shell cannot
  // know that at build time, so it emits the tokens sheet and this takes it
  // away — the APK used to apply `*{box-sizing:border-box}` to the one app
  // that asked it not to.
  if (theme === "none") {
    document.querySelector("style[data-aio-box-base]")?.remove();
    document.querySelector("style[data-aio-theme-base]")?.remove();
    for (const el of document.querySelectorAll("style[media='not all']")) {
      if (el.hasAttribute("data-aio-theme-deferred")) el.remove();
      if (el.hasAttribute("data-aio-theme-deferred-nolayout")) el.remove();
    }
    return;
  }
  if (theme !== "auto" && theme !== "full") return;
  // `ui.layout: false` picks the OTHER deferred sheet — the same visual look
  // without the page-layout defaults. One sheet meant the APK always enabled
  // the full-layout variant, so `{ theme: "full", layout: false }` laid the
  // page out inside its own APK after not doing so in `deno task dev`.
  const wantLayout = ui.layout !== false;
  const deferred = document.querySelector(
    wantLayout
      ? "style[data-aio-theme-deferred]"
      : "style[data-aio-theme-deferred-nolayout]",
  );
  if (!deferred) return;
  // `"auto"` steps aside for an app that ships its own stylesheet — the same
  // rule the server shell applies, asked at the one moment this runtime can
  // see the answer.
  const appCss = document.querySelector('link[rel="stylesheet"]');
  if (theme === "auto" && appCss) return;
  deferred.removeAttribute("media");
}

function runStandalone(
  cfg: StandaloneRunConfig,
): Promise<AioApp<Record<string, unknown>, Msg>> {
  _applyShellUi(cfg.ui as Record<string, unknown> | undefined);
  _adoptShellPath();
  _setRouterBoot(ensureConnected);
  _installRouterListeners();
  const cells = cfg.cells && cfg.cells.length
    ? cfg.cells
    : [...getRegisteredCells().values()];
  return Promise.resolve(
    bootStandalone(cells, {
      appId: cfg.appId,
      persist: cfg.persist,
      onRestore: cfg.onRestore,
      circuitBreaker: cfg.circuitBreaker,
      cellDefaults: cfg.cellDefaults,
      localFirst: cfg.localFirst,
      perfBudget: cfg.perfBudget as PerfBudget | undefined,
      effectTimeoutMs: cfg.effectTimeoutMs as number | undefined,
    }),
  );
}

/** Standalone counterpart of the server `aio` namespace. */
export const aio: { run: typeof runStandalone } = { run: runStandalone };

/** Define a cell — works identically in standalone builds; methods dispatch
 *  through the local loop instead of a server connection. */
export { cell } from "./state/cell.ts";
// `schedule` — Deno-free since alpha70 (the worker pool left it); `blocking`
// stays server-only and refuses by name here.
export { schedule } from "./state/schedule.ts";

// ── Unit formatters ───────────────────────────────────────────────────
// The standalone (Android WebView / no-server) half of `aio`'s
// `bytes`/`dur`/`count` (mod.ts). Pure and isomorphic — a real re-export of
// the one implementation, never a stub — because a symbol that exists on
// `aio` everywhere and vanishes on one target is an app that builds fine and
// fails to BUNDLE only there (tests/android-air-surface.test.ts).
export { bytes, count, dur } from "./diagnostics/fmt.ts";

// ── Failure codes ─────────────────────────────────────────────────────
// `errorCode(e)` is the ONE documented way to branch on WHY an awaited call
// failed (mod.ts), and a standalone app catches rejections exactly like a
// browser one. It reads a `.code` off the thrown value and imports nothing
// but a type, so there is no reason for it to stop at the WebView — and every
// reason not to: a `catch` block that compiles for three targets must not be
// the thing that fails to bundle for the fourth.
export { errorCode } from "./protocol/envelope.ts";
