# Examples

New project? Don't copy these — run **`am create my-app`** (see the root
README), which is where the templates actually live (`src/am/am-cmd-create.ts`).
These are CI fixtures: the same two apps the `--template=…` flags scaffold, kept
here so they are runtime-tested (`tests/examples.test.ts`), UI-tested
(`tests/examples-ui.test.ts`), lint-gated (`tests/examples-lint.test.ts`) and
type-checked on every run. They are not the source the scaffold reads, and
calling them "the canonical template source" was how they drifted a generation
behind it in the first place.

## Templates (what `am create` scaffolds)

| Dir        | `am create` flag  | What                                        |
| ---------- | ----------------- | ------------------------------------------- |
| `counter/` | _(default)_       | Smallest full app — one cell, one component |
| `todo/`    | `--template=todo` | Todo list — list state, `useLocal` input    |

## Worked example

| Dir         | What                                                                      |
| ----------- | ------------------------------------------------------------------------- |
| `contacts/` | End-to-end CRUD — cell state ↔ `db:` table, validation, selectors         |
| `disk/`     | Folder-size scanner — the filesystem, subprocesses, and long-running work |
| `updates/`  | Shipping to users — an update banner, a blocked release, problem reports  |
| `cli-tool/` | A rich CLI on `aio/cli` — one binary is the server and its commands       |

`contacts/` is the one to read first: it is the whole integration in ~120 lines
— one array in cell state, one `db:` table of the same name kept in step with
it, validation that refuses in plain code (the caller's `await` rejects with the
reason), parameterized selectors, and a UI that creates, edits and deletes with
no transport code anywhere. It also turns on `checkIntegrityOnBoot`, which is
the honest setting for data a user would miss. Tested in
`tests/example-contacts.test.ts`.

`disk/` is the one to read when your app has to leave the process: it walks the
real filesystem and opens the desktop file manager, both from cell methods, with
the Deno-only half in `disk.server.ts` behind a dynamic import
([the rule](../docs/build/imports.md#2-server-only-code-name-it-serverts-and-dynamic-import-it)).
It is also the reference for
[long-running server work](../docs/state/methods.md#long-running-server-work) —
`cancelOn: { open: ["self", "disk:stop"] }` (a new folder supersedes the scan
still running, Cancel stops it), a `scanning` flag, and the rule that a
superseded run never writes. Tested in `tests/example-disk.test.ts`.

`updates/` is the one to read when your app has to reach people who are not you.
Two config lines (`updates: "<url>"`, `feedback: true`) and a component that
renders from cell state: an update offer with its release notes, the separate
**blocked** case (a newer version that cannot migrate this install's data —
shown with the reason and deliberately no button), download progress, and a
"report a problem" path. The point of reading it is what is NOT there — no
transport, no polling, no version comparison, no dialog framework. See
[updates](../docs/deploy/updates.md) and
[problem reports](../docs/debugging/feedback.md).

`cli-tool/` is the one to read when the product is a command line. One entry,
two roles: `todo serve` runs the aio server that owns the list (headless,
persisted), and `todo add|done|list [--watch|--json]` connect to it. Flags with
generated `--help` and refused typos, a table, a live `--watch` view that
degrades to plain lines on a pipe, `--json` for scripts, and exit codes a shell
can trust — all from [`aio/cli`](../docs/clients/cli-toolkit.md). Tested from
source and as a compiled `cli` binary in `tests/cli-toolkit-build.test.ts`.

## Target build smoke fixtures

`examples/targets/<dir>` — minimal per-target apps kept purely as **CI
build/boot smoke fixtures** (not learn-from examples), so every compile target
stays honest:

Each one builds with `deno task compile` (its own default target) or
`deno task build` (every target in its `deno.json` → `build.targets`) — the
alpha52 vocabulary, the same two tasks `am create` scaffolds. The
`build.targets` name in the third column is what `deno task build --targets=…`
accepts.

| Dir                | `build.targets`   | Interface                                 |
| ------------------ | ----------------- | ----------------------------------------- |
| `browser/`         | `browser`         | server + AIR UI (JSX, no React)           |
| `browser-remote/`  | `server-app`      | exposed server (`dev:expose`)             |
| `electron/`        | `electron`        | desktop window + embedded server          |
| `electron-remote/` | `electron-client` | thin client, connect page                 |
| `cli/`             | `cli`             | headless server + `deno task client` REPL |
| `cli-remote/`      | `cli-client`      | thin WS client (`src/client.ts`)          |
| `android/`         | `android`         | APK — standalone WebView runtime          |
| `android-remote/`  | `android-client`  | thin client APK, connect page             |
| `service/`         | _(none)_          | headless daemon + systemd unit            |
| `service-remote/`  | `server`          | exposed headless daemon                   |

Notes:

- `service/` is the one fixture the fleet vocabulary cannot name: every named
  service target (`server`, `server-app`) carries `--remote`, which is exactly
  what makes it `service-remote`. It keeps a single-target `compile` and
  declares no `build.targets`, rather than pretending to be its own twin.
- Electron targets need the runtime once: `deno task install:electron` — which
  runs aio's installer (`src/electron-install.ts`). It is NOT
  `deno install --allow-scripts=npm:electron`: that command exits 0 having
  skipped the lifecycle script, leaving no `dist/`, and the build then advises
  running the task that just did nothing. Both examples shipped the broken form
  until it was caught here.
- Android targets need `$ANDROID_HOME` + JDK + Gradle (see
  `docs/build/targets.md`).
- Remote-server examples authenticate when run with `--expose` — token is
  printed on boot, or pin one via the `users:` hint in `src/app.ts`.
