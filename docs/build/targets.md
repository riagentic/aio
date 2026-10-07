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
│ electron         │ desktop AppImage/zip, server inside         │
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
  macOS bundle id `app.aio.<slug>`, the systemd `Description=`), overriding
  `title`. Two different apps must not share one name; without it they collide
  and the second is suffixed as if it were another build of the first.
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

`name` renames the **artifact** (files, display name, macOS bundle id), not the
running app. A compiled binary takes its RUNTIME identity (its lock, its data
directory) and its window title from the project's deno.json, which every target
embeds — so give each entry its own:

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
> named, instead of emptied.
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
(`myapp.service`, `myapp-linux-arm64.service`).

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
notarization, and a Windows Authenticode certificate. The artifacts we emit are
ad-hoc signed (macOS) or unsigned (Windows) on every host — a _downloaded_
unsigned app meets Gatekeeper/SmartScreen, which is a distribution decision, not
a build one.

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
them, and they are the same files the Linux/Windows packages carry), and the
whole bundle is signed inside-out (ad-hoc) so macOS will actually launch the
nested runtime — an unsealed one is killed with exit status 1 and no message.

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

**What your users see on first open.** The bundle is signed ad-hoc, not with an
Apple Developer ID, and it is not notarized. So a `.dmg` downloaded through a
browser carries macOS's quarantine mark, and Gatekeeper holds the first launch
with a warning that Apple cannot check the app. Measured on macOS 14: the
process is held before any app code runs, and nothing opens until the user
approves it. The way through:

- **macOS 14 and earlier** — Control-click the app → **Open** → **Open**.
- **macOS 15 and later** — try to open it once, then **System Settings → Privacy
  & Security → Open Anyway**.
- **From a terminal** —
  `xattr -dr com.apple.quarantine "/Applications/<name>.app"`.

Only a Developer ID signature plus notarization removes the warning. That needs
an Apple Developer account, which is a distribution decision, not a build step.
A copy that never carried the mark (built locally, or copied with `scp`) opens
directly.

**Opened without being dragged to Applications.** A user who double-clicks the
app inside the mounted `.dmg`, or in Downloads, gets an app that works and can
never update: it runs from a read-only image, or from the temporary read-only
copy macOS makes of a quarantined app (App Translocation). So a desktop app that
finds itself outside `/Applications` and `~/Applications` asks once, after its
window is up: **Move _App_ to your Applications folder?** — **Move to
Applications** / **Not Now**.

- **Move** copies the bundle into `/Applications` (`~/Applications` when that
  folder cannot be written), clears the quarantine mark from that copy, closes
  the app the ordinary way and opens the copy. The copy it was opened from is
  left where it is.
- **Not Now** is remembered in the app's data directory (`macos-move-declined`);
  delete that file to be asked again. A dialog nobody answers is not an answer.
- **No question at all** when an app of the same name is already in Applications
  (nothing is replaced), for a server-only or browser client, and when running
  from source.
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

| Name              | Role   | Produces                                      |
| ----------------- | ------ | --------------------------------------------- |
| `server`          | server | headless binary + systemd unit (`--expose`)   |
| `browser`         | app    | self-contained binary serving the browser app |
| `electron`        | app    | Electron desktop app (AppImage / zip)         |
| `android`         | app    | Android APK (bundled assets)                  |
| `web`             | app    | static PWA directory (no server, offline)     |
| `cli`             | app    | headless CLI binary                           |
| `electron-client` | client | standalone Electron connect-page AppImage     |
| `android-client`  | client | Android client APK (connects to a server)     |
| `ios-client`      | client | iOS client Xcode project; `.app` on macOS     |
| `cli-client`      | client | CLI client binary (connects to a server)      |

