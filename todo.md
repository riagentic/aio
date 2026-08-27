# Road to 1.0.0-final

> **The defect backlog is EMPTY.** Every reported finding is fixed with a test,
> or recorded in `feedback/refused.md` with its reason. What follows is the
> ROADMAP — planned work and standing policy, not open defects.
>
> Shipped work lives in `CHANGELOG.md`; what was fixed or refused from field
> reports lives in `feedback/resolved.md` and `feedback/refused.md`. This file
> carried 1,500 lines of finished-work narrative until 2026-08-21; that story
> belongs in those three, and keeping a second copy here made "what is left?"
> unanswerable.

**Core principle:** all breaking changes die in alpha; beta = frozen surface,
bugfix-only; 1.0.0 = boring.

---

## The gate to beta (user rule, 2026-07-19)

Ten consecutive alpha releases with **no major/critical/blocker bug and no
compat break**. A corruption-class bug found during an alpha resets the count —
that is the gate working, not a setback.

- **Streak: 0** — reset 2026-08-05, when the `sync-chaos` fuzzer found a
  convergence divergence reachable in released alpha44: server timestamps were
  issued from an in-memory counter that ran ahead of anything the log could
  prove, so after a restart a client could be sent ops below a cursor it had
  already been given — undeliverable forever, silently. Fixed by making the
  reservation durable by construction; pinned by
  `tests/sync/cursor-durability.test.ts`.

## Planned work

Two blocks remain before the stabilization hunt, the hardware week, and beta1.
Both are alpha-only by design — they are where the remaining breaking changes
get spent, and each ships with the codemod that performs it (`aiol --safe-fix`).

- **The surface diet + safety defaults.** Cell `ui:` → `visible:` (alias through
  beta); `key:` auto-generates when an app is exposed without per-user auth;
  `access` without visibility REFUSES on an exposed or multi-user app; `aio/db`
  becomes types-only (`createDB` lives on `aio/server`); an `@internal` sweep of
  `aio/sync` and `aio/state-core` (~40 symbols); the browser surface gets the
  snapshot twin the android surface already has.
- **Internals.** `protocol/`↔`state` decomposition; boundary-gate tightening
  (unused edges, unused permissions, root files that launder imports);
  offline-queue unification (one factory, one drop policy);
  `PRAGMA user_version` plus one ordered fatal DDL runner. (`app.blobs` came off
  this list: it SHIPPED in full — content-addressed files under
  `appDirs().files`, `put/get/stream/info/url/delete/list`, HTTP Range
  streaming, `openBlobStore()` for headless. See
  `docs/persistence/big-data.md`.)

## Open asks from field reports

Recorded because they were asked for and are not yet decided or built — not
because anything is broken.

**From a local-LLM chat app (alpha55/alpha61, 8/10):**

- `am doctor`: "the running aio differs from `dep/aio` on disk". A live process
  holds the modules it loaded at boot, so a symlinked checkout can move
  underneath it. Cheap shape: compare the newest mtime under `dep/aio/src`
  against the process start time.
- **Append-delta broadcasts for growing values.** A streamed reply is a string
  that grows; rewriting it every 60 ms is quadratic in the reply and doubled per
  window — measured at a sustained 33 broadcasts/sec against aio's own threshold
  of 30. Three consumers pay this now.
- **`own(resourceId)` so effect displacement is unrepresentable.**
  `own.set(key,
  …)` stops whatever is running NOW, not the process the effect
  was created for: after a crash, the next start came up and was SIGTERMed a
  moment later. The remedy (key by resource identity) is documented advice, and
  the API still makes the wrong thing the natural thing.
- **Codemods for default flips.** When a default must flip, ship `aio migrate`,
  not a changelog line.
- **A sanctioned workspace share for multi-app repos.** Symlinks out of the app
  root are refused by static serving (correctly), so a repo generates
  `client/src/shared/` by copy and polices it with a test.
