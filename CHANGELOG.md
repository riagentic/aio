# Changelog

## 1.0.0-alpha42 — the pin is the promise (2026-08-01)

An app built on aio today must still build and run years from now, on a machine
that has never seen it, with the framework many releases ahead. That guarantee
does not come from staying compatible forever — it comes from every app naming
the framework it was built against, and from that name still resolving. This
release closes the gaps where the name was missing, ignored, or unexplained.

### `am fix` seals an unpinned app

An app without `"aioVersion"` in its deno.json linked to whatever aio happened
to be installed — which is exactly how a working app dies on a version it never
asked for. `am fix` no longer merely advises: it records the version it is about
to link, and says so.

```
✓ aio version pin — was unpinned — recorded "aioVersion": "v1.0.0-alpha41" in
  deno.json so every future clone rebuilds against this exact framework
```

`am create` already pinned; this is the safety net for everything else. It never
overrides a pin you chose (an app held at an older release stays there),
`--dry-run` writes nothing, and it is the ONE committed-source edit `am fix`
makes. Change it any time with `am pin <version>` / `am pin --latest`, which
still refuses to cross a major on its own.

### The one-liner builds with the aio the app pins

`run.sh` / `run.ps1` fell back to the _installed_ framework's builder for an app
without a scaffolded `compile` task — silently building it against a version it
never asked for. Both now prefer the app's own `dep/aio` (which `am fix` has
just pointed at the pin), and say so when they cannot. Proven differentially in
`test:onboard`: the installed builder is sabotaged, so any regression that
reaches for it fails loudly.

### One record of what was removed, and the way out

`machine:`, `actions:`, `reduce:`, `execute:`, `generators:` and the 2-arg
`aio.run(state, config)` were removed in alpha27, and three surfaces described
that in their own words — the runtime throw, the aiol check, the upgrade guide —
free to drift. `src/state/removals.ts` is now the single decider, and every
message carries BOTH exits, including the one that was invisible before:

```
[mdview] cell config key 'machine:' was removed in alpha27 — guards are a guard
line — `if (s.status !== "idle") return;`. Migrate: docs/upgrade/restructure.md
— or run it unchanged on the version it was written for:
`am pin v1.0.0-alpha26 && am fix`.
```

`tests/removals-registry.test.ts` makes the registry unforgettable: no file may
announce a version-scoped removal it did not read from there, rows are
append-only, every `lastGood` must be a real git tag (an escape hatch that does
not resolve is fiction), and the runtime and the linter must agree row by row. A
future 1.x removal that skips the registry fails the suite, not the user.

### The ladder: `am pin` checks before it moves

Moving a pin forward is allowed to be work; it is not allowed to be a surprise.
`am pin <newer>` / `am pin --latest` now reads the app's own source through the
registry and refuses a move that would break it, with `file:line` and both ways
out. `--force` pins anyway. Moving _backward_ to a version that still accepts
the old spelling is silent, and `main` counts as the tip.

`am pin` and `am fix` also report how far behind a pin is
(`3 release(s) behind
v1.0.0-alpha42`) — advisory only. A pin is a promise, not
a prison.

### An artifact identifies itself

`--version` printed `aio 1.0.0-alpha42` — which answered neither "what is this
binary" nor, for a compiled app found on a server months later, "which app". It
now prints `<appId> <appVersion> (aio <framework version>)`. A running app
already reported the framework build at `/__aio/health`; this closes the same
question for a binary that is not running.

### Gates

- `tests/removals-registry.test.ts` — 13 tests; mutation-checked both ways
  (hardcode a removal message → red; delete a row → red)
- `tests/am-pin-seal.test.ts` — `am fix` driven as a subprocess against a real
  clone with real tags and real worktrees: seals, reports, is idempotent, and
  never overrides an author's pin
- `tests/run-sh-e2e.test.ts` — the one-liner builds through the pinned worktree,
  and its no-`compile`-task fallback reaches for `dep/aio` before `$AIO_HOME`
- `tests/am-pin-preflight.test.ts` — the upgrade check: forward moves blocked
  with file:line, backward moves silent, `main`/path pins treated as the tip,
  the framework's own `dep/aio` never scanned, row-driven over the registry

## 1.0.0-alpha41 — catching up (2026-07-31)

A field report put it precisely: "aio's failure modes tend to be silent rather
than loud — the philosophy is right, the implementation hasn't caught up
everywhere." This release is the catching up: an adversarial review of alpha40,
a structural hardening pass, one new headline feature, and every item from the
space-invaders field report — each fix behind a guard that makes its whole bug
class unshippable.

### One line runs any aio app from source

`curl -fsSL …/run.sh | sh` in an app repo = production build of the default
target, running. `--dev` for the dev server; `--git <url>` (or `owner/repo`)
clones, installs deno/aio/am, repairs the checkout (`am fix`), builds, runs. The
artifact is found by timestamp, never by name, so the script cannot drift from
the framework's naming rules. `run.ps1` mirrors it on Windows. Offline e2e in
`test:onboard`.

### The alpha40 review, and the fuzzer it left behind

Four review agents reproduced real corruption bugs in released alpha40 — the
beta streak resets to 0, by its own rule. Fixed and property-tested:
transactional conflict detection had three tracked-read escapes (a path
published by `s.$commit()` was exempt forever; `.find()` recorded no read; root
enumeration never overlapped) plus a false abort on read-only stand-downs; patch
narrowing corrupted overlapping-path batches; conflict aborts are typed
(`TX_CONFLICT`).

The lasting guard: a randomized **differential fuzzer** runs the same method
body as a sync method (Immer draft) and an async method (live proxy) and
requires identical state and reads. It immediately found two more: recorded
mutation payloads were installed by reference and destructively replayed, and
`{...s.obj}` copied nested live proxies into the recording (unbounded
recursion). Both fixed — and as a consequence **assigning proxy-derived values
back into state now simply works**, identically to sync. The oldest documented
footgun (and its aiol rule) is gone.

### The config bridge can no longer drop an option

The hand-maintained CellsConfig→AioConfig copy silently dropped FOUR shipped
options over its life (`strictOrigin`, `redactActions`, then found now:
**`appDir` — logs went to the configured directory, all data to the default
one** — and `renderBudget`, which was validator-legal, untypeable and never
bridged). The bridge is now a mechanical spread filtered by the runtime's own
whitelist, and the completeness test is a runtime sentinel gate: one value per
documented option goes in and must come out.

### `await cell.method()` — the browser side, unified

