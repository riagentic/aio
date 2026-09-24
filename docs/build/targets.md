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

- **App / server targets** (`browser`, `electron`, `android`, `cli`, `server`) —
  self-contained artifacts. `server` is the headless role (it was spelled
  `service` before alpha52); it builds the exposed `--remote` binary + systemd
  unit.
- **Client targets** (`electron-client`, `android-client`, `ios-client`,
  `cli-client`) — thin clients that connect to a separately-running aio server.
  iOS has no Deno, so it has ONLY a client target: an Xcode project on any host,
  an `.app` where `xcodebuild` is (macOS).

```
┌──────────────────┬─────────────────────────────────────────────┐
│ browser          │ binary + system browser (127.0.0.1)         │
│ electron         │ desktop AppImage/zip, server inside         │
│ android          │ APK, standalone (no server)                 │
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
- **`name`** — this target's binary/APK name, overriding `title`. Two different
  apps must not share one name; without it they collide and the second is
  suffixed as if it were another build of the first.
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

`name` renames the **binary**, not the app. A compiled binary takes its identity
(its lock, its data directory) from the project's deno.json, which every target
embeds — so give each entry its own:

```ts
// src/agent/app.ts
await aio.run({ appId: "remote-agent" /* … */ });
```

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
> earlier artifacts.
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
artifact its `platform`, `triple`, and whether it is the `host` one.

**What cross-compiles**

|                                        | from any host                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `server` `browser` `cli` `cli-client`  | ✅ — `deno compile` emits the target's binary                                                                                         |
| `electron` → **Windows, macOS**        | ✅ — the runtime is a published zip we fetch and cache; Windows is a directory + launcher + zip, macOS a real `.app` (assembled here) |
| `electron*` → **Linux**                | ❌ needs a Linux host **of that arch** — an AppImage is assembled by `appimagetool`, a native binary                                  |
| `electron-client` → **Windows, macOS** | ❌ by design — the connect-page client is an AppImage, Linux only; build `electron` or `cli-client`                                   |
| `android*`                             | ❌ by design — the APK is platform-independent, so it is built **once**, on any host                                                  |
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

| Platform      | Artifact                                               |
| ------------- | ------------------------------------------------------ |
| macOS (x64)   | `<name>-<version>-mac-x64.dmg` (a `<name>.app` inside) |
| macOS (arm64) | `<name>-<version>-mac-arm64.dmg`                       |

The `.app` is assembled **on any host** (a bundle is a directory tree and
Electron's runtime is a download), with the shape a real macOS app has:

```
Counter.app/Contents/
  Info.plist            identity: CFBundleExecutable, Identifier, Icon
  PkgInfo
  MacOS/
    counter             the Deno server binary IS the bundle executable
    electron/Electron.app/   the runtime (where the launcher looks)
  Resources/AppIcon.icns
