# aio — run any aio app from source with ONE line (Windows).
#
#   In an aio app repo:   irm https://raw.githubusercontent.com/riagentic/aio/main/run.ps1 | iex
#   With arguments:       & ([scriptblock]::Create((irm .../run.ps1))) -Dev
#                         & ([scriptblock]::Create((irm .../run.ps1))) -Git owner/repo
#   (env vars work too:   $env:AIO_DEV=1; $env:AIO_GIT="owner/repo"; irm .../run.ps1 | iex)
#
# Same contract as run.sh: ensure git + deno + aio/am, clone if a repo was
# given, `am fix` the checkout, PRODUCTION-build the default target, INSTALL the
# artifact where it outlives the checkout, and run it. -Dev runs the dev server
# instead; -NoRun builds and installs only; -NoInstall runs it from dist\.
#
# NOT EXECUTED BY A GATE. The lab runs these files under PowerShell 7 on Linux
# (docker/windows-scripts.ps1): they parse, their pure logic is unit-tested, and
# 7-only syntax is rejected because Windows ships 5.1 — that check exists
# because a `??` in this file would have been a parse error on every stock
# Windows box, and the 7 runtime could not see it. tests/run-sh.test.ts checks
# this file's text (it runs on Windows too). Since 1.0.19 aio's test suite runs
# natively on Windows 11, but no test in it executes this file: what the OS
# does here — installing deno, the am.cmd shim, .exe artifacts, shortcuts,
# symlink privileges, replacing a RUNNING .exe — is unverified by a gate. Every
# path below is the twin of a run.sh path that IS proven on a bare machine.

param(
  [switch]$Dev,
  [switch]$NoRun,
  [switch]$NoInstall,
  [string]$Git = "",
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$AppArgs = @()
)
$ErrorActionPreference = "Stop"

# ── How this script talks ────────────────────────────────────────────────
# The SAME vocabulary and colour rule as the sh installers and the framework
# itself: `·` a step, `✓` something that now exists, `!` an advisory, `✗` a
# refusal. install.ps1 used `>` and `+` with no colour at all while run.ps1
# used `>` and `+` WITH colour — two spellings of one installer, on one OS.
$script:AioColor = if ($env:FORCE_COLOR) { $true }
  elseif ($env:NO_COLOR) { $false }
  else { -not [Console]::IsOutputRedirected }
function Say($glyph, $color, $m, $err = $false) {
  if ($err) { [Console]::Error.WriteLine("$glyph $m") }
  elseif ($script:AioColor) {
    Write-Host "$glyph " -ForegroundColor $color -NoNewline
    Write-Host $m
  } else { Write-Host "$glyph $m" }
}
function Info($m) { Say '·' DarkGray $m }
function Ok($m)   { Say '✓' Green    $m }
function Warn($m) { Say '!' Yellow   $m $true }
function Fail($m) { Say '✗' Red      $m $true; exit 1 }

# Windows PowerShell 5.1: once a native program's stderr is REDIRECTED
# (`2>$null` and `2>&1` alike) every line it writes there is an error record,
# and under $ErrorActionPreference = 'Stop' the first one ENDS THE SCRIPT -
# measured: `git clone ... 2>&1` throws on "Cloning into ...", and
# `git rev-parse HEAD 2>$null` outside a repository throws on git's "fatal:".
# So every redirected native call runs through here, where a stderr line is
# only a line; its exit code is still read by the caller.
function Quiet([scriptblock]$run) { $ErrorActionPreference = 'Continue'; & $run }

function Get-MinDenoFrom($aioHome) {
  $file = Join-Path $aioHome 'src\server\deno-version.ts'
  if (-not (Test-Path $file)) { return '' }
  $m = Select-String -Path $file -Pattern 'MIN_DENO\s*=\s*"([^"]+)"' | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value }
  return ''
}

