# Building & Compiling

For the docs index, see [manual.md](manual.md). For getting started, see [quickstart.md](quickstart.md).

Build targets follow `compile:<shell>:<topology>` — two axes: **shell** (what renders the UI) × **topology** (local or remote).

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

All 10 targets ship in a single binary. See [changelog.md](changelog.md) for version history.

## Dev mode

```sh
deno task dev
```

Live-transpiles `.ts`/`.tsx` via esbuild on each request. React loaded from CDN via import map. File watcher auto-reloads the browser on save (works even without `useAio`). Error overlay shows **Build Error** (transpile, with file/line/col + caret) or **Runtime Error** (JS crash, with stack trace). Opens Electron or browser.

## compile:browser (standalone binary)

```sh
deno task compile
```

Bundles `src/App.tsx` + React + useAio into a fully self-contained `dist/app.js` (no CDN dependency), then runs `deno compile` to produce a standalone binary (~95MB). Dev-only packages (electron, esbuild, react, react-dom) are excluded from the binary automatically.

The binary name comes from deno.json `"title"` (lowercased, spaces→hyphens). Override with `--name=`:

```sh
./my-app                       # binary name derived from title "My App"
./my-app --port=3000           # custom port
deno run -A jsr:@riagentic/aio@^1.0/src/build --compile --name=custom   # override
deno run -A jsr:@riagentic/aio@^1.0/src/build --compile --force          # skip cache, rebuild from scratch
```

**Build flags:**

| Flag | Effect |
|------|--------|
| `--compile` | Compile standalone Deno binary |
| `--electron` | Build Electron package: AppImage (Linux), zip (macOS/Windows) — implies `--compile` |
| `--client` | Build client-only AppImage — no Deno runtime, Linux only (`compile:electron:remote`) |
| `--cli` | Build CLI binary — no browser bundle, headless server (`compile:cli`) |
| `--cli --remote` | Build client-only CLI binary — no server (`compile:cli:remote`) |
| `--android` | Build APK via Gradle |
| `--android --remote` | Build client-only APK — connect page, no local dispatch (`compile:android:remote`) |
| `--compile --service` | Compile binary + generate systemd unit file |
| `--compile --service --remote` | Same, with `--expose` in systemd ExecStart (`compile:browser:remote`) |
| `--compile --service --headless` | Same, with `--headless` in systemd ExecStart (`compile:service`) |
| `--compile --service --headless --remote` | Same, with `--expose --headless` (`compile:service:remote`) |
| `--name=X` | Override binary name (default: from deno.json `"title"`) |
| `--force` | Skip bundle cache — always rebuild `dist/app.js` |
| `--release` | Android release build (default: debug) |

## compile:electron (desktop app)

```sh
deno task compile:electron
```

Does everything `compile` does, plus packages the binary with Electron. Output varies by platform:

| Platform | Output | Launcher |
|----------|--------|----------|
| Linux | `<name>-x86_64.AppImage` or `<name>-aarch64.AppImage` | self-contained, double-click |
| macOS | `<name>-mac-x64.zip` or `<name>-mac-arm64.zip` | extract, run `./run.sh` |
| Windows | `<name>-win-x64.zip` | extract, run `run.bat` or `<name>.exe` |

Build steps:
1. Bundles `dist/app.js` (self-contained, React included)
2. Compiles deno binary → `dist/AppDir/<name>[.exe]`
3. Copies `node_modules/electron/dist/` → `dist/AppDir/electron/`
4. Generates platform launcher + icon (`src/icon.png` if present, otherwise SVG placeholder)
5. Linux: downloads `appimagetool` (cached in `node_modules/.cache/`), produces AppImage
6. Windows/macOS: zips `dist/AppDir/` into a portable archive

All launchers set `$ELECTRON_PATH` pointing to the bundled Electron before starting the Deno binary. State is persisted to the OS user data directory — not inside the read-only package.

**Prerequisite:**
```sh
deno task install:electron   # required before compile:electron
```

**Cross-platform builds via CI** (`.github/workflows/release.yml`):
```sh
git tag vX.Y.Z && git push origin vX.Y.Z   # triggers build on all 3 platforms
```
Produces AppImage (Linux x64 + arm64), `.zip` (macOS x64 + arm64, Windows x64) as GitHub Release artifacts.

## compile:electron:remote (thin client AppImage)

```sh
deno task compile:electron:remote
```

Builds a standalone Electron app with a connect page — no Deno runtime, no app code bundled. Users type a server address and connect to any running aio server. Linux only.

The output is `aio-client-x86_64.AppImage` (~80MB, Electron only). Supports `--url=` argument for direct connection without the connect page.

## compile:cli (terminal binary)

```sh
deno task compile:cli
```

Compiles a headless server + CLI client into a standalone binary. No browser bundle — skips esbuild entirely, just `deno compile` of `src/app.ts`. Your app uses `connectCli()` instead of `useAio()` to receive state and dispatch actions.

**Entry point** — `src/app.ts`:

