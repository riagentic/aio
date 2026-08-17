#!/bin/sh
# Shared helpers for lab scenarios. POSIX sh — the container has bash, but a
# scenario that needs bashisms is a scenario that would not survive the next
# minimal base image.
#
# Every scenario runs as the non-root `aio` user, in a container where the only
# tools are ca-certificates, curl and git. If a step needs anything else, that
# is the finding.

set -e

LAB_PORT="${LAB_PORT:-8777}"
LAB_LOG="${LAB_LOG:-/tmp/lab-app.log}"
BROWSER_BIN="${BROWSER_BIN:-}"

bold="\033[1m"; dim="\033[2m"; cyan="\033[36m"; green="\033[32m"; red="\033[31m"; reset="\033[0m"

step() { printf "\n${cyan}▸ %s${reset}\n" "$1"; }
ok()   { printf "${green}✓${reset} %s\n" "$1"; }
note() { printf "${dim}  %s${reset}\n" "$1"; }

# A failure prints WHY, then whatever the app said — the log tail is the part a
# developer actually needs, and the part our old E2E threw away.
die() {
  printf "\n${red}✗ FAILED:${reset} %s\n" "$1" >&2
  if [ -f "$LAB_LOG" ]; then
    printf "\n${dim}── last 40 lines of the app's own output ──${reset}\n" >&2
    tail -40 "$LAB_LOG" >&2 || :
  fi
  exit 1
}

# deno + am live in ~/.deno/bin, which a fresh shell does not have on PATH.
# Scenarios source this AFTER install, so they see what a returning user sees.
use_aio_path() {
  DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
  PATH="$DENO_INSTALL/bin:$HOME/.deno/bin:$PATH"
  export DENO_INSTALL PATH
}

# Wait for an HTTP endpoint to answer at all (the app may still be booting).
wait_http() {
  _url="$1"; _what="${2:-$1}"; _deadline=$(( $(date +%s) + ${3:-120} ))
  while [ "$(date +%s)" -lt "$_deadline" ]; do
    if curl -fsS -o /dev/null "$_url" 2>/dev/null; then
      ok "$_what is answering"
      return 0
    fi
    # A dead process will never answer — say so immediately instead of
    # burning the whole timeout, which is how a crash used to read as "slow".
    if [ -n "${APP_PID:-}" ] && ! kill -0 "$APP_PID" 2>/dev/null; then
      die "$_what exited before it served anything (pid $APP_PID is gone)"
    fi
    sleep 1
  done
  die "$_what never answered on $_url"
}

# Run the framework's own verifier against a listening app.
verify_app() {
  _mode="$1"; _appid="${2:-}"
  _args="--port=$LAB_PORT --mode=$_mode"
  [ -n "$BROWSER_BIN" ] && _args="$_args --browser=$BROWSER_BIN"
  [ -n "$_appid" ] && _args="$_args --app-id=$_appid"
  # shellcheck disable=SC2086
  deno run -A /lab/verify-app.ts $_args || die "the app is not working (see the tiers above)"
}

stop_app() {
  [ -n "${APP_PID:-}" ] || return 0
  kill "$APP_PID" 2>/dev/null || :
  sleep 1
  kill -9 "$APP_PID" 2>/dev/null || :
  APP_PID=""
}

# The version the FRAMEWORK requires, read from the framework itself — never a
# number copied into a shell script, which is how a minimum becomes two
# different minimums.
min_deno_from_src() {
  _src="${1:-/aio-src}"
  sed -n 's/.*MIN_DENO = "\([^"]*\)".*/\1/p' \
    "$_src/src/server/deno-version.ts" 2>/dev/null | head -1
}

# Every scenario starts on a FRESH machine — that is the point of the lab — so
# anything past the installer has to install first. It is not a shortcut around
# scenario 1: it runs the same real installer, which means every scenario
# re-proves that the install works before testing what comes after it.
ensure_aio_installed() {
  use_aio_path
  if command -v am >/dev/null 2>&1 && am version >/dev/null 2>&1; then
    return 0
  fi
  step "installing aio (this machine is bare)"
  if [ "${AIO_SOURCE:-local}" = "local" ]; then
    AIO_REPO=/aio-src sh /aio-src/install.sh >/tmp/install.log 2>&1 || {
      tail -25 /tmp/install.log >&2; die "install.sh failed"; }
  else
    curl -fsSL "$AIO_RAW/install.sh" | sh >/tmp/install.log 2>&1 || {
      tail -25 /tmp/install.log >&2; die "the published install.sh failed"; }
  fi
  use_aio_path
  command -v am >/dev/null 2>&1 || die "am is missing after a successful install"
  ok "aio installed ($(am version 2>/dev/null | head -1))"
}

# Make a SCAFFOLDED app build against the framework under test.
#
# `am create` pins the app to the last RELEASE and links dep/aio at the
# versions store — the exact-pin invariant, and correct: an app builds against
# the version it declares. The consequence for this lab is that scenarios past
# the installer were testing the last tag, not the checkout, so a fix to the
# BUILD could pass here while still being broken (and a broken one could pass
# for the same reason). `am pin` is the framework's own way to move that, so
# the lab uses it and says so.
#
# Only for scaffolds: a user's own repo pins what it pins, and silently moving
# it would answer a different question than "does this repo work".
pin_app_to_lab_ref() {
  [ "${AIO_SOURCE:-local}" = "local" ] || return 0
  [ -n "${AIO_REF:-}" ] || return 0
  step "pinning this app to the framework under test ($AIO_REF)"
  if am pin "$AIO_REF" >/tmp/pin.log 2>&1; then
    ok "dep/aio → $(readlink -f dep/aio 2>/dev/null || echo '?')"
  else
    tail -12 /tmp/pin.log >&2
    die "am pin $AIO_REF failed — the app would silently build against the last RELEASE instead of the code under test"
  fi
}
