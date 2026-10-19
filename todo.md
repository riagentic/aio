# Road to 1.0.0-final

Shipped work: `CHANGELOG.md`. Field reports: `feedback/resolved.md`,
`feedback/refused.md`. Needs a major: `untracked/v2.md`. This file holds only
what is OPEN, what is DECIDED (so it is not argued again), and measured facts.

## 1. State

- Current release: 1.0.20-beta (2026-10-14). The rounds after it (hunts of
  2026-10-14/16, the field reports and the shared Electron runtime of
  2026-10-18) are prepared locally as 1.0.21-beta (version, `CHANGELOG.md`,
  upgrade guide); not tagged, not pushed.
- Surface frozen since 2026-09-04: additive only, bugfix-only through beta.
  1.0.0 = a date, once releases have been boring for several weeks — the owner's
  call.
- Compatibility rule (owner, 2026-10-10): never flip a default; a green build
  stays green; an app upgrades with `am pin` + `am fix` and no manual edits. The
  better-but-breaking behaviour ships as an opt-in; its default flip goes to
  `untracked/v2.md`.
- Say "closed as far as v1 allows", never "all fixed" or "bug-free".

## 2. Standing policy

- Additive-only: new features behind new exports/options, never changed
  semantics; `@experimental` is the only escape hatch. What needs a break goes
  to `untracked/v2.md` with the four facts (wrong / shipped instead / v2 /
  breaks).
- A release is never pushed with a known unresolved bug.
- Every gate is a ratchet (`check:silent-catch`, `check:vacuous`,
  `check:sanitizers`, `check:log-prefix`, `check:dead-wiring`): a count only
  goes down; raising one costs an argument in the commit.
- A new validator is proven by BOOTING an app, not only by unit tests.
- A status line is not evidence: re-audit a report against the TREE.
- Discoverability is a feature: a reader greps `am help` for their own word and
  will not browse — help lines carry INTENT words; one fact has one producer.
- A null result is not a result until the instrument produced a positive one. A
  seeded test must prove it met every case (2026-10-10: an overflowing LCG made
  `rnd(4)` always 0, so a property test never met its subject).
- A gate that fires on correct code gets muted: check a new gate's SILENCE as
  hard as its finding.
- A flaky test is a resource leak with a cause — find WHY the child is late
  before lengthening a wait.

## 3. Decided — do not re-litigate

Refused (one line each; long form in `feedback/refused.md`):

- `aio migrate` codemod (`aiol --safe-fix` is it) · an `io:` method kind · a
  terminal renderer for AIR · `UI_CSS`/`UiStyles` merge · a `scratch:` slice · a
  `listensTo` fan-out queue · serverFn response writes · starter cells.
- `am trust --replace` · `am shot` X11/Wayland capture fallback · a
  `check:vacuous` rule for "handler ran zero times" · the named `CellState`
  bound · an open JSX index signature for unknown tags · typing selector `deps`
  from the literal (`docs/state/cells.md`).
- `--client=headless` (`testUI` is the headless driver) · `am start --scratch`
  (`--instance=<name>` is the private copy) · an `aio/media` export
  (`am shot --video`, `testUI --video`) · a generic Electron main-process
  extension point (one door per capability) · `updates.allowCrossOrigin`.
- `electron.permissions: "strict"` (`permissions: {}` already denies all) · a
  `getCellHealth` server key (no caller) · a dialog for "refused by its server"
  (cannot tell busy from refusing) · following worker files in `validateGraph`
  (the skip reason carries `file:line`).
- Seven renderer warnings stay dev-only, each with its reason in
  `tests/prod-says-guard.test.ts` (slot swap, untracked read, missing/mixed
  keys, child desync, unknown event, control drift).
- Automatic repair of a sync row left unmarked by 1.0.9–1.0.18: nothing those
  builds wrote proves the row unacknowledged.
- Builds: `zip -9` / `.7z` · a DMG strip list · a custom Electron build · UPX ·
  ICU/Deno trimming. (A shared Electron runtime, once refused here, is built in
  1.0.21: `build.electronRuntime: "online"`, which `am create` writes; no key
  stays `"offline"`; the default flip is v2.)
