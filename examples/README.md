# Examples

New project? Don't copy these — run **`am create my-app`** (see the root
README). The two apps below are exactly what `am create --template=…` scaffolds;
they live here as the canonical template source + CI fixtures, all
runtime-tested (`tests/examples.test.ts`), UI-tested (`tests/examples-ui.test.ts`),
and type-checked in CI.

## Templates (what `am create` scaffolds)

| Dir        | `am create` flag       | What                                        |
| ---------- | ---------------------- | ------------------------------------------- |
| `counter/` | *(default)*            | Smallest full app — one cell, one component |
| `todo/`    | `--template=todo`      | Todo list — list state, `useLocal` input    |

## Target build smoke fixtures

`examples/targets/<dir>` — minimal per-target apps kept purely as **CI build/boot
smoke fixtures** (not learn-from examples), so every compile target stays honest:

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