- **Strict mode: refuse boot on unmigrated shape drift.** A permanent warning is
  a weaker instrument than a refusal.

**From a desktop wallet app (money software, alpha59 → triaged at alpha61):**

- **Prod-parity test mode** (their #1, rightly): a harness mode where the worker
  pool is ON, every method return and error crosses a real structured-clone hop
  even in-process, sync methods replay in client context, and the DOM is shared.
  Five of their six multi-day bugs were harness/prod wiring divergence. The
  highest-leverage open testing item.
- **A first-class async-I/O shape**: `io:`-kind methods (no mutex held, no
  ceiling false alarm) or an `s.$job(fetch, commit)` primitive — decided
  together with `transaction`/`long`/`cancelOn`, plus the aiol rule that bans
  `fetch`/`Deno.*` in reducer bodies.
- **Ceiling heartbeat**: report "still running (slow)" at interval for a call
  past 50% of its deadline, so slow is never mistaken for dead.
- **`db:`/persist granularity**: object-shaped `db:` mappings (subset and
  projection rather than whole-slice arrays), and row/field dirty tracking for
  persist and per-client deltas. Two production consumers pay this; the largest
  open design debt.
- **Standalone export parity**: the router, auth UI and islands are enumerated
  as `KNOWN_DRIFT` in `tests/standalone-export-parity.test.ts`. Porting the
  router to the android runtime without dragging the WS transport is the first
  cut.

**From a remote-desktop app (alpha61/63):** stale-capture detection is
per-invocation by design — a reference that escapes a method (a module-level
variable, a callback) is not tracked, because the ledger dies with the
invocation. Escaping a live proxy is already outside the contract, so it is
worth an `aiol` rule rather than a runtime cost on every read.

## Prod parity — what the harness still fakes

The gap named as the source of several multi-day field bugs: a test that is more
permissive than production manufactures green-test-broken-prod. Three parts were
listed; all three are now closed.

- **[x] The serialization hop.** A worker cell is reached by `postMessage`, so
  every argument and return value is structured-cloned; in-isolate they were
  passed by reference, and the boot log claimed "behaviour is identical" while a
  function, a class instance or a live proxy passed every test and threw in
  production. `libraryMode` now clones across that boundary for exactly the
  cells that would have been hosted, and names the cell and the reason when it
  cannot. `tests/prod-parity-worker-boundary.test.ts`.
- **[x] The worker pool itself.** Worker cells run in-isolate under
  `libraryMode` (the entry module is the test file), so isolation — a separate
  heap, its own module graph, no shared module state — was not reproduced, and a
  cell holding anything at module scope behaved one way in every test and
  another in production. `testServer({ workers: "real", workerEntry })` now
  spawns the real thing from a real app entry, paid for only by the tests that
  ask; every way of asking for it and getting nothing throws at the call.
  Strictness travels with the thread (`__aioDev` crosses on the init message),
  so the worker isolate is never more permissive than the one that spawned it,
  and an uncloneable argument now REJECTS on the real path too — `postMessage`
  throws synchronously, out of a call the contract says always returns a
  promise, so one mistake had two shapes depending on whether a worker happened
  to be hosted. `tests/prod-parity-real-workers.test.ts` measures both halves —
  the module graph is separate, and the main isolate keeps ticking through a
  700ms burn — the same properties `tests/build-e2e.test.ts` measures on a
  compiled binary.
- **[x] Sync methods in a client context.** A non-async method called from a
  client crosses the wire; the harness called it in-process, so four differences
  were invisible to the whole suite (JSON arguments, a JSON-vetted return, a
  throw arriving as a message with no stack, and `access: false` refusing the
  client and not the server). `testMultiClient`'s clients now have
  `call(cell, method, ...args)` — the real path, a real socket to a real
  `aio.run()` — and an unknown cell or method rejects instead of resolving
  `undefined` off an ack the server sends for any frame.
  `tests/prod-parity-client-sync-call.test.ts` asserts each difference with the
  in-process and wire results side by side.

  Both are documented in `docs/testing/prod-parity.md`, which is also the honest
  list of what the harness still does NOT reproduce (the browser's own renderer;
  a second process).

- **[x] The harness fires the frozen-state tripwire.** `bootCells` never passes
  `freezeState`, which read as "the in-process harness cannot fire it". It can —
  the standalone runtime defaults it on and Immer's `autoFreeze` is never
  disabled (verified by forcing `freezeState: false` and watching committed
  state come back frozen anyway) — but nothing checked it, so the fact lived in
  a `??`. `tests/prod-parity-harness-strictness.test.ts` is that check, for
  `bootCells` and `testServer`.

## Tracked debt (not defects)

- **94 test files opt out of a sanitizer.** `sanitizeResources: false` /
  `sanitizeOps: false` is a test saying it may leak a resource or an op, and at
  that count the suite can no longer tell "this test cleans up" from "nobody
  checked". Each one is a judgement about a specific test, so this is a
  file-by-file pass, not a sweep — and the ratchet shape (`check:silent-catch`,
  `check:vacuous`) is the right instrument: freeze the count, only ever lower
  it. Reported by a process-lifecycle audit (2026-08-22), still open.
- **A one-step "start fresh" for a blocked release**
  (`apply({ retireData:
  true })`) and a public **`aio.stop()` /
  `aio.restart()`**. Both asked for by an app that had to write ~200 lines to
  archive its profile, retire `data/` and relaunch across two processes. The
  shape is right and the pieces exist in `updates-runtime.ts`; both want their
  own release and their own gate run — "restart yourself" has to hold on every
  target and every launcher, which is a test matrix rather than a function. See
  `feedback/refused.md`.

## Known gaps, stated where they are felt

- **`schedule` is the one `aio` export android cannot have.** The android build
  maps both `aio` and `aio/air` to `src/standalone-air.ts`, and `schedule` pulls
  `blocking.ts` and the Deno worker pool behind it. The other twelve gaps found
  with it are re-exported; this one needs the standalone half separated from the
  pool. Held by `KNOWN_GAPS` in `tests/android-air-surface.test.ts`, which
  refuses any NEW divergence and refuses a ledger entry that has stopped being
  true.
- **Client render vitals are not wired.** alpha48's transport swap removed the
  only caller of the render meter and the transport that replaced it never
  picked it up: `renderBudget` is accepted, validated and bridged, and nothing
  measures staleness or pending patches; `vitals-ping` has no sender, so
  `/__aio/vitals` reports `clients: []`. (`DevToolsHandle.tree` came OFF this
  list in alpha69: it is now walked from the live AIR roots on demand —
  pull-based deliberately, because publishing after each flush re-renders any
  component that displays the tree, which changes the tree. The freeze
  diagnostic came off too: it had reported "unreachable for 0.0s" with a null
  hint every time, because the duration was recomputed from the timestamp
  stamped on that very transition and the snapshot hardcoded the transport layer
  healthy, which made the hint rule written for it structurally unreachable.)
  Boot now says so, and so does `docs/debugging/vitals.md`, because
  config-accepted-then-silently-dropped is the class this project calls
  disqualifying — but saying it is not fixing it. The fix is an `initVitals`
  equivalent wired into the current transport with a browser-path test, plus a
  gate in the class "every config key must reach a reader". Server-side vitals
  are unaffected and real.

- **Two deliberate deferrals that source comments point here for**, both
  hot-path changes that deserve their own release and gate run rather than a
  quiet widening:
  - `dispatch.ts` cannot tell "draining" from "sealed" for an effect-sourced
    commit. The data outcome is safe either way — the write is captured by the
    final persist or loudly dropped — and separating the meanings needs a new
    dispatch-level flag, which is a wire-contract change.
  - `method-cancel.ts` keys its pending-call registry by cell NAME, so two apps
    in one process sharing a cell name share cancellation. The honest fix keys
    it by app identity, threading an app id through `registerCall` and every
    dispatch that reaches it.
  - `cell-worker-host.ts` builds its `createDispatch` without `freezeState`,
    while the main isolate passes `config.freezeState ?? !prod`. A worker cell's
    committed state is therefore frozen only by Immer's `autoFreeze` (never
    disabled), not additionally deep-frozen — a narrower tripwire inside a
    worker than outside it, in dev and prod alike. The flag is captured when the
    dispatch is created, and the host creates its dispatch BEFORE the `init`
    message that carries `prod` arrives, so the fix is either deferring dispatch
    creation until `init` or making `freezeState` a getter in `dispatch.ts` — a
    hot-path change that deserves its own gate run. Found while closing the
    prod-parity items above; `workers: "real"` makes it reachable from a test.

