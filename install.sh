#!/bin/sh
# aio — one-line installer for `am` (the aio manager). Source-based: clones the
# framework from GitHub and installs `am` from it. No JSR, no publish, no login.
#
#   curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh
#
# Re-running updates aio + am in place (same as `am update`). Uninstall with
# `am uninstall`. Override the location with AIO_HOME, or a fork/branch with
# AIO_REPO / AIO_BRANCH.
set -e

AIO_HOME="${AIO_HOME:-$HOME/.local/lib/aio}"
AIO_REPO="${AIO_REPO:-https://github.com/riagentic/aio}"
AIO_BRANCH="${AIO_BRANCH:-main}"

bold="\033[1m"; dim="\033[2m"; cyan="\033[36m"; green="\033[32m"; red="\033[31m"; reset="\033[0m"
info() { printf "${cyan}▸${reset} %s\n" "$1"; }
ok()   { printf "${green}✓${reset} %s\n" "$1"; }
fail() { printf "${red}✗${reset} %s\n" "$1" >&2; exit 1; }

# ── Deno (am runs on Deno) ──
if command -v deno >/dev/null 2>&1; then
  ok "deno $(deno --version | head -1 | awk '{print $2}')"
else
  info "deno not found — installing..."
  curl -fsSL https://deno.land/install.sh | sh -s -- -y >/dev/null 2>&1 || \
    curl -fsSL https://deno.land/install.sh | sh
  export DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
  export PATH="$DENO_INSTALL/bin:$PATH"
  command -v deno >/dev/null 2>&1 \
    && ok "deno installed: $(deno --version | head -1 | awk '{print $2}')" \
    || fail "deno install failed — see https://docs.deno.com/runtime/getting_started/installation/"
fi

command -v git >/dev/null 2>&1 || fail "git is required — install git and re-run"

# ── Clone / update aio ──
if [ -d "$AIO_HOME/.git" ]; then
  info "updating aio in $AIO_HOME"
  git -C "$AIO_HOME" fetch --depth 1 origin "$AIO_BRANCH" >/dev/null 2>&1
  git -C "$AIO_HOME" reset --hard "origin/$AIO_BRANCH" >/dev/null 2>&1
  ok "aio updated ($(git -C "$AIO_HOME" rev-parse --short HEAD))"
else
  info "cloning aio → $AIO_HOME"
  git clone --depth 1 -b "$AIO_BRANCH" "$AIO_REPO" "$AIO_HOME" >/dev/null 2>&1 \
    || fail "git clone failed — check network / $AIO_REPO"
  ok "aio cloned ($(git -C "$AIO_HOME" rev-parse --short HEAD))"
fi

# ── Install am from the clone (its deno.json supplies the import map) ──
info "installing am..."
deno install -gAf --config "$AIO_HOME/deno.json" -n am "$AIO_HOME/src/am.ts"

export DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
export PATH="$DENO_INSTALL/bin:$PATH"
if command -v am >/dev/null 2>&1; then
  ok "am installed: $(am version 2>/dev/null || echo am)"
else
  ok "am installed to $DENO_INSTALL/bin"
  printf "${dim}  add it to PATH:${reset} export PATH=\"\$HOME/.deno/bin:\$PATH\"\n"
fi

printf "\n${bold}Next:${reset}\n"
printf "  am create my-app   ${dim}# scaffold a new aio app (points at %s)${reset}\n" "$AIO_HOME"
printf "  cd my-app && deno task dev\n"
