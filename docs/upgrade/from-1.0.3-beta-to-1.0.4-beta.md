# Upgrading from 1.0.3-beta to 1.0.4-beta

**Nothing breaks.** The public surface is byte-identical to 1.0.3-beta — there
is no migration step to perform.

```sh
am pin --latest
```

1.0.4-beta is the macOS round. The `electron` target now produces a real, signed
`.app` inside a `.dmg` (Dock identity, icon and window all correct), Chromium's
translations are trimmed on every platform, and one Electron version governs the
whole framework. The full account is `CHANGELOG.md`.

## Building a macOS `.dmg`

The `.app` is assembled on any host; only `hdiutil` needs macOS. Pick one:

```sh
# On a Mac — nothing to configure
deno task build --targets=electron --platforms=macos-arm64

# From Linux/Windows CI, through a Mac reachable over SSH
AIO_MACOS_SSH=dev@mac-mini deno task build --targets=electron --platforms=macos-arm64

# …or pin it in the app's deno.json
# "build": { "macos": { "host": "dev@mac-mini" } }
```

With no Mac configured the build writes `<name>-<version>-mac-<arch>.zip` (a zip
of the `.app`) and warns. That zip runs on Intel, but **Apple Silicon refuses an
unsigned arm64 binary** — sign it on a Mac, or configure one, before shipping.

## What you may notice

| behaviour                                                                                                      | what to do if you hit it                                                            |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| the macOS artifact is a `.dmg` (or a `.zip`), not `-mac-x64.zip`                                               | expected — the `.app` is inside; drag it to `/Applications`                         |
| the Dock shows your app's name and icon, not "Electron"                                                        | expected — the bundle now carries your identity                                     |
| the Linux AppImage / Windows zip is ~46-49 MB smaller                                                          | expected — unused Chromium locales are no longer shipped                            |
| a non-English Chromium menu (a context item, an error page) is now English                                     | expected — locale trimming is English-only by default                               |
| `am create` writes `"electron": "npm:electron@44.4.1"` (exact) instead of bare                                 | expected — a pinned version, not whatever is latest at install time                 |
| an app installed from the OLD macOS zip refuses to self-update to the new `.app`                               | install the new `.dmg` once by hand — the update is refused before anything changes |
| a downloaded `.dmg` shows a Gatekeeper warning on first open                                                   | expected for an app that is not notarized — see `docs/build/targets.md`             |
| fewer dev warnings: a same-value primitive `signal.set`, a label-wrapped input, a method called from `onMount` | expected — each was a false alarm; the real cases still warn                        |

## Retire

| workaround                                                                               | fixed in   |
| ---------------------------------------------------------------------------------------- | ---------- |
| unpacking the macOS zip and running `./run.sh` by hand                                   | 1.0.4-beta |
| renaming `Electron.app`/editing its `Info.plist` so the Dock showed the app's name       | 1.0.4-beta |
| pinning `npm:electron` to a specific version by hand to keep dev and the build in step   | 1.0.4-beta |
| treating the old `-mac-x64.zip` (a bare binary beside `Electron.app`) as distributable   | 1.0.4-beta |
| shipping all ~55 Chromium locales because there was no way to trim them                  | 1.0.4-beta |
| `if (sig.peek() !== v)` guards around a primitive `set`, only to silence the dev warning | 1.0.4-beta |
| a redundant `aria-label` on an input already nested in a `<label>`                       | 1.0.4-beta |
