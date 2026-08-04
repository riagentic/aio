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
- **Cells-aware dev watch** — a cell edit restarts the app instead of warning
  about it (alpha35, `docs/build/dev-mode.md`).
- **`aio/server` import split** — server-only symbols live behind `aio/server`
  exclusively (alpha37), so a browser bundle cannot reach them by construction
  instead of the graph validator catching it afterwards.
- **One data directory** (alpha38) — everything an app writes is under
  `~/.<appId>/`, `data/` is the whole backup, migrated automatically; `am data`
  / `am backup` / `am restore` (`docs/persistence/where-files-live.md`).

## The gate to beta (user rule, 2026-07-19)

Ten consecutive alpha releases with **no major/critical/blocker bug and no
compat break**. A corruption-class bug found during an alpha resets the count —
that is the gate working, not a setback.

- Streak: **0** — reset again 2026-08-05. The `sync-chaos` fuzzer (time-derived
  seed) found a convergence divergence REACHABLE IN RELEASED alpha44: a client's
  confirmed state was missing ops (94 of 97) and could never receive them. Root
  cause: `server_ts` was issued from an IN-MEMORY counter that ran ahead of
  anything the log could prove — duplicates burned timestamps no row carried,
  compaction and D11-rejection deleted rows — so after a restart the server
  re-seeded to the surviving row max and issued ops BELOW a cursor it had
  already echoed to a client. `loadOpsSince` filters `server_ts > cursor`
  strictly, so those ops were undeliverable forever, silently. Fixed by making
  the reservation durable by construction (`highWaterTs` = max of the op-log and
  the compaction watermark) and by not burning a ts on a duplicate; pinned by
  `tests/sync/cursor-durability.test.ts` (incl. a 300-step property that every
  cursor ever handed out stays a valid delivery boundary). Verified against the
  v1.0.0-alpha44 tag in a clean worktree — it shipped, so by the rule below the
  count restarts. That is the gate working. (Previously: reset 2026-07-31. The
  post-release review of alpha40 found corruption-class bugs REACHABLE in the
  released alpha: a transactional method's post-`$commit` writes were exempt
  from conflict validation (silent lost update), and the same review's
  differential fuzzer then found recorded mutation payloads being destructively
  mutated by batch replays (`s.nums = s.nums.filter(…); s.nums.shift()`
  committed garbage). Both fixed and property-tested the same day, but they
  shipped in alpha40 — by the rule above, the count restarts. (History: the
  alpha34 audit reset it once before; alpha34…alpha39 reached 7 before that
  reset.))
- (Bugs caught while building an alpha — the alpha38 libraryMode log
  misplacement, the app-key split-brain — don't reset it: they never shipped.
  That distinction is the whole point of the gate.)

## Remaining before beta

**For the alpha44 release notes** (landed 2026-08-03, unreleased) —
**WYSIDIWYSIP** (dev/prod UI 1:1, new kata in `.katana/core.md`), from a field
report: prod electron showed a white border dev never had. Root cause = the "two
deciders" trap on app assets: dev served `style.css` from the app dir (the
entry's directory) while the build copied from a hardcoded `src/` — prod
silently shipped without CSS (default 8px body margin). Fixed: ONE decider
(`BuildConfig.appDir` = dirname(deno.json entry), same rule as the runtime's
`_inferBaseDir`) now drives the bundle's App.tsx import, style.css + icon.png
copy (all targets incl. electron AppDir + dev-window icon), with fail-loud on
missing App.tsx / stray `src/style.css` / a swallowed AppDir copy; the Android
local shell no longer hand-rolls its HTML (it delegated to the one head builder
— it had shipped a different default viewport, no viewport-fit=cover); gate:
`tests/shell-parity.test.ts` (dev-vs-prod shell byte-parity outside an allowlist
of observe-only dev scripts, electron/android shell delegation, app-dir decider
parity — mutation-tested).

