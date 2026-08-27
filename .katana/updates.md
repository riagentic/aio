# Updates

> Scope: the app-update feature — how a running app learns a new release exists,
> what it is allowed to install, how it installs it, and what happens when that
> goes wrong. Covers `updates:` in `aio.run`, the `updates` cell (`aio/updates`),
> `aio ship`, the trust store, and the rollback machinery. Not `am update`
> (which updates the framework's own tooling — see `onboard.md`).

The one rule this whole feature exists to keep: **an update never breaks the
app or its data, and never installs code the publisher did not sign.**
Everything below is a way of not breaking that rule.

## Detection

- a newer version on the followed channel is detected without the developer
  writing any polling code
- **a new BUILD of the same version is detected** — a republished `1.2.3` with
  different bytes is offered, because the digest of what is installed is
  recorded and compared. An install that never recorded one stays quiet rather
  than guessing
- build metadata (`1.2.3+abc`) never changes ordering, and never turns a release
  into a "prerelease"
- a version string that cannot be ordered is refused with the string named —
  never silently treated as `0.0.0`, and never compared against an app whose own
  version is unknown
- detection works identically when running from source, so an update UI can be
  developed against a real source without building anything
- a check that fails says so on the cell (`status`, `error`, `lastChecked`), and
  a failing source backs off instead of hammering the host forever
- a poll costs a conditional request; an unchanged channel costs a 304 and no
  body. A dismissal never poisons that cache into answering "you are the latest"

## Trust — what the app is allowed to install

- an unsigned release is refused unless the app opted in, and the opt-in says so
  at every step
- a signed release is verified against a key this install already trusts; the
  first verified release pins that key, loudly, and only over a transport that
  authenticates the host
- a trust store that cannot be read is a REFUSAL, never a silent return to
  trust-on-first-use
- everything a client decides on — version, digest, channel, target, platform,
  the data contract, the app's own name, and the text shown to the user — is
  inside the signature. A field outside it is a bug, not a nuance
- a manifest for another app, another channel, another platform or another
  target is refused before anything is downloaded
- the download is bounded by the signed size, verified against the signed
  digest, and the bytes that were verified are the bytes that get installed
- a value from a manifest never reaches a shell string, and never escapes the
  directory it belongs in
- the user can see whether a release was signed and by which key

## The data gate

- a release that cannot migrate the data on disk is never OFFERED — it is
  reported, with the reason, and there is no code path from that state to
  installed
- the contract is measured from the built artifact, never guessed from source
- when an update does migrate, a backup is taken BEFORE anything is swapped, and
  its path is named. An app that cannot take one is told, not quietly skipped
- a mis-published contract can be overridden deliberately by the operator — with
  the backup taken first and every blocker logged — because "blocked forever
  with no way out" is its own kind of data loss

## Applying it

- the app asks before restarting, unless it was told not to; the app can refuse
  the moment (`canApply`) so an update never lands mid-transaction
- the marker that makes a rollback possible is written BEFORE the swap, durably
- the swap is atomic, keeps the previous version, and never rewrites the running
  binary in place
- a staged artifact that cannot even execute is caught before the swap, not by
  crash-looping afterwards
- the new version proves itself by SERVING, not by starting; if it does not, the
  previous one is put back — on every install layout, including a symlinked
  versioned install and an unpacked directory — and a rollback that fails keeps
  its marker and says so
- what `am` believes is installed and what the app installed cannot disagree
- every install layout the framework can produce either applies updates or says
  exactly why it cannot, before the offer is shown — including when the install
  directory is not writable by the user running it

## Publishing

- one command produces a signed, verifiable release from a built artifact
- the file it writes is the file the client fetches — a publisher cannot
  silently produce a channel nothing can read
- the commands printed are the commands that work, on every surface that prints
  them (docs, CLI output, generated CI)
- a key can be rotated without bricking every existing install, or the recovery
  is documented precisely

## The developer's side

- the whole feature is one config line for the common case
- the update state is cell state: reactive, testable, visible in `am state`
- an app can test its update UI with no network and no release, through a
  supported seam
- an app that configures updates but renders nothing still tells its user
- intermediate states (`checking`, `downloading`, progress) are observable by a
  client, or they do not exist in the type
- every option an app can set is documented, defaulted defensibly, and validated
  loudly when set to something meaningless
