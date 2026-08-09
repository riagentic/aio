# Road to 1.0.0-final

> **Clean desk, 2026-08-09.** The defect backlog is EMPTY: every reported
> finding is fixed (with a test) or in `feedback/refused.md` with its reason.
> What remains below is the ROADMAP — planned releases, not open defects — plus
> the blocked items whose blocker is named. Beta is targeted for alpha70–80, so
> the roadmap has runway; "there is time" is not a reason to leave a DEFECT
> open, and none are.

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

## The last-call plan (2026-08-07 audit → alpha52–56, then beta)

> **Numbering note (2026-08-09).** These rows once named alpha52–56 and the
> releases went out in a different order with different content, so a row's
> number stopped meaning anything. Rows now name the WORK; the version is
> whatever it lands in. Check `CHANGELOG.md` for what a released number actually
> contains.

Four design audits (API/config, cell semantics, architecture, DX) ran at
alpha51; user approved the package with the rule: **perfect aio is the goal,
break burden must be bearable** — every break = deprecated alias through beta

- `am fix`/`aiol --safe-fix` rewrite + loud hint at the old spelling.

* [x] **alpha52 — the honest release (bugs + guardrails, no breaks).** **SHIPPED
      as alpha52 (2026-08-08 reconciliation).** Effect-classifier unification
      (sync vs async disagree on `return [effect, data]` — make mixed arrays a
      LOUD error both paths); standalone runtime calls `initAll`/`destroyAll` +
      breaker arms (testUI/ testCell/Android currently more permissive than
      prod); `--expose` no-auth warning false-positives on
      `auth:true`/`resolveUser`; config help table (19 missing keys, `key`
      default documented wrong, `dbPath` wrong, dup row); `onMigrate` without
      `version` throws at `cell()`; persistence DDL failures fatal not
      warn-continue; `cdiag` over UDS decided + SERVES matrix test; api-snapshot
      phantom types filtered. PLUS big-data guardrails: per-cell serialized-size
      warn ~1MB / error ~16MB (configurable) at the flush/broadcast seams,
      naming the right tier; wsLimits refusal points at the tier doc; new doc
      "Big data: the four tiers" (state / db: / blobs / pipelines).

> **Numbering below is historical.** These batches were folded into alpha52 and
> alpha53 as they shipped (see CHANGELOG) — the version labels are what was
> planned at the time, not what is next. alpha54 shipped as "the last mile".

- [x] **alpha53 — one vocabulary.** Fleet names win: `service` dies (→ **SHIPPED
      — the vocabulary landed in alpha52; the release named alpha53 carried
      other work. Numbering drifted, content did not.** `server`),
      `compile:remote:*` dies (→ `deno task build`), deno.json `target` →
      `client`; scaffold 30 tasks → ~9 (+`check`/`fmt`); `am new` → `am add`
      (stops generating deprecated code); scaffold writes explicit `appId`
      (title leaves the inference chain w/ boot warning);
      `am fix
      --migrate-tasks` is the vehicle; am flags:
      `--client-index`/-i (am), `--takeover` alias for `--kill-existing`,
      `--connect` for bare `--server-url`, stale help text.
- [x] **alpha54 — the effect channel.** Effects off the return via **PARTLY
      SHIPPED — `transaction: true` is the default; the release named alpha54
      carried updates/releases/feedback instead. Re-scope what remains of the
      effect channel before alpha55.** `s.$do(effect)` (kills `: CellEffect`
      wart, own.set token registry, RETURN_TAG; `self("method", ...)` builder
      for residual self-refs); `transaction: true` default (codemod writes
      `transaction: false` into existing async cells — behaviour-preserving);
      `$`-prefixed + reserved state keys throw at `cell()` (drop dead A/E);
      `listensTo` array form dies, object form accepts arrays; selector
      deps-form takes tuple so parameterized+deps compose;
      `schedule.backoff/poll` arg order + `factor` key; `schedule.blocking` →
      top-level `blocking`.
