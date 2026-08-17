# Changelog

## 1.0.0-alpha59 — a machine that is not ours, and a line you can act on (2026-08-17)

Two halves, both from the same complaint: _"the one-line install was a horrible
experience"_ — the installer did not upgrade deno, and the app it fetched never
started. Every onboarding test aio had ever run had run on a machine that
already had everything. So the first half is a lab that fails the way a new user
fails, and the fixes it found. The second half is the output itself: a user
pasted their app's log and asked what one of the lines even was.

### Onboarding is now tested on a machine that has nothing

`deno task lab` runs the whole first-contact path inside a fresh `ubuntu:24.04`
container — no deno, no node, no unzip, non-root — and it takes a GitHub app or
a local path:

```sh
deno task lab                              # all five scenarios
deno task lab riagentic/llama-master       # any public aio app, end to end
deno task lab --scenario=electron
```

Scenarios: `install` · `create-dev` · `run-sh` · `electron` · `windows-scripts`.
The UI check is not a click — it is _"is the expected screen there"_. Over CDP
it distinguishes **blank** (mount point empty), **stuck** (still a loader at the
deadline), **dead** (painted, but the client says "Reconnecting…") and **broken
build** (the module-error page served in place of the app), polls rather than
snapshots, fails on any console error the page logs, and `--expect="text"`
asserts a marker the caller knows should be on screen. An absent log directory
is a finding, not a pass: "no errors" from a tier that scanned no files is the
exact shape of a green test over a broken app.

What it found, in the order it found it:

- **deno could not install without `unzip`**, which a fresh Ubuntu does not
  have. `install.sh` now unpacks with perl and verifies the checksum itself.
- **Nothing compared the deno version.** An old deno failed later, inside a
  build, with a message about something else. Both installers now read
  `MIN_DENO` from the framework they just cloned, compare field-by-field, and
  upgrade or refuse by name.