The browser had its own hardcoded 15s ack ceiling with a guessed cause ("server
overloaded or disconnected") — below every server ceiling, so the server's
honest timeout could never reach a browser caller. The resolved
`effectTimeoutMs`/`perfBudget` ceilings now ride the page shell and the new
`cfg` frame; `0` waits indefinitely; offline-queued calls start their clock when
the frame is sent, not when queued.

### Sync cells: durable, seeded, and visible

A server-origin write (effect, cron, `serverFn`, an async method's outcome) now
folds into the cell's sync snapshot — debounced 100ms, flushed on clean
shutdown; a restart never rewinds a write the server confirmed. Flipping
`localFirst` on an app with existing data seeds the sync store from the restored
state instead of erasing it. Actions-style cells are no longer adopted into a
mode they cannot replay. The SPA deep-link shell carries `syncCells` (one shared
shell closure). And the new C→S `cdiag` frame relays browser `degraded()`
escalations, so `/__aio/health` reports `clientDegraded` instead of claiming
health while a browser subsystem is dead.

### The space-invaders report — every item

- **A cell rename can no longer destroy data.** A stored-but-undeclared cell's
  slice is preserved in every persisted document, stripped from runtime state,
  announced at every boot; a rename migration is one `onRestore` hook (read the
  old slice, move, delete to consume).
- **Time travel stops cloning what is already immutable.** An entry stores the
  committed frozen tree by reference — structural sharing, zero copy; the ~1
  MB/s `structuredClone` at 60 fps, the 100KB cap and its size-sampling are
  gone; window 200 → 2000; `diagnostics.skipActions` keeps a tick action out of
  history.
- **`am` can no longer silently retarget.** `--port=N` verifies the responder's
  `/__aio/health` appId and refuses a mismatch; the lock/socket dir scopes with
  `AIO_APPS_DIR`, so one env var isolates an instance completely; `am start` of
  a GUI client on a headless box fails fast.
- **`useCell` is deprecated where it bites** (its `.state` is a live view —
  stash-and-diff compares state to itself), and aiol flags usage.
- **testUI holds keys**: `ui.X.keyDown/keyUp`. `expectCell` retries and names
  `scope:'client'` instead of blaming the predicate. **`useInterval`** is the
  client-cadence idiom. The pressure hint names `scope:'client'`.
- New docs: `docs/state/real-time.md` (at what cadence does state belong where —
  with the measured hot-cell commit cost) and `docs/debugging/time-travel.md`.
  `docs:check` now resolves every `docs/….md` path cited in src/ comments (it
  caught three dangling refs on arrival).

### Surface diet and removals (alpha window)

484 → 467 public symbols: pre-methods relics (`draft`, `matchEffect`,
`UnionOf`), duplicate re-exports (`connectCliUDS` and `DEFAULT_PRAGMAS` off
extras, ship signing on `aio/build` only), `sha256Hex`, `authUser` off `aio/air`
(use `useUser()`), internal type triple off the main entry, and `./schedule` is
an explicit export list (cron plumbing off the surface). The legacy pre-v2 flow
residue (`FLOW_*` error codes, `FlowStepRecord`) is deleted — nothing produced
it since alpha27. New: `useInterval`, `TX_CONFLICT`, `degraded()` relay types,
`diagnostics.skipActions`.

Root housekeeping: historical `RELEASE_NOTES-*` live in `docs/release-notes/`,
the bench baselines in `scripts/`.

Gates: fmt, check, lint, lint:aio, boundaries, api:check, docs:check (with the
new inline-ref gate), bench:check, publish --dry-run, test (3103 passed / 0
failed), test:build, test:onboard.

## 1.0.0-alpha40 — silence is the bug (2026-07-29)

### Silence is the bug — the `errors` kata pass

`.katana/errors.md` says it plainly: aio fails loudly, never hides an error, and
checks that it is working rather than assuming it. This pass took the one
pattern a field report kept naming — "aio degrades quietly where it should fail
loudly" — and closed it case by case.

**A transactional method can no longer lose an update quietly.** `transaction`
pins reads at method entry; that is the feature, and it made a whole bug class
invisible: a guard on a field a SYNC method writes during the `await` could
never fire, and a read-modify-write committed over the newer value with nothing
said. A wallet shipped exactly that — a balance refresh overwrote a transfer and
stamped it confirmed. So the write-set is now validated at every commit, using
the model databases already agreed on: `transaction: true` is snapshot isolation
and checks read-modify-writes (a blind `s.loading = false` is last-writer-wins
by intent and never conflicts); `transaction: { serialize:
true }` is
serializable and checks every read. A conflict aborts the call with a message
naming the path — `conflict: "warn"` commits anyway, loudly, and there is no
option to do neither. `s.$live` is the sanctioned way to read current state on
purpose; writes through it still join the atomic commit. The old "documented
lost update" test now asserts the refusal.

**A restore that erases seeded state says so.** A persisted array replaces the
declared one wholesale, so a profile that once stored an empty list booted with
a curated token registry gone and every holding rendered as a raw mint. The
boot-time shape-drift detector — same facility, one more issue — now reports a
declared non-empty list replaced by an empty stored one, names the fix, and
stays quiet for the cases where nothing is lost (shorter lists, empty declared
lists, objects, which merge key-by-key).

**Reading a `ui.exclude`d field from the client throws in dev.** It used to warn
once and hand back `undefined`, which type-checks as the field's declared type —
a lock screen asked "does a vault exist?", got `undefined` forever, and behaved.
Dev and every test harness now throw at the read; production still degrades to
`undefined` with the same one-time warning.

**The dev browser is no longer aio's most permissive environment.** Every
`__aioDev` tripwire in the isomorphic core — frozen state so a component
mutation throws at the site, the readonly hint, the hidden-field guard — was set
only by the test harnesses. The dev page shell sets it now (never production),
so those bugs surface in the browser you develop in instead of later.

**Best-effort subsystems can't fail forever in private.** `degraded(name)` (also
`degradedReport()`) counts consecutive failures of a named operation and
escalates exactly once — one structured event, not per-occurrence spam, which is
what made the original invisible — plus one on recovery. `/__aio/health` reports
`status: "degraded"` and names them, because an app claiming to be healthy while
a feature is dead is the failure the endpoint invites. aio's own worst
swallow-cluster is the first user: every browser CRDT sync frame was a
`.catch(() => {})`, so the sync layer could fail continuously behind a clean
console. Offline-queue writes now report when an action will not survive a
reload, and a queue that replays but fails to clear says that it will replay
again.

**A guard that fires on the framework's own code is a false alarm.** The first
field result of the hidden-read throw was aio tripping it: all three binding
paths asked "does a method own this name?" with `typeof def[key] === "function"`
— which READS the property, invoking whatever accessor is installed. By the
second bind of a cell that accessor is the reactive getter from the first, so
the framework read the app's `ui.exclude`d field and threw, naming the app for
something aio did. It took an entire UI suite offline (512 passed / 298 failed →
785 / 25 once the probe was fixed). The question is about SHAPE, so it is
answered from the property descriptor and never touches a value — which also
ends a quieter bug: reading through the getter called `trackPath()`, so binding
a cell subscribed whatever reactive context happened to be current.

**`await cell.method()` no longer invents a cause or hides the outcome.** The
30-second wait was hardcoded, and its error said "the effect executor may have
crashed or never resolved this call" — almost never true. The method was simply
still running, and it kept running: its writes committed later, unannounced, on
top of whatever the caller did next (a production incident: an NFT queue
starting new work on top of live work). The message now states what is true —
the CALL gave up, the METHOD did not, its writes will still commit, only the
return value is lost — and names the knob.

There is also only one knob now. `effectTimeoutMs` bounded the effect tracker
while a second, hardcoded 30s bounded the caller, so raising it left the caller
giving up on schedule: a setting that looks like it worked. Both sides resolve
from `effectTimeoutMs` and `perfBudget.methods["cell:method"].timeout`, and `0`
waits indefinitely.

### Local-first, opt-in

`aio.run({ localFirst: true })` makes every server cell run its methods where
the caller is and travel as CRDT ops; the server re-runs each op and stays the
authority, so guards, `access` and `validate:` decide exactly what they decide
today. `sync: false` is the per-cell opt-out for anything whose optimistic
preview would be a lie. Boot logs which cells were adopted — a switch that
silently relocates every method in the app is not a decision to make invisibly.

The client half is where this kind of feature usually half-lands: the decision
is resolved on the SERVER at compose time, so the browser is told in the page
shell, and adopts through the cell def's own `enableSync`, which sets the sync
config and the replay reducer together or not at all. Both client-side callers
that decide "does this cell sync" — the transport gate that loads the engine and
the engine's own boot — now go through one resolver; they disagreed at first,
and the result was a server logging "1 cell runs locally" while every method
kept round-tripping. Measured, not claimed: a real chromium click on an adopted
cell lands in the op-log, and the same app without the switch produces no ops at
all.

### The cell-binding triple is gated

A cell has three bindings and the browser's `cell()` is a separate
implementation, so a per-cell fact the client branches on has twice been added
to two of the three and shipped broken (`asyncMethods` → `await` resolving
`undefined` in a browser; sync config without its reducer). Any `__aio` key
client code reads must now be produced by the browser stub or carry a written
exemption, and the two catalogs are pinned to the same async classification and
public action keys.

### A list that SHRINKS no longer re-ships itself either

alpha39 narrowed a whole-array `replace` to its appends. The same shape covers
the rest of how lists are rebuilt, and the case most worth winning was missing:
a `filter` dropping three items from a 500-item list matched no common prefix or
suffix, so all 500 shipped again. `diffArray` now walks both arrays once,
matching by identity — 3 ops instead of 500 items — and `slice`, an insert, and
a removal in the middle all narrow too. A REORDER and DUPLICATE identities still
ship the whole replacement on purpose: Immer's patch format has no `move`, and
"is this element needed later" has no single answer when it appears twice. The
cost model was fixed rather than extended (an `add` carries an element, a
`remove` only an index), so truncating 10k items to one sends the one, not 9,999
removes. A 400-round randomized equivalence check with Immer's own
`applyPatches` as judge backs the whole path.

One latent bug came out of attacking that change rather than from a caller:
narrowing diffed every op against the ORIGINAL state, so two ops on the same
array path in one batch — the second relative to the first's result — appended
the same element twice. Immer emits one op per path per commit, so neither
caller could reach it; the function is exported and a merged or replayed patch
list is an obvious thing to hand it, so it is fixed rather than documented.

## 1.0.0-alpha39 — pin it, price it, redact it (2026-07-28)

### A list that grows no longer re-ships itself

`s.items.push(x)` already travelled as one `add`, but the equally idiomatic
`s.items = [...s.items, ...batch]` is a `replace` carrying the whole array — so
a list growing to 10k items re-sent all 10k on every commit, quadratic over a
scan. A hardware-wallet scan had to hand-throttle its own state writes to stay
under vitals PRESSURE because of it.

Whole-array replacements are now rewritten as their appends, at the seam where
patches are born (the composed reducer) — the last place the PREVIOUS slice is
still in hand, since by broadcast time only the new state is left and the prefix
can no longer be proven. Only the unambiguous case is touched: the old array is
a prefix of the new one **by identity**, and the tail is cheaper than the array
it replaces. A reorder, an in-place edit, a shrink, or a fresh array of
equal-looking objects all fall through as the original `replace` — a wrong guess
here corrupts state rather than merely costing bytes.

### Worker cells work in compiled binaries — and always did

`cell-worker-pool` warned that "compiled binaries don't support cell workers
yet", and it was wrong: Deno embeds the entry and reports it as `file:///…`, so
a compiled app takes the normal path and its worker cells really do run
off-isolate. The claim outlived the constraint by a long way, and it was in the
docs and the roadmap as a known limitation. `test:build` now measures the
isolation in a real compiled binary rather than trusting a log line.

Also compiled-binary-only: `deno compile` cannot trace a bare specifier behind
`await import()`, so the lazy `@std/path` in the title resolver was not embedded
and threw inside the binary — swallowed by a catch, leaving the app with the
"AIO App" fallback title as though it had simply found no `title` field. Now a
static import.

### `am` accepts `--flag value`, not only `--flag=value`

`am dispatch … --body '{"a":1}'` silently passed the literal `--body` as the
method's first argument, which then failed inside Immer — reading like a bug in
the app rather than a mistyped command. Flags that require a value now accept
both forms. Flags whose value is optional (`--wait`, `--client`) deliberately do
not: there, `--wait 5` cannot be told apart from `--wait` plus an argument.

### The suite gets a fresh app home every run

Tests spawn real apps, and a real app writes durable files — `state.db`, the
CRDT op-log, `launch.json`. The suite pointed those at `.aio-test-home` and
never cleaned it, so they accumulated across runs while `appId` stayed fixed.
That is a wrong-answer machine, not untidiness: `e2e-sync-browser` asserted
"exactly one op in the op-log", gained a row per run, and therefore passed
exactly once on a virgin machine and was red forever after — while staying green
on CI, which always has a fresh checkout. It was read as a flake for a long time
and "fixed" with polling, which could not have helped. One reset before each run
removes the class; within a run tests still share the home, since some
deliberately hand state to each other.

### `redactActions` — one list, every place an action is recorded

`journalRedact` is now **`redactActions`**, and it covers all three sinks: the
durable journal, the in-memory timeline `am timeline` prints, and
`logs/actions.jsonl`. The old name shipped in no release; a config key that says
"journal" while governing three recorders would be a lie in an API whose whole
job is a security guarantee.

The reason is the more interesting part. Redaction was added because a wallet's
`journal: true` wrote its unlock passphrase to `vault.db.journal` in cleartext,
next to the AES-GCM vault it opens. That fix covered the journal — and the same
passphrase stayed in the timeline ring, where `am timeline` prints it and no
lock-and-wipe can reach it. **A redaction that covers only the sink you thought
of is worse than none, because it is believed.** So the predicate is now built
once at boot and handed to all three; they cannot diverge.

Also fixed while testing it: **the option never worked at all.** `redactActions`
was typed, validated, documented and read by the journal — and the CellsConfig →
AioConfig bridge never copied it, so
`aio.run({ journal: true,
redactActions: [...] })` wrote the passphrase to disk
regardless. The unit tests passed because they tested `createJournal` directly
instead of a booted app.

This is the second option lost at that bridge (`strictOrigin` was the first), so
it is now a gate rather than another one-line patch:
`tests/config-bridge-completeness.test.ts` fails when a `CellsConfig` key is
neither carried across the bridge nor recorded — with the consumer that reads it
— as deliberately exempt, and fails again when an exemption names a reader that
no longer exists. A silently dead config option is not shippable.

Details: a redacted action keeps its type, seq, timestamp and the state
**paths** it changed (replay ordering and `am timeline`'s "what did it touch"
are unaffected); its payload and the before/after values it wrote become
`"[redacted]"`. A trailing `*` matches by prefix (`vault:*`) — a list of
individual method names is the list that goes stale the day someone adds
`unlockWithFile`, and a stale redaction list fails open.

### Diagnostic artifacts have a lifecycle

Turning `actionLog` or `checkpoint` off stopped new writes and left everything
already written — in one real case a passphrase, world-readable, indefinitely.
Off now means the artifact does not exist: aio removes its own
`actions.jsonl`/`checkpoint.json` at boot when the writer that owns them is
disabled, including when diagnostics are off wholesale, and says so at info
level rather than deleting quietly.

### Three things that were harder to diagnose than they should have been

- **Every full-state broadcast now says why** at debug level. The size-threshold
  path already did; the fallback did not — which made the expensive case the
  invisible one (438 KB frames, 28 of them in 20 s, nothing in the log pointing
  at them). It now names the reason: a `"full"`-strategy cell, a round with no
  patches, or no patch matching that client's subscriptions.
- **"cell worker did not become ready"** no longer leads with "does the app
  entry call `aio.run()`?" — the one thing that is almost always true, and a
  bisect to rule out. A worker cell re-imports the app entry, so every top-level
  side effect in it runs again inside the worker before the handshake; ~20 ms of
  file I/O was enough to stall boot. The message says that, and names the guard
  (`isCellWorker()`).
- **`dbPath` outside the app home warns once.** It moves only the database:
  `auth.db`, `tls/`, `meta.json` and the journal stay where they were, so an app
  that resolves its own data root ends up with two homes and a complete, stale,
  unguarded copy of its database in the one it stopped looking at. `appDir`
  moves everything; the warning says so at the moment the split is created.

### `am cost` — the number behind aio's own warnings

aio tells every app its state might be too big, in three subsystems — `aiol`'s
typed-array hint, its "N state keys across M cells" summary, the pressure
monitor's "reduce state size, raise syncIntervalMs, or use cell-level ui
filters" — and ships all three remedies. It gave nobody a way to find out
whether they had the condition. The consequence, reported honestly: _"I have
been told about my 91 state keys on every `aiol` run for four rounds and have
ignored it every time, because acting means a refactor and I could not tell
whether the warning applied to me."_ A hint that cannot be triaged trains people
to skim — the same argument that got `aiol`'s `tests/` blindness fixed.

```
$ am cost
cell  pushes/s    bytes/s     mean  p95 reduce   state  top keys by bytes
hw         1.0   7.7 KB/s   7.7 KB      0.4 ms  7.9 KB  cpuHistory 2.1 KB · coresUtil 1.8 KB · gpus 1.4 KB
chat       0.0          —        —      3.1 ms    15 B  (idle)
──────────────────────────────────────────────────────────────────────────────
per client             8.1 KB/s
clients connected         3  24.3 KB/s   (all surfaces)
full resends       10%  2 of 20 state pushes (+5 acks/diagnostics)
```

`--json`, `--cell=X`, `--window=5m`, `--keys`. Always on: bounded rings on a
path that already serializes, because this question gets asked _after_ something
feels slow, and an opt-in diagnostic is never enabled then.

**Why it is in the framework at all.** Total bytes an app could measure itself
(attach a socket, count). Per-cell, per-key attribution it cannot: which cell
caused a push and which keys were in the diff exists only inside the broadcast
path. "You push 24 KB/s" makes you worry; "19 KB of it is `hw.cpuHistory`" tells
you what to do. That narrower claim is the one that clears the bar.

**Correct, or not shipped.** The acceptance condition was explicit — _"a cost
number that is plausible but wrong is worse than no number, because people act
on it"_ — so the wire totals are the exact byte length of every frame handed to
a socket, and a test holds them against a real WebSocket client counting its own
inbound bytes: **they must be equal, not close**. Building it to that standard
caught two bugs in the measurement itself:

- Metering the broadcaster missed the handshake, acks and diagnostics — 686 B
  reported against 9805 B actually received. The meter moved to the socket,
  which is the one place every frame passes through.
- Classifying every non-patch frame as a "full resend" turned a wall of 40-byte
  acks into the headline _"71% — most frames send the WHOLE state"_. It is 9%.
  Acks and diagnostics are now their own category: real wire bytes, not state
  pushes. Both mutations are covered by tests.

Per-cell attribution counts payload **content**; wire totals include the
envelope and JSON-Patch paths. They are reported separately and never added,
because the sum would be a number that looks right and is not.

### Round four — the three open defects, plus the harness for aio's own claim

- **`skipIfRunning` reached the wrong API.** It shipped on the imperative
  `schedule.every(id, ms, action, opts)` and was absent from **`ScheduleDef`** —
  the declarative shape `aio.run({ schedules: [...] })` takes, which is what
  `am create` scaffolds, what the docs show, and what every long-lived poller
  uses. Not types-only: `start()` never forwarded it either. So the feature
  written to delete the hand-rolled `if (s.refreshing) return` landed where
  nobody could reach it. Now on both.

- **A `perfBudget.methods` key naming a method that doesn't exist is reported.**
  One app declared 17 per-method budgets adopting the feature; one named no
  method at all and had never applied to anything. Nothing would ever have said
  so — the symptom is a violation naming the METHOD, which sends you to read the
  method instead of the config. Same class as `strictCells` one layer up: it
  throws under `strictCells`, warns otherwise, and lists the cell's real
  methods.

- **`absent()` called a component that rendered `null` "present".** It has a
  surface node (it ran) but put nothing on screen, and "did it render anything"
  is the question being asked — the docstring's own example was the failing
  case. Now: showing = an element, a child that shows something, or text.

- **`testMultiClient` — aio's central claim, made testable.** The promise that
  sells the framework is that an Electron window, a browser tab and `am` all
  read the same state with no transport code. A shipped app with two of those
  clients reported: _"I have never tested two of them at once, because there is
  nothing to test them with… so the claim I lean on hardest is the one my
  281-test suite says nothing about."_ Now: N real WebSocket clients over one
  real server, with `converged()`, `dispatchAll()` for the same-action-same-tick
  case, and per-client views. Nothing simulated — a harness that faked the
  transport would report success for the one thing it exists to check.

  Building it caught two bugs in itself, which is the point of writing tests
  against real transport: `converged()` could pass **trivially** in the window
  between a send leaving a socket and the server seeing it (every client still
  agrees — because nothing has happened yet), and `dispatchAll` used a fixed
  sleep that made correct behaviour look like a lost update at 20ms and correct
  at 60ms. Both now wait for the work, not the clock.

- **A vanished log directory heals itself.** Delete an app's log directory —
  `/tmp` cleaned, a deploy replacing the tree, a test removing its sandbox — and
  every subsequent line failed with `[logger] write failed`, so the app lost its
  voice until restart. It now recreates the directory and retries once; a
  genuinely unwritable path is still reported.

- **Persisted-state schema evolution is documented.** The behaviour was defined
  all along, in the restore merge, and never written down: a removed field is
  dropped, a retyped one keeps the schema's default, a rename is a remove plus
  an add (carry it with `version` + `onMigrate`), and an empty-object schema
  means "dictionary — keep every key". Now a table in
  [auto-persist](docs/persistence/auto-persist.md), pinned by tests so the docs
  cannot drift from the merge.

### llama-master's open list — closed, with two refusals

Working the incremental report's remaining items. Rule of thumb applied
throughout: an item is accepted when it makes the FRAMEWORK more correct, and
refused when it would only make one app shorter.

- **Selectors work under `testCell`.** `models.visible()` threw "not a function"
  in the tool that presents itself as the unit-level one, while working in
  testUI, bootCells and production — an inconsistency, not a design, and it
  pushed any test touching a selector out to `bootCells` for no visible reason.
  The binding is restored on teardown, so a later harness in the same file
  re-binds for real.

- **`AppDirs.cache` is back.** Removing it asked "does the framework write
  here?" when the right question is "does the layout PROMISE apps a place for
  regenerable bulk?" It does — that's what tier ② means — and one app had 20 GB
  of it, so the choice was hand-computing the path (which it did) or putting the
  bulk in `data/` and doubling every backup. The docs described the field the
  whole time; the code was the thing that was wrong.

- **`aiol` no longer warns about an `appId` you already moved.** It reported
  "move to aio.run({ appId })" at apps that pass it there — describing work
  already done. Now that case is a hint about the harmless duplication, and the
  `--safe-fix` codemod is only offered when the move genuinely hasn't happened.

- **Per-method perf budgets.** The effect budget couldn't tell "slow because it
  awaits cmake for four minutes" from "slow because it blocks the loop", so an
  I/O-heavy app raised both budgets globally and "lost the signal everywhere to
  silence one poller". `perfBudget.methods["cell:method"] = { effect, timeout }`
  keeps every other method strict, and a violation now names the method rather
  than the shared `cell:__exec` effect type.

- **`schedule.every(id, ms, action, { skipIfRunning: true })`.** Every polling
  cell opened with `if (s.refreshing) return`. Hand-rolled, that guard needs a
  state field and a reset in a `finally` — and if the tick throws in between,
  the flag stays `true` and the poll is dead until a restart. The scheduler
  already knows when a dispatch settles, so it owns the whole thing, clearing on
  rejection too. Opt-in: silently dropping a tick that used to fire would be a
  behaviour change, and some schedules overlap on purpose.

- **`testUI(App, "name", opts, fn)`.** Adopting `seed` meant rewriting one-line
  tests into the handle form by hand.

- **A `waitFor` timeout is readable again.** It stringified the entire surface,
  uncapped — tens of KB per failure, with the assertion scrolled away. Now: a
  named tree first, the JSON only when it's small enough to help.

**Refused, with reasons.** `own.set` returning a value into state would punch a
hole in `(state, action) → (state, effects)` — the factory can call a cell
method with what it learned, and that pattern is now documented instead. A
`progress` primitive stays out: three features needing the same shape _inside
one app_ is an app-level helper, and the danger that made it feel urgent (the
silent proxy write) is already gone.

### llama.master, round two — the friction found by building 1000 more lines

The same app came back after another ~1000 lines, four kata audits and a suite
grown 208 → 271 tests. Its verdict on the previous batch: **7 → 9.2**, every one
of the eight items verified fixed in their own app, three of its own claims
withdrawn with evidence. What follows is the new list.

- **`aiol` was blind to `tests/`.** It scanned `src/`, `cells/` and the project
  root — never the directory aio's OWN convention mandates ("tests all live in
  `tests/`, never beside their source"). So an app with 271 passing tests was
  told `Tests: 0` and "cell X has no test file" for every cell: 8 of its 14
  hints were this one false positive. The cost isn't the wrong number — _"a
  linter which is confidently wrong about 8 items trains you to skim the
  other 6. I nearly missed a genuine post-await hint in the noise."_ Tests are
  now collected (separately from app sources, so app-code checks don't start
  flagging fixtures), and a cell defined inside a test counts as a fixture, not
  app surface.

- **`testUI({ seed })` — state a cell would otherwise get from the machine.**
  The biggest ask, and it "bit me three times today": a cell populated from real
  telemetry made its UI untestable, because "does a stranded CPU-only placement
  get called out" either ran against whatever the developer's GPU was doing that
  second, or didn't run. That report ended up deriving the expectation at
  runtime and asserting whichever branch the hardware chose. `seed` installs
  state before the first render (per-cell shallow merge over the declared
  initial state); `ui.seed()` moves it mid-test. An unknown cell name throws,
  listing what booted — a silently-ignored seed looks like a pinned fixture
  while testing nothing.

- **`ui.absent(name)` / `ui.present(name)`.** "This component is not rendered"
  was `assert(!ui.html().includes("placement-advice"))` — stringly-typed, and it
  keeps passing for the wrong reason after a class rename. Composes with
  `waitFor`.

- **A component can carry a `t` handle.** Renaming `CtxPresets` → `CtxControls`
  broke a test that addressed the component by its identifier — a refactor, not
  a behaviour change. `t` was already the recommended handle for elements. It is
  **additive**: the function name stays authoritative, because `t` is also a
  legitimate data prop that components forward to inner elements (this repo's
  own toolbar fixture does exactly that, and overriding the name broke sibling
  de-duplication — caught by the existing tests).

- **`am surface --component=X / --path=A/B / --depth=N`.** One page serialised
  to a 32 KB single-line blob and reading one component out of it meant piping
  into Python — the one place `am`, "the best debugging tool I have used in a
  framework", still forced a script. A filter that matches nothing exits
  non-zero and lists the components that ARE there.

- **`<fieldset disabled>` and friends are typed.** `disabled` on a fieldset is
  _the_ way to lock a form section, and it wasn't in the attribute map. Fixed
  with a bounded audit of the elements whose attributes change behaviour:
  `fieldset`, `optgroup`, `details`, `dialog`, `progress`, `meter`, `td`/`th`,
  `video`, `audio`, `canvas`.

- **`afterRender` + `useRef` is documented** as the "re-derive when inputs
  change" pattern, including why it settles in one extra pass and the rule that
  keeps it from looping (the reaction must not change anything the key is
  derived from). It was found by reading AIR's source, which is a docs failure.

### An app pins the aio version it was written against

`am create` scaffolds an app that imports the framework through a gitignored
`dep/aio` symlink. Portable `deno.json`, but the repo said **nothing** about
which aio it was written for — so a clone a month later linked to whatever
version happened to be installed, and "it compiled last month" was not a fact
anyone could reproduce.

Now the version is recorded in the app, committed with the code:

```jsonc
{ "aioVersion": "v1.0.0-alpha38", … }
```

```sh
am create my-app                          # pins the newest RELEASE (not the tip)
am create my-app --aio-version=main       # …or follow the branch tip
am pin                                    # what this app uses, and what's available
am pin v1.0.0-alpha38                      # switch: provision, relink, record
am pin --latest
```

The clone path is now reproducible on a machine that has never seen the app:
`git clone && am fix && deno task dev` reads the pin, provisions that exact
version, and links it.

**Multiple versions coexist.** `install.sh` clones aio with full history, so any
tag is provided as a **git worktree** under `~/.local/lib/aio-versions/<tag>/` —
~8 MB of source per version, git objects shared rather than re-downloaded, and
several apps on one machine can pin different versions simultaneously.
`AIO_VERSIONS_DIR` moves the store (containers, CI).

**Built to survive aio's own majors.** Three rules, each of which a naive
"latest tag" implementation gets wrong: a committed pin is always **exact**
(`am pin main` records `main-<commit>`, so "follow main" is an action you
re-run, not a stored state that mutates an app's framework behind its back);
`--latest` means newest **within the app's major**, with `--major` to cross
deliberately; and versions are ordered by **semver, not tag date** — this repo
already contains an abandoned `v1.0.0-beta1` tagged before `v1.0.0-alpha38`, and
post-1.0 a maintenance release can be tagged after a new major.

**The pin covers the framework's dependencies too.** A source-layout app's
import map supplies the bare deps aio needs (`immer`, `esbuild`, `@std/*`)
because `dep/aio/**` resolves through the _app's_ map. aio pins `immer@10.2.0`
while a scaffolded app said `^10` — so the day aio needs `immer@^11`, that app
would break at runtime while claiming to be pinned. `am pin` now copies the
exact versions the pinned release declares, and prints each change; deps the app
never declared are never added.

**Only releases that actually happened are pinnable.** A version tag has to be
reachable from `origin/main`; a tag on an orphaned commit names a release that
was abandoned. This is not hypothetical — the first live run of `am create`
after the ordering fix pinned `v1.0.0-beta1`, an abandoned local feature-freeze
tag from three weeks earlier that out-ranked the real latest release by semver.
The ordering was right; the data wasn't. (The stale tag is deleted; it was never
pushed.)

**A created app is pinned all the way down.** The scaffold writes dep ranges
(`immer@^10`) while the framework pins exact versions, so `am create` now syncs
them at scaffold time too — otherwise a brand-new app was half-pinned from birth
and only `am pin` fixed it.

**Drift is a failure, not a note.** `am pin` exits non-zero when `dep/aio`
points somewhere other than the pin (usable as a CI check), and `aio doctor`
fails the `framework pin matches dep/aio` line. `am fix` corrects it, and
reports an unpinned app as something to fix rather than staying quiet about it.

Two escape hatches stay: `--aio=<path>` / `am create --mirror` link a live
checkout for framework development, and a real directory at `dep/aio` is treated
as a vendored copy and never replaced.

Also: `journalRedact` (from the same cycle) is now in the API snapshot — it had
landed in `CellsConfig` without regenerating it, which the gate caught.

## 1.0.0-alpha38 — one directory (2026-07-28)

Everything an app writes now lives under **`~/.<appId>/`**, and the one part you
have to back up is **`~/.<appId>/data/`**. Migrated automatically on the first
boot; the wire protocol is untouched, so alpha37 ↔ alpha38 interoperate.

Before this, one app scattered its durable state across four locations, and two
of them changed when you compiled it:

| Before                            | After                      |
| --------------------------------- | -------------------------- |
| `./data.db` (next to the project) | `~/.<appId>/data/state.db` |
| `~/.local/share/<appId>/auth.db`  | `~/.<appId>/data/auth.db`  |
| `./.aio-tls/`                     | `~/.<appId>/data/tls/`     |
| `./.aio/log/`                     | `~/.<appId>/logs/`         |

Copying either half alone lost the other, and "where is my data" had a different
answer in dev than in production. Now there are three tiers and the boundary
between them is exactly "what a backup contains": ① `data/` — critical, `0700`,
nothing here is recreatable; ② `logs/` + `launch.json` — regenerable, delete
freely; ③ `$XDG_RUNTIME_DIR/aio/` — socket, pid and lock, which must NOT survive
a reboot. `data/meta.json` stamps the appId and versions, so an archive is
self-describing.

**Migration** runs before anything opens a database, moves each SQLite file with
its `-wal`/`-shm` sidecars as one set, never overwrites an existing target, and
refuses outright while the app is running. Cross-filesystem moves copy → verify
size → unlink, so an interruption leaves the original intact. It prints every
move once. `--no-data-migrate` skips it.

**Where it goes** — two knobs, one rule each: the author names one app's folder
(`aio.run({ appDir })`), whoever runs it names the root all apps sit under
(`AIO_APPS_DIR=/srv/aio` → `/srv/aio/<appId>`), and with neither it is
`~/.<appId>`. The environment variable earns its place because the person moving
the data usually can't edit the code, and because a test suite spawns apps whose
ids it doesn't control. Dev and production resolve identically — compiling no
longer moves your data. `dbPath` still overrides the state database alone.

**Three new `am` commands** — the payoff of consolidation:

```sh
am data                 # every path, by tier, with sizes
am backup [dest]        # copy data/ (stop the app first, or --force)
am restore <dir>        # put it back
```

`am snapshot` (cell state as JSON, from the running app) is unchanged and still
different: this is the files, including `auth.db`, the app key and the TLS
material, none of which are cell state. What the commands add over `cp -r` is
two refusals: **backup refuses while the app runs** (a `-wal` file holds
committed pages the `.db` doesn't have yet, so a live copy can be internally
inconsistent — `--force` overrides and marks the result `tornRisk`), and
**restore refuses another app's archive** (`meta.json` records the appId) as
well as any restore into a running app, which would write its in-memory pages
straight back over the restored file. A restore **moves** the data it replaces
to `data.replaced-<stamp>` rather than deleting it.

**`am restart` now survives a reboot.** The launch record that lets `am restart`
replay an app's original flags (`--env-file` and friends) moved from
`$XDG_RUNTIME_DIR/aio/` to **`~/.<appId>/launch.json`**. The runtime directory
is cleared on logout _by design_ — right for the lock and socket, exactly wrong
for a record whose whole job is to outlive the machine. It sits with the app
rather than in a shared toolchain directory because those are _this_ app's
flags: "delete the app" stays one `rm -rf`, there is no second root to relocate
when sandboxing, and `AIO_HOME` keeps its one existing meaning (the framework
checkout `am link` binds to). Records written by an older `am` are still read.

**Two fewer places to look.** `am start`'s raw stdout+stderr capture moved from
`<project>/.aio.log` to `~/.<appId>/logs/stdout.log` — it was splitting one
app's output across two directories and leaving a stray file in every project
(`am log` still reads the old path for an app running from before the move). And
`cache/` is gone: it was created under every app on every boot and nothing ever
wrote to it.

**Tests: pin the data home.** An app that persists writes to `~/.<appId>`, and a
test that spawns a real app process inherits that — one suite run left 57 stray
dot-directories in a home directory, and the state inside them carried between
runs (a worker-persistence test started asserting 7 where it had written 2). One
variable in the task fixes it for every spawned child:

```jsonc
{ "tasks": { "test": "AIO_APPS_DIR=$INIT_CWD/.test-home deno test -A" } }
```

aio's own suite does this, and a test now fails if a `deno test` task forgets
it. `libraryMode` (what `testCell()` / `bootCells()` use) was already hermetic.

`appDirs` is now exported from **`aio/server`**, so an app that writes its own
files can put them at `appDirs(appId).files` — inside the one directory the user
backs up — instead of inventing a fifth location.

Also fixed while sweeping the seam:

- **A `libraryMode` app wrote its logs to `~/.<appId>/logs`** — the one place
  `libraryMode` exists to avoid. The logger resolves its directory in the outer
  boot, before the inner boot registered the app's dirs, so it saw the plain
  default. That rule now lives in one function (`resolveAppDirs`) which both
  entries call. It hit any embedded/host use of aio, not only tests.
- `am record` / `am timeline --from` / `am replay` resolved the journal as
  `./data.db.journal` in the cwd; they now ask the app dirs, with the old path
  as a fallback.
- `buildLocalProfile` preferred a leftover `./.aio-tls/` over the cert the
  server is actually serving — which fails hostname verification against stale
  SANs.
- `resolveDataDir()` **created** `~/.local/share/<appId>/` merely to look for
  the legacy layout there, re-creating on every boot the directory the move
  exists to retire. It is now a pure path function; the dead `resolveDbPath`
  went with it.
- amui tails an app's logs from `~/.<appId>/logs/` (the project-relative path is
  still searched, so it can still read an app that hasn't been restarted).

### A dispatch with no patches no longer broadcasts the whole state

`onDone` passed `undefined` to `broadcast()` when a dispatch produced no
patches, and the broadcaster reads "no patches" as "send the full state". The
`lastFullJson` guard hides that in a static app — but any app with a ticking
field always differs from the last full send, so **every idempotent dispatch
cost a complete state frame**.

Measured with a WS probe in a real app: 28 full-state frames of 438 KB in 20
seconds (12 MB) against under 700 KB of genuine patch traffic. That app had just
made its hardware-poll setters idempotent — a strict improvement — and its
bandwidth got _worse_, because those polls turned from small patches into full
states. A framework must not punish a reducer for avoiding a pointless write.
**800 KB/s → 85 KB/s**, and the pressure warnings went away.

Patches that exist but are filtered out by a cell's strategy still fall through
to the full-state path — that is what `"full"`-strategy cells depend on.

### From the llama.master field report — six silences made loud

A full app (8 cells, Rust→WASM core, 239 tests, real hardware) shipped on aio,
and its retrospective was blunt: _"several of aio's sharpest edges are silent.
Not hard to use — silent. Every multi-hour loss in this project came from that
category."_ Every item below was a violation of one of aio's own two rules —
**fail loud, never silent**, and **tests are the strictest environment**.

- **A selector read in a component subscribed to nothing.** `models.items`
  (property) re-rendered; `models.current()` (selector) returned correct, fresh
  data and registered no dependency, so a component whose only read was a
  selector rendered once and froze — right data, dead screen, no warning. Cause:
  standalone/Electron binds a cell twice, and the reactive pass skipped any name
  that was already a function, which by then is every selector. It cost that
  project an afternoon and a whole `derive.ts` layer re-exposing selectors as
  properties; **that workaround is now unnecessary**.
- **A write the store refused was reported as success.** In an async method
  `s.job = { ...s.job, step }` hands back a proxy-derived object, which the
  store must refuse — it logged and dropped the write while the method RESOLVED.
  A build panel froze at step 0 with an empty log, no error, and 239 green
  tests. The batcher now keeps the store's promise for every write-set and the
  method awaits it, so a refused write **rejects the method that made it**,
  identically in dev, prod and all four harnesses. `aiol` flags the pattern
  statically too.
- **`own.set` on a live key silently disposed the previous resource.** That is
  the design (same as `schedule.after`), but the disposer runs arbitrary
  teardown: one app's `close()` stopped a server process, so re-registering
  after a crash SIGTERMed the freshly started one and the app looked like it
  could not start at all. Dev now warns, once per key, naming the id.
- **The in-process harnesses ignored `own` effects entirely** — one warning,
  then silence. So the one place a test boots and disposes cells could not see a
  leaked or misfiring resource, which turned a whole class of bug into a
  production-only bug. They now acquire and dispose for real, and teardown
  releases them.
- **A harness could write into the user's home.** App code asks `appDirs(appId)`
  where its files live; under a test that resolved to the real `~/.<appId>`, and
  the pollution then HID a second bug by making two tests pass against an
  artefact that existed only on that machine. Every harness now redirects app
  directories into a temp sandbox, and `registerAppDirs` / `ensureAppDirs` /
  `_resetAppDirs` are exported from `aio/testing` for a test that wants a
  fixture directory of its own.
- **A cell stayed bound after its app closed**, so two `testServer()` blocks in
  one file failed with "already bound" even with `await using` — the second test
  had to move to its own file for no visible reason. A closed app now releases
  its own cells.

Also from the same report: `// aiol-ok` is accepted on the **preceding comment
line** (where the justification goes, and where `deno fmt` cannot move it — a
marker on a long line got reflowed and the hint came back elsewhere), and both
messages now say where it goes. `am surface` marks truncated text with `…`
instead of cutting silently at 80 characters, and **`am surface --full`**
returns it untruncated.

Not reproduced, and said so rather than guessed at: a `testUI` rehydration flake
(the harness is hermetic by default — `persist: false`, a fresh persist key and
a state reset per mount) and a controlled `<select>` losing its value when
options re-render (a regression test now pins the correct behaviour). Both need
a reproduction against current HEAD.

### Naming, settled once

Three variables all read as flavours of each other (`AIO_HOME`, `AIO_DATA_DIR`,
`AIO_DATA_HOME`), and two of them said "data" while setting the folder that
merely _contains_ `data/`. The rule now is: **`AIO_` = framework-wide, one
meaning each; per-app settings live in code, not the environment.**

| Was             | Is             | Means                                   |
| --------------- | -------------- | --------------------------------------- |
| `dataDir:`      | `appDir:`      | one app's folder (the author's choice)  |
| `AIO_DATA_HOME` | `AIO_APPS_DIR` | where every app's folder lives          |
| `AIO_DATA_DIR`  | _deleted_      | `AIO_APPS_DIR=/var/lib` already gave it |
| `AIO_HOME`      | unchanged      | the aio checkout `am link` binds to     |
| `AUI_ROOTS`     | `AMUI_ROOTS`   | amui's project search path (stale name) |

