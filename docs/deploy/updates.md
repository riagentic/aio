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

| Your cell declares               | Can migrate from | An install holding v1 data  |
| -------------------------------- | ---------------- | --------------------------- |
| `version: 2` **and** `onMigrate` | v1 and up        | offered, backup taken first |
| `version: 2`, **no** `onMigrate` | v2 only          | **never offered**           |
| unchanged `version`              | —                | offered                     |

The second row is the one that matters. Bumping a cell version and forgetting
the migration used to be a data-loss incident at some user's next boot. Now it
is an update they are simply never shown — and `aio ship` tells you at publish
time.

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
(pinned at install)            this machine
updates: { channel: "test" }   this app
(the artifact's stamp)         ← the default
"prod"
```

Poll cadence follows the channel: `dev` 1m · `test` 5m · `prod` 6h, jittered,
and conditional (`If-None-Match`), so an unchanged check costs a 304 and no
body. Override with `check: <ms>`, or `check: false` for manual-only.

## Publishing

```sh
deno task compile
deno run -A jsr:@riagentic/aio/ship ./dist/wallet --channel=prod --key=release-key.json
# → wallet.ship.json, next to the artifact. Copy both to <source>/prod/.
```

Or let CI do it:

```sh
deno run -A jsr:@riagentic/aio/ship github --channel=prod
# → .github/workflows/release.yml
```

That writes a workflow which builds on Linux, macOS and Windows, signs each
artifact, and publishes into the channel layout above as a GitHub Release. Put
the output of `ship keygen` in the repo secret `AIO_SIGNING_KEY`, then point the
app at the release base URL:

```ts
updates: "https://github.com/OWNER/REPO/releases/latest/download";
```

It is emitted, not integrated: the layout is the part aio owns, and a workflow
file does the rest natively without the framework depending on a forge's API.
Edit it freely — it is a normal file in your repo.

`aio ship keygen > release-key.json` makes the signing key. Publish only the
public half — it rides inside the manifest.

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
- **Android** — detection only; APKs install through the OS.

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
| `allowUnsigned` | `false`            | Accept unsigned releases                        |
| `kind`          | inferred           | `"manifest"` or `"git"` when a URL is ambiguous |

## Cell state reference

| Field                 | Meaning                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `enabled`             | `updates` was configured                                               |
| `status`              | idle · checking · available · blocked · downloading · applying · error |
| `available`           | `{ version, notes, size, releasedAt, migrates, warnings }` or null     |
| `blocked`             | `{ version, blockers }` — newer, but unsafe here                       |
| `progress`            | 0..1 while downloading                                                 |
| `current` · `channel` | what is running, and what it follows                                   |
| `lastChecked`         | ISO timestamp                                                          |
| `error`               | last failure, verbatim                                                 |

Methods: `check()` · `apply()` · `dismiss()` · `setChannel(name)`.

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
