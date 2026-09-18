# Upgrading from 1.0.4-beta to 1.0.5-beta

**The public surface is byte-identical to 1.0.4-beta** — no code change is
needed.

```sh
am pin --latest
```

One behaviour changes on purpose: **aio now decides your app's Electron.** The
full account is `CHANGELOG.md`.

## Your app's Electron

aio is tested with one Electron (44.4.1 in this release), and a build now always
ships that one. Your app's `"electron": "npm:electron@x.y.z"` line and its
`node_modules` runtime are copies aio keeps in line — `am pin` moves both, and
`am fix` repairs either. If your app was scaffolded by an older aio, the first
`am pin --latest` (or `am fix`) moves it:

```
Electron 43.0.0 → 44.4.1 (the version this aio is tested with): installed
```

Offline, `am pin --no-download` moves the line and leaves the runtime for a
later `am fix`; a build ships the tested version regardless.

## What you may notice

| behaviour                                                                               | what to do if you hit it                                                      |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `am pin` / `am fix` rewrites the `electron` line in `deno.json` and downloads a runtime | expected — commit the `deno.json` change                                      |
| a build prints "Electron 44.4.1 ships … but deno.json says …"                           | run `am fix` — the build already ships the right one; this aligns dev with it |
| the first dev start after the upgrade downloads Electron                                | expected once — dev now runs the Electron the build ships                     |
| a Windows desktop app opens its native dialog with no PowerShell window                 | expected — the Terminal window was the bug                                    |
| a large Windows desktop app that opened to an empty window now renders                  | rebuild it — the local pipe dropped the end of the page script                |
| a new warning: `x.m() got a DOM InputEvent … as argument 1`                             | a raw element handler passed the Event, not the value — use the fix it names  |
| a new warning: `args.m lists 3 rules, but m takes 2 arguments`                          | slot 0 is the method's FIRST argument, not `s` — drop the leading `null`      |
| `signal.value = x` throws "…read-only — use .set(v) or .update(fn)"                     | it always threw; the message now names the fix                                |
| `am create --json` has a `next` field                                                   | expected — the commands that take the new app to running                      |
| a standalone Android APK's buttons now work                                             | they threw on every tap since 1.0.0-beta — rebuild the APK                    |
| a client APK / iOS client opens its server on every launch, not just the first          | Back from the server's first page opens the connect form, to change it        |
| a client APK that cannot reach its server shows the connect form, saying so             | expected — it used to show Chromium's "Webpage not available"                 |
| a link to another site in an Android APK opens the phone's browser                      | expected — it used to do nothing at all                                       |
| rotating an Android APK no longer reloads the app                                       | expected — unsaved text and scroll position used to be lost                   |

## Retire

| workaround                                                                              | fixed in   |
| --------------------------------------------------------------------------------------- | ---------- |
| editing `npm:electron@…` by hand after an aio upgrade to keep dev and the build in step | 1.0.5-beta |
| deleting `node_modules/electron` so dev would fetch the framework's Electron            | 1.0.5-beta |
| hiding the PowerShell window around a native dialog (or living with it) on Windows      | 1.0.5-beta |
| an `<app>/android/` MainActivity.kt overlay only to let a client APK reach its server   | 1.0.5-beta |
