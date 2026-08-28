# The Windows scripts, under a real PowerShell.
#
# Docker cannot boot Windows, so an end-to-end run of install.ps1/run.ps1 is
# out of reach here — and pretending otherwise is how the POSIX one-liner
# stayed broken for months. What IS reachable is everything short of Windows
# itself: the files parse, and the decisions inside them are correct. Both are
# run by the real PowerShell parser and the real PowerShell engine, in
# mcr.microsoft.com/powershell.
#
# What this does NOT prove, stated so nobody reads it as more than it is:
# nothing here touches a Windows filesystem, the registry, WScript.Shell
# shortcuts, .exe artifacts, or `winget`-installed denos. Those need a Windows
# runner.

$ErrorActionPreference = 'Stop'
$root = if ($env:AIO_SRC) { $env:AIO_SRC } else { '/aio-src' }
$failures = @()
function Check($name, [scriptblock]$body) {
  try {
    & $body
    Write-Host "  + $name"
  } catch {
    $script:failures += "$name : $($_.Exception.Message)"
    Write-Host "  x $name : $($_.Exception.Message)"
  }
}
function Assert($cond, $msg) { if (-not $cond) { throw $msg } }

# ── 1. do they parse? ───────────────────────────────────────────────────
foreach ($f in @('install.ps1', 'run.ps1')) {
  Check "$f parses" {
    $path = Join-Path $root $f
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors) | Out-Null
    if ($errors -and $errors.Count -gt 0) {
      throw ($errors | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }) -join '; '
    }
  }
}

# ── 2. the decisions inside them ────────────────────────────────────────
# Dot-sourcing defines the functions without installing or building anything.
. (Join-Path $root 'install.ps1')
. (Join-Path $root 'run.ps1')

Check 'version compare: 2.10 is NEWER than 2.9 (a string compare says otherwise)' {
  Assert (Test-VersionAtLeast '2.10.0' '2.9.0') '2.10.0 >= 2.9.0'
  Assert (-not (Test-VersionAtLeast '2.9.0' '2.10.0')) '2.9.0 < 2.10.0'
}

Check 'version compare: the reported bug (deno 2.1.4 must NOT pass 2.9.0)' {
  Assert (-not (Test-VersionAtLeast '2.1.4' '2.9.0')) '2.1.4 must be refused'
  Assert (Test-VersionAtLeast '2.9.0' '2.9.0') 'equal passes'
  Assert (Test-VersionAtLeast '2.9.5-rc.1' '2.9.0') 'prerelease suffix is ignored'
}

Check 'MIN_DENO is read from the framework, not copied into the script' {
  $min = Get-MinDeno $root
  Assert ($min -match '^\d+\.\d+\.\d+$') "expected a version, got '$min'"
  $ts = Get-Content (Join-Path $root 'src/server/deno-version.ts') -Raw
  Assert ($ts -match [regex]::Escape($min)) 'the value must come from deno-version.ts'
  # run.ps1 has its own reader (different function name, same source of truth).
  Assert ((Get-MinDenoFrom $root) -eq $min) 'both scripts must read the same MIN_DENO'
}

Check 'install name: the BUILD is asked what an artifact is installed as' {
  # The rule lives in the framework (installArtifactName): the version comes
  # off the file name, because a compiled binary takes its identity — and its
  # data directory — from the name it runs under. This image is PowerShell
  # with no deno, so what is provable here is that the script ASKS; the
  # answer itself is pinned in tests/build-version.test.ts.
  $src = Get-Content (Join-Path $root 'run.ps1') -Raw
  Assert ($src -match '--print-install-name=') 'run.ps1 must ask the build for the installed name'
}

Check 'install name: no deno / an aio too old to answer falls back, and never truncates' {
  # A builder that cannot answer (a pin from before the flag) leaves the
  # pre-versioning rule — which strips the ARCH the packager appends and
  # nothing else: `chat-app` is a name, not `chat` plus a suffix.
  $none = Join-Path $root 'no/such/build.ts'
  Assert ((Get-InstallName $none 'chat-app.exe').Base -eq 'chat-app') 'chat-app survives'
  Assert ((Get-InstallName $none 'demo-electron-x86_64.exe').Base -eq 'demo-electron') 'arch is stripped'
  Assert ((Get-InstallName $none 'demo.exe').Base -eq 'demo') 'plain name'
  Assert ((Get-InstallName $none 'demo.exe').Ext -eq '.exe') 'the extension comes with it'
}

Check 'install.ps1 verifies am with a spelling every RELEASE understands' {
  # CODE only: the comment above that line explains the rule and names the
  # forbidden spelling, so a check that cannot tell an explanation from a use
  # fails on its own documentation (this one did, first run).
  $code = (Get-Content (Join-Path $root 'install.ps1') |
    Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
  Assert ($code -notmatch 'am --version') 'must not CALL am with the branch-only spelling'
  Assert ($code -match 'am version') 'must verify the version somehow'
}

Check 'install.ps1 WRITES PATH instead of suggesting it' {
  $src = Get-Content (Join-Path $root 'install.ps1') -Raw
  Assert ($src -match "SetEnvironmentVariable\('Path'") 'must persist PATH for the next terminal'
}

Check 'run.ps1 installs the artifact instead of running it from dist\' {
  $src = Get-Content (Join-Path $root 'run.ps1') -Raw
  Assert ($src -match 'print-install-root') 'the install root must be ASKED for, never hardcoded'
  Assert ($src -match 'install-record\.ts') 'an install must record what it installed'
  Assert ($src -match 'prune') 'old versions must be bounded'
  Assert ($src -match 'CreateShortcut') 'a GUI app needs a launcher'
  # The same layout the POSIX installer and the updater use: the version is the
  # DIRECTORY, the file keeps the app's name. A versioned FILE renames the app,
  # and its data directory, on every update; a flat file under no `versions/`
  # is a rollback the pruner cannot see and the updater cannot swap.
  Assert ($src -match 'Join-Path \$targetDir "versions"') 'the version must be a directory'
  Assert ($src -match '\$versioned = Join-Path \$versionDir "\$base\$ext"') 'the installed file must keep the app name'
  Assert ($src -notmatch '"\$base-\$ver\$ext"') 'the installed file must not carry a version'
}

# ── 3. syntax that only PowerShell 7 understands ────────────────────────
# This image is PowerShell 7 on Linux. WINDOWS ships 5.1, and `irm … | iex` in
# a default terminal runs 5.1 — so a 7-only operator is a parse error on the
# machines this script exists for, and the parser above would never say so
# (it accepts everything it can run). A static check is a poor substitute for
# a 5.1 runtime, and it is the only one available on Linux.
Check 'no PowerShell 7-only syntax (Windows ships 5.1)' {
  foreach ($f in @('install.ps1', 'run.ps1')) {
    $code = (Get-Content (Join-Path $root $f) | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
    # ?? and ?. (null-coalescing), ternary ? :, and -Parallel are all 7+.
    if ($code -match '\?\?|\?\.|ForEach-Object\s+-Parallel') {
      throw "$f uses PowerShell 7-only syntax (?? / ?. / -Parallel) - it would not parse on Windows PowerShell 5.1"
    }
  }
}

Write-Host ''
if ($failures.Count -gt 0) {
  Write-Host "x $($failures.Count) check(s) failed" -ForegroundColor Red
  exit 1
}
Write-Host '+ the Windows scripts parse and their logic is correct' -ForegroundColor Green
Write-Host '  (a real Windows end-to-end run still needs a Windows runner)'
exit 0
