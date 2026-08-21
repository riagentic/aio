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
- **Internals + blobs.** `protocol/`↔`state` decomposition; boundary-gate
  tightening (unused edges, unused permissions, root files that launder
  imports); offline-queue unification (one factory, one drop policy);
  `PRAGMA user_version` plus one ordered fatal DDL runner; `app.blobs` —
  content-addressed files under `appDirs().files`, HTTP Range streaming,
  `put/get/stream/url`.

## Open asks from field reports

Recorded because they were asked for and are not yet decided or built — not
because anything is broken.

**From llama.master (alpha55/alpha61, 8/10):**

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

**From risoto (money software, alpha59 → triaged at alpha61):**

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

**From rimote (alpha61/63):** stale-capture detection is per-invocation by
design — a reference that escapes a method (a module-level variable, a callback)
is not tracked, because the ledger dies with the invocation. Escaping a live
proxy is already outside the contract, so it is worth an `aiol` rule rather than
a runtime cost on every read.

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
  `/__aio/vitals` reports `clients: []`; `DevToolsHandle.tree` is `[]` forever.
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