- Field asks (2026-10-18): `aiol --safe-fix` rewriting an `onInit` `setTimeout`
  to `app.dispatch` (measured unsafe: dispatch runs before later cells'
  `onInit`) · `s.$progress(done, total)` (`s.$commit(minMs)` is it) ·
  `am dispatch --watch` (`am state <path> --watch` beside it) · graph layout
  helpers and an inspector example (an app library's job, not aio's core).

Design limits, documented where a user meets them:

- Unkeyed `collectHead()` under concurrent streaming (v2 §30) · global
  `routePath` (v2 §28) · `visible` filter + `sync` on one cell is refused at
  boot (`docs/state/cell-visibility.md`).
- `journal: true` with listened sync ops costs ~5–10% ops/s, and two fsyncs per
  op under `synchronous = FULL`.
- Data last run by 1.0.9 re-derives no `listensTo` reaction of a sync op; a
  1.0.9 `am kill` still removes a backup hold's lock.
- macOS nohup detection is a TTY heuristic. The timeline byte estimator samples
  large containers (`src/diagnostics/retained-bytes.ts`). Attribute names follow
  `setAttribute`: `1abc` / `-a` are refused on both sides.
- Electron: a child window from `openWindow` has no popup policy of its own;
  `--client=electron` connect mode has no `requireSandbox`.
- The trim guard does not see a path computed at run time
  (`build.keepPackages`). A `blocking()` job module must be in a compiled
  binary's graph (a static import).
- Handler-less `value`/`checked` controls keep typed text (1.0 behaviour, one
  decider `_keepsTyped`, `tests/air-keeps-typed.test.ts`); the hint names
  `defaultValue`.
- Update patches cover single-file installs only (`binary`, AppImage). Zip,
  one-click `.exe`, `.app` and Android installs download whole.

The CA decision (2026-09-21): no intermediate; two locks instead.

| verifier                 | anchor name constraints | anchor EKU |
| ------------------------ | ----------------------- | ---------- |
| openssl                  | enforces                | enforces   |
| rustls / NSS / Go        | enforces                | —          |
| Windows CryptoAPI        | enforces                | enforces   |
| macOS Security.framework | enforces                | IGNORES    |
| Java / Android Conscrypt | IGNORES                 | IGNORES    |

- `serverAuth` EKU carries Windows + openssl; rfc822Name/URI bases (`.invalid`)
  carry macOS. An intermediate closes only the Java row and costs a new root +
  `am trust` on every machine → v2 §31.
- An existing root is reused verbatim and WARNED about once, never regenerated.

## 4. Open work

Triaged on 2026-10-12 (59 boxes + an outside audit) and again on 2026-10-18 (the
field reports and this list against `git log v1.0.20-beta..HEAD`): what was real
and needed no owner is built and in `CHANGELOG.md`; what would break an app is
in `untracked/v2.md` §65–§73. What is left needs a decision, a person, hardware,
or is small and known.

### Owner decides (each has a recommendation)

- [ ] Pairing by code trusts the first certificate it sees. The sound answer is
      a PAKE; designed and probed (CPace on X25519, no new dependency), not
      built: three hand-written implementations, one in Kotlin, and a device
      test (v2 §65). Opt-in in 1.0.x, or v2? Recommended: opt-in, after 1.0.20.
- [ ] Update patches for directory installs: keep the installed release's
      archive as the base (one archive of disk per install, 100–190 MB for an
      Electron zip; ~80 lines client, 15 publisher, half a day with a VM run).
      `.app.tar.gz` cannot patch without a format change. AppImage and zip patch
      sizes are not measured.
- [ ] Android deep links as `android.schemes` (~150 lines + a page event; when
      an app asks).
- [ ] `am create` does not write `build.android.strict`: the 1.0.19 linter
      reports any unknown `build.*` key as an ERROR, so a scaffold pinned back
      would fail `deno task lint`. That holds for every future scaffold key
      (`build.electronRuntime`, written since 1.0.21, included).
- [ ] `scripts/proof.ts --require-current` as a release gate (report-only
      today). A Windows CI job (YAML in the audit worker's notes; cannot be
      proven without a push; `continue-on-error`).
- [ ] Windows: taskbar pins after the AppUserModelID change (pin a 1.0.19
      window, upgrade, start: does the window join the pin?). `am kill --json`
      there: 1.0.20 adds `"how"`, asks first (app exit 0, was 1), and can say
      `killed: false` with exit 1 when the process survives.
