# alpha59 → alpha60

**Nothing to migrate in your app's code.** This release changes what you _type_,
not how anything runs — and every renamed thing kept its old spelling working.

## If you contribute to aio itself, the gate tasks moved

The framework's own tasks now read verb-first, like `test:core` and `lint:aio`
always did:

| was                        | now                            |
| -------------------------- | ------------------------------ |
| `deno task api:check`      | `deno task check:api`          |
| `deno task api:update`     | `deno task update:api`         |
| `deno task docs:check`     | `deno task check:docs`         |
| `deno task docs:coverage`  | `deno task check:doc-coverage` |
| `deno task docs:index`     | `deno task update:docs`        |
| `deno task coverage:check` | `deno task check:coverage`     |
| `deno task bench:check`    | `deno task check:bench`        |
| `deno task release:check`  | `deno task check:release`      |
| `deno task boundaries`     | `deno task check:boundaries`   |

These are the **framework repo's** tasks. An app's own tasks are untouched.

The rule, if you add one: a bare verb is the default instance (`check`, `test`),
`verb:qualifier` is a specific one (`check:api`), and the qualifier never leads.
A reversed name now fails `tests/task-naming.test.ts` with the fix in the
message.

## New: `deno task install:android`

Scaffolded into android apps (as `install:electron` is scaffolded into electron
ones). It puts a finished APK on the phone plugged into your machine:

```sh
deno task install:android --build          # build it, install it, launch it
deno task install:android                  # …if you already built one
deno task install:android --device=SERIAL  # when several are attached
deno task install:android --emulator       # a RUNNING emulator, not a phone
deno task install:android --no-launch      # install without starting it
```

Enable **Developer options → USB debugging**, plug in, accept the dialog;
`adb devices` should list it as `device`. `--build` builds the **debug** APK
(the same flags as `compile:android`) because it is signed with the debug key
and therefore installable; `--release` needs your own signing config.

`deno task dev:android` is unchanged — it is the development loop (emulator, dev
server, live reload).

An existing android app gets the task from `am fix`.

## `am`: same acts, clearer words

Everything old still works. What changed:

| now               | was         | why                                                                                         |
| ----------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `am upgrade`      | `am update` | one verb; the OBJECT says which — bare is am itself, `am upgrade <app>` is an installed app |
| `am timetravel`   | `am tt`     | the only abbreviation in a surface that spells everything out (`tt` still works)            |
| `am sql --tables` | `am tables` | one fixed query, not a second command; the flag composes with `--json`/`--app`              |

**`am errors` shows more than it did.** It used to print only the build error;
it now prints that first (when there is one) and then the tail of `error.log`,
with `--lines=N`. If you script it: `--json` keeps `errors` meaning exactly what
it meant — the build errors — and adds `build` and `runtime` beside it, so
existing scripts are unaffected.

**New: `am open [--print]`** opens _your app_ in a browser (`am ui` opens the
visual manager). It refuses when nothing is serving rather than opening a tab
that says `ERR_CONNECTION_REFUSED`; `--print` writes the URL so it composes:

```sh
open "$(am open --print)"
```

**Four commands are now in `am help`** that were not: `fix`, `link`, `auth` and
`report`. They always worked.

**Piping help no longer mangles it.** `am auth | less` printed the whole help as
one JSON string with escaped newlines, because output mode was chosen from the
terminal. Only an explicit `--json` turns help into data now.

## If you install on macOS, re-run the installer

A fresh macOS account has no `~/.zshrc`, and a login zsh never reads
`~/.profile` — so the PATH line went into files zsh does not read, and `am` was
missing from the next Terminal while the installer reported success. Re-running
`install.sh` writes `~/.zprofile` and verifies with `zsh -lc`. If you worked
around it by editing a profile by hand, that line is still fine; the installer
is idempotent and will not add a second one.

## Testing the Windows artifact (optional)

`deno task lab --scenario=windows-app` runs the `.exe` we cross-compile under
Wine — it boots, serves, writes its SQLite database and its UI is verified on
screen. Opt-in: the image is ~4 GB. It does **not** run `install.ps1`/`run.ps1`
(PowerShell does not execute under Wine — measured on Wine 9 and 11), which is
why the script gate stays separate.