- [ ] **The surface diet + safety defaults** (was "alpha55" — renumbered
      2026-08-09: alpha55 SHIPPED as the memory release, and a plan row naming a
      version that already exists is how 52/53/54 drifted. These rows now name
      the WORK, and take whatever number they land on.) Cell `ui:` → `visible:`
      (alias through beta; "access gates calls, visible gates reads"); `key:`
      auto-generates when exposed w/o per-user auth (codemod inserts
      `key: false` to preserve today's behaviour); `access`-without- visibility
      REFUSES on exposed/multi-user; `aio/db` types-only (`createDB` →
      `aio/server` only); delete `aio/schedule` + `aio/
      selectors`
      entries; `@internal` sweep of aio/sync + aio/state-core (~40 symbols);
      remove browser `actions`/`effects` + `timeout` + `useCell`; renames:
      `extras.lint`→`checkCells`, air `Action`→ `NodeAction`,
      `testgen`→`testGen`, drop `ExtractState`; `AioUser` opens
      (`& Record<string, unknown>`); `AioApp` typed overload; browser-surface
      snapshot twin of android-air-surface test.
- [ ] **Internals + blobs** (was "alpha56" — see the note above.)
      `protocol/`↔`state` decomposition (browser runtime files → `browser/`);
      boundary gate: trim 12 unused edges, error on unused permission, root
      files stop laundering (state/cell.ts testCell re-export dies);
      offline-queue unification (one factory, one drop policy); `routeEffect`
      exhaustive router (3 runtimes); `PRAGMA user_version` + one ordered fatal
      DDL runner; wire: ignorable- kind tier + reserved binary lane; shared
      SERVER_ONLY_AIO_SYMBOLS; `app.blobs` (content-addressed under
      appDirs().files, HTTP Range streaming, `put/get/stream/url`) +
      windowed-query example. Then: stabilization hunt → hardware week
      (B5/B4/A6) → **beta1**.

Deferred from the alpha51 architecture pass (docs/basics/app-architectures.md
names the two shapes; these are the remaining gaps, from the geng-market + dm
analyses, ranked):

- [x] **Two-app test harness — SHIPPED.** `testApps({ service, desk })` in
      `aio/testing` (src/testing/apps-test.ts): N independent apps, each with
      its own port/data dir/appId, plus `connect(name)` for the
      client-of-another-app path over a real socket. Keyed by NAME rather than
      the sketched array — an assertion about "which app" is unreadable when
      both are `apps[1]`. Covered by tests/apps-multi.test.ts. Note the
      constraint it surfaced: a cell def binds to exactly one app (D2), so a
      client binds its own instance — write client-bound cells as factories.
      (superseded) `testMultiClient` is one-server/N-clients; "service app +
      client app in one process" is hand-rolled per repo (~80 lines: dual
      `aio.run` + raw `connectCli` + until()-loops). The doc recipe shipped
      (app-architectures.md); a `testApps([svc, client])` helper is the
      candidate API once a second repo asks.
- [x] **Build-time server-URL bake for shipped clients — DONE 2026-08-09.**
      `build.server` was recorded in the manifest, printed at the end of a build
      and used to REFUSE a client-only build — and then the artifact still asked
      the user to type the address the build already knew (one field deployment
      rewrote a build-time constant to work around it). Now baked: the Electron
      client connects straight to it (`--server-url` and an imported profile
      still win; `--connect` always reaches the picker), and the Android client
      prefills + auto-connects on a FRESH install only, so a user's own choice
      always outranks it. The CLI client takes its address as argv[0] — a
      launching script already controls that, so nothing is baked there. Scheme
      inferred (`192.168.1.50:8000` works), `bakedServerUrl` is the one rule.
- [x] `afterRender()` called OUTSIDE a render is silently dropped **DONE
      2026-08-08 — dev warn naming the three callers it comes from (timer,
      promise continuation, event handler); observe-only, prod drops exactly as
      before.** (`renderer-flush.ts`, `if (_activeRoot)` with no else) — from a
      `setTimeout`/async continuation the callback vanishes forever with no
      warning. A fail-loud violation; a dev-only warn is the fix, but it risks
      noise in existing transition paths, so it wants a careful pass.