- **The Electron client never started from the one-liner** (the original
  report). Four defects between "built" and "a window": two deciders for where
  Electron is installed; `deno install --allow-scripts` exiting 0 having skipped
  the postinstall (we now run the package's own `install.js`); `chrome-sandbox`
  not being setuid-root on Ubuntu 24.04+ and in every container (detected
  exactly, `--no-sandbox` with the chown/chmod to restore the strict path
  printed every time); and `appimagetool` needing `file(1)`.
- **`autoInstallElectron` answered the wrong question** — `run().success`
  instead of "is the runtime there".
- **The lab's own Electron check was a false positive**: `pgrep -f electron`
  matches any command line containing the word. It now requires a real electron
  executable (`/proc/<pid>/exe`) and a mapped window from the X server.

### The one-liner installs the app; `am remove` takes it back

It used to build and run out of the checkout, so deleting the clone deleted the
app and there was never a launcher.

```
~/app/<name>/versions/<version>/<name>.AppImage   the artifact
~/app/<name>/<name>.AppImage                      a stable name, symlinked
~/.local/share/applications/<name>.desktop        a menu entry (headless: ~/.local/bin)
~/app/<name>/installed.json                       repo/commit/version/target/aio
```

- `am installed` · `am remove <app>` (data KEPT unless `--data`, refused while
  running, naming `am stop`) · `am upgrade <app>` re-runs the recorded source.
- Installing a **different** repo under a name already taken is refused, naming
  both sources — two projects called `demo` share `~/app/demo` and `~/.demo`.
- Old versions are pruned to the newest three (`AIO_KEEP_VERSIONS`); the version
  the symlink points at is never removed.
- The updater no longer flattens the layout: `swapArtifact` used to rename the
  new artifact over the stable **symlink**, which replaced the link with a file
  and destroyed the rollback.

**A data-loss class, found and fixed in the same week it was introduced.** A
deno-compiled binary takes its identity from the `deno-compile-<file>` VFS
segment — the executable's file name, at runtime. Naming the installed artifact
`<app>-<version>` therefore renamed the app: it wrote to `~/.app-1-0-0/` and
every upgrade moved it again, silently orphaning the real data. `resolveAppId`
now prefers the deno.json embedded in the binary, and the version moved into the
directory so the running file is always called `<name>`. Even an app pinned to
an older aio keeps one identity.

### Windows is caught up, and honest about what is unverified

`install.ps1`/`run.ps1` had drifted into an implied promise. They now clone
first, compare the deno version, write the PATH entry in the User scope, install
to `%LOCALAPPDATA%\Programs\<name>\`, write the same install record, prune to
the same bound, and create a Start Menu shortcut.

`run.ps1` used `??` — PowerShell **7 only**, a parse error on every stock
Windows box before a single line ran. The class is now checked statically (`??`,
`?.`, `-Parallel` rejected in both files) and the decisions are unit-tested in
Microsoft's PowerShell image. What that cannot prove is printed on every run and
stated at the top of both files: nothing here touches a Windows filesystem,
registry, shortcut, `.exe` artifact or a winget deno. **Windows is best-effort
by construction until there is a Windows runner** — stated, not implied.

### Every line aio prints now says what it is

A user pasted their app's output and asked the question the output could not
answer:

```
[aio:vitals] PRESSURE — 40 broadcasts/sec (threshold: 30/sec)
```

> "aio:vitals, what is it, should it be fixed or is it just info? It's unclear."

It was a bare `console.warn`: no timestamp, no level, no category — and absent
from `app.log` and `warning.log` entirely, because console output only reaches a
file when something happens to be capturing stdout. Sitting in the middle of the
framework's own levelled log, it read as neither information nor error.

- **Framework runtime code writes through the logger.** Every message carries
  info (nothing to do) / warn (should be fixed) / error (must be fixed), a
  timestamp and a category, and lands in the matching sink. Fifty-odd files
  converted; `tests/every-message-has-a-level.test.ts` fails the build on a new
  `console.*` in `server`, `state`, `vitals`, `diagnostics`, `electron`,
  `protocol`, `db` or `sync`. Four files are allowlisted, each for a reason the
  test re-checks: two generate browser code as strings, two _are_ the sink.
- **The level picks the stream and the console method** — `console.error` /
  `console.warn` / `console.info` / `console.debug`. Everything used to go
  through `console.log`, so a host app filtering devtools by level, a shell
  redirecting stderr, and `2>` all saw one undifferentiated stream.
- **Two defects the conversion itself created, both now gated.** `log` reached
  the browser bundle through `logger-core` (Deno-only, `@std/path`) — an
  unmapped bare import is a blank screen for an app with no deno.json — so the
  public API depends on a `LogSink` shape and the class stays server-side. And a
  bulk rewrite put `log.warn` inside the template literals that GENERATE the
  Electron main-process script, where `log` does not exist: the reconnect path
  became a ReferenceError, so a backend restart never reconnected. Generated
  code keeps its console, and a test now walks template literals to prove no
  logger call is buried in one.
- **Tests capture every channel.** `tests/console-capture.ts` — a test that
  stubbed `console.log` alone saw nothing once warnings moved to `console.warn`,
  and asserted "no warning" over an app that warned loudly.
- **The pressure line says what it means and reports on the edges.** It now
  reads _"broadcast rate 40/sec is above the 30/sec advisory threshold — the app
  is working, this is about cost"_, ends with "Nothing is broken and no data is
  at risk", fires once when the condition starts and once when it clears, and is
  silent in between. Eighteen identical lines a second apart is one condition,
  not eighteen findings — and it is how a reader learns to skim past the one
  that matters.

## 1.0.0-alpha58 — everything outside the state model (2026-08-14)

Two halves. A kata audit and two seeded hunts found the pattern behind most of
this release's defects: **checks that existed but could not fail, and errors
reported to a sink nobody reads.** Then a field report named what the framework
was missing rather than getting wrong — _"what fought us was everything outside
the state model: dialogs, subprocesses, process signals, and long-running work"_
— and that is now framework too.

### The LAN responder answered anyone, and replay ran as nobody

Two recovery/exposure defects found while reading the code around the above:

- **Discovery replied to any source address.** The reply is an inventory of the
  host (app id, window title, real port, whether auth is required), so an
  exposed app handed that to the internet for the cost of one 13-byte datagram —
  and since UDP source addresses are trivially spoofed, the responder was also a
  reflector aiming ~100-byte replies at any named victim. It now answers
  private/loopback sources only, with a per-source reply budget whose memory
  cannot grow without bound.
- **Journal replay ran every action as nobody, and a throw was fatal forever.**
  A method that reads `serverUser()` — an authorization check, an "own rows
  only" filter, a per-caller quota — is a different function under a different
  caller, so replaying it unattributed recovered the wrong state silently. The
  caller is recorded per entry and restored during replay. And because the
  journal tail survives the crash, an entry the reducer rejects used to make
  `aio.run()` reject identically on every subsequent boot until a human deleted
  the file: it is now skipped, reported with the reducer's own message, and the
  app comes up. Recovery must never be the reason a process cannot start.

### The desktop surface the field reports kept writing themselves

`bw2col` (a GPU-pipeline front-end, alpha57) rated the core 7.5/10 and put the
missing points in one sentence: _"what fought us was everything outside the
state model — dialogs, subprocesses, process signals, and long-running work."_
Three of its asks were repeats from `ayd.md`. All four are now framework:

**`pickFile()` / `pickDirectory()`** (`aio/server`) — the native OS dialog
(zenity/kdialog, `osascript`, Windows common dialogs). Three apps wrote the same
zenity wrapper and at least two shipped the same bug, because a dialog binary
that is not installed and a user pressing Cancel are the same exit code. So the
contract is the four endings: picked → path, **cancelled → `null`**, missing
dialog / headless box / broken dialog → **throws**, naming the fix. A dead
`DISPLAY` is a failure, not a cancel.

**`spawn()`** (`aio/server`) — a child process with line-streamed output (`\r`
progress bars included), `pause()`, `resume()`, `kill()` and an `AbortSignal`
you can wire straight to `s.$signal`. It exists because of one measured line in
the report: `Deno.Command("kill", ["-STOP", "-1234"])` **exits 0 and signals
nothing** (procps `kill` does not read a negative pid as a group), so their
kill-the-tree had never worked — it orphaned four Python CUDA workers holding
GPU memory until reboot, and looked correct in review. Every child is launched
through a session leader (`setsid`, or `perl`'s `POSIX::setsid()` on macOS) so
`Deno.kill(-pgid)` is safe, and `spawn` **refuses to start** if it cannot make
one rather than orphaning grandchildren. `kill()` sends SIGCONT before SIGTERM —
a stopped process cannot handle a TERM.

**`long: ["method"]` on the cell** — "this one runs for hours", declared where
the method is instead of in another file as
`perfBudget.methods["job:colorize"].timeout`, a string key no rename follows. A
typo throws at `cell()` time listing the async methods; one declaration lifts
BOTH ceilings (the caller-side `await` and the effect tracker's deadline); it
applies in `testCell`/`testUI` too, so a test can await the job instead of
starting it and polling. An explicit `perfBudget` entry still wins.

**`// aio-ok: server-only`** — the acknowledgement path the graph warning never
had. One app launched for weeks with `⚠ Deno.remove is server-only` pointing at
a `finally` block that only ever runs on the server; permanent noise next to the
✖ lines that genuinely break the client is how you teach someone to skim the
output they most need to read. Warnings only: a `node:` import in a
browser-reachable module is a guaranteed blank screen and stays unsilenceable.

Plus the small ones from the same report: **aio config at the top level of
`deno.json`** (`ui: { width, height }`) is now named at boot as doing nothing
instead of being silently ignored; a **client that vanishes without a close
frame** is logged as a disconnect rather than `WARN ws error — Unexpected EOF`
on every clean shutdown; the blocking-graph block now states that the browser is
being served the diagnostic page; and `aiol` gained a rule for the framework's
subtlest trap — **a same-cell method call from inside a method**, which runs as
its own transaction against committed state and cannot see the write in
progress. `docs/clients/desktop-jobs.md` is the guide for the whole shape.

### Logs are kept now — bounded, not wiped (behaviour change)

`backupLogs` defaulted to **false**, so every start wiped the log directory: the
logs of the run you restarted _because of_ were destroyed by the restart, and in
dev — where a cell-file save respawns the process — the crash you had just
reproduced was erased by the reload that followed it. It now defaults to
**true**: the live files rotate to `.1`, older archives shift up, `backupKeep`
(7) bounds the depth. `--no-backup-logs` (or `logging: { backupLogs: false }`)
restores the old clean-slate behaviour.

Retention is only a good default if it is bounded, and nothing rotates a log
_mid-run_ — so "keep the last 8 runs" would have meant "keep 8× unbounded" on
exactly the file a chatty browser console fills fastest (`client.log`). New
`logging.logBudget` (`--log-budget=200MB`, default 200 MB, `0` = unlimited) is a
byte ceiling over the whole directory, enforced right after rotation: archives
are evicted **oldest run first**, whole runs at a time — never half of one — and
every eviction is logged. Live files are counted but never evicted; if they
alone exceed the budget the logger warns instead of deleting this run's
evidence.

`stdout.log` is under the same policy, rotated by `am` just before it spawns the
app. It is the one log the app cannot rotate itself: the shell redirect holds
its fd for the life of the run, so a rename from inside would carry the writer
into the archive and an unlink would send the whole run's output to a file with
no name. It was previously truncated by `>` on every start — the one file in a
directory of rotating logs that silently kept no history.

`--backup-logs` still parses (it is now the default); the CLI→config bridge that
carried it was spread only when truthy, which would have made `--no-backup-logs`
parse and do nothing.

### A documented import blank-screened the app

`docs/ui/kit.md` tells every app to `import { Button, Input } from "aio/ui"`,
and that specifier resolved **nowhere in the browser** — the page died on an
unmapped bare import while `fmt`, `check`, `lint`, `aiol`, `doctor` and the
app's own tests all stayed green (a field report hit exactly this). Mapped now,
and the class is gated: `tests/ui-kit-browser-import.test.ts` walks every
`aio/*` specifier the docs tell an app to import from a page and requires the
dev server to serve real JS for each.

### `am dispatch <index>` reported success for work it never did

`am trigger` and `am surface` take a client INDEX as their first positional, so
`am dispatch 0 counter:increment` is the natural generalization — and it
dispatched `{type:"0"}` into the void and answered `{"ok":true}`. A predictable
user error reported as success is the silent-wrong-outcome class this project
treats as disqualifying. Refused now, naming the confusion. (A bare `Increment`
still works: that IS the actions-form spelling.)

### Errors that reached no sink

Six server catches reported through `debug(…)`, which the default log level
discards — so they reached nothing at all. Each now goes through the
`degraded()` tracker that already surfaces in `/__aio/health`:

- **a client silently stopped receiving state, forever**, while health still
  said `healthy` (`server-broadcast.ts` — a serialize failure returned
  `undefined` and the caller's response to that is `continue`)
- a throw anywhere in the broadcast flush killed that round for every client
- a client that missed its initial state frame rendered blank, permanently —
  nothing re-sends it
- `ws: malformed message` was a GUESS about whose fault it was: a server bug
  looked identical to a bad client frame, and both were invisible
- the browser's own error-forwarding channel could die for good and look like
  "no errors"
- a failed `DELETE FROM sync_ops` left the op to be retried on every drain,
  forever — the server twin of the browser bug `browser-sync.ts` exists to kill

### The 2% flake was a 2% data bug: `confirmOp` scanned keys that were not documents

A suite run failed `tests/browser-sync.test.ts` ("an ack for an op the snapshot
already holds does not double-apply") once, at items 2 ≠ 1. Chased to the root
instead of rerun-until-green: the browser storage's `confirmOp` had lost the
`cell` parameter at the `OpBufferStorage` interface, so it **scanned every
`__aio_sync:*` localStorage key as a cell document** — including the clientId
identity key and the forensic `.corrupt` copies, which share the prefix but are
not documents. Three defects from that one scan:

- **~2% of clients silently never confirmed any op.** The clientId is 8 hex
  chars; when all 8 happened to be digits — probability (10/16)⁸ ≈ 2.3%, and
  exactly the observed 11/300 repro rate — `JSON.parse("93350346")` returns a
  _number_, `doc.ops.find` throws, and `catch { /* storage unavailable */ }` ate
  the confirm. The op stayed unconfirmed forever, so every catch-up snapshot
  that already contained it got the op rebased on top again: the user's own
  edit, duplicated on their own screen, permanently.
- **Every ack cried wolf.** For the other ~98%, parsing the clientId as a
  document threw, and the corrupt-queue handler reported _"offline queue is
  corrupt and was discarded — any unsent changes in it are lost"_ on every
  single confirm — a false data-loss alarm about a key that was never a queue.
- **localStorage grew one key per ack, forever.** The handler also wrote
  `clientId.corrupt`; the next scan read _that_ as a document too, failed, and
  wrote `clientId.corrupt.corrupt` — an unbounded chain, straight toward the
  origin quota (where `setItem` starts silently failing and offline edits die
  with the tab).

The fix is structural: `confirmOp(cell, opId)` carries the cell (the caller
always had it), reads exactly one document, and the scan does not exist to
misfire. Boot now sweeps the `.corrupt.corrupt…` chains the old scan left behind
(single-`.corrupt` forensic copies stay), a sync cell named `clientId` is
refused at init (its document would overwrite the identity key), and the class
is pinned by two storage tests plus the — now deterministic, 0/300 —
double-apply test.

### A randomized hunt over ten drawn files

Ten source files drawn by seeded shuffle, three parallel reviewers, every
finding verified in the source before it was believed. Fixed, each at its root:

- **`am backup` into a destination inside `data/` recursed forever** —
  `copyTree` created the dest, then found it in its own source listing, and
  copied itself into itself (reproduced: unbounded depth, nested garbage sprayed
  INTO the directory being backed up). `copyTree` now refuses overlapping trees
  as an invariant, and both commands refuse up front with a message;
  `am restore` also refuses a source overlapping `data/` — the move-aside would
  have taken the source with it.
- **A corrupt `meta.json` silently disabled restore's wrong-app check** — parse
  failure was treated as "no meta (hand-made copy)", so the one check the
  command exists for went blind exactly on the archives a live `--force` backup
  can tear. Corrupt now refuses, naming the file; `--force` proceeds.
- **A live app under another user read as "stopped"** — `isProcessAlive`
  swallowed EPERM as dead, so in the shared-`AIO_APPS_DIR` deployment the
  live-writer refusals (backup torn-read, restore not-overridable) silently
  skipped. EPERM is an existence proof; it now reads as alive.
- **A reducer crash on unusual state destroyed its own error report** — the
  REDUCE_ERROR box stringified the live state snapshot unguarded (and the log
  dedupe key did the same one step later), so a BigInt or cycle — the very
  states reducers crash on — threw mid-report and lost the `onError` hook, the
  TT mark, the error count and the bus emit. Both sites now carry the guard
  `dispatch.ts` and the action log already had.
- **`actions.jsonl` was world-readable** — every payload-retaining sink
  (journal, checkpoint) is deliberately 0600 with a pinning test; the action
  log, holding every non-redacted action payload, was 0644. Now 0600 on write,
  tightened once on pre-existing files, pinned by a test. Its truncation failure
  was also silent AND reset the line counter (masking the overflow by another
  `max` appends) — now logged on the append path's three-strikes budget, counter
  kept so the next append retries.
- **DevTools could take the render path down with it** — a dead Redux DevTools
  extension port (routine on extension reload) made the unguarded `send` throw
  out of every re-render, misattributed to the component being rendered; and a
  panel that DISPLAYS `devtools.renders` re-triggered itself into the 25× cycle
  breaker, which then blamed the panel. The bridge now drops itself on the first
  port failure, and a render triggered only by devtools' own signals is
  recognized as the observer observing itself and stays out of the ring.
- **Vitals numbers you could not act on** — a frozen loop that also backed up
  the queue reported as merely "degraded" (the queue tier early-returned past
  the loop tier; the WORSE layer now wins); the alert mixed units
  (`max(milliseconds, action-count)` against a millisecond threshold — each
  layer now reports its own pair); "broadcasts/sec" counted per-client sends, so
  15 clients × 2 updates/sec tripped the 30/sec dispatch-frequency alarm at
  trivial load (rounds are counted now, sends still feed per-client bandwidth);
  and `/__aio/vitals` bytes-per-sec divided by a milliseconds-old window,
  inflating a 50 KB send into 5 MB/s (a window younger than 1 s now reports the
  last completed window).

Verified but deliberately NOT drive-by-fixed (transport wiring, own pass):
client render vitals and `vitals-ping` have had no caller since alpha48's
transport swap, and `DevToolsHandle.tree` has no writer — recorded in `todo.md`
with the evidence and the fix shape.

### The docs gate that never opened its file

`scripts/check-docs.ts` resolved the README as `../../README.md` — outside the
repo, to a file that has never existed — inside an empty `catch`. The README
half of that gate spent its whole life passing on a file it never read, which is
how `README.md` came to advertise `deno task dev:electron` / `compile:android`
**five alphas after that task matrix was retired**. Path fixed, a missing README
is now a hard failure, and the README's own task vocabulary is correct again.

### `deno task release:check`

`.katana/release.md` listed the release gates in prose, so running them was a
human loop — and alpha56 shipped with `deno lint` red and `deno publish`
refusing the package outright. CI ran both and had been red on `main` since that
release: a remote result that arrives after the push, and that nobody reads, is
not a gate. One command now runs every gate AND every release surface (version
triple, dated CHANGELOG entry, upgrade guide written _and linked_), fast tier
first, heavy tier skipped when the fast tier fails. It caught a red
`docs:coverage` on its first run, and a regression of mine on its second.

### Two field reports, finally triaged

`got` (a habit tracker on alpha56) and `ayd` (a downloader on alpha54) had sat
untriaged. Each item was reproduced or read in the source before it was
believed; the two P1s are described above, and the rest:

- **Nothing could launch an app without a heap warning.** Two real causes: the
  over-share branch had no tolerance band while its sibling deliberately does
  ("reporting that as a shortfall would be a warning about rounding"), so
  `am start` sized the ceiling to exactly the advised share and then warned that
  the result exceeded it; and the 4 GB FLOOR is itself above 25% of RAM on any
  machine under ~16 GB, so an 8 GB laptop was told it had asked for more than
  the automatic share when nobody had asked for anything. Both fixed — a
  deliberate over-ask still speaks. (Declaring a ceiling BELOW the floor still
  cannot lower it; that floor is the point, and with these two fixed the modest
  app no longer warns at all.)
- **`t.expect.state(pred, msg)`** takes a message now. It hit ~12 call sites at
  once, because an `assertEquals`-shaped call is what everyone writes first.
- **`inputMode`, `enterKeyHint`, `autoCapitalize`** are in the JSX attribute
  types. The renderer already wrote all three to the DOM — only the type was
  missing, so the standard way to raise a numeric keypad failed to compile on
  the target it matters most for. Global attributes, so they sit on the shared
  base rather than on `<input>`.
- **aiol's `[ui]` chain rule fired on a TYPE-only import** — an error-severity
  false positive on correct code. `import type` is erased before esbuild sees it
  and can drag nothing into the bundle; the server-only probe had always
  excluded it, the hop regex never did. The reporter worked around it by moving
  their shared types. Its fix text now also says that renaming to `*.server.ts`
  excludes only DYNAMIC imports — the advice they tried first.

The items NOT closed are written into `todo.md` rather than left implicit, along
with the process defect behind them: `feedback/` is gitignored, so "every
reported item is in resolved.md or refused.md" cannot be verified from the
repository at all.

### A second hunt, and what silence looked like this round

Another seeded sweep, wider than the first. Every item below was reproduced or
read in the source before it was believed, and every one of them now has a test
that goes RED when the fix is reverted (each was checked that way).

**Identity, state and the wire**

- **`serverUser()` was `undefined` inside every async method in production.**
  The identity wrap lived inside the `onEffect ? … : …` ternary, so an app with
  no `onEffect` hook — the default, and nearly every app — ran its effects
  outside the ALS scope. An async method's body IS an effect, and adding a no-op
  `onEffect: () => {}` made the same method see the caller: two behaviours from
  one config key nobody thought was about identity. The test harness wraps a
  whole `t.as()` body itself, so the harness was MORE permissive than production
  — a green test over a broken path (`tests/serveruser-in-effects.test.ts`
  drives a booted app instead).
- **A reconnect silently unsubscribed the client from its own cells.** The
  first-state branch cleared `_accessedPaths` unconditionally, and a reconnect
  re-enters it with the page still mounted — so the next path any component
  tracked collapsed to a `subs` frame containing ONLY that path. The server
  REPLACES its list from that frame, and a cell that gets no updates cannot
  re-render to re-track itself: silent, permanent, self-sustaining (AIO-170,
  which the sibling branch has carried a warning about for releases).
- **A client could be stranded one state behind, forever.** `lastFullJson` is
  refreshed only when a full state is serialized, so after any patch round it
  describes an older state than the client actually holds — and the dedup read
  it as proof anyway. A value returning to what it was mid-patch-stream was
  therefore "already delivered" and the whole round was dropped: server idle,
  health green, nothing logged. The memo now carries whether it is exact
  (`lastFullJsonStale`), and the differential fuzzer's model was corrected to
  match what the code does — modelling an always-fresh memo is what hid this
  from 150 rounds of fuzzing.
- **`vitals: { backpressure: false }` had no reader at all** — it type-checked,
  was accepted, and changed nothing, while the hint engine advised toggling it.
- **A cell's `sync: { offline: { retention } }` was read by nobody**, so every
  cell evicted unsent changes at the 4h default no matter what it asked for.
  `"7d"` — the value `docs/persistence/crdt.md` uses in its own example — had no
  `d` unit either, and silently became 4h: the queue threw the user's work away
  42× earlier than the app said. Days parse, per-cell retention is wired, and a
  duration the parser cannot read now throws instead of defaulting.

**Security seams**

- **Electron trusted every bad certificate, from every host.** The
  `certificate-error` handler re-parsed the APP's own URL and asked whether that
  was localhost — a constant `true` for every local launch, so an intercepting
  proxy answering the page's fetch to a third-party API was silently accepted.
  Both generated mains now compare the URL that FAILED against this app's own
  origin, and refuse everything else.
- **Two files holding the app key were world-readable**: the Electron recents
  file (which stores each app's paired key and its `?token=` URL) and
  `am profile --out=<file>`. Both are 0600 now, and both re-assert the mode on a
  pre-existing file, which `mode:` alone does not.
- **`am start` killed the healthy instance of a prod+UDS app, every time.**
  Single-instance protection probed `http://127.0.0.1:<port>/`, and a UDS app
  listens on its socket and nowhere else — so the check was INVERTED for that
  transport while `am status` (which has always carried the socket fallback)
  reported the app as up.
- **An exposed full-login app advertised itself on the LAN as needing no
  authentication** — the discovery stamp read `users`/`token`, which both miss
  `auth: true` and `resolveUser` (with per-user auth no shared key is generated
  at all). No ⚷ in `am discover`, no auth badge in the client.

**The renderer**

- **A modal that starts closed never attached its Escape handler** — i.e. every
  modal, plus `Confirm`/`ConfirmButton`. The mount gate marked an instance
  "mounted" on a render that collected no callbacks, burning the one chance a
  component gets; a component that returns early before its `onMount(...)` line
  is the normal case, not an edge one.
- **A lazy component one level below its boundary never resolved.** Suspense
  identified "which lazy stopped me" by scanning its own immediate children, so
  `<Suspense><Wrapper/></Suspense>` left the fallback on screen forever after
  the loader resolved. The thrower now records its own identity.
- **`<Portal target={cond ? el : null}>` left its content mounted in the old
  target forever**, and tripped the reconciler's own corruption tripwire when
  the target came back. Teardown and re-create are both handled now.
- **A removed camelCase SVG attribute never left the DOM**: removal used the raw
  JSX key while the write used the mapped name (`strokeWidth` → `stroke-width`),
  so an incremental diff did not converge on what a fresh render produces —
  silently, for all 41 mapped names.
- **`Defer`'s failed `load()` discarded the reason** — a 404, a syntax error or
  a dead network rendered nothing, with an empty console.
- **FLIP reorders animated from a stale origin**: the reference rects were
  re-measured AFTER the pass applied its transforms, and
  `getBoundingClientRect()` includes transforms, so every reorder after the
  first jumped back two renders before sliding. Also fixed: `transitionend`
  BUBBLES (a button's hover transition inside a moving row ended the row's
  FLIP), the safety timer was dropped from its map without being cleared
  (leaving an armed orphan that wiped the next animation), and a bare
  `requestAnimationFrame` — absent outside a browser tab — threw from inside an
  afterRender callback, where the contained-failure guard swallowed it and
  killed the rest of that pass.
- **`useDimensions` without a `ResizeObserver` returned 0 for the component's
  whole life**, so a layout branching on `width.value < 600` took the narrow
  path forever with nothing logged. It measures once and says live updates are
  off — and a computed padding of `""` no longer makes the dimension `NaN`,
  which compares `false` against everything.
- **A component instance leaked from the hydrate path** on any subtree throw (no
  `finally`), and the stale ancestor then won `useContext` lookups for unrelated
  components later on the page.

**Tools that reported the wrong thing**

- **`route()`'s `setCookie` was lost on the textbook login handler.**
  `Response.redirect()` headers are immutable per the fetch spec, so appending
  threw out of the handler into a 500 — no cookie, no redirect. Also:
  `{...init.headers}` silently dropped every header for a `Headers` instance (no
  own enumerable properties) and turned the `[["k","v"]]` form into a header
  named `0`.
- **A correct `import type { Buffer } from "node:buffer"` was reported as a
  BLOCKING server-only import** when any import preceded it — the pattern
  crossed statement boundaries, so the type-only lookahead judged the wrong
  statement. A blocking graph error serves the diagnostic page instead of the
  app, and the fix text told the author to do what they had already done.
- **The capability scanner never matched the `*Sync` spellings** (`\b` does not
  sit between `e` and `S`), so an app whose I/O is `readFileSync` scanned to
  `read:false` and its SIGNED manifest advertised `runFlags: []` — following
  that advice launched a binary that died on PermissionDenied at its first file
  read. The scanned API list is now exported and cross-checked against the
  regexes by a test.
- **`am fix` overwrote a customized task with another one** (a `*:service` →
  `*:server` rename onto an existing destination) and reported the destroyed
  task under `kept`; and its entry lookup used `JSON.parse` on `deno.json` only,
  so one `//` comment made a jsonc project fall back to the default entry and
  skip the dependency-cache repair with no output at all.
- **`am add cell <name> | jq -r .created` received a stringified sentence** — it
  branched on `flags.json` instead of the resolved output mode (a non-tty stdout
  IS json mode, everywhere else in `am`).
- **`aiol --safe-fix` patched the wrong file on a jsonc project** — it read
  `deno.jsonc` and wrote `deno.json`, creating a second config Deno silently
  prefers; a config with real comments now refuses out loud instead of failing
  silently. `--json --safe-fix` also printed its progress lines on stdout, so
  the tool's own output could not be parsed; and a dead-entry import on LINE 1
  was reported as line 2.
- **The automatic-feedback dedup grew without bound** — error messages embed
  varying ids, so nearly every error added a key for the life of the process.
- **`host` was missing from `CellsConfig`** — allowlisted, forwarded, read by
  the server, printed by `doctor` and used in `docs/auth/auth.md`, but absent
  from the one surface an app compiles against, so following the docs failed
  `deno task check`. A REVERSE drift gate now fails when any allowlisted key is
  not offered by a public type (the forward gate has existed for releases).

**Gates that measured nothing**

- **`deno task soak` drove ZERO dispatches for five alphas.** Its load generator
  sent the bare pre-alpha52 action frame, which the server's decoder refuses, so
  every "N dispatches" it reported was frames written to a socket and dropped on
  arrival — a green heap slope over an idle server. It sends a v2 envelope now,
  asks the CELL whether anything landed, and FAILS if nothing did.
- **`preflight` printed its green "`curl | sh` clones exactly this" for a branch
  that has never been pushed** — `git rev-list origin/<branch>..HEAD` exits 128
  with empty stdout, which read as "0 commits ahead". Exit code and shape are
  both checked now, and a detached HEAD is named.
- **A differential fuzzer went red against correct code** for any seed that drew
  `undefined` (its composite oracle used the BARE verdict for a value whose
  verdict depends on position). A gate that goes red on the behaviour another
  test demands is noise, and noise is how a real failure gets waved through.

### Also

- **17 undocumented public symbols** documented — `docs:coverage` (a CI gate) is
  green.
- **aiol's strict rules no longer fire on comments**: two error-severity probes
  read raw file text, so `markAsync` named in a comment and an import inside a
  codegen template literal both failed the gate. Masked now — and the first fix
  went too far (`codeText` blanks string literals, and an import specifier IS a
  string, which blinded the rule to its own violation); the tests caught it.
- **`parseCli()` is memoized** on the boot path — it was parsed 10× per boot, so
  `unknown flag ignored:` printed 5–7 times and read as an error loop.
- **`examples/disk` opts into `transaction: true`** — it taught the alpha52
  default that alpha57 retired, and called `s.$commit!()` in a cell where it
  resolves to a no-op: the flagship long-running-work example demonstrated an
  idiom it did not have.
- **`examples/updates` has a UI test** — it had a boot gate and a lint gate,
  both green, while `App.tsx` (the entire point of that example) was never
  executed.
- Doc corrections: `schedule.at`/`cron` DO fire on the virtual clock;
  `ui.surface()` returns an object, not a string; a curried selector is called
  `choicesFor()("image")` (verified empirically — passing the argument to the
  accessor returns the inner function); the quickstart no longer promises an
  Electron window for a browser-default app, nor a scaffolder that does not
  exist; stale `@^1.0.0-alpha17` pins now use the floating range the same page
  tells you to keep.

## 1.0.0-alpha57 — the default a cell never asked for (2026-08-12)

`transaction` is opt-in again, and the rule that decides such questions is
written down instead of re-argued. Then a field report from a desktop app sent
the test surface the same way: stop answering a question other than the one
asked, and own the state nobody owned.

### `transaction` goes back to opt-in

alpha52 made `transaction: true` the async default. On the merits it is the
better model — snapshot reads, one atomic commit, conflict detection — and none
of that changes. What changed is who it applies to: **a cell gets it when it
asks for it.**

The flip did not break a spelling; it silently re-specified every async method
already written. Two shapes, both from the field:

- a **stand-down guard** —
  `s.query = q; await fetch(); if (s.query !== q) return` — reads its own pinned
  write, so the comparison can never fire and a stale response overwrites a
  fresh one
- a **spinner** — `s.loading = true` announcing the fetch it precedes — buffers
  to the end of the method that is doing the fetching, so it never reaches the
  client

Neither produces a type error, a runtime error, or a failing test. The app runs,
differently. A boot WARN was not enough: it named the change, but an app that
still runs is not looking for warnings, and `major.md` — compatibility with the
previous alpha — was broken outright.

Retired with the flip: the once-per-cell boot hint, aiol's migration warning,
and `aiol --safe-fix`'s `transaction: false` insert. An app already carrying
that insert needs no action — it now states the default. `transaction: true` and
`{ serialize: true }` are unchanged for the cells that want them.

### The rule, written down — `.katana/_aio.md`

The axis is not restrictive ↔ permissive, it is **loud ↔ silent**:

- detectable at **boot, build or lint** → be strict, refuse, and print the exact
  replacement. It costs a newcomer nothing — they learn at the moment of the
  mistake instead of building on sand
- only observable by **watching runtime behavior** → the default never changes.
  Opt-in forever, or gate the flip on a version the app declares

And the corollary that keeps onboarding out of the argument: strict-and-loud
defaults _teach_. What strictness trades against is EXISTING apps, which is the
compatibility kata's business, not this one.

### aiol stopped reading comments as code

The read-after-await rule's opt-in probe tested RAW file content, so a cell that
merely **mentioned** `transaction: true` in a comment — the comment explaining
why it declined the option is the common shape — silently disabled the rule for
the whole file. Masked now, like every other body probe in that file. Found in
an app whose comment did exactly that.

### The t2v report — the harness stops answering a different question

A field report from a Deno/Electron app (two prompt stages, an embedded
inference engine, ~250 tests) written from a session that included a full UI
redesign. It rated aio 7/10 and kept the `cell` shape, `t`-handle testing and
the no-build loop. The two points came off the test surface, and every finding
below was probed before it was believed — two of them turned out to be a
misdiagnosis of a real trap sitting next to them.

- **A module-level `signal()` survived between tests.** Cells were already reset
  per test; the state that lives BESIDE a cell was not, and from inside a test
  the two are indistinguishable — so the report read it as "cells leak state
  between tests" and wrote defensive setup lines in tests that had no business
  caring. `testUI`, `testCell` and `bootCells` now restore every module-scope
  signal to the value it was created with. Signals born during a render
  (`useLocal`, `useRef(signal(…))`) are per-mount already and are not touched.
  Hermetic means all of the state, not most of it.
- **`present()`/`absent()` could answer about a component when you asked about
  an element.** `t` on a component is a rename-proof component handle (an
  earlier report's fix), so a component that also forwards `t` down to an
  element makes one string name two things: `absent("image-negative")` was false
  because the SWITCH was showing, while the field really was gone.

  Chasing it found the general case, and it is not an app-authoring mistake:
  **aio's own kit forwards `t`** — `<Button t="Home">`, `<Input t="who">`,
  `<Select t="sel">` all pass it to the element they render — so every app built
  on `aio/ui` has names that address a component and an element at once. The
  harness has to answer well in spite of that, not scold about it. It now
  resolves the ELEMENT first (deterministic and frame-local — never "what a
  previous render happened to show", which would make tests order-dependent),
  takes a kind when you want to be explicit (`ui.absent("x", "element")`), and
  explains the one frame where the two answers genuinely differ (the element is
  gone while the component still renders something else) instead of returning a
  bare confident boolean. A component handle that names nothing else stays
  silent — a warning that fires on the correct, common pattern is noise, and
  noise gets ignored.
- **A handle died when its subtree remounted.** Resolution pinned the path
  captured at access time, so switching views re-parented the element and every
  handle taken before the switch threw `is not on the current surface` — while
  `ui.html()` and `present()` both insisted it was there. Three of the harness's
  own APIs disagreeing about one element is the framework lying to somebody. The
  NAME is the address now (the path only tie-breaks same-named siblings), and
  "on screen" has one definition every API answers from: a live DOM node.
  `present()` no longer counts a surface entry that has none.
- **`ui.Name1` now spells "the first instance".** The report's "ambiguity should
  be an error, not a silent first-match" was probed by making it exactly that —
  and the kit's reachability fuzzer refused the change: same-named siblings are
  POSITIONAL by design (bare name = first, `Name2` = second, which is why the
  ordinal is 2-based and what every miss listing teaches). Erroring made
  elements reachable only through an ordinal the author has no reason to know,
  so it was reverted and the contract is pinned instead. The one real gap it
  exposed: "the first" had no explicit spelling, so a reader could not tell a
  deliberate first from an unconsidered one, and a loop over instances needed
  two spellings. `Name1` says it. (A deep HOIST with two hits still throws —
  that one is a search, not a position.)
- **A missing handle dumped every name in the app** — ~50 entries, several
  hundred characters each, on one line, with the failed assertion scrolled off
  the top. Ranked by closeness to what was asked for, capped at 8, with
  `AIO_TEST_NAMES=all` for the exhaustive list — the diet `am surface` already
  went on.
- **`signal` had no `.get()`.** `.value` to read, `.set()` to write, `.peek()`
  to read untracked — the report tried `now.get()` and `now()` and landed on
  `.value` by reading another component's source. `.get()` is now the tracked
  read, the mirror of `.set()`; `.value` and `.peek()` are unchanged.
- **The tracking boundary is written down** — `docs/ui/reactivity-tracking.md`:
  a read is tracked during the synchronous execution of a component body, a
  `computed()` or an `effect()`, and at no other time. Everything else (nesting,
  fragments, conditional branches entered on a later render, selectors that
  return functions) follows from that sentence.

### The package is publishable again

Two release gates had been red, and the pre-release audit is where that surfaced
rather than at a publish attempt:

- **`deno publish` refused the package.** `feedback` and `updates` were exported
  with inferred types, so their type was knowable only by type-checking the
  factory — a "slow type" that blocks `.d.ts` generation and makes every
  consumer pay for the inference. Both factories already declare their return
  type; the exports now say it (`export const feedback: FeedbackCell = …`).
- **`deno lint` is clean.** `startFeedback`/`startUpdates` were `async` with
  nothing to await: the dynamic import that made them asynchronous became static
  in alpha56 (an app top-level-awaiting `aio.run()` could not otherwise finish
  module evaluation) and only the keyword was left behind. They are synchronous
  and now say so; both call sites already `await`, which is unchanged either
  way.

### The class behind the leak — who resets what

Chasing the signal leak found the shape of it: `runtime-reset.ts` opens with
"tests get hermeticity from a single call instead of remembering five scattered
`_reset*` functions (forgetting one = cross-test bleed)" — and `src/` had grown
**55 module-scope `_reset*` functions, of which the one call owned 7**. Every
other one is a memory a test author has to hold, and the ones nobody holds are
silent bleed. Fixing the signal was a patch; the class is module-scope mutable
state whose lifetime nobody owns.

- The **warn/hint dedup sets** joined the one call. An unreset "have I already
  said this?" memory makes a test's own diagnostics order-dependent: the second
  test to trigger the same hint sees silence, so "it warns about X" passes alone
  and fails in a suite (or the reverse).
- **`tests/reset-ownership.test.ts` is the gate.** Every `_reset*` exported from
  `src/` must be classified — `RUNTIME` (the one call), `LIFECYCLE` (src/ code
  owns when it runs), `HARNESS`, or `MANUAL` with a stated reason — and a new
  one fails the gate until someone decides which. The ledger also rots forwards:
  an entry naming a reset that no longer exists fails too.

The ledger is deliberately uncomfortable to read: ~30 entries are still
`MANUAL`, each a debt with a name rather than an anonymous trap. Moving one up
to `RUNTIME` is now a visible improvement instead of a thing nobody knew to do.

Two findings did not survive probing, and are pinned as what actually happens so
nobody re-derives them: the stale nested-ternary-inside-a-fragment **re-renders
correctly** (reads of one cell share one signal, and dependencies are
re-collected every render, so a branch entered later still subscribes), and
handles **never matched by substring** — every name match in the surface is
`===`. The `t`-on-a-component trap is what made it look like both.

## 1.0.0-alpha56 — the empty desk (2026-08-09)

A 42-finding static audit arrived, and this is the release where every one of
them is closed: fixed with a test, or written into `feedback/refused.md` with
the reason it will not be. Nothing was changed on the strength of a description
— two findings were **refuted** on verification, and one was half right in a
more interesting way than reported.

Strictly additive: no removals, no renames, nothing to migrate.

### An app that top-level-awaits `aio.run()` boots again

alpha54 added two `await import(…)` calls **inside `aio.run()`** — for the
built-in `updates` and `feedback` cells — because `cell()` self-registers and a
static import would have put those cells in every app that never asked for one.
The reasoning was sound; the shape was not. A dynamic import issued from inside
a call the app top-level-awaits can leave module evaluation unable to complete,
and the app dies at boot with:

```
error: Module evaluation is still pending after multiple event loop iterations,
but no stalled top-level await was found. This is a bug in Deno.
```

That message names neither aio nor the app, and there is nothing in the app to
fix — which is why `am fix` could not have helped: nothing in the project was
wrong. **This is a defect, not one of the breaks we agreed to.**

The two cells are factories now (`createUpdatesCell` / `createFeedbackCell`):
registration happens on the CALL, so the opt-in property survives — an app that
never configures updates still never gets the cell — and every caller uses an
ordinary static import. The same shape one call deeper, in `startUpdates` and
`startFeedback`, went with it: half a fix is not one. `aio/updates` and
`aio/feedback` are unchanged for apps.

A test now boots a real app whose ENTRY top-level-awaits `aio.run()`, with and
without `feedback`, and a guard refuses any dynamic import of a cell or runtime
module from the boot path. No harness covered this before, because every one of
them calls `aio.run()` from inside a test function rather than at a module's top
level — which is exactly not how apps are written.

### Silent wrong outcomes — the class this project treats as disqualifying

- **A held ack could lose a write.** Its known `serverTs` was clamped down to
  the snapshot watermark — but a `serverTs` ABOVE the watermark is precisely the
  op the snapshot does not contain, so the engine marked it already-folded,
  skipped the apply, and the user's own change vanished from confirmed state.
  Reachable whenever the server serialises a `sync-req` before an op whose ack
  arrives while the catch-up gate is shut.
- **A throwing live-query subscriber made a COMMITTED write reject.** The throw
  propagated out of `invalidate()` into `execute()`, so the caller was told a
  landed write had failed — and might retry it. Subscribers are app code; a bug
  in one cannot un-commit a write.
- **A route wildcard that was not last silently over-matched.** `matchRoute`
  returns the moment it reaches a `*`, so `/files/*/x` answered `/files/foo` and
  the `/x` it demands was never checked. Refused at boot now, naming the pattern
  to write instead.
- **A corrupt offline queue was discarded in silence** and overwritten by the
  next save — in the subsystem whose entire purpose is not losing offline
  mutations. Now reported, with the raw document kept alongside.
- **Every recovery alert was dropped.** `VitalStatus` carries both `"healthy"`
  and `"recovered"`; the reporter matched only the first while the sole firing
  site uses the second, so its own recovery branch existed for an event it could
  never receive.
- **A worker patch with a disabled owner** vanished without the rejection record
  every sibling path in that file writes.
- **Two public methods swallowed real errors** — `feedback.refresh()` and
  `updates.check()`, both of whose siblings already recorded failures.

### Hangs

- **"Abandoned" now means abandoned.** A hard-timed-out effect stayed in
  `effectPromises` until its promise settled, so an effect that never settles
  left `drain()` waiting forever on work the timeout had already given up on.
- **A synchronous `sendFn` throw** waited out the 15-second ack clock and then
  reported a generic timeout. The frame never left; the caller is told now.
- **`connectCli().ready`** — see alpha55; `readyTimeoutMs` is the opt-in.

### Correctness

- **`useEffect(fn, [])` cleanup ran before every re-render**, tearing the mount
  effect down permanently: `useEffect(() => subscribe(), [])` unsubscribed on
  the first unrelated re-render and nothing put it back. The deps-form branch
  was fixed for exactly this once, and carries a comment about it; its twin was
  missed.
- **A declared JWKS `kid` must now match.** `|| keys.length === 1` meant any
  token verified against a sole published key whatever kid it declared — never a
  bypass, since the signature still had to check out, but it made key rotation
  meaningless.
- **`electronBinReady` returned true when the binary was missing**, which is
  exactly the broken install it exists to catch.
- **A remove that races an EDIT is now reported as a conflict.** Remove still
  wins — that part was a deliberate rule, and the audit's reading of it was half
  wrong — but two sides deciding differently about the same item is a
  disagreement `onConflict` should hear.

### Shared-key mode can serve a browser

The shell loaded with `?token=`, then every asset request arrived with no query
and no header and 401'd — and since `key:` and `auth:` refuse to boot together,
an app that wanted a browser had no shared-key option at all. The request that
PROVES it holds the key is now handed the credential back as an `HttpOnly`,
`SameSite=Strict` cookie, named per app (cookies ignore the port), `Secure` when
the page is https, session-scoped and issued once. Strictly safer than the
`?token=` URL it replaces, which leaks into history, referrers and proxy logs.

### The boot report says WHO decided

"Default target — where is it defined?" A client target can come from a
`--client=` flag, `aio.run({ client })`, deno.json or the framework's default,
and the running app was the one thing that could not say which:

```
client    electron (deno.json)
port      8000 (flag)
entry     /opt/wallet/src/app.ts (default)
```

`(default)` is spelled out rather than implied by silence. New lines, each
because its absence sent someone to read source: **pid**, **bind**
(`127.0.0.1 —
loopback only` vs `0.0.0.0 — every interface`, the posture
`expose` only implied), **tls**, **heap** (the ceiling and the machine it came
from), **logs**, **journal**, **workers** and **sync** (the cells that are not
ordinary — own thread, second writer), **routes**, **serverfns**.

### `build.server` reaches the artifact

It was recorded in the manifest, printed at the end of a build, and used to
REFUSE a client-only build — and then the APK or AppImage still asked the user
to type the address the build already knew. Now baked: the Electron client
connects straight in (`--server-url` and an imported profile still win;
`--connect` reaches the picker), and the Android client prefills and
auto-connects on a FRESH install only, so a user's own choice always outranks
it.

### Tooling

- **aiol stopped crying wolf** in three ways: a callback whose parameter shares
  the draft's name is no longer blamed on the method, the `until`/`race`
  exemption belongs to the CALL rather than the whole line, and the `$`
  exemption is the four real meta fields instead of any `$`-prefixed name.
- **One entry decider.** `am-utils` held a fourth copy of "where does this app
  start"; it agreed by luck.
- **Discoverability** — the README points at `pitfalls.md` where the two readers
  who missed it actually were, and `am --help` gives `--json` its own line
  instead of burying the scripting interface in a fourteen-flag row.

## 1.0.0-alpha55 — the memory a machine actually has (2026-08-09)

An app that needs 12 GB on a 32 GB machine should get it. One that leaks should
say so hours early. Neither should be able to freeze the desk it runs on. This
release is those three sentences, plus the seams found on the way there.

Strictly additive: no removals, no renames, nothing to migrate.

### Seams: what an app looks like from outside its own directory

Three findings in one pass were the same shape — nobody had asked that question.
`tests/seam-paths.test.ts` now boots a real app with `$HOME` and
`$XDG_RUNTIME_DIR` redirected and asserts on the FILESYSTEM: everything under
the app's two homes, nothing in the working directory, nothing of ours in
`/tmp`, secrets 0700/0600. It found two on its first run:

- the **TLS private key was world-readable** — openssl writes with the process
  umask, and the mode was inherited rather than stated. Now 0600, `data/tls`
  0700.
- the **openssl config was written to `/tmp`** on every first TLS boot, which
  also made TLS depend on a writable `/tmp`. Now beside the key.

And in prod + UDS, **client logs went to a cwd-relative `.aio/log`**:
`initClientLog` sat behind `if (!prod)` while the UDS transport writes client
frames regardless, so an Electron app's renderer logs landed wherever it was
launched from — a fourth location, wiped by no policy, not the one
`am log --client` reads.

### Testing the shape aio documents but could not exercise

- **`testApps({ service, desk })`** (`aio/testing`) — N independent apps, own
  ports/dirs/appIds, plus `connect(name)` for the client-of-another-app path
  over a real socket. Every property of the service+clients architecture is
  cross-app, so a one-app harness could not express any of them.
- **A real client over a real interface** — `connectCli` over `wss://` against a
  self-signed cert it must pin, in a separate process. Every client assertion
  before this was `fetch` over loopback, where TLS does not happen.
- **GUI tests stopped stealing focus.** Test windows open in a nested X display
  (`scripts/xephyr.sh`), started detached and **never stopped by the tests** — a
  harness that starts and kills a window per run reproduces the flicker it is
  meant to remove.

### Loud where it was silent

- **`afterRender()` outside a render** no longer vanishes. From a timer, a
  promise continuation or an event handler the callback was simply dropped; dev
  now says so, naming those three callers.
- **`connectCli().ready` never settled** when the first connection failed: a
  wrong address, token or certificate logged "still retrying" forever while the
  caller hung. Opt-in `readyTimeoutMs` on both `connectCli` and `connectCliUDS`.
- **Client-side diagnostics are pinned at the ROUTER**, not just the sink —
  reverting any one transport to the old inline `_aioDiag` check used to keep
  the suite green while every diagnostic went silent.
- **`--no-tls` without `--expose`** says it has no effect.

### One app, one identity — and one entry

- **dev and compiled resolved DIFFERENT appIds.** The build named the binary
  from `title ?? basename(root)` and ignored `appId`, while a compiled app takes
  its identity from that filename — so a `deno.json` with `appId: "wallet"` in a
  directory called `thing` was `~/.wallet` in dev and `~/.thing` compiled. The
  data directory moved when you compiled. One `appIdFromConfig` now decides
  both, pinned by a differential test.
- **`am fix` probed entries the build does not recognise** (`src/main.ts`,
  `main.ts`) — it could pronounce a project healthy on the strength of a file
  that would never compile. One `resolveEntryPath`, shared.

### Smaller, and worth having

- **Android `applicationId`** is no longer aio's to choose:
  `android.applicationId` in deno.json, validated and REFUSED rather than
  sanitized — the id is permanent once published.
- **Pre-migration store backups are pruned** (3 kept). One full `state.db` copy
  per migrating update accumulated forever, inside the backup unit.
- **`wipeOnStart` clears the archives too** — a clean slate that leaves files
  behind is the wrong shape of promise.
- **The e2e harness blames the server** when a request fails after readiness,
  attaching the child's output instead of a bare "error sending request".
- **aiol scans `scripts/` and `tools/`** — with a tooling scope, so the eleven
  premise-false findings that came with them do not. It caught two real ones.
  And it stopped crying wolf at the framework itself: 84 of 85 warnings were one
  app-shaped rule firing where its premise is false. Apps still get every one.

### An app gets the machine it is running on

V8 fixes its heap ceiling when an isolate starts and never revisits it, and
Deno's default is ~4 GB whatever the hardware. So an aio app on a 32 GB machine
died with "out of memory" while 28 GB sat free. Nothing in aio set that limit —
which is exactly why nobody had chosen it.

**The rule: 25% of physical RAM, never below 4 GB.** A quarter leaves room for
the rest of the machine; the floor is V8's current default, so this can only
raise a ceiling, never lower one. The ceiling is not an allocation — V8 reserves
nothing — but it is not free either: V8 collects less eagerly when it believes
it has room, which is why the rule is a fraction of the machine rather than
simply a big number.

Applied wherever aio starts something:

- **`am start`, `run.sh`, the test harness** resolve it for the machine they are
  on and pass `--v8-flags=--max-old-space-size=N`.
- **Compiled artifacts** bake it at build time — measured: a compiled binary
  ignores `DENO_V8_FLAGS` entirely, so `deno compile --v8-flags=` is the only
  way in. On this machine a build went from a 4192 MB ceiling to 47790 MB.
- **A bare `deno run src/app.ts`** gets V8's default, and now says so at boot,
  naming the exact flag to add. Observe-only: the ceiling is fixed long before
  any of our code runs, so a warning is all that is available — but discovering
  it at boot beats discovering it under load.
- Override per app: `"memory": { "maxHeap": "12GB" }` (also `"25%"`, `"512MB"`,
  a number of MB, or `"default"`). An explicit value is still clamped to 25% —
  the cap protects the machine, and an app cannot opt out by asking.

**Workers were never the problem.** The docs claimed Worker isolates were stuck
at ~1.7 GB and that `DENO_V8_FLAGS` did not propagate to them. Both were false:
measured on Deno 2.9, a Worker reports the same ceiling as the main isolate, in
`deno run` and in a compiled binary alike. One flag covers the DB worker and
every `worker: true` cell. The page now says so.

Still outside the JS heap, and stated rather than implied: SQLite's page cache
is native memory (`PRAGMA cache_size`, 64 MB per connection), governed by no V8
flag and invisible to the memory monitor.

### Three memory failures, three different signals

A ceiling alone answers one of them. The monitor now names which problem it saw
(`report.reason`), because the fix differs for each:

- **`pressure`** — near the V8 ceiling; the app is about to run out.
- **`machine`** — a large share of the whole machine (default: half) while the
  ceiling is nowhere near. This is the one that freezes a desktop: with a 47 GB
  ceiling, 75%-of-ceiling is 35 GB, and a 64 GB machine is already swapping
  before that fires. Ceiling-relative thresholds are structurally blind to it.
- **`growth`** — climbing steadily with nothing near any threshold. A leak
  announces itself here hours earlier; reporting it only at 75% turned a slow
  diagnosis into an emergency.

And the ceiling stopped fighting the first failure it was built to fix: an
explicit `memory.maxHeap` is now **honoured above 25%**. The automatic share
protects a machine from an app nobody has thought about, but an app that
legitimately needs 12 GB on a 32 GB box is not misbehaving — clamping it to 8 GB
reproduced the original crash with the framework's fingerprints on it. The
author who writes the number has thought about it; boot says so loudly instead,
and points at `systemd MemoryMax=` for a hard total, which is the only place a
real one can live.

## 1.0.0-alpha54 — the last mile (2026-08-08)

Everything between a built artifact and a person using it: updates, releases,
and problem reports. Three mechanisms aio already had the data for and every app
had to invent badly.

### Channelled app updates

```ts
aio.run({ cells: [wallet], updates: "https://releases.example.com/wallet" });
```

One line. The app follows a release channel, and the update state is a **cell**
(`aio/updates`), so a banner is an ordinary reactive read — no transport, no
polling loop, no version comparison, no dialog framework.

**An update never breaks the app or its data.** Every release carries a _signed_
data contract stating, per cell, the schema version it writes and the oldest it
can migrate from — **measured** from the binary
(`<binary> --aio-data-contract`), never guessed from source. Bump a cell
`version` without an `onMigrate` and the release is simply never offered to
anyone holding older data; it surfaces as `updates.blocked` with the reason, and
there is no code path from blocked to installed. A migrating update takes a
consistent `VACUUM INTO` backup **first**.

**The signature moved.** `aio ship` used to sign only the binary's digest, which
authenticated the bytes and none of the coordinates: a genuine, correctly-signed
**test** build copied onto the **prod** path verified perfectly and installed.
The signature now covers the whole manifest core — version, digest, channel,
target, platform, data contract — and v1 manifests are refused rather than
downgraded to. Verification also demands a _trusted_ key (pinned on first use):
a self-signed manifest shipping its own public key is internally consistent and
worthless.

Sources are agnostic. Published artifacts over `https://` or `file://` (three
static files per channel — S3, a Pages site, a mounted share, a USB stick), or a
**git repository**, where a moved ref is the new version: aio clones it, runs
the repo's `compile`, gates the built binary's data contract, then swaps.
Ambiguous URLs are refused rather than guessed — "no updates available" is
indistinguishable from being up to date, and that is the failure this project
bans.

Every target installs. A single-file binary or AppImage is replaced by `rename`
under the running process (writing to a busy executable gets `ETXTBSY`; renaming
one does not). An Electron `.zip` install is a **directory**, which cannot be
moved from inside itself — and on Windows the running `.exe` in it is locked —
so the swap is handed to the system shell, which lives in neither directory.
Android detects and points at the OS; running from source detects identically
and refuses to swap, loudly, so an update banner can be built in dev.

Services get `auto: true`: detect, verify, install, restart, nobody asked. The
failure that shapes it is the 3am one — a new build that will not come up and a
supervisor restarting it forever — so the **new build verifies itself**,
counting its own failed boots and putting the previous artifact back when they
run out.

Channels default to the one **stamped into the artifact at build time**, because
the alternative is silent: a test build following `prod` updates itself into the
public release and vanishes; a prod build following `dev` ships unreviewed code
to users. Overridable by `--channel=`, `AIO_UPDATE_CHANNEL`, or a pin.

Configuring `updates` forces the `net` capability into the compiled binary's
least-privilege flags — without it the check dies in production only.

### Problem reports

```ts
aio.run({ cells: [wallet], feedback: true });
```

A report answers what a maintainer asks anyway: which build (version, target,
channel, commit, platform, artifact path), how it was configured, what state it
was in, what had just happened, recent diagnostics, and the log tail. Plain JSON
in `<data>/reports/`, so a maintainer, a script, an issue tracker and a coding
agent read it identically with no aio installed. `am report list|show|path`.

**Reports honour the app's existing `redactActions` list** — the same one the
journal, timeline and checkpoint honour — withholding a redacted cell's slice
whole and _naming_ it, so absence reads as a decision. A report that ignored
that list would be the leak the list exists to prevent.

Automatic capture on error is the point: the reports worth having are the ones
nobody was there to file. Deduped by message, capped at 10 per session. Optional
`url`/`sink` delivery is attempted only **after** the report is safely on disk.

Everything is capped, and truncation is stated: state above 256 KB is _dropped_
rather than truncated, because half a state tree misleads in a way none does
not.

### Publishing a release

`aio ship github` writes a GitHub Actions workflow that builds Linux/macOS/
Windows, signs each artifact, and publishes into the channel layout the updater
already reads. Emitted, not integrated — the layout is aio's, the forge API is
not. `aio/ship` is now a published run-only entry; it was previously reachable
only from inside this repo, which made the release story unusable for real apps.

### The boot report says what you are running

`build` (source vs compiled, and the artifact kind), `artifact` (inside an
AppImage, the `.AppImage`, not the squashfs mount), `platform` + runtime,
`data`, `cells`, `updates` (channel · kind · cadence · ask-vs-auto) and
`feedback`. Every value read from the running process, never from configuration
— configuration gets copied between machines. An app with no update path prints
`updates  not configured`, once, where somebody will see it.

### A packaged app unpacks itself under its own home, not `/tmp`

An AppImage stages its contents into `$TMPDIR` **before a single line of the app
runs**, so the launcher is the only thing that can decide where. Every aio
launcher now points it at **`~/.<appId>/app` (mode 0700)** — a fourth tier in
the one-directory layout (`AppDirs.app`, listed by `am data`, ②b: regenerable,
but not while the app is running).

`/tmp` was wrong on four counts, measured on the AppImage runtime aio ships
rather than assumed:

- the FUSE-less **extract** path names its directory after a **digest of the
  AppImage** — predictable to anyone on the host — and creates it `0755`, so the
  unpacked app is world-readable. (The FUSE mount path is `0700` and user-only;
  only the extract path leaks.) A symlink planted at a name the extractor writes
  is followed, as the launching user.
- the digest is per-**file**, not per-user: a second user running the same
  AppImage lands in the first user's directory, and the runtime does not fail
  there — it warns, **exits 0, and runs whatever tree is already present**.
- `/tmp` is `noexec` on hardened hosts (the app won't start) and tmpfs on most
  distros (a ~200 MB unpack goes to RAM).
- tmp-cleaners delete underneath long-running apps.

An app that finds itself unpacked somewhere world-writable now says so at boot —
a `security` warning naming the path and the runnable fix. Observe-only and
identical in dev and prod: it still runs, it just never does it silently. Empty
`.mount_*` stubs from a crash are swept on the next start; extracted trees are
kept deliberately (warm start).

Launching one by hand: `TMPDIR=~/.<appId>/app ./app-x86_64.AppImage`, and
`aio/build --print-app-tmpdir` prints that path so a launcher never re-derives
an app's identity itself.

### One app, one id — in dev and once compiled

A compiled binary must never read the cwd's `deno.json` (it would adopt an
unrelated project's identity), so it infers its `appId` from its own filename —
which the build chose. That made "name the binary" and "resolve the appId" one
decision, and it was being made twice: the build read `title ?? basename(root)`
and **ignored `appId` outright**. A `deno.json` with `appId: "wallet"` in a
directory called `thing` was `~/.wallet` in dev and `~/.thing` compiled — the
data directory moved the moment you compiled, which is the one asterisk the
one-directory layout promises it does not have. Worse, the shipping checklist's
advice ("pin `appId` before you ship") was what triggered it.

Both sides now resolve through one `appIdFromConfig` — `appId` → `title` →
`name` → directory — so the binary's name **is** the app's id. Pinned by a
differential test that runs both resolvers over the same project shapes, plus a
guard that fails if the build ever grows its own chain again.

Artifact names change only for apps this bug was already mis-identifying (one
that sets `appId`, or a `name` with no `title`); a scaffolded app is unaffected.

Same class, two more places: **`appimagetool`** now unpacks into a private dir
beside its cache instead of leaving a world-readable copy of the packaging tool
in `/tmp` on every build, and the **lock/socket directory** is created `0700` —
which is a no-op under `$XDG_RUNTIME_DIR` and the whole point under its `/tmp`
fallback (containers, no-systemd hosts), where every app's control socket sat at
a predictable path any local user could traverse to and connect to.

## 1.0.0-alpha53 — one address, one manager (2026-08-08)

Small and additive: the visual manager gets a front door, and binding a single
interface becomes sayable — with the bind address reduced to ONE decider after
the same second-decider trap `expose` fell into in alpha45 reappeared in the new
`host` option.

### `am ui` opens amui

`am ui` now launches **amui**, the visual app manager (detached, Electron by
default, `--client=browser` for a tab) — from any aio app directory, with a loud
fallback naming `jsr:@riagentic/aio/amui` if the install has no amui. The name
finally does what everyone assumed it did.

The UI-state projection it used to print moved to **`am state --ui [user]`**,
where it belongs beside `am state`. The old spelling doesn't guess:
`am ui
alice` refuses with a one-line pointer instead of surprising you with a
window. `deno task amui` no longer forces the browser client, and amui's own
config was migrated to the alpha52 `client:` key.

### `--host=ADDR` / `host:` — bind one interface

`--expose` binds every interface; `host` binds exactly one (a private LAN NIC, a
VPN address, an interface behind a reverse proxy), from the flag or from
`aio.run({ host })`, flag winning.

**It shipped mid-flight with three deciders and only the listener knew about
it** — the boot report re-derived the address from the flag alone (so a
config-set host was reported as `localhost`), the share/local URLs ignored
`host` entirely, and `host` was missing from the `CellsConfig` allowlist, so
`aio.run({ host })` was boot-fatal. On a non-loopback bind that is not cosmetic:
aio printed — and opened a client window at — an address nothing was listening
on. `setupTransport` now resolves the bind once; every consumer reads that one
answer, and `localhost` is only ever printed when the bind truly answers there.
Pinned by boot tests on a real 127.0.0.2 bind (config form and flag-wins form),
and the alpha52 config-docs gate caught the unprinted key on its own.

### The UDS frame ceiling follows the app's WS limit

An app that raises `wsLimits.maxMessageBytes` for large payloads (a base64
attachment) got that ceiling on the WS hop and a hardcoded 10MB cap on the
Electron/UDS hop — the same payload reset the connection mid-send, with no
refusal logged anywhere. `createUDSListener` now takes the app's limit, and
`udsFrameCeiling()` is the one rule both halves read: raise freely, never below
the 10MB floor. Additive; default behaviour unchanged.

### The rest

`aiol` marks a finding `[manual]` (with the reason) when a safe-fix deliberately
declines it, so repeated `--safe-fix` runs converge visibly instead of leaving
`[fixable]` items that never move · `am fix` seals a local-checkout link with a
`path:` pin instead of a version pin, so `am fix` no longer produces a tree
`aiol` immediately calls mismatched.

## 1.0.0-alpha52 — the last call (2026-08-07)

The one big break window before beta, all at once — four design audits, five
work packages, and every approved breaking change front-loaded so beta (and 1.0)
can promise stability. **Every break ships with a working deprecated alias
through beta + a one-time hint at the old spelling + an automated rewrite**
(`aiol --safe-fix` / `am fix --migrate-tasks`). The whole migration was
field-tested end to end on two real apps (1089 tests) — three tooling blockers
found and fixed, then independently re-verified: unmigrated apps run untouched
with accurate hints; migrated apps pass every gate on the new spellings; the
migration is idempotent.

### The honest layer (bugs + guardrails, no breaks)

Sync/async effect-classifier disagreement fixed (mixed `[effect, data]` returns
now fail loud on both paths) · standalone runtime (testUI/testCell/ Android) now
runs `onInit`/`onDestroy` + the circuit breaker — the harness is no longer more
permissive than prod · `--expose` no-auth warning no longer cries wolf on
`auth: true`/`resolveUser` apps · config help table tells the truth (19 missing
keys added, `key`/`dbPath` defaults corrected) · `onMigrate` without `version`
throws at `cell()` · persistence DDL failures are fatal, never warn-and-continue
· `cdiag` health frames now arrive over UDS (Electron) · **big-data
guardrails**: per-cell serialized-size warn (~1MB) / hard error (16MB) naming
the right tier; new doc `docs/persistence/big-data.md` (state / `db:` rows /
blobs / pipelines) · **measured perf**: 10MB-state persist flush 22ms → 0.2ms
(~100×), broadcast ~340× (unchanged-cell skip, deduped serialization) ·
`PRAGMA user_version` belongs to the APP — aio's own schema tracking moved to a
private `aio_schema` table (aio ≤alpha51 wrote user_version; see the docs
caveat).

### One vocabulary (breaking, auto-migrated)

`service` → `server` everywhere · deno.json `target` → `client` · the
`compile:remote:*`/`dev:remote:*` task families retire — `deno task build` over
`build.targets` is THE fleet path · scaffold task diet 30 → ~10 (+ `check`,
`fmt`) · `am new` → `am add` (and it stops generating deprecated code;
`add page` removed) · am's `--client=N` → `--client-index`/`-i` ·
`--kill-existing` → `--takeover` · bare `--server-url` → `--connect` ·
`am fix --migrate-tasks` migrates a repo in one run — and derives
`build.targets` from the tasks it retires, so no fleet information is lost.

### The effect channel (breaking, auto-migrated)

Effects move off the return: `s.$do(effect)` — `return` is always a value now
(returned effects keep working through beta with a hint) ·
`self(method,
...args)` kills the `: CellEffect` TS7022 annotation wart ·
`transaction: true` is the async default (safety: rollback-on-throw, conflict
detection; `--safe-fix` inserts `transaction: false` into undecided cells, and
an undecided async cell hints once at `cell()`) · `$`-prefixed state keys
reserved · `listensTo` array form retires; object form accepts arrays · selector
deps form takes a tuple so deps + parameterized compose ·
`schedule.backoff/poll` argument order fixed (action third), poll's `backoff`
option → `factor`, `blocking` exported top-level.

### Surface diet + safety defaults (breaking, auto-migrated)

Cell `ui:` → `visible:` ("access gates calls, visible gates reads") · **an
exposed app with no per-user auth now gets a generated shared key by default**
(`key: false` is the loud opt-out; loopback unchanged) · `access` without
`visible` REFUSES to boot on exposed/multi-user apps (was a warning) · `aio/db`
runtime values live on `aio/server` (deprecated re-exports remain) ·
`aio/schedule` + `aio/selectors` entries deleted · ~59 sync/state-core engine
internals `@internal` (public surface 479 → 417 symbols) · `call({timeout})` and
`useCell` removed (registry errors name the fix) · renames with aliases:
`checkCells`, `NodeAction`, `testGen`, `StateOf`, one `Access` type · `AioUser`
opens for custom claims · `aio.run<S>()` typed overload · **`app.blobs`**:
content-addressed binary store under the app's files dir, HTTP Range streaming,
dedup by construction — bytes never ride the state channel.

### Internals (invisible, now-or-never)

`protocol/` decomposed to a leaf (browser runtime moved to `browser/`) ·
boundary matrix trimmed 81 → 54 honest edges + root-file conduit rule (edge
laundering impossible) + dead-edge-is-error self-ratchet · ONE offline queue
(one drop policy: oldest, with immediate ack rejection) · `routeEffect` — a new
effect kind is a compile error at all three runtimes · frame×transport `SERVES`
matrix + ignorable-kind tier reserved for wire evolution · dead alpha27 relics
deleted (browser `actions`/`effects`, legacy config branch).

Suite 4190/0 · build-E2E 14/0 · onboard 15/0 · publish dry-run green · all
static gates green. Field verification: risoto-aio 1018/0 + nftpass 71/0,
unmigrated AND migrated.

Upgrade guide: `docs/upgrade/from-alpha51-to-alpha52.md` — or just run
`aiol --safe-fix` + `am fix --migrate-tasks`.

## 1.0.0-alpha51 — zero inbox (2026-08-07)

Every open field-report item across five reports (geng-market, spacy, fezor,
aicontrol, llama-master leftovers) is now resolved or refused — `feedback/`
holds exactly two files again. Plus the first pass of first-class support for
the two canonical app architectures, driven by deep analyses of two real apps.

### The auth seam (geng-market, all seven items)

- **`testUI({ user })`** — mounts an authenticated app signed in on the FIRST
  render, no `/me` stub, no auth-UI internals; `user: null` mounts anonymous;
  identity resets on dispose. `authFeatures` shapes what `<SignIn/>` offers.
- **A denied cell action now REJECTS its caller**
  (`cell "name.method" —
  access denied`) instead of resolving like a success —
  the same contract serverFns always had. A mis-written `access` predicate is a
  one-minute bug now, not a working button that does nothing.
- **`serverAuth()`** — the running app's user store, ambient like
  `serverUser()`: admin screens need no `onStart(app)` plumbing. Throws (never a
  silent null) without per-user auth.
- **`totpCode` on `aio/testing`** — the 2FA round-trip is testable without
  internal imports. **`AuthFeatures`** is a named, exported type.
- The docs' cart example no longer teaches a privacy bug (`ui: { forUser }`
  added, "access gates calls / ui gates reads" called out); aiol checks the
  `aioVersion` pin (doctor was the only checker, and doctor is the diagnostic
  nobody runs on a green build); aiol's Electron advice names commands that
  exist.

### `am` and `aiol` honesty (spacy, all five items)

- `am status` probes the Unix socket a compiled (zero-TCP) app actually listens
  on — no more eternal "starting" for a running production app, and "app not
  running" names the UDS/prod truth when the process is alive.
- `--json` errors go to STDOUT (the stream a script parses) with the non-zero
  exit; `am <cmd> --help` prints usage instead of `{"ok":true}`; aiol's clean
  verdict claims exactly its scope ("No architectural issues found", fmt is
  `deno fmt`'s job); pitfalls.md states which gate covers the bundle boundary
  and why a green suite cannot.

### The two app architectures (new: docs/basics/app-architectures.md)

"One app, many surfaces" (server + thin clients) and "service + rich clients"
(headless service + self-sufficient client apps) are now named, documented end
to end, and supported by analysis-driven fixes:

- **A fleet of clients with nothing to dial warns at build time** — client
  targets with no `server` role and no `build.server` shipped artifacts that
  recorded no address (a real app shipped exactly this).
- **`connectCli` `token:` accepts a function**, resolved before every
  (re)connect — an expiring assertion no longer 401s forever on the first silent
  reconnect; a rejected `token()` follows the normal backoff.
- **`await import("aio/server")` is now external in client bundles** (same rule
  as `*.server.ts`) — the documented lazy pattern no longer drags the server
  entry into the client graph; a static import still fails loud.
- **`readLock` exported from `aio/extras`** — a service's own
  `--status`/`--stop` flags without internal imports.
- targets.md now uses the task names the scaffold actually writes
  (`compile:remote:X`); the Android connect page says to paste the full share
  link against a keyed server. Remaining gaps (two-app test harness API,
  server-URL bake, Android applicationId/TLS, CA distribution) are ranked in
  `todo.md`.

### The rest

- **`openExternal(target)` on `aio/server`** — the per-OS
  open/`cmd /c start`/xdg-open launcher three apps re-derived (and the two
  internal copies had drifted; the bare-`start` Windows form never worked).
  Fail-loud; the disk example uses it.
- **testUI `settle()` drains a fire-and-forget nested dispatch** — a method's
  un-awaited follow-up (`void fs.open(parent)`) left the UI on the old state
  after settle; pending method calls are awaited (bounded, so a deliberate
  long-runner degrades to quiescence, never a wedge). Mutation-verified.
- Doc gaps closed: wasm-bindgen `--target web` + `serveDirs` recipe;
  onMount-without-DOM guard (the doc's own example was unguarded);
  cell-method-from-`onStart` dynamic import; `access` predicate positional args.
- Refused with reasons (feedback/refused.md): `own.setUnique`, a streaming WASM
  crossing, `writeFileAtomic`.
- Housekeeping: ~700 MB of stale local artifacts removed (old coverage,
  AppImage, test homes); the last docs version straggler fixed — docs:check is
  fully quiet; three stale todo entries reconciled with what actually shipped.

Upgrade guide: `docs/upgrade/from-alpha50-to-alpha51.md`.

## 1.0.0-alpha50 — the quiet hunt (2026-08-05)

A bug hunt — hunts 7, 8 and 9 in the same series that produced alpha46–49. No
security holes this time, but a class of defects the security passes were good
at hiding: tests that passed one run in sixteen, invariants held by comment
rather than by gate, a `port: 0` app bricking itself on its own clean shutdown,
and two deciders drifting apart until they disagreed in production.

### A `port: 0` app bricked itself on a clean shutdown — HIGH

`port: 0` is the documented "pick a free port" setting, and it was written into
the lock file verbatim — then `readLock` validated the record with truthiness,
so `port: 0` (falsy) made the lock look corrupt. Every consequence compounded:
`release()` guards on re-reading our own record, so a graceful shutdown removed
NOTHING; staleness is decided from the same data, so the leftover was never
recognised as stale either; so the next launch refused to start forever with
"Already running" — an app bricked by its own clean exit, recoverable only by
deleting a file in a runtime dir nobody knows about. Fields are now validated by
shape (`typeof`, `pid > 0`, `port >= 0`), not truthiness. Singleton enforcement
itself was unaffected (a live second instance is still refused).

### Only the first lock in a process was released on a signal

The cleanup-handler registration is static (right — one listener per process)
but the handler closed over one instance's `this`, so a second locked app leaked
its lock on SIGTERM. The mirror case was live too: tearing the listeners down
whenever ANY lock released un-protected apps still running. "Are the listeners
installed?" and "which locks do they release?" are two facts, now held
separately by a live-lock set.

### Dispatch while time travel is paused lied to the caller

The drop happened inside `reduce`, after the action had been ACCEPTED — so the
caller's promise settled as SUCCESS with nothing applied, and an async method
hung the full call timeout then rejected with a message that was simply false.
`undo` pauses, so pressing undo in the debug panel put every subsequent call
into that state. Refusal moved to the dispatch door, the only place that still
owns the caller's promise: a dropped action now REJECTS, not resolves. Time
travel's own restore bypasses the gate, so undo/redo keep working.

### A deep-merge cycle branch was silent data loss

`seen` was a global visited-set, so it answered "have I ever seen this object?"
when the question that stops recursion is "am I INSIDE it right now?". The first
also fires on a DAG — one object reachable by two paths — so the SECOND
reference merged to the declared default: `{a: shared, b: shared}` holding
`n: 99` restored `b.n` as `0`. Tracking the ancestor path fixes it (a DAG is no
longer mistaken for a cycle) and lets a real cycle fail LOUD with its path;
`MAX_NODES` bounds a shared-at-every-level DAG the same way `MAX_DEPTH` bounds
depth.

### Worker-cell shutdown durability: zero coverage, correct twice over

The "an in-flight method finishes writing" contract is implemented twice — once
for main-isolate cells, once for the worker host — and no in-process test CAN
cover the worker path because `libraryMode` runs worker cells in-isolate. The
implementation turned out correct, but three load-bearing facts were held only
by comments. A real end-to-end test now spawns an app and reads the DB to pin
them: the worker's post-abort write reaches disk, `workerPool.close()` must
precede runtime shutdown (the worker's final writes are ordinary dispatches),
and the drain bound must be below the close deadline.

### Electron reconnected on a different curve from every other client

The shared backoff authority's formula was RE-TYPED inline in the Electron main
script — and the copy had already drifted, dropping the ±20% jitter term. The
emitted `main.cjs` now embeds `backoffDelay.toString()`, so a change to the
shared curve reaches Electron by construction. A copy that cannot drift beats a
copy that is merely correct today.

### Two offline queues, one health question

Cell-method dispatch and `send()` queue independently (structural — the core
cannot import the browser), but "is the connection degraded?" is one fact, and
`isConnectionDegraded()` — freshly importable — consulted only the cell-method
queue. A `send()` caller could back up to dropping actions with the indicator
reporting healthy. Both queues feed it now, and a drop on the core side emits a
diagnostic (it was console-only before).

### The diagnostic bus went silent about going silent

`diagEmit` dedups on `type` inside a 5s window, so a suppressed event could
carry a DIFFERENT message — a second cell failing while the first is still in
the window — and vanish. The window is a deliberate, tested contract and is
unchanged; suppressions are now tallied per type and the next event through
carries `suppressed: N`. "Was anything dropped?" is now something you see.

### The rest

`markAsync` on a client-scoped cell: server accepted it, the browser threw at
module load — blank page for a rule whose job is to refuse the config early ·
Electron's UDS backoff and the shared authority are now one decider (above) ·
`/__aio/<framework src>.ts` was mounted in PROD, re-fetching + transpiling per
request with `no-cache`; now gated on `!prod` · a stale `app.key` after a mode
switch to per-user auth is cleared (and deliberately NOT on "unexposed" — "one
key, use forever") · `access`-gated cells with no `ui` now warn at boot naming
the exposed fields, so the read side of a gate cannot go undecided ·
`_syncSqlite` re-diffed every table because a clone broke its reference
pre-filter; now only changed tables clone · the shutdown flush's SQLite half was
a drifted hand-copy (no error reporting, full-table clone, split baseline); it
calls `_syncSqlite()` now · the `/__aio/pair` 401 hint says `am pair` and takes
the real TTL · an `isConnectionDegraded()` promise in prose the doc-import gate
couldn't see is now checked against the actual exports.

### The tests were part of the problem

Three tests were wrong in ways that hid real regressions: a security test built
its "wrong credential" fixture as `real.slice(0,-1) + "0"`, so when the hex key
already ended in `0` the bogus value WAS the real key — correct accepted, then
the test failed claiming a leak (6.25% of runs, on a security assertion); a sync
test's ordering premise was decided by two wall-clock reads that could tie, the
tie then broken by a random client uuid — a coin flip; and "every harness arms
dev-strict" was a hand-maintained invariant three of five had silently broken.
All pinned behaviourally: near-misses that differ from the key, stamps pinned to
one source, and a gate that fails when `aio/testing` grows a function in neither
MUST_ARM nor EXEMPT.

Suite 4000 (from 3637). Hunts 7/8/9 mutations verified red.

Upgrade guide: `docs/upgrade/from-alpha49-to-alpha50.md`.

## 1.0.0-alpha49 — the perimeter (2026-08-05) — SECURITY

A **security release**. Randomized probes against the auth stack and the
scheduler — the two subsystems earlier hunts had not reached — found 19 defects,
two of them critical. Take this release if you use `auth: true`, `users:` or
`resolveUser`, or if you ship to Android.

### An unauthenticated attacker could take the whole app offline

The per-IP failure budget gated SERVICE, not authentication. Ten wrong logins
against any username — no valid account required — refused that client key for
five minutes: valid sessions, authenticated API calls and WebSocket handshakes
alike, renewable at ~2 requests/minute. And behind the reverse-proxy config the
auth docs themselves prescribed, every client collapsed into one bucket, so one
attacker took the app down for everyone. The credential is now resolved FIRST
and only a presented-and-wrong one meets the budget. The bucket collapse is no
longer silent: a boot warning for an exposed per-user app without
`trustProxyHeader`, and an evidence-based runtime warning the first time a
forwarded-for header arrives untrusted.

### A stolen session was a permanent, unrecoverable takeover

Enabling 2FA needed only a session; disabling it needed the password — so an
attacker with a borrowed session enrolled their own authenticator and NOTHING
cleared it: not a reset, not `am auth passwd`, no `am` command at all. The only
recovery was destroying the account. The code stated the correct principle three
lines above the gap. Enabling now costs exactly what disabling costs, and
`am auth totp <id> off` is a real operator recovery path (the operator's
credential — reading the app's data dir — is strictly stronger than any in-app
account). A reset still cannot clear an ENABLED factor (mailbox compromise must
not be a 2FA bypass) but does drop a staged-and-never-enabled secret, so a
planted secret cannot outlive the rescue. No user-held recovery codes — stated
plainly rather than implied.

### OIDC could take over a local account

SSO matched local accounts by `sub` alone, so an IdP identity whose `sub`
equalled a local username got a session for it — bypassing its enrolled 2FA —
and then REWROTE its email to the IdP's, capturing the password-reset channel
permanently. External identities are namespaced `oidc:<issuer>:<sub>` now; since
`sub` is unique only within an issuer the namespaces cannot overlap.

### The rescue paths did not rescue

A completed password reset left the account LOCKED OUT (renewable forever by the
attacker), and `am auth passwd` — the breach-response command — did not revoke
sessions. Exact complements of one missing invariant: unlock, token burn and
session revocation now live INSIDE `setPassword`, and the redundant per-flow
revokes were removed so there is one decider. Reverting the revoke was initially
GREEN under the fuzzer precisely because the flows revoked separately — that
masking is why the duplicates had to go. `<SignIn/>` also gained a "Forgot
password?" affordance: `features.mail` was fetched and typed in three places and
never read, so the reset flow was unreachable from the shipped UI.

### A demoted admin stayed an admin

Session rows stored the role copied at issue time, so a demotion did not reach a
live session for up to the 30-day TTL — across `/__aio/snapshot`,
`/__aio/trojan/*` and every `access:` rule. Roles resolve live now, on the next
request and on open sockets.

### Scheduled tasks never fired on Android

The standalone runtime — which ships inside the APK — created a VIRTUAL clock
unconditionally, and nothing in a shipped app advances one. Every `after`,
`every`, `at` and `cron` was registered and silently never ran. It survived
because of the other bug in the same file: the harness drove that clock by hand
and re-implemented the scheduler more permissively than production, so
`schedule.every("fast tick!", 5, …)` was green in tests and refused twice over
in production. Two defects propping each other up. The harness now runs the REAL
scheduler with only the clock swapped, and virtual time is an explicit opt-in.

### Timers, workers and the rest

`schedule.after` had no delay clamp (`at` and `cron` both did), so anything past
~24.8 days fired IMMEDIATELY and `backoff` without an explicit `max` became a
1ms hot loop at attempt 22 — aimed at the rate-limited API its own docstring
describes; one clamp now serves every path · `own.set` from a `worker: true`
cell silently did nothing, and now runs in the worker isolate, the only one that
can create AND dispose the resource · a leap-day cron was deleted forever · a
retry could resurrect a schedule `cancelAll()` had just cancelled, during
shutdown · `skipIfRunning` wedged permanently on a hung tick ·
`auth: { totp:
false }` silently stopped VERIFYING for enrolled accounts ·
unauthenticated `/__aio/auth/*` and `/__aio/pair` bodies are bounded (a 48MB
login body was buffered) · confusable usernames can no longer become separate
accounts · auth responses carry `Cache-Control: no-store`.

### Gates

An auth state-machine fuzzer (14 ops against a real server, 12 invariants
asserted after EVERY step) — 3360 ops / 70 seeds clean · a cron differential
against a constructive reference — 20 000 cases, 0 mismatches · a schedule
program fuzzer compared to an independent event model — 4 000 programs, 0
divergences (it found a stale-tick guard bug nobody had reported) · an `own`
churn fuzzer — 90 000 ops clean · and `createVirtualTimers` shipped in `src/` so
the harness and the fuzzers share one decider.

Suite 3637 (from 3583). 15/15 auth mutations and 12/12 scheduler mutations
verified red.

Upgrade guide: `docs/upgrade/from-alpha48-to-alpha49.md`.

## 1.0.0-alpha48 — the third hunt (2026-08-05)

Randomized probes against **observability** and the **client transports** — the
two subsystems the previous hunts had not reached. 19 defects, and two of them
were only findable by running the thing rather than reading it.

### A client with a 2s clock skew was cut off from every update, forever

The transport probe stored a timestamp the BROWSER produced (`ping.t1`) and
subtracted it from the SERVER's `Date.now()`. Past the 2s "frozen" threshold the
broadcaster skips that client entirely — and the offset is constant, so it never
recovered. The socket stayed open, pings kept being answered, and neither side
had any signal. A clock running AHEAD made the gap negative and silently
disabled the freeze watchdog. Measured: `skew 0ms → patch received: true`,
`skew -10000ms → false`. Fixed structurally —
`onClientPing()`/`onClientStateSent()` take **no timestamp at all** and stamp
from an injectable clock, so the cross-clock subtraction is now unexpressible.
The client still computes RTT from its own echoed `t1`.

### A rejected call was delivered anyway — in all three clients

`rejectAll` on disconnect settled calls whose frames were still in the
transport's own offline queue, which survives the close and flushes on
reconnect. One intent → one rejection → one application. Worse, the rejection
text promised "the action is not resent automatically", so an app that retried
as invited applied the write twice (measured: `n=2` for one `inc(1)`). Now one
decider in the shared ack registry: a pending entry tracks whether its frame was
WRITTEN; a disconnect rejects only those, a discarded queue rejects its callers
and says so. The same defect had a second form — the ack clock started at
dispatch instead of at write, because a wrapper function lost the
`ARMS_ACK_TIMER` capability symbol; capabilities now travel with the transport.

### Async and transactional writes existed in no observability sink

They commit as `cell:__set*`, filtered as framework noise by the journal, the
timeline and time travel — but that action is the only record of what an async
method did. Journal replay reconstructed the state as of the CALL while logging
"recovered 1 action(s)"; `am timeline` showed `"diff":[]`; and an undo/redo pair
**permanently destroyed a committed write**. The transactional docs promised the
opposite. `__set` is now recorded with an `origin` attributing it to its method
(not folded into the call-time entry — a method can commit repeatedly via
`$commit`). Fixing it opened a redaction hole immediately: an exact pattern
`"vault:unlockWith"` does not match `vault:__setUnlockWith`, so the write-set
would have leaked what the payload redaction hid. One decider now covers both.

### `redactActions` + `journal: true` made a restart impossible

The redacted payload was re-reduced at boot, so the method ran with no
arguments: with the documented config `aio.run` REJECTED, and the tail persisted
so every restart failed identically. A redacted row is now a refusal marker —
replay skips it and names the types and seq range it could not reconstruct;
`replayJournal`'s signature changed so every caller fails at compile time rather
than silently.

### The durable offline queue was never wired

~1050 lines implementing IndexedDB persistence were unreachable from every
client entry (proven by import closure), while four doc pages promised it with a
24h TTL. An offline edit was lost on reload, silently. The dead stack is deleted
and the docs say what is true; queueing while offline is announced and every
discard rejects its callers with a count. Wiring it instead would need
server-side cid de-duplication — without that, durable replay trades a known
loss for a silent double-apply. Two subsystems that WERE reachable are
reconnected: `ui.showStatus` toggles a real widget again, and client
`degraded()` escalations reach `/__aio/health`.

### Also

Return values that survive lossily are reported per path (53 of 90 fuzzed
classes were silently corrupted — `Date`→string, `Map`/`Set`→`{}`, `NaN`→`null`,
`-0`→`0`); it warns rather than rejects, because the method already committed ·
a sync method returning `null` resolved `undefined` while async resolved `null`
· `connectCliUDS` now requests a resync instead of freezing forever, reports
over-cap discards truthfully, and survives a destructured `bind` · `am cost` no
longer inflates every rate once its ring wraps · the diagnostic checkpoint is
`0600` and honours `redactActions` · the action log enforces `max` at runtime ·
a changed `Date` is visible in the timeline diff · the only real-Electron IPC
test's negative control was inert and is now deterministic.

### Gates

`transport-chaos-fuzz` (seeded drop/kill/reconnect; every promise settles,
resolved ⊆ applied, no double-apply — it catches the reject-then-deliver bug as
an invariant), `return-value-fuzz` (48 classes × sync/async ×
in-process/WS/UDS), `timeline-diff-differential` (states generated through
Immer; **2109/2109 exact** on the plain-JSON shape `persist-guard` enforces),
plus clock-skew, write-set observability, redacted-replay and exactly-once
suites.

Suite 3583 (from 3529). Public surface unchanged.

Upgrade guide: `docs/upgrade/from-alpha47-to-alpha48.md`.

## 1.0.0-alpha47 — the second hunt (2026-08-05)

Randomized differential fuzzers pointed at the two areas the previous pass did
not reach — the **renderer** and the **build**. 17 more defects, and the two
fuzzers landed as permanent gates.

### A build could delete your source code and report success

`out:` pointing at a directory that CONTAINS the app wiped it:
`entry: "apps/web/main.ts"` + `"out": "apps"` printed `✓ 1/1 build(s) → apps/`,
exited 0, and `apps/web/` was gone. `unsafeOutDir` tested membership in a fixed
list rather than CONTAINMENT — so only an exact match was refused, while its own
doc comment promised "never … an ancestor". The existing tests asserted only the
exact-dir case, which is why it survived. It now refuses in both directions by
path SEGMENT (so `apps` and `appsX` are never confused), for every target's app
dir plus `src`, `.git` and `.aio`.

### Four renderer defects that committed the wrong DOM in silence

A differential fuzzer — random tree, random mutation, rendered incrementally vs
mounted fresh from the same model — diverged on ~44% of programs.

- **An unkeyed sibling reorder rendered byte-identical DOM.** The diff located
  an old bare-text node by SCANNING for matching content, while `diffUnkeyed`
  had already computed the correct positional node and simply did not pass it —
  so it matched a node this same pass had just inserted. Any list where two text
  children share a value (`{" "}` separators, repeated labels, equal numbers)
  could re-order in the model and not move on screen.
- **Removing bare text was a no-op** (`removeDom` ends at `getDom`, which is
  null for a string), so `<>{"aaa"}</>` → `<i>` left `aaa` behind, on every
  toggle, forever.
- **An empty Fragment had no anchor in SSR output** while `createDom` emits one,
  so hydrated content landed in the wrong place — rows above their header.
  `mount()` was always correct; hydration-only, and invisible to `testUI`.
- **A component returning a bare string wrote into a sibling's text node** —
  same content-scan root.

Fixing the root (thread the position, delete both scans) surfaced three more,
all pre-existing and silent: a spent `DocumentFragment` recorded as a region
anchor, keyed moves stranding bare text and multi-node components, and a `_Null`
placeholder deleted as if it were a stale anchor.

**Why the class shipped:** the dev tripwire `_assertChildAlignment` compared
COUNTS only, and only for elements. Every one of these is an order/identity
defect at a correct count, so it fired for 1 of 8. It is now a per-child
positional assertion covering Fragment/Suspense/ErrorBoundary regions too.

### The freshness cache guessed at its inputs

It walked the project for `.ts`/`.tsx`/`.css` FROM THE CWD — wrong in two
directions at once. An `App.tsx` importing `./helper.js` or `./data.json` had
those edits invisible (wrong extensions); a monorepo app importing
`../../packages/shared/lib.ts` had the whole sibling package invisible (wrong
root). Both printed "cached — use `--force`" and shipped the OLD code, which
`--compile` embedded verbatim. It now records the input list esbuild actually
read and stats those; **no record means not fresh**.

### A binary took its identity from wherever it was launched

`title` and the client/target default were read from `Deno.cwd()/deno.json`.
Under systemd (`ExecStart` runs from `$HOME`) or inside another project, a
binary served someone else's `<title>` and auto-downloaded Electron despite
`"target": "browser"`. `appVersion` was fixed for this in alpha44; the other two
fields were not. One decider now — the app's own deno.json, found from the
entry.

### Packaging no longer ships whatever `dist/` holds

`compile:android` then `compile:service` embedded the Android IIFE into a server
binary: the prod shell does `const { mount } = await import('/app.js')`, `mount`
is undefined, blank page. The target stamp was read only where the bundle is
REBUILT, never where it is PACKAGED. It is now checked at both.

### Also

`cli-client` compiles the entry you declared (it printed yours and built
`src/client.ts`) · `aio ship` derives its scan dir from the entry and REFUSES to
sign a capability claim it never measured (any non-`src/` layout got "no
permissions") · an out-of-project `compile.include` is refused, not dropped ·
`dev:android` writes `<app>-dev.apk` so a cleartext dev build cannot be mistaken
for the shippable one · one slugify decider (a directory named `My App` no
longer yields a binary literally named `My App`) · the Electron build announces
it when `deno install` rewrites your `deno.json`.

### The gates

`tests/renderer-differential.test.ts` — incremental-vs-fresh AND
SSR→hydrate→mutate, over a text alphabet chosen to COLLIDE, with anti-vacuity
assertions: **68 200 programs, ~770 000 diff steps, 0 divergences**, failing at
round 2 against pre-fix code. Plus `renderer-position-fidelity` (15 pins, all
mutation-verified), a containment table for `unsafeOutDir`, artifact-level
source-survival tests, and bundle-cache tests including an out-of-root sibling
package.

Suite 3529 (from 3495). Public surface unchanged.

Upgrade guide: `docs/upgrade/from-alpha46-to-alpha47.md` — no code changes
required.

## 1.0.0-alpha46 — the hunt (2026-08-05)

No new capability. Three adversarial passes over persistence, the state core and
the server/auth surface — every finding reproduced before it was fixed — plus
the framework's own fuzzers swept far wider than CI runs them (4 800 proxy
programs, 6 400 patch programs, 121 fresh chaos seeds). **27 real defects**,
most of them silent.

The recurring root cause is worth naming, because it is the same one the
WYSIDIWYSIP kata was written for: **a fact written down twice**. A hand-copied
config list, a locally-cloned baseline bridged to a live one, an epoch pinned
once and never re-based, a drop-list standing in for a lookup rule. The fixes
are mechanisms, not patches.

### Three that no existing test could see

- **The flagship CRUD example never booted.** `db:` table names address the ROOT
  state namespace, which under the cells API is the cell-id namespace — so a
  `db:` key either collided with a cell (hard boot error) or was a permanent
  no-op that injected a phantom root key. `examples/contacts` crashed on start
  and the documented `db:` example was the same forbidden shape; CI missed it
  because the example's test is `testCell`-only and never touches that path. A
  `db:` key now binds to the array field it stores, ambiguity is a boot error
  naming both candidates, and a new gate **discovers and boots all 13 example
  apps**.
- **`ui.forUser` failed open.** A filter that threw fell back to "the structural
  filter result" — but with `ui: { forUser }` alone, that is the whole cell. One
  missing field on a user record broadcast every tenant's rows. It fails closed
  now: the cell is omitted, which can never expose more than the filter would
  have returned.
- **`auth: true` left the control plane unauthenticated.** Anonymous local
  callers could read raw state, dispatch, run SQL and replace the whole state
  through `/__aio/trojan/*`; in `users:` mode any non-admin token could too.
  Gated in every mode — and because that locks a developer out of their own app,
  dev apps now mint an owner-only, per-boot `control.key` that `am` and amui
  present. Authority is owning the machine, not membership in the app.

### Data that stopped disappearing

- A **broken migration** reset the cell to defaults and the debounced persist
  then wrote that empty slice **over the stored data** — a fixed build found
  nothing left to migrate. Boot refuses now; nothing is written. The error also
  reaches `onError`, which it could not before: `_reportOpts` was declared below
  the boot call, so reporting a boot failure threw a `ReferenceError` inside the
  error path and masked the real cause.
- A **rollback** re-stamped versions downward, so rolling forward re-ran
  `onMigrate` over already-migrated data — a balance silently zeroed by an
  ordinary rollback. Stamps are monotonic; a downgraded slice is parked verbatim
  at `__downgraded:<cell>`; `onMigrate` now receives the stored fields a rename
  migration exists to read.
- Switching **`persistMode`** booted empty and stranded the document (and
  switching back resurrected stale state). It migrates now, verifying the
  read-back before retiring the source.
- **Dictionary keys naming `Object.prototype` members** — `toString`, `valueOf`,
  `constructor` — were dropped on every restore, because the declared-key test
  was a prototype-chain lookup. Any user-keyed record lost exactly those
  entries. Prototype pollution is now structurally impossible rather than
  list-based.
- State nested past the depth cap is kept **verbatim** and the path is named,
  instead of being silently replaced by defaults.

### Transactions and cancellation

- A **cancelled** `transaction: true` method committed its stale write-set
  _after_ the winner — so `cancelOn`, the documented cure for late-write
  clobbering, caused it.
- **`s.$commit()` poisoned its own transaction**: a single writer, no
  concurrency, rejected with "changed by another action". `$commit` was unusable
  on any cell holding arrays or objects. Fixed at the root — the baseline is a
  re-basable epoch and the bridge that existed only to paper over it is gone.
- **`cancelOn` could not reach a call queued behind `serialize: true`** — "Stop"
  ran every remaining job in full. The controller is created when a call is
  _made_ rather than when it _starts_, which closes the window by construction.
- A **`listensTo` handler's single effect return** was silently dropped.
- A **`BigInt` in state killed the process** from an observe-only diagnostics
  hook — and in one variant left the method promise unsettled forever.

### Sessions, origins, and the rest

- Revoking a session left its **WebSocket fully authorized** — logout ACKed
  dispatches. Sockets are now closed on revocation.
- A **stale session cookie** locked the legitimate user out of login for five
  minutes; an ambient cookie is not a deliberate credential presentation.
- A submitted **`Origin` could self-certify** by claiming to be localhost, so
  any page on another loopback port could open an authenticated socket.
- **`key:` + `auth:` + `--expose`** refuses at boot — proven irreconcilable
  rather than assumed.
- `sync` + a hiding `ui` filter is **refused at compose**: CRDT replication
  sends every op to every peer, so a per-user view cannot survive it. Filtering
  the op stream would swap a silent leak for silent divergence.
- `db.execute()` rejects a multi-statement string instead of running only the
  first; a row beyond 2^53 names its table and column; the journal keeps mode
  `0600` across compaction; `am pair` exists.

### Gates, which are the durable part

Eleven new ones: a transaction differential (one writer ⇒ transaction and
serialize must be observationally a no-op, ~2 300 programs), two generative
`ui`-shape properties, boot-every-example, config-bridge hop 2 completeness,
cursor durability, a fuzz-knob contract, and a shared op vocabulary so the two
differential fuzzers cannot drift apart. All three fuzzers now **throw** on an
unreadable seed — `SYNC_CHAOS_SEED=abc` used to run seed 0 and report a
confident green for a program nobody asked for.

Suite 3495 (from 3377). One exported type gained a required field
(`SyncHandlerDeps.getClientCellState`) — constructed only inside the framework,
but named here rather than called "strictly additive".

Upgrade guide: `docs/upgrade/from-alpha45-to-alpha46.md`.

## 1.0.0-alpha45 — the network boundary (2026-08-05)

Two field reports, written independently, reached the same verdict: everything
inside one process was excellent, and everything that crossed a socket had a
sharp edge. The three worst were silent — a filter that did not filter, a
certificate only browsers accept, and a promise that resolved on failure. An app
author cannot see any of them from their own code. All three are closed, and
verifying them found four more on the same seams.

### A sync cursor is now durable by construction

Found by the `sync-chaos` fuzzer during the release run, and **reachable in
released alpha44**: a client's confirmed state could end up permanently missing
ops — 94 where 97 were expected — with no error anywhere.

`server_ts` was issued from an in-memory counter that ran ahead of anything the
op-log could prove. Every duplicate re-send (a reconnect replays its whole
pending buffer) burned a timestamp no row carried; compaction and D11-rejection
deleted rows that held others. After a restart the server re-seeded from the
surviving row maximum and began issuing timestamps **below a cursor it had
already echoed to a client** — and since delivery filters `server_ts > cursor`
strictly, those ops became undeliverable to that client forever.

The reservation is now durable by construction — the high-water mark of the
op-log _and_ the compaction watermark — and a duplicate no longer burns a
timestamp. Pinned by `tests/sync/cursor-durability.test.ts`, including a
300-step property that every cursor ever handed out remains a valid delivery
boundary across duplicates, rejections, compaction and restarts. Two indexes
were added for the new lookups (`IF NOT EXISTS`; no migration).

### A per-user filter now really filters

`ui: { forUser }` with no `include`/`exclude` beside it classified as the `raw`
patch strategy, so every delta was computed from **unfiltered** server state and
narrowed only by subscriptions — `forUser` guarded the initial frame and nothing
else. It corrupted as well as leaked: raw ops carry raw array indices, and the
client's array had already been shortened by the filter, so rows landed at the
wrong position (the reporter's "one field reflected the filter, another was
stale"). `docs/state/cell-visibility.md` had documented `forUser ⇒ full` all
along — the code contradicted its own contract. Pinned as a **property** (a
per-user filter is never bypassed by a strategy, whatever `ui` shape is added
later) plus a two-client wire test that proves the leak they could only infer.

### `--expose` and the CLI client compose again

Their diagnosis (a missing `basicConstraints`) was **refuted** empirically: the
cert works fine as a pinned anchor, and adding `CA:TRUE` is what rustls rejects.
The real causes were two: `connectCli` had no way to trust a cert at all, and
every aio cert on earth shared `CN=aio-local`, so a stale or sibling-app cert
shadowed the right one and produced their exact `BadSignature`. Certs now carry
a per-app CN (plus `CA:FALSE` and an authority key id), existing certs on disk
are reused untouched, and the boot warning names non-browser clients — which
refuse outright where a browser offers click-through — and the fix.

### A CLI call tells you what happened

`connectCli().bind(cell)` resolved a bound call even when the server-side method
threw; the ack frame carries `ok` and `error`, and the client read neither.
Return values were dropped the same way. Verifying it found worse:

- **every async bound method was broken outright** — the binding awaited a local
  pending-call promise that only an in-process executor can settle, so a
  _successful_ remote call rejected 30 seconds later with "stopped waiting";
- a **disconnect resolved** outstanding calls, reporting success for work whose
  fate is unknown;
- an action sent **while reconnecting** was neither written nor queued — a
  silent write loss in the window a reconnecting client lives in.

One ack registry now serves the browser and both CLI transports, per connection,
so one client's disconnect can never settle another's calls.

### `am` mutations were ungated (found in review)

`verifyInstance` — whose own comment records a green e2e writing its rows into a
production leaderboard — guarded reads only. Every mutation (`dispatch`, `sql`,
`shutdown`, `trigger`, `snapshot`) could retarget whatever app happened to hold
that port. Now gated, with a bounded TTL so a long-lived `amui` cannot refuse
the right app by quoting one that exited. `am stop --port=N` identifies the app
from that port instead of the current directory, and names the real cause —
"port speaks TLS", "nothing is listening" — instead of a bare "app not running".

### The four its own diagnostics did not catch

- **An `afterRender` that threw took the whole render with it.** The button that
  toggled the theme stopped _existing_ — two debug cycles away from an effect
  that threw after it had rendered. An effect can no longer un-render the tree
  that scheduled it.
- **In the test surface, an absent boolean was a callable.** `checked` was
  serialised only when true, and the handle proxy turns unknown properties into
  lazy callables, so the natural assertion for "off" was unwritable and the
  failure named neither cause.
- **Cell config inference was order-dependent.** `onMigrate` above `state`
  inferred the state type from the hook, and every method body silently lost its
  typing — reported ten lines away, saying nothing about ordering. `state` is
  the sole inference site now.
- **Hot reload updated the bundle but not the booted cell set.** A UI that
  rendered and did nothing, with the truth visible only through `am`. The
  server's booted cells ride the `cfg` frame; the client says so, with the fix.

### Quieter, sharper, and one thing everybody saw

- **Every aio app had an unwanted white border.** The shell shipped no CSS reset
  and no template ships a `style.css`, so every app inherited
  `body{margin:8px}`. A two-rule baseline now ships on every target, before the
  app's stylesheet so one rule overrides it.
- The secret-name heuristic no longer fires on `latency`, `sequence`,
  `currency`, `reference`, `influence` (`enc` was matched as a bare substring)
  or on measurement suffixes — a warning that cries wolf teaches people to reach
  for the escape hatch without reading it.
- `aiol` no longer reports a plain **write** as a post-await read. The exemption
  was line-level, so a `deno fmt`-wrapped assignment had no `=` on the reported
  line and the hint was unsilenceable without lying. Tooling scripts no longer
  count against the logger rule.
- **`serveDirs`** — two apps in one repository can share a pure module instead
  of a generated mirror a test has to police. Dev-only, read-only, every
  `baseDir` guard unchanged.
- **`expose` is a config key** and **`--expose --no-tls`** is sayable (loudly
  warned) for payloads already end-to-end encrypted; the privacy warning and the
  transport read one resolved value, so config-expose cannot silence it.
- **Per-target build entry** — one repo, two apps — with the array form
  unchanged.
- A compiled binary missing the embedded SQLite worker says so and names
  `--include`, instead of advising a permissions fix that cannot help;
  `dbWorkerInclude()` is exported.
- `am dispatch --args='["…"]'` gives positional arguments a spelling;
  `t.as(user, fn)` tests `serverUser()` without an internal import; `appVersion`
  says `unknown (…)` rather than a confident `0.0.0`; an effect-budget violation
  names `perfBudget.methods`.

Upgrade guide: `docs/upgrade/from-alpha44-to-alpha45.md` — three observable
behavior changes, none requiring code.

## 1.0.0-alpha44 — what you see is what you ship (2026-08-04)

A field report showed a prod Electron window with a white border dev never had:
dev served the app's stylesheet from the app dir while the build copied it from
a hardcoded `src/` — prod silently shipped without CSS. The root cause is a
pattern, not a file: **two deciders** for the same fact. This release hunts that
pattern down and installs single deciders with loud failures around them — plus
a shutdown contract that lets an in-flight method finish writing.

### WYSIDIWYSIP — dev/prod UI 1:1 (new kata)

- **One app-dir decider.** `BuildConfig.appDir` = the entry's directory, the
  same rule the runtime uses — it now drives the bundle's `App.tsx` import and
  the `style.css`/`icon.png` copy on every target, including the Electron AppDir
  and dev-window icon. Missing `App.tsx`, a stray `src/style.css` in a
  non-`src/` app, or a swallowed copy now **fail loud**.
- The Android local shell no longer hand-rolls its HTML — it delegates to the
  one head builder (it had shipped a different viewport, no
  `viewport-fit=cover`). Gate: `tests/shell-parity.test.ts` — dev-vs-prod shell
  byte parity outside an allowlist of observe-only dev scripts.
- **Two more second-deciders killed:** `dev:android` booted its server on a
  literal `src/app.ts` (a flat app hung the emulator forever); `out:` pointed at
  the app's own source dir would have recursively **deleted the app** — both now
  go through `resolveEntry()`/`resolveAppDir()`, the named deciders.

### A streaming method's last words survive shutdown

Closing an app while an async method streamed into state killed the method
mid-write (`EFFECT_ASYNC_ERROR`) and lost the tail. The contract now: an
in-flight call gets to finish **writing** — it just never gets to start new
work. Shutdown aborts every in-flight `s.$signal` first, tracks and waits for
async calls (the drain had nothing to wait on before), accepts effect commits
while draining, then seals. Both waits are 3 s deadline-bounded and logged;
instance-scoped, so one app closing never aborts another's methods. The same
contract covers the corners the adversarial review then found: a
`serialize: true` call that starts DURING the drain is born aborted (the sweep
can only reach controllers that exist at sweep time), and a `worker: true`
cell's host now aborts + drains its own isolate and acks — instead of a flat 50
ms and a terminate. Gates: `tests/dispatch.test.ts`,
`tests/shutdown-inflight.test.ts`.

### The build cache was dead — and hid two hazards

`isBundleFresh` stat'd a deleted file, the catch said "not fresh", and every
build since the methods restructure re-ran esbuild. Reviving it exposed: no
**target stamp** (an `--android` build could reuse a browser-shaped bundle that
boots to a blank WebView), and a one-level-deep walk (editing
`components/Btn.tsx` in a flat app re-shipped the old bundle). The check now
walks the framework tree and the WHOLE app project (skipping generated and
vendored output — so `packages/shared/` and `vendor/` bust the cache too, and a
deleted `style.css`/`icon.png` is removed from `dist/` instead of shipping
stale) and stamps artifacts per target; `runBundle` refuses a config with no
`appDir`. Gates in `tests/e2e-bundle-smoke.test.ts` — each fails against the
pre-fix code.

### Forged provenance stripped at every door

The three network entry points (WS, UDS, trojan) stripped `_user` and
`payload._origin` but not `_source` or `_syncOp`. A client forging
`_source:"Effect"` could start new work during shutdown drain; forging
`_syncOp:true` made a sync-cell write **durable nowhere** — in memory, lost on
restart, no warning. All four fields now go through ONE decider
(`sanitizeClientAction`) at all three doors: forged values are stripped **and
logged** (an attack signal, not a shrug), and `_source` is re-stamped `"UI"`
rather than deleted, so app hooks keep real provenance. Pinned in
`tests/server.test.ts` (WS), `tests/aio-402-uds-ack.test.ts` (UDS), and
`tests/glm-residual-guards.test.ts` (trojan — whose first version POSTed to a
route that does not exist and passed vacuously; it now proves the dispatch ran).

### Silent failures, said loud

- **`client.log` grew forever** — its rotation existed, documented, called by
  nothing. `client` is a `LogKind` now, governed by the one on-start policy
  (wipe by default, `.N` under `backupLogs`); the duplicate rotator is deleted,
  and `AioLogger.path()` no longer aliases unknown kinds to `error.log`.
- **Client diagnostics were themselves the silent failure** — diag events
  checked for a dev overlay that nothing injects and dropped the event on every
  page. One sink now: overlay when present, console otherwise, severity-mapped,
  dedup ahead of delivery. `tests/diag-sink.test.ts`.
- **`useInterval`/`useRaf` `active` was a mount-time snapshot** — the hooks' own
  documented example could not start or stop a timer. `active` is re-read every
  render and really starts/stops the loop (one shared `useActiveLoop`).
- **`am` turned typos into confident wrong answers** — `--timeout=2s` is NaN,
  `setTimeout(…, NaN)` fires in 1 ms, so discovery swept the LAN for a
  millisecond and blamed your firewall. One `parseNumArg` across
  discover/top/surface — and across the global flags too
  (`--port`/`--lines`/`--wait`/`--client`, which the review found still doing
  the silent NaN→default); garbage now names the flag and exits.
- **`aiol`'s post-await-read rule was inverted** — it skipped type-annotated
  methods (the real-world shape) and flagged `s.$signal.aborted` and
  `until(() => …)`, the documented patterns. Fixed and mutation-tested;
  `mod.ts`'s flagship example now shows what the primitives are for.

### Field-report items closed

`ui.keyDown`/`ui.keyUp` in `testUI` + `am trigger` · `ui.expectCell` on
`scope:'client'` cells · dev warning for listeners added on the Deno global ·
`useInterval` hook · **per-method perf budgets**
(`perfBudget.methods["cell:method"]`) · `schedule.every` `skipIfRunning` ·
**`examples/contacts`** — the end-to-end CRUD example (state ↔ `db:` table,
refusing validation, parameterized selectors, `checkIntegrityOnBoot`).

### Test honesty

The e2e harness piped and drains child output (a crash now fails in ~160 ms with
the child's own stack instead of a 120 s "timeout: server up"), which
immediately diagnosed a real intermittent failure: **every scaffolded e2e app
shared one appId** and therefore one single-instance lock — each now gets
`appId: e2e-<uuid8>`. The two randomized fuzzers accept `FUZZ_SEED`/
`FUZZ_ROUNDS` (defaults unchanged for CI); ~13 000 extra programs swept across
seeds with **no divergence**.

Upgrade guide: `docs/upgrade/from-alpha43-to-alpha44.md` — no code changes
required.

## 1.0.0-alpha43 — silence into signal (2026-08-02)

A framework's worst failure is the one it does not mention. This release is a
sweep through every outstanding field report from apps built on aio, and the
theme picked itself: nearly every finding was something going wrong _quietly_ —
an op acknowledged but never applied, a `Date` that came back a string, a test
that passed because it was covering nothing. Each is now either impossible or
loud.

### Sync: three ways a write could vanish

`dispatch` reports failure by REJECTING its promise, never by throwing. Two
places wrapped it in `try/catch` and believed they were covered:

- **A failed dispatch was acked, broadcast and compacted away.** The op was
  persisted, the origin was told it landed, peers applied it — and compaction,
  which snapshots _live_ state, then deleted the row. The change existed on
  every machine except the one that owns the truth. A failed dispatch now makes
  the op poison: deleted, unacked, unbroadcast, with the reason sent back.
- **The scheduler's failure handler had never run.** Retry, cleanup and "giving
  up" were all unreachable. Making them live exposed the policy as wrong, too: a
  repeating schedule now _survives_ a failed tick instead of cancelling itself.
  One transient blip must not switch a poller off for the life of the process.

Two more, found by pulling the same thread:

- **An ack could double-apply an op a snapshot already contained.** A
  `mode:"snapshot"` response installs live server state, which already holds the
  client's in-flight ops; the ack then applied one a second time. The client
  cannot dedup by id — a snapshot never enumerates its contents — so snapshots
  now state the `server_ts` they reflect and `sync-ack` carries the op's own.
- **Compaction deletes by HLC; delivery reads by `server_ts`.** A client holding
  a cursor but no HLC watermark was told it was caught up while the ops it
  needed had been compacted away. `sync_meta` gained a `compacted_ts` watermark
  (with the first schema migration these tables have needed).

Both wire additions are optional and backwards compatible with an older peer.
Reconnect-flushed ops also stopped skipping the validate check, and an access
denial now reaches the client instead of leaving it re-sending forever.

### Persistence: JSON was corrupting state on the way to disk

The persist path was raw `JSON.stringify`, which silently drops `undefined`
keys, turns `NaN`/`Infinity` into `null`, a `Date` into a string, and a
`Map`/`Set` into `{}`. None of it surfaced at write time; it surfaced as wrong
state on the next boot. Every such value is now named with its exact path and
the fix, reusing the serialization pass that already happens.

### Profile integrity — new

The ~150 lines every app storing user data eventually writes by hand:

```ts
await app.db.snapshot(path); // VACUUM INTO — safe on a live database
await aio.run({ checkIntegrityOnBoot: true });
```

A damaged file is **quarantined** beside itself with a timestamp — never deleted
— and if a `<db>.snapshot` exists the app boots on it, saying what the restore
lost. No snapshot means starting empty, said loudly, rather than booting on a
file SQLite cannot read. A file too damaged to even scan counts as damaged, not
as inconclusive. Both new `DB` members are optional, so custom implementations
stay valid.

Also: `db.close()` no longer terminates the worker underneath writes still
queued behind the writer lock — they were neither awaited nor aborted, and their
promises never settled.

### Auth

- **The per-account lockout could be outrun.** Counting failures with a
  read-modify-write across PBKDF2's ~100ms meant twenty concurrent guesses
  advanced the counter by one; the only defence a botnet's rotating addresses
  cannot sidestep was off for anyone who simply did not wait. Now one atomic
  statement.
- TOTP codes are **one-time-use** (RFC 6238 §5.2); `/totp/setup` refuses while
  TOTP is enabled (staging a new secret over a live one could lock the owner
  out); `password` and `totp/disable` respect the per-IP budget; the fail-budget
  map is bounded.
- A login **session** no longer authenticates from `?token=` on ordinary HTTP
  requests — it leaks through history, proxy logs and `Referer`. Share links,
  the CLI and the `/ws` handshake (which has no header channel) are unaffected.
- `am new` validates its argument, which had been going straight into a file
  path _and_ into generated source.

### Tests are the strictest environment

- **`testCell` emptied the cell registry**, so the first `testCell` in a file
  silently disarmed every later `testUI`: zero cells booted, `expectCell`
  asserting against declared initial state, green tests covering nothing.
- **A call now starts when you make it**, as in production — which is what makes
  cancel-in-flight and supersession expressible at all.
- **A failure nobody awaited surfaces** at `settle()` or at the end of the test;
  a sync method's throw **rejects** as it always did in production; `expectCell`
  on a non-booted cell fails loud; `waitFor` no longer swallows `TypeError`s.
- All five harnesses arm dev-strict through one entry point, and a UI listener
  registered on the Deno global is called out — it never fires under `testUI`,
  and that silence has cost an app its whole suite.

### Renderer

`ErrorBoundary` and `Suspense` rebuilt content with `appendChild`, so a boundary
with siblings after it jumped to the end of its parent. `useEffect` (compat) was
dismantled by the first re-render with unchanged deps. `<Transition>`
re-animated on every render. `useDimensions` never re-observed a replaced
element. Browser transport: pending calls are rejected on disconnect instead of
hanging out the 15s ceiling, `markAsync` is honoured by the browser stub, and
per-method call budgets actually apply.

### Cross-platform builds

```sh
deno task build --platforms=host,windows,macos-arm64
```

One machine, one command, three executable formats — ELF, PE and Mach-O. The
host artifact keeps its plain name; cross builds are labelled and recorded in
the manifest with their triple. Electron and Android package with per-OS tooling
and are refused with a reason rather than silently emitting a host binary under
a foreign name. The artifact gate reads magic bytes, so a renamed host binary
fails it. A build producing no recognised artifact is now a failure — it used to
report success while the binary sat stranded in the project root.

There is deliberately no "one binary for all three": Linux, Windows and macOS
use different executable containers and syscall ABIs. One artifact per platform,
from one command, is the honest version of that wish.

### `cancelOn: { method: "self" }`

Newest wins: a new call aborts the ones still running, never itself. The shape
every search-as-you-type, folder scan and autocomplete needs, and one a
self-reference could not express (a cell's own methods do not exist yet inside
its `cell()` literal). Naming a missing or sync method throws at definition.

### Examples

- **`examples/contacts`** — the end-to-end CRUD story: a SQLite-backed list via
  `db:` auto-sync, validation that refuses in plain code, parameterized
  selectors, create/edit/delete, no transport code anywhere.
- **`examples/disk`** — subprocesses and the filesystem from a cell, with cancel
  and supersession across the `.server.ts` boundary.

### Also

A freshly scaffolded app passes its own linter (it failed on creation, which
teaches that the linter is noise); a compiled binary carries its own version
instead of reading the launch directory's `deno.json`; surface `text` is always
a string; `am surface`/`am trigger` are documented as the primary dev loop
rather than an ops tool. Published text — comments, changelog, roadmap — now
describes field reports by type rather than by application name.

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
cell config key 'machine:' was removed in alpha27 — guards are a guard
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
a structural hardening pass, one new headline feature, and every item from the a
field report — each fix behind a guard that makes its whole bug class
unshippable.

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

### A field report — every item

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

### A field report's open list — closed, with two refusals

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

### A field report, round two — the friction found by building 1000 more lines

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

### From a field report — six silences made loud

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

### From the field

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

The dream-list release: a real financial app drove its whole backlog to zero on
this framework. Every item below is framework-general — capabilities, not
one-app policy.

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

**Field-report P1s.** The `Deno is not defined` blank-screen trap (machine U1):
dev-boot graph findings are now LOUD — blocking client-breaks `console.error`
with file:line, `Deno.*`-in-client- reachable-modules `console.warn` with the
`*.server.ts` fix (was debug-only). `s.users.find(…)` returns a LIVE element
proxy so a write held across an await batches instead of being silently dropped
in prod. `ui.surface()` staleness fixed at the root: the auto-memo skip now
re-points the component instance at the tree vnode, so a structural branch swap
driven by the child's own signal stays resolvable.

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

Five field reports worked end to end. The theme: every fix either **removes** a
silent failure or makes it **loud, early, and attributed** — never silent, late,
and anonymous. Each fix ships with a regression test proven to fail on revert.

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
  signals are no longer orphaned across re-renders — with a real e2e harness
  that reproduces it.
- **UDS transport buffers patches across the throttle window** instead of
  dropping the ones that arrive mid-window.
- **14 verified bugs** from a multi-aspect audit, and three fail-loud gaps from
  one field report, each pinned by regression tests.

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

Every open item from all three field reports closed — each countersigned or
resolved with the fix cited in-code.

### Added

- **`bootCells` + virtual-clock schedules — every effect is now testable.**
  `import { bootCells } from "aio/testing"` boots several cells on the real
  dispatch loop with no component (the multi-cell `testCell`), and
  `await ui.advance(ms)` (also on `bootCells`) runs a **virtual clock**: every
  `schedule.after`/`every` captured and fired when due — toast auto-dismiss,
  debounce, `backoff`, `poll` all get deterministic unit coverage with no real
  timers. (`schedule.at`/`cron` stay wall-clock and warn once.) The one item
  that blocked "test every use case" in one field report — countersigned 10/10.
- **`schedule.next(id, action)`** — the honest "defer to the next tick"
  primitive, replacing the `schedule.after(id, 1, …)` sentinel apps were
  writing. Same-id replace still dedups.
- **Electron: external links open in the system browser.** `will-navigate`
  relays only **same-origin** URLs as in-app navigation — a cross-origin link
  can no longer `pushState` a routerless app onto a dead path (white screen on
  reload). Renderers get **`__aioIPC.openExternal(url)`**, with the main process
  enforcing an http/https allowlist.
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

- **Conditional element bindings froze inside `<form>` .** Under testUI, a
  conditional binding (or fragment-root component) anchored as a direct `<form>`
  child never re-reconciled while sibling text bindings stayed live. Root cause:
  happy-dom wraps `HTMLFormElement` in a Proxy, so the reconciler's
  `.parentNode === parent` containment guards failed identity and silently
  skipped removals/inserts. All guards now use a proxy-agnostic `isChildOf()`;
  the report's full repro matrix is pinned as tests.
- **SVG camelCase attrs render.** `stopColor` → `stop-color` (and the common
  camelCase set) — gradients no longer render black.
- **Async multi-await write loss locked.** Writes after any `await` are
  guaranteed to land (property-tested), and the await-commit model is documented
  loudly: every `await` commits + renders.
- **Dev failures got loud .** Discovery bind failures print a startup warning;
  editing a _cell_ file warns "cells do NOT hot-reload — restart to apply";
  port-in-use fails loudly; transient post-restart imports show "Building…" and
  retry instead of the error card.
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

## 1.0.0-alpha16 — deep-audit cleanup + field-report fixes

A full per-file audit (no correctness bugs found) plus the cleanup it turned up,
and every open item from the a field report and a field report field reports.
Non-breaking: additive API only (`deno task doctor` / `aio/doctor`,
`schedule.backoff`), no changed semantics.

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
