# aui — the aio app manager

A visual manager for every aio app on your machine. The GUI counterpart to the
`am` CLI ([docs/clients/app-manager.md](../../docs/clients/app-manager.md)):
discover, inspect, and control your apps without `ps`, `kill`, or `curl`.

aui is itself an aio app — it dogfoods the framework (one server-side `manager`
cell + an AIR/JSX UI).

## Run it

```sh
cd examples/aui
deno task dev          # browser shell (instant)
deno task dev:electron # desktop window (first run installs electron)
```

It auto-discovers aio projects by walking up from where you launch it, plus
`~/aio-apps`. Point it elsewhere with `AUI_ROOTS`:

```sh
AUI_ROOTS=/work/apps:/experiments deno task dev
```

## What it does

**Sidebar** — every aio project (running ● / stopped ○), searchable; a button
to scaffold a new app (`am create`).

**Per-app detail**, tabbed:

- **Overview** — status, port, pid, uptime, clients, CPU, memory, project +
  runtime config, recent errors, schedules.
- **Cells** — each cell and its methods; a button runs a method live (trojan
  dispatch).
- **State** — the app's live state as a collapsible JSON tree (loaded on demand,
  size-capped so a huge state never freezes the UI).
- **Metrics** — live CPU + memory charts (sampled while selected).
- **Tasks** — run any `deno task`; output is captured and every run is
  cancellable with a hard 5-minute cap, so `dev`/`watch` can't wedge the runner.
- **Files** — browse the whole source tree (read-only), collapsible, deps/build
  junk filtered out.

**Controls** — start / stop / restart (graceful trojan shutdown → SIGTERM), with
confirm guards; the list refreshes itself after each action.

## How it works

- The `manager` cell runs **server-side**; the browser gets synced state + a
  dispatch surface. Node/Deno-only helpers are pulled via dynamic `import()`
  inside methods, keeping the browser bundle clean.
- Discovery uses the instance **lock registry** (every local app, `--expose`d or
  not) unioned with an on-disk scan.
- Per-app data comes from each app's **trojan API** (localhost control plane);
  CPU/memory come from `ps`.

## Test

```sh
deno task test
```

Covers the manager cell (dispatched through the real reduce path), the discovery
+ file/process helpers, and the SSR shell.