- [ ] An `online` app's plain `--compile` binary (target `binary`) answers
      `--aio-electron-runtime` with "shared", so each update first fetches its
      Electron (~100 MB) into the store — also for a binary that only ever opens
      in a browser (since 1.0.21; nothing breaks, it costs bandwidth). The
      binary cannot tell before boot whether its client will be Electron.
      Recommended: the build bakes the default client into `electron.json`, and
      the prefetch skips a browser-default `binary`; its first
      `--client=
      electron` start downloads with the progress window, as
      any online start.

### Known and small

- [ ] Tests: run together in ONE `deno test --parallel` process (not the shard
      runner, which isolates files), `updates-git-ref-exact`, the git-source
      case of `updates-e2e`, `am-version-pin` and `am-versions-self-heal` fail
      at `git` — the same on v1.0.21-beta, so a test elsewhere in the update
      files leaks process-wide state (env or cwd) into them. Found 2026-10-19;
      the suite runner is green.
- [ ] Boot: an Error built under a call site deep in one long function costs in
      step with that depth — V8 scans each frame's position table up to its call
      site; `Error.stackTraceLimit` does not change it (measured 2026-10-19: 2
      µs → 12 → 58 → 237 µs for a 10 / 1k / 5k / 20k-statement function on the
      stack). Done after 1.0.21: `_runPhases`' long blocks and long calls,
      `_runAsApp`'s body and `setupTransportInner`'s `createServer` call are
      functions of their own — a boot's missing-path NotFound went ~72 → ~25 µs
      (12 per boot). Left: call sites deep inside `createServer` (~2000 lines,
      the watcher and stylesheet checks) and `startLifecycle`; and moving
      `_runPhases`' phase functions out of the function itself.
- [ ] Electron zero-port (IPC): the main process holds the socket; no
      silent-socket watchdog there (the page's rule is in
      `src/browser/browser-vitals.ts`, `connectCli`'s in
      `src/server/cli-client.ts` since 1.0.21). The page watchdog is proven on
      the Android WebView and by fake-socket tests, not in a desktop browser
      with a black-holed socket; the 20-beat ceiling is unit-tested only.
- [ ] Discovery: the real-socket test assumes a machine hears its own broadcast
      (true on Linux; not run elsewhere).
- [ ] Dev: one extra restart at dev start for an app whose start rewrites a cell
      file with the same bytes. `am start` cannot tell "Deno still fetching"
      from "fetched, app silent" (it reads the last log line). A local-socket
      listener re-created on the same path right after `shutdown()` in one
      process was unreachable for 10 s once (test only, not traced).
- [ ] Sync: a row left by a kill under 1.0.9–1.0.18 still stops the start; the
      message names the file and a tool-free repair. `am sync drop-op` refused.
- [ ] Android lane: 15/15 on API 35 and API 36, twice each (2026-10-12, load
      11–35). Its taps are not retried. Record the proof at release:
      `AIO_PROOF_RECORD=1 deno task test:android`; WebKit lane green 3/3
      (`AIO_PLAYWRIGHT_DIR`), row not recorded.
- [ ] Under the mutation gate's load (4 workers, 45 min)
      `tests/test-shards-leftover.test.ts` was red unmutated once and green
      alone (its planted suite was not green); it now prints the shard log and
      stderr, so the next sighting says why.
- [ ] Linux, seen once (full release check 2026-10-14, loaded box), not
      reproduced 0/42 (12 alone, 30 under 10-way load):
      `shutdown-signal-says-why-e2e` SIGHUP — app.log had a `stopped uptime=`
      line ABOVE the `SIGHUP received` one, outside the 2000-char tail the
      message showed. The message now prints every log file in full; the next
      sighting says whether it was a second boot (a dev restart) or a log order.
- [ ] Windows VM under suite load (4 cores), alone-green ×3: `retained-bytes`'s
      timing ratio (estimate ×20 < `JSON.stringify`). Updates: creation-time
      tunnelling may also touch
      `record(previous, …, { is: identity(current), moving })` in
      `updates-apply.ts` (folders did not tunnel when measured).
- [ ] Tests: the chaos fuzz's draws depend on timer order (a `FUZZ_SEED` replay
      is not exact under load); `auth-db-busy-timeout`'s measured unit is not
      confirmed at macOS background priority; own-HOME for test browsers is
      Linux only; `tests/electron-handshake-watch.test.ts` now runs in the
      serialized real-window lane.
