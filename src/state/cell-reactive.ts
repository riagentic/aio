// cell-reactive.ts — browser-side reactive cell binding
//
// Installs signal-backed getters on cell defs so that reading
// counter.count in a component auto-tracks and re-renders.
// Called from ensureConnected() for all registered cells.

import type { AccessUser, CellDef, CellFieldFilter } from "./cell-types.ts";
import { randomUuid } from "../rand.ts";
import { attachMeta } from "./cell-catalog.ts";
import { _cellSignals, getCellSignal } from "./state-signals.ts";
import { ackMethodKey } from "../protocol/ack-registry.ts";
import {
  context,
  contextNote,
  SIDE,
  WHERE_HINT,
} from "../diagnostics/contexts.ts";
import { _ackSink } from "./ack-sink.ts";
import { trackPath } from "./state-subs.ts";
import { CLIENT_ONLY_SUB } from "../protocol/broadcast-utils.ts";
import { nameIsTaken } from "./cell-helpers.ts";
import {
  applyCellFieldFilter,
  deepExcludePaths,
  uiKeyVisibility,
} from "./state-filter.ts";
import { log } from "../diagnostics/logger-api.ts";
import { unregisterCancelOn } from "./method-cancel.ts";

// ── Cell registry ────────────────────────────────────────────────────
// Every cell() call registers here. Browser binding iterates this set.

const _cellRegistry = new Map<string, CellDef>();

/** Register a cell for reactive binding. Called by cell() at creation time.
 *  Same-id re-registration is allowed (HMR re-imports the module and re-runs
 *  cell()), but in dev mode a duplicate name warns loudly — two modules both
 *  defining `cell("counter", …)` would otherwise silently kill the first
 *  definition with no warning. The composeCells duplicate check only catches
 *  the case where both are passed explicitly to `aio.run({ cells })`; this
 *  catches the import-time registration overwrite. */
export function registerCell(def: CellDef): void {
  const id = def.__aio.id;
  if (
    _cellRegistry.has(id) &&
    (globalThis as Record<string, unknown>).__aioDev === true
  ) {
    // HMR re-import produces an identical def — only warn when the new def
    // differs from the registered one (genuine conflict, not hot reload).
    const existing = _cellRegistry.get(id);
    if (existing !== def) {
      log.warn(
        `duplicate cell name '${id}' — cell() called twice with this ` +
          `name. The previous definition is being replaced. If this is HMR, ` +
          `ignore; if two modules define the same cell name, rename one.`,
      );
    }
  }
  _cellRegistry.set(id, def);
}

/** Get all registered cells. */
export function getRegisteredCells(): ReadonlyMap<string, CellDef> {
  return _cellRegistry;
}

/** Clear registry (test isolation). */
export function _resetCellRegistry(): void {
  _cellRegistry.clear();
}

/**
 * Clear per-cell binding state so registered cells can re-bind to a fresh app
 * on the next mount — WITHOUT dropping the registry. Cells are module
 * singletons that bind once ("already bound" guard); a hermetic re-mount must
 * release them so their methods/getters rewire to the new runtime.
 */
/** Release ONE app's cells so they can bind again — what `app.close()` calls.
 *
 *  A cell def binds to exactly one app (perfect-aio D2), and that guard used to
 *  outlive the app: two `testServer()` blocks in one test file failed with
 *  "[cell] already bound" even with `await using`, forcing the second test into
 *  a file of its own for no reason a reader could see. A closed app
 *  owns nothing, so its claim ends with it. Scoped to the given cells, so a
 *  second app running in the same process keeps its own bindings. */
export function _releaseCellBindings(
  defs: Iterable<CellDef>,
  appId = "",
): void {
  for (const def of defs) {
    (def.__aio as Record<string, unknown>).bound = false;
    _reactivelyBound.delete(def);
    // A cancelOn trigger is a claim on THIS binding's in-flight calls, so it
    // ends with the binding. It used to outlive it: the registry only ever
    // grew, and the next app to use the same cell name inherited a dead app's
    // triggers. `cell-compose` re-registers on every compose, so a re-bind
    // gets them all back.
    unregisterCancelOn(def.__aio.id, appId);
  }
}

export function _resetCellBindings(): void {
  for (const def of _cellRegistry.values()) {
    (def.__aio as Record<string, unknown>).bound = false;
    _reactivelyBound.delete(def);
    unregisterCancelOn(def.__aio.id); // a full reset: every app, the claim ends with the binding
  }
}

