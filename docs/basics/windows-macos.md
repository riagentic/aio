# aio on Windows and macOS

Most snippets in these docs are written for a POSIX shell on Linux. This page is
the one place that says what changes on Windows and macOS: how to type the same
commands in PowerShell, where the files are, what the OS asks the user, and what
aio does not do for you there.

What has been run on each OS, and what has not, is in the
[validation runbook](../build/validation-runbook.md#results-ledger). Nothing
below is a claim beyond it.

## Windows: what you need

| Need       | Detail                                                                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git        | install it first (`winget install Git.Git`) — `install.ps1` stops without it                                                                                                                                                                                     |
| PowerShell | the stock Windows PowerShell 5.1 is enough; `install.ps1` and `run.ps1` use no PowerShell 7 syntax                                                                                                                                                               |
| Deno       | `install.ps1` installs it into `%USERPROFILE%\.deno` when missing or older than aio's minimum, and adds it to your `PATH`                                                                                                                                        |
| aio        | cloned to `%HOME%\.local\lib\aio` when `HOME` is set, else `%USERPROFILE%\.local\lib\aio` — a checkout already at `%USERPROFILE%\.local\lib\aio` (every install before 1.0.20) stays the one used (`$env:AIO_HOME` overrides); `am` is installed from that clone |

`deno task …` and `am …` are typed the same in every shell. A task body in
`deno.json` may use `&&`: Deno runs tasks in its own shell, on every OS.

## PowerShell for the POSIX snippets

| The docs show (sh)                 | Type in PowerShell 5.1                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `a && b`                           | one command per line (or `a; if ($?) { b }`) — 5.1 has no `&&`                |
| `AIO_X=1 deno task dev`            | `$env:AIO_X = '1'; deno task dev` — stays set for that window                 |
| `export AIO_X=1` / `unset AIO_X`   | `$env:AIO_X = '1'` / `Remove-Item Env:AIO_X`                                  |
| `~/.myapp/…`                       | `$HOME\.myapp\…` (see [what `~` is](#where-things-are))                       |
| `tail -f ~/.myapp/logs/app.log`    | `Get-Content -Wait -Tail 20 $HOME\.myapp\logs\app.log`, or `am logs -f`       |
| `grep ERROR ~/.myapp/logs/app.log` | `Select-String -Path $HOME\.myapp\logs\app.log -Pattern ERROR`                |
| `curl -fsSL …/install.sh \| sh`    | `irm https://raw.githubusercontent.com/riagentic/aio/main/install.ps1 \| iex` |
| `curl -fsSL …/run.sh \| sh -s …`   | `run.ps1`, below                                                              |
| `./myapp --port=8080`              | `.\myapp.exe --port=8080`                                                     |
| `sudo cp`, `systemctl`, `chmod`    | no twin — see [run at startup](#run-at-startup-or-as-a-service)               |

`run.ps1` takes switches where `run.sh` takes flags:

```powershell
$run = [scriptblock]::Create((irm https://raw.githubusercontent.com/riagentic/aio/main/run.ps1))
& $run -Git owner/repo     # clone, build, install, run
& $run -Dev                # in an app repo: the dev server instead of a build
& $run -NoRun              # build and install, do not start
& $run -NoInstall          # run from dist\, install nothing
```

`dep/aio` in a scaffolded app is a directory **junction** on Windows, not a
symbolic link — a junction needs no Developer Mode and no administrator. `dep/`
is gitignored on every OS: a fresh clone has no `dep/aio` until `am fix` makes
it.

## Where things are

`~` in these docs is the home directory aio reads: `$HOME`, and on Windows
`%HOME%` when it is set (Git Bash and OpenSSH set it), else `%USERPROFILE%`.

| What                                   | Linux                                        | macOS                                                 | Windows                                                    |
| -------------------------------------- | -------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| App data, logs                         | `~/.<appId>/`                                | `~/.<appId>/`                                         | `%USERPROFILE%\.<appId>\`                                  |
| Lock, sockets                          | `$XDG_RUNTIME_DIR/aio/`, else `/tmp/aio/`    | `/tmp/aio/`                                           | `%TEMP%\aio\`; pipes `\\.\pipe\aio-<appId>` (and `…-http`) |
| The window's profile (Electron)        | `~/.<appId>/electron/`                       | `~/.<appId>/electron/`                                | `%USERPROFILE%\.<appId>\electron\`                         |
| Electron itself (`"online"` apps)      | `~/.local/share/aio/electron/`               | `~/Library/Application Support/aio/electron/`         | `%LOCALAPPDATA%\aio\electron\` — shared by every aio app   |
| A desktop app installed by its package | where the AppImage was put                   | `/Applications/<Title>.app`                           | `%LOCALAPPDATA%\aio-sfx\<name>\` + a Start-menu shortcut   |
| An app installed by `run.sh`/`run.ps1` | `~/app/<name>/` + a `.desktop` entry         | `~/app/<name>/` ([below](#macos-what-runsh-installs)) | `%LOCALAPPDATA%\Programs\<name>\` + a Start-menu shortcut  |
| aio's local root certificate           | `~/.aio/ca/`                                 | `~/.aio/ca/`                                          | `%USERPROFILE%\.aio\ca\`                                   |
| Build tool cache (Electron runtimes)   | `$XDG_CACHE_HOME/aio/tools`, else `~/.cache` | `~/.cache/aio/tools`                                  | `%USERPROFILE%\.cache\aio\tools`                           |

The full layout of `~/.<appId>/`, and what a backup holds, is in
[Where files live](../persistence/where-files-live.md).

**For someone who only uses the app** (no `am`, no terminal): the state is
`data\` and the logs are `logs\app.log`, `logs\error.log` and `logs\client.log`
inside the first row's folder. The folder starts with a dot — Finder hides it
(Go → Go to Folder, type `~/.<appId>`); Explorer shows it. aio adds no "open
logs" menu item; an app that wants one builds it.

### macOS: what `run.sh` installs

A desktop app installed by `run.sh` is its bundle,
`~/app/<name>/versions/<version>/<Title>.app`, plus the link
`~/app/<name>/<Title>.app` that always names the newest version; `run.sh` opens
that link. It writes no `.desktop` entry (a Linux convention) and puts nothing
in `/Applications`. `am remove <name>` removes `~/app/<name>/` — every version
and the link. A copy that was moved to `/Applications` afterwards (the app
offers the move once it is up) is not aio's to find: delete it by hand.

Run again while the app is open, `run.sh` installs the new version and says the
app is already open: macOS only brings the running window forward, so quit the
app and open it again to run the new copy. While it is open, the bundle it runs
from is not replaced and older versions are not pruned.

### Windows: two copies of one app

A pipe name is machine-wide, so an app's pipe carries where its lock lives. With
no `AIO_APPS_DIR` the name is `aio-<appId>` as it always was. Under an
`AIO_APPS_DIR` it is `aio+<scope>+<key>`, so two copies of one app in two apps
directories no longer ask for the same pipe. An app whose pipe name is already
hosted — by another instance, another Windows user, any other process — refuses
to start and says so. And an app run from source that needs a pipe but was
started without `--allow-ffi` refuses before its `running` line, naming
`--allow-ffi` and `--transport=ws`.

## Stopping an app

A clean stop runs `onStop` and the final write to disk. A hard kill does
neither: what the last flush had not written yet is lost (the
[persist window](../persistence/how-it-works.md)).

| How                                                     | Linux, macOS                       | Windows                            |
| ------------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| `am stop`                                               | clean                              | clean                              |
| Ctrl-C in its terminal                                  | clean                              | clean                              |
| closing the desktop window; `app.close()`; `aio.stop()` | clean                              | clean                              |
| `am stop` when the app does not answer                  | SIGTERM — clean                    | the process is ended — **hard**    |
| `am kill`                                               | clean (the app handles the signal) | asked first — clean; else **hard** |
| `kill <pid>` (SIGTERM)                                  | clean (the app handles the signal) | the process is ended — **hard**    |
| `kill -9`; Force Quit; Task Manager; `taskkill /F`      | **hard**                           | **hard**                           |

Windows has no SIGTERM, so there `am kill` asks the app to stop first — the
request `am stop` sends — and waits up to 3 seconds for it to be gone. Then it
says which of three things happened: `stopped <app> cleanly`;
`killed <app> … ended hard: onStop and the last flush did not run` when the app
did not answer or did not finish in time and the process was ended; or
`<app> … was not running any more` when it had already gone (a crash) and
nothing was stopped or killed. With `--json` the same answer is the `how` field:
`"clean"`, `"hard"` or `"gone"` (`killed` is `false` for `"gone"`). Stop with
`am stop`, Ctrl-C or the window; `am kill` is for an app that is stuck.

## First launch of a downloaded desktop app

Neither package is signed with a certificate the OS knows, so each OS holds the
first launch of a **downloaded** copy:
[Gatekeeper and SmartScreen](../build/targets.md#first-open-of-a-downloaded-app).

## The firewall, when you `--expose`

aio opens no firewall rule. On Windows and macOS an `--expose` boot prints one
line that starts with `firewall:` and says what the OS may ask and where to fix
a refusal; Linux gets no line. The first time a program listens beyond loopback,
the OS may ask the person at the screen:

| OS      | What appears                                                                                         | If it is dismissed or denied                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Windows | a Windows Security dialog asking whether `<program>` may be reached from your networks               | a **block** rule is kept for that program; allow it under _Allow an app through Windows Firewall_, or see below |
| macOS   | "Do you want the application to accept incoming network connections?" — only when the firewall is on | blocked; change it under System Settings → Network → Firewall → Options                                         |
| Linux   | nothing                                                                                              | a host firewall (`ufw`, `firewalld`) needs the port opened by hand                                              |

A blocked server **looks dead from other machines and healthy on its own**: the
boot line, `am status` and `http://127.0.0.1:<port>` all work. Check from the
second machine before debugging anything else. `<program>` is `deno.exe` in dev
and your `.exe` once compiled, so the question comes again for the built app.
With nobody at the screen (a scheduled task, a service) there is no question and
the default applies: on Windows, blocked.

```powershell
# an administrator PowerShell — allow one compiled server, on private networks
New-NetFirewallRule -DisplayName 'myapp' -Direction Inbound -Action Allow -Profile Private -Program 'C:\apps\myapp\myapp.exe'
```

## macOS: Local Network permission

macOS 15 and later asks, per app, before it may reach other devices on the local
network. That covers a Mac window (or a terminal running `am`, `deno`) that
connects to an aio server on the LAN, not only
[`am discover`](../clients/electron.md#how-discovery-works). Denied, the
connection fails as if the server were down while the internet still works.
Allow it under System Settings → Privacy & Security → Local Network. aio names
the permission when a discovery probe could not be sent; for a plain connection
it adds no such hint.

## Run at startup, or as a service

A `server` target's build writes the supervisor file of the OS it was built for,
beside the artifact: the systemd unit on Linux, `<artifact>.plist` (a launchd
agent) for macOS, and `<artifact>.ps1` (a Task Scheduler script, the artifact's
name without `.exe`) for Windows. Each file starts with how to install and
remove it. The two written out below are the same contract by hand, for an app
that is not a `server` target.

What the app expects from a supervisor, with `AIO_SUPERVISED=1` in its
environment:

| The app                                | Exits with | The supervisor should |
| -------------------------------------- | ---------- | --------------------- |
| updated itself, or `aio.restart()`     | `0`        | start it again        |
| was asked to stop: `aio.stop()`        | `143`      | leave it down         |
| was asked to stop: `am stop`           | `0`        | start it again        |
| … with `AIO_STOP_STAYS_DOWN=1` as well | `143`      | leave it down         |
| crashed                                | other      | start it again        |

`am stop` exits 0 under `AIO_SUPERVISED=1` alone — what it has always done, so a
service that comes back after it keeps doing so. `AIO_STOP_STAYS_DOWN=1` beside
it makes `am stop` mean what `aio.stop()` means; the `.plist` and `.ps1` a build
writes set it, the systemd unit carries it as a commented line.

Without `AIO_SUPERVISED=1` a compiled app that updates or restarts starts its
own successor — and a supervisor that also starts one leaves two processes
competing for one app lock.

**Windows — Task Scheduler.** It cannot tell exit codes apart, so a four-line
loop is the supervisor and the task only starts it at logon:

```powershell
# C:\apps\myapp\serve.ps1
$env:AIO_SUPERVISED = '1'
$env:AIO_STOP_STAYS_DOWN = '1'
do {
  & 'C:\apps\myapp\myapp.exe' --headless --expose
  $code = $LASTEXITCODE
  if ($code -ne 143) { Start-Sleep -Seconds 5 }
} while ($code -ne 143)
```

```powershell
# once, in an administrator PowerShell
$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\apps\myapp\serve.ps1'
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'myapp' -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName 'myapp'
```

Without `-Settings` Task Scheduler ends a task after three days and does not
start it on battery. To take it down: `am stop --app=myapp`, then
`Stop-ScheduledTask -TaskName myapp` within the loop's five seconds —
`Stop-ScheduledTask` alone ends the process tree the hard way. The loop and the
task registration were run on Windows 11 (PowerShell 5.1) with a stand-in
program; no aio release check runs an app this way.

**macOS — launchd.** Save as `~/Library/LaunchAgents/app.aio.myapp.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>app.aio.myapp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/myapp</string>
    <string>--headless</string>
    <string>--expose</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AIO_SUPERVISED</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.aio.myapp.plist   # start now, and at every login
launchctl bootout gui/$(id -u)/app.aio.myapp                                  # stop (SIGTERM — a clean stop) and unload
```

launchd has no "every exit code but 143": with `KeepAlive` true this
hand-written agent also starts the app again after `aio.stop()` and `am stop`,
so stop it with `launchctl bootout`. (The `.plist` a build writes runs the app
in a small loop that ends on 143 and sets `AIO_STOP_STAYS_DOWN=1`, so `am stop`
keeps it down.) The file passes `plutil -lint` on macOS 26; no aio release check
loads it.

## Uninstalling a desktop app

aio ships no uninstaller for a packaged desktop app. These are the places:

| OS      | The program                                                                                        | Its data and window profile (deleting it cannot be undone) |
| ------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\aio-sfx\<name>\` and `%APPDATA%\Microsoft\Windows\Start Menu\Programs\<title>.lnk` | `%USERPROFILE%\.<appId>\`                                  |
| macOS   | `/Applications/<Title>.app` (or `~/Applications`)                                                  | `~/.<appId>/`                                              |
| Linux   | the `.AppImage` file                                                                               | `~/.<appId>/`                                              |

An `"online"` app's Electron is in the per-user store every aio app shares
(table above): `am prune --yes` removes what no installed app needs any more.

Close the app first: Windows refuses to delete a running program's folder. The
Windows zip has no install step — delete the folder it was extracted to. An app
installed with `run.sh` / `run.ps1` is removed with
[`am remove <name>`](../clients/app-manager.md#which-aio-version-an-app-builds-against).
On Windows it also removes the one-click install
`%LOCALAPPDATA%\aio-sfx\<name>\`, and a Start-menu shortcut only when it opens
the app being removed — its target is inside one of that app's two install
folders. A shortcut that merely has the app's name, or only mentions its folder
(in its arguments, its icon), is somebody else's: it stays, and does not make an
app count as installed.

`am upgrade <name>` upgrades a one-click install without opening it: it builds
the new `.exe` from the recorded source and runs it with `--aio-sfx-install`,
which installs that version over the one that is there (an older one too — that
is how you go back) and starts nothing. The Start-menu shortcut is added by the
`.exe` whenever it extracts the app — under `--aio-sfx-install` too, before any
start — and not again for files that are already installed, nor by an upgrade of
an install whose shortcut is on record (a removed one stays removed); only an
install whose `.exe` added none gets it from the app, at its first start. Close
the app first: while it runs the `.exe` changes nothing, and `am upgrade` exits
1 saying so, with the install and its record as they were. An `.exe` built with
aio 1.0.19-beta or older has no such switch: under `-NoRun` it is installed the
way 1.0.19's `run.ps1` installed every `.exe` — a copy under
`%LOCALAPPDATA%\Programs\<name>\` with a Start-menu shortcut, recorded, exit
code 0 — and installs itself under `aio-sfx\` when that copy is first run. An
app that already has such a `Programs\<name>\` install keeps being updated
there, whatever built its `.exe`.

`run.ps1` without `-NoRun` opens the one-click `.exe` and gives the terminal
back as soon as the app is installed and started: its exit code is the `.exe`'s
own — 0 when the app was started, non-zero (with a warning naming it) when it
could not be — and the app itself is not waited for. `run.sh` does the same on
macOS, where `open` starts the app. A program that is not a one-click `.exe` (a
compiled CLI) runs in the terminal and exits with its own exit code, as on
Linux.

## File names, paths, line endings

- **Case.** macOS and Windows file systems ignore case by default; Linux does
  not. `import "./Cell.ts"` for a file named `cell.ts` works on your Mac or PC
  and fails on a Linux server or CI runner. aio does not check this: run
  `deno task check` and `deno task test` on Linux before you ship (the
  [CI workflow](../build/ci.md) does).
- **Path length.** aio has no handling for Windows' 260-character path limit;
  Deno's and Git's own rules apply (`git config --global core.longpaths true`).
- **Line endings.** A new app (`am create`) gets a `.gitattributes` with
  `* text=auto eol=lf`, so a Windows checkout holds the same bytes as a Linux
  one whatever Git's `core.autocrlf` says. An existing repo is not touched: add
  the line yourself if you want the rule.