There are deliberately **no `AIO_APP_*` variables**: every per-app knob
(`appDir`, `dbPath`, `logging.dir`, `port`, `appId`) belongs to the app's own
code, because the author owns those decisions. The environment only answers
framework-wide questions — where aio is installed, and where apps are kept.

**amui finds your projects wherever you keep them.** Running apps were always
located from their lock files; the on-disk scan for _stopped_ projects now
starts at `$HOME` (depth-capped, stopping at the first `deno.json`, skipping
dot-dirs and `node_modules`) instead of only walking up from the launch
directory. It never traverses `/proc`, `/sys`, `/dev`, `/var`, `/etc`, `/tmp`,
`/run` or the network mount points under `/mnt` and `/media` — a `readDir` on a
network mount blocks for seconds and none of them can hold a project. An
explicit `AMUI_ROOTS` is still honoured verbatim, network mount or not.
Measured: 46ms for 18 projects on a real home directory.

### Also in alpha38

- **`dbPragmas`** — the app db was opened with WAL + `synchronous = NORMAL` and
  the app had no say. That's right for a cache and wrong for a wallet: `NORMAL`
  can lose the last committed transactions on power loss, and that transaction
  may be a freshly imported seed. `aio.run({ dbPragmas: [...] })` now sets them
  verbatim ([sqlite](docs/persistence/sqlite.md#choosing-your-own-durability)).
- **`isCellWorker()`** — a `worker: true` cell re-imports the app entry, so any
  top-level side effect there (mkdir, migrations, opening a db, starting a
  listener) runs once per worker cell, and anything slow stalls the ready
  handshake into a 30s timeout. `if (!isCellWorker()) { … }` is now the
  one-liner instead of hardcoding the internal `aio-cell:` prefix.
- **One fewer false alarm at dev boot:** a dynamic `await import("aio/server")`
  inside a cell method — the documented way to reach `createDB` — was reported
  on every boot as "not in the import map", under a blank-screen headline that
  cannot happen, with a suggested fix that doesn't exist. The graph validator
  now knows that entry is deliberately server-only. `aiol` also gained the
  dynamic form of the server-only import check, which `--safe-fix` previously
  couldn't see (a lazy `await import("aio")` of `createDB` failed only at
  runtime).

See **[Where Files Live](docs/persistence/where-files-live.md)** and the
[alpha37 → alpha38 guide](docs/upgrade/from-alpha37-to-alpha38.md).

## 1.0.0-alpha37 — say it at boot (2026-07-26)

One **BREAKING** change (the last one the alpha window allows for this seam) and
two fixes: the half of a guarantee that was still missing, and one false alarm
removed. Purely additive; alpha36 ↔ alpha37 interoperate, no code changes
required.

**BREAKING — server-only symbols now live only on `aio/server`.** `createDB`,
`DEFAULT_PRAGMAS`, `connectCli` and `connectCliUDS` are no longer re-exported
from the `aio` entry:

```ts
import { createDB } from "aio/server"; // was: from "aio"
```

They pull in SQLite (a Worker) or CLI/UDS transport and don't exist in a browser
bundle, so a static `import { createDB } from "aio"` inside a cell — or anything
a cell imports — link-failed the whole client bundle at boot. That blank screen
names the symbol but not your file, and every server-side check passes, because
the split doesn't exist until a real browser links the graph. Keeping the
convenience re-export made that a one-character mistake; now the boundary is the
import path itself. **`aiol --safe-fix` rewrites it for you**, splitting a mixed
import into one statement per entry. The TYPES (`DB`, `DBOpts`, `QueryResult`,
`Tx`, `CliApp`) stay on `aio` — they're erased at build time and can't poison a
bundle.

Breaking changes only happen in alpha, and this seam had a standing "a future
major moves them behind it exclusively" note. That future is now, while the cost
is one command.

**A worker cell's peer read now fails at BOOT, not only when it runs.** alpha36
made reading another cell from inside a `worker: true` cell throw — but a throw
is a runtime event: you learn when that line executes, which for a rare branch
can be much later. The field report that drove cell workers set the bar
explicitly ("fails loudly at boot instead of quietly reading nothing"), and this
closes it:

```
✗ ERROR [cells] src/heavy.ts:12 — cell "heavy" has worker: true and reads
  "accounts.active". A worker cell has ONLY its own state, so this read cannot
  see accounts' live value (the runtime throws when it executes). Pass the value
  in as a method argument, or keep the heavy work in one self-contained cell —
  the designated-thread idiom.
```

It runs inside **`aio doctor`** alongside the other integrity checks, so it
fires without anyone remembering to run the linter, and in `aiol`. Deliberately
conservative: property _reads_ only (a peer method **call** already throws via
the unbound-runtime guard), and only inside the worker cell's own file. The
runtime throw remains the guarantee; this is the early warning.

**The boot linter stopped advising about test files.** A `.test.tsx` never
reaches the browser bundle, so "this import won't work in the browser" about one
is pure noise — it fired on this repo's own suite the moment a test file landed
next to a booted app's `baseDir`. Same class as the inline-style lint retired in
alpha36: a warning that costs attention and buys nothing is a bug, not a
feature.

## 1.0.0-alpha36 — a thread of its own (2026-07-25)

A responsiveness release. The through-line: a user's action should feel instant,
and one slow piece of code should never be able to freeze the rest of the app.
Purely additive — no public API removed, wire protocol unchanged (alpha35 and
alpha36 interoperate).

**Cell workers — `worker: true`.** A cell can now run its methods in its own
Deno worker: a separate isolate on a separate OS thread. Work that blocks — a
parse, a crunch, an FFI call, a sync-only API — then stalls **only that cell**.
Every other cell, every other client, and the socket loop that acks them keep
running. Measured in the e2e suite: five round trips to another cell during a
1.5s burn finish in milliseconds with the flag; **1403ms without it**.

```ts
cell("reports", {
  worker: true, // ← the entire opt-in
  state: { status: "idle", rows: [] as Row[] },
  methods: {
    async build(s, raw: number[]) {
      s.status = "building"; // commits + reaches clients immediately
      s.rows = crunch(raw); // seconds of CPU, on its own thread
    },
  },
});
```

`crunch` is a normal import: unlike `schedule.blocking` (which serializes one
self-contained function), the worker loads your app's real module graph. State
stays authoritative on the main isolate — the worker streams its Immer patches
home — so persistence, broadcast, `ui`/`persist` filters, time-travel and the
wire protocol are unchanged. `serverUser()`/`serverRequest()` answer inside the
worker, per-cell ordering holds, return values and thrown errors cross back, and
shutdown terminates the thread instead of waiting for it. Boot refuses what a
thread boundary can't honour (`scope: "client"`, `sync`, `listensTo`, `machine`,
`selectors`) with the reason and the fix; `libraryMode` and compiled binaries
degrade to in-isolate with one log line. **Flag the cell that does dangerous
work — never a counter.** See [state/cell-workers](docs/state/cell-workers.md).

