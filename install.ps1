# aio — one-line installer for `am` (the aio manager) on Windows. Source-based:
# clones the framework from GitHub and installs `am` from it. No JSR, no publish.
#
#   irm https://raw.githubusercontent.com/riagentic/aio/main/install.ps1 | iex
#
# Re-running updates aio + am in place. Uninstall with `am uninstall`. Override
# with $env:AIO_HOME / $env:AIO_REPO / $env:AIO_BRANCH / $env:AIO_REF;
# $env:AIO_NO_PATH_WRITE=1 leaves your PATH alone (it names the folder instead).
#
# Needs: git on PATH (winget install Git.Git) — checked first, nothing is
# installed without it. Stock Windows PowerShell 5.1 is enough. Deno is
# installed into %USERPROFILE%\.deno when missing or too old; aio is cloned to
# <home>\.local\lib\aio, where <home> is %HOME% when that is set and
# %USERPROFILE% otherwise - the folder aio itself calls home when it runs. The
# two differ under Git Bash or a login script that sets HOME; a checkout an
# earlier install left under %USERPROFILE% stays the one used; the folder used
# is printed.
#
# NOT EXECUTED BY A GATE — see the note in run.ps1. This is the twin of
# install.sh and carries the same fixes, which were found by
# running the POSIX side on a machine that had nothing:
#   • the deno version is COMPARED against the framework's MIN_DENO, not merely
#     detected — "✓ deno 2.1.4" followed by unrelated failures later is the
#     single worst thing an installer can do;
#   • PATH is written, not suggested, so the next terminal works;
#   • `am` is verified by RUNNING it, with `am version` (the spelling every
#     release understands — this script comes from the branch and installs the
#     last tag, so a newer spelling would fail against the release it just
#     installed).
#
# The container lab cannot boot Windows (Docker), so the logic below is
# exercised by parsing and unit-testing these functions under PowerShell 7 on
# Linux — docker/windows-scripts.ps1, the lab's `windows-scripts` scenario.
# Since 1.0.20 tests/install-ps1-e2e-windows.test.ts runs this file for real
# on Windows (clone, tag checkout, am install, a second run that updates) in a
# throwaway home, with a local repository and AIO_NO_PATH_WRITE. NOT run by it:
# the deno download/upgrade branches and the PATH write itself.

$ErrorActionPreference = 'Stop'

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

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# The version the FRAMEWORK requires, read from the framework itself. A number
# copied into this script is a second decider that goes stale the first time
# the minimum moves — and nobody notices, because both look right.
function Get-MinDeno($aioHome) {
  $file = Join-Path $aioHome 'src\server\deno-version.ts'
  if (-not (Test-Path $file)) { return '' }
  $m = Select-String -Path $file -Pattern 'MIN_DENO\s*=\s*"([^"]+)"' | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value }
  return ''
}