- [ ] Windows stub, next rebuild: a cut-short download's box says "not an aio
      SFX (missing AIOSFX02 trailer)" — say "this download is incomplete,
      download it again" (seen on w11pro 2026-10-19; needs a re-pinned stub).
- [ ] Windows: no ledger row for the stub's Rust (a `cargo test` row made the
      real checkout reuse the mutant's binary); the first `am state` after a
      1.0.19 app boots timed out once (8 s, fixture without `node_modules`). The
      stub's message box for a shortcut it cannot add was never seen.
- [ ] macOS: Spotlight lists every kept version of an installed app;
      `pruneVersions` knows one `current`, not a running version (guarded in
      `run.sh` for the bundle only). Full runs on the Mac keep their ssh session
      open: a detached job cannot send LAN broadcasts there.
- [ ] Code health (audit): the first cut of `single-instance-lock.ts` is done
      (App ID resolution → `app-id.ts`, 196 → 183 KB); the lock file and the
      other 150–280 KB hotspots are uncut. 293 silent-catch blocks, ratcheted.
- [ ] Deno: a close for cause can lose its code to an unread frame
      (`_closeAfterRead` narrows it; the reconnect's 401 ends it right);
      `node:dgram` reports EHOSTUNREACH as `UNKNOWN`.
- [ ] Page size: message prose is a fifth of the download; codes would need a
      source convention at ~300 sites (v2 §68).
- [ ] Refusals: one stable `code` and a one-line summary head on each harness
      refusal (`DEAD_BOOT` is the first, 1.0.21); the rest carry prose only
      (field report).
- [ ] `am errors`: a hot reload's errors are not tagged or superseded by reload
      number (`--since` filters by time only; field report).
- [ ] Upgrade test breakage: the shapes that go red are a list in
      `docs/upgrade/README.md`; no machine-readable index or
      `am migrate --tests` (field report).

- [ ] Android, from the real-phone round (Saga, Android 14, 2026-10-13):
  - A font-scale or display-size change reloads the page (committed state kept,
    typed text lost). `fontScale|density` in `configChanges` might stop the
    WebView picking up the new scale — measure first.
  - Not done on the phone (battery at 2 %, the port charges at 900 mA): the
    whole lane with the three new steps (they passed there alone, and 17/17 on
    the API 35 emulator), share link and TLS over real Wi-Fi, split screen,
    picking a real file, keyboard insets on Android 15+. New in 1.0.21, never on
    a phone: a `blob:` export saved into Downloads, a download from a pinned
    self-signed server, the dev overlay on Home for 90 s (a hidden page is no
    longer `frozen`), `strictPin` refusals on the client APK.
- [ ] Windows: `Deno.Command.spawn()` of a program that has never run stops the
      app's event loop while the system checks the file — 1–11 s measured (2–5
      ms the second time). An app that starts its window answers nothing
      meanwhile: `am state` got "accepted the connection but never answered
      (waited 8000ms)". Once per install or update for a real app. Two ways out,
      both measured or sized, the owner picks: (a) create the exe once SUSPENDED
      on a pool thread and end it, then spawn (0 of 80 after; the next spawn 3–6
      ms) — the patch is kept as `untracked/round3/first-run-verdict.patch`, but
      "create suspended" is a shape security tools watch; (b) do the real spawn
      in a Worker and proxy pid/status/stderr/kill — larger. The other `spawn()`
      sites (`spawn.ts`, `updates-apply.ts`, `updates-check.ts`,
      `open-external.ts`, `app-version.ts`, `dev-restart.ts`) pause the same
      way.
- [ ] Windows Defender (signatures of 2026-10-12): a compiled binary that
      carries `esbuild.exe` whole in its data was refused at start as
      Trojan:Win32/Cloxer in 15 of 20 builds — a CLOUD verdict. What the build
      ships leaves esbuild out and was never flagged (cli 0/5, server 0/3);
      `build.keepPackages: ["esbuild"]` is warned at build since 1.0.21. Open:
      the Electron-target server exe was not measured. Lasting answers are the
      owner's: a code-signing certificate, or a false-positive report to
      Microsoft.

- [ ] Field wish (network, 2026-10-17), deferred: `ZoomPan` for `aio/ui` (wheel
      zoom at cursor, drag pan, fit).