**Interactive priority.** A broadcast caused by a _client action_ now skips the
coalescer's throttle window instead of waiting it out — every keystroke used to
pay up to `syncIntervalMs` (a constant ~66ms per navigation key at the 50ms
default). Background churn still coalesces exactly as before, so this costs no
extra broadcasts; it moves the ones a user is waiting on to the front. Raising
`syncIntervalMs` now throttles background updates without dulling the app.

**Dev holds a reduce to one frame.** The default reduce budget is 16ms in dev
(100ms in prod). A reduce runs on the server's single dispatch path, so its
duration is what every connected client's next action waits — dev now tells you
at one frame, throttled to one report per action type per 10s. Every budget tip
was also wrong for CPU work: "move it to an async effect" doesn't help, because
awaiting a 200ms computation blocks the isolate for 200ms. The tips (and the
performance guide) now name the real fix — `schedule.blocking()` for a function,
`worker: true` for a whole cell — and a test pins the trap so the guidance can't
rot.

**`schedule.blocking` is documented at last.** The worker pool that existed
precisely so compute can't freeze rendering appeared in zero docs. There is now
a "move it off-thread" section with the contract, cancellation, pool sizing, the
self-contained-fn rule, the browser story, and a which-tool-for-which-work
table.

**The upgrade tax, paid mechanically.** `aiol` reports every deprecated spelling
your app still uses and `--safe-fix` rewrites the pure renames:
`call({ timeout })` → `timeoutMs`, `--cert`/`--key` → `--tls-cert`/`--tls-key`,
and a build-only `--headless` on a task that RUNS the app →
`--client=server-only` (the bug that made a generated systemd unit crash-loop).
Upgrading is a command, not a diff review.

