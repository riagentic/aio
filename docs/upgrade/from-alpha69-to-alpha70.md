# Upgrading from alpha69 to alpha70

**This is the last release that breaks compatibility.** Every alias and
duplicate import path that had been "deprecated through beta" is retired, one
never-read option is removed, and a handful of behaviours got stricter. Run
`aiol --safe-fix` in the app: it rewrites every retired spelling and import path
below. `am pin` refuses to move an unfixed app to alpha70 and names the
file:line; the escape hatch is `am pin v1.0.0-alpha69 && am fix`.

## Breaking — what `aiol --safe-fix` rewrites for you

| old                                                | now                                             |
| -------------------------------------------------- | ----------------------------------------------- |
| `CellAccess`, `ServerFnAccess`                     | `Access`                                        |
| `ExtractState<typeof c>`                           | `StateOf<typeof c>`                             |
| `type Action` from `aio/air`                       | `NodeAction`                                    |
| `schedule.blocking(…)`                             | `blocking(…)` from `aio`                        |
| `connectDevTools` / `disconnectDevTools`           | `connectReduxDevTools` / `disconnect…`          |
| `schedule.poll({ backoff })`                       | `{ factor }`                                    |
| `schedule.backoff/poll(id, attempt, opts, action)` | `(id, attempt, action, opts)`                   |
| `cell({ ui })`, `cellDefaults: { ui }`             | `visible`                                       |
| `listensTo: [a.m]`                                 | `listensTo: { onM: a.m }` (advised)             |
| deno.json `"target"`                               | `"client"` (`am fix` rewrites)                  |
| `testgen`                                          | `testGen`                                       |
| `lint` from `aio/extras`                           | `checkCells`                                    |
| `createDB`… from `aio/db`                          | from `aio/server` (`aio/db` = types)            |
| ship family from `aio/build`                       | from `aio/ship`                                 |
| `appDirs`, updates runtime from `aio/testing`      | `aio/server`, `aio/updates`                     |
| `testComponent`/`setDocument` from `aio/air`       | `aio/testing`                                   |
| `testCell`/`TestContext` from `aio`                | `aio/testing`                                   |
| aiol `lint()`/`Report`                             | `lintProject()`/`LintReport`                    |
| `am new/update/ls/log/tt/release`                  | `add/upgrade/instances/logs/timetravel/publish` |
| `memory.gcStressRatio`                             | delete it (never read)                          |

Config-read aliases (`ui:`, `cellDefaults.ui`, `listensTo: […]`, `target`)
refuse in dev and log at error level in prod while still honouring the old key,
so a production app never diverges silently — but it says so on every boot until
fixed.

## Stricter — read if it bites

- **Shape drift refuses in dev.** A persisted cell whose on-disk shape drifted
  without an `onMigrate` used to warn forever; dev now refuses to boot with the
  cell, the keys and the fix (`version` + `onMigrate`, or a `persist` filter).
  Prod keeps the warning.
- **Dispatch during shutdown.** New input while the app is closing is
  `DISPATCH_DRAINING` (in-flight writes still land); after the seal it is
  `DISPATCH_CLOSED`. A bound async call no longer starts new work during the
  drain.
- **Sanitizers stay on in every test.** A `sanitizeOps/Resources: false` now
  needs an `// aio-ok:` reason; `check:sanitizers` ceiling is 0.
- **A memory config key that does not exist is refused by name.**
- **Protocol v3.** The wire gained the `append` patch op (a grown string ships
  as its suffix). A client built against alpha69 is refused at the handshake
  with the reason named — rebuild the app once (`deno task build`); the
  self-update path handles it for installed apps.

## What to do

- **You can build for iPhone.** Add `"ios-client"` to `build.targets` (and,
  optionally, `"ios": { "bundleId": "com.example.app" }`) and `deno task build`
  writes `dist/ios/<name>-ios-client/App.xcodeproj` — open it in Xcode, pick
  your team, Archive. On a Mac it also builds the simulator app. The client
  connects to your `server`/`server-app` like the Android one.
