# aio DX Overhaul — Implementation Plan

**Goal:** eliminate every place where a developer writes the _obvious_ code and
aio does something else. When every box below is checked, aio behaves exactly as
its docs and a reasonable developer's intuition predict: zero-config works as
advertised, `await` means "applied", state reads never need incantations, and
React muscle memory doesn't betray users of the AIR renderer.

---

## How to work this file (read first, applies to every task)

1. **Work top to bottom, one task at a time.** Phases are ordered by user impact
   and by dependency — later tasks assume earlier ones are done.
2. **Every task has the same shape:** Problem → Files → Steps → Acceptance
   criteria. Do the steps in order. A task is done only when ALL acceptance
   criteria pass.
3. **Write the test before the fix** whenever the task lists a test file.
   Confirm the test fails first (it must reproduce the bug), then fix, then
   confirm it passes.
4. **After every task run:** `deno test -A --unstable-kv tests/` — all existing
   tests must stay green. If an existing test now fails because intended
   behavior changed, update that test and say so in the commit message.
5. **Do not refactor beyond the task scope.** No renames, no file moves, no
   style changes outside the listed files, unless a step explicitly says so.
6. **Docs are part of the task.** If a task changes behavior, the listed doc
   files must be updated in the same commit. Never leave docs describing the old
   behavior.
7. **Commit per task** with message `dx(<task-id>): <summary>`, e.g.
   `dx(1.2): per-cell
   ui/persist resolution, no mode cliff`.
8. Line numbers below are from the audit snapshot (2026-06-11) — treat them as
   anchors, not gospel. If code moved, locate it by the quoted identifier.

---

## Phase 1 — Truthful, uniform `ui` / `persist` defaults (P0)

