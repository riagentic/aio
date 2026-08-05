<p align="center">
  <img src="docs/aio-logo.svg" alt="aio" width="380">
</p>

<p align="center">
  <b>The all-in-one Deno app framework — persistence + state + UI, batteries included.</b><br>
  Define state once as a <code>cell</code>; it persists, syncs to every client, and drives the UI.<br>
  One codebase → browser, Electron, and Android.
</p>

<p align="center"><code>v1.0.0-alpha46</code> · <a href="LICENSE">MIT</a></p>

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

Or skip all four — **one line runs any aio app straight from source** (installs
whatever is missing, clones, repairs, production-builds, runs):

```sh
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/run.sh | sh -s owner/repo
# inside an app repo, no argument needed · --dev for the dev server
```

See [run from source](docs/build/run-from-source.md).

Every target has an explicit dev and compile task:

```sh
deno task dev:browser        # dev build running in the browser
deno task dev:electron       # dev build in an Electron desktop window
deno task dev:android        # dev build in an Android emulator

deno task compile:browser    # release binary serving the browser app
deno task compile:electron   # release desktop (Electron) build
deno task compile:android    # release Android APK
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

And the UI is just JSX over that cell (AIR, ~8 KB signals renderer):

```tsx
// src/App.tsx — reads are reactive, calls dispatch. No hooks, no wiring.
import { counter } from "./counter.ts";

export default function App() {
  return (
    <main>
      <h1>{counter.count}</h1>
      <button type="button" onClick={() => counter.increment()}>+</button>
      <button type="button" onClick={() => counter.reset()}>Reset</button>
    </main>
  );
}
```

Two files — that's the whole app. State persists across restarts, every open
client stays in sync, and the same two files build to browser, Electron desktop,
and Android.

## Features

Everything below ships in the box — no plugins, no assembly.

| Feature                       | What                                                                                                                                                                                                      | Docs                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **State — cells**             | One `cell({ state, methods })` drives server, UI, persistence, sync, and tests; `worker: true` gives a heavy cell its own thread                                                                          | [cells](docs/state/cells.md)                |
| **Reactive UI — AIR (~8 KB)** | Signals + JSX; direct reads (`counter.count`) and calls (`counter.increment()`)                                                                                                                           | [air](docs/ui/air-setup.md)                 |
| **Persistence**               | Auto worker-thread SQLite (one `state.db`) — zero config, opt out per cell/field; one app = one directory (`~/.<app>/data` is the whole backup)                                                           | [persist](docs/persistence/auto-persist.md) |
| **Sync**                      | WebSocket delta patches, per-action acks, offline queue, CRDT merge                                                                                                                                       | [sync](docs/persistence/crdt.md)            |
| **Async workflows**           | Plain async methods + `until`/`race`/`sleep`, cancellable via `cancelOn`                                                                                                                                  | [methods](docs/state/methods.md)            |
| **Scheduling**                | `after` / `every` / `at` / cron / exponential `backoff`                                                                                                                                                   | [scheduling](docs/state/scheduling.md)      |
| **Server**                    | HTTP routes with `:id` params, cookies + JSON (`route()`), ambient `serverRequest()`, per-user filtering, auto-TLS                                                                                        | [routes](docs/examples/05-integrations.md)  |
| **Auth**                      | `auth: true` = full login: signup, sessions, `<SignIn/>`, TOTP 2FA, OIDC, roles                                                                                                                           | [auth](docs/auth/auth.md)                   |
| **Testing**                   | `testCell` + semantic `testUI`, plus `testServer`/`testBrowser` for real e2e — zero setup, hermetic                                                                                                       | [testing](docs/testing/cell-testing.md)     |
| **Build — 5 targets**         | Browser · Electron · Android · CLI · service, single-binary `deno compile`; `deno task build` builds a whole fleet (server + clients) into `dist/`                                                        | [targets](docs/build/targets.md)            |
| **`am` CLI + amui GUI**       | Manage + inspect running apps: state, SQL, logs, trigger UI, metrics, `am cost` (what your app actually pushes) — CLI, or the visual [amui](docs/clients/amui.md) app manager                             | [am](docs/clients/app-manager.md)           |
| **Debug & DX**                | Time-travel, blank-screen guard, dev graph validator, vitals, live reload (a cell edit restarts the app), one-frame reduce budget in dev, `am pin` (each app pins the aio version it was written against) | [debug](docs/debugging/troubleshooting.md)  |
| **Security**                  | PBKDF2 passwords, lockout + rate limits, CSRF floor, secret-field boot guards, `redactActions` (a secret argument is recorded nowhere)                                                                    | [auth](docs/auth/auth.md)                   |

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
