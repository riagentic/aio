# Keeping an app up to date

One line turns it on:

```ts
aio.run({
  cells: [todos],
  updates: "https://releases.example.com/wallet",
});
```

That is the whole configuration for most apps. The app now checks for new
releases, and your UI can show whatever you want about it — because the update
state is just cell state.

```tsx
import { updates } from "aio/updates";

export function App() {
  return (
    <>
      {updates.available && (
        <div class="banner">
          A new version ({updates.available.version}) is available. The app will
          restart.
          <button onClick={() => updates.apply()}>Update</button>
          <button onClick={() => updates.dismiss()}>Not now</button>
        </div>
      )}
    </>
  );
}
```

There is no update API to learn. `updates` is a cell: it binds reactively, syncs
to every connected client, shows up in `am state`, and is testable with
`testCell`/`testUI` like anything else.

## The rule that outranks everything else

**An update never breaks your app or its data.** A release that cannot migrate
what is already on disk is not offered as an update at all. It is reported
separately, with the reason:

```tsx
{
  updates.blocked && (
    <p>
      Version {updates.blocked.version} exists but cannot be installed:
      {updates.blocked.blockers.join(" ")}
    </p>
  );
}
```

This is not politeness — there is no code path from `blocked` to installed.
`apply()` refuses.

How aio knows: every published release carries a **signed data contract**
saying, per cell, what schema version it writes and the oldest version it can
migrate from. That contract is measured from the binary
(`<binary> --aio-data-contract`), not guessed from source, so it cannot promise
something the build does not do.

| Your cell declares               | Can migrate from | An install holding v1 data                  |
| -------------------------------- | ---------------- | ------------------------------------------- |
| `version: 2` **and** `onMigrate` | v1 and up        | offered, backup taken first                 |
| `version: 2`, **no** `onMigrate` | v2 only          | **never offered**                           |
| unchanged `version`              | —                | offered                                     |
| **no `version` at all**          | —                | **offered — the gate cannot see this cell** |

**Read that last row before anything else.** The gate protects the cells that
declare a `version`. A cell that never declared one is not stamped on disk, is
not in the contract, and is not checked — so a release that renames one of its
fields is offered to every install as compatible, the merge drops the field, and
the persist window writes the loss back. Nothing about the app looks wrong until
the data is gone.

Declaring one is free and converts nothing: the first `version: 1` on an
existing install stamps the shape already on disk and runs no hook (the boot
line says `stamping <cell> at version 1`). Add `onMigrate` later, when the shape
actually changes. `deno task lint` warns, once, listing every persisted cell in
an updating app that has no version.

The second row is the one that matters. Bumping a cell version and forgetting
the migration used to be a data-loss incident at some user's next boot. Now it
is an update they are simply never shown — and `deno task publish` tells you at
publish time.

When an update _does_ migrate, aio takes a consistent backup of the store
(SQLite `VACUUM INTO`) **before** swapping anything, and records its path so a
rollback can point you at it.

## Sources: a location, or a repository

`updates.source` is agnostic. `<channel>` is interpreted by the source — a
directory for published artifacts, a git ref for a repository.

| Source                             | What "a new version" means | Applying it          |
| ---------------------------------- | -------------------------- | -------------------- |
| `https://releases.example.com/app` | a newer semver             | download + swap      |
| `file:///mnt/releases/app`         | a newer semver             | download + swap      |
| `https://github.com/you/app`       | the ref moved              | re-run the installer |

A **manifest source** is three static files per channel on any host that serves
files — S3, GitHub Releases, nginx, a Pages site, a mounted share, a USB stick:

```
<source>/<channel>/<os>-<arch>.json    the manifest
<source>/<channel>/<artifact>          the binary / AppImage
```