- [x] `aiol` scans `scripts/` and `tools/` — SHIPPED. `isToolingPath`
      (aiol/context.ts) skips the four rules whose PREMISE is false there (a
      one-shot CLI has no clients waiting on its event loop; a gate's stdout IS
      its interface; a benchmark's cell is a fixture). Extending the scan
      without that fired 11 premise-false findings; with it, 13 → 2, both true.
- [x] The post-await walker attributes a read to a nested closure inside the
      **DONE 2026-08-09 — a callback whose own parameter shares the draft's name
      is no longer blamed on the method (nestedShadowLine).** method body (a
      callback using the same param name) — pre-existing.
- [x] `build-bundle.ts`'s missing-App.tsx error says `deno.json "entry": …` even
      **DONE 2026-08-08 — BuildConfig carries entryFromFlag; the message blames
      --entry or deno.json, whichever it was.** when the value came from
      `--entry` (per-target) — right value, wrong attribution.
- [x] `src/diagnostics/error.ts` carries a SECOND piece of BUDGET_EFFECT advice
      **DONE 2026-08-08 — the dispatcher states facts + the per-method hatch
      (only it knows the key); the remedy lives once in generateTip. Each half
      pinned at its own source.** beside the dispatch message — a two-decider
      consolidation.
- [x] `am create` still writes the array form of `build.targets` (correct and
      **DONE 2026-08-08 — the scaffolded deno.json carries a commented
      per-target object example.** intended for compat), so the per-target
      object form is undiscoverable from the scaffold — a commented example in
      the generated deno.json.
- [x] `--no-tls` without `--expose` is silently ignored (loopback is plaintext
      **DONE 2026-08-08 — 'has no effect without --expose' warn. No wrong
      outcome, but the belief it creates ('--expose is plaintext too') is
      expensive.** anyway, so no wrong outcome) — a "flag has no effect here"
      warn.
- [x] `docs/debugging/performance.md` should say per-method budgets now cover
      **DONE 2026-08-08 — documented, with the copy-pasteable perfBudget.methods
      form and why the global budget is the wrong knob.** sync methods' effects
      and that the violation prints the key.

Deferred from that review (alpha45 candidates, none data-loss):

- [x] aiol post-await rule: destructured draft params unchecked; until/race
      **DONE 2026-08-09 (2 of 3) — the until/race exemption now belongs to the
      CALL not the line (a genuine read after `await until(…);` on the same line
      reports), and the `$` exemption is the four real meta fields instead of
      any `$`-prefixed name. Also fixed the older whole-await-line skip: reads
      to the RIGHT of the await run post-suspension like any other. Destructured
      draft params still unanalysed — aliasing needs more than a regex.**
      exemption skips the whole line; `$`-prefix exemption is broader than the
      three meta fields.
- [x] `am fix` probes entries (`src/main.ts`, `main.ts`) that `resolveEntry`
      **DONE 2026-08-08 — one entry decider (resolveEntryPath in
      server/paths.ts) shared by am and the build; am could pronounce a project
      fine on a main.ts the build would never compile.** does not recognize —
      fold into the decider or drop.
- [x] `errorBoundaryScript()` (server-html-gen) is a React-era relic — **DONE
      2026-08-08 — deleted; it had no callers.** deliberate cleanup.

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
  - [x] Split the 1016-line `server-ws.ts` factory — REFUSED (2026-08-02,
        `feedback/refused.md`): the boundary gate + tests already constrain it;
        pure churn with regression risk. Revisit only if a change there becomes
        hard to make.

## Remaining before 1.0 — physical (needs the user's machines)

## Phase C — 1.0.0 exit criteria (defined now, not negotiated later)

## From the a field report (2026-07-26) — what's left

Closed in alpha36: worker peer-reads now throw (they returned the peer's
declared default forever), the inline-style "freeze" was stale folklore (pinned
reactive on both read paths, false lint retired), `t` markers no longer leak
from SSR, deno.json edits warn that the import map is stale, the module-errors
page counts fatals instead of burying them under standing warnings, a
caller-side post-await-read lint, and append-in-place guidance for array
patches. Verified already-fixed: browser return values (alpha34 ack transport),
the 64KB KV ceiling (gone with the SQLite move), `am restart` flag replay.

- [x] **`persist: "db"` for big slices.** REFUSED (2026-08-02,
      `feedback/refused.md`) — bulk data belongs in SQLite rows via `db:` /
      `app.db` (`examples/contacts` is the shape); a second persistence strategy
      for the same data would be two ways to lose it.
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

- [x] **Profile integrity.** DONE (alpha43) — `db.snapshot(path)`
      (`VACUUM INTO`) + `db.checkIntegrity()` + `checkIntegrityOnBoot: true`:
      damaged file quarantined beside itself, boot falls back to the snapshot
      with the loss stated.
- [x] **A "degraded" escalation hook.** DONE (alpha40) — `degraded(name)` /
      `degradedReport()`: N consecutive failures of a named best-effort op
      escalate exactly once (one structured event, not per-occurrence spam) plus
      one on recovery, and `/__aio/health` reports `status: "degraded"` and
      names them. aio's own browser sync frames — a wall of `.catch(() => {})` —
      were the first user.
- [x] **Time-travel subscribe-on-open.** REFUSED (2026-08-02,
      `feedback/refused.md`) — a protocol change bought for an optimisation
      nobody can measure in production, where the feature is off.

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

## Shipped 2026-08-08 — GUI tests stopped stealing focus

- [x] **Test windows open in a nested X display, not on your desktop.**
      `src/testing/test-display.ts` resolves ONE display for every GUI child a
      test spawns: `$AIO_TEST_DISPLAY` → an Xephyr already up on `:77` → start
      one → the real display with a loud warning naming the package to install.
      Started DETACHED and **never stopped by the tests** — a harness that
      starts and kills a window per run reproduces the exact flicker it is meant
      to remove. `scripts/xephyr.sh` (start / --status / --stop) is the user's
      handle; the user closes it. Wired into `testBrowser` and the e2e harness's
      `spawnServer`, so the day `aio.run()`'s default electron client slips
      through without `--client=server-only`, the window lands inside the nested
      session instead of over your editor. Skipped entirely with no parent
      `$DISPLAY` (headless CI has no focus to steal, and Xephyr cannot nest into
      nothing).

## Shipped 2026-08-08 — heap ceiling scales with the machine

- [x] **25% of RAM, floor 4 GB, every surface.** V8's ~4 GB default killed an
      app on a 32 GB box with 28 GB free. `src/server/heap-policy.ts` is the one
      rule; `am start` / `run.sh` / the test harness resolve it at launch, the
      build bakes it (a compiled binary ignores `DENO_V8_FLAGS` — measured), and
      a bare `deno run` warns at boot with the exact flag. `memory.maxHeap`
      overrides, still clamped to 25%. Workers inherit it — the documented "~1.7
      GB worker limit" never existed, measured and corrected.
- [x] **`connectCli().ready` never settles when the FIRST connection fails.**
      **DONE 2026-08-08 — opt-in readyTimeoutMs on BOTH connectCli and
      connectCliUDS; rejects with the three causes retrying cannot fix,
      reconnection continues, default unchanged.** Verified: a wrong URL, a
      wrong token or an untrusted certificate logs
      `cannot reach … (still retrying)` and then `await app.ready` hangs
      forever. Retrying forever is right for a client that HAS connected — a UI
      must out-wait a flaky network — but the first attempt is different: those
      three causes never become good by retrying, and an unsettled promise is
      indistinguishable from a hang for a script, a test or a service-to-service
      link. (It cost two 400-second test timeouts to find, which is the point.)
      Fix: an opt-in `readyTimeoutMs` that REJECTS `ready` while reconnection
      continues — in BOTH `connectCli` and `connectCliUDS`, or it becomes the
      next two-decider.

- [x] **App updates — SHIPPED.** `updates: "<url>"` in `aio.run()`; see
      `docs/specs/2026-08-08-app-updates.md` and `docs/deploy/updates.md`.
      Manifest v2 binds channel/target/platform/data-contract INSIDE the
      signature (v1 signed the bytes but none of the coordinates, so a genuine
      `test` build moved onto the `prod` path verified perfectly); verification
      demands a trusted key; the data gate makes a version bump without
      `onMigrate` an update nobody is ever offered; atomic swap + boot-verified
      rollback + the relaunch handshake around the single-instance lock. Sources
      are agnostic: published artifacts (http/file) or a git repo.
- [x] **Problem reports (`feedback: true`).** `<data>/reports/*.json` carrying
      build identity, environment, state, timeline, diagnostics and the log tail
      — honouring the SAME `redactActions` rule as the journal/timeline (a
      report that ignored it would be the leak that list prevents). User reports
      via the `feedback` cell (`aio/feedback`), automatic capture on error
      (deduped, capped at 10/session), optional `url`/`sink` delivery that never
      replaces the on-disk copy. `am report list|show|path`.
      docs/debugging/feedback.md.
- [x] **Release workflow (`aio ship github`).** Emits a GitHub Actions matrix
      that builds Linux/macOS/Windows, signs each artifact, and publishes into
      the channel layout the updater already reads. Emitted, not integrated —
      the layout is what aio owns; a forge API is not. Also published `aio/ship`
      as a run-only entry: `aio ship` was previously reachable only from inside
      this repo, which made the release story unusable for real apps.
- [x] **Updates — the last two targets.** `electron-zip` unpacks and swaps the
      install DIRECTORY via the system shell (a process cannot move the
      directory it runs from; Windows locks the running .exe inside it), and a
      git source now clones the ref, runs the repo's `compile`, gates the built
      binary's data contract, and swaps. `run.sh` exports `AIO_BUILD_COMMIT` so
      a git install has a commit to compare against. Every target installs
      except Android (OS-mediated) and source (refuses, loudly).

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
- [x] **`schedule.every` with "skip if still running"** — DONE: `skipIfRunning`
      drops a tick while the previous is in flight instead of stacking copies,
      survives a rejected tick (clears the guard — the hand-rolled
      `s.refreshing` flag leaks on throw), and sync ticks never skip. Pinned in
      `tests/schedule-skip-if-running.test.ts`.
- [x] **Discoverability, twice over.** `pitfalls.md` existed and they didn't
      **DONE 2026-08-09 — README points at pitfalls.md right after the
      get-started block (where the readers who missed it actually were), and
      `am --help` gives `--json` its own line instead of burying it in a 14-flag
      row.** find it; `am --json` was documented and they didn't find it. Both
      were read-the- docs failures, and two in one report is a signal about the
      docs' entry points rather than about one reader.

Closed in alpha38: selector reads are reactive everywhere (the report's #1,
which had cost it a whole `derive.ts` layer — now unnecessary), a refused write
rejects the method that made it, `own` effects run in the in-process harnesses,
`own.set` warns when it displaces a live resource, harnesses sandbox app
directories, a closed app releases its cells, `aiol-ok` works on the preceding
comment line, `am surface` marks truncation and gained `--full`.

- [x] **Controlled `<select>` losing its value when options re-render (#10).**
      **CLOSED 2026-08-08 — tests/select-controlled.test.tsx pins the correct
      behaviour and passes; no reproduction against HEAD.**
      `tests/select-controlled.test.tsx` pins the correct behaviour and passes,
      so either it is already fixed or the trigger is Electron-specific.
- [x] **`schedule.every` with "skip if still running"** — DONE: `skipIfRunning`
      drops a tick while the previous is in flight instead of stacking copies,
      survives a rejected tick (clears the guard — the hand-rolled
      `s.refreshing` flag leaks on throw), and sync ticks never skip. Pinned in
      `tests/schedule-skip-if-running.test.ts`.

## Linter signal quality (observed 2026-08-05, post-alpha46)

`deno task lint:aio` on the framework repo reports 73 warnings / 37 hints, and
the majority are not actionable — which is the failure mode the post-await-read
fix was about: a lint people learn to skim is worse than one that does not
exist.

- [x] **App-shaped rules fire at the framework repo itself** — **DONE 2026-08-08
      — ctx.isApp, read from deno.json the same way run.sh decides it. Framework
      repo: 85 warnings → 0.** `no entry point
      found (src/app.ts)` and
      `appId "aio" in deno.json — move to aio.run()`. aio is not an app; the
      linter should recognise its own repo (or any repo with no cell and no
      `aio.run`) and skip the app-structure rules rather than advise moving a
      framework field into a call that does not exist.
- [x] **The `perf` sync-I/O rule dominates the remainder** on paths where its
      **DONE 2026-08-08 — gated on ctx.isApp. 84 of 85 were premise-false
      (boot-once, shutdown, CLI-once, and the journal whose fsync IS the
      guarantee). Apps still get it — pinned by a test.** own message is false:
      its text is "every client's next action waits behind it", but the hits are
      boot-once (`async-db` pre-flight), shutdown (`checkpoint`), and CLI-once
      (`app-key`) paths that are never on the dispatch path. Either the rule
      should not fire outside dispatch-reachable code, or the framework should
      carry `// aiol-ok` with a reason at each deliberate site. Annotating ~60
      sites is churn; narrowing the rule is the root fix, and it is the same
      shape as the `enc`-matched-`latency` heuristic narrowed in alpha46.

## Post-alpha45 bug hunt (2026-08-05) — deferred, none data-loss

The hunt itself is in `CHANGELOG.md`; these are the items deliberately NOT
fixed, each with the reason:

- [x] **`access`-gated cells broadcast their whole state to every socket.**
      DECIDED and closed (2026-08-05). `access` gates method CALLS, `ui` gates
      reads; neither may derive the other, because "only admins may edit,
      everyone may read" is a real design. So the semantics stay — what changed
      is that the framework now refuses to let the read side go UNDECIDED: a
      cell declaring `access` with no `ui` warns at boot, naming the exposed
      fields, and any explicit `ui` (including `ui: "all"`) is an answer that
      silences it. Sync cells get different advice, because a sync cell that
      hides state is refused at compose — telling one to add `ui: "none"` would
      be advice that hard-fails the next boot. Pinned by
      `tests/access-vs-ui-visibility.test.ts`, which also asserts the WIRE truth
      in both directions so the boundary can never move by accident. This closed
      an asymmetry, not just a gap: composition REFUSES TO BOOT on a guess (a
      field whose NAME matches a credential regex) while the author's own
      explicit `access` declaration was read by nothing.
- [x] **Shared-key mode serves a browser — DONE 2026-08-09.** The request that
      PROVES it holds the key is handed the credential back as an HttpOnly,
      SameSite=Strict cookie named per app (`aio_key_<appId>` — cookies ignore
      the port), Secure when the page is https, session-scoped, issued once. The
      page's own asset requests then authenticate; before this only the shell
      load carried a credential and every asset 401'd. Eight tests, four against
      a real keyed server over https with its own pinned cert; mutation-checked.
      `key:` + `auth:` still refuse to boot together — unchanged, out of scope.
- [x] **Stale `app.key` after a mode switch** — FIXED (2026-08-05). Cleared on
      the per-user path (`users` / `resolveUser` / `auth: true`), which is the
      only signal that makes the shared key definitively dead. NOT on
      "unexposed": a plain local boot of a `key: true --expose` app must keep
      its key, or the next `--expose` mints a different one and breaks every
      paired device ("one key, use forever").
      `tests/app-key-mode-switch.test.ts` pins BOTH directions — the over-eager
      fix fails it.
- [x] **`deep-merge`'s cycle branch** — FIXED (2026-08-05), and it was worse
      than recorded: not a diagnostic gap but SILENT DATA LOSS. `seen` was a
      global visited-set, so it answered "have I ever seen this object?" when
      the question that stops recursion is "am I INSIDE it right now?". The
      first also fires on a DAG — one object reachable by two paths, which
      `structuredClone` preserves — so the SECOND reference merged to the
      declared default: `{a: shared, b: shared}` holding `n: 99` restored `b.n`
      as `0`. Fixed by tracking the ancestor path (add on entry, delete on
      exit), which also dissolves the false-positive worry recorded above: a DAG
      is no longer mistaken for a cycle, so a real cycle can now fail LOUD with
      its path. Correct cycle detection removed the visited-set's accidental
      breadth bound (a shared-at-every-level DAG costs 2^depth), so MAX_NODES
      was added with the same keep-the-DATA-and-say-where treatment as MAX_DEPTH
      — 30 levels goes from heap exhaustion to 30ms.
      `tests/deep-merge-shared-refs.test.ts` (6 blocks) pins both guards.
- [x] `/__aio/<framework src>.ts` mounted in PROD — FIXED (2026-08-05). Gated on
      `!prod`, so prod 404s the whole framework-source namespace. Safe because
      `prodHTML` emits no import map and loads one bundled `/app.js` — nothing
      in a prod page ever names these routes. It was not merely dead surface:
      each hit was a file read + an esbuild transpile, with `no-cache` on the
      response so nothing downstream absorbed a repeat — an unauthenticated
      request costing the server far more than the caller, the same amplifier
      shape as the alpha49 auth-budget DoS.
      `tests/aio-namespace-prod-surface.test.ts` pins prod-404, dev-200, AND
      that the prod shell emits no import map — so if a future change puts one
      back, the removal is revisited instead of silently breaking.
- [x] `shapeDriftSummary`'s parenthetical misattributes the mechanism. Probed
      **DONE 2026-08-08 — persistence keeps the value, not deepMerge (which
      drops it from live state). The mechanism is what someone reads to predict
      the next case.** 2026-08-05 (declare {a,b} → narrow to {a} AND WRITE →
      re-declare): the stored value SURVIVES, so the outcome claim "keeps the
      stale value" is correct and this is not data loss. But deepMerge does not
      preserve it — it drops the field from LIVE state (the narrowed boot really
      does see only `a`); persistence is what keeps it on disk. Wording only.
- [x] `/__aio/pair`'s 401 hint — FIXED (2026-08-05). Says `am pair`, and takes
      the window from `PIN_TTL_MS` instead of a typed-out "3 minutes" that was
      free to drift from the real lifetime.
- [x] `_syncSqlite` re-diffed every table — FIXED (2026-08-05). `syncTables`
      pre-filters on IDENTITY (`state[n] !== prev[n]`), which is the right test
      because immer shares structure, but cloning the whole table set every
      persist minted fresh objects so the check was always true. Now only
      CHANGED tables are cloned; unchanged ones carry their existing baseline
      through by reference. The clone's guarantee is untouched — no baseline
      ever aliases live state — and a `getTableState` that rebuilds its arrays
      degrades to exactly today's behaviour. Measured with a 500-row table over
      6 persists that never touch it: 6 full re-diffs → 2 (boot + close).
      Correctness covered by the 72 existing db tests; the CPU win itself is
      measured, not gated (no seam exists to observe it without adding one).
- [x] `abortAllInflight`'s "commit what it has" rationale is now true only for
      **DONE 2026-08-08 — documented: true for non-transactional cells only; an
      interrupted transaction commits nothing, which is the correct outcome.**
      NON-transactional cells (an interrupted transaction must not persist half
      of itself). Documented at the fix site; wants a doc line.

## Hunt 7 (2026-08-05) — my own findings, alongside the four agent sweeps

- [x] **Worker-cell shutdown durability had ZERO real coverage.** The contract
      "an in-flight method finishes writing" is implemented TWICE — Phase 1 of
      shutdown.ts for main-isolate cells, and the worker host's own abort+settle
      for worker cells, because their method registries live in another isolate
      where `abortAllInflight` cannot reach. Only the main-isolate half was
      tested, and no in-process test CAN cover the other: `libraryMode`
      deliberately runs worker cells in-isolate, so every existing test
      exercised the main-isolate path while appearing to cover workers. The
      implementation turned out CORRECT (negative evidence — no bug), but three
      load-bearing facts were held only by comments. Now pinned by
      `tests/shutdown-worker-cell-durability.test.ts`, which spawns a real app
      with a real entry module and reads the DB: (1) the worker's post-abort
      write reaches disk — red when the host's abort+settle is removed; (2)
      `workerPool.close()` MUST precede `_shutdownRuntime()`, because the
      worker's final writes arrive as ordinary dispatches and need dispatch
      still open — red when the two lines are swapped; (3)
      `WORKER_CLOSE_DRAIN_MS < WORKER_CLOSE_DEADLINE_MS`, or the main isolate
      terminates the thread mid-drain. Fact (3) needs its own shape assertion:
      the end-to-end test passes even with both equal, since a cooperative
      worker acks in milliseconds and never approaches either bound.

- [x] **Electron reconnected on a different curve from every other client.**
      `electron-uds.ts` imported `BACKOFF_BASE_MS`/`BACKOFF_MAX_MS` from the
      shared authority and then RE-TYPED the formula inline — and the copy had
      already drifted, dropping the ±20% jitter term. Fixed by emitting
      `backoffDelay.toString()` into the generated `main.cjs` (it cannot import
      at runtime — it is a standalone CJS file in the packaged app), so a change
      to the shared curve reaches it by construction. A copy that CANNOT drift
      beats a copy that is merely correct today.
      `tests/electron-backoff-one-decider.test.ts` asserts textual identity with
      the authority, evaluates the emitted function and proves the jitter is
      actually present (a bare exponential fails), and asserts the retyped
      formula survives nowhere in the script.

- [x] **A `port: 0` app bricked itself on a clean shutdown.** HIGH. `readLock`
      validated with truthiness —
      `if (!data.appId || !data.pid ||
      !data.port) return null` — and
      `port: 0` is falsy while being the documented "pick a free port" setting,
      written into the lock verbatim. Every consequence compounded the same way:
      `release()` guards on `readLock` returning our record, so a GRACEFUL
      shutdown removed nothing; staleness is decided from that same data, so the
      leftover could never be recognised as stale either; so the next launch
      refused to start, permanently, with "Already running". An app bricked by
      its own clean exit, recoverable only by deleting a file in a runtime dir
      nobody knows about. Fixed by checking each field's SHAPE (`typeof`,
      `pid > 0`, `port >= 0`) instead of its truthiness. Singleton enforcement
      itself was NOT affected (verified: a second instance is still refused
      while the first lives) — that path does not go through the validity check.

- [x] **Only the FIRST lock in a process was released on a signal.** The
      registration flag is static (right — one listener set per process) but the
      handler closed over ONE instance's `this`, so a second locked app (a
      supported shape: `singleton` defaults to true outside libraryMode) got no
      cleanup at all and leaked its lock on SIGTERM. The mirror case was live
      too: `_unregisterCleanupHandlers` tore the listeners down whenever ANY
      lock released, un-protecting apps still running. Both are the same
      conflation — "are the listeners installed?" and "which locks do they
      release?" are two facts — now held separately by a live-lock set.
      `tests/single-instance-lock-port-zero.test.ts` (6 blocks) pins all three,
      3/3 mutations red. The multi-lock probes deliberately hold the child alive
      with a real timer and INSPECT after signalling rather than waiting for it
      to exit: an unresolved promise does not hold Deno's event loop open, so
      the first draft passed (and regressed into a 400s HANG) for reasons that
      had nothing to do with locks.