// ── Reactive binding ─────────────────────────────────────────────────

const _reactivelyBound = new WeakSet<CellDef>();

// ── Client-side ui visibility ───────────────────────────────
// bindCellReactive IS the client read surface — it runs only in browser /
// standalone (electron, android, testUI) contexts, never on a pure server.
// Enforcing `ui:` visibility here gives ONE seam for both runtimes: over WS
// the server already filters at broadcast time; locally (standalone) there is
// no broadcast, so without this every "secret" was fully readable on the cell
// object. A read of a hidden field THROWS, in dev and prod alike (see
// `reportHiddenRead`) — never a quiet `undefined`. Server-side reads
// (routes/effects — bound via bindCell) see everything, by design.

/** A client read of a field the cell hides THROWS — in every context, dev
 *  and prod alike.
 *
 *  It used to warn (everywhere), then throw in dev and warn-once + return
 *  `undefined` in prod. Neither half-measure held: a warning does not stop the
 *  read from type-checking as the field's declared type, so client code went
 *  on branching on `undefined` as though it were data (a field report: a lock
 *  screen asked "does a vault exist?", got `undefined` forever, and behaved —
 *  in prod, where the warning scrolled past). A hidden field is never readable
 *  here, so ANY such read is a bug, and a bug that yields a plausible value is
 *  worse than one that stops the page: dev == prod, one outcome table. The fix
 *  is always the same shape — `visible: { exclude }` is doing its job:
 *  publish the non-secret FACT (`hasVault: boolean`) beside the secret and
 *  read that, or read the secret in a server-side/async method. */
export function reportHiddenRead(
  cellName: string,
  key: string,
  reason: string,
  context = `read in ${SIDE.client}`,
): never {
  const id = `${cellName}.${key}`;
  throw new Error(
    `[aio] ${id} ${context} — ${reason}. ` +
      // ONE name for the side, not three. This sentence used to read
      // "enforced on ALL client reads (browser and standalone/electron
      // alike)" — three spellings of one idea, in one line, which is how a
      // reader learns that the words are decoration.
      `\`visible:\` is enforced on every read in ${SIDE.client} — wherever ` +
      `your UI runs — in dev and prod alike. Two fixes: publish the ` +
      `non-secret FACT as its own visible field (e.g. \`has${
        (key.split(".").pop() ?? key).replace(/^./, (c) => c.toUpperCase())
      }: boolean\`) and read that, or read \`${key}\` in ${SIDE.server} — a ` +
      `server-side/async method (routes, effects, methods).\n` +
      // Name WHERE you are, not only what is refused. This fires from places
      // that look identical in a source file, and the reader's next question
      // is always which one they are in. The sync method is the expensive
      // case: reading a hidden field there is correct-looking TypeScript that
      // only dies when the reducer replays.
      `  ${WHERE_HINT}. Note: ${contextNote("a sync method")} — where ` +
      `hidden fields are not present.`,
  );
}

/** Deep-exclude for CLIENT reads — state-filter's `deepExcludePaths`, THE
 *  one rule, plus a tripwire: the dropped field is re-installed as a
 *  non-enumerable reporting getter, so `account.encSecKey` throws exactly
 *  like a top-level excluded field. On the wire path the field never even
 *  arrives (the broadcast filter strips it), and that absent field reading as
 *  a clean `undefined` is the same "undefined as data" trap, one level down.
 *  Non-enumerable, so spreads / Object.keys / JSON.stringify of the parent
 *  never trip it — only an actual read of the hidden name does.
 *
 *  ALL of the key's paths in one call, never one excluder per path composed
 *  over the previous one's output: the second pass rebuilds with a spread,
 *  which copies own ENUMERABLE properties only, so it dropped the first
 *  pass's tripwire and `["a.b", "a.c"]` left `a.b` silently `undefined`.
 *
 *  MEMOIZED per source value, which is what makes it affordable. A read of
 *  `cell.accounts` is a property read — the docs call it cheap and UIs are
 *  written that way — and it walked and re-copied the whole array EVERY time:
 *  O(n) per read, and a fresh array of fresh rows, so no `WeakMap`-on-the-row
 *  memo downstream could ever hit. A field report measured 25.5 s of a 27 s
 *  renderer profile in here at 10 000 rows, with one keypress freezing the app
 *  for 38 s.
 *
 *  A `WeakMap` per depth is EXACT rather than a cache with a staleness
 *  window: committed state is frozen (Immer `autoFreeze`, never disabled) and
 *  a delta applies as `applyPatches`, so a value that changed is a different
 *  object and a value that did not is the same one. Same source ⇒ same view,
 *  which also keeps the excluded row identities stable between reads. */
