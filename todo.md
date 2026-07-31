# Road to 1.0.0-final

Plan written 2026-07-04, current as of **v1.0.0-alpha41** (2026-07-31). **Core
principle:** all breaking changes die in alpha; beta = frozen surface,
bugfix-only; 1.0.0 = boring. Shipped work lives in `CHANGELOG.md` — this file
tracks only what remains.

---

## Shipped

- **Phase A (alphas)** — A1 public-surface audit, A2 API-snapshot gate, A3 WS
  protocol handshake, A4 persistence schema versioning, A5 `air/compat`
  permanent. A6 field reports: TUI/desktop, AIR/canvas, android (real emulator),
  browser + electron (real chromium/window), multi-client sync concurrency — all
  done **except the off-box remote report** (below).
- **Phase B gates** — B2 docs-coverage gate, B3 error-message audit, B4 bench +
  soak harness, B5 security pass, B7 kata test sweep (per-target examples +
  coverage ratchet), B8 watcher-feedback-loop hardening.
- **The perfect-aio bets** — B1 methods+patches only, B2 instance-scoped
  runtime, B3 phase 1 (explainable rejections + `serverFns`), B4 SQLite-only +
  surface diet + typed wire catalog, B5 automatable validation matrix. See
  `perfect-aio.md`.
- **src/ folderized** with the CI-enforced boundary gate.
- **Transport-boundary harness** — was the top remaining reliability gap:
  `testServer()` / `testBrowser()` / `freePort()` in `aio/testing` (alpha35) are
  the documented, reusable helpers the `e2e-*` tests used to hand-roll. The
  related "typed compile error when awaiting a browser method's return" item is
  **moot** — alpha34 made return values actually cross the bridge.
- **The upgrade tax** — every renamed option is reported and mechanically
  rewritten by `aiol --safe-fix` (alpha35), and nothing renamed is ever removed
  inside a major (`docs/basics/semver-policy.md`).
- **Cells-aware dev watch** (quant Bad #3) — a cell edit restarts the app
  instead of warning about it (alpha35, `docs/build/dev-mode.md`).
- **`aio/server` import split** (risoto) — server-only symbols live behind
  `aio/server` exclusively (alpha37), so a browser bundle cannot reach them by
  construction instead of the graph validator catching it afterwards.
- **One data directory** (alpha38) — everything an app writes is under
  `~/.<appId>/`, `data/` is the whole backup, migrated automatically; `am data`
  / `am backup` / `am restore` (`docs/persistence/where-files-live.md`).

## The gate to beta (user rule, 2026-07-19)

Ten consecutive alpha releases with **no major/critical/blocker bug and no
compat break**. A corruption-class bug found during an alpha resets the count —
that is the gate working, not a setback.

- Streak: **0** — reset 2026-07-31. The post-release review of alpha40 found
  corruption-class bugs REACHABLE in the released alpha: a transactional
  method's post-`$commit` writes were exempt from conflict validation (silent
  lost update), and the same review's differential fuzzer then found recorded
  mutation payloads being destructively mutated by batch replays
  (`s.nums = s.nums.filter(…); s.nums.shift()` committed garbage). Both fixed
  and property-tested the same day, but they shipped in alpha40 — by the rule
  above, the count restarts. (History: the alpha34 audit reset it once before;
  alpha34…alpha39 reached 7 before this reset.)
- (Bugs caught while building an alpha — the alpha38 libraryMode log
  misplacement, the app-key split-brain — don't reset it: they never shipped.
  That distinction is the whole point of the gate.)

## Remaining before beta

**space-invaders report — remaining after the 2026-07-31 batch** (shipped that
day: orphan-cell preservation, reference-based TT + `skipActions`, am instance
identity + `AIO_APPS_DIR`-scoped lock dir, `am start` GUI fail-fast, useCell
deprecation + aiol rule, aiol empty-state false positive, pressure hint):

- [ ] `ui.keyDown(key)` / `ui.keyUp(key)` in testUI (hold a key — games/drag
      UIs; `press` is a tap: `src/air/ui-trigger.ts:83`). Mirror in am trigger.
- [ ] `ui.expectCell` on a `scope:'client'` cell: resolve against the client
      signal, or fail with "scope:'client' — use ui.settle() + direct read"
      instead of a generic predicate error. `am state` same blind spot → point
      at `am surface`.
