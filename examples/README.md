# Examples

New project? Don't copy these — run **`am create my-app`** (see the root
README). The two apps below are exactly what `am create --template=…` scaffolds;
they live here as the canonical template source + CI fixtures, all
runtime-tested (`tests/examples.test.ts`), UI-tested
(`tests/examples-ui.test.ts`), and type-checked in CI.

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

## Target build smoke fixtures

`examples/targets/<dir>` — minimal per-target apps kept purely as **CI
build/boot smoke fixtures** (not learn-from examples), so every compile target
stays honest:

| Target                    | Dir                | Interface                                 |
| ------------------------- | ------------------ | ----------------------------------------- |
| `compile:browser`         | `browser/`         | server + React UI                         |
| `compile:browser:remote`  | `browser-remote/`  | exposed server (`dev:expose`)             |
| `compile:electron`        | `electron/`        | desktop window + embedded server          |
| `compile:electron:remote` | `electron-remote/` | thin client, connect page                 |
| `compile:cli`             | `cli/`             | headless server + `deno task client` REPL |
| `compile:cli:remote`      | `cli-remote/`      | thin WS client (`src/client.ts`)          |
| `compile:android`         | `android/`         | APK — standalone WebView runtime          |
| `compile:android:remote`  | `android-remote/`  | thin client APK, connect page             |
| `compile:service`         | `service/`         | headless daemon + systemd unit            |
| `compile:service:remote`  | `service-remote/`  | exposed headless daemon                   |

Notes:

- Electron targets need the runtime once: `deno task install:electron`.
- Android targets need `$ANDROID_HOME` + JDK + Gradle (see
  `docs/build/targets.md`).
- Remote-server examples authenticate when run with `--expose` — token is
  printed on boot, or pin one via the `users:` hint in `src/app.ts`.