function makeDeepExcluder(
  paths: string[][],
  onRead: (path: readonly string[]) => void,
): (value: unknown) => unknown {
  // Shared across calls, and keyed by the cursor set the walk is in — same
  // source value ⇒ same view object, for the life of the binding.
  const memos = new Map<string, WeakMap<object, unknown>>();
  return (value: unknown) =>
    deepExcludePaths(value, paths, {
      memos,
      tripwire: (obj, head, path) => {
        Object.defineProperty(obj, head, {
          get() {
            onRead(path);
            return undefined;
          },
          enumerable: false,
          configurable: true,
        });
      },
    });
}

/** The ui filter that applies to CLIENT reads of a cell. Client-scoped cells
 *  are exempt: their state lives only in this client (never broadcast), so a
 *  ui filter has nothing to protect. */
function clientUiFilter(def: CellDef): CellFieldFilter | undefined {
  return def.__aio.scope === "client" ? undefined : def.__aio.ui;
}

// ── The per-user view, for a runtime that holds the UNFILTERED state ──
//
// A real client never holds another user's rows: the server runs
// `visible.forUser` before the frame leaves (aio-composition.ts), so the
// getters below read a slice that is already that user's view. `testUI` holds
// the SERVER's state in the same signals — so it rendered the whole cell,
// `{ user }` or not, and a UI test passed while showing every user's orders.
// The harness names the viewer; the getters then answer with what that
// viewer's socket would carry. Unset (a browser, an APK), nothing changes.

type Slice = Record<string, unknown>;
type ForUser = (exposed: Slice, user?: AccessUser) => Slice;

/** Who a harness is reading AS — `null` when the runtime already holds a
 *  client's view (the browser) or has no users at all (standalone). */
let _clientViewer: {
  user: AccessUser | undefined;
  forUserOf: (def: CellDef) => ForUser | undefined;
} | null = null;

/** Harness-only: read every cell as a client signed in as `user` (undefined =
 *  an anonymous connection) sees it. `forUserOf` hands over each cell's
 *  per-user filter — passed in, not read here, because this module rides in
 *  the browser bundle, whose cell stub does not carry the filter (it runs on
 *  the server). Returns the undo. @internal */
export function _readAsClient(
  user: AccessUser | undefined,
  forUserOf: (def: CellDef) => ForUser | undefined,
): () => void {
  const viewer = { user, forUserOf };
  _clientViewer = viewer;
  return () => {
    if (_clientViewer === viewer) _clientViewer = null;
  };
}

/** What `visible.forUser` decides for one cell and one user — the broadcast's
 *  rules, including the three FAIL-CLOSED ones: a filter that throws, returns
 *  a Promise, or returns a non-object has decided nothing, so the cell is
 *  omitted rather than sent unfiltered. `omit` carries the reason.
 *  `wholeCell` — the cell has NO structural filter, so `structural` is its
 *  entire state (the omit reason says why that must never be sent).
 *
 *  Pure but for one thing: a returned Promise is OBSERVED. Omitting the cell
 *  and dropping the Promise left a REJECTING async filter as an unhandled
 *  rejection — a failed test file under `testUI`, and, without
 *  `guardDispatches`, a server that exits the first time a client is sent the
 *  cell. The omission is already reported by name; the rejection adds nothing
 *  but the crash. */
