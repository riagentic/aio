# Upgrading from 1.0.17-beta to 1.0.18-beta

Nothing is removed or renamed. The surface gains one flag,
`am publish --no-zip`, one build key, `build.windows.shortcut`, and one
environment variable, `AIO_MOVE_TO_APPLICATIONS`. Most apps change nothing; an
app that publishes a Windows desktop build has one thing to check — see
[What to do](#what-to-do).

```sh
am pin --latest
```

This release is about the Windows one-click `.exe`. Its first bytes — the stub
that unpacks and opens the app — were a Go program since 1.0.16-beta. They are
now a Rust program, and no Go is left in aio. Around that: an old download no
longer puts its version over a newer app, the first open adds a Start-menu
shortcut, and `am publish` refuses a release no install could update from.

## What to do

- **You publish a Windows desktop build** (`am publish`, `deno task publish`):
  publish the `.zip` together with the one-click `.exe`. An app installed by the
  `.exe` updates from the zip's manifest (`<os>-<arch>.electron-zip.json`), so a
  channel with the `.exe` alone held releases no install could take.
  `am publish` now refuses that and names the missing zip. A normal build makes
  both files; this only bites if something removed the zip before publishing. To
  publish the `.exe` on purpose as a download nothing updates from, pass
  `--no-zip`.
- **You do not want a Start-menu shortcut:**

  ```json
  { "build": { "windows": { "shortcut": false } } }
  ```

- **You ship a macOS desktop app:** opened outside Applications, it now asks
  once to be moved there (see [macOS](#macos)). To ship without the question,
  start the app with `AIO_MOVE_TO_APPLICATIONS=never`.
- **You change the stub itself** (`src/build/windows-sfx-stub/`): it needs Rust
  now, not Go — see that folder's `README.md`. Building an app needs neither.

Everything else needs nothing.

## The Windows one-click `.exe`

- **Rust instead of Go.** The stub went from 3,712,000 to 706,048 bytes, so
  every `<name>-win-x64.exe` is 3.0 MB smaller. It is still a committed,
  SHA-256-pinned, reproducibly built file: building an app needs no compiler.
- **Nothing an installed app depends on moved.** The trailer (`AIOSFX02`), the
  `tar.zstd` and `zip` payloads, the install folder
  `%LOCALAPPDATA%\aio-sfx\<name>\win-<arch>`, the `.aio-sfx-stamp` and the
  install lock's name are the same. An `.exe` built with either stub opens,
  keeps or replaces an install the other made, and the app's own updater is
  untouched. Measured on Windows 11 with both stubs taking turns on one install.
- **An old download no longer overwrites a newer app.** The `.exe` you open used
  to win in both directions: an older `.exe` put its version over an app that
  had updated itself. Now the `.exe` carries the app's version, the install says
  its own in `.aio-sfx-version` (written by the stub, rewritten by the app at
  every start), and an `.exe` that is older only opens what is installed. An
  `.exe` built with 1.0.17-beta or older carries no version and still installs
  what it carries, as before.
- **A Start-menu shortcut.** The open that installs the app adds `<title>.lnk`
  under Start Menu → Programs, pointing at the installed program, so the
  download can be deleted. Opening the `.exe` again does not put back a shortcut
  the user removed.
- **First open is a little slower, later opens are not.** The Rust zstd decoder
  is slower than the Go one. Measured on Windows 11 with a 465 MB app: first
  open 1.44 s (Go: 1.12 s); every later open 0.09 s (Go: 0.10 s).
- **The stub is stricter about what it reads.** A header whose app or
  architecture name holds a path separator or a drive, and a payload entry named
  with a drive (`C:…`), are refused; a payload cut short is an error.

## macOS

- **An app opened from the `.dmg` or from Downloads offers to move itself to
  Applications.** There it could never update: it ran from a read-only image, or
  from the read-only copy macOS makes of a quarantined app. It asks once, after
  its window is up. "Move to Applications" copies the bundle into
  `/Applications` (`~/Applications` when that cannot be written), clears the
  quarantine mark from the copy, closes the app and opens the copy; "Not Now" is
  remembered. With an app of that name already in Applications there is no
  question — nothing is replaced. `AIO_MOVE_TO_APPLICATIONS=never` switches it
  off; `=move` moves without asking. Details:
  [build targets](../build/targets.md).

## Running an app

- A user record changed in place (the same object, `u.role = "user"`) is now
  noticed by the socket's re-check: an idle page is re-sent its view within 5 s,
  where it used to keep showing the old one until the next state change.
- A set `AIO_DISCOVERY_PORT` that is not a port (`0x1F90`, `0`, `port`) is named
  in the log with the port used instead; it used to fall back to 8099 in
  silence.
- The memory-budget error carries `err.code === "MEMORY_UNBOUNDED"`.
- A `build.chromiumExtras` value other than `"keep"` / `"strip"` is warned about
  by a build that packages no Electron; an Electron build for Windows or Linux
  refuses it, as before.

## Publishing and updates

- **An install offered a release without its zip says so.** It used to answer
  "reinstall from the artifact this channel actually serves" — the `.exe`, which
  installs the same kind again. It now says the release was published without
  its `.zip` and that there is nothing to reinstall.
- **A signed one-click `.exe` is recognised as one.** A signature puts its
  certificate table after the SFX trailer; aio's reader looked only at the end
  of the file. It now looks before the certificate table too, as the stub does.

## Testing

- A dev server that cannot get its port no longer leaves a file read running —
  in a test run it used to finish inside the next test, which then failed with
  "an async readTextFile started before the test".
- `testUI --video=<dir>/` under `deno test --parallel`: two same-named tests in
  two files get two videos again; they could share one.
- A parallel test run no longer leaves an `apps-*` sandbox folder behind.

## Retire

- **A Go toolchain kept only to rebuild the Windows stub** (needed for that in
  1.0.16-beta and 1.0.17-beta): nothing in aio uses Go since 1.0.18-beta.
- **A release note telling Windows users to keep their downloaded `.exe` up to
  date, or not to reopen an old one after an update**: an older `.exe` opens the
  newer installed app since 1.0.18-beta.

The full list is in [the changelog](../../CHANGELOG.md).
