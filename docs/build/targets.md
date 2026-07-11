# Compile Targets

Build targets follow `compile:<shell>:<topology>` — two axes: **shell** (what
renders the UI) x **topology** (local or remote).

- **Local** (default) — self-contained binary, 127.0.0.1 or client-locked
- **Remote** — exposed server (0.0.0.0 + auth) or client-only binary

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

> **⚠️ Remote targets are experimental.** The five `remote` / thin-client
> targets (`browser:remote`, `service:remote`, `electron:remote`, `cli:remote`,
> `android:remote`) build and run, but are not yet field-validated off-box (a
> deployed server + a client on a separate machine/device). Their behavior may
> change before 1.0. The five **local** targets are the fully-validated, stable
> set.

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

## compile:electron (desktop app)

```sh
deno task compile:electron
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
deno task compile:electron:remote
```

Standalone Electron app with a connect page — no Deno runtime, no app code.
Users type a server address and connect. Linux only. Output:
`aio-client-x86_64.AppImage` (~80MB).

## compile:cli (terminal binary)

```sh
deno task compile:cli
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
deno task compile:cli:remote
```

Compiles `src/client.ts` into a standalone binary with no server — just a WS
client that connects to a remote aio server. Same `connectCli()` API.

```ts
import { connectCli } from "aio";
const url = Deno.args[0] ?? "http://localhost:8000";
const cli = connectCli<AppState>(url);
await cli.ready;
cli.subscribe((s) => console.log("state:", JSON.stringify(s)));
```

## Standalone runtime (`initStandalone`)

For Android builds, aio uses a client-side dispatch loop instead of a server:

```ts
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
in the browser. Persistence via `localStorage` instead of Deno.Kv.
`app.mode === 'standalone'`.

## compile:android (standalone APK)

```sh
deno task compile:android
```

Standalone Android APK running entirely in a WebView — no server, no Deno
runtime. Dispatch loop, reducer, and effects all run client-side with
localStorage.

**Prerequisites:** Android SDK (`$ANDROID_HOME`), Java 17+ (`$JAVA_HOME`),
Gradle on `PATH`.

Same `src/` code works on both platforms. Use `app.mode === 'standalone'` to
branch for Deno-only APIs:

```ts
execute: {
  readFile(app, _payload) {
    if (app.mode === 'standalone') return  // skip on Android
  },
},
```

## compile:android:remote (client APK)

```sh
deno task compile:android:remote
```

Thin client APK — no local state, no reducer, no Deno runtime. Shows a connect
page where the user enters the server URL. The remote server must run with
`--expose`.

## compile:browser:remote (exposed server + systemd)

```sh
deno task compile:browser:remote
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
deno task compile:service:remote
```

Same as `compile:browser:remote` but headless — no browser auto-open. **Systemd
ExecStart:** `--expose --headless --port=3000`

> **Note:** `compile:service` (local) generates `--headless --port=3000` without
> `--expose` — binds 127.0.0.1 only.