- [x] **`isConnectionDegraded()` was a documented function you could not
      import.** Two doc pages tell the reader to call it to drive a
      "reconnecting / slow connection" indicator, and both import from
      `aio/air`, which exported it from nowhere — following the documentation
      produced a module-resolution error. The function was real and correct the
      whole time; only the door was missing. Exported (strictly additive, one
      symbol, `api:update` regenerated). The existing doc-imports gate could not
      see it — it scans `import` statements inside fences, and this promise is
      made in PROSE — so `tests/docs-promised-exports.test.ts` checks
      framework-owned `name()` mentions in the prose of those pages against what
      the entry actually exports.

- [x] **`markAsync` on a client-scoped cell: server accepted, browser threw at
      module load.** "Is this method async" was decided twice — the browser cell
      stub asked the shared `isAsyncFunction` (which knows both a native
      `AsyncFunction` and the `markAsync` mark a transpiled async body carries),
      while `cell()` itself only tested `constructor.name === "AsyncFunction"`.
      A transpiled async method therefore passed the server's guard and blew up
      as the browser module loaded: server boots, app serves, page is blank —
      the worst possible split for a rule whose whole job is to refuse the
      configuration early and loudly. Collapsed onto `isAsyncFunction`;
      `tests/client-cell-async-guard-parity.test.ts` pins both forms plus the
      sync case (so the guard cannot become a blanket refusal).

