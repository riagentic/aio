# Production Roadmap — from alpha13 to a 1.0 you can ship without shame

**Written:** 2026-06-12, after a full audit (see `bugs.md` for concrete defects
found). Companions: `todo.md` (DX overhaul — behavior correctness),
`roadmap-to-goals.md` (goal-level plan). This file is the **release-engineering
view**: everything that must be true before calling it `1.0.0` and inviting
production users.

**Audit verdict in one paragraph:** the feature set is genuinely 1.0-grade and
the code shows unusual hardening discipline (timing-safe auth, abuse denylists,
cycle guards, ~194 audited fixes). What's _not_ 1.0-grade is the release
engineering around it: the test suite is red on current Deno, there is no CI at
all, the project's own gates (`check`, `lint`) are either red or don't cover the
code that broke, there's no health endpoint, no compat matrix, no release
process, and several silent-failure paths remain. "Production-ready" is less
about more features and more about making the green state provable,
continuously, on every platform you claim to support.

---

## Definition of Done for v1.0 (the no-shame checklist)

v1.0 ships when every box below is checked. Each box is backed by a workstream
(W0–W7) with implementation details.

- [ ] **Gates green and binding:** `deno task test`, full-tree `deno check`,
      `deno task lint` all pass on every supported Deno version, enforced by CI
      on every PR. (W0, W1)
- [ ] **No known silent failures:** every P0/P1/P2 in `bugs.md` fixed with a
      regression test; "silent failure is never acceptable in dev" enforced by
      review rule. (W0)
- [ ] **Behavior matches docs everywhere:** `todo.md` DX overhaul complete
      through its Phase 9 truth pass. (W2)
- [ ] **Compat matrix proven:** tested Deno versions (2.6–2.8+), OSes
      (Linux/macOS/Windows), browsers (evergreen Chrome/Firefox/Safari) — each
      cell green in CI or explicitly documented as unsupported. (W1)
- [ ] **All build targets smoke-built in CI:** browser-prod, binary, Electron,
      Android, CLI, service. README's "less battle-tested" caveat deleted
      because it's no longer true. (W3)
- [ ] **Operations story exists:** health endpoint, graceful-shutdown guarantees
      documented and tested, backup/restore procedure, 24h soak test with flat
      memory. (W4)
- [ ] **Security posture written down and verified:** threat model doc,
      token-in-URL retired to opt-in, protocol fuzz pass, dependency audit,
      SECURITY.md disclosure policy. (W6)
- [ ] **Release process is mechanical:** versioning policy, JSR publish dry-run
      in CI, signed/tagged releases, CHANGELOG + upgrade doc per breaking
      change, deprecation policy. (W7)
- [ ] **Performance claims measured:** benchmark suite with budgets in CI; load
      test (100 concurrent WS clients) passes; large-state persistence behavior
      verified. (W5)

---

## W0 — Stop the bleeding (do first, this week)

Fix the defects that make every other claim unverifiable. All items reference
`bugs.md`.

1. **B-1** — SQLite worker type-check failure on Deno 2.8.2. Until fixed, the
   test suite cannot gate anything. Includes deciding and _documenting_ the
   supported Deno range.
2. **B-2** — signal `batch()` stale-computed drop. Highest-severity runtime bug
   found; sits under every DOM event handler. Fix + permutation test matrix
   (`tests/signal-batch-staleness.test.ts`).
3. **B-3** — lint to zero, then binding.
4. **B-9** — expand `deno task check` to the full tree
   (`deno check src/
   examples/ tests/`), so worker-only modules can never
   silently rot again.
5. **B-4** — dispatch must not resolve dropped actions; align with the Phase-2
   promise contract before task 2.2 builds the browser ack on top of it.
6. **B-5/B-6** — esbuild false warning + specifier divergence (small, trust-
   restoring).
7. **B-7/B-8/B-10** — silent-failure trio in persistence/offline queue.
8. **B-12/B-13** — working-tree and stale-doc hygiene (`issues.md`,
   `roadmap-to-goals.md` R1 correction: signal P0/P1/P4 are already fixed; only
   useSignal JSDoc and todo-7.5 remain).

**Exit:** all three gates green locally on Deno 2.8.x; `bugs.md` items each
closed with a commit reference or explicitly deferred with a reason.

## W1 — Continuous Integration + compat matrix (the single biggest gap)

There is **no CI configuration in the repo at all**. For a framework claiming
production use, this is the most shameful gap found — every other guarantee is
"works on my machine" until this exists.

**Implementation:**

- `.github/workflows/ci.yml`: jobs = {test, check, lint, fmt-check} × Deno
  {2.6.x, LTS, latest stable} × {ubuntu, macos, windows}. KV/SQLite tests need
  `--unstable-kv`; keep the existing `test:core` split so flaky
  platform-specific suites (electron, tls) can be quarantined explicitly, not
  silently.