export function forUserView(
  cellName: string,
  forUser: ForUser,
  structural: Slice,
  user: AccessUser | undefined,
  wholeCell = false,
): { view: Slice } | { omit: string } {
  let view: unknown;
  try {
    view = forUser(structuredClone(structural), user);
  } catch (e) {
    return {
      omit:
        `[${cellName}] visible.forUser threw — omitting the cell for this ` +
        `client (fail closed; nothing is sent for it)` +
        (wholeCell
          ? `. This cell has NO structural visible filter, so the pre-filter ` +
            `value is its ENTIRE state — it must never be sent.`
          : "") +
        `: ${e}`,
    };
  }
  const then = (view as { then?: unknown } | null)?.then;
  if (typeof then === "function") {
    // aio-ok: the cell is omitted and the ASYNC filter named in `omit`;
    // observing the rejection only keeps it from escaping unhandled.
    then.call(view, undefined, () => {});
    return {
      omit: `[${cellName}] visible.forUser is ASYNC — it returned a Promise, ` +
        `not a state object. Broadcast filtering cannot await, so the ` +
        `Promise would reach every client as {}. Make the filter ` +
        `synchronous (read what it needs from the state it is handed, or ` +
        `precompute the value in a method) — omitting the cell for this ` +
        `client (fail closed).`,
    };
  }
  if (!view || typeof view !== "object" || Array.isArray(view)) {
    return {
      omit:
        `[${cellName}] visible.forUser returned ${
          Array.isArray(view) ? "an array" : typeof view
        }, not a state object — omitting the cell for this client (fail ` +
        `closed). A per-user filter must return the slice the client may see.`,
    };
  }
  return { view: view as Slice };
}

/** One view per committed slice per viewer: a commit replaces the slice
 *  object, so identity is the cache key and a stale view cannot be served. */
const _views = new WeakMap<object, { viewer: object; view: Slice | null }>();

/** The slice a client of the current viewer holds for `def` — `raw` itself
 *  unless a harness named a viewer and the cell has a per-user filter; `null`
 *  when the filter failed closed (a client with no slice reads declared
 *  state, exactly like a client the broadcast omitted the cell for). */
function clientSlice(def: CellDef, raw: unknown): Slice | null {
  const viewer = _clientViewer;
  const forUser = viewer?.forUserOf(def);
  if (
    !viewer || !forUser || raw == null || typeof raw !== "object" ||
    def.__aio.scope === "client"
  ) return raw as Slice | null;
  const hit = _views.get(raw);
  if (hit && hit.viewer === viewer) return hit.view;
  const filter = clientUiFilter(def);
  const out = forUserView(
    def.__aio.id,
    forUser,
    filterSlice(filter, raw as Slice),
    viewer.user,
    (filter ?? "all") === "all",
  );
  if ("omit" in out) log.error(out.omit);
  const view = "view" in out ? out.view : null;
  _views.set(raw, { viewer, view });
  return view;
}

/** Filter a full cell slice for client visibility ("none" → empty slice). */
function filterSlice(
  filter: CellFieldFilter | undefined,
  slice: Record<string, unknown>,
): Record<string, unknown> {
  if (!filter || filter === "all") return slice;
  return applyCellFieldFilter(filter, slice) ?? {};
}

const _hiddenKeys = new WeakMap<CellDef, Set<string>>();

/** Wrap a client-visible slice so that reading a ui-HIDDEN field on it reports
 *  exactly as `cell.field` does (it throws — dev and prod alike).
 *
 *  Selectors are client reads too, and they were the one client read the ui
 *  filter enforced SILENTLY: `filterSlice` handed a `ui: "none"` cell an empty
 *  object and the selector computed over it — `total()` returned NaN,
 *  `count()` returned 0 — while `cell.balance` on the same cell threw in dev.
 *  Garbage shaped like data is worse than an error, and it was one seam
 *  deciding two ways. Reporting on the READ (not on the call) keeps a selector
 *  that never touches a hidden field silent, so a deps-form selector over other
 *  cells is unaffected. Hidden keys are absent from the slice already, so
 *  `Object.keys`/spread over it never trip the guard — only naming the field
 *  does. */
function guardHidden(
  def: CellDef,
  slice: Record<string, unknown>,
  context?: string,
): Record<string, unknown> {
  let hidden = _hiddenKeys.get(def);
  if (!hidden) {
    const filter = clientUiFilter(def);
    hidden = new Set(
      Object.keys(def.__aio.state).filter((k) =>
        uiKeyVisibility(filter, k).hidden
      ),
    );
    _hiddenKeys.set(def, hidden);
  }
  if (hidden.size === 0) return slice;
  const hiddenKeys = hidden;
  const filter = clientUiFilter(def);
  return new Proxy(slice, {
    get(target, prop) {
      if (typeof prop === "string" && hiddenKeys.has(prop)) {
        reportHiddenRead(
          def.__aio.id,
          prop,
          uiKeyVisibility(filter, prop).reason!,
          context,
        );
      }
      return (target as Record<string | symbol, unknown>)[prop];
    },
  });
}

