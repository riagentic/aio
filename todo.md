# Road to 1.0.0-final

> **The desk is triaged, not clear.** Every reported finding is fixed with a
> test, refused in writing in `feedback/refused.md`, recorded as major-version
> material in `untracked/aio-v2.md`, or listed below as accepted-and-not-yet-
> built. The nine-report round of 2026-09-08 added the fourth pile: ~50 asks
> that are additive, agreed, and real work. Nothing is left unrouted.
>
> Shipped work lives in `CHANGELOG.md`; what was fixed or refused from field
> reports lives in `feedback/resolved.md` and `feedback/refused.md`.

**Core principle:** all breaking changes died in alpha70; from here the surface
is frozen — additive only, bugfix-only through beta; 1.0.0 = boring.

---

## RESUME HERE — round of 2026-09-17 (Windows builds, 1.0.3-beta)

**State.** 1.0.3-beta is prepared (version triple, CHANGELOG, upgrade guide,
`update:api`, `update:docs`, `check:release --fast` green). Not pushed.

**This round: Windows stops being rubbish.** A Windows desktop app opens on the
first double-click from either artifact on a machine with nothing installed, and
the one-file exe binds **zero TCP ports**. Verified on a real Windows 11 VM
(zip + self-contained exe, `ui mounted 7 element(s)`, no listening TCP port).

- Spawn: a `--no-terminal` GUI exe has no console, so inheriting stdout threw
  `Invalid handle`; retry with the std handles discarded (`electron-spawn.ts`).
- One Electron version per build (`installedElectronVersion` requires a real
  `dist/`; one `resolveElectronVersion` decider) and one platform per package
  (fresh staging + executable-format check) — the zip shipped 44.4.1 beside a
  43.0.0 exe, and both platforms in one 350 MB zip.
- Zero ports for the one-file exe: the embedded VFS `dist/` is served over the
  app socket instead of opening a loopback port (`resolveZeroPort`).
- The named pipe is drained (`FlushFileBuffers`) before `DisconnectNamedPipe`:
  real Windows DISCARDS unread buffered bytes on disconnect, so the first page
  request answered `read EPIPE` and the window failed to load. Wine never
  reproduced it.
- Built-in zip reader (`server/zip-extract.ts`); the exe carries Electron's own
  release zip and unpacks it through the same verified installer a download
  uses.
- The build stops embedding dev-only npm closure (esbuild/electron/happy-dom
  graph walk) and bakes `--client=…` from the target flags.

**The 2026-09-16 round is closed** (areas A–H committed at 2fb9ebe57).

Small follow-ups from the fixers:

- [ ] Android runtime (`src/standalone-air.ts`) lacks the serverUser /
      serverRequest / serverAuth / blocking stubs; stale comment atop
      `src/server/auth-context.ts`.
- [ ] Count the shutdown "database file is GONE" ERROR in `errors=`
      (`src/diagnostics/logger-core.ts` hook).
- [ ] `am check` is green with the `aio` import mapping removed
      (`src/server/graph-validator.ts`).
- [ ] The production dispatch loop does not log a self-call that runs after its
      caller threw (testCell does).
- [ ] `docs/clients/app-manager.md`: document `am dispatch --args=@file` / `-`.

Hunter reports with repro scripts: scratchpad `h1`–`h8` (session 26af1791…).
They are temporary; the findings are summarised above.

**Still open after that** (from the full triage of this file):

- [ ] Async read-your-writes overlay is quadratic (section below) — needs its
      own fixer; start from the fuzzer seed that broke the last attempt.
- [ ] Ratchet tightening left over: the silent-catch ceiling is at its exact
      count (330 blocks / 91 handlers); lower it as the remaining swallows in
      `src/state/blocking.ts:175` and `src/sync/browser-storage.ts:81` are
      justified or made loud. `tests/browser-server-only-stubs.test.ts:118` is
      still vacuous.
- [ ] Dev-only chunk — MEASURED 9.3 KB gz of dev-only code on the page, plus the
      `am trigger` engine (+2.4 KB gz) that production never runs. The ceiling
      was raised 83 → 86 on 2026-09-16 on that promise; build the chunk and
      lower it again.
- [ ] Sync-method browser-replay differential (known gap, bottom of file).
- [ ] Flaky-test remainder: `tests/am.test.ts`, `tests/spawn.test.ts` onto
      `stopChild` with stderr + exit code kept.
- [ ] Clear-out: move the DONE items below to `feedback/resolved.md`, the policy
      sections (beta gate, alpha70 decisions, standing policy, facts) to
      `.katana/` / docs, then delete them here; delete `feedback/cc.md`,
      `that report`, `that report` once each item is in resolved/refused (back
      them up first — `feedback/` is gitignored).
- [ ] Release 1.0.3-beta: surfaces are prepared (version triple, CHANGELOG,
      upgrade guide, `update:api`, `update:docs`, `check:release --fast` green).
      Remaining before a tag: the heavy `check:release` (`test:onboard`,
      `test:build`, mutation gate) and the push — only when asked.

**Answered, no work queued:** a one-file `deno run` build is feasible (measured:
2 MB, 560 KB gz) but today fails to boot — the SQLite worker file and the page
bundle are not inside it. GitHub releases exist: `deno task ship github`.

## Open work

### Two browser-bundle gaps left after report 9 (2026-09-13)

- `docs/auth/auth.md:357` imports `serverUser` into a cell module: that example
  still fails the browser build. A re-export cannot fix it (the module needs
  `node:async_hooks`); a browser `serverUser` that throws when called is a
  design decision.
- `blocking` is not on the browser bundle: `src/state/blocking.ts` has a
  module-level initializer esbuild cannot drop (+0.8 KB gz on every page). Make
  it lazy, then ship it.

### A size pass on the page (1.0.1-beta, 2026-09-13)

The page grew 71 → 81 KB gz across three hunt rounds (+26 KB minified, all
fixes; itemised in `tests/bundle-size.test.ts`). Measure message prose vs code
in the metafile, and move dev-only diagnostics to the dev-only chunk already
discussed below before raising the ceiling again.

### The read-your-writes overlay is QUADRATIC in an async method (measured, attempted, reverted)

`effectiveRoot()` (`src/state/cell-impl.ts`) memoises on
`(committed, pendingArray, pending.length)`, so EVERY write invalidates it and
the next read deep-clones committed state and replays the entire pending batch.
A loop that reads its own writes is therefore O(n²) in both time and allocation.
Measured on the identical body (`push`, then read `length`):

    N=  250   sync   4ms   async     76ms
    N=  500   sync   5ms   async    218ms
    N= 1000   sync   6ms   async    768ms
    N= 2000   sync  12ms   async  3,176ms
    N= 4000   sync  23ms   async 12,882ms

Sync is linear; async is quadratic. A bulk import or scan that reads its own
writes blocks the whole server loop for seconds, and the only diagnostic the
author gets is `BUDGET_EFFECT … hand CPU work to blocking("id", fn, arg)` —
advice about a cause that is not theirs. Rewriting the identical body as a sync
method is a 560× speedup nobody is told about.

ATTEMPTED and REVERTED: applying only the new tail of the batch to the memoised
root (same base, same array identity, count grew) takes the 4000-item case from
12,882ms to 82ms — and `tests/proxy-differential.test.ts` found a real
divergence at seed 1779560461, round 14: an `objarr_push` following a
`read_map_json` was missing from the async read. `applyMutations` is a plain
sequential loop and `batch.mutations` is only appended to within a batch, so the
equivalence LOOKS sound and is not; the reason was not found in the time
available, and this is the framework's most delicate file. The fuzzer is right
and the change is out.

Whoever picks this up: the win is real and large, the naive memo tweak is not
equivalent, and the fuzzer (with `arr_sort_counting` now in its op set) is the
instrument that will tell you. Start by finding what the full rebuild gives a
caller that a mutated-in-place root does not.

### Found in the post-beta audit (2026-09-12), verified, not yet fixed

Both reproduced; neither is a correctness bug in shipped behaviour, which is why
they are here rather than in the round's commits. The round's fixes are in
`git log v1.0.0-beta..`, and what would need a major version is in
`future/v2.md`.

- ~~**`uiNames(ui)` and the miss listing are two producers of one fact**~~ —
  **DONE (1.0.2-beta).** `collectElementPaths` is the one walker; miss
  `available:` lists the same element paths as `uiNames` / `am surface --names`
  (components stay as ordinal hints). Guard covers nested components.
- ~~**Two deciders for test scratch directories**~~ — **DONE.** `tempDir()`
  creates under `aioTestRoot()` (`AIO_TEST_ROOT` / `~/tmp/aio`); orphans sweep
  covers that tree.

### 1.0.1-beta — per-page head (proposed 2026-09-11)

aio is one process by design — no load balancer, no CDN, no static-site export;
"these things break simplicity and maintainability a lot" (user). With that
settled, the README's ❌ ("not for content sites, SEO") rests on ONE missing
primitive, and it is small:

- [x] **`useHead({ title, meta, link })`** from `aio/air` — shipped in
      1.0.0-beta (2026-09-12). Hoisted into `<head>` on SSR — AIR's render is
      sync, so one pass collects it before `renderToStream` writes the head, no
      second request — and swapped on route change on the client
      (`document.title`, the meta tags it owns). Today `ui.head` is one string
      for the whole app and there is no per-route primitive at all. New export,
      no reshape; a `testUI` case that reads the title after `navigate()`, and
      an SSR case that finds the article's title in `<head>`, not the body.
- After it, the README reads ✅ "simple yet powerful enough for any single web
  app or portal" and the ❌ is one clause: one process, by design.

### Accepted from the nine-report round (2026-09-08)

Nine field reports against alpha74–77. What was FIXED is in
`feedback/resolved.md`; what was refused, with reasons, is in
`feedback/refused.md`; what needs a major version is in `untracked/aio-v2.md`.
What follows is the rest: additive, agreed, not built yet. Ordered by what the
reports themselves said it cost them.

**The meta-finding, which several of these serve.** Three reports independently
withdrew a complaint after reading the source, and two named the same cause:
_"aio's features are consistently better than aio's discoverability."_ An agent
greps `am help` for a keyword, does not find its exact word, and composes
primitives it already knows — it will not browse. Two of the four withdrawn
complaints cost their authors nothing but embarrassment; the third cost four
hand-rolled parsers and a bug class they defended against by hand.

