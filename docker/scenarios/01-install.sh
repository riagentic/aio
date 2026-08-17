#!/bin/sh
# Scenario 1 — the first line a stranger runs.
#
#   curl -fsSL https://…/install.sh | sh
#
# What must be true afterwards, and what we never checked before:
#   • deno is present AND new enough (a user reported the installer printing
#     "✓ deno 2.1.4" and moving on — every later failure then pointed at
#     something else entirely);
#   • `am` runs — not "the file exists", RUNS;
#   • it runs in a FRESH LOGIN SHELL, because a PATH that only works inside the
#     installer's own process is a PATH that does not work.
. /lab/scenarios/_lib.sh

step "install.sh — from $AIO_SOURCE"
if [ "$AIO_SOURCE" = "local" ]; then
  # The local checkout, cloned as a git repo would be. This is the fast loop:
  # it tests the SCRIPT, not the network.
  AIO_REPO=/aio-src sh /aio-src/install.sh || die "install.sh exited non-zero"
else
  curl -fsSL "$AIO_RAW/install.sh" | sh || die "the published install.sh failed"
fi

step "deno is present and new enough"
use_aio_path
command -v deno >/dev/null 2>&1 || die "deno is not on PATH after install.sh"
HAVE=$(deno --version | head -1 | awk '{print $2}')
WANT=$(min_deno_from_src "${AIO_HOME:-$HOME/.local/lib/aio}")
[ -n "$WANT" ] || WANT=$(min_deno_from_src /aio-src)
note "have deno $HAVE, framework requires $WANT"
# Numeric compare, field by field — `sort -V` is not on every base image and a
# string compare calls 2.10 older than 2.9.
newer_or_equal() {
  _h_maj=${1%%.*}; _rest=${1#*.}; _h_min=${_rest%%.*}; _h_pat=${_rest#*.}; _h_pat=${_h_pat%%[-+]*}
  _w_maj=${2%%.*}; _rest=${2#*.}; _w_min=${_rest%%.*}; _w_pat=${_rest#*.}; _w_pat=${_w_pat%%[-+]*}
  [ "$_h_maj" -gt "$_w_maj" ] && return 0
  [ "$_h_maj" -lt "$_w_maj" ] && return 1
  [ "$_h_min" -gt "$_w_min" ] && return 0
  [ "$_h_min" -lt "$_w_min" ] && return 1
  [ "${_h_pat:-0}" -ge "${_w_pat:-0}" ]
}
newer_or_equal "$HAVE" "$WANT" \
  || die "deno $HAVE is older than the required $WANT — install.sh left this box unable to run aio. THIS is the reported bug: it must upgrade deno, or refuse with the exact command that fixes it."
ok "deno $HAVE ≥ $WANT"

step "am RUNS (not just exists)"
command -v am >/dev/null 2>&1 || die "am is not on PATH after install.sh"
am version >/tmp/am-version.txt 2>&1 || die "am is installed but does not run: $(cat /tmp/am-version.txt)"
ok "am version → $(head -1 /tmp/am-version.txt)"

step "…and in a FRESH login shell"
# The installer prints a PATH hint; a hint is not a working install. If this
# fails, the one-liner's promise ("run this, then use am") is false for anyone
# who opens a new terminal — which is everyone.
if bash -lc 'am version' >/tmp/am-login.txt 2>&1; then
  ok "a new shell finds am: $(head -1 /tmp/am-login.txt)"
else
  die "am works in the installer's shell but NOT in a fresh login shell — the installer must persist PATH (or say precisely what to add, and we must test that instruction). Output: $(head -3 /tmp/am-login.txt)"
fi

step "the framework checkout is a real, pinned clone"
[ -d "${AIO_HOME:-$HOME/.local/lib/aio}/.git" ] || die "no git checkout at ${AIO_HOME:-$HOME/.local/lib/aio}"
git -C "${AIO_HOME:-$HOME/.local/lib/aio}" describe --tags >/tmp/aio-tag.txt 2>&1 \
  && ok "aio at $(cat /tmp/aio-tag.txt)" \
  || note "no tag reachable (branch checkout) — acceptable, but a release should be tagged"

printf "\n${green}${bold}scenario 1 passed${reset} — a stranger can install aio\n"
