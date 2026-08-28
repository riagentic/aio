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

Useful flags: `--dir=/srv/releases` (where to stage), `--channel=test`,
`--notes="fixes the sync bug"`, `--no-build` (publish what `dist/` already
holds). Unsigned is allowed for a local or air-gapped channel, and every step
says so out loud — but a client only installs unsigned releases if the app opted
in.

The long way is the same three steps by hand, if you want to see them:

```sh
deno task compile
deno task ship ./dist/wallet --channel=prod   # signs with ~/.aio/keys/wallet-release-key.json (the `ship keygen` default) when it exists; --key=<path> picks another
# → wallet.ship.json, next to the artifact. Copy BOTH into <source>/prod/,
#   with the manifest named <os>-<arch>.json.
```

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
serving state; if it does not, it puts the previous artifact back and exits so
the supervisor starts a version that works, naming the backup if the update had
migrated data.

Under systemd (or any supervisor), aio exits and lets the unit restart it rather
than launching a competing process. On a plain CLI launch it starts the
successor itself.

**The unit's contract.** The generated unit (`deno task build --service`)
carries two lines the app relies on, and a hand-written unit must carry them
too:

```ini
Restart=always                 # an update or aio.restart() exits 0 to come back
RestartPreventExitStatus=143   # aio.stop() exits 143 to STAY down
Environment=AIO_SUPERVISED=1   # "exit; do not spawn your own successor"
```

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

| Field                 | Meaning                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `enabled`             | `updates` was configured — true from boot, not from the first answer            |
| `status`              | idle · checking · available · blocked · downloading · applying · staged · error |
| `available`           | see below, or null                                                              |
| `blocked`             | `{ version, blockers }` — newer, but unsafe here                                |
| `progress`            | 0..1 while downloading                                                          |
| `current` · `channel` | what is running, and what it follows                                            |
| `lastChecked`         | ISO timestamp                                                                   |
| `dismissed`           | the version the user said no to (persisted)                                     |
| `backupPath`          | the pre-migration backup this install took, or null — set before the swap       |
| `error`               | last failure, verbatim                                                          |

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

`dismiss()` holds across polls and restarts: the dismissed version is persisted,
handed to every later check, and only a version **newer** than it is offered
again. It accepts a **blocked** release as its subject too — a notice with no
way to put it away is a notice people learn to ignore. `undismiss()` is the way
back.

### A new BUILD of the same version

A re-published `1.2.3` with different bytes is a real update, and it is
detected: the install records the SHA-256 of the artifact it is running (the
digest verified at the last swap, or measured once from the artifact itself),
and a manifest whose digest differs at the same version is offered with
`reason: "same version, new build…"`.

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