/** The replay-side twin of {@link guardHidden}: a `sync`/`localFirst` cell's
 *  SYNC methods replay on the client against the ui-filtered draft (optimistic
 *  rebase, `protocol-cell.ts`), so a hidden field the server-side run could
 *  read is simply absent there — and it read as a clean `undefined` with no
 *  tripwire, in the one runtime nobody tests by hand. Same outcome table as
 *  every other client read: it THROWS naming cell + field, dev and prod
 *  alike. Writes pass straight through to the draft. */
export function guardHiddenReplay<S extends object>(def: CellDef, draft: S): S {
  return guardHidden(
    def,
    draft as unknown as Record<string, unknown>,
    // The side OBSERVED, then the context by name. A sync method is DECLARED
    // server-side and this guard fires precisely when it is running on the
    // client, so anything derived from the declaration names the wrong side at
    // the one moment the side is the whole point. See the note in
    // `diagnostics/contexts.ts` about the helper that used to do exactly that.
    `read in ${SIDE.client} — this is ${
      context("a sync method").name
    }, and sync methods replay on the client`,
  ) as unknown as S;
}

/** Subscribe the server to this cell's deltas — never by id for a
 *  `scope: "client"` cell: no server has one, so the id could only name a cell
 *  the server does not know, and it warns about those (`warnUnknownSubs`, a
 *  typo'd id). The read still subscribes to `CLIENT_ONLY_SUB`, which names no
 *  cell, so a page that reads only client cells narrows to nothing, as 1.0.11's
 *  id did — tracking nothing left it on the wildcard, every server delta. */
function trackCell(def: CellDef): void {
  trackPath(def.__aio.scope === "client" ? CLIENT_ONLY_SUB : def.__aio.id);
}

/** Install signal-backed getters on a cell for each state key, and wrap
 *  action creators with dispatch so `counter.increment()` sends to server.
 *  After this, `counter.count` reads from the cell signal (auto-tracked). */
