# aio — one-line installer for `am` (the aio manager) on Windows. Source-based:
# clones the framework from GitHub and installs `am` from it. No JSR, no publish.
#
#   irm https://raw.githubusercontent.com/riagentic/aio/main/install.ps1 | iex
#
# Re-running updates aio + am in place. Uninstall with `am uninstall`. Override
# with $env:AIO_HOME / $env:AIO_REPO / $env:AIO_BRANCH.
$ErrorActionPreference = 'Stop'
$AioHome   = if ($env:AIO_HOME)   { $env:AIO_HOME }   else { Join-Path $env:USERPROFILE '.local\lib\aio' }
$AioRepo   = if ($env:AIO_REPO)   { $env:AIO_REPO }   else { 'https://github.com/riagentic/aio' }
$AioBranch = if ($env:AIO_BRANCH) { $env:AIO_BRANCH } else { 'main' }

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# ── Deno ──
if (Have 'deno') {
  Write-Host "✓ deno $((deno --version | Select-Object -First 1))"
} else {
  Write-Host "▸ deno not found — installing..."
  irm https://deno.land/install.ps1 | iex
  $denoBin = Join-Path $env:USERPROFILE '.deno\bin'
  if (Test-Path $denoBin) { $env:PATH = "$denoBin;$env:PATH" }
  if (-not (Have 'deno')) { throw "deno install failed — see https://docs.deno.com/" }
}
if (-not (Have 'git')) { throw "git is required — install git and re-run" }

# ── Clone / update aio ──
if (Test-Path (Join-Path $AioHome '.git')) {
  Write-Host "▸ updating aio in $AioHome"
  git -C $AioHome fetch --depth 1 origin $AioBranch | Out-Null
  git -C $AioHome reset --hard "origin/$AioBranch" | Out-Null
} else {
  Write-Host "▸ cloning aio → $AioHome"
  git clone --depth 1 -b $AioBranch $AioRepo $AioHome | Out-Null
}
Write-Host "✓ aio $(git -C $AioHome rev-parse --short HEAD)"

# ── Install am from the clone ──
Write-Host "▸ installing am..."
deno install -gAf --config (Join-Path $AioHome 'deno.json') -n am (Join-Path $AioHome 'src\am.ts')
$denoBin = Join-Path $env:USERPROFILE '.deno\bin'
if (Test-Path $denoBin) { $env:PATH = "$denoBin;$env:PATH" }

if (Have 'am') { Write-Host "✓ am installed: $(am version)" }
else { Write-Host "✓ am installed to $denoBin — add it to PATH, then restart your shell" }

Write-Host ""
Write-Host "Next:"
Write-Host "  am create my-app   # scaffold a new aio app"
Write-Host "  cd my-app; deno task dev"
