# Road to 1.0.0-final

Shipped work: `CHANGELOG.md`. Field reports: `feedback/resolved.md`,
`feedback/refused.md`. Needs a major: `untracked/v2.md`. This file holds only
what is OPEN, what is DECIDED (so it is not argued again), and measured facts.

## 1. State

- Current release: 1.0.19-beta (2026-10-07). The clean-desk round of 2026-10-10
  and the todo/audit round of 2026-10-12 are prepared locally as 1.0.20-beta
  (version, `CHANGELOG.md`, upgrade guide); not tagged, not pushed.
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
- Builds: `zip -9` / `.7z` · a DMG strip list · a shared or CDN Electron runtime
  · a custom Electron build · UPX · ICU/Deno trimming.

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

Triaged on 2026-10-12 (59 boxes + an outside audit): what was real and needed no
owner is built and in `CHANGELOG.md`; what would break an app is in
`untracked/v2.md` §65–§73. What is left needs a decision, a person, hardware, or
is small and known.

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
- [ ] Let `build.strictPin` cover the Android client: refuse a keyed
      non-loopback `http://` link and the https→http fallback of a pairing typed
      without a scheme. Recommended: yes (only new or hardened apps change).
- [ ] The keyless load to a changed, unproved certificate still sends that
      host's non-key cookies (a login session). Dropping them logs users out
      whenever a server regenerates its certificate.
- [ ] Android, each small and additive: unsigned `.aab` for an unsigned release
      build (~15 lines, adds bundle time — yes, low priority); keystore path +
      alias in `deno.json` (`build.android.keystore`, `keyAlias`; env wins;
      passwords never — ~35 lines in `releaseSigning`); deep links as
      `android.schemes` (~150 lines + a page event; when an app asks).
- [ ] `am create` does not write `build.android.strict`: the 1.0.19 linter
      reports any unknown `build.*` key as an ERROR, so a scaffold pinned back
      would fail `deno task lint`. That holds for every future scaffold key.
- [ ] macOS: an installed app is not in Launchpad. Design measured on macOS 14
      (a symlink in `~/Applications` is listed within 5 s): opt-in
      `AIO_APPLICATIONS_LINK=1` in `run.sh`, and `am remove` deletes the link
      first. Also: `open -W` so `run.sh` waits for the app as it does on Linux?
- [ ] `scripts/proof.ts --require-current` as a release gate (report-only
      today). A Windows CI job (YAML in the audit worker's notes; cannot be
      proven without a push; `continue-on-error`).
- [ ] The one-click stub checks only the stamp, `<name>.exe` and
      `electron\electron.exe` before its fast path; another damaged file still
      launches broken. Design: the stub writes `.aio-sfx-files` (path + size) at
      extract and verifies it when present; `carrySfxStamp` does not carry it.
      Needs a stub rebuild and a VM run.
- [ ] v2 §25 promises a subpath export "when asked"; the `aio/media` refusal
      says no. Pick one.
- [ ] Windows: taskbar pins after the AppUserModelID change (pin a 1.0.19
      window, upgrade, start: does the window join the pin?). `am kill --json`
      there: 1.0.20 adds `"how"`, asks first (app exit 0, was 1), and can say
      `killed: false` with exit 1 when the process survives.

### Known and small

- [ ] Electron zero-port (IPC): the main process holds the socket; no
      silent-socket watchdog there (the page's rule is in
      `src/browser/browser-vitals.ts`). `src/server/cli-client.ts` has its own
      ping, not examined. The page watchdog is proven on the Android WebView and
      by fake-socket tests, not in a desktop browser with a black-holed socket;
      the 20-beat ceiling is unit-tested only.
- [ ] Discovery: a remote host on two shared subnets is listed twice (needs a
      machine id in the ad — an additive wire field). The real-socket test
      assumes a machine hears its own broadcast (true on Linux; not run
      elsewhere).
- [ ] aio client: in a picker-launched window every in-page navigation re-enters
      `connectTo`; a tokenless link in a keyed app would answer 401 (read, not
      run). A host with no pin gets the jar's cookies whatever certificate it
      shows later. Not strict: Chromium's own connections are not checked
      against the pin (strict / v2 §58 closes it).
