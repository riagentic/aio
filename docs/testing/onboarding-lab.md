# The onboarding lab — testing on a machine that is not yours

```sh
deno task lab                          # scaffold → dev → prod, all in a fresh Ubuntu
deno task lab ../my-app                # does MY project build and run?
deno task lab riagentic/some-app       # does THAT repo build and run?
deno task lab --no-browser             # skip the UI proof (faster, and weaker)
deno task lab --old-deno --scenario=install
deno task lab --source=github          # exactly what a stranger gets today
deno task lab --shell                  # a shell in the lab, for poking
```

Needs `docker` or `podman`. Nothing else — the lab installs everything it needs
inside the container, because that is the thing under test.

> **"docker is installed but permission denied"** — you added yourself to the
> `docker` group and your shell still cannot use it. Nothing you can `source`
> fixes that: supplementary groups are process credentials, fixed when the
> process is created, not environment variables. Either start a process that has
> the group (`newgrp docker`, or `sg docker -c '…'`), or log out and back in so
> your whole session gets it. The lab notices this case and re-runs itself under
> `sg docker`, so `deno task lab` works anyway.

## Why it exists

Every onboarding test aio shipped before this ran **here**: on a box with deno
already installed and current, a warm module cache, git configured, and
`AIO_HOME` pointed at the local checkout. `install.sh`'s first-contact branch
was never taken; `run.sh` never installed anything. They were green for months
while the real one-liner failed on a fresh machine — the only machine that
matters, because it is the one a new developer has.

The lab fixes the environment, not the assertions:

- **ubuntu:24.04 with `ca-certificates`, `curl`, `git` — and nothing else.** No
  `unzip`, no build tools. If our installer needs a tool, it has to say so
  rather than failing inside someone else's script.
- **No deno**, or a deliberately old one (`--old-deno`), which is how the
  version gate gets exercised instead of assumed.
- **A non-root user.** As root, `$HOME/.deno/bin` PATH problems and
  world-writable temp directories go unnoticed.
- **The published scripts, optionally.** `--source=github` fetches `install.sh`
  / `run.sh` from the branch instead of the local checkout, so you can answer
  "is what's live right now broken?" separately from "is my fix right?".

## What "working" means here

`docker/verify-app.ts` answers in tiers, because each cheap check proves less
than it looks like it proves:

| tier        | question it answers                                   | available |
| ----------- | ----------------------------------------------------- | --------- |
| `html`      | does the server serve a document that BOOTS a client? | always    |
| `health`    | does the app say it is healthy about itself?          | always    |
| `surface`   | does the UI tree render (not an empty page)?          | dev only  |
| `dispatch`  | does a method RUN and change state?                   | dev only  |
| `browser`   | **is the UI up and WAITING for a user?**              | default   |
| `no-errors` | did the app record an error while all that passed?    | always    |

The `browser` tier is the one that answers "is the UI up?", and it runs by
default. It loads the page in real Chrome and asks whether the screen is the
**expected app** rather than one of the four things it is when something went
wrong:

| what it catches                          | the message you get                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **blank** — mount point empty            | `the mount point is EMPTY — a blank screen (the server answered 200 and the client rendered nothing)` |
| **stuck** — a loader that never clears   | `still showing a loader ("Loading…") — the UI never finished coming up`                               |
| **dead** — painted, socket down          | `the page is painted but DEAD — the client cannot reach the server ("Reconnecting…")`                 |
| **broken build** — the module-error page | `the server is serving the module-error page instead of the app — the build is broken`                |

It also fails on any uncaught exception or `console.error` the page logs while
that is happening: a UI that paints and then throws is not working, it only
looks like it is.

It **polls** rather than snapshots — a loader that clears in two seconds is a
normal app starting, and only one still there at the deadline is a finding.