function Test-DenoAtLeast([string]$have, [string]$want) {
  if (-not $want) { return $true }   # nothing to compare against yet
  if (-not $have) { return $false }
  $h = ($have -split '[-+]')[0] -split '\.'
  $w = ($want -split '[-+]')[0] -split '\.'
  for ($i = 0; $i -lt 3; $i++) {
    $hv = if ($i -lt $h.Count) { [int]($h[$i] -replace '\D', '0') } else { 0 }
    $wv = if ($i -lt $w.Count) { [int]($w[$i] -replace '\D', '0') } else { 0 }
    if ($hv -gt $wv) { return $true }
    if ($hv -lt $wv) { return $false }
  }
  return $true
}

# WHAT an artifact is installed as - base name, extension, and the version its
# file name carries. The BUILD owns that rule (`installArtifactName`); this
# asks for it rather than keeping a Windows copy. A second copy is how the
# POSIX and Windows installers came to disagree, and once artifacts carried the
# derived version in their names a hand-rolled copy installed
# `demo-1.2.345.exe` - an app that renames itself, and its data directory, on
# every update.
function Get-InstallName([string]$builder, [string]$fileName) {
  $out = @()
  # try/catch as well as the exit code: a machine with no deno on PATH throws
  # here rather than returning one, and an installer that dies on that has
  # forgotten it is the thing that installs deno.
  try { $out = @(Quiet { deno run -A $builder "--print-install-name=$fileName" 2>$null }) } catch { $out = @() }
  if ($LASTEXITCODE -eq 0 -and $out.Count -ge 1 -and $out[0]) {
    return @{
      Base    = $out[0]
      Ext     = if ($out.Count -ge 2) { $out[1] } else { '' }
      Version = if ($out.Count -ge 3) { $out[2] } else { '' }
    }
  }
  # An aio pinned before that flag existed: such a build stamps no version into
  # the name, so the pre-versioning rule is the whole rule for what it makes.
  # A name that DOES carry one, with no builder able to read it, is refused
  # rather than guessed at.
  if ($fileName -match '-\d+\.\d+\.\d+') { # aio-ok: refuse-versioned-name
    Fail "this app's pinned aio cannot name the artifact it just built ($fileName). Update the pin (am pin --latest) and re-run."
  }
  $base = [IO.Path]::GetFileNameWithoutExtension($fileName)
  foreach ($arch in @('x86_64', 'aarch64', 'arm64', 'armhf', 'i686', 'amd64', 'x64')) {
    if ($base.EndsWith("-$arch")) { $base = $base.Substring(0, $base.Length - $arch.Length - 1) }
  }
  return @{ Base = $base; Ext = [IO.Path]::GetExtension($fileName); Version = '' }
}

# "Home", by the RUNTIME's rule (src/server/paths.ts `homedir`): %HOME% when it
# is set, else %USERPROFILE%. aio itself looks for its checkout, its versions
# and every app's data under that folder, so installing under %USERPROFILE%
# while a custom HOME is set (Git Bash, a login script) put aio where `am`
# then did not look.
function Get-AioUserHome() {
  if ($env:HOME) { return $env:HOME }
  return $env:USERPROFILE
}

# Where aio's own checkout lives when AIO_HOME does not say. An installer
# before 1.0.20 cloned under %USERPROFILE% whatever HOME said, and "am" was
# installed from that checkout: when it is there it stays THE checkout - used
# and updated - or a user with HOME set would get a second clone and an "am"
# that no longer follows the first. Only a machine with none gets the rule
# above.
function Get-AioDefaultHome() {
  if ($env:USERPROFILE) {
    $old = Join-Path $env:USERPROFILE '.local\lib\aio'
    if (Test-Path -LiteralPath (Join-Path $old '.git')) { return $old }
  }
  return Join-Path (Get-AioUserHome) '.local\lib\aio'
}

