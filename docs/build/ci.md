# CI for an app built on aio

A working GitHub Actions workflow, and the three aio-specific things that make
the difference between a pipeline that catches problems and one that is green
while the artifact is broken.

## The workflow

```yaml
name: ci
on: [push, pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: "2.9" # aio's MIN_DENO — pin the floor you support
      - run: deno task fmt --check
      - run: deno task lint # deno lint AND aiol — see below
      - run: deno task check # deno check AND am check — see below
      - run: deno task test

  build:
    needs: check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: "2.9"
      - run: deno task compile
      - uses: actions/upload-artifact@v4
        with:
          name: app
          path: dist/
```

Nothing in it is aio-specific, and that is the point: the scaffolded tasks are
the interface. What matters is that CI runs `deno task check` and
`deno task lint` rather than `deno check src/` and `deno lint` directly.

## Why `deno task check`, not `deno check`

`"aio"` resolves to two different modules: `mod.ts` for the type-checker and the
browser entry for the bundle. TypeScript checks the **union**; the bundle gets
the **intersection**. So a server-only import reachable from a cell type-checks
perfectly and then fails to build.

`deno task check` is `deno check src/ tests/ && am check` — the second half
walks the client graph and fails on exactly that. A CI that calls `deno check`
on its own is green on the code path aio is most often reported for.

The same shape applies to lint: `deno task lint` is `deno lint src/ && aiol`,
and `aiol` is the half that knows about cells, `t=` handles and accessible
names.

## Why `deno task test` needs nothing special

`testUI` brings its own DOM (happy-dom, via the import map) and boots the cells
your component imports. There is no display, no browser and no server to start,
so a plain `deno test -A` is the whole story on a headless runner.

Two things that are NOT true of it:

- **Electron tests need a display.** A switch cannot substitute for one. Wrap
  them in `xvfb-run -a`, and see
  [Headless and VM hosts](../clients/electron.md#headless-and-vm-hosts-aio_electron_args)
  for the switch set a GPU-less runner needs.
- **A browser e2e needs a browser.** `ubuntu-latest` ships Chrome. aio looks for
  one in the usual Linux places and in `/Applications` on macOS; on a Windows
  runner (and anywhere else) set `CHROMIUM_BIN` to the browser's path.

## Building the other targets

`deno task compile` builds the default target. `deno task build` builds every
target in `deno.json`'s `build.targets`. Most of them cross-build from one Linux
runner (`--platforms=…` —
[what cross-compiles](targets.md#build-for-other-operating-systems----platforms));
what a runner of the target OS adds is that the artifact is **run** there, and
on macOS that the `.app` is signed and packed into a `.dmg`:

```yaml
build:
  needs: check
  strategy:
    matrix:
      os: [ubuntu-latest, macos-latest, windows-latest]
  runs-on: ${{ matrix.os }}
```

On a Windows runner, run `am` steps with `shell: pwsh`. `am` is `am.cmd` there,
and Git Bash (`shell: bash`, the default for a `run:` step in many templates)
cannot start it. Installing `am` itself is one `pwsh` step:

```yaml
- if: runner.os == 'Windows'
  shell: pwsh
  run: |
    irm https://raw.githubusercontent.com/riagentic/aio/main/install.ps1 | iex
    "$env:USERPROFILE\.deno\bin" >> $env:GITHUB_PATH
```

The second line is there because a later step sees a PATH change only through
`$GITHUB_PATH`, not through the user PATH the installer writes. The folder is
`%USERPROFILE%\.deno\bin`, or `%DENO_INSTALL%\bin` when `DENO_INSTALL` is set.

Actions runs a `pwsh` step by dot-sourcing it (`. '{0}'`); `install.ps1` and
`run.ps1` do their work however they are loaded. Only `AIO_INSTALL_LOAD_ONLY=1`
/ `AIO_RUN_LOAD_ONLY=1` make a load define the functions without running them,
which is how aio's own tests reach them.

macOS is the one worth paying for even on a small project: it is the only real
signal for a `.app` bundle, and nothing on Linux reproduces it. A Linux AppImage
is the one package that must be built on its own OS and CPU.

## Caching

Deno's cache is in a different place on each OS — `~/.cache/deno` on Linux,
`~/Library/Caches/deno` on macOS, `%LOCALAPPDATA%\deno` on Windows (`deno info`
prints it). Pin it with `DENO_DIR` so one cache step fits every runner;
restoring it turns a cold two-minute resolve into seconds:

```yaml
env:
  DENO_DIR: ${{ github.workspace }}/.deno-cache
steps:
  - uses: actions/cache@v4
    with:
      path: .deno-cache
      key: deno-${{ runner.os }}-${{ hashFiles('deno.lock') }}
```

Add `.deno-cache/` to `.gitignore` if you also run the workflow's commands
locally with that variable set.

Commit `deno.lock`. Without it the cache key changes on every run and the
dependency set is not pinned — two problems with one fix.

## What to check on a schedule, not on every push

The heavy tiers — a full target matrix, a real-browser e2e, an install-to-run
E2E — cost minutes per run and catch problems that arrive on a timescale of
days, not commits. Run them nightly and on demand (`workflow_dispatch`), and say
so in the workflow file, or someone will read a green push as proof the artifact
boots.
