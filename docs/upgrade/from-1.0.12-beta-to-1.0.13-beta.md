# Upgrading from 1.0.12-beta to 1.0.13-beta

Nothing is removed and nothing changes shape. No app needs a code change.

```sh
am pin --latest
```

## What you may notice

- **New, opt-in: `electron: { permissions }`.** Without it, Electron permissions
  work exactly as in 1.0.12: your app's own page and an `openWindow` child
  window (for its own origin) keep what they ask for, and a `<webview>` guest or
  a foreign-origin frame gets only fullscreen. Set `electron.permissions` to
  deny child windows and guests everything but what you list. It is then the
  whole policy: your own page gets exactly the listed permissions, and guests,
  foreign frames and child windows get none, not even fullscreen.

  ```ts
  await aio.run({
    electron: {
      permissions: {
        "clipboard-sanitized-write": ["app"], // copy buttons
        notifications: ["app"],
      },
    },
  });
  ```

  Names are Electron's own (camera and microphone are both `media`), and `"app"`
  is the only scope. An unknown name or scope stops the boot. See
  [Permissions](../clients/electron.md#permissions-electron--permissions-).

- **Main-process warnings reach `app.log` in a packaged app.** A permission
  `DENIED` line and the other `[aio:electron]` warnings from the Electron main
  process now land in the app's log as well as on the console. This includes a
  page that only queries a permission. Each line names the origin, never the URL
  with its key. Deprecation warnings are logged at WARN.

- **`ship` / `am publish` refuse a release no install would take.** If the app
  runs as one id (`aio.run({ appId: "x" })`) and `deno.json` names it another
  (only `"title": "X App"` → `x-app`), every install already refused every
  release, silently. Publishing now stops and says so. Fix: add `"appId": "x"`
  to `deno.json`. Artifacts built before 1.0.13 are not checked.

- **`visible: { publicFields: [...] }` alone now counts as declaring
  `visible`.** A cell with `access` and only `publicFields` no longer gets the
  "access does NOT hide state" warning at boot, or the refusal under `--expose`.

- **Self-update now works on macOS, Windows and Linux.** A Mac build signed on a
  Mac (`build.macos.host`) also writes `<bin>-mac-<arch>.app.tar.gz`, and
  `am publish` names it in `darwin-<arch>.json`; a Mac install updates from it.
  Tell Mac users to move the app to /Applications first: a copy run from the
  disk image or Downloads refuses to update and says so. A directory update
  whose new version never boots is rolled back by the swap helper. See
  [Desktop and CLI](../deploy/updates.md#desktop-and-cli).

- **A Windows install unpacked from the `.zip` by 1.0.12 needs one manual
  update.** It reads only `<os>-<arch>.json`, which now names the `.exe`.
  Installs from 1.0.13 on read `<os>-<arch>.electron-zip.json` first and update
  themselves. Publish's summary says this.

- **`am publish` publishes multi-platform Electron builds that include
  Windows**, and no longer skips a `.dmg` silently. `--no-data` is now an
  `am publish` flag, and `--data`/`--no-data` are used as given.

- **Android: three new pieces replace a copied `MainActivity.kt`.**
  `nativeFetch()` (a request with no `Origin`, for APIs that refuse browsers),
  `onBackButton()` (Android Back asks the page first) and deno.json `assets`
  mounts packaged into a standalone APK. The saved-state store now takes a
  per-launch key, so a third-party `<iframe>` cannot read it; state saved by
  1.0.12 loads unchanged. An own `<app>/android/` activity copied from 1.0.12
  still builds, and the build warns about each piece it lacks. See
  [Native fetch](../build/targets.md#native-fetch) and
  [The Back button](../build/targets.md#the-back-button).

## Retire

- A copied `<app>/android/.../MainActivity.kt` kept only for Back handling, a
  native HTTP bridge, or its own saved-state store: delete it and use
  `onBackButton()`, `nativeFetch()` and the built-in store.
- A sentinel `appDir` probe to learn whether `--profile`/`--home` was given: use
  `homeWasRequested()` from `aio/server`.
- An app-side script that rewrote `dist/manifest.json` to one artifact per
  platform before `am publish --no-build`: publish picks it now.
- `visible: { exclude: [], publicFields: [...] }` written only to silence the
  access warning: `visible: { publicFields: [...] }` is enough.
- A per-app "the Mac version doesn't update itself yet" note or download-only
  Mac manifest.
- Running a packaged app from a terminal only to see why a permission was
  denied: `app.log` (and `am logs`) now shows it.
