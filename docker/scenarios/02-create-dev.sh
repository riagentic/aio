#!/bin/sh
# Scenario 2 — the second and third lines a stranger runs.
#
#   am create my-app
#   cd my-app && deno task dev
#
# The README promises those two lines produce a working app. This scenario is
# the only place we have ever checked that on a machine that did not already
# have a warm module cache, a checked-out framework and a current deno.
#
# "Working" here is not "the port opened": the UI tree must render and a method
# must actually run (docker/verify-app.ts).
. /lab/scenarios/_lib.sh
ensure_aio_installed

step "am create demo"
cd "$HOME"
rm -rf demo
am create demo >/tmp/create.log 2>&1 || {
  cat /tmp/create.log >&2
  die "am create failed"
}
[ -f demo/deno.json ] || die "am create produced no deno.json"
ok "scaffolded $(wc -l </tmp/create.log) lines of output"
note "$(grep -c . /tmp/create.log) lines; app at $HOME/demo"

cd demo
pin_app_to_lab_ref

step "the scaffold type-checks (deno task check)"
# A scaffold that does not type-check is a scaffold that greets a new user with
# red squiggles in their editor before they have written a line.
if deno task check >/tmp/check.log 2>&1; then
  ok "deno task check clean"
else
  tail -30 /tmp/check.log >&2
  die "the freshly scaffolded app does not type-check"
fi

step "deno task dev"
LAB_LOG=/tmp/lab-app.log
: > "$LAB_LOG"
deno task dev --port="$LAB_PORT" >"$LAB_LOG" 2>&1 &
APP_PID=$!
wait_http "http://127.0.0.1:$LAB_PORT/" "the dev server" 180

step "is it actually working?"
# The appId defaults to the directory name when deno.json does not say —
# the same rule the framework uses, so the log path we look in is the one the
# app actually writes to.
APP_ID=$(sed -n 's/.*"appId"[: ]*"\([^"]*\)".*/\1/p' deno.json | head -1)
[ -n "$APP_ID" ] || APP_ID=$(basename "$PWD")
verify_app dev "$APP_ID"
stop_app

step "the app left no error in its own log"
# The framework's rule is fail-loud; a boot that printed an ERROR while still
# serving is exactly the "worked, but" a new user cannot interpret.
if grep -iE "^\s*(error|✗)|ERROR \[" "$LAB_LOG" | grep -v "0 errors" | head -5 >/tmp/errs.txt; then
  if [ -s /tmp/errs.txt ]; then
    cat /tmp/errs.txt >&2
    die "the dev server logged errors while serving"
  fi
fi
ok "no errors in the dev log"

printf "\n${green}${bold}scenario 2 passed${reset} — create → dev → a UI that renders and responds\n"