**A cell edit restarts the app.** Cells run in the server process, so JSX
hot-reload used to show new UI on old cell logic. Dev now restarts the app
itself: teardown, fresh process on the same port, tabs reload on the new boot
id. It steps aside — warning as before — when it can't relaunch faithfully (no
`-A`, `libraryMode`, prod, or `AIO_NO_DEV_RESTART=1`).

### From the field (risoto, day one on cell workers)

The first real app to adopt `worker: true` reported 2-second freezes becoming a
flat ~58ms loop with a hardware wallet on its own thread — and nine friction
points, six of which are fixed here.

- **A worker cell reading a peer cell silently returned that peer's declared
  default, forever.** Boot validation caught config-level misuse but not a read
  in a method body, so interconnected cells couldn't be flagged at all. Peer
  reads inside a worker now throw, naming the cell, the field and the way out.
  The pattern that emerged in the field — **one designated heavy cell**, plain
  args in, cloneable values out — is now the documented idiom.
- **The "cell-dependent inline `style={{}}` freezes at mount" warning was
  stale.** It is reactive, on both the server-store and the browser's
  signal-backed read path; the advice it produced ("convert it to a class") kept
  costing real debugging sessions long after the fix. The behavior is now pinned
  by tests on both paths, the false `checkInlineStyle` lint is retired, and the
  doc that repeated the myth is corrected.
- **`t` markers leaked from SSR but never appeared in the live DOM**, so every
  DOM-probing tool found them in the served HTML and nothing after hydration.
  Both renderers now agree: the semantic marker is never a DOM attribute.
- **Editing `deno.json` under a running dev server** left the boot-time import
  map in place, so the watcher rescanned against a stale map and blamed your
  code. The config is now watched, with one loud "restart to pick this up".
- **The module-errors page counted standing warnings as errors** — "30 module
  errors" where 29 were never-fatal and exactly 1 was real. The header now
  counts fatals; warnings are collapsed beneath them, labelled "not blocking".
- **New lint:** reading `cell.field` right after `await cell.method()` — on a
  browser client the patch may not have landed, so it can read the previous
  value. The method's return value is the answer (it crosses the bridge).
- **Documented:** `s.list.push(x)` emits one `add` patch while
  `s.list = [...s.list, x]` re-ships the whole array every commit — the usual
  cause of a PRESSURE warning on an otherwise small cell.

