```
 _v_
(o>o)  aio
 )/
/|
```

- **Full-stack Deno framework — one state, propagated everywhere.**
- **Write reactive, use generators or atomic actions when needed.**
- **Pick your target, compile and ship!**

`v1.0.0-alpha11`

> Define state once. It persists, syncs to all clients, drives the UI.

## Three styles — mixable

| Style          | API                         | Best for                                      |
| -------------- | --------------------------- | --------------------------------------------- |
| **Reactive**   | `cell({ methods })`         | Most cells — CRUD, forms, async               |
| **Sequential** | `cell({ generators })`      | Multi-step workflows, wizards, checkout flows |
| **Explicit**   | `cell({ actions, reduce })` | Full control, complex cross-cell logic        |

All three can be mixed in a single cell. Start reactive, add generators or
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
import { aio, cell } from "aio";

const counter = cell("counter", {
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

await aio.run({ appId: "taste", appVersion: "0.1.0", cells: [counter] });
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

→ [Quickstart](docs/basics/quickstart.md) for UI setup, Electron, scaffolder,
and all compile targets.

## What's included

|                 |                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **State**       | reactive proxy (Immer) · state machines · generators · selectors · middleware · `call()` coordination · `draft()` · `useLocal` · `page()` routing |
| **Renderer**    | AIR (~8KB) — signals, JSX, auto-memo, SSR/hydration, forms, animation, virtual-list · React adapter · custom adapter API                          |
| **SQLite**      | async Worker (non-blocking) · read replicas · ORM · schema migrations · WAL · transactions · custom pragmas                                       |
| **Persistence** | auto-persist to Deno.Kv · cell-level `persist` config (`include`/`exclude`) per cell                                                              |
| **Sync**        | WebSocket · delta patches · offline queue (IndexedDB, 24h TTL) · UDS/IPC · cell-level `ui` per-user filtering · periodic resync                   |
| **Security**    | auto-TLS (`--expose`) · multi-user token auth · rate limiting · CSRF protection · `allowedOrigins`                                                |
| **Scheduling**  | cron · intervals · one-shot timers · cancel by ID or prefix                                                                                       |
| **DX**          | time-travel (Ctrl+.) · hot reload · `testCell` harness · Redux DevTools · perf budgets · freeze detection · AIR DevTools                          |
| **Electron**    | desktop window · UDS+IPC (zero TCP in prod) · window persistence · DevTools toggle · `keepServer`                                                 |
| **Deploy**      | browser · Electron · CLI · systemd service · Android APK (WebView) · single binary · remote (HTTPS)                                               |

[Core Concepts](docs/basics/concepts.md) ·
[Full API reference](docs/basics/api-reference.md)

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
| Cell lifecycle           |   ✅    |     🔧     |    ❌    |       ❌        |    ❌     |     ❌      |    ❌     |
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

See [FAQ](docs/basics/faq.md#when-not-to-use-aio) for details.

## Docs

**Getting Started:** [Quickstart](docs/basics/quickstart.md) ·
[Concepts](docs/basics/concepts.md) ·
[Project Structure](docs/basics/project-structure.md) ·
[Migration](docs/basics/migration.md)

**State:** [Cells](docs/state/cells.md) · [Methods](docs/state/methods.md) ·
[Machines](docs/state/machines.md) · [Generators](docs/state/generators.md) ·
[Actions & Reduce](docs/state/actions-reduce.md) ·
[Scheduling](docs/state/scheduling.md)

**UI:** [AIR Setup](docs/ui/air-setup.md) · [Signals](docs/ui/air-signals.md) ·
[Components](docs/ui/air-components.md) · [React Adapter](docs/ui/react.md) ·
[AIR vs React](docs/ui/comparison.md)

**Data:** [Auto-Persist](docs/persistence/auto-persist.md) ·
[SQLite](docs/persistence/sqlite.md) · [CRDT Sync](docs/persistence/crdt.md) ·
[Delta](docs/persistence/delta.md) · [Offline](docs/persistence/offline.md)

**Clients:** [Browser](docs/clients/browser.md) ·
[Electron](docs/clients/electron.md) ·
[App Manager](docs/clients/app-manager.md)

**Infrastructure:** [Auth](docs/auth/auth.md) ·
[Build Targets](docs/build/targets.md) · [Scaling](docs/build/scaling.md) ·
[Testing](docs/testing/cell-testing.md) · [Linter](docs/testing/linter.md)

**Debug:** [Errors](docs/debugging/errors.md) ·
[Vitals](docs/debugging/vitals.md) ·
[Troubleshooting](docs/debugging/troubleshooting.md) ·
[Performance](docs/debugging/performance.md)

**Reference:** [API](docs/basics/api-reference.md) · [FAQ](docs/basics/faq.md) ·
[Upgrade](docs/upgrade/README.md) · [Changelog](docs/basics/changelog.md)

## Status

**v1.0.0-alpha11** · [JSR](https://jsr.io/@riagentic/aio) · MIT

1774 tests · security hardened · 184+ bugs fixed across 5 nuclear audit waves

New in alpha11: `feature()` → `cell()` rename, cell-level `persist`/`ui` filters
(replace `stateForDB`/`stateForUI`), type-safe machine states with literal
`.type` inference, clean import boundaries (`aio/core` removed, renderers no
longer re-export server API), monolith decomposition into focused modules,
`dispatchTo` removed (use direct calling). Core (state, sync, persistence,
cells, scheduling, renderer) is stable. Electron, Android, and build targets are
functional but less battle-tested.
