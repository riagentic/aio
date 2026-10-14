# Run any aio app from source — one line

Point one command at an aio app and it takes care of everything between a source
checkout and a running production build: installing Deno, the framework and `am`
if they're missing, cloning the repo if you gave it a link, repairing the
checkout (`am fix`), building the app's default target, and launching the
artifact. No questions asked.

```sh
# You are inside an aio app repo → production build + run:
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/run.sh | sh

# You have a repo link → clone + set up + build + run:
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/run.sh | sh -s owner/repo
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/run.sh | sh -s https://github.com/owner/repo

# Dev server instead of a production build:
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/run.sh | sh -s -- --dev
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/riagentic/aio/main/run.ps1 | iex
# with arguments:
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/riagentic/aio/main/run.ps1))) -Git owner/repo
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/riagentic/aio/main/run.ps1))) -Dev
```

## What it does, in order

1. **Prerequisites** — `git` must exist; then the standard installer runs
   **every time**: Deno is installed if missing, and the framework + `am` are
   installed or **updated in place** (`~/.local/lib/aio`, checked out at the
   last tagged release — so the one-liner never runs an old `am`). A checkout
   that is being worked in (on a branch, or with local changes) is never moved.
   The app still builds with the version it pins; updating `am` moves no app.
2. **Clone** — with `--git <url>` (or a bare `owner/repo` / URL argument) the
   repo is cloned into `./<name>`; an existing clone is fast-forwarded.
3. **Sanity** — the directory must be an aio app (an `"aio"` import or an
   `aioVersion` pin in `deno.json`); anything else fails loud with the fix.
4. **Repair** — `am fix` runs: import-path, env, electron and config repairs,
   the same repair loop you'd run by hand on a fresh clone.
5. **Build** — `deno task compile` (what `am compile` runs too): the app's
   DEFAULT target, production build. (An app without the scaffolded task gets
   the builder invoked directly.)
6. **Install** — the artifact the build produced is found **by timestamp, never
   by name** (so this script can't drift from the framework's naming rules) and
   copied to where it outlives the checkout: `~/app/<name>/` with a menu entry
   on Linux, `%LOCALAPPDATA%\Programs\<name>\` with a Start-menu shortcut on
   Windows
   ([the layout](../persistence/where-files-live.md#the-program-vs-its-data)).
7. **Run** — the installed artifact is executed. AppImages run with
   `APPIMAGE_EXTRACT_AND_RUN=1`, so no FUSE is needed — containers included.

**macOS:** a desktop (Electron) app is installed as its bundle —
`~/app/<name>/versions/<version>/<Title>.app`, linked from
`~/app/<name>/<Title>.app` — and opened with `open`. `run.sh` writes no
`.desktop` entry there and does not touch `/Applications`; the app offers that
move itself once it is up.

## Flags

| `run.sh`       | `run.ps1`    | effect                                          |
| -------------- | ------------ | ----------------------------------------------- |
| `--dev`        | `-Dev`       | run the dev server (`deno task dev`) instead    |
| `--git <url>`  | `-Git <url>` | clone first (`run.sh`: also a bare argument)    |
| `--no-run`     | `-NoRun`     | build and install only; print the artifact path |
| `--no-install` | `-NoInstall` | run it from `dist/`, install nothing            |
| `-- <args…>`   | `<args…>`    | passed to the app itself                        |

Environment: `AIO_HOME` / `AIO_REPO` / `AIO_BRANCH` work exactly as they do for
`install.sh`; `AIO_RAW` overrides where `install.sh` itself is fetched from;
`AIO_INSTALL` points at a local `install.sh` (offline use, tests).

## Notes

- Re-running is cheap: prerequisites are skipped when present, the clone is
  fast-forwarded, and the build re-runs from warm caches.
- The e2e for this flow lives in `tests/run-sh-e2e.test.ts` (part of
  `deno task test:onboard`): a real scaffold, a real `git clone`, a real
  compile, and a health-checked run of the produced binary.
- `run.ps1` mirrors the contract on Windows. No gate executes it: its text is
  checked (`tests/run-sh.test.ts`) and its pure logic runs under PowerShell 7 on
  Linux; what it does on a real Windows — installing Deno, shortcuts, replacing
  a running `.exe` — is unverified. See
  [aio on Windows and macOS](../basics/windows-macos.md).
