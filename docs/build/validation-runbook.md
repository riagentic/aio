# Full-matrix validation runbook (perfect-aio D6/B5)

D6 promises FULL support: 5 local targets + 6 remote forms, on
Linux/Windows/macOS/Android, at the "small apps flawless" bar. This runbook is
the checklist that keeps that promise honest. Automatable parts run in CI; the
physical parts need real machines — record results in the table at the bottom.

## 1. Automated (every release — one command)

```sh
deno task validate:matrix
```

Runs: per-target boot + WS-increment smoke for all 10 target examples, example
UI functional tests, the full onboarding e2e (install → create → dev → compile →
android APK), and the build smoke (scaffold → compile → binary). Green = the
in-repo bar.

## 2. Off-box remote (two machines, ~30 min)

On machine A (the server):

```sh
am create remote-check && cd remote-check
deno task dev:expose          # binds 0.0.0.0, prints the share link + key
```

On machine B (same LAN, then ideally a different network):

- open the share link in a browser → counter increments, updates live ✚
- `deno task compile:cli --remote` a cli-remote build, connect with the link
- kill the server → client shows the reconnect state loudly; restart → client
  recovers without reload

Pass = all three; record any silent failure verbatim (that's a P1).

## 3. Windows (~20 min)

```powershell
irm https://raw.githubusercontent.com/riagentic/aio/main/install.ps1 | iex
am create win-check; cd win-check
deno task dev        # browser opens, counter works
deno task compile    # binary runs
deno task test       # starter test green
```

## 4. macOS (~20 min)

Same as Windows with the curl installer. Additionally: `deno task
dev:electron`
(auto-install path) and `compile:electron`.

## 5. Android — real device (~30 min)

```sh
am create droid-check && cd droid-check
deno task compile:android          # APK builds
adb install app-release.apk        # on the REAL device (not emulator)
# launch: counter works offline; with `deno task dev` running on the same
# network + dev:android against the device: live reload reaches it
```

## Results ledger

| date                                                                         | check | machine/OS | result | notes |
| ---------------------------------------------------------------------------- | ----- | ---------- | ------ | ----- |
| _(record each run here — a target claims tier-1 truthfully only with a row)_ |       |            |        |       |
