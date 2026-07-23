# amui — Aio Manager UI

A visual manager for every aio app on your machine — the GUI counterpart to the
[`am` CLI](app-manager.md). Discover apps (running or on disk), inspect them
deeply (process + versions, cells, merged state with persist/UI flags, the full
runtime metrics aio exposes, logs, config, code), run their tasks, and
start/stop/restart them. amui mines everything the framework's diagnostic
surface emits — health, vitals, the live action stream — so nothing aio measures
goes unseen.

amui is itself an aio app — it dogfoods the framework (one server-side `manager`
cell + an AIR/JSX UI).

## Run it

```sh
deno task amui            # from the aio repo — browser shell (instant)
```

Or from anywhere via the export:

```sh
deno run -A jsr:@riagentic/aio/amui   # (once published)
```

amui auto-discovers aio projects by walking up from where you launch it, plus
`~/aio-apps`. Point it elsewhere with `AUI_ROOTS` (colon-separated):

```sh
AUI_ROOTS=/work/apps:/experiments deno task amui
```

## What it does

**Sidebar** — every aio project (running ● / stopped ○), searchable; a button to
scaffold a new app (`am create`). amui is an aio app too, so it lists **itself**
— every monitoring surface (cells, state, metrics, logs) works on it. Only its
lifecycle is off-limits: the detail view shows a `★ this is amui` marker instead
of Start/Stop/Restart, since starting would spawn a second manager and stopping
would kill the one you are looking at. Manage it from the shell that launched
it.

**Per-app detail**, tabbed:

- **Overview** — status + quick tiles (port, pid, uptime, clients, CPU, memory,
  heap); a **process** card (pid, port, app id, runtime kind, working dir, exe);
  **versions** (the app's own + the **aio framework version** it runs); **live
  cell health** (per cell: status, enabled, error count, last action); project +
  runtime config; build targets; recent errors; schedules.
- **Cells** — each cell and its methods; a button runs a method live (trojan
  dispatch), and a **`</> source`** button opens where the cell is defined
  (`cell("<name>")`) in the Codebase viewer, when source is available.
- **State** — every cell's live state merged into one page, as a collapsible
  tree. Each field shows whether it is **persisted** (written to SQLite) and
  whether it is **exposed to the UI** (synced to clients) — a single overview of
  what exists, what ships to the browser, and what survives a restart.
- **Metrics** — everything aio monitors, sampled live: trend charts (CPU, RSS,
  V8 heap, p95 reduce time, dispatch-queue depth); the **dispatch loop** (queue
  depth, drain rate, p95/last reduce, effect backlog, tripped **circuit
  breakers**); **memory** (RSS + heap); a **clients** table (transport, health,
  bytes/s, backpressure); **per-cell state sizes**; and the **recent-actions
  stream** — every processed action with its reduce time (and errors) — so you
  can see how state is actually being processed.
- **Logs** — the app's live logs: the framework + app lines from
  `.aio/log/app.log`, or the **combined** stdout capture (`.aio.log`, which also
  carries cell `console.log` and stack traces). Pick a source (combined /
  framework / errors / client), filter by level or text, and toggle live-follow.
  (aio has no log-streaming endpoint, so amui tails the files.)
- **Tasks** — run any `deno task`; output is captured and every run is
  cancellable with a hard 5-minute cap.
- **Codebase** — the app's files. Defaults to the **runtime** dir (what's
  actually executing: the source dir for a dev build, the unpacked mount for a
  running AppImage, the binary's dir for a compiled build); when the app lives
  inside a larger git repo whose root differs (a monorepo, or an AppImage
  mount), a toggle switches to the whole repo tree. Read-only, foldable to a
  single root, filterable; files open with basic syntax highlighting (TS/JS,
  JSON); oversized (>2 MB) and binary files show a notice instead.

**Controls** — start / stop / restart (graceful trojan shutdown → SIGTERM), with
confirm guards; the list refreshes itself after each action.

## How it works

- The `manager` cell runs **server-side**; the browser gets synced state + a
  dispatch surface. Node/Deno-only helpers are pulled via dynamic `import()`
  inside methods, keeping the browser bundle clean.
- Discovery uses the instance **lock registry** (every local app, `--expose`d or
  not) unioned with an on-disk scan.
- Diagnostics are mined from each running app's own surface: the **trojan API**
  (state, cells, config, `fields`, schedules, `clients`, `history`), plus
  `/__aio/health` (cell health + framework version) and `/__aio/vitals` (the
  dispatch loop, per-cell payload + sizes, client health). Process CPU/memory
  come from `ps`; the app's own RSS/heap from its Prometheus `/__aio/metrics`.
  Logs are tailed from the app's `.aio/log` (there is no streaming endpoint).
  All of this is localhost-only and dev-only, exactly as the trojan gates it.

See also: [`am` CLI](app-manager.md) · [browser client](browser.md) ·
[electron client](electron.md).
