#!/bin/sh
# Scenario 3 — the one-line app runner, which is the promise that broke.
#
#   curl -fsSL https://…/run.sh | sh                    (in an app repo)
#   curl -fsSL https://…/run.sh | sh -s owner/repo      (from a link)
#
# It has to take a machine with NOTHING on it to a PRODUCTION BUILD that runs
# and serves a working UI. Everything in between — deno, the framework, `am`,
# `am fix`, the compile, finding the artifact — is its problem, not the user's.
#
# The target comes from the runner:
#   LAB_TARGET_KIND=scaffold  → build the app scenario 2 scaffolded
#   LAB_TARGET_KIND=path      → /target, a project bind-mounted from the host
#   LAB_TARGET_KIND=git       → LAB_TARGET_GIT, a repo URL run.sh must clone
#
# A prod artifact has no trojan API (dev-only, by design), so "working UI" here
# is answered by a real browser when one is present, and by the served shell +
# the app's own health when one is not.
. /lab/scenarios/_lib.sh
ensure_aio_installed

WORK="$HOME/run-sh-work"
rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

case "${LAB_TARGET_KIND:-scaffold}" in
  scaffold)
    step "preparing a target: am create demo-run"
    am create demo-run >/tmp/create-run.log 2>&1 || {
      cat /tmp/create-run.log >&2; die "am create failed"; }
    cd demo-run
    pin_app_to_lab_ref
    ;;
  path)
    step "preparing a target: a copy of the mounted project"
    [ -d /target ] || die "LAB_TARGET_KIND=path but nothing is mounted at /target"
    # A COPY, because run.sh builds in place and the mount is the user's real
    # working tree. A test harness that dirties the thing under test is a
    # harness people stop running.
    cp -a /target ./project || die "could not copy /target"
    cd project
    # A checkout may carry the previous machine's build output and lockfile.
    rm -rf dist .aio dep node_modules 2>/dev/null || :
    ;;
  git)
    step "preparing a target: $LAB_TARGET_GIT (run.sh clones it itself)"
    [ -n "${LAB_TARGET_GIT:-}" ] || die "LAB_TARGET_KIND=git needs LAB_TARGET_GIT"
    ;;
esac

step "run.sh — production build and run (as --client=browser, so the UI is reachable)"
LAB_LOG=/tmp/lab-app.log
: > "$LAB_LOG"

# `--` passes the port through to the app; run.sh forwards everything after it.
# `--client=browser` is not a convenience, it is what makes the UI VISIBLE to
# anything but a desktop. An app whose default target is electron does two
# things in a container that defeat verification: it launches Electron (which
# needs a display and a node runtime that are deliberately absent here), and it
# talks over a UNIX SOCKET with zero TCP ports — so there is no address to open
# and nothing to check. Asking for the browser client makes the same build
# serve the same UI over HTTP, which is the thing we can actually look at.
APP_ARGS="--port=$LAB_PORT --client=browser"
if [ "${LAB_TARGET_KIND:-scaffold}" = "git" ]; then
  # shellcheck disable=SC2086
  set -- "$LAB_TARGET_GIT" -- $APP_ARGS
else
  # shellcheck disable=SC2086
  set -- -- $APP_ARGS
fi

if [ "$AIO_SOURCE" = "local" ]; then
  # Offline-ish: the installer branch resolves to the mounted checkout.
  AIO_INSTALL=/aio-src/install.sh AIO_REPO=/aio-src \
    sh /aio-src/run.sh "$@" >"$LAB_LOG" 2>&1 &
else
  curl -fsSL "$AIO_RAW/run.sh" | sh -s "$@" >"$LAB_LOG" 2>&1 &
fi
APP_PID=$!

# The build happens inside run.sh, so this wait covers compile time too — a
# generous deadline, and a dead pid short-circuits it (see wait_http).
wait_http "http://127.0.0.1:$LAB_PORT/" "the production artifact" 900

step "did it really build a binary?"
if grep -q "built " "$LAB_LOG"; then
  ok "$(grep -m1 'built ' "$LAB_LOG")"
else
  note "run.sh printed no 'built' line — it may have run a dev path instead"
fi

step "is the production app working?"
APP_ID=$(sed -n 's/.*"appId"[: ]*"\([^"]*\)".*/\1/p' deno.json 2>/dev/null | head -1)
[ -n "$APP_ID" ] || APP_ID=$(basename "$PWD")
verify_app prod "$APP_ID"
stop_app

printf "\n${green}${bold}scenario 3 passed${reset} — one line took a bare machine to a running production app\n"