Also for alpha44 — **a streaming method's last words survive shutdown**, from
the same report: a chat streaming a model reply when the window closed lost the
whole reply. Root cause = shutdown closed dispatch and THEN drained, so the
method's next draft write hit a closed queue: it died mid-reply with
`EFFECT_ASYNC_ERROR` and never reached the final persist. Three parts, one
contract — an in-flight call gets to finish WRITING, it just never gets to start
new work: (1) shutdown now `abortAllInflight()` FIRST, so a stream with no
reason of its own to stop takes its own `s.$signal.aborted` path instead of
being waited on for minutes; (2) async cell calls are tracked
(`trackPending`/`settlePending`) because `execute` returns nothing, so
`dispatch.drain()` had never had anything to wait for and sailed straight past
them; (3) dispatch accepts `_source:"Effect"` commits while draining and SEALS
only when the drain ends — late client input still drops, which is what
`close()` is for. Both waits are deadline-bounded (3 s) and say so in the log,
so a method that ignores its signal cannot hold a desktop window open. Gates:
`tests/dispatch.test.ts` (queue half: a draining effect commits, a tick still
drops, sealed after) + `tests/shutdown-inflight.test.ts` (the real app: a
streaming method is aborted mid-flight and its partial state is on disk at the
next boot). All of it is INSTANCE-SCOPED (D2): shutdown aborts and waits for its
own cells only, so one app closing never cancels another app's in-flight methods
mid-write — the same claim `_releaseCells` already makes for bindings, and the
failure it prevents is exactly the data loss this change exists to stop.

Found in the alpha44 bug hunt, all in the **build freshness cache** — one dead
gate hiding two live hazards, none of which ever failed out loud:

- **The cache had been dead since the methods restructure.** `isBundleFresh`
  stat'd a handpicked list of six framework paths, one of which
  (`state/factory.ts`) stopped existing; the stat threw, the outer catch turned
  it into "not fresh", and every build since re-ran esbuild while the "cached —
  use `--force` to rebuild" line became unreachable. Root cause was the
  handpicked list itself, so it is gone: the check now walks `frameworkSrcDir`
  (skipping build output, vendored trees and dot-dirs), which cannot rot and is
  strictly more correct.
- **Reviving the cache exposed the shared artifact.** Every target writes the
  same `dist/app.js`, but a browser bundle is ESM exporting `mount()` and an
  android bundle is an auto-mounting IIFE — no mtime can tell them apart, so
  `--android` after a browser build would have reused a bundle that cannot boot
  in a WebView (a blank app, no error anywhere). The artifact now carries a
  target stamp next to its version stamp, and a shape mismatch is stale.
- **A flat-layout app was only checked one level deep**, so editing
  `components/Btn.tsx` in an `examples/counter`-shaped app re-shipped the
  previous bundle. The walk is recursive from THE app dir now.
- `runBundle` also refuses a `BuildConfig` with no `appDir` instead of letting
  `join(undefined, "App.tsx")` — which returns `"."`, a directory that always
  stats fine — sail past the fail-loud check and die 60 lines later inside
  `@std/path`.

Gates: `tests/e2e-bundle-smoke.test.ts` grew three freshness tests (a nested
edit busts the cache · an untouched app really reuses it · switching target
never reuses the other shape), each of which fails against the pre-fix code.

Two more second-deciders of the same class as the WYSIDIWYSIP work above, both
found by asking "who else hardcodes `src/`?":

- `dev:android` spawned its dev server on a literal `src/app.ts`, so a flat app
  (`entry: "app.ts"`) booted an emulator that then waited forever on a server
  that never started. The entry now comes from `resolveEntry()` — the one rule
  `loadBuildConfig` uses — and a missing entry fails loud with the fix.
- `unsafeOutDir` refused to build into `src/` but could not know about any other
  layout, so `out: "apps/web"` in an app whose entry is `apps/web/main.ts` would
  have recursively DELETED the app's own sources. It refuses the app dir now
  too.

`resolveEntry` + `resolveAppDir` (both in `build-config.ts`) are the two named
deciders; every caller reads them instead of re-deriving the rule.

Second bug-hunt round — two more, both "the docs promise what the code does not"
and "a typo answers confidently":

- **`useInterval`/`useRaf`'s `active` was a mount-time snapshot.** `onMount`
  fires exactly once per instance, so the hooks' own documented example
  (`active={game.screen === "playing"}`) could neither start a sequencer that
  mounted on the title screen nor stop one when the player paused — the hook
  silently did the opposite of what it promised. `active` is re-read on every
  render now and really starts/stops the timer (not a callback that returns
  early), via ONE shared `useActiveLoop` rather than two copies of the
  lifecycle. Gate: `tests/ui-keys-and-client-cells.test.tsx` drives
  inactive-at-mount → play → pause → resume; mutation-tested against the old
  hook.