- [ ] Web target: every deploy re-downloads every asset-mount file (the cache is
      per build). A content-addressed asset cache was tried (2026-10-18, 4
      review rounds, each found a 🔴: activation race with the 1.0.20 adopt,
      quota mid-adopt, integrity fetch buffering whole bodies, `#fragment`
      misses, byte-rewriting hosts) and reverted to the 1.0.20 design plus an
      ordered, capped install. Needs a design written and attacked BEFORE code.

- [ ] Windows suite, seen 2 of 4 full runs (2026-10-19), never alone: the first
      test of `tests/updates-patch.test.ts` fails "An async call to left was
      started before the test, but completed during the test" — an op an EARLIER
      file in the shard left running (that file has sanitizers off). 13 targeted
      runs green; the op name `left` is not one aio or Deno's sources were seen
      to use. Next time: `--trace-leaks` on the whole shard.
- [ ] Windows, over SSH only (2026-10-19, once): `lock-zombie-verdict`'s
      `--takeover (production)` case hung 8+ min with A (`--prod`) and the
      lock-path `deno eval` both alive; 3 reruns over SSH and every scheduled-
      task run green.

### Before the release

- [ ] One full `check:release` green end to end on Linux; the full suite on the
      Windows VM and the real Mac at the release commit; `test:onboard` and
      `test:build`; the three build-lane browser tests edited for
      `browserHomeEnv`; a cold stub rebuild (`check:release` now says when it
      was skipped).
- [ ] Record the proof rows (today: 1 of 16 proven, 5 never recorded, 4 stale,
      android BEHIND its build path; the Windows rows are BEHIND the stub
      rebuilt for `.aio-sfx-files`): `deno task update:proof`.
- [ ] Real OS, new in 1.0.21 (Linux, the w11pro VM, the Mac):
  - `electronRuntime: "online"`: first start downloads into the store with the
    progress window (Cancel, Retry/Quit offline), a second app starts from it
    with nothing shown, an update that changes Electron fetches it before the
    swap, `am prune` keeps it; macOS: the window clone signs and opens.
  - The window profile's one-time move into `~/.<appId>/electron/` from a 1.0.20
    install (signed-in state and window size kept).
  - Windows: delete a listed file in a one-click install, double-click → it is
    extracted again (`.aio-sfx-files`); the todo §5 one-click steps 1–4 on the
    rebuilt stub; the win-pipe `NtReadFile`/`NtWriteFile` path under the full
    suite.
  - macOS: `run.sh` waits (`open -W`), an app that dies at once fails with its
    log, `AIO_APPLICATIONS_LINK=1` shows in Launchpad and `am remove` deletes
    it.

## 5. Needs a human

- The Windows icon (1.0.20): the downloaded one-click `.exe` shows the app's
  icon in Explorer, the Downloads folder and on the desktop; the Start-menu
  shortcut shows it too. Proven through the shell's API on the VM, never looked
  at by a person.