A **git source** is for apps installed by the one-line runner, where the
repository is the source of truth. aio detects new commits on the followed ref
(one `git ls-remote`, no clone) and tells you; taking it re-runs the installer.
Two honest differences: there is no signature (authenticity rests on the repo
URL and your transport, exactly as the installer's does), and the data check
happens after the rebuild rather than before the download.

If a URL could be either, aio **refuses to guess** and asks for
`kind: "git" | "manifest"`. A wrong guess would produce "no updates available",
which is indistinguishable from being up to date.

## Channels

Three by convention — `dev`, `test`, `prod` — but the name is yours.

The channel an artifact was **built** for is stamped into it and is the default
it follows. That default exists to prevent two silent disasters: a test build
that followed `prod` would update itself into the public release and vanish (the
tester loses the build they were testing), and a prod build that followed `dev`
would ship unreviewed code to users.

It is a default, not a lock. Most specific wins:

```
--channel=test                 this run
AIO_UPDATE_CHANNEL=test        this environment
(pinned by setChannel)         this machine
(the artifact's stamp)         this build      ← the default
updates: { channel: "test" }   this source tree
"prod"
```

The stamp outranks the config literal on purpose. The literal is a property of
the source tree — every build made from it carries it — while the stamp is a
property of the artifact somebody is actually running. A build stamped `test`
made from a tree whose config says `prod` is a test build, and letting the
literal win is exactly the silent "the tester's build updated itself into the
public release" the stamp exists to prevent. Say something else per run
(`--channel`, `AIO_UPDATE_CHANNEL`) or per install (`updates.setChannel()`); a
one-off flag is never pinned.

Poll cadence follows the channel: `dev` 1m · `test` 5m · `prod` 6h, jittered,
and conditional (`If-None-Match`), so an unchanged check costs a 304 and no
body. Override with `check: <ms>`, or `check: false` for manual-only. `check`
must be `true`, `false`, or a number of milliseconds **>= 1000** — anything else
throws at boot naming the value, because a negative interval silently never
polled and `NaN` became a tight loop against the release host.

`setChannel(name)` is a real channel change, not a rename: the cadence and the
prerelease default (below) follow the new channel at once, unless the app pinned
them with `check: <ms>` or `prerelease`. The name is checked at the call — a
manifest channel is a path segment and must be a name `deno task ship` can
publish (letters, digits, `. _ + -`), and a git channel must be a branch or tag
name — so `setChannel("../prod")` throws instead of being pinned.

## Publishing

```sh
deno task ship keygen                      # once, ever
# → wrote ~/.aio/keys/<app>-release-key.json   (private; never commit it)
deno task publish --key=~/.aio/keys/myapp-release-key.json
# → ./release/prod/ — upload that directory to <source>/
```

`publish` is build → sign → **lay out the channel directory a client actually
fetches**, in one step. It publishes the version the build recorded in
`dist/manifest.json` — `major.minor.<commit count>`, see
[Versioning](../build/versioning.md) — and **refuses** a `-dirty.*` / `-nogit.*`
build ("commit first — a published build must be reproducible from a commit");
`--allow-dirty` is the explicit, logged override. The manifest carries
`version`, `buildNumber` and `commit`. That last part is the one worth naming: a
client asks for `<source>/<channel>/<os>-<arch>.json`, and a release whose
manifest is not at exactly that path is invisible. Not an error — invisible. The
app reports "no updates available" forever, on the users' machines, and nothing
anywhere says why.

A platform's manifest carries ONE artifact, so where a build makes two for one
platform, publish picks the one an update can install as the platform's
`<os>-<arch>.json`. An Electron build for Windows makes two **install kinds**:
the one-click `<name>-win-x64.exe` SFX (kind `binary`) is the platform's update,
and the `.zip` gets a manifest of its own, `<os>-<arch>.electron-zip.json` — an
install unpacked from the zip reads that one first and falls back to
`<os>-<arch>.json` when the channel has none (a 404 or 410, then not asked again
for a day; a timeout fails the check). A channel that has one costs one request
per check. A zip install running aio older than 1.0.13-beta only reads
`<os>-<arch>.json`, is offered the `.exe` it cannot install, and must be updated
by hand once; publish's summary says so. An app installed by the one-click
`.exe` runs from the folder that `.exe` extracted, so it is an `electron-zip`
install too: it updates from the **zip's** manifest, not from the `.exe` it was
downloaded as — publish the `.zip` with every release, or those installs are
offered an `.exe` they cannot install. Any other tie is refused, naming both
files. A macOS `.dmg` is download-only: `downloads` in `--json` lists it,
`stranded` lists any download whose platform got no manifest, and each of
`releases` names its `kind`.

**The data contract.** Publish asks each artifact it can run here
(`<binary> --aio-data-contract`) and stamps that answer into the manifests of
the ones it cannot — the same cells compile into every artifact of one build. On
a Mac, a `<bin>-mac-<arch>.app.tar.gz` built on this kind of Mac is unpacked and
its bundle executable asked, unless `--data` or `--no-data` already answers. A
`.app` nothing here can ask, with no other artifact to answer for it, is
**refused** unless you pass `--data=contract.json` (captured on a Mac) or
`--no-data` (publish without one, on purpose). Every release that goes out
without a contract is warned about on stderr, in `--json` mode too, with the
reason per file.

The answer is read off a **marked line**, not off whatever the binary printed:
besides the JSON on stdout, `--aio-data-contract` writes
`[aio] data-contract:
{…}` on stderr, with `[aio] persisting-cells: …` and
`[aio] app-id: …` beside it. Publish (and the git update source, for the binary
it rebuilt) sets `AIO_PROBE_NONCE` to a fresh value for each probe, the binary
echoes it — `[aio:<value>] data-contract: {…}` — and only lines carrying that
value are read, so an app that prints at module top level, or prints a line of
the same shape, neither breaks nor forges the answer. A binary built before the
marker is read as before: from stdout. A `--data=` file may hold either form.

Useful flags: `--dir=/srv/releases` (where to stage), `--channel=test`,
`--notes="fixes the sync bug"`, `--no-build` (publish what `dist/` already
holds). Unsigned is allowed for a local or air-gapped channel, and every step
says so out loud — but a client only installs unsigned releases if the app opted
in.

`--dir` inside the project must be a directory of its own — the rule the build's
`--out` follows: not the project root, `src/`, an app dir, `.git`, `.aio`, nor
inside or around one of them. `--dir=src` is refused before anything is built or
written, and so is any other name for it (a link to `src`, `src.`, `src`). A
directory outside the project is always fine.

The long way is the same three steps by hand, if you want to see them:

```sh
deno task compile
deno task ship ./dist/wallet --channel=prod   # signs with ~/.aio/keys/wallet-release-key.json (the `ship keygen` default) when it exists; --key=<path> picks another
# → wallet.ship.json, next to the artifact. Copy BOTH into <source>/prod/,
#   with the manifest named <os>-<arch>.json.
```

The release is named from `deno.json` (`appId` > `title` > `name`), and every
install refuses a release whose name is not its own `appId`. So `ship` (and
`am publish`) asks the artifact which id it runs as and refuses a mismatch — for
example `aio.run({ appId: "wallet" })` in code with only `"title": "My Wallet"`
in `deno.json`. Fix it once with `"appId": "wallet"` in `deno.json`, or pass
`--name=wallet` to `ship`.

Or let CI do it:

```sh
deno run -A jsr:@riagentic/aio/ship github --channel=prod
# → .github/workflows/release.yml
```

That writes a workflow which builds on Linux, macOS and Windows, signs each
artifact, and publishes the channel layout above to **GitHub Pages**. Put the
output of `ship keygen` in the repo secret `AIO_SIGNING_KEY`, enable Pages once
(Settings → Pages → Source: GitHub Actions), then point the app at the site:

```ts
updates: "https://OWNER.github.io/REPO";
```

**Not** a release download URL. A client asks for
`<base>/<channel>/<os>-<arch>.json`; GitHub Release assets are a FLAT list with
no directories, so `.../releases/latest/download/prod/linux-x86_64.json` cannot
exist and never will. Pointing an app there produces a permanent, silent "no
updates available". Any host that serves a directory tree works — Pages, S3, R2,
nginx, a mounted share.

It is emitted, not integrated: the layout is the part aio owns, and a workflow
file does the rest natively without the framework depending on a forge's API.
Edit it freely — it is a normal file in your repo.

`deno task ship keygen` makes the signing key, writing it OUTSIDE your repo
(`~/.aio/keys/<app>-release-key.json`) and printing the path plus the public
half. Redirecting it — `keygen > release-key.json` — captures that summary, not
the key: a valid-looking JSON file with a `publicKey` and no private half, which
signs nothing. Use the file at the printed path, or `keygen --stdout` to pipe
the real pair somewhere (a CI secret). Publish only the public half — it rides
inside the manifest. [Release signing](signing.md) is the full API: key
generation and fingerprints, key rotation, what `manifestCore` covers, and the
two verification functions a publisher or a third-party checker calls.

The signature covers the **whole manifest core**: version, digest, channel,
target, platform, and the data contract. That matters more than it sounds.
Signing only the binary's digest would authenticate the bytes but none of the
coordinates, so a genuine, correctly-signed _test_ build copied to the _prod_
path would verify perfectly and install. It does not: the channel is inside the
signature, and a mismatch aborts before anything is downloaded.

The first release an install verifies **pins its signing key** (trust on first
use, with a loud one-time line). Every release afterwards must be signed by that
key — a manifest signed by anyone else is refused, and so is an unsigned one.

Unsigned releases are refused unless you opt in with `allowUnsigned: true`,
which says so at every step. Use it on a private LAN, not on the internet.

## Services: updating with nobody watching

```ts
updates: { source: "https://releases.example.com/gateway", auto: true }
```

`auto: true` detects, verifies, installs and restarts without asking. It still
refuses anything that fails verification or the data gate.

The failure this design cares about is the 3am one: the new build does not come
up, and a supervisor restarts it forever. So the **new build verifies itself**.
The swap writes a pending marker; the new version gets two boots to reach a
serving state with the app's own `onStart` through (an async one settled, still
running after 30 s, or the app quit cleanly — exit code 0); if it does not, it
puts the previous artifact back and exits so the supervisor starts a version
that works, naming the backup if the update had migrated data.