> Known limitation (android with bundled assets): the packaged shell HTML is
> written at **build** time, before your `aio.run()` config exists — so
> `ui.head`, a custom `ui.viewport`, and `ui.showStatus` cannot reach the
> android-local shell. It carries the app title, stylesheet, icon, the standard
> viewport, and — applied by the runtime at boot, because they travel with the
> bundle rather than the HTML — `ui.theme` and `ui.lang`. The build prints this
> list, so a dropped key is never a surprise. The other targets (browser,
> electron) render the full `ui` shell config. If your app depends on `ui.head`
> on android, use `android-client` (the WebView then loads the live server's
> shell).

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
| `--electron`                              | Build Electron package: AppImage (Linux), zip (macOS/Windows) — implies `--compile`                                                                  |
| `--client`                                | Build client-only AppImage — no Deno runtime, Linux only (target `electron-client`)                                                                  |
| `--cli`                                   | Build CLI binary — no browser bundle, headless server (target `cli`)                                                                                 |
| `--cli --remote`                          | Build client-only CLI binary — no server (target `cli-client`)                                                                                       |
| `--android`                               | Build APK via Gradle                                                                                                                                 |
| `--ios`                                   | Write the `ios-client` Xcode project (with `--remote`); `.app` on macOS                                                                              |
| `--android --remote`                      | Build client-only APK — connect page, no local dispatch (target `android-client`)                                                                    |
| `--web`                                   | Write the standalone web app / PWA directory `<bin>-web/` (target `web`)                                                                             |
| `--compile --service`                     | Compile binary + generate systemd unit file                                                                                                          |
| `--compile --service --remote`            | Same, with `--expose` in systemd ExecStart                                                                                                           |
| `--compile --service --headless`          | Same, with `--headless` in systemd ExecStart                                                                                                         |
| `--compile --service --headless --remote` | Same, with `--expose --headless` (target `server`)                                                                                                   |
| `--name=X`                                | Override binary name (default: from deno.json `"title"`)                                                                                             |
| `--force`                                 | Skip bundle cache — always rebuild `dist/app.js`                                                                                                     |
| `--analyze`                               | Print where the bundle's bytes went (per dependency, per framework area) — same artifact, one extra report                                           |
| `--smoke` / `--smoke=strict`              | After building, start each artifact and fail the build when it does not come up clean — see [Start what you built](#start-what-you-built---smoke)    |
| `--release`                               | Android release build (default: debug) — emits `myapp-unsigned.apk`; sign it yourself                                                                |
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
`"build": { "smoke": true }` (or `"strict"`); the flag wins.

| Target                      | What is checked                                                                                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser`, `server-app`     | answers `/__aio/health`; `/`, the bundle, the stylesheet and icon the page names, and every asset URL the bundle names all answer 200                                                                                       |
| `server`                    | answers `/__aio/health` (it is headless — no page)                                                                                                                                                                          |
| `cli`                       | `--help` exits 0                                                                                                                                                                                                            |
| `electron` (Linux AppImage) | the window opens and its page finishes loading; every file the page names answers 200; every `build.guestPreloads` file is one the packaged shell says it can attach                                                        |
| all of the above            | nothing at ERROR level, no uncaught error and no `REFUSED` line in its console output or `logs/app.log`; it stops when asked (the request `am stop` sends; a desktop app by closing its window); no process is left running |

Everything else is listed with its reason and never skipped in silence: an
artifact built for another OS or architecture
(`not smoke-tested here: built
for windows-x64`), a client that needs its
server, an APK, a web directory, a desktop package on a Windows or macOS build
host. `--smoke=strict` turns a "not smoke-tested" row into a failure — use it on
the machine whose job is to prove the release.

The desktop window opens on a nested X display (Xephyr, the one `am start` uses
for agents), never on your desktop. With no Xephyr installed the row reads
`not smoke-tested: no display` and names the package to install.

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

### `<webview>` guest preloads: `build.guestPreloads`

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
Electron -> generate launcher + icon -> package (AppImage on Linux, a signed
`.app` + `.dmg` on macOS — see below, a zip on Windows). On Windows the
one-click `<name>-win-x64.exe` is then built as a **thin SFX**: the staged
package is packed into a **zstd-compressed tar** and appended to a small stub
(~0.7 MB), so the download is smaller than the zip (zstd beats deflate by ~15%
and decompresses faster), and it is not a second `deno compile` with
`electron-runtime.zip` inside the PE. First double-click extracts to
`%LOCALAPPDATA%\aio-sfx\<name>\win-<arch>\`; later launches skip extract when
the payload stamp matches. The `.zip` stays a plain zip (Windows Explorer can
open it).

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
- **It installed the app**: it adds a Start-menu shortcut named after the app
  (`title`), pointing at the installed `<name>.exe` — so the download can be
  deleted. Opening the `.exe` again without installing anything does not put
  back a shortcut the user removed. An install made by an older `.exe` (aio
  1.0.17-beta or older, which added none) gets the same shortcut from the app
  itself, once, at its first start on a version that has this — so an app that
  updated itself needs no new download — and the log says the old `.exe` can be
  deleted. What was decided is kept beside the install
  (`…\aio-sfx\<name>\win-x64.shortcut`), so a shortcut removed after that is not
  put back by a later start or update. (One exception: an install made by a
  1.0.18-beta `.exe` whose shortcut was removed gets it back once.)
  `"build": { "windows": { "shortcut": false } }` in `deno.json` builds an
  `.exe` that adds none, and an app that adds none either. Nothing removes the
  shortcut when the app's folder is deleted by hand: aio has no uninstaller.

**Signing the `.exe` (Authenticode).** Sign the finished `<name>-win-x64.exe`
with your own tool —
`signtool sign /fd SHA256 /tr <timestamp-url> /td SHA256
<name>-win-x64.exe`, or
`osslsigncode` on Linux — after the build and **before** `deno task ship`, whose
manifest hashes the file as it will be downloaded. A signature appends a
certificate table after the SFX trailer; the stub finds its payload through the
PE security directory, so a signed `.exe` runs like an unsigned one. The
signature covers the whole download, payload included; the `<name>.exe` and
Electron that it extracts are not signed individually. aio does not sign for
you.

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
(`format: "zip"`) — larger, still one-click. A symlink in the staged package
ships as a copy of its target (the build says so, with the size); one that
points outside the package, at nothing, or at a folder it is inside stops the
build, naming the path. `AIO_WINDOWS_FAT_EXE=1` restores the legacy
`deno compile` PE instead, and the build falls back to it by itself, with a
warning, when the stub cannot be read, fetched or verified. The intermediate
`dist/app.js` does not survive into the finished `dist/`.

On Linux and Windows the launcher sets `$ELECTRON_PATH` before starting the Deno
binary; on macOS the `.app` bundles the runtime where the binary looks for it
directly, so there is no launcher to run by hand. State is persisted to the OS
user data directory.

**Fuses.** The Electron inside every desktop package (and the tree a Windows SFX
extracts on first launch) has three of Electron's fuses turned off, so it cannot
be started around your app:

- as plain Node (`ELECTRON_RUN_AS_NODE`),
- with code injected through `NODE_OPTIONS`,
- with a debugger on the main process (`--inspect`).

The build says `Electron fuses off: …`, and fails if the runtime has no fuse
wire, so a package never ships without them. Dev (`node_modules/electron`) is
not changed; aio already refuses those three when it starts Electron itself.

**Cross-platform builds via CI:**

```sh
git tag vX.Y.Z && git push origin vX.Y.Z   # triggers build on all 3 platforms
```

## electron-client (thin client AppImage)

```sh
deno run -A dep/aio/src/build.ts --client
```

Standalone Electron app with a connect page — no Deno runtime, no app code.
Users type a server address and connect. Linux only. Output:
`aio-client-x86_64.AppImage` (~80MB).

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
  holding the old bytes. A browser that refuses the worker (plain `http` off
  localhost, `file://`) logs
  `[aio] offline cache (service worker) not registered` in the console; the app
  still runs online.
- **Deploy it as it is** — copy the directory to the host, at the origin's root
  or under a sub-path (a GitHub Pages project site at `/repo/`): routes are read
  relative to the directory `app.js` is served from, so `<Route path="/">`
  matches `/repo/` and `<Link to="/about">` is `/repo/about`. `am publish` names
  it and sets it aside: the updater's manifests are for programs.
- **What does not reach it** is what the APK loses too: `aio.run({...})` options
  (the build names each one the app sets), `*.server.ts` modules (refused), and
  anything that needs a server. An app whose UI needs its server builds the
  `browser` target, or gives `web` its own `ui`.

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
native store ([below](#state-survives-a-kill)).

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

The template targets **API 35** (`compileSdk`/`targetSdk` 35, `minSdk` 24) —
Play's floor. Android 15 makes every activity of a targetSdk-35 app
**edge-to-edge**: the page would otherwise draw underneath the status bar and
the navigation bar, and measured on API 35 it did exactly that — the app's own
title and the system clock on the same pixels. So the WebView sits in a frame
that carries the system-bar and display-cutout insets as padding, which gives
back the same layout the app had before the bump on every API level. The
emulator test asserts it (`screen.height - innerHeight` must be at least a
status bar).

Full-bleed is a per-app decision, not a default: take it by overlaying your own
`MainActivity` under `<app>/android/`
([below](#adding-native-android-code-android)).

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
([below](#adding-native-android-code-android)). The WebView logs and denies any
other permission a page asks it for.

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

### Adding native Android code (`<app>/android/`)

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

Overlaid files still go through placeholder substitution, and `dev:android`
rewrites two exact strings in `MainActivity.kt`. So a replacement must keep what
the build reaches for, or that step quietly does nothing:

| If you replace        | Keep                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MainActivity.kt`     | `loadUrl("https://appassets.androidplatform.net/assets/index.html")` — rewritten to the dev server's URL                                                                                                                                                                                                                                                           |
| `MainActivity.kt`     | `return !url.startsWith("https://appassets.androidplatform.net/")` — rewritten so dev navigation stays in the WebView                                                                                                                                                                                                                                              |
| `AndroidManifest.xml` | `{{APPLICATION_ID}}`, `{{APP_NAME}}`, `{{ICON_ATTR}}`, `{{CLEARTEXT_ATTR}}` and `{{CAMERA_PERMISSION}}` — `{{CLEARTEXT_ATTR}}` becomes `android:usesCleartextTraffic="true"` for a dev or `--remote` build and nothing for a standalone one; `{{CAMERA_PERMISSION}}` becomes the CAMERA declaration only with [`android: { camera: true }`](#the-camera-is-opt-in) |
| `MainActivity.kt`     | `{{CAMERA_DECLARED}}` — the same flag, so the WebView's refusal cannot disagree with the manifest                                                                                                                                                                                                                                                                  |

A replacement `MainActivity.kt` also replaces four things the template's
activity does, and the build **warns** when an overlay drops any of them:

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

That server serves plain `http://` unless you set `tls`, and Android blocks
cleartext by default from targetSdk 28 — so this target's manifest permits it
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
