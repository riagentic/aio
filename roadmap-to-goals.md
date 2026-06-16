# Roadmap to Goals — audit + implementation plan

**Audited:** 2026-06-12, at `v1.0.0-alpha13` (commit `4dff8e7`). **Source of
goals:** `goals.md`. **Companion plans:** `todo.md` (DX overhaul, in progress),
`issues.md` (AIR signal DX issues, partially unaddressed).

This document does three things:

1. **Audit** — where the project stands against each goal today.
2. **Gap analysis** — what concretely blocks each goal.
3. **Roadmap** — ordered workstreams R0–R6 with implementation details and
   acceptance criteria. R0 is mostly "finish what `todo.md` already plans";
   R1–R6 cover everything `todo.md` explicitly scoped out or never targeted.

---

## Part 1 — Audit snapshot

**What exists (strong foundation):**

- ~208 source files, 124 test files, 1958+ tests, 11 nuclear-audit waves (~194
  bugs fixed). Core (cells, dispatch, sync, persistence, AIR renderer,
  scheduling) is stable per README.
- Full subsystem coverage: Deno.Kv auto-persist, SQLite worker + ORM, WS sync
  with delta patches + offline queue, auth/TLS (`--expose`), cron, time-travel,
  hot reload, `testCell` harness, AIR (~8KB) renderer with SSR/hydration.
- Build toolchain (`src/build.ts`): `--compile`, `--electron`, `--android`,
  `--client`, plus systemd service generation. Scaffolder (`utils/create.ts`)
  with app-type menu. Custom linter (`aiol/`) with browser/memo checks.
- Error infrastructure: typed error codes (`src/error.ts`, 513 lines),
  diagnostic bus, dev hints (`_hint` in `src/compat.ts`), HTML error overlay,
  graph validator.
- Docs: ~14 sections, architecture doc, per-topic guides, comparison table.
- DX overhaul (`todo.md`) underway: tasks 1.1–1.3 and 5.1 done; 2.1 committed
  (`66226b4`) but its checkbox is still unchecked — verify and tick it.

**Housekeeping found during audit:** `src/jsx-runtime.ts` has uncommitted
changes in the working tree; either commit under its task or stash.

### Goal-by-goal scorecard

| #  | Goal (paraphrased)                         | Status | Evidence / gap                                                                                                                                         |
| -- | ------------------------------------------ | :----: | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1  | Super user friendly                        |   🟡   | Zero-config run works; but `todo.md` documents method-return lies, mode cliffs (fixed), draft-read traps                                               |
| 2  | Stupid-proof                               |   🟡   | `aiol` linter + freeze detection exist; silent failures remain: pre-run method calls (2.3), Set/Map signal no-op (issues.md P0), name collisions (6.1) |
| 3  | Intuitive                                  |   🟡   | Three mixable styles is good; "works on server, lies in UI" await trap (2.2) is the biggest intuition breaker                                          |
| 4  | Forgiving                                  |   🟡   | Prod resilience posture exists; dev should fail loud (2.3, 4.4, 8.2) — currently fails silent in places                                                |
| 5  | Minimalistic                               |   🟡   | 10-line counter is real; API surface never inventoried; React-compat hooks pollute main surface (7.6)                                                  |
| 6  | Easy and familiar                          |   🟡   | React muscle memory betrayed: useEffect deps ignored, onDoubleClick never fires, event casts (Phase 7)                                                 |
| 7  | Significantly simplify app development     |   🟢   | Replaces 6 systems; the claim holds once Phases 1–4 make defaults truthful                                                                             |
| 8  | Free devs from unnecessary complexity      |   🟡   | `void sig.value` incantation (7.5), `markAsync` tribal knowledge (8.2), manual deno.json magic lines (8.3)                                             |
| 9  | Electron/Android app with single command   |   🟡   | `build.ts --electron/--android` exists; unverified end-to-end ("less battle-tested" per README); no CI smoke builds; no `aio build` ergonomic entry    |
| 10 | Compact and intuitive syntax               |   🟢   | `cell()` API is compact; cross-cell selectors were documented-but-missing (3.1 fixes)                                                                  |
| 11 | Detailed error descriptions, no hour-hunts |   🟡   | Error codes + diagnostic bus exist; coverage uneven — issues.md P0/P1 are exactly "hours of guessing" failures; no error-message quality bar enforced  |
| 12 | Loved by developers                        |   🔴   | No feedback loop, no published metric (time-to-first-app), no community surface; outcome goal — see R6                                                 |
| 13 | Holy grail of app development              |   🔴   | Aspirational; proxy = all other goals green + R6 adoption metrics                                                                                      |
| 14 | Unified / consistent                       |   🟡   | One meaning for `cell.method()` everywhere (Phase 2) is THE consistency fix; selector arg shape (3.1); naming rules (6.1)                              |
| 15 | air as default react-lite UI framework     |   🟢   | Done in alpha12 (React renderer removed, AIR sole renderer); remaining: compat-hook demotion (7.6)                                                     |
| 16 | Minimize/hide wiring, boilerplate          |   🟡   | Auto-wiring is real; remaining boilerplate: event-target casts (7.3), spread-to-force-signal (issues.md P4), per-client state workarounds (5.2)        |