#### 1 · Discoverability (report 3 §7, report 9 §8.0/§9.7, report 7 §7, report 4 §10.1, report 6 §8) — ALL DONE 2026-09-08

The round's meta-finding: _"aio's features are consistently better than aio's
discoverability."_ An agent greps `am help` for its own word, does not find it,
and composes primitives it already knows — it will not browse. All six are done.

- ~~`am help` should carry INTENT words, not just names~~ — the help lines lead
  with ASSERT / TEST / verify for `expect` and GENERATE A TEST for `record`, so
  a grep for the intent finds the verb.
- ~~One `docs/AGENTS.md`, five lines~~ — written: five verbs, an "I want to…"
  table, and the loop that works, with the `--cdp` prerequisite named once.
- ~~A tip line in the `am status` footer~~ — every running app's status now ends
  with `am surface --path=App` · `am expect <path> eq <v>` · `am help` ·
  docs/AGENTS.md. Pretty mode only: `--json` is parsed by scripts, and prose in
  a data channel is noise. `am status` is the command everyone runs first and
  runs often, which makes it the one place a pointer is actually read.
- ~~`aio/ui` is missing from `docs/basics/api-reference.md`~~ — listed under
  Focused imports with the kit's own section. One report hand-rolled eight
  components and ~889 lines of CSS with the kit one import away.
- ~~A task-shaped doc index beside the domain-shaped one~~ — `docs/content.md`
  now opens with an "I want to…" table, curated in the GENERATOR (one home, so
  it cannot drift) and every target checked by `check:docs`, so a renamed page
  breaks the gate instead of rotting.
- ~~`docs/state/real-time.md` was found by accident, four levels down~~ — linked
  from `basics/concepts.md` and `state/README.md`, the two pages where the
  cadence decision is actually made.

#### 2 · `am`, the surface every report calls the best thing in the box

- ~~**`am restart` drops the argv the app was started with**~~ (report 4 §5,
  report 1 §22.4) — **DONE 2026-09-08.** Replay was all-or-nothing: ANY flag on
  the restart command line skipped the recorded launch entirely, so
  `am restart --force` — where `--force` steers the RESTART and says nothing
  about how the app boots — threw away `--cdp --port=8140`. Merging is per FLAG
  now: an explicit `--port=9000` overrides the recorded one and everything else
  is replayed, `am`'s own flags (`--force`, `--json`, `--wait`, …) are
  transparent to replay, and both the replayed and the OVERRIDDEN flags are
  reported — silently replacing a recorded flag is the same silence in the other
  direction. `mergeLaunchFlags` is pure and pinned by six cases.
- ~~**`am dispatch` has two argument shapes and the wrong one fails deep inside
  the app**~~ (report 3 §4) — **DONE 2026-09-08.** Both readings are legal —
  `--args` is the argument LIST, so `--args='["a","b"]'` passes two arguments
  and a method taking one array wants `--args='[["a","b"]]'` — so the CLI cannot
  refuse either. What it can do is stop the app's own message
  (`v.startsWith is not a function`, about a value the author never knowingly
  passed) from being the only thing said: a FAILED `--args` dispatch now carries
  one extra line offering the other reading, with the exact command line to
  type. Only on failure, only with `--args`, never on an empty list — a hint
  that fires every time buries the message it sits under.
- ~~**`am surface` has no geometry**~~ (report 6 §10.2) — **DONE 2026-09-11.**
  `am surface --rects` attaches `w x h @x,y` per element. The measurement was
  the easy half: `getBoundingClientRect()` answers everywhere and answers `0x0`
  with no layout engine behind it, which reads as a real measurement of a
  collapsed UI — the exact bug someone reaching for `--rects` is hunting. So the
  counts travel with the rects (`measurable` / `laidOut`), the server-side
  render REFUSES `--rects` instead of answering with zeroes, and a live client
  that measures all-zero exits 1 naming both readings. Found a gate defect on
  the way: `check:api` reported the four fields of one NEW OPTIONAL member as
  four REQUIRED additions — the frozen-surface gate calling the additive shape a
  break.
- ~~`am surface --names` / `ui.names()`~~ (report 6 §5a) — **DONE 2026-09-08.**
  `am surface --names` on a running app, `uiNames(ui)` in a test: full
  `Component…:Element` paths, the form `am trigger` takes. A test pins that the
  list AGREES with what a miss reports as `available:`, because two producers of
  one fact is how they come to disagree. Shipped as a free function, not a
  `ui.names()` member: `TestUI` is frozen, so a member could only be added as
  OPTIONAL and every caller would write `ui.names?.()` forever. One spelling, no
  `?.`.

- ~~**Gate defect found while doing the above**~~ — **DONE 2026-09-08.**
  `api-snapshot.ts` reported an added OPTIONAL member of a public type as
  BREAKING — the one change that provably breaks nobody, and which the file
  already has a rule for. Two causes, both in `objectMembers`: a typeLiteral's
  `methods` were never read (only `properties`, so a type written in method
  syntax had an empty member map), and an intersection's parts were looked for
  under `intersection`/`types` when `deno doc` puts every payload under `value`
  — so an intersection type read as having no members at all. With no member map
  `diffMembers` correctly refuses to guess and the blunt whole-symbol verdict
  applies. Dumped the real doc JSON rather than guessing the shape again;
  `TestUI` now carries a 17-member map, and the classifier is verified BOTH
  ways: adding an optional member reports `additive`, removing one still reports
  `BREAKING`. This mattered well beyond one item — §6 is largely optional config
  members on public types, and every one of them would have looked like a compat
  break.
- ~~`am logs --tag= --level= --since=` (+ `--follow`)~~ (report 7 §6, §8.8;
  report 4 §9.8) — **DONE 2026-09-08.** `--level=warn` means warn AND above,
  `--tag=cell` matches the NAMESPACE (so `cell:todo` and `cell:notes`, never
  `checkpoint`), `--since=` takes a duration or a timestamp. The unit is the
  EVENT, so an `ERROR` keeps its stack. `--follow` applies the same filters as
  the tail it continues — filtering differently there would answer one question
  two ways. An unparseable header passes every filter (dropping what cannot be
  classified is how a filter hides the line that mattered), and an unreadable
  `--since` is REFUSED, never ignored.
- ~~`am state --watch <path>`~~ (report 7 §6) — **DONE 2026-09-08.** A line per
  CHANGE, not per poll. `--wait=N` already re-read and re-printed every N
  seconds, which is a poll loop with nicer syntax — and both reports wrote
  `until` loops around `am state` anyway. Compared by VALUE (the state arrives
  freshly parsed each poll, so identity comparison would mean "changed" ==
  "polled"); the first reading prints too, because a change with no baseline is
  unreadable. `--wait=N` now sets the interval for both modes. Fixed while
  there: the path was `args[0]`, so `am state --watch todo.items` looked up a
  key called "--watch".
- ~~**`am start --instance=<name>`**~~ (report 6 §4) — **DONE 2026-09-08.** A
  private copy beside anyone else's: its own lock, data home, socket and logs.
  An agent's `am dispatch` used to land in the human's session and their clicks
  in the agent's measurements; `--takeover` steals the lock, it never gave an
  isolated one. NOT a new mechanism — `single-instance-lock.ts` already says
  "AIO_APPS_DIR relocates the apps' DATA root — the lock/socket dir scopes with
  it, so ONE env var isolates an instance completely." This is a name for that,
  bound before any command resolves a lock, so `am` and the child it starts land
  in the same private world without either knowing about the flag. An explicit
  `AIO_APPS_DIR` wins (the more specific instruction), and a path-shaped name is
  refused rather than turned into a directory.
- ~~`am shot --selector` (report 3 §11.7)~~ — **DONE 2026-09-11.** Crops to one
  element's box, MEASURED IN THE PAGE (`getBoundingClientRect`), so it survives
  a scroll or a transform; a selector matching nothing, or an element measuring
  `0x0`, is an error rather than a 1x1 image — the same "answered with zeroes"
  refusal `am surface --rects` already makes. The "restart with --cdp" half was
  already done: `noCdpMessage` names the client first and says what to type.
- ~~`am shot --check` / `--update` against a committed baseline (report 4
  §10.7)~~ — **DONE 2026-09-11.** aio had the three hard parts; this is the
  comparison, and the comparison is where the traps are. It compares PIXELS, not
  bytes (a re-encode is a different file and a gate that fails on an identical
  screenshot gets deleted), with a per-channel tolerance defaulting to 2 because
  antialiasing moves one or two. A MISSING baseline FAILS — the one case where
  "nothing to compare" and "nothing changed" look the same. A failure writes
  `<baseline>.actual.png`, and a size change is reported as a size change rather
  than as 100% of pixels. Needed a PNG reader (`src/am/png-compare.ts`, 8-bit
  non-interlaced, types 0/2/4/6, anything else refused by name); driven by the
  two REAL PNGs already in the repo — one from an external tool, one from aio's
  own encoder — plus an exact round-trip, because a fixture I encode myself only
  proves my decoder agrees with my encoder.
- ~~`am shot` must detect the stale-surface case rather than returning success
  with old pixels~~ (report 6 §2) — **DONE 2026-09-08.** It now waits for the
  window to COMMIT a frame (a double `requestAnimationFrame`, the browser's own
  definition of "something was painted since you asked") before capturing, and
  reports `painted: true|false`. An unconfirmed frame still writes the file — it
  is worth having — but carries a warning and a `! STALE RISK` line naming the
  cause (a hidden, minimised or occluded window is not composited) and the two
  remedies. The caveat is in `docs/clients/electron.md` and the `am shot` docs.
  Mutation-checked: hard-code `painted = true` and the test fails.
- ~~`am instances` should print the DATA path beside each row~~ (report 1 §20) —
  **DONE 2026-09-08.** The lock now records `dataDir`; `--json` reports it on
  every row (`null` for a lock written before 1.0.0-beta — a field that appears
  conditionally is one a script has to guess about), and `--long` shows a `DATA`
  column when it DIFFERS from `home`, since a column repeating the obvious is
  noise. The three spellings are tabulated in the docs, because the trap is that
  `AIO_APPS_DIR` _appears_ to work: it moves the lock and the discovery files,
  so `am` follows the app, while an `appDir` set in code leaves the database
  where it was.
