# aio — one-line installer for `am` (the aio manager) on Windows.
#
#   irm https://raw.githubusercontent.com/riagentic/aio/main/install.ps1 | iex
#
# Installs Deno if missing, then installs `am` as a global command. Re-running
# updates am in place (same as `am update`). Uninstall with `am uninstall`.
$ErrorActionPreference = 'Stop'
# Prerelease-pinned: a BARE jsr spec resolves to the latest *stable* (an old
# 0.9.x with no ./am export), so the range is required to land on newest alpha.
$Pkg = 'jsr:@riagentic/aio@^1.0.0-alpha/am'

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# ── Deno (am runs on Deno) ──
if (Have 'deno') {
  Write-Host "✓ deno $((deno --version | Select-Object -First 1))"
} else {
  Write-Host "▸ deno not found — installing..."
  irm https://deno.land/install.ps1 | iex
  $denoBin = Join-Path $env:USERPROFILE '.deno\bin'
  if (Test-Path $denoBin) { $env:PATH = "$denoBin;$env:PATH" }
  if (-not (Have 'deno')) {
    throw "deno install failed — see https://docs.deno.com/runtime/getting_started/installation/"
  }
}

# ── am (into ~/.deno/bin — the same dir Deno already put on PATH) ──
Write-Host "▸ installing am..."
deno install -gAf --reload -n am $Pkg
$denoBin = Join-Path $env:USERPROFILE '.deno\bin'
if (Test-Path $denoBin) { $env:PATH = "$denoBin;$env:PATH" }

if (Have 'am') { Write-Host "✓ am installed: $(am version)" }
else {
  Write-Host "✓ am installed to $denoBin"
  Write-Host "  add it to PATH, then restart your shell"
}

Write-Host ""
Write-Host "Next:"
Write-Host "  am create my-app   # scaffold a new aio app"
Write-Host "  cd my-app; deno task dev"
