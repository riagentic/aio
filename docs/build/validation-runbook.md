# Full-matrix validation runbook (perfect-aio D6/B5)

D6 promises FULL support: 5 local targets + 6 remote forms, on
Linux/Windows/macOS/Android, at the "small apps flawless" bar. This runbook is
the checklist that keeps that promise honest. Automatable parts run in CI; the
physical parts need real machines — record results in the table at the bottom.

## 1. Automated (every release — one command)

```sh
deno task check:matrix
```

Runs: per-target boot + WS-increment smoke for all 10 target examples, example
UI functional tests, the full onboarding e2e (install → create → dev → compile →
android APK), and the build smoke (scaffold → compile → binary). Green = the
in-repo bar.

```sh
deno task test:build       # + AIO_BUILD_ELECTRON=1 for the real AppImage
```

Artifact reliability — the gate for "the thing we ship actually runs". Every
compile target is built for real and its binary must **boot from a foreign
working directory** and serve; the generated systemd unit's own `ExecStart`
flags must boot it; a fleet build's `dist/` + `manifest.json` must describe
files that exist, match their recorded sizes and run; and an app with a `.wasm`
must instantiate it inside the compiled binary. Running artifacts from their
build directory is what hid two shipped bugs (a non-portable binary and a
service unit that could not start), so the foreign cwd is the point.

## 2. Off-box remote (two machines, ~30 min)

On machine A (the server):

```sh
am create remote-check && cd remote-check
deno task dev --expose        # binds 0.0.0.0, prints the share link + key
```

On machine B (same LAN, then ideally a different network):

- open the share link in a browser → counter increments, updates live ✚
- `deno task build --targets=cli-client` a cli-client build, connect with the
  link
- kill the server → client shows the reconnect state loudly; restart → client
  recovers without reload

Pass = all three; record any silent failure verbatim (that's a P1).

## 3. Windows (~20 min)

```powershell
irm https://raw.githubusercontent.com/riagentic/aio/main/install.ps1 | iex
am create win-check; cd win-check
deno task dev --open # --open: the browser opens (plain `dev` prints the URL); counter works
deno task compile    # binary runs
deno task test       # starter test green
```

## 4. macOS (~20 min)

Same as Windows with the curl installer. Additionally:
`deno task dev --client=electron` (auto-install path) and
`deno task build --targets=electron`.

## 5. Android — real device (~30 min)

```sh
am create droid-check && cd droid-check
deno task build --targets=android  # APK builds
adb install app-release.apk        # on the REAL device (not emulator)
# launch: counter works offline; with `deno task dev` running on the same
# network + the android dev flow (deno run -A jsr:@riagentic/aio/dev-android)
# against the device: live reload reaches it
```

## Results ledger

A row is a run somebody did, on the machine named. None of these is a recorded
gate — `deno task check:proof` prints the recorded ones (`proof-matrix.json`).

| date       | check                                                  | machine/OS                          | result                                                          | notes                                       |
| ---------- | ------------------------------------------------------ | ----------------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| 2026-10-07 | the full test suite, run natively                      | Linux x64 workstation               | ran; what it found was fixed before the 1.0.19-beta tag         | every release                               |
| 2026-10-07 | the full test suite, run natively                      | Windows 11 x64, a KVM guest         | ran; what it found was fixed before the tag (CHANGELOG, 1.0.19) | by hand, over ssh                           |
| 2026-10-07 | the full test suite, run natively                      | Windows 11 x64, a real laptop       | ran; what it found was fixed before the tag                     | by hand, over ssh                           |
| 2026-10-07 | the full test suite, run natively                      | macOS 26, Apple silicon, a real Mac | ran; what it found was fixed before the tag                     | by hand, over ssh                           |
| 2026-10-07 | a shipped app: the Windows `.zip` and one-click `.exe` | Windows 11 x64, a real laptop       | the packaged app ran                                            | started from a shell, not by a double-click |

**Not run for 1.0.19-beta**, so nothing in these docs may claim it: sections 2–5
above as written (the two-machine check, the one-line installers on a clean
Windows or macOS, a real Android device); a double-click on a real desktop
(SmartScreen, Gatekeeper, the firewall question); opening a `.dmg` on macOS; an
Intel Mac; the Windows `.exe` under Wine (`deno task test:wine`).
