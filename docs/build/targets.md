# Compile Targets

Build targets follow `compile:<shell>:<topology>` — two axes: **shell** (what
renders the UI) x **topology** (local or remote).

- **Local** (default) — self-contained binary, 127.0.0.1 or client-locked
- **Remote** — exposed server (0.0.0.0, optional `key` auth) or client-only
  binary

```
                    local (default)              remote
┌────────────┬─────────────────────────┬──────────────────────────┐
│ browser    │ compile:browser         │ compile:browser:remote   │
│            │ binary + system browser │ exposed server + systemd │
├────────────┼─────────────────────────┼──────────────────────────┤
│ electron   │ compile:electron        │ compile:electron:remote  │
│            │ AppImage/zip, server    │ client AppImage (Linux)  │
├────────────┼─────────────────────────┼──────────────────────────┤
│ cli        │ compile:cli             │ compile:cli:remote       │
│            │ binary + WS client API  │ client binary, no server │
├────────────┼─────────────────────────┼──────────────────────────┤
│ android    │ compile:android         │ compile:android:remote   │
│            │ APK, server inside      │ client APK, no Deno      │
├────────────┼─────────────────────────┼──────────────────────────┤
│ service    │ compile:service         │ compile:service:remote   │
│            │ headless, 127.0.0.1     │ headless, 0.0.0.0 + auth │
└────────────┴─────────────────────────┴──────────────────────────┘

Aliases: compile = compile:browser
```

All 10 targets ship in a single binary.

> **Remote targets.** The five `remote` / thin-client targets (`browser:remote`,
> `service:remote`, `electron:remote`, `cli:remote`, `android:remote`) build,
> boot, and are exercised by CI (per-target boot + WS-increment smoke in
> `tests/examples.test.ts`, LAN e2e in `tests/e2e-remote-lan.test.ts`).

## Build a fleet — `deno task build`

The `compile:*` tasks build **one** target at a time. When you ship more than
one — a LAN server plus the clients that connect to it, say — declare the set
once and build it all with a single command:

```jsonc
// deno.json
"build": {
  "targets": ["server", "electron-client", "android-client"],
  "out": "dist",
  "server": "192.168.1.50:8000" // recorded in the manifest (clients connect here)
}
```

```sh
deno task build                 # builds every target in build.targets → dist/
deno task build --targets=server,electron-client   # override the list
deno task build --release       # release builds (e.g. Android assembleRelease)
deno task build --list          # show all target names
```

Every artifact lands in **`dist/`** (flat) alongside a **`dist/manifest.json`**:

```
dist/
  myapp                    server binary
  myapp.service            systemd unit (server, with --expose baked in)
  aio-client-x86_64.AppImage   electron client
  myapp-client.apk         android client
  manifest.json            { app, title, builtAt, server, targets:[…] }
```

On a name collision (e.g. both `browser` and `server`, which each emit the bare
binary) the second is suffixed with its target (`myapp-server`) — nothing is
silently overwritten.

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
  relay        ← compiled from src/relay/app.ts
  myapp-x86_64.AppImage   ← compiled from src/app.ts
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

Both spellings behave identically otherwise — `["server", "electron"]` is the
object form with no overrides, and `--targets=server` still selects a subset
without discarding its declared entry.

