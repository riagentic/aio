# Upgrading from 1.0.2-beta to 1.0.3-beta

**Nothing breaks.** The public surface is byte-identical to 1.0.2-beta — there
is no migration step to perform.

```sh
am pin --latest
```

1.0.3-beta is the Windows round. A Windows desktop app now opens on the first
double-click from either artifact, and the one-file exe binds **zero TCP
ports**; Electron version, packaged platform and npm payload are all decided
once and checked rather than assumed. The full account is `CHANGELOG.md`.

## What you may notice

| behaviour                                                                  | what to do if you hit it                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| a Windows one-file exe binds no TCP port (it used to open a loopback port) | expected — the window loads its embedded bundle over the local pipe  |
| the packaged app and the dev server run the version in your `node_modules` | expected — one `resolveElectronVersion` decides for both artifacts   |
| a first launch of the self-contained exe takes a few seconds               | expected — it is unpacking Electron once; later launches are instant |
| the Windows zip is smaller than before                                     | expected — the Linux tree and dev-only npm packages no longer ship   |

## Retire

| workaround                                                                                         | fixed in   |
| -------------------------------------------------------------------------------------------------- | ---------- |
| shipping `dist/` beside a Windows binary just so the window could open with zero ports             | 1.0.3-beta |
| running `deno task install:electron` before double-clicking a Windows build                        | 1.0.3-beta |
| setting `$ELECTRON_PATH` at a hand-unpacked runtime because the packaged one would not start       | 1.0.3-beta |
| a `run.bat` launcher added to work around the exe silently downloading the runtime on first launch | 1.0.3-beta |
