```
 _v_
(o>o)  aio
 )/
/|
```

- **Full-stack Deno framework — one state, propagated everywhere.**
- **Write reactive, use generators or atomic actions when needed.**
- **Pick your target, compile and ship!**

`v1.0.0-alpha8`

> Define state once. It persists, syncs to all clients, drives the UI.

## Three styles — mixable

| Style          | API                            | Best for                                      |
| -------------- | ------------------------------ | --------------------------------------------- |
| **Reactive**   | `feature({ methods })`         | Most features — CRUD, forms, async            |
| **Sequential** | `feature({ generators })`      | Multi-step workflows, wizards, checkout flows |
| **Explicit**   | `feature({ actions, reduce })` | Full control, complex cross-feature logic     |

All three can be mixed in a single feature. Start reactive, add generators or
actions when needed.

## Why aio?

You're building a dashboard, trading tool, control panel, or internal app. You
need state that persists, syncs to every client in real-time, and works offline.
Today that means wiring together a state manager, a database, a WebSocket layer,
a persistence layer, auth, and build tooling — six systems that don't know about
each other.

aio replaces all six. Define state once, it flows everywhere. One codebase
compiles to browser, desktop, CLI, service, or mobile. No glue code, no sync
bugs, no infrastructure decisions.

## Taste