Legend: 🟢 substantially met · 🟡 partially met, concrete gaps known · 🔴 not
yet started / unmeasurable.

**Conclusion of the audit:** the architecture already matches the goals; the
distance to "goals achieved" is (a) finishing the DX overhaul, (b) the signal
reactivity bugs in `issues.md`, (c) hardening the single-command build targets,
(d) an enforced error-quality bar, and (e) building the measurement/feedback
loop that goals 12–13 require.

---

## Part 2 — Roadmap

Ordering rationale: correctness-of-promises first (R0–R1, the framework must do
what its docs say), then loud-failure hardening (R2), then the build-target goal
(R3), then surface minimalism (R4), then docs/onboarding (R5), then the adoption
flywheel (R6). R0/R1 block everything else; R3–R6 can interleave.

---

### R0 — Finish the DX overhaul (`todo.md` Phases 2–9)

**Goals served:** 1, 2, 3, 4, 6, 8, 10, 14, 16. **Status:** Phase 1 done, 5.1
done, 2.1 committed-but-unticked. Remaining: 2.1-verify, 2.2, 2.3, 3.1, 4.1–4.4,
5.2, 6.1, 7.1–7.6, 8.1–8.3, 9.1–9.3.

This is the backbone. `todo.md` already contains task-level implementation
detail (Problem → Files → Steps → Acceptance); do not duplicate it here —
**execute it top-to-bottom as written.** Roadmap-level notes only:

- **Highest leverage single task: 2.2 (browser ack promises).** It converts the
  framework's central promise ("await means applied") from false to true in the
  place users actually live (the browser). Everything in Phase 9's truth pass
  depends on it.
- **2.1 hygiene:** commit `66226b4` claims 2.1; run
  `deno test -A --unstable-kv tests/direct-call-return.test.ts` and the full
  suite, then tick the box. The uncommitted `src/jsx-runtime.ts` diff likely
  belongs to 7.2/7.3 — triage before starting Phase 3.
- **Do Phase 9 (docs truth pass) dead last** as `todo.md` instructs — it locks
  in R0+R1 together, so schedule it after R1 lands.

**Exit criteria:** every checkbox in `todo.md` ticked; the 9.3 verification gate
(full suite, `deno check`, `deno lint`, counter-restart persistence, two-tab
todo test, grep gates, CHANGELOG entry) passes.

---

### R1 — Signal reactivity correctness (`issues.md` P0–P4) — ✅ DONE (2026-06-15)

**Status:** all of R1.1–R1.5 are implemented. P0/P1/P4 shipped in the AIO-364
signal pass (`src/signal.ts`), P2 in dx 7.5, P3's JSDoc in
`src/renderer-lifecycle.ts`; `issues.md` is fully marked resolved. The
sub-section detail below is retained as the implementation record.

**Goals served:** 2, 3, 11, 16. `todo.md` covers P2 (task 7.5) but **not P0, P1,
P3, P4** — these are tracked nowhere else and P0 is a critical silent-failure
bug. Fold them in as follows.

#### R1.1 — Set/Map silently ignored by `_shallowEq` (P0)

- **Files:** `src/signal.ts`, new `tests/signal-set-map.test.ts`.
- **Implementation:** in `_shallowEq`, before the `Object.keys` comparison:
  `if (a instanceof Set || a instanceof Map || b instanceof Set || b instanceof Map) return false;`
  (forces propagation; correct because the caller already passed an `Object.is`
  identity check).
- **Tests:** `signal(new Set()).set(new Set(['a']))` notifies subscribers; same
  for `Map`; plain-object shallow-eq behavior unchanged (pin it).