Two `docker/verify-app.ts` flags sharpen that tier — they belong to the verifier
you run **inside** the container
(`deno run -A docker/verify-app.ts --port=8000
--expect="…"`), not to
`deno task lab`, which has its own flag list below. `--expect="Some text"` adds
an assertion that the screen contains something you know it should, which is
what makes the verifier useful against an arbitrary repo. `--interact`
additionally clicks the first control and requires the screen to change — off by
default, because whether the UI is THERE and whether clicking works are
different questions with different failure modes.

`no-errors` then reads the three places an error could be hiding: the server's
own error channel (the endpoint `am errors` reads), `error.log` / `app.log` on
disk, and `client.log` — the browser console the framework forwards, so a page
error survives even when nobody is watching the tab. An app that serves a page
while logging errors is failing quietly, which is the failure this project
treats as worse than a crash.

## `deno task lab` flags

| flag                 | default      | what it changes                                                                    |
| -------------------- | ------------ | ---------------------------------------------------------------------------------- |
| `--scenario=a,b`     | all of them  | run only these scenarios (see the table below)                                     |
| `--source=github`    | `local`      | fetch `install.sh` / `run.sh` from the branch instead of this checkout             |
| `--branch=<name>`    | `main`       | which branch `--source=github` fetches from                                        |
| `--old-deno[=<ver>]` | current deno | preinstall a deliberately old deno (`2.1.4` bare) so the version gate is exercised |
| `--browser`          | on           | the real-Chrome UI tier; `--no-browser` skips it (faster, and weaker)              |
| `--electron`         | on           | the Xvfb desktop-window scenario; `--no-electron` drops it from the default run    |
| `--runtime=<bin>`    | autodetected | force `docker` or `podman` instead of probing for whichever is present             |
| `--keep`             | off          | leave the container running after the run                                          |
| `--shell`            | off          | drop into a shell in the lab instead of running scenarios                          |

The first non-flag argument is the target: a path (`../my-app`) or a
`owner/repo` on GitHub. With no target the lab scaffolds a fresh app.

## Scenarios

| name         | what it runs                                      | what must be true                                                                                                                              |
| ------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `install`    | `curl … install.sh \| sh`                         | deno present **and ≥ `MIN_DENO`**; `am` RUNS; it runs in a **fresh login shell**; the checkout is a pinned clone                               |
| `create-dev` | `am create` → `deno task check` → `deno task dev` | scaffold type-checks; dev server serves; UI renders; a method runs; no errors in the log                                                       |
| `run-sh`     | `curl … run.sh \| sh`                             | one line → **production build** → artifact runs → the expected UI is on screen                                                                 |
| `electron`   | the same one line, on a **virtual display**       | the app starts in its **DEFAULT client**: a real Electron binary runs and puts a **mapped window** on the X server, with no failure in the log |

The `electron` scenario exists because the default client IS the app for most
projects — a lab that only ever ran headless could not test the thing most users
actually get. It uses Xvfb (a real X server writing to memory) and `x11-utils`
asks the server what windows exist, because a log line saying "launching
Electron" is not a window. The image deliberately has **no node**:
`node_modules/.bin/electron` is a node shim, and Deno users routinely have no
node, so a launch that needs one is a launch that fails on the machines this
framework targets.

Pass a path or a repo URL and the lab runs `install` + `run-sh` against **that**
project instead of a scaffold — the answer to "will this thing build and run on
a clean machine?", which is the question a README's install instructions are
really making a claim about.

### Windows: two scenarios, two different claims

Docker cannot boot Windows — Windows containers need a Windows kernel, and no
emulation path exists. What a Linux host _can_ do splits in two, and the split
is deliberate: neither half is allowed to borrow the other's credibility.

**`--scenario=windows-scripts`** — `install.ps1` / `run.ps1` under Microsoft's
PowerShell image. It proves they **parse** and that their decisions are right
(version comparison, `MIN_DENO` read from the framework, app-name derivation),
plus a static ban on PowerShell-7-only syntax — needed because the gate's own
pwsh 7 accepts what Windows 5.1 rejects, which is how a `??` shipped as a parse
error on every stock Windows box. Seconds to run; in the default set.

