# Versioning — `major.minor.build`, derived from the code

An aio app's version is **`major.minor.build`**. You write `major.minor`; the
build number is **derived from the repository**, so nothing ever numbers a build
by hand and no two builds of the same code disagree about what they are.

```jsonc
// deno.json — THE place. Every reader (--version, the boot line, Android,
// iOS, ship / am publish manifests, /__aio/health, the update check) reads it.
{ "title": "notes", "version": "1.2" }
```

| Tree state                       | Version                  | How the build number is made                                         |
| -------------------------------- | ------------------------ | -------------------------------------------------------------------- |
| clean checkout                   | `1.2.345`                | `git rev-list --count HEAD` — monotonic, one number per commit       |
| uncommitted changes              | `1.2.345-dirty.9f3ac2b1` | `345` + sha256 over the sorted dirty paths **and their contents**    |
| no git repository                | `1.2.0-nogit.4e1d0c77`   | build `0` + sha256 of the project tree; the build prints a loud note |
| pinned (`"version": "1.0.0"`)    | `1.0.0`                  | not derived — used verbatim, and every build says so, once           |
| no `version` at all              | `0.1.345`                | `0.1` is the default; the build names the key to add                 |
| staged (`"version": "1.2-beta"`) | `1.2.345-beta`           | the stage rides the same string; builds are still derived            |

Two builds of the same commit produce the **same** version and the same artifact
names. A new commit bumps the build number. The same uncommitted edit built
twice is the same `-dirty.<hash8>`; a different edit never collides.

`-dirty.*` and `-nogit.*` are SemVer prereleases, so they order **below** the
clean build of the same count (`1.2.345-dirty.… < 1.2.345`). That is the point:
a dirty build is not a release, and the update check never offers one over a
clean build.

## Release stage — `-alpha`, `-beta`, `-rc`

Add one of three words to say how finished the app is. The build number is still
derived:

```jsonc
{ "title": "notes", "version": "1.2-beta" } // → 1.2.345-beta
```

It rides the **same string** everywhere — `--version`, the boot line, the status
bar, `/__aio/health`, artifact names, the ship manifest, the update check. That
is the whole feature: an app that shows `0.1.377-beta` in its own UI and ships
`0.1.377` on its download page has two versions, and an update check ordering by
build number alone would offer an **alpha** over the beta that replaced it.

| Ordering                                                    | Why                           |
| ----------------------------------------------------------- | ----------------------------- |
| `1.2.345-alpha` < `1.2.345-beta` < `1.2.345-rc` < `1.2.345` | plain SemVer prerelease order |
| `1.2.345-rc` < `1.2.346-alpha`                              | the build number wins first   |

**Your own updates keep working.** A release channel does not offer prereleases
— `updates: { prerelease: true }` is the opt-in — and every build of a staged
app IS a prerelease. So an install whose own version carries a stage follows its
own line by default: a `1.2.345-beta` is offered `1.2.346-beta`. Saying
`prerelease: false` still means no. A `-dirty` mark does not count: it says a
build is not reproducible, not that it is on a prerelease line.

Only those three words, only lower case, and never a number after them
(`"1.2-rc1"` is still refused): the build count already numbers the build, and
`rc1` would be a second counter to disagree with it. A pinned version may carry
one too (`"1.0.0-rc"`).

**Android:** `versionName` carries the full string, and `versionCode` is
computed from `major.minor.build` alone — so `1.2.345-rc` and `1.2.345` have the
SAME code. Android refuses to install an update whose code is not greater, so
promote an rc to a release on a later commit (which every real promotion is),
never on the same one. A dirty staged build is `1.2.345-beta.dirty.<hash8>` —
one prerelease tail, since two `-` groups would not be SemVer. That one string
ranks _above_ plain `1.2.345-beta` (SemVer ranks a longer prerelease higher),
which is the single build it is: that commit, plus your uncommitted edits. It is
below every other clean build, and it cannot reach a channel anyway — publishing
a dirty build is refused outright.

What a build writes is never part of the hash — with or without a repository, so
building or publishing the same sources twice gives the same version. An output
is told apart by **where a command of the project put it**, never by what a
directory looks like:

- by name: `.aio/`, `.aio-integrity.json`, `dist/` (the build always stages
  there), the out dir of the build that is running (`--out=<dir>`, else
  `build.out`, when it is inside the project), `node_modules/` and `dep/`;
- by record: every directory a build (`--out`) or a publish (`--dir`, default
  `release/`, and the channel directory in it, `release/prod/`) of this project
  has written to. The command writes the name into `.aio/outputs.json`; a
  release under an out dir you built to last week does not count, and neither
  does the staged release of the last publish.

The record is a claim; the directory is the proof. An entry counts only if the
build would take that directory as its `--out` — a plain `<dir>/` inside the
project that is not the project, `src/`, an app dir (the directory of `entry`,
or of a target's own `entry`), `.git` or `.aio`, nor inside or around one of
them, compared as the directory it **is** (links resolved; case, and the
trailing dots and spaces Windows drops, ignored) — **and** only while it holds
what was put there: a build's out dir nothing but its release (the rule by which
a build refuses an `--out` holding other files), a publish channel dir its
update manifest (`<os>-<arch>.json`). A recorded directory that is gone or empty
hides nothing. One that holds anything else — an out dir reused for source, a
stray file beside a release, a folder written into the record by hand — counts
as source for as long as it does: remove the stray file and the directory is an
output again, with no build needed. What a desktop drops into a folder you open
(`.DS_Store`, `Thumbs.db`, `desktop.ini`) is nobody's file: it neither makes a
release count nor makes a folder a release. Only an entry the guard refuses is
dropped from the record, at the next build or publish.

