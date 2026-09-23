# Every option, one page

> Generated from the source by `deno task update:reference` — do not edit by
> hand; `check:release` fails when it is stale. 186 entries: the signature, what
> it does, an example when the source has one, and the file it lives in. The
> guides explain; this page is for looking a name up.

- [cell options](#cell-options) — 24
- [aio.run options](#aiorun-options) — 80
- [aio/air](#aioair) — 82

## cell options

`cell(name, { … })` — the keys a cell takes. Guide: [cells](../state/cells.md).

### `state`

```ts
state: S;
```

The cell's initial state — a plain JSON-shaped object.
<sub>src/state/cell-config-types.ts</sub>

```ts
state: { items: [] as Todo[], filter: "all" },
```

### `methods`

```ts
methods?: M
```

The cell's methods — `name(s, ...args)` reads and writes the state `s`; call it
as `cell.name(...args)`, from the UI or the server.
<sub>src/state/cell-config-types.ts</sub>

```ts
methods: {
  add(s, text: string) { s.items.push({ text, done: false }); },
  async load(s) { s.items = await fetchTodos(); },
},
```

### `scope`

```ts
scope?: "client" | "server"
```

Cell scope. `"client"` cells live in the browser only — never registered with
the server, never synced, never server-persisted.
<sub>src/state/cell-config-types.ts</sub>

```ts
scope: "client",   // lives in this tab only — never synced, never on disk
```

### `cancelOn`

```ts
cancelOn?: { [K in keyof M & string]?: "self" | (string | { type })[] }
```

Cancellation triggers per ASYNC METHOD — { methodKey: [actionsOrTypes] }.
<sub>src/state/cell-config-types.ts</sub>

```ts
cancelOn: { open: "self", search: ["self", nav.leave] }
```

### `concurrency`

```ts
concurrency?: { [K in keyof M & string]?: ConcurrencyMode }
```

What happens when an ASYNC method is called again while it is still running.
<sub>src/state/cell-config-types.ts</sub>

```ts
concurrency: { search: "newest", scan: "first", save: "queue" }
```

### `ttl`

```ts
ttl?: { [K in keyof M & string]?: number }
```

Milliseconds for which a SUCCESSFUL async call answers an identical one without
running it. <sub>src/state/cell-config-types.ts</sub>

```ts
ttl: { fetchUser: 30_000 },   // an identical fetchUser(1) is answered from cache
```

### `long`

```ts
long?: (keyof M & string)[]
```

Async methods that may run as long as they need — no call ceiling, no effect
deadline. <sub>src/state/cell-config-types.ts</sub>

```ts
cell("job", {
  state: { pct: 0 },
  long: ["colorize", "refreshScratch"],   // ← checked against methods
  methods: {
    async colorize(s) { ... },            // hours; still cancellable
  },
})
```

### `selectors`

```ts
selectors?: Sel & Record<string, SelectorDef<S>>
```

Selectors — derived values, auto-scoped to cell state.
<sub>src/state/cell-config-types.ts</sub>

```ts
selectors: { open: (s) => s.items.filter((i) => !i.done) },
```

### `listensTo`

```ts
listensTo?: Record<string, string | { type } | (string | { type })[]>
```

React to FOREIGN actions (decoupled pub/sub — the source cell never knows about
this one): `{ myHandler: other.method }` — the named SYNC method runs with the
foreign action's payload when it dispatches.
<sub>src/state/cell-config-types.ts</sub>

```ts
listensTo: { onLogout: auth.logout },   // runs the SYNC method onLogout
```

### `validate`

```ts
validate?: (state: S) => true | string
```

Optional state validator — called after every reduce.
<sub>src/state/cell-config-types.ts</sub>

```ts
validate: (s) => s.total >= 0 || "total went negative",
```

### `args`

```ts
args?: ArgSchemas
```

Optional per-method ARGUMENT rules, positional, keyed by method name.
<sub>src/state/cell-config-types.ts</sub>

```ts
args: { setAge: [z.number().int().min(0)] },
```

### `persist`

```ts
persist?: CellFieldFilter<keyof NoInfer<S> & string>
```

Persistence filter — "all" (default) persists everything, "none" persists
nothing. { include: [...] } or { exclude: [...] } for field-level control.
<sub>src/state/cell-config-types.ts</sub>

```ts
persist: { exclude: ["draft", "scrollTop"] },
```

### `diagnostics`

```ts
diagnostics?: false
```

Keep this cell's ACTIONS out of the on-disk dev diagnostics — the action journal
(`logs/actions.jsonl`) and the dev action timeline.
<sub>src/state/cell-config-types.ts</sub>

### `access`

```ts
access?: Access
```

Who may CALL this cell's methods over the network — and only that: `access`
gates CALLS, `visible` gates READS, and neither implies the other (an `access`
rule hides no state; a `visible` filter stops no call).
<sub>src/state/cell-config-types.ts</sub>

### `visible`

```ts
visible?: CellVisibility<keyof NoInfer<S> & string, NoInfer<S>>
```

The READ side — what of this cell's state the broadcast carries to clients — and
ONLY the read side: `visible` gates READS, `access` gates CALLS, and neither
implies the other (a `visible: "none"` cell still has every method callable by
any client, return value included). <sub>src/state/cell-config-types.ts</sub>

```ts
visible: { exclude: ["passwordHash"] },
```

### `sync`

```ts
sync?: true | false | Partial<SyncConfig>
```

CRDT sync — true for defaults, or partial config to override merge strategies,
identity keys, retention. <sub>src/state/cell-config-types.ts</sub>

### `worker`

```ts
worker?: boolean
```

Run this cell's methods in their OWN Deno worker (its own isolate and OS
thread), so work that blocks — a parse, a crunch, an FFI call — can only stall
THIS cell. <sub>src/state/cell-config-types.ts</sub>

```ts
worker: true,   // this cell's methods run off the main thread
```

### `transaction`

```ts
transaction?: boolean | { serialize?; conflict? }
```

Transactional async methods: reads see a STABLE snapshot taken at method entry
(an `await` never changes them), and writes commit ATOMICALLY at return — one
batch, all-or-nothing (a throw/cancel discards).
<sub>src/state/cell-config-types.ts</sub>

```ts
transaction: true,   // reads pinned at entry, writes commit all-or-nothing
```

### `version`

```ts
version?: number
```

State version — increment when state shape changes.
<sub>src/state/cell-config-types.ts</sub>

```ts
version: 2,
```

### `onMigrate`

```ts
onMigrate?: (state: NoInfer<S>, fromVersion: number) => NoInfer<S>
```

Migration hook — called when persisted version < current version.
<sub>src/state/cell-config-types.ts</sub>

```ts
onMigrate: (s, from) => (from < 2 ? { ...s, tags: [] } : s),
```

### `onRestore`

```ts
onRestore?: (state: NoInfer<S>) => NoInfer<S> | void
```

Repair this cell's restored state, once, at boot.
<sub>src/state/cell-config-types.ts</sub>

```ts
onRestore(s) {
  for (const e of s.log) e.undo = undefined;   // closures don't persist
}
```

### `onPersist`

```ts
onPersist?: (state: NoInfer<S>) => Record<string, unknown>
```

Shape this cell's state on its way TO the store — the mirror of
`MethodsCellConfig.onRestore`. <sub>src/state/cell-config-types.ts</sub>

```ts
onPersist: (s) => ({ key: s.thumbKey }),   // 40 MB live, 200 bytes on disk
onRestore: (s) => { s.thumb = load(s.key) },
```

### `onInit`

```ts
onInit?: (app: ScopedApp<NoInfer<S>>, initState: NoInfer<S>) => void
```

Runs once at boot, after the cells it depends on are initialized — open a
connection, start a watcher. <sub>src/state/cell-config-types.ts</sub>

```ts
onInit: (app) => { watcher = watch(app); },
```

### `onDestroy`

```ts
onDestroy?: (app: ScopedApp<NoInfer<S>>) => void
```

Runs when the app shuts down (cells in reverse order) or the cell is disabled —
close what `onInit` opened. <sub>src/state/cell-config-types.ts</sub>

```ts
onDestroy: () => watcher?.close(),
```

## aio.run options

`aio.run({ … })` — the keys an app takes. Guide:
[lifecycle](../state/lifecycle.md).

### `appId`

```ts
appId?: string
```

Unique app identity — used for lock file, UDS socket, KV/SQLite paths, TLS cert
dir. <sub>src/server/aio-types.ts</sub>

```ts
appId: "notes",   // the data dir, the icon hue and the window title follow it
```

### `cells`

```ts
cells?: …[]
```

Cells to run. Default: every `cell()` the entry (transitively) imported — they
self-register, exactly like the standalone/android runtime.
<sub>src/server/aio-types.ts</sub>

### `localFirst`

```ts
localFirst?: boolean
```

Local-first execution (perfect-aio D3): every server cell runs its methods where
the CALLER is — instantly, optimistically — and propagates the change as a CRDT
op. <sub>src/server/aio-types.ts</sub>

### `cellDefaults`

```ts
cellDefaults?: { visible?; ui?; persist? }
```

Default persist and visibility config for all cells — individual cells override
these. <sub>src/server/aio-types.ts</sub>

### `port`

```ts
port?: number
```

HTTP/WS port. Order: `--port` > `AIO_PORT` > this > `AIO_DEFAULT_PORT` > a free
port picked at boot; a local Electron app may bind no TCP port unless one is
named. <sub>src/server/aio-types.ts</sub>

```ts
port: 8080,
```

### `host`

```ts
host?: string
```

Bind address. Defaults to `127.0.0.1`, or `0.0.0.0` under `expose`.
<sub>src/server/aio-types.ts</sub>

```ts
host: "127.0.0.1",
```

### `expose`

```ts
expose?: boolean
```

Serve on 0.0.0.0 with TLS instead of loopback-only — the config twin of
`--expose`. <sub>src/server/aio-types.ts</sub>

```ts
expose: true,   // bind 0.0.0.0 instead of 127.0.0.1 — needs auth or a key
```

### `tls`

```ts
tls?: "auto" | false | { cert; key }
```

Transport security when exposed — the config twin of `--no-tls` /
`--tls-cert`/`--tls-key`, so a COMPILED binary (a service unit has no shell
flags) can declare how it serves. <sub>src/server/aio-types.ts</sub>

```ts
tls: "auto",   // a cert on first boot — nothing to install, any OS
```

### `appDir`

```ts
appDir?: string
```

`--profile=<name>` puts a copy beside it (`<appDir>-<name>`).
<sub>src/server/aio-types.ts</sub>

```ts
appDir: "./data",   // everything this app writes lives here
```

### `profiles`

```ts
profiles?: boolean
```

Default true. `false`: the app runs from one folder only —
--profile/AIO_PROFILE/--home refused; AIO_APPS_DIR still moves every app.
<sub>src/server/aio-types.ts</sub>

```ts
profiles: false,   // a kiosk/service binary: one data home, always
```

### `dbPath`

```ts
dbPath?: string
```

Override the SQLite file (":memory:" for hermetic tests).
<sub>src/server/aio-types.ts</sub>

```ts
dbPath: "./data/state.db",
```

### `dbPragmas`

```ts
dbPragmas?: string[]
```

PRAGMAs for the app db, MERGED over the defaults by pragma name (WAL,
synchronous=NORMAL, busy_timeout, cache_size, foreign_keys) — naming one keeps
the rest. <sub>src/server/aio-types.ts</sub>

### `checkIntegrityOnBoot`

```ts
checkIntegrityOnBoot?: boolean
```

Check the app database's integrity at boot (`PRAGMA quick_check`).
<sub>src/server/aio-types.ts</sub>

### `updates`

```ts
updates?: …
```

Keep this app up to date from a release source.
<sub>src/server/aio-types.ts</sub>

```ts
updates: "https://releases.example.com/wallet"      // published artifacts
updates: "https://github.com/you/app"               // the repo itself
updates: { source, auto: true }                     // unattended service
```

### `feedback`

```ts
feedback?: …
```

Capture problem reports — what is running, what state it was in, what had just
happened, and the recent log — into `<data>/reports/`.
<sub>src/server/aio-types.ts</sub>

### `persist`

```ts
persist?: boolean
```

`false` keeps state in memory only (also `--no-persist`); default `true`
persists to SQLite (`state.db`). <sub>src/server/aio-types.ts</sub>

### `persistKey`

```ts
persistKey?: string
```

The key state is stored under in SQLite (`aio_kv`) — the key PREFIX in
`persistMode: "multi"`. <sub>src/server/aio-types.ts</sub>

### `persistDebounceMs`

```ts
persistDebounceMs?: number
```

Minimum milliseconds between state writes to SQLite; default 100.
<sub>src/server/aio-types.ts</sub>

### `persistMode`

```ts
persistMode?: "single" | "multi"
```

`"single"` (default) stores all state as one JSON row; `"multi"` one row per
top-level cell, rewriting only the cells that changed.
<sub>src/server/aio-types.ts</sub>

### `ui`

```ts
ui?: UiConfig
```

Window and page settings — title, width/height, entry, `<head>`, lang/dir,
theme, chrome, tray. <sub>src/server/aio-types.ts</sub>

### `baseDir`

```ts
baseDir?: string
```

Where the dev server serves the UI source from (`ui.entry` is relative to it);
default: the main module's directory. <sub>src/server/aio-types.ts</sub>

### `serveDirs`

```ts
serveDirs?: Record<string, string>
```

Extra read-only roots the DEV server serves, `"/urlPrefix" → dir` — e.g.
<sub>src/server/aio-types.ts</sub>

### `assets`

```ts
assets?: Record<string, string>
```

Read-only directories this app serves in dev AND prod, `"/urlPrefix" → dir` —
e.g. <sub>src/server/aio-types.ts</sub>

```ts
assets: { "/logo.svg": "./brand/logo.svg" },
```

### `client`

```ts
client?: "electron" | "browser" | "cli" | "server-only"
```

Which client to launch. Order: `--client` > this > deno.json `client` >
`"electron"`. <sub>src/server/aio-types.ts</sub>

```ts
client: "browser",   // open the default browser instead of a desktop window
```

### `keepServer`

```ts
keepServer?: boolean
```

Electron only: keep the server running after the window closes (also
`--keep-server`); with any other client, boot is refused.
<sub>src/server/aio-types.ts</sub>

### `transport`

```ts
transport?: "uds" | "ws" | "auto"
```

How the local client reaches the server. `"auto"` (default): a Unix socket for a
local, non-exposed Electron app, else WebSocket.
<sub>src/server/aio-types.ts</sub>

### `takeover`

```ts
takeover?: boolean
```

Kill the running instance and take its singleton lock (default: false) — the
config twin of `--takeover` (`killExisting` until alpha76).
<sub>src/server/aio-types.ts</sub>

### `serverUrl`

```ts
serverUrl?: string
```

Electron only: start as a thin client of this URL, with no server of its own
(`""` opens the connect page); exits when the window closes.
<sub>src/server/aio-types.ts</sub>

### `users`

```ts
users?: Record<string, AioUser>
```

Static token → user map, compared in constant time.
<sub>src/server/aio-types.ts</sub>

```ts
users: { "s3cret-token": { id: "ada", role: "admin" } },
```

### `key`

```ts
key?: string | boolean
```

Shared-key auth under `--expose`: `"secret"` = a fixed key, `true` = one
generated once and persisted, `false` = no framework auth.
<sub>src/server/aio-types.ts</sub>

```ts
key: true,   // generate and persist one shared key; the client pairs by PIN
```

### `resolveUser`

```ts
resolveUser?: ResolveUserFn
```

`(token, state) => user | null` — authenticate each connection's token against
current state. <sub>src/server/aio-types.ts</sub>

### `sessions`

```ts
sessions?: boolean | { ttlMs? }
```

Enable the SQLite session store: `app.sessions.issue(user)` returns a bearer
token with TTL and revocation (`true` = 30-day TTL).
<sub>src/server/aio-types.ts</sub>

### `auth`

```ts
auth?: boolean | AuthOptions
```

Built-in password auth — signup/login/logout, email verify, reset, TOTP 2FA,
OIDC, HttpOnly session cookie. <sub>src/server/aio-types.ts</sub>

```ts
auth: true,   // full login flows: sessions, users, TOTP
```

### `db`

```ts
db?: Record<string, TableDef | DbMapping>
```

SQLite tables by name: a `table()` bound to a state array mirrors that array; an
unbound table is reached through `app.db`. <sub>src/server/aio-types.ts</sub>

### `perfCheck`

```ts
perfCheck?: PerfCheck
```

Report performance-budget violations (default: on); `false` / `"off"` silences
them. <sub>src/server/aio-types.ts</sub>

### `perfBudget`

```ts
perfBudget?: PerfBudget
```

Time budgets per dispatch (reduce 100 ms, sync effect 5 ms by default) that
trigger a report, plus per-method `methods["cell:m"]` overrides including
`timeout`. <sub>src/server/aio-types.ts</sub>

### `budgets`

```ts
budgets?: Budgets
```

Size and rate limits, in the units a person writes — e.g.
<sub>src/server/aio-types.ts</sub>

### `watch`

```ts
watch?: false | string[]
```

Live reload in dev: `false` turns it off, an array narrows what is watched
(`watch: ["src/ui"]`). <sub>src/server/aio-types.ts</sub>

### `renderBudget`

```ts
renderBudget?: …
```

Client render-staleness / pending-patch thresholds — sent to the browser (page
shell + `cfg` frame). <sub>src/server/aio-types.ts</sub>

### `effectTimeoutMs`

```ts
effectTimeoutMs?: number
```

How long `await cell.method()` waits for an async method (default 30000; 0 =
forever) before rejecting. <sub>src/server/aio-types.ts</sub>

### `freezeState`

```ts
freezeState?: boolean
```

Extra deep-freeze of committed state after every reduce, on top of the always-on
Immer freeze; default `true` in dev, `false` in prod.
<sub>src/server/aio-types.ts</sub>

### `memory`

```ts
memory?: MemoryConfig
```

Heap-pressure monitor: `enabled`, `interval` (10 s), `warnThreshold` (0.75),
`criticalThreshold` (0.90), `onMemoryPressure`.
<sub>src/server/aio-types.ts</sub>

### `circuitBreaker`

```ts
circuitBreaker?: CircuitBreakerConfig
```

Auto-disable a cell after `maxErrors` errors (optionally within a rolling
`window` ms), calling `onTrip`. <sub>src/server/aio-types.ts</sub>

### `singleton`

```ts
singleton?: boolean
```

Refuse to start while another instance of this appId runs (default `true`;
`--takeover` replaces it). <sub>src/server/aio-types.ts</sub>

### `strictCells`

```ts
strictCells?: boolean
```

Fail boot loudly if a cell was defined (imported → cell() ran) but not passed to
`aio.run({ cells })` — its dispatches would be silent no-ops (green tests, dead
feature). <sub>src/server/aio-types.ts</sub>

### `guardDispatches`

```ts
guardDispatches?: boolean
```

Supervised runtime: an unhandled promise rejection (a fire-and-forget cell
dispatch that rejects, a floating `void poll()` on a schedule path) is logged
loudly, checkpointed and the process SURVIVES — no hand-written
`.catch(() => {})` per dispatch. <sub>src/server/aio-types.ts</sub>

### `refusalsReject`

```ts
refusalsReject?: boolean
```

Answer an in-process caller the way the WIRE already answers: a write the reduce
REFUSED (a `validate` hook, a machine guard) rejects `await cell.method()`
instead of resolving. <sub>src/server/aio-types.ts</sub>

### `journal`

```ts
journal?: boolean
```

Action journal: every committed action is appended to a log beside the database;
on the next boot the actions after the last snapshot are replayed on top of it,
so a SIGKILL in the persist debounce window loses nothing — a power cut can
(appends are not fsynced, so it can take the newest lines; see
docs/persistence/how-it-works.md). <sub>src/server/aio-types.ts</sub>

### `redactActions`

```ts
redactActions?: readonly string[]
```

Action types whose recorded VALUES must never be retained anywhere: the durable
journal, the in-memory timeline (`am timeline`) and the optional action log all
honour this one list. <sub>src/server/aio-types.ts</sub>

### `childWindows`

```ts
childWindows?: boolean
```

Allow the electron client to open CHILD windows to arbitrary http(s) URLs via
`__aioIPC.openWindow(url, { preload, sandbox })`.
<sub>src/server/aio-types.ts</sub>

### `electron`

```ts
electron?: ElectronConfig
```

The Electron process's own security decisions (sandbox policy) — see
`ElectronConfig`. <sub>src/server/aio-types.ts</sub>

```ts
aio.run({
  cells: [wallet],
  electron: { requireSandbox: true, unsandboxedChildWindows: false },
});
```

### `libraryMode`

```ts
libraryMode?: boolean
```

Embed aio in a bigger program or a test: no `Deno.exit`, no signal handlers, no
instance lock; `app.close()` leaves the process alive.
<sub>src/server/aio-types.ts</sub>

### `syncIntervalMs`

```ts
syncIntervalMs?: number
```

Push state to clients at most once per N ms (default 50; 0 = batch only within
the current tick). <sub>src/server/aio-types.ts</sub>

### `fullStateThreshold`

```ts
fullStateThreshold?: number
```

Send full state instead of a patch when the patch is larger than this fraction
of it; default 0.5. <sub>src/server/aio-types.ts</sub>

### `routes`

```ts
routes?: Record<string, …>
```

Custom HTTP routes — exact path or "/prefix/*" wildcard → handler.
<sub>src/server/aio-types.ts</sub>

```ts
routes: { "/health": () => new Response("ok") },
```

### `maxConnections`

```ts
maxConnections?: number
```

Maximum concurrent WebSocket clients; further upgrades are refused.
<sub>src/server/aio-types.ts</sub>

### `appFlags`

```ts
appFlags?: string[]
```

Flags this app answers itself — declared so aio passes them through instead of
refusing them as unknown. <sub>src/server/aio-types.ts</sub>

### `wsLimits`

```ts
wsLimits?: WsLimits
```

Per-client WebSocket safety limits (advanced; defaults are hardened).
<sub>src/server/aio-types.ts</sub>

### `allowedOrigins`

```ts
allowedOrigins?: string[]
```

Extra allowed WS origins beyond localhost + own host (reverse proxy, custom
domains). <sub>src/server/aio-types.ts</sub>

### `security`

```ts
security?: …
```

Response hardening + transfer encoding — see `SecurityConfig`.
<sub>src/server/aio-types.ts</sub>

### `plugins`

```ts
plugins?: …[]
```

Reusable pieces of app — each contributes cells, routes, schedules and
observe-only hooks through the SAME keys this config already has, so a plugin
can never do anything the app could not have written itself.
<sub>src/server/aio-types.ts</sub>

### `strictOrigin`

```ts
strictOrigin?: boolean
```

--expose hardening: require an Origin header on WS upgrade.
<sub>src/server/aio-types.ts</sub>

### `trustProxyHeader`

```ts
trustProxyHeader?: string
```

Behind a trusted reverse proxy: the header (e.g.
<sub>src/server/aio-types.ts</sub>

### `schedules`

```ts
schedules?: ScheduleDef[]
```

Jobs started at boot, validated first; plugin schedules run ahead of these.
<sub>src/server/aio-types.ts</sub>

### `isolate`

```ts
isolate?: string[]
```

Isolate cells — only these cells are active (dev mode convenience)
<sub>src/server/aio-types.ts</sub>

### `beforeReduce`

```ts
beforeReduce?: (action: unknown, state: unknown, user?: AioUser) => unknown | null
```

Runs before every action is reduced: return the (possibly changed) action to
continue, or `null` to drop it. <sub>src/server/aio-types.ts</sub>

### `onAction`

```ts
onAction?: (action: unknown, state: unknown, user?: AioUser) => void
```

Observe-only: called with (action, state, user) before each action is reduced.
<sub>src/server/aio-types.ts</sub>

### `onEffect`

```ts
onEffect?: (effect: unknown, state: unknown, user?: AioUser) => void
```

Observe-only: called with (effect, state, user) before each effect runs.
<sub>src/server/aio-types.ts</sub>

### `onConnect`

```ts
onConnect?: (user?: AioUser) => void
```

Called with the user when a WebSocket client connects.
<sub>src/server/aio-types.ts</sub>

### `onDisconnect`

```ts
onDisconnect?: (user?: AioUser) => void
```

Called with the user when a WebSocket client disconnects (not for the
Unix-socket transport). <sub>src/server/aio-types.ts</sub>

### `onStart`

```ts
onStart?: (app: AioApp) => void | Promise<void>
```

Runs once after boot, when cell methods are callable — seed data, start a timer.
<sub>src/server/aio-types.ts</sub>

### `fatalOnStart`

```ts
fatalOnStart?: boolean
```

`true`: a throw or rejection from `onStart` ends the process with exit code 1
instead of leaving a half-started app running (under `libraryMode`, the app is
closed instead). <sub>src/server/aio-types.ts</sub>

### `onStopping`

```ts
onStopping?: () => void | Promise<void>
```

Stop YOUR OWN producers (timers, feeds) at shutdown — it runs before dispatch
closes, so a final write from here still lands.
<sub>src/server/aio-types.ts</sub>

### `onStop`

```ts
onStop?: () => void | Promise<void>
```

Awaited at shutdown, after the cells' `onDestroy`, before the logger closes —
`log.*` still works here. <sub>src/server/aio-types.ts</sub>

### `onError`

```ts
onError?: (error: AioError) => void
```

Receives every `AioError` aio reports — errors, warnings, a method's refusal
(`err.context.rejected`). <sub>src/server/aio-types.ts</sub>

### `onRestore`

```ts
onRestore?: (state: unknown) => unknown
```

`(state) => state | void`, once at boot after restore, migrations and each
cell's `onRestore`. <sub>src/server/aio-types.ts</sub>

### `logging`

```ts
logging?: boolean | LogConfig
```

Structured logging — app.log (narrative), debug.log (all), error.log (errors),
warning.log (warnings), perf.log (violations).
<sub>src/server/aio-types.ts</sub>

### `diagnostics`

```ts
diagnostics?: DiagnosticsConfig
```

Diagnostics module — state diffs, action log, checkpoint, crash handler.
<sub>src/server/aio-types.ts</sub>

### `dispatchStorm`

```ts
dispatchStorm?: boolean | StormConfig
```

Dispatch-storm guard — warns when one action type sustains a runaway dispatch
rate (default: >200/s for 5s), naming the feedback loop instead of leaving
downstream symptoms (log churn, perf noise, starved server).
<sub>src/server/aio-types.ts</sub>

### `onCheckpointRestore`

```ts
onCheckpointRestore?: (checkpoint: CheckpointData) => Record<string, unknown> | null
```

Callback when a diagnostics checkpoint is found on startup.
<sub>src/server/aio-types.ts</sub>

## aio/air

`import { … } from "aio/air"` — hooks, components and helpers for the UI. Guide:
[AIR](../ui/air-setup.md), [React hooks](../ui/react.md).

### `afterRender`

```ts
afterRender(fn: () => void): void
```

Register a callback to run after the current render cycle commits to the DOM.
<sub>src/air/renderer-flush.ts</sub>

### `batch`

```ts
batch(fn: () => void): void
```

Group multiple signal writes into one flush — subscribers notified once at the
end. <sub>src/state/signal.ts</sub>

### `collectHead`

```ts
collectHead(key?: object): string
```

The `<head>` markup the components of a server render asked for — `<title>`,
`<meta>` and `<link>` tags, escaped, each marked `data-aio-head` so the client
takes them over on hydration. <sub>src/air/head.ts</sub>

```ts
const body = renderToString(<App />);
const head = collectHead(); // after the body: render is sync, so it is known
// collectHead() returns MARKUP; collectCss() returns CSS, so it needs a
// <style> around it — bare, a browser treats it as text and applies none.
return `<!doctype html><html><head>${head}<style>${collectCss()}</style>` +
  `</head><body>${body}</body></html>`;
```

### `computed`

```ts
computed<T>(fn: () => T): Computed<T>
```

Create a derived signal that recomputes when its dependencies change.
<sub>src/state/signal.ts</sub>

### `connectAioDevTools`

```ts
connectAioDevTools(): DevToolsHandle
```

Connect AIO DevTools. Returns a handle for reading component tree and render
events. <sub>src/diagnostics/devtools.ts</sub>

```ts
const devtools = connectAioDevTools();
// Read devtools.tree for component hierarchy
// Read devtools.renders for recent re-render events
```

### `connectReduxDevTools`

```ts
connectReduxDevTools(): void
```

Connect state changes to the Redux DevTools browser extension (state tree,
action history, diffs). <sub>src/browser/protocol-devtools.ts</sub>

### `createContext`

```ts
createContext<T>(defaultValue: T): Context<T>
```

Create a context with a default value. <sub>src/air/renderer-context.ts</sub>

### `Defer`

```ts
Defer(props: DeferProps): VNode | null
```

Trigger-based lazy loading — renders a placeholder until the trigger fires
(viewport visibility, idle, hover, interaction, or a timer), then loads and
mounts the component. <sub>src/air/defer.ts</sub>

```tsx
<Defer
  trigger="viewport"
  load={() => import("../Chart.tsx")}
  placeholder={<Spinner />}
/>;
```

### `disconnectReduxDevTools`

```ts
disconnectReduxDevTools(): void
```

Disconnect from the Redux DevTools extension.
<sub>src/browser/protocol-devtools.ts</sub>

### `effect`

```ts
effect(fn: () => void | CleanupFn): CleanupFn
```

Run a side-effect that re-executes when its tracked signals change; returns a
dispose function. <sub>src/state/signal.ts</sub>

### `ErrorBoundary`

```ts
ErrorBoundary: unknown;
```

Error boundary — catches render errors in children, renders fallback.
<sub>src/air/vdom-types.ts</sub>

### `fade`

```ts
fade(_node, opts): unknown
```

Fade opacity 0↔1. <sub>src/air/transition.ts</sub>

### `Fragment`

```ts
Fragment: unknown;
```

Fragment sentinel — groups children without adding a wrapper DOM element.
<sub>src/air/vdom-types.ts</sub>

### `h`

```ts
h(tag: string | typeof Fragment | typeof ErrorBoundary | typeof Portal | typeof Suspense | ComponentFn, props: Record<string, unknown> | null, ...rawChildren): VNode
```

Create a virtual DOM node — the JSX factory function for AIO components.
<sub>src/air/vdom-create.ts</sub>

### `hydrate`

```ts
hydrate(root: any, App: ComponentFn): MountHandle
```

Attach to existing server-rendered DOM without re-creating elements.
<sub>src/air/renderer-hydrate.ts</sub>

### `isConnectionDegraded`

```ts
isConnectionDegraded(): boolean
```

Returns true when the offline action queue is >80% full — UI can use this to
show a "reconnecting / slow connection" indicator.
<sub>src/browser/browser-air-transport.ts</sub>

### `island`

```ts
island<M>(config: IslandConfig<M>): ComponentFn
```

Mount external framework components into AIR pages. <sub>src/air/island.ts</sub>

### `lazy`

```ts
lazy<P>(loader: () => Promise<{ default }>): ComponentFn
```

Lazy-load a component. Use with Suspense for fallback UI.
<sub>src/air/vdom-lazy.ts</sub>

```ts
const LazyComp = lazy(() => import("../HeavyComponent.ts"));
// h(Suspense, { fallback: h("span", null, "Loading...") }, h(LazyComp, null))
```

### `Link`

```ts
Link({ to, replace, exact, activeClass, activeStyle, children, … }: LinkProps): VNode
```

Anchor that navigates without page reload. <sub>src/air/router.ts</sub>

### `memo`

```ts
memo<P>(Component: (props: P) => unknown, _compare?: (prev: P, next: P) => boolean): (props: P) => unknown
```

No-op in AIR — the renderer has built-in auto-memo via shallow prop comparison.
<sub>src/air/memo.ts</sub>

### `mount`

```ts
mount(root: any, App: ComponentFn): MountHandle
```

Mount a component tree into a DOM element and start the reactive render loop.
<sub>src/air/aio-renderer.ts</sub>

```tsx
import { h, mount } from "aio/air";
const App = () => h("p", null, "hello");
mount(document.getElementById("app")!, App);
```

### `navigate`

```ts
navigate(to: string | number, opts?: { replace? }): void
```

Programmatic navigation. Pass a path (`navigate("/users/42")`, optionally
`{ replace: true }`) or a history delta (`navigate(-1)`).
<sub>src/air/router-core.ts</sub>

### `NavLink`

```ts
NavLink({ activeClass, … }: Omit<LinkProps, "activeClass"> & { activeClass? }): VNode
```

Link with automatic 'active' class. <sub>src/air/router.ts</sub>

### `on`

```ts
on<T>(source: Signal<T> | Computed<T>, fn: (next: T, prev: T) => void): () => void
```

Explicit dependency declaration for effects. <sub>src/state/watch.ts</sub>

```ts
effect(on(count, (next, prev) => { ... }));
```

### `onChange`

```ts
onChange<T>(selector: () => T, fn: ((value: T, previous: T | undefined) => Dispose) | ((value: T, previous: T | undefined) => void), opts?: OnChangeOptions<T>): Dispose
```

Run `fn` whenever `selector()` produces a different value.
<sub>src/air/use-resource.ts</sub>

### `onCleanup`

```ts
onCleanup(fn: () => void): void
```

Register a cleanup callback. - Called in component body: runs on unmount AND
before each re-render. - Called inside onMount(): runs ONLY on unmount (AIO-76
fix). <sub>src/air/renderer-lifecycle.ts</sub>

### `onGlobalKey`

```ts
onGlobalKey(key: string, fn: (e: KeyboardEvent) => void, chord?: KeyChord): void
```

A window/document-level key binding, scoped to this component's lifetime.
<sub>src/air/renderer-lifecycle.ts</sub>

```tsx
onGlobalKey("Escape", () => lightbox.close());
onGlobalKey("k", () => palette.open(), { mod: true });
```

### `onMount`

```ts
onMount(fn: () => void): void
```

Register a callback to run after the component's first render.
<sub>src/air/renderer-lifecycle.ts</sub>

### `onUnmount`

```ts
onUnmount(fn: () => void): void
```

Register a cleanup that runs ONCE, when this component goes away for good.
<sub>src/air/renderer-lifecycle.ts</sub>

```tsx
function NftThumb({ id }: { id: string }) {
  const slot = useRef(queue.take(id));
  onUnmount(() => slot.current.release());
  return <img src={id} />;
}
```

### `onWindowEvent`

```ts
onWindowEvent<K>(type: K, fn: (e: WindowEventMap[K]) => void, options?: AddEventListenerOptions): void
onWindowEvent(type: string, fn: (e: Event) => void, options?: AddEventListenerOptions): void
```

Listen for an event on the window this component is actually mounted in, for as
long as it is mounted. <sub>src/air/renderer-lifecycle.ts</sub>

```tsx
onWindowEvent("mousemove", (e) => setPos(e.clientX, e.clientY));
onWindowEvent("resize", () => remeasure());
```

### `Outlet`

```ts
Outlet(): VNode | null
```

Renders the matching child route inside a parent Route's element.
<sub>src/air/router.ts</sub>

### `page`

```ts
page<K>(current: K, routes: Record<K, (props: Record<string, never>) => unknown>): VNode | null
```

Renders the component matching the current page key.
<sub>src/air/router.ts</sub>

### `Portal`

```ts
Portal: unknown;
```

Portal — renders children into a target DOM node outside the component
hierarchy. <sub>src/air/vdom-types.ts</sub>

### `reactIsland`

```ts
reactIsland<P>(config: ReactIslandConfig<P>): ComponentFn
```

Mount a React component as an island inside an AIR page.
<sub>src/air/react-island.ts</sub>

```tsx
import { reactIsland } from "aio/air";
// Your loaders — import() of your own React modules:
declare const loadChartComponent: Parameters<
  typeof reactIsland
>[0]["component"];
declare const loadReact: Parameters<typeof reactIsland>[0]["react"];
declare const loadReactDom: Parameters<typeof reactIsland>[0]["reactDomClient"];
declare const market: { prices: number[] };
const PriceChart = reactIsland({
  component: loadChartComponent, // your React component module
  react: loadReact, // your react runtime loader
  reactDomClient: loadReactDom, // your react-dom/client loader
  props: () => ({ series: market.prices }), // reactive from a cell
});
// then: <PriceChart />
```

### `Redirect`

```ts
Redirect({ to, replace }: { to; replace? }): null
```

Navigates to `to` on mount. Replace=true by default (no history entry).
<sub>src/air/router.ts</sub>

### `renderToStream`

```ts
renderToStream(vnode: VNode | string | number | null, key?: object): AsyncGenerator<string, void, unknown>
```

Streaming SSR — async generator yielding HTML chunks.
<sub>src/air/ssr-stream.ts</sub>

### `renderToString`

```ts
renderToString(vnode: VNode | string | number | null): string
```

Render a VNode tree to an HTML string (no DOM required).
<sub>src/air/vdom-ssr.ts</sub>

### `requestNotificationPermission`

```ts
requestNotificationPermission(): Promise<"default" | "granted" | "denied" | "unsupported">
```

Ask the user, from a click handler. Resolves to the browser's answer, or
`"unsupported"` where there is no Notification API.
<sub>src/browser/desktop-notify.ts</sub>

### `resource`

```ts
resource<S, T>(source: () => S, fetcher: (source: S, opts: { signal }) => Promise<T>): Resource<T>
```

Async data as signals. Re-fetches when the reactive source changes.
<sub>src/air/resource.ts</sub>

### `Route`

```ts
Route({ path, index, element, children }: RouteProps): VNode | null
```

Renders element when path matches. Nest inside other Routes for layouts with
Outlet. <sub>src/air/router.ts</sub>

### `routePath`

```ts
routePath: Signal<string>;
```

Current pathname as a signal — auto-tracked in AIR components.
<sub>src/air/router-core.ts</sub>

### `routeSearch`

```ts
routeSearch: Signal<URLSearchParams>;
```

Current query string as a `URLSearchParams` signal.
<sub>src/air/router-core.ts</sub>

### `scale`

```ts
scale(_node, opts): unknown
```

Scale from 0 to 1. <sub>src/air/transition.ts</sub>

### `setDevMode`

```ts
setDevMode(enabled: boolean | "auto"): void
```

Enable dev-mode warnings (excessive re-renders, also enables VDOM key warnings).
<sub>src/air/aio-renderer.ts</sub>

### `Show`

```ts
Show<T>(props: { when; fallback?; children? }): VNode | null
```

Conditional renderer with TypeScript narrowing. <sub>src/air/show.ts</sub>

### `signal`

```ts
signal<T>(initial: T, nameOrOpts?: string | { name? }): Signal<T>
```

Create a reactive value. Reads auto-track (`count()` / `count.value` /
`count.get()` are one tracked read); write with `set`/`update`.
<sub>src/state/signal.ts</sub>

### `SignIn`

```ts
SignIn(props?: SignInProps): VNode
```

Drop-in login/signup form (+ TOTP step). Renders nothing extra when the user is
already signed in — pair with useUser() to branch the app.
<sub>src/browser/browser-auth-ui.ts</sub>

### `signOut`

```ts
signOut(): Promise<void>
```

Sign the current session out and reload into the anonymous shell.
<sub>src/browser/browser-auth-ui.ts</sub>

### `slide`

```ts
slide(_node, opts): unknown
```

Slide vertically via translateY. <sub>src/air/transition.ts</sub>

### `Suspense`

```ts
Suspense: unknown;
```

Suspense — shows fallback while lazy children are loading.
<sub>src/air/vdom-types.ts</sub>

### `trackedMemo`

```ts
trackedMemo<K, V>(compute: (key: K) => V, opts?: { key?; max? }): (arg: K) => V
```

A cache whose HITS still subscribe — the correct version of the memo every app
hand-rolls wrong. <sub>src/state/signal.ts</sub>

```ts
// module scope — shared across every component that asks
const visibleRows = trackedMemo((filter: string) =>
  accounts.list.filter((a) => a.name.includes(filter))
);

function Panel({ filter }: { filter: string }) {
  return <List rows={visibleRows(filter)} />; // hit or miss, it subscribes
}
```

### `Transition`

```ts
Transition(props: TransitionProps): VNode | null
```

Wrap a conditionally rendered child with enter/exit animations.
<sub>src/air/transition-component.ts</sub>

```tsx
<Transition enter={fade} exit={fade}>
  {show.value && <Modal />}
</Transition>;
```

### `TransitionGroup`

```ts
TransitionGroup(props: TransitionGroupProps): VNode
```

Animate list additions, removals, and reordering.
<sub>src/air/transition-group.ts</sub>

```tsx
<TransitionGroup enter={fade} exit={fade} flip>
  {items.value.map((item) => <div key={item.id}>{item.text}</div>)}
</TransitionGroup>;
```

### `untrack`

```ts
untrack<T>(fn: () => T): T
```

Read signals without tracking — reads inside fn() will NOT create subscriptions
in the current tracking context. <sub>src/state/signal.ts</sub>

### `useAio`

```ts
useAio<S>(): ReturnType<typeof _airUseAio>
```

AIR useAio -- full global state, signal-based.
<sub>src/browser/browser-air-hooks.ts</sub>

### `useCallback`

```ts
useCallback<T>(fn: T, _deps?: unknown[]): T
```

React-compatible `useCallback` — a STABLE identity across renders, which is the
thing it is for. <sub>src/air/compat.ts</sub>

### `useConnected`

```ts
useConnected(): boolean
```

AIR useConnected -- signal-based connection status.
<sub>src/browser/browser-air-hooks.ts</sub>

### `useContext`

```ts
useContext<T>(ctx: Context<T>): T
```

Read the current value of a context. Must be called inside a component.
<sub>src/air/renderer-context.ts</sub>

### `useContextSelector`

```ts
useContextSelector<T, R>(ctx: Context<T>, selector: (value: T) => R): R
```

Select a slice of context. The component re-renders only when the selected value
changes (`Object.is`), not when an unselected field of the context does.
<sub>src/air/renderer-context.ts</sub>

### `useDimensions`

```ts
useDimensions(): DimensionsState
```

Track an element's dimensions reactively via ResizeObserver.
<sub>src/air/dimensions.ts</sub>

### `useEffect`

```ts
useEffect(fn: () => void | (() => void), deps?: unknown[]): void
```

React's `useEffect`: runs after mount, re-runs when a dep changes (`Object.is`),
cleanup before each re-run and on unmount. <sub>src/air/compat.ts</sub>

### `useFieldArray`

```ts
useFieldArray<T>(initial?: T[]): FieldArrayState<T>
```

Create a dynamic array field. Call outside the component body.
<sub>src/air/form.ts</sub>

```ts
const items = useFieldArray([{ name: "Item 1" }]);
const App = () =>
  h(
    "ul",
    null,
    ...items.items.map((item, i) => h("li", { key: i }, item.name)),
  );
```

### `useForm`

```ts
useForm<T>(config: { [K in keyof T]: { initial; rules?; asyncRules?; debounceMs? } }, options?: FormOptions<T>): FormState<T>
```

A form: one signal-backed `FieldState` per field, plus validity, dirtiness,
values and a `bind()` helper for wiring an `<input>`. <sub>src/air/form.ts</sub>

### `useHead`

```ts
useHead(input: HeadInput): void
```

Own part of `<head>` for as long as this component is mounted.
<sub>src/air/head.ts</sub>

```tsx
function Post({ id }: { id: string }) {
  const post = blog.posts[id];
  useHead({
    title: `${post.title} — My Blog`,
    meta: [{ name: "description", content: post.summary }],
    link: [{ rel: "canonical", href: `https://example.com/p/${id}` }],
  });
  return <article>…</article>;
}
```

### `useId`

```ts
useId(): string
```

Generate a unique, SSR-stable ID. Persists across re-renders.
<sub>src/air/renderer-lifecycle.ts</sub>

### `useInterval`

```ts
useInterval(cb: () => void, ms: number, active?: boolean): void
```

Run `cb` every `ms` milliseconds until the component unmounts — a managed
`setInterval` with automatic cleanup. <sub>src/air/raf.ts</sub>

```ts
function Music() {
  useInterval(() => audio.step(), 150, game.screen === "playing");
  return null;
}
```

### `useLocal`

```ts
useLocal<T>(initial: T): UseLocalResult<T>
```

Component-local reactive state — the signal you would otherwise create by hand,
scoped to this instance and disposed with it. <sub>src/adapters/air.ts</sub>

### `useMemo`

```ts
useMemo<T>(fn: () => T, _deps?: unknown[]): T
```

React's `useMemo`: recomputes when a dep changes (`Object.is`, length first).
<sub>src/air/compat.ts</sub>

### `useNavigate`

```ts
useNavigate(): (to: string | number, opts?: { replace? }) => void
```

Returns the navigate function. <sub>src/air/router.ts</sub>

### `useOptimistic`

```ts
useOptimistic<T, A>(passthrough: T, updateFn: (current: T, optimistic: A) => T): [T, (action: A) => void]
```

Optimistic UI hook. Shows an immediate update while an async action runs, then
reverts to the real state when it completes (success or failure).
<sub>src/air/renderer-lifecycle.ts</sub>

### `useProjection`

```ts
useProjection<T>(fn: () => T, _deps?: unknown[]): T
```

Derives state from a transformation, preserving element-level references.
<sub>src/browser/browser-air-hooks.ts</sub>

### `useRaf`

```ts
useRaf(cb: (time: number, delta: number) => void, active?: boolean): void
```

Run `cb` on every animation frame until the component unmounts — a managed
`requestAnimationFrame` loop with automatic cleanup (no manual
cancelAnimationFrame bookkeeping). <sub>src/air/raf.ts</sub>

```ts
function Canvas() {
  const ref = useRef<HTMLCanvasElement>(null!);
  useRaf((_t, dt) => {
    const ctx = ref.current?.getContext("2d");
    if (ctx) draw(ctx, cycle.phase, dt); // live cell read
  });
  return <canvas ref={ref} />;
}
```

### `useRef`

```ts
useRef<T>(initial: T): { current }
```

Persist a mutable ref across renders. Does not trigger re-render on mutation.
<sub>src/air/renderer-lifecycle.ts</sub>

### `useResource`

```ts
useResource<T>(cfg: UseResourceConfig<T>): ResourceHandle<T>
```

Hold a keyed resource — something with an open and a close, where the close
matters. <sub>src/air/use-resource.ts</sub>

```ts
const cam = useResource({
  key: () => settings.cameraId,
  open: (id, { signal }) => openCamera(id, signal),
  close: (stream) => stream.getTracks().forEach((t) => t.stop()),
});
```

### `useRoute`

```ts
useRoute<P>(pattern?: string): RouteState<P>
useRoute<S>(pattern: S): RouteState<RouteParams<S>>
```

Current route state -- reads routePath/routeSearch signals (auto-tracked by
AIR). <sub>src/air/router.ts</sub>

### `useSignal`

```ts
useSignal<T>(initial: T): Signal<T>
```

Creates a component-scoped signal. Auto-GC'd on unmount.
<sub>src/air/renderer-lifecycle.ts</sub>

```tsx
// Module-level UI state (survives unmount)
const ui = signal({ collapsed: [] as string[] }, "sidebar");