The single worst trap: docs say defaults are `"none"`, the runtime defaults to
"everything" until one cell opts in, then flips global behavior. Decision
(final, do not re-litigate): **the framework default for both `ui` and `persist`
is `"all"`** — it matches the README promise ("State persists across restarts.
WebSocket sync included.") and the zero-config intuition. Privacy/size tuning is
opt-out per cell.

Resolution order (unchanged, but now ends in `"all"`):
`cell.ui > cellDefaults.ui > "all"` and
`cell.persist > cellDefaults.persist > "all"`.

### [x] 1.1 Make `persist` default to `"all"`

**Problem:** with zero `persist` configs, `buildDBStateGetter` returns
`() => ({})` (`src/aio-composition.ts` ~line 129, comment "No cells opted into
persistence — persist nothing"). The README counter example therefore does NOT
persist `count` across restarts, contradicting README, quickstart, and the
`Taste` section.

**Files:** `src/aio-composition.ts`, `tests/` (new:
`tests/defaults-persist.test.ts`), `docs/persistence/auto-persist.md`,
`docs/state/cell-visibility.md`.

**Steps:**

1. Write `tests/defaults-persist.test.ts`:
   - Test A: compose a cell with NO `persist` config and no `cellDefaults`;
     assert the DB-state getter returns the full cell slice (not `{}`).
   - Test B: cell with `persist: "none"` → getter omits that cell.
   - Test C: cell with `persist: { exclude: ["cache"] }` → getter returns slice
     minus `cache`, AND a second cell with no config still returns its full
     slice (this is the mode-cliff regression test). Run; A and C must fail.
2. In `buildDBStateGetter` (`src/aio-composition.ts`): resolve every cell's
   filter as `f.__aio.persist ?? "all"` (after `applyCellDefaults` has run) and
   always build the per-cell map for ALL cells. Delete the
   `cellPersistFilters.size > 0` branch and the `() => ({})` fallback.
3. Update `docs/persistence/auto-persist.md`: "Per-Cell Persistence — Default:
   `"all"` (everything persists). Opt out with `persist: "none"` or narrow with
   include/exclude." Update the resolution-order block in
   `docs/state/cell-visibility.md` to end in `"all"`.

**Acceptance criteria:**

- [ ] All three new tests pass; full suite green.
- [ ] `examples/counter`: run, increment, kill, restart → count restored (manual
      check, note result in commit message).
- [ ] No doc file still claims the persist default is `"none"`:
      `grep -rn '"none"' docs/ | grep -i persist` reviewed, every hit accurate.

### [x] 1.2 Make `ui` default to `"all"` and remove the mode cliff

**Problem:** with zero `ui` configs, `_getUIState` falls back to identity
(`src/aio.ts:306`) — full state to clients. The moment ONE cell sets `ui`,
`buildUIStateGetter` (`src/aio-composition.ts:146`) builds client state from
only the cells with explicit `ui` entries; every other cell resolves `"none"` →
patch strategy `"skip"` → silently vanishes from all clients.

**Files:** `src/aio-composition.ts`, `src/aio.ts`, new
`tests/defaults-ui.test.ts`, `docs/state/cell-visibility.md`.

**Steps:**

1. Write `tests/defaults-ui.test.ts`:
   - Test A: no cell has `ui`; getUIState returns full state; every cell's patch
     strategy is `"raw"`.
   - Test B: cell X has `ui: { include: ["a"] }`, cell Y has nothing → Y's slice
     is still fully present in UI state and Y's strategy is `"raw"` (mode-cliff
     regression test — currently fails).
   - Test C: `ui: "none"` cell → absent from UI state, strategy `"skip"`.
   - Test D: `cellDefaults: { ui: "none" }` + one cell with `ui: "all"` → only
     that cell visible.
2. In `buildUIStateGetter`: resolve `const resolved = f.__aio.ui ?? "all"` and
   add a `UiEntry` for EVERY cell (not just those with explicit config). Delete
   the `cellUiEntries.size === 0 → autoGetUIState: undefined` early return;
   always return a concrete getter.
3. In `src/aio.ts:306`, the `?? ((s) => s)` fallback becomes dead — keep it as a
   safety net but add a comment that `autoGetUIState` is now always defined by
   composition.
4. Update `docs/state/cell-visibility.md` top section: default is `"all"`;
   rewrite the "nothing leaks unless you opt in" sentence to describe opt-out.
   Keep the include/exclude/forUser tables as-is.

**Acceptance criteria:**

- [ ] All four new tests pass; full suite green.
- [ ] Adding `ui: { include: [...] }` to one cell in `examples/todo` does not
      stop the other state keys/cells from rendering (manual check).

### [x] 1.3 Startup visibility report

**Problem:** "why doesn't my state sync/persist" is answerable only by reading
source.

**Files:** `src/aio.ts` (after `composeCellsWiring`), `src/aio-composition.ts`
(expose resolved filters), `docs/debugging/troubleshooting.md`.

**Steps:**

1. Have `composeCellsWiring` return a
   `visibilityReport: Array<{ cell: string;
   ui: string; persist: string; scope?: string }>`
   where each value is the resolved filter rendered as
   `"all" | "none" | "include(a,b)" | "exclude(x)" | "forUser"`.
2. In `aio.run()` after composition, log one compact table at `info` level,
   e.g.:
   `cells: counter ui=all persist=all | trading ui=include(orders,positions) persist=exclude(cache)`.
3. If running with `--expose` AND any cell resolves `ui: "all"`, log a one-line
   `warn`:
   `--expose with ui="all" on cells: <names> — every authenticated client sees
   this state. Narrow with ui:{include:[...]} if needed.`
4. Add a row to troubleshooting S3 ("Stale data") checklist: "Check the `cells:`
   visibility line at startup — is the field you expect actually exposed?"

**Acceptance criteria:**

- [ ] Booting `examples/todo` prints the table with correct resolved values.
- [ ] Unit test asserting report contents for a 3-cell mix (all/none/include).

---

## Phase 2 — One meaning for `cell.method()` everywhere (P0)

Rule AIO6 promises "all bound cell methods return Promise — use await for
synchronization." Today there are three behaviors: server async → `Promise<R>`;
server sync → returns the action object; browser → `undefined`, fire-and-forget
(awaiting resolves before the server applied anything). Decision (final):
**every bound method returns a Promise that resolves when the state change has
been applied** — locally on the server, ack-confirmed in the browser. Unawaited
calls remain fine (fire-and-forget is just an ignored promise).

### [x] 2.1 Server: sync methods return a resolved Promise

**Problem:** bound sync methods return the action object (see `DirectCalling` in
`src/cell-types.ts:252` — the non-Promise branch types the return as
`{ type; payload }`).

**Files:** `src/cell-impl.ts` / `src/cell-methods-factory.ts` (wherever
direct-call binding wraps creators — locate `bindCell`), `src/cell-types.ts`,
new `tests/direct-call-return.test.ts`.

**Steps:**

1. Test: bind a cell, call a sync method → returned value is a `Promise` that
   resolves to `undefined` AFTER the state change is observable via
   `getState()`. Call an async method returning a value → `Promise<R>` with the
   value (existing behavior, pin it).
2. Change the bound sync-method wrapper: dispatch, then
   `return Promise.resolve()`. Keep `.type` metadata on the function
   (`counter.increment.type`).
3. Update `DirectCalling` in `src/cell-types.ts`: sync branch becomes
   `((...args: P) => Promise<void>) & { readonly type: ... }`.
4. Unbound calls (before `aio.run()`): see task 2.3 — do not handle here.

**Acceptance criteria:**

- [ ] `await counter.increment(5); getState().counter.count === 5` typechecks
      and passes.
- [ ] `counter.increment.type === "counter:increment"` still works.
- [ ] Full suite green (update any test asserting the old action-object return).

### [x] 2.2 Browser: methods return an ack-backed Promise

**Problem:** `src/cell-reactive.ts:69` wraps browser methods as `sendFn(action)`
→ returns `undefined`. `await todo.add("x"); todo.items` reads stale state. This
is the single biggest "works on server, lies in UI" trap.

**Files:** `src/cell-reactive.ts`, `src/browser-protocol.ts`,
`src/browser-transport-send.ts` (or wherever `_clientSend` is built),
`src/server-ws.ts` (server side of the protocol), `src/protocol-types.ts`, new
`tests/browser-ack.test.ts`, docs: `docs/basics/concepts.md` (AIO6),
`docs/clients/browser.md`.

**Steps:**

1. Protocol: add an optional `cid` (string, client-generated, e.g.
   `crypto.randomUUID()`) to client→server action messages, and a new
   server→client message `{ type: "ack", cid, ok: true }` /
   `{ type: "ack", cid, ok: false, error }`. Add both to
   `src/protocol-types.ts`. The server sends the ack **after** the dispatch has
   been reduced (hook into the same completion point that triggers the
   broadcast, so by the time the client's promise resolves, the patch for this
   action is either already applied locally or in flight ahead of any subsequent
   read... if ordering between ack and patch is not guaranteed on the same
   socket, send the ack AFTER the broadcast write for that dispatch).
2. Client: in the method wrapper (`cell-reactive.ts` `bindCellReactive`),
   generate a `cid`, register it in a `Map<cid, {resolve, reject, timer}>`,
   send, return the promise. On `ack` message, settle and clear. Timeout: 15s →
   reject with a clear error
   `method <type> not acknowledged in 15s — server overloaded or disconnected`.
   On WS disconnect, reject all pending with `connection lost`.
3. Unhandled-rejection safety: fire-and-forget callers must not get console
   noise from a rejected ack on disconnect. Attach a no-op `.catch()` to the
   returned promise internally ONLY if you also `console.warn` once in dev mode;
   otherwise resolve (not reject) on disconnect with `{ delivered: false }` —
   pick the first approach (reject + internal catch + dev warn) and document it.
4. Offline queue interaction: if the action is queued offline
   (`src/protocol-offline.ts`), resolve the promise when the queued action is
   finally acked after reconnect — the pending map must survive reconnect; only
   the timeout timer restarts.
5. Update docs: AIO6 in `concepts.md` now true verbatim; add a short "Awaiting
   methods in the browser" section to `docs/clients/browser.md` showing
   `await todo.add(...)` then reading fresh `todo.items`.

**Acceptance criteria:**

- [ ] Integration test: browser-side (or simulated transport)
      `await cell.method()` resolves only after the local cell signal reflects
      the change; reading state on the next line sees the new value.
- [ ] Timeout and disconnect paths tested (reject with the documented messages).
- [ ] No unhandled-rejection warnings when calling without `await` and killing
      the server (test with `Deno.test` + transport mock).

### [x] 2.3 Calling a method before `aio.run()` fails loudly

**Problem:** before binding, `counter.increment()` silently returns an inert
action object — the classic "I clicked and nothing happened, no error anywhere."

**Files:** `src/cell-methods-factory.ts` + `src/cell-actions-factory.ts`
(creator construction), new test in `tests/direct-call-return.test.ts`.

**Steps:**

1. At `cell()` creation, wrap each creator so that when invoked while unbound
   it:
   - In dev (`!prod` / `__aioDev`): **throws**
     `[counter] increment() called before aio.run() — add this cell to aio.run({ cells: [...] })`.
   - In prod: logs the same message at `warn` once per method and returns a
     resolved Promise (don't crash prod over ordering). The binding step
     (`bindCell` / `bindCellReactive`) replaces the wrapper, so bound calls pay
     zero overhead.
2. Internal callers that legitimately need raw action objects (composition,
   tests, time-travel replay) must use an explicit internal accessor — search
   for call sites that rely on "call creator to get action" (e.g.
   `creator(...args)` in `cell-reactive.ts:70`, dispatch wiring) and route them
   through `def.__aio.creators[key]` instead. **Step 1 is not done until this
   search comes back clean.**
3. Remove/adjust the `methods.md` "Direct calling" paragraph claiming pre-run
   calls return action objects.

**Acceptance criteria:**

- [ ] Dev: calling an unbound method throws the exact message above.
- [ ] `testCell` harness still works (it binds internally) — full suite green.

---

## Phase 3 — Cross-cell selectors: documented API must exist (P0)

**Problem:** `docs/basics/concepts.md:111` promises
`summary(s, counter, wallet)` with "parameter names match cell names —
auto-injected". No such injection exists — `scopeSelectors`
(`src/cell-helpers.ts:54`) passes exactly one argument (the cell's own slice).
Following the docs yields `undefined.count` at runtime. Param-name matching is
also minification-hostile, so we implement an **explicit deps form** instead.

### [x] 3.1 Implement explicit-deps selectors

**Files:** `src/cell-helpers.ts` (`scopeSelectors`), `src/cell-config-types.ts`
(selector config type), `src/cell-types.ts` (typing), new
`tests/cross-cell-selectors.test.ts`, docs: `docs/basics/concepts.md`,
`docs/state/methods.md`.

**Target API:**

```ts
const dashboard = cell("dashboard", {
  state: { ... },
  selectors: {
    plain: (s) => s.x * 2,                                   // unchanged
    summary: {
      deps: ["counter", "wallet"],                            // cell names (string)
      fn: (s, counter, wallet) =>
        `Count: ${counter.count}, Balance: ${wallet.balance}`,
    },
  },
});
```

**Steps:**

1. Tests first: plain selector unchanged; deps selector receives the other
   cells' CURRENT slices in deps order; unknown dep name → error at `aio.run()`
   (composition time, message
   `[dashboard] selector 'summary' depends on unknown cell 'walet' —
   known cells: counter, wallet`);
   deps selector recomputes when a dep cell changes.
2. Extend the selector config union in `cell-config-types.ts`:
   `SelectorDef<S> = ((s: S) => unknown) | { deps: readonly string[]; fn: (s: S, ...deps: Record<string, unknown>[]) => unknown }`.
   (Typed dep slices via generics are a stretch goal — `Record<string, unknown>`
   deps are acceptable; note it in the doc.)
3. In `scopeSelectors`, for the object form produce
   `(fullState) => fn(fullState[name], ...deps.map(d => fullState[d]))`.
4. Validate dep names during `composeCells` (where all cell names are known);
   throw the message from step 1.
5. Rewrite `concepts.md` "Selectors with cross-cell dependencies" to show ONLY
   the deps form. Delete every mention of parameter-name matching (grep:
   `grep -rn "match cell names" docs/`).

**Acceptance criteria:**

- [ ] All tests in `tests/cross-cell-selectors.test.ts` pass.
- [ ] `grep -rn "Parameter names match" docs/` → zero hits.

---

## Phase 4 — State drafts accept everyday JavaScript (P0)

**Problem:** quickstart and `methods.md` forbid `{...s}`, `Object.keys(s)`,
`s.items.map()`, `JSON.stringify(s)` inside methods, while the identical
`.filter()` is the canonical pattern in selectors and components.
Context-dependent rules for the most common operations in the language =
permanent footgun. Goal: **the DON'T list becomes unnecessary** — reads on
drafts either work or throw an exact, actionable dev error. Silent corruption is
never acceptable.

### [x] 4.1 Characterize current behavior with a pinning test suite

**Files:** new `tests/draft-read-patterns.test.ts`.

**Steps:**

1. For BOTH sync methods (Immer draft) and async methods (live proxy from
   `createLiveProxy` in `src/cell-impl.ts`), write tests covering: `{...s}`,
   `Object.keys(s)`, `Object.entries(s)`, `s.items.map(x => x.id)`,
   `s.items.filter(...)`, `s.items.find(...)`, `JSON.stringify(s)`,
   `structuredClone unsupported (expected throw?)`, `for...of s.items`,
   `s.items.length`, reading after `await` (async only), mutating inside
   `forEach`.
2. For each, assert either (a) correct plain-JS result, or (b) a thrown error —
   record which. **Do not fix anything yet.** Commit the matrix as
   `// CURRENT BEHAVIOR — see 4.2/4.3 for target` comments.

**Acceptance criteria:**

- [ ] Test file documents actual behavior for every pattern in both method
      kinds, all tests green (asserting whatever currently happens).

### [x] 4.2 Sync methods: verify Immer-native reads work, fix docs

Real Immer supports spread, `Object.keys`, `.map`, and `JSON.stringify` on
drafts. If 4.1 shows they work in aio's sync methods, the DON'T list is FUD —
delete it.

**Files:** `docs/basics/quickstart.md` ("Immer proxy restrictions" section),
`docs/state/methods.md` ("Common Pitfalls").

**Steps:**

1. From the 4.1 matrix: every pattern that works → remove from the DON'T list.
2. For any pattern that genuinely misbehaves in sync methods, fix it in code if
   Immer supports it natively (we may be wrapping the draft — check
   `cell-compose-reduce.ts`) or keep a SHORT pitfalls note with the exact error
   the user will see.
3. Replace both doc sections with: "State in methods is a standard Immer draft.
   Plain reads, spreads, `.map`/`.filter`, and `JSON.stringify` all work. One
   rule: values you take OUT of a method (effect payloads, returns) are
   snapshots — aio clones them for you."

**Acceptance criteria:**

- [ ] `tests/draft-read-patterns.test.ts` (sync section) asserts
      plain-JS-correct results for spread/keys/map/filter/stringify — and
      passes.
- [ ] Quickstart no longer contains a DON'T table for sync methods.

### [x] 4.3 Async methods: live proxy supports reads or throws precisely

The live proxy (`createLiveProxy`, `src/cell-impl.ts` ~560) re-reads fresh state
per property get. Read patterns must return **plain snapshots**, not
proxy-wrapped values.

**Files:** `src/cell-impl.ts`, `tests/draft-read-patterns.test.ts` (async
section), `docs/state/methods.md`.

**Steps:**

1. In the proxy `get` trap: when the property is a non-mutating array/object
   read method (`map`, `filter`, `find`, `findIndex`, `some`, `every`, `reduce`,
   `slice`, `concat`, `includes`, `indexOf`, `flat`, `flatMap`, `forEach`,
   `entries`, `keys`, `values`, `join`, `toSorted`, `toReversed`), return a
   function that executes against a **plain structuredClone snapshot** of the
   current value and returns plain data. Keep the existing instrumented mutators
   (`push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`,
   `copyWithin`) untouched.
2. Support `ownKeys` / `getOwnPropertyDescriptor` so `{...s}`, `Object.keys(s)`,
   and `JSON.stringify(s)` produce plain snapshots of fresh state (the
   `getOwnPropertyDescriptor` trap already reads fresh state — verify spread
   works end-to-end and add `ownKeys` if missing).
3. Anything that still cannot work must throw immediately with:
   `[cell:method] <operation> is not supported on live async state — snapshot first:
   const items = [...s.items]`.
   Never return wrong data silently.
4. Update the async section of `methods.md` pitfalls accordingly.

**Acceptance criteria:**

- [ ] Async section of `tests/draft-read-patterns.test.ts` asserts correct plain
      results (or the exact error message) for every pattern; passes.
- [ ] `s.items.map(i => i.id)` inside an async method after an `await` returns
      fresh, plain data.

### [x] 4.4 Mutations outside methods fail loudly in dev

**Problem:** `todo.items.push(x)` from a component (mutating synced state
directly) either silently desyncs or works-until-it-doesn't. Rule AIO2 exists
but nothing enforces it.

**Files:** `src/dispatch.ts` (`deepFreeze` exists), `src/aio.ts` (`freezeState`
config), `src/state-signals.ts` (browser-side cell signal values), new
`tests/freeze-dev.test.ts`, `docs/debugging/errors.md`.

**Steps:**

1. Server: default `freezeState: true` when not prod (today it's opt-in —
   confirm via `grep -n freezeState src/aio.ts` and flip the default for dev).
2. Browser: freeze the value held by each cell signal in dev mode before
   exposing it (`getCellSignal` set path) so component-side mutation throws
   `TypeError: Cannot assign to read only property` — then add a
   `window.onerror`-level dev hint mapping that error to:
   `state is read-only — call a cell method to change
   it (rule AIO2)`. The
   hint lives next to the existing dev-hint mechanism in `src/compat.ts`
   `_hint`.
3. Measure: freezing must skip slices >100KB (reuse the time-travel size guard
   threshold) to avoid dev slowdowns; log once when skipped.

**Acceptance criteria:**

- [ ] Dev: mutating `todo.items` from outside a method throws; prod: unchanged.
- [ ] Perf: booting `examples/todo` in dev shows no freeze-related budget
      warnings.

---

## Phase 5 — Per-client state is first-class (P1)

**Problem:** all cell state is shared/synced; per-user UI state requires knowing
`useLocal`/`useSignal`/module signals. Even `examples/todo` gets it wrong:
`filter` is shared cell state, so two tabs fight over the filter buttons. The
natural code (UI state in a cell) must be expressible correctly.

### [x] 5.1 `scope: "client"` cells

**Files:** `src/cell-config-types.ts`, `src/cell-create.ts`,
`src/cell-reactive.ts`, `src/aio-composition.ts`, new
`tests/client-scope.test.ts`, docs: `docs/state/cells.md`,
`docs/state/cell-visibility.md`.

**Target API:**

```ts
const view = cell("view", {
  scope: "client", // lives in the browser only
  state: { filter: "all" as Filter },
  methods: {
    setFilter(s, f: Filter) {
      s.filter = f;
    },
  },
});
```

**Semantics (final):** a `scope: "client"` cell never registers with the server
store, never syncs, never persists to Deno.Kv. Its methods run **in the
browser** against a signal-backed slice (synchronous, local). Each tab has its
own copy. Optional `persist: "local"` stores the slice in `localStorage` keyed
`aio:<appId>:<cellName>` (JSON, best-effort).

**Steps:**

1. Tests: methods mutate local slice and trigger component re-render; server
   composition skips client-scoped cells (passing one to `aio.run({ cells })` is
   fine — it is ignored server-side with a debug log, NOT an error, so one
   `cells` array can hold both); `persist: "local"` round-trips through a
   localStorage mock; two separate bindings (simulating tabs) don't share state.
2. Implement: in `cell()` when `scope === "client"`, build the def with a marker
   `__aio.scope = "client"`. In `bindCellReactive`, when the marker is present,
   bind methods to run locally: produce next state via Immer against the cell
   signal's current value, then `sig.set(next)`. Sync methods only in v1 —
   `async` methods in a client cell throw at `cell()` time with
   `client-scoped cells support sync methods
   only (no server round-trip exists); do async work in the component and call sync
   methods with results`.
3. Composition (`composeCellsWiring`): filter out client-scoped cells before
   building reducers/persistence; log
   `debug: skipping client-scoped cell 'view' on server`.
4. Generators/actions/machine on a client cell → `cell()` throws (clear message,
   v1 limitation).
5. Docs: new "Shared vs per-client state" section in `cells.md` with a 3-row
   decision table (shared cell / client cell / `useLocal`), cross-linked from
   `cell-visibility.md`.

**Acceptance criteria:**

- [ ] All `tests/client-scope.test.ts` tests pass.
- [ ] Decision table exists in `cells.md`.

### [x] 5.2 Fix `examples/todo` to use it

**Files:** `examples/todo/app.ts`, `examples/todo/App.tsx`.

**Steps:** move `filter` (and its `setFilter` method) into a `scope: "client"`
cell (or `useLocal` — prefer the client cell to showcase 5.1). Remove
`persist: { exclude: ["filter"] }` (no longer needed). Verify two browser tabs
filter independently while items stay in sync.

**Acceptance criteria:**

- [ ] Two tabs: toggling a todo syncs; changing the filter does not. Note the
      manual check in the commit message.

---

## Phase 6 — Name collisions never silently shadow state (P1)

**Problem:** `cells.md` blesses `state.error` + action `error`; the method wins
on the cell object, so `gateway.error` in a component returns a _function_ and
the state is only reachable via escape hatches — contradicting rule AIO4. The
old collision error was removed (AIO-NEW-2) in favor of silent priority.

### [x] 6.1 Collisions are a definition-time error

**Files:** `src/cell-methods-factory.ts`, `src/cell-actions-factory.ts` (there
are existing reserved-key checks at `cell-methods-factory.ts:292` to extend),
update `docs/state/cells.md` "Naming rules", existing tests that rely on the
allowed overlap.

**Steps:**

1. Restore the check: a state key that matches any
   method/action/effect/generator name throws at `cell()`:
   `[gateway] state key 'error' collides with action 'error' — reading gateway.error in
   a component would return the function, not the state. Rename one (e.g. state key
   'lastError').`
2. Selector names already collide-check; keep that.
3. Rewrite the `cells.md` "Naming rules" section: collisions between a state key
   and a callable are errors; show the rename pattern. Delete the "Allowed"
   example.
4. Search the repo/examples for the now-forbidden pattern and rename
   (`grep -rn "state.*error" examples/ tests/` and inspect).

**Acceptance criteria:**

- [ ] New unit test: colliding cell def throws the exact message.
- [ ] Full suite green after renames.
- [ ] `cell-reactive.ts:50`'s `if (key in def…) continue` guard becomes
      unreachable for state keys — add a comment noting why it remains as a
      safety net.

---

## Phase 7 — React muscle memory works in AIR (P1)

`className`, `dangerouslySetInnerHTML`, `htmlFor`, and `onChange`→input mapping
already exist. These are the remaining traps for React users.

### [x] 7.1 `useEffect` non-empty deps get real React semantics

**Problem:** `src/compat.ts:88` — non-empty deps are **ignored**; the effect
re-runs via signal tracking only. `useEffect(fn, [someProp])` never re-fires
when a non-signal prop changes. React users lose hours here.

**Files:** `src/compat.ts`, new `tests/compat-hooks.test.ts`.

**Steps:**

1. Tests: empty deps → runs once on mount, cleanup on unmount (existing — pin
   it); deps `[a]` → runs after mount and again only when `a` differs by
   `Object.is` on a later render, with cleanup before re-run; no deps array →
   runs after every render.
2. Implement classic deps comparison with `useRef` (store last deps + cleanup;
   compare each render; run effect post-render via `onMount`-style scheduling —
   find the renderer's after-render hook; if none exists, use `queueMicrotask`
   after the render commit, matching where `onMount` fires from in
   `src/aio-renderer.ts`). Signal auto-tracking must be DISABLED inside
   deps-driven effects (wrap the call in the renderer's untracked helper — see
   `_trackStart`/throwaway pattern in `src/signal.ts:58`) so behavior is purely
   deps-driven, like React.
3. Keep the one-time dev hint but reword: it now states deps are honored, and
   suggests `effect()` as the signal-native alternative.

**Acceptance criteria:**

- [ ] All `tests/compat-hooks.test.ts` pass, including "prop change re-fires
      effect".

### [x] 7.2 React event-name aliases

**Problem:** AIR maps `onXxx` → lowercase native events. React's `onDoubleClick`
would map to nonexistent `doubleclick` and silently never fire (the example
itself uses the non-React `onDblClick`).

**Files:** `src/vdom-events.ts`, `src/jsx-runtime.ts` (types), test in `tests/`
(find the existing vdom-events test file and extend).

**Steps:**

1. Add an alias map applied where event names are derived:
   `onDoubleClick → dblclick`, `onMouseEnter → mouseenter`,
   `onMouseLeave →
   mouseleave`, `onFocusCapture`-style capture suffix if
   cheap — otherwise skip capture. Audit React's common events vs lowercase
   mapping and alias every mismatch (at minimum: `DoubleClick`, `TransitionEnd`,
   `AnimationEnd`, `AnimationStart`, `AnimationIteration`,
   `CompositionStart/End/Update`, `PointerCancel` family are fine lowercase —
   verify each with `new Event(...)` names).
2. Dev-mode guard: an `on*` prop whose derived event name is not a known DOM
   event for that element logs once:
   `[air] unknown event "doubleclick" from prop onDoubleclick — did you mean
   onDoubleClick (→ dblclick)?`
   (Implement as: maintain the alias map + a known-events set; warn when neither
   matches.)
3. Add both `onDblClick` and `onDoubleClick` to JSX prop types.

**Acceptance criteria:**

- [ ] `onDoubleClick` fires on dblclick in a DOM test.
- [ ] Unknown handler name produces the dev warning exactly once.

### [x] 7.3 Typed events — no more `(e.target as HTMLInputElement)` casts

**Problem:** every handler in the examples casts `e.target`. React users expect
`e.currentTarget` typed as the element.

**Files:** `src/jsx-runtime.ts` (event handler prop types),
`examples/todo/App.tsx` (de-cast as proof).

**Steps:**

1. Define
   `type AirEvent<T extends EventTarget, E extends Event = Event> = E &
   { currentTarget: T; target: EventTarget }`,
   and type intrinsic-element handler props generically: on `<input>`,
   `onChange?: (e: AirEvent<HTMLInputElement,
   InputEvent | Event>) => void`,
   etc. Pattern this after how `jsx-runtime.ts` already declares per-element
   props (`htmlFor` on label, etc.). Cover at least: input, textarea, select,
   form (submit), button.
2. Rewrite `examples/todo/App.tsx` handlers to `e.currentTarget.value` with zero
   casts; `deno check` the example.

**Acceptance criteria:**

- [ ] `deno check examples/todo/App.tsx` passes with no `as HTML…` casts in it.

### [x] 7.4 Missing/duplicate `key` dev warnings

**Problem:** AIR is silent about missing or duplicate keys in dynamic children;
list reordering then produces wrong-element reuse with no hint (React warns).

**Files:** `src/vdom-diff-children.ts`, test alongside existing diff tests.

**Steps:**

1. In the keyed-diff path, dev mode only: when an array of children has SOME
   keyed and some unkeyed items, or >1 items and zero keys while diffing causes
   a reorder, warn once per component name:
   `[air] list under <Component> re-rendered without keys —
   add key={id} to list items to preserve element state`.
   When duplicate keys are found, warn with the duplicated key value.
2. Throttle: one warning per component type per session (reuse `_hint`-style
   set).

**Acceptance criteria:**

- [ ] DOM test: duplicate keys warn once; keyed list does not warn.

### [x] 7.5 Kill the `void signal.value` parent incantation

**Problem:** a child component reading a module signal can be skipped when only
the parent re-renders structurally; the documented fix is `void ui.value` in the
parent — pure tribal knowledge. A dev warning exists
(`src/renderer-rerender.ts:201`), but the incantation must die: **each component
instance must independently re-render when its own tracked signals change,
regardless of parent subscriptions.**

**Files:** `src/renderer-rerender.ts`, `src/renderer-lifecycle.ts`,
`src/aio-renderer.ts`, new `tests/child-signal-subscription.test.ts`, docs:
`docs/ui/air-signals.md`, `issues.md` (mark P2 resolved).

**Steps:**

1. Failing test first: module signal; parent renders `<Child/>` without reading
   the signal; child renders `sig.value`; `sig.set(newValue)` → child DOM
   updates. Add a second test: parent re-render (own state change) does not
   orphan the child's subscription afterward.
2. Diagnose with the test: instrument `inst.deps` — the expected bug shape is
   the child's subscription being disposed during a parent-driven re-render and
   not re-established, or child reads being attributed to the parent's tracking
   scope. Fix so each instance's `_trackStart`/`_trackEnd` window covers exactly
   its own render and survives parent reconciliation (re-subscribe on every
   re-render is the acceptable simple fix; dedupe via existing
   `_pendingSubscribers` batching).
3. When green: delete the `void ui.value` recipe from `air-signals.md` (lines
   around the "Module-level signals" block) and from any other doc
   (`grep -rn "void .*\.value" docs/`). Keep the dev warning but demote it to
   debug — or remove it if the invariant now always holds.
4. Update `issues.md`: mark P2 resolved with one line pointing at this task.

**Acceptance criteria:**

- [ ] Both new tests pass without any signal read in the parent.
- [ ] `grep -rn "void ui.value\|void collapsedDirs" docs/ examples/` → zero
      hits.

### [x] 7.6 Move React-compat hooks off the main surface

**Problem:** `useState`/`useEffect`/`useMemo`/`useCallback` exported from
`aio/air` (`src/air.ts:72`) make the wrong mental model the path of least
resistance.

**Files:** `src/air.ts`, new `src/air-compat.ts` (re-export module), `deno.json`
exports map + JSR manifest, `docs/ui/air-setup.md`, `docs/basics/migration.md`.

**Steps:**

1. Create export entry `aio/air/compat` re-exporting everything from
   `src/compat.ts`.
2. Keep the re-exports in `src/air.ts` for one release BUT tag each with
   `@deprecated import from "aio/air/compat" — these exist for React migration only`
   so editors strike them through. (Removal happens post-1.0; do not remove
   now.)
3. Migration doc gets a "Migrating from React" snippet showing the compat import
   and the native equivalents table (`useState`→`useLocal`/`signal`,
   `useEffect`→ `onMount`/`effect`, `useMemo`→`computed`).

**Acceptance criteria:**

- [ ] `import { useState } from "aio/air/compat"` typechecks in an example
      snippet.
- [ ] Main exports show deprecation in `deno doc src/air.ts` output.

---

## Phase 8 — No invisible conventions (P2)

### [x] 8.1 Explicit UI entry option

**Problem:** `App.tsx` is discovered by hardcoded filename under `baseDir`
(`src/server-dev-checks.ts:80`, `server-html-gen.ts:91`); `app.ts` never
mentions the UI at all.

**Files:** `src/aio-types.ts` (`UiConfig`), `src/server-html-gen.ts`,
`src/server-dev-checks.ts`, `src/server-watcher.ts:95`,
`docs/basics/quickstart.md`.

**Steps:**

1. Add `ui: { entry?: string }` (path relative to `baseDir`, default
   `"App.tsx"`). Thread it through the three hardcoded sites (gen, dev-check,
   watcher).
2. Startup log (info):
   `ui: serving <resolved entry> (default convention — set
   ui.entry to override)`.
3. Quickstart "File structure" section: one sentence naming the convention and
   the override.

**Acceptance criteria:**

- [ ] `ui: { entry: "Main.tsx" }` serves and hot-reloads that file (manual check
      ok).
- [ ] Default behavior byte-identical when option absent; suite green.

### [x] 8.2 Runtime async-misclassification guard

**Problem:** async detection is `fn.constructor.name === "AsyncFunction"`
(`src/cell-impl.ts:185`); transpiled async functions silently classify as sync,
and `markAsync` is knowledge you only gain after a debugging session.

**Files:** `src/cell-methods-internals.ts` (sync method invocation path), test
in `tests/`.

**Steps:**

1. Where a sync-classified method's return value is consumed: if it is a
   thenable AND it isn't a recognized schedule-effect shape, log error (dev:
   throw):
   `[counter] method 'save' returned a Promise but was classified sync — your build
   transpiled async functions. Wrap it: save: markAsync(async (s) => {...})`.
   Then await-and-discard the promise so state isn't half-applied... no — do NOT
   half-handle it: in dev throw before dispatch completes; in prod log and
   continue (matching current prod resilience posture).
2. Test: define a method as `function(s) { return Promise.resolve() }`
   (simulating transpiled async) → dev throw with the message.

**Acceptance criteria:**

- [ ] Test passes; genuine schedule-effect returns (`schedule.every(...)`) do
      NOT trigger the guard.

### [x] 8.3 `aio doctor` config check

**Problem:** manual `deno.json` setup needs 6 magic lines; each mistake is a
cryptic failure (JSX errors, missing kv, unresolved `aio/jsx-runtime`).

**Files:** new `src/doctor.ts`, wire into `src/aio-cli.ts`, mention in
`docs/basics/quickstart.md` troubleshooting list.

**Steps:**

1. `deno run -A jsr:@riagentic/aio/src/doctor` (and `deno task doctor` in
   scaffolds) checks, each with PASS/FAIL + one-line fix:
   - `compilerOptions.jsx === "react-jsx"` and `jsxImportSource === "aio"`;
   - import map has `aio`, `aio/air`, `aio/jsx-runtime`;
   - `unstable` includes `"kv"`;
   - `nodeModulesDir` set when `electron` imported;
   - vendored mode (`aio` maps to a path): `immer` + `@std/path` entries
     present;
   - Deno version ≥ 2.6.
2. Output ends with `N checks passed, M failed` and exit code 1 on failure.
3. Quickstart troubleshooting: first bullet becomes "run `deno task doctor`".

**Acceptance criteria:**

- [ ] Doctor run against `examples/todo` → all PASS.
- [ ] Removing `jsxImportSource` from a temp fixture → that check FAILS with the
      fix line.

---

## Phase 9 — Docs tell the truth, examples model best practice (P0, do LAST)

This phase locks in everything above. Do it after all behavior changes are
merged.

### [x] 9.1 Truth pass over claims changed by Phases 1–8

**Files/claims checklist — verify each against the new behavior and fix in
place:**

- [ ] `README.md` "State persists across restarts. WebSocket sync included." —
      now true with defaults; keep, and add "(both default on — see cell
      visibility docs to narrow)".
- [ ] `docs/basics/concepts.md` AIO6 — now literally true in browser and server.
- [ ] `docs/basics/concepts.md` cross-cell selectors — deps form only (done in
      3.1, re-verify).
- [ ] `docs/state/cell-visibility.md` — defaults `"all"`, no "nothing leaks"
      phrasing (done in 1.1/1.2, re-verify).
- [ ] `docs/basics/quickstart.md` — no Immer DON'T table; troubleshooting starts
      with doctor; "State resets on restart" bullet rewritten (persistence is on
      by default; shape-change merge rules linked).
- [ ] `docs/state/methods.md` — pitfalls reflect 4.2/4.3 reality; "Direct
      calling" section shows Promise contract incl. browser ack; pre-run call
      behavior (throws in dev).
- [ ] `docs/state/cells.md` — naming collisions are errors; shared vs client
      scope table present.
- [ ] `docs/ui/air-signals.md` — no `void x.value` incantation.
- [ ] `issues.md` — every item marked resolved with task references, or moved
      into this file.

**Acceptance:** for each box, quote the updated line in the commit message.

### [x] 9.2 Examples are exemplary

- [ ] `examples/todo`: client-scoped filter (5.2), no event-target casts (7.3),
      `await todo.add(...)` shown once with a comment explaining the ack
      contract.
- [ ] `examples/counter`: add one comment line:
      `// persists by default — restart and
  count survives`, which is now true
      (1.1).
- [ ] Add `examples/per-user` ONLY IF `forUser` docs lack a runnable sample —
      one cell with `ui.forUser` + two-user token setup. Skip if
      `docs/auth/auth.md` already has a complete runnable sample (check first).

### [x] 9.3 Final verification gate

Run in order; all must pass before declaring the overhaul done:

1. `deno test -A --unstable-kv tests/` — full suite.
2. `deno check src/ examples/` (or repo-standard typecheck task).
3. `deno lint`.
4. Boot `examples/counter`: increment → restart → value survives; startup prints
   visibility table.
5. Boot `examples/todo` in two tabs: items sync, filter independent, no console
   warnings.
6. `grep` gates from tasks 3.1, 7.5, 9.1 all return clean.
7. Update `CHANGELOG.md` with a "DX overhaul" section enumerating behavior
   changes (defaults, promise contract, collision errors, compat deprecations) —
   these are breaking changes for alpha users; say so plainly.

---

## Out of scope (explicitly — do not drift into these)

- CRDT/sync-engine internals, Electron/Android targets, build pipeline.
- New state styles or renderer features beyond listed compat fixes.
- Performance work except where a task names a budget.
- Removing the deprecated `aio/air` compat exports (post-1.0 only).