- [ ] testUI dev warning when a mounted component adds keydown/resize listeners
      on the DENO global instead of the happy-dom window (cost the app its UI
      tests until diagnosed).
- [ ] `useInterval` AIR hook (client-only loops — audio sequencers, polling;
      `useRaf` precedent).
- [ ] Docs batch: TT = "dev inspector, bounded window" + input-tape replay
      pattern; localFirst "a 60 Hz tick still crosses the wire" note;
      syncIntervalMs guidance for games; isolation = one knob (AIO_APPS_DIR).

**Declined from the report, with reasons**: per-cell Immer/freeze opt-out for
hot cells (breaks dev==prod + the immutability contract TT/sync/persist rest on;
`scope:'client'` is the sanctioned escape and was measured comfortable at 60
fps); deterministic-seed cell effect (app-level: put the seed in state); `am`
portless discovery (identity verification covers the failure mode; am discover
exists).

**For the alpha41 release notes** (work landed 2026-07-31, unreleased):
alpha40-review fixes (tx conflict escapes, patch-compact overlap, SPA-shell
syncCells, browser call-timeout bridge, deep ui.exclude, degraded registry), the
sync/async differential fuzzer + mutation-payload aliasing fix (proxy
spread-back now WORKS — `aiol` rule retired, docs updated), server-origin sync
durability (+`appDir` config-bridge fix — BREAKING-ish: data now actually lands
in the configured dir), `cdiag`/`cfg` wire frames, legacy FLOW_* error codes +
`FlowStepRecord` removed (nothing produced them since the alpha27 restructure —
alpha-window cut). Surface diet (484→466 symbols, audit-driven): removed
`_CellBuiltins`/`_InferState`/ `_InferSend` (internal types), extras'
`draft`/`matchEffect`/`UnionOf` (pre-methods relics) + duplicate
`connectCliUDS`/`DEFAULT_PRAGMAS` re-exports, `sha256Hex` (both entries), ship
family de-duped onto `aio/build` only, `authUser` off `aio/air` (use
`useUser()`), `capabilityManifest` un-exported, `./schedule` star-export made
explicit (cron plumbing off the surface). aiol's moved-off-core hint now names
each symbol's real home or says "removed". Deliberate KEEPs from the audit:
`markAsync` (error-message escape hatch), `createAuthClient` (dynamic-import
users), UI kit + TOTP (documented), type backers. **One-line source execution
shipped**: `run.sh` (+ `run.ps1`, Windows) — `curl … run.sh | sh` in any aio app
repo = production build + run of the default target; `--dev` for the dev server;
`--git <url>`/`owner/repo` clones

- installs deno/aio/am + `am fix` first; artifact found by timestamp, never by
  name; e2e'd offline in `tests/run-sh-e2e.test.ts` (test:onboard). run.ps1
  awaits the physical Windows pass (B5).

* [x] **`localFirst` opt-in — SHIPPED.** `aio.run({ localFirst: true })` makes
      every server cell run its methods where the caller is and travel as CRDT
      ops; `sync: false` is the per-cell opt-out; boot logs exactly which cells
      were adopted. The browser learns the decision from the page shell (it is
      resolved server-side at compose time) and adopts through the def's own
      `enableSync`, so config and replay reducer can never come apart. Measured,
      not claimed: `tests/e2e-local-first.test.ts` asserts a real chromium click
      lands in the op-log with the switch on, and that the same app without it
      produces no ops at all.
* [ ] **Decide the `localFirst` DEFAULT.** Needs a real local-first app to
      report back — same bar every foundational flip in this repo has met.
      Flipping it changes WHERE methods run, so it cannot land after the freeze.
* [x] **Sync-cell durability for server-origin writes** (closed 2026-07-31):
      every non-op commit to a sync cell (effect, cron, `serverFn`, plain server
      call, async `__set` outcome) folds current state into the cell's sync
      snapshot — debounced 100ms, flushed on clean shutdown, sync-op dispatches
      marked `_syncOp` so they never double-fold. Mutation-tested in
      `tests/sync-server-write-durability.test.ts`. Found alongside it: the
      config bridge DROPPED `appDir` (logs obeyed it, all data went to the
      default dir — third config-bridge fail-open); bridged + the exemption that
      masked it removed from the completeness test.
