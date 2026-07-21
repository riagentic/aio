<p align="center">
  <img src="docs/aio-logo.svg" alt="aio" width="380">
</p>

<p align="center">
  <b>The all-in-one Deno app framework — persistence + state + UI, batteries included.</b><br>
  Define state once as a <code>cell</code>; it persists, syncs to every client, and drives the UI.<br>
  One codebase → browser, Electron, and Android.
</p>

<p align="center"><code>v1.0.0-alpha25</code> · <a href="LICENSE">MIT</a></p>

## Get started — four lines

```sh
# 1 — install: Deno (if missing) + am into ~/.local/lib/aio, added to your PATH
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh

# 2 — scaffold a new app (counter by default, or --template=todo)
am create my-app

# 3 — run it in the browser
cd my-app && deno task dev

# 4 — build a release binary (· deno task electron · deno task android)
deno task compile
```

That's it. A working counter (or todo) app, runnable and buildable to a native
binary, desktop (Electron), or Android APK. (Windows:
`irm …/install.ps1 | iex`.)

## The whole app is state

```ts
import { cell } from "aio";

export const counter = cell("counter", {
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

// In JSX: read `counter.count` directly, call `counter.increment()` directly.
// It's persisted, synced to every client, and testable — for free.
```

## Features

Everything below ships in the box — no plugins, no assembly.

| Feature                       | What                                                                            | Docs                                        |
| ----------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| **State — cells**             | One `cell({ state, methods })` drives server, UI, persistence, sync, and tests  | [cells](docs/state/cells.md)                |
| **Reactive UI — AIR (~8 KB)** | Signals + JSX; direct reads (`counter.count`) and calls (`counter.increment()`) | [air](docs/ui/air-setup.md)                 |
| **Persistence**               | Auto Deno.Kv + worker-thread SQLite — zero config, opt out per cell/field       | [persist](docs/persistence/auto-persist.md) |
| **Sync**                      | WebSocket delta patches, per-action acks, offline queue, CRDT merge             | [sync](docs/persistence/crdt.md)            |
| **Generators**                | Sequential, cancellable, observable multi-step workflows                        | [generators](docs/state/generators.md)      |
| **State machines**            | Transition guards, selectors, `validate` invariants                             | [machines](docs/state/machines.md)          |
| **Scheduling**                | `after` / `every` / `at` / cron / exponential `backoff`                         | [scheduling](docs/state/scheduling.md)      |
| **Server**                    | Custom HTTP routes, token/`resolveUser` auth, per-user filtering, auto-TLS      | [auth](docs/auth/auth.md)                   |
| **Testing**                   | `testCell` harness + semantic `testUI` — zero setup, hermetic                   | [testing](docs/testing/cell-testing.md)     |
| **Build — 5 targets**         | Browser · Electron · Android · CLI · service, single-binary `deno compile`      | [targets](docs/build/targets.md)            |
| **`am` CLI**                  | Manage + inspect running apps: state, SQL, logs, trigger UI, metrics            | [am](docs/clients/app-manager.md)           |
| **Debug & DX**                | Time-travel, blank-screen guard, dev graph validator, vitals, live reload       | [debug](docs/debugging/troubleshooting.md)  |
| **Security**                  | Timing-safe auth, secret-field boot guards, wire pollution guards               | [auth](docs/auth/auth.md)                   |

**[→ Every doc on one page](docs/content.md)** ·
[Quickstart](docs/basics/quickstart.md) · [Concepts](docs/basics/concepts.md) ·
[API](docs/basics/api-reference.md) · [FAQ](docs/basics/faq.md) ·
[Changelog](CHANGELOG.md)

## Is aio for you?

Built for apps where **state is the product** — dashboards, trading & ops tools,
control panels, internal tools, local-first desktop/mobile apps. Not for
content/SEO sites or planet-scale public APIs (one embedded process, by design).
[Positioning & non-goals](docs/basics/positioning.md).

## License

[MIT](LICENSE)
