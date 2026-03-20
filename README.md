```
  _v_
 (o>o)  aio
  )/
 /|
```

- **Full-stack Deno framework — one state, propagated everywhere.**
- **Write reactive, use generators or atomic actions when needed.**
- **Pick your target, compile and ship!**

`v1.0.0-alpha1`

> Define state once. It persists, syncs to all clients, drives the UI.

## Three styles — mixable

| Style | API | Best for |
|---|---|---|
| **Reactive** | `feature({ methods })` | Most features — CRUD, forms, async |
| **Sequential** | `feature({ generators })` | Multi-step workflows, wizards, checkout flows |
| **Explicit** | `feature({ actions, reduce })` | Full control, complex cross-feature logic |

All three can be mixed in a single feature. Start reactive, add generators or actions when needed.

## What's included

| | |
|---|---|
| **State** | reactive proxy (Immer) · state machines · generators · selectors · middleware · `call()` coordination · `draft()` · `useLocal` · `page()` routing |
| **SQLite** | async Worker (non-blocking) · read replicas · ORM · schema migrations · WAL · transactions · custom pragmas |
| **Persistence** | auto-persist to Deno.Kv · `stateForDB` transform · `persist.exclude` per feature |
| **Sync** | WebSocket · delta patches · offline queue (IndexedDB, 24h TTL) · UDS/IPC · `stateForUI` per-user filtering |
| **Security** | auto-TLS (`--expose`) · multi-user token auth · rate limiting · CSRF protection · `allowedOrigins` |
| **Scheduling** | cron · intervals · one-shot timers · cancel by ID or prefix |
| **DX** | time-travel (Ctrl+.) · hot reload · `testFeature` harness · Redux DevTools · perf budgets · freeze detection |
| **Electron** | desktop window · UDS+IPC (zero TCP in prod) · window persistence · DevTools toggle · `keepAlive` |
| **Deploy** | browser · Electron · CLI · systemd service · Android APK (WebView) · single binary · remote (HTTPS) |

[Architecture diagram](docs/core.md#architecture--data-flow) · [Full API reference](docs/api.md)

## Quickstart

**Prerequisites:** [Deno 2.6+](https://docs.deno.com/runtime/getting_started/installation/)

### Minimal (headless — no UI)

```ts
// src/app.ts
import { feature, aio } from 'aio'

const counter = feature('counter', {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) { s.count += by },
    reset(s)             { s.count = 0 },
  },
})

await aio.run({ features: [counter], headless: true })
```

```
$ deno run -A src/app.ts
  _v_
 (o>o)  aio — counter
  web   http://localhost:52413
  ws    ws://localhost:52413/ws
```

State persists across restarts. That's it — 10 lines, full persistence + WebSocket sync.

### With UI (Electron or browser)

**1. Create project**

```sh
mkdir my-app && cd my-app
```

**2. `deno.json`**

```json
{
  "appId": "my-app",
  "nodeModulesDir": "auto",
  "unstable": ["kv"],
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "jsxImportSourceTypes": "@types/react"
  },
  "imports": {
    "aio":          "jsr:@riagentic/aio@1.0.0-alpha1",
    "react":        "npm:react@^18",
    "react-dom":    "npm:react-dom@^18",
    "@types/react": "npm:@types/react@^18",
    "esbuild":      "npm:esbuild@^0.24"
  },
  "tasks": {
    "dev":               "deno run -A src/app.ts",
    "test":              "deno test -A --unstable-kv tests/",
    "am":                "deno run -A jsr:@riagentic/aio@1.0.0-alpha1/src/am",
    "install:electron":  "deno add npm:electron && deno install --allow-scripts=npm:electron"
  }
}
```

> Full compile tasks (browser, electron, CLI, service, android — local + remote) in [builds.md](docs/builds.md).

**3. Source files**

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
  if (!state) return <div>Loading...</div>
  return (
    <div>
      <button onClick={() => send.decrement()}>-</button>
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

**4. Run**

```sh
deno install                       # install deps
deno task dev                      # Electron (run install:electron first)
deno task dev -- --no-electron     # browser
deno task dev -- --headless        # server only
```

State persists across restarts. Hot reload on save.

**5. Compile for production**

| Target | Command | Output |
|--------|---------|--------|
| **Browser** | `deno task compile:browser` | Standalone binary — serves browser UI |
| **Electron** | `deno task compile:electron` | AppImage (Linux) with embedded server |
| **CLI** | `deno task compile:cli` | Headless binary — no UI |
| **Service** | `deno task compile:service` | systemd service binary |
| **Android** | `deno task compile:android` | APK with embedded server |

Each target has a `:remote` variant for exposed HTTPS deployments. See [builds.md](docs/builds.md) for the full 10-target matrix.

> `jsr:@riagentic/aio@1.0.0-alpha1/src/build` and `jsr:@riagentic/aio@1.0.0-alpha1/src/am` are part of the JSR package.

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

<details>
<summary><strong>How it compares</strong></summary>

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

</details>

**aio's sweet spot:** apps where state is the product — dashboards, trading tools, control panels, internal tools, desktop utilities. One state, many clients, zero plumbing.

### When NOT to use aio

| If you need... | Use instead |
|----------------|-------------|
| SSR / server components | Fresh, Next.js, Astro |
| Static sites / content pages | Astro, Hugo, 11ty |
| Native mobile UI | React Native, Flutter |
| Multi-region distributed state | ElectricSQL, CRDTs |
| High-traffic public APIs | Hono, Fastify, bare Deno.serve |
| Complex form-heavy CRUD | Rails, Django, Laravel |

See [FAQ](docs/faq.md#when-not-to-use-aio) for details.

## Docs

[Quickstart](docs/quickstart.md) · [Feature Anatomy](docs/syntax.md) · [Core API](docs/core.md) · [Reactivity](docs/reactivity.md) · [Generators](docs/generators.md) · [Scheduling](docs/scheduling.md) · [UI](docs/ui.md) · [Testing](docs/testing.md) · [Linter](docs/linter.md) · [Builds](docs/builds.md) · [Electron](docs/electron.md) · [Auth](docs/auth.md) · [Persistence](docs/persistence.md) · [CLI](docs/cli.md) · [am](docs/am.md) · [Structure](docs/structure.md) · [FAQ](docs/faq.md) · [Migration](docs/migration.md) · [Upgrade](docs/upgrade.md) · [Changelog](docs/changelog.md)

## Status

**v1.0.0-alpha1** · [JSR](https://jsr.io/@riagentic/aio) · MIT

801 tests · audit 8.9/10 · all 10 audit bugs fixed · security hardened

Core (state, sync, persistence, features, scheduling) is stable. Electron, Android, and build targets are functional but less battle-tested.