* [x] **Runtime `__aioConfig` handshake** (closed 2026-07-31): the server sends
      the resolved client config (`syncCells`/`callTimeouts`/ `renderBudget`) as
      an early S→C `cfg` frame on BOTH transports (WS + electron UDS), so
      build-time-templated shells learn compose-time decisions. Shell keys win
      per-key; late sync adoption re-runs the one resolver (`_applyServerConfig`
      → `_initSyncIfNeeded`, re-entrant) — pre-cfg actions round-trip, which is
      correct, never corrupting. `tests/cfg-handshake.test.ts` (real-WS e2e +
      apply semantics).
* [x] **Browser→server `degraded()` visibility** (closed 2026-07-31): new C→S
      `cdiag` frame — the transport relays escalation/recovery (registered via
      `_setDegradedRelay`, replayed on reconnect), the server records per client
      with caps, `/__aio/health` reports `clientDegraded` aggregated across
      connected clients and drops a client's records on disconnect. Deliberately
      NOT the diagnostic bus (dev-only) — health must work in prod. E2E over a
      real WS in `tests/cdiag-health.test.ts`.
* [x] **Deep-path `ui.exclude` reads are loud now** (closed 2026-07-31): the
      stripped parent carries a non-enumerable reporting getter at the hidden
      name — dev throws, prod warns once; spreads/keys/JSON never trip it
      (`deepExcludeLoud`, pinned in `tests/ui-exclude-client.test.ts`).
* [ ] **Structural trio** (alpha-only, each behind its own full gate run).
  - [x] **Cell-binding triple** — the fix-one-forget-the-others offender is now
        GATED rather than merged: `tests/cell-binding-parity.test.ts` fails if
        client code reads an `__aio` key the browser stub does not produce, and
        pins the server/browser catalogs to the same async classification and
        public action keys. That is what the two shipped bugs (`asyncMethods`,
        `syncConfig`-without-reducer) needed; a physical merge of three surfaces
        with different lifetimes buys little on top and risks a lot. Revisit
        only if the gate starts accumulating exemptions.
  - [x] **`AioConfig` bridge collapsed to a mechanical spread** (2026-07-31):
        the hand-maintained field-by-field copy — the source of FOUR shipped
        fail-open drops (`strictOrigin`, `redactActions`, `appDir`,
        `renderBudget`) — is now `...fc` with only consumed/wrapped keys held
        back, so a new option is bridged BY DEFAULT. The completeness test is a
        runtime sentinel gate (a value per documented option must come OUT of
        buildLegacyConfig), replacing the grep test whose exemption list masked
        two of the four bugs. `renderBudget` also added to the CellsConfig TYPE
        (it was validator-legal but untypeable). A full physical merge of
        AioConfig into CellsConfig remains possible later, but the trap class
        this item existed for is dead.
  - [ ] Split the 1016-line `server-ws.ts` factory (abuse / backpressure /
        routing).
* [ ] **B1 — the beta1 release itself.** API snapshot locked ✓, semver +
      deprecation policy ✓, codemod ✓. Remaining: the freeze decision.

## Remaining before 1.0 — physical (needs the user's machines)

- [ ] **A6 — off-box remote field report.** Same-box remote is validated
      (exposed TLS+token server ↔ remote-cli). Remaining: a really deployed
      (off-box) server + client session, plus `electron:remote` /
      `android:remote` device smokes.
- [ ] **B4 — the 72h soak run.** Harness ready (`deno task soak:72h`, heap-slope
      leak gate); 30-minute runs are clean.
- [ ] **B5 physical matrix** — Windows, macOS, a real Android device.
- [ ] **B6 — beta2+ = fixes only** + 2 more field-report apps on the frozen API.

## Phase C — 1.0.0 exit criteria (defined now, not negotiated later)

- [ ] **C1** — API snapshot unchanged across ≥2 consecutive betas.
- [ ] **C2** — latest 2 field reports contain zero P1/P2 (only "worked well").
- [ ] **C3** — all templates × app types scaffold + build + run in CI. The
      automatable slice is green (`validate:matrix`, `test:build`,
      `test:onboard`); the physical runs above are the remainder.