- **Acceptance:** UI updates on Set/Map mutation in a DOM test; suite green.
- **Sequencing:** do immediately — 2-line fix, critical impact, independent of
  everything else.

#### R1.2 — Dev-mode signal tracing (P1)

- **Files:** `src/signal.ts`, docs `docs/debugging/troubleshooting.md`.
- **Implementation:** when a signal has a name (`signal(v, "name")`) and dev
  mode is on, `console.warn` on skipped updates, distinguishing "identical
  reference" vs "shallow-equal". Use the existing dev-mode flag the renderer
  uses (locate via `grep -n _devMode src/signal.ts src/compat.ts`); expose
  `localStorage.AIO_DEV = '1'` toggle if not already present.
- **Acceptance:** test asserts one warn per skipped named-signal update, zero
  warns in prod mode; troubleshooting doc gains a "signal didn't update?" entry
  pointing at naming + tracing.

#### R1.3 — `useSignal` JSDoc + module-signal recipe (P3)

- **Files:** JSDoc at `useSignal` definition, `docs/ui/air-signals.md`.
- **Implementation:** exactly the JSDoc and recipe from `issues.md` P3 —
  component-scoped, GC'd on unmount, use module-level `signal()` for
  survives-remount state. Note: write the recipe WITHOUT the `void ui.value`
  incantation if R0 task 7.5 has landed (it kills that pattern).
- **Acceptance:** `deno doc` shows the new JSDoc; grep gate from 7.5 stays
  clean.

#### R1.4 — `sig.set(next, { force: true })` (P4)

- **Files:** `src/signal.ts`, `tests/` signal test file,
  `docs/ui/air-signals.md`.
- **Implementation:** optional options arg; `force: true` skips both equality
  checks and always notifies. Keep overload typing strict so `set(v)` is
  unchanged.
- **Acceptance:** in-place array mutation + `set(arr, {force:true})` re-renders;
  docs show it as the escape hatch replacing spread boilerplate.

#### R1.5 — Close out `issues.md`

Mark each P-item resolved with the task/commit reference, or migrate remaining
items into `todo.md`/this file. **Acceptance:** `issues.md` has zero open items
without a pointer.

---

### R2 — Error experience program (goal 11: "no hour-long investigations")

**Goals served:** 2, 4, 11. R0 fixes individual silent failures; R2 makes error
quality a _standing invariant_ instead of a per-bug fix.

#### R2.1 — Error message quality bar (definition + audit)