## Standing policy

- **Deliberate deferrals**, recorded so they are not re-litigated: a `scratch:`
  cell slice duplicates `visible`/`persist` excludes; a `listensTo` low-latency
  fan-out queue serves one app's perf profile; serverFn response writes are
  HTTP, and `route()` owns that; starter cells are app policy, not framework
  capability.
- **Post-1.0 insurance**: additive-only evolution — new features behind new
  exports and options, never changed semantics. `@experimental` is the only
  escape hatch for unstable surface. Keep the field-report ritual, and pin
  field-report keep-lists as tests wherever possible.
- **Needs the user's machines** (not closable from here): the Windows and macOS
  target matrix, a real-Android device pass, the 72-hour soak, and the off-box
  remote field report.
- **Windows zero-port** (hardware week, first item): Deno has no Unix-socket
  listener on Windows and Node has no `AF_UNIX` there — but Node has named
  pipes. Design: the Electron shell hosts `\\.\pipe\aio-<app>`, Deno dials it
  with `Deno.open` (a pipe is a file object → duplex byte stream, no FFI); the
  NDJSON envelope, control plane and page-over-socket path stay identical. Until
  it is proven on a real Windows box the fallback is WS + TCP on `127.0.0.1`,
  named in the boot line. See `docs/clients/transports.md`.