> Chaining single-target builds by hand
> (`build.ts --compile && build.ts
> --electron`) does **not** work: each build
> cleans the shared `dist/`, so the first binary is gone by the time the second
> finishes. That is what the orchestrator is for — it moves each target's
> artifacts out to staging before the next build starts.

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
deno task build --platforms=linux,windows,macos,macos-arm64
deno task build --list          # shows every platform, and marks this machine
```

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

**What cross-compiles:** `server`, `browser`, `cli`, `cli-client` — the targets
`deno compile` produces. **What does not:** `electron*` bundles a per-OS
Electron runtime and packages an AppImage/zip, and `android*` drives Gradle (its
APK is already platform-independent — build it once, anywhere). Asking for those
on a foreign platform is **refused with the reason**, never quietly satisfied
with a host binary under a foreign name.

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
| `cli-client`      | client | CLI client binary (connects to a server)      |

> Known limitation (android with bundled assets): the packaged shell HTML is
> written at **build** time, before your `aio.run()` config exists — so
> `ui.head`, a custom `ui.viewport`, and `ui.showStatus` cannot reach the
> android-local shell. It carries the app title, stylesheet, icon, and the
> standard viewport; the other targets (browser, electron) render the full `ui`
> shell config. If your app depends on `ui.head` on android, use
> `android:remote` (the WebView then loads the live server's shell).

Each target maps to the same single-target flags as its `compile:*` task, run as
a subprocess — so `build` is purely additive: the individual `compile:*` tasks
keep working unchanged. A failed target is reported in the summary and marked
`ok: false` in the manifest; the exit code is non-zero if any target failed.

## Dev mode

```sh
deno task dev
```

Live-transpiles `.ts`/`.tsx` via esbuild on each request. React loaded from CDN
via import map. File watcher auto-reloads the browser on save. Error overlay
shows **Build Error** or **Runtime Error**. Opens Electron or browser.

## Build flags

| Flag                                      | Effect                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `--compile`                               | Compile standalone Deno binary                                                        |
| `--electron`                              | Build Electron package: AppImage (Linux), zip (macOS/Windows) — implies `--compile`   |
| `--client`                                | Build client-only AppImage — no Deno runtime, Linux only (`compile:electron:remote`)  |
| `--cli`                                   | Build CLI binary — no browser bundle, headless server (`compile:cli`)                 |
| `--cli --remote`                          | Build client-only CLI binary — no server (`compile:cli:remote`)                       |
| `--android`                               | Build APK via Gradle                                                                  |
| `--android --remote`                      | Build client-only APK — connect page, no local dispatch (`compile:android:remote`)    |
| `--compile --service`                     | Compile binary + generate systemd unit file                                           |
| `--compile --service --remote`            | Same, with `--expose` in systemd ExecStart (`compile:browser:remote`)                 |
| `--compile --service --headless`          | Same, with `--headless` in systemd ExecStart (`compile:service`)                      |
| `--compile --service --headless --remote` | Same, with `--expose --headless` (`compile:service:remote`)                           |
| `--name=X`                                | Override binary name (default: from deno.json `"title"`)                              |
| `--force`                                 | Skip bundle cache — always rebuild `dist/app.js`                                      |
| `--release`                               | Android release build (default: debug) — emits `myapp-unsigned.apk`; sign it yourself |

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

## compile:browser (standalone binary)

```sh
deno task compile
```

Bundles `src/App.tsx` + React + useAio into a fully self-contained `dist/app.js`
(no CDN dependency), then runs `deno compile` to produce a standalone binary
(~95MB). Dev-only packages (electron, esbuild, react, react-dom) are excluded
automatically.

The binary name comes from deno.json `"title"` (lowercased, spaces to hyphens).

```sh
./my-app                       # binary name derived from title "My App"
./my-app --port=3000           # custom port
```

> Scaffolds ship **one** `compile` task — their own target. To build a different
> target, invoke `build.ts` directly with the flags shown below (or add your own
> task).

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
import { assetIncludes, compileArgs, dbWorkerInclude } from "aio/build";

const args = compileArgs({
  hasDist: true, // embed dist/ (the browser bundle)
  workerInclude: dbWorkerInclude(), // ← the SQLite worker
  assets: await assetIncludes(Deno.cwd()), // ← .wasm + compile.include + deno.json
  excludes: [],
  out: "myapp",
  entry: "src/app.ts",
});
await new Deno.Command("deno", { args }).output();
```

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

`aio build` already excludes the dev-only packages (electron, esbuild) for every
target, which is why its binaries are small without either flag.

## compile:electron (desktop app)

```sh
deno run -A dep/aio/src/build.ts --compile --electron
```

Does everything `compile` does, plus packages the binary with Electron:

| Platform | Output                                                | Launcher                               |
| -------- | ----------------------------------------------------- | -------------------------------------- |
| Linux    | `<name>-x86_64.AppImage` or `<name>-aarch64.AppImage` | self-contained, double-click           |
| macOS    | `<name>-mac-x64.zip` or `<name>-mac-arm64.zip`        | extract, run `./run.sh`                |
| Windows  | `<name>-win-x64.zip`                                  | extract, run `run.bat` or `<name>.exe` |

Build steps: bundle dist/app.js -> compile deno binary -> copy Electron ->
generate launcher + icon -> package (AppImage on Linux, zip elsewhere).

All launchers set `$ELECTRON_PATH` before starting the Deno binary. State is
persisted to the OS user data directory.

**Cross-platform builds via CI:**

```sh
git tag vX.Y.Z && git push origin vX.Y.Z   # triggers build on all 3 platforms
```

## compile:electron:remote (thin client AppImage)

```sh
deno run -A dep/aio/src/build.ts --client
```

Standalone Electron app with a connect page — no Deno runtime, no app code.
Users type a server address and connect. Linux only. Output:
`aio-client-x86_64.AppImage` (~80MB).

## compile:cli (terminal binary)

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
  console.error(`refused: ${e.message}`); // ← the server's own reason
}
```

> **Connecting to `--expose` (TLS).** A self-signed server cert is not in any
> trust store, so a CLI client refuses it. Point the process at the cert —
> `DENO_CERT=~/.<appId>/data/tls/tls-cert.pem` — or hand out the cert with
> `am profile`. A browser's click-through has no equivalent here: the connection
> simply fails.

## compile:cli:remote (client-only binary)

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
// this import only exists inside a compile:android bundle.
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

## compile:android (standalone APK)

```sh
deno run -A dep/aio/src/build.ts --android
```

Standalone Android APK running entirely in a WebView — no server, no Deno
runtime. Dispatch loop, reducer, and effects all run client-side with
localStorage.

**Prerequisites:** Android SDK (`$ANDROID_HOME`), Java 17+ (`$JAVA_HOME`),
Gradle on `PATH`.

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

## compile:android:remote (client APK)

```sh
deno run -A dep/aio/src/build.ts --android --remote
```

Thin client APK — no local state, no reducer, no Deno runtime. Shows a connect
page where the user enters the server URL. The remote server must run with
`--expose`.

## compile:browser:remote (exposed server + systemd)

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

## compile:service:remote (headless exposed server)

```sh
deno run -A dep/aio/src/build.ts --compile --service --headless --remote
```

Same as `compile:browser:remote` but headless — no browser auto-open. **Systemd
ExecStart:** `--expose --headless --port=3000`

> **Note:** `compile:service` (local) generates `--headless --port=3000` without
> `--expose` — binds 127.0.0.1 only.