A new version that never boots at all cannot judge itself. For the directory
swaps (Electron `.zip` and macOS `.app`) the swap helper covers that case: it
waits up to 120 s for the new version's first boot to take a first-boot token.
If that never happens (macOS refused to open it, or it exited or hung before
booting), the helper takes the token itself, stops whatever still runs from the
new folder, puts the old folder back and starts it. Taking the token is one
atomic file operation on each side, so exactly one of them wins, even when the
first boot arrives at the moment the wait runs out; a new version that lost
exits before it writes anything. Whichever way an update is rolled back, the
next boot logs `update X → Y was rolled back: …` and dismisses Y, so it is not
installed again automatically. A newer release is offered as usual, and
`undismiss()` offers Y again.

If the helper cannot move a folder (a file lock held by antivirus, an open
Explorer window, a program whose working directory is inside it), it retries: on
Windows the move of the running version aside for 30 s, every other move for 10
s. If the move still fails, it puts back what it moved, removes the tree it had
staged, starts the old version, and records why; the next boot logs
`update X → Y could not be installed: <why>` — with what the system said (on
macOS and Linux the words of the `mv` or `rm` that failed, cut to one line) and,
on Windows, the processes still running from the folder or started with its path
(up to eight by name; a program that only has its working directory there is on
no list Windows gives cheaply, and the line says so). An earlier
`<install>.old-<version>` that cannot be removed is named as that:
`an earlier copy of the app (…) could not be removed`.