- [ ] **C4** — `docs/upgrade/from-beta-to-1.0.0.md` + stability statement.
      `docs/basics/semver-policy.md` already defines what is public, what
      breaking means per phase, and that there is no `@experimental` surface;
      the beta→1.0 guide gets written when beta exists.

## From the risoto field report (2026-07-26) — what's left

Closed in alpha36: worker peer-reads now throw (they returned the peer's
declared default forever), the inline-style "freeze" was stale folklore (pinned
reactive on both read paths, false lint retired), `t` markers no longer leak
from SSR, deno.json edits warn that the import map is stale, the module-errors
page counts fatals instead of burying them under standing warnings, a
caller-side post-await-read lint, and append-in-place guidance for array
patches. Verified already-fixed: browser return values (alpha34 ack transport),
the 64KB KV ceiling (gone with the SQLite move), `am restart` flag replay.

- [ ] **`persist: "db"` for big slices.** The KV size ceiling is gone, but a
      cell holding megabytes still round-trips as one JSON blob per flush. A
      first-class "this slice lives in SQLite rows" strategy is the real fix;
      every app with a large cell currently hand-rolls it via `createDB`.
- [x] **Array patch granularity.** DONE (alpha39, completed in alpha40) — a
      whole-array `replace` is rewritten as the ops that produce it, at
      patch-generation time: appends first, then any identity-matched shrink,
      insert or scattered `filter`. Only the provable cases; a reorder or
      duplicate identities still fall through as a replace.
- [x] **Worker cells in compiled binaries.** DONE (alpha39) — they already
      worked; the "not supported yet" warning was stale (Deno embeds the entry
      and reports it as `file:///…`). `test:build` now measures the isolation in
      a real binary instead of trusting the log line.

### The 2026-07-28 round (journal secrets, electron stderr, `am cost`)

Closed: `redactActions` covers all three action sinks (and the bridge finally
carries it — it had never reached a booted app); diagnostic artifacts are
removed when their writer is off; every full-state broadcast says why; the
"worker did not become ready" error leads with the real cause and the spec says
it too; `dbPath` outside the app home warns about the split. Fixed by the
reporter in-tree: journal `0600`, electron stderr filtering, `timeTravel`
honoured, `broadcastTT` coalesced, `am cost` weighing unattributed bytes.

- [ ] **Profile integrity.** `quick_check` at boot → restore from a rolling
      `VACUUM INTO` snapshot → quarantine the damaged file. ~150 lines every app
      that persists user data eventually wants; risoto wrote its own. Would be
      `db.snapshot(path)` + `checkIntegrityOnBoot: true`. Feature-sized, so it
      waits for a second app to ask — but it is the strongest remaining ask.
- [x] **A "degraded" escalation hook.** DONE (alpha40) — `degraded(name)` /
      `degradedReport()`: N consecutive failures of a named best-effort op
      escalate exactly once (one structured event, not per-occurrence spam) plus
      one on recovery, and `/__aio/health` reports `status: "degraded"` and
      names them. aio's own browser sync frames — a wall of `.catch(() => {})` —
      were the first user.
- [ ] **Time-travel subscribe-on-open.** Coalescing + the no-client gate cover
      the realistic cases; the honest fix is that a client which never opens the
      panel should receive nothing at all. Needs a `tt-subscribe` frame and a
      touch of every transport — a protocol change, so not on a whim.

Refused this round, with reasons:

- **Redact by default, using the cell-visibility secret-name heuristic.**
  Tempting, and it would have missed the exact case that leaked: the action was
  `unlock:unlockWith`, and no part of that name matches `secret|key|passphrase`.
  A heuristic that silently covers the easy names would replace an explicit list
  with false confidence — the worst outcome for a security default. The list is
  explicit, and `vault:*` makes whole cells the natural unit.
- **Deriving the app directory from `dbPath`.** `dbPath` is a FILE path; a
  framework inferring "and therefore your auth store, TLS key and journal live
  in its parent" is exactly the implicit magic that fails quietly. `appDir`
  already moves everything as one knob, so `dbPath` alone now warns about the
  split it creates instead of guessing what was meant.
- **`electronStderrFilter?: RegExp[]`.** The filter itself shipped (every aio
  app on a hybrid-GPU Linux box hits the Mesa probe noise). The escape hatch is
  speculative surface for one app; if a second app needs a different filter,
  that is the moment to add it.

