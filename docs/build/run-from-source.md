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

1. **Prerequisites** — `git` must exist; Deno is installed if missing; the
   framework + `am` are installed via the standard installer if missing
   (`~/.local/lib/aio`, checked out at the last tagged release).
2. **Clone** — with `--git <url>` (or a bare `owner/repo` / URL argument) the
   repo is cloned into `./<name>`; an existing clone is fast-forwarded.
3. **Sanity** — the directory must be an aio app (an `"aio"` import or an
   `aioVersion` pin in `deno.json`); anything else fails loud with the fix.
4. **Repair** — `am fix` runs: import-path, env, electron and config repairs,
   the same repair loop you'd run by hand on a fresh clone.
5. **Build** — `deno task compile`: the app's DEFAULT target, production build.
   (An app without the scaffolded task gets the builder invoked directly.)
6. **Run** — the artifact the build produced is found **by timestamp, never by
   name** (so this script can't drift from the framework's naming rules) and
   executed. AppImages run with `APPIMAGE_EXTRACT_AND_RUN=1`, so no FUSE is
   needed — containers included.

## Flags

| flag          | effect                                            |
| ------------- | ------------------------------------------------- |
| `--dev`       | run the dev server (`deno task dev`) instead      |
| `--git <url>` | clone first (also accepted as a bare argument)    |
| `--no-run`    | build only; print the artifact path               |
| `-- <args…>`  | everything after `--` is passed to the app itself |

Environment: `AIO_HOME` / `AIO_REPO` / `AIO_BRANCH` work exactly as they do for
`install.sh`; `AIO_RAW` overrides where `install.sh` itself is fetched from;
`AIO_INSTALL` points at a local `install.sh` (offline use, tests).

## Notes

- Re-running is cheap: prerequisites are skipped when present, the clone is
  fast-forwarded, and the build re-runs from warm caches.
- The e2e for this flow lives in `tests/run-sh-e2e.test.ts` (part of
  `deno task test:onboard`): a real scaffold, a real `git clone`, a real
  compile, and a health-checked run of the produced binary.
- `run.ps1` mirrors the contract on Windows; it is shipped alongside the
  physical-platform validation matrix (see `todo.md`) and not yet exercised by
  CI on a real Windows machine.
