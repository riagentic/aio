# Build Targets

**Three commands, one rule.** List the targets you ship in deno.json
`build.targets`; that is all there is to decide.

```sh
deno task build      # = am build     every target in build.targets → dist/ + manifest.json
deno task compile    # = am compile   the default target alone (deno.json "client")
deno task dev        # = am dev       the app in dev, foreground, flags pass through
```

`am build` / `am compile` / `am dev` ARE those tasks — the same command line,
run for you (words narrow it: `am build server electron`, `am compile cli`).
There is no second build pipeline behind `am`, so the two spellings cannot
differ; a test on a real scaffold pins that (`tests/am-build-unified.test.ts`).
`am start` is the other way to run: the supervised background form (lock, health
wait, `am stop`/`status`) — `dev` is your terminal and your Ctrl-C.

What each OS adds around a built app — first-launch warnings, the firewall,
running at startup, uninstalling — is on
[aio on Windows and macOS](../basics/windows-macos.md).

**One vocabulary**: every buildable artifact is a **target name**, and
`deno task build` (the fleet build) is the one way to build them — locally
runnable apps and remote/thin-client artifacts alike. Two axes, expressed in the
names themselves:

- **App / server targets** (`browser`, `electron`, `android`, `web`, `cli`,
  `server`) — self-contained artifacts. `server` is the headless role (it was
  spelled `service` before alpha52); it builds the exposed `--remote` binary +
  systemd unit.
- **Client targets** (`electron-client`, `android-client`, `ios-client`,
  `cli-client`) — thin clients that connect to a separately-running aio server.
  iOS has no Deno, so it has ONLY a client target: an Xcode project on any host,
  an `.app` where `xcodebuild` is (macOS).

```
┌──────────────────┬─────────────────────────────────────────────┐
│ browser          │ binary + system browser (127.0.0.1)         │
│ electron         │ desktop app, server inside (package per OS) │
│ android          │ APK, standalone (no server)                 │
│ web              │ static PWA directory, offline (no server)   │
│ cli              │ headless binary + WS client API             │
│ server           │ headless exposed server + systemd unit      │
│ server-app       │ exposed server WITH its page + systemd unit │
├──────────────────┼─────────────────────────────────────────────┤
│ electron-client  │ connect-page AppImage (no app code)         │
│ android-client   │ client APK — connects to a server           │
│ ios-client       │ client Xcode project (.app on macOS)        │
│ cli-client       │ client binary — connects to a server        │
└──────────────────┴─────────────────────────────────────────────┘
```