```ts
import { aio, connectCli } from 'aio'
import { myFeature } from './features/myFeature/index.ts'
import type { AppState } from './state.ts'

// Start server-only — no browser/electron
const app = await aio.run({ features: [myFeature], client: 'server-only' })

// Connect CLI client to local server
const cli = connectCli<AppState>(`http://localhost:${app.port}`)
const state = await cli.ready

// Reactive — called on every state change
cli.subscribe(s => {
  console.clear()
  console.log(`Counter: ${s.counter}`)
})

// Developer builds whatever they want — REPL, TUI, daemon, etc.
```

`connectCli<S>(url, opts?)` returns a `CliApp<S>`:

| Property | Type | Description |
|----------|------|-------------|
| `state` | `S \| null` | Current state (null until connected) |
| `send(action)` | `(action) => void` | Dispatch action to server |
| `subscribe(fn)` | `(fn) => unsubscribe` | Listen to state changes (fires immediately if state exists) |
| `close()` | `() => void` | Close connection |
| `connected` | `boolean` | Whether WS is currently open |
| `ready` | `Promise<S>` | Resolves when first state arrives |

Options: `{ token?: string }` — auth token for `--expose` / multi-user servers.

## compile:cli:remote (client-only binary)

```sh
deno task compile:cli:remote
```

Compiles `src/client.ts` into a standalone binary with no server — just a WS client that connects to a remote aio server. Same `connectCli()` API.

**Entry point** — `src/client.ts`:

```ts
import { connectCli } from 'aio'
import type { AppState } from './state.ts'
const url = Deno.args[0] ?? 'http://localhost:8000'
const cli = connectCli<AppState>(url)
await cli.ready

cli.subscribe(s => console.log('state:', JSON.stringify(s)))
```

## Standalone runtime (`initStandalone`)

For Android builds, aio uses a client-side dispatch loop instead of a server. The `initStandalone()` function replaces `aio.run()`:

```ts
import { initStandalone } from 'aio'

