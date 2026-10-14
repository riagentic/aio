# Upgrading from 1.0.19-beta to 1.0.20-beta

Nothing is removed or renamed, and no default moves. There is nothing to change
by hand: an app that builds and tests on 1.0.19-beta builds and tests on
1.0.20-beta.

**One floor moves: an Android app built with 1.0.20 needs Android 10** (it was
Android 7). See [Android](#android).

```sh
am pin 1.0.20-beta
am fix
```

This release is the clean-desk round: everything that was open after 1.0.19 is
either done or decided. Where the better value could change what a shipped app
does, it is an opt-in — see [New opt-ins](#new-opt-ins). The surface gains a few
names — see [What is new](#what-is-new).

## What to do

Nothing is required. Four things are worth a look:

- **Run `am doctor`.** It names the opt-ins your app has not decided — see
  [What `am doctor` now hints](#what-am-doctor-now-hints). A hint never changes
  the exit code.
- **Your app starts a browser worker from a `.ts` file**
  (`new Worker(new URL("./w.ts", import.meta.url))`): it now runs in every
  build. If the build prints a warning that names the worker, the worker could
  not be bundled and is as it was on 1.0.19 — the line gives the way out. See
  [Browser workers](#browser-workers).
- **You build a local APK or a web build and `app.ts` passes options to
  `aio.run()`:** read [Android](#android). `ui.*` options are now applied there.
- **You go back to 1.0.19 after `am create`:** see
  [Pinning back to 1.0.19](#pinning-back-to-1019).

## New opt-ins

Each is off until set. `am create` writes the safer value into a **new** app;
`am fix --harden` writes the first three into an existing one; plain `am fix`
writes none of them.

| Opt-in                                           | What it does when set                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `electron: { strictPin: true }`                  | A paired server whose certificate the pin does not cover is refused (nothing is sent)           |
| `"build": { "strictPin": true }`, `--strict-pin` | The same for a packaged Electron client, and for one run                                        |
| `electron: { ignoreDebugEnv: true }`             | The desktop app does not read `AIO_CDP` or `AIO_PORT` from its environment                      |
| `auth: { maxSessions: n }`                       | A ceiling on one account's live sessions                                                        |
| `auth: { publicDir: "public" }`                  | What an anonymous visitor may read is that folder, not a rule over file extensions              |
| `wire: { refuseShortCalls: true }`               | A frame with no argument list, for a method that declares arguments, is refused                 |
| `wire: { omitTrailingUndefined: true }`          | `m(a, undefined)` is sent as `m(a)` by every client                                             |
| `"android": { "colorScheme": "system" }`         | An Android build's page follows the phone's light/dark setting (unset: dark, as before)         |
| `testUI(App, name, { wire: { strict: true } })`  | UI calls in a test behave as a real client's do; `AIO_TEST_WIRE=strict` for a whole run         |
| `deno task build --smoke=desktop`                | Starts the desktop package on a Windows or macOS host too (plain `--smoke` lists it, as before) |
| `AIO_STOP_STAYS_DOWN=1`                          | `am stop` of a supervised app exits 143 and the service stays down (unset: exits 0, as before)  |

Details: [electron](../clients/electron.md), [auth](../auth/auth.md),
[every option](../basics/every-option.md),
[UI testing](../testing/ui-testing.md).

## What `am doctor` now hints

- **`electron.strictPin`** — for an app that launches a remote Electron client
  (`--server-url`); **`build.strictPin`** — for an app with an `electron-client`
  target.
- **`electron.ignoreDebugEnv`** — for an app with a desktop window.
- **`android.colorScheme`** — for an app with an Android target that has not
  chosen. `"dark"` keeps today's look and ends the hint.
- **A stale `allowScripts` entry** — `am pin` and `am fix` now move these with
  the imports, and say so.

`am doctor --json` lists them in `hints`; `ok` and the exit code are unchanged.
`am fix --harden` writes the three hardening switches.

## What is new

| Name                                          | What it is                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `am publish --patch-from=<dir>`               | Publishes the difference from an earlier release; single-file installs update from it |
| `ReleasePatch`, `patchesCore`, … (`aio/ship`) | The patch list of a release manifest                                                  |
| `am fix --harden`                             | Writes the hardening opt-ins                                                          |
| `bindInput(form, name)` (`aio/air`)           | `form.bind(name)` with the field's type                                               |
| `blocking(id, fn or URL, arg)`                | A function or `new URL("./job.ts", import.meta.url)`; a source string still works     |
| `checkCells(cells)`                           | `config` and `baseDir` are optional                                                   |
| `AIO_ANDROID_KEYSTORE` (+ password, alias)    | With `--release`: a signed, non-debuggable APK and an `.aab`                          |
| `AIO_BUILD_PROBE`                             | Set while the build reads `app.ts` for an APK or web build                            |
| `updates.shortcutAdded`                       | Windows one-click install: the Start-menu shortcut this start added, else null        |
| `--aio-sfx-install`, `--aio-sfx-wait`         | The one-click `.exe`'s own first arguments (`am upgrade <app>` uses the first)        |
| `am instances --json`: `otherAppsDir`         | The app was started under another `AIO_APPS_DIR`                                      |
| `deno task build --analyze`                   | Also prints what each compiled binary embeds                                          |

## Browser workers

- A `.ts`, `.tsx` or `.jsx` worker named by a URL literal is bundled and served
  the same way in dev, `--prod`, a compiled binary, Electron, web and an APK.
  `dist/` gains `worker-*.js`. A `SharedWorker` is treated the same.
- A `.js` worker is left exactly as written.
- A worker that cannot be bundled (an import that does not resolve, a
  server-only module) is a **warning**; the build stays green and the worker is
  as it was.
- An `assets` mount that only deno.json declares is now served (it answered
  404). One boot line lists such mounts — as a warning when the app is exposed
  with no key and no auth, because anyone who can reach the port reads those
  files. It fills in: a route, an `aio.run` mount, `serveDirs`, `share` or the
  app's own file at that path answers first. A mount that points outside the
  project is not served, and a warning says so.

Details: [performance](../debugging/performance.md#browser-workers),
[runtime differences](../build/runtime-differences.md).

## Android

- **The floor is Android 10** (`minSdk` 29; it was 24, Android 7). An APK built
  with 1.0.20 does not install on Android 7, 8 or 9. Nothing in the app changes
  and the build is the same; phones on those versions keep the last build made
  with 1.0.19 or older (a store keeps serving it to them). Why: the WebView that
  runs the app no longer gets updates below Android 10 — Chrome, which it ships
  with, left Android 8 and 9 in 2025 — and system dark mode starts there. An app
  that must keep Android 7–9 stays on 1.0.19 for its Android build, or overlays
  its own `android/app/build.gradle.kts`.
- **A local APK or web build applies the options `app.ts` gives `aio.run()`**:
  `ui.theme`, `layout`, `lang`, `dir`, `head`, `viewport`, and `persist`,
  `persistDebounceMs`, `cellDefaults`, `circuitBreaker`, `refusalsReject`,
  `perfBudget`, `effectTimeoutMs`. The build runs the entry once to read them,
  in a process that may only read; `AIO_BUILD_PROBE=1` is set there. An entry
  that cannot be read this way bakes nothing, and the build says why.
- **Saved state is never dropped by this.** `persist: false` and
  `cellDefaults.persist` apply on a new install only; an install that already
  holds such state keeps it and says so once.
- **The page's colour scheme is dark unless `android.colorScheme` says
  otherwise**, as before.
- The Android client pairs by code; a self-signed `--expose` server works once
  paired, with its certificate pinned.

## Sync

A 1.0.19 server with `journal: true` that was killed in the instant after it
refused a sync op (a `validate` or a guard, on an action another cell
`listensTo`) and before it removed that op's row left the row in the op-log.
Nothing tells that row from an accepted op killed between its commit and its
mark, so 1.0.20 keeps it, as 1.0.19 did. The first boot may print once that an
op the server accepted is refused by this build and is folded as a no-op. The op
has no effect on the server, its author's resend is acknowledged, and the next
compaction of that cell drops it. No action is needed, unless that client must
be told that its copy of the change is not on the server.

On 1.0.20 the same kill ends in the row removed and the resend answered
`op-rejected`. See [CRDT](../persistence/crdt.md).

## Windows

- **`<install>.zip-<version>` beside an install.** An install updated by 1.0.20
  can have this file on disk until the next healthy start: an update that could
  not be swapped in keeps its downloaded archive until the update is confirmed
  or given up, so the next try does not download it again. It is used only when
  the updater's record proves the updater made it and its bytes verify against
  the signed manifest; otherwise it is removed and downloaded. Anything beside
  the install that the updater did not make is left alone, as before, and is now
  named once in the log, not at every start. (If the app is later moved back to
  1.0.19, that build drops the note of what was already named, so it is named
  once more.)
- **The one-click `.exe` and a removed Start-menu shortcut.** A 1.0.20 `.exe`
  records the shortcut it adds and never puts back one the user removed. An
  install made by an older `.exe` has no such record, so a removed shortcut can
  come back **once**, at the first upgrade; removed again, it stays removed.
- **`am upgrade <app>` works for a one-click install** whose `.exe` was built
  with 1.0.20. For an `.exe` built with 1.0.19 or older it says so and changes
  nothing: open the new `.exe` once.
- **`AIO_APPS_DIR` on Windows:** the local pipe name carries the apps dir, so a
  1.0.19 `am` or client and a 1.0.20 app under the same `AIO_APPS_DIR` do not
  find each other. Without `AIO_APPS_DIR` the name is unchanged.
- **`install.ps1` and `run.ps1`** keep the checkout at
  `%USERPROFILE%\.local\lib\aio` and an app installed under `Programs\<name>\`.

Details: [targets](../build/targets.md), [updates](../deploy/updates.md),
[Windows and macOS](../basics/windows-macos.md).

### The Windows icon

Rebuild to get it. A one-click `.exe` built by 1.0.20 shows the app's icon in
Explorer, and an `icon.png` larger than 256 px is scaled for Windows instead of
being replaced by the monogram. An `.exe` built earlier keeps what it had; it
still installs, runs and updates. An app that added an `icon.ico` as a
workaround can keep it (it wins) or delete it.

## Pinning back to 1.0.19

An app made by 1.0.20's `am create` and then pinned back to 1.0.19-beta fails
its type check on keys 1.0.19 does not know: `electron.strictPin`,
`electron.ignoreDebugEnv` and `wire.refuseShortCalls` in `app.ts`, and
`android.colorScheme` in deno.json. Remove them, or stay on 1.0.20-beta. An app
that was made by an older `am create` and upgraded has none of them unless you
added them.

## Small things a script may notice

- **A socket path you chose yourself** (`createUDSListener`): its directory is
  left as it is. 1.0.19 set a directory named `aio` or `aio-u<digits>` to mode
  0700 whoever made it, which cut off a reverse proxy that reached the socket
  through its group. A directory that is missing is still made, 0700. aio's own
  lock and socket directories are 0700, as before.
- **The boot report's `entry` row** is a path that opens: `C:\app\src\app.ts` on
  Windows (was `/C:/app/src/app.ts`), and a space is a space (was `%20`).

- **A connection that died without closing** (airplane mode, a sleeping device)
  is treated as closed after about 5 s of unanswered pings: the page says
  "Reconnecting…" and a call in flight rejects `connection lost` then, not at
  its 15 s timeout. A connection that answers is never judged.
- **A server build's `<name>.plist` / `<name>.ps1`** is in `dist/` under the
  artifact's name (`<name>-<version>-<platform>.plist`). 1.0.19 left it in the
  project root; a deploy script that picked it up there needs the new path.
- **`run.sh`** no longer adds `-dirty.<hash>` to the version of a clean
  checkout, so one commit installs as one version.
- **A dev app restarted by the supervisor** no longer has `AIO_PORT` set for it;
  the port travels in `AIO_DEV_RESTART_PORT`. `AIO_PORT` you set yourself is
  passed on as before.
- **`<download>~damaged`** can appear beside an install: a kept update download
  whose bytes changed on disk, moved aside before the release is downloaded
  again. It is safe to delete.
- **New names:** `build.android.strict`, `testPageFetch` (`aio/testing`),
  `AIO_TEST_BROWSER_HOME=own`, and for the one-click `.exe`
  `AIO_SFX_REASON_FILE` and `AIO_SFX_LOCK_WAIT_MS`.

## Packages

| Package  | Was    | Is     |
| -------- | ------ | ------ |
| Electron | 44.5.1 | 44.7.0 |

An app whose deno.json says `electron@44.5.1` builds with 44.7.0 and says so in
one line that names `am fix`.

## Retire

- **A build step that bundles a browser worker by hand** (an esbuild call, a
  copied `worker.js`): a `.ts` worker named by a URL literal is bundled on every
  target since 1.0.20-beta.
- **A route that serves a folder deno.json already lists under `assets`**: the
  mount is served since 1.0.20-beta.
- **`blocking()` called with a function turned into a string**
  (`fn.toString()`): pass the function, or a URL, since 1.0.20-beta.
- **A signing step run on the APK after the build** (`apksigner` in a script):
  `AIO_ANDROID_KEYSTORE` with `--release` signs it since 1.0.20-beta.
- **A note telling Windows users to download the `.exe` again to upgrade**:
  `am upgrade <app>` does it for an `.exe` built with 1.0.20-beta.

The full list is in [the changelog](../../CHANGELOG.md).