- [ ] Updates: a damaged kept download whose record entry was already swept
      still refuses its release; a single-file release that keeps failing its
      swap is never dismissed (dismissal is directory-only). `allowScripts`
      drift is decided only for exact entry against exact import (a lock-based
      rule was refused: ~40 lines, low value).
- [ ] Build: the outside-project mount warning can print twice per boot
      (`_servedAssets` runs in `aio-server.ts` and `server.ts`); the
      machine-bound-imports warning says the binary "runs here" where it runs
      nowhere (the smoke run refuses it); the relative-`importScripts` finding
      reads the worker's entry file only; no test covers the `stubRebuildNow`
      spawn or the build-summary key warning wiring (pure parts are tested).
- [ ] Dev: the catch-up look does not cover `watch: ["file.ts"]` (a file, not a
      directory); one extra restart at dev start for an app whose start rewrites
      a cell file with the same bytes. `am start` cannot tell "Deno still
      fetching" from "fetched, app silent" (it reads the last log line). A
      local-socket listener re-created on the same path right after `shutdown()`
      in one process was unreachable for 10 s once (test only, not traced).
- [ ] Sync: a row left by a kill under 1.0.9–1.0.18 still stops the start; the
      message names the file and a tool-free repair. `am sync drop-op` refused.
- [ ] Android lane: 15/15 on API 35 and API 36, twice each (2026-10-12, load
      11–35). Its taps are not retried. Record the proof at release:
      `AIO_PROOF_RECORD=1 deno task test:android`; WebKit lane green 3/3
      (`AIO_PLAYWRIGHT_DIR`), row not recorded.
- [ ] Under the mutation gate's load (4 workers, 45 min) two tests were red
      unmutated once and green alone: `tests/test-shards-leftover.test.ts` (its
      planted suite was not green) and a lock dir of a test process's
      `apps-<pid>` sandbox was still there when `check:orphans` looked (gone
      later; the `test` gate had failed before it, so the suite's own post-check
      did not run).
- [ ] Linux, seen once (full release check 2026-10-14, loaded box), not
      reproduced 0/42 (12 alone, 30 under 10-way load):
      `shutdown-signal-says-why-e2e` SIGHUP — app.log had a `stopped uptime=`
      line ABOVE the `SIGHUP received` one, outside the 2000-char tail the
      message showed. The message now prints every log file in full; the next
      sighting says whether it was a second boot (a dev restart) or a log order.
- [ ] Windows VM under suite load (4 cores), alone-green ×3: `workers: "real"`
      tests miss the 30 s ready deadline because `deno test` type-checks the
      worker entry's graph when the worker starts (6 s idle, twice in one shard)
      — let the shard runner check the worker fixtures first, or run the shards
      `--no-check` (check is its own gate); `retained-bytes`'s timing ratio
      (estimate ×20 < `JSON.stringify`). Updates: creation-time tunnelling may
      also touch `record(previous, …, { is: identity(current),
      moving })`
      in `updates-apply.ts` (folders did not tunnel when measured).
- [ ] Windows: tests that name `/tmp/…` or `/nonexistent/path` as a literal make
      `C:\tmp` (`xdg-int-*`, `xdg-left-*`, `.X11-unix`) and
      `C:\nonexistent\path` on the VM. Find them with a guard that fails when a
      suite run leaves a new entry in the drive root (removed by hand
      2026-10-12).
- [ ] Tests: the chaos fuzz's draws depend on timer order (a `FUZZ_SEED` replay
      is not exact under load); `auth-db-busy-timeout`'s measured unit is not
      confirmed at macOS background priority; own-HOME for test browsers is
      Linux only; `tests/electron-handshake-watch.test.ts` now runs in the
      serialized real-window lane.
- [ ] Windows: no ledger row for the stub's Rust (a `cargo test` row made the
      real checkout reuse the mutant's binary); the first `am state` after a
      1.0.19 app boots timed out once (8 s, fixture without `node_modules`). The
      stub's message box for a shortcut it cannot add was never seen.
