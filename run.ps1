# aio — run any aio app from source with ONE line (Windows).
#
#   In an aio app repo:   irm https://raw.githubusercontent.com/riagentic/aio/main/run.ps1 | iex
#   With arguments:       & ([scriptblock]::Create((irm https://raw.githubusercontent.com/riagentic/aio/main/run.ps1))) -Dev
#                         & ([scriptblock]::Create((irm .../run.ps1))) -Git owner/repo
#   (env vars work too:   $env:AIO_DEV=1; $env:AIO_GIT="owner/repo"; irm .../run.ps1 | iex)
#
# Same contract as run.sh: ensure git + deno + aio/am, clone if a repo was
# given, `am fix` the checkout, PRODUCTION-build the default target and run the
# artifact (-Dev runs the dev server instead). -NoRun builds only.
param(
  [switch]$Dev,
  [switch]$NoRun,
  [string]$Git = "",
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$AppArgs = @()
)
$ErrorActionPreference = "Stop"

if ($env:AIO_DEV -eq "1") { $Dev = $true }
if ($env:AIO_GIT) { $Git = $env:AIO_GIT }
$AioHome = if ($env:AIO_HOME) { $env:AIO_HOME } else { Join-Path $HOME ".local\lib\aio" }
$AioRepo = if ($env:AIO_REPO) { $env:AIO_REPO } else { "https://github.com/riagentic/aio" }
$AioBranch = if ($env:AIO_BRANCH) { $env:AIO_BRANCH } else { "main" }

function Info($m) { Write-Host "> $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "+ $m" -ForegroundColor Green }
function Fail($m) { Write-Host "x $m" -ForegroundColor Red; exit 1 }

# -- prerequisites ------------------------------------------------------
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git is required - install git and re-run" }

$denoBin = Join-Path $HOME ".deno\bin"
if ($env:DENO_INSTALL) { $denoBin = Join-Path $env:DENO_INSTALL "bin" }
$env:Path = "$denoBin;$env:Path"
if (-not (Get-Command deno -ErrorAction SilentlyContinue)) {
  Info "deno not found - installing..."
  irm https://deno.land/install.ps1 | iex
  $env:Path = "$denoBin;$env:Path"
  if (-not (Get-Command deno -ErrorAction SilentlyContinue)) { Fail "deno install failed" }
}

# aio framework clone + am (mirrors install.sh; checked out at the last tag)
if (-not (Test-Path (Join-Path $AioHome ".git"))) {
  Info "cloning aio -> $AioHome"
  git clone -q $AioRepo $AioHome; if ($LASTEXITCODE -ne 0) { Fail "git clone failed ($AioRepo)" }
}
git -C $AioHome fetch --tags --force -q origin $AioBranch 2>$null
$tag = git -C $AioHome describe --tags --abbrev=0 "origin/$AioBranch" 2>$null
if ($tag) { git -C $AioHome checkout -q --force $tag 2>$null; Ok "aio $tag" }
else { git -C $AioHome checkout -q --force $AioBranch 2>$null; Ok "aio $AioBranch" }
if (-not (Get-Command am -ErrorAction SilentlyContinue)) {
  Info "installing am..."
  deno install -gAf --config (Join-Path $AioHome "deno.json") -n am (Join-Path $AioHome "src\am.ts")
  if (-not (Get-Command am -ErrorAction SilentlyContinue)) { Fail "am install failed - is $denoBin on PATH?" }
}
Ok ("deno " + (deno --version | Select-Object -First 1))

# -- clone (when a repo was given) --------------------------------------
if ($Git) {
  if ($Git -notmatch "^(https?://|git@|ssh://|file://|[A-Za-z]:\\|\./|\.\./|/)") {
    if ($Git -match "^[^/]+/[^/]+$") { $Git = "https://github.com/$Git" }
    else { Fail "not a git URL or owner/repo: $Git" }
  }
  $name = [IO.Path]::GetFileNameWithoutExtension(($Git -replace "\.git$", ""))
  if (Test-Path (Join-Path $name ".git")) {
    Info "updating existing clone .\$name"
    git -C $name pull --ff-only 2>$null
  } elseif (Test-Path $name) {
    Fail ".\$name exists and is not a git clone - move it or cd elsewhere"
  } else {
    Info "cloning $Git -> .\$name"
    git clone -q $Git $name; if ($LASTEXITCODE -ne 0) { Fail "git clone failed - check the URL" }
  }
  Set-Location $name
}

# -- sanity: is this an aio app? ----------------------------------------
$cfg = if (Test-Path "deno.json") { "deno.json" } elseif (Test-Path "deno.jsonc") { "deno.jsonc" } else { Fail "no deno.json here - not an aio app ($(Get-Location))" }
$conf = Get-Content $cfg -Raw | ConvertFrom-Json
if (-not ($conf.imports.aio -or $conf.aioVersion)) { Fail "$(Get-Location) doesn't look like an aio app (no `"aio`" import in $cfg). Scaffold one with: am create my-app" }

# -- repair whatever the checkout needs ---------------------------------
Info "am fix (checking the checkout)..."
am fix; if ($LASTEXITCODE -ne 0) { Info "am fix reported issues it couldn't auto-repair - continuing" }

# -- dev ----------------------------------------------------------------
if ($Dev) {
  if ($conf.tasks.dev) { Info "dev run: deno task dev"; deno task dev @AppArgs; exit $LASTEXITCODE }
  Info "dev run: deno run -A src/app.ts"; deno run -A src/app.ts @AppArgs; exit $LASTEXITCODE
}

# -- prod: build the default target, then run the artifact --------------
$stamp = Get-Date
Info "production build (default target)..."
if ($conf.tasks.compile) { deno task compile } else { deno run -A (Join-Path $AioHome "src\build.ts") --compile }
if ($LASTEXITCODE -ne 0) { Fail "build failed - the output above says why" }

# Newest runnable the build created (root or dist\) - by TIME, not by name, so
# this script never re-implements the framework's binary-naming rules.
$artifact = Get-ChildItem -Path ".", "dist" -File -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -gt $stamp -and $_.Extension -in ".exe", ".bat", ".cmd" } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $artifact) { Fail "build finished but no runnable artifact appeared - run 'deno task compile' by hand to see why" }
Ok "built $($artifact.FullName)"
if ($NoRun) { Write-Host "Run it: $($artifact.FullName)"; exit 0 }
Info "running $($artifact.Name)"
& $artifact.FullName @AppArgs
exit $LASTEXITCODE
