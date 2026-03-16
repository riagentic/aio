```
  _v_
 (o>o)  aio
  )/
 /|
```

- ✅ **Full-stack Deno framework — one state, propagated everywhere.**
- ✅ **Write reactive, use generators or atomic actions when needed.**
- ✅ **Pick your target, compile and ship!**

`v0.9.0` · beta

> Define state once. It persists, syncs to all clients, drives the UI.

Use the features you need:

| | |
|---|---|
| **State** | reactive proxy (Immer) · state machines · generators · selectors · middleware · `call()` coordination · `draft()` · `useLocal` · `page()` routing |
| **Persistence** | async SQLite (Worker, non-blocking) · auto-persist · read replicas · ORM · schema migrations · WAL · transactions · custom pragmas · `stateForDB` |
| **Sync** | WebSocket · delta patches · offline queue (IndexedDB, 24h TTL) · UDS/IPC · `stateForUI` per-user filtering · connection status indicator |
| **Networking** | HTTP server · auto-TLS · multi-user auth · rate limiting · `allowedOrigins` · health endpoint · snapshot API · `expose` (0.0.0.0) · custom TLS certs |
| **Scheduling** | cron · intervals · one-shot timers · cancel by ID or prefix |
| **Hooks** | `onStart` · `onStop` · `onAction` · `onEffect` · `onConnect` · `onDisconnect` · `onError` · `beforeReduce` · `onPerf` |
| **DX** | time-travel (Ctrl+.) · hot reload · `testFeature` harness · Redux DevTools · perf budgets · freeze detection · `isolate` mode · single-instance lock |
| **Electron** | Electron window · UDS+IPC (zero TCP in prod) · `aio://` protocol · window persistence · DevTools toggle · `keepAlive` · packaged binary |
| **Deploy** | browser · Electron · CLI · systemd service · Android APK (WebView) · single binary · remote (HTTPS) |

## Get started