```

Three details are load-bearing and were measured on a real macOS 14 guest:

- **The Deno binary is `CFBundleExecutable`.** aio is a two-process app — the
  binary owns the server and spawns Electron as its window. Its identity is the
  app's, so there is one Dock entry and one lifetime.
- **`Contents/MacOS/` holds only the executable.** `codesign` treats that
  directory as code-only; a `dist/` there fails the seal with "code object is
  not signed at all / In subcomponent: …/dist/icon.png". None is needed — the
  compiled binary embeds `dist/` in its Deno VFS and serves it to Electron over
  the app's own socket.
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
| `--compile --service`                     | Compile binary + generate systemd unit file                                                                                                          |
| `--compile --service --remote`            | Same, with `--expose` in systemd ExecStart                                                                                                           |
| `--compile --service --headless`          | Same, with `--headless` in systemd ExecStart                                                                                                         |
| `--compile --service --headless --remote` | Same, with `--expose --headless` (target `server`)                                                                                                   |
| `--name=X`                                | Override binary name (default: from deno.json `"title"`)                                                                                             |
| `--force`                                 | Skip bundle cache — always rebuild `dist/app.js`                                                                                                     |
| `--analyze`                               | Print where the bundle's bytes went (per dependency, per framework area) — same artifact, one extra report                                           |
| `--release`                               | Android release build (default: debug) — emits `myapp-unsigned.apk`; sign it yourself                                                                |
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

| Setting                      | Names                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `deno.json` `"title"`        | the **binary/APK name** (slugified), and the window title if nothing else sets one |
| `aio.run({ ui: { title } })` | the **window / browser tab title** only — never the binary                         |
| `--name=X` (build)           | the binary name for this build, overriding `deno.json` `"title"`                   |
| `--title=X` (runtime)        | the window title for this run, overriding `ui.title`                               |

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

`deno task build` already excludes the dev-only packages (electron, esbuild) for
every target, which is why its binaries are small without either flag.

## electron (desktop app)

```sh
deno run -A dep/aio/src/build.ts --compile --electron
```

Does everything `compile` does, plus packages the binary with Electron:

| Platform | Output                                                     | How it opens                           |
| -------- | ---------------------------------------------------------- | -------------------------------------- |
| Linux    | `<name>-x86_64.AppImage` or `<name>-aarch64.AppImage`      | self-contained, double-click           |
| macOS    | `<name>-mac-x64.dmg` / `…-mac-arm64.dmg` (a `.app` inside) | drag to Applications, double-click     |
| Windows  | `<name>-win-x64.zip`                                       | extract, run `run.bat` or `<name>.exe` |

Build steps: bundle dist/app.js -> compile deno binary (which embeds it) -> copy
Electron -> generate launcher + icon -> package (AppImage on Linux, a signed
`.app` + `.dmg` on macOS — see below, a zip on Windows). The intermediate
`dist/app.js` does not survive into the finished `dist/`.

On Linux and Windows the launcher sets `$ELECTRON_PATH` before starting the Deno
binary; on macOS the `.app` bundles the runtime where the binary looks for it
directly, so there is no launcher to run by hand. State is persisted to the OS
user data directory.

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
Gradle on `PATH`.

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

**An `<iframe>` is the exception.** `addJavascriptInterface` injects the bridge
into every _frame_ too, and the removal above watches the main frame only — so a
third-party page an app embeds in an `<iframe>` can call `AioNativeStore` and
read or overwrite the app's saved state. Embed only content you trust, or open
it outside the app with a plain link. The page says so the moment such a frame
appears (`[aio] ⚠ security: this page embeds an <iframe> from …`, once per
origin); closing it natively is on the roadmap.

**A restore that fails never costs the saved state.** If the state on disk
cannot be used at boot, the app does not write over it:

- **unreadable** (the native read failed — an IO error, an OOM on a large
  state): the file is left exactly as it is and **nothing is saved for the rest
  of that run**; a restart reads it again. Said at boot and on the first refused
  save (`console.error`, logcat).
- **corrupt** (it reads, but is not valid state): the raw text is copied
  byte-for-byte to `<key>.corrupt-<ms>` in the same store and read back before
  anything else is written; the app then starts from its initial state, and the
  boot line names the copy. If the copy cannot be made, it falls back to the
  refusal above.
- **nothing stored** is a first run, and saves normally.

The same rule holds for `localStorage` in a browser preview.

In a desktop browser the same bundle finds no such object and falls back to
`localStorage`, which is all a preview can offer — the boot line names it and
says it is lossy.

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

A replacement `MainActivity.kt` also replaces two things the template's activity
does in `onCreate`, and the build **warns** when an overlay drops either:

- **The durable store** (standalone APK only). Without it the page falls back to
  `localStorage` and a change can be lost on a kill right after it (see
  [State survives a kill](#state-survives-a-kill)). Copy `class AioNativeStore`
  from aio's `android-template/app/src/main/java/aio/app/MainActivity.kt` and
  install it under the exact JS name the page looks for — for a standalone APK
  only, as the template does (`TALKS_TO_SERVER` false), and keep the template's
  `onPageStarted` removal of it:

  ```kotlin
  addJavascriptInterface(AioNativeStore(File(filesDir, "aio-store")), "AioNativeStore")
  ```

- **The insets frame** (every APK). targetSdk 35 draws edge-to-edge, so a
  WebView set as the content view draws under the status bar. Keep the
  template's `FrameLayout` + `setOnApplyWindowInsetsListener` block from the end
  of its `onCreate` (see [The system bars](#the-system-bars)).

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