function Sidebar() {
  void ui.value; // subscribe parent
  return <TreeRow collapsed={ui.value.collapsed} />;
}
```

### `useSpring`

```ts
useSpring(config?: SpringConfig): SpringValue
```

Animate a numeric value with spring physics. <sub>src/air/animation.ts</sub>

```ts
const x = useSpring({ initial: 0, stiffness: 200, damping: 20 });
x.to(100); // animates to 100
// In component: h("div", { style: { transform: `translateX(${x.value}px)` } })
```

### `useState`

```ts
useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void]
```

React's `useState`, signal-backed: `const [v, setV] = useState(0)`.
<sub>src/air/compat.ts</sub>

### `useTimeTravel`

```ts
useTimeTravel(): { entries; index; paused; undo; redo; goto; pause; resume } | null
```

Signal-based hook exposing the time-travel debugger: action history plus
undo/redo/goto/pause controls. <sub>src/air/time-travel-air.ts</sub>

### `useUser`

```ts
useUser(): AioUser | null | undefined
```

Reactive current user (auto-tracked): kicks off one /me fetch, then keeps
components in sync with login/logout. <sub>src/browser/browser-auth-ui.ts</sub>

### `useVirtualList`

```ts
useVirtualList<T>(config: VirtualListConfig<T>): VirtualListState<T>
```

Create a virtual scrolling list. Call outside the component body.
<sub>src/air/virtual-list.ts</sub>

```ts
const vlist = useVirtualList({
  items: bigArray,
  itemHeight: 40,
  containerHeight: 400,
});

const App = () =>
  h(
    "div",
    { style: vlist.containerStyle, onScroll: vlist.onScroll },
    h(
      "div",
      { style: vlist.innerStyle },
      ...vlist.visible.map(({ item, index, offset }) =>
        h("div", {
          key: index,
          style: { position: "absolute", top: `${offset}px`, height: "40px" },
        }, item.name)
      ),
    ),
  );
```

### `watch`

```ts
watch<T>(source: Signal<T> | Computed<T>, fn: (next: T, prev: T | undefined) => void, opts?: WatchOptions): () => void
```

Watch a signal or computed, calling `fn(next, prev)` whenever it changes.
<sub>src/state/watch.ts</sub>