- Browser-reality job: run the existing happy-dom suites, plus one real-browser
  smoke (Playwright or `deno run` + headless Chrome) booting `examples/todo`,
  clicking, asserting sync — this is the only way the renderer/transport claims
  are continuously true.
- Publish dry-run job: `deno publish --dry-run` on every PR (catches JSR
  manifest/export breakage like slow-types before release day).
- Badge in README only after it's actually green for a week.

**Exit:** PRs cannot merge red; compat matrix table added to README ("Supported:
Deno ≥2.6 ✓ tested in CI").

## W2 — Behavior correctness (delegate to existing plans)

`todo.md` (Phases 2–9) and `roadmap-to-goals.md` (R1 as corrected by B-13)
already specify this work at task level. Production-relevant emphasis:

- Phase 2 (one meaning for `cell.method()` incl. browser acks) and Phase 4
  (draft reads) are _correctness_, not polish — they block 1.0.
- Phase 9 truth pass is the docs gate; schedule last, after W0 fixes land, so
  docs are written once.
- Add to Phase 9's gate: `bugs.md` must be empty or all-deferred-with-reason.

## W3 — Build targets you can stand behind

The toolchain exists (`src/build.ts`:
`--compile/--electron/--android/
--client`); what's missing is proof and
ergonomics (also `roadmap-to-goals.md` §R3 — this is the release-gating subset):

1. **Smoke-build script** (`scripts/smoke-build.ts`): builds every target for
   `examples/counter` headlessly; asserts artifact exists and (where possible)
   launches it: binary + `--client=server-only` → curl health; Electron via
   `xvfb-run`; Android → APK assembles + zip structure sanity. Wire into CI
   (nightly if too slow for PRs).
2. **Scaffolded tasks:** `deno task build:electron` / `build:android` /
   `build:binary` in `utils/create.ts` output — the goals.md "single command
   line" made literal.
3. **Doctor prereq checks** for each target (ANDROID_HOME/java, electron dist/,
   disk space) with one-line fixes — extends todo-8.3's doctor.
4. **Build failures meet the error bar:** wrap esbuild/gradle/signing stderr
   with `[build:<step>] what failed — fix`. Break each step intentionally in a
   fixture and review every message once.

**Exit:** CI builds all targets green for 2 consecutive weeks → delete
"functional but less battle-tested" from README §Status.

## W4 — Operations: run it for a year without fear

Missing today: any way for an operator (or systemd, or a load balancer) to ask
"is it healthy?", any documented backup story, any leak/soak evidence.

1. **`/health` endpoint** (none exists today — grep confirmed): returns
   `{ ok, version, bootId, uptime, clients, queueDepth, effectBacklog,
   persistLag }`
   — all already tracked internally (`dispatch.getQueueDepth()`,
   `getEffectBacklog()`, WS connections map). No auth required for a bare
   200/503; details only with auth. Document for systemd watchdog +
   reverse-proxy checks. Generated `aio-counter.service` gains
   `WatchdogSec`/healthcheck wiring.
2. **Graceful shutdown contract, tested:** SIGTERM → stop accepting WS, drain
   dispatch (bounded), `flushPersist` (with B-10 fixed), close KV/SQLite, exit 0
   within N seconds. One integration test that kills a live app mid-traffic and
   asserts state survival + clean exit code. Document the contract in
   `docs/build/scaling.md`.
3. **Backup & restore:** document where state lives (Deno.Kv path per appId,
   SQLite file), a safe hot-copy procedure, and a `aio export/import` (JSON dump
   of cell state) — even a minimal version turns "my KV file is corrupt" from
   catastrophe into recovery. Test the restore path.
4. **24h soak test** (`scripts/soak.ts`): synthetic client cluster
   (connect/disconnect churn, steady action rate, offline/reconnect cycles)
   against `examples/todo`; record RSS, connection count, queue depths hourly;
   assert flat-line within tolerance. Run before each release. This is the only
   honest answer to "does it leak?" — the listener-leak class of bug (fixed in
   wave 11) says the risk is real.
5. **Crash recovery:** document and test what happens with a corrupt/partial KV
   value and a mid-write SIGKILL (KV is atomic per commit — assert that's
   actually sufficient with a kill-during-persist test).

## W5 — Performance: measure what the README implies

1. **Benchmark suite** (`deno bench`, `bench/` dir): dispatch throughput, reduce
   latency p50/p99 for a 100-key cell, patch-compact encode/decode, signal flush
   with 1k subscribers, SSR render of `examples/todo`. Budgets asserted (fail
   > 20% regression) in nightly CI.
2. **Load test:** 100 concurrent WS clients (the default `WS_MAX_CONNECTIONS`)
   on one process — connect storm, sustained 50 actions/s, measure broadcast
   fan-out latency and staleness-backpressure behavior. Verify the abuse
   denylist doesn't trip on legitimate burst traffic.
3. **Large-state reality:** persistence at 50KB/500KB/5MB state in both `single`
   and `multi` modes (S-3 in `bugs.md`: atomic-commit limits need chunking or a
   proactive error); broadcast patch size behavior on large cells; document hard
   limits in `docs/persistence/auto-persist.md`.
4. **Docs honesty:** wherever docs say "fast"/"~8KB"/"non-blocking", link the
   benchmark that proves it (AIR bundle size asserted in a test).

## W6 — Security posture for exposed deployments

Code-level hygiene is already good (timing-safe compares, origin checks,
denylists, rate limits, CSRF, prototype-pollution guards). What's missing is the
_posture around_ the code:

1. **Threat model doc** (`docs/auth/threat-model.md`): what `--expose` is and is
   not designed for (LAN/tailnet tools vs hostile internet), what an
   authenticated client can do (dispatch any non-internal action — i.e. every
   authenticated user is a writer), multi-user trust boundaries with
   `ui.forUser`.
2. **Retire token-in-URL to opt-in** (B-11): default to `Authorization`
   header/cookie; query-param only with explicit config + startup warning.
3. **Protocol robustness pass:** fuzz the WS message parser (malformed JSON,
   oversized cid, type-confusion payloads on `__` internal prefixes, sync/op
   messages) — a `Deno.test` fuzz harness with a seed corpus is enough; the
   parser must never throw uncaught or leak state to unauthorized cells.
4. **Dependency audit + pinning:** all deps exactly pinned (B-6 fixes the one
   floating specifier); `deno info --json` diff in CI to flag new transitive
   deps; document the (pleasingly short) dep list.
5. **SECURITY.md:** disclosure contact, supported-version policy, response SLA.
   Required for "production without shame".
6. **Rate-limit configurability:** `WS_MAX_MESSAGE`, `WS_RATE_LIMIT`,
   `WS_BYTES_PER_SEC` are constants (`src/server-ws.ts:11–14`) — expose via
   config with current values as defaults, documented in scaling docs.

## W7 — Release engineering & policy

1. **Versioning policy:** adopt and document semver-with-teeth — what counts as
   breaking (any observable behavior in docs), minimum deprecation window (one
   minor), `@deprecated` JSDoc + runtime dev-warn pattern (already used for
   compat hooks — make it the standard).
2. **Release checklist** (`docs/upgrade/RELEASING.md`): gates green on matrix →
   smoke-builds green → soak run → CHANGELOG section → upgrade doc if breaking →
   `deno publish --dry-run` → tag → publish → post-publish install test
   (`deno add jsr:@riagentic/aio` in a clean container + counter boot).
3. **API freeze for 1.0:** after W2's truth pass and roadmap-to-goals R4.1
   surface audit, declare the exported surface frozen; additions OK, removals/
   renames require deprecation cycle.
4. **Support statement in README:** supported Deno range (CI-proven), browser
   floor, OS matrix, and an honest "experimental" label for anything not in the
   CI matrix (instead of the current blanket alpha caveat).
5. **1.0 announcement honesty:** ship with the Definition-of-Done checklist
   above, publicly checked — that's the difference between "we feel ready" and
   "we can show you."

---

## Sequencing

```
Week 0:  W0 (bugs.md P0/P1) ──► gates green locally
Week 1:  W1 CI skeleton (test/check/lint on linux) ──► gates green remotely, binding
       parallel: W2 continues (todo.md Phases 2–4)
Week 2+: W1 full matrix · W3 smoke builds · W6.2/.4/.5 (cheap, high-trust)
Then:    W4 ops (health → shutdown → soak) · W5 benchmarks
Last:    W2 Phase 9 truth pass · W7 freeze + release checklist · 1.0
```

Dependencies: W1 needs W0 (can't enforce red gates). W3 CI jobs need W1. W4 soak
needs W0's B-2 fix (leak-free signals). W7 freeze needs W2 + R4.1.

## What was explicitly checked and found GOOD (no action)

For balance — these production-critical areas were audited and held up:

- `dispatch.ts`: re-entrancy, queue overflow handling, effect timeout/rejection
  tracking, correlation IDs — solid (modulo B-4's resolve-on-drop).
- Auth: timing-safe token comparison everywhere (`src/server-auth.ts:9`).
- WS layer: origin validation incl. strictOrigin, per-client + global rate
  limits, bandwidth caps, backpressure with abuse denylist surviving reconnects,
  connection/timer cleanup on error paths.
- `deepMerge` restore path: prototype-pollution ban, cycle guard, depth cap,
  schema-wins type-mismatch rules.
- Offline queue: TTL pruning by primary key, transaction-completion awaits.
- Scheduler: id validation, retry-with-backoff on one-shots, interval cancel on
  failure, setTimeout 2^31 overflow handling.
- Zero TODO/FIXME markers in `src/` — the codebase does not hide known debt.
