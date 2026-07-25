# Road to 1.0.0-final

Plan written 2026-07-04, current as of **v1.0.0-alpha35** (2026-07-25). **Core
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

## The gate to beta (user rule, 2026-07-19)

Ten consecutive alpha releases with **no major/critical/blocker bug and no
compat break**. A corruption-class bug found during an alpha resets the count —
that is the gate working, not a setback.

- Streak: **2** (alpha34, alpha35). The alpha34 audit found six data-loss /
  security HIGHs, which reset it.

## Remaining before beta

- [ ] **Decide `localFirst`.** The spec and the machinery exist
      (`docs/specs/2026-07-22-local-first.md`; local execution, HLC ops, offline
      queue, rejection path, `serverFns` all shipped) — the switch does not. Two
      steps: ship `aio.run({ localFirst: true })` as opt-in, then decide the
      default once a real app reports back. It changes WHERE methods run, so it
      cannot land after the freeze.
- [ ] **Structural trio** (alpha-only, each behind its own full gate run) —
      unify the cell-binding triple (server catalog / reactive proxy / protocol
      stub, the proven fix-one-forget-the-others offender), collapse the
      `AioConfig` intermediate (~420 LOC, one producer + one consumer), split
      the 1016-line `server-ws.ts` factory (abuse / backpressure / routing).
- [ ] **`aio/server` import split** (risoto) — a server-only entry point so a
      browser bundle cannot reach server symbols by construction, rather than
      the graph validator catching it afterwards.
- [ ] **B1 — the beta1 release itself.** API snapshot locked ✓, semver +
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
- [ ] **Array patch granularity.** `push` emits an `add` patch (now documented),
      but a _replacing_ mutation still ships the whole array. A
      `pushPatch`-style helper — or Immer-level array diffing — would remove the
      footgun instead of documenting around it.
- [ ] **Worker cells in compiled binaries.** Currently they degrade to
      in-isolate, and production is exactly where a wedged FFI call hurts most.
      Needs the entry to be re-importable from inside the binary.

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