- **A write through `s` after an async method finished now throws.** A
  `setTimeout`, an event listener or an un-awaited `.then` that assigned through
  the method's state view used to commit silently — persisted, broadcast,
  `ok: true`, no log line. It is refused by name now
  (`[cell:method] write after the method finished: s.count …`), in dev, prod and
  every harness. If a test or an app starts throwing this, the fix is the one
  the message names: await the work inside the method, or dispatch a method from
  the callback.
- **`am dispatch` no longer says `ok` for a typo or a failed method.** A bare
  type (`incremnt`) is a 404 naming the nearest real method; a method that threw
  after its first `await` is the route's error. Scripts that only checked the
  exit code were passing on both.
- **Built bundles are minified.** `deno task build` now passes `minify` to
  esbuild (the counter app: 309 KB → 145 KB raw, 79 → 52 KB gzipped). If you
  read stack traces from a production bundle, keep a source map beside it.
- **`testUI` and `bootCells` take `cellDefaults` and `localFirst`.** If your
  `aio.run` passes either, pass the same to the harness — it applies them
  exactly as boot does and refuses what boot refuses. Before, an app whose only
  unsafe composition came from its app-level defaults was green under test and
  refused at start.
- **A comment in `deno.json` no longer changes your app's identity.** Three
  readers parsed it with `JSON.parse`, threw on JSONC, and inferred the app id
  from the directory name instead. If an app of yours has a `deno.json` with
  comments and you ever saw `am` "not find" it, or a lock/data dir keyed by the
  directory name, this was why.
- **`am --app=X` targets X or nothing.** With X not running and one other app
  up, `am` used to fall back to the running one after a stderr note — so
  `am dispatch --app=X` mutated Y. The fallback is for a guessed id (the cwd's)
  only.
- **The scaffold's `src/client.ts` takes the server URL as its argument** (no
  more `ws://localhost:8000` default — dev picks a free port) and fails in 10 s
  with the reason when nothing answers.
- **Docs drive `am surface` / `am trigger` with no index.** Index `0` was the
  dev server's reload socket; the index-less form drives the newest UI client.
- **Release gates grew.** `check:release` now builds the Electron package
  (`deno task test:electron`), proves a `cli-client` binary against a `server`
  binary, freezes the count of tests that turn a leak sanitizer off without a
  reason (`check:sanitizers`), and refuses an undocumented CLI flag or `am`
  verb. CI runs the real-browser e2e with a Chrome it installs, and its Deno
  floor is 2.9.0.

## Known and deliberate

- `memory.gcStressRatio` and `renderBudget` are accepted and not read. Both are
  documented as such; their removal is a separate, announced decision.
- `aio/db` still re-exports the runtime values (`createDB`, …) it marked
  deprecated in alpha52; the docs now import them from `aio/server`.

## Retire

| workaround you may have                                                              | fixed in    | what to do now                                                              |
| ------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------- |
| A script that greps `am dispatch` output because the exit code lied on a typo        | **alpha70** | trust the exit code — a bare type is a 404, a failed method is an error     |
| `--key=~/.aio/keys/<app>-release-key.json` typed back into every `am publish`        | **alpha70** | drop it — `publish` finds the key `keygen` wrote; it says which key it used |
| an index typed after `am surface` / `am trigger`, with a retry when 0 was the reload | **alpha70** | drop the index — the newest UI client is the default                        |
| A hard-coded `ws://localhost:8000` in a CLI client because the scaffold had one      | **alpha70** | pass the URL (`deno run -A src/client.ts ws://host:port/ws`)                |
| Comments stripped from `deno.json` so `am` would find the app                        | **alpha70** | put them back — every reader is JSONC-aware                                 |
| `am <cmd> --help \| head -40` to find one command's flags                            | **alpha70** | `am <cmd> --help` prints that command's block                               |
