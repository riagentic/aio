# Versioning — `major.minor.build`, derived from the code

An aio app's version is **`major.minor.build`**. You write `major.minor`; the
build number is **derived from the repository**, so nothing ever numbers a build
by hand and no two builds of the same code disagree about what they are.

```jsonc
// deno.json — THE place. Every reader (--version, the boot line, Android,
// iOS, ship / am publish manifests, /__aio/health, the update check) reads it.
{ "title": "notes", "version": "1.2" }
```

| Tree state                    | Version                  | How the build number is made                                         |
| ----------------------------- | ------------------------ | -------------------------------------------------------------------- |
| clean checkout                | `1.2.345`                | `git rev-list --count HEAD` — monotonic, one number per commit       |
| uncommitted changes           | `1.2.345-dirty.9f3ac2b1` | `345` + sha256 over the sorted dirty paths **and their contents**    |
| no git repository             | `1.2.0-nogit.4e1d0c77`   | build `0` + sha256 of the project tree; the build prints a loud note |
| pinned (`"version": "1.0.0"`) | `1.0.0`                  | not derived — used verbatim, and every build says so, once           |
| no `version` at all           | `0.1.345`                | `0.1` is the default; the build names the key to add                 |

Two builds of the same commit produce the **same** version and the same artifact
names. A new commit bumps the build number. The same uncommitted edit built
twice is the same `-dirty.<hash8>`; a different edit never collides.

`-dirty.*` and `-nogit.*` are SemVer prereleases, so they order **below** the
clean build of the same count (`1.2.345-dirty.… < 1.2.345`). That is the point:
a dirty build is not a release, and the update check never offers one over a
clean build.

The build's own outputs (`.aio/`, `dist/` or `build.out`, `node_modules/`,
`dep/`) are never counted as dirty — the stamp a build writes cannot dirty the
next build. An **untracked** `deno.lock` is the toolchain's (the first
`deno task` writes it) and does not count either; once committed, a changed lock
is a real change.

## What is refused, what is noted

- A `version` that is neither `M.m` nor `M.m.p` (`"1"`, `"v1.2"`, `"1.2-rc1"`,
  `"1.2.3.4"`) is **refused by name** at build time.
- A three-part version is **pinned**: accepted verbatim, with exactly one line
  per build —
  `version 1.0.0 is pinned by deno.json — the build number is not derived; write "1.0" to let aio number builds from commits`.
  `am fix` offers the rewrite.
- No repository: one line —
  `no git repository: the build number cannot be derived — git init; builds are numbered from commits`.

## Bumping major / minor

Edit `deno.json`'s `version` and commit. The next build is `1.3.<count>` — the
count keeps climbing across the bump (it is the repository's, not the minor's),
so `1.3.346` follows `1.2.345`: still strictly newer under SemVer.

## Artifact file names

The fleet build (`deno task build`) places every artifact under
`<name>-<version>…` in `dist/`, where `<version>` is the **full** string —
`-dirty.<hash8>` / `-nogit.<hash8>` included, so a dirty artifact is visibly
dirty:

| Target                       | File in `dist/`                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| browser / server / cli       | `notes-1.2.345` (bare binary)                                                              |
| server (+ systemd unit)      | `notes-1.2.345.service`                                                                    |
| electron (Linux)             | `notes-1.2.345-x86_64.AppImage`                                                            |
| electron (Windows / macOS)   | `notes-1.2.345-win-x64.zip`, `…-mac-arm64.zip`                                             |
| android                      | `notes-1.2.345.apk` (`…-unsigned.apk` unsigned)                                            |
| android-client               | `notes-1.2.345-client.apk`                                                                 |
| cli-client                   | `notes-1.2.345-client`                                                                     |
| cross builds (`--platforms`) | `notes-1.2.345-windows-x64.exe`, `notes-1.2.345-macos-arm64`, `notes-1.2.345-client-linux` |
| ios-client                   | `notes-1.2.345-ios-client/` (Xcode project)                                                |
| electron-client              | `aio-client-1.2.345-x86_64.AppImage`                                                       |
| a suffixed duplicate target  | `notes-1.2.345-cli` (see "Target names")                                                   |
| dirty                        | `notes-1.2.345-dirty.9f3ac2b1-client.apk`                                                  |

Grammar: `<name>-<version>` first, then whatever the target adds. The direct
single-target builder (`build.ts --compile`) still writes the bare name into the
project root; the fleet is what places and versions.

`dist/manifest.json` carries the same facts:

```json
{ "app": "notes", "version": "1.2.345", "commit": "9f3ac2b1", "dirty": false, "buildNumber": 345, … }
```

