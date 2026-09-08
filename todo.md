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

## Open work

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

#### 1 · Discoverability (vidtune §7, cc §8.0/§9.7, watcher §7, composer §10.1, anathomy §8) — ALL DONE 2026-09-08

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

- ~~**`am restart` drops the argv the app was started with**~~ (composer §5,
  risoto §22.4) — **DONE 2026-09-08.** Replay was all-or-nothing: ANY flag on
  the restart command line skipped the recorded launch entirely, so
  `am restart --force` — where `--force` steers the RESTART and says nothing
  about how the app boots — threw away `--cdp --port=8140`. Merging is per FLAG
  now: an explicit `--port=9000` overrides the recorded one and everything else
  is replayed, `am`'s own flags (`--force`, `--json`, `--wait`, …) are
  transparent to replay, and both the replayed and the OVERRIDDEN flags are
  reported — silently replacing a recorded flag is the same silence in the other
  direction. `mergeLaunchFlags` is pure and pinned by six cases.
- ~~**`am dispatch` has two argument shapes and the wrong one fails deep inside
  the app**~~ (vidtune §4) — **DONE 2026-09-08.** Both readings are legal —
  `--args` is the argument LIST, so `--args='["a","b"]'` passes two arguments
  and a method taking one array wants `--args='[["a","b"]]'` — so the CLI cannot
  refuse either. What it can do is stop the app's own message
  (`v.startsWith is not a function`, about a value the author never knowingly
  passed) from being the only thing said: a FAILED `--args` dispatch now carries
  one extra line offering the other reading, with the exact command line to
  type. Only on failure, only with `--args`, never on an empty list — a hint
  that fires every time buries the message it sits under.
- **`am surface` has no geometry** (anathomy §10.2). A rect per element behind
  `--rects` turns "the app looks fine" into "the Stage is 6 886 px tall".
- ~~`am surface --names` / `ui.names()`~~ (anathomy §5a) — **DONE 2026-09-08.**
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
- ~~`am logs --tag= --level= --since=` (+ `--follow`)~~ (watcher §6, §8.8;
  composer §9.8) — **DONE 2026-09-08.** `--level=warn` means warn AND above,
  `--tag=cell` matches the NAMESPACE (so `cell:todo` and `cell:notes`, never
  `checkpoint`), `--since=` takes a duration or a timestamp. The unit is the
  EVENT, so an `ERROR` keeps its stack. `--follow` applies the same filters as
  the tail it continues — filtering differently there would answer one question
  two ways. An unparseable header passes every filter (dropping what cannot be
  classified is how a filter hides the line that mattered), and an unreadable
  `--since` is REFUSED, never ignored.
- ~~`am state --watch <path>`~~ (watcher §6) — **DONE 2026-09-08.** A line per
  CHANGE, not per poll. `--wait=N` already re-read and re-printed every N
  seconds, which is a poll loop with nicer syntax — and both reports wrote
  `until` loops around `am state` anyway. Compared by VALUE (the state arrives
  freshly parsed each poll, so identity comparison would mean "changed" ==
  "polled"); the first reading prints too, because a change with no baseline is
  unreadable. `--wait=N` now sets the interval for both modes. Fixed while
  there: the path was `args[0]`, so `am state --watch todo.items` looked up a
  key called "--watch".
- ~~**`am start --instance=<name>`**~~ (anathomy §4) — **DONE 2026-09-08.** A
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
- `am shot --selector` (vidtune §11.7); `am shot` should say "restart with
  --cdp" rather than failing, or the boot line should say screenshots need it
  (newjob §6).
- `am shot --check` / `--update` against a committed baseline (composer §10.7).
  aio already has all three hard parts — headless capture, deterministic state
  via `am snapshot load`, and `am dispatch` to reach any state. This is the last
  10%, and it is a differentiator rather than catch-up.