In a repository a recorded directory is left out only where git does **not**
track the path: a file git tracks is source wherever it lies, and editing it
makes the build `-dirty`. A folder that merely looks like a release (a
`manifest.json` and the files it lists) is source. To make a recorded directory
part of the project again without a repository, remove its line from
`.aio/outputs.json`. A source run (`deno task dev`) reads the same record.

An **untracked** `deno.lock` is the toolchain's (the first `deno task` writes
it) and does not count either; once committed, a changed lock is a real change.

## What is refused, what is noted

- A `version` that is neither `M.m` nor `M.m.p`, with or without a stage (`"1"`,
  `"v1.2"`, `"1.2-rc1"`, `"1.2-dev"`, `"1.2.3.4"`) is **refused by name** at
  build time, and the refusal spells out both accepted forms.
- A three-part version is **pinned**: used as written (normalised — `" 01.0.0 "`
  is the version `1.0.0`, because one version has one spelling), with exactly
  one line per build —
  `version 1.0.0 is pinned by deno.json — the build number is not derived; write "1.0" to let aio number builds from commits`.
  `am fix` offers the rewrite.
- No repository: one line —
  `no git repository: the build number cannot be derived — git init; builds are numbered from commits`.

## What a version may cost

A `-dirty.<hash8>` / `-nogit.<hash8>` version is an identity of files, and
reading files is the one part of versioning that can be expensive. It is
bounded, in three tiers:

| The dirty set / the repository-less tree is…                                                | Identity                                                                        |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| up to **20,000 files** and **128 MB**                                                       | sha256 of paths **and contents** — every normal project                         |
| past either                                                                                 | sha256 of path, size and mtime — nothing more is read, the tree is still named  |
| past **50,000 files**, **50,000 directories** or **64 levels** deep, or git does not answer | **refused** by name: the version is `unknown (<one-line reason> — see the log)` |

- A file's size is read from `stat` **before** it is opened, so the file that
  would cross the 128 MB cap is never read.
- git is given **30 s** to answer and **32 MB** of output
  (`git status --untracked-files=all` lists every untracked file); past either
  it is stopped and the identity refused.
- The past-the-cap identity includes mtimes, so it names _this_ checkout: two
  machines with the same large tree get different `<hash8>`s. Both are
  unpublishable builds either way.
- A **pinned** version (`"version": "1.0.0"`) prints no hash, so it costs none:
  a source run reads nothing, and a build reads only the commit and whether the
  tree is dirty — no file is opened, and a tree past every cap still builds.
- A nested `node_modules/` (`web/node_modules/`) is part of the content hash, as
  it always was — only the project root's own is excluded. Past the caps it is
  left out: it is not in the path-size-mtime identity and counts toward none of
  the refusal bounds, so what `npm install` unpacked never costs a project its
  version.

A refusal almost always means the directory is not the app's project: the
project root is the nearest `deno.json` above the app's entry, so a stray one in
an ancestor (a home directory, say) makes everything under it "the project". The
log line names the root it tried to read.

## Bumping major / minor

Edit `deno.json`'s `version` and commit. The next build is `1.3.<count>` — the
count keeps climbing across the bump (it is the repository's, not the minor's),
so `1.3.346` follows `1.2.345`: still strictly newer under SemVer.

## Artifact file names

The fleet build (`deno task build`) places every artifact under
`<name>-<version>…` in `dist/`, where `<version>` is the **full** string —
`-dirty.<hash8>` / `-nogit.<hash8>` included, so a dirty artifact is visibly
dirty:

| Target                       | File in `dist/`                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| browser / server / cli       | `notes-1.2.345` (bare binary)                                                                |
| server (+ systemd unit)      | `notes-1.2.345.service`                                                                      |
| electron (Linux)             | `notes-1.2.345-x86_64.AppImage`                                                              |
| electron (Windows)           | `notes-1.2.345-win-x64.zip`                                                                  |
| electron (macOS)             | `notes-1.2.345-mac-x64.dmg`, `…-mac-arm64.dmg` (a `.app` is inside; no `.dmg` without a Mac) |
| android                      | `notes-1.2.345.apk` (`…-unsigned.apk` unsigned)                                              |
| android-client               | `notes-1.2.345-client.apk`                                                                   |
| cli-client                   | `notes-1.2.345-client`                                                                       |
| cross builds (`--platforms`) | `notes-1.2.345-windows-x64.exe`, `notes-1.2.345-macos-arm64`, `notes-1.2.345-client-linux`   |
| ios-client                   | `notes-1.2.345-ios-client/` (Xcode project)                                                  |
| electron-client              | `aio-client-1.2.345-x86_64.AppImage`                                                         |
| a suffixed duplicate target  | `notes-1.2.345-cli` (see "Target names")                                                     |
| dirty                        | `notes-1.2.345-dirty.9f3ac2b1-client.apk`                                                    |

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
| `1.2.345` | `1.2.345`, an older build   | current (released before it)        |
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