# Numeric, field by field. A string compare says "2.10.0" < "2.9.0", which is
# exactly how a version gate lets the wrong build through.
function Test-VersionAtLeast([string]$have, [string]$want) {
  if (-not $have -or -not $want) { return $false }
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

function Get-DenoVersion() {
  if (-not (Have 'deno')) { return '' }
  $line = (deno --version | Select-Object -First 1)
  if ($line -match 'deno\s+(\S+)') { return $Matches[1] }
  return ''
}

# PATH, made true rather than suggested: the User scope is what the NEXT
# terminal reads. Idempotent — this runs on every re-install.
function Add-UserPath([string]$dir) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($current -and ($current -split ';' | Where-Object { $_ -eq $dir })) { return $false }
  $updated = if ($current) { "$current;$dir" } else { $dir }
  [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
  return $true
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

function Invoke-AioInstall {
  $AioHome = if ($env:AIO_HOME) { $env:AIO_HOME } else { Get-AioDefaultHome }
  Show-AioHome $AioHome
  $AioRepo = if ($env:AIO_REPO) { $env:AIO_REPO } else { 'https://github.com/riagentic/aio' }
  $AioBranch = if ($env:AIO_BRANCH) { $env:AIO_BRANCH } else { 'main' }

  # Checked up front, together: discovering a missing git after the deno
  # download is a worse experience than being told both at once.
  if (-not (Have 'git')) {
    throw "git is required - install it (winget install Git.Git) and re-run"
  }

  # ── Clone / update aio FIRST ──
  # Before deno, on purpose: the clone needs only git, and it carries the one
  # authoritative statement of which deno version this framework requires.
  if (Test-Path (Join-Path $AioHome '.git')) {
    Info "updating aio in $AioHome"
    git -C $AioHome fetch --tags --force origin $AioBranch | Out-Null
  } else {
    Info "cloning aio -> $AioHome"
    $err = (Quiet { git clone $AioRepo $AioHome 2>&1 })
    if ($LASTEXITCODE -ne 0) { throw "git clone failed for ${AioRepo}:`n$err" }
  }
  if ($env:AIO_REF) {
    Quiet { git -C $AioHome fetch --tags --force origin $env:AIO_REF 2>$null | Out-Null }
    Quiet { git -C $AioHome checkout -q --force $env:AIO_REF 2>$null }
    if ($LASTEXITCODE -ne 0) { throw "AIO_REF=$($env:AIO_REF) is not a ref in $AioRepo" }
    Ok "aio $($env:AIO_REF) (pinned via AIO_REF)"
  } else {
    $AioTag = (Quiet { git -C $AioHome describe --tags --abbrev=0 "origin/$AioBranch" 2>$null })
    if (-not $AioTag) { $AioTag = (git -C $AioHome tag -l 'v*' --sort=-creatordate | Select-Object -First 1) }
    if ($AioTag) { git -C $AioHome checkout -q --force $AioTag; Ok "aio $AioTag" }
    else { git -C $AioHome checkout -q --force $AioBranch; Ok "aio $AioBranch (no tags yet)" }
  }

  # ── Deno, at a version this framework can actually run on ──
  $minDeno = Get-MinDeno $AioHome
  if (-not $minDeno) { $minDeno = '2.9.0' }   # unreadable clone: refuse to guess low
  $denoBin = if ($env:DENO_INSTALL) { Join-Path $env:DENO_INSTALL 'bin' } else { Join-Path $env:USERPROFILE '.deno\bin' }
  $env:PATH = "$denoBin;$env:PATH"

  $have = Get-DenoVersion
  if (-not $have) {
    Info "deno not found - installing (aio needs $minDeno+)"
    irm https://deno.land/install.ps1 | iex
    $env:PATH = "$denoBin;$env:PATH"
    $have = Get-DenoVersion
    if (-not $have) { throw "deno install failed - see https://docs.deno.com/runtime/getting_started/installation/" }
    Ok "deno $have installed"
  } elseif (Test-VersionAtLeast $have $minDeno) {
    Ok "deno $have"
  } else {
    Info "deno $have is older than the $minDeno aio requires - upgrading"
    Quiet { deno upgrade 2>$null | Out-Null }
    $have = Get-DenoVersion
    if (-not (Test-VersionAtLeast $have $minDeno)) {
      # A deno from winget/choco/scoop cannot rewrite itself; install a private
      # one and put it first on PATH rather than failing with someone else's
      # permission error.
      Info "that deno cannot upgrade itself - installing a private one in $denoBin"
      irm https://deno.land/install.ps1 | iex
      $env:PATH = "$denoBin;$env:PATH"
      $have = Get-DenoVersion
    }
    if (-not (Test-VersionAtLeast $have $minDeno)) {
      throw @"
aio needs deno $minDeno+ and this machine has $have, which could not be upgraded.
  Fix it with ONE of:
    deno upgrade                                  (if you installed deno yourself)
    irm https://deno.land/install.ps1 | iex       (installs into %USERPROFILE%\.deno)
    winget upgrade DenoLand.Deno                  (if a package manager owns it)
  Then re-run this installer.
"@
    }
    Ok "deno $have"
  }

  # ── Install am from the clone ──
  Info 'installing am...'
  deno install -gAf --config (Join-Path $AioHome 'deno.json') -n am (Join-Path $AioHome 'src\am.ts')
  if ($LASTEXITCODE -ne 0) { throw 'installing am failed - the output above says why' }
  $env:PATH = "$denoBin;$env:PATH"

  # AIO_NO_PATH_WRITE: for whoever manages PATH themselves, and for the test
  # that runs this file for real - the one step here that reaches outside the
  # folders the other variables name. Unset (the default), PATH is written.
  if ($env:AIO_NO_PATH_WRITE) {
    Info "PATH not changed (AIO_NO_PATH_WRITE is set) - add $denoBin to it yourself"
  } elseif (Add-UserPath $denoBin) {
    Ok "added $denoBin to your PATH (new terminals will have it)"
  }

  # An installed file is not an installed TOOL. `am version`, not `am --version`:
  # this script comes from the BRANCH and installs the last TAG, so verifying
  # with a spelling that only exists on the newer side would fail against the
  # release it just installed.
  $amBin = Join-Path $denoBin 'am.cmd'
  $ver = ''
  if (Have 'am') { $ver = (Quiet { am version 2>$null | Select-Object -First 1 }) }
  if (-not $ver -and (Test-Path $amBin)) { $ver = (Quiet { & $amBin version 2>$null | Select-Object -First 1 }) }
  if ($ver) { Ok "am installed: $ver" }
  elseif (Test-Path $amBin) { throw "am is installed at $amBin but does not run" }
  else { throw "am did not install - expected $amBin" }

  Write-Host ''
  Write-Host 'Next:'
  Write-Host '  am create my-app   # scaffold a new aio app'
  Write-Host '  cd my-app; deno task dev'
}

# AIO_INSTALL_LOAD_ONLY=1 defines the functions WITHOUT installing anything —
# that is how the tests reach them. Every other load installs, dot-sourcing
# included: GitHub Actions runs a `shell: pwsh` step as `. '{0}'`, so a
# dot-source check made `irm … | iex` there exit 0 having installed nothing.
if ($env:AIO_INSTALL_LOAD_ONLY -ne '1') { Invoke-AioInstall }