- ~~`am shot` must detect the stale-surface case rather than returning success
  with old pixels~~ (anathomy §2) — **DONE 2026-09-08.** It now waits for the
  window to COMMIT a frame (a double `requestAnimationFrame`, the browser's own
  definition of "something was painted since you asked") before capturing, and
  reports `painted: true|false`. An unconfirmed frame still writes the file — it
  is worth having — but carries a warning and a `! STALE RISK` line naming the
  cause (a hidden, minimised or occluded window is not composited) and the two
  remedies. The caveat is in `docs/clients/electron.md` and the `am shot` docs.
  Mutation-checked: hard-code `painted = true` and the test fails.
- ~~`am instances` should print the DATA path beside each row~~ (risoto §20) —
  **DONE 2026-09-08.** The lock now records `dataDir`; `--json` reports it on
  every row (`null` for a lock written before beta1 — a field that appears
  conditionally is one a script has to guess about), and `--long` shows a `DATA`
  column when it DIFFERS from `home`, since a column repeating the obvious is
  noise. The three spellings are tabulated in the docs, because the trap is that
  `AIO_APPS_DIR` _appears_ to work: it moves the lock and the discovery files,
  so `am` follows the app, while an `appDir` set in code leaves the database
  where it was.
- ~~`am restart <appId>` refuses an app id that is also not a component name~~
  (vidtune §5) — **DONE 2026-09-08.** The positional was read ONLY as a
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
- ~~`am heap <app>`~~ (quant §9.4) — **DONE 2026-09-08.** `am state` says what
  an app SERVES; nothing said what it HOLDS. A new trojan route reports heapUsed
  against the real V8 ceiling (`heap_size_limit`, not the lazily allocated
  `heapTotal`, which always sits just above heapUsed and always looks
  reassuring), RSS, external, and per-cell serialized size sorted biggest first.
  The percentage is `null` when the runtime cannot say — a hard-coded 0 reads as
  "plenty of room". The output states that cell state is serialized SIZE, not
  retained heap, so "my cells are small, so the leak is aio's" has to be
  reasoned to rather than assumed.
- `am add server <name>` scaffolding the module AND its line in `app.ts`
  (vidtune §12.6).
- `am preview <Component> --props=` (vidtune §12.5).
- ~~`am migrations` — a way to SEE the version chain~~ (newjob §8.9) — **ALREADY
  DONE**, verified 2026-09-08: `am migrations` reports declared vs stored
  versions per cell, what the last boot's migration pass did, and any
  unaccounted shape drift. Listed in `am help`. The report predates it.
- **`useResource({ key, open, close })`** (watcher §2, §8.5). Keyed
  replace-on-change with a cancellation signal — `own.set` with a token, on the
  client. The reporting app hand-rolled it and every one of its lifecycle bugs
  came out of that code: two pipelines fighting over one camera on a remount, a
  hand-written `alive(s)` guard at ~twenty call sites each of which is a bug if
  forgotten, a stale open installed over a newer one.
- **A client-side reaction** — `onChange(selector, fn)` (watcher §5, §8.4). The
  rule "when the camera id changes, reopen the camera" can only live in a JSX
  handler today, so `am dispatch settings:patch` changed the state and the
  camera stayed open. Logically correct and genuinely surprising.
- **An error boundary** (risoto §22.1). A component that throws during render
  takes its whole render with it. For a wallet that is the difference between
  "the NFT gallery is broken" and "the wallet is a blank window", arriving while
  the user is mid-send. The renderer already has the collector, the
  mount/cleanup callbacks and a crash handler; what is missing is a place to
  stop.
- **A dev-time error overlay** (vidtune §12.4, watcher §8.7). One app's
  MediaPipe failed on every single frame and the only evidence was a counter in
  a panel the author happened to have written.
- **Source maps** (newjob §8.2). `grep -rn sourcemap src/build*` returns
  nothing, and the renderer-error forwarder — which two reports call the best
  thing in the box — currently prints `app.js:1:22073`. aio's strongest feature
  is undercut by a missing esbuild flag.
