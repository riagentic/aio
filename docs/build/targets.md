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
- **Android client** — the field is prefilled and the first launch connects
  without a form. Only on a fresh install: once the user has chosen a server,
  including changing it, their choice wins.
- **CLI client** — takes the address as its first argument, which a launching
  script already controls; nothing is baked.

Write it the way you would say it — `192.168.1.50:8000` — the scheme is inferred
when you leave it out, and an explicit `https://` is honoured.

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

|                                        | from any host                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `server` `browser` `cli` `cli-client`  | ✅ — `deno compile` emits the target's binary                                                        |
| `electron` → **Windows, macOS**        | ✅ — the runtime is a published zip we fetch and cache; the package is a directory + launcher + zip  |
| `electron*` → **Linux**                | ❌ needs a Linux host **of that arch** — an AppImage is assembled by `appimagetool`, a native binary |
| `electron-client` → **Windows, macOS** | ❌ by design — the connect-page client is an AppImage, Linux only; build `electron` or `cli-client`  |
| `android*`                             | ❌ by design — the APK is platform-independent, so it is built **once**, on any host                 |
| `ios-client`                           | ❌ by design — the Xcode project is the same on every host; `xcodebuild` (macOS) makes the `.app`    |

So on a Linux x86_64 box, `--targets=electron --all-platforms` gives you the
Linux `.AppImage`, the Windows `.zip` and both macOS `.zip`s, and skips
`linux-arm64` with its reason.

What still needs the target OS is **signing**, not packaging: Apple notarization
(and a `.dmg`), and a Windows Authenticode certificate. The zips we emit are
unsigned on every host, so nothing is lost by building them here — but a
_downloaded_ unsigned app meets Gatekeeper/SmartScreen, which is a distribution
decision, not a build one.

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
  assets: await assetIncludes(Deno.cwd()), // ← .wasm + compile.include + deno.json
  v8Flags: await v8FlagsArg(Deno.cwd()), // ← compile.v8Flags
  excludes: [],
  out: "myapp",
  entry: "src/app.ts",
});
await new Deno.Command("deno", { args }).output();
```

### Memory: `compile.v8Flags`

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

| Platform | Output                                                | Launcher                               |
| -------- | ----------------------------------------------------- | -------------------------------------- |
| Linux    | `<name>-x86_64.AppImage` or `<name>-aarch64.AppImage` | self-contained, double-click           |
| macOS    | `<name>-mac-x64.zip` or `<name>-mac-arm64.zip`        | extract, run `./run.sh`                |
| Windows  | `<name>-win-x64.zip`                                  | extract, run `run.bat` or `<name>.exe` |

Build steps: bundle dist/app.js -> compile deno binary (which embeds it) -> copy
Electron -> generate launcher + icon -> package (AppImage on Linux, zip
elsewhere). The intermediate `dist/app.js` does not survive into the finished
`dist/`.

All launchers set `$ELECTRON_PATH` before starting the Deno binary. State is
persisted to the OS user data directory.

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

| Property        | Type                  | Description                                                 |
| --------------- | --------------------- | ----------------------------------------------------------- |
| `state`         | `S \| null`           | Current state (null until connected)                        |
| `send(action)`  | `(action) => void`    | Dispatch action to server                                   |
| `subscribe(fn)` | `(fn) => unsubscribe` | Listen to state changes (fires immediately if state exists) |
| `close()`       | `() => void`          | Close connection                                            |
| `connected`     | `boolean`             | Whether WS is currently open                                |
| `ready`         | `Promise<S>`          | Resolves when first state arrives                           |

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

const url = Deno.args[0] ?? "http://localhost:8000";
const cli = connectCli<AppState>(url);
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
  persist: true, // uses localStorage
  persistKey: "aio_state",
  persistDebounceMs: 100,
  onRestore: (s) => s,
});
```

**Differences from `aio.run()`:** no server, no WebSocket — dispatch loop runs
in the browser. Persistence via `localStorage` instead of SQLite.
`app.mode === 'standalone'`.

## android (standalone APK)

```sh
deno run -A dep/aio/src/build.ts --android
```

Standalone Android APK running entirely in a WebView — no server, no Deno
runtime. Dispatch loop, reducer, and effects all run client-side with
localStorage.

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

| If you replace        | Keep                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MainActivity.kt`     | `loadUrl("https://appassets.androidplatform.net/assets/index.html")` — rewritten to the dev server's URL                                                                                                |
| `MainActivity.kt`     | `return !url.startsWith("https://appassets.androidplatform.net/")` — rewritten so dev navigation stays in the WebView                                                                                   |
| `AndroidManifest.xml` | `{{APPLICATION_ID}}`, `{{APP_NAME}}`, `{{ICON_ATTR}}` and `{{CLEARTEXT_ATTR}}` — the last becomes `android:usesCleartextTraffic="true"` for a dev or `--remote` build, and nothing for a standalone one |

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

Standalone binary + systemd unit file with `--expose --port=3000`. Browsers on
the network access the full UI.

```sh
sudo cp aio-counter /usr/local/bin/
sudo cp aio-counter.service /etc/systemd/system/
sudo systemctl enable --now aio-counter
journalctl -u aio-counter -f  # view logs + auth token
```

## server (headless exposed server)

```sh
deno run -A dep/aio/src/build.ts --compile --service --headless --remote
```

Same as the exposed browser server but headless — no browser auto-open. This is
the fleet's `server` target. **Systemd ExecStart:**
`--expose --headless --port=3000`

> **Note:** without `--remote`, `--compile --service --headless` generates
> `--headless --port=3000` and no `--expose` — binds 127.0.0.1 only.