- Windows one-click `.exe`, real desktop session (proof rows `app-on-real`):
  1. First open: "Installing <name>…", a moving bar, no Cancel; it closes and
     the app window follows — content, not white. Start menu: one shortcut.
  2. Second open: no progress window. Two fast double-clicks on a fresh install:
     one progress window, one app.
  3. App running + another version's `.exe`: "… is running … Nothing was
     changed". Close it, open the newer `.exe`: new version, one shortcut. Then
     the older `.exe`: the newer app opens.
  4. Delete the download while the app runs: allowed. A truncated `.exe`: a
     message box with the reason. Note what SmartScreen / Defender show.
  5. Terminal: `am upgrade <name>` (app closed) opens no window and prints
     `installed <v> … (the app was not started)`; `run.ps1` returns once the
     window is up, `$LASTEXITCODE` 0.
  6. Sign an `.exe` with the real certificate, `run.ps1 -NoRun`: one install
     under `aio-sfx\`, none under `Programs\`.
  7. A real app updating itself from the `.exe`; Bluetooth/USB/serial pickers.
- macOS: press each "Move to Applications" button once on a Mac. Then a real
  download: Safari's allow-downloads click, Open Anyway (`spctl` rejects the
  ad-hoc app from a quarantined image), then the offer; the DMG double-click.
  The `aio-macos` desktop may still show a Safari sheet or a "control Safari"
  prompt. `sudo safaridriver --enable` there, once.
- iPad, 10 minutes, same Wi-Fi (`deno task build --targets=web`, serve
  `dist/<name>-web/`; server steps: `--expose --no-tls --client=server-only`):
  1. Note the iPadOS version. Open the URL in Safari: themed app, no blank page,
     no sideways scroll (below 15.4: "the browser engine is too old").
  2. Tap + three times, reload: 3. Rotate: layout follows, count stays. Tap a
     text field: no zoom. Switch to Dark: the page follows.
  3. Share → Add to Home Screen → open: no Safari bars, nothing under the status
     bar, count 3. (https only) Airplane mode: still renders, + gives 4.
  4. Open the server's share link, tap +. Home for 60 s, return: reconnects by
     itself, count current. Wi-Fi off, tap +, Wi-Fi on: "Reconnecting…" clears
     and the tap arrives. Done 2026-10-12 on an iPad mini 5, iPadOS 26.7.1,
     Safari, share link to a dev server: the page opens, taps reach the server
     (count 3), no client error. Not done: reload, rotate, Dark, Home Screen,
     leave and return, Wi-Fi off and on. With a USB cable to the Mac (trust
     once, Settings → Safari → Advanced → Remote Automation) `safaridriver` can
     drive most of these.
- Android phone: USB debugging on, accept the prompt, then
  `AIO_ANDROID_SERIAL=<serial> AIO_PROOF_RECORD=1 deno task test:android` (never
  run on hardware). Play upload needs the owner's keystore.
- Xcode: download `Xcode_16.2.xip` (Apple ID) for the macOS 14 VM, plus the iOS
  simulator runtime (`xcodebuild -downloadPlatform iOS`). The first build must
  check what was written by reading only (2026-10-12): `ViewController.swift`'s
  load-failure handling (`#unreachable`, `#keyed`) compiles and `loadFileURL`
  keeps the fragment; the iOS connect page offers the share link only. Then ATS,
  icon alpha, no shared scheme, no UIScene.
- Done 2026-10-13 on a real phone (Saga, Android 14, WebView 141):
  `test:android` 15/15 twice; the run now takes its client APK and its
  `adb reverse` rule back off a phone. Record the `android (device)` row on the
  release commit while the phone is attached.
- An Android 10 phone proves the floor (`minSdk` 29 since 1.0.20; a bare
  emulator image's WebView is older than the 98 the bundle needs, so no emulator
  can); any real phone proves hardware and `android.colorScheme`. One level
  each, the owner's: Android 10, iOS / iPadOS 15.4 (where `structuredClone` and
  `Object.hasOwn` arrived). An iPad run counts for the engine, not for the notch
  or a phone-sized keyboard.
- A Developer ID (Apple Developer Program, Team ID; a "Developer ID Application"
  certificate in the signing Mac's keychain; notary credentials via
  `xcrun notarytool store-credentials aio`). aio signs ad-hoc only
  (`src/build/dmg.ts` `codesignScript`); the by-hand steps are
  `codesign
  --force --options runtime --timestamp -s "Developer ID Application: …"`,
  `notarytool submit --wait`, `stapler staple`, then re-make the `.app.tar.gz`
  and `.dmg`. Unproven here: no certificate. Authenticode for the Windows `.exe`
  likewise.
- File the Immer issue (needs the account): `shallowCopy` uses `slice`, V8's
  slow path on a frozen array. Text and a repro that ran are ready (round-3
  notes, `immer-issue.md`).
- The Windows VM holds about 14 GB this project's tests made (`C:\aio-test`, lab
  folders, ~150 test profiles, two scheduled tasks `\fixD-*`); the list is in
  the round-3 notes. Nothing is deleted without the owner's yes. Same for
  `~/.cache/aio/tools/windows-sfx-stub-target` here (an old shared cargo cache,
  unused since the cache is keyed per checkout).
- This workstation: (verify) remove the test-made profiles in `~/.config`
  (`deno task check:home-clean --list`; also `Electron`, `ipc-test`,
  `reload-cfg-e2e`, `route-e2e`, `aio-csp-probe`, `aio-android-e2e@…`);
  `git worktree prune` for two entries under `/tmp/run-sh-e2e-*`.
- Still owed: the 72-hour soak; an off-box remote report. `install.sh` against a
  repo committed under `umask 077` names the cause; it cannot fix it.

## 6. Measured facts worth keeping

