#!/bin/sh
# Scenario 6 — the Windows ARTIFACT, executed.
#
# Every release cross-compiles `x86_64-pc-windows-msvc` and, until this
# scenario, had never run the result. "It compiles" is not "it starts": the
# compiled binary opens a SQLite database in a worker, resolves its own app id,
# picks a data directory from the PLATFORM's rules, and serves. All of that is
# Windows-specific code that a Linux build never executes.
#
# Wine is a real Win32 implementation and a Deno binary is a plain PE, so the
# .exe runs here for real — same binary that would ship. What Wine is NOT is a
# Windows box: `install.ps1`/`run.ps1` are not touched by this scenario (see
# --scenario=windows-scripts and Dockerfile.windows-app for why), and the
# registry, Start Menu, SmartScreen and file-locking behaviour of a genuine
# Windows machine remain untested. This scenario claims exactly one thing: the
# artifact we ship starts, persists, and serves its UI.
#
# The runner cross-compiles the .exe on the host and mounts it at /work/app.exe
# with the app id in LAB_WIN_APPID.
. /lab/scenarios/_lib.sh

APPID="${LAB_WIN_APPID:?LAB_WIN_APPID not set by the runner}"
LAB_PORT="${LAB_PORT:-8123}"
CDRIVE="$WINEPREFIX/drive_c"

step "preparing the wine prefix"
wineboot -i >/dev/null 2>&1 || :
ok "wine $(wine --version 2>/dev/null)"

[ -f /work/app.exe ] || die "no /work/app.exe — the runner did not build one"
cp /work/app.exe "$CDRIVE/app.exe" || die "could not copy the artifact into the prefix"
ok "artifact staged as C:\\app.exe ($(du -m "$CDRIVE/app.exe" | cut -f1) MB)"

step "starting the Windows binary under wine"
# --client=browser: the .exe is an app binary, and a browser client makes the
# same build serve the same UI over HTTP — the only way to SEE a desktop app's
# screen without a desktop. Named here so nobody reads the result as "the
# electron target was tested".
( wine "$CDRIVE/app.exe" --client=browser --port="$LAB_PORT" \
    >/tmp/app.out 2>/tmp/app.err & ) || die "wine could not start the binary"

# No APP_PID: the process the shell can see is wine's launcher, not the app —
# `wait_for` falls back to the timeout, and the log tail below is what says why
# on a failure.
wait_http "http://127.0.0.1:$LAB_PORT/__aio/health" "the Windows binary" 90 || {
  echo "--- stdout ---"; tail -20 /tmp/app.out
  echo "--- stderr ---"; tail -20 /tmp/app.err
  die "the .exe never served — it compiled, but it does not run"
}

step "is the expected screen there?"
# The app writes to a WINDOWS-shaped profile path, so the log tier is pointed at
# the prefix rather than $HOME — otherwise it would scan an empty directory and
# report "clean", which is the shape of a green test over a broken app.
WIN_LOGS="$CDRIVE/users/$(id -un)/.$APPID/logs"
_args="--port=$LAB_PORT --mode=full --log-dir=$WIN_LOGS"
[ -n "$BROWSER_BIN" ] && _args="$_args --browser=$BROWSER_BIN"
# shellcheck disable=SC2086
deno run -A /lab/verify-app.ts $_args || {
  echo "--- stdout ---"; tail -20 /tmp/app.out
  echo "--- stderr ---"; tail -20 /tmp/app.err
  die "the Windows binary serves, but its UI does not work"
}

step "did it land where Windows says it should?"
# The identity check that a compiled binary gets wrong most expensively: it
# resolved its app id, and it wrote its state where that id says — not into a
# directory named after the FILE (`app`), which is the data-loss shape fixed in
# alpha59 and worth re-proving on the platform where it was found.
DATA="$CDRIVE/users/$(id -un)/.$APPID"
[ -d "$DATA" ] || die "no data directory for \"$APPID\" — the binary took its identity from somewhere else (looked in $DATA; found: $(ls -a "$CDRIVE/users/$(id -un)" 2>/dev/null | tr '\n' ' '))"
ok "data: C:\\users\\$(id -un)\\.$APPID"
[ -f "$DATA/data/state.db" ] && ok "sqlite: state.db written by the worker" \
  || note "no state.db (persist may be off for this app)"

# One directory, not two: a second `.<something>` for the same app is the file
# name leaking back into the identity.
_dirs=$(ls -ad "$CDRIVE/users/$(id -un)"/.*/ 2>/dev/null | grep -vE '/\.$|/\.\./|/\.wine|/\.local|/\.config|/\.cache' | wc -l)
[ "$_dirs" -le 1 ] || die "the app owns $_dirs dot-directories in the Windows profile — its identity is not stable"

ok "the Windows artifact starts, persists and serves"