## `discovery: multi-app-per-host` is environment-sensitive, not hermetic

`tests/discovery.test.ts` sends a UDP broadcast and asserts on whoever answers.
It therefore sees every aio responder reachable on the LAN — including apps
started by other tests, other checkouts, or another machine entirely. Observed
failing once with `apps.length >= 3` PASSING while its own `dashboard` was
absent: three strangers answered and its own responder did not make the window.

Not a regression (it passes 3/3 in isolation and in a full suite run), but it
can fail for reasons that have nothing to do with the change under test, which
is the property that eventually gets a test deleted rather than fixed.

Fix direction: give the responder a per-run nonce and have the sweep keep only
answers carrying it. The test then measures ITS responder instead of the
neighbourhood, and stays meaningful on a busy network.

## `install.sh` against a repo created under a restrictive umask — DIAGNOSED (alpha69)

`git` applies the process umask when it writes loose objects, so commits made
under `umask 077` land as `400` (owner-read) instead of git's usual `444`. The
owner can still clone such a repo; **another user cannot read the objects at
all**, which is what the onboarding lab does — and git reports:

```
fatal: failed to copy file to '…/.git/objects/fc/afa…': Permission denied
```

Hit again on 2026-08-27: 38 objects and several hundred working-tree files
written by agents running under a tight umask failed `deno task lab`.

**Not fixable on the installer's side** — a clone must READ what it cannot read,
so `--no-hardlinks` and the `file://` transport fail identically (both were
tried; both still open the object). It is a property of the source repo.

What alpha69 changed: `install.sh` now RECOGNISES the failure and names the
cause and the fix (`chmod -R o+rX <repo>/.git`, and `umask 022` before
committing) instead of leaving git internals as the only clue. That is the whole
of what this side can do, so this item is closed as diagnosed rather than
carried as a defect.