- **The renderer console keeps the interceptor's call site** (watcher §8.6).
  Every line arrives as `console-intercept.ts:73`. Capture one caller frame.

#### 4 · Build products that go stale in silence

- ~~**A browser `Worker` entry is not in the renderer build graph**~~ (watcher
  §1) — **PARTLY DONE 2026-09-08: the silence is closed.** The graph validator
  now reports `new Worker(new URL("./x.ts", import.meta.url))` in a
  client-reachable module as `unmanaged-worker` — a warning, not a block, since
  the worker genuinely runs — and the fix text names the CONSEQUENCE ("editing
  it may appear to do NOTHING: the app keeps running the previous build") plus
  the three things to do about it. A remote/blob URL is not reported: nothing
  local goes stale, and a warning nobody can act on is how a real one gets
  ignored. Still open, and now merely a feature rather than a trap: bundling app
  workers for real (a `workers:` list, or following the constructor).
- **Hot reload does not cover server-side dynamic imports** (composer §6). A fix
  to a `*.server.ts` module reached from a cell method by `await import()` did
  not take; the author verified state twice, concluded the fix was wrong, and
  went back to re-reading correct code. One line at boot ("browser modules
  reload, server modules need a restart") would have closed it; naming the
  changed file on the reload event is better, since `am where` already computes
  the answer.
- ~~**`*.server.ts` modules must be hand-registered in `app.ts`**~~ (vidtune §3,
  llama.master §13) — **DONE 2026-09-08.** Every `*.server.ts` / `*.server.tsx`
  is now auto-embedded by `assetIncludes`, the same zero-config walk `.wasm`
  already got: the naming convention IS the registration. MEASURED first,
  because the reported shape did not reproduce as stated — on Deno 2.9, running
  from a foreign cwd with sources deleted, a literal `import("./io.server.ts")`
  and a template ``import(`./${n}.server.ts`)`` are both analysed and embedded;
  only an OPAQUE specifier (a variable, what a registry or plugin loader writes)
  is missed, and that binary dies at the call. That is the shape the reports
  hit, and the rule that guarded it was a comment enforced by nothing.
- **Dev does not watch `dep/aio`** when it is a symlink into a working tree
  (quant §9.6).

#### 5 · Composition inside a cell

- **A cell method cannot call a sibling** (llama.master §6, §9; vidtune §6).
  Three ways to express it, all wrong: `this.bench(...)` cannot type-check (the
  declared method takes the draft, the callable one does not); `srv.bench(...)`
  is a second dispatch with its own draft; extracting a helper works and is the
  third time that repo has done it. `s.$call.bench(kind)` — typed, same draft,
  no second dispatch. _"The single most valuable thing aio could add for an app
  of this size. Composition inside a cell is not exotic."_ The error today is
  twelve lines of intersected generics naming `MethodDraftServed`.
- **The workaround escapes `aiol`** (llama.master §7), which is the actual
  danger: moved into a module-level function taking the draft, a post-await read
  is no longer analysed, and the absence of a warning now means "not analysed"
  while reading as "fine". A function whose parameter is the cell's state type
  is a method body wherever it lives.

#### 6 · Declared policy instead of per-app invention

- **`s.$append("partial", chunk)`** (llama.master §12). Publishing a streaming
  reply re-sends the whole accumulated string, so a naive 60 ms flush is
  quadratic in the reply, doubled per window, measured in production as a
  sustained `PRESSURE — 33 broadcasts/sec`. The app wrote a byte-rate limiter to
  hold it flat: a framework problem solved in application code, in the app whose
  most visible feature is a streaming reply. Append-only strings and arrays need
  offsets, not a CRDT.
- **`s.$pending("scan")`** (llama.master §14, cc §9.5). Ten hand-rolled booleans
  across five cells, each set at the top and reset in a `finally` — ten chances
  to forget — and replicated, persisted and migrated like real domain state,
  which they are not. cc got the fourth one wrong: a boolean where two readings
  overlap, so the first to finish declared silence while the speakers were still
  going.
- **`concurrency: "first" | "newest" | "queue"` and `ttl:`** (llama.master §15).
  Three different hand-written answers to one question in one app, and the
  comment on one records that the original first-wins guard was itself a bug.
- **An optional per-method argument schema** (cc §9.6, vidtune §12.7). A dozen
  hand-written coercions in one week; the existing arity warning exists
  precisely because the boundary is untyped at runtime.
- **`onPersist(state)` / `persist: { include, transform }`** (cc §8.4). aio lets
  you repair what comes back (`onRestore`) and not shape what goes out. The
  reporter got lucky — the fat field was dead weight — and says plainly that had
  it been needed on screen, the only move was a second mirrored cell kept in
  sync by hand.
- **A `budgets` block** (quant §9.3).
  `{ cellState: "1MB", broadcastRate:
  "20/s" }`, declared by the app, warned
  in dev, failing `deno task check`. Strictly better than aio picking a
  threshold for everyone.
- **`aio/server-only` and `aio/client-only` marker modules** (quant §9.1). The
  graph checker is good and runs at BUILD; Next's marker fails at EDIT time.

#### 7 · Test-harness reach

- **A stubbing tier between `testCell` and `bootCells`** (cc §8.6, §9.3). For a
  cell that owns an OS process there is no rung where "random actions against a
  real runtime" is safe — `bootCells` spawns the real child. Cassettes wrap a
  function you can reach, not a `.server.ts` a cell imports dynamically.
  `bootCells([session], { stub: { "./claude.server.ts": … } })`.
- ~~**`testUI`'s window is not `globalThis`**~~ (risoto §19.2) — **DONE
  2026-09-08.** The false green was already closed (testUI THROWS on a
  bare-global DOM listener); what remained was the ceremony. `onWindowEvent` now
  resolves the component's OWN window — correct in a browser, in an Electron
  child window, in a `<webview>` and under the harness — and removes the
  listener on unmount. Making the bare global work was considered and refused:
  aio mounts into more than one window, so `globalThis` is genuinely the wrong
  target, and a harness that accepted it would be lying. See
  `feedback/refused.md`.
- **Geometry in tests** (risoto §19.1, §22.2; anathomy §10.1). happy-dom
  measures everything 0×0, which hid two security-relevant defects in a wallet
  behind 1546 passing tests: a dApp origin running off the edge of the approval
  card, and that dialog opening scrolled past the origin. Even a narrow
  `ui.box(selector)` returning a real rect would close most of it; the full
  shape is a second opt-in runner
  (`testUI(App, name, { engine: "browser" }, …)`) exposing the SAME semantic
  names — which is a property nobody else has, since Playwright gives you the
  browser and makes you invent the names.
- **`waitFor` failure should route through `fail()`** (cc §9.0). It dumps the
  whole tree — one failing test printed 31 769 characters — where `fail()` would
  have printed six ranked names.
- **`t=` is a handle, not an attribute, and does not appear in `ui.html()`**
  (risoto §19.3). One doc line.
- **Typed test locators** (llama.master §11, §18). `ui.App["tab-settings"]` is a
  string key whose typo is a runtime `undefined`. The `t=` props are in the
  source; generating a typed map from them is mechanical and the string form can
  keep working.
- **Mount-time rehydration is racy and silent** (llama.master §11). Measured at
  ~40% flake in one repo, now guarded by a house rule and a comment on every
  affected test.
- **A trace artifact on failure** (quant §9.5) — dump the AIR tree and the last
  N dispatches, and name the file in the error.

#### 8 · Styling and the shell

- **`theme: "base"`** (newjob §4). The reset, form controls, focus rings and
  `::selection` — no page shell. _"I want my own layout; I do not want to
  restyle `<input>`, `<textarea>`, `<button>` and focus rings from scratch."_
  Today the choice is 200 lines of control CSS or fighting the shell.
- **Scoped styles** (vidtune §12.1, composer §10.3, newjob §8.5). The worst UI
  bug of one build: a `class="track"` collision silently clipped every music row
  to one line, with no error, a correct DOM and a correct component tree. The
  cheapest half is a LINT rule — `aiol` already walks the component graph, and a
  class name defined twice with different bodies is one second of work. Opt-in
  hashed classes are the fuller answer.
- **A `<Browser>` component and `docs/clients/webview.md`** (newjob §2). The
  `<webview>` gate rides `childWindows` and is documented in exactly one place:
  a source comment. Two traps every author meets in hour one — a reactive `src`
  is an infinite navigation loop, and unmounting destroys the guest with its
  scroll and its login. ~150 lines, and it is the difference between "aio can
  build a browser app" and "aio builds browser apps".
- **A CSP that can drop `base-uri`, and a nonce for the inline shell** (newjob
  §3, risoto §11). `base-uri` is described as one of "the directives that cannot
  break a page" and it breaks any page your app serves that is not about your
  app — archiving, mirroring, print previews. Separately, the shell inlines its
  own scripts, so a strict app cannot drop `script-src 'unsafe-inline'`; one
  wallet carries that as a documented HIGH waiver.
- **Standard Schema in `useForm`** (composer §10.6, newjob §8.7). ~40 lines
  against an interface, no dependency, `rules` untouched — and the same adapter
  then serves the cell `validate` hook, where it pays off twice.
- **`resource()` keys, dedup and invalidation** (composer §10.4). Three
  components mounting with the same `resource` fire three identical requests,
  and there is no key to dedup on.
- **More templates** (anathomy §10.6): `--template=canvas`, `--template=assets`,
  `--template=desktop-panels`. A template encodes tribal knowledge that
  documentation cannot make anyone read, and it cannot break an existing app.
- **`aio.run({ assets: { "/x": "./assets/x" } })`** (anathomy §7, §10.5). Every
  app with binary data writes the same twenty lines — route, MIME, caching,
  range, traversal guard, `compile.include` — and one of them will forget the
  guard. Pre-compression and a `build.lean` Electron trim ride the same entry.
- **An open index signature (or `custom("webview")`) for unknown JSX tags**
  (newjob §6). `<webview>` is admitted and its attributes are not.

#### 9 · Dev-loop cost

- **A `patch` watcher signal** (newjob §8.3, vidtune §12.2, watcher §8.2, risoto
  §22.4). A `.tsx` edit reloads the whole document. aio starts from a better
  position than anyone — cell state lives on the server and already survives a
  reload — so what is lost is small: `useLocal`, scroll, focus, and stateful
  DOM. But "small" included an embedded `<webview>` with its logged-in session
  (newjob), 760 MB of GPU weights (watcher), and a wallet's unlock (risoto). AIR
  already preserves stateful nodes across a re-render; this is wiring existing
  machinery to an existing signal.
- **`am dev --no-watch` and a `watch:` path list** (watcher §3). The cheap
  escape hatch that solves 90% of the above. `deno fmt` triggered full model
  reloads repeatedly.
- **`am dev --devtools[=PORT]`** (watcher §4). The reporter wrote a launcher
  shim exploiting `$ELECTRON_PATH` to get a CDP port at all.
- **`deno task dev` follows the launching terminal** (anathomy §3). Right for a
  human, wrong for an agent whose every command is a fresh short-lived shell —
  the app vanished about eight times in one session. `am start` solves it and
  was found near the end, by reading `am help` for something else. One line in
  the scaffold README; and consider treating a session leader as "no parent".
- **A component profiler / re-render log** (llama.master §16, risoto §22.3). One
  page root ran `tuneAll` three times per render at ~14 ms — half of "typing is
  slow while the model answers" — found by reading code and confirmed over CDP.
  aio already tracks the dependencies.
- **A bundle treemap / `--analyze`** (newjob §8.9, risoto §22.7).

#### 10 · Found by the coverage audit, not the reading pass

Cross-referencing every numbered section against the routing docs turned up
thirteen findings that had been read and not written down (see the audit note in
`feedback/resolved.md`). One was a real bug and is fixed; these are the rest.

- ~~**A green `deno check` precedes a failing bundle**~~ (composer §1 — the ONLY
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
- **Selector deps discriminate on SOURCE TEXT** (composer §4). `deps` is typed
  `any[]`, so the documented tuple form cannot be typed as a tuple; widening to
  an array then trips `secondParamIsTuple(fn)`, which reads the function's text
  for a leading `[`. Three attempts, each rejected by a different tool, and the
  version that satisfies both has WEAKER type information than the one the docs
  show. Type `deps` from the literal (`readonly [...D]`) and the source-text
  heuristic can go.
- **aiol rule 23 flags the spelling its own docs call correct** (llama.master
  §2). It reports every `perfBudget.methods[...].timeout` unconditionally, while
  `docs/state/methods.md:631` says that spelling "still works and is the right
  tool for a specific NUMBER". Ten of one app's sixteen are real ceilings on
  work that is quick by nature, where `long:` would DELETE the report — so they
  stay, and so do ten permanent warnings. It also calls `report()` directly
  rather than routing through `isSuppressed`, so there is nowhere to put the
  acknowledgement. Either fix alone closes it; firing only on `timeout: 0` (the
  shape that means "forever", and the copied-from-examples case the rule's own
  comment names) is the better one.
- ~~**`am fix` rewrites the app's version at `fixed` severity**~~ (llama.master
  §3) — **DONE 2026-09-08.** Now `advise`, and the advice names the alternative
  and how to take it. The guard does a REAL `am fix` and asserts `deno.json` is
  unchanged, because an outcome string that says "advise" while the writer still
  runs is the same bug with a new label.
- **`am fix --migrate-tasks` would delete a working task by name** (llama.master
  §4). `dev:browser` is in the app's CLAUDE.md, its README and everyone's muscle
  memory. The capability half is fixed — `targetsFromLegacyTasks` now persists
  what those names encoded — but deleting a task the user runs by name is the
  one irreversible thing `am fix` does, and the neighbouring check gets this
  right ("kept, review manually"). Should be `advise` with the replacement
  spelled out.
- ~~**A version pin makes `.katana/_aio.md`'s own instruction unreachable**~~
  (llama.master §5, quant §7) — **DONE 2026-09-08.** Both halves were the same
  defect: the instruction named `dep/aio/feedback/`, which is absent from a
  release worktree AND inside the version store, so an app that pinned had
  nowhere to write and an app that upgraded lost what it had written.
  `am
  feedback` is now the one decider for the path — outside the version
  store, `$AIO_FEEDBACK_DIR`/`XDG_DATA_HOME` aware, with `--create` from a
  template — and the kata names the command instead of a path that drifts. The
  guard that matters asserts the location is not under `versionsDir()`.
- **Adding a state key gives no migration signal either way** (llama.master
  §10). A new field is safe — a stored blob without it deep-merges — but the
  author had to reason that out. The tool has both shapes: it could say
  `builds: 1 new state field, no migration needed` as readily as it says
  `shape drift: 1 stored field(s) no longer match`. Silence on the safe case and
  a loud warning on the unsafe one are indistinguishable from "nobody checked".
  §17 is the same ask one step further:
  `cfg: +1 field (safe), -1
  field (needs onMigrate)`, and offer the stub.
- **The 100-msg/sec WS budget is tripped by a legitimate burst** (risoto §10). A
  demo seed of ~1000 accounts made the sync scheduler exceed the per-connection
  budget; observed live, the renderer froze on the pre-burst state while the
  server moved on, and a later dispatch was invisible to the client. The budget
  is right as an anti-abuse default; the gap is that a one-time seed hits it and
  the failure mode is a silently dead socket rather than a slowed one. Coalesce
  patches within a tick before broadcast (N commits in one task ship as one
  frame), or allow a burst allowance before the 50-in-a-row close. `wsLimits` is
  the app-side workaround; the batching is the framework's to do.
- **A canvas app is invisible to `testUI`, and the workaround deserves a page**
  (anathomy §6). Under happy-dom `createEngine` returns null, so the entire 3D
  half of an app has no framework test. That is a fair limitation — but it
  leaves the largest, riskiest part of a canvas app with no blessed answer. The
  pattern that worked, found unaided: push the decisions out of the imperative
  shell, so "what should light up" and "what did the ray hit" are pure functions
  taking the renderer's knowledge as a parameter and only the GL calls stay
  untestable. One page in `docs/testing/`.

#### 11 · The dev audits ship to production (raised at beta1, not paid down)

beta1 raised the page ceiling 63 → 67 KB gz, and about half of that is
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

- `aio-ok` vs `aiol-ok` — one letter apart, two different checkers, placed by
  copying nearby code (vidtune §8.1). One marker with a scope.
- ~~An `aiol` rule for accessible names~~ (cc §9.4) — **DONE 2026-09-08.** An
  interactive element with no name gets no semantic path: absent from
  `am surface`, unreachable by `am trigger`, no handle in `testUI`. The runtime
  already warns for `<input>` at render time; this catches the ones a render
  never reaches. DELIBERATELY NARROW — one line, empty body, no naming attribute
  — because a name can come from a variable, a child component or a multi-line
  body, none of which is knowable from source. Ten cases pin the SILENCE as hard
  as the finding: text content, five naming attributes, an `id` that may pair
  with `<label htmlFor>`, a multi-line body, and `aio-ok`.
- The bundle auditor false-positives on path-shaped strings — a
  `placeholder="/home/you/documents/cv.pdf"` was reported as a 404 (newjob §6).
- `am trigger … press "Enter"` refused on a visible, focusable `<input>` (newjob
  §6).
- ~~`am stop` could not find a demonstrably running app; `--port=N` worked~~
  (newjob §6) — **DONE 2026-09-08.** Two halves. `am stop <appId>` now works at
  all (see the positional fix above — an id from `am instances` used to be read
  only as a component label). And the "not running" refusal now NAMES what is
  running: one instance gets `did you mean --app=<id>?`, several are listed. It
  already pointed at `am instances`, and a pointer costs a round trip at the
  exact moment someone is staring at "not running" for an app they can see in
  their own browser.
- `am surface` prints ~8 kB as one unwrapped JSON line by default (vidtune
  §8.2).
- `am shot /path/to/file.png` — a positional ending in `.png` is a detectable
  mistake; suggest `--out=` (vidtune §8.4).
- A `worker: true` hint when a cell's tick exceeds a frame budget (quant §3),
  and the module-graph checker's output in the default build summary.
- A documented known-good Electron switch set for headless and VM hosts (quant
  §7, §9.7) — one console crash-looped on a GPU abort every ~90 s until it got
  `LIBGL_ALWAYS_SOFTWARE=1`.
- `feedback/` lives inside the versioned directory, so an upgrade deletes it
  (quant §7) — the tooling costs the project exactly the reports it wants.
- A CI recipe for an app built on aio (newjob §8.9).
- `deno task am migrate --from=alpha76` for known renames (risoto §22.7).
- A named way to keep a cell out of the dev action journal, distinct from
  `persist` (quant §7, and see `refused.md`).

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

**Found while cutting v1.0.0-beta1; fixed the same day.** Kept because the shape
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