- A one-row change costs O(whole state), not persistence. Median per toggle
  (2026-10-10, one core): 1k rows 0.07 ms core / 0.35 ms dev; 10k 0.40 / 0.72;
  50k 2.0 / 3.0 (dev was 19.4 before the state-diff line stopped serializing the
  value). Four fifths of the core is Immer: `slice()` on a frozen 50k array 0.96
  ms, unfrozen 0.095, `[].concat(x)` 0.107, spread 0.018 (fills holes).
  `s.items = tenThousandFreshRows` spends ~29 ms in finalize. Immer 11.1.21 is
  slower on this shape. `fixKeyOrder` is 13%.
- Sync op under `synchronous = FULL`: two fsyncs, `op-door-full` p10 ~8.9 ms;
  one fsync measured ~5.6 ms and was rolled back (v2).
- Standalone/Android per-dispatch fsync at 1.08 MB state: 0.710 ms/key, 35.9×
  the debounced path.
- Page (2026-10-12): 223.2 KB raw / 82.6 gz / 79.1 served; its 317 messages 41.5
  / 15.6 KB; codes would save at most 15.9 KB gz (19.3%) against a 16.7 KB gz
  table, and 288 of the 317 reach their sink through a helper.
- A socket in airplane mode: one on wifi is destroyed (close in 0.5–2.3 s); one
  on mobile data keeps existing with no route and never closes. Android WebView
  writes `localStorage` to disk about a second late.
- A limited broadcast (255.255.255.255) leaves by ONE interface — the VPN's when
  one is up. macOS: a detached job whose login session ended cannot send to the
  LAN at all (EHOSTUNREACH).
- An import-map value pointing into a folder with a JSR-package `deno.json`
  makes Deno 2.9.7 resolve that package's bare deps through its own map
  (relative values, run and compile; not an absolute or `file:` value under
  `deno compile`).
- Binary: 6.7 MB embedded in ~107 MB (counter); `.d.ts` is 1.1% of a 132 MB
  binary. One-click `.exe` 133.5 MB against a 171 MB zip.
- Update patch between two 104.6 MB binaries one commit apart: 10.7 KB, 27 s to
  make, 0.1 s and ~210 MB to apply. Deno's `node:zlib` ignores a zstd
  `dictionary`; `systemMemoryInfo().available` is 0 on Windows.
- Windows: `%APPDATA%` alone does not move Electron's `userData`,
  `%USERPROFILE%` does. A lock held share `None` for `Read` is still readable.
  Named pipe: `GetOverlappedResult(bWait=FALSE)` ignores its handle; the FFI
  pool is exactly 32; reopen if `drain` ever READS through its handle.
- macOS background QoS stretches sleeps ~3.5× (SQLite's 1 s busy wait took 3517
  ms).
- Android: a kill 122 ms after a change lost it before the native store; now
  survives at 52 ms. WebView floor 98, Safari/iPadOS floor 15.4.
- Controls: a handler-less input costs 0.29 ms per 1000 (was 0.05) since the
  decider reads the live value.
- A one-file `deno run` build (2 MB) does not boot: the SQLite worker file and
  the page bundle are not inside it. x509 alternatives refused: `@peculiar/x509`
  = 19 packages / 2.06 MB; `node-forge` has no ECDSA signing. Deleting
  Electron's `default_app.asar` breaks it silently.

## 7. Known gap: the harness cannot cross a transport boundary

(The project instructions point here.) `testUI`/`testCell`/`bootCells` run
dev-strict but in-process. Closed so far, each by a DIFFERENTIAL (same scenario
in-process and over the real hop, identical state required):

- method payloads + returns over a real WebSocket —
  `tests/transport-differential.test.ts`
- worker-cell parity — `tests/worker-parity.test.ts`
- sync-method replay in real Chromium —
  `tests/transport-differential-browser.test.ts`
- `testUI` client calls, thrown errors, `serverFn` and `useAio().send` cross the
  action wire — `tests/wire-harness-differential.test.tsx`. For errors,
  `serverFn` and `send` this is opt-in (`TestUIOptions.wire.strict` /
  `AIO_TEST_WIRE=strict`; new scaffolds and aio's own suite are strict); the
  default is the 1.0.19 harness plus one stderr line per kind.

- a login: form → server → cookie → reload → sign-out in one test —
  `tests/auth-login-joined.test.tsx` (`testPageFetch`).

Still not crossed: the page's socket after a login (cell state there comes from
`testUI`'s in-process cells; e2e only).