# One line saying where things will live - and a second when the two "home"
# variables name different folders, because then Explorer's idea of home is
# not the one aio uses.
function Show-AioHome([string]$aioHome) {
  $h = Get-AioUserHome
  Info "aio: $aioHome - app data: $h\.<appId>"
  if ($env:HOME -and $env:USERPROFILE -and
      ($env:HOME.TrimEnd('\', '/') -replace '/', '\') -ne ($env:USERPROFILE.TrimEnd('\', '/') -replace '/', '\')) {
    Info "note: %HOME% ($($env:HOME)) differs from %USERPROFILE% ($($env:USERPROFILE)) - aio uses %HOME%, here and when an app runs. A program started without that HOME looks under %USERPROFILE% instead."
    # The checkout an installer before 1.0.20 made (Get-AioDefaultHome).
    if (-not $env:AIO_HOME -and $aioHome -eq (Join-Path $env:USERPROFILE '.local\lib\aio')) {
      Info "note: the aio checkout stays at $aioHome, where an earlier install put it - it is the one used and updated."
    }
  }
}

# Write the install record ("am installed", "am upgrade", "am remove" read it)
# and SAY when that failed. Each field is built as ONE string: in Windows
# PowerShell `--commit=(git ...)` is two arguments ("--commit=" and the value)
# and `--aio=$conf.aioVersion` expands $conf and keeps ".aioVersion" as text -
# measured on 5.1 - so the record held no commit, no artifact and a garbage
# aio version, and a failed write was discarded with its output.
function Write-InstallRecord([string]$aioHome, [System.Collections.IDictionary]$fields) {
  $recArgs = @(); foreach ($k in $fields.Keys) { $recArgs += "--$k=$($fields[$k])" }
  Quiet { deno run -A (Join-Path $aioHome "src\server\install-record.ts") write @recArgs 2>$null | Out-Null }
  if ($LASTEXITCODE -ne 0) {
    Warn "the install record for $($fields['name']) was NOT written (install-record.ts exited $LASTEXITCODE) - 'am installed', 'am upgrade' and 'am remove' will not know this install"
    return $false
  }
  return $true
}

# Where the trailer of a one-click .exe ENDS in the open file $fs: the end of
# the file, or - for an Authenticode-SIGNED exe - just before the certificate
# table the signature appended (the PE's security directory; up to 7 pad
# bytes sit between). -1: no trailer, not a one-click .exe. The stub finds its
# own payload by this very rule (build\windows-sfx-stub\src\format.rs,
# `trailer_end`) and so does am publish (src\build\sfx-trailer.ts): a signed
# .exe read only at its end was not recognised, and was copied under
# Programs\ as a second install.
function Get-SfxTrailerEnd($fs) {
  $bytes = {
    param([long]$at, [int]$n)
    if ($at -lt 0 -or $at + $n -gt $fs.Length) { return $null }
    [void]$fs.Seek($at, [IO.SeekOrigin]::Begin)
    $b = New-Object byte[] $n
    if ($fs.Read($b, 0, $n) -ne $n) { return $null }
    return ,$b
  }
  # ...[payload][header][u32 header length][u64 payload length][8 magic]
  $magicEndsAt = {
    param([long]$end)
    $b = & $bytes ($end - 8) 8
    return ($end -ge 20 -and $b -and ([Text.Encoding]::ASCII.GetString($b) -like 'AIOSFX0?'))
  }
  $u32 = {
    param([long]$at)
    $b = & $bytes $at 4
    if (-not $b) { return [long]-1 }
    return [long][BitConverter]::ToUInt32($b, 0)
  }
  if (& $magicEndsAt $fs.Length) { return $fs.Length }
  $pe = & $u32 0x3c
  if ($pe -lt 0 -or (& $u32 $pe) -ne 0x4550) { return [long]-1 }   # "PE\0\0"
  $opt = $pe + 24                       # past the signature and the COFF header
  $kind = (& $u32 $opt) -band 0xffff
  if ($kind -eq 0x20b) { $dirs = $opt + 112 }        # PE32+
  elseif ($kind -eq 0x10b) { $dirs = $opt + 96 }     # PE32
  else { return [long]-1 }
  if ((& $u32 ($dirs - 4)) -le 4) { return [long]-1 }  # no security directory
  $cert = & $u32 ($dirs + 32)
  $len = & $u32 ($dirs + 36)
  if ($cert -le 0 -or $len -le 0 -or $cert -gt $fs.Length) { return [long]-1 }
  for ($pad = 0; $pad -lt 8; $pad++) {
    if (& $magicEndsAt ($cert - $pad)) { return [long]($cert - $pad) }
  }
  return [long]-1
}

# Is this the one-click .exe (an SFX: stub + payload + trailer)? Its trailer
# ends in the magic "AIOSFX0<n>" (build\windows-sfx-stub\src\format.rs). Read
# from the file, never guessed from its name.
function Test-OneClickExe([string]$path) {
  try {
    $fs = [IO.File]::OpenRead($path)
    try { return ((Get-SfxTrailerEnd $fs) -ge 0) } finally { $fs.Dispose() }
  } catch { return $false }
}

# Can this one-click .exe install itself WITHOUT starting the app? Its stub
# (aio 1.0.20 and newer) does when its first argument is --aio-sfx-install; an
# older stub hands that argument to the app and opens it. Read from the stub
# itself - the bytes before the payload - never guessed from a version.
function Test-OneClickInstallSwitch([string]$path) {
  try {
    $fs = [IO.File]::OpenRead($path)
    try {
      $end = Get-SfxTrailerEnd $fs
      if ($end -lt 0) { return $false }
      [void]$fs.Seek($end - 20, [IO.SeekOrigin]::Begin)
      $t = New-Object byte[] 12
      [void]$fs.Read($t, 0, 12)
      $stub = $end - 20 - [BitConverter]::ToUInt32($t, 0) - [BitConverter]::ToUInt64($t, 4)
      if ($stub -lt 1 -or $stub -gt 16MB) { return $false }
      $b = New-Object byte[] $stub
      [void]$fs.Seek(0, [IO.SeekOrigin]::Begin)
      $n = 0
      while ($n -lt $stub) {
        $r = $fs.Read($b, $n, $stub - $n)
        if ($r -le 0) { return $false }
        $n += $r
      }
      return [Text.Encoding]::GetEncoding(28591).GetString($b).Contains('--aio-sfx-install')
    } finally { $fs.Dispose() }
  } catch { return $false }
}

# One argument as CreateProcess wants it: quoted when it holds a space or a
# quote, a quote escaped, backslashes before a quote doubled. Start-Process
# joins -ArgumentList with spaces and quotes nothing.
function ConvertTo-NativeArg([string]$a) {
  if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
  return '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

# Open a one-click .exe and say truthfully whether the app was started.
#
# It is a window program: `& $exe` does not wait for one, and $LASTEXITCODE
# stayed whatever an earlier command had left - "exit $LASTEXITCODE" reported
# git's exit code as the app's. Its stub exits as soon as the app is installed
# and started (0), or could not be (non-zero - the reason is in its own
# message box and on stderr). So the STUB is waited for and never the app: the
# terminal comes back once the app is up, with a true exit code - what
# run.sh promises on macOS, where `open` does the same. (WaitForExit, not
# Start-Process -Wait: that one waits for every process the stub started,
# which is the app itself. And no -NoNewWindow or redirect: the app would
# inherit this script's output pipe and hold whoever reads it until the app
# closes.) Returns the exit code.
#
# WHY it failed comes back in a file: the stub (aio 1.0.20 and newer) writes
# its reason to the path AIO_SFX_REASON_FILE names and keeps that variable
# from the app. It is said here, on stderr, and kept in
# $script:OneClickReason; an older stub writes nothing, and then the exit code
# is all there is.
function Start-OneClickExe([string]$exe, [string[]]$appArgs) {
  $with = @{ FilePath = $exe; PassThru = $true }
  if ($appArgs -and $appArgs.Count -gt 0) {
    $with.ArgumentList = @($appArgs | ForEach-Object { ConvertTo-NativeArg $_ })
  }
  $script:OneClickReason = ''
  $why = [IO.Path]::GetTempFileName()
  $env:AIO_SFX_REASON_FILE = $why
  try {
    $p = Start-Process @with
    $null = $p.Handle   # without the handle, ExitCode is empty after the exit
    $p.WaitForExit()
    $said = Get-Content -Raw -Encoding UTF8 -ErrorAction SilentlyContinue -LiteralPath $why
    if ($said) { $script:OneClickReason = $said.Trim() }
  } finally {
    Remove-Item Env:AIO_SFX_REASON_FILE -ErrorAction SilentlyContinue
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $why
  }
  if ($script:OneClickReason) { [Console]::Error.WriteLine("aio SFX: $($script:OneClickReason)") }
  return $p.ExitCode
}

function Invoke-AioRun {
  if ($env:AIO_DEV -eq "1") { $script:Dev = $true }
  if ($env:AIO_GIT) { $script:Git = $env:AIO_GIT }
  $AioHome = if ($env:AIO_HOME) { $env:AIO_HOME } else { Get-AioDefaultHome }
  Show-AioHome $AioHome
  $AioRaw = if ($env:AIO_RAW) { $env:AIO_RAW } else { "https://raw.githubusercontent.com/riagentic/aio/main" }

  # -- prerequisites ----------------------------------------------------
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "git is required - install it (winget install Git.Git) and re-run"
  }
  $denoBin = if ($env:DENO_INSTALL) { Join-Path $env:DENO_INSTALL "bin" } else { Join-Path $HOME ".deno\bin" }
  $env:Path = "$denoBin;$env:Path"

  # Existence was the only question this script used to ask, so a machine with
  # an old deno went all the way to a failing BUILD whose error described a
  # syntax or API problem rather than the version behind it. install.ps1 owns
  # the how; this owns the "is it good enough".
  $denoOk = $false
  if (Get-Command deno -ErrorAction SilentlyContinue) {
    $have = (deno --version | Select-Object -First 1)
    if ($have -match 'deno\s+(\S+)') { $have = $Matches[1] } else { $have = '' }
    $denoOk = Test-DenoAtLeast $have (Get-MinDenoFrom $AioHome)
  }
  # ALWAYS, not only when something is missing (same rule as run.sh): a box
  # that installed aio once otherwise keeps that am forever. install.ps1 is
  # idempotent — fetch, check out the latest tag, reinstall am — and the app
  # still builds with its own pin, so updating am never moves an app.
  if ($denoOk -and (Get-Command am -ErrorAction SilentlyContinue) -and
      (Test-Path (Join-Path $AioHome ".git"))) {
    Info "updating aio + am (already installed)..."
  } else {
    Info "setting up aio (deno + framework + am)..."
  }
  if ($env:AIO_INSTALL) { & $env:AIO_INSTALL }
  else { irm "$AioRaw/install.ps1" | iex }
  $env:Path = "$denoBin;$env:Path"
  if (-not (Get-Command deno -ErrorAction SilentlyContinue)) { Fail "deno still not found after install" }
  if (-not (Get-Command am -ErrorAction SilentlyContinue)) { Fail "am still not found after install" }
  Ok ("deno " + ((deno --version | Select-Object -First 1)) + " - am ready")

  # -- clone (when a repo was given) ------------------------------------
  if ($Git) {
    $g = $Git
    if ($g -notmatch "^(https?://|git@|ssh://|file://|[A-Za-z]:\\|\./|\.\./|/)") {
      if ($g -match "^[^/]+/[^/]+$") { $g = "https://github.com/$g" }
      else { Fail "not a git URL or owner/repo: $g" }
    }
    $name = [IO.Path]::GetFileNameWithoutExtension(($g -replace "\.git$", ""))
    if (Test-Path (Join-Path $name ".git")) {
      Info "updating existing clone .\$name"
      Quiet { git -C $name pull --ff-only 2>$null }
    } elseif (Test-Path $name) {
      Fail ".\$name exists and is not a git clone - move it or cd elsewhere"
    } else {
      Info "cloning $g -> .\$name"
      git clone -q $g $name; if ($LASTEXITCODE -ne 0) { Fail "git clone failed - check the URL" }
    }
    Set-Location $name
  }

  # -- sanity: is this an aio app? --------------------------------------
  $cfg = if (Test-Path "deno.json") { "deno.json" } elseif (Test-Path "deno.jsonc") { "deno.jsonc" } else { Fail "no deno.json here - not an aio app ($(Get-Location))" }
  $conf = Get-Content $cfg -Raw | ConvertFrom-Json
  if (-not ($conf.imports.aio -or $conf.aioVersion)) {
    Fail "$(Get-Location) doesn't look like an aio app (no `"aio`" import in $cfg). Scaffold one with: am create my-app"
  }

  # -- repair whatever the checkout needs -------------------------------
  Info "am fix (checking the checkout)..."
  am fix; if ($LASTEXITCODE -ne 0) { Info "am fix reported issues it couldn't auto-repair - continuing" }

  # -- dev --------------------------------------------------------------
  if ($Dev) {
    if ($conf.tasks.dev) { Info "dev run: deno task dev"; deno task dev @AppArgs; exit $LASTEXITCODE }
    Info "dev run: deno run -A src/app.ts"; deno run -A src/app.ts @AppArgs; exit $LASTEXITCODE
  }

  # -- prod: build ------------------------------------------------------
  $stamp = Get-Date
  Info "production build (default target)..."
  if ($conf.tasks.compile) { deno task compile }
  elseif (Test-Path "dep\aio\src\build.ts") { deno run -A "dep\aio\src\build.ts" --compile }
  else { Info "no compile task and no dep\aio link - building with the installed aio"; deno run -A (Join-Path $AioHome "src\build.ts") --compile }
  if ($LASTEXITCODE -ne 0) { Fail "build failed - the output above says why" }

  # Newest runnable the build created - by TIME, not by name, so this script
  # never re-implements the framework's binary-naming rules.
  $artifact = Get-ChildItem -Path ".", "dist" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt $stamp -and $_.Extension -in ".exe", ".bat", ".cmd" } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $artifact) { Fail "build finished but no runnable artifact appeared - run 'deno task compile' by hand to see why" }
  Ok "built $($artifact.FullName)"

  # -- install: where it outlives the checkout --------------------------
  # Same promise as run.sh, Windows spelling: %LOCALAPPDATA%\Programs\<name>\
  # (asked for, never hardcoded - the framework owns that rule), a versioned
  # file, a stable name beside it, a Start Menu shortcut, and the same install
  # record + pruning the POSIX side writes.
  $installed = $artifact.FullName
  # A one-click .exe INSTALLS ITSELF the first time it runs - into
  # %LOCALAPPDATA%\aio-sfx\<name>\, with its own Start Menu shortcut, and it
  # updates itself there. Copying it under Programs\ as well (what this did:
  # the newest .exe of an Electron build IS the one-click one) installed the
  # app twice, with two shortcuts that could open two different versions. So
  # it is recorded - "am installed", "am upgrade" and "am remove" know it -
  # and left to install itself.
  $oneClick = (-not $NoInstall) -and (Test-OneClickExe $artifact.FullName)
  if ($oneClick) {
    # ...unless that is what an app installed by an older run.ps1 lives on.
    # Through 1.0.19 every .exe was copied under Programs\<name>\ with a
    # Start Menu shortcut to the copy: where that install exists it keeps
    # being updated, by the branch below, or the shortcut would go on opening
    # the old version. And an .exe whose stub cannot install itself without
    # starting the app (built with aio older than 1.0.20) is, under -NoRun,
    # installed the way 1.0.19 installed it.
    $root = (Quiet { deno run -A (Join-Path $AioHome "src\build.ts") --print-install-root 2>$null })
    if (-not $root) { $root = Join-Path $env:LOCALAPPDATA "Programs" }
    $names = Get-InstallName (Join-Path $AioHome "src\build.ts") $artifact.Name
    $stable = Join-Path (Join-Path $root $names.Base) "$($names.Base)$($names.Ext)"
    if (Test-Path -LiteralPath $stable) {
      Info "$stable is an install made by an earlier run - updating it there (a one-click .exe also installs itself to $(Join-Path $env:LOCALAPPDATA "aio-sfx\$($names.Base)") when it runs)"
      $oneClick = $false
    } elseif ($NoRun -and -not (Test-OneClickInstallSwitch $artifact.FullName)) {
      Info "this one-click .exe (built with aio older than 1.0.20) installs itself only when it is run, and -NoRun was given - installing it under $(Join-Path $root $names.Base), as before"
      $oneClick = $false
    }
  }
  if ($oneClick) {
    $names = Get-InstallName (Join-Path $AioHome "src\build.ts") $artifact.Name
    $base = $names.Base
    $src = if ($Git) { $Git } else { (Quiet { git config --get remote.origin.url 2>$null }) }
    if (-not $src) { $src = (Get-Location).Path }
    $ver = if ($names.Version) { $names.Version } elseif ($conf.version) { $conf.version } else { '' }
    $target = if ($conf.client) { $conf.client } else { 'electron' }
    # -NoRun (what "am upgrade" passes) must not open the app. The .exe is
    # asked to install itself and start nothing; its exit code says whether
    # it did, and only then is the version recorded - recording a version
    # nobody installed made "am upgrade" print "1.0.3 -> 1.0.4" over an
    # install that still held 1.0.3.
    if ($NoRun) {
      $sfxDir = Join-Path $env:LOCALAPPDATA "aio-sfx\$base"
      $errFile = [IO.Path]::GetTempFileName()
      try {
        $p = Start-Process -FilePath $artifact.FullName -ArgumentList '--aio-sfx-install' -Wait -PassThru -RedirectStandardError $errFile
        $said = (Get-Content -Raw -ErrorAction SilentlyContinue $errFile)
      } finally { Remove-Item -Force -ErrorAction SilentlyContinue $errFile }
      if ($said) { [Console]::Error.WriteLine($said.Trim()) }
      if ($p.ExitCode -ne 0) {
        $why = if ($p.ExitCode -eq 3) { "$base is running - close it and run this again" } else { "the .exe exited $($p.ExitCode)" }
        Warn "built $($artifact.FullName) - version $ver is NOT installed: $why. Nothing was recorded; $sfxDir holds what it held."
        exit 1
      }
      Ok "installed $ver to $sfxDir (the app was not started)"
      $inner = Get-Item -Path (Join-Path $sfxDir "win-*\$base.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($inner) { $installed = $inner.FullName }
    }
    [void](Write-InstallRecord $AioHome ([ordered]@{
      name = $base; version = $ver; artifact = $artifact.Name; source = $src
      commit = (Quiet { git rev-parse HEAD 2>$null }); target = $target; aio = $conf.aioVersion
    }))
    if (-not $NoRun) { Ok "one-click .exe - it installs itself to $(Join-Path $env:LOCALAPPDATA "aio-sfx\$base") and adds its Start Menu shortcut when it runs (next)" }
  }
  if (-not $NoInstall -and -not $oneClick) {
    $root = (Quiet { deno run -A (Join-Path $AioHome "src\build.ts") --print-install-root 2>$null })
    if (-not $root) { $root = Join-Path $env:LOCALAPPDATA "Programs" }
    $names = Get-InstallName (Join-Path $AioHome "src\build.ts") $artifact.Name
    $base = $names.Base
    $ext = $names.Ext
    $targetDir = Join-Path $root $base

    $src = if ($Git) { $Git } else { (Quiet { git config --get remote.origin.url 2>$null }) }
    if (-not $src) { $src = (Get-Location).Path }
    $prev = (Quiet { deno run -A (Join-Path $AioHome "src\server\install-record.ts") conflict "--name=$base" "--source=$src" 2>$null })
    if ($prev) {
      Fail @"
"$base" is already installed here, from a DIFFERENT source:
    installed from: $prev
    installing:     $src
  They share $targetDir AND the data directory for this app.
  Remove the old one first (am remove $base), install under another name,
  or set AIO_INSTALL_ROOT to keep them apart.
"@
    }

    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    # The VERSION goes in the DIRECTORY, never in the file name - the same
    # layout run.sh writes and the only one the updater and the pruner know
    # (`versions/<version>/<base><ext>`, resolveInstallLayout /
    # pruneVersions). A compiled binary takes its identity, and its data
    # directory, from its own file name, so `<base>-<ver>.exe` renamed the app
    # on every update and started it from empty state; and a flat file under
    # no `versions/` directory is a rollback the pruner cannot see and the
    # updater cannot swap.
    $ver = if ($names.Version) { $names.Version } elseif ($conf.version) { $conf.version } else { (Get-Date -Format 'yyyyMMddHHmmss') }
    $versionDir = Join-Path (Join-Path $targetDir "versions") $ver
    New-Item -ItemType Directory -Force -Path $versionDir | Out-Null
    $versioned = Join-Path $versionDir "$base$ext"
    Copy-Item -Force $artifact.FullName "$versioned.part"
    Move-Item -Force "$versioned.part" $versioned
    $stable = Join-Path $targetDir "$base$ext"
    # A symlink needs Developer Mode or admin on Windows; a copy always works.
    # The updater notices the difference (a real symlink gets the versioned
    # swap, a copy gets the flat one) so either outcome is correct, and this
    # says which one happened rather than pretending.
    $linked = $false
    try {
      if (Test-Path $stable) { Remove-Item -Force $stable }
      New-Item -ItemType SymbolicLink -Path $stable -Target $versioned -ErrorAction Stop | Out-Null
      $linked = $true
    } catch {
      Copy-Item -Force $versioned $stable
    }
    $installed = $stable
    Ok "installed $installed$(if (-not $linked) { ' (copied - no symlink privilege; updates replace the file in place)' })"

    # `??` is PowerShell 7 ONLY. Windows ships 5.1, which is what `irm … | iex`
    # runs in a default terminal — so that one operator would have made the
    # whole script a parse error on a stock Windows box, before a single line
    # executed. The lab could not see it: its PowerShell is 7 on Linux.
    $target = if ($conf.client) { $conf.client } else { 'electron' }
    [void](Write-InstallRecord $AioHome ([ordered]@{
      name = $base; version = $ver; artifact = [IO.Path]::GetFileName($versioned); source = $src
      commit = (Quiet { git rev-parse HEAD 2>$null }); target = $target; aio = $conf.aioVersion
    }))

    $keep = if ($env:AIO_KEEP_VERSIONS) { $env:AIO_KEEP_VERSIONS } else { 3 }
    $pruned = (Quiet { deno run -A (Join-Path $AioHome "src\server\install-record.ts") prune `
      "--name=$base" "--ext=$ext" "--keep=$keep" "--current=$versionDir" 2>$null })
    if ($pruned) { Info "pruned older version(s): $($pruned -join ' ')" }

    # A launcher, so the app is where a Windows user looks for one.
    try {
      $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
      New-Item -ItemType Directory -Force -Path $programs | Out-Null
      $lnk = Join-Path $programs "$base.lnk"
      $shell = New-Object -ComObject WScript.Shell
      $sc = $shell.CreateShortcut($lnk)
      $sc.TargetPath = $installed
      $sc.WorkingDirectory = $targetDir
      $sc.Description = "$base (installed by aio)"
      $sc.Save()
      Ok "Start Menu shortcut $lnk"
    } catch {
      Info "could not create a Start Menu shortcut: $($_.Exception.Message)"
    }
  }

  if ($NoRun) { Write-Host "Run it: $installed"; exit 0 }
  Info "running $installed"
  # The commit this artifact was built FROM - an app with a git update source
  # compares against it instead of guessing.
  $sha = (Quiet { git rev-parse HEAD 2>$null }); if ($sha) { $env:AIO_BUILD_COMMIT = $sha }
  if (Test-OneClickExe $installed) {
    $code = Start-OneClickExe $installed $AppArgs
    if ($code -ne 0) {
      if ($script:OneClickReason) { Warn "$installed exited $code - the app was NOT started (the reason is the line above)." }
      else { Warn "$installed exited $code - the app was NOT started. Its message box says why; with no desktop to show one on, the reason is on its stderr: Start-Process '$installed' -NoNewWindow -Wait" }
    }
    exit $code
  }
  & $installed @AppArgs
  exit $LASTEXITCODE
}

# AIO_RUN_LOAD_ONLY=1 defines the helpers WITHOUT running anything — that is
# how the tests reach them. Every other load runs, dot-sourcing included (GitHub
# Actions runs a `shell: pwsh` step as `. '{0}'`; see install.ps1).
if ($env:AIO_RUN_LOAD_ONLY -ne '1') { Invoke-AioRun }