**Prerequisites:** [Deno 2.6+](https://docs.deno.com/runtime/getting_started/installation/)

**1. Create project**

```sh
mkdir my-app && cd my-app
```

**2. `deno.json`** — create this file in the project root:

```json
{
  "nodeModulesDir": "auto",
  "unstable": ["kv"],
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "jsxImportSourceTypes": "@types/react"
  },
  "imports": {
    "aio":          "jsr:@riagentic/aio@^0.9",
    "react":        "npm:react@^18",
    "react-dom":    "npm:react-dom@^18",
    "@types/react": "npm:@types/react@^18",
    "esbuild":      "npm:esbuild@^0.24",
    "electron":     "npm:electron"
  },
  "tasks": {
    "dev":                    "deno run -A src/app.ts",
    "install:electron":       "deno install --allow-scripts=npm:electron",
    "am":                     "deno run -A jsr:@riagentic/aio@^0.9/src/am",
    "test":                   "deno test -A --unstable-kv tests/",
    "compile:browser":        "deno run -A jsr:@riagentic/aio@^0.9/src/build --compile",
    "compile:browser:remote": "deno run -A jsr:@riagentic/aio@^0.9/src/build --compile --service --remote",
    "compile:electron":       "deno run -A jsr:@riagentic/aio@^0.9/src/build --electron",
    "compile:electron:remote":"deno run -A jsr:@riagentic/aio@^0.9/src/build --client",
    "compile:cli":            "deno run -A jsr:@riagentic/aio@^0.9/src/build --compile --cli",
    "compile:cli:remote":     "deno run -A jsr:@riagentic/aio@^0.9/src/build --compile --cli --remote",
    "compile:service":        "deno run -A jsr:@riagentic/aio@^0.9/src/build --compile --service --headless",
    "compile:service:remote": "deno run -A jsr:@riagentic/aio@^0.9/src/build --compile --service --headless --remote",
    "compile:android":        "deno run -A jsr:@riagentic/aio@^0.9/src/build --android",
    "compile:android:remote": "deno run -A jsr:@riagentic/aio@^0.9/src/build --android --remote"
  }
}
```

**3. Install dependencies**

```sh
deno install                    # browser / CLI / service
deno task install:electron      # Electron — also downloads the ~150MB runtime (one-time)
```

**4. Create source files**

`src/features/counter/index.ts`
```ts
import { feature } from 'aio'

export const counter = feature('counter', {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) { s.count += by },
    decrement(s, by = 1) { s.count -= by },
    reset(s)             { s.count = 0 },
  },
})
```

`src/App.tsx`
```tsx
import { useFeature } from 'aio'
import { counter } from './features/counter/index.ts'

export default function App() {
  const { state, send } = useFeature(counter)
  if (!state) return <div>Loading…</div>
  return (
    <div>
      <button onClick={() => send.decrement()}>−</button>
      <span> {state.count} </span>
      <button onClick={() => send.increment()}>+</button>
      <button onClick={() => send.reset()}>Reset</button>
    </div>
  )
}
```

`src/app.ts`
```ts
import { aio } from 'aio'
import { counter } from './features/counter/index.ts'

await aio.run({ features: [counter] })
```

**5. Run**

| Target | Command | Notes |
|--------|---------|-------|
| **Electron** (default) | `deno task dev` | Desktop window — run `deno task install:electron` first |
| **Browser** | `deno task dev -- --no-electron` | Opens `http://localhost:8000` in default browser |
| **Headless** | `deno task dev -- --headless` | Server only — no window, for CLI/service use |

State persists across restarts. Hot reload on save.

**6. Compile for production**

> `jsr:@riagentic/aio@^0.9/src/build` and `jsr:@riagentic/aio@^0.9/src/am` are part of the JSR package — `src/` is fully published.

| Target | Command | Output |
|--------|---------|--------|
| **Browser local** | `deno task compile:browser` | Standalone binary — serves browser UI |
| **Browser remote** | `deno task compile:browser:remote` | Exposed HTTPS server for remote browser clients |
| **Electron local** | `deno task compile:electron` | AppImage (Linux) with embedded server |
| **Electron remote** | `deno task compile:electron:remote` | Thin client AppImage — connects to remote server |
| **CLI local** | `deno task compile:cli` | Headless binary — no UI, server + state only |
| **CLI remote** | `deno task compile:cli:remote` | CLI client binary — connects to remote server |
| **Service local** | `deno task compile:service` | Headless service binary for systemd / 127.0.0.1 |
| **Service remote** | `deno task compile:service:remote` | Exposed service for 0.0.0.0 + auth |
| **Android** | `deno task compile:android` | APK with embedded server |
| **Android remote** | `deno task compile:android:remote` | APK client — connects to remote server |

For **headless targets** (CLI / Service) you don't need `App.tsx` or React imports. Minimal `src/app.ts`:

```ts
import { aio } from 'aio'
import { counter } from './features/counter/index.ts'

await aio.run({ features: [counter], headless: true })
```

## Example — async method with call()

```typescript
import { feature, call, aio } from 'aio'

const api = feature('api', {
  state: { data: null as string | null, saving: false },
  methods: {
    async save(s, value: string) {
      s.saving = true
      await call({ timeout: 3000 }, () => Deno.writeTextFile('./data.json', value))
      s.data = value
      s.saving = false   // auto-dispatched, persisted, synced to all clients
    },
  },
})

await aio.run({ features: [api] })
```

## Three styles

| Style | API | Best for |
|---|---|---|
| **Reactive** | `feature({ methods })` | Most features — CRUD, forms, async |
| **Sequential** | `feature({ generators })` | Multi-step workflows, wizards, checkout flows |
| **Explicit** | `feature({ actions, reduce })` | Full control, complex cross-feature logic |

Start reactive. Add generators for sequential flows. Switch to explicit only when needed.

## How it compares

| | **aio** | **Convex** | **Zero** | **ElectricSQL** | **Fresh** | **Next.js** | **Tauri** |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **State & data** | | | | | | | |
| State management | ✅ | ✅ | ✅ | 🔧 | 🔧 | 🔧 | 🔧 |
| Reactive proxy | ✅ | ❌ | ❌ | ❌ | 🔧 | ❌ | ❌ |
| State machines | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Auto-persistence | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | 🔧 |
| Embedded DB (SQLite) | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | 🔧 |
| Built-in ORM | ✅ | ✅ | ✅ | 🔧 | ❌ | ❌ | ❌ |
| Schema migrations | ✅ | ✅ | 🔧 | ✅ | ❌ | 🔧 | ❌ |
| **Sync & networking** | | | | | | | |
| Real-time sync | ✅ | ✅ | ✅ | ✅ | ❌ | 🔧 | ❌ |
| Offline-first | ✅ | 🔧 | ✅ | ✅ | ❌ | ❌ | ❌ |
| Delta patches | ✅ | 🔧 | ✅ | ✅ | ❌ | ❌ | ❌ |
| Built-in server | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ |
| Auto-TLS | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Multi-user auth | ✅ | ✅ | ✅ | 🔧 | 🔧 | 🔧 | ❌ |
| **Architecture** | | | | | | | |
| Generator flows | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Feature lifecycle | ✅ | 🔧 | ❌ | ❌ | ❌ | ❌ | ❌ |
| Cron / scheduled tasks | ✅ | ✅ | ❌ | ❌ | ❌ | 🔧 | ❌ |
| Middleware | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ |
| **Developer experience** | | | | | | | |
| Time-travel debug | ✅ | ❌ | ❌ | ❌ | ❌ | 🔧 | ❌ |
| Hot reload | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | 🔧 |
| Test harness | ✅ | 🔧 | 🔧 | 🔧 | 🔧 | 🔧 | 🔧 |
| Process manager | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Zero-config start | ✅ | 🔧 | ❌ | ❌ | 🔧 | ❌ | ❌ |
| **Deployment** | | | | | | | |
| Desktop app | ✅ | 🔧 | 🔧 | 🔧 | ❌ | 🔧 | ✅ |
| Android APK | ✅ | 🔧 | 🔧 | 🔧 | ❌ | ❌ | 🔧 |
| CLI client | ✅ | 🔧 | 🔧 | 🔧 | ❌ | ❌ | ❌ |
| Single binary | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| systemd service | ✅ | ❌ | ❌ | ❌ | 🔧 | 🔧 | ❌ |
| Self-hosted | ✅ | 🔧 | ✅ | ✅ | ✅ | ✅ | ✅ |
| **UI & rendering** | | | | | | | |
| React UI | ✅ | ✅ | ✅ | ✅ | ⚛️ | ✅ | ✅ |
| SSR / SSG | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| One codebase | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🔧 |

✅ built-in · 🔧 manual setup · ⚛️ Preact · ❌ not included
*Comparison is approximate — check each project for current capabilities.*

**aio's sweet spot:** apps where state is the product — dashboards, trading tools, control panels, internal tools, desktop utilities. One state, many clients, zero plumbing.

**Not ideal for:** static sites, content-heavy pages, SEO-first apps (use Fresh/Next), apps that need native UI (use Tauri).

## Docs

[Quickstart](docs/quickstart.md) · [Core API](docs/core.md) · [Reactivity](docs/reactivity.md) · [Generators](docs/generators.md) · [Scheduling](docs/scheduling.md) · [UI](docs/ui.md) · [Testing](docs/testing.md) · [Builds](docs/builds.md) · [Electron](docs/electron.md) · [Auth](docs/auth.md) · [Persistence](docs/persistence.md) · [CLI](docs/cli.md) · [Structure](docs/structure.md) · [Migration](docs/migration.md) · [Upgrade](docs/upgrade.md) · [Changelog](docs/changelog.md)

## Status

**v0.9.0** · beta · [JSR](https://jsr.io/@riagentic/aio) · MIT