**`--scenario=windows-app`** — the **artifact**, executed. Every release
cross-compiles `x86_64-pc-windows-msvc`, and until this existed nobody had ever
run the result: "it compiles" is not "it starts". Wine is a real Win32
implementation and a Deno-compiled binary is a plain PE, so the same `.exe` that
would ship boots here, opens its SQLite database in a worker, serves, and writes
to a Windows-shaped profile path. The UI tier then answers _is the expected
screen there_, and the identity check re-proves the data-loss shape fixed in
alpha59 (a binary must not take its name from its FILE). Opt-in: the image is ~4
GB.

**`deno task test:wine`** — the **named-pipe transport**, under Wine. On Windows
a local Electron app (and `am`) talks to the host over `\\.\pipe\aio-<x>`
instead of a TCP port (`src/server/win-pipe.ts`, `local-listen.ts`,
`http-over-conn.ts`). No Windows machine exists in this project's CI, so the
same `Dockerfile.windows-app` image is extended (`WITH_WIN_TOOLS=1`) with two
real Windows runtimes, cached under `~/.cache/aio/tools/win`: the Windows
`deno.exe` at the host's own version hosts the pipes
(`tests/fixtures/wine-pipe/host.ts`, importing the real modules from the
read-only mounted checkout), a Windows Node 22 LTS drives libuv's pipe client —
`net.connect` and `http.request({ socketPath })`, the exact code path Electron
main uses — through 1000 NDJSON lines including a 1 MB one, a streamed 20 MB
body with its sha256 and `nosniff` headers, a 5 MB POST echo, 8 concurrent
clients (the pre-created-next-instance pattern; no `ERROR_PIPE_BUSY`), and the
negative control (a pipe nobody hosts fails fast, `ENOENT`); then `deno.exe`
again through `connectLocal` — the `am` path. One summary line,
`WINE PIPE: N passed, M failed`, with each failure naming the Win32 call and
`GetLastError` code; `tests/wine-pipe-e2e.test.ts` (gated by `AIO_WINE_E2E=1`)
asserts it. Wine's pipe emulation is not the NT kernel, so the claim is exactly
"proven under Wine in CI; one pass on real Windows still pending". Not yet
covered here: the compiled `.exe` booting in pipe mode under Wine and `am state`
reaching it (a `windows-pipe` lab scenario) — Wine offers no `netstat` view of a
pipe namespace and the compiled binary picks the pipe only for the electron
client, which Wine cannot launch, so that half waits for a flag that forces the
transport without a window.

What **neither** proves, printed on every run rather than left implied:

- Windows PowerShell **5.1** actually executing the scripts (only a syntax
  subset is checked statically). PowerShell 7 does **not** run under Wine at all
  — measured on Wine 9 and Wine 11 staging: it loads .NET and exits without
  executing, which is why the scripts are not tested there.
- The real registry, Start Menu `.lnk`, a winget-installed deno, SmartScreen on
  an unsigned binary, and true file locking when replacing a **running** `.exe`.

Both remain best-effort until there is a Windows runner. The point of two
scenarios is that a green line names exactly what went green.

## When it fails

The scenario prints the failing step, then the last 40 lines of the app's own
output — the part a person debugging actually needs. To take it apart by hand:

```sh
deno task lab --shell        # the framework is mounted read-only at /aio-src
sh /lab/scenarios/01-install.sh        # run a scenario step by step
```

`--keep` leaves the container behind after a run for the same purpose.

## Where the fast gate is

The lab is minutes and needs a container runtime, so it is not on every commit.
The decision it depends on most — "is this deno new enough?" — is pinned by
`tests/install-deno-version.test.ts`, which drives the real `install.sh` with a
fake old `deno` on `PATH` and needs no container at all. It runs with
`deno task test`.