Three reported items were already fixed and are now verified: browser clients DO
receive method return values (alpha34's ack transport), the 64KB KV ceiling is
gone (SQLite values hold ~1GB), and `am restart` replays the original launch
flags when the app was started by `am start`.

### Fixed

- **A scaffolded app couldn't import most documented entry points.** `am create`
  mapped four specifiers while the docs advertise a dozen, so
  `import { createDB } from "aio/db"` failed with "not in import map" — which
  reads like the entry doesn't exist. The scaffold now maps every public entry,
  `aio/server` is a real export, and `aiol --safe-fix` repairs apps created
  before this.
- **Two structures grew with uptime.** The client-log rate map kept one entry
  per client index forever _and_ walked all of them every second; the pressure
  monitor kept one throttle key per client UUID. Both are bounded now.
- **Vitals taxed what it measured** — p95 sorted a 100-sample window on every
  dispatch. Computed on read now: dispatch-sync 0.083 → 0.071 ms/op,
  dispatch-async 0.103 → 0.082.
- **`aiol` invented cells.** A `cell("x")` in a doc comment or a scaffolder's
  template literal was extracted as declared, producing phantom cells and an
  unfixable `duplicate cell name` error. Extraction (and the legacy-import and
  Node-API checks) now read real code only.
- **`route()` hardening:** `decodeURIComponent` on attacker-controlled cookies
  and path segments raised `URIError` on a malformed escape — and
  `serverRequest()` parses cookies on every request, so one bad header could 500
  a route or break a WS upgrade. Cookie _names_ were also taken verbatim, so an
  untrusted name could append its own attributes.
- Every public symbol now carries API documentation (449/449).

## 1.0.0-alpha35 — the edges (2026-07-25)

Everything in this release is at an edge: where the app meets HTTP, where a call
meets its caller, where a test meets a real server, where the linter meets your
comments. Purely additive — no public API removed, wire protocol unchanged
(alpha34 and alpha35 interoperate). **Most apps upgrade with no code changes.**

**`route()` — HTTP routes that stop being boilerplate.** `routes: {}` already
handed you a raw `Request`, so cookies, status and multipart always worked; what
every app re-rolled on top was `:id` params, a method guard, cookie
parse/serialize and a JSON reply. `route()` adds exactly that, on the same
`routes` record — raw `(req) => Response` handlers keep working untouched.

```ts
routes: {
  "/users/:id": route((ctx) => ctx.json({ id: ctx.params.id, ip: ctx.ip })),
  "/login": route(async (ctx) => {
    ctx.setCookie("sid", await mkSession(await ctx.req.json()), { httpOnly: true, path: "/" });
    return ctx.json({ ok: true });
  }, { method: "POST" }),
}
```

Custom routes now also run inside the resolved-user path, so an authenticated
app's own routes see `ctx.user`. See
[examples/integrations](docs/examples/05-integrations.md).

**`serverRequest()` — where the call came from.** The companion to
`serverUser()`: an ambient, read-only view of the transport facts a caller can't
forge — client IP, headers, cookies, url, and whether the call arrived over HTTP
or the socket. Available in cell methods, serverFns and effects, across
`await`s, with nothing threaded through your signatures.

```ts
methods: {
  attempt(s, user: string, pw: string) {
    const ip = serverRequest()?.ip ?? "unknown"; // a rate-limit key the client can't set
    const locale = serverRequest()?.headers.get("accept-language");
  },
}
```

It is deliberately read-only: setting a cookie, status or header is `route()`'s
job — one write path, not two. Server-origin work (schedules, boot, internal
dispatch) sees `undefined`, never a stale request. See
[auth](docs/auth/auth.md).

**UI kit: Avatar, Pagination, Confirm, Toast — and safe Markdown.** The
components every content/CRUD app re-rolled, now native AIR components with the
kit's tokens: `<Avatar/>`, `<Pagination/>`, `<Confirm/>`/`<ConfirmButton/>`, and
`toast()` + `<ToastHost/>`. Plus `<Markdown/>`, which is XSS-safe _by
construction_ — it parses to AIR VNodes rather than an HTML string, so there is
no raw-HTML passthrough at all, and link/image hrefs are scheme-checked. See
[ui/kit](docs/ui/kit.md).

**Real e2e without the harness tax.** `testServer()` boots a library-mode app on
a free port with a throwaway data dir; `testBrowser()` launches headless
Chromium and kills it even if the test crashes. Both are `await using`-ready and
self-cleaning. `freePort()` is exported too — a test port taken from the OS
instead of a constant is one fewer flake class (it removed a real one from this
repo's own suite). See [testing/ui-testing](docs/testing/ui-testing.md).

**Row-level authorization.** A cell's `access` predicate and a serverFn's
`access` predicate now receive the invoked method/function _and its arguments_,
so "edit only your own row" is expressible where it belongs:
`access: (user, method, id) => ownsListing(user, id)`. Backwards compatible —
existing predicates ignore the extra parameters.

**Testing + diagnostics polish.** `testUI` now isolates `localStorage` between
mounts (Deno's native storage was bleeding state test-to-test) and exposes
`ui.serverState()` / `ui.fullState(cell)` for fields the client filter hides. A
`--headless` build that still serves the UI shell now answers with a clear 503
diagnostic instead of a blank page. `aio doctor` flags an aio-version pin that
has drifted from the running framework.

**`aiol` stopped inventing cells.** The linter extracted `cell()` calls from raw
text, so an example in a JSDoc block — or a scaffolder's template literal —
became a _declared_ cell, complete with an unfixable `duplicate cell name`
error. Cell extraction now runs over real code only (comments, strings, template
literals and regex bodies are masked out). `aiol --no-hints` gives a zero-noise
run for a project that has consciously accepted its hints.

Also: TOTP primitives (`generateTotpSecret`, `totpUri`, `verifyTotp`) are
re-exported from `aio` for hand-rolled 2FA flows; `JSX.Node`/`JSX.Children`
aliases; an Electron protocol-fallback warning that used to be silent; and every
public symbol now carries API documentation (447/447 — `testUI`'s own doc block
had been attached to the wrong symbol).

## 1.0.0-alpha34 — cross the bridge (2026-07-25)

The dream-list release: a real wallet (risoto, ~650 tests) drove its whole
backlog to zero on this framework. Every item below is framework-general —
capabilities, not one-app policy.

**Return values cross the bridge.** `await cell.method()` in a browser now
resolves with the method's real return value — sync and async (settles on
completion), transported in the action's ack frame. No `server`/`client`
annotations: a JSON-serializable return crosses; a non-serializable one resolves
`undefined` with a loud dev warning, never a hang. See
[state/the-bridge](docs/state/the-bridge.md).

**Transactional methods** (`transaction: true`). A method body becomes a
transaction — reads see a stable snapshot across every `await`, writes buffer
and commit atomically at return, `s.$commit()` publishes mid-flight. Kills the
read-after-await class; a per-cell serialize mutex prevents lost read-modify-
write updates. See
[state/transactional-methods](docs/state/transactional-methods.md).

**Crash-only durability** (`journal: true`). A durable action journal replays
the un-persisted tail at boot, so a SIGKILL or power cut in the debounce window
loses nothing. Migrations hardened: a **downgrade guard** (stored version newer
than code → loud warn, state kept) and **shape drift** detection — a stored
field the cell's `initialState` no longer declares (a rename/removal without a
`version` bump) is surfaced at boot and via `am migrations`, with an open-record
rule so dynamic-key maps (`{} as Record<K,V>`) aren't false-flagged.

**Time travel.** `am timeline` (every dispatch + payload + the state diff it
produced, from an always-on ring), `am replay <range>` (deterministically
re-dispatch a journal range for repro), and `am record` (journal → a runnable
`bootCells` test). See [clients/app-manager](docs/clients/app-manager.md).

**Testing & shipping.** `deno task test:e2e` blesses the real-client e2e path
and `am expect` asserts over live state; **transport cassettes** record/replay
device + network I/O for CI; **reactive SQL views** (`select()` re-emitting when
rows change) drop the full-array-in-RAM cost. `aio ship` produces a reproducible
signed single-binary build with a least-privilege capability manifest generated
from what cells declare (USB / net / fs) instead of `-A`.

**DX.** `aio/server` gives server-only imports an explicit surface; the aiol
boundary lint (server-only import reaching the browser bundle, cell-dependent
inline `style={{}}` freeze) now also runs in `aio doctor`; `teachableError`
generalizes the what-happened / one-line-fix / doc-link pattern; `am top` adds
live runtime observability; gated `openWindow` child windows + `webviewTag`.

Two breaking-safe notes: no public API removed; `onMigrate(state, fromVersion)`
is unchanged. Full suite 2767 green.

## 1.0.0-alpha33 — build a fleet, see everything (2026-07-24)

Two headline features.

**`deno task build` — one command builds a whole target fleet.** Declare the set
once in `deno.json`
(`"build": { "targets": ["server", "electron-client",
"android-client"], "out": "dist" }`)
and build them all with a single command into a predictable `dist/` + a
`manifest.json`. Eight targets (`server`, `browser`, `electron`, `android`,
`cli`, `electron-client`, `android-client`, `cli-client`;
`deno task build --list`). It orchestrates the existing single-target builds as
subprocesses — purely additive, so every `compile:*` task keeps working
unchanged — and collects every artifact into one flat `dist/`, disambiguating
name collisions rather than overwriting. Ideal for a LAN app: one server plus
the clients that connect to it, built together. See
[build/targets](docs/build/targets.md#build-a-fleet--deno-task-build).

**amui, leveled up.** The manager UI now mines everything aio's diagnostic
surface exposes. The two file tabs merged into one source-aware **Codebase**
tab; a new **Logs** tab tails the app's `.aio/log` (framework + app lines) or
the combined stdout capture, with source/level/text filters and live-follow.
**Overview** gained a process card (pid, port, work dir, exe, runtime kind),
app + **aio framework** versions, and live per-cell health. **Metrics** is now
the full picture: CPU/RSS/heap/reduce-p95/queue charts, the dispatch loop (queue
depth, drain rate, effect backlog, circuit breakers), per-client transport +
backpressure, per-cell state sizes, and the **live action stream** with
per-action reduce timing. See [clients/amui](docs/clients/amui.md).

Also: closed a two-reviewer audit on amui + `am fix` (a same-path Refresh wedge,
a proxy re-read race, stale config after stop, a sibling-vendoring
misclassification, and more).

### 30-audit sweep — six serious bugs, found and fixed

Thirty randomized audits (a random subsystem paired with a random defect lens),
each finding then put to two independent reviewers who had to actively try to
refute it. 74 survived. The six most serious are fixed, each with a regression
test that was verified by reintroducing the bug:

- **Sync compaction destroyed state.** `sync_snapshots` was written by
  compaction and read by nothing — so the first restart after a cell passed 1000
  ops brought it back EMPTY and broadcast that to clients as authoritative. Boot
  replay now seeds from the snapshot and folds the surviving ops on top.
- **`db:` tables stopped persisting after the first restart.** The table
  baseline was captured before restored rows were loaded, so the next flush
  re-inserted every existing row, hit a UNIQUE violation, and rolled back —
  losing that flush's real writes, permanently.
- **`/__aio/…` served any file and any URL.** `new URL(rel, base)` ignores the
  base when `rel` is absolute, so `/__aio/file:///…` read arbitrary files and
  `/__aio/http://internal/…` proxied internal hosts back as executable
  JavaScript — in prod too. Module paths are now validated and re-checked
  against the framework source root.
- **Deep static subtrees corrupted the DOM.** The unchanged-subtree fast path
  handed down DOM handles only two levels deep, so a deep leaf was appended next
  to its predecessor instead of replacing it.
- **One Electron reconnect duplicated your data.** The IPC bridge callbacks were
  re-registered on every reconnect (the bridge has no unbind), so each frame was
  applied twice — and patch frames are not idempotent.
- **Async methods could read their own writes back stale**, committing a value
  computed from pre-write state.

Also fixed: `.env`, dotfiles and `*.server.ts` were served over HTTP; a
`serverFn` that threw or returned something unserializable killed the process
(both transports); vitals alerts were silent under the default config and a
throwing vitals hook took the server down; shutdown could hang on an in-flight
trojan request, and the trojan shutdown route called `Deno.exit` even in
`libraryMode`; `cancelOn` silently stopped working after two overlapping calls;
cell `onMigrate` ran on brand-new installs; `am create --target=X` was ignored;
`am auth` ignored `--app`; amui kept showing an externally-killed app as
healthy; and the CRDT/offline docs described a wire format and a queue size that
no longer exist.

### Builds you can trust

A build that "succeeds" while shipping a broken artifact is the worst failure a
framework can have, so artifacts are now tested as artifacts:
`deno task test:build` (new, a release gate) scaffolds a real app, builds every
compile target for real, and requires each one to **boot from a foreign
directory and serve** — plus a real fleet build whose `dist/` + `manifest.json`
must describe files that exist and run, and a `.wasm` app that must actually
instantiate its module inside the compiled binary.

It immediately caught two shipped bugs, both fixed:

- **`compile:service` produced a binary that crashed anywhere but its build
  directory.** A headless build never bundles, so there is no `dist/app.js` to
  detect — the binary fell through to _dev_ mode, ran the dev lint, demanded
  `src/App.tsx` at the current directory and died. A compiled binary is now prod
  by definition.
- **The generated systemd unit couldn't start the service.** It passed
  `--headless`, a _build_ flag with no runtime counterpart, so the unit users
  copy into `/etc/systemd/system` started the app in the default (Electron)
  client mode. The unit now emits `--client=server-only`, and its flags are
  verified against the real CLI parser.

Version skew is handled at the root as well. The browser bundle is **stamped
with the aio version that built it**: the stamp invalidates a `dist/app.js` left
behind by a framework upgrade (an mtime check kept stale bundles, leaving an old
client speaking the old wire protocol to a new server), and each peer announces
its build in the protocol handshake — so a mismatch now reads _"THIS side is the
older build (here: aio 1.0.0-alpha28, peer: aio 1.0.0-alpha33); rebuild it"_
instead of only naming protocol numbers.

## 1.0.0-alpha32 — aui, the aio app manager (2026-07-23)

The headline is a new example that is really a product: **aui**, a visual
manager for every aio app on your machine — the GUI counterpart to the `am` CLI.
Discover apps (running or on disk), inspect each one (cells, live state,
metrics, config, errors, schedules), browse its source tree, run its tasks, and
start/stop/restart it. aui is itself an aio app (one server-side `manager`
cell + an AIR/JSX UI), so it doubles as the framework's most complete dogfood.

**What aui does.** A searchable sidebar of projects (running ●/stopped ○) with a
button to scaffold new apps; a tabbed detail panel — Overview · Cells · State ·
Metrics · Tasks · Files. Discovery walks up from the launch dir (plus
`~/aio-apps` and `$AUI_ROOTS`) so it finds your apps with zero config. Per-app
data comes from each app's trojan API; CPU/memory from `ps`. The live-state tree
loads on demand and is size-capped, the task runner is cancellable with a
5-minute cap (so `dev`/`watch` can't wedge it), and the file browser shows the
whole source tree minus deps/build junk. See `examples/aui/README.md`.

**Framework changes it needed.** A new trojan `cells` route exposes each cell's
public method names (internal `__set*`/`__error`/`__effects` keys filtered out)
so a manager UI can list and invoke methods.

**Persistence: the phantom ~64KB "KV limit" is gone for good.** aio has been
SQLite-only for a while, but a stale KV-era size guard survived and could
degrade/refuse large cell state. Removed at the source (not just renamed) with a
new `persist-large-cell` test proving multi-hundred-KB cell state round-trips.

**Electron: `deno task dev` just works.** The electron shell auto-installs the
runtime on first run (hardened
`deno install --allow-scripts=npm:electron
npm:electron` + a bin-ready check),
so a fresh clone boots without a manual install step. The generated `main.cjs`
now installs a **main-process crash guard**: an uncaught exception no longer
pops the intrusive native "A JavaScript error occurred" dialog — it's logged to
stderr and the app exits clean (silent during quit). Connect-page host
validation regex hardened.

**Shutdown no longer drops cell teardown.** `close()` rejects late input before
the final persist, but cell destroy is dispatched afterward from `onStop`. A
System-sourced `:__destroy` is lifecycle, not client input, so it now passes the
closed-dispatch gate — cell state resets cleanly on stop instead of being left
un-reset (and warned about) on every shutdown.

## 1.0.0-alpha31 — sanity & cleanup: auth hardening, consistency, coverage (2026-07-22)

A stabilization release — no new features, everything is hardening, correctness,
and polish on top of alpha30's enterprise auth.

**Auth hardened to a clean bill.** Three independent adversarial security passes
were run over the auth stack; findings converged 7 → 2 → 0 and every one is
fixed with a pinned regression test. Closed: two open-redirect vectors (the
second a browser tab-strip bypass), a **sync-op access bypass** (the cell
`access` rule was enforced on the action-dispatch path but not the CRDT sync-op
path — a `sync:true` + `access`-gated cell was mutable by any connected client),
login/signup account enumeration, a password-reset timing oracle, OIDC login
CSRF / session fixation, and a reverse-proxy IP-bucket DoS (new opt-in
`trustProxyHeader`). The cell `access` value is now validated at definition
(`access:"none"` — a role named "none" — throws instead of silently granting).

**Parameter consistency (pre-beta cleanup, minor breaking).**
`call({ timeoutMs })` is canonical (matches `until`; bare `timeout` kept as a
deprecated alias so nothing silently loses its timeout);
`onEffect(effect,
state, user)` gains the `state` arg for parity with
`onAction`; `diagnostics` and `dispatchStorm` accept `boolean` like the other
toggle-or-configure fields; TLS flags are now `--tls-cert` / `--tls-key` (bare
`--cert`/`--key` kept as aliases).

**Coverage + two bugs it caught.** ~25 new tests on previously-untested
data-loss / security / sync-corruption surfaces (HLC restore, build-integrity,
crash-handler, console-intercept, auth-client, KV over-limit persistence, sync
access gate). Writing them surfaced two real bugs, both fixed: `flushPersist`
lost **all** persisted data on shutdown when a single cell exceeded the ~64KB KV
limit (the shutdown path lacked the degrade logic the scheduled path had), and
`console.error(someError)` forwarded `"{}"` to the dev console. Core suite 2216
→ 2241.

## 1.0.0-alpha30 — enterprise auth + full target matrix (2026-07-22)

**`auth: true` is a complete login system.** Primitives: ambient `serverUser()`
(survives await — cell methods, serverFns, effects), declarative `access` rules
on cells + serverFns enforced at the network entry, SQLite sessions (hashed at
rest, TTL/refresh/revoke), per-IP failed-auth budget with audit lines. Flows:
`/__aio/auth/*` signup/login/logout/me, PBKDF2-600k passwords (no account
enumeration), HttpOnly SameSite=Strict session cookie that authenticates the WS
handshake, CSRF origin floor, public app shell in auth mode (state stays gated).
UI: drop-in `<SignIn/>` + `useUser()`/`signOut()` from `aio/air` — auto-adapts
to the server (SSO button only when OIDC is on, signup toggle only when open).
Enterprise: email verify + password reset (one-shot hashed tokens, reset revokes
all sessions), TOTP 2FA (RFC 6238), config-only OIDC (discovery + PKCE S256 +
RS256 JWKS verify, deep-link return, open-redirect sanitizer), per-account
lockout (5 fails → 15 min → 423), `am auth` operator console (seed the first
admin, unlock yourself — no server needed). **Targets:** scaffolds emit the full
dev/compile matrix (cli, service, client,
`remote:{browser,electron,android,cli,service}`) + `src/client.ts` thin CLI
client. **Also:** security batch (trojan 4-gate lockdown, snapshot same-machine
gating, `_user` spoof strip, pairing one-shot/TTL/budget), sync-cell boot-window
race fixed, 4 dev/prod equivalency divergences closed. Opt-in throughout — apps
upgrade with no code changes ([guide](docs/upgrade/from-alpha29-to-alpha30.md)).

## 1.0.0-alpha29 — wire protocol v2: ONE envelope (2026-07-22)

**B4b phase 2 lands.** Every message on every transport (WS browser/cli, UDS
NDJSON, Electron IPC relay) is ONE JSON envelope `{v:2, t, d?}` — the v1 zoo
(string prefixes, discriminator keys, bare-JSON-is-state) is deleted. Overloaded
keys split (`ack` vs `sync-ack`; `sync-req` vs `sync-res`); PROTOCOL v/min = 2/2
with a loud, readable refusal (+ close 4505) for v1 peers; UDS gains sync +
serverFns parity; the wire-envelope CI pin now rejects any uncatalogued kind AND
any v1 prefix. **Field-fix batch:** testUI collision/disabled cluster,
`ui.exclude` enforced at every client read seam, CRDT op-id dedup + chaos suite
(4 op-loss/double-apply bugs), 3 AIR renderer bugs via the conformance suite,
`dbPath`/`--db-path`, loud electron→browser fallback, 2 aiol false positives.
**New gates:** D12 bench suite, docs-truth (snippets type-check + stale-term
denylist). Breaking: rebuild compiled binaries/CLI clients (protocol bump); no
app-code changes — docs/upgrade/from-alpha28-to-alpha29.md.

## 1.0.0-alpha28 — restructure completes: B3–B5 (2026-07-21)

The rest of the perfect-aio plan lands. **B3 phase 1:** `sync.onRejected`
(explainable rejections — no more silent optimistic-op drift) + `serverFns`/
`serverFn`, the typed server/client seam. **B4a:** SQLite-only persistence —
Deno.Kv removed, auto-migration on first boot, writes 27× faster, no 64 KiB cap,
no unstable flag. **B4b phase 1:** ONE typed wire catalog
(src/protocol/envelope.ts) pinned by CI against the live transports; fixed AIR's
divergent ack parse, the silently-dropped `__sync_error`, AIR's missing
`__proto` hello, and UDS's silent drop of WS-only frames. **B4c:** core diet —
main entry 120 → 82 symbols, periphery moved unchanged to `aio/extras`, aiol
flags old imports with the fix. **B5:** `deno task validate:matrix` +
docs/build/validation-runbook.md (off-box remote / Windows / macOS / real
Android checklists). **Papercuts:** typed route params
(`useRoute<{id:string}>`), typed `Link`/`Route` children, honest async-method
dispatch-budget message. Breaking: only the `aio/extras` import moves — recipes
in docs/upgrade/restructure.md.

## 1.0.0-alpha27 — the restructure begins: methods is the ONE style (2026-07-21)

**The biggest breaking change in aio's history — and the biggest
simplification.** The redux-era Style B (`actions:`, `reduce:`, `execute:`,
`machine:`, `generators:`, middleware) is deleted; `cell({ state, methods })` is
the one style. ~3,000 LOC of framework left; ~15 concepts became ~8. Full
migration recipes: docs/upgrade/restructure.md — and `deno task lint` (aiol)
statically detects removed keys and prints the per-cell fix.

**Every capability survives, method-native:** workflows are plain async methods
with new `until()` / `race()` / `sleep()` helpers; cancellation is
`cancelOn: { method: [triggers] }` + `s.$signal` (AbortController per call);
guards are one-line ifs; cross-cell reaction is the new `listensTo` OBJECT form
that actually runs a handler (`listensTo: { onCleared: cart.clear }` — the old
array form routed but ran nothing); side effects run inside the method, and
async-method failures now feed the circuit breaker.

**Deletion gate honored:** every Style-B test was ported to methods (or verified
machinery-only) before deletion — ~200 triage decisions recorded in
tests/_styleb-port-manifest.md.

**Also:** headless `am surface` (works with zero connected clients — server
renders against live cell state; `am surface` auto-falls back); testCell full
inference (state, sender args AND return types — fixed the index-signature
default that collapsed `keyof cellRef`); all 52 `@experimental` markers
graduated with tests (browser-sync unit suite, electron auto-install seam);
complexity batch (security config threading fix for strictOrigin/allowedOrigins,
dead 281-LOC IndexedDB store deleted, transport/catalog/clone/esbuild dedup);
electron reload is Ctrl+F5 (plain F5 free for app shortcuts); perfect-aio.md
records the full v2 plan and decisions D1–D12.

Gates: suite 2439/0 · onboard e2e 10/10 · preflight 7/7 · coverage 74.6% ·
fmt/lint/check/api/docs/boundaries green.

## 1.0.0-alpha26 — sync cursor hardening + field-report P1 closure (2026-07-21)

A deep randomized audit plus a full katana `--fix` pass. Every open field-report
P1 is closed; the CRDT catch-up cursor is rebuilt race-free.

**Sync (CRDT) — silent-loss / double-apply chain fixed.** `server_ts` is now
strictly monotonic (bare `Date.now()` ties + the strict `>` cursor silently LOST
ops) and re-seeded from `MAX(server_ts)` after a restart. The echoed
`lastServerTs` was computed from the client's own cursors — dead code; it is now
a per-cell map reserved under each cell's lock. Reconnect-flushed pending ops
are always acked and dispatched exactly once (they were never acked and
re-dispatched every round — server counter drift + permanent client
double-apply). Broadcast ops carry `serverTs` so peers advance their cursor; a
client's own ops are filtered from catch-up echoes. `persistOp` returns the
issued ts (api surface regenerated).

**Field-report P1s (machine, inews R4).** The `Deno is not defined` blank-screen
trap (machine U1): dev-boot graph findings are now LOUD — blocking client-breaks
`console.error` with file:line, `Deno.*`-in-client- reachable-modules
`console.warn` with the `*.server.ts` fix (was debug-only). `s.users.find(…)`
returns a LIVE element proxy so a write held across an await batches instead of
being silently dropped in prod (inews R4). `ui.surface()` staleness fixed at the
root: the auto-memo skip now re-points the component instance at the tree vnode,
so a structural branch swap driven by the child's own signal stays resolvable
(inews R4 🔴).

**testUI.** Disabled form controls are on the surface with `disabled: true`;
invoking an unknown action fails with the aio name listing plus a
component/element shadowing hint (never a bare TypeError);
`waitFor(pred, "msg")`; `location`/`history` come from the owned happy-dom
window automatically — `navigate()` tests need zero shims.

**am / onboarding.** `am create --target=X` works end-to-end: `aio.run()` reads
the scaffolded `target` from deno.json as the client default, so the flag-less
`deno task dev` runs the chosen target (android → the emulator orchestrator;
server → server-only). Electron auto-installs on first `dev:electron` /
`compile:electron`. Invalid `--target` fails loud.

**State.** Parameterized selectors: `byId: (s, id) => …` surfaces as
`cell.byId(id)` — server and browser, fully typed.

Gates: full suite 2497/0 · onboard e2e 10/10 · coverage 74.5% (floor 73) ·
fmt/lint/check/api/docs/boundaries/publish-dry-run green.

## 1.0.0-alpha25 — source-first onboarding, simplified README, feature freeze (2026-07-20)

Onboarding is now pure source — no JSR, no publish, no version-resolution
quirks. This is the last feature-adding release; from here it's fix / test /
field-report only.

### Changed

- **Source-first install.** `curl … install.sh | sh` git-clones aio into
  `~/.local/lib/aio`, checks out the **last tagged release** (not the branch
  tip), and installs `am` from the clone (`deno install --config` supplies the
  import map). No JSR, no publish, no login. `am update` = fetch + checkout the
  latest tag. `install.ps1` for Windows.
- **`am create` links `dep/aio`.** The scaffolded app imports aio through a
  `dep/aio` **symlink** to the clone, so its `deno.json` stays relative and
  portable (only the symlink is machine-specific, gitignored). `--jsr` remains
  an opt-in for pinned JSR consumption.
- **Every dev + build target works out of the box.** `deno task dev` defaults to
  the **browser** (instant — no Electron download, no toolchain). Explicit
  `dev:browser` / `dev:electron` (auto-installs Electron), and `compile`
  (binary) / `compile:browser` / `compile:electron` (AppImage) /
  `compile:android` (APK — needs `ANDROID_HOME` + Gradle + a JDK) are all wired.
- **`dev:android` runs the app in an emulator** (the mobile `dev:browser`). It
  boots an AVD if none is running, builds a thin dev APK whose WebView loads the
  **live dev server** over `http://localhost:PORT` tunneled with `adb reverse`
  (VPN/NAT-proof — unlike the emulator's `10.0.2.2` alias — and works on real
  USB devices), starts the server, installs + launches — so edits reflect live,
  no re-bundle. Verified end-to-end (app rendered in the emulator, aio reload-WS
  connected). Needs the Android SDK (adb + emulator) and an AVD; fails loud with
  steps otherwise (never a silent browser fallback). If the emulator crashes or
  stalls on boot, its output is surfaced (no silent hang), and a dev-server bail
  (app already running) is reported clearly.
- **Dispatch works over insecure `http://` (LAN / emulator).**
  `crypto.randomUUID()` — used to tag every dispatch — only exists in a _secure
  context_ (https or localhost), so over `http://10.0.2.2` (emulator) or
  `http://192.168.x.x` (real device) it was `undefined`: every action threw
  `randomUUID is not a function` and the UI silently didn't update (e.g. the
  counter's `+` did nothing). All client id generation now uses an
  insecure-context-safe `randomUuid()` (`crypto.getRandomValues` fallback).
  Fixes `dev:android` interactivity + LAN dev.
- **SDK auto-resolution.** `ANDROID_HOME` may point at the SDK **or its parent**
  (a common `~/Android` → `~/Android/Sdk` setup), or be unset — the build finds
  the SDK via `ANDROID_HOME`/`ANDROID_SDK_ROOT` (and their `Sdk` subdir) then
  the platform defaults. Applies to both `compile:android` and `dev:android`.
- **Android build now works out of the box across JDK/packaging quirks.** Three
  compounding failures fixed, verified by building a real APK end-to-end:
  - **Gradle 8.12.1 → 8.14.3.** 8.12.1 mis-detects Ubuntu's OpenJDK as a JRE
    (`Is JDK: false` → `… does not provide … [JAVA_COMPILER]`), even for a
    complete JDK. Fixed in Gradle 8.13+.
  - **Robust JDK detection.** `findJdk` now resolves `javac` symlinks
    (update-alternatives / JRE→JDK redirects) to the real JDK dir and **proves**
    each candidate by actually compiling a program — so a JRE, a redirected
    `javac`, or a broken install can never be chosen. It picks the newest
    Gradle-runnable version (≤ 23, preferring LTS 17/21) from `JAVA_HOME`,
    `/usr/lib/jvm/*`, Android Studio's JBR, Homebrew, SDKMAN and PATH.
  - **Gradle is pinned to that JDK** (`org.gradle.java.installations.paths`,
    auto-download off) so its toolchain resolver can't wander to a JRE. When no
    usable JDK exists it fails loud, naming the reason (JRE-only vs.
    too-new-for-Gradle) with the install command.
- **Onboarding is now gated by a real E2E suite** (`deno task test:onboard`):
  runs `install.sh` (clone + `am`), scaffolds counter/todo, boots the browser
  dev server and hits it over HTTP, compiles the binary and boots _it_, and
  drives `compile:android` (builds the APK when the SDK+JDK are present, else
  asserts the clear guidance) + `compile:electron`. No release ships unless it's
  green.
- **README rewritten** to four onboarding lines + a one-row-per-feature table +
  a logo. "Batteries included: persistence + state + UI."

### Why JSR is no longer the default

`1.0.0-alphaN` prerelease versions sort **lexically**, so a `@^1.0.0-alpha`
range resolves to `alpha9` (`'9' > '2'`), not the newest — and deno caches the
mis-resolution. Cloning a git tag has no version resolution to get wrong. (If
JSR returns at 1.0, it needs dotted prereleases: `1.0.0-alpha.25`.)

## 1.0.0-alpha24 — magic onboarding (`am`) + sync method returns + correct server/client boundary (2026-07-20)

Onboarding collapses to a single delightful path, sync methods can return
values, and the server/client import guard becomes precise (eager blocks,
deferred warns).

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
- **Sync method return values (AIO-427).** A sync method may `return` a value
  and `await cell.method()` resolves with it — no more `async`-just-to-return.
  Effects (`schedule`/`own`) still route; a returned draft slice is snapshotted
  so it survives the reducer. Types inferred via `DirectCalling`.
- **`deno task check:graph`** — CI-friendly one-shot module-graph validator
  (same engine as the dev server); exits non-zero on a guaranteed client break.

### Changed

- **Server/client boundary is now precise (eager vs deferred).** A **static**
  import of a `node:` builtin or omitted `aio` server-symbol (`createDB`, …)
  reachable from the UI entry **blocks** (it blank-screens the sandboxed
  renderer — `deno task compile` fails the same, so dev==prod). A **dynamic**
  `import()` of the same is the documented escape hatch — **deferred, a warning,
  never a block**. `@std/*` + `Deno.*` usage stay warnings. Fixes
  false-positives on apps that already lazy-load server-only modules.
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
  `ETXTBSY` for) an esbuild it never uses. esbuild still loads at runtime when
  the dev server transpiles.

## 1.0.0-alpha23 — field-report closeout: silent traps → loud, early, attributed (2026-07-20)

Five field reports (tbd, risoto ×2, realitio, inews) worked end to end. The
theme: every fix either **removes** a silent failure or makes it **loud, early,
and attributed** — never silent, late, and anonymous. Each fix ships with a
regression test proven to fail on revert.

### Fixed

- **Sync cells recover their state on a headless restart.** The committed op-log
  is replayed through the reducer at boot (after KV restore + `onRestore`,
  before any dispatch/broadcast) — previously a `sync: true` cell came back
  empty until a client reconnected (silent data loss). Logged per cell.
- **`deepMerge` keeps dictionary entries.** An empty-object initial
  (`{} as Record<K,V>`) is now treated as a dictionary — persisted entries
  survive restore instead of all being silently dropped.
- **KV over-limit degrades instead of nuking everything.** A single >64KB cell
  no longer fails the whole atomic commit; the healthy cells persist, the
  over-limit cell keeps its last-saved value, and the offender is named.
  Single-key mode names the largest cells.
- **`db:` table named after a cell throws at boot** (was a silent slice
  overwrite that broke the cell's methods), naming both.
- **Selectors are callable in the browser** — they were server-only, so
  `cell.count()` threw `is not a function` client-side with no warning. Now
  bound the same both sides; deps-form selectors read other cells reactively.
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

- **`libraryMode: true`** on `aio.run()` — no `Deno.exit`, no signal handlers,
  no singleton lock; `app.close()` resolves clean. Boots a real server inside
  `Deno.test` (sanitizers on) — the unlock for end-to-end persistence tests.
- **Responsive `<meta viewport>` by default** + `ui.viewport` override / `false`
  opt-out, and **`ui.head`** for verbatim `<head>` content
  (meta/OG/favicon/fonts).
- **`createDB(":memory:")`** documented as the file-less test DB (single Worker,
  `close()`); `readers` ignored for `:memory:`.
- **Server-only import guard.** `aiol` flags a server-only `"aio"` symbol
  (`createDB`, …) statically imported into a cell-shared file — `file:line` +
  fix; the dev blank-screen classifier makes the runtime error teachable and
  points at the linter.

### Changed

- **Unified UI facility.** One semantic surface (`ui-surface`/`ui-remote`/
  `ui-trigger`) backs both `testUI` and `am surface`/`am trigger`. The legacy
  selector/index/raw-DOM path — `am click`/`interact`/`dom`, `dom-interact.ts`,
  `dom-snapshot.ts`, `__ui:snapshot`/`__ui:interact`/`__click:` — is removed.
  `am` is a dev CLI; no public API change.

### Security

- **Exposed credential fields refuse to boot in dev.** A field named
  `password`/`passphrase`/`mnemonic`/`privateKey`/`apiKey`/`secretKey`/
  `accessToken`/`authToken` broadcast to the UI now fails the dev boot (prod
  logs a loud error) unless excluded or declared `ui.publicFields`. The old
  heuristic didn't even match `password`; ambiguous names (`seed`/`enc`/`key`)
  still warn.

## 1.0.0-alpha22 — reactivity hardening: no more silent freezes (2026-07-19)

Root-caused the "value changes but the UI doesn't, with no error" class into six
distinct renderer bugs and fixed each with a regression test proven to fail on
revert. The common thread: reconciliation under geometry or load the suite never
generated — multi-node siblings, zero-node Portals, budget overruns, a throw
mid-flush. A new dev-mode invariant now makes this whole class loud at the
source.

### Fixed

- **Scheduler could permanently, silently strand components under load.** When a
  re-render burst overran the flush time budget mid-batch, the unprocessed tail
  was dropped: its `pendingRender` stayed set, so it was never re-queued and
  every future signal update to it was silently discarded (AIO-408). A throw
  while re-rendering one component aborted the whole flush, stranding its
  siblings the same way (AIO-409). Both fixed; a `flushing` self-heal in the
  scheduler now degrades any future strand to a one-tick delay + loud dev error
  instead of a permanent freeze. Only reachable under real bursts — why fast
  test flushes never surfaced it.
- **Child reconciliation corrupted/froze the DOM around multi-node siblings.** A
  `Signal` used directly as a child froze when a Fragment sibling shifted its
  DOM index (AIO-410); a component that renders a Fragment mis-counted as one
  node and desynced the diff cursor (AIO-411); a text-only Fragment was judged
  "empty" and injected a stray comment every re-render (AIO-413); `diffUnkeyed`
  ignored a Fragment's region anchor and clobbered preceding siblings, and
  advanced its cursor past zero-node Portals, duplicating the following text
  (AIO-414). `_domNodeCount` is now the single source of truth for a node's
  realized DOM span (Fragment/component/Portal/ErrorBoundary/Suspense).
- **Direct cell access now reliably subscribes to server deltas** and cell
  signals are no longer orphaned across re-renders (risoto CRITICAL) — with a
  real e2e harness that reproduces it.
- **UDS transport buffers patches across the throttle window** instead of
  dropping the ones that arrive mid-window.
- **14 verified bugs** from the GLM-5.2 multi-aspect audit, and three fail-loud
  gaps from the risoto report (16e, 16f-b, 17b), each pinned by regression
  tests.

### Added

- **Dev child-alignment invariant.** In dev mode, after every element diff aio
  asserts `childNodes.length === Σ _domNodeCount(child)` (skipping `ref`/`use`/
  `dangerouslySetInnerHTML`); a mismatch means the child cursor desynced. It has
  zero false positives and immediately caught two of the bugs above that were
  not yet known (AIO-412).
- **Actionable antipattern messages, with the linter surfaced to app devs** —
  the same checks aio runs internally now guide application code.
- Test-only `_setFlushBudget` makes the flush-budget yield path
  deterministically testable; the WS+UDS coalescing paths are unified behind one
  shared primitive.

### Changed

- Docs codify **dev==prod equivalency** as a critical convention; the test
  harness now runs dev-strict so the test environment can no longer be more
  lenient than production, and `press()` gained keyboard-modifier support.

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