- **Definition (adopt as a rule in `rules.md`):** every developer-facing error
  must contain (a) **where** — `[cell:method]` or subsystem prefix, (b) **what**
  — the violated expectation in plain words, (c) **fix** — one concrete next
  action or doc link. Pattern already used by the best existing messages (e.g.
  2.3's "called before aio.run() — add this cell to aio.run({cells:[...]})") —
  make it universal.
- **Implementation:** inventory every `throw` and `log.error`/`log.warn` in
  `src/` (`grep -rn "throw new\|log.error\|log.warn" src/ | wc -l` first to size
  it; expect a few hundred). Triage into: meets bar / needs fix / internal
  (never user-facing, exempt). Fix in batches by subsystem, one commit per
  subsystem (`err(<subsystem>): messages meet where/what/fix bar`).
- **Enforcement:** add an `aiol` lint rule (in `aiol/`) flagging
  `throw new
  Error("...")` literals in `src/` that lack a `[prefix]` and a `—`
  fix clause; exempt via `// aiol-ignore: internal`.
- **Acceptance:** audit spreadsheet committed under `docs/specs/`; aiol rule
  active in `deno task lint:aio`; zero unexempted violations.

#### R2.2 — Error catalog doc

- **Files:** `docs/debugging/errors.md` (extend), `src/error.ts`.
- **Implementation:** generate a table of all `ErrorCode` values from
  `src/error.ts` with one paragraph each: when it fires, what to check, linked
  doc. Add a `scripts/check-docs.ts` assertion that every code in `error.ts`
  appears in `errors.md` (script already exists — extend it).
- **Acceptance:** check-docs passes; every code documented.

#### R2.3 — First-run failure UX

- **Implementation:** the three highest-frequency newcomer failures (bad
  `deno.json` JSX config, missing `--unstable-kv`, port in use) must each
  produce a where/what/fix error _and_ a pointer to `deno task doctor` (R0 task
  8.3 builds doctor; this task wires errors to recommend it).
- **Acceptance:** manual matrix — break each config knob in a temp fixture,
  confirm the printed error names the knob and the fix.

---

### R3 — Single-command targets, battle-tested (goal 9)

**Goals served:** 9, 7. The toolchain exists; the gap is _trust_ ("functional
but less battle-tested") and _ergonomics_ (no single memorable command).

#### R3.1 — `aio build <target>` ergonomic entry

- **Files:** `utils/cli.ts` (or wherever `aio create` lives), `src/build.ts`,
  `src/build-config.ts`, `docs/build/targets.md`.
- **Implementation:** expose `deno task build:electron`, `build:android`,
  `build:binary` in scaffolded projects (scaffolder change in
  `utils/create.ts`), each a one-liner wrapping
  `deno run -A jsr:@riagentic/aio/src/build --electron` etc. The literal goal is
  "single command line" — a memorable task name is that command.
- **Acceptance:** fresh scaffold → `deno task build:electron` produces a
  runnable AppImage with no other steps; same for `build:android` → APK (Android
  SDK presence checked by doctor, R3.3).

#### R3.2 — Target verification matrix + CI smoke builds

- **Implementation:** a checklist doc (`docs/build/verification.md`) with the
  full matrix: {counter, todo} × {browser-prod, electron, android, binary,
  service, cli}. For CI (or a `scripts/smoke-build.ts` run manually per
  release): build each target headlessly, assert artifact exists, launch where
  possible (binary + `--client=server-only` at minimum; Electron via `xvfb-run`
  if available; Android = APK assembles + `apkanalyzer`/zip sanity only).
- **Acceptance:** script exits 0 on main; release checklist in CHANGELOG process
  references it; README may then drop "less battle-tested".

#### R3.3 — Doctor covers build prerequisites

- **Files:** `src/doctor.ts` (created by R0 task 8.3).
- **Implementation:** add target-specific checks: `ANDROID_HOME`/SDK + java for
  `--android`; `nodeModulesDir` + electron resolvable for `--electron`;
  disk-space sanity for `--compile`. Each FAIL prints the install one-liner.
- **Acceptance:** doctor on a machine without Android SDK fails only the android
  check, with the fix line.

#### R3.4 — Build error messages meet the R2 bar

Build failures are where beginners abandon a framework. Audit `build-*.ts` error
paths specifically (esbuild failures, missing icons, gradle/apk signing errors)
and wrap raw tool stderr with a where/what/fix header. **Acceptance:**
intentionally break each step in a fixture; every failure names the step and the
fix.

---

### R4 — Minimalism & API-surface audit (goals 5, 10, 16)

**Goals served:** 5, 10, 16, 14.

#### R4.1 — Public API inventory + budget

- **Implementation:** `deno doc --json mod.ts src/air.ts` → script
  (`scripts/api-surface.ts`) emitting a sorted list of exported symbols per
  entry point. Commit the snapshot as `docs/specs/api-surface.md`. Review each
  export: core / convenience / should-be-internal / deprecated. Anything not
  defensible moves out of `mod.ts` (kept importable via subpath for one release,
  `@deprecated` tagged — same pattern as R0 task 7.6).
- **Budget rule:** adding a new export to `mod.ts` or `aio/air` requires
  updating `api-surface.md` in the same PR (check-docs enforces the file is in
  sync via the script).
- **Acceptance:** snapshot committed; check-docs gate active; deprecation
  candidates listed with removal milestone (post-1.0).

#### R4.2 — Boilerplate census on examples

- **Implementation:** for each example, count lines that are _wiring_ (imports,
  config, type incantations, casts) vs _intent_ (state, methods, UI). Target:
  wiring ≤ 20% in every example after R0 lands (7.3 removes casts, 5.2 removes
  the persist-exclude workaround). Where wiring remains, file a concrete
  framework task to absorb it — the census is the goal-16 backlog generator.
- **Acceptance:** census table in `docs/specs/`; each >20% example has either a
  fix task or a written justification.

#### R4.3 — `examples/playground` triage

Audit `examples/playground` (exists, undocumented in README): either promote it
to a documented kitchen-sink example held to the same exemplary bar as 9.2, or
delete it. Half-maintained examples teach anti-patterns. **Acceptance:**
playground is documented-and-exemplary or gone.

---

### R5 — Onboarding & docs that match goal 6 ("easy and familiar")

**Goals served:** 1, 3, 6, 12. Mostly sequenced after R0 Phase 9 so docs are
written once, truthfully.

#### R5.1 — Time-to-first-app (TTFA) measurement

- **Implementation:** define the metric — minutes from
  `deno run -A
  jsr:@riagentic/aio/utils/create.ts` (or documented equivalent)
  to "todo app with persistence visible in browser", on a clean machine,
  following only the quickstart. Measure it yourself (script the clean-machine
  run in a container) and record in `docs/specs/ttfa.md`. **Target: ≤ 5
  minutes.** Every future DX task can cite its TTFA effect.
- **Acceptance:** containerized TTFA script committed; current number recorded.

#### R5.2 — "Coming from React" guide

- **Files:** `docs/basics/migration.md` (R0 task 7.6 starts this — extend).
- **Implementation:** a single table-driven page: every React API/habit → aio
  equivalent (`useState`→`useLocal`/`signal`, `useEffect`→`onMount`/`effect`,
  `useMemo`→`computed`, Redux→cells, react-query→async methods + resource,
  Context→cross-cell selectors). Familiarity (goal 6) is delivered by mapping,
  not by mimicry.
- **Acceptance:** page exists; each row links to a runnable doc snippet.

#### R5.3 — Quickstart hard-gate

Add `scripts/check-docs.ts` extension: extract every fenced `ts`/`sh` block from
`docs/basics/quickstart.md` and type-check / dry-run what's checkable. Docs that
drift from reality is the single fastest way to lose goal-12 trust.
**Acceptance:** check runs in `deno task check` or a dedicated task; passes.

---

### R6 — The flywheel: measure "loved by developers" (goals 12, 13)

Outcome goals can't be implemented, only instrumented and earned. Minimal honest
loop:

- **R6.1 Feedback channel:** GitHub issues template with three forms (bug /
  DX-paper-cut / docs-lie). The DX-paper-cut form feeds `issues.md`-style files;
  commit the template under `.github/`.
- **R6.2 Release cadence + upgrade honesty:** keep the existing
  `docs/upgrade/from-X-to-Y.md` discipline; every breaking change has an upgrade
  note in the same PR (extend check-docs: CHANGELOG breaking entries must
  reference an upgrade doc).
- **R6.3 Definition of "holy grail" (goal 13), made falsifiable:** declare v1.0
  criteria = all `todo.md` boxes ticked, R1–R5 acceptance criteria green, TTFA ≤
  5 min, R3.2 matrix green, error-bar lint clean. When those hold, goals 1–11 +
  14–16 are demonstrably met and 12–13 become a marketing and community problem,
  not an engineering one.
- **Acceptance:** v1.0 criteria block added to `CHANGELOG.md` or `rules.md`;
  templates committed.

---

## Part 3 — Sequencing summary

```
now ──► R1.1 (Set/Map fix — 1 day, do first, it's a P0 silent-failure bug)
     ├► R0 Phases 2–4 (promise contract, selectors, drafts)   ← critical path
     │    └► R0 Phases 5.2–8 (client cells in todo, collisions, React compat, conventions)
     │         └► R0 Phase 9 + R5 docs work (single truth pass)
     ├► R1.2–R1.5 (signal tracing/force/docs — parallel, small)
     ├► R2 (error bar — parallel per-subsystem batches, start after Phase 2)
     └► R3 (build hardening — independent, start anytime; R3.3 needs 8.3 doctor)
            └► R4 (surface audit — after 7.6 lands)
                 └► R6 (v1.0 criteria — last)
```

Rough effort (sequential solo-dev estimate, calibrated to task sizes in
`todo.md`): R0 remainder ≈ the dominant cost; R1 ≈ days; R2 ≈ 1–2 weeks of
batched passes; R3 ≈ 1 week + per-release maintenance; R4–R6 ≈ days each.

## Part 4 — Standing rules while executing (inherited from todo.md, apply repo-wide)

1. One task at a time, top of the critical path first.
2. Test before fix; full suite green after every task
   (`deno test -A --unstable-kv tests/`).
3. Docs change in the same commit as the behavior they describe.
4. Every dev-facing error meets the where/what/fix bar (R2.1) from now on —
   don't wait for the batch audit to write new errors correctly.
5. Silent failure is never acceptable in dev mode; prod degrades gracefully and
   loudly logs.