The scaffold ships two build tasks: `deno task build` (every target in deno.json
`build.targets`) and `deno task compile` (the same pipeline, only the default
target — the one in deno.json `"client"`). One-off:
`deno task build --targets=electron`. The packaged window loads over `aio://`
(not `http://`); `deno task test:electron` runs the built AppImage on a display
and asserts the renderer's `ui mounted` line, and
`AIO_ELECTRON_PROTOCOL=1 deno task dev` takes the same path in dev — see
[Electron → Test what you ship](../clients/electron.md#test-what-you-ship--aio_electron_protocol1).

> **Remote / thin-client targets** build, boot, and are exercised by CI
> (per-target boot + WS-increment smoke in `tests/examples.test.ts`, LAN e2e in
> `tests/e2e-remote-lan.test.ts`).

## Build a fleet — `deno task build`

`deno task compile` builds **one** target (your default). When you ship more
than one — a LAN server plus the clients that connect to it, say — declare the
set once and build it all with a single command:

```jsonc
// deno.json
"build": {
  "targets": ["server", "electron-client", "android-client"],
  "out": "dist",
  "server": "192.168.1.50:8000", // BAKED into every client artifact (see below)
  "ui": "App.tsx"                // the component every target bundles (default)
}
```

> **`build.ui` is the build's half of `ui.entry`.** The dev server reads
> `ui.entry` from `aio.run()`; the bundler cannot (that is runtime code), so a
> project that renames its root component declares it here too. Dev warns at
> boot when the two disagree, and a prod server refuses a bundle whose stamp
> does not match its `ui.entry` — the mismatch cannot reach a user silently.

```sh
deno task build                 # builds every target in build.targets → dist/
deno task build --targets=server,electron-client   # override the list
deno task build --release       # release builds (e.g. Android assembleRelease)
deno task build --list          # show all target names
```

Every artifact lands in **`dist/`** (flat) alongside a **`dist/manifest.json`**:

```
dist/
  myapp-1.2.345                    server binary
  myapp-1.2.345.service            systemd unit (server, with --expose baked in)
  aio-client-1.2.345-x86_64.AppImage   electron client
  myapp-1.2.345-client.apk         android client
  manifest.json            { app, title, version, commit, dirty, buildNumber, builtAt, server, targets:[…] }
```

**The systemd unit carries two build-machine values, on purpose and labelled.**
`User=` and `Environment=HOME=` come from the machine that BUILT the binary, not
the host you install on — aio has no way to know which account should run your
service, so it says so in the file rather than deciding for you. Set `User=`
before enabling the unit. A build with no `$USER` (a container, a CI runner)
writes `User=REPLACE-ME`, which systemd refuses until you set it — deliberately,
instead of defaulting to `root` because of how the build was run.

Every artifact carries **the app version** right after its name —
`major.minor.<commit count>`, `-dirty.<hash8>` when built from uncommitted
changes — and reports the same string from `--version`, the boot line and
`/__aio/health`. See [Versioning](versioning.md) for the rule and the full
file-name grammar.

On a name collision (e.g. both `browser` and `server`, which each emit the bare
binary) the second is suffixed with its target (`myapp-1.2.345-server`) —
nothing is silently overwritten.

### Every `build` key

The whole deno.json `build` block. A key that is not in this table is named in a
build warning (`deno.json build block: aio never reads …`) and does nothing.

| Key               | Value                                               | Default                                     | What it decides                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `targets`         | list of target names, or `{ label: { … } }` (below) | —                                           | what `deno task build` builds                                                                                                                                                                                            |
| `platforms`       | list of platform names                              | `["host"]`                                  | which OS/CPU each target is built for — [platforms](#build-for-other-operating-systems----platforms)                                                                                                                     |
| `out`             | directory                                           | `"dist"`                                    | where the artifacts land                                                                                                                                                                                                 |
| `server`          | `host:port` or a URL                                | none                                        | the address baked into client artifacts — [build.server](#buildserver--the-address-a-shipped-client-starts-with)                                                                                                         |
| `strictPin`       | `true`                                              | `false`                                     | the packaged Electron client refuses a paired host whose certificate changed — [Electron client](../clients/electron.md); the Android client never sends a key over plain http (below)                                   |
| `ui`              | path, relative to the app dir                       | `App.tsx`                                   | the component every target bundles                                                                                                                                                                                       |
| `css`             | command string, or an argv list                     | none                                        | the app's own CSS step — [CSS toolchain](../ui/css-toolchain.md)                                                                                                                                                         |
| `channel`         | a channel name: `"dev"`, `"test"`, `"prod"`, …      | `"prod"`                                    | the release channel a build is stamped with — [updates](../deploy/updates.md#channels)                                                                                                                                   |
| `v8Flags`         | list of `--…` flags                                 | none                                        | V8 flags of a compiled binary — [memory](#memory-buildv8flags)                                                                                                                                                           |
| `keepPackages`    | list of npm package names                           | none                                        | packages the dev-only exclusion must leave in — [keepPackages](#keep-a-build-only-package-buildkeeppackages)                                                                                                             |
| `minify`          | `true` \| `false`                                   | `true`                                      | minify the embedded server modules — [minify](#hide-the-server-source-buildminify-on-by-default)                                                                                                                         |
| `chromiumExtras`  | `"keep"` \| `"strip"`                               | `"keep"`                                    | drop Chromium's optional graphics libraries — [extras](#optional-chromium-extras-buildchromiumextras)                                                                                                                    |
| `guestPreloads`   | list of file paths, relative to deno.json           | none                                        | `<webview>` preloads an Electron package ships — [guest preloads](#webview-guest-preloads-buildguestpreloads)                                                                                                            |
| `smoke`           | `true` \| `"desktop"` \| `"strict"`                 | off                                         | start each built artifact and fail the build when it does not come up — [smoke](#start-what-you-built---smoke)                                                                                                           |
| `electronRuntime` | `"online"` \| `"offline"`                           | `"offline"` (`am create` writes `"online"`) | a desktop package downloads its Electron once into a per-user store every online app starts from, or carries its own — [shared runtime](#shared-electron-runtime-buildelectronruntime)                                   |
| `splash`          | `false` \| `{ "image": "…png", … }`                 | none                                        | the image a desktop package, an APK and the `web` target's page show from their first moment until the app has loaded — [splash](#splash-buildsplash)                                                                    |
| `windows`         | `{ "shortcut": true \| false }`                     | `shortcut: true`                            | whether the one-click `.exe` adds a Start-menu shortcut — [electron](#electron-desktop-app)                                                                                                                              |
| `macos`           | `{ "bundleId": "…", "host": "[user@]mac" }`         | `app.aio.<name>`                            | the bundle identifier, and the Mac that packs the `.dmg` — [macOS](#macos-the-app-and-the-dmg)                                                                                                                           |
| `android`         | `{ "strict": true }`                                | `strict: false`                             | an `android/` overlay that drops part of the template's activity fails the build — [native code](#adding-native-android-code-the-android-folder); `keystore`, `keyAlias`, `aab` — [signing](#signing-a-release-apk--aab) |

A target in the object form of `targets` takes `kind`, `entry`, `ui`, `name`,
`title` and `platforms`.

### One repo, two apps — per-target `entry`

The list form builds every target from the same `entry`. When the repo holds
**two apps** — a relay server and the client that talks to it — write `targets`
as an object and give each one its own module (and its own name):

```jsonc
// deno.json
"entry": "src/app.ts",          // the default, for anything not overridden
"build": {
  "targets": {
    "server":   { "entry": "src/relay/app.ts", "name": "relay" },
    "electron": { "entry": "src/app.ts" }
  },
  "out": "dist"
}
```

```
dist/
  relay-1.2.345        ← compiled from src/relay/app.ts
  myapp-1.2.345-x86_64.AppImage   ← compiled from src/app.ts
  manifest.json           targets[].binary + targets[].entry say which is which
```

- **`entry`** — the module this target compiles. Everything derived from the
  entry follows it, including the app dir (`dirname(entry)`) that the bundler
  reads `App.tsx`, `style.css` and `icon.png` from.
- **`name`** — this target's binary/APK name (the file names, `notes-pro-…`, the
  macOS bundle id `app.aio.<slug>`, the Android applicationId `app.aio.<slug>`,
  the systemd `Description=`), overriding `title`. Two different apps must not
  share one name; without it they collide and the second is suffixed as if it
  were another build of the first. ⚠ On Android a new name is a new
  applicationId — a SECOND app on the phone, the installed one keeping its data.
  Pin `"android": { "applicationId": "…" }` in deno.json before renaming a
  shipped APK; the build warns when the derived id differs from the last build's
  (`dist/manifest.json` records it as `applicationId`; a dev APK,
  `--android-dev-url`, is recorded as `dev: true` and never compared with a
  release one).
- **`title`** — this target's display name: what a person sees — the macOS
  `.app` and DMG volume, the Linux `.desktop` `Name=`, the Windows README, the
  generated icon monogram, the Android label — overriding deno.json `title`.
  `name` does not change it, so a `"name": "Notes PRO"` edition still shows as
  "Notes" and its `Notes.app` replaces the free edition in /Applications. Add
  `"title": "Notes PRO"` and it installs beside it as `Notes PRO.app`. The build
  warns when two desktop targets are different apps that show one name. The
  running app's window title still comes from `aio.run({ ui: { title } })`.
- **`platforms`** — an OS/arch list for this target alone, overriding
  `build.platforms`.
- **`kind`** — what kind of target this is, when the key is a LABEL rather than
  a target name. Without it the key must itself be a target name, which caps a
  repo at one target of each kind.
- **`ui`** — the component this target bundles, relative to its app dir
  (default: `App.tsx`). The build-side twin of `ui.entry`; a compiled bundle
  records what it was built from and the server refuses to serve one that
  disagrees with the running config.

### Two apps of the same kind

Three apps in one repo — a relay and two desktop clients — is the shape
[app architectures](../basics/app-architectures.md) recommends. Label each
target freely and name its `kind`:

```jsonc
"build": {
  "targets": {
    "agent":   { "kind": "electron",   "entry": "src/agent/app.ts",   "name": "remote-agent" },
    "control": { "kind": "electron",   "entry": "src/control/app.ts", "name": "remote-control" },
    "relay":   { "kind": "server-app", "entry": "src/server/app.ts",  "name": "remote-server" }
  },
  "out": "dist"
}
```

`name` renames the **artifact** (files, display name, macOS bundle id, Android
applicationId), not the running app. A compiled binary takes its RUNTIME
identity (its lock, its data directory) and its window title from the project's
deno.json, which every target embeds — so give each entry its own:

```ts
// src/agent/app.ts
await aio.run({ appId: "remote-agent", ui: { title: "Remote Agent" } /* … */ });
```

A declared `build.macos.bundleId` is one id for every target — leave it unset
(or build the editions from separate deno.json files) when two desktop targets
must install side by side on macOS.

Without it all three run as the project's app: the second one started on a
machine refuses with "Already running", and apps that never meet share one data
directory. The fleet build asks each host-built binary which appId it runs under
and warns when differently named targets answer the same. `am` reads identity
the same way: a component's app id is the one its entry runs under, never its
`name` — two components without their own `appId` are one app, and `am start`
refuses them up front instead of waiting on a name nothing runs under.

The label is what you pass to `--targets=agent,relay`, what names the artifact
group in the summary, and what the manifest records. A label that IS a target
name (`"electron": {…}`) keeps meaning exactly what it always did.

Both spellings behave identically otherwise — `["server", "electron"]` is the
object form with no overrides, and `--targets=server` still selects a subset
without discarding its declared entry.

> `dist/` is bundle STAGING, not a destination: it is embedded into the binary
> wholesale (`deno compile --include dist/`) and every build wipes what it does
> not own there. Chaining single-target builds that all write into it loses the
> earlier artifacts. A `dist/` the project brought with it — holding none of the
> files an aio build stages there and no `manifest.json` — is refused, its files
> named, instead of emptied. When `dist/` holds a previous release
> (`"out": "dist"`, the default) and this build's out is elsewhere
> (`--out=dist-online`), that release — `manifest.json` and its artifacts — is
> moved to `.aio/kept-dist-<time>/` first, and the build says so.
>
> Give each build its own destination instead — `build.ts` takes **`--out=`**:
>
> ```sh
> deno run -A build.ts --compile --service --remote --entry=src/server/app.ts --out=release/relay
> deno run -A build.ts --compile --electron --entry=src/agent/app.ts  --name=agent --out=release/agent
> ```
>
> `--out=` inside `dist/` is refused, for the reason above. `deno task build`
> (the fleet build) does this staging for you — reach for the flag only when you
> are orchestrating builds yourself.

## `build.server` — the address a shipped client starts with

A client artifact used to open a box asking for a server address the build
already knew. `build.server` is now baked into what the build produces:

- **Electron client** — connects straight to it. `--server-url=` and an imported
  `.aioapp` profile still win (both are someone choosing THIS run), and
  `--connect` always reaches the picker for when the server has moved.
- **Android / iOS client** — every launch connects without a form: to the user's
  own choice once they have made one (including a change), else to the baked
  address. Back to the connect page stays on the form, to change it.
- **CLI client** — takes the address as its first argument, which a launching
  script already controls; nothing is baked.

Write it the way you would say it — `192.168.1.50:8000` — the scheme is inferred
when you leave it out, and an explicit `https://` is honoured, in any case.
`ws://` and `wss://` name the same server as `http://` and `https://`. A value
that is not an address (`host:99999`, `ftp://…`) refuses the build, naming it —
it is never baked as "no server".

An explicit port in `build.server` is also the port the `server` targets'
systemd unit pins (`--port=8000`); without one the unit names no `--port`, and
the service binds what the app declares (`aio.run({ port })`, `$AIO_PORT`) — or,
when it declares none, `3000`: the unit sets `AIO_DEFAULT_PORT=3000`, the bottom
rung of the port chain, so a restart never moves the service to a new random
port and never overrides a port the app declares.

## Build for other operating systems — `--platforms`

The targets above are the **shell** (what kind of app). The other axis is the
**platform** — which OS and CPU the binary runs on. By default that is the
machine you are building on; name others and one command emits them all:

```jsonc
// deno.json
"build": {
  "targets": ["server", "cli"],
  "platforms": ["host", "windows", "macos-arm64"]
}
```

```sh
deno task build --all-platforms   # everything this machine can produce
deno task build --platforms=linux,windows,macos,macos-arm64
deno task build --list            # shows every platform, and marks this machine
```

`--all-platforms` works on `compile` too (it is `build` narrowed to one target).
It never quietly means "some": a pair this host cannot produce is printed as
`–  skipped` with the reason, and the summary counts it separately.

| Platform      | Triple                      | Runs on                             |
| ------------- | --------------------------- | ----------------------------------- |
| `linux`       | `x86_64-unknown-linux-gnu`  | Linux x86_64                        |
| `linux-arm64` | `aarch64-unknown-linux-gnu` | Raspberry Pi, Graviton              |
| `windows`     | `x86_64-pc-windows-msvc`    | Windows x86_64 (artifact is `.exe`) |
| `macos`       | `x86_64-apple-darwin`       | macOS Intel                         |
| `macos-arm64` | `aarch64-apple-darwin`      | macOS Apple Silicon                 |
| `host`        | —                           | whatever you are building on        |

The host's artifact keeps its plain name (`myapp`); every other platform is
labelled (`myapp-windows.exe`, `myapp-macos-arm64`), so one `dist/` can hold
them all. `manifest.json` records `builtOn`, the `platforms` list, and per
artifact its `platform`, `triple`, and whether it is the `host` one. A server
target's systemd unit is written for Linux platforms only, named like its binary
(`myapp.service`, `myapp-linux-arm64.service`); a macOS or Windows platform gets
[its own supervisor file](../basics/windows-macos.md#run-at-startup-or-as-a-service)
instead (`<artifact>.plist`, `<artifact>.ps1`).

**What cross-compiles**

|                                        | from any host                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `server` `browser` `cli` `cli-client`  | ✅ — `deno compile` emits the target's binary                                                                                         |
| `electron` → **Windows, macOS**        | ✅ — the runtime is a published zip we fetch and cache; Windows is a directory + launcher + zip, macOS a real `.app` (assembled here) |
| `electron*` → **Linux**                | ❌ needs a Linux host **of that arch** — an AppImage is assembled by `appimagetool`, a native binary                                  |
| `electron-client` → **Windows, macOS** | ❌ by design — the connect-page client is an AppImage, Linux only; build `electron` or `cli-client`                                   |
| `android*`                             | ❌ by design — the APK is platform-independent, so it is built **once**, on any host                                                  |
| `web`                                  | ❌ by design — the same static files on every OS, built **once**, on any host                                                         |
| `ios-client`                           | ❌ by design — the Xcode project is the same on every host; `xcodebuild` (macOS) makes the `.app`                                     |

So on a Linux x86_64 box, `--targets=electron --all-platforms` gives you the
Linux `.AppImage`, the Windows `.zip` and both macOS `.dmg`s, and skips
`linux-arm64` with its reason.

What still needs the target OS is **notarization**, not packaging: Apple
notarization, and a Windows Authenticode certificate. The Windows artifacts are
unsigned on every host. The macOS `.app` is ad-hoc signed only where `codesign`
exists — on a Mac, or on the Mac named by `AIO_MACOS_SSH`; with neither it is an
unsigned `.zip` (see below). A _downloaded_ app without a Developer ID or
Authenticode signature meets Gatekeeper/SmartScreen, which is a distribution
decision, not a build one.

### macOS: the `.app` and the `.dmg`

A macOS GUI app is not a binary or a zip — it is a **bundle**: a directory with
a `Contents/Info.plist`, an icon, and a bundle identifier, which is what the OS
reads to draw the Dock entry, the menu bar and the window. So the `electron`
target produces:

| Platform      | Artifact                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------- |
| macOS (x64)   | `<name>-<version>-mac-x64.dmg` (a `<name>.app` inside) + `<bin>-mac-x64.app.tar.gz` (update) |
| macOS (arm64) | `<name>-<version>-mac-arm64.dmg` + `<bin>-mac-arm64.app.tar.gz` (update)                     |

The `.app.tar.gz` is the **self-update artifact** (target `electron-app`): the
same signed `.app`, packed by the Mac right after it sealed it — tar, so the
framework symlinks and exec bits the seal covers survive. It exists only when a
Mac signs the bundle (the DMG paths below); the `.dmg` is the first download,
the tarball is what `am publish` names in `darwin-<arch>.json`.

The `.app` is assembled **on any host** (a bundle is a directory tree and
Electron's runtime is a download), with the shape a real macOS app has:

```
Counter.app/Contents/
  Info.plist            identity: CFBundleExecutable, Identifier, Icon
  PkgInfo
  MacOS/
    counter             the Deno server binary IS the bundle executable
    app_window          a link to electron/…/MacOS/Electron — the window is started through it
    electron/Electron.app/   the runtime
  Resources/
    AppIcon.icns
    en.lproj/ …         the runtime's kept language stubs (the app's language is chosen from these)
```

Four details are load-bearing and were measured on a real macOS 14 guest:

- **The Deno binary is `CFBundleExecutable`.** aio is a two-process app — the
  binary owns the server and spawns Electron as its window. Its identity is the
  app's, so there is one Dock entry and one lifetime.
- **`Contents/MacOS/` holds only code: the executable, the runtime, and the
  window's link to it.** `codesign` treats that directory as code-only; a
  `dist/` there fails the seal with "code object is not signed at all / In
  subcomponent: …/dist/icon.png". None is needed — the compiled binary embeds
  `dist/` in its Deno VFS and serves it to Electron over the app's own socket.
- **The window is started through `Contents/MacOS/app_window`,** a relative link
  to the runtime's executable. macOS decides which app a process is from the
  path it was started by, so the window IS `Counter.app` — the one entry the
  system re-opens and quits — and not a second bundle nested inside it. (Started
  by its nested path, a second `open` of the running app registered the server
  process instead, and "quit" then reached nothing.) The link is sealed with the
  bundle and survives the `.dmg`, the `.app.tar.gz` and the `.zip`; a bundle
  unpacked by a tool that drops symbolic links still starts — from the nested
  path, with a log line saying what that costs. Because the bundle is now the
  window's main bundle, its `Info.plist` also carries the runtime's own
  `NS…`/`Electron…` keys, and its `LSMinimumSystemVersion` is the bundled
  Electron's (13.0 for Electron 44), never lower than aio's floor of 12.0.
- **The nested Electron carries the same `CFBundleIdentifier` and icon.** macOS
  merges processes by identifier; matching them is what shows **Counter** in the
  menu bar and Dock instead of **Electron**.

Unused Chromium translations are trimmed (~218 `.lproj` bundles, ≈46 MB), the
app's `icon.png` becomes `AppIcon.icns`, Electron's `LICENSE` and
`LICENSES.chromium.html` ride in `Contents/Resources/` (redistribution requires
them, and they are the same files the Linux/Windows packages carry). Where a Mac
packs the image (the first two cases below), the whole bundle is signed
inside-out (ad-hoc) there, so macOS will actually launch the nested runtime — an
unsealed one is killed with exit status 1 and no message.

**The `.dmg` needs `hdiutil`, which exists only on macOS.** It is a disk image,
not an archive, so there is no Linux equivalent. `aio` handles this without
falling back to a zip in disguise:

- **On a Mac** — it just runs `hdiutil`.
- **Anywhere else** — set `AIO_MACOS_SSH=[user@]mac-host` (or
  `"build": { "macos": { "host": "…" } }` in `deno.json`) and the build ships
  the `.app` to that Mac, runs `hdiutil` there, and fetches the `.dmg` back. An
  `~/.ssh/config` alias works; the only requirements are OpenSSH and an
  authorised key.
- **Neither** — the `.app` is zipped to `<name>-<version>-mac-<arch>.zip` and a
  warning says so. It never produces a file that merely claims to be a `.dmg`.

Either way the artifact is **one file**, because the `.app` is a directory and
the build's output is a file. The DMG is preferred: it is what a macOS user
expects, and signing happens on the Mac (see below). The zip is the honest
fallback — it still runs on Intel, but **an unsigned arm64 `.app` is refused by
Apple Silicon**, and editing the nested `Info.plist` necessarily invalidates
Electron's shipped signature (arm64 binaries carry one; the kernel requires it).
So on a host with no Mac, treat the arm64 zip as a build artifact to be signed
on a Mac before it can ship.

### First open of a downloaded app

aio does nothing here on either OS: the package carries no signature the OS
recognises, and each OS holds the first launch of a copy that was
**downloaded**. A copy that never carried the download mark (built locally, or
copied with `scp`) opens directly.

**macOS — Gatekeeper.** The bundle is signed ad-hoc, not with an Apple Developer
ID, and it is not notarized. So a `.dmg` downloaded through a browser carries
macOS's quarantine mark, and Gatekeeper holds the first launch with a warning
that Apple cannot check the app. Measured on macOS 14: the process is held
before any app code runs, and nothing opens until the user approves it. The way
through:

- **macOS 14 and earlier** — Control-click the app → **Open** → **Open**.
- **macOS 15 and later** — try to open it once, then **System Settings → Privacy
  & Security → Open Anyway**.
- **From a terminal** —
  `xattr -dr com.apple.quarantine "/Applications/<name>.app"`.

Only a Developer ID signature plus notarization removes the warning. That needs
an Apple Developer account, which is a distribution decision, not a build step.

**Windows — SmartScreen.** The `.exe` and the `.zip` are unsigned unless you
[sign them](#electron-desktop-app). A browser marks what it downloads, and
Windows holds the first start of a marked, unrecognised program with a blue
**Windows protected your PC** panel whose only button is **Don't run**:

- **In the panel** — **More info** → **Run anyway**.
- **Before opening** — right-click the file → **Properties** → tick **Unblock**
  → **OK**, or in PowerShell `Unblock-File .\<name>-win-x64.exe`.
- **The `.zip`** — unblock the zip before extracting it; Explorer copies the
  mark onto every file it extracts.

An Authenticode signature names you as the publisher in that panel; whether it
still appears is Microsoft's reputation decision. This is how Windows treats any
downloaded program — the panel itself has not been recorded in an aio run, whose
Windows machines received the files by copy.

### Opened outside Applications (macOS)

A user who double-clicks the app inside the mounted `.dmg`, or in Downloads,
gets an app that works and can never update: it runs from a read-only image, or
from the temporary read-only copy macOS makes of a quarantined app (App
Translocation). So a desktop app that finds itself outside `/Applications` and
`~/Applications` asks once, after its window is up: **Move _App_ to your
Applications folder?** — **Move to Applications** / **Not Now**.

- **Move** copies the bundle into `/Applications` (`~/Applications` when that
  folder cannot be written), clears the quarantine mark from that copy, closes
  the app the ordinary way and opens the copy. The copy it was opened from is
  left where it is.
- **Not Now** is remembered in the app's data directory (`macos-move-declined`);
  delete that file to be asked again. A dialog nobody answers is not an answer.
- **No question at all** when an app of the same name is already in Applications
  (nothing is replaced), for a server-only or browser client, when running from
  source, and for the copy `run.sh` / `am` installed
  (`~/app/<name>/versions/<version>/<App>.app`): that one is installed where it
  is — it updates there, and `am upgrade` / `am remove` know it there.
- `AIO_MOVE_TO_APPLICATIONS=never` switches the question off; `=move` moves
  without asking (an unattended install).

Measured on macOS 14: opened from the mounted image and from a quarantined copy
in Downloads (running translocated), the app moved, the copy in Applications
carried no quarantine mark and a valid signature, and it came back as the one
entry in the Dock. The question waits for the window on purpose — asked earlier,
its process took the app's own entry in the system's application list. The
buttons themselves were not pressed in that run (the test Mac has no way to
click them remotely); what each answer does is covered by
`tests/macos-move.test.ts`.

`"build": { "macos": { "bundleId": "com.acme.Counter" } }` overrides
`CFBundleIdentifier`; the default is `app.aio.<binaryName>`.

Anything refused is **refused with the reason**, never quietly satisfied with a
host binary under a foreign name.

> **A cross-built binary is built and checked here, not run here.** Only the
> host artifact can boot on the build machine; that is what
> `deno task
> test:build` exercises. The rest are verified by format (a Windows
> artifact is asserted to be a real PE executable, not a renamed ELF) —
> smoke-test them on the target OS, or in its CI runner, before you ship.
>
> There is no single file that natively runs on all three: Linux, Windows and
> macOS use different executable formats (ELF / PE / Mach-O) and different
> syscall ABIs. One artifact per platform, from one command, is the achievable
> version of that.

### Target names

| Name              | Role   | Produces                                       |
| ----------------- | ------ | ---------------------------------------------- |
| `server`          | server | headless binary + systemd unit (`--expose`)    |
| `browser`         | app    | self-contained binary serving the browser app  |
| `electron`        | app    | desktop app: AppImage / `.dmg` / `.exe`+`.zip` |
| `android`         | app    | Android APK (bundled assets)                   |
| `web`             | app    | static PWA directory (no server, offline)      |
| `cli`             | app    | headless CLI binary                            |
| `electron-client` | client | standalone Electron connect-page AppImage      |
| `android-client`  | client | Android client APK (connects to a server)      |
| `ios-client`      | client | iOS client Xcode project; `.app` on macOS      |
| `cli-client`      | client | CLI client binary (connects to a server)       |

> android and web with bundled assets: your entry module never runs on the
> phone, so the **build** reads what it passes to `aio.run()` and bakes in the
> options that are plain data — `ui.theme`, `ui.layout`, `ui.lang`, `ui.dir`,
> `ui.head`, `ui.viewport`, and `persist`, `cellDefaults`, `perfBudget` and
> their kin. The build prints what it baked and names what cannot travel (the
> hooks, `ui.showStatus`, server-only options) —
> [Runtime differences](runtime-differences.md#a-packaged-apk-never-runs-appts).

Each target maps to a set of single-target `build.ts` flags (the table below),
run as a subprocess. A failed target is reported in the summary and marked
`ok: false` in the manifest; the exit code is non-zero if any target failed.

## Dev mode

```sh
deno task dev                       # the default target (deno.json "client")
deno task dev --client=electron     # flags pass through — any shell
deno task dev --client=server-only  # headless
deno task dev --expose              # reachable on the LAN (server side)
```

Live-transpiles `.ts`/`.tsx` via esbuild on each request. File watcher
auto-reloads the browser on save. Error overlay shows **Build Error** or
**Runtime Error**. Opens the default target's shell. There is ONE dev task —
every other shell/topology is a flag, not another task; a thin dev client is
`deno run -A src/client.ts` (CLI) or `deno task dev --connect` (Electron connect
page).

## Build flags (single-target `build.ts`)

**There is one build path.** `build.ts` invoked with these flags resolves the
target they name and runs the fleet for it, so every route — `am build`,
`deno task build`, `deno task compile`, a direct `build.ts --compile --electron`
— produces the same artifact, in `dist/`, with the version in its name, recorded
in the same `manifest.json`, covered by the same artifact E2E.

A flag combination that names **no** target is refused, with the list. It used
to fall back to a second code path that wrote an unversioned artifact into the
project root — invisible to `dist/manifest.json`, and therefore to `am publish`
and to every updater. "It built something" was the worst available answer, since
the something was unshippable and looked fine.

`--service` here means "emit a systemd `.service` unit", not a target name.

### What lands in `dist/`

`dist/` is **one release, assembled clean**: the artifacts, their `.service`
units, and `manifest.json`. Flat — no nested directories. The build's own
scaffolding (the AppImage `AppDir`, the generated Gradle project) lives in
`.aio/build/`, where it is kept between runs so Gradle stays incremental.
Anything else in `dist/` (a file an app's own task wrote there) is removed by
the next build, and the summary names it:
`⚠ dist/ is rebuilt clean on every build — it removed 1 entry no build put
there: export`
— write such files outside `dist/`.

File modes: everything INSIDE a package — the `.dmg`, the `.app.tar.gz`, a zip,
an AppImage, the Windows exe's payload, the `<bin>-web/` folder, the iOS project
— is `0755` for directories and executables and `0644` for other files, whatever
the builder's umask. The files in `dist/` themselves (the `.zip`, the `.exe`,
the `.dmg`, `manifest.json`) are the builder's own and follow its umask;
compiled binaries and the AppImage are executable. In the Windows exe's payload,
where no exec bit exists, "executable" is what Windows runs by its name: `.exe`,
`.bat`, `.cmd`, `.com`.

| Flag                                      | Effect                                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--compile`                               | Compile standalone Deno binary                                                                                                                       |
| `--electron`                              | Build the desktop package: AppImage (Linux), `.dmg` (macOS; a `.zip` with no Mac), one-click `.exe` + `.zip` (Windows) — implies `--compile`         |
| `--client`                                | Build client-only AppImage — no Deno runtime, Linux only (target `electron-client`)                                                                  |
| `--cli`                                   | Build CLI binary — no browser bundle, headless server (target `cli`)                                                                                 |
| `--cli --remote`                          | Build client-only CLI binary — no server (target `cli-client`)                                                                                       |
| `--android`                               | Build APK via Gradle                                                                                                                                 |
| `--ios`                                   | Write the `ios-client` Xcode project (with `--remote`); `.app` on macOS                                                                              |
| `--android --remote`                      | Build client-only APK — connect page, no local dispatch (target `android-client`)                                                                    |
| `--web`                                   | Write the standalone web app / PWA directory `<bin>-web/` (target `web`)                                                                             |
| `--compile --service`                     | Compile binary + generate systemd unit file                                                                                                          |
| `--compile --service --remote`            | Same, with `--expose` in systemd ExecStart                                                                                                           |
| `--compile --service --headless`          | Same, with `--client=server-only` in ExecStart                                                                                                       |
| `--compile --service --headless --remote` | Same, with `--expose --client=server-only` (`server`)                                                                                                |
| `--name=X`                                | Override binary name (default: from deno.json `"title"`)                                                                                             |
| `--force`                                 | Skip bundle cache — always rebuild `dist/app.js`                                                                                                     |
| `--analyze`                               | Print where the bundle's bytes went (per dependency, per framework area), and what a compiled binary embeds — same artifact, one extra report        |
| `--smoke` / `--smoke=desktop` / `=strict` | After building, start each artifact and fail the build when it does not come up clean — see [Start what you built](#start-what-you-built---smoke)    |
| `--release`                               | Android release build (default: debug) — unsigned, or a signed APK + AAB with `AIO_ANDROID_KEYSTORE` ([signing](#signing-a-release-apk--aab))        |
| `--display-name=X`                        | Display name for this build (a target's `"title"`; default: deno.json `"title"`)                                                                     |
| `--entry=PATH`                            | Entry point for this build (default: `deno.json` `entry` › `src/app.ts`)                                                                             |
| `--ui=PATH`                               | UI component this build bundles, overriding the `App.tsx` convention (recorded in the bundle; dev==prod checked)                                     |
| `--platform=X`                            | Which OS/arch this binary is FOR (default: the host) — see `--platforms` below                                                                       |
| `--android-dev-url=URL`                   | Android dev APK: hot-load the app from a running dev server at this URL (validated; must be a URL)                                                   |
| `--allow-server-only`                     | Android: assert the server-only paths the graph reaches are guarded and never taken (else the build is refused)                                      |
| `--print-app-tmpdir`                      | Build nothing: print the TMPDIR a launcher must hand this project's packaged artifact                                                                |
| `--print-install-root`                    | Build nothing: print where a built artifact gets installed (`run.sh` asks instead of hardcoding `~/app`)                                             |
| `--print-install-name=<file>`             | Build nothing: print what that artifact is installed as — base name, extension, version (`run.sh` / `run.ps1` ask instead of parsing names in shell) |
| `--list` / `--help` (fleet)               | Show target names / usage and exit                                                                                                                   |
| `--build-spec=X` (fleet)                  | The single-target build path/specifier the fleet delegates to (the generated task passes it)                                                         |

`deno task ship` (sign + publish a built artifact — see
[updates](../deploy/updates.md)):

| Flag                       | Effect                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--src=DIR`                | Source directory of the build (default: the artifact's)                                                   |
| `--name=N` / `--version=V` | Override the app name / version recorded in the manifest                                                  |
| `--key=key.json`           | Signing key (default `~/.aio/keys/<name>-release-key.json` when it exists)                                |
| `--channel=X`              | `dev` \| `test` \| `prod`                                                                                 |
| `--target=T`               | Which target the artifact is (when two build for one platform)                                            |
| `--url=U` / `--notes=…`    | Artifact download URL / release notes in the manifest                                                     |
| `--min-from=X.Y.Z`         | Refuse to update FROM anything older than this (a forced-step release)                                    |
| `--data=contract.json`     | Data contract to publish with the release; `--no-data` skips the data probe                               |
| `--out=ship.json`          | Manifest path                                                                                             |
| `--channel-dir=DIR`        | Also write `DIR/<channel>/<os>-<arch>.json` — the layout an update client fetches                         |
| `--allow-dirty`            | publish a `-dirty`/`-nogit` build anyway — logged; a published build should be reproducible from a commit |
| `--github`                 | `ship github`: write a GitHub release workflow                                                            |
| `--stdout`                 | `ship keygen --stdout`: print the key pair for a CI secret instead of writing a file                      |
| `--force`                  | `ship keygen`: overwrite an existing key / write one inside a git tree anyway                             |

### Which "title" names what

Both exist, both matter, and `deno.json`'s does double duty — which is why it
reads ambiguously:

| Setting                      | Names                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `deno.json` `"title"`        | the **binary/APK name** (slugified), and the window title if nothing else sets one     |
| `aio.run({ ui: { title } })` | the **window / browser tab title** only — never the binary                             |
| `--name=X` (build)           | the binary/APK name for this build (a target's `name`), over `"title"`                 |
| `--display-name=X` (build)   | the name people see (`.app`, DMG, `.desktop`, icon, Android label): a target's `title` |
| `--title=X` (runtime)        | the window title for this run, overriding `ui.title`                                   |

Window-title resolution is `--title` › `ui.title` › `deno.json "title"` ›
`"AIO App"`. So setting only `deno.json "title"` gives you a matching binary
name and window title; add `ui.title` when you want a spaced, human-readable
window title over a slugged binary (`"a field report Master"` vs
`a field report`).

### Where the bytes went (`--analyze`)

```
$ deno task build --analyze
bundle: 192.5 KB across 131 modules (bytes AFTER tree-shaking and minification)
  aio/air/                    76.1 KB  39.5%  ################  (46 modules)
  aio/browser/                31.2 KB  16.2%  ######  (19 modules)
  aio/state/                  27.0 KB  14.0%  ######  (25 modules)
  node_modules/immer/         10.4 KB   5.4%  ##
  src/App.tsx                  0.6 KB   0.3%  #
```

Same artifact, one extra report. Three things it deliberately does:

- **Counts what reached the OUTPUT**, not file size on disk. A 400 KB dependency
  that tree-shakes to 3 KB is not a 400 KB problem, and a report saying it is
  costs you a day.
- **Folds a dependency to its package**, because that is the unit you can act on
  — remove it, replace it, import less of it. Sixty rows of
  `three@0.160/build/*` answer "which dependency is big" worse than one row.
- **Summarises the tail rather than dropping it**, so the rows plus "everything
  else" always add up to the bundle.

A target that compiles a binary (`browser`, `electron`, `server`, `server-app`,
`cli`) then answers the same question for the binary itself:

```
binary: myapp is 131.2 MB — 24.3 MB of it is 1204 embedded file(s) (source, compiled form and source map); the rest is the Deno runtime and what the app imports by URL (jsr:, https:)
 by package
  node_modules/pdf-lib/            11.8 MB  48.6%  (212 files)
  (the app and what it links)       9.9 MB  40.7%  (431 files)
  node_modules/immer/               0.2 MB   0.8%  (28 files)
 largest files
  assets/model.bin                  6.0 MB  24.7%
  node_modules/.deno/pdf-lib@1.17.1/node_modules/pdf-lib/dist/pdf-lib.js   2.1 MB   8.6%
```

It is read out of the finished binary, not estimated from the sources: a package
row is what [`build.keepPackages`](#keep-a-build-only-package-buildkeeppackages)
keeps or the build leaves out, a file row is usually something `compile.include`
or an `assets` mount put there. A file is charged with what the runtime stores
beside it (its compiled form and source map), and content stored once is charged
once. The Deno runtime itself is 75–100 MB of every binary, by platform, and is
not in the list.

### Start what you built (`--smoke`)

```
$ deno task build --smoke

smoke
  ✓ browser   passed            myapp-0.3.1
  ✗ electron  FAILED            myapp-0.3.1-x86_64.AppImage
      guest preload REFUSED in the package: src/guest/preload.cjs is declared in deno.json build.guestPreloads and the packaged shell cannot attach it (it has: none)
  – server    not smoke-tested  myapp-server-0.3.1-windows-x64.exe
      not smoke-tested here: built for windows-x64
```

A green build says the artifact exists. `--smoke` runs it: after every target is
built and placed, each artifact that can run on this machine is started from a
foreign working directory with a throwaway home (its own data, config and temp
dir — never yours) on a free port, checked, stopped, and the build exits
non-zero when any of them did not come up clean. In deno.json:
`"build": { "smoke": true }` (or `"desktop"`, `"strict"`); the flag wins.

| Target                  | What is checked                                                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser`, `server-app` | answers `/__aio/health`; `/`, the bundle, the stylesheet and icon the page names, and every asset URL the bundle names all answer 200                                                                                       |
| `server`                | answers `/__aio/health` (it is headless — no page)                                                                                                                                                                          |
| `cli`                   | `--help` exits 0                                                                                                                                                                                                            |
| `electron`              | the window opens and its page finishes loading; every file the page names answers 200; every `build.guestPreloads` file is one the packaged shell says it can attach                                                        |
| all of the above        | nothing at ERROR level, no uncaught error and no `REFUSED` line in its console output or `logs/app.log`; it stops when asked (the request `am stop` sends; a desktop app by closing its window); no process is left running |

Everything else is listed with its reason and never skipped in silence: an
artifact built for another OS or architecture
(`not smoke-tested here: built
for windows-x64`), a client that needs its
server, an APK, a web directory. `--smoke=strict` turns a "not smoke-tested" row
into a failure — use it on the machine whose job is to prove the release.

Which desktop package is started depends on the build host: on Linux the
AppImage; on Windows the `.zip`, unpacked into the throwaway directory; on macOS
the `.app.tar.gz`, unpacked there and started by the program in its
`Contents/MacOS`. The one-click `.exe` and the `.dmg` are not started — one
installs itself and exits, the other would have to be mounted.

On Linux the desktop window opens on a nested X display (Xephyr, the one
`am start` uses for agents), never on your desktop; with no Xephyr installed the
row reads `not smoke-tested: no display` and names the package to install.
Windows and macOS have no nested display: there the window would open on your
desktop, so plain `--smoke` / `"smoke": true` lists the desktop artifact as
`not smoke-tested` and starts nothing (what it did through 1.0.19 — a build that
passed there keeps passing). Ask for it by name — `--smoke=desktop` or
`"build": { "smoke": "desktop" }`: the window opens on the desktop for the
seconds the check takes, and the build says so. `--smoke=strict` includes it.

An asset URL that 404s from the artifact and has no file in the source tree
either is reported and not counted — it is a 404 in `deno task dev` too, and a
string that looks like a path may be one of your routes.

## browser (standalone binary)

```sh
deno task compile
```

Bundles `src/App.tsx` and everything it imports into a fully self-contained
`dist/app.js` (no CDN dependency), then runs `deno compile` to produce a
standalone binary (~95MB). Dev-only packages (electron, esbuild, react,
react-dom) are excluded automatically.

`dist/app.js` is an INTERMEDIATE file, not something to serve: `deno compile`
embeds it, and the fleet then assembles a clean `dist/` holding the binaries and
`manifest.json` — the bundle is gone by the time the build finishes. The build
log says so
(`built dist/app.js … goes into the binary; not in the final
dist/`). Running
the source with `--prod` afterwards has nothing to serve, and warns at boot; run
the binary in `dist/`, or `deno task dev`.

The binary name comes from deno.json `"title"` (lowercased, spaces to hyphens).

```sh
./my-app                       # binary name derived from title "My App"
./my-app --port=3000           # custom port
```

> Scaffolds ship `compile` (the default target) and `build` (the declared
> fleet). Another target is one flag away: `deno task build --targets=X`.

### Data assets (WASM, etc.) are embedded

`deno compile` embeds the module graph, but **not** data files you read at
runtime via `import.meta.url` — e.g. WASM loaded server-side:

```ts
const bytes = await Deno.readFile(new URL("./syscalls.wasm", import.meta.url));
```

aio handles this for you:

- **Every `.wasm` in the project is embedded automatically** — zero config. A
  WASM app compiles and runs identically to dev (no "wasm not available").
- **Any other asset** (data files, models, fixtures) — list it in `deno.json` →
  `"compile": { "include": [...] }` (files or dirs, relative to the project
  root):

  ```jsonc
  // deno.json
  "compile": { "include": ["assets/model.bin", "data/"] }
  ```

  A module under an included **directory** (`"plugins/"` holding `.ts` / `.js`
  files loaded by a computed path) is a root of the binary's module graph, like
  the entry: the npm packages it imports are embedded. (They used to be left out
  as "unreachable", and the module failed when the binary loaded it.)

- **`*.server.ts` modules the entry can load are embedded automatically** — even
  one reached through an opaque `import(url)` the module graph cannot see. "Can
  load" is: in the entry's module graph, under the entry's own directory, or in
  the same directory as a module the graph reaches. A repo with several targets
  (a relay in `src/server/`, an agent in `src/agent/`) therefore ships each
  binary with only its own server code; the log lists the ones it left out. A
  module loaded opaquely from anywhere else goes in `compile.include`. A folder
  that is ANOTHER target's entry folder (`src/agent/` under a web entry in
  `src/`) belongs to that target: its `*.server.ts` ship elsewhere only when
  this entry's graph reaches them.

- **A file a server module reads from beside itself must be embedded — the build
  checks.** `Deno.readTextFile(new URL("../style.css", import.meta.url))` finds
  the file on disk in `deno task dev`; in a compiled binary `import.meta.url`
  points into the binary, which holds the module graph and the embedded paths
  and nothing else, so the read throws `NotFound`. The compile reads the app's
  own modules in the binary's graph and stops when such a read's target exists
  on disk and nothing embeds it:

  ```
  ✗ src/rud/serve.server.ts:12 reads "../../style.css" at run time → style.css,
    a file that is on disk in `deno task dev` and that this binary will NOT
    contain — the read fails in every shipped artifact. Embed it: add
    "compile": { "include": ["style.css"] } to deno.json.
  ```

  | Form                                                                                                                                                                                       | Verdict                   |
  | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
  | `new URL("lit", import.meta.url)` or `import.meta.resolve("lit")` written inside `Deno.readTextFile` / `readFile` / `open` / `readDir` (and `…Sync`) — `fromFileUrl(…)` around it included | build fails               |
  | the same bound to a name that a read call later mentions; `join(import.meta.dirname, "lit")`; a bare `Deno.stat` of it                                                                     | warning                   |
  | a read whose absence the code handles: `.catch(…)` on it, a `try`/`catch` around it that does not rethrow, an `if (!Deno.build.standalone)` (or `isCompiled()`) test                       | warning, naming the guard |
  | `fetch(new URL("lit", import.meta.url))` in a `*.server.ts` module                                                                                                                         | warning                   |
  | the same `fetch` in any other module — it runs in the browser, where the bundler resolved the URL                                                                                          | not judged                |
  | a target that does not exist at all (a typo — broken in dev too)                                                                                                                           | warning                   |

  Covered means: a module in the binary's graph, a `compile.include` file or a
  directory holding it, an `assets` directory, the staged `dist/`. A read that
  is never meant to run in a binary is acknowledged on its line:
  `// aio-ok(read): only under deno task dev`. Applies to every compiled target
  (`browser`, `server`, `server-app`, `electron`, `cli`, `cli-client`).

The compile log prints what it embedded (`[compile] embedding N data asset(s)`).
Compiled binaries are **fully portable** — they serve the embedded `dist/` and
run their WASM from any directory (an AppImage mount included); they never need
their source tree at runtime.

### Compiling an entry yourself

Running `deno compile` on your own entry (a custom script, a monorepo task, CI)
skips the pipeline above — so the two things it does for you have to be passed
by hand. Both are exported, so nothing has to be rediscovered:

```ts
import {
  assetIncludes,
  compileArgs,
  dbWorkerInclude,
  v8FlagsArg,
} from "aio/build";

const args = compileArgs({
  hasDist: true, // embed dist/ (the browser bundle)
  workerInclude: dbWorkerInclude(), // ← the SQLite worker
  assets: await assetIncludes(Deno.cwd(), "src/app.ts"), // ← .wasm + the entry's *.server.ts + compile.include + deno.json
  v8Flags: await v8FlagsArg(Deno.cwd()), // ← build.v8Flags
  excludes: [],
  out: "myapp",
  entry: "src/app.ts",
});
await new Deno.Command("deno", { args }).output();
```

### Memory: `build.v8Flags`

V8 caps its old-space heap at roughly **4 GB regardless of installed RAM**. For
most apps that is irrelevant — but if peak memory scales with the input (a large
index, a big in-memory table, a batch job), that cap, not the machine, is the
real limit.

The trap is that the fix does not survive packaging. **A compiled binary ignores
`DENO_V8_FLAGS`**, because V8 options are fixed when the isolate is created:

| binary                                           | `DENO_V8_FLAGS` set? | heap limit |
| ------------------------------------------------ | -------------------- | ---------- |
| `deno run`                                       | yes                  | raised ✅  |
| `deno compile`, no flags                         | yes                  | 4 GB ❌    |
| `deno compile --v8-flags=--max-old-space-size=…` | —                    | raised ✅  |

So an app that raises its heap in the `dev` task silently reverts to the default
once packaged, and only discovers it under load. Declare it instead, and the
build bakes it into every target:

```jsonc
// deno.json — under aio's "build" block, NOT under "compile"
"build": { "v8Flags": ["--max-old-space-size=16384"] }
```

`compile` is Deno's own block and rejects unknown keys, aborting the build with
`Failed to parse compile configuration` — which names neither the key nor the
fix. aio detects that spelling and redirects you here instead.

One flag per entry (the list is comma-joined); an entry that is not a `--` flag,
or that contains a comma, is **refused at build time** rather than silently
producing a binary that keeps the default. The build prints the flag it baked
in.

This is a **ceiling, not a reservation** — the heap still grows on demand, and
an idle app declaring 16 GB sits at the same ~50 MB RSS as one declaring
nothing.

**The SQLite worker is not optional.** Persistence always opens the
worker-thread DB, and the worker is started with
`new Worker(new URL("./db-worker.ts", import.meta.url))` — a construct
`deno compile` cannot see in the module graph. Without it the binary compiles,
boots, and then dies on the first DB call with
`Module not found: …/src/db/db-worker.ts`. A compiled binary that is missing it
says exactly that at boot, with the flag to add — it is never reported as a
permissions problem.

**Size flags.** A default `deno compile` of an aio app can carry the whole
`node_modules` tree — including the ~300 MB Electron runtime, inside a headless
server binary. One reporter's binary went **353 MB → 7 MB** with:

```sh
deno compile -A --node-modules-dir=none --exclude-unused-npm \
  --include <aio-src>/src/db/db-worker.ts \
  src/app.ts
```

- `--node-modules-dir=none` — resolve npm packages from the global cache instead
  of embedding a `node_modules` directory.
- `--exclude-unused-npm` — embed only the npm packages the module graph actually
  reaches (without it, the whole lockfile snapshot goes in).
- `<aio-src>` is wherever aio resolved for your project — `dep/aio/src` for a
  vendored install, `node_modules/.deno/@riagentic+aio@<version>/src` for a JSR
  one. Print it with `dbWorkerInclude()` rather than typing it.

`deno task build` already excludes the dev-only packages (electron, esbuild,
happy-dom, `typescript`) for every target, and — for every target except `cli`
and `cli-client` — every npm package the binary's graph cannot reach, which is
why its binaries are small without either flag. A CLI binary embeds the rest of
`node_modules` as installed. When the target is another platform (a Windows
build on Linux), the build tools' packages for THAT platform are left out too.

A binary runs on one system, so it carries **native packages for that system
only**. Which system a package is built for is the package's own statement — the
`os`, `cpu` and `libc` fields of its `package.json`, the rule npm installs by (a
package that states nothing runs everywhere). For a build of another platform,
the target's packages are installed first:
`deno install --entrypoint
<the binary's modules> --os … --arch …` in the
project. That install only **adds** — the host's packages stay installed through
the whole build, however it ends. The target's packages **stay in
`node_modules/.deno` after a cross build**; nothing prunes them, and every
compile leaves out each package that is not its own system's, so the first
Windows build on Linux and the tenth embed the same files. It resolves against a
**copy** of the project's lock: a build never writes `deno.lock`, and leaves no
tracked file changed. If the install cannot run (offline, with the target's
packages not yet in deno's cache), the build stops and says so. The audit that
ends every compile reads each embedded `package.json` and names any package
built for another system.

A package your own modules **import** that cannot run on the target is left out
like any other — and the build says so, by name: the binary would fail where it
loads it. Import such a package only on the system it runs on (a dynamic
`import()` behind a check of `Deno.build.os`).

It also drops the weight that is not a package at all: every source map
(`*.map`), every docs file (`*.md` — never a `LICENSE`, `NOTICE`, `COPYING`,
`AUTHORS` or `PATENTS` file, whatever its extension), and the test-fixture
directories inside an embedded package — none of which any runtime path reads.
On a large app those are hundreds of megabytes of the compiled binary. A
directory's name alone is not evidence that it holds fixtures, so the rule is
narrow:

- `__tests__` at any depth;
- `test` / `tests` only **directly under a package's root** — a library's
  `_esm/actions/test/` is runtime code and stays;
- never a package's own directory (a package _named_ `test`, `@scope/test`);
- never a module the binary's graph loads from there — a file your code imports
  from inside a package (`import "pkg/test/helpers.js"`) included;
- never a test directory its **own package names**: a literal relative specifier
  in the package's `.js` / `.cjs` / `.mjs` (`require("./test/x")`,
  `import … from "../tests/y.js"`, `import("./__tests__/z")`), or a path its
  `package.json` `main` / `exports` / `imports` hand out. The module graph has
  one entry per npm package and none of its files, so this is read from the
  package itself;
- nothing inside a package named in
  [`build.keepPackages`](#keep-a-build-only-package-buildkeeppackages).

What a build cannot read is a path a package **computes** at run time
(`require(dir + name)`, `fs.readFileSync(join(__dirname, "test", …))`) or a test
file named from another package. Held aside, that load fails in the binary with
`Cannot find module './test/…'` at the call — or not at all, where the package
catches it and falls back. Name the package in `build.keepPackages`: it is kept
whole.

They are **held aside for the compile and put back afterwards**, so your
`node_modules` is unchanged. A build that is interrupted (Ctrl-C, `SIGTERM`)
puts them back before it exits; one that is killed outright is repaired by the
next `deno task build` — or the next start from source (`deno task dev`), which
checks before it resolves a package — even after a reinstall of `node_modules`
in between. While a build is running they sit under `.aio/trim.<build>/` beside
the project. `.d.ts` files are deliberately kept — the compile type-checks with
them. `AIO_SKIP_TRIM=1` disables this for a build you are debugging.

aio's own tool cache (`node_modules/.cache`, where an older aio left a bare
`appimagetool`) is excluded from the binary and the legacy copy is removed. So
is deno's own install state: `node_modules/.bin` and, under
`node_modules/.deno`, `.setup-cache.bin` and `.deno.lock`. A binary runs none of
it, and the audit that ends every compile names any of them it still finds.

### Keep a build-only package: `build.keepPackages`

aio leaves the dev-only packages out of a compiled binary because the shipped
app does not run them — the client bundle is built ahead of time, the desktop
runtime is fetched at install, and TypeScript is transpiled at build time. An
app that genuinely **loads one at runtime** (a code playground that `import`s
`typescript`, say) asks for it back by name:

```jsonc
// deno.json
"build": { "keepPackages": ["typescript"] }
```

The build otherwise tells you when a package it is about to drop looks needed,
so the surprise arrives at build time, with the exact line above, not as a
`Module not found` on a user's machine:

- your own code imports it → a warning;
- a dependency you ship lists it under its `dependencies` → a warning naming
  that dependency;
- a dependency you ship lists it as a required **peer** (the common case:
  `typescript` pulled in by a library) → a warning naming that dependency. It is
  left out by name whether or not the tree has a top-level link for it. A
  library that only reads its types is unaffected and there is nothing to do;
  one that loads it at runtime fails in the binary at first use — add the line
  above.

On every target, the last two are said only for a dependency the binary loads:
one its module graph reaches, or one you named in `keepPackages` (the graph
cannot see a computed `import(name)`, so a package kept by name is asked what it
needs too). A package that is merely installed — a `cli` build embeds those — is
not asked.

**A name in `keepPackages` wins over every rule that leaves a package out** —
build-only by name, linked only from a build-only package, reached by no module,
or a platform package deno links during a cross build. One rule it does not
override by family: a package built for another system than the target stays out
even under a kept package (`esbuild` kept ships the TARGET's `@esbuild/<system>`
binary, not the host's) — name that exact package to ship it anyway. Any package
can be named, not only a build-only one — the usual reason is a package the app
loads by a computed `import(name)`, which the module graph cannot see. A name
that no installed package answers to keeps nothing, and the build says so. A
kept package ships **with everything it needs to run**: every package its
installed links lead to (its `dependencies`, its peers, the optional ones deno
installed), all the way down, even though no module reaches them — except
`@types/*` packages, which nothing loads at run time (name one to keep it). The
other exception is a build-only package on the way (`esbuild` under `tsx`): that
stays out unless you name it too, and the warning above says so with the line to
add — `"keepPackages": ["tsx", "esbuild"]`. On the machine that builds, a binary
that cannot start is refused; a cross-built one is not run, so read the warning.

**`esbuild` kept in a Windows binary**: Windows Defender has refused such a
binary at start as `Trojan:Win32/Cloxer` (a cloud verdict on a new file — most
builds, not all; a binary without esbuild was never flagged). The build warns
when a Windows binary embeds a kept esbuild. Keep it only if the app runs
esbuild while it runs; then sign the binary with a code-signing certificate, or
report the false positive to Microsoft.

A name in `keepPackages` also exempts that package from the source-map / docs /
test-fixture trim described above. Only the named package: the packages kept
because it needs them are trimmed like any other embedded package.

### Optional Chromium extras: `build.chromiumExtras`

Electron ships a DXIL shader compiler (`dxcompiler.dll`/`dxil.dll`, ~27 MB on
Windows), a software Vulkan implementation (`vk_swiftshader*`) and the Vulkan
loader itself (`vulkan-1.dll` on Windows, `libvulkan.so.1` on Linux) — ~9 MB of
Vulkan on Linux — because _some_ app uses each. aio keeps them by default: a 3D
app must keep hardware acceleration, and a GPU-less VM must keep its software
fallback. An owner who knows the app renders no GPU content can opt in:

```jsonc
// deno.json
"build": { "chromiumExtras": "strip" }
```

Stripping removes **all of Vulkan, not only the software fallback**: the loader
is how Chromium reaches any Vulkan driver, the machine's own GPU included, so
without it there is no Vulkan path at all — and WebGPU on Windows loses its
shader compiler (DXIL). Chromium's OpenGL/Direct3D paths are untouched: WebGL
(`d3dcompiler_47.dll`), media (`ffmpeg`), ICU data and every license file are
never removed. `"keep"` (the default) does nothing.

The value is checked on every desktop build, on every platform, and anything
other than `"keep"` or `"strip"` is named. It stops a Windows or Linux build.
Two builds do not depend on it and go on with a warning that says which setting
wins: a macOS build (the files are Windows and Linux ones; a macOS bundle keeps
its runtime whole, and the build says so) and a build run with
`AIO_STRIP_CHROMIUM=1` (the env form decides: the extras are stripped).

### Webview guest preloads: `build.guestPreloads`

A `<webview>` guest's preload is a file Electron opens from disk, so an Electron
package has to carry it:

```jsonc
// deno.json — paths are relative to this file
"build": { "guestPreloads": ["src/guest/preload.cjs"] }
```

Every Electron package (AppImage, Windows exe and zip, macOS app) then ships the
listed files, and the page names one with
`guestPreload("src/guest/preload.cjs")` from `aio/ui` — the same name in
`deno task dev`. A declared file that does not exist stops the build by name, on
every target; so does a literal `guestPreload("…")` that is not declared. The
window prints the files it can attach when it starts
(`guest preloads present in …`), and `build --smoke` fails a package whose list
lacks a declared one. See
[Embedding a web page](../clients/webview.md#a-preload-for-the-guest).

### Hide the server source: `build.minify` (on by default)

`deno compile` puts every server module into the binary as readable source —
comments and all. `strings myapp` prints your design notes back. The browser
bundle is already minified, and since 1.0.16-beta the **server side is minified
by default** too, so the normal build already removes that free gift.

To opt out (for a build you want to debug at the source-line level), set:

```jsonc
// deno.json
"build": { "minify": false }
```

Every compiled target (app, `server`, Electron, the Windows exe, `cli`) then
ships each server module minified: no comments, short local names — unless you
set `false`. The build says `build.minify: N server modules minified`, and that
stack traces change. The Android APK has no server binary: it ships only the
client bundle, which is always minified, and never its map.

- **Type check first.** Your ORIGINAL code is type-checked, then the minified
  copy is compiled with `--no-check`. A type error still fails the build.
- **Per file, not one bundle.** Each module is minified in place, so workers
  found by `new URL(…, import.meta.url)` (the SQLite worker) still load.
- **Names of functions and classes are kept**, so code reading `fn.name` or
  `constructor.name` works the same as unminified.
- **A module that cannot be minified safely ships as written**, and the build
  names it in a warning (`… ships UN-minified — <why>`) — its comments are then
  in the binary. Every reason, as the warning words it:
  - _its minified form reads differently as TypeScript_ — a comparison whose
    parentheses matter to TypeScript, `(a < b) > (c ? d : e)` or
    `[(a < b), c > (d ?? 0)]`: minified, a `.ts` file reads `a<b>(…)` as a
    generic call, or (`c > /x/.test(s)`) cannot read it at all. Rewrite the
    expression (`b > a`, a named constant).
  - _deno cannot read its minified form_ — the same family, one deno's parser
    alone trips on: `[(a < b), c > {}]`. deno reads the whole staged graph
    before it compiles, and a module it cannot parse goes back as written.
    Rewrite the expression.
  - _it uses decorators_ — any decorator, standard or `experimentalDecorators`.
    A decorator is handed names (`@d class K` gets `"K"`, `@d #secret` gets
    `"#secret"`), and those are exactly what minifying changes; legacy decorator
    metadata needs the types. Keep decorated classes in a module of their own if
    the rest should be minified.
  - _it uses the name `__aioName` itself_ — rename the binding.
  - _esbuild's name helper was not recognised_ — nothing in your code; aio's
    pinned esbuild printed something this version does not know. Report it.
- **A function's source can still leave its module.** Names are kept through one
  global, `__aioName(fn, "name")`, which every minified module defines — so the
  text of a minified function (`fn.toString()`) may call it. `blocking()`'s
  worker defines it too, so a `blocking()` function may declare helpers, arrows
  and classes of its own. If your app sends a function's source somewhere aio
  does not run — a page through `executeJavaScript`, a worker built from a
  string — and gets `__aioName is not defined`, define it there first:
  `globalThis.__aioName ??= (f, name) => Object.defineProperty(f, "name", { value: name, configurable: true });`
- **The client source map is left out** (`dist/.app.js.map` — it holds every UI
  name and path).
- **Stack traces** from the server keep function names, but their `line:column`
  point into the minified code, not your source. There is no server source map
  (it would ship the names back). To debug a trace, reproduce it with
  `build.minify: false`.
- **Not a lock.** Minified JS is still readable by someone who tries hard. It
  removes the free gift: the comments and names that explain the design.
- `true` or `false` only — `"true"` (a string) fails the build.

## electron (desktop app)

```sh
deno run -A dep/aio/src/build.ts --compile --electron
```

Does everything `compile` does, plus packages the binary with Electron:

| Platform | Output                                                     | How it opens                           |
| -------- | ---------------------------------------------------------- | -------------------------------------- |
| Linux    | `<name>-x86_64.AppImage` or `<name>-aarch64.AppImage`      | self-contained, double-click           |
| macOS    | `<name>-mac-x64.dmg` / `…-mac-arm64.dmg` (a `.app` inside) | drag to Applications, double-click     |
| Windows  | `<name>-win-x64.exe` (SFX, zstd payload)                   | double-click (extract once, then run)  |
| Windows  | `<name>-win-x64.zip`                                       | extract, run `run.bat` or `<name>.exe` |

Build steps: bundle dist/app.js -> compile deno binary (which embeds it) -> copy
Electron -> generate launcher + icon -> package (AppImage on Linux; a `.app` in
a `.dmg` on macOS, or in a `.zip` when no Mac is reachable —
[above](#macos-the-app-and-the-dmg); a zip on Windows). On Windows the one-click
`<name>-win-x64.exe` is then built as a **thin SFX**: the staged package is
packed into a **zstd-compressed tar** and appended to a small stub (~0.7 MB), so
the download is smaller than the zip (zstd beats deflate by ~15% and
decompresses faster), and it is not a second `deno compile` with
`electron-runtime.zip` inside the PE. First double-click extracts to
`%LOCALAPPDATA%\aio-sfx\<name>\win-<arch>\`; later launches skip extract when
the payload stamp matches. The `.zip` stays a plain zip (Windows Explorer can
open it).

**The Windows icon.** Both exes — the one-click download and the app's
`<name>.exe` inside it — wear the app's `icon.png`. A Windows icon holds images
of at most 256 px, so a larger square `icon.png` (the 512 or 1024 px one the
other platforms use) is scaled down by the build to 256, 48, 32 and 16 px; one
of at most 256 px is used as it is. An `icon.ico` beside `icon.png` wins and is
used byte for byte — draw your own small sizes that way. An `icon.png` the build
cannot use (not square; 16-bit or interlaced) gets the generated monogram, and
the build's closing summary says so and names the `icon.ico` to add.

What the `.exe` does when it is opened:

- **Twice at once** (a second double-click while the first is still extracting):
  the second waits for the first, then only starts the app — one install, never
  two extractions into one folder.
- **A different version is installed**: the installed folder is moved aside, the
  new one extracted and moved in, the old one deleted last; a failed extraction
  (a full disk) puts the old folder back.
- **The app is running** and the `.exe` carries a different version: nothing is
  changed, and a message says to close the app and open the file again.
- **The app updated itself**: the `.exe` starts the updated app — see
  [Updates](../deploy/updates.md).
- **A newer version is installed** than the one the `.exe` carries: the `.exe`
  opens what is installed and changes nothing. An old download can no longer put
  its version over a newer app, whose data it may not be able to read. (An
  `.exe` built with aio 1.0.17-beta or older still installs what it carries.)
- **Its first argument is `--aio-sfx-install`** (how `am upgrade <name>` runs
  it): it installs its version over whatever is installed — a newer one too,
  said on stderr — starts nothing and shows nothing. Exit 0: installed; 3: the
  app is running and nothing was changed; 1: any other failure, the reason on
  stderr.
- **Its first argument is `--aio-sfx-wait`**: it waits for the app and exits
  with the app's exit code (opened any other way it exits 0 as soon as the app
  is started). Both arguments are the `.exe`'s own and are not passed on; an
  `.exe` built with aio 1.0.19-beta or older passes them to the app.
- **It extracts** (a first open, another version): a progress window named after
  the app is shown until the files are in place.
- **It fails** (a damaged download, a full disk): a message box says why, and so
  does a line on stderr, with exit code 1. Opened where nobody could press OK —
  over ssh, from a service or a task that runs without a logged-on user — it
  shows no box and no progress window: the stderr line and the exit code are the
  answer, and it never waits.
- **It installed the app**: it adds a Start-menu shortcut named after the app
  (`title`), pointing at the installed `<name>.exe` — so the download can be
  deleted. Opening the `.exe` again without installing anything does not put
  back a shortcut the user removed, and neither does a newer `.exe` (or
  `am upgrade`) that replaces the install: the `.exe` records the shortcut it
  added and adds none over an install that has the record. One it could not add
  is said (a message box on a plain open, stderr under `--aio-sfx-install`) and
  the app opens all the same. An install made by an older `.exe` (aio
  1.0.17-beta or older, which added none) gets the same shortcut from the app
  itself, once, at its first start on a version that has this — so an app that
  updated itself needs no new download — and the log says the old `.exe` can be
  deleted (an app with `updates` reads the same fact as `updates.shortcutAdded`,
  on that one start, and can tell its user). What was decided is kept beside the
  install (`…\aio-sfx\<name>\win-x64.shortcut`), so a shortcut removed after
  that is not put back by a later start or update. (One exception: an install
  whose shortcut nothing recorded — made by a 1.0.18-beta `.exe`, or by a
  1.0.19-beta one for an app without `updates` — gets a removed shortcut back
  once.) `"build": { "windows": { "shortcut": false } }` in `deno.json` builds
  an `.exe` that adds none, and an app that adds none either. Nothing removes
  the shortcut when the app's folder is deleted by hand: aio has no uninstaller.

**Signing the `.exe` (Authenticode).** Sign the finished `<name>-win-x64.exe`
with your own tool —
`signtool sign /fd SHA256 /tr <timestamp-url> /td SHA256
<name>-win-x64.exe`, or
`osslsigncode` on Linux — after the build and **before** `deno task ship`, whose
manifest hashes the file as it will be downloaded. A signature appends a
certificate table after the SFX trailer; the stub finds its payload through the
PE security directory, so a signed `.exe` runs like an unsigned one — and
`run.ps1` and `am publish` recognise it as the one-click `.exe` by the same
rule. The signature covers the whole download, payload included; the
`<name>.exe` and Electron that it extracts are not signed individually. aio does
not sign for you.

Building that one-click `.exe` needs **no compiler**: the extractor stub is a
committed **prebuilt PE** (`src/build/windows-sfx-stub/prebuilt/`, a ~0.7 MB
Rust program, rebuilt only when its source changes — see that directory's
README), and the zstd payload is packed by aio itself, in Deno (`@std/tar`
through `node:zlib`). The stub is used only when its SHA-256 is the one pinned
in aio's source, and its build is reproducible (remapped paths, no build time),
so the bytes at the start of your `.exe` are checkable against the stub's
source; the licenses of what it links are in `THIRD_PARTY_NOTICES` beside it.
The payload is deterministic too: the same staged package packs to the same
bytes. If packing ever fails, the payload falls back to the same zip
(`format: "zip"`) — larger, still one-click — and the build says so with the
size it ships instead. The pack is also declined, the same way, on a build
machine that is out of memory headroom: under 5% of RAM available, or under 20%
with the swap over 80% full (full swap beside plenty of free RAM is not
pressure, and does not decline it). A symlink in the staged package ships as a
copy of its target (the build says so, with the size); one that points outside
the package, at nothing, or at a folder it is inside stops the build, naming the
path. `AIO_WINDOWS_FAT_EXE=1` restores the legacy `deno compile` PE instead, and
the build falls back to it by itself, with a warning, when the stub cannot be
read, fetched or verified. The intermediate `dist/app.js` does not survive into
the finished `dist/`.

On Linux and Windows the launcher sets `$ELECTRON_PATH` before starting the Deno
binary; on macOS the `.app` bundles the runtime where the binary looks for it
directly, so there is no launcher to run by hand. State is persisted to
`~/.<appId>/data/` on every OS (on Windows `%USERPROFILE%\.<appId>\data\`).

**Fuses.** The Electron inside every desktop package (and the tree a Windows SFX
extracts on first launch) has three of Electron's fuses turned off, so it cannot
be started around your app:

- as plain Node (`ELECTRON_RUN_AS_NODE`),
- with code injected through `NODE_OPTIONS`,
- with a debugger on the main process (`--inspect`).

The build says `Electron fuses off: …`, and fails if the runtime has no fuse
wire, so a package never ships without them. Dev (`node_modules/electron`) is
not changed; aio already refuses those three when it starts Electron itself.

**Building on each OS in CI.** Nothing builds on a pushed tag until the project
has a workflow that does. `deno task ship github --channel=prod` writes one
(`.github/workflows/release.yml`: Linux, macOS and Windows runners, on a `v*`
tag) — see [signing](../deploy/signing.md); [CI](ci.md) has the plain matrix.

### Shared Electron runtime: `build.electronRuntime`

```jsonc
// deno.json
{ "build": { "targets": ["electron"], "electronRuntime": "online" } }
```

- **`"online"`** — what `am create` writes into a new app. The package carries
  no Electron: it is the app alone (~75% smaller), and on its first start the
  app downloads the Electron its build pinned into one **per-user store** that
  every online app on the machine starts from. An update downloads only the app.
- **`"offline"`** — the package carries its own Electron and opens with no
  internet. It is what an app with no `electronRuntime` gets, as every app built
  before the key did. Its Electron is not shared: it is trimmed for that one app
  (unused translations, optional GPU files, on macOS its name and icon), so it
  is not a copy another app could start from.

| OS      | The store                                         |
| ------- | ------------------------------------------------- |
| Linux   | `~/.local/share/aio/electron/` (`$XDG_DATA_HOME`) |
| macOS   | `~/Library/Application Support/aio/electron/`     |
| Windows | `%LOCALAPPDATA%\aio\electron\` (never roams)      |

`$AIO_SHARED_ELECTRON_DIR` moves it. It is app data, not a cache: an app cannot
open without it, so only what no installed app needs is ever deleted from it
(see _Cleaning up_ below).

**An online app starts only that Electron.** An `$ELECTRON_PATH` it inherits —
from a bundled app's launcher, as when an update from a bundled build relaunches
it — is cleared by its own launcher (`AppRun`, `run.bat`) and ignored by the app
(logged once, naming the path): another package's Electron, from a mount that
can vanish, is never started in its place. A bundled package keeps using
`$ELECTRON_PATH` as before.

**The Electron it downloads is the one the app was built with — byte for byte.**
The build reads Electron's published `SHASUMS256.txt` once, on the build machine
(over HTTPS from Electron's GitHub release, or from the developer's own
`$ELECTRON_MIRROR`; kept in the tool cache for later builds), and writes each
platform's SHA-256 into the app's binary. On the user's machine the download
must hash to that number; nothing the network sends decides it, so a mirror, a
proxy or a man in the middle that serves a different zip — even with a matching
checksum list — is refused, nothing is unpacked, and the user is asked Retry /
Quit. An update fetches the new version's Electron against the number the NEW
build carries. A build that cannot get the list fails, never ships unpinned.

**Shared: the program files. Never shared: anything an app writes.** The store
holds Electron's files (and on macOS each app's window, stamped with that app's
name), and one record per app saying which Electron it needs — nothing else.
Each app runs its own Electron process, with its own Chromium profile (cookies,
Local Storage, IndexedDB, cache) in the app's own home, `~/.<appId>/electron/`
on every OS — exactly as when the package carried Electron. Two instances of one
app with different data homes get two profiles. The app's own data (`state.db`,
logs) stays beside it, in the same home. The store is the user's own (other
users of the machine have their own), so one app can read no other app's files
through it.

**What a user sees.**

- **Electron is already in the store** (another app put it there, or this one
  did before): the app opens as fast as a bundled one. Nothing is shown.
- **It is not**: a window named after the app says _Resolving dependencies_ with
  a progress bar while Electron (~110–130 MB) downloads, is checked against the
  release's `SHASUMS256.txt`, and unpacks; then the app opens. Closing that
  window cancels the start — nothing is installed, and the next start downloads
  again.
- **The download fails** (offline, a proxy): a dialog names the reason and
  offers **Retry** or **Quit** (Windows' own box labels Quit **Cancel**) — and,
  right after an update while the version it replaced is kept in `old/`, **Start
  the previous version**, which rolls the update back and starts that one
  (Windows' box is then Yes / No / Cancel, its text says which is which). A
  start that never got its window does not confirm the update: two such starts
  roll it back ([updates](../deploy/updates.md)). A store that cannot be written
  (a read-only or full disk) says so at once, with the folder's name, before
  anything is downloaded. Started with no desktop (a service, ssh) there is
  nothing to ask on: the reason is logged and the start ends.
- **Two apps start at once** without it: one downloads, the other waits for that
  download instead of making a second one. Closing either window ends that start
  at once.

The window is drawn with what each OS has: Windows Forms (PowerShell) on
Windows, a Cocoa window (`osascript`) on macOS, `zenity` or `yad` on Linux — and
with neither, a page in the default browser. A window that cannot be shown at
all (no interactive desktop, a browser that does not open) is not a cancel: the
download goes on and the log carries the progress. If the app dies while the
window is up, the window closes itself within half a minute. `$AIO_DIALOG=none`
turns it off (log only).

**Updates.** A shared-runtime update downloads only the app. When the new
version pins a different Electron, the updater fetches that Electron into the
store **before** it installs the update, while the running version still works —
so the new version never waits on a download at its first start, and a download
that fails leaves the update not installed. The old Electron stays: the rollback
copy starts from it. The updater asks the new build which Electron it needs
(`--aio-electron-runtime`); a build that cannot answer refuses the update rather
than being guessed at.

Both downloads report into the same `updates.progress` under
`status: "downloading"`, so the bar fills twice; `updates.progressOf` says which
(`"app"`, then `"runtime"`), and `updates.runtimeBytes` gives the Electron
download's size once it has begun, for one bar over both legs
([cell state](../deploy/updates.md#cell-state-reference)).

The **first** update from a build made before 1.0.21 (bundled Electron) to an
online build is applied by the OLD updater, which knows nothing of the shared
runtime: it installs the app alone, and the new version fetches its Electron at
its first start, in the download window — not inside the app's update bar.
Promise nothing else for that one update.

**Cleaning up.** Every start, and every update before its swap, records which
Electron the installed app needs (`<store>/apps/`, one record per app and
Electron version; each app keeps its newest two — the one it runs and the one
before or after it). [`am prune`](../clients/app-manager.md) lists the store
with the cache and removes, with `--yes`, only what no installed app names — an
Electron no app needs anymore, the window of an app that is gone, and the
records of uninstalled apps. Age decides nothing there: an app opened once a
year still opens offline. An Electron an app started from in the last 10
minutes, a window being made right now, and everything while any record cannot
be read (it is named) are kept.

End users have no `am`, so **an online app cleans the store itself**: once its
window has loaded (never delaying the start) and at most once a day per user
(`<store>/.aio-auto-prune`), it removes each Electron that same plan offers
which nothing has started from in **30 days** — never one an installed app's
record names (a record whose install is gone counts as gone), one being
downloaded or installed (its lock is held), or the one the app itself runs from
— and logs one line per Electron removed. 30 days, because a record names the
install's path: an app the user moved and has not opened since names nothing
until its next start, and offline that start could not download Electron again.
Windows of removed apps and stale records are left to `am prune`. A failure is
logged and never stops the app.

**What it costs.**

- The first start needs the internet, once per Electron version per machine. For
  an app that must open offline on a fresh machine, use `"offline"`.
- The process is called `electron` (Linux, Windows) — the window, its title and
  icon are the app's.
- macOS: the window is the app's own bundle inside the store
  (`windows/<bundle id>/`), stamped with the app's name and icon and signed ad
  hoc on that Mac. (A signed `.app` cannot point outside itself, so the window
  cannot run from inside the installed app.) The runtime is signed once in the
  store; each window is an APFS clone of it, re-signing only its own small
  parts, so a window adds almost no disk (measured: two apps' store, 308 MB in
  all).
- Options that change Electron's own files do nothing in a shared build:
  `build.chromiumExtras` strips nothing (the shared copy stays whole for every
  app), and a warning says so.
- Measured on the `todo` example (Electron 44):

  | Package          | Bundled  | Shared  |
  | ---------------- | -------- | ------- |
  | Linux AppImage   | 141.9 MB | 34.9 MB |
  | Windows `.exe`   | 134.6 MB | 26.4 MB |
  | Windows `.zip`   | 173.7 MB | 34.6 MB |
  | macOS `.dmg`     | 169.0 MB | 40.8 MB |
  | macOS `.app.tar` | 152.5 MB | 35.2 MB |

### Splash: `build.splash`

A desktop package can open with a splash: the app's image, drawn by the OS
itself (not by Electron) the moment the app starts, before Electron is looked
for, and gone once the app's window has loaded. An Android APK shows the same
splash natively ([Android](#splash-on-android), below).

```jsonc
"build": {
  "splash": {
    "image": "assets/splash.png", // required: a PNG, at most 1 MB
    "text": "Starting {title}…",  // optional; left out or false = the image alone
    "progress": true,             // optional: a bar while Electron downloads
    "minMs": 1000,                // optional: it stays at least this long (0–10000)
    "font": { "family": "Georgia", "size": 13, "weight": "bold" },
    "color": "#ffffff",           // the text's colour
    "bar": { "style": "solid", "color": "#3b82f6", "track": "#e5e7eb" } // or "thin"
  }
}
```

- **Looks.** The image alone; the image with the text over its lower part; or
  the image, the text and a small bar under it. The window is the image's size,
  centred, without a frame, above other windows, and with no taskbar or Dock
  entry. Name the file `…@2x.png` when it is drawn for a 2× screen: it is shown
  at half its pixels, so it is sharp there.
- **Colours.** Colours you leave out are the app's own (the same hue as its icon
  and theme), in light and dark mode. The colour behind a transparent image is
  the app's page background.
- **Text.** `{title}` is the app's name. `{got}`, `{total}` and `{pct}` are the
  download's MB and percent (`?` while the size is unknown). Any other `{…}` is
  refused at build time.
- **When it closes.** The app's window is made hidden and loads underneath the
  splash. When its page has mounted and the splash has been on screen for
  `minMs`, the splash fades out and the window shows, in the same moment. A
  splash that is not up yet is waited for: it always shows, for `minMs`. The
  splash also closes when Electron exits or never starts, when the app stops,
  and after 30 s with no sign of the window; that last case is logged once. The
  30 s do not count while a download runs. If the splash cannot be drawn, the
  window shows as soon as its page has mounted. Whatever happens, the window
  shows by itself `minMs` + 5 s after it is ready, and the log says so.
- **Online apps.** On a first start (`electronRuntime: "online"`), Electron
  downloads behind the same splash. With `progress: true` the bar shows the
  download, and a ✕ on the splash cancels it. When no download runs, the bar is
  hidden. If the download fails, the splash closes and the usual Retry / Quit
  question is asked.
- **Without `splash`** (or with `false`), nothing changes: there is no splash,
  and a first download shows the plain progress window.
- **Runs from source** (`deno task dev`, `--prod`) show no splash. Only a built
  package does.
- **Electron is never delayed.** Electron starts and loads its page while the
  splash opens; only the window's show waits. The log says when each happened:
  `electron: splash — visible N ms after it was asked for, M ms after the app started`
  and `electron: splash — the main window shows N ms after the splash appeared`.
- **The `web` target** shows it too, as part of the page — see
  [the web splash](#splash-on-the-web).

What each OS draws:

| OS      | Drawn by                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | Windows Forms (PowerShell)      | visible about 650 ms after it is asked for. The text has no shadow. The window takes focus as it opens (Windows Forms cannot cheaply show a window without that). It fades out                                                                                                                                                                                                                                                         |
| macOS   | Cocoa (JXA)                     | visible about 200 ms after it is asked for. The text has a soft shadow. The window never takes focus, has no Dock icon, and fades out                                                                                                                                                                                                                                                                                                  |
| Linux   | `yad`, else `zenity`, else none | `yad`: the image at its pixel size (an `@2x` image is not halved), with the text in the bar under it, in the GTK theme's font and colours. With `progress`, the bar is the download's and stays empty when none runs; without `progress`, it pulses. Without `yad`: a plain `zenity` window with the text only; it cannot stay on top, so the app's window covers it once it opens. Without either: no splash. One log line says which |

#### Splash on Android

An APK built with `build.splash` draws the image, with the text under it (in its
font and colour), centred on the app's background, full screen above the
WebView. It is shown from the activity's first frame. On Android 12+ the system
always shows its own icon splash before that; the APK's theme gives it the same
background colour, as it does the starting window on Android 10 and 11, so there
is no flash. It fades out once the page has loaded, never sooner than `minMs`
after its first frame, and at most 30 s after the start (logged once). "Loaded"
is the desktop's rule: aio's `#root` has content, or a page without one (the
client APK's connect form) has been parsed. A WebView too old for the signal
falls back to the page's `onPageFinished`. There is no download, so `progress`
and `bar` are accepted and draw nothing, and `{got}`/`{total}`/`{pct}` read
`0`/`?`/`?`. The colours left out follow the phone's light/dark mode, or
`android.colorScheme` when it is `"dark"` or `"light"`. Only a cold start shows
it: a rotation or a reload after a lost renderer does not. Logcat (`aio`) says
`splash: shown`, `splash: the page has loaded, N ms after it was shown` and
`splash: gone N ms after it was shown`. Without `build.splash`, the APK is
exactly what it was.

## electron-client (thin client AppImage)

```sh
deno run -A dep/aio/src/build.ts --client
```

Standalone Electron app with a connect page — no Deno runtime, no app code.
Users type a server address and connect. **Linux only** (an AppImage; built on a
Linux host): for Windows or macOS build the `electron` target or `cli-client`
instead. Output: `aio-client-x86_64.AppImage` (~80MB).

## AppImage and TMPDIR

An AppImage unpacks itself into `$TMPDIR` — and the **AppImage runtime reads
that before your app starts**: before `AppRun`, before aio, before any line the
artifact ships. Nothing inside the file can move its own unpack directory.

The default is `/tmp`, which is world-readable, and on the FUSE-less extract
path the directory name is a predictable digest another user on the host can
create first. aio warns about this at boot when it happens.

Only the **launcher** can set it:

```sh
TMPDIR="$HOME/.cache/notes" ./notes.AppImage
```

The menu entry `run.sh` installs already does — its `Exec=` creates a private
per-user directory and sets `TMPDIR` before exec'ing the artifact. If you write
your own `.desktop` file, do the same:

```ini
Exec=sh -c 'D="${XDG_CACHE_HOME:-$HOME/.cache}/notes"; mkdir -p "$D"; chmod 700 "$D"; TMPDIR="$D" exec "/home/u/app/notes/notes.AppImage" "$@"' _ %U
```

Any directory that is not world-writable silences the warning; the app's own
data directory is simply the one it already owns.

## cli (terminal binary)

```sh
deno run -A dep/aio/src/build.ts --compile --cli
```

Headless server + CLI client in a standalone binary. No browser bundle — skips
esbuild entirely. Uses `connectCli()` instead of `useAio()`:

```ts
const app = await aio.run({ cells: [myCell], client: "server-only" });
const cli = connectCli<AppState>(`http://localhost:${app.port}`);
const state = await cli.ready;

cli.subscribe((s) => {
  console.clear();
  console.log(`Counter: ${s.counter}`);
});
```

`connectCli<S>(url, opts?)` returns a `CliApp<S>`:

| Property        | Type                  | Description                                                                                   |
| --------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `state`         | `S \| null`           | Current state (null until connected)                                                          |
| `send(action)`  | `(action) => void`    | Dispatch action to server                                                                     |
| `subscribe(fn)` | `(fn) => unsubscribe` | Listen to state changes (fires immediately if state exists)                                   |
| `close()`       | `() => void`          | Close connection                                                                              |
| `connected`     | `boolean`             | Whether WS is currently open                                                                  |
| `ready`         | `Promise<S>`          | Resolves when first state arrives; rejects if `readyTimeoutMs` passes or `close()` runs first |

| `bind(...cells)` | `(cells) => void` | Bind cell defs — `await cell.method()`
over the socket |

Options:

- `token?: string` — auth token for `--expose` / multi-user servers.
- `ackTimeoutMs?: number` — ceiling for one bound-cell call (0 = wait
  indefinitely). A CLI client has no page shell, so the server's per-method
  budgets can't be bridged to it; raise this for methods that legitimately run
  for minutes.

### What a bound call resolves to

`cli.bind(cell)` makes `await cell.method(args)` dispatch over the socket. The
promise mirrors a local call:

- **resolves** with the method's return value once the server acks it;
- **rejects** with the server's own message if the method threw;
- **rejects** if the connection dropped, was closed, or the ceiling elapsed
  before the server confirmed — the error says so, because an action the server
  never confirmed must never look like a success. `state` is the source of truth
  after such a failure; actions are not resent automatically.

```ts
try {
  const order = await orders.place("sku-1"); // ← the method's return value
} catch (e) {
  // `e` is `unknown` under strict TypeScript — narrow before reading it.
  console.error(`refused: ${e instanceof Error ? e.message : String(e)}`);
}
```

> **Connecting to `--expose` (TLS).** A self-signed server cert is not in any
> trust store, so a CLI client refuses it. Point the process at the cert —
> `DENO_CERT=~/.<appId>/data/tls/tls-cert.pem` — or hand out the cert with
> `am profile`. A browser's click-through has no equivalent here: the connection
> simply fails.

## cli-client (client-only binary)

```sh
deno run -A dep/aio/src/build.ts --compile --cli --remote
```

Compiles `src/client.ts` into a standalone binary with no server — just a WS
client that connects to a remote aio server. Same `connectCli()` API.

```ts
import { connectCli } from "aio/server";
import type { AppState } from "./state.ts";

// No default URL: a server binds a FREE port unless one is named, so a
// hard-coded one connects to nothing — or to another app. The port is on the
// server's boot line and in `am instances`; a remote one is the URL you deploy.
const url = Deno.args[0];
if (!url) {
  console.error("usage: client <ws://host:port/ws>");
  Deno.exit(2);
}
const cli = connectCli<AppState>(url, { readyTimeoutMs: 10_000 });
await cli.ready;
cli.subscribe((s) => console.log("state:", JSON.stringify(s)));
```

## web (standalone PWA)

The standalone app — the same bundle an APK carries: `App.tsx` and the cells it
imports, running in the page, state in page storage, **no Deno and no server** —
as a static directory any HTTPS host serves. On an iPhone, Safari's Share →
**Add to Home Screen** installs it as a full-screen app with its own icon; that
is the iPhone target for an app that needs no server (iOS runs no Deno, so there
is no iOS app target — see `ios-client` for one that connects to a server).

```jsonc
// deno.json
"build": { "targets": ["browser", "web"] }
// or one component per target:
"build": { "targets": { "browser": {}, "web": { "ui": "AppWeb.tsx" } } }
```

`deno task build --targets=web` places `dist/<name>-<version>-web/`:

```
index.html             the shell: title, stylesheet, the Apple Home Screen tags
manifest.webmanifest   name, icons and colours from deno.json (the appId's hue)
app.js  style.css      the standalone bundle (an auto-mounting classic script)
icon.png | icon-192.png icon-512.png   yours, or the generated monogram
splash.png  apple-splash-*.png         with build.splash only — the splash on the web
sw.js                  the offline cache
<assets mounts>        deno.json "assets" — fetch them with a RELATIVE URL
```

- **Offline.** `sw.js` precaches every file of the build under a cache named by
  a hash of all of them, answers from it first, serves the shell for a
  navigation the host has no file for (a reload on a client route, however deep)
  or cannot reach (offline) — loading the build from the deploy root, not from
  the route's directory — and drops older builds' caches when it takes over. A
  new build is a new `sw.js`, which is what makes a browser install it —
  deploying the directory **is** the update. Every script, stylesheet and wasm
  file is checked against its digest as it is cached (pages and images are not:
  a host may rewrite those — an injected snippet, an image optimizer): a CDN
  edge still serving the previous build fails the update, the previous build
  keeps serving whole, and the browser tries again later — never the new version
  holding the old bytes. The page's own files are fetched first, all at once;
  the `assets` mounts' files after them, two at a time — a first visit's page
  (not yet controlled by the worker) keeps most of the bandwidth for its own
  requests. The update is still all or nothing: any file that fails fails it.
  Each build is cached whole: a deploy downloads every file again, the `assets`
  too, and the version in the page (`appVersion()`, which moves with every
  commit) makes each commit's build a new one. A browser that refuses the worker
  (plain `http` off localhost, `file://`) logs
  `[aio] offline cache (service worker) not registered` in the console; the app
  still runs online.
- **Deploy it as it is** — copy the directory to the host, at the origin's root
  or under a sub-path (a GitHub Pages project site at `/repo/`): routes are read
  relative to the directory `app.js` is served from, so `<Route path="/">`
  matches `/repo/` and `<Link to="/about">` is `/repo/about`. `am publish` names
  it and sets it aside: the updater's manifests are for programs.
- **What does not reach it** is what the APK loses too: the `aio.run({...})`
  hooks and server-only options (the plain-data ones are baked in, and the build
  names each one that is not), `*.server.ts` modules (refused), and anything
  that needs a server. An app whose UI needs its server builds the `browser`
  target, or gives `web` its own `ui`.
- **Browser workers travel with it:** each
  `new Worker(new URL("./w.ts",
  import.meta.url))` is bundled into its own
  file beside `app.js` — in the web folder and in an APK's assets alike — and a
  worker file in a deno.json `assets` mount is packaged at its path.
- **What it needs to run:** Safari / iOS / iPadOS **15.4**, Chrome or Android
  System WebView **98**, Firefox **94**, or newer. An older engine cannot parse
  or run the bundle; the page says so instead of staying blank — the web build,
  the APK and a server-served page alike. (The `ios-client` project's deployment
  target is iOS 15.4 for the same reason.)
- **How the iPhone route is tested:** `deno task test:webkit` drives the web
  build and a server-served page in WebKit — the engine of every iOS browser —
  as an iPhone and an iPad: render, taps, state across a reload, the service
  worker, offline with the server gone, a deep route, no horizontal overflow,
  16px form controls, the dark scheme, and a WebSocket that drops and returns
  with a call made meanwhile. It does **not** prove Home Screen (standalone)
  mode, real backgrounding or the safe area: those need an iPhone. The engine is
  Playwright's WebKit, named by `AIO_PLAYWRIGHT_DIR`
  ([environment](environment.md)); without it the lane is skipped.

### Splash on the web

With [`build.splash`](#splash-buildsplash), the web build's page opens on the
splash: the image centred over the app's page background (light or dark, as the
device is), the `text` under it in its `font` and `color`. It is part of the
page's HTML, so it paints with the page's first frame, before any script runs.
The same page serves a plain browser tab and the installed Home Screen app, so
both show it.

- **When it goes.** Once the app has mounted (`#root` has content), and not
  before `minMs` has passed since the page first painted, it fades out (0.2 s;
  none with reduced motion) and is removed. Nothing of it stays to block a tap.
  After 30 s it goes regardless — an app that never mounts shows what it shows
  then.
- **No download runs on the web,** so `progress` and `bar` are accepted and
  ignored, and in `text` `{got}` reads `0` and `{total}` / `{pct}` read `?`.
- **iOS launch images.** iOS shows a Home Screen app's launch image while it
  starts, before the page. The build makes one per iPhone and iPad screen iOS
  15.4 runs on (`apple-splash-<w>x<h>.png`, portrait, each with its exact
  `apple-touch-startup-image` media query): the image at the size and place the
  page draws it, on the light background, so the launch image and the page's
  splash are one picture. They carry no text, and they stay light in dark mode
  (the page's splash then turns dark). The offline cache does not hold them: iOS
  fetches them, not the page. An image the build cannot read (16-bit,
  interlaced) gets no launch images, with a warning.
- **Colours.** The manifest's `background_color` and `theme_color` become the
  app's page background — the splash's — and the dark mode's `theme-color` its
  dark one, so the screen before the page matches the splash. Without `splash`
  they are unchanged.
- **Without `splash`** (or with `false`), the page is byte for byte the one
  without it. Only the web build carries it; a server-served page (`browser`)
  does not.

## Standalone runtime (`initStandalone`)

For Android builds, aio uses a client-side dispatch loop instead of a server:

```ts no-check
// In android builds, the bundler resolves "aio" to the standalone runtime —
// this import only exists inside an android bundle.
import { initStandalone } from "aio";

const app = initStandalone(initialState, {
  reduce,
  execute,
  persist: true, // the durable native store on Android, localStorage elsewhere
  persistKey: "aio_state",
  persistDebounceMs: 100, // ignored by a durable store — see below
  onRestore: (s) => s,
});
```

**Differences from `aio.run()`:** no server, no WebSocket — dispatch loop runs
in the browser. Persistence goes to a key/value store instead of SQLite, and
_which_ store is decided once at boot and printed:

```
[aio] persistence: native file store at /data/user/0/app.aio.notes/files/aio-store
  (fsync + atomic rename on every change — a kill right after a change cannot lose it)
```

Inside an aio APK that is the **native store**
([below](#state-survives-a-kill)). Anywhere else — the same bundle opened in a
desktop browser — it is `localStorage`, and the boot line says so and says it is
lossy. There is one decider (`_pickPersistStore`), so restore and writes can
never disagree about which store this run is using. `app.mode === 'standalone'`.

## android (standalone APK)

```sh
deno run -A dep/aio/src/build.ts --android
```

Standalone Android APK running entirely in a WebView — no server, no Deno
runtime. Dispatch loop, reducer, and effects all run client-side, over a durable
native store ([below](#state-survives-a-kill)). With `build.splash` it opens
with a native splash until the page has loaded (every APK, the client one too) —
see [Android splash](#splash-on-android).

**Prerequisites:** Android SDK (`$ANDROID_HOME`), Java 17+ (`$JAVA_HOME`),
Gradle on `PATH`. On a Windows host the build runs the wrapper it generates as
`gradlew.bat`.

### The APK's version

The APK's `versionName` is **the build version** — `major.minor.<commit
count>`,
`-dirty.<hash8>` included ([Versioning](versioning.md)) — and its `versionCode`,
the integer Play, an MDM and `adb install -r` actually compare, is derived from
it:

```
major·100 000 000 + minor·1 000 000 + build
```

So build order is install order (`1.2.345 < 1.2.346 < 1.3.1`), a dirty build
carries the clean build's code (Android accepts a same-code reinstall), and a
version that cannot be encoded (major > 20, minor > 99, build > 999 999) is
refused rather than wrapped — a truncated `versionCode` is an APK that installs
over a newer one. No `"version"` in deno.json means `0.1.<build>`, and the build
says so.

### Signing a release (APK + AAB)

The default build is a **debug** build: signed with Android's debug key and
debuggable. It installs on your own devices; no store takes it, and the build
says so. `--release` without a key writes `<name>-unsigned.apk`, which Android
refuses to install until you sign it.

A release the build signs for you needs **your** keystore, named by the
environment — aio never creates, stores or prints a release key:

```sh
AIO_ANDROID_KEYSTORE=keys/release.jks \
AIO_ANDROID_KEYSTORE_PASSWORD=… \
AIO_ANDROID_KEY_ALIAS=upload \
deno task build --targets=android --release
```

| Variable                        | Meaning                                                   |
| ------------------------------- | --------------------------------------------------------- |
| `AIO_ANDROID_KEYSTORE`          | the keystore file (relative to the app root, or absolute) |
| `AIO_ANDROID_KEYSTORE_PASSWORD` | its password                                              |
| `AIO_ANDROID_KEY_ALIAS`         | the key inside it                                         |
| `AIO_ANDROID_KEY_PASSWORD`      | the key's own password, when it differs                   |

That build writes two files, both signed with your key and **not debuggable**:
`<name>.apk` (install it, or publish it yourself) and `<name>.aab` — the bundle
a store upload takes. Gradle reads the passwords from the environment; they are
not written into the generated project. A keystore that is named but missing, or
named without its password or alias, stops the build before Gradle starts. Make
a keystore once with
`keytool -genkeypair -keystore keys/release.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`,
keep it out of the repository, and back it up: an app can only ever be updated
by the key that first signed it.

The path and the alias can live in `deno.json` instead, so a release needs only
the password from the environment (a variable that is set wins over the file):

```json
{
  "build": {
    "android": { "keystore": "keys/release.jks", "keyAlias": "upload" }
  }
}
```

A password is never read from `deno.json` — a `build.android` key naming one
(`keyPassword`, `storePassword`, …) stops the build. `"aab": true` there makes
an **unsigned** `--release` write `<name>-unsigned.aab` beside the unsigned APK
(Gradle's `bundleRelease`, which adds to the build time), for a bundle you sign
yourself. A signed release always writes its `.aab`.

### State survives a kill

A standalone APK writes its state through **`AioNativeStore`**, a native
key/value store the shell injects into the page. Every change goes to a file
under the app's own `filesDir`, written **temp file → `fsync` → atomic rename →
`fsync` of the directory** (so the rename itself survives a power cut; a
filesystem that refuses a directory `fsync` is logged once, tag `aio`), and the
write call does not return until that is done. So the change is on the disk
before the method that made it returns: a swipe-away, an OOM kill or a crash in
the same instant cannot lose it, and a crash _during_ the write leaves the
previous value whole rather than a torn one.

This replaces `localStorage`, which a WebView commits to disk on its own
schedule. Measured on an API 35 emulator with `examples/counter`: a `SIGKILL`
**122 ms** after a committed change brought the app back without it — the change
silently gone. (At ~900 ms it survived, which is why it looked fine for so
long.) `tests/android-emulator-e2e.test.ts` now kills the app as fast as `adb`
can deliver it and asserts the change came back.

**The window that remains.** None, for state a method has committed:
`persistDebounceMs` is not used when the store is durable, because a debounce is
exactly the window this fix removes. What is _not_ covered is a change that was
never committed — text typed into an input but not yet sent to a method, or a
change made inside an `async` method that has not reached its next commit. A
kill there loses it, as it would on any target.

The price is one `fsync` of the **whole persisted state** per committed change,
so the cost is paid per keystroke. Measured on a desktop CPU, JS side only (the
`fsync` is on top, and a phone is slower): a 21 KB state costs 0.02 ms per
dispatch, 214 KB costs 0.13 ms, and a 1 MB state costs 0.71 ms — and writes 1 MB
each time. If it grows large enough to be felt, aio says so once rather than
letting the app feel mysteriously heavy:

```
[aio] ⚠ a durable save took 41ms for 1.2 MB — the whole state is written and
  fsync'd on every change, so this cost is paid per keystroke. Fix:
  `persist: "none"` on a cell whose state need not survive a restart, or
  `persist: { exclude: ["big"] }` on the fields that need not — see
  docs/persistence/big-data.md#legitimately-large-state.
```

Those are the same [`persist` filters](../persistence/auto-persist.md) the
server honours, and a standalone build honours them identically — one decider,
`state/cell-persist-filter.ts`. It did not always: this runtime used to write
the whole composed state, so a cell that declared `persist: "none"` was fsync'd
to `filesDir` on every change and restored on the next launch, while
`deno task dev` dropped it.

The bridge is a security surface: `addJavascriptInterface` hands its methods to
**every** page a WebView loads, so it is installed only in a **standalone** APK
— the one shape whose WebView can never show anything but its own bundled assets
(any other URL is handed to an external app). A `--remote` client APK and a
`dev:android` build open a server's pages and never get the bridge at all; their
state lives on the server anyway. If a page from any other origin somehow loads,
the shell removes the bridge and logs it.

**An `<iframe>` gets nothing either.** `addJavascriptInterface` injects the
bridge into every _frame_ too, and the removal above watches the main frame only
— so every store method takes a **per-launch key** first and throws without it.
The key is 32 random bytes made at each launch and handed to the page by a
document-start script whose only allowed origin is the app's own
(`addDocumentStartJavaScript`), so a third-party page the app embeds sees the
object and can neither read nor write through it (logcat:
`native store call
REFUSED`). The files on disk are laid out exactly as before,
so an app upgraded from 1.0.12 keeps its state. A WebView too old for
document-start scripts gets no key: the app then starts from its initial state
and writes nothing over the saved one, saying why, until Android System WebView
is updated. An app whose own `android/` activity still installs the unkeyed
store of 1.0.12 is warned at build time, and its page warns the moment a
third-party frame appears
(`[aio] ⚠ security: this page embeds an <iframe> from …`).

**A restore that fails never costs the saved state.** If the state on disk
cannot be used at boot, the app does not write over it:

- **unreadable** (the native read failed — an IO error, an OOM on a large
  state): the file is left exactly as it is and **nothing is saved for the rest
  of that run**; a restart reads it again. Said at boot and on the first refused
  save (`console.error`, logcat).
- **corrupt** (it reads, but is not valid state): the raw text is copied
  byte-for-byte to `<key>.corrupt-<length>-<hash>` in the same store (named by
  content, so the same blob is never copied twice) and read back before anything
  else is written; the app then starts from its initial state, and the boot line
  names the copy. If the copy cannot be made, it falls back to the refusal
  above.
- **nothing stored** is a first run, and saves normally.

The same rule holds for `localStorage` in a browser preview.

In a desktop browser the same bundle finds no such object and falls back to
`localStorage`, which is all a preview can offer — the boot line names it and
says it is lossy.

### Native fetch

A standalone APK runs every cell inside its WebView, so every `fetch()` carries
`Origin: https://appassets.androidplatform.net` and is subject to CORS. Some
public APIs refuse any request with an Origin (a public JSON-RPC that answers
403), so no page code can reach them. Use `nativeFetch` for those calls:

```ts
import { nativeFetch } from "aio"; // also on "aio/air"

const r = await nativeFetch("https://rpc.example.com", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
});
```

It takes the same arguments as `fetch` and returns a real `Response`.

- **In a standalone APK** the app sends the request (`HttpURLConnection`), not
  the WebView. There is no `Origin`, no `Referer`, no WebView cookie, and no
  CORS check. `Set-Cookie` is not handed back, and nothing is stored.
- **Everywhere else** (server, desktop, Electron, a browser, tests) it is plain
  `fetch`. The server already sends no Origin. A browser page cannot avoid it.
- **Limits:** http and https only, 15 s to connect, 30 s between bytes, and 8
  MiB per body each way. `signal` aborts. `mode`, `credentials` and `cache` have
  no effect. A standalone APK allows no cleartext, so an `http://` URL fails
  natively just as it does in the WebView. Use https.
- **Security:** the bridge (`AioNativeFetch`) is installed only in a standalone
  APK, never in a client or dev APK that opens a server's pages. It is given
  only to the app's own origin (`addWebMessageListener`), so an embedded
  third-party `<iframe>` does not get it. It is removed if a foreign page ever
  loads.
- **Fails loud:** a WebView too old for `addWebMessageListener` (update Android
  System WebView), or an `<app>/android/` activity that dropped the bridge,
  makes `nativeFetch` reject with the reason. It never falls back to a fetch
  that carries an Origin.

`fetch` itself is not patched: it keeps its browser behaviour in every runtime.

### The system bars

The template targets **API 35** (`compileSdk`/`targetSdk` 35 — Play's floor) and
installs on **Android 10** or newer (`minSdk` 29). Android 15 makes every
activity of a targetSdk-35 app **edge-to-edge**: the page would otherwise draw
underneath the status bar and the navigation bar, and measured on API 35 it did
exactly that — the app's own title and the system clock on the same pixels. So
the WebView sits in a frame that carries the system-bar and display-cutout
insets as padding, which gives back the same layout the app had before the bump
on every API level. The emulator test asserts it (`screen.height - innerHeight`
must be at least a status bar).

Full-bleed is a per-app decision, not a default: take it by overlaying your own
`MainActivity` under `<app>/android/`
([below](#adding-native-android-code-the-android-folder)).

### Light and dark

Which of light and dark the page's `prefers-color-scheme` sees is deno.json
`android.colorScheme`:

```json
{ "android": { "colorScheme": "system" } }
```

- `"system"` — the activity follows the phone's light/dark setting, and so does
  the page, as in every browser. `am create` writes it into a new app.
- `"dark"` — **the default when the key is absent**: the page sees "dark"
  whatever the phone says. Every APK up to 1.0.19 was built this way, so an app
  that is only rebuilt looks as it did. `am doctor` names the key for an app
  with an Android target that has not chosen.
- `"light"` — the mirror of `"dark"`.

Any other value is refused by the build. A stylesheet that never mentions
`prefers-color-scheme` looks the same under all three.

Switching the system setting while the app is open restyles the page in place,
without a reload (up to 1.0.19 it recreated the activity and reloaded the app).

### The WebView has to be current

The floor is **Android 10** (`minSdk` 29, since 1.0.20-beta; it was Android 7):
the oldest Android whose WebView still gets updates — Chrome, which the WebView
ships with, left Android 8 and 9 in 2025 — and the first with a system dark
mode. An app built by 1.0.19 or older keeps installing on Android 7–9; one
rebuilt with 1.0.20 does not, and the stores keep serving those phones the last
build that did.

What runs the app is the phone's **Android System WebView**, and the bundle
needs version **98** or newer. A phone updates it from the Play Store by itself;
an image that never has (a bare emulator image) shows one line saying the
WebView is too old, where it used to show a blank page.

### Content: deno.json `assets` travel into the APK

A standalone APK has no server, so nothing serves a mount there. The build
packages each deno.json `assets` mount at the same path under the page instead.
With `{ "assets": { "/text": "./text" } }`, a **relative**
`fetch("text/en/a.md")` reads the mount on the desktop and the packaged copy in
the APK. The APK carries exactly what the production server would serve, asked
of the server's own rules: dotfiles, `*.server.*` (any case), modules that
`import "aio/server-only"` and `.ts`/`.tsx`/`.jsx` source are never packaged. A
symlink is followed only while it stays inside its mount; one that leads out
(`env.txt -> ../.env`) is refused by name, as the server refuses to serve it,
and so is a link that loops back or points at nothing. A mount that contains the
build output (`"/data": "."`) is refused too. A mount at `/`, one named like the
page's own files (`index.html`, the bundle, the stylesheet), or one with a
`.`/`..` segment is refused, and so is a directory outside the project or one
that does not exist. The build prints how many files each mount packaged.

### The Back button

Android Back reaches the page before Android acts on it. The template's
`onBackPressed` calls `window.__aioBack()` through `evaluateJavascript`, which
needs no user gesture, so the first Back after a cold start is asked too. That
global runs the app's
[`onBackButton`](../ui/air-lifecycle.md#android-back-onbackbutton) handlers,
last registered first. When none returns `true`, Android does the default:
WebView history, then (a client APK) the connect form, then leave the app. This
holds for a standalone APK and for one that talks to a server.

### File inputs, downloads, a lost renderer

Three things a browser does by itself and a WebView leaves to its app. The
template does them, for a standalone APK and for one that talks to a server:

- **`<input type="file">`** opens the system's picker (`multiple` and `accept`
  are passed on). It needs no permission: the page gets exactly the files the
  user picked. Backing out answers the page with nothing (its `cancel` event).
- **A download** from the network (`<a download>`, a response sent as an
  attachment) goes to Android's `DownloadManager`: into `Downloads`, with the
  system's notification, carrying the page's cookies. From a server whose
  certificate a client APK **pinned** (the one `--expose` signs itself), which
  `DownloadManager` does not know, the app fetches the file itself — the
  system's trust first, then exactly that pin — into `Downloads`, with a toast.
  A `blob:` or `data:` link — a file the page made, an "export" button — is
  handed over by the page and saved into `Downloads` under its
  `download="name"`, with a toast (up to 32 MB; the page may revoke its object
  URL right after the click). Each outcome is logged (`adb logcat -s aio`:
  `download saved` / `download NOT saved`).
- **The renderer process**: a WebView's page runs in a process of its own, and
  Android takes it back when memory is short. The app stays; the page is loaded
  again and reads its state from the store (a client: from its server). Text
  typed and not yet sent to a method is lost, as on a kill. A second loss within
  10 seconds stops the app instead of reloading in a loop. Both are logged under
  the tag `aio`.

### The camera is opt-in

An APK declares `android.permission.CAMERA` **only when the app asks for it**:

```json
{
  "android": { "camera": true }
}
```

Default is off. Until 1.0.7-beta the permission was in every generated manifest,
so a todo list and a dashboard both told their user — on the install screen, and
on their Play listing — that they could use the camera. Play flags exactly that.

It is a key rather than a silent removal because a page that scans a QR code
with `getUserMedia` needs the permission, and without it Android refuses with a
bare `NotAllowedError` that names nothing. So the same flag reaches the WebView,
which says what is missing in logcat:

```
E aio: camera DENIED: this page asked for the camera, but the APK does not
  declare android.permission.CAMERA. It is opt-in: add "android": { "camera":
  true } to your deno.json and rebuild.
```

`camera: true` also declares **both** `android.hardware.camera` and
`android.hardware.camera.any` as `required="false"`, so the app still installs
on a device without a camera and can explain itself there. Both are needed:
requesting the permission makes Android imply a **required**
`android.hardware.camera`, and declaring only `camera.any` does not suppress it
(`aapt2 dump badging` on a built APK is the check —
`tests/build-android-camera.test.ts` runs it).

A value that is neither `true` nor `false` is refused by name at build time, on
**every** build — not only an `--android` one.

Anything beyond the camera (microphone, location, a foreground service) is a
native concern: overlay your own manifest under `<app>/android/`
([below](#adding-native-android-code-the-android-folder)). The WebView logs and
denies any other permission a page asks it for.

### Onto a real phone

`dev:android` is the _development_ loop — it boots an emulator when nothing is
attached, builds a dev APK pointed at a dev server, and holds that server open
over `adb reverse`. To put a finished build on the phone on your desk:

```sh
deno task install:android                  # newest .apk → the attached phone
deno task install:android --build          # build it first (debug APK)
deno task install:android --build --release   # …a release build instead
deno task install:android --emulator       # a RUNNING emulator, not a phone
deno task install:android --apk=my.apk     # a specific artifact
deno task install:android --device=SERIAL  # when several are attached
deno task install:android --no-launch      # install without starting it
```

Plain `install:android` **installs, it does not build** — and it refuses an APK
that is older than your `src/`, naming the file that changed:

```
[install:android] ✗ app-0.1.8.apk is OLDER than your sources — src/cell.ts changed 4min after it was built.
  Installing it would put the PREVIOUS build on the phone, under the same version number, and report success.
  fix: `deno task install:android --build` (builds, then installs), or `deno task build --targets=android` first.
  To install this exact artifact anyway, name it: `--apk=app-0.1.8.apk`.
```

Without that check the tool printed `✓` and the phone ran the previous build,
with the same version number on screen — so nothing disagreed.

`--build` builds the **debug** APK, the same build as
`deno task build --targets=android`: it is signed with the debug key, so it
installs. A `--release` build with no signing config produces
`<app>-unsigned.apk`, which Android refuses — use it once you have signing set
up.

Enable **Developer options → USB debugging** on the phone and accept the
authorization dialog; `adb devices` should list it as `device`. An attached
**emulator is refused** unless you pass `--emulator` — "install to my phone"
quietly landing on an AVD is an hour nobody gets back — and an `-unsigned.apk`
is refused by name rather than by `adb`'s
`INSTALL_PARSE_FAILED_NO_CERTIFICATES`.

Same `src/` code works on both platforms. Use `app.mode === 'standalone'` to
branch for Deno-only APIs:

```ts
methods: {
  async readFile(s) {
    if (app.mode === 'standalone') return  // skip on Android
    s.content = await Deno.readTextFile('data.json')
  },
},
```

### Adding native Android code (the android/ folder)

The generated APK is a WebView around the JS bundle, which is the whole app for
anything that only needs a screen. It is not the whole app for anything that
needs the **device** — screen capture (`MediaProjection`), input injection (an
`AccessibilityService`), a foreground service, an extra permission. Those apps
are not asking for a different shell; they are asking to add a service to this
one.

So anything under `<app>/android/` is copied over the generated Gradle project
at the same relative path, before placeholder substitution — an overlaid
manifest still gets `{{APPLICATION_ID}}`:

```
myapp/
  android/
    app/src/main/AndroidManifest.xml        # replaces the generated manifest
    app/src/main/java/aio/app/MainActivity.kt
    app/src/main/java/aio/app/CaptureService.kt
    app/src/main/res/xml/accessibility.xml
```

Every overlaid path is printed by the build — a silent overlay is a build that
quietly stopped being the app the template describes.

A file that replaces a template file freezes it at the day it was copied: what
aio later fixes in that file never reaches the APK. So the first build that sees
the overlay records the template's hash in `.aio/android-overlay.json`, and
every later build whose template differs warns (and repeats it in the summary):
`⚠ android/app/src/main/java/aio/app/MainActivity.kt overlays a template that
changed since it was copied (aio 1.0.21-beta → 1.0.22-beta) … fix: re-base it
on aio's android-template/…`.
The warning stops once the overlay itself changes (re-based), or when it is
deleted. The record is per checkout (`.aio/` is the build's own and never part
of the version), so a fresh clone starts recording from its first build.

Overlaid files still go through placeholder substitution, and `dev:android`
rewrites two exact strings in `MainActivity.kt`. So a replacement must keep what
the build reaches for, or that step quietly does nothing:

| If you replace        | Keep                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MainActivity.kt`     | `loadUrl("https://appassets.androidplatform.net/assets/index.html")` — rewritten to the dev server's URL                                                                                                                                                                                                                                                           |
| `MainActivity.kt`     | `return !url.startsWith("https://appassets.androidplatform.net/")` — rewritten so dev navigation stays in the WebView                                                                                                                                                                                                                                              |
| `AndroidManifest.xml` | `{{APPLICATION_ID}}`, `{{APP_NAME}}`, `{{ICON_ATTR}}`, `{{CLEARTEXT_ATTR}}` and `{{CAMERA_PERMISSION}}` — `{{CLEARTEXT_ATTR}}` becomes `android:usesCleartextTraffic="true"` for a dev or `--remote` build and nothing for a standalone one; `{{CAMERA_PERMISSION}}` becomes the CAMERA declaration only with [`android: { camera: true }`](#the-camera-is-opt-in) |
| `MainActivity.kt`     | `{{CAMERA_DECLARED}}` — the same flag, so the WebView's refusal cannot disagree with the manifest                                                                                                                                                                                                                                                                  |
| `MainActivity.kt`     | `{{SPLASH}}` — `null`, or the [splash](#splash-on-android) that `build.splash` bakes in                                                                                                                                                                                                                                                                            |

A replacement `MainActivity.kt` also replaces what the template's activity does,
and the build **warns** when an overlay drops any of these:

- **The durable store** (standalone APK only). Without it the page falls back to
  `localStorage` and a change can be lost on a kill right after it (see
  [State survives a kill](#state-survives-a-kill)). Copy `class AioNativeStore`
  from aio's `android-template/app/src/main/java/aio/app/MainActivity.kt` and
  install it under the exact JS name the page looks for — for a standalone APK
  only, as the template does (`TALKS_TO_SERVER` false), together with the
  document-start script that hands its per-launch key to the app's own origin
  (without it any third-party `<iframe>` can read and overwrite the state — see
  [State survives a kill](#state-survives-a-kill)), and keep the template's
  `onPageStarted` removal of it:

  ```kotlin
  val store = AioNativeStore(File(filesDir, "aio-store"))
  addJavascriptInterface(store, "AioNativeStore")
  WebViewCompat.addDocumentStartJavaScript(this,
      "Object.defineProperty(window, \"__aioNativeStoreKey\", { value: \"" + store.key + "\" });",
      setOf("https://appassets.androidplatform.net"))
  ```

  An activity copied from aio 1.0.12 or earlier installs the unkeyed store; the
  build warns about it. Its files load unchanged in the keyed one.

- **The native fetch bridge** (standalone APK only). Without it
  [`nativeFetch`](#native-fetch) rejects. Copy `object AioNativeFetch` and its
  `WebViewCompat.addWebMessageListener(…, "AioNativeFetch", …)` line from the
  same file, inside the same standalone-only block.

- **The insets frame** (every APK). targetSdk 35 draws edge-to-edge, so a
  WebView set as the content view draws under the status bar. Keep the
  template's `FrameLayout` + `setOnApplyWindowInsetsListener` block from the end
  of its `onCreate` (see [The system bars](#the-system-bars)).

- **Back asks the page** (every APK). Keep the template's `onBackPressed` and
  `defaultBack`. Without them no `onBackButton` handler ever runs (see
  [The Back button](#the-back-button)).

- **The splash** (only with [`build.splash`](#splash-on-android)). The app asked
  for one, so an activity that never shows it is a loss. It is one
  self-contained block — `// ── the splash` to the end of the file — plus the
  lines marked `// splash` in `MainActivity`: copy both. An app that set
  `build.splash` after copying its activity has to re-base it anyway: the
  template changed, and the overlay-hash warning above says so.

A warning scrolls past. To make each of these an **error** — no APK is built
until the overlay carries it — opt in:

```json
{ "build": { "android": { "strict": true } } }
```

Off when absent: a build that warned and produced an APK still does. It reads
the overlay's source, as the warnings do, and changes nothing for an app with no
`android/…/MainActivity.kt` of its own.

Its type is checked by every build, not only an Android one (`"true"` is refused
by name). `am doctor` names the key for an app that has its own
`MainActivity.kt` and has not chosen, and `am fix --harden` writes it.

### The page is a secure origin, so `ws://` is blocked

The WebView serves packaged assets from `https://appassets.androidplatform.net`
rather than `file://`, and that is deliberate: `crypto.subtle` and
`navigator.mediaDevices` only exist in a secure context. The consequence is that
the page is **https**, and a secure page may not open a plaintext socket. An app
that talks to a LAN server over `ws://` or `http://` comes up perfectly, renders
its whole UI, and connects to nothing.

Two ways out, in preference order:

1. **Serve the LAN server over TLS** (`tls` in `deno.json`) and use `wss://` —
   the page and the socket then agree, with no WebView setting involved.
2. **Overlay a `MainActivity.kt`** (above) that opts that WebView back into
   mixed content:

   ```kotlin
   settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
   ```

   This is the whole app's setting, not one socket's — take it knowingly. A
   standalone APK also needs `android:usesCleartextTraffic="true"` on its
   `<application>` (it dials nothing by default, so the build does not add it) —
   put it in the same overlay, on an `AndroidManifest.xml` that keeps the other
   placeholders listed above.

`--android --remote` is unaffected: that APK navigates to the server's own
origin, so there is no mixed content to allow.

## android-client (client APK)

```sh
deno run -A dep/aio/src/build.ts --android --remote
```

Thin client APK — no local state, no reducer, no Deno runtime. Shows a connect
page where the user enters the server URL. The remote server must run with
`--expose`.

A server run with `--expose` asks for its key. Reached by a bare address, the
connect form says so and takes either of two things:

- the **pairing code** the server prints at boot (`pair code: 123456`; `am pair`
  mints a new one — a code works once, for a few minutes), typed beside the
  address; or
- the **share link** the server prints (`share: https://…?token=…`), pasted as
  the address.

The client remembers the result and goes straight in from then on — the shell
writes the address to disk before the server is opened, so a kill right after
pairing does not lose it. A share link typed without a scheme is opened over
`https://`. One that says `http://` and names another machine is opened too,
with a warning on the form: its key crosses the network in clear text.

`"build": { "strictPin": true }` closes that: the form refuses a keyed `http://`
address to another machine (typed, pasted or remembered) and pairing over
`http://` (its answer is the key), and a pairing address typed without a scheme
is tried over `https://` only. Loopback (`adb reverse`) and keyless addresses
are opened as before. A pinned certificate that changed is refused in either
mode — before any request, so no cookie is sent with it.

`--expose` serves a certificate the server **signed itself** unless told
otherwise, and Android trusts no such certificate. Pairing is what makes this
client trust it: the pairing reply carries the server's certificate, and a share
link's key lets the server prove — on the certificate it is presenting — that it
holds that key. Either way the certificate is **pinned** for that address: the
client then accepts exactly it (or one signed by the same aio root, so a server
whose addresses changed still connects) and nothing else. What the form says
when it refuses:

- no code and no link: the device does not trust the certificate;
- a wrong or used code: invalid or expired — nothing is remembered;
- a paired address presenting **another** certificate: not the one this device
  paired with. A server that was reinstalled is paired again; anything else is
  something answering in its place, and it cannot pass — it does not hold the
  key.

Pairing by code trusts the certificate it first sees (the code is the only
secret, as on the desktop client); a share link is verified against its key.
With `--no-tls` the server speaks plain `http://` — Android blocks cleartext by
default from targetSdk 28, so this target's manifest permits it
(`android:usesCleartextTraffic="true"`). A standalone APK does not get it: it
dials nothing.

## Exposed server with browser UI (+ systemd)

```sh
deno run -A dep/aio/src/build.ts --compile --service --remote
```

Standalone binary + systemd unit file with `--expose` (plus `--port=N` when
`build.server` names a port — otherwise the app's own port decides). Browsers on
the network access the full UI.

The build prints these steps with the file names it placed in `dist/`:

```sh
sudo cp dist/aio-counter-1.2.345 /usr/local/bin/aio-counter
sudo cp dist/aio-counter-1.2.345.service /etc/systemd/system/aio-counter.service
sudo systemctl enable --now aio-counter
journalctl -u aio-counter -f  # view logs + auth token
```

## server (headless exposed server)

```sh
deno run -A dep/aio/src/build.ts --compile --service --headless --remote
```

Same as the exposed browser server but headless — no browser auto-open. This is
the fleet's `server` target. **Systemd ExecStart:**
`--expose --client=server-only` (and `--port=N` from `build.server`'s port)

> **Note:** without `--remote`, `--compile --service --headless` generates
> `--client=server-only` and no `--expose` — binds 127.0.0.1 only.