**Prerequisites:**
[Deno 2.6+](https://docs.deno.com/runtime/getting_started/installation/)

```ts
import { aio, feature } from "aio";

const counter = feature("counter", {
  state: { count: 0 },
  methods: {
    increment(s, by = 1) {
      s.count += by;
    },
    reset(s) {
      s.count = 0;
    },
  },
});

await aio.run({ appId: "taste", appVersion: "0.1.0", features: [counter] });
// State persists across restarts. WebSocket sync included. 10 lines.
```

```sh
# Option A: JSR (quick start)
deno add jsr:@riagentic/aio

# Option B: Clone into project (full source access, bleeding edge)
git clone https://github.com/riagentic/aio dep/aio
```

Then in `deno.json`:

```jsonc
// JSR
"imports": { "aio": "jsr:@riagentic/aio" }

// Clone — same user code, full source access for debugging
"imports": { "aio": "./dep/aio/mod.ts" }
```

```sh
deno run -A src/app.ts             # run
```

→ [Quickstart](docs/quickstart.md) for UI setup, Electron, scaffolder, and all
compile targets.

## What's included

|                 |                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **State**       | reactive proxy (Immer) · state machines · generators · selectors · middleware · `call()` coordination · `draft()` · `useLocal` · `page()` routing |
| **Renderer**    | AIR (~8KB) — signals, JSX, auto-memo, SSR/hydration, forms, animation, virtual-list · React adapter · custom adapter API                          |
| **SQLite**      | async Worker (non-blocking) · read replicas · ORM · schema migrations · WAL · transactions · custom pragmas                                       |
| **Persistence** | auto-persist to Deno.Kv · `stateForDB` transform · `persist.exclude` per feature                                                                  |
| **Sync**        | WebSocket · delta patches · offline queue (IndexedDB, 24h TTL) · UDS/IPC · `stateForUI` per-user filtering · periodic resync                      |
| **Security**    | auto-TLS (`--expose`) · multi-user token auth · rate limiting · CSRF protection · `allowedOrigins`                                                |
| **Scheduling**  | cron · intervals · one-shot timers · cancel by ID or prefix                                                                                       |
| **DX**          | time-travel (Ctrl+.) · hot reload · `testFeature` harness · Redux DevTools · perf budgets · freeze detection · AIR DevTools                       |
| **Electron**    | desktop window · UDS+IPC (zero TCP in prod) · window persistence · DevTools toggle · `keepServer`                                                 |
| **Deploy**      | browser · Electron · CLI · systemd service · Android APK (WebView) · single binary · remote (HTTPS)                                               |

[Architecture diagram](docs/core.md#architecture--data-flow) ·
[Full API reference](docs/api.md)

## How aio compares

|                          | **aio** | **Convex** | **Zero** | **ElectricSQL** | **Fresh** | **Next.js** | **Tauri** |
| ------------------------ | :-----: | :--------: | :------: | :-------------: | :-------: | :---------: | :-------: |
| **State & data**         |         |            |          |                 |           |             |           |
| State management         |   ✅    |     ✅     |    ✅    |       🔧        |    🔧     |     🔧      |    🔧     |
| Reactive proxy           |   ✅    |     ❌     |    ❌    |       ❌        |    🔧     |     ❌      |    ❌     |
| State machines           |   ✅    |     ❌     |    ❌    |       ❌        |    ❌     |     ❌      |    ❌     |
| Auto-persistence         |   ✅    |     ✅     |    ✅    |       ✅        |    ❌     |     ❌      |    🔧     |
| Embedded DB (SQLite)     |   ✅    |     ❌     |    ❌    |       ✅        |    ❌     |     ❌      |    🔧     |
| Built-in ORM             |   ✅    |     ✅     |    ✅    |       🔧        |    ❌     |     ❌      |    ❌     |
| Schema migrations        |   ✅    |     ✅     |    🔧    |       ✅        |    ❌     |     🔧      |    ❌     |
| **Sync & networking**    |         |            |          |                 |           |             |           |
| Real-time sync           |   ✅    |     ✅     |    ✅    |       ✅        |    ❌     |     🔧      |    ❌     |
| Offline-first            |   ✅    |     🔧     |    ✅    |       ✅        |    ❌     |     ❌      |    ❌     |
| Delta patches            |   ✅    |     🔧     |    ✅    |       ✅        |    ❌     |     ❌      |    ❌     |
| Built-in server          |   ✅    |     ✅     |    ❌    |       ❌        |    ✅     |     ✅      |    ❌     |
| Auto-TLS                 |   ✅    |     ✅     |    ❌    |       ❌        |    ❌     |     ❌      |    ❌     |
| Multi-user auth          |   ✅    |     ✅     |    ✅    |       🔧        |    🔧     |     🔧      |    ❌     |
| **Architecture**         |         |            |          |                 |           |             |           |
| Generator flows          |   ✅    |     ❌     |    ❌    |       ❌        |    ❌     |     ❌      |    ❌     |
| Feature lifecycle        |   ✅    |     🔧     |    ❌    |       ❌        |    ❌     |     ❌      |    ❌     |
| Cron / scheduled tasks   |   ✅    |     ✅     |    ❌    |       ❌        |    ❌     |     🔧      |    ❌     |
| Middleware               |   ✅    |     ✅     |    ❌    |       ❌        |    ✅     |     ✅      |    ❌     |
| **Developer experience** |         |            |          |                 |           |             |           |
| Time-travel debug        |   ✅    |     ❌     |    ❌    |       ❌        |    ❌     |     🔧      |    ❌     |
| Hot reload               |   ✅    |     ✅     |    ❌    |       ❌        |    ✅     |     ✅      |    🔧     |
| Test harness             |   ✅    |     🔧     |    🔧    |       🔧        |    🔧     |     🔧      |    🔧     |
| Process manager          |   ✅    |     ❌     |    ❌    |       ❌        |    ❌     |     ❌      |    ❌     |
| Zero-config start        |   ✅    |     🔧     |    ❌    |       ❌        |    🔧     |     ❌      |    ❌     |
| **Deployment**           |         |            |          |                 |           |             |           |
| Desktop app              |   ✅    |     🔧     |    🔧    |       🔧        |    ❌     |     🔧      |    ✅     |
| Android APK              |   ✅    |     🔧     |    🔧    |       🔧        |    ❌     |     ❌      |    🔧     |
| CLI client               |   ✅    |     🔧     |    🔧    |       🔧        |    ❌     |     ❌      |    ❌     |
| Single binary            |   ✅    |     ❌     |    ❌    |       ❌        |    ✅     |     ❌      |    ✅     |
| systemd service          |   ✅    |     ❌     |    ❌    |       ❌        |    🔧     |     🔧      |    ❌     |
| Self-hosted              |   ✅    |     🔧     |    ✅    |       ✅        |    ✅     |     ✅      |    ✅     |
| **UI & rendering**       |         |            |          |                 |           |             |           |
| Built-in renderer        |   ✅    |     ❌     |    ❌    |       ❌        |    ⚛️     |     ❌      |    ❌     |
| React adapter            |   ✅    |     ✅     |    ✅    |       ✅        |    ⚛️     |     ✅      |    ✅     |
| Custom adapter API       |   ✅    |     ❌     |    ❌    |       ❌        |    ❌     |     ❌      |    ❌     |
| SSR / hydration          |   ✅    |     ❌     |    ❌    |       ❌        |    ✅     |     ✅      |    ❌     |

✅ built-in · 🔧 manual setup · ⚛️ Preact · ❌ not included _Comparison is
approximate — check each project for current capabilities._

**aio's sweet spot:** apps where state is the product — dashboards, trading
tools, control panels, internal tools, desktop utilities. One state, many
clients, zero plumbing.

### When NOT to use aio

| If you need...                 | Use instead                    |
| ------------------------------ | ------------------------------ |
| SSR / server components        | Fresh, Next.js, Astro          |
| Static sites / content pages   | Astro, Hugo, 11ty              |
| Native mobile UI               | React Native, Flutter          |
| Multi-region distributed state | ElectricSQL, CRDTs             |
| High-traffic public APIs       | Hono, Fastify, bare Deno.serve |
| Complex form-heavy CRUD        | Rails, Django, Laravel         |

See [FAQ](docs/faq.md#when-not-to-use-aio) for details.

## Docs

**Getting Started:** [Quickstart](docs/quickstart.md) · [How-To](docs/howto.md)
· [Migration](docs/migration.md)

**Core:** [Feature Anatomy](docs/syntax.md) · [Reactivity](docs/reactivity.md) ·
[Generators](docs/generators.md) · [Core API](docs/core.md) ·
[API Reference](docs/api.md) · [Features](docs/features.md)

**Data:** [Persistence](docs/persistence.md) · [SQLite](docs/sqldb.md) ·
[Scheduling](docs/scheduling.md)

**Infrastructure:** [Auth](docs/auth.md) · [Builds](docs/builds.md) ·
[Electron](docs/electron.md) · [CLI](docs/cli.md) · [am](docs/am.md) ·
[Linter](docs/linter.md)

**UI & Rendering:** [UI](docs/ui.md) · [Renderer](docs/renderer.md) ·
[Structure](docs/structure.md) · [Scaling](docs/scaling.md) ·
[Testing](docs/testing.md) · [Debugging](docs/debugging.md) · [FAQ](docs/faq.md)
· [Upgrade](docs/upgrade.md) · [Changelog](docs/changelog.md)

## Status

**v1.0.0-alpha8** · [JSR](https://jsr.io/@riagentic/aio) · MIT

1343 tests · security hardened · 58+ bugs fixed in nuclear audit

Core (state, sync, persistence, features, scheduling, renderer) is stable.
Dynamic user auth (`resolveUser`), 58 bug fixes across 23 files, and
protocol/security hardening are new in alpha8. Electron, Android, and build
targets are functional but less battle-tested.
