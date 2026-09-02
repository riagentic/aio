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
- **alpha72 (2026-08-29) — the streak call is YOURS, and here are the facts.**
  Additive only, no compat break. But a randomized audit of alpha71 found
  defects that were IN alpha71, and the rule says a corruption-class bug found
  during an alpha resets the count. None of these is corruption-class — no data
  is lost or wrongly written — so by the letter of the rule the streak advances
  to 2. Two of them are availability-class, which is the closest call:
  - a boot that REFUSED (corrupt `state.db`) never exited: the caller got a
    clean error and a process that hangs forever
  - every `libraryMode` app lingered 5,054 ms after `app.close()` returned
  - `logging: false` silently stopped writing the action log and the crash
    checkpoint — the two artifacts that exist to explain a crash
  - nothing was ever compressed and `no-cache` could not revalidate (a 3x wire
    cost on every page load)
  - `visible: { include: ["rows.field"] }` dropped an EMPTY list from the
    client's view entirely — `state.rows.map(…)` on `undefined` in the one state
    every app starts in, and a delta the client then could not apply (it
    recovered by resyncing, so no data was wrong: correctness-of-view, not
    corruption)

  Say the word either way and the line above gets the number you decide.

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

## Measured: a one-row change costs O(WHOLE STATE), and it is not persistence

A field-report framing calls whole-slice arrays and coarse dirty tracking the
largest design debt, and names PERSISTENCE as the cost. Measured on this machine
(2026-09-01), changing one boolean in one row of an `items` array, median of 120
dispatches:

| rows   | dev defaults | diagnostics off | state core only | `kv.set` alone |
| ------ | ------------ | --------------- | --------------- | -------------- |
| 1,000  | 0.53 ms      | —               | 0.12 ms         | 0.05 ms        |
| 10,000 | 5.86 ms      | 2.16 ms         | 1.10 ms         | 0.49 ms        |
| 50,000 | 39.97 ms     | 17.48 ms        | 7.27 ms         | 3.87 ms        |

What the numbers say, and it is not what the framing says:

- **Persistence is not the cost.** `persist: true` vs `persist: false` is
  identical within noise (36.3 vs 35.6 ms at 50k). Finer-grained persistence
  would buy approximately nothing here.
- **Neither is the freeze.** `freezeState` on vs off is identical within noise,
  so Immer's deep freeze is not what scales.
- **The whole pipeline is O(state), not O(change)** — every layer of it, from
  the state core up.
- **About half of the dev cost is diagnostics** (`stateDiffs`, `timeTravel`,
  `checkpoint` are DEV_DEFAULTS and touch whole state). That half is absent in
  production, which also means a developer's feel for the cost is ~2x worse than
  what ships.

So the target for anyone picking this up is per-dispatch O(state) work in the
state core and the server path — NOT persist granularity. The practical boundary
today is around 10k rows: 2 ms of prod-side work per keystroke-driven change is
fine, 17 ms at 50k is not.

Numbers are from one machine and one shape (a flat array of small objects);
re-measure before designing against them.

## Known gap: the harness cannot cross a transport boundary

`CLAUDE.md` names this and says it is tracked here; it was not, which is how a
sentence became the only place it lived.

The in-process harness (`testUI` / `testCell` / `bootCells`) runs dev-strict, so
every tripwire fires in a test — but it never crosses a real transport, so a
structured-clone hop, a worker-pool round trip, and a client-context replay are
all invisible to it. Field reports keep landing here, and so did the hook-guard
false alarm in this release: every unit test of the validator passed while it
warned on every boot of every app, because the object the CALLER hands it is
what was wrong. A regression test written for that bug used `libraryMode: true`,
never reached the cells bridge, and stayed green with the bug reinstated.

The shape that would close it is the one this repo already trusts for sync/async
parity (`tests/proxy-differential.test.ts`): run the same scenario in-process
AND over loopback, then assert identical state and effects. Differential, not a
second set of hand-written expectations that can drift from the first.

**Started**: `tests/transport-differential.test.ts` does this for METHOD
PAYLOADS — the same call dispatched in-process and over a real WebSocket, with
the resulting state compared. It found and now pins two divergences the harness
had been accepting silently: `{ gone: undefined }` keeps its key in-process and
loses the KEY over the wire (so `"gone" in state` is true in a test and false in
a browser), and `-0` arrives as `0`. Both are JSON, neither is an aio defect,
and both are executable facts now rather than surprises.

The RETURN path is covered too, and it came out well: `serializeReturn` already
knew that `Map`/`Set`/`RegExp`/`Error` become `{}` and warns — in dev AND prod —
that "the caller receives a DIFFERENT value than the method returned". The test
pins the value AND the warning, because an unwarned `{}` is the bug and a warned
one is the design. That path is the model state was missing until this release.

Async methods are covered as well, both the value and the throw. The contract is
`_callId`: `aio-server.ts` says "an ASYNC method carries `_callId`; the executor
resolves that id with the method's RETURN value when it completes … SYNC/void
methods have no `_callId`; dispatch() already resolves with their value". A
socket caller that omits it gets the early reduce result and no correlation —
which is the contract, and which the first version of these tests mistook for
two serious defects.

Still to cover, in rough order of what has already bitten:

- ~~worker-cell parity~~ **DONE** — `tests/worker-parity.test.ts`. Two cells
  with identical config in one spawned app, one `worker: true` and one not,
  compared server-side across state, a `Date` payload (the hops differ:
  structuredClone vs JSON), sync returns, async returns, async throws, and a
  returned schedule effect. They agree on all six. Mutation-verified against the
  REAL historical bug: stop posting a worker's schedule effects home and it
  fails on `/parity/later` — so it catches the thing that actually happened, not
  a proxy for it.
- effects and their payloads — lower value than it looks: a reducer runs
  server-side whether the dispatch arrived over a socket or in-process, so the
  transport does not change them. The worker hop is where effects DO cross a
  boundary, which folds this into the item above.
- the client-context replay of a sync method — needs a browser client; parts are
  covered by `test:e2e`. Each is the same shape — run it both ways, compare, and
  pin a divergence that is genuinely JSON's rather than hide it.

Until then the standing rule is the cheap half of it: **a new validator is
proven by BOOTING an app, not only by unit tests.**

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
