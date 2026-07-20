# Changelog

## 1.0.0-alpha24 — magic onboarding (`am`) + sync method returns + correct server/client boundary (2026-07-20)

Onboarding collapses to a single delightful path, sync methods can return values,
and the server/client import guard becomes precise (eager blocks, deferred warns).

### Added

- **`am create <name> [--template=counter|todo]`** — one command scaffolds a
  runnable, git-initialized app that ships a **passing** starter test and builds
  to every target with one `deno task` line (`dev`/`test`/`compile`/`electron`/
  `android`). Pinned to the exact aio version `am` was installed at, so app and
  framework stay in lockstep. `am update` / `am uninstall` self-manage.
- **One-line install** — `curl -fsSL …/install.sh | sh` (and `install.ps1` for
  Windows) installs Deno if missing, then `am` onto PATH via `~/.deno/bin`. Uses
  the `@^1.0.0-alpha` range (a **bare** `jsr:@riagentic/aio` mis-resolves to an
  old stable during the alpha).
- **Sync method return values (AIO-427).** A sync method may `return` a value and
  `await cell.method()` resolves with it — no more `async`-just-to-return. Effects
  (`schedule`/`own`) still route; a returned draft slice is snapshotted so it
  survives the reducer. Types inferred via `DirectCalling`.
- **`deno task check:graph`** — CI-friendly one-shot module-graph validator
  (same engine as the dev server); exits non-zero on a guaranteed client break.

### Changed

- **Server/client boundary is now precise (eager vs deferred).** A **static**
  import of a `node:` builtin or omitted `aio` server-symbol (`createDB`, …)
  reachable from the UI entry **blocks** (it blank-screens the sandboxed
  renderer — `deno task compile` fails the same, so dev==prod). A **dynamic**
  `import()` of the same is the documented escape hatch — **deferred, a warning,
  never a block**. `@std/*` + `Deno.*` usage stay warnings. Fixes false-positives
  on apps that already lazy-load server-only modules.
- **Onboarding is one path.** `am` replaces the old interactive scaffolder
  (`src/create.ts`, `init.ts`, `utils/`) and the `./create` export — removed.
  `examples/playground` removed; `counter`/`todo` are the `am create` templates,
  `examples/targets/*` remain as CI build-smoke fixtures.

### Fixed

- `AioApp.dispatch` and bound sync methods resolve with the transported return
  value (or `undefined`) instead of always `Promise<void>`.
- **`am` installs lean.** `am` no longer drags the esbuild native binary (~10MB)
  into its install graph — the transpiler's `import("npm:esbuild@…")` now uses a
  computed specifier, so `deno install am` doesn't eagerly fetch (and fail on
  `ETXTBSY` for) an esbuild it never uses. esbuild still loads at runtime when the
  dev server transpiles.

## 1.0.0-alpha23 — field-report closeout: silent traps → loud, early, attributed (2026-07-20)

Five field reports (tbd, risoto ×2, realitio, inews) worked end to end. The theme:
every fix either **removes** a silent failure or makes it **loud, early, and
attributed** — never silent, late, and anonymous. Each fix ships with a
regression test proven to fail on revert.

### Fixed

- **Sync cells recover their state on a headless restart.** The committed op-log
  is replayed through the reducer at boot (after KV restore + `onRestore`, before
  any dispatch/broadcast) — previously a `sync: true` cell came back empty until a
  client reconnected (silent data loss). Logged per cell.
- **`deepMerge` keeps dictionary entries.** An empty-object initial
  (`{} as Record<K,V>`) is now treated as a dictionary — persisted entries
  survive restore instead of all being silently dropped.
- **KV over-limit degrades instead of nuking everything.** A single >64KB cell no
  longer fails the whole atomic commit; the healthy cells persist, the over-limit
  cell keeps its last-saved value, and the offender is named. Single-key mode
  names the largest cells.
