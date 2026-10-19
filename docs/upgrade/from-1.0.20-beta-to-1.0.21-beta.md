# Upgrading from 1.0.20-beta to 1.0.21-beta

Nothing is removed or renamed, and no default moves. There is nothing to change
by hand: an app that builds and tests on 1.0.20-beta builds and tests on
1.0.21-beta.

```sh
am pin v1.0.21-beta
am fix
```

The headline is a desktop package without Electron: `build.electronRuntime` (see
[One Electron per machine](#one-electron-per-machine)). An app without the key
is built as before; `am create` writes `"online"` into a **new** app. The
surface gains a few names — see [What is new](#what-is-new).

## What to do

Nothing is required. Four things are worth a look:

- **You ship a desktop app and want a smaller download:** set
  `"electronRuntime": "online"` under `build` in deno.json. Keep `"offline"` (or
  no key) for an app that must open with no internet on a fresh machine.
- **A test asserts `REDUCE_ERROR` for a refused write** (`validate`, a disabled
  cell) under `bootCells`, `testUI` or `testCell`: it is now `ACTION_REFUSED`,
  the code the wire always answered. See [Tests](#tests).
- **A script reads `am trigger`'s answer:** a gesture whose handler throws is
  now `ok:false` (exit 1), naming the throw. It said `ok`.
- **A rebrand sets only `--aio-accent` under a generated theme:** set
  `--aio-accent-ink` too — the kit's active tab and Markdown links draw it as
  text. Unset, they fall back to `--aio-accent`. See [the kit](../ui/kit.md).

## One Electron per machine

`"build": { "electronRuntime": "online" }` makes a desktop package that carries
no Electron. Its first start downloads the Electron the build pinned into a
per-user store every online aio app shares, with a progress window; later starts
and other apps start from it. The download must hash to the SHA-256 the build
wrote into the binary, or it is refused. An update downloads the new version's
Electron (when it changes) **before** the swap; a failed download leaves the old
version running.

| OS      | The store                                     |
| ------- | --------------------------------------------- |
| Linux   | `~/.local/share/aio/electron/`                |
| macOS   | `~/Library/Application Support/aio/electron/` |
| Windows | `%LOCALAPPDATA%\aio\electron\`                |

`AIO_SHARED_ELECTRON_DIR` moves it; `AIO_DIALOG=none` turns the progress window
off (log only); `am prune` removes only runtimes no installed app names.
Details:
[targets](../build/targets.md#shared-electron-runtime-buildelectronruntime).

## The desktop window's profile moves

Every desktop app (online or offline) keeps its window's Chromium profile —
cookies, web storage, window size, Chromium's caches — in its own home,
`~/.<appId>/electron/` (`%USERPROFILE%\.<appId>\electron\` on Windows). It was
Electron's per-OS place (`~/.config/<title-slug>/`,
`~/Library/Application Support/<title-slug>/`, `%APPDATA%\<title-slug>\`).

The first start of a 1.0.21 build moves it there once and says so in `app.log`.
A profile in both places, or one that cannot move (another volume), is kept and
used — never lost. Now `am remove --data` removes it, a `--profile` home has its
own, two apps with one title no longer share one, and on Windows it is out of
the roaming profile. Pinned back to 1.0.20, an app reads the old place again:
the window starts signed out, at its default size. See
[where files live](../persistence/where-files-live.md).

## Sync

A device whose clock is off from the server's by more than `maxDrift` now stamps
its ops on the server's time (`serverNow`, an optional field an older client
ignores) and warns once with the offset. Nothing to configure. A device that was
far behind stops losing last-write-wins with its newer edits, and stops having
fresh edits refused as stale resends. See
[the CRDT protocol](../persistence/crdt-protocol.md).

## The aio client

- **Sign in again, once**, when a server's root certificate really changes (a
  reinstall, a new machine, a renewal) and the server cannot prove it holds the
  app's key: such a host is sent none of its cookies now (it used to get the
  login session). An unpaired host keeps the certificate it was first seen with;
  a different one later has that host's cookies removed before the page loads,
  with a warning. A leaf re-issued under the same root still matches.
- Once an app is open, its own links load in its window and its login provider
  loads; other sites open in the system browser.
- A machine on two subnets you share is listed once (answers carry `addrs`). A
  responder older than 1.0.21 is listed per address, as before.

## Android

- **Standalone APK:** `useConnected()` and `isConnectionDegraded()` exist
  (always connected). An app that imported them failed the APK build.
- **`build.strictPin` and the client APK:** a keyed `http://` link to another
  machine and pairing over plain http are refused. Only an app that sets
  `strictPin` changes.
- **A `blob:` / `data:` download is saved** into Downloads (up to 32 MB). An APK
  that logged "download NOT saved" for one now saves it. A download from a
  server whose certificate was pinned works.
- **`build.android.keystore` / `keyAlias`** name the release key in deno.json;
  the `AIO_ANDROID_*` environment still wins, and a debug build never needs
  them. A `build.android` key that names a password is never read and now warns.
  **`build.android.aab: true`** also writes `<name>-unsigned.aab` for an
  unsigned `--release`.
- An unknown `{{TOKEN}}` left in a template or overlay is now a build warning,
  by file.

## macOS

- **`run.sh` waits for the app** (`open -W`), as on Linux, so it no longer
  returns the moment the app opens. An app gone within 3 s fails the run with
  the tail of its log; `AIO_OPEN_EARLY_EXIT_S=0` turns that off.
- `AIO_APPLICATIONS_LINK=1` links the installed bundle into `~/Applications`
  (Launchpad); `am remove` deletes the link.

## Updates

- A single-file app whose update fails to install 3 times in a row now sees that
  release dismissed; `undismiss()` offers it again.
- A kept download damaged on disk is moved aside and fetched again, instead of
  blocking its release.

## Tests

- **`ACTION_REFUSED` in process:** under `refusalsReject` (every harness, and an
  app that sets it) a `validate` or disabled-cell refusal rejects with
  `ACTION_REFUSED`, as over the wire; it was `REDUCE_ERROR`.
- **A click on a label's text** moves focus to its control and toggles it as
  Chromium does — not through a link or button inside the label, and once for
  nested labels.
- **A `blocking()` error an earlier task left behind** is a log line under that
  task's id; it no longer fails the task running on that worker.
- `bootCells` called from an async helper now works (every test body starts
  outside every boot scope). A harness booted over a live one warns.
- `press("Tab")` moves focus and arrow keys move a radio group's choice, so an
  `onBlur` validation now runs in a test.

## What is new

| Name                                                   | What it is                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `build.electronRuntime: "online" \| "offline"`         | A desktop package without Electron, which downloads it once per machine           |
| `runCommand(cmd, { args, timeoutMs, signal, onLine })` | `aio/server`: run a command to its end; the timeout kills the whole tree on time  |
| `appVersion()` (`aio/air`)                             | The app's resolved version, in every shell and under SSR                          |
| `build.android.keystore`, `keyAlias`, `aab`            | The release key named in deno.json; an unsigned `.aab` beside an unsigned release |
| `am dispatch --wait=N`                                 | Waits N s for the method's reply                                                  |
| `am errors --since=15m\|<time>`                        | Events at or after the cutoff, as `am logs`                                       |
| `AIO_APPLICATIONS_LINK=1`, `AIO_OPEN_EARLY_EXIT_S`     | macOS `run.sh`: a Launchpad link; the early-exit window (3 s, `0` = off)          |
| `AIO_SHARED_ELECTRON_DIR`, `AIO_DIALOG=none`           | The shared store's folder; no progress window                                     |
| `code: "DEAD_BOOT"`                                    | The standalone dead-boot refusal, for `errorCode(e)`                              |
| `serverNow`, `addrs`, hello `appId`/`user`, ping `h:1` | Optional wire fields; an older peer ignores them                                  |

## Retire

- **A per-app copy of Electron in every desktop download**:
  `electronRuntime:
  "online"` shares one per machine since 1.0.21-beta.
- **A subprocess wrapper with its own timeout and tree kill** around
  `Deno.Command`: `runCommand` since 1.0.21-beta.
- **A guard that fakes `useConnected` for an Android standalone build**: it
  exists there since 1.0.21-beta.
- **A signing step that copies the keystore path into the environment for each
  build**: `build.android.keystore` / `keyAlias` since 1.0.21-beta.
- **A script that waits for a macOS app after `run.sh` returns**: `run.sh` waits
  (`open -W`) since 1.0.21-beta.
- **A wrapper that serializes `useCell().send` calls across a dev reload**: the
  reload carries unsent calls since 1.0.21-beta.

The full list is in [the changelog](../../CHANGELOG.md).
