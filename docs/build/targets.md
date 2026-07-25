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

| Flag                                      | Effect                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `--compile`                               | Compile standalone Deno binary                                                       |
| `--electron`                              | Build Electron package: AppImage (Linux), zip (macOS/Windows) — implies `--compile`  |
| `--client`                                | Build client-only AppImage — no Deno runtime, Linux only (`compile:electron:remote`) |
| `--cli`                                   | Build CLI binary — no browser bundle, headless server (`compile:cli`)                |
| `--cli --remote`                          | Build client-only CLI binary — no server (`compile:cli:remote`)                      |
| `--android`                               | Build APK via Gradle                                                                 |
| `--android --remote`                      | Build client-only APK — connect page, no local dispatch (`compile:android:remote`)   |
| `--compile --service`                     | Compile binary + generate systemd unit file                                          |
| `--compile --service --remote`            | Same, with `--expose` in systemd ExecStart (`compile:browser:remote`)                |
| `--compile --service --headless`          | Same, with `--headless` in systemd ExecStart (`compile:service`)                     |
| `--compile --service --headless --remote` | Same, with `--expose --headless` (`compile:service:remote`)                          |
| `--name=X`                                | Override binary name (default: from deno.json `"title"`)                             |
| `--force`                                 | Skip bundle cache — always rebuild `dist/app.js`                                     |
| `--release`                               | Android release build (default: debug)                                               |

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

Options: `{ token?: string }` — auth token for `--expose` / multi-user servers.

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