Every reader of `dist/` — `am publish`, `am lab`, `deno task install:android`,
the tests — understands both versioned names and the unversioned names an older
`dist/` may still hold. Nothing writes unversioned names any more.

## What gets INSTALLED is the app's own name

The version is in the artifact's file name — and it is taken back off when the
app is installed. The one-line installer (`run.sh` / `run.ps1`, and the updater
after it) writes:

```
~/app/notes/versions/1.2.345/notes.AppImage   the artifact — the version is the DIRECTORY
~/app/notes/notes.AppImage -> versions/…      the stable name a menu entry and an alias point at
```

The installed FILE never carries a version, because a compiled binary derives
its identity — and therefore its data directory (`~/.notes/`) — from its own
file name. `notes-1.2.345.AppImage` is an app that calls itself `notes-1-2-345`,
writes to `~/.notes-1-2-345/`, and starts from empty state again at the next
version, while the real data sits in the previous directory. The version in the
directory costs nothing and removes the whole class; it is also the rollback
(`AIO_KEEP_VERSIONS`, default 3) and the only layout `updates-apply.ts` can
swap.

Neither installer parses that name itself — both ask the build, which owns the
rule (`installArtifactName`):

```sh
$ deno run -A src/build.ts --print-install-name=notes-1.2.345-x86_64.AppImage
notes
.AppImage
1.2.345
```

## The running artifact says the same

The build stamps the resolved version into the artifact:
`.aio/build-version.json` is embedded by `deno compile` and read by the runtime;
an APK / Xcode project carries it as `versionName`. So all of these print the
derived version — `-dirty.…` included:

```
$ ./dist/notes-1.2.345 --version
notes 1.2.345 (aio 1.0.0-alpha71)
$ curl -s :8000/__aio/health | jq .appVersion
"1.2.345"
$ deno task dev                  # from source: derived the same way
  version  1.2.346-dirty.0c7e11aa
```

`am instances` / `am status` and the updates data contract read the same string.
The server announces it in the WebSocket hello (`proto` frame, `app` field —
additive within protocol v3), so a client can say which build it talks to
(`peerHello().app`); `am clients` shows what each connected client announced
(`aio`, `app`) in return.

There is no config override: `aio.run({ appVersion })` is **retired** (dev
refuses it by name, prod logs and ignores it — `am fix` and `aiol` point at the
line). deno.json is the one place. A compiled binary that carries no stamp
(built without aio's builder) reports a pinned deno.json version if there is
one, else `unknown (…)` — a string the update check refuses by name rather than
compares as `0.0.0`.

The `versionCode` of an APK is `major·100 000 000 + minor·1 000 000 + build`, so
build order is install order; a dirty build carries the clean build's code
(Android accepts a same-code reinstall). Budget: major ≤ 20, minor ≤ 99, build ≤
999 999 — anything past it is refused, never truncated.

## How updates compare

The update check (`updates`) compares `major.minor.build` as plain SemVer:

| installed | channel                     | result                              |
| --------- | --------------------------- | ----------------------------------- |
| `1.2.345` | `1.2.346`                   | offered                             |
| `1.2.345` | `1.2.345`, different sha256 | offered (same version, new build)   |
| `1.2.345` | `1.2.345`, same sha256      | current                             |
| `1.2.345` | `1.2.344`                   | current (not offered)               |
| `1.2.345` | `1.2.345-dirty.…`           | current — a prerelease of what runs |

The digest is only the tie-breaker for an identical version. The manifest `ship`
/ `am publish` write carries `version`, `buildNumber` and `commit` — all three
inside the signed core ([signing](../deploy/signing.md)).

## Publishing is strict

`ship` and `am publish` **refuse** a `-dirty.*` or `-nogit.*` version:

```
✗ version 1.2.345-dirty.9f3ac2b1 is a dirty-tree build — commit first: a
  published build must be reproducible from a commit
```

`--allow-dirty` is the explicit override, and it is logged. `am publish`
publishes the version `dist/manifest.json` recorded — the one the artifacts are
named with — never a re-derivation from the tree as it is now.

## The one decider

`src/build/build-version.ts` (`resolveBuildVersion(declared, tree)`) is pure
over injected git facts; `readTreeFacts(root)` is the one reader. The fleet
resolves once per run and hands the answer to every per-target build
(`AIO_BUILD_VERSION`), so one run is one version. The runtime twin
(`resolveRuntimeVersion`) reads the stamp when compiled and derives when running
from source. Pinned by `tests/build-version.test.ts`.