- **`am` turned a mistyped number into a confident wrong answer.**
  `Number("2s")` is NaN and `setTimeout(…, NaN)` fires in 1 ms, so
  `am discover --timeout=2s` swept the LAN for one millisecond and reported "no
  aio apps found" plus a note about UDP being blocked — the typo was in the
  flag, the output sent you to your firewall. Same shape in `am top`'s poll
  interval (`|| 1` silently ignored what was asked) and `am surface`'s client
  index (`surface/NaN`). All three now go through one `parseNumArg`
  (`tests/am-num-args.test.ts`); `--depth` and `tt goto` already validated,
  which is what made the gap visible.

Also: the two randomized fuzzers (`proxy-differential`, `patch-compact`) had
hard-coded seeds, so they re-checked the same programs forever — regression
tests wearing a fuzzer's name. `FUZZ_SEED`/`FUZZ_ROUNDS` now override, default
unchanged (CI must stay reproducible from its own commit), and the seed is part
of every failure message. Swept: 2000 extra proxy programs over 10 seeds and ~11
000 extra array-patch programs over 8 — **no divergence**, which is a real
result for the two corruption-class contracts, not just a green tick.

Also from the alpha44 bug hunt — **a spoofed `_source` could defeat the shutdown
drain gate.** The three network action entry points (WS, UDS, trojan) already
stripped the trusted-provenance fields a client could forge (`_user`, and
`payload._origin`), but not `_source` — and dispatch's new drain gate lets
`_source:"Effect"` actions through a CLOSED queue (a streaming method's
write-set must land) while dropping everything else. A client forging it on a
`cell:method` action could have it run during shutdown drain — new work started
while the server was closing — and its write captured by the final persist: the
exact "never start new work" invariant the gate enforces. Fixed by stripping
`_source` at all three entry points, exactly as the pre-existing fields are. The
sync-op path was never exposed (the handler constructs the dispatch object
server-side). Pinned in `tests/server.test.ts`.

The same hunt found a sibling — **a forged `_syncOp` could make a sync-cell
write silently vanish.** `_syncOp: true` is the origin marker the sync handler
sets (server-side, only on ops already persisted to the op-log) so `afterAction`
can skip the durability fold for sync cells (`aio.ts`). A network client forging
it on a sync-cell method action would make the server treat a write that is
durable NOWHERE (sync cells are excluded from KV) as already-durable — the state
change lands in memory and is lost on the next restart, no warning anywhere.
Only the sync handler produces it, so a caller-supplied value is never
legitimate. Stripped at the same three entry points, alongside `_source`. Pinned
with `_source` in `tests/server.test.ts`.

Third bug-hunt round — **`aiol`'s post-await-read rule was almost exactly
INVERTED**, which is worse than not having the rule: it fired on the framework's
own documented code and stayed silent on the shape it exists to catch, and a
hint that flags the documentation teaches people to stop reading hints (the rest
of this linter is load-bearing). Three defects, one rule:

- **False negative — the shape it exists for was the one it skipped.**
  `METHOD_RE` required the draft param to be followed by `,` or `)`, so a
  TYPE-ANNOTATED param (`async work(s: { n: number }, x)` — what real TypeScript
  looks like) never matched and the whole method went unchecked.
- **False positive — `s.$signal.aborted`**, THE documented cancellation check
  and the single most common post-await read there is. Draft meta
  (`$signal`/`$live`/`$commit`) is framework surface, not app state a concurrent
  action can move.
- **False positive — `until(() => s.x)` / `race({…})`**, the sanctioned way to
  wait on live state inside a method: re-reading is the entire point of the
  primitive. `mod.ts`'s own flagship example tripped it.

Each half mutation-tested in `tests/aiol-pattern-checks.test.ts`. The repo-wide
run drops from 38 hints to 37 — the one that disappeared was the false positive
on our own module doc — and no genuine post-await read exists in `src/`. That
`mod.ts` example is also fixed: it awaited `until(() => s.status === 'placing')`
one line after setting `s.status = 'placing'` (vacuously true) and discarded the
`race` result. It now shows what the primitives are actually for.

Fourth bug-hunt round — swept `src/` for exported functions with exactly ONE
occurrence repo-wide (the `isDriftExceeded`-was-dead-code shape). Fifteen hits,
two of them real, both **written, documented, and never wired**:

- **`client.log` grew forever.** Every other framework log obeys one on-start
  policy — wiped by default, rotated to `.N` when `backupLogs` is on.
  `client.log` (forwarded browser/Electron console output, so the file a chatty
  page fills fastest) was in NEITHER: it was missing from `logger-rotate.ts`'s
  `KINDS`, and the complete, documented `rotateClientLog()` sitting in
  `client-log.ts` was called by nothing. So it was appended to across every
  restart for the life of the app. Nothing failed; the disk just filled. Fixed
  at the root — `client` is a `LogKind` now, so it is governed by the ONE
  policy, and the second rotation implementation is deleted rather than wired (a
  rotation living next to the writer is how this happened). `AioLogger.path()`
  also lost its if-chain, whose final `return` silently aliased any unlisted
  kind onto `error.log`; it is one expression over `LogKind`, so the type
  decides the set.
- **Client-side diagnostics were themselves the silent failure.**
  `window._aioDiag` is the dev overlay, defined by `healthOverlayScript()` —
  which nothing injects into any shell. Four hand-written copies of
  `if (typeof _w._aioDiag === "function") _w._aioDiag(ev)` (`_diagEmit` plus the
  WS, IPC and AIR command routers) therefore took the else branch on EVERY page
  and dropped the event without a word. The events whose whole job is to surface
  silent failures were being silently discarded. Now one sink (`_deliverDiag`):
  overlay when present, console otherwise, severity-mapped, hint included,
  throw-guarded, with `_diagEmit`'s 5s-per-type dedup moved ahead of delivery so
  the fallback cannot flood. Pinned in `tests/diag-sink.test.ts`.

Both mutation-tested. The overlay itself stays unwired — injecting a visible dot
into every dev page is a UX decision, not a bug fix; the events are no longer
lost either way. (`errorBoundaryScript()` next to it is a React-era relic —
`Component`/`createElement` — and is left for a deliberate cleanup.)

The first version of `tests/diag-sink.test.ts` then broke the suite
intermittently, which is worth recording because the rule caught it:
`protocol-diagnostics.ts` captures `window` at import time, so the test
installed one — and left it on the global. `deno test tests/` runs every file in
ONE process, and four places in `src/` branch on `typeof window !== "undefined"`
to decide "browser", so later unrelated files went down the browser path in a
runtime with no `document`. A fixture that is more permissive than production
manufactures exactly this. The global is now restored in a `finally`, verified
with a leak-detector file that runs after it.

Chasing that failure surfaced a third one, in the **e2e harness itself**: it
spawned each test server with `stdout: "null", stderr: "null"`, so a boot
failure said `timeout: server up` and nothing more — a crash on a syntax error
and a machine merely under load produced the identical message, and the first
question a failure raises ("did it die, or is it slow?") could only be answered
by re-running the test by hand. Now the child's output is piped and drained
(unread pipes fill and wedge the child — the very hang this explains), capped at
8 KB, and `boot()` watches `proc.status` so a crash fails in **160 ms with the
child's own stack trace and line number** instead of burning the full 120 s.
Measured against a deliberately broken app, not assumed.

That immediately paid for itself: the very next suite run failed 2/3268, and the
new output named the cause on sight — `[AIO] Already running: e2e-probe`.
**Every app the e2e harness scaffolds shared ONE appId.** `writeApp` wrote
`title: "E2E Probe"` and no `appId`, and `single-instance-lock.ts` infers appId

> title > name, so all of them resolved to `e2e-probe` and therefore shared one
> single-instance lock: two e2e servers alive at the same moment meant the
> second `exit(1)`, and whichever test happened to boot alongside another
> failed. This was a REAL intermittent suite failure, not load — it had simply
> never been diagnosable before, because the harness threw the evidence away.
> Each scaffolded app now gets `appId: e2e-<uuid8>`, exactly as `testServer()`
> already scopes its own. Verified by booting FOUR e2e servers concurrently
> (passes; reverting the harness makes the same probe fail), and the whole class
> is gone rather than one test retried.

**Pre-release adversarial review (2026-08-04, six parallel reviewers over the
whole alpha44 diff)** — findings, all fixed the same day:

- **Shutdown corners.** A `serialize: true` call queued behind an aborted one
  started AFTER the abort sweep with a fresh controller — no signal, full 3s
  burn, writes lost at the seal. `abortAllInflight` now records the draining
  cells and `trackCall` hands late starters a born-aborted controller
  (`endShutdownAbort` closes the window; pinned in
  `tests/shutdown-inflight.test.ts`). The `sealed` flag itself was unpinned —
  `sealed = false` survived all 8 new tests (the drain-timeout test now
  dispatches a late `_source:"Effect"` and asserts it drops). Worker cells were
  silently OUTSIDE the whole contract: close was send-"close"+50ms+terminate,
  and the worker's registries are invisible to the main isolate — the worker
  host now aborts + drains its own isolate, streams the final patches, and acks
  `closed` (1s main deadline — deliberately under the 3s drain, since the
  budgets stack and a WEDGED sync worker can only be terminated; pinned by
  cell-workers.test.ts "a shutdown that never waits"). The drain gate also
  counted the process-global `pendingCalls()`; it counts the app's own
  (`pendingCallsFor(cellNames)`).
- **Freshness cache, again.** The revived walk covered only `src/` + the app dir
  — `packages/shared/`, root `vendor/` never busted the cache; a name-based
  `android` skip hid a real `src/android/`; a DELETED style.css/icon.png kept
  shipping from dist (mtime can't see removal); equal-mtime edits read fresh.
  Walk = whole project root minus generated/vendored (out dir skipped by PATH),
  deletion removes the dist copy, `>=` is stale. True fix (esbuild
  metafile-recorded inputs) deferred below.
- **Vacuous tests.** The trojan-strip test POSTed to `/__aio/dispatch` (404), no
  X-AIO header — passed unconditionally since it was written (now proves
  dispatch ran + gate asked); UDS strip had no test at all (now
  `tests/aio-402-uds-ack.test.ts`); `FUZZ_ROUNDS=garbage` → NaN → 0 rounds
  vacuous green (both fuzzers now throw on unreadable sweep flags; patch-compact
  honors FUZZ_ROUNDS as documented); the todo claimed a window-leak detector
  that did not exist (`tests/diag-window-leak.test.ts` now does).
- **The `am` NaN class, one layer up.** `parseGlobalFlags` still did
  NaN→silent-default for `--port/--lines/--wait/--client` — the exact bug the
  same release fixed in discover/top/surface. All through `parseNumArg`,
  `flags.error` exits loud.
- **Provenance.** The strips became ONE decider (`sanitizeClientAction`), forged
  fields WARN (attack signal ≠ shrug), and `_source` is re-stamped `"UI"`
  instead of deleted so hooks keep provenance.
- **Diag sink.** Overlay throw ate the event (falls through to console);
  transport routers bypassed the 5s dedup (dedup moved into `_deliverDiag`); the
  console fallback echoed into client.log twice (console-intercept skips
  `[aio:diag]` lines).
- Plus: `useRaf` live-active pinned (only `useInterval` was), harness decoder
  per stream + flush + drain-settle on fail, `androidApplicationId` shared by
  build & dev:android, electron-uds shell spread no longer clobbers defaults
  with undefined, shell-parity imports THE decider instead of re-deriving it,
  icon copy fails loud on a copy error of an existing icon.

**For the alpha45 release notes** (landed 2026-08-05, unreleased) — **the
network boundary**, from two field reports (`dm`: a post-quantum messenger, two
apps in one repo; `llama-master`: a LAN chat client beside its server). Their
shared verdict: everything inside one process was excellent, everything crossing
a socket had a sharp edge, and the worst ones were silent.

Three severe, all silent, all confirmed WORSE than reported:

- **`ui: { forUser }` alone disabled per-user filtering.** `normalizeUiFilter`
  returns undefined without include/exclude, so the cell classified as `raw` and
  every delta was computed from UNFILTERED state — the filter guarded the
  initial frame only. It also CORRUPTED: raw ops carry raw array indices,
  applied to an array `forUser` had already shortened. The docs had always
  documented `forUser ⇒ full`, so the code contradicted its own contract. Fixed
  at the classification; pinned as a PROPERTY (a per-user filter is never
  bypassed by a strategy) plus a two-client wire test that proves the leak the
  reporter could only infer.
- **`--expose` produced a cert aio's own client could not verify.** The reported
  cause was REFUTED empirically: the cert works fine as a pinned anchor, and
  `CA:TRUE` is what rustls rejects (`CaUsedAsEndEntity`). Two real causes:
  `connectCli` had no way to trust a cert at all, and every aio cert shared
  `CN=aio-local`, so a stale or sibling-app cert shadowed the right one → their
  exact `BadSignature`. Per-app CN + `CA:FALSE` + AKI; the boot warning names
  non-browser clients and the fix instead of browsers only.
- **The CLI client discarded ack failures** — a refused method resolved like a
  successful one and return values were dropped. Verifying it found worse:
  **every async bound method over `connectCli` was broken outright** (the
  binding awaited a LOCAL pending-call promise nothing remote settles, so a
  SUCCESSFUL call rejected 30s later with "stopped waiting"); a disconnect
  RESOLVED outstanding calls; and an action sent while reconnecting was neither
  written nor queued — a silent write loss. One ack registry now serves the
  browser and both CLI transports, per-connection (D2).

Found in review, not reported: **`am` mutations were ungated.** `verifyInstance`
— whose own comment records a green e2e writing into a production leaderboard —
guarded reads only, so `dispatch`/`sql`/`shutdown` could retarget whatever app
held that port. Gated, with a bounded TTL.

From `llama-master`, the four its diagnostics did NOT catch:

- **An `afterRender` that throws took the whole render with it** — the button
  that toggled the theme stopped EXISTING, two debug cycles away from an effect
  that threw after it rendered.
- **In the test surface an absent boolean was a callable** — `checked` was
  serialised only when true, and the handle proxy turns unknown props into lazy
  callables, so the natural assertion for "off" was unwritable.
- **Cell config inference was ORDER-DEPENDENT** — `onMigrate` above `state`
  inferred `S` from the hook, and every method body silently lost its typing ten
  lines away. `state` is the sole inference site now (`NoInfer`).
- **Hot reload updated the bundle but not the booted cell set** — a UI that
  rendered and did nothing, with the truth only visible through `am`. The
  server's booted set now rides the `cfg` frame and the client says so.

Plus: `serveDirs` (two apps in one repo can share a pure module instead of a
generated mirror a test has to police — dev-only, every baseDir guard
unchanged); the secret-name heuristic no longer fires on `latency`, `sequence`,
`currency`, `reference` (`enc` was matched as a bare substring) nor on
measurement suffixes; `aiol` no longer reports a plain WRITE as a post-await
read (the exemption was line-level, so a `deno fmt`-wrapped assignment had no
`=` on the reported line) and no longer counts tooling scripts against the
logger rule; `expose` as a config key + `--expose
--no-tls`; per-target build
entry; the db-worker crash caught before it ships with `--include` named;
`am dispatch --args`; `t.as(user, fn)`; honest `appVersion`; the perf-budget
message names `perfBudget.methods`; and every aio app lost the ~8px white border
it never asked for (the shell shipped no CSS reset and no template ships a
stylesheet).

Deferred from the alpha45 work (alpha46 candidates, none data-loss):

- [ ] `afterRender()` called OUTSIDE a render is silently dropped
      (`renderer-flush.ts`, `if (_activeRoot)` with no else) — from a
      `setTimeout`/async continuation the callback vanishes forever with no
      warning. A fail-loud violation; a dev-only warn is the fix, but it risks
      noise in existing transition paths, so it wants a careful pass.
- [ ] `aiol` never scans `scripts/` or `tools/` at all — the new tooling scope
      is written to stay correct if that widens, but today those dirs are
      invisible to EVERY rule, not just the console one.
- [ ] The post-await walker attributes a read to a nested closure inside the
      method body (a callback using the same param name) — pre-existing.
- [ ] `build-bundle.ts`'s missing-App.tsx error says `deno.json "entry": …` even
      when the value came from `--entry` (per-target) — right value, wrong
      attribution.
- [ ] `src/diagnostics/error.ts` carries a SECOND piece of BUDGET_EFFECT advice
      beside the dispatch message — a two-decider consolidation.
- [ ] `am create` still writes the array form of `build.targets` (correct and
      intended for compat), so the per-target object form is undiscoverable from
      the scaffold — a commented example in the generated deno.json.
- [ ] `--no-tls` without `--expose` is silently ignored (loopback is plaintext
      anyway, so no wrong outcome) — a "flag has no effect here" warn.
- [ ] `docs/debugging/performance.md` should say per-method budgets now cover
      sync methods' effects and that the violation prints the key.

Deferred from that review (alpha45 candidates, none data-loss):

- [ ] Freshness by esbuild metafile-recorded inputs (the honest dependency set;
      the root walk is a sound over-approximation).
- [ ] android-local shell cannot carry `ui.head`/`viewport`/`showStatus`
      (written at build time, before `aio.run()` config exists) — documented in
      `docs/build/targets.md` + scoped in the kata; wiring would need a config
      probe at build time.
- [ ] A serverFn calling `await cell.asyncMethod()` during the ≤3s drain window
      passes the gate (bindCell tags async calls `_source:"Effect"`,
      cell-catalog.ts:157; its sync twin is refused — asymmetry with no stated
      rationale). Data outcome is safe (captured by persist or loudly dropped).
- [ ] Shutdown scoping is cell-NAME-scoped, not instance-scoped (duplicate names
      across two apps warn-only; same claim bindings already make).
- [ ] prod/UDS client.log: `initClientLog` is dev-gated on the WS path but UDS
      log frames are not, and prod electron writes cwd-relative `.aio/log` that
      no policy wipes; `am log --client` reads a third path (`log/client.log`).
      One decider wanted.
- [ ] `wipeOnStart` leaves stale `.N` backups behind after `backupLogs` is
      turned off.
- [ ] e2e harness: a crash AFTER readiness surfaces as a raw fetch error without
      the child's output (`serverOutput` exists — attach it); readiness fetch
      has no per-attempt timeout.
- [ ] Transport diag routers (WS/IPC/AIR) have no router-level pin — reverting
      any one to the old inline `_aioDiag` check keeps the suite green.
- [ ] aiol post-await rule: destructured draft params unchecked; until/race
      exemption skips the whole line; `$`-prefix exemption is broader than the
      three meta fields.
- [ ] `am fix` probes entries (`src/main.ts`, `main.ts`) that `resolveEntry`
      does not recognize — fold into the decider or drop.
- [ ] `errorBoundaryScript()` (server-html-gen) is a React-era relic —
      deliberate cleanup.

**a field report report — remaining after the 2026-07-31 batch** (shipped that
day: orphan-cell preservation, reference-based TT + `skipActions`, am instance
identity + `AIO_APPS_DIR`-scoped lock dir, `am start` GUI fail-fast, useCell
deprecation + aiol rule, aiol empty-state false positive, pressure hint):

- [x] `ui.keyDown(key)` / `ui.keyUp(key)` in testUI (hold a key — games/drag
      UIs; `press` is a tap: `src/air/ui-trigger.ts:83`). Mirrored in am trigger
      (alpha44): `am trigger <idx> "<path>" keyDown|keyUp <key>` — the `__ui`
      action union + `am trigger` now accept the hold/release pair alongside
      `press`. Pinned in `tests/ui-keys-and-client-cells.test.tsx`.
- [x] `ui.expectCell` on a `scope:'client'` cell: resolve against the client
      signal, or fail with "scope:'client' — use ui.settle() + direct read"
      instead of a generic predicate error. `am state` same blind spot → point
      at `am surface`. Pinned in `tests/ui-keys-and-client-cells.test.tsx`.
- [x] testUI dev warning when a mounted component adds keydown/resize listeners
      on the DENO global instead of the happy-dom window (cost the app its UI
      tests until diagnosed). Pinned in `tests/testui-global-listener.test.ts`.
- [x] `useInterval` AIR hook (client-only loops — audio sequencers, polling;
      `useRaf` precedent). Pinned in `tests/ui-keys-and-client-cells.test.tsx`.
- [x] Docs batch: TT = "dev inspector, bounded window" + input-tape replay
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

## From the a field report (2026-07-26) — what's left

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
      that persists user data eventually wants; a field report wrote its own.
      Would be `db.snapshot(path)` + `checkIntegrityOnBoot: true`.
      Feature-sized, so it waits for a second app to ask — but it is the
      strongest remaining ask.
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

## From the a field report — what's left

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

Round three closed: selectors bind under `testCell`, `AppDirs.cache` restored,
the false `appId` warning, per-method perf budgets,
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

- [x] **Per-method perf budgets, or an `io: true` marker.** DONE (alpha) — a
      per-method budget map
      `perfBudget.methods["cell:method"].effect`/`.timeout` lets a method that
      runs cmake for four minutes keep a raised budget and deadline WITHOUT
      raising the global one (which had blinded every tight reducer to silence
      one poller). Key-validation warns on a misspelled method (boot-fails under
      `strictCells`). Pinned in `tests/perf-budget-per-method.test.ts` +
      `perf-budget-key-validation.test.ts`.
- [ ] **A `progress` primitive.** Both reports raised it; both now agree it is
      "still nice, still not urgent" — the danger it wrapped (the silent proxy
      write) is gone, so what remains is boilerplate.
- [ ] **`am eval '<expr over cells>'`.** `am state`, `am sql` and `--json` cover
      most of it; a general evaluator on a dev-only route is a real security
      surface and needs a design, not a quick add.
- [x] **`schedule.every` with "skip if still running"** — DONE: `skipIfRunning`
      drops a tick while the previous is in flight instead of stacking copies,
      survives a rejected tick (clears the guard — the hand-rolled
      `s.refreshing` flag leaks on throw), and sync ticks never skip. Pinned in
      `tests/schedule-skip-if-running.test.ts`.
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
- [ ] **A `progress` primitive (#10 / a field report #1).** Every long job
      hand-rolls `{step, steps[], progress, lines[]}` plus a callback that
      writes it into state. The trap that made this dangerous (the proxy write)
      is now loud, so what remains is boilerplate, not danger — which lowers the
      priority but doesn't close it. Weigh against [[polish over growth]] before
      adding public surface.
- [ ] **`am eval '<expr over cells>'` (#9).** Would have replaced a dozen
      scratch scripts. `am state`, `am sql` and `--json` cover most of it today;
      a general evaluator is a real security surface on a dev-only route, so it
      needs a design, not a quick add.
- [x] **`schedule.every` with "skip if still running"** — DONE: `skipIfRunning`
      drops a tick while the previous is in flight instead of stacking copies,
      survives a rejected tick (clears the guard — the hand-rolled
      `s.refreshing` flag leaks on throw), and sync ticks never skip. Pinned in
      `tests/schedule-skip-if-running.test.ts`.

## Deliberate deferrals (with reasons, so they aren't re-litigated)

- **`scratch:` cell slice** (machine M4) — duplicate: `ui.exclude` +
  `persist.exclude` on a field already gives private, non-broadcast,
  non-persisted state (`docs/state/cell-visibility.md`).
- **`listensTo` low-latency fan-out queue** — one app, one perf profile;
  `on`/`watch`/effects cover the sanctioned path.
- **serverFn response writes** (cookies/status/headers out) — that is HTTP, and
  `route()` owns it; `serverRequest()` covers the read half.
- **Starter cells (`aio/cells/auth` …)** — app policy, not framework capability;
  the auth primitives are already usable headless.
- **DX papercut still open:** none blocking — `am fix` repairs environments,
  `aiol --safe-fix` repairs code.

## Residue from the field reports (reports purged 2026-07-25)

`feedback/*.md` (a field report, a field report, machine, a field report, a
field report, a field report, a field report) were retired once every item was
closed, refused with a reason, or listed here. They live on in git history;
these are the only pieces that outlived them:

- [x] **An end-to-end CRUD example** (a field report Bad#10, the one item they
      rated _high_) — DONE: `examples/contacts` — one array in cell state, one
      `db:` table of the same name kept in step, validation that refuses in
      plain code (the caller's `await` rejects with the reason), parameterized
      selectors, a create/edit/delete UI with no transport code anywhere, and
      `checkIntegrityOnBoot`. Pinned in `tests/example-contacts.test.ts`.
- [ ] **`testCell<S>` inference from the cell** (a field report B8; M7 is the
      same root — type-safe cell config). Deliberately not rushed: it changes
      inference in a helper every test file uses.
- [x] **Parameterized selectors** `byId(id)` — DONE: `examples/contacts`
      demonstrates the parameterized form (`sorted`, `byId: (s, id) => …`).
      `items.find(...)` inline also works.
- [ ] **Cross-runtime `seed()` hook** — convenience; `onRestore` covers the
      server side.
- [ ] **`useLocal` tuple form under `noUncheckedIndexedAccess`** — the object
      form is the documented workaround. Verify, then close.
- [ ] **`am instances`** as the "what's running" command — `am discover` + amui
      cover most of it.
- [ ] **`aio ship` auto-update client** — the signing foundation shipped; the
      client half is the remaining piece.
- [ ] **Headless-electron e2e** — parked: headless Electron stalls in this
      environment, so it needs a real desktop session.

## Post-1.0 insurance (policy, not tasks)

- Additive-only evolution: new features behind new exports/options, never
  changed semantics.
- `@experimental` tag = the only escape hatch for unstable surface.
- Keep the field-report ritual; pin field-report keep-lists as tests where
  possible.