- [ ] macOS: Spotlight lists every kept version of an installed app;
      `pruneVersions` knows one `current`, not a running version (guarded in
      `run.sh` for the bundle only); an app that exits at start under `open` is
      silent and `run.sh` exits 0. Full runs on the Mac keep their ssh session
      open: a detached job cannot send LAN broadcasts there.
- [ ] Code health (audit): `single-instance-lock.ts` is 196 KB; the smallest
      safe first cut is "App ID Resolution" (lines 369–686, no lock state) into
      its own file, re-exported. 294 silent-catch blocks, ratcheted.
- [ ] Deno: a close for cause can lose its code to an unread frame
      (`_closeAfterRead` narrows it; the reconnect's 401 ends it right);
      `node:dgram` reports EHOSTUNREACH as `UNKNOWN`.
- [ ] Page size: message prose is a fifth of the download; codes would need a
      source convention at ~300 sites (v2 §68).

- [ ] Android, from the real-phone round (Saga, Android 14, 2026-10-13):
  - A `blob:` / `data:` download cannot be saved (a standalone app's "export"
    button) — refused out loud since 1.0.20. Build: the page reads the blob, a
    native bridge takes the bytes, the user saves through
    `ACTION_CREATE_DOCUMENT`. The download listener does not get the
    `download="name"` attribute.
  - A download from a client paired to a self-signed `--expose` TLS server: not
    measured; `DownloadManager` does not know the app's pin, so expect a
    failure. Fetch natively with the pinned certificate.
  - The dev overlay says `[transport] frozen … Check network stability` after 90
    s on Home (1/1): a hidden page's timers stop, the server reads the missing
    heartbeat as a stalled network. The client should say it is hidden with its
    last beat; the server then names that, not the network. (`frozen` itself
    must stay — the broadcast skips frozen clients.)
  - A font-scale or display-size change reloads the page (committed state kept,
    typed text lost). `fontScale|density` in `configChanges` might stop the
    WebView picking up the new scale — measure first.
  - Not done on the phone (battery at 2 %, the port charges at 900 mA): the
    whole lane with the three new steps (they passed there alone, and 17/17 on
    the API 35 emulator), share link and TLS over real Wi-Fi, split screen,
    picking a real file, keyboard insets on Android 15+.
- [ ] Windows: `GetLastError()` is a second FFI call and read 0 once after a
      FALSE `ConnectNamedPipe` (fixed there: `connectCodeFromFacts`). The other
      sites in `win-pipe.ts` (reads, writes, `GetOverlappedResult`) still trust
      it; a 0 there closes one connection, not the listener. Take the status
      from the OVERLAPPED's `Internal` field instead.
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
      Trojan:Win32/Cloxer in 15 of 20 builds — a CLOUD verdict (a file never run
      scans clean; each `deno compile` is a new file to it). What the build
      ships leaves esbuild out and was never flagged (cli 0/5, server 0/3); the
      one test that compiled with no excludes now builds as `buildCli` does.
      Open: `build.keepPackages: ["esbuild"]` embeds it again — warn there; the
      Electron-target server exe was not measured. Lasting answers are the
      owner's: a code-signing certificate, or a false-positive report to
      Microsoft.
- [ ] `am publish`'s summary line "an install made by the one-click .exe is a
      zip install too" has no test (needs a publish with both artifacts).

### Before the release

- [ ] One full `check:release` green end to end on Linux; the full suite on the
      Windows VM and the real Mac at the release commit; `test:onboard` and
      `test:build`; the three build-lane browser tests edited for
      `browserHomeEnv`; a cold stub rebuild (`check:release` now says when it
      was skipped).
- [ ] Record the proof rows (today: 1 of 16 proven, 5 never recorded, 4 stale,
      android BEHIND its build path): `deno task update:proof`.
- [ ] `docs/clients/electron.md` and the doctor hints say "1.0.20" (adjust if
      the number differs).

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