- [x] **A false wiring claim in a security-critical comment.**
      `server-auth.ts`'s `armLocalControl` docblock still said the function was
      "NOT yet called from `startServer`", that per-user apps therefore refuse
      `am`/amui, and listed the two edits needed to finish it — long after both
      landed (`server.ts:169` and `:568`). It described the opposite of what the
      code does, in the one place a reader is auditing a trust boundary, and
      invited someone to "complete" wiring that already exists. Rewritten to
      describe the live wiring; the rationale for WHERE the branch sits is kept.

- [x] **Dispatch while time travel is paused lied to the caller.** The drop
      happened inside `reduce`, which returned state unchanged — but by then the
      action had been ACCEPTED, so the caller's promise settled as SUCCESS with
      nothing applied. An async method was worse: its result rides a later
      commit that now never came, so it hung the full 30s call timeout and then
      rejected with a message that was simply false ("it may still be running...
      its writes will still commit") and advised raising `effectTimeoutMs`.
      `undo` pauses, so pressing undo in the debug panel put every subsequent
      call into that state. Refusal moved to the dispatch DOOR — the only place
      that still owns the caller's promise — restoring B-4 ("a dropped action
      must REJECT, not resolve"), with the reduce-time swallow removed so there
      is one decider. Reuses `DISPATCH_CLOSED` (a new code would change the
      public `AioErrorCode`), warns once per action type like the closed path,
      and rejects through `rejectDropped` so a fire-and-forget schedule cannot
      raise an unhandled rejection. Time travel's own restore assigns state
      directly and never passes the gate, so undo/redo keep working.
      `tests/time-travel-paused-dispatch.test.ts`, 2/2 mutations red.

## Hunt 8 (2026-08-05) — my own findings

- [x] **Two offline queues, one health question — and the indicator saw only
      one.** Cell-method dispatch queues in `browser/browser-air-transport.ts`
      (cap 1000, drop-oldest, promise rejection); `useCell().send` /
      `useAio().send` queue in the isomorphic core (cap 100, drop-newest,
      returns false). Two queues is STRUCTURAL — the boundary matrix forbids
      `state` importing `browser`, so the core cannot delegate — but "is this
      connection degraded" is one fact, and `isConnectionDegraded()` (which the
      docs tell you to render as a reconnecting indicator, and which hunt 7 had
      just made importable) consulted the cell-method queue alone. A `send()`
      caller could back up to the point of dropping actions with the indicator
      still reporting a healthy connection. Now both queues feed it. A drop on
      the core side was also quieter than the same event on the other — console
      only, invisible to the diagnostic bus, the dev overlay and `am` — so it
      emits a diagnostic now too. `tests/offline-queue-both-paths.test.ts`, 2/2
      mutations red. The remaining asymmetry (sync boolean vs rejected promise)
      is inherent to the two APIs and is now DOCUMENTED rather than implied
      away: docs/persistence/offline.md described the cell-method contract as if
      it were universal.

