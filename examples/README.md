# Examples

Run any example: `cd <dir> && deno task dev`. Build it: `deno task compile`. All
examples are runtime-tested (`tests/examples.test.ts`), UI-functionally tested
(`tests/examples-ui.test.ts` — real clicks/typing via the AIR renderer), and
type-checked (`deno task check`) in CI.

## Apps

| Dir           | What                                        |
| ------------- | ------------------------------------------- |
| `counter/`    | Smallest full app — one cell, one component |
| `todo/`       | Todo list — list state, `useLocal` input    |
| `playground/` | Browser playground page                     |

## Compile targets

One working example per target (`examples/targets/<dir>`) — same counter app,
wired per target exactly like `aio create` scaffolds it:

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