- ~~`am restart <appId>` refuses an app id that is also not a component name~~
  (report 3 §5) — **DONE 2026-09-08.** The positional was read ONLY as a
  component label, so an id typed straight out of `am instances` was refused
  with "this project declares no components, so it names nothing" — true about
  components and useless about the thing the user was holding. A positional
  naming a RUNNING instance now resolves to `--app`, at every `processPlan` call
  site (start, stop, restart, watch): a plan that resolves while the command
  acts on the wrong app would be worse than the refusal it replaced. A DECLARED
  component still wins, because in a repo that declares one the label is that
  component's name by definition — otherwise what a command means would depend
  on what happens to be running. The refusal, when it stands, now points at
  `am instances`.
- ~~`am heap <app>`~~ (report 2 §9.4) — **DONE 2026-09-08.** `am state` says
  what an app SERVES; nothing said what it HOLDS. A new trojan route reports
  heapUsed against the real V8 ceiling (`heap_size_limit`, not the lazily
  allocated `heapTotal`, which always sits just above heapUsed and always looks
  reassuring), RSS, external, and per-cell serialized size sorted biggest first.
  The percentage is `null` when the runtime cannot say — a hard-coded 0 reads as
  "plenty of room". The output states that cell state is serialized SIZE, not
  retained heap, so "my cells are small, so the leak is aio's" has to be
  reasoned to rather than assumed.
- ~~`am add server <name>` scaffolding the module AND its line in `app.ts`~~ —
  **DONE 2026-09-11.** Writes `src/server/<name>.server.ts` (the `.server.ts`
  name is the convention aio enforces, so a generator producing `<name>.ts`
  would put the keys in the browser bundle) AND adds the import that registers
  it. The wiring is the half that matters: a `serverFns` namespace nobody
  imports is registered NOWHERE, so calling it fails at runtime with "unknown
  namespace" while the author has a file that looks finished. No app entry is
  SAID (`wired: null`), never silently skipped; idempotent on a second run.
  (report 3 §12.6).
- ~~`am preview <Component> --props=` (report 3 §12.5)~~ — **DONE 2026-09-11.**
  `am preview src/Card.tsx --export=Card --props='{"title":"Inbox"}'` renders
  one component in a state you choose, with the app not running, and prints the
  same `Component:Element` paths `am trigger` takes — so what you read is what
  you would address. It reuses `renderHeadlessSurface` (the path `am surface`
  and `am testgen` already use) with an export name and props threaded through;
  a second renderer would be answering a question about itself. `--props` is
  refused unless it is a JSON OBJECT: a number spreads into nothing, and a
  component rendering with every prop `undefined` looks exactly like the bug
  someone is hunting. A component that renders nothing addressable says so
  rather than printing an empty screen that could mean either thing.
- ~~`am migrations` — a way to SEE the version chain~~ (report 5 §8.9) —
  **ALREADY DONE**, verified 2026-09-08: `am migrations` reports declared vs
  stored versions per cell, what the last boot's migration pass did, and any
  unaccounted shape drift. Listed in `am help`. The report predates it.
