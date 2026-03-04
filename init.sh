#!/bin/sh
# aio — one-liner project scaffolder
# Usage: sh -c "$(curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/init.sh)" -- my-app
set -e

REPO="riagentic/aio"
BRANCH="main"
INIT_URL="https://raw.githubusercontent.com/$REPO/$BRANCH/init.ts"

# ── Colors ──
bold="\033[1m"  dim="\033[2m"  cyan="\033[36m"  green="\033[32m"  red="\033[31m"  reset="\033[0m"

info()  { printf "${cyan}▸${reset} %s\n" "$1"; }
ok()    { printf "${green}✓${reset} %s\n" "$1"; }
fail()  { printf "${red}✗${reset} %s\n" "$1" >&2; exit 1; }

# ── Check / install Deno ──
if command -v deno >/dev/null 2>&1; then
  ok "deno $(deno --version | head -1 | awk '{print $2}')"
else
  info "deno not found — installing..."
  curl -fsSL https://deno.land/install.sh | sh
  # Add to PATH for this session
  export DENO_INSTALL="$HOME/.deno"
  export PATH="$DENO_INSTALL/bin:$PATH"
  if command -v deno >/dev/null 2>&1; then
    ok "deno installed: $(deno --version | head -1 | awk '{print $2}')"
  else
    fail "deno installation failed — check https://docs.deno.com/runtime/getting_started/installation/"
  fi
fi

# ── Run scaffolder ──
exec deno run -A "$INIT_URL" "$@"
