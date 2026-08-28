# Road to 1.0.0-final

> **The desk is clear.** Every reported finding is fixed with a test, or
> recorded in `feedback/refused.md` with its reason. There is no planned work
> list any more: alpha70 was the release where every remaining breaking change,
> every "deferred by design" item and every open ask was either done or refused
> in writing. What follows is the standing policy and the facts this side cannot
> change.
>
> Shipped work lives in `CHANGELOG.md`; what was fixed or refused from field
> reports lives in `feedback/resolved.md` and `feedback/refused.md`.

**Core principle:** all breaking changes died in alpha70; from here the surface
is frozen — additive only, bugfix-only through beta; 1.0.0 = boring.

---

## The gate to beta (user rule, 2026-07-19)

Ten consecutive alpha releases with **no major/critical/blocker bug and no
compat break**. A corruption-class bug found during an alpha resets the count —
that is the gate working, not a setback.

- **Streak: 1** — alpha71 (2026-08-28), the first release after the deliberate
  last compat break. Additive only; no major/critical/blocker bug reported
  against it.

## Decided in alpha70, so it is not re-litigated

- **Refused, with the reason on record** (see `feedback/refused.md`):
  `aio migrate` as a separate codemod tool — `aiol --safe-fix` IS the codemod
  and every retirement ships a rule for it; an `io:` method kind — `long: true`
  removes the ceiling, and an async method holds no mutex unless
  `transaction: true`, so the shape already exists (an aiol rule now refuses I/O
  in a sync method body); a terminal renderer for AIR — AIR's contract is the
  DOM, and `aio/cli` covers rich CLIs without a second renderer;
  `UI_CSS`/`UiStyles` consolidation — two spellings of a stylesheet cost nothing
  and break themes.
- **Deliberate non-features**, recorded so they are not re-proposed: a
  `scratch:` cell slice duplicates `visible`/`persist` excludes; a `listensTo`
  low-latency fan-out queue serves one app's perf profile; serverFn response
  writes are HTTP, and `route()` owns that; starter cells are app policy, not
  framework capability.

## Standing policy

- **Post-alpha70 insurance**: additive-only evolution — new features behind new
  exports and options, never changed semantics. `@experimental` is the only
  escape hatch for unstable surface. Keep the field-report ritual, and pin
  field-report keep-lists as tests wherever possible.
- **Every gate is a ratchet**: `check:silent-catch`, `check:vacuous`,
  `check:sanitizers`, `check:log-prefix`, `check:dead-wiring` freeze a count and
  only ever lower it. Raising a ceiling costs an argument in the commit.

## Facts this side cannot change

- **Needs the user's machines**: a real Windows pass (the named-pipe transport
  is proven under Wine and by inspection), a real macOS pass (Electron and the
  `ios-client` Xcode project cross-build fine; `xcodebuild` and a device run
  need a Mac), a real-Android device pass, the 72-hour soak, and the off-box
  remote field report.
- **`install.sh` against a repo committed under a restrictive umask** — git
  writes loose objects with the process umask, so `umask 077` commits are
  unreadable to another user (the onboarding lab). Not fixable on the
  installer's side; `install.sh` names the cause and the fix
  (`chmod -R o+rX <repo>/.git`, `umask 022` before committing), and since
  alpha71 `deno task lab` refuses BEFORE the first container with the same words
  — it hit this three times, each time reading as a git error. Diagnosed in
  alpha69, closed.