- ~~**`useResource({ key, open, close })`** (report 7 §2, §8.5)~~ — **DONE
  2026-09-11.** All three of the report's own bugs are refused by construction,
  and each has its own test: ONE OPEN PER KEY, reference-counted (so three
  holders open once and close when the last lets go — which is also report 4
  §10.4's "three components fire three identical requests, and there is no key
  to dedup on"); a STALE OPEN cannot install itself over a newer one, because
  every open carries a generation and a late one closes what it made rather than
  leaking it — that is the `alive(s)` guard at twenty call sites, deleted; and
  the CLOSE is attached to the open that made it, so changing the key closes
  before opening and two pipelines never fight over one device. `scope` keeps
  two unrelated resources that share an id apart, a number key and a string key
  are different resources, and a `close` that throws still releases the slot — a
  slot nobody can release is the leak the whole module prevents.
- ~~**A client-side reaction** — `onChange(selector, fn)` (report 7 §5, §8.4)~~
  — **DONE 2026-09-11.** Not tied to a component, so a change from anywhere —
  `am dispatch` included — reaches it. Three things it does that a bare `effect`
  does not, all of which the report would have hit: only the SELECTOR is tracked
  (so a reaction that reads state while working does not subscribe to it and
  re-run forever), it WAITS for a change (an effect runs immediately, so "when
  the camera id changes, reopen it" would open one on boot), and the returned
  cleanup runs BEFORE the next change, so close-then-open is one function rather
  than two rules that have to agree. Typed as a union of two signatures rather
  than `=> void | Dispose`: TypeScript forgives a non-void return one signature
  at a time, so the single-type spelling rejects
  `onChange(sel, v => list.push(v))`.
- ~~**An error boundary** (report 1 §22.1)~~ — **DONE 2026-09-11.**
  `<ErrorBoundary>` existed and `docs/ui/air-lifecycle.md` already promised it
  caught "initial render, signal-triggered re-render, and lazy component
  rejection". Two of the three were true: a throw in a component's OWN
  signal-triggered re-render kept the last good output (AIO-138) and the subtree
  quietly stopped updating, which is the wallet's blank window wearing the old
  screen's face. The failing component now renders the boundary's FALLBACK by
  re-entering its own render path — one renderer, not two. The failed render's
  signal deps are carried into the fallback's subscriptions (a fallback reads no
  signals, so without that the fallback is PERMANENT), and a fallback that
  itself throws degrades to AIO-138 instead of looping. With no boundary above,
  AIO-138 is unchanged and newly pinned.
- ~~**A dev-time error overlay** (report 3 §12.4, report 7 §8.7)~~ — **DONE
  2026-09-11.** The seam had existed since alpha52 and nothing filled it:
  `_deliverDiag` calls `window._aioDiag` with a comment saying "overlay when the
  page has one, console otherwise", and only the console branch ever ran "since
  nothing injects it". `src/browser/dev-overlay.ts` is the injection — plain
  DOM, no AIR (the renderer is one of the things that breaks, and an overlay
  needing a working renderer to report a broken one reports nothing), dev-only
  and observe-only. It COUNTS: the per-frame failure that motivated it is one
  problem, and two thousand rows of it is the same silence in a different font.
  Bounded at 20 so a misbehaving page does not also leak, `pointer-events: none`
  everywhere it is not a control, and it CHAINS an app's own `_aioDiag` rather
  than replacing it. Found while testing: `protocol-diagnostics` captures its
  window at MODULE LOAD, so the seam cannot be driven end-to-end from a Deno
  test — noted in the test rather than worked around.
- ~~**Source maps** (report 5 §8.2)~~ — **DONE 2026-09-11.** Not a missing
  esbuild flag: NO browser applies a source map to the string form of
  `Error.stack` (devtools maps frames for display only), so turning esbuild's
  flag on would have changed nothing in `client.log`. The SERVER applies it, in
  the one place that renders the text. The build writes `dist/.app.js.map` —
  dot-prefixed because `.map` is in `SHELL_EXT` and `dist/app.js.map` would have
  served the app's whole source over an unauthenticated read — and
  `client-log.ts` remaps every forwarded position before writing it. Pure VLQ
  decoder in `diagnostics/sourcemap.ts`, driven by a REAL esbuild map (a fixture
  I encode myself only proves my decoder agrees with my encoder). Found the trap
  on the way: THREE surfaces have to agree (bundle write · `dist/` staging
  allowlist · server read) and the first version silently failed at the second —
  the allowlist in `build.ts` deleted the map before `deno compile` saw it. One
  `BUNDLE_MAP` constant, one named `keepInDistStaging` predicate, and the build
  now REPORTS the staged map like every other artifact.
- ~~**The renderer console keeps the interceptor's call site** (report 7 §8.6)~~
  — **DONE (already shipped).** `_callSite()` in `browser/console-intercept.ts`
  walks past this file's own frames and attaches the caller's location; the
  forwarded entry carries it as `source`. As of the source-map work above that
  location is also REMAPPED, so it names the author's file rather than a
  position in the bundle.

#### 4 · Build products that go stale in silence

- ~~**A browser `Worker` entry is not in the renderer build graph**~~ (report 7
  §1) — **PARTLY DONE 2026-09-08: the silence is closed.** The graph validator
  now reports `new Worker(new URL("./x.ts", import.meta.url))` in a
  client-reachable module as `unmanaged-worker` — a warning, not a block, since
  the worker genuinely runs — and the fix text names the CONSEQUENCE ("editing
  it may appear to do NOTHING: the app keeps running the previous build") plus
  the three things to do about it. A remote/blob URL is not reported: nothing
  local goes stale, and a warning nobody can act on is how a real one gets
  ignored. Still open, and now merely a feature rather than a trap: bundling app
  workers for real (a `workers:` list, or following the constructor).
- ~~**Hot reload does not cover server-side dynamic imports** (report 4 §6)~~ —
  **DONE 2026-09-11**, by the better of the two routes the report offered: the
  warning fires on the RELOAD EVENT and names the changed file, because that is
  the moment the question is being asked. It says why (the module registry hands
  back the copy it already has), states the mismatch outright ("the browser
  reloaded; this file did not" — which is the sentence that would have stopped
  the author re-reading correct code), what to do, and `am where` for any other
  file. Once per file per session, `.server.tsx` as well as `.server.ts`, and an
  ordinary module says nothing — a warning that fires on every save is how a
  real one gets ignored.
- ~~**`*.server.ts` modules must be hand-registered in `app.ts`**~~ (report 3
  §3, report 8 §13) — **DONE 2026-09-08.** Every `*.server.ts` / `*.server.tsx`
  is now auto-embedded by `assetIncludes`, the same zero-config walk `.wasm`
  already got: the naming convention IS the registration. MEASURED first,
  because the reported shape did not reproduce as stated — on Deno 2.9, running
  from a foreign cwd with sources deleted, a literal `import("./io.server.ts")`
  and a template ``import(`./${n}.server.ts`)`` are both analysed and embedded;
  only an OPAQUE specifier (a variable, what a registry or plugin loader writes)
  is missed, and that binary dies at the call. That is the shape the reports
  hit, and the rule that guarded it was a comment enforced by nothing.
- ~~**Dev does not watch `dep/aio`** when it is a symlink into a working tree
  (report 2 §9.6)~~ — **DONE 2026-09-11.** Two facts made it invisible: the
  checkout is not under `absBaseDir`, and `Deno.watchFs` does not follow
  symlinks anyway. The watcher now also watches the framework's `src/`, derived
  from the IMPORT MAP rather than by looking for `dep/aio` — the import map is
  what actually decides where `aio` comes from, so any path pin gets it and a
  `jsr:`/`npm:` pin correctly gets nothing (no working tree, and handles spent
  on a read-only cache are handles spent on nothing). The REAL path, because
  that is what the watcher's events carry. `src/` only: the checkout also holds
  `.git`, `node_modules` and a `dist/` a build rewrites constantly, and a
  watcher over those is a reload storm. An explicit `watch: [...]` is left alone
  — an app that narrowed the watcher because its boot reloads gigabytes has said
  what it wants watched.

#### 5 · Composition inside a cell

- ~~**A cell method cannot call a sibling**~~ (report 8 §6, §9; report 3 §6) —
  **DONE 2026-09-11.** `s.$call.bench(kind)`: the sibling's body runs against
  the CALLER's draft, in the caller's commit. One action, one draft, one
  publish, where `myCell.bench()` would have been three of each. Served on every
  draft, sync and async (the parity contract). Refuses by name: an async sibling
  from a sync method (no way to await it, and a floating promise would write
  after the commit), an unknown name (with what IS available), and a cycle after
  32 nested calls — `$call` runs the body inline, so `a → b → a` recurses rather
  than queueing. **The types had to be found, not assumed.** `check:api` refused
  the first shape: adding `$call` to `MethodDraftMeta` breaks anyone who
  CONSTRUCTS one, and a second type parameter is refused on principle. The
  additive shape is a separate opt-in `MethodDraftCalls<C>` — exactly what
  `Partial<MethodDraftMeta>` is for `$signal`. Its default is `any` rather than
  a mapped index signature, because under `noUncheckedIndexedAccess` (which aio
  itself sets) the obvious spelling forces `s.$call.bench!(…)` on everyone; and
  the precise form is an interface, not `typeof methods`, which is circular
  inside the literal the methods live in.
- ~~**The workaround escapes `aiol`**~~ (report 8 §7) — **DONE 2026-09-11.**
  `$call` removes the reason to move a body out of the cell, and `$call` itself
  joins `DRAFT_META` so the documented way to compose is not reported as the
  post-await hazard it replaces. The test pins the exemption AND that a genuine
  read is still reported, so the silence means "exempt" and not "the analyser
  stopped working".

#### 6 · Declared policy instead of per-app invention

- ~~**`s.$append("partial", chunk)`**~~ (report 8 §12) — **DONE, and better than
  asked.** The `append` WIRE OP exists (protocol v3) and `narrowPatches` emits
  it automatically at patch generation: a grown string travels as its SUFFIX, a
  grown array as its adds. Nothing to call, so every method that already does
  `s.partial += chunk` gets it — including the ones written before the op
  existed. Verified 2026-09-11 and pinned as the report's own MEASUREMENT rather
  than the op name: `tests/streaming-append-broadcast.test.ts` compares narrowed
  against raw bytes over 40 chunks and asserts the per-chunk cost does not scale
  with the reply. A string under `APPEND_MIN_LENGTH` deliberately stays a
  `replace`, and that silence is asserted too.
- ~~**`$pending`**~~ (report 8 §14, report 9 §9.5) — **DONE 2026-09-11.**
  Spelled `cell.$pending("scan")` (reactive, so a component re-renders) rather
  than `s.$pending` — the consumer is the UI, not the method. A COUNT, never a
  flag, which is the bug cc shipped. NOT state: never broadcast, persisted,
  migrated, or in the cell's shape. The count was already being kept on both
  sides — `trackCall` on the server, the ack registry in a client — and simply
  never exposed; the counter lives in `protocol/` (dependency-free, the folder
  both may import) with the signal wrapper in `state/`. Reading returns the LIVE
  count while subscribing through the signal, because `signal.set` is scheduled
  and returning `.value` reported one update behind — two overlapping calls read
  as one, the exact bug a count exists to avoid.
- ~~**`concurrency: "first" | "newest" | "queue"` and `ttl:`**~~ (report 8 §15)
  — **DONE 2026-09-11.** `"newest"` IS `cancelOn: "self"` and folds into that
  map at `cell()` time, so there is one mechanism rather than two that can
  disagree — declaring both is refused. `"first"` resolves the second caller
  with the RUNNING call's result, which is the difference between a policy and
  the silent drop that report shipped. `"queue"` reuses the transactional
  serialize chaining, per method. `ttl` caches only SUCCESSES and is keyed by
  the arguments, so `fetchUser(1)` never answers `fetchUser(2)`. Both keys are
  validated at `cell()`: an unknown name, and a SYNC method (which can never
  overlap itself, so the policy would silently do nothing). My own test caught
  the one real bug: a function inside an array serializes as `null`, so
  `scan(fnA)` and `scan(fnB)` would have shared a cache key.
- ~~**An optional per-method argument schema**~~ (report 9 §9.6, report 3 §12.7)
  — **DONE 2026-09-11.** `args: { setAge: [z.coerce.number().min(0)] }`.
  STANDARD SCHEMA, not a DSL of aio's own — Zod, Valibot and ArkType all
  implement it, so it is the app's existing validator doing the job it already
  does; an app with none can pass a plain predicate. Checked in `methodArgs`,
  the ONE place both method kinds pass through, so `am dispatch`, a form, a URL
  and an agent are guarded identically. It COERCES as well as refuses — the
  parsed value is what the method receives, which is the dozen hand-written
  coercions deleted. Failures name cell, method and POSITION. An ASYNC schema is
  refused by name: the dispatch path is synchronous for a sync method, and a
  schema that silently did not run is worse than none.
- ~~**`onPersist(state)`**~~ (report 9 §8.4) — **DONE 2026-09-11.** `persist`
  FILTERS; `onPersist` SHAPES. It receives the slice after include/exclude and
  returns what is written, and pairs by NAME with `onRestore` — a shape that
  only drops fields needs no partner, one that reshapes needs an `onRestore`
  that knows it. NOT error-guarded, unlike the observe-only hooks: it runs on
  the persist path, where "the write quietly stopped happening" is the worst
  outcome there is, so a throw is reported as a failed WRITE, names the cell and
  turns `/health` degraded. Refused on a `sync: true` cell, same rule as a
  filter. The report's other spelling — `persist: { transform }` — was built
  first and `check:api` refused it: widening `persist` breaks anyone who assigns
  it to a `CellFieldFilter`. `onPersist` adds a key and moves nothing, and is
  the better shape anyway.
- ~~**A `budgets` block**~~ (report 2 §9.3) — **DONE 2026-09-11.**
  `aio.run({ budgets: { cellState: "1MB", broadcastRate: "20/s", payload:
  "500KB" } })`.
  NOT a second mechanism: every limit already existed and was reachable (a
  hard-coded 1 MiB in the broadcaster, `vitals.pressure`'s two thresholds) —
  this is one obvious door onto them in human units, which is the round's own
  meta-finding again. An explicit `vitals.pressure` still wins. They FAIL rather
  than only warn: `/health` carries the verdict and a breach turns the app
  `degraded`, so `am health` is a CI step. The ledger keeps the WORST reading —
  "it went over once" is the fact. An app that declared none gets no field at
  all, never a green tick. An unreadable value throws at boot, naming the key.
  Measured on the broadcast path AND on demand at `/health`, because an app with
  no client connected would otherwise report a budget it had never once
  measured.
- ~~**`aio/server-only` and `aio/client-only` marker modules**~~ (report 2 §9.1)
  — **DONE 2026-09-11.** The `*.server.ts` convention works and has one hole: it
  is a FILENAME, and you cannot always rename a file twenty places import, that
  is generated, or that is published under that name. `import "aio/server-only"`
  is the same statement made IN the file; the audit treats the two identically,
  so dev boot and `deno task build` cannot disagree (they already share one
  decider). It also throws if ever evaluated in a browser — unreachable in
  practice, and there for the paths a build cannot see. The two halves are
  deliberately NOT symmetric, because the failures are not: a server module in
  the browser LEAKS (refused at build, throws at runtime); a browser module on
  the server BREAKS, loudly, escaping nothing — so `aio/client-only` has no
  runtime guard and would break SSR if it did. `aiol` refuses a CELL that
  imports it, since a cell method runs on the server.

#### 7 · Test-harness reach

- ~~**A stubbing tier between `testCell` and `bootCells`**~~ (report 9 §8.6,
  §9.3) — **DONE 2026-09-11.**
  `bootCells(cells, { stub: { "./claude.server.ts": … } })` — exactly the
  spelling the report asked for. NOTHING can intercept a raw `await import(…)`
  in Deno (there is no loader hook a test process can install after the fact),
  so the seam is a function the cell calls on purpose:
  `serverImport(spec, import.meta.url)`. That price is stated rather than hidden
  behind a stub that silently does not apply. Unstubbed it IS the import it
  replaces — specifier resolved against the caller, module still out of the
  browser bundle (the audit reads the specifier, not the spelling). Keyed by the
  specifier AS WRITTEN, so a test stubs the string it can see; a specifier
  nobody stubbed still loads for real, because the map is not a whitelist.
- ~~**`testUI`'s window is not `globalThis`**~~ (report 1 §19.2) — **DONE
  2026-09-08.** The false green was already closed (testUI THROWS on a
  bare-global DOM listener); what remained was the ceremony. `onWindowEvent` now
  resolves the component's OWN window — correct in a browser, in an Electron
  child window, in a `<webview>` and under the harness — and removes the
  listener on unmount. Making the bare global work was considered and refused:
  aio mounts into more than one window, so `globalThis` is genuinely the wrong
  target, and a harness that accepted it would be lying. See
  `feedback/refused.md`.
- ~~**Geometry in tests**~~ (report 1 §19.1, §22.2; report 6 §10.1) — **DONE
  2026-09-11**, by the narrow shape the report itself said "would close most of
  it", and without a second runner. `uiRects(roots)` keys real rects by the same
  `Component…:Element` paths everything else uses, fed by a surface a REAL
  client measured (`testServer` + `testBrowser` + `surface/N?rects=1`, or
  `am surface --rects`). It deliberately does NOT read the harness's DOM: under
  happy-dom that answers 0×0 and makes a layout assertion PASS, which is how
  those two defects hid behind 1546 green tests. An unmeasured element is ABSENT
  rather than reported at the origin — a missing key fails loudly, a plausible
  zero does not. NOT DONE, and deliberately not claimed: the full
  `engine: "browser"` runner mirroring the whole `testUI` API. The parts exist
  (`testBrowser`, the trojan surface, `--rects`) and the recipe is documented; a
  second runner is its own piece of work and doing it badly would be worse than
  the recipe.
- ~~**`waitFor` failure dumped the whole tree**~~ (report 9 §9.0) — **DONE
  2026-09-11.** The JSON half of `surfaceDigest` was capped and the component
  TREE was not, so a wide app turned one timeout into 31 769 characters. Now
  bounded by the same `NAME_LIMIT` every other name list uses, with the same
  `AIO_TEST_NAMES=all` escape — two spellings of "how much do we print" is how
  they come to disagree. Tested on a 200-row app: under 4 kB, still shows the
  tree, says how many are hidden, and the escape really prints all of it.
- ~~**`t=` is a handle, not an attribute**~~ (report 1 §19.3) — **DONE
  2026-09-11.** A callout in `docs/testing/ui-testing.md` beside the naming
  table: it is stripped from the DOM, so it is absent from `ui.html()` and
  `[t="save"]` matches nothing in a test OR in the app; address it by name, or
  use `data-testid` when you genuinely need an attribute in the markup.
- ~~**Typed test locators**~~ (report 8 §11, §18) — **DONE 2026-09-11**, as
  `am testgen`. The GENERATOR already existed and already answered the ask — and
  types the RENDER rather than the source, which is strictly better: a `t=` prop
  inside a branch that never renders is not a locator anyone can use. What was
  missing was a way to run it without hand-writing a script (happy-dom, a
  document, the App, the cells, and remembering to re-run), which is why an app
  that HAD the feature kept using string keys. One command, default
  `tests/ui.gen.ts`, loud when there is no UI entry. Needed a deliberate
  boundary widening (`am → testing` for the generator, `am → air` type-only);
  the laundering check caught the attempt to sneak it through a root entry.
- ~~**Mount-time rehydration is racy and silent** (report 8 §11)~~ — **DONE
  2026-09-11.** `testUI` now settles ONCE before handing the UI over, so the
  first observation is always of a mounted, quiesced app. A rule enforced by
  remembering to write `await ui.settle()` is not enforced. What the measurement
  actually showed, and why the test looks the way it does: the race was masked.
  A synchronous `onMount` dispatch lands before the test body either way, and so
  do 0ms, 25ms, 100ms and 200ms rehydrations — the mount path already spans that
  long on its dynamic imports. Every test I wrote on those passed BOTH ways and
  asserted nothing. At 400ms it discriminates: red without the settle, green
  with it. That incidental window IS the defect, restated: a guarantee that
  holds because the harness happens to be slow enough is one any refactor can
  take away in silence. The wait is now on purpose and bounded by `settle`'s own
  budget; non-strict, so a mount that never quiesces is reported by the first
  real observation rather than as a mount failure naming the harness.
- ~~**A trace artifact on failure**~~ (report 2 §9.5) — **DONE 2026-09-11.**
  Every miss and every `waitFor` timeout writes `.aio/traces/ui-<ts>-<id>.json`
  and NAMES it in the error: the calls this test made in order (arguments
  summarised — a trace that inlines a 2 MB payload is one nobody opens, and a
  secret does not belong in a file the test leaves behind), the surface, the
  HTML and each cell's state. Written SYNCHRONOUSLY, because `fail()` throws and
  there is nothing to await it — an async write would be reported by the leak
  sanitizers against whoever ran next, which is the class this repo has already
  spent two suite runs on. Bounded at 20: an unbounded artifact directory is one
  nobody ever cleans. A trace that cannot be written leaves the assertion's own
  error untouched.

#### 8 · Styling and the shell

- ~~**`theme: "base"`** (report 5 §4)~~ — **DONE 2026-09-11**, as
  `ui.layout:
  false` rather than a fifth `theme` value. `UiTheme` is frozen
  public surface and `check:api` refused the widening — and the additive shape
  is the better design: "how much look" and "does it place my boxes" are
  separate questions, so the switch composes with every `theme` answer
  (`theme:"full", layout:false` = controls without layout, always;
  `theme:"auto", layout:false` = the same until you ship CSS). Kept: canvas,
  dark mode, type, every form control, focus rings, tables, code, `::selection`,
  and the three environments. Dropped: the `<main>` page container with its
  header/footer alignment, and the six classes. Sliced from the ONE stylesheet
  by banner, exactly as `appThemeTokensCss` is, so a third variant cannot drift
  into a third palette — and a missing banner REFUSES rather than guessing,
  because both wrong answers are invisible. Setting it on `"tokens"`/`"none"`
  warns instead of doing nothing.
- ~~**Scoped styles** (report 3 §12.1, report 4 §10.3, report 5 §8.5)~~ — **DONE
  2026-09-11, both halves.** The worst UI bug of one build: a `class="track"`
  collision silently clipped every music row to one line, with no error, a
  correct DOM and a correct component tree.
  - ~~the LINT half~~ — **DONE 2026-09-11.** `checkStyles` in `aiol` reports a
    class defined in two places that disagree about the SAME PROPERTY, naming
    both sites and both values. Narrow on purpose, because a rule people silence
    takes its true positives with it: agreement, complementary properties, a
    more specific selector (`.track:hover`, `.list .track`), the same class
    inside `@media`, and custom properties are all left alone, and a generated
    stylesheet (`/*!` — Tailwind's output) is skipped entirely.
    `topLevelClassRules` / `collidingClasses` are pure and tested on their own;
    verified end to end by planting the reported bug in a real scaffolded app
    and watching the linter name it.
  - ~~Opt-in hashed classes are the fuller answer~~ — **DONE 2026-09-11.**
    `css\`…\``from`aio/ui`returns a class named after a HASH of the rule, so
    two components cannot collide however they name things — and two writing
    the identical rule share one class rather than shipping it twice.
    Content-addressed rather than counted, because a counter depends on module
    evaluation ORDER and a server-rendered page would hydrate against names the
    client numbered differently — wrong in exactly the way nobody looks for. No
    build step (a scoping scheme needing a bundler plugin does not work in`deno
    task
    dev`, which serves modules untouched, and would be a dev/prod
    divergence in the part of an app people judge by looking at it), and
    unlayered so it beats the generated theme without`!important`.`&`works, including inside an at-rule;`collectCss()`is for`renderToString`. My own tests caught two real parser bugs: a nested block
    swallowed everything after it, and leading declarations were absorbed into
    the next block's SELECTOR (`color:
    red; .c:hover{…}` — which no browser applies and nothing reports).
- ~~**A `<Browser>` component and `docs/clients/webview.md`** (report 5 §2)~~ —
  **DONE 2026-09-11.** Both traps closed in the component rather than described
  in a doc: `src` is applied IMPERATIVELY and only when it changed, so the
  `onNavigate` → state → `src` cycle that looks obviously wrong is exactly what
  an author is supposed to write; and `keepAlive="id"` PARKS the guest in a
  hidden holder on unmount instead of letting Electron destroy it with the
  page's scroll, forms and login. It renders a plain `<webview>`, so the whole
  Electron API stays true and reachable through `ref` — a wrapper that hid it
  would be a second, worse API. `docs/clients/webview.md` says the
  `childWindows` gate out loud (it was documented in exactly one place: a source
  comment) and covers `partition` and what the guest cannot reach.
- ~~**A CSP that can drop `base-uri`, and a nonce for the inline shell** (report
  5 §3, report 1 §11)~~ — **DONE 2026-09-11.** `security.cspDirectives`
  overrides or REMOVES one directive of the computed policy
  (`{"base-uri": false}`), which is the point: writing a verbatim policy to lose
  one directive meant re-deriving `frame-ancestors` from `allowedOrigins` by
  hand and keeping it in sync forever. Ignored for a verbatim policy — two ways
  to say one thing with one of them silent is the shape this repo refuses — and
  an empty result sends no header rather than `""`. `security.cspNonce` mints a
  nonce PER RESPONSE (a reused one is a replayable one) and `"strict"` then
  sends `script-src 'self' 'nonce-…'` instead of the waiver. Stamped by ONE rule
  applied to the finished shell rather than threaded through the six places it
  writes a `<script>`: a missed tag is not a degraded page, it is a blank one,
  and the test counts tags rather than checking the ones I remembered. Styles
  deliberately keep `'unsafe-inline'` — that directive also governs the `style=`
  ATTRIBUTE, which `style={{…}}` produces on ordinary components.
- ~~**Standard Schema in `useForm`** (report 4 §10.6, report 5 §8.7)~~ — **DONE
  2026-09-11.** `useForm(config, { schema })`, reusing the `isStandardSchema`
  the cell `validate` hook already had, so it really did pay off twice and still
  costs no dependency. ONE schema for the form, not one per field — that is the
  shape apps actually hold (`z.object({…})` already exists somewhere) — with
  issues attributed to fields by `path`, reading BOTH spellings (Zod emits bare
  keys, Valibot emits `{ key }` wrappers; reading one would put every issue from
  the other library on the form and look like the schema half-working). An issue
  that names no field becomes `form.formError` rather than being dropped, which
  is how a form refuses to submit while every field looks fine. `rules`
  untouched and still the more specific statement. Async refused by name. Two
  shapes the freeze forced, both better: `schema` went on `FormOptions` (param0
  is frozen), and coercion went on a separate `parsed()` instead of into
  `values()` — `values(): T` is inferred from each field's `initial`, so
  coercing there would make the signature say `string` for a value that is a
  number. Exported `FormOptions`/`CrossFieldValidator`/`AsyncValidationRule`
  while there: `useForm`'s own option type was reachable only structurally.
- ~~**`resource()` keys, dedup and invalidation** (report 4 §10.4)~~ — **DONE
  2026-09-11, through `useResource` rather than by keying `resource()`.** A
  `key` option on `resource()` would have been an added optional parameter,
  which the freeze refuses by name — and the new door is the better answer
  anyway: `useResource({ key, open, close })` dedups by key with reference
  counting, which is what "three components, one request" actually needs, and it
  invalidates by changing the key. `resource()` is untouched.
- ~~**More templates** (report 6 §10.6)~~ — **DONE 2026-09-11** for
  `--template=canvas` and `--template=assets`; `desktop-panels` REFUSED for now
  (see below). Each encodes the knowledge another report produced: `canvas` is
  the shape that makes a canvas app testable — a pure `step()` the scaffolded
  test drives with no GPU, and an imperative shell with no branches left in it
  (report 6 §6) — and `assets` ships the deno.json mount AND the directory
  together, because either alone is a 404 and one of them looks like a build
  problem (report 6 §7). The per-file ternary chain became a function on the
  way: it held exactly two templates, could not hold a third without every line
  growing a branch, and the branches had already drifted (the UI's had a `css`
  case the entry's did not). Found while doing it: `denoJson()` was passed a
  hardcoded `"counter"`, so every template's tasks were the counter's —
  invisible because the two templates that existed agreed. And a gate the parse
  check could not give: every template is now TYPE-CHECKED against the
  framework, in a real project with a real link. A `ref` callback with the wrong
  parameter type shipped in the canvas template and was found by scaffolding one
  by hand, which is not a gate. Verified red by breaking a return type on
  purpose. `desktop-panels` is not scaffolded: unlike the other two it encodes
  no specific finding from a report, and a template nobody can describe the
  purpose of is a maintenance cost with no lesson in it.
- ~~**`aio.run({ assets: { "/x": "./assets/x" } })`** (report 6 §7, §10.5)~~ —
  **DONE 2026-09-11.** The twenty lines, once. It is `serveDirs`' machinery
  without the `prod ? undefined` and with the build half attached, because the
  two answer different questions: `serveDirs` exists so the DEV server can
  resolve a MODULE outside baseDir (prod bundles follow the import themselves)
  and is dev-only on purpose; `assets` is DATA, which production needs exactly
  as much as dev does. Route, MIME, caching, range and every baseDir guard come
  free from the static path — an extra root is never a weaker root, and that is
  asserted through the REAL handler, not just the predicate. The
  `compile.include` half is zero-config: declared in deno.json, `assetIncludes`
  embeds the directory, so there is no second place to keep in sync and a mount
  pointing outside the project is REFUSED at build time rather than dropped.
  Pre-compression already rides the same entry (the response finisher);
  `build.lean` does not and is not claimed.
- ~~**An open index signature for unknown JSX tags**~~ (report 5 §6) — **REFUSED
  2026-09-11, blocked by the frozen surface; the app-side answer is documented
  and tested.** The complaint is real and reproduces. Widening the index is the
  general fix and `check:api` refuses it — the index type is published, and
  "provably breaks nobody" is the argument the policy already answers. The
  optional spelling is not even legal (TS2411). What an app has today is better
  than a cast: TypeScript's own interface merging, four lines, typed exactly as
  the app wants — so a typo in `partition` is still a compile error, which a
  blanket widening would have cost. See `feedback/refused.md`,
  `docs/clients/electron.md`, and `tests/jsx-unknown-tag-attrs.test.tsx`.

#### 9 · Dev-loop cost

- ~~**A `patch` watcher signal** (report 5 §8.3, report 3 §12.2, report 7 §8.2,
  report 1 §22.4)~~ — **DONE 2026-09-11**, for the one case where it is provably
  safe. When the ONLY changed file in a burst is the UI entry, the server sends
  `patch` instead of `reload`: the browser re-imports that module and
  `swapRootComponent` hands it to AIR, whose diff patches the DOM in place — so
  a `<webview>` session, a loaded model, focus and scroll are the same elements
  afterwards. THE CONDITION IS THE WHOLE DESIGN. Re-importing a module gives a
  fresh copy and every module that imported the OLD one still holds it; nothing
  in the client graph imports the ENTRY, so nothing can be left stale, and that
  is not true of any other file. A hot reload that silently does not apply an
  edit to a child is worse than a reload that always works, so anything else —
  two changed files, a child module, a cell — is the reload it always was. Cells
  are deliberately never re-imported: a component holding an unbound twin of
  every cell is the failure that makes naive HMR "sometimes work". Every failure
  falls back to `location.reload()`, so the worst case is today's behaviour.
  Found a real bug in my own first version: `_rerenderRoot` diffs `h(state.App)`
  against the old root vnode, and a different function is a different component
  — the subtree was REPLACED and the `<video>` really was a new element.
  Retagging the old vnode says what happened (same component, new
  implementation), the instance is reused, and the diff runs on the rendered
  output. Pinned by a test that asserts element IDENTITY, not markup.

- ~~**`am dev --no-watch` and a `watch:` path list**~~ (report 7 §3) — **DONE
  2026-09-11.** `aio.run({ watch: false })` / `{ watch: ["src/ui"] }`, and
  `--no-watch` / `--watch=false` / `--watch=src/ui,src/style.css` on the command
  line, where a flag beats the config value (a flag is a decision about THIS
  run). `false` is honoured by never opening the watcher rather than by ignoring
  its events, so the process holds no file handles for a feature nobody asked
  for. An empty `--watch=` is refused: silently watching nothing is
  indistinguishable from the watcher being broken.
- ~~**`am dev --devtools[=PORT]`**~~ (report 7 §4) — **DONE 2026-09-11**, as
  discoverability rather than a second spelling. `--cdp[=PORT]` already existed
  and does exactly this; the reporter wrote a launcher shim exploiting
  `$ELECTRON_PATH` because they could not FIND it. A second flag would
  contradict "one vocabulary", so `am help` now lists it under `dev` with the
  words someone would grep for — DEVTOOLS / INSPECT / DEBUG — which is the
  meta-finding's own remedy.
- ~~**`deno task dev` follows the launching terminal**~~ (report 6 §3) — **DONE
  2026-09-11.** The scaffold README now says it plainly, and `am help`'s `dev`
  entry says `am start` is the form an AGENT wants. Both, because the reporter
  found `am start` near the end by reading `am help` for something else — so the
  answer had to be in the place they were already looking AND in the file a new
  app opens first. The "session leader as no parent" idea was considered and
  left alone: `am start` is the supervised form and already answers it; a second
  way for a foreground process to outlive its terminal would be two mechanisms
  for one decision.
- ~~**A component profiler / re-render log** (report 8 §16, report 1 §22.3)~~ —
  **DONE 2026-09-11.** Not new instrumentation: `_dtRenders`, `_dtLastMs` and
  `deps.size` were already on every instance and `_componentTree()` already
  walked them — nothing added the numbers up, which is why the finding cost an
  afternoon of code-reading before CDP confirmed it. `__aioProfile()` on the
  page, so `am eval '__aioProfile()'` answers it; a GLOBAL rather than a sixth
  `am` round-trip, because `am eval` is already the documented tool for what
  `am surface` cannot see and the aggregation was the missing half. Summed BY
  NAME (400 Rows is the finding; the same fact in a hundred pieces is not),
  stable order so two runs can be diffed, and TIMINGS ARE OPT-IN because two
  `performance.now()` calls per render are not free at 60fps — the first call
  turns them on and says `timings OFF` rather than reporting zeros as though
  every render were instant. Printed as well as returned, so it lands in
  `client.log` beside everything around it.
- ~~**A bundle treemap / `--analyze`** (report 5 §8.9, report 1 §22.7)~~ —
  **DONE 2026-09-11.** `deno task build --analyze`: same artifact, one extra
  report. The answerable version of "a treemap" is "which twenty things are most
  of my bundle, and is anything in here that should not be", and the number that
  makes it honest is `bytesInOutput` — what reached the output after
  tree-shaking — because a 400 KB dependency that shakes down to 3 KB is not a
  400 KB problem and a report saying it is costs someone a day. Folds a
  dependency to its PACKAGE (the unit you can act on; Deno's nested
  `node_modules/.deno/pkg@ver/node_modules/pkg` layout needs the LAST segment,
  or you get a row per version) and the framework per AREA. The tail is
  summarised, never dropped — rows plus "everything else" always sum to the
  bundle. Pure and tested on its own, then run on a real build: 192.5 KB, 131
  modules, aio/air 39.5%.

#### 10 · Found by the coverage audit, not the reading pass

Cross-referencing every numbered section against the routing docs turned up
thirteen findings that had been read and not written down (see the audit note in
`feedback/resolved.md`). One was a real bug and is fixed; these are the rest.

- ~~**A green `deno check` precedes a failing bundle**~~ (report 4 §1 — the ONLY
  thing that report calls a defect) — **DONE 2026-09-08.** The fix is not a
  better error; the error was already good (dev boot names file, line, column
  and fix). It is that `deno task check` stops being green. `am check` walks the
  client graph and exits non-zero on anything that would stop the bundle, and
  the scaffolded `check` task now runs BOTH halves — the same treatment `lint`
  already gets, where one task runs `deno lint` AND `aiol` because a task's name
  has to be true. `am fix` adds it to an existing app. Finding no UI entry
  prints `NOTHING CHECKED` on stderr in every mode, including `--json`:
  reproducing this command's own bug one layer up would be a poor joke. Still
  open, and now cosmetic: typing `deps` from the literal so the source-text
  heuristic can go.
- ~~**Selector deps discriminate on SOURCE TEXT** (report 4 §4)~~ — **ADDRESSED
  2026-09-11, and the proposed fix does not work.** Typing `deps` from the
  literal cannot replace the heuristic, because the thing being discriminated is
  not expressible in a type: with ONE dep, `fn: (s, prices)` (retired spread)
  and `fn: (s, deps) => deps[0]` (current, named parameter) are the SAME
  function at runtime — one argument after the slice, no `[` to read — and no
  signature can tell a caller's intent apart from its arity. Two or more deps
  were never ambiguous; the arity already separates them. What WAS wrong, and is
  fixed: the ambiguous case resolves toward the retired form, so the second
  spelling receives the slice where it expects a tuple and `deps[0]` is
  `undefined` — correct-looking code, wrong number, no error. MEASURED and
  pinned. The resolution is unchanged (prod must keep degrading the same way),
  but the refusal now names BOTH readings and the one-character fix, because the
  author of the second one was being told they had used a form they have never
  heard of. `refuseRetired` gained an optional `detail` for exactly this shape;
  the unambiguous multi-dep case still gets the plain registry line, pinned so
  the note cannot spread into messages that were already right. Documented in
  `docs/state/cells.md` as a rule: destructure the tuple.
- ~~**aiol rule 23 flags the spelling its own docs call correct**~~ (report 8
  §2) — **DONE 2026-09-11.** BOTH fixes, not either: it now fires only on
  `timeout: 0` — the shape that means "forever", which is what `long:` replaces
  and what people copy out of the retired example — so a real ceiling, the
  spelling `docs/state/methods.md` calls the right tool for a specific number,
  is silent. And it routes through `isSuppressed`, so a deliberate `timeout: 0`
  can be acknowledged like every other rule; reporting directly left nowhere to
  put the acknowledgement, and the finding was permanent whatever you did.
- ~~**`am fix` rewrites the app's version at `fixed` severity**~~ (report 8 §3)
  — **DONE 2026-09-08.** Now `advise`, and the advice names the alternative and
  how to take it. The guard does a REAL `am fix` and asserts `deno.json` is
  unchanged, because an outcome string that says "advise" while the writer still
  runs is the same bug with a new label.
- ~~**`am fix --migrate-tasks` would delete a working task by name**~~ (report 8
  §4) — **DONE 2026-09-11.** It no longer deletes. A pristine old-matrix task
  stays in `deno.json` and is reported as advice with its replacement SPELLED
  OUT (`dev:browser → deno task dev --client=browser`), the same treatment the
  neighbouring check already gave customized ones. "Pristine" is a fact about
  the COMMAND and says nothing about whether the NAME is in the app's README,
  its CLAUDE.md and everyone's fingers. Deriving the fleet from those names is
  what made removal survivable; keeping them is what makes it safe.
- ~~**A version pin makes `.katana/_aio.md`'s own instruction unreachable**~~
  (report 8 §5, report 2 §7) — **DONE 2026-09-08.** Both halves were the same
  defect: the instruction named `dep/aio/feedback/`, which is absent from a
  release worktree AND inside the version store, so an app that pinned had
  nowhere to write and an app that upgraded lost what it had written.
  `am
  feedback` is now the one decider for the path — outside the version
  store, `$AIO_FEEDBACK_DIR`/`XDG_DATA_HOME` aware, with `--create` from a
  template — and the kata names the command instead of a path that drifts. The
  guard that matters asserts the location is not under `versionsDir()`.
- ~~**Adding a state key gives no migration signal either way** (report 8 §10)~~
  — **DONE 2026-09-11.** `detectNewFields` is the direction the boot detector
  already walked and threw away, and boot now says
  `state shape: N new field(s), no migration needed — cfg.retries (number)` at
  info level, pointing at the "shape drift" line for the case that is NOT safe.
  A SEPARATE type and line, not a fifth `issue` on the drift union: the remedy
  differs (there isn't one), and a reader scanning for problems must not have to
  filter the reassurance out of the warning. A rename shows as both, once in
  each, which is exactly what a rename is. A brand-new CELL is not a pile of new
  fields, a wholly new subtree is one arrival rather than five, and an open
  record's keys stay data. Found a real bug writing the test: the cap was only
  checked on entry to the walk, so one level with 300 new keys pushed 300 — the
  pre-existing drift walk checks inside its loop and was fine.
- ~~**The 100-msg/sec WS budget is tripped by a legitimate burst**~~ (report 1
  §10) — **DONE**, by a third route the report did not list and which is better
  than both it did: the SERVER ADVERTISES its budget in the hello (`rate`) and
  the client PACES ITSELF against it, so "over budget" stops being reachable by
  ordinary use. A single op still sends inline — only a burst queues, and it
  queues frames, never the only copy (the op is durable in the buffer before it
  is ever sent, so the queue is dropped offline rather than double-sending on
  reconnect). A peer that advertises nothing is paced at the server's own
  default, never left unpaced. Verified 2026-09-11 by the report's own scenario,
  `tests/sync/op-pacing.test.ts`: 1000 ops, asserted as a RATE; with the pacing
  removed the same test measures 268/sec against an advertised 100.
- ~~**A canvas app is invisible to `testUI`, and the workaround deserves a
  page**~~ (report 6 §6) — **DONE 2026-09-11**, `docs/testing/canvas-and-3d.md`.
  The report's own pattern, written up as the blessed answer: the decisions come
  out of the imperative shell, so "what did the ray hit" and "what should light
  up" are pure functions of what the renderer knows and only the GL calls stay
  untestable. Plus the half the report did not name — canvas state (selection,
  camera, tool mode) belongs in a cell, where `testCell` reaches it with no DOM
  at all — and the two tools that cover what is genuinely left: `am eval` for
  "did the context initialise" (a real GPU is the only place that has a true
  answer) and `am shot --check` for the drawn pixels, which landed earlier the
  same day. Says plainly not to stub `getContext`: a test against a fake GL is a
  test about the fake, and it goes green on exactly the changes that break the
  real thing.

#### 11 · The dev audits ship to production (raised at 1.0.0-beta, not paid down)

1.0.0-beta raised the page ceiling 63 → 67 KB gz, and about half of that is
**dev-only diagnostics that production downloads and never runs** — the contrast
audit, the `#id`-selector audit, the untracked-lifecycle-read check, and the
message prose that makes the child-desync warning actionable. Every one of them
answers a top-of-report finding, so the trade was taken deliberately and
itemised in `tests/bundle-size.test.ts`. It is still a trade.

Paying it down means a dev-only chunk: `await import()` the audits from the one
dev-guarded call site in `renderer-flush`, so esbuild emits them separately and
a production page never fetches them. The cost is a chunk-aware reader in three
places (the prod static route, the dist sweep, the Electron AppDir copy) — which
is exactly the trade `feedback/refused.md` declined once for the sync engine.
The difference worth weighing: this chunk is fetched by NOBODY in production,
where the sync engine's was fetched by everybody who used sync.

Not decided in a hurry at release time. Decide it with a measurement of the
three-reader cost, not an argument.

#### 12 · Smaller, each named once

- ~~`aio-ok` vs `aiol-ok`~~ (report 3 §8.1) — **DONE 2026-09-11.** One marker,
  in `src/diagnostics/ok-marker.ts`, read by all eight checkers: both spellings
  everywhere, so the wrong one can no longer be silent. And it gained the scope
  it never had — `// aio-ok(silent-catch): why` binds to one gate, while the
  unscoped form keeps meaning exactly what the hundreds of existing ones mean.
  `aiol` keeps its optional reason (dozens of bare `aiol-ok` lines exist and
  tightening them would be a silent change for no finding); the script gates
  keep requiring one. A test refuses any new private marker regex in `scripts/`
  or `aiol/`.
- ~~An `aiol` rule for accessible names~~ (report 9 §9.4) — **DONE 2026-09-08.**
  An interactive element with no name gets no semantic path: absent from
  `am surface`, unreachable by `am trigger`, no handle in `testUI`. The runtime
  already warns for `<input>` at render time; this catches the ones a render
  never reaches. DELIBERATELY NARROW — one line, empty body, no naming attribute
  — because a name can come from a variable, a child component or a multi-line
  body, none of which is knowable from source. Ten cases pin the SILENCE as hard
  as the finding: text content, five naming attributes, an `id` that may pair
  with `<label htmlFor>`, a multi-line body, and `aio-ok`.
- ~~The bundle auditor false-positives on path-shaped strings~~ (report 5 §6) —
  **DONE.** `FS_ROOT_RE` in `assetUrlsIn` drops `/home`, `/Users`, `/tmp` and
  the rest of an OS's roots: no aio app routes them, and a build warning that
  cries wolf costs more than it is worth, because the REAL finding (an asset
  that works in dev and 404s in the artifact) is the one that then goes unread.
  Pinned by `tests/build.test.ts`.
- ~~`am trigger … press "Enter"` refused on a visible, focusable `<input>`~~
  (report 5 §6) — **NOT REPRODUCIBLE 2026-09-11, and now pinned.** Driven
  against the same two functions the CLI calls: `parseChord` turns the
  positional into a key (chords, and the literal `+`), and `runUITrigger`
  delivers it — the handler sees `Enter` and the form submits. `assertOperable`
  is deliberately strict, which is the kind of guard that grows one condition
  too many, so `tests/trigger-press-enter.test.ts` asserts BOTH that a plain
  text input passes it and that a disabled / hidden / `type="hidden"` one still
  does not.
- ~~`am stop` could not find a demonstrably running app; `--port=N` worked~~
  (report 5 §6) — **DONE 2026-09-08.** Two halves. `am stop <appId>` now works
  at all (see the positional fix above — an id from `am instances` used to be
  read only as a component label). And the "not running" refusal now NAMES what
  is running: one instance gets `did you mean --app=<id>?`, several are listed.
  It already pointed at `am instances`, and a pointer costs a round trip at the
  exact moment someone is staring at "not running" for an app they can see in
  their own browser.
- ~~`am surface` prints ~8 kB as one unwrapped JSON line~~ (report 3 §8.2) —
  **DONE 2026-09-11.** `--json` is serialized for whoever is reading it: a pipe
  gets the compact form a parser wants, a terminal gets it indented. Same
  document either way — `JSON.parse` cannot tell them apart — so it is the call
  colour output already makes, on the same fact.
- ~~`am shot /path/to/file.png` suggests `--out=`~~ (report 3 §8.4) — **DONE.**
  A positional ending in an image extension is a detectable mistake, and
  "invalid window index: shots/home.png" explained the parser instead of the
  fix. Pinned by `tests/am-shot.test.ts`.
- ~~A `worker: true` hint when a cell's tick exceeds a frame budget, and the
  module-graph checker's output in the default build summary~~ (report 2 §3) —
  **DONE.** The hint has shipped for a while (`_budgetMisses`, THREE misses
  before advising a thread — a cold start, a first big import and one unlucky GC
  are each a single slow tick, and advising on the strength of one is how a hint
  becomes noise; `tests/budget-worker-hint.test.ts`). The graph checker already
  ran per target and REFUSED the artifact; what was missing was that the final
  summary never named it, so a summary-only reader saw "it compiled".
  `deno task build` now ends with what was checked, counted over ARTIFACTS
  rather than attempts — and a test asserts the refusal that makes the claim
  legal, because the line is only honest while an artifact really cannot reach
  disk unaudited.
- ~~A documented known-good Electron switch set for headless and VM hosts~~
  (report 2 §7, §9.7) — **DONE 2026-09-11.** Environment variables already
  reached Electron; Chromium SWITCHES had no way in, so half the remedy was
  unreachable. `AIO_ELECTRON_ARGS` takes them, appended LAST so an operator can
  override one of aio's own, and a token that is not a `--switch` is named in
  the log rather than dropped — "I set the flag and nothing changed" is the
  failure it exists to end. `docs/clients/electron.md` carries four sets (no
  GPU, small `/dev/shm`, software rasteriser, and `xvfb-run` for a host with no
  display at all) and deliberately hands out NO `--no-sandbox`: aio adds that
  itself, only after measuring the two conditions under which Chromium aborts.
- ~~`feedback/` lives inside the versioned directory~~ (report 2 §7) — **DONE.**
  `am feedback` writes to `$XDG_DATA_HOME/aio/feedback` (or `AIO_FEEDBACK_DIR`),
  outside anything an upgrade replaces; `docs/clients/app-manager.md` says not
  to write into `dep/aio/feedback/` and why. Pinned by
  `tests/am-feedback-survives-pin.test.ts`.
- ~~A CI recipe for an app built on aio~~ (report 5 §8.9) — **DONE 2026-09-11.**
  `docs/build/ci.md`: a working GitHub Actions workflow, and the three
  aio-specific facts that decide whether it catches anything. Chiefly that CI
  must run `deno task check`, not `deno check` — `"aio"` resolves to `mod.ts`
  for the type-checker and to the browser entry for the bundle, so a server-only
  import reachable from a cell type-checks and then fails to build, and the task
  is the half that walks the client graph. Same for `deno task lint` vs
  `deno lint`. Plus the two things a headless runner cannot do (Electron needs a
  display, an e2e needs a browser), the target matrix, and the cache.
  `tests/docs-ci-recipe.test.ts` checks every task name against the scaffold and
  the pinned Deno version against `MIN_DENO`, because a copy-pasteable workflow
  is read once and trusted for years.
- ~~`am migrate --from=alpha76`~~ (report 1 §22.7) — **DONE 2026-09-11.** Every
  piece already existed with no front door: `REMOVALS` carries each retired
  spelling with its hint and guide, `removalsInSource` finds them,
  `aiol
  --safe-fix` rewrites the renames. `am migrate` SCANS rather than lists
  — "everything removed since alpha76" is a changelog and the changelog exists;
  the useful answer is the intersection with your code. `--from` narrows to what
  was removed after a release (default: the app's own pin); exits 1 so it works
  in CI; `[fixable]` marks the renames and a hit under `tests/` is marked a
  probable fixture, the same call `am pin` makes. Running it on a real tree
  found its own defect first: `removalsInSource` documents itself as taking a
  cell CONFIG BLOCK, and fed whole files it read
  `{ seed: number; actions:
  string[] }` as a retired cell key — so the file is
  now handed over twice, each time as the thing the contract describes (66
  findings → 39 on this repo, all cell-config false positives gone).
- ~~A named way to keep a cell out of the dev action journal~~ (report 2 §7) —
  **DONE 2026-09-11.** `cell({ diagnostics: false })`. A separate word on
  purpose: `persist: "none"` was read as covering this too, and it does not —
  `persist` is the STATE STORE, the journal is a dev diagnostic. The BOUNDARY is
  the design and is what the tests pin: IN are `logs/actions.jsonl`, the
  state-diff debug log, the checkpoint's recentActions and `am timeline`; OUT
  are the durability journal (`journal: true` — dropping a cell from the replay
  log would be data loss dressed as a privacy feature) and persistence itself.
  Registered per boot from `composed.cells`, replaced not accumulated, and
  cleared by `_resetAioRuntime`.

### The leak sanitizers are off (found 2026-09-04, audit round) — DONE 2026-09-04

Done: the flags are on `test`, `test:core` and `check:coverage`;
`check:sanitizers` is red if they go missing; the full suite is green with them.
Measured before the fix: **729 of 7210** failed with the flags on. The bulk was
the framework's own teardown, fixed at the source (dev == prod): a completed
async call left its half-way heartbeat timer armed (`cell-impl.ts`); an app's
Phase 5 `onStop` re-armed the diagnostics checkpoint debounce after the final
flush (`checkpoint.ts`); a boot that REFUSED left the lock, the vitals sampler,
the logger heartbeat, SQLite and the worker pool running (`aio.ts` unwinds them
now); `race({ timeout })` kept the losing timer (`async-helpers.ts`); a throwing
`onStop` skipped the logger teardown (`aio-cells-bridge.ts`); process-wide
signal listeners outlived the last app (`shutdown.ts`); the AIR transport's
reconnect timer was untracked (`browser-air-transport.ts`); `testUI`'s
refused-mount teardown closed its window fire-and-forget (`ui-test.ts`). The
rest was tests closing what they opened. `tests/sanitizer-leak-floor.test.ts`
pins each one with the sanitizers on regardless of flags. The original entry,
for the record:

Deno 2.9 made `--sanitize-ops` / `--sanitize-resources` opt-**in**; they used to
be on by default and no aio task passes them. So `deno task test` has no leak
floor at all: a test can leave a timer, a socket, a file or a child process
behind and stay green, and `check:sanitizers` — which freezes the count of
unexplained opt-outs at zero — has been ratcheting a mechanism that does not
run. `docs/testing/README.md` said "Sanitizers stay on"; it now says what is
true, and the gate prints the same thing on every run.

Measured over the whole suite with both flags on: **702 failures of 7009**,
dominated by one shape — a booted test app (`aio.run({ libraryMode: true })`)
that leaves its live-reload file watcher and timers running, plus `testUI`'s
fire-and-forget happy-dom close. Both are fixable in the harness rather than in
702 test files, which is what makes this tractable at all.

The work: close the watcher on `app.close()` (or make the harness own it), make
`_teardownPartialMount`/`unmount()` await the window close, then add
`--sanitize-ops --sanitize-resources` to `test`, `test:core` and
`check:coverage` and delete the warning branch in `scripts/check-sanitizers.ts`.

## Resolved: `check:api` was red inside `check:release`, green in a shell

**Found while cutting v1.0.0-beta; fixed the same day.** Kept because the shape
of the mistake is more instructive than the bug.

**Cause.** `deno doc --json` writes ANSI colour escapes INTO the JSON it emits.
A type whose `repr` interpolates comes back as
`"${\u001b[38;5;12mPrefix\u001b[0m}:${…}"` and as `"${Prefix}:${K}"` under
`NO_COLOR`. The digest is taken over that string, so the same unchanged tree
hashed two ways — and the release harness sets `NO_COLOR`, which is why exactly
one context disagreed with the ~20 that agreed. The four symbols named
(`Catalog`, `CellFieldFilter`, `CellVisibility`, `SelfAction.type`) were simply
the only public types whose `repr` contains an interpolation. Nothing on the
surface had moved.

**Fix.** `docOnce()` spawns `deno doc` with `NO_COLOR=1` so the reading is
canonical wherever it runs, and `normalize()` strips SGR escapes from every
string before it reaches a digest. Snapshot re-baselined: 4 digests, 0
structural changes, verified symbol-by-symbol. Pinned by
`tests/api-snapshot-colour-independent.test.ts`, which asserts the hazard is
real on this Deno _and_ that the gate is immune to it — mutation-checked three
ways.

**The lesson, twice over.** The gate had a false BREAKING that pointed at
innocent types, and the honest reaction to a break you cannot explain is to
distrust the gate rather than regenerate the snapshot to quiet it — regenerating
is precisely the motion that would launder a real break. And the first probe
written to test the colour theory searched raw stdout for an ESC _byte_, found
none, and briefly "disproved" a diagnosis that was correct: the escape is
JSON-_escaped_ as six characters. Verify the instrument before believing what it
says about the subject.

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

## Known gap: a handful of tests fail NON-DETERMINISTICALLY, in one shape

Measured 2026-09-06, five full runs on one tree (bar the fixes each prompted),
on a machine also running the developer's own apps:

| 15-min load | result                        |
| ----------- | ----------------------------- |
| 9.49        | 16 failed                     |
| ~7          | 2 failed (a different pair)   |
| 6.35        | 0 failed                      |
| ~6          | 1 failed (a gate, not a leak) |
| 9.69        | 0 failed                      |

**Load is suggestive, not established.** The last run was GREEN at a 15-minute
load of 9.69 — higher than the run that failed sixteen — so "the machine was
busy" does not predict it. What is established: the failures are
non-deterministic on an unchanged tree, and every one is resource-leak shaped
rather than a wrong answer.

Every one of those failures was a RESOURCE LEAK, never a wrong answer: 15 in
`tests/am.test.ts` ("a child process was started during the test, but not
closed"), one in `tests/spawn.test.ts` (child stdout/stderr not closed), and
earlier `tests/examples.test.ts` sat on one test for ten minutes because a
spawned child had already died. Both files pass 86/86 and 11/11 alone,
repeatedly, at the same load.

The shape is always the same: a child process that does not exit inside the
teardown's window leaves its handle open, and the sanitizer reports it against
whichever test runs next — so the failure names a file that did nothing wrong.
WHY the child is late — CPU contention, disk, or a race in the teardown itself —
is not known, and anyone picking this up should find out before assuming: a fix
aimed at the wrong cause will look like it worked, on a suite whose failures
already come and go.

This matters beyond a developer's busy laptop: a CI runner is a busy machine by
definition, and a suite that goes red at no defect teaches its readers to re-run
rather than read (the same argument as the orphan-directory ceiling).

What would close it, in rough order of value:

- `stopChild` (tests/stop-child.ts) is the one teardown; the leaking sites do
  not all go through it. Route them through it and give it a deadline that
  ESCALATES (SIGTERM, wait, SIGKILL, wait) rather than one flat wait.
- Failures should say what the child did — `tests/examples.test.ts` now keeps
  the child's stderr and names its exit code; the am/spawn sites still do not.
- A load-sensitive bound is a bound measured on the wrong machine. Where a test
  waits for a child, wait for an OBSERVABLE (a port answering, a line in the
  log), never a duration.

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