A swap that was never made is not a rollback: Y never ran, so it is **not**
dismissed. It stays on offer (`… — Y stays on offer (failed attempt 1 of 3)`)
and the next click, or with `auto: true` the next check after the one at that
boot, tries again. The count is kept per release in `update-trust.json`; the
third failure in a row dismisses Y like a rollback does, with a line that names
the folder that was held and what to do about it on this OS. The count ends
there, and with a confirmed update: after `undismiss()` Y has its three tries
again. An old copy that had to be started from where it was set aside, and a
count that cannot be written, are dismissed at once.

### What the updater may remove

The folder an app is installed in is the user's — `~/Apps`, `Downloads`, a
shared `Programs` folder — and an update leaves things there: a download
(`<install>.zip-<version>`, `<install>.new-<version>`, and while it runs a
staging folder `.aio-update-<download name>-<pid>-<8 hex>`), an unpacked tree
(`<install>.staged-<version>`), the version it replaced
(`<install>.old-<version>`), a build set aside by a rollback
(`<install>.failed-<time>`). A name proves nothing there: `notes.staged-1.2.3`
can be somebody's folder.

So the updater removes a path only when it can prove it made what is there:

- Before it makes anything beside the install it writes the path down in
  `update-artifacts.json` in the app's data directory, with the process that is
  making it. A crash can leave a record with nothing behind it, never a thing
  with no record.
- Once the thing exists the record holds what the filesystem says it IS (kind,
  device, file number, creation time). A path is ours only while the very object
  that was made is still there — not when something else has taken the name. For
  a file that also means its bytes: the record holds its size and SHA-256,
  checked before it is removed, pruned or taken as a kept version. (On NTFS a
  file made again under a deleted one's name inherits its creation time, and the
  file number Deno reports there is rounded — identity alone is a hint.) A name
  the update needs that cannot even be looked at (access denied) is in the way,
  refused before the download. Nothing is written into what the updater makes
  (one more file in an unpacked macOS bundle would break its seal).
- A boot with no update in flight removes the recorded leftovers nobody is
  working on (their process is gone; the same pid in an earlier run counts as
  gone), each renamed aside first (to `<install>.swept-<pid>-<n>`, a free name
  that goes on the record before the rename), and logs their names:
  `removed what an unfinished update left beside …`.
- Anything beside the install that only LOOKS like a leftover is left where it
  is and named once per boot:
  `left alone beside …: not made by this app's
  updater — …`. A second copy of
  the app running from the same folder with another data directory has its own
  record, so it leaves the first one's download and staged tree alone.
- When a name the update needs is taken by something that is not the updater's,
  the update is refused before anything is downloaded —
  `… is in the way of the update, and it was not made by this app's updater` —
  and nothing is removed.