export function bindCellReactive(
  def: CellDef,
  sendFn?: (
    action: { type: string; payload?: unknown; cid?: string },
  ) => void | Promise<void>,
): void {
  if (_reactivelyBound.has(def)) return;
  _reactivelyBound.add(def);

  const cellName = def.__aio.id;
  const initialState = def.__aio.state;
  const sig = getCellSignal(cellName, initialState);

  // Install signal-backed state getters. Overrides the creation-time default
  // getter (installDefaultStateGetters); skip only if a method/selector owns the
  // name (impossible per AIO-6.1, but defensive — a default getter reads as a
  // non-function and is correctly overridden).
  const uiFilter = clientUiFilter(def);
  for (const key of Object.keys(initialState)) {
    if (nameIsTaken(def, key)) continue;

    // ui visibility is enforced at THIS seam for client reads — a
    // hidden field THROWS (dev and prod), a dot-path exclude strips the
    // nested value, exactly like the broadcast filter.
    const vis = uiKeyVisibility(uiFilter, key);
    // Built ONCE per (key, exclude path), not per read: each excluder owns the
    // memo that makes a read of a 10k-row array cost a `WeakMap` lookup
    // instead of a full copy — see `makeDeepExcluder`.
    const exclude = vis.deepSegs && vis.deepSegs.length > 0
      ? makeDeepExcluder(vis.deepSegs, (path) =>
        reportHiddenRead(
          cellName,
          `${key}.${path.join(".")}`,
          "the field is under a visible.exclude path",
        ))
      : undefined;
    Object.defineProperty(def, key, {
      get() {
        if (vis.hidden) reportHiddenRead(cellName, key, vis.reason!);
        // Register a SERVER subscription for this cell:
        // reading a cell via direct access is documented as "reactive and
        // auto-tracked", but it only tracked the AIR *re-render* signal — it
        // never told the server to send this cell's deltas. So the moment the
        // client's subscription was narrowed to a partial set (by useCell/
        // useAio elsewhere), a directly-read cell silently stopped receiving
        // live updates — its signal never changed, freezing the UI at the
        // connect-time value. trackPath makes "auto-tracked" true for deltas
        // too. No-op on the server (never bound reactively) and harmless in
        // standalone/test (no transport → no __subs sent).
        trackCell(def);
        // tracked read — auto-tracked by AIR renderer
        const s = clientSlice(def, sig.value);
        const v = s == null
          ? initialState[key]
          : (s as Record<string, unknown>)[key];
        return exclude ? exclude(v) : v;
      },
      enumerable: false,
      configurable: true,
    });
  }

  // AIO-422: bind selectors on the browser cell too — they're pure
  // functions over state, so `cell.count()` must work client-side exactly as it
  // does server-side. Before this they existed only on the server; the browser
  // cell had no accessor and `listings.count()` threw `is not a function` at
  // runtime with no boot warning — the "quiet lie" the docs promised against.
  // Mirrors the server bind (cell-catalog.ts): zero-arg accessor,
  // selectorFn(ownSlice, fullState). The `fullState` is a lazy Proxy so a
  // deps-form selector reading another cell tracks ONLY the cells it touches
  // (precise subscriptions), and a plain own-slice selector subscribes to just
  // its own cell.
  const selectors = def.__aio.selectors as
    | Record<string, (s: unknown, fullState?: unknown) => unknown>
    | undefined;
  if (selectors) {
    // Deliberately NO "already a function, skip" guard here.
    //
    // standalone/Electron binds a cell twice: bindCell() first (methods +
    // selectors over `app.getState()`), then bindCellReactive(). A skip-if-
    // function guard therefore skipped EVERY selector — the catalog version had
    // just installed one — leaving the non-signal-backed selector in place. It
    // returned correct, fresh data and subscribed to nothing, so a component
    // whose only read was a selector rendered once and froze: right data, dead
    // screen, no warning.
    // testUI binds reactively ONLY, which is why no test could ever see it.
    //
    // Selector names cannot collide with method names (AIO-6.1 enforces it), so
    // overwriting unconditionally can only ever replace a selector with the same
    // selector — reading the signal instead of a snapshot.
    // A selector is a client read like any other, so it answers to the same
    // rule. It did not: `filterSlice` handed a `ui: "none"` cell an EMPTY
    // object and the selector computed over it — `total()` returned NaN,
    // `count()` returned 0 — while `cell.balance` on the very same cell threw
    // in dev. Garbage that looks like data is worse than an error, and it was
    // the same seam deciding two different ways. The guard reports on the
    // READ, so a selector that never touches a hidden field stays silent (and
    // a deps-form selector over other cells keeps working).
    for (const [key, selectorFn] of Object.entries(selectors)) {
      const isDeps = key in
        ((def.__aio as { selectorDeps?: Record<string, unknown> })
          .selectorDeps ?? {});
      Object.defineProperty(def, key, {
        value: (...args: unknown[]) => {
          trackCell(def);
          // Selectors run in client context and see the ui-FILTERED slice —
          // the same data any client holds after a broadcast, so a selector
          // cannot leak a ui-excluded secret wherever the UI runs.
          const own = guardHidden(
            def,
            filterSlice(
              uiFilter,
              (clientSlice(def, sig.value) ?? initialState) as Record<
                string,
                unknown
              >,
            ),
          );
          // Called WITH args on a PLAIN selector → parameterized
          // (`cell.byId(id)`). A deps-form selector always needs the full
          // state (built below), with args riding behind it (alpha52).
          if (!isDeps && args.length > 0) {
            return (selectorFn as (s: unknown, ...a: unknown[]) => unknown)(
              own,
              ...args,
            );
          }
          const full = new Proxy({} as Record<string, unknown>, {
            get(_t, prop) {
              if (typeof prop !== "string") return undefined;
              if (prop === cellName) return own;
              const other = _cellSignals.get(prop);
              if (!other) return undefined;
              // Cross-cell reads honor the OTHER cell's ui filter too.
              const otherDef = _cellRegistry.get(prop);
              if (otherDef) trackCell(otherDef);
              else trackPath(prop);
              const otherSlice = ((otherDef
                ? clientSlice(otherDef, other.value)
                : other.value) ??
                otherDef?.__aio.state ??
                {}) as Record<string, unknown>;
              // Same rule across the cell boundary: a deps-form selector
              // reading another cell's hidden field must hear about it too.
              return otherDef
                ? guardHidden(
                  otherDef,
                  filterSlice(clientUiFilter(otherDef), otherSlice),
                )
                : otherSlice;
            },
          });
          return isDeps
            ? (selectorFn as (
              s: unknown,
              f: unknown,
              ...a: unknown[]
            ) => unknown)(own, full, ...args)
            : selectorFn(own, full);
        },
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }

  /** Is this an effect a client-scoped cell can never run — and which kind?
   *
   *  A HAND-KEPT TWIN of `isOwnEffect` (own.ts) and `isScheduleEffect`
   *  (schedule.ts), and deliberately not an import of them: this module is
   *  browser-reachable, `schedule.ts` pulls `blocking.ts` and the Deno worker
   *  pool behind it, and widening the browser graph to reach a two-line type-tag
   *  check is the trade `import type` is used for everywhere else in this file's
   *  neighbours (`dispatch.ts`, `cell-impl.ts`). The twin is not trusted on its
   *  own — `tests/client-cell-return.test.ts` feeds REAL effects, built through
   *  the real `own.set()` / `schedule.after()`, through this predicate, so a new
   *  effect kind or a renamed tag fails there rather than going quiet here. */
  function deadClientEffect(e: unknown): "own" | "schedule" | null {
    const tag = typeof e === "object" && e !== null
      ? (e as { type?: unknown }).type
      : undefined;
    if (tag === "__own") return "own";
    if (tag === "__schedule") return "schedule";
    return null;
  }

  // AIO-5.1: client-scoped cells — methods run locally against the cell signal,
  // synchronously, with no server dispatch. Each binding (tab) owns its slice.
  if (def.__aio.scope === "client") {
    const methods = def.__aio.clientMethods ?? {};
    for (const [key, method] of Object.entries(methods)) {
      const fn = (...args: unknown[]) => {
        const cur = (sig.value ?? initialState) as Record<string, unknown>;
        const next = structuredClone(cur);
        // `s.$do` exists on every draft (alpha52) — but a client-scoped cell
        // has no effect runtime (no scheduler, no own manager, no dispatch),
        // so running one here would be a silent no-op. Loud instead.
        Object.defineProperty(next, "$do", {
          value: () => {
            throw new Error(
              `[${cellName}] ${key}(): s.$do(...) is not available in a ` +
                `scope: "client" cell — client cells have no effect runtime. ` +
                `Do timer work in the component (useInterval), or move the ` +
                `method to a server cell.`,
            );
          },
          enumerable: false,
          configurable: true,
        });
        const returned = method(next, ...args);
        delete (next as Record<string, unknown>)["$do"];
        sig.set(next);
        // A client cell has no effect runtime, so an effect RETURNED from a
        // method is as dead as one passed to `s.$do` — and was dropped without
        // a word. Same treatment, same words: the silent no-op is the bug.
        const dead = deadClientEffect(returned);
        if (dead) {
          throw new Error(
            `[${cellName}] ${key}(): returning a ${dead} effect does nothing ` +
              `in a scope: "client" cell — client cells have no effect ` +
              `runtime. Do timer work in the component (useInterval), or ` +
              `move the method to a server cell.`,
          );
        }
        // The method's own return value, which used to be thrown away: a sync
        // method that returns transports its value to the caller on the server
        // path (`markReturn` → the ack frame), and the SAME method on a
        // `scope: "client"` cell resolved `undefined` forever. Documented as a
        // load-bearing parity contract in docs/state/methods.md — "in-process
        // callers always get the raw value" — and a client cell is the most
        // in-process caller there is: no wire, so no JSON requirement either.
        return Promise.resolve(returned);
      };
      const label = `${cellName}:${key}`;
      const creator = Object.assign(
        (...args: unknown[]) => ({ type: label, payload: { args } }),
        { type: label },
      );
      (creator as unknown as Record<string, unknown>).action = creator;
      attachMeta(fn, creator);
      Object.defineProperty(def, key, {
        value: fn,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    return; // no server wiring — client cells never dispatch
  }

  // Wrap action creators with dispatch so methods send to server.
  // Each call generates a client-side id (cid) and returns a Promise<void> that
  // resolves when the server acks the dispatch. Awaitable callers get
  // synchronization; unawaited callers (fire-and-forget) get a no-op .catch()
  // attached to silence unhandled-rejection warnings on disconnect.
  if (sendFn) {
    for (const key of def.__aio.actionKeys) {
      // Read from __aio.actions (raw catalog) — the def[key] surface is
      // wrapped in makeUnboundGuard and would throw if invoked.
      const creator = (def.__aio.actions as Record<string, unknown>)[key];
      if (typeof creator !== "function") continue;

      // Async methods carry `_callId` so the server correlates the completion
      // (its return value) back to this call over the wire (return-value
      // transport) — mirroring bindCell's direct-call path. Sync/void methods
      // get their value from the dispatch result on the server side.
      const isAsync = def.__aio.asyncMethods?.has(key) === true;
      const fn = (...args: unknown[]) => {
        const action = (creator as (...a: unknown[]) => {
          type: string;
          payload?: unknown;
        })(...args);
        const cid = randomUuid();
        const tagged = isAsync
          ? {
            ...action,
            cid,
            payload: {
              ...(action.payload as Record<string, unknown> ?? {}),
              _callId: cid,
            },
          }
          : { ...action, cid };
        // AIO-2.2: register the ack BEFORE send so a fast server can't ack
        // before we listen. Then dispatch; the ack handler (wired in the
        // browser transport) will settle the registered promise.
        const promise = _registerAndSend(sendFn, tagged);
        // Attach a no-op .catch() so fire-and-forget callers don't get
        // unhandled-rejection console noise on disconnect.
        promise.catch(() => {});
        return promise;
      };
      attachMeta(fn, creator);
      (def as Record<string, unknown>)[key] = fn;
    }
  }
}

/** Register a pending ack for `cid`, then call the send function. The send
 *  function may be the browser transport's `send` (Promise-returning) or a
 *  legacy void-returning sendFn — both work. The returned promise resolves
 *  on _resolveAck, rejects on _rejectAck / timeout / disconnect. */
function _registerAndSend(
  sendFn: (
    action: { type: string; payload?: unknown; cid?: string },
  ) => void | Promise<void>,
  tagged: { type: string; payload?: unknown; cid: string },
): Promise<unknown> {
  // Register with the SAME options the transport would, because this
  // registration is the one that wins: `_registerAck` is idempotent per cid
  // and returns early when an entry exists, so whatever is registered FIRST
  // fixes the entry's terms. Registering bare here meant, for every cell
  // method call in every transport:
  //   • the 15s clock started at dispatch time rather than when the frame was
  //     written, so an action queued offline for 20s was rejected at 15s while
  //     still sitting in the queue — then sent on reconnect and applied
  //     server-side, after its caller had already been told it failed;
  //   • `methodKey` stayed undefined, so per-method call budgets
  //     (`perfBudget.methods["cell:method"].timeout`) never applied to
  //     anything.
  // The transports arm the clock (`armTimer`) once the frame is out.
  //
  // The ack registry itself lives in the browser runtime (browser-ack.ts) and
  // reaches this module through the late-bound sink (ack-sink.ts) — state may
  // not import browser. Every transport that hands a sendFn to this binding
  // imports browser-ack, so a missing sink here is a wiring bug: fail LOUD
  // instead of returning a promise nothing can ever settle.
  const ack = _ackSink.impl;
  if (!ack) {
    throw new Error(
      `[aio] cannot dispatch "${tagged.type}" — no ack registry is installed ` +
        `(state/ack-sink.ts is empty). The browser transport module ` +
        `(browser-ack.ts) installs it on load; a sendFn-bound cell without it ` +
        `would return a promise that can never settle.`,
    );
  }
  const promise = ack.register(tagged.cid, {
    deferTimer: true,
    methodKey: ackMethodKey(tagged),
  });
  // Send in a microtask so a fast synchronous sendFn doesn't have its return
  // value clobbered by the pending map. The ack can come back as soon as
  // the dispatch completes server-side; the registration is in place.
  queueMicrotask(() => {
    try {
      sendFn(tagged);
    } catch (e) {
      // The frame never left. Waiting out the 15s ack clock to discover that
      // turns a send error into a near-silent hang, and the timeout then
      // reports a generic "stopped waiting" instead of the actual failure.
      // Reject NOW, with the real cause: a transport that throws
      // synchronously has already told us everything the clock could.
      ack.reject(
        tagged.cid,
        e instanceof Error ? e : new Error(`send failed: ${String(e)}`),
      );
      return;
    }
    // aio's own transports arm the clock when the frame goes out. Anything
    // else — a custom or legacy `sendFn` — never would, and a deferred timer
    // that is never armed is a call that can hang forever, so start it here.
    if (!ack.armsAckTimer(sendFn)) ack.armTimer(tagged.cid);
  });
  return promise;
}

/** Bind all registered cells reactively. Called once from ensureConnected(). */
export function bindAllCellsReactive(
  sendFn?: (action: { type: string; payload?: unknown }) => void,
): void {
  for (const def of _cellRegistry.values()) {
    bindCellReactive(def, sendFn);
  }
}