## Next, from the data-directory work

- [ ] **`am update-app`** — Part 2 of
      `docs/specs/2026-07-26-data-dir-and-updates.md`, still design: verify
      (sha256 + the Ed25519 manifest `aio ship` already produces) → stage → flip
      a symlink → restart → health check → auto-rollback. Part 1 was its
      prerequisite: "swap the binary, keep the data" is only honest now that the
      data is in one place the binary never touches.

## From the llama.master field report — what's left

Round one (alpha38) closed all eight ranked items; the reporter verified each in
their own app and moved 7 → 9.2. Round two (after ~1000 more lines) is closed
too: `aiol` sees `tests/`, `testUI({ seed })` pins machine-dependent state,
`ui.absent()`/`present()`, a `t` handle on components,
`am surface
--component/--path/--depth`, the `<fieldset disabled>` typing gap,
and the `afterRender` + `useRef` pattern is documented.

Withdrawn by the reporter with evidence (do not re-open without a repro): the
`testUI` rehydration flake (their own cross-test contamination — cells are
process-wide singletons and one test's click landed a tab another test read),
the live `am dispatch ui:go` revert (6/6 and 3/3 clean on re-test), the
`<select>` bug (theirs, not aio's), and "no `am --json`" (it exists, and is in
`am help` — a discoverability miss).

Round three (llama-master's open list) closed: selectors bind under `testCell`,
`AppDirs.cache` restored, the false `appId` warning, per-method perf budgets,
`schedule.every({ skipIfRunning })`, `testUI(App, name, opts, fn)`, and a
readable `waitFor` timeout.

Refused, with the reason recorded so it isn't re-litigated:

- **`own.set` returning a value into state** — it would punch a hole in
  `(state, action) → (state, effects)`: an effect writing state directly is
  invisible to the reducer, untracked by patches and unreplayable. The factory
  calls a cell method with what it learned; documented in
  `docs/state/methods.md`.
- **A `progress` primitive** — three features needing the same shape inside ONE
  app is an app-level helper. Both reports now agree it is "nice, not urgent"
  since the danger it wrapped (the silent proxy write) is gone.

Round five: `am cost` shipped — the last un-actioned item on their list. Their
kill criterion deserves an answer on the record: _"If the diff is already
granular enough that the honest answer is always 'a few hundred bytes', then
this tool would confirm a non-problem forever — and the correct action is to
delete the `aiol` hints instead."_ First measurements say **neither**: on a
small state, patches routinely exceed `fullStateThreshold` and the whole state
goes out (a 4.7 KB cell measured 29 KB/s to one client at ~12 pushes/s, 1 full
resend in 11 pushes plus 23 acks). So the cost is real, it is often framing and
full resends rather than the diff, and the hints stay — now with a number behind
them.

Still open:

- [ ] **Per-method perf budgets, or an `io: true` marker.** Every method in that
      app shells out or reads megabytes, so the global budgets had to be raised
      to `{ reduce: 100, effect: 1000 }` + `effectTimeoutMs: 30_000` — which
      loses the signal everywhere to silence one poller. A budget on the method
      that runs cmake for four minutes would let the tight reducers keep a
      strict one. Ranked #2 on their wishlist; the design question is whether it
      hangs off the method (`{ io: true }`) or a per-method budget map.
- [ ] **A `progress` primitive.** Both reports raised it; both now agree it is
      "still nice, still not urgent" — the danger it wrapped (the silent proxy
      write) is gone, so what remains is boilerplate.
- [ ] **`am eval '<expr over cells>'`.** `am state`, `am sql` and `--json` cover
      most of it; a general evaluator on a dev-only route is a real security
      surface and needs a design, not a quick add.
- [ ] **`schedule.every` with "skip if still running"** (llama-master #3) —
      every polling cell hand-rolls an `inFlight` guard.
- [ ] **Discoverability, twice over.** `pitfalls.md` existed and they didn't
      find it; `am --json` was documented and they didn't find it. Both were
      read-the- docs failures, and two in one report is a signal about the docs'
      entry points rather than about one reader.

Closed in alpha38: selector reads are reactive everywhere (the report's #1,
which had cost it a whole `derive.ts` layer — now unnecessary), a refused write
rejects the method that made it, `own` effects run in the in-process harnesses,
`own.set` warns when it displaces a live resource, harnesses sandbox app
directories, a closed app releases its cells, `aiol-ok` works on the preceding
comment line, `am surface` marks truncation and gained `--full`.

- [ ] **`testUI` rehydration flake (report #5).** Measured at ~40% in that app;
      not reproducible here — `testUI` is hermetic by default (`persist: false`,
      fresh persist key, state reset per mount). The live-app half
      (`am dispatch
      ui:go settings` landing on the stored tab twice in
      three tries) is the more interesting claim and needs a reproduction
      against current HEAD.
- [ ] **Controlled `<select>` losing its value when options re-render (#10).**
      `tests/select-controlled.test.tsx` pins the correct behaviour and passes,
      so either it is already fixed or the trigger is Electron-specific.
- [ ] **A `progress` primitive (#10 / llama-master #1).** Every long job
      hand-rolls `{step, steps[], progress, lines[]}` plus a callback that
      writes it into state. The trap that made this dangerous (the proxy write)
      is now loud, so what remains is boilerplate, not danger — which lowers the
      priority but doesn't close it. Weigh against [[polish over growth]] before
      adding public surface.
- [ ] **`am eval '<expr over cells>'` (#9).** Would have replaced a dozen
      scratch scripts. `am state`, `am sql` and `--json` cover most of it today;
      a general evaluator is a real security surface on a dev-only route, so it
      needs a design, not a quick add.
- [ ] **`schedule.every` with "skip if still running"** (llama-master #3) —
      every polling cell hand-rolls an `inFlight` guard.

## Deliberate deferrals (with reasons, so they aren't re-litigated)

- **`scratch:` cell slice** (machine M4) — duplicate: `ui.exclude` +
  `persist.exclude` on a field already gives private, non-broadcast,
  non-persisted state (`docs/state/cell-visibility.md`).
- **`listensTo` low-latency fan-out queue** (quant) — one app, one perf profile;
  `on`/`watch`/effects cover the sanctioned path.
- **serverFn response writes** (cookies/status/headers out) — that is HTTP, and
  `route()` owns it; `serverRequest()` covers the read half.
- **Starter cells (`aio/cells/auth` …)** — app policy, not framework capability;
  the auth primitives are already usable headless.
- **DX papercut still open:** none blocking — `am fix` repairs environments,
  `aiol --safe-fix` repairs code.

## Residue from the field reports (reports purged 2026-07-25)

`feedback/*.md` (glm-audit, inews, machine, mdview, quant, realitio, risoto,
tbd) were retired once every item was closed, refused with a reason, or listed
here. They live on in git history; these are the only pieces that outlived them:

- [ ] **An end-to-end CRUD example** (realitio Bad#10, the one item they rated
      _high_) — `examples/` is counter, todo, and the per-target smoke fixtures.
      "The pieces are documented; the integration story isn't."
- [ ] **`testCell<S>` inference from the cell** (tbd B8; M7 is the same root —
      type-safe cell config). Deliberately not rushed: it changes inference in a
      helper every test file uses.
- [ ] **Parameterized selectors** `byId(id)` (realitio, low) — plain selectors
      work in the browser since alpha23; the parameterized form is the gap.
      `items.find(...)` inline works.
- [ ] **Cross-runtime `seed()` hook** (tbd M6, low) — convenience; `onRestore`
      covers the server side.
- [ ] **`useLocal` tuple form under `noUncheckedIndexedAccess`** (realitio, low)
      — the object form is the documented workaround. Verify, then close.
- [ ] **`am instances`** as the "what's running" command (realitio, low) —
      `am discover` + amui cover most of it.
- [ ] **`aio ship` auto-update client** (risoto #9, deferred as large) — the
      signing foundation shipped; the client half is the remaining piece.
- [ ] **Headless-electron e2e** (risoto #5) — parked: headless Electron stalls
      in this environment, so it needs a real desktop session.

## Post-1.0 insurance (policy, not tasks)

- Additive-only evolution: new features behind new exports/options, never
  changed semantics.
- `@experimental` tag = the only escape hatch for unstable surface.
- Keep the field-report ritual; pin field-report keep-lists as tests where
  possible.