- [x] **`am timeline`/`am replay` claimed to expose "every state change".** They
      do not: `afterActionHook` returns early for a `sync: true` cell (its
      writes are durable in the CRDT op-log, not the dispatch journal), so no
      sync-cell change has ever appeared in either. Doc corrected to say
      DISPATCH history, with an explicit note pointing at `am state` and the
      CRDT protocol page. NOT fixed in code deliberately: giving non-journalled
      entries a seq risks colliding with the journal's next append, and that
      allocation belongs with the journal/timeline owner — see below.

- [x] **The diagnostic bus went silent about going silent.** `diagEmit` dedups
      on `type` alone inside a 5s window, so a suppressed event may have carried
      a DIFFERENT message — a second cell failing while the first is still in
      the window — and it vanished without trace. In the one subsystem whose
      whole job is to surface silent failures, that was the thing that had gone
      quiet. The window itself is a deliberate, explicitly tested contract
      (volume control), so it is UNCHANGED and no new events are emitted:
      suppressions are tallied per type and the next event through carries
      `suppressed: N`. Absent when nothing was lost, so "was anything dropped?"
      stays something you see rather than read.
      `tests/diagnostic-bus-suppression-count.test.ts`, 2/2 mutations red — the
      second mutation covers always-attaching a 0, which would have made the
      field noise. The tally is pruned alongside the dedup map so it cannot
      leak.

