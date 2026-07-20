#!/bin/sh
# aio — one-line installer for `am` (the aio manager).
#
#   curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh
#
# Installs Deno if missing, then installs `am` as a global command. Re-running
# updates am in place (same as `am update`). Uninstall with `am uninstall`.
set -e

# Prerelease-pinned: aio is in 1.0.0-alpha, and a BARE jsr spec resolves to the
# latest *stable* (an old 0.9.x with no ./am export) — so the range is required
# to land on the newest alpha. Widens to 1.0.0 final automatically once it ships.
PKG="jsr:@riagentic/aio@^1.0.0-alpha/am"

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
  # Deno installs to ~/.deno/bin and wires PATH in your shell rc for next login;
  # make it usable in THIS session too.
  export DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
  export PATH="$DENO_INSTALL/bin:$PATH"
  command -v deno >/dev/null 2>&1 \
    && ok "deno installed: $(deno --version | head -1 | awk '{print $2}')" \
    || fail "deno install failed — see https://docs.deno.com/runtime/getting_started/installation/"
fi

# ── am (into ~/.deno/bin — the same dir Deno already put on PATH) ──
info "installing am..."
deno install -gAf --reload -n am "$PKG"

# ── Verify / PATH hint ──
export DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
export PATH="$DENO_INSTALL/bin:$PATH"
if command -v am >/dev/null 2>&1; then
  ok "am installed: $(am version 2>/dev/null || echo am)"
else
  ok "am installed to $DENO_INSTALL/bin"
  printf "${dim}  add it to PATH:${reset} export PATH=\"\$HOME/.deno/bin:\$PATH\"\n"
fi

printf "\n${bold}Next:${reset}\n"
printf "  am create my-app   ${dim}# scaffold a new aio app${reset}\n"
printf "  cd my-app && deno task dev\n"
