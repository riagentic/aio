```
  _v_
 (o>o)  aio
  )/
 /|
```

- ✅ **Full-stack Deno framework — one state, propagated everywhere.**
- ✅ **Write reactive, use generators or atomic actions when needed.**
- ✅ **Pick your target, compile and ship!**

`v0.8.3` · beta

> Define state once. It persists, syncs to all clients, drives the UI.

## Get started

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/init.sh)" -- my-app
cd my-app && deno task dev
```

Or: `deno add @riagentic/aio` (library only, no build tooling)

## Example

```typescript
import { feature, call, aio } from 'aio'

// Reactive style — default
const counter = feature('counter', {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) { s.count += by },
    async save(s) {
      await call({ timeout: 3000 }, () => Deno.writeTextFile('./data.json', String(s.count)))
      s.saved = true   // auto-dispatched, persisted, synced to all clients
    },
  },
})

// Sequential workflow — generator with typed state
const checkout = feature('checkout', {
  state: { orderId: null as string | null },
  generators: {
    *place(ctx, item: string) {
      const id = yield* ctx.call('submit', () => submitOrder(item))
      yield* ctx.done(s => { s.orderId = id })  // s is typed — no cast needed
    },
  },
})

await aio.run({ features: [counter, checkout] })
counter.increment(5)       // typed direct call
checkout.place('widget')   // starts generator
```

## Three styles

| Style | API | Best for |
|---|---|---|
| **Reactive** | `feature({ methods })` | Most features — CRUD, forms, async |
| **Sequential** | `feature({ generators })` | Multi-step workflows, retry, cancel |
| **Explicit** | `feature({ actions, reduce })` | Full control, complex cross-feature logic |

All compose together. Start reactive, add generators or explicit reducers per feature when needed.

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

## Platform targets

| | **local** | **remote** |
|---|:---:|:---:|
| **Browser** | standalone binary | exposed server + systemd |
| **Electron** | AppImage | thin client |
| **CLI** | headless + client | client-only binary |
| **Android** | APK with server | client APK |
| **Service** | 127.0.0.1 + systemd | 0.0.0.0 + auth |

## Docs

[Quickstart](docs/quickstart.md) · [Core API](docs/core.md) · [Reactivity](docs/reactivity.md) · [Generators](docs/generators.md) · [UI](docs/ui.md) · [Testing](docs/testing.md) · [Builds](docs/builds.md) · [Electron](docs/electron.md) · [Auth](docs/auth.md) · [Persistence](docs/persistence.md) · [CLI](docs/cli.md) · [Structure](docs/structure.md) · [Migration](docs/migration.md) · [Upgrade](docs/upgrade.md) · [Changelog](docs/changelog.md)

## Status

**v0.8.3** · 774 tests · beta · [JSR](https://jsr.io/@riagentic/aio) · MIT