- [x] **The shutdown flush had its own drifted copy of the SQLite sync.** The KV
      half of that block carries a comment explaining it was unified with the
      scheduled path precisely to stop this, but the SQLite half stayed a
      hand-copy — and had drifted three ways: it never called
      `_reportPersistError`, so a table sync failing on SHUTDOWN (the app's last
      chance to write anything, and the failure you most need to hear about)
      reached the log and nothing else; it cloned every table rather than the
      changed ones; and it advanced `prevDbState` without the live-reference map
      beside it, leaving two halves of one baseline disagreeing. Now calls
      `_syncSqlite()`. `tests/persist-flush-error-report.test.ts`, mutation red.

## Hunt 9 (2026-08-05) — my own finding

- [x] **"Every harness arms dev-strict" was a hand-maintained invariant that had
      already broken once, and nothing gated it.** CLAUDE.md is explicit that
      tests must be the STRICTEST environment; `_armTestStrict()` is how a
      harness delivers that (frozen-state enforcement, the readonly hint, the
      hidden-field read guard). It previously lived in `cell-test.ts`, the
      harnesses import each other, and an import cycle meant THREE OF FIVE never
      called it — so a component that illegally mutated committed state passed
      `testComponent` and threw everywhere else. That was fixed by moving the
      function and adding the call to each harness, i.e. by re-creating the same
      hand-maintained invariant one layer along, with no gate.
      `tests/harness-strictness-gate.test.ts` now (a) proves each in-process
      harness arms, BEHAVIOURALLY — it clears the flag, invokes the harness with
      deliberately invalid arguments so nothing heavy boots, and watches whether
      the flag comes back set (not by grepping source, which is a named
      anti-pattern here); (b) fails when `aio/testing` grows a function that is
      in neither MUST_ARM nor EXEMPT, so the next harness cannot skip the
      decision; and (c) pins the BEHAVIOUR the flag stands for, so the file
      cannot pass while `__aioDev` means nothing. 2/2 mutations red — the first
      reproduces the original three-harness regression exactly. NOT a bug today:
      all six in-process harnesses currently arm. `testBrowser` is exempt with
      its reason recorded (it owns only an external browser process; the app
      under test boots via `testServer`, which arms).

