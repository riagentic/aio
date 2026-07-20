```
 _v_
(o>o)  aio
 )/
/|
```

- **Full-stack Deno framework — one state, propagated everywhere.**
- **Write reactive, use generators or atomic actions when needed.**
- **Pick your target, compile and ship!**

`v1.0.0-alpha24`

> Define state once. It persists, syncs to all clients, drives the UI.

## Three styles — mixable

| Style          | API                         | Best for                                      |
| -------------- | --------------------------- | --------------------------------------------- |
| **Reactive**   | `cell({ methods })`         | Most cells — CRUD, forms, async               |
| **Sequential** | `cell({ generators })`      | Multi-step workflows, wizards, checkout flows |
| **Explicit**   | `cell({ actions, reduce })` | Full control, complex cross-cell logic        |

All three can be mixed in a single cell.

**Not sure which? Use this rule:**

1. **Default to `methods`** (reactive) — reach for it 90% of the time. Mutate
   state directly; sync and persistence are automatic.
2. **Switch to `generators`** only when one user action is a **multi-step
   sequence** with intermediate states you want to see (a wizard, a checkout).
3. **Drop to `actions` + `reduce`** only when you need an **explicit action
   log** or complex cross-cell logic that methods can't express cleanly.

Start with `methods`. You'll know when you need the others — until then, you
don't.

## Why aio?

You're building a dashboard, trading tool, control panel, or internal app. You
need state that persists and syncs to every client in real-time. Today that
means wiring together a state manager, a database, a WebSocket layer, a
persistence layer, auth, and build tooling — six systems that don't know about
each other.

aio replaces all six. Define state once, it flows everywhere. One codebase
compiles to browser, desktop, CLI, service, or mobile. No glue code, no sync
bugs, no infrastructure decisions. (Offline-first CRDT sync is built in and
currently `@experimental` — see [sync](docs/persistence/README.md).)

## Is aio for you?

Decide in 30 seconds:

| aio is great for                                           | aio is deliberately not for                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Dashboards, trading & ops tooling, control panels          | Content/marketing sites & SEO (client-rendered, no server components) |
| Internal tools & admin panels                              | Planet-scale public APIs (embedded, one process — by design)          |
| Local-first desktop/mobile apps (one codebase → 5 targets) | Native iOS (Android ships via WebView)                                |
| Teams on **Deno** who want batteries included              | Node/Bun projects (aio is Deno-native)                                |

The right users self-select in; the wrong ones leave happy. Full rationale:
[positioning & non-goals](docs/basics/positioning.md).

## Taste

**Prerequisites:**
[Deno 2.9+](https://docs.deno.com/runtime/getting_started/installation/) (aio
tracks the latest stable Deno)

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
// (both default on — see docs/state/cell-visibility.md to narrow per cell)
```

Get started with **`am`** (the aio manager) — install once, it does the rest:

```sh
# 1. install am (installs Deno too if missing)
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh

# 2. scaffold + run
am create my-app                   # or: --template=todo
cd my-app
deno task dev                      # run · deno task compile|electron|android to build
```

`am update` keeps it current; `am uninstall` removes it (your apps stay put).
Prefer no curl? `deno install -gA -n am jsr:@riagentic/aio/am` is the same thing.

→ [Quickstart](docs/basics/quickstart.md) for UI setup, Electron, scaffolder,
Fit check first? → [Positioning & non-goals](docs/basics/positioning.md). and
all compile targets.

## Features

Everything below ships in the box — no plugins, no assembly.

**State — cells**

- `cell(name, { state, methods })` — one definition drives server, UI,
  persistence, sync, and tests
- Direct reactive reads in JSX (`counter.count`) and direct calls
  (`counter.increment()`) — no dispatch ceremony
- Sync methods mutate an Immer draft; async methods get read-your-writes
  semantics and Promise-with-ack returns
- Generators — sequential, cancellable, observable multi-step workflows
- Actions/reduce tier for explicit control (time-travel-friendly, replayable)
- State machines with transition guards · selectors (auto-scoped) · `validate`
  invariants
- Cross-cell composition: `call()` coordination, `waitFor`, own-effects,
  `composeCells`
- Middleware / `beforeReduce` interception · cell lifecycle
  (`onInit`/`onDestroy`)
- Client-scoped cells (`scope: "client"`) for per-tab state · `useLocal` (object
  or tuple form)
- State versioning + `onMigrate` · per-cell circuit breaker · `isolate` dev
  filter

**Zero-config runtime**

- `await aio.run()` — cells from the registry, appId/title/version from
  deno.json, baseDir from the entry; config only to override
- Boot-fatal config validation with the full key table (typo ≠ mystery) ·
  single-instance lock with liveness self-heal
- `deno task doctor` — config, import map, Deno version sanity

**Persistence**

- Auto-persist every cell to Deno.Kv (default on; opt out per cell/field, deep
  dot-path excludes)
- SQLite on a worker thread — non-blocking, WAL, transactions, read replicas,
  `table()/pk()/text()` schema, automatic state↔table sync
- Snapshots (save/load), persist debounce, single/multi KV modes, schema version
  stamps

**Sync & networking**

- WebSocket state broadcast with Immer delta patches (+ full-state fallback,
  per-cell strategies)
- Per-action acks · offline queue · periodic resync · wire-protocol version
  handshake
- UDS/IPC transport — zero TCP ports for Electron in prod
- Bound remote cells: `connectCli(url).bind(counter)` — typed method calls +
  live state over the socket, no wire format
- CRDT sync (experimental): HLC clocks, op-log, rebase, per-field merge
  strategies (lww, counter, per-key, set-add/remove), `onConflict`/`onSync`

**Server**

- Custom HTTP routes (exact + `/prefix/*`) next to the state channel — uploads,
  webhooks, APIs
- Live TSX transpile in dev · offline-capable (framework deps served locally) ·
  static/prod bundle serving
- Auth: token map or `resolveUser` hook · per-user state filtering (`forUser`) ·
  auto-TLS with `--expose`
- Rate/size limits (`wsLimits`), `maxConnections`, origin checks, dispatch-storm
  guard with breaker
- Prometheus metrics (`/__aio/metrics`) · health endpoint · graceful shutdown ·
  dead-listener exit

**Scheduling**

- `after` / `every` / `at` / cron · exponential `backoff` for pollers · cancel
  by id
- Config-level always-on schedules + dynamic effects returned from methods ·
  collision warnings

**UI — AIR renderer (~8KB)**

- Signals + JSX automatic runtime, auto-memo, no virtual-DOM diffing of
  untouched trees
- Hooks: `useLocal`, `useAio`, `useCell`, `useConnected`, `useOptimistic`,
  `useDimensions`, `useSignal`, `useRef`, contexts with selectors
- Router (`Route`/`Outlet`, signal-based path/search) · forms with validation +
  auto-`preventDefault` submits (opt-out attribute)
- Transitions & springs · `Portal` · `Suspense` + `lazy` · `ErrorBoundary` ·
  SSR/streaming + hydration · virtual list
- Accessibility dev warnings (`setDevMode`) · React-compat hooks
  (`aio/air/compat`) · custom adapter API (`aio/state-core`)

**Testing — first-class**

- `testCell` — typed send/expect harness, machine + effect assertions,
  property-style random actions
- Semantic UI testing: `testUI(App, "name", async (ui) => …)` — zero setup (auto
  DOM, auto cells, full teardown)
- No awaits on actions (ordered queue); deterministic names from the TSX
  (`<div class="button">Submit</div>` → `SubmitButton`)
- Stable handles via `t` / `data-testid` · keyed instances · `expectCell` /
  `waitFor` · hermetic by default
- `testgen` — generated fully-typed clients; renames break tests at compile time
- Drive **live** apps: `am surface` / `am trigger` with the full action set
  incl. gestures — browser, Electron, Android WebView
- AI-native: the surface is a complete perception+action space; replies include
  the fresh post-action state
- Proven end-to-end against real Chromium, over aio's own protocol — no
  webdriver

**Debugging & DX**

- Time-travel (Ctrl+. panel, `am tt`, error forensics) · Redux DevTools bridge ·
  AIR devtools
- Blank-screen guard: every dev boot failure = in-page diagnostic + terminal
  cause (never a silent white page)
- Dev graph validator (broken imports → explanatory page) · startup linter ·
  error-code catalog (gate-tested)
- Client console auto-forwarded to the server (`am logs`) · diagnostic bus +
  health overlay
- Vitals: freeze detection, memory-pressure monitor, render meter, perf budgets
  · live reload (code + CSS)

**`am` — app manager CLI**

- Process: start/stop/restart/status/watch/instances · State:
  state/ui/dispatch/actions/persist/snapshot/tt
- Inspect:
  clients/surface/trigger/dom/interact/sql/tables/schedules/log/errors/metrics/health/config
- `--json` everywhere — scriptable by tools and AI agents

**Build & deploy — 10 targets**

- Browser, Electron, CLI, systemd service, Android APK — each local or remote
  (remote: experimental)
- Single-binary `deno compile` · esbuild bundling (ESM browser / IIFE WebView) ·
  build integrity checks
- Scaffolder: `aio create` — 5 templates × 10 app types, vendored or mirrored
  framework delivery

**Security**

- Timing-safe token auth · localhost-only control API (CSRF header,
  rate-limited, read-only SQL)
- Secret-looking-field boot warnings · deep-path excludes stripped from
  broadcasts AND patches
- Prototype-pollution guards on the wire · URL-token usage warnings

**Quality machinery**

- 2370+ tests incl. real-browser e2e · coverage ratchet (floor-enforced)
- CI drift gates: API snapshot, docs links/coverage/imports/index, module
  boundaries, config allowlists, browser deps, bundle smoke
- Symptom→cause→caught-by matrix for every failure class ever hit
  ([troubleshooting](docs/debugging/troubleshooting.md))

**aio's sweet spot:** apps where state is the product — dashboards, trading
tools, control panels, internal tools, desktop utilities. One state, many
clients, zero plumbing. Fit questions:
[Positioning & non-goals](docs/basics/positioning.md) ·
[When not to use aio](docs/basics/faq.md#when-not-to-use-aio)

## Docs

**[→ Full contents — every doc on one page](docs/content.md)**

**Getting Started:** [Quickstart](docs/basics/quickstart.md) ·
[Concepts](docs/basics/concepts.md) ·
[Project Structure](docs/basics/project-structure.md) ·
[Migration](docs/basics/migration.md)

**State:** [Cells](docs/state/cells.md) · [Methods](docs/state/methods.md) ·
[Machines](docs/state/machines.md) · [Generators](docs/state/generators.md) ·
[Actions & Reduce](docs/state/actions-reduce.md) ·
[Scheduling](docs/state/scheduling.md)

**UI:** [AIR Setup](docs/ui/air-setup.md) · [Signals](docs/ui/air-signals.md) ·
[Components](docs/ui/air-components.md) ·
[For React developers](docs/ui/comparison.md)

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
[Upgrade](docs/upgrade/README.md) · [Changelog](CHANGELOG.md)

## Status

**v1.0.0-alpha24** · [JSR](https://jsr.io/@riagentic/aio) · MIT

2370+ tests · security hardened · CI-locked API snapshot + coverage ratchet

New in alpha21: **every effect is testable** — `bootCells` + a virtual clock
(`await ui.advance(ms)`) fire `schedule.*` deterministically in tests, plus
`schedule.next`, external links via the system browser (`openExternal`,
same-origin-only navigation relay), the `.server.ts` convention for server-only
code, and a reconciler fix for conditional bindings inside `<form>` — closing
out all three external field reports. Alpha20 shipped **zero-config everything**
(`import "./cell.ts"; await aio.run();`), no-await UI tests, bound remote cells,
the `aio/ui` kit, and flag-free LAN discovery. Alpha18 shipped **semantic UI
testing** + read-your-writes async methods; alpha15 fixed the **Deno ≥ 2.9
blank-app bug** (WS upgrade) every earlier version hits. Alpha13 was the **DX
overhaul** (honest `persist`/`ui` defaults, awaitable methods, React-compat
hooks moved to `aio/air/compat`); alpha12 removed React — **AIR is the sole
renderer** with direct reactive cell access as the primary UI pattern. Core
(state, sync, cells, scheduling, renderer) is stable. Electron, Android, and
build targets are functional but less battle-tested.
