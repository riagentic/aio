# Upgrading from 1.0.21-beta to 1.0.22-beta

Nothing is removed or renamed. **One default moves**: an update keeps ONE old
version (it kept three), in a folder of its own — see
[Updates: one install, the old one in `old/`](#updates-one-install-the-old-one-in-old).
`updates: { keepOld: 3 }` keeps three again. There is nothing else to change by
hand: an app that builds and tests on 1.0.21-beta builds and tests on
1.0.22-beta.

```sh
am pin v1.0.22-beta
am fix
```

## What to do

Nothing is required. Worth a look:

- **You want a splash screen:** `"build": { "splash": { "image": "…png" } }` —
  see [Splash screen](#splash-screen).
- **You want more than one rollback kept:** `updates: { keepOld: <n> }`.
- **A script or a shortcut you made by hand names a versioned single-file
  install** (`myapp-1.0.0-x86_64.AppImage`, `myapp-1.0.0.exe`): after the next
  update the file has the new version's name. aio's own menu entry follows;
  yours does not — the update's log names the old and the new path once.
- **Your app draws its own update progress:** `updates.progressOf` says which
  download the bar measures (`"app"` or `"runtime"`), `updates.runtimeBytes` the
  Electron download's size.

## Updates: one install, the old one in `old/`

| Install                                         | 1.0.21                                    | 1.0.22                                                 |
| ----------------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| single file with its version in its name        | written over in place; `X.old-<v>` beside | `X` with the new version's name, `old/<v>/X` (the old) |
| single file the user renamed, or under systemd  | in place; `X.old-<v>` beside              | in place; `old/<v>/X`                                  |
| macOS `.app`, a Windows or Linux install folder | `X.old-<v>` beside                        | `old/<v>/X` (on macOS `X.app.noindex`)                 |
| kept                                            | 3                                         | `keepOld`, default 1                                   |

- The rollback is `old/<previous>`: a build that fails its first starts is
  replaced by it, under the name it had, and goes into `old/` itself.
- `<install>.old-<v>` copies an older aio left are moved into `old/<v>/` at the
  first confirm under 1.0.22, then pruned to `keepOld`.
- On macOS a copy in `old/` is unregistered from LaunchServices and dropped from
  Spotlight, so `open`, URL schemes and file types reach only the live app.

See [updates](../deploy/updates.md).

## Splash screen

```jsonc
"build": {
  "splash": {
    "image": "assets/splash.png",  // required; @2x is drawn at half its pixels
    "text": "Starting {title}…",   // optional
    "progress": true,              // optional: a bar (desktop download)
    "minMs": 1000                  // optional: shown at least this long
  }
}
```

The image (and text, and bar) from the app's first moment until it has loaded:
native on the desktop (before Electron starts, and through an online app's first
Electron download), a native overlay on Android, in the page on the web target
with iOS launch images. The main desktop window shows as the splash leaves.
Without the key nothing changes. See
[splash](../build/targets.md#splash-buildsplash).

## Builds

A build whose `out` is not `dist/` moves a release a previous build left in
`dist/` (`"out": "dist"`) to `.aio/kept-dist-<time>/` before it stages there,
and says so. It deleted it.

## Retire

- A step that copied `dist/` away before a build to another `out` — 1.0.22's
  build keeps it in `.aio/kept-dist-<time>/` and says so. Nothing else to
  retire.

## Fixed

- macOS: the online download window updated, closed and heard Cancel (on macOS
  14 it froze until the app's 2 s kill).
- An online app started by a bundled one (an update from a bundled build)
  inherited its `$ELECTRON_PATH` and could start that package's Electron, from a
  mount that can vanish. Its launcher now clears it and the app ignores it
  (logged once): it starts only the Electron its build pinned. A bundled app's
  `AppRun` likewise clears an inherited `AIO_ELECTRON_RUNTIME`.
- The shared Electron store was cleaned only by `am prune`, which end users do
  not have: a removed online app left ~280 MB behind for good. An online app's
  start now removes, at most once a day and after its window has loaded, each
  Electron no installed app names that nothing started from in 30 days
  ([cleaning up](../build/targets.md#shared-electron-runtime-buildelectronruntime)).
- Online first start with a splash: when the splash's helper exited before it
  showed (a locked-down PowerShell, an unreadable image), Electron downloaded
  with no window at all. The plain progress window now takes over for the rest
  of the download.
- With a splash, a helper slower than Electron's own show-anyway cap (`minMs` +
  5 s) left the main window and the splash on screen together — up to 30 s when
  its ack could not be written. The splash now closes the moment the main window
  shows.
- A desktop app's update was confirmed once `onStart` came through — before an
  online build had downloaded its Electron — so a failed or cancelled download
  left a confirmed build that could not open. It is confirmed once the main
  window has loaded; a start without one is a failed start, rolled back after
  two. The failed-download question offers **Start the previous version** while
  the replaced version is in `old/`.
- A rollback to a build that reads the window profile at Electron's old place
  (`~/.config/<name>/`, before 1.0.21) moves it back there; a start that finds a
  profile in both places keeps the newer and sets the other aside as
  `~/.<appId>/electron.previous-<date>/`.
- A rollback drops the shared Electron store's `pending` record of the version
  it removed.
- The line about launch points after a renamed update is a warning, and claims
  the menu entry follows only on Linux, when it does.
- A staged file that could not be made executable left a marker that kept the
  version failed for good; an invalid `updates.keepOld` refused the boot before
  its update was judged (it is refused after, and by `aio ship`).