const app = initStandalone(initialState, {
  reduce,                       // (state, action) → { state, effects: (E | ScheduleEffect)[] }
  execute,
  persist: true,                // default: true — uses localStorage
  persistKey: 'aio_state',      // default: 'aio_state'
  persistDebounceMs: 100,       // ms between localStorage writes (default: 100)
  stateForDB: (s) => s,         // which part of state to persist
  stateForUI: (s) => s,         // which part of state to show in UI
  onRestore: (s) => s,          // transform state after loading from localStorage
})
```

Normally you don't call this directly — the Android build pipeline substitutes `standalone.ts` for `browser.ts` automatically. But it's useful for testing or custom setups.

**Differences from `aio.run()`:**
- No server, no WebSocket — dispatch loop runs in the browser
- Persistence via `localStorage` instead of Deno.Kv
- `app.snapshot`, `app.loadSnapshot`, and `app.db` are `undefined`
- `app.mode === 'standalone'`

## compile:android (standalone APK)

```sh
deno task compile:android
```

Bundles your app into a standalone Android APK that runs entirely in a WebView — no server, no Deno runtime on the device. The dispatch loop, reducer, and effects all run client-side with localStorage for persistence.

**Prerequisites:**
- Android SDK (`$ANDROID_HOME` set)
- Java 17+ (`$JAVA_HOME`)
- Gradle on `PATH`

**How it works:**
1. Bundles `dist/app.js` with `standalone.ts` instead of `browser.ts` — same React hooks, but dispatch loop runs locally
2. Generates a Kotlin WebView shell from `dep/aio/android-template/`
3. Copies `dist/app.js` + generated `index.html` + optional `style.css` into Android assets
4. Copies `src/icon.png` to mipmap resources (if present)
5. Runs `gradle assembleDebug` (or `assembleRelease` with `--release`)
6. Outputs `<name>.apk` in project root

```sh
deno task compile:android                  # debug APK
deno run -A jsr:@riagentic/aio@^1.0/src/build --android --release  # release APK (needs signing config)
```

**Same src/ code for both platforms.** Your `state.ts`, `actions.ts`, `reduce.ts`, `execute.ts`, and `App.tsx` work identically on desktop and Android. The only difference: effects using Deno APIs (file system, network server, etc.) will fail in standalone mode. Use `app.mode === 'standalone'` to branch:

```ts
execute: {
  log(_app, payload) {
    console.log(payload.message)  // works everywhere
  },
  readFile(app, _payload) {
    if (app.mode === 'standalone') return  // skip on Android
    // Deno API — desktop only
  },
},
```

**Android WebView uses Chromium** (same engine as Electron), so your app renders identically on desktop and mobile.

## compile:android:remote (client APK)

```sh
deno task compile:android:remote
```

Builds an Android APK that acts as a thin client — no local state, no reducer, no Deno runtime. The APK shows a connect page where the user enters the server URL. The WebView then navigates to the remote aio server, which serves the full UI.

**How it works:**
1. Skips `esbuild` bundling entirely — no `dist/app.js` needed
2. Generates a connect page HTML with URL input (stored in `localStorage` for reconnection)
3. Packages the connect page into Android assets
4. Builds APK via Gradle — outputs `<name>-client.apk`

Same prerequisites as `compile:android` (Android SDK, Java, Gradle).

The remote server must be running with `--expose` for the APK to connect. Use `compile:browser:remote` or `compile:service:remote` for the server side.

## compile:browser:remote (exposed server + systemd)

```sh
deno task compile:browser:remote
```

Compiles a standalone binary + generates a systemd unit file with `--expose --port=3000`. The binary includes `dist/app.js` so browsers on the network can access the full UI.

**Systemd ExecStart:** `--expose --port=3000` (binds 0.0.0.0, auto-generates auth token)

Install and manage like any systemd service:

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

Same as `compile:browser:remote` but headless — no browser auto-open.

**Systemd ExecStart:** `--expose --headless --port=3000`

Use this when the server only needs to serve API clients (CLI, Android, Electron remote), not browser users directly. The binary still includes `dist/app.js` so browser access works if needed.

> **Note:** `compile:service` (local) generates `--headless --port=3000` without `--expose` — binds 127.0.0.1 only.

## Import rules: server vs browser bundle

aio apps have **two separate bundles** running simultaneously — code must respect the boundary between them.

```
┌─────────┬──────────────────────────────────┬──────────────────────────────────────┐
│         │ Deno binary (server)             │ esbuild bundle (browser/Electron)    │
├─────────┼──────────────────────────────────┼──────────────────────────────────────┤
│ Entry   │ src/app.ts                       │ src/App.tsx (auto-detected)           │
│ Bundler │ deno compile                     │ esbuild                              │
│ Can use │ Deno APIs, @std/*, fs, processes │ Only browser-safe code               │
└─────────┴──────────────────────────────────┴──────────────────────────────────────┘
```

### The rules

**1. Feature `index.ts` must be browser-safe.**

The feature index is imported by both worlds — `app.ts` (server) and UI components like `App.tsx` (browser). It must not contain Deno APIs or `@std/*` imports.

```ts
// features/mdview/index.ts
// ✅ Safe — no Deno APIs, no @std/*
import { feature } from 'aio'
export const mdview = feature('mdview', { ... })
```

**2. Server-only code needs dynamic import with string concatenation.**

esbuild statically analyzes all imports — even dynamic ones. To prevent it from pulling server-only modules into the browser bundle, break the path with a variable:

```ts
// ✅ Correct — esbuild can't resolve this, skips it
const _hp = './helpers'
const loadHelpers = () => import(`${_hp}.ts`)

// ❌ Breaks browser bundle — esbuild pulls in @std/path
import { basename } from '@std/path'

// ❌ Still breaks — esbuild resolves plain dynamic imports too
const loadHelpers = () => import('./helpers.ts')
```

**3. Dynamic-imported files must also be statically imported in `app.ts`.**

`deno compile` only embeds files it can see in the static import graph. Without a static import, the file won't exist in the compiled binary and the dynamic import fails at runtime.

```ts
// app.ts
import './features/mdview/helpers.ts'  // ← embed for deno compile
// The dynamic import in index.ts finds it at runtime
```

**4. `import type` is always safe.**

Type imports are erased at compile time — they cross both worlds freely.

```ts
// ✅ Fine everywhere — erased at compile time
import type { MdviewState } from './helpers.ts'
```

### Quick reference

| What | Rule |
|------|------|
| Feature `index.ts` | Browser-safe only — shared between server and UI |
| Server-only code (`@std/*`, `Deno.*`) | Dynamic import with string concat trick |
| Files loaded via dynamic import | Must also have static import in `app.ts` for `deno compile` |
| `import type` | Always safe — erased at compile time |

### Auto-aliasing npm packages (dev mode)

AIO automatically makes npm packages from `deno.json` available in the browser during dev mode.

**How it works:**
1. Add the package to `deno.json` imports: `"xterm": "npm:xterm@5.3.0"`
2. AIO generates a browser import map that maps `"xterm"` → `https://esm.sh/xterm@5.3.0`
3. Browser imports resolve automatically — no extra configuration

**Prod builds** bundle everything via esbuild — npm packages are resolved from `node_modules/` as usual.

### Browser import validation

AIO checks for common import mistakes at three levels:

1. **Lint time** (`aiol`): Flags `@std/*`, `node:*`, `Deno.*` in feature files and `.tsx` files. Flags bare specifiers not in `deno.json`.
2. **Build time**: esbuild plugin intercepts `@std/*` and `node:*` — returns clear error messages instead of cryptic failures.
3. **Runtime**: Error overlay shows fix suggestions (e.g., "Add X to deno.json imports").

Run `deno run -A aiol/mod.ts` to check for issues before building.

---

## CSS in builds

If `src/style.css` exists, it's automatically:
- **Dev:** served from `src/` and injected as `<link>` in HTML
- **Compile:** copied to `dist/style.css` and included in the binary

## How exclusion works

The build script temporarily removes dev-only symlinks from `node_modules/` and passes `--exclude` flags to `deno compile` for the big directories (electron ~254MB, esbuild ~11MB, react ~5MB). Symlinks are restored after compile, even on failure.
