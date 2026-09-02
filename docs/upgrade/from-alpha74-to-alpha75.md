# Upgrading from alpha74 to alpha75

**Nothing in your app code breaks.** The public surface is unchanged — the API
snapshot moved by exactly one hash, the version string. This release is
bugfixes, tests for the parts that had none, and five new gates.

```sh
am pin --latest && am fix   # or: deno task upgrade
```

## What changes without you doing anything

### Every build flag reaches the build

alpha73 routed every build through the fleet, and `build.ts` became a router
that forwarded a hand-written subset of the flags it accepts. Three were parsed,
validated and then dropped:

| flag                 | what it did before                                           | now                                                          |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `--platform=windows` | produced a **host** binary under the host's name             | a real `PE32+ … for MS Windows`, named `.exe`                |
| `--out=release/one`  | artifacts landed in `dist/`, `release/one` was never created | the artifacts and their `manifest.json` land where you asked |
| `--android-dev-url=` | `deno task dev:android` built a **production** APK           | the APK dials your dev server                                |

If you worked around the platform one by building on the target machine, you no
longer have to. If you scripted around `--out=` by copying out of `dist/`, that
copy is now unnecessary — though it still works.

### `dev:android` and `install:android --build` find the APK again

Both built the APK successfully and then reported
`no .apk produced by the
build`: they scanned the project root, and the fleet
has placed artifacts in `dist/` since alpha73. They read `dist/manifest.json`
now, which is the contract `am publish` already used.

### A failed crash checkpoint says so

`writeSync` — the emergency write, called from the crash handler — swallowed
every error. A checkpoint that could not be written and a process that never
reached the handler left the same evidence: no file, no line. It reports now
(once per distinct cause) and retries a vanished directory the way the routine
path always did.

### `am auth` hands out a uniformly random password

The generator was `byte % 62`, so the first eight letters of the alphabet came
up 25% more often than the rest. Passwords already issued are unaffected in any
practical sense — the entropy loss is a fraction of a bit — but this is the
password that seeds your first admin, so it is rejection-sampled now.

### `am auth totp <id> off` stops claiming it cleared a factor that was not there

It reported "second factor cleared" whenever the user existed. During a
lost-device recovery that implies an account had been protected when it had not.
`cleared` (and the human line) now answer whether a factor was actually removed.

### `am remove` refuses a path outside the app it names

`am remove ..` was refused by a name check, and that check was the only thing
between the name and a recursive delete — two of the three paths an install
occupies are built from `$HOME`, not from `AIO_INSTALL_ROOT`. A second guard now
refuses any path that is not a proper descendant of the directory that owns it,
whatever name produced it.

## If you run aio's test suite

Two things changed for you.

- **Tests no longer write into `$HOME`.** A spawned test app used to resolve its
  home as `~/.<appId>` when `AIO_APPS_DIR` was not pinned — which the suite's
  task does and running a single file does not. All test scratch now lands under
  one root, `~/tmp/aio/` (mode 0700 — user space rather than `/tmp`, because a
  test's scratch holds an `auth.db`, an `app.key` and TLS material). Set
  `AIO_TEST_ROOT` to move it.
- **`deno task check:home-clean`** fails if anything did write there, and names
  it. It never deletes: what is in your home is yours.

## New gates

None of these change how an app behaves; they are what the repo refuses to ship
with.

- `check:placeholders` — a `${…}` inside a plain string, which prints as source
  to whoever reads the message (fifteen of them, all on the Android and Electron
  build paths).
- `check:gated-tests` — an opt-in env gate that no task turns on. Two were dark:
  a build smoke that had been red for four releases, and three Electron E2E
  cases that had never run.
- `check:lock` — an unbounded dependency request, in `deno.lock` or at the
  import site.
- `check:home-clean` — above.
- `check:coverage` now measures **this** repo. It matched any path containing
  `/src/`, which on a machine that has run `install.sh` also matches
  `~/.local/lib/aio/src/…` — so it averaged the repo with an installed copy of
  itself and reported 52.4% instead of 83.5%.

## Retire

Workarounds this release lets you delete:

- **Building on the target machine to get a foreign binary.** `--platform=` was
  dropped on the way to the fleet and produced a host binary under the host's
  name, so the only reliable cross-build was no cross-build. Fixed in alpha75 —
  `deno task build --targets=cli --platforms=windows` produces a real `.exe`.
- **Copying artifacts out of `dist/` because `--out=` did nothing.** Fixed in
  alpha75; point `--out=` where you want them and the `manifest.json` goes too.
- **Any script that hunts for the `.apk` in the project root.** `dev:android`
  and `install:android --build` read `dist/manifest.json` now (alpha75); so can
  yours.
- **A second `AIO_APPS_DIR` export around a single-file test run**, if you run
  aio's suite. The harnesses pin their own sandbox as of alpha75.