- **`db:` table named after a cell throws at boot** (was a silent slice
  overwrite that broke the cell's methods), naming both.
- **Selectors are callable in the browser** — they were server-only, so
  `cell.count()` threw `is not a function` client-side with no warning. Now bound
  the same both sides; deps-form selectors read other cells reactively.
- **Router components type-check.** `Route`/`Link`/`NavLink`/`Outlet`/`page`
  returned `unknown` (broke every JSX use); now `VNode | null` / `VNode`.
- **Dev graph-validator no longer false-positives on English.** A bare `from "`
  inside a JSX string literal (a title like "Recovering from Disaster") was
  parsed as an import and returned a Module-Errors page for a valid app.
- **`onStart` can seed via a cell method** — it now fires after the callable
  method surface is bound.
- **Connection loss is reported once, clearly** (UDS + WS) — "backend not
  reachable — is the aio server running?" instead of a per-retry stack-trace/log
  flood, plus one "reconnected" on recovery.

### Added

- **`libraryMode: true`** on `aio.run()` — no `Deno.exit`, no signal handlers, no
  singleton lock; `app.close()` resolves clean. Boots a real server inside
  `Deno.test` (sanitizers on) — the unlock for end-to-end persistence tests.
- **Responsive `<meta viewport>` by default** + `ui.viewport` override / `false`
  opt-out, and **`ui.head`** for verbatim `<head>` content (meta/OG/favicon/fonts).
- **`createDB(":memory:")`** documented as the file-less test DB (single Worker,
  `close()`); `readers` ignored for `:memory:`.
- **Server-only import guard.** `aiol` flags a server-only `"aio"` symbol
  (`createDB`, …) statically imported into a cell-shared file — `file:line` + fix;
  the dev blank-screen classifier makes the runtime error teachable and points at
  the linter.

### Changed

- **Unified UI facility.** One semantic surface (`ui-surface`/`ui-remote`/
  `ui-trigger`) backs both `testUI` and `am surface`/`am trigger`. The legacy
  selector/index/raw-DOM path — `am click`/`interact`/`dom`, `dom-interact.ts`,
  `dom-snapshot.ts`, `__ui:snapshot`/`__ui:interact`/`__click:` — is removed. `am`
  is a dev CLI; no public API change.

### Security

- **Exposed credential fields refuse to boot in dev.** A field named
  `password`/`passphrase`/`mnemonic`/`privateKey`/`apiKey`/`secretKey`/
  `accessToken`/`authToken` broadcast to the UI now fails the dev boot (prod logs
  a loud error) unless excluded or declared `ui.publicFields`. The old heuristic
  didn't even match `password`; ambiguous names (`seed`/`enc`/`key`) still warn.

## 1.0.0-alpha22 — reactivity hardening: no more silent freezes (2026-07-19)

Root-caused the "value changes but the UI doesn't, with no error" class into six
distinct renderer bugs and fixed each with a regression test proven to fail on
revert. The common thread: reconciliation under geometry or load the suite never
generated — multi-node siblings, zero-node Portals, budget overruns, a throw
mid-flush. A new dev-mode invariant now makes this whole class loud at the source.

### Fixed

- **Scheduler could permanently, silently strand components under load.** When a
  re-render burst overran the flush time budget mid-batch, the unprocessed tail
  was dropped: its `pendingRender` stayed set, so it was never re-queued and every
  future signal update to it was silently discarded (AIO-408). A throw while
  re-rendering one component aborted the whole flush, stranding its siblings the
  same way (AIO-409). Both fixed; a `flushing` self-heal in the scheduler now
  degrades any future strand to a one-tick delay + loud dev error instead of a
  permanent freeze. Only reachable under real bursts — why fast test flushes never
  surfaced it.
- **Child reconciliation corrupted/froze the DOM around multi-node siblings.** A
  `Signal` used directly as a child froze when a Fragment sibling shifted its DOM
  index (AIO-410); a component that renders a Fragment mis-counted as one node and
  desynced the diff cursor (AIO-411); a text-only Fragment was judged "empty" and
  injected a stray comment every re-render (AIO-413); `diffUnkeyed` ignored a
  Fragment's region anchor and clobbered preceding siblings, and advanced its
  cursor past zero-node Portals, duplicating the following text (AIO-414).
  `_domNodeCount` is now the single source of truth for a node's realized DOM span
  (Fragment/component/Portal/ErrorBoundary/Suspense).
- **Direct cell access now reliably subscribes to server deltas** and cell signals
  are no longer orphaned across re-renders (risoto CRITICAL) — with a real e2e
  harness that reproduces it.
- **UDS transport buffers patches across the throttle window** instead of dropping
  the ones that arrive mid-window.
- **14 verified bugs** from the GLM-5.2 multi-aspect audit, and three fail-loud
  gaps from the risoto report (16e, 16f-b, 17b), each pinned by regression tests.

### Added

- **Dev child-alignment invariant.** In dev mode, after every element diff aio
  asserts `childNodes.length === Σ _domNodeCount(child)` (skipping `ref`/`use`/
  `dangerouslySetInnerHTML`); a mismatch means the child cursor desynced. It has
  zero false positives and immediately caught two of the bugs above that were not
  yet known (AIO-412).
- **Actionable antipattern messages, with the linter surfaced to app devs** — the
  same checks aio runs internally now guide application code.
- Test-only `_setFlushBudget` makes the flush-budget yield path deterministically
  testable; the WS+UDS coalescing paths are unified behind one shared primitive.

### Changed

- Docs codify **dev==prod equivalency** as a critical convention; the test harness
  now runs dev-strict so the test environment can no longer be more lenient than
  production, and `press()` gained keyboard-modifier support.

## 1.0.0-alpha21 — field-report closeout: testable time, loud dev, the form fix (2026-07-17)

Every open item from all three field reports (risoto, quant, mdview) closed —
each countersigned or resolved with the fix cited in-code.

### Added

- **`bootCells` + virtual-clock schedules — every effect is now testable.**
  `import { bootCells } from "aio/testing"` boots several cells on the real
  dispatch loop with no component (the multi-cell `testCell`), and
  `await ui.advance(ms)` (also on `bootCells`) runs a **virtual clock**: every
  `schedule.after`/`every` captured and fired when due — toast auto-dismiss,
  debounce, `backoff`, `poll` all get deterministic unit coverage with no real
  timers. (`schedule.at`/`cron` stay wall-clock and warn once.) The one item
  that blocked "test every use case" in the risoto report — countersigned 10/10.
- **`schedule.next(id, action)`** — the honest "defer to the next tick"
  primitive, replacing the `schedule.after(id, 1, …)` sentinel apps were
  writing. Same-id replace still dedups.
- **Electron: external links open in the system browser.** `will-navigate`
  relays only **same-origin** URLs as in-app navigation — a cross-origin link
  can no longer `pushState` a routerless app onto a dead path (white screen on
  reload). Renderers get **`__aioIPC.openExternal(url)`**, with the main process
  enforcing an http/https allowlist (mdview #6/#7).
- **`.server.ts` is the first-class server/browser-split convention.** A plain
  `import("./x.server.ts")` in a cell method stays out of the browser bundle —
  documented as the primary rule in docs/build/imports.md (string-concat demoted
  to fallback), recognized by the linter, recommended by its fix hints. The
  mechanism existed since AIO-55; it was folklore with zero docs.
- **aiol: state-read-after-await hint.** Every `await` in an async method is a
  commit + render point — a post-await read can see other actions' commits. The
  linter now hints on the first such read (once per method; writes and draft
  mutations exempt — they always land), pairing the loud docs/state/methods.md
  callout with tooling.

### Fixed

- **Conditional element bindings froze inside `<form>` (risoto 2026-07-16d).**
  Under testUI, a conditional binding (or fragment-root component) anchored as a
  direct `<form>` child never re-reconciled while sibling text bindings stayed
  live. Root cause: happy-dom wraps `HTMLFormElement` in a Proxy, so the
  reconciler's `.parentNode === parent` containment guards failed identity and
  silently skipped removals/inserts. All guards now use a proxy-agnostic
  `isChildOf()`; the report's full repro matrix is pinned as tests.
- **SVG camelCase attrs render.** `stopColor` → `stop-color` (and the common
  camelCase set) — gradients no longer render black (quant Ugly #2).
- **Async multi-await write loss locked.** Writes after any `await` are
  guaranteed to land (property-tested), and the await-commit model is documented
  loudly: every `await` commits + renders (quant Ugly #1).
- **Dev failures got loud (quant's thesis: no quiet failures).** Discovery bind
  failures print a startup warning; editing a _cell_ file warns "cells do NOT
  hot-reload — restart to apply"; port-in-use fails loudly; transient
  post-restart imports show "Building…" and retry instead of the error card.
- **Pre-boot method calls throw** with an actionable message (instead of
  silently no-oping); bound **selector accessors are type-accessible**;
  standalone-air effect spam silenced; the secret-field heuristic no longer
  flags correctly-fixed public fields.

### Changed

- **Examples modernized to the alpha20 API**: every entry is zero-config
  `aio.run()` (only behavioral config remains — `client: "server-only"`,
  `key: true`), the cli/cli-remote clients use bound remote cells
  (`app.bind(counter)` — raw wire actions and the hand-rolled state mirror
  deleted), and the todo form drops `e.preventDefault()` (AIR auto-prevents).
- **"Fail loud, never silent" codified as the #1 convention** (claude.md) — the
  shared thesis of all three field reports, now policy.
- **Coverage ratchet raised: floor 69 → 70** (actual 71.4%). The `am` CLI's
  process + inspect commands gained direct tests (real spawned children, real
  lock files, fake control-port server): `am-cmd-process` 9% → 44%,
  `am-cmd-inspect` 25% → 56%.

### Docs

- `schedule.backoff` / `schedule.poll` / `schedule.next` reference sections
  (poll shipped in alpha20 undocumented); JSDoc for all `aio/ui` props types
  (docs:coverage 390/390); docs/content.md index regenerated and fmt-excluded
  (the byte-exact index gate and fmt could never both pass on fresh output).

## 1.0.0-alpha20 — remote UX, a component kit, and a whole bug class killed (2026-07-15)

### Added

- **`aio/ui` — a basic component kit.** Button, Input, Textarea, Select,
  Checkbox, Field, Table, Card, Stack/Row, Spinner, and **Modal** (backdrop,
  Escape, ARIA). Native AIR components that bind to cells with no adapter,
  themed through `--aio-*` CSS custom properties (light + dark), styles rendered
  through AIR (SSR/test-safe). Deliberately basic — enough to build a dashboard
  without importing anything.
- **React components as islands — `reactIsland()`** (exported from `aio/air`).
  Mount any React component with reactive props + clean teardown; aio stays 100%
  React-free (you supply the react/react-dom loaders, so they resolve in your
  build).
- **`schedule.poll(id, attempt, { every, backoff?, max? }, action)`** — a
  first-class self-pacing poller: constant while healthy, backs off on failure
  up to `max`. Replaces the hand-rolled after-chain behind RPC-rate-limit
  foot-guns.
- **Min Deno version enforced at boot.** aio uses ≥2.9 behavior directly, so it
  now fails fast with a clear message on older Deno (and `doctor` checks the
  same floor) instead of failing cryptically mid-run.
- **No-auth default for `--expose` + PIN pairing for the aio client.**
  `--expose` auth is now user-friendly and off by default:
  - **No framework auth by default** — `--expose` binds the LAN with no key, for
    apps that do their own user auth or are deliberately open on a trusted
    network. The old always-on key surprised people; auth is now opt-in.
  - `aio.run({ key: true })` opts into a **persisted** auto-generated key (same
    across restarts — "one key, use forever"); `key: "secret"` sets a fixed key;
    `key: false` is the explicit form of the open default.
  - **PIN pairing.** A keyed `--expose` app prints a 6-digit **pair code** at
    startup. In the aio client, click the app and type the code; it submits to
    `/__aio/pair`, pulls the profile (cert + key), pins the cert, and connects —
    forever after. No share link to copy, no file to hand over. The endpoint is
    attempt-limited (8 tries) and the code is session-scoped.
  - `am profile [--out=x.aioapp]` still exports a profile file (name, address,
    TLS cert to pin, auth key) from local files — works offline, for headless or
    scripted setups. The client imports it via `--profile=x.aioapp` or a
    double-clicked `.aioapp` (pins the exact cert, connects immediately).
- **LAN discovery for exposed apps + a unified aio client.** An app running with
  `--expose` now answers UDP broadcast probes on a fixed port (`8099`,
  `AIO_DISCOVERY_PORT` to override), advertising
  `{ name, port, title,
  needsAuth, tls }`. Consumers broadcast once and get
  every app on the subnet — resolving the server IP from the datagram:
  - `am discover` — lists exposed apps on the LAN (name, URL, auth flag).
  - Scaffolds gain `deno task compile:client` ((re)build the standalone
    client) + `deno task discover`; the repo has the same tasks.
  - The standalone **aio-client** Electron app (`build --client`) gained a real
    connect experience: a live "Apps on your network" list (click to connect, no
    typing IPs), **recent servers** that persist across launches (click to
    reconnect, ✕ to forget), and **"is this an aio app?"** validation before
    loading. Manual entry and `--server-url` still work.
  - **Multi-app-per-host solved via the lock registry**: each exposed app stamps
    its discovery info into its lock file (the per-host registry `am ls` already
    maintains), and a probe is answered with _every_ exposed app on the host —
    so it's irrelevant which app's socket receives the broadcast. Apps also all
    bind the port (SO_REUSEPORT); the client dedups.
  - **No unstable flags** — discovery runs over `node:dgram` (stable in Deno),
    so `deno task dev --expose` and `am discover` need **no `--unstable-net`**.
    Best-effort still: manual entry is always the fallback where UDP is blocked
    (corporate/guest networks). Discovery gives the address; auth stays
    separate.

- **Offline/CRDT sync is real end-to-end** — the client engine (the
  long-standing missing half of `sync: true`) now auto-wires on connect: local
  method calls on sync cells become HLC ops queued in localStorage (survive
  reloads, replay on reconnect), `__ack`/`__op`/`__sync` feed the engine, and
  the optimistic view drives the UI. The server applies every accepted op
  through its normal dispatch so state and op-log agree, and provisions the
  op-log SQLite file even without a `db:` config. Proven by a two-tab
  real-chromium convergence e2e. Still `@experimental`.
- **`aio/create` JSR entry** — scaffold with one line, no curl:
  `deno run -A jsr:@riagentic/aio/create my-app`.

### Fixed

- **State-leak / Immer-alias bug CLASS eliminated** (from a field report on a
  complex wallet app). `testUI` wasn't hermetic — state added in one test leaked
  into the next. Root cause was structural: live state aliased the declared
  initial (shallow-spread seed), and reset swapped signal instances, orphaning
  reactive getter closures with stale state. Fixed by construction:
  clone-on-seed (no aliasing), a frozen declared initial (dev — mutation throws
  at the site), stable signal identity (reset mutates values in place), and a
  state-only runtime reset that re-binds cells per mount. A property-test
  harness (`state-immutability.test.ts`) makes the whole class a red gate.
- **Field filters fail loud instead of leaking.** A `ui`/`persist` filter key
  that matches no state field (a typo, or a nested path in `include`) now throws
  at cell creation — a filter that silently matches nothing used to expose the
  secret you meant to hide.
- **Lifecycle hooks can't collapse the surface.** An `onMount`/`afterRender`
  hook reaching for a global `document` where there's none (testUI/SSR) used to
  throw uncaught and blank the whole render. Now each hook is contained and
  reported with an actionable DOM-safe hint; `_getDocument()` exposes AIR's
  render document so components work under testUI/SSR.
- **Secret-field heuristic stopped crying wolf** — a `pub`/`public` hint or an
  Id/Type/Name/… suffix marks a field non-secret, so public keys and nav state
  no longer trip the exposure warning; real secrets still do.
- **`testUI` `t`-handle hoisting** — a `t`/testid element handle is now
  addressable from the top level (`ui.watchPubkey`) regardless of nesting,
  instead of a fragile positional `ui.find("Input", 1)[...]`.
- **aio client couldn't connect to `--expose`'d apps** — the self-signed TLS
  cert failed with "unable to verify the first certificate" in both the Node
  metadata fetch and the Chromium page load. The dedicated client now trusts
  self-signed certs, scoped to the specific host it fetched and validated as an
  aio app (not globally). Connecting to an auth-required app without a token now
  shows an actionable "add `?token=`" message instead of a raw 401.
- **More per-hot-path log floods silenced** (same class as the time-travel fix):
  dev a11y warnings (`<img>` missing alt, missing keyboard handler, missing
  label) fired on **every render** of an offending element — now once per
  distinct issue (re-armed when dev mode is re-toggled); the sync engine's
  "reducer returned undefined" warning fired **per op** — now once per
  `cell:action`; dispatch's "invalid effect" warning fired **per action** — now
  once per action type.
- **Time-travel large-state warning no longer spams** the console — the "state
  is NNN KB — skipping snapshot" notice fired on every action while state stayed
  above the cap. It now logs **once** per session (re-armed on a fresh session,
  or if state drops back under the cap and grows again), with clearer wording
  about what's affected and how to fix it.

### Changed

- **`--expose` is no-auth by default** (was: always-on key). Opt into auth with
  `key: true`/`"..."`. Docs, scaffolder, and remote examples updated.
- **Deno floor is 2.9+** — aio tracks the latest stable Deno; `--unstable-net`
  is no longer needed (discovery moved to `node:dgram`).
- `SyncReducer` gains an optional `cell` arg (one reducer can serve many sync
  cells); `SyncHandlerDeps` gains `dispatch` (server applies ops to live state).
  Both additive.

## 1.0.0-alpha19 — zero-config DX + no-await UI tests (2026-07-11)

### Added (failure-class capture)

- **Blank-screen guard** — the #1 historical failure class, captured at runtime:
  every dev boot failure (failed import, missing default export, state timeout,
  mount error, empty render) now shows an in-page diagnostic overlay (XSS-safe,
  with a classified fix hint) AND a loud `BLANK SCREEN (<stage>)` warning in the
  server terminal. 10s watchdog covers silent hangs. Proven against real
  chromium for all four failure stages + a healthy-app no-false-positive case.
  Layered with the existing graph-validator page and startup linter.
- **Bundle-smoke CI gate** — the AIO-404 class, captured in advance: the real
  esbuild bundle step now runs in CI for both shapes (browser ESM with exported
  mount, android IIFE with registry boot) and asserts the exact invariants that
  broke twice historically. Caught its first ship-blocker on its first run (see
  Fixed).
- **Symptom → cause → caught-by matrix** in troubleshooting.md — every failure
  class aio has actually hit, mapped to the guard that now catches it in
  advance.

### Fixed (failure-class capture)

- `testUI`'s auto-DOM used a static `happy-dom` import — `cell.ts` re-exports
  `testCell`, so the testing stack rides in every app bundle graph and
  android/browser compiles broke with 51 esbuild errors (the new bundle gate
  caught it before release). The specifier is now opaque to bundlers
  (runtime-only resolution).
- Blank-screen guard renders synchronously (never races its own report);
  emptiness check sees through comment nodes (a `null` render).

### Changed

- **Zero-config `aio.run()`** — every boot field is now inferred: `cells` from
  the registry (every imported `cell()` self-registers — same mechanism the
  android runtime always used), `appId` from deno.json `appId`/`title`/`name`
  (else the entry's directory name), `appVersion` from deno.json `version`,
  `baseDir` from the entry module, `title` from deno.json. A working app is
  `import "./cell.ts"; await aio.run();`. Config remains for overrides; existing
  apps unchanged.
- **Forms never navigate** — AIR auto-prevents the default on handled form
  submits (the SPA behavior every handler reimplemented with
  `e.preventDefault()`); opt back into native submission with
  `data-native-submit`.
- **`useLocal` tuple form** — `const [text, setText] = useLocal("")` alongside
  the object form (`{ local, set, patch }`); pick either.
- **Bound remote cells** — `connectCli(url).bind(counter)` replaces raw
  `{ type, payload }` wire actions: `await counter.increment(1)` dispatches over
  the socket (resolving on the server's per-action ack — WS and UDS) and
  `counter.count` reads live server state.
- **Scaffolds slimmed** — app.ts is now 3 lines (zero-config), one `compile`
  task instead of twelve, tuple `useLocal`, no `preventDefault` boilerplate, no
  leading `t.init()` (state starts initialized — init is a reset); `test` task
  only emitted when the template ships tests.

- **UI tests: zero boilerplate, zero awaits on actions** —
  - `testUI(App, "name", async (ui) => …)` wrapper form: auto happy-dom window,
    auto-boots every `cell()` the App imports (same registry the android runtime
    uses), full teardown. Handle form supports
    `await using ui = await testUI(App)`.
  - Actions run on an ordered internal queue — no `await` per action; `await`
    only observations (`settle`/`expectCell`/`waitFor`), which drain the queue
    and surface any queued failure (typo'd names still fail with the usual
    listing). Acting on UI a prior action creates
    (`ui.OpenButton.click(); ui.Modal.ConfirmButton.click()`) resolves lazily at
    run time.
  - Options (`document`, `cells`) are now only for taking control, not required
    setup; Dashboard template + docs rewritten to the compact form.

### Added

- **`data-testid` naming** — the industry-standard test handle now works on the
  semantic surface exactly like `t` (verbatim name, puts handler-less elements
  on the surface as assertion targets; `t` wins when both present).
- **Docs**: Mermaid architecture diagrams (system, data flow, boundaries),
  Common Pitfalls page, going-to-production checklist, alpha17→18 upgrade guide.
- **docs/content.md** — generated master table of contents (every doc page,
  grouped, with one-liners); `deno task docs:index` regenerates, CI gates
  freshness.

### Fixed (multi-aspect audit)

- Audit rounds B–C: production checklist recommended `WatchdogSec` (aio doesn't
  sd_notify — it would kill healthy services); prod import maps no longer point
  at the dev-only vendor route; coverage re-prime covers the air/browser graphs;
  LAN e2e regenerates certs (stale SANs); appId-pinning guidance added
  (inference follows the project name — renaming orphans data); architecture
  diagrams machine-verified with mermaid-cli.

- **Bound remote cells could hang forever** — a dropped connection never acks:
  outstanding calls now resolve on disconnect (with a warning), and a call made
  while already disconnected resolves immediately instead of waiting for an ack
  that can't come (at-most-once delivery; verify via state). WS and UDS both.
- **`am` broke on zero-config scaffolds** — `resolveAmAppId` now mirrors the
  server's inference chain (deno.json appId > title > name > project dir).
- **Compiled binaries could adopt a foreign identity** — a zero-config compiled
  app launched from another project's directory would read THAT project's
  deno.json for its appId (locks, KV paths). Compiled builds now derive identity
  from the binary name and never read the cwd's deno.json.
- **`am dom --all` never worked** — the flag is consumed by the global flag
  parser; the command now reads it from flags.
- **Docs instructed removed scaffold tasks** — targets.md/cli-service referenced
  `deno task compile:<target>` (trimmed to one `compile` task); now show the
  direct build.ts invocations.
- `/__aio/vendor/immer.js` is dev-only now (prod serves bundles); stale
  naming-priority comments updated for data-testid; remote scaffold transform no
  longer glues comments onto one line.

### Fixed

- stress.test.ts header claimed memory-bounds coverage it didn't have
  (heap-slope testing lives in `deno task soak`); patch-filter tests now
  exercise the real `state-filter.ts` module instead of a local copy of the
  logic.

## 1.0.0-alpha18 — first-class semantic UI testing + intuitiveness hardening (2026-07-11)

### Added

- **First-class semantic UI testing** (spec:
  `docs/specs/2026-07-10-semantic-ui-testing.md`) — every TSX component is
  automatically exposed as an intuitive, deterministic API; tests and `am` drive
  the UI the way a user would, with **no DOM/selector lookup**:
  - `testUI()` (`aio/testing`): `await ui.Submit.SubmitButton.click()` — names
    inferred from the TSX (label + role: `<div class="button">Submit</div>` →
    `SubmitButton`), every action awaits quiescence (zero sleeps), real event
    sequences via AIR's own delegation (client-only `useLocal` flows included),
    keyed instances via `ui.find("Row", key)`, cell assertions via `expectCell`,
    helpful listing errors, optional `t=` handle prop.
  - `am surface <clientIdx>` — the live client's semantic surface as a friendly
    tree; `am trigger <idx> <path> <action> [text]` — faithfully simulate a user
    on a **running** app (browser/electron/android WebView) over aio's own
    protocol; misses reply with available paths so humans/AI self-correct.
  - One shared trigger implementation (`ui-trigger.ts`) guarantees tests and
    `am` behave identically. Dev-tooling only — the surface walk is on-demand,
    zero production overhead.
  - **AI-natural by design**: the surface is a complete perception+action space
    (live text/value/checked on every node), `am trigger` replies with the fresh
    post-action surface (observe→act→observe in one call), and misses
    self-describe. Guide: docs/testing/ui-testing.md ("For AI agents").
- **Custom HTTP routes** — `aio.run({ routes })`: exact paths or `/prefix/*`
  wildcards for uploads, webhooks, and API endpoints outside the state channel
  (`/__aio` and `/ws` reserved, validated at boot). Documented file-upload
  pattern in the new integrations walkthrough.
- **Prometheus metrics** — `GET /__aio/metrics` (uptime, memory, connected
  clients, per-cell errors/enabled, broadcast bytes) for supervised production
  deployments.
- **`onConflict` is real** — the sync engine now fires the documented
  `sync.onConflict` callback when a remote op changes a field your unconfirmed
  local ops also changed (rebase-LWW semantics; it was typed + documented but
  never invoked). Tested both ways (fires on overlap, silent otherwise).
- **`testgen` — fully-typed UI-test clients** (`aio/testing`): generates one
  interface per component from the live surface (`generateUITypes` is pure —
  works on any surface, including `am surface --json` output) plus
  `TypedTestUI`; a renamed button breaks tests at **compile time**. The test
  suite compiles the generated module with `deno check`.
- **Gestures + full live-tier parity**: `scroll({top,left})` and `dragTo(other)`
  (faithful HTML5 DnD sequence with one shared DataTransfer) in tests AND
  `am trigger`; the live tier now accepts the complete testUI action set
  (`select`, `check`, `uncheck`, `clear`, `scroll`, `dragTo`).
- **Tier-3 e2e** — `tests/e2e-ui-chromium.test.ts` proves the whole stack
  against a **real headless chromium**: boots examples/counter, drives it purely
  over trojan surface/trigger, asserts server-state convergence. Auto-runs when
  a chromium/chrome binary exists (`AIO_E2E=0` opts out).
- **Per-field merge strategies applied on conflict** — fields configured in
  `sync.merge` now get their CRDT merge (counter/set-add/lww-per-key/…) applied
  to the client view for the conflict window; `onConflict` reports `resolution`
  = the strategy. Unconfigured fields keep rebase-LWW. The server remains the
  convergence authority.
- **Dashboard scaffold template** — `aio create --template=Dashboard`: a
  monitoring app showcasing two cells, a self-driving `schedule.backoff` poll
  loop, custom routes, filter UI, and built-in semantic UI + cell tests.
  Scaffolds now map `aio/testing`, `@std/assert`, `happy-dom`.
- **Docs**: integrations walkthrough (routes/uploads/backoff/auth providers),
  positioning & non-goals, storage-backend interface design spec (pre-freeze
  seam reservation), Prometheus section in production.md, testgen + gestures in
  ui-testing.md.

### Changed

- **Read-your-writes in async methods** — the worst intuitiveness footgun is
  dead: reads through the `s` proxy now see committed state with the batch's
  pending writes overlaid, so `s.cpu = 5; s.history.push({cpu: s.cpu})` pushes
  5, exactly like sync code. What you read is byte-for-byte what commits (the
  overlay replays `applyMutations` itself).
- **`forUser` params fully infer** — `(s, user) => …` just works; the old
  Pick/Omit union defeated TypeScript's contextual typing and forced manual
  annotations. `exposed` is typed as the full state (runtime carries only
  filtered fields).
- **Deep-path excludes** — `ui/persist: { exclude: ["accounts.encSecKey"] }`
  removes the field everywhere under `accounts` (arrays traversed element-wise),
  in full-state filtering AND patch broadcasts (ancestor- replacing patches get
  the secret stripped from their payload).
- **Offline-capable dev** — the framework's own browser dep (`immer`) is now
  served locally at `/__aio/vendor/immer.js`; esm.sh is only a fallback when no
  local copy exists. Dev no longer requires the internet.

### Gates (new permanent drift gates)

- **browser-deps gate** — every bare npm import reachable from `/__aio/`-served
  framework code must have a default import-map mapping (the
  blank-screen-by-unresolvable-import class, closed).
- **doc-imports gate** — every `import … from "aio…"` in doc code fences must
  name a real exported symbol. First run caught 7 doc lies (fictional `aio/sql`
  entry, four non-existent `aio/air` imports, unexported `setDevMode` → now
  exported, android pseudo-import) — all fixed; `am` gained the missing `dom`
  command.
- **remote LAN smoke** — `--expose` verified over the real network interface:
  0.0.0.0 binding, self-signed cert SANs, share token, TLS page serve.

### Fixed

- **Blank screen for apps without a readable `deno.json`** — the dev import map
  now always maps the framework's own browser-side runtime deps (`immer`);
  previously the transpiled framework's bare import threw in the page and
  nothing mounted (repo examples, ad-hoc app dirs).
- **Lazy components surfaced as colliding `LazyWrapper` names** — a resolved
  `lazy()` wrapper now reports the loaded component's real name on the semantic
  surface. Portal + Suspense surface coverage pinned with tests.

## 1.0.0-alpha17 — external-audit hardening + experimental targets

Bugfixes and hardening from an external code audit, plus honest labeling of the
targets that aren't yet field-validated. Staying on the alpha track — beta is
deferred until the remote targets are proven off-box.

### Security

- **`_safeUiEntry`** sanitizes the dev HTML shell's `ui.entry` interpolation
  (self-XSS guard); the localhost trojan's read-only SQL guard now also allows
  `WITH … SELECT` CTEs while staying read-only.

### Fixed

- **Deterministic CRDT ordering** — sync ops `ORDER BY … hlc_node` for a stable
  total order across nodes.
- **Memory** — renderer signal-binding cleanup on unmount; dispatch-storm evicts
  quiet action types so its map can't grow unbounded on a long-running server.
- **UDS zombie detection** (`isSocketAlive`) — the liveness check now covers the
  Unix-socket transport (skipHttp / electron), matching the port check.
- Renderer / transport / server refinements across ~30 files (all
  additive/bugfix; full suite + security regression stay green).

### Added

- **Remote / thin-client targets marked experimental** — they build and run but
  aren't yet field-validated off-box; flagged in `docs/build/targets.md`, the
  scaffolder menu, and a build-time notice.
- **`VirtualListConfig.containerRef`** — `scrollToIndex` now moves the actual
  scrollbar (DOM `scrollTop` is the source of truth).

### Docs

- Honest JSR install wording — JSR trails the tagged releases (latest is an
  alpha), so the scaffolder / `--vendored` paths are recommended; the `jsr:`
  pins apply once the version is published.

## 1.0.0-alpha16 — deep-audit cleanup + field-report fixes (mdview, risoto)

A full per-file audit (no correctness bugs found) plus the cleanup it turned up,
and every open item from the mdview and risoto field reports. Non-breaking:
additive API only (`deno task doctor` / `aio/doctor`, `schedule.backoff`), no
changed semantics.

### Added

- **`deno task doctor`** (+ `./doctor` export) — config sanity checker for the
  magic `deno.json` lines (jsx / jsxImportSource, `aio` import-map keys,
  `unstable: ["kv"]`, vendored `immer`/`@std/path`, Deno ≥ 2.6). Wired in the
  repo and emitted by every scaffold; covered by tests.
- **`schedule.backoff(id, attempt, { base, max?, factor? }, action)`** — a
  one-shot `after` whose delay grows exponentially with `attempt`, owning the
  retry/backoff arithmetic so RPC pollers stop hand-rolling it.

### Security

- **Field-filter safety warnings** — `ui`/`persist` `include`/`exclude` only
  match top-level state keys, so a nested key (e.g. `exclude: ["encSecKey"]`
  under `accounts[]`) was a silent no-op that kept broadcasting the secret. Two
  compose-time warnings now catch it: a non-top-level filter key, and a
  secret-looking field (`enc/secret/priv/key/seed/mnemonic/passphrase`) left
  exposed to the UI.
- **`sql.ts` validates ORDER BY direction** instead of interpolating it raw
  (injection guard); **dispatch overflow rejects** dropped actions
  (`DISPATCH_MAX`) instead of silently resolving. Both with regression tests.

### Removed (dead code found by the audit)

- The `boot/` folder — a redundant parallel implementation of lock/identity/CLI
  the live server path already does inline (0 importers).
- `server-html-error-overlay.ts` — superseded by `server-html-scripts.ts`'s live
  dev-error path since alpha12.
- `browser-transport.ts` — the pre-split monolith, superseded by the
  `browser-transport-{state,vitals,send,ws,ipc}.ts` family.

### Fixed

- **`.gitignore` wrongly ignored `docs/build/`** — 5 authored docs were on disk
  but never tracked, so five files linking into the section had dead links in
  the pushed repo. Un-ignored and tracked. Added `*.zip`/`*.exe`.
- **Honest install path across all docs** — scaffolder/vendored first, JSR "once
  published"; the stale `jsr:@…/src/doctor` quickstart path now points at
  `deno task doctor`.
- **A dynamic `schedule.every`/`after` reusing a static schedule id** (from
  `aio.run({ schedules })`) warns instead of silently colliding.
- **aiol false positives** — `db:` inside a comment no longer trips "SQLite
  configured"; the table-import check is quote-agnostic; the `.env` warning
  respects `.gitignore`.
- Doc/test quality — corrected `useTimeTravel`'s signature, removed the internal
  `setDevMode` from the public reference, updated the input example to
  `e.currentTarget`, strengthened weak middleware/selector test assertions, and
  made the `stress.test.ts` header honest.

### Docs

- `ui.forUser` typing workaround (a TS inference gap across sibling config
  properties) and a copy-paste **Modal / focus-trap recipe**.

## 1.0.0-alpha15 — Deno 2.9 blank-app fix, kata test sweep, runtime hardening

Every aio version ≤ alpha14 dies on Deno ≥ 2.9 the moment a UI connects (WS
upgrade bug) — this release fixes that plus four more real-app bugs found by the
new kata-driven test suites, and hardens the runtime against a
watcher-feedback-loop incident from a field report.

**Behavior changes** (not API-breaking, but visible):

- Framework logs moved from `./log/` to **`.aio/log/`** (dot-dir — file
  watchers/scanners skip it; the incident was aio's own logs feeding an app's
  workspace watcher). Configure via `logging: { dir }`.
- Default file log level is **`info`** (was `trace`) — set
  `logging: { level: "trace" }` to keep logging every dispatch.
- Identical consecutive log lines collapse into "… last message repeated N
  times"; log writes are batched (250ms) instead of one fs write per entry.
- A server whose HTTP listener dies now **exits loudly** (supervisor-friendly)
  instead of spinning as a zombie; the single-instance lock treats "pid alive
  but port dead" as stale and reclaims it.

### Hardening (2026-07-08 field report)

- **`DISPATCH_STORM` guard** — new `dispatchStorm` config (default on: over 200
  dispatches/s sustained 5s) names the runaway action type in a warning +
  `dispatch:storm` diagnostic instead of leaving downstream symptoms;
  `{ breaker: true }` drops the offending action while the storm lasts
  (src/diagnostics/dispatch-storm.ts, wired through `beforeReduce`)
- **Event-loop stall detector** — a 1s heartbeat that arrives >3s late logs a
  `loop:stall` warning naming the starvation instead of dying silently
- **Zombie-server guard** — `httpServer.finished` without shutdown →
  `Deno.exit(1)` so supervisors restart the app
- **Lock liveness** — `AppLock.acquire` reclaims locks whose owner pid is alive
  but whose port refuses connections (10s startup grace; UDS instances exempt)
- **Log sink** — buffered writes, repeat suppression, `info` default, dot-dir
  (all above)

### Fixed (kata-driven test sweep, 2026-07-08)

- **WS connect no longer kills the server on Deno ≥ 2.9** — `handleWs` read
  `req.headers` (user-agent) _after_ `Deno.upgradeWebSocket(req)`; newer Deno
  closes the request on upgrade, so the header read threw `Request closed`, the
  serve callback died with "Upgrade response was not returned from callback",
  and **every app went blank the moment its UI connected**. Headers are now read
  before the upgrade (src/server/server-ws.ts)
- **Delegated event handlers see the right `e.currentTarget`** — AIR delegates
  most events to the mount root, so handlers received the root as
  `currentTarget` and the documented `e.currentTarget.value` pattern (docs,
  scaffolder templates, examples) read `undefined`. The dispatcher now presents
  the handling element as `currentTarget` while each handler runs
  (src/air/vdom-events.ts), matching the `AioEvent` contract in jsx-runtime
- **Nested `<Route>` + `<Outlet>` render** — a component returning an array
  (exactly what `Outlet` returns for route children) crashed the renderer
  (`applyProps` on `props: undefined`); `Outlet` now wraps array children in a
  Fragment (src/browser/browser-air-router.ts). Documented layouts in
  docs/ui/air-routing.md work now
- **`cell("app", { state: {}, methods: {} })` no longer crashes** — the empty
  methods map (generated by the `aio create` remote-electron/android scaffolds)
  fell through to the actions builder and threw; empty/omitted `methods` is now
  a valid state-only cell (src/state/cell-create.ts)
- **Flat apps get a browser import map** — the dev server only read `deno.json`
  from `baseDir/..` (scaffold layout); flat layouts (entry next to deno.json,
  e.g. repo examples) got no npm mappings, `immer` failed to resolve, and the
  page rendered blank. Fallback chain: `baseDir/..` → `baseDir` → cwd
  (src/server/server.ts)

### Added (roadmap B-testing)

- `examples/targets/<target>/` — one runnable example per compile target (all
  10), mirroring `aio create` output; runtime-tested in CI
  (tests/examples.test.ts) and UI-functionally tested via the real AIR renderer
  (tests/examples-ui.test.ts)
- Coverage ratchet gate — `deno task coverage:check` (scripts/check-coverage.ts)
  enforces a floor on src/ line coverage in CI; floor only moves up
- Tests for previously-untested exports: `NavLink`/`Outlet` (router),
  `useTimeTravel` + panel, `persistOp`/`loadOpsSince`/`getLowWater`/
  `SYNC_DEFAULTS`, `setSyncHandler`/`resendSubscriptions`, `disconnectDevTools`,
  `DEFAULT_PRAGMAS`/`createDB`

### Security (roadmap B5)

- **`/__aio/snapshot` requires `role: "admin"` in multi-user mode** — it
  returns/accepts raw, unfiltered state, so any authenticated user (e.g. a
  viewer) could bypass `ui: { exclude, forUser }` filtering; now admin-only on
  both the main server and the localhost trojan helper
- **`allowedOrigins`/`strictOrigin` are real config** — they existed on the
  internal server type but were never plumbed from `aio.run()` config (dead
  code); additionally, pages served by the server itself (Origin = own Host) are
  now accepted in `--expose` mode without manual allowlisting
- **Trojan localhost helper authenticates in `users`/`resolveUser` mode**
  (previously only token mode was checked)
- `?token=` URL warning also fires on the per-user auth path; the `ui: "all"`
  visibility warning also fires for multi-user (non-expose) setups
- **Symlinks under `baseDir` can no longer escape it** — static file serving
  re-checks the real path
- Docs: secrets need BOTH `persist.exclude` and `ui.exclude` (invariant +
  examples fixed in tutorial/persistence docs), snapshot semantics, health
  endpoint auth note

### Fixed

- **Dev server serves the browser app again** — folderization moved
  `server-static.ts` into `src/server/`, so its `/__aio/` framework-module
  resolver (`new URL(".", import.meta.url)`) pointed at `src/server/` instead of
  `src/`. Every framework module 404'd, the client's
  `import('/__aio/…/aio-renderer.ts')` threw, and **every browser/dev app
  rendered blank**. The `/__aio/` namespace now mirrors the `src/` folder
  structure (base at `src/` root; the client mounts
  `/__aio/air/
  aio-renderer.ts`), so a module's own `../state/…` imports
  resolve back inside `/__aio/`. Found by browser field validation, driven
  end-to-end in real chromium (AIO-405)
- **`compile:*` bundling works again** — folderization moved the build module,
  and its framework-path resolution (`frameworkSrcDir`, `frameworkBase`, the
  generated entry's `./src/App.tsx` import) still pointed at the old flat
  layout; all `compile:browser/electron/cli/android` targets bundle again
  (AIO-404)
- **Android builds run cell-based apps end-to-end** — verified on a real
  emulator (Pixel 7 / API 35): scaffold → `compile:android` → APK → install →
  interact → persist across restart. Fixes found in the process (AIO-404):
  - `standalone-air` now exports `cell` and a standalone `aio.run()`; the
    generated client bundle mounts `App.tsx` and never runs the user's `app.ts`,
    so `ensureConnected()` boots the runtime from the **cell registry** and
    binds methods before first render
  - the android entry auto-mounts and bundles as `iife` (was `esm` — the WebView
    loads it as a classic `<script>`, which threw on `export`)
  - state getters are upgraded to reactive signals so `counter.count` reads
    re-render the AIR tree after a local dispatch (verified: tap +, count
    updates; localStorage survives a force-stop + relaunch)

- **`connectCli` works against exposed (TLS + token) servers** — `wss://` URLs
  were silently downgraded to `ws:` and a `?token=` in the URL (the server's own
  share-link format) was dropped, so remote thin clients hung on `ready` forever
  with no error; both fixed, and repeated connect failures now log an actionable
  hint. Found by the remote field validation run (AIO-403)

### Internal

- **`src/` folderized into domain modules** — 199 flat files moved into
  `state/ protocol/ air/ browser/ server/ build/ am/ electron/ diagnostics/
  testing/`
  (plus existing `db/ sync/ vitals/ boot/`); `src/` root now holds only the
  public entry files. No export paths changed — vendored projects and jsr
  consumers are unaffected.
- **Module-boundary gate** — `deno task boundaries`
  (`scripts/check-boundaries.ts`, CI-enforced) locks the folder dependency
  matrix: `state/` stays isomorphic-light, `browser/`+`air/` can never import
  `server/`, tooling can't leak into the runtime graph.
- `src/*.test.ts` strays moved to `tests/`; `.gitignore` `build/` root-anchored
  (was silently excluding `src/build/` from the JSR package graph).

## 1.0.0-alpha14 — public-surface audit + AIR test harness (BREAKING for alpha users)

Road-to-1.0 hardening plus field-report fixes: the public-surface audit (entry
renames, export trims), wire-protocol and persistence versioning, AIR renderer
lifecycle correctness, and a public component test harness (from field-report
feedback).

### Added

- **Wire-protocol version handshake (roadmap A3)** — server and clients exchange
  `__proto:{v,min}` hellos on connect (WS, UDS, CLI); mismatches close loudly
  (code 4505) instead of failing mysteriously, and post-1.0 protocol evolution
  can negotiate instead of breaking old clients. Legacy clients without a hello
  still work.
- **Persistence schema versioning (roadmap A4)** — KV snapshots are stamped with
  the framework's schema version after each successful write; alpha-era
  (unstamped) stores migrate transparently on boot, stores written by a newer
  aio refuse to load with `PERSIST_SCHEMA` instead of being misread. Also fixes
  cell `version`/`onMigrate` stamps never being written — migrations re-ran on
  every restart.
- **`useRaf` hook** — requestAnimationFrame loop with automatic cleanup
  (AIO-392)
- **Public `testComponent`/`setDocument` harness** — render and drive AIR
  components in tests without a browser (AIO-393)
- **`CellEffect` type** — typed self-referencing effects in cell configs
- **`cell.method.action()` descriptor accessor** — schedule methods without
  hand-writing action objects
- **`aio create --vendored`** — git-clones the framework into `dep/aio/`
  (`git -C dep/aio pull` to update) with the vendored import map already correct
  (field-report follow-up)

### Changed (BREAKING — public-surface audit, roadmap A1)

Full audit + upgrade steps: `docs/specs/2026-07-04-public-surface-audit.md`,
`docs/upgrade/from-alpha13-to-alpha14.md`.

- **Entry renames**: `./src/build` → `./build` (now exports `build(cfg?)`
  instead of building on import), `./src/am` → `./am` (pure CLI entry, zero
  library exports). Update `deno task` definitions that use the jsr: paths.
- **`aio/adapters/air` removed** — import `useAio`/`useLocal`/`useConnected`
  from `aio/air`.
- **`aio/air` trimmed 145 → 101 exports**: state re-exports (`aio`, `cell`,
  `actions`, `effects`, `log`, `schedule`, `msg`) moved to `aio` only;
  `_`-internals and protocol plumbing (`bridge`, `client`, `matchPath`,
  `ensureConnected`) hidden; every remaining export documented; `useTimeTravel`
  tagged `@experimental`.
- **Stability tags**: `aio/state-core` entry and `aio/sync` engine internals are
  `@experimental`; `aio/db` no longer exports the worker wire format;
  `aio/air/compat` no longer exports test-only `_resetHints`.
- **Additive**: `aio/testing` re-exports `testComponent`/`setDocument`; `mod.ts`
  inference-only `_`-types tagged `@internal`.

### Fixed

- **Browser `aio` surface exports `own`** — cell modules that `import { own }`
  at module top (the documented `own.set` pattern, AIO-382) crashed the whole
  browser graph with "does not provide an export named 'own'"; browser-air now
  re-exports a pure effect-creator stub alongside the `schedule` stubs (AIO-402)
- **`onMount` runs after the DOM subtree and refs are committed** — refs are
  populated and children attached when it fires (AIO-390)
- **Pre-bind cell reads return declared state defaults** instead of undefined
  (AIO-391)
- **Fragment-in-map keyed children keep DOM order across re-renders** — region
  anchoring in the child differ, plus a reorder/add/remove stress suite
  (AIO-395)
- **Awaited methods no longer falsely time out** — ack registration is
  idempotent per cid (AIO-396), and the AIR command router settles acks instead
  of swallowing `__ack:` frames (AIO-399)
- **Nested array state serializes as arrays** through the async live proxy
  (AIO-397)
- **Browser-side `cell()` honors `scope: "client"`** and rejects async client
  methods at definition time (AIO-398)
- **`onMount` fires exactly once** — re-renders that re-collect mount callbacks
  (e.g. children changes) no longer remount wrappers/layouts (AIO-400)
- **Perf guards no longer flood the console** — WARN-class codes log at warn
  level and repetitive perf/vitals reports are throttled per (code, action) to
  once per 10s with a coalesced count; every occurrence still counts and reaches
  the diagnostic bus (AIO-401)
- **Typed `t.send` senders** in the test harness; refactor-safe scheduling docs
- **Clearer async-guard diagnostics**, type-only Deno refs, `testCell`
  self-dispatch

### Docs

- **Backoff on rate-limit** — worked self-scheduling `after`-chain pattern for
  dynamic polling (replaces hand-rolled `backoffUntil` state), cross-linked from
  `schedule.every` and static schedules (field-report P2)
- **Keyed map with default** — declare-once accessor pattern for
  `Record<string, T>` cell reads in JSX, no sprinkled `?? 0` guards
  (field-report P3)
- README vendored snippet now declares `immer` + `@std/path` (the doctor-check
  footgun)

## 1.0.0-alpha13 — DX overhaul + production hardening (BREAKING for alpha users)

The largest release since the `feature()` → `cell()` rename: the full DX
overhaul (phases 1–9), a production-readiness pass that fixed every audited
defect and made the project's own gates green, binding, and CI-enforced, plus
nuclear audit waves 6–11.

### DX overhaul — the framework now behaves as its docs and your intuition predict

- **Defaults flipped to honest**: `persist` and `ui` default to `"all"` —
  zero-config persists and syncs, as the README always claimed. Opt out per cell
  (`persist: "none"` / include/exclude). The "mode cliff" (one configured cell
  flipping global behavior) is gone.
- **`await method()` is real**: bound methods return Promises — sync resolves
  after the dispatch is applied, async resolves with the return value; in the
  browser the Promise resolves on server ack, so a state read on the next line
  is fresh (cid/ack protocol). Calling before `aio.run()` throws in dev.
- **State/callable name collisions now throw at `cell()` time** with a rename
  suggestion (previously the callable silently shadowed the state key).
- **Client-scoped cells**: `scope: "client"` — browser-local, per-tab,
  signal-backed, sync methods only; skipped by server composition. The todo
  example's filter uses it.
- **useEffect deps are honored** (React semantics, signal auto-tracking disabled
  inside deps-driven effects); React compat hooks
  (`useState`/`useEffect`/`useMemo`/`useCallback`) live **only** at
  `aio/air/compat` — removed from the `aio/air` main surface (`useRef` stays, it
  is a native AIR primitive).
- **Typed events**: `e.currentTarget` is element-typed on intrinsic handlers
  (AirEvent<T>); `onDoubleClick` aliased; unknown event names warn in dev.
- **Child signal subscriptions are independent of parents** — the
  `void sig.value` incantation is deleted from docs; invariant pinned by test.
- **Sync-classified methods returning a Promise throw in dev** (transpiled async
  detection) with a `markAsync` fix message.
- **`ui.entry`** option replaces the hardcoded App.tsx convention (default
  unchanged); **`aio doctor`** validates the six magic deno.json lines.

### Correctness fixes (full production audit — `bugs.md` B-1…B-13)

- **Signal graph never drops updates** — computed invalidation is now eager
  (push dirty flags synchronously, pull values lazily), so an effect reading a
  signal plus a derived computed written in the same `batch()` is glitch-free.
  This sat under every DOM event handler. (B-2)
- **SQLite worker type-checks again** on current Deno; `deno check` now covers
  `src/` (incl. worker entries) so it can't silently rot. (B-1, B-9)
- **Dropped dispatches reject instead of resolving** — under overload or after
  close(), `await cell.method()` no longer succeeds on unapplied state. (B-4)
- **Persistence/offline silent-failure trio fixed**: failed multi-key KV commits
  are reported, the offline queue warns when full, and the shutdown flush
  re-runs so a late write can't be lost. (B-7, B-8, B-10)
- **esbuild**: the false "not installed" warning is gone (it probes the real
  import) and dev transpile + prod bundle are pinned to the exact tested
  version. (B-5, B-6)
- **Lint to zero**, and the gate is now binding. (B-3)

### Operations & security

- **Configurable WebSocket limits** (`wsLimits`: message size / messages-per-sec
  / bytes-per-sec) for tuning `--expose` deployments without forking; defaults
  unchanged.
- **`/health` reports the framework version** for deploy verification.
- **Token-in-URL** (`?token=`) auth emits a one-time warning — it stays a
  fallback but flags the leak surface. (B-11)

### Release engineering

- **CI workflow** (`.github/workflows/ci.yml`): fmt / lint / check / full test
  suite across the supported Deno range + a JSR publish dry-run — "green" is now
  provable on every PR.
- **Whole-tree `deno fmt`** so the formatting gate is binding, and a
  **`docs:check` gate** that fails if any `AioErrorCode` ships undocumented.
- **GitHub issue templates** (bug / DX paper-cut / docs-lie) for a real feedback
  loop.

### Hardening — nuclear audit waves 6–11 (~194 fixes)

- Sync protocol routing (`onTTCommand` guard stops time-travel commands leaking
  into prod sync), sync cursor advance, concurrent HLC drop, SVG namespace,
  watcher sentinel TOCTOU, logger flush race, signal listener leak, rate-limiter
  abuse detection, op-buffer TTL eviction, state-module cleanup.

### Docs

- New **`from-alpha12-to-alpha13`** upgrade guide for the breaking changes;
  fixed the stale "persist defaults to none" claim in the alpha10→11 guide;
  every error code is documented in `docs/debugging/errors.md`; dead links fixed
  and stale `stateForUI`/`stateForDB` references removed.

---

## 1.0.0-alpha12

### Breaking

- **React renderer removed** — AIR is the sole renderer. `aio/react`,
  `src/react.ts`, `src/browser.ts`, `src/standalone.ts`, `src/browser-fiber.ts`,
  `src/browser-hooks.ts`, `src/browser-router.ts`, `src/time-travel-react.ts`,
  `src/adapters/react.ts` and their tests are gone. See
  `docs/upgrade/from-alpha11-to-alpha12.md`

### Added

- **Direct reactive cell access** — `counter.count` is now type-safe. Both
  `cell()` overloads return `… & Readonly<S>` so UI code can read state off the
  cell without a hook. Backed by `src/cell-reactive.ts` which installs
  signal-backed getters via `Object.defineProperty`
- **JSX runtime wired up** — `aio/jsx-runtime` added to exports and import map.
  `src/jsx-runtime.ts` triple-slash-references `jsx.d.ts` so
  `JSX.IntrinsicElements` resolves and `<div/>` type-checks
- **`deno task check` covers examples** — now runs against
  `examples/counter/App.tsx` and `examples/todo/App.tsx` so JSX regressions
  break the task

### Fixed

- **Blank render in minimal apps** — dev HTML bootstrap now calls
  `ensureConnected()` before `_waitForState()`, so apps that use direct cell
  access without any UI hook still get cells bound reactively
- **Immer draft proxies in effects** — effects are cloned inside `produce()`
  before Immer revokes draft proxies; uncloneable effects are dropped rather
  than passed through as revoked proxies
- **Hardening wave** — trojan auth, `fatalOnStart`, effect async errors, cleanup
  hooks
- **Stale `VERSION`** — `src/aio-cli.ts` constant bumped alpha8 → alpha12 (was
  stale since alpha8)

### Tests

- **Regression: blank render via direct cell access** —
  `tests/boot-direct-access.test.ts` mounts a no-hook component with `happy-dom`
  and asserts `counter.count` renders after `bindAllCellsReactive()`, pins the
  undefined-without-binding failure mode, and guards the seeded-initial-state
  fallback

### Docs

- Direct cell access is the primary UI pattern; TS2722 troubleshooting added
- Quickstart covers both JSR and vendored (`dep/aio/`) `deno.json`, verified
  end-to-end against a fresh `/tmp` project with headless chrome + CDP driver
- Upgrade guide: `aio/adapters/react` subpath removed alongside `aio/react`;
  `aio/jsx-runtime` added to the required imports diff

## 1.0.0-alpha11

### Added

- **`cell()` API** — renamed from `feature()`. All internal naming updated
  (cell-impl, cell-types, cell-machine, cell-compose, cell-catalog, cell-test)
- **Type-safe machine states** — `cell({ machine })` infers literal `.type`
  union from state map keys; transitions type-checked at compile time
- **Per-cell field filters** — `persist` and `ui` config on cells controls which
  fields are persisted to KV and which are sent to clients. Strategies: `"all"`,
  `"none"`, `{ include }`, `{ exclude }`
- **Patch strategies** — per-cell `patchStrategy`: `"auto"` (default), `"full"`,
  `"filter"` with field-level control over what gets broadcast
- **State migration system** — `version` + `onMigrate(state, fromVersion)` on
  cells. Version tracked in KV, migration runs on restore when version mismatch
  detected. Failed migrations reset to `initialState` (safe fallback)
- **Per-cell locking** — async mutex in server sync handler serializes
  `handleOp` + compaction per cell, preventing race between op persist and
  compaction DELETE
- **LWW set merge** — `set-add` and `set-remove` CRDT strategies now use HLC
  comparison for content conflicts instead of always keeping local
- **Clean import boundaries** — removed `aio/core` export, stripped server
  re-exports from `aio/air` and `aio/react`. `Msg` type unified via single
  import from `cell-types.ts`
- **Upgrade guide** — `docs/upgrade/from-alpha10-to-alpha11.md`

### Fixed

- **Sync server race condition** — fire-and-forget `tryCompact()` could
  interleave with `handleOp`, losing ops. Now awaited inside per-cell lock
- **Silent op drops** — sync engine buffer-full silently discarded ops. Now
  prunes confirmed ops first, warns on actual drop
- **Migration failure safety** — `onMigrate` throwing left stale persisted
  state. Now resets to cell's `initialState` with error log
- **Low-water corruption** — `getLowWater` JSON parse failure was silent. Now
  logs warning and triggers full snapshot
- **Duplicate `Msg` type** — `cell-impl.ts` had its own `Msg` definition
  diverging from `cell-types.ts`. Replaced with import
- 184 bugs fixed across 5 audit waves (waves 1-4 in alpha8-10, wave 5 in
  alpha11)

### Changed

- **`feature()` → `cell()`** (breaking) — all public API renamed. See upgrade
  guide for migration steps
- **`bindFeature` → `bindCell`**, **`testFeature` → `testCell`**,
  **`composeCells`** (was `composeFeatures`)
- **Test count** — 1774 → 1949 (175 new tests: migration, patch filter, merge
  null safety, sync locking, protocol, virtual list)

## 1.0.0-alpha10

### Added

- **`src/sync/` module** — offline-first CRDT sync engine with
  server-authoritative merging. Includes hybrid logical clock (HLC), op buffer
  with storage abstraction and cap enforcement, merge strategies (LWW, counter,
  LWW-per-key, set-add, set-remove), rebase engine for unconfirmed ops, and
  client sync engine with op stamping, ack, status, and reconnect
- **Server-side sync** — `__op`/`__sync` message handlers, atomic compaction
  with schema definitions, sync table init, KV exclusion for sync keys
- **Sync feature API** — `sync` config on features, sync routing hook in
  `state-core send()`, barrel export via `src/sync/mod.ts`
- **Client log forwarding** — forward client console output to server
- **DOM-based UI snapshot & interaction** — `am ui` now captures live DOM tree
  from connected clients, with `am ui <userId>` for server-state filtering

### Fixed

- **`afterSubtree` crash** — `instanceof HTMLElement` replaced with
  `nodeType === 1` check to work in non-browser environments (happy-dom); added
  missing `_devMode` guard (was always stamping `data-component`)
- **`_syncFeatureIds`** registered in valid config keys
- **`am ui`** test aligned with refactored `cmdUi` (DOM snapshot default path)

### Changed

- **Test count** — 1343 → 1774 (431 new tests, mostly sync/CRDT coverage
  including property-based, integration, and reconnection tests)

## 1.0.0-alpha9

### Added

- **`src/boot/` module** — structured startup orchestration: `parseCli()`,
  `printHelp()`, `handleCliExit()` (CLI); `bootIdentity()` (appId/port/title
  resolution); `bootLock()` (single-instance lock); `electron-helpers.ts`
  (`toSlug`, `escapeForExecuteJavaScript`, `requireElectronVersion`,
  `buildWillNavigateHandler`, `buildCertificateHandler`,
  `buildKeyboardShortcuts`, `WINDOW_STATE_HELPERS`)
- **`bindFeature(feature, dispatch, getState)`** — wire a feature to a custom
  dispatch bus without `aio.run()`, for advanced composition and custom hosts
- **Legacy delta deprecation warning** — `$p/$d` format now logs a one-time
  console warning on receipt; server no longer produces it

### Fixed

- **AIO-287..291** — 7 AIR renderer bugs: signal flush guard on re-entrant
  notify, in-flight subscriber tracking, `_FLUSH_MAX_ITERATIONS` raised to 1000,
  phase-1 failure isolation in flush loop
- **Signal equality** — all comparisons use `Object.is` (NaN-correct,
  cross-realm safe via duck-typing instead of prototype checks)
- **Persistence** — `result.ok` guard on KV `setMulti`; snapshots use
  `structuredClone` before write
- **Dispatch JSON fallback** — warns explicitly when `structuredClone` fails and
  JSON round-trip is used (data loss: `undefined`/`NaN`/`Infinity`/`Date`)
- **`disable()` rollback** — failure during cleanup rolls back
  `disabledFeatures` set and logs the error; feature re-enabled on destroy
  failure
- **Catch logging audit** — all silent catches now log or carry a documented
  rationale comment; no swallowed errors remain

### Changed

- **`_status` → `__aio_status`** (breaking) — internal machine state key
  renamed. Direct reads of `feature._status` must migrate (see upgrade guide).
  The reserved-key guard now **throws** (was: warn) and also blocks any
  `__aio_*` prefix in feature state definitions.
- **`appVersion` required in examples** — quickstart and all docs examples now
  include `appVersion` in `aio.run()` calls
- **Quickstart style guide** — added decision table for `methods` vs
  `generators` vs `actions + reduce`

## 1.0.0-alpha8

### Added

- **Dynamic user resolution (`resolveUser`)** — async hook for JWT, OAuth, or
  database-backed auth. Supports `Promise<AioUser | null>` return type. Unified
  `_buildUserResolver` factory replaces separate static/dynamic code paths
  (AIO-171)
- **`ResolveUserFn` type** exported from `mod.ts`
- **Patch compaction** — broadcast protocol compacts redundant patches before
  sending, reducing wire overhead for rapid-fire mutations
- **Broadcast size guard** — oversized patch sets auto-fallback to full-state
  send

### Fixed

- 58 bugs fixed across 23 files in 13-round nuclear audit (AIO-57..236)
- Prototype pollution guard on `_deepMergeFiltered` (AIO-238 — security)
- Delta protocol hardening — backpressure recovery, filtered merge, array
  identity patching, periodic resync improvements
- Renderer fixes — flush guard on disposed root, hydration signal binding, keyed
  fragment placement, Suspense cleanup
- Feature system — proxy tracking, async method batching, flow cleanup,
  delegation leak, schedule prefix handling
- Electron — `pageReady` reset on reload, IPC null cleanup
- Server — stateForUI memoization for undefined results, time-travel perf
  metrics timing, config schedule ID validation

### Changed

- `_extractToken` and `_buildUserResolver` replace inline auth resolution in
  server.ts — single code path for all auth modes
- Auth mode reporting: `authMode` now distinguishes `"resolveUser"` from
  `"users"` in trojan API

## 1.0.0-alpha7

### Added

- **Type-safe `send`** — `useFeature` infers method signatures from feature
  definition; `send.methodName(...)` is fully typed with args and return
- **`aio/air` and `aio/react` subpath exports** — barrel modules for each
  renderer; all primitives available from a single import
- **React compat hooks** — `useState`, `useEffect`, `useCallback`, `useMemo`
  wrappers in `src/compat.ts` for zero-friction React migration
- **AIR renderer primitives exported** — `useRef`, `onMount`, `onCleanup`,
  `effect`, `computed`, `signal`, `batch` all re-exported from `aio/air`

### Fixed

- Proxy stale `ownKeys` — second+ `.map()`/spread on proxy state (AIO-57)
- Signal equality — `.set()` with same value no longer triggers re-render
  (AIO-59)
- Ref callback invocation reliability (AIO-58)
- JSX event types use native DOM events, no `as any` casts (AIO-62)
- `useLocal` single-field `.patch()` (AIO-66)
- `useFeature` type inference without double-cast (AIO-67)
- `key` prop warnings for array rendering (AIO-69)
- AIR renderer primitives not exported from main import (AIO-70)
- CJS server-only stubs for esbuild (AIO-55)
- `aio://` custom protocol `registerSchemesAsPrivileged` (AIO-56)
- Explicit return types for JSR no-slow-types compliance

### Changed

- Extracted `middleware.ts` and `lint.ts` from `aio.ts` monolith
- Renderer exports stripped from `mod.ts` — base is now server/protocol only
- Docs imports updated to `aio/react` and `aio/air`

## 1.0.0-alpha6

### Added

- **AIR native renderer** — signal-based VDOM engine with JSX, keyed
  reconciliation, auto-memo per-component reactivity (~8KB)
- Renderer Phase 2: per-component signal tracking, auto-memo, VDomHooks
- Renderer Phase 3: SSR, hydration, ErrorBoundary, AIO bridge hooks
- Renderer Phase 4: lifecycle, context, portal, suspense, forms, devtools
- Signal system — `signal()`, `computed()`, `effect()`, `batch()` reactive
  primitives
- VDOM engine — `h()`, diff, patch, keyed reconciliation
- Form bindings — `useForm()` with signal-backed validation
- Animation system — `useSpring()`, `useTransition()` signal-driven
- Virtual list — `useVirtualList()` for large datasets
- DevTools integration for AIR renderer (component tree, render counts)
- **Adapter architecture** — `state-core.ts` as framework-agnostic foundation,
  React and AIR adapters as thin consumers
- `state-core` exports: `getFeatureSignal`, `getStateSignal`, `createSendProxy`,
  `setTransport`, `flushOfflineQueue`, `_trackingProxy`, `_resolveWithFallback`
- New export paths: `@riagentic/aio/state-core`,
  `@riagentic/aio/adapters/react`, `@riagentic/aio/adapters/air`,
  `@riagentic/aio/jsx-runtime`
- Delta round-trip invariant tests
- AIO-33 state integrity test suite

### Fixed

- Electron IPC `__aio:ready` requests fresh state from server via `__subs:*`
  (AIO-26)
- Unsafe delta replay removed from `__aio:ready` handler (AIO-26)
- UDS `__subs:` handling and per-client subscription filtering (AIO-27)
- Cancel sub timer on `_accessedPaths.clear()`, guard empty subs (AIO-28)
- `$f` marker for filtered state — merge instead of replace (AIO-29)
- Control messages no longer corrupt `lastFullState`, shallow `$f` merge
  (AIO-30)
- `useFeature` auto-merges init shape — prevents crash on incomplete state
  (AIO-30)
- Recursive deep merge for `$f` responses, prevents sub-sub-key loss (AIO-31)
- `unflattenPatch` contradicting `$arr`+`$d` on empty→identity array transition
  (AIO-31)
- `_applyPatch` defense-in-depth: `$arr` identity patch survives contradicting
  `$d` deletion with diagnostic warning
- Dev-mode `_checkStateIntegrity` warns when keys from initial full state
  disappear (state-shape-drift diagnostic)
- Periodic resync every ~5s prevents permanent delta desync (AIO-33)
- `lastKeyJsons` updated after successful send, not before (AIO-33)
- Removed unsafe reference-equality shortcut in `_computeDelta` (AIO-34)
- Renderer hydration `afterSubtree` — instanceStack leak fix
- `useSpring` timestep hardening, lazy re-render, context signal cleanup

## 1.0.0-alpha5

### Added

- Identity-keyed array delta compression (AIO-12) — `flattenKeys` detects arrays
  with stable `id` fields, diffs per-element. 160-element array with 10 changes:
  120KB → ~7.5KB per tick
- 4-layer wasted render prevention (AIO-11) — `useProjection`, `memo` with
  structural comparison, aiol lint rule, runtime warning
- IPC keepalive ping (AIO-24) — `__ping` every 60s as defense-in-depth for
  Electron IPC
- `.ts` added to live-reload watcher extensions

### Fixed

- UDS ghost socket elimination (AIO-24) — removed idle timeout, close conn on
  read-loop exit, `_ipcConnected` flag, write-error cleanup
- UDS broadcast/sendTo write failures now close connection cleanly (AIO-25)
- `_reset()` clears `_idMaps`, `_useAioActiveCount`, `_diagLastEmit`,
  `_vitalsUrlLogged`, `_vitalsPingTimer`, `_vitalsTransportProbe` (AIO-14,
  AIO-23)
- `_applyArrPatch` self-heals on desync instead of injecting `undefined`
  (AIO-15)
- `flattenKeys` preserves empty arrays as atomic keys (AIO-16)
- `onerror` handler cleans up vitals/payloadStats/pressureMonitor (AIO-17)
- Double `onDisconnect` callback prevented via `disconnected` flag (AIO-18)
- Delta-before-state now emits diagnostic event (AIO-19)
- `ws.onopen` guards `readyState` after async gap (AIO-20)
- `_accessedPaths` pruned on full state receive (AIO-21)
- Graph validation race guard via `_graphGeneration` counter (AIO-22)
- Electron IPC test updated to match dual-replay `lastFullState` template

### Changed

- `_preserveArrayRefs` bypassed entirely for identity-patched arrays (AIO-13) —
  8,000 shallow comparisons per patch eliminated

## 1.0.0-alpha4

### Added

- Todo app example (`examples/todo/`) — CRUD, filtering, inline editing,
  persistence
- Interactive playground (`examples/playground/`) — standalone HTML, 3 examples,
  live code editor, no server needed
- Tests for `listeners.ts`, `sql.ts` (buildWhereOr, buildQuerySuffix,
  isWhereOp), Electron script generators (29 unit tests)

### Fixed

- `structuredClone` failure in dispatch now reports `EFFECT_ERROR` and drops
  effects instead of silently continuing with revoked Immer draft refs
- Effect timeout is now hard-cancel — timed-out effects are abandoned and
  counted toward circuit breaker. Late rejections after timeout are suppressed
  (no double-report)
- `db.transaction()` callback form: `_inTransaction` flag now resets even when
  `BEGIN` fails, preventing permanent deadlock on subsequent transactions

### Changed

- Extracted `server-html.ts` from `server.ts` (MIME, import map, HTML gen, error
  classification)
- Extracted `aio-cli.ts` from `aio.ts` (CliFlags, parseCli, printHelp, VERSION)
- `effectTimeout` behavior change: previously warn-only, now marks effect as
  abandoned after timeout. The underlying promise may still complete but the
  framework considers the effect failed.

## 1.0.0-alpha3

### Added

- Diagnostics module — state diffs, action log, checkpoint, crash handler,
  dev/prod config
- Circuit breaker, state validation, correlation ID race fix, error tips
- First-class error infrastructure — `AioError`, memory monitor, correlation
  IDs, TT error markers
- Logging enabled by default (`logging: false` to disable)
- CI pipeline — fmt, check, lint, test, publish to JSR on tag

### Fixed

- Memory monitor false alarms (use `heap_size_limit`), strip CSS imports
- AM reads `appId`/`port` from app.ts, kills stuck instances, fixes lock
  self-deadlock
- Console fallback only prints info + error (mirrors app.log)
- Pre-release audit — fmt, types, tests, CI, version

### Changed

- Extracted shared `Listeners<T>` — deduplicate browser.ts and standalone.ts
- Unified loggers — single `logger.ts` singleton, plain text, wipe-on-start
- Time-travel `MAX_ENTRIES` bumped to 20,000

## 1.0.0-alpha1

- Initial alpha: reactive + sequential + explicit feature styles
- Server-side state persistence (Deno KV), WebSocket sync, offline queue
- Build targets: browser, Electron desktop, Android (WebView), CLI, service
- App Manager (`am`) — process control, logs, KV inspect
- Time-travel debugger, middleware, selectors, scheduling
- AIO linter (`aiol`) — framework-specific checks

## 0.9.5

- Fix Electron dev loading (IPC ready handshake + E2E test)

## 0.9.4

- UI fix, exports, random ports, `/tmp/aio/`, startup log

## 0.9.3

- JSR-native builds, esbuild HTTP plugin, android template, Electron fixes