- [x] **A security test that was wrong one run in sixteen.**
      `tests/local-control.test.ts` built its "wrong credential" fixture as
      `real.slice(0, -1) + "0"`. The control key is hex, so whenever it already
      ended in `0` the "bogus" value WAS the real key — correctly accepted, and
      the test then failed claiming a wrong credential had been let through.
      6.25% of runs, on a security assertion, which is the worst place for a
      failure that reads as flakiness and gets waved through. The near-miss is
      now built by CHANGING the last character, with an assert that it differs.
      Proven by forcing a key ending in `0`: old fixture RED, new fixture GREEN.

- [x] **A sync test whose premise was a coin flip.** The double-apply guard in
      `tests/browser-sync.test.ts` stamped the snapshot's low-water mark and the
      ack with `Date.now()` while its own comment said the ack sits "at or below
      the snapshot's cursor". Two wall-clock reads can land in the same
      millisecond, and the tie is then broken by node id — a random client uuid
      compared against `"s"` — so the ordering the test depends on was decided
      by chance. Both stamps pinned; the assertion is unchanged and still goes
      red when `serverTs` forwarding is removed.

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
- [x] **Parameterized selectors** `byId(id)` — DONE: `examples/contacts`
      demonstrates the parameterized form (`sorted`, `byId: (s, id) => …`).
      `items.find(...)` inline also works.
- [x] **`useLocal` tuple form under `noUncheckedIndexedAccess`** — the object
      **CLOSED 2026-08-08 — does not reproduce. Verified by compiling the tuple
      form in a fixture with the flag on: a tuple has fixed arity, so the flag
      (which widens index signatures and arrays) never touched it. Pinned by a
      type annotation in the android surface test.** form is the documented
      workaround. Verify, then close.
- [x] **`aio ship` auto-update client** — the signing foundation shipped; the
      **DONE — shipped as alpha54's update path (updates: "<url>", manifest v2,
      atomic swap, boot-verified rollback).** client half is the remaining
      piece.

## Post-1.0 insurance (policy, not tasks)

- Additive-only evolution: new features behind new exports/options, never
  changed semantics.
- `@experimental` tag = the only escape hatch for unstable surface.
- Keep the field-report ritual; pin field-report keep-lists as tests where
  possible.