Things made by a build older than this record (1.0.16 and earlier) are on no
record, and looking at one can only say "this is a copy of the app", never "the
updater made it". So that look is taken **once**: the first start with no update
in flight (or the first confirmed update) on 1.0.17 or later goes through the
exact names those builds used — `<install>.old-<version>`, `.staged-<version>`,
`.zip-<version>`, `.new-<version>`, `.failed-<time>`, and the download folder
`.aio-update-<8 hex>` — and takes onto the record what also passes by content: a
folder that is this very app (an `electron/` folder and the running install's
launcher, byte for byte; on macOS the running bundle's identifier), beside a
single-file install a file of the same executable format as the running one, a
`.zip-<version>` that is an archive, an old download folder that holds nothing
but a file `artifact`. A leftover (anything but an `.old-` copy) must also have
been untouched for an hour; while one is younger the look stays open and the
next start takes it again. Each time the look is taken one info line says so,
naming what it took:
`looked for what an earlier version's updater left beside … (…): took over …`
(or `nothing to take over`). A run from source never looks: its "install" is the
`deno` binary, and no update is applied there. From then on only the record
counts — a copy of the app you make later under one of those names is left
alone, never pruned as an old version, and refuses an update that needs the
name.

That look is the single place where a name and a content check stand in for
proof: at the first start on 1.0.17, and at any start that finds no record or
one without its mark (`update-artifacts.json` deleted, edited by hand, or
restored from before 1.0.17), a copy of the app that somebody made BY HAND under
exactly such a name (`<install>.old-1.2.3`) is taken for the updater's — kept as
an old version and pruned like one. What the record already names is never taken
twice.

On a file system that gives files no creation time the record cannot prove
anything it names: nothing is removed there and old versions are not pruned —
each start warns with the path and its size, and they are yours to delete.

### What an update keeps, and what it costs in disk

Each update keeps the version it replaced beside the install, as
`<install>.old-<version>` — a file for a single-file artifact, a whole folder
for an Electron `.zip` or a macOS `.app` install. That copy is what a rollback
puts back, and what makes going back by hand a rename instead of a download.

A single-file artifact is kept by copying it (on Windows the running file is
renamed aside instead). The copy is on the record as unfinished until every byte
is on disk, and is recorded as whole before the new build goes in. One cut off
half-way — the app killed, the disk full — is not a version: it is not counted
among the kept ones, a rollback refuses it
(`the copy to roll back to (…) was cut off while it was being written …`), and
the next start removes it. A copy that comes out short stops the update, with
nothing changed.

The **three newest** are kept. Older ones are deleted when a later update is
confirmed (the new version's first healthy boot), never before. Only copies the
updater itself set aside are counted and deleted (see above): a
`<install>.old-photos` of your own is neither. So an install that has been
updated three times or more occupies up to **four times the app's size**: the
running version plus three old ones. For a 430 MB Windows folder install that is
about 1.7 GB. An install made by `run.sh` keeps its versions under
`versions/<version>/` instead, three in all, pruned at the same moment. Deleting
an `.old-` copy by hand is safe while no update is in flight; the only thing
lost is the rollback to that version without a download.

If it cannot move the old folder back during a rollback, it starts the version
in place and the next boot logs
`ROLLBACK FAILED of update X → Y: … — this is still Y`, naming the folder to put
back by hand. When neither folder can be moved back, it records that first and
starts the old copy where it was set aside
(`— this is X, started
from where it was set aside`). A pending marker found by
the very executable it was meant to replace is recorded as a failed update,
never confirmed. A new version built with aio 1.0.12 or older never takes the
token; its boot rewrites the pending marker instead, and the helper counts that
as its first boot. On Windows, the in-app rollback of a `.zip` install also goes
through the helper, because a running folder cannot be moved from inside.

Under systemd (or any supervisor), aio exits and lets the unit restart it rather
than launching a competing process. On a plain CLI launch it starts the
successor itself.

**The unit's contract.** The generated unit (`deno task build --service`)
carries two lines the app relies on, and a hand-written unit must carry them
too:

```ini
# an update or aio.restart() exits 0 to come back
Restart=always
# aio.stop() exits 143 to STAY down
RestartPreventExitStatus=143
# "exit; do not spawn your own successor"
Environment=AIO_SUPERVISED=1
```

Comments go on their own lines: systemd has no trailing-comment syntax, so a `#`
after a directive is part of its value — `Restart=always # …` is refused as
unparsable and leaves the service with NO restart policy, and the same text
after `ExecStart=` reaches the binary as extra arguments.

`Restart=on-failure` is the classic mistake: a successful update exits cleanly
and the service stays down until somebody notices.

## Stopping and restarting from inside the app

```ts
import { aio } from "aio";

await aio.stop(); // finish writing, final snapshot, exit
await aio.restart(); // the same, then come back
```

Both are safe to call from inside a cell method: they defer by one macrotask, so
the method returns and the shutdown sees a quiet cell — the same finish-writing
contract a signal or `am stop` runs. Every app in the process is shut down (a
process is stopped, not a cell).

"Come back" is a promise per launcher, and aio keeps it where it can and
**refuses, with the reason and the manual step, where it cannot** — never a
silent no-op:

| Launcher                                       | `aio.restart()`                                                | `aio.stop()`                                     |
| ---------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| `deno task dev` (the dev supervisor)           | exits 75 — the supervisor relaunches                           | exits 0 — the session ends                       |
| a service (`systemd`, `AIO_SUPERVISED=1`)      | exits 0 — `Restart=always` brings it back                      | exits 143 — `RestartPreventExitStatus=143` holds |
| a compiled binary, AppImage, or local Electron | re-executes itself with the same arguments; the window follows | exits 0                                          |
| `deno run -A app.ts`, unsupervised             | re-executes `deno run …` with the real command line            | exits 0                                          |
| running from source without `-A`               | **refused** — restart by hand                                  | exits 0                                          |
| `libraryMode` (a test, a host process)         | **refused** — `await app.close()` and run again                | closes the apps, keeps the process               |

`am restart` and the update handover use the same plan. A refusal is an ordinary
thrown error, so a method can show it.

## Desktop and CLI

- **AppImage / Electron (Linux)** — the new file is downloaded beside the
  running one, verified, and renamed over it. Renaming a running executable is
  safe on Unix (writing to one is not: `ETXTBSY`); the running process keeps its
  inode, and the path now resolves to the new version. Then the app restarts.
- **Electron (macOS `.app`)** — the release is the signed bundle as
  `<bin>-mac-<arch>.app.tar.gz` (`am publish` names it in `darwin-<arch>.json`;
  the `.dmg` beside it stays the first download). It is unpacked beside the
  running `X.app`, its seal checked with `codesign --verify --deep --strict` (a
  failure keeps the running version, untouched), then a detached shell swaps the
  folders once the app exits and relaunches it with `open -n`.
  - **Move it to /Applications first.** An app opened straight from the disk
    image or from Downloads runs from a read-only App Translocation copy (the
    browser's quarantine mark does that); it refuses to update, before
    downloading anything, with "Move X.app to /Applications … then update". A
    folder the user cannot write is refused the same way.
  - **Keychain.** An aio app creates no Keychain item. This was measured on
    macOS 14 across an update from 1.0.0 to 1.0.2: before and after it, there
    was no `<App> Safe Storage` entry, no SecurityAgent prompt, and
    `document.cookie` did not persist on the `aio://` page. A new ad-hoc
    identity per version therefore leaves nothing for macOS to ask about.
  - A swapped-in version carries no quarantine mark (it was never downloaded by
    a browser), so Gatekeeper does not hold its launch.
- **Electron (Windows)** — the install is a folder either way: unpacked from the
  `.zip` by hand, or extracted by the one-click `.exe` (SFX) to
  `%LOCALAPPDATA%\aio-sfx\<name>\win-<arch>\`. The downloaded `.exe` itself is
  never replaced. The folder is swapped by a detached helper once the app exits
  (it waits up to 30 s for every process running from the install, then up to 30
  s for the folder itself to become movable, and always ends with a version
  started). The helper starts through `CreateProcessW` with no console window;
  without `--allow-ffi`, through `cmd.exe`. The `--version` check of a new
  download runs off the app's thread, so the antivirus scan of a new exe does
  not freeze the window.
  - **The `.exe` after an update.** The SFX re-extracts its own payload whenever
    the folder's stamp (`.aio-sfx-stamp`, the hash of the payload that was
    extracted) is not its own. The updater therefore carries the stamp into
    every folder it swaps in — an update and a rollback alike — so the `.exe`
    the user keeps double-clicking stays a launcher for the updated app. A
    **different** `.exe` (a newer download, or an older one) has another hash
    and installs the version it carries over the folder: the `.exe` you open
    wins, in both directions. It refuses, changing nothing, while the app is
    running ("close it first").
  - An app built with aio 1.0.16-beta swaps without carrying the stamp; the
    updated version puts it back on its first start. Until that start — or if
    the updated version is itself built with aio 1.0.16-beta — opening the old
    `.exe` re-installs the old version over the update.
- **A CLI binary you launched yourself** — with no `auto`, the check at startup
  asks on the terminal: `Update to 2.1.0? The app will restart. [y/N]`. A
  non-interactive launch is never asked, because a service blocking on stdin
  that never arrives is how an app hangs at boot with no explanation.
- **Running from source** (`deno task dev`) — detection works identically, so
  you can develop your update banner against a real `file://` source. `apply()`
  refuses, loudly: there is no artifact to swap.
- **Android** — detection only. An app cannot replace its own APK, so a newer
  release is reported like a blocked one, carrying the **link to the package**
  so the user can open it in the system installer.

Every target shares one spine — fetch → verify → gate → stage → swap → restart →
roll back if it does not come up. Only the swap and the restart differ.

## What the app tells you at startup

```
build     compiled (appimage)
artifact  /opt/wallet/wallet-x86_64.AppImage
platform  linux/x86_64 · deno 2.9.1
data      /home/u/.wallet
updates   prod · manifest · every 6h · ask first
source    https://releases.example.com/wallet
```

An app with no update path prints `updates  not configured` — once, where
somebody will see it, rather than leaving its absence to be discovered when an
update is needed.

## Configuration reference

| Option          | Default            | Meaning                                         |
| --------------- | ------------------ | ----------------------------------------------- |
| `source`        | —                  | Release location or repository URL              |
| `auto`          | `false`            | Install without asking (services)               |
| `check`         | `true`             | `false` = manual only · a number = interval ms  |
| `channel`       | the artifact stamp | Directory (manifest) or ref (git)               |
| `key`           | trust on first use | Pin the signing key explicitly                  |
| `keys`          | —                  | Extra accepted keys, for a rotation             |
| `canApply`      | —                  | `() => boolean` — may an update land RIGHT NOW? |
| `allowUnsigned` | `false`            | Accept unsigned releases                        |
| `kind`          | inferred           | `"manifest"` or `"git"` when a URL is ambiguous |
| `prerelease`    | `dev` only         | Follow `2.1.0-rc.1`-style versions              |

### `canApply` — the one hook that cannot be defaulted

```ts
updates: {
  source: "https://releases.example.com/wallet",
  auto: true,
  canApply: () => !wallet.signing && !editor.dirty,
}
```

Consulted before **every** apply — the button, the unattended `auto` path, and
the terminal prompt all go through it. Only the app knows what it is in the
middle of: a signature being collected, an unsaved document, a transaction that
has not committed. A `false` refuses the install, says so, and leaves the
release standing for the next check. A hook that throws is treated as a refusal,
not as permission.

**Work belongs here.** The hook is awaited, it runs before a byte is downloaded,
and a throw fails closed carrying its own message — so something that must
succeed before an install can simply happen in it:

```ts
canApply: async () => {
  if (wallet.signing || editor.dirty) return false;
  await archiveTo(`${home}/backup/backup-${today}.zip`); // throws → no install
  return true;
},
```

This is the only seam that covers all three doors. A backup taken behind the
button is a promise `auto: true` and the terminal prompt break in silence.

Without it, `auto: true` has no guard of any kind — which is right for a service
and a surprise on a desktop, so an Electron install with `auto: true` and no
`canApply` says so loudly at boot.

## Cell state reference

| Field                 | Meaning                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | `updates` was configured — true from boot, not from the first answer                                                                    |
| `status`              | idle · checking · available · blocked · downloading · applying · staged · error                                                         |
| `available`           | see below, or null                                                                                                                      |
| `blocked`             | `{ version, blockers }` — newer, but unsafe here                                                                                        |
| `progress`            | 0..1 while downloading                                                                                                                  |
| `current` · `channel` | what is running, and what it follows. `current` is `null` when this build cannot say what version it is — render `current ?? "unknown"` |
| `currentUnknown`      | why `current` is null (a sentence for a log or a dev banner, never a version); `null` when the version resolved                         |
| `lastChecked`         | ISO timestamp                                                                                                                           |
| `dismissed`           | the version the user said no to (persisted)                                                                                             |
| `backupPath`          | the pre-migration backup this install took, or null — set before the swap                                                               |
| `error`               | last failure, verbatim                                                                                                                  |

`available` is
`{ version, reason, notes, size, releasedAt, migrates, signed, keyFingerprint, warnings }`.

- **`reason`** is the sentence to show. It matters because the version on offer
  can be the version already running — see below.
- **`signed`** and **`keyFingerprint`** are what the user is being asked to
  trust. An app running with `allowUnsigned` should say so where the button is,
  not only in a log.

Every status is observable by a client, including `checking` and `downloading`:
the cell publishes mid-method (`s.$commit()`), so a spinner and a progress bar
are ordinary reactive reads.

Methods: `check()` · `apply(opts?)` · `dismiss()` · `undismiss()` ·
`setChannel(name)`.

`check()` and `apply()` have no call ceiling, and while they run the ceiling of
every other pending call is paused (each gets a fresh window after), so an app
method that awaits `updates.apply()` is not told "stopped waiting" during a
multi-minute install. A page's own wait for its call is still the method's
ceiling: from the UI, call `updates.apply()` directly, or declare the app method
`long`.

`dismiss()` holds across polls and restarts: the dismissed version is persisted,
handed to every later check, and only a version **newer** than it is offered
again. It accepts a **blocked** release as its subject too — a notice with no
way to put it away is a notice people learn to ignore. `undismiss()` is the way
back.

### A new BUILD of the same version

A re-published `1.2.3` with different bytes is a real update, and it is
detected: the install records the SHA-256 of the artifact it is running (the
digest verified at the last swap — for a directory install, written once that
update is confirmed — or measured once from the artifact itself), and a manifest
whose digest differs at the same version is offered with
`reason: "same version, new build…"`. One released (signed `releasedAt`) BEFORE
the build installed by an update is an older build — a CDN edge still caching
the previous manifest, or a replay of it — and is not offered.

An install that cannot establish its own digest stays quiet and says so — "never
offer on ignorance" — rather than re-downloading its own bytes.

Version comparison ignores build metadata (`1.2.3+abc` is the release `1.2.3`,
not a prerelease of it), and a version string that cannot be ordered is refused
by name. In particular an app that cannot determine its own version refuses to
compare rather than reading itself as `0.0.0`, which with `auto: true` was an
infinite download → swap → restart loop.

### A blocked release on a FRESH install

"Blocked" is a statement about the data on this machine, not about the release.
An install with no stamped versions — a new machine, or one whose profile has
been retired — has nothing to be incompatible with, so the same release is
offered normally. That is what makes "start fresh" a real answer to a block, and
it holds by construction: the gate compares against what is stamped on disk, and
a fresh profile has nothing stamped.

aio has no one-step "retire my data and take it" verb. An app that wants one
archives the profile, moves `data/` aside (never deletes it), and relaunches —
the next boot is a fresh install and the release is offered. Doing that from
inside the running process is the hard part: the profile cannot be moved from
under the process holding it. Two processes is the honest shape — write a marker
beside the profile, quit, and let the next boot act on it before persistence
opens.

### Overriding the data gate

The gate is right almost always, and when it is wrong it is wrong permanently: a
contract published with a mistake blocks that app's every future release, on
every install, forever. So there is a door, and it is heavy:

```ts
await updates.apply({ acceptDataLoss: true });
```

It installs a **blocked** release — but only one the caller was shown the
blockers for, only if a backup can actually be taken (it refuses otherwise), and
it takes that backup before the download starts, logs every blocker at error
level, and names the file it wrote. Nothing else changes: the default is still
"never offered, and `apply()` refuses".

### Starting fresh: retiring the data

The other door for a blocked release. Where `acceptDataLoss` keeps the data and
lets the new build try to read it, `retireData` keeps the data **out of the
way**:

```ts
await updates.apply({ retireData: true });
```

At handover — after the shutdown contract has closed persistence, before the
successor starts — the whole profile is moved, in one atomic rename, to
`<home>/archive/<app>-<version>-<timestamp>/`, an empty profile takes its place,
and the new build boots clean. Nothing is deleted, ever. The update trust store
(the pinned signing key) is carried over so the next check does not re-pin, and
the rollback marker is re-armed with the archived store named as its backup, so
the new build still gets two boots to prove itself.

Every step is logged (`retireData ① … ⑤`), and a failure at any step names the
step and leaves the previous data exactly where it was — the app then restarts
against it, under the ordinary rollback net. To put an archive back: stop the
app, move the archive directory over `<home>/data`.

## When your delivery is not a shape aio can verify

`updates: { source }` covers a directory of signed manifests and a git ref — the
two aio knows how to check, verify and install. Some apps deliver differently:
an internal artifact server with its own auth, an MDM push, a signed blob the
app already syncs. For those, the platform half is replaceable whole:

```ts
import { installUpdatesRuntime, updates } from "aio/updates";

installUpdatesRuntime({
  kind: "manifest",
  channel: "stable",
  current: appVersion,
  exposed: false,
  check: async () => {
    const r = await ourArtifactServer.latest(); // your transport, your auth
    return r.version === appVersion
      ? { kind: "current", reason: "up to date" }
      : {
        kind: "offer",
        update: { version: r.version /* … */ },
      };
  },
  apply: async () => {
    await ourInstaller.run(); // your download, your verification, your swap
  },
  setChannel: async (c) => void await ourArtifactServer.follow(c),
});
```

Everything else still works: the cell state a UI binds to, the dismissal that
holds across polls, `canApply`, phase and progress reporting, and the same
`testUI` story below.

**Two things to know.**

It is **exclusive** with `updates:` in `aio.run()`. Boot refuses rather than
replacing your implementation with aio's, because configuration that is quietly
overruled is worse than configuration that is refused.

And **the guarantees become yours**. aio's runtime is where the signature is
verified against a pinned key, the download is bounded and checked against the
signed digest, the data contract is measured from the built artifact, and a
backup is taken before a migration. A runtime that skips those installs whatever
the source served. If what you need is a different _transport_ rather than a
different _trust model_, prefer a `source` aio can read.

## Testing your update banner

The cell's platform half is injected, so a test installs a stub in its place and
drives the UI it renders — no source, no network:

```tsx
import { testUI } from "aio/testing";
import { installUpdatesRuntime, updates } from "aio/updates";
import { App } from "./App.tsx";

installUpdatesRuntime({
  kind: "manifest",
  channel: "prod",
  current: "1.0.0",
  // `null` when this build cannot say what version it is; `currentUnknown`
  // then says why (alpha76 — it used to be one `string` field that sometimes
  // held the whole explanation).
  currentUnknown: null,
  exposed: false,
  check: () =>
    Promise.resolve({
      kind: "offer",
      update: {
        version: "2.0.0",
        reason: "2.0.0 is newer than 1.0.0",
        notes: null,
        size: null,
        releasedAt: null,
        migrates: false,
        signed: true,
        keyFingerprint: "0badc0ffee11",
        warnings: [],
      },
    }),
  apply: () => Promise.resolve(),
  setChannel: () => Promise.resolve(),
});

testUI(App, "the banner offers 2.0.0 and Not now dismisses it", async (ui) => {
  await updates.check();
  await ui.expectCell(updates, (u) => u.available?.version === "2.0.0");
  ui.NotNowButton.click();
  await ui.expectCell(updates, (u) => u.dismissed === "2.0.0");
});
```

`check(opts)` receives `{ dismissed }` — what the cell persisted — so a stub can
mirror the real rule (answer `current` when `opts.dismissed` is the version it
would offer). `installUpdatesRuntime(null)` takes the stub out again.

The other route needs no runtime at all:
`testUI(App, { seed: { updates: {
status: "available", available: { … } } } })`
(or `ui.seed({ updates: { … } })` mid-test) pins the cell state directly, for a
test that only cares how the banner renders.

## Security summary

- Signature covers version, digest, channel, target, platform and data contract
- The trusted key is pinned on first use; a different key is refused
- Unsigned is refused by default; stripping a signature never downgrades a
  pinned install
- Artifacts are verified by digest after download, before anything is swapped
- Versions only move forward within a channel
- On an exposed app, driving an update requires an authenticated user; on a
  loopback-bound app every client is already on the machine
- Configuring `updates` forces the `net` capability into the compiled binary's
  least-privilege flags, so the check cannot fail in production only

## Related

- [Release signing](signing.md) — the `aio/ship` API: keys, fingerprints,
  rotation, `manifestCore`, `verifyShipManifest`, `SAFE_TOKEN`
- [Build targets](../build/targets.md) — what `deno task build` produces
- [Versioning](../build/versioning.md) — how `major.minor.build` is derived, and
  how the update check orders it
