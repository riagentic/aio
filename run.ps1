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
# WINDOWS IS NOT TESTED. The lab runs these files under PowerShell 7 on Linux
# (docker/windows-scripts.ps1): they parse, their pure logic is unit-tested, and
# 7-only syntax is rejected because Windows ships 5.1 — that check exists
# because a `??` in this file would have been a parse error on every stock
# Windows box, and the 7 runtime could not see it. Everything the OS actually
# does — installing deno, the am.cmd shim, .exe artifacts, shortcuts, symlink
# privileges, replacing a RUNNING .exe — is unverified until there is a Windows
# runner. Every path below is the twin of a run.sh path that IS proven on a
# bare machine.

param(
  [switch]$Dev,
  [switch]$NoRun,
  [switch]$NoInstall,
  [string]$Git = "",
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$AppArgs = @()
)
$ErrorActionPreference = "Stop"

function Info($m) { Write-Host "> $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "+ $m" -ForegroundColor Green }
function Fail($m) { Write-Host "x $m" -ForegroundColor Red; exit 1 }

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

# The app name an artifact belongs to. Windows builds produce `<name>.exe`, but
# a packaged one may carry the arch the way the AppImage does — splitting at the
# first hyphen would turn `chat-app` into `chat`, which is a bug the POSIX
# side shipped for exactly one afternoon.
function Get-AppBaseName([string]$fileName) {
  $base = [IO.Path]::GetFileNameWithoutExtension($fileName)
  foreach ($arch in @('x86_64', 'aarch64', 'arm64', 'amd64', 'x64')) {
    if ($base.EndsWith("-$arch")) { $base = $base.Substring(0, $base.Length - $arch.Length - 1) }
  }
  return $base
}

function Invoke-AioRun {
  if ($env:AIO_DEV -eq "1") { $script:Dev = $true }
  if ($env:AIO_GIT) { $script:Git = $env:AIO_GIT }
  $AioHome = if ($env:AIO_HOME) { $env:AIO_HOME } else { Join-Path $HOME ".local\lib\aio" }
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
      git -C $name pull --ff-only 2>$null
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
  if (-not $NoInstall) {
    $root = (deno run -A (Join-Path $AioHome "src\build.ts") --print-install-root 2>$null)
    if (-not $root) { $root = Join-Path $env:LOCALAPPDATA "Programs" }
    $base = Get-AppBaseName $artifact.Name
    $ext = $artifact.Extension
    $targetDir = Join-Path $root $base

    $src = if ($Git) { $Git } else { (git config --get remote.origin.url 2>$null) }
    if (-not $src) { $src = (Get-Location).Path }
    $prev = (deno run -A (Join-Path $AioHome "src\server\install-record.ts") conflict --name=$base --source=$src 2>$null)
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
    $ver = if ($conf.version) { $conf.version } else { (Get-Date -Format 'yyyyMMddHHmmss') }
    $versioned = Join-Path $targetDir "$base-$ver$ext"
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
    deno run -A (Join-Path $AioHome "src\server\install-record.ts") write `
      --name=$base --version=$ver --artifact=([IO.Path]::GetFileName($versioned)) `
      --source=$src --commit=(git rev-parse HEAD 2>$null) --target=$target `
      --aio=$conf.aioVersion 2>$null | Out-Null

    $pruned = (deno run -A (Join-Path $AioHome "src\server\install-record.ts") prune `
      --name=$base --ext=$ext --keep=$(if ($env:AIO_KEEP_VERSIONS) { $env:AIO_KEEP_VERSIONS } else { 3 }) `
      --current=$versioned 2>$null)
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
  $sha = (git rev-parse HEAD 2>$null); if ($sha) { $env:AIO_BUILD_COMMIT = $sha }
  & $installed @AppArgs
  exit $LASTEXITCODE
}

# Dot-sourcing defines the helpers WITHOUT running anything — that is how the
# tests reach them.
if ($MyInvocation.InvocationName -ne '.') { Invoke-AioRun }
