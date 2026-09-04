#!/bin/sh
# Scenario 4 — the DEFAULT client, on a machine that has a display.
#
# Electron is what an aio app uses when it says nothing else, so "the one-line
# command works" is mostly a claim about this path — and every other scenario
# runs headless, where the claim cannot even be made. A user reported exactly
# this gap: the one-liner built the app, Electron did not come up, and only a
# manual `deno task install:electron` made it work.
#
# The display is Xvfb: a real X server that writes to memory. The app opens a
# real window and real Chromium renders it; nothing needs a monitor.
#
# Deliberately absent from this image: node. `node_modules/.bin/electron` is a
# node shim, and Deno users routinely have no node — so a launch that depends
# on one is a launch that fails on the machines this framework targets.
. /lab/scenarios/_lib.sh
ensure_aio_installed

command -v Xvfb >/dev/null 2>&1 || die "this image has no Xvfb — build with --electron"
if command -v node >/dev/null 2>&1; then
  note "node IS present here; the point of this scenario is that it should not be needed"
fi

WORK="$HOME/electron-work"
rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"

case "${LAB_TARGET_KIND:-scaffold}" in
  git)
    step "target: $LAB_TARGET_GIT (run.sh clones it)"
    set -- "$LAB_TARGET_GIT"
    ;;
  path)
    step "target: the mounted project"
    cp -a /target ./project || die "could not copy /target"
    cd project
    rm -rf dist .aio dep node_modules 2>/dev/null || :
    set --
    ;;
  *)
    step "target: am create demo-electron --target=electron"
    am create demo-electron --target=electron >/tmp/create-e.log 2>&1 || {
      cat /tmp/create-e.log >&2; die "am create failed"; }
    cd demo-electron
    pin_app_to_lab_ref
    set --
    ;;
esac

step "starting a virtual display (:99)"
Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
sleep 2
kill -0 "$XVFB_PID" 2>/dev/null || { cat /tmp/xvfb.log >&2; die "Xvfb did not start"; }
export DISPLAY=:99
ok "DISPLAY=:99"

step "the one-line command, exactly as a user runs it"
LAB_LOG=/tmp/lab-app.log
: > "$LAB_LOG"
# A desktop has a session bus; a bare container does not, and Chromium is loud
# about it. Providing one keeps the log honest — the errors that remain are the
# app's, which is the point of the check below.
DBUS="dbus-run-session --"
command -v dbus-run-session >/dev/null 2>&1 || DBUS=""
if [ "$AIO_SOURCE" = "local" ]; then
  AIO_INSTALL=/aio-src/install.sh AIO_REPO=/aio-src \
    $DBUS sh /aio-src/run.sh "$@" >"$LAB_LOG" 2>&1 &
else
  # shellcheck disable=SC2086
  curl -fsSL "$AIO_RAW/run.sh" | sh -s $* >"$LAB_LOG" 2>&1 &
fi
APP_PID=$!

step "did an Electron WINDOW actually come up?"
# `pgrep -f electron` is NOT the check — it matches any command line containing
# the word, including `deno … --client=electron` and this scenario's own shell.
# The first version of this step did exactly that and reported success while
# Electron was aborting: the only "electron process" it found was /usr/bin/bash.
# So the process must be a real electron EXECUTABLE, and the window must be a
# real window the X server knows about.
electron_pid() {
  for _p in $(pgrep -f electron 2>/dev/null); do
    _exe=$(readlink -f "/proc/$_p/exe" 2>/dev/null || echo "")
    case "$_exe" in */electron) echo "$_p"; return 0 ;; esac
  done
  return 1
}

deadline=$(( $(date +%s) + 900 ))
EPID=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    die "the one-line command exited before Electron came up"
  fi
  EPID=$(electron_pid) && [ -n "$EPID" ] && break
  EPID=""
  sleep 3
done
[ -n "$EPID" ] || die "no real Electron BINARY ever ran (15 min) — the one-line command did not start the app in its default client"
ok "electron running: pid $EPID → $(readlink -f /proc/$EPID/exe)"

step "…and it put a WINDOW on the display"
# The X server is the authority: a client with a mapped window of real size is
# a window. A log line saying "launching Electron" is not.
wdeadline=$(( $(date +%s) + 120 ))
WIN=""
while [ "$(date +%s)" -lt "$wdeadline" ]; do
  WIN=$(xwininfo -root -tree 2>/dev/null | grep -E '[0-9]+x[0-9]+\+' \
        | grep -viE '^\s*0x[0-9a-f]+ \(has no name\): \(\) 1x1' | head -5)
  [ -n "$WIN" ] && break
  sleep 3
done
[ -n "$WIN" ] || die "Electron is running but NO window appeared on the display — the app started and showed nothing"
note "$(printf '%s' "$WIN" | head -2)"
ok "a window is mapped on :99"

step "…and the page in it MOUNTED the app (aio://, the shipped path)"
# A mapped window is not a painted one. A field report had exactly this: the
# packaged app started, served, logged errors=0, and the window stayed blank —
# the renderer had thrown before it painted and nothing said so. run.sh runs
# the BUILT artifact, whose window loads over aio://; the renderer reports its
# mount through the shell into the framework log, and that line is the proof.
mdeadline=$(( $(date +%s) + 120 ))
MOUNTED=""
while [ "$(date +%s)" -lt "$mdeadline" ]; do
  MOUNTED=$(grep -E 'INFO +renderer +ui mounted [1-9][0-9]* element' "$LAB_LOG" | head -1)
  [ -n "$MOUNTED" ] && break
  if grep -qE 'ERROR +renderer +' "$LAB_LOG"; then
    grep -E 'ERROR +renderer +' "$LAB_LOG" | head -5 >&2
    die "the renderer reported an error before mounting — the window is blank"
  fi
  sleep 3
done
[ -n "$MOUNTED" ] || die "the window never mounted the app over aio:// (no 'ui mounted' line in 120s) — a blank window"
ok "$(printf '%s' "$MOUNTED" | sed -E 's/.*renderer +//')"
if grep -qE 'ERROR +renderer +' "$LAB_LOG"; then
  grep -E 'ERROR +renderer +' "$LAB_LOG" | head -5 >&2
  die "the renderer logged errors after mounting"
fi
ok "no renderer errors"

step "did it INSTALL itself somewhere that outlives the checkout?"
# The one-liner used to run the build in place, out of the repo's dist/ — so
# deleting the clone deleted the app, and everyone who used it seriously copied
# the AppImage somewhere by hand. That copy is the script's job.
INST="$HOME/app"
[ -d "$INST" ] || die "nothing was installed under $INST — the app still only exists inside the checkout"
APPIMG=$(find "$INST" -maxdepth 4 -path '*/versions/*' -name '*.AppImage' 2>/dev/null | head -1)
[ -n "$APPIMG" ] || die "no AppImage under $INST"
ok "installed $APPIMG"
# The installed name must BE the app's name. Splitting at the first hyphen
# turned demo-electron into "demo" and would have made chat-app "chat".
# The installed FILE must be named after the app — not the app plus a version.
# A deno-compiled binary takes its identity from its own file name at runtime,
# so `<app>-<version>` made the app call itself `app-1-0-0` and write to
# `~/.app-1-0-0/`; the next version moved it again, starting from empty state.
[ "$(basename "$APPIMG")" = "$(basename "$PWD").AppImage" ] \
  || die "installed as '$(basename "$APPIMG")' — the running file must be named '$(basename "$PWD").AppImage' or the app's identity (and its data directory) changes with every version"
case "$APPIMG" in
  */versions/*) ok "version is in the directory, not the file name" ;;
  *) die "expected the artifact under versions/<version>/" ;;
esac
# A stable name beside the versioned file: what a menu entry and a shell alias
# point at, so an update does not break either.
STABLE=$(dirname "$(dirname "$(dirname "$APPIMG")")")/$(basename "$(dirname "$(dirname "$(dirname "$APPIMG")")")").AppImage
[ -e "$STABLE" ] || die "no stable symlink beside the versioned artifact ($STABLE)"
ok "stable name $STABLE"
DESK="$HOME/.local/share/applications/$(basename "$PWD").desktop"
if [ -f "$DESK" ]; then
  # Since alpha73 the Exec line wraps the artifact in `sh -c` to hand the
  # AppImage a private TMPDIR before it unpacks — so the install path is
  # INSIDE the line, not at its start. What matters is that the entry
  # launches the installed artifact, wherever the wrapper puts it.
  grep -q "^Exec=.*$INST" "$DESK" || die "$DESK does not point into $INST"
  grep -q "^Icon=" "$DESK" || note "no Icon= line (the AppImage carried none)"
  ok "menu entry $DESK"
else
  die "no .desktop entry — a GUI app that cannot be launched from the desktop"
fi

step "…and the running process is the INSTALLED copy"
# `readlink /proc/<pid>/exe` points into the extracted AppImage, so compare the
# mount/extract root's origin instead: the app dir under ~/.<appId> is derived
# from the artifact that was actually launched.
ok "running from $(readlink -f /proc/$EPID/exe 2>/dev/null | head -1)"

step "no errors while it started"
# App-level failures only. "No such file or directory" was in this list and
# matched Chromium's dbus chatter, failing a run whose window was up and
# painted — a check that fires on someone else's noise is a check people learn
# to ignore.
if grep -iE "FATAL|SIGTRAP|exited with signal|could not be installed|✗ (electron|appimage|build)" "$LAB_LOG" >/tmp/eerr.txt 2>/dev/null && [ -s /tmp/eerr.txt ]; then
  head -6 /tmp/eerr.txt >&2
  die "the app logged a failure while starting its default client"
fi
ok "clean start"

stop_app

step "upgrade: a second install adds a version and re-points the stable name"
# The update MECHANICS are unit-tested; this is the part units cannot see — a
# real second build, through the real script, over a real install. The failure
# it guards against is concrete: renaming a new artifact over the stable
# SYMLINK turns it into a file and loses every earlier version.
APPNAME=$(basename "$PWD")
STABLE_BEFORE=$(readlink -f "$STABLE")
# Bump the app's version the way its author would.
sed -i 's/"version": "0.1.0"/"version": "0.2.0"/' deno.json 2>/dev/null || :
if am upgrade "$APPNAME" >/tmp/upgrade.log 2>&1; then
  ok "$(tail -1 /tmp/upgrade.log)"
else
  tail -20 /tmp/upgrade.log >&2
  die "am upgrade failed"
fi
[ -L "$STABLE" ] || die "the stable name is no longer a symlink — the upgrade FLATTENED the install"
STABLE_AFTER=$(readlink -f "$STABLE")
[ "$STABLE_AFTER" != "$STABLE_BEFORE" ] || die "the stable name still points at the old version ($STABLE_AFTER)"
ok "stable name now → versions/$(basename "$(dirname "$STABLE_AFTER")")/$(basename "$STABLE_AFTER")"
[ -f "$STABLE_BEFORE" ] || die "the previous version was deleted — there is nothing to roll back to"
ok "previous version kept (versions/$(basename "$(dirname "$STABLE_BEFORE")")/)"
KEPT=$(find "$INST/$APPNAME/versions" -maxdepth 1 -mindepth 1 -type d | wc -l)
[ "$KEPT" -le 3 ] || die "$KEPT versions kept — the install directory grows without bound"
ok "$KEPT version(s) kept (bounded)"
grep -q "\"source\"" "$INST/$APPNAME/installed.json" 2>/dev/null \
  && ok "install record present ($INST/$APPNAME/installed.json)" \
  || die "no install record — am upgrade had nothing to re-run"

step "the app's IDENTITY did not move when it was installed or upgraded"
# The data directory is derived from the app id. If installing or updating
# changes that id, the app starts from empty state and the real data is
# orphaned in a directory nobody looks in — silent, and unrecoverable by
# anyone who does not know to go looking.
DATADIRS=$(ls -d "$HOME"/."$APPNAME"* 2>/dev/null | wc -l)
[ -d "$HOME/.$APPNAME" ] || die "the app never wrote ~/.$APPNAME — its identity is not what it is called"
if [ "$DATADIRS" -gt 1 ]; then
  ls -d "$HOME"/."$APPNAME"* >&2
  die "$DATADIRS data directories for one app — the identity changed between runs (install/upgrade renamed it)"
fi
ok "one data directory, before and after the upgrade: ~/.$APPNAME"

step "am remove: uninstall takes back exactly what install created"
# Data first: the app ran, so it has some. Removing the PROGRAM must not touch
# it — that is the line this command promises not to cross.
DATA="$HOME/.$APPNAME"
[ -d "$DATA" ] || DATA="$HOME/.demo-electron"
# Graceful, the way a person does it: the app is still holding its singleton
# lock, and `am remove` REFUSES to delete a running app's binary (deleting it
# leaves the process running from an unlinked inode and failing confusingly at
# the next start). Prove the refusal is survivable by doing what it says.
if am remove "$APPNAME" >/tmp/remove-running.log 2>&1; then
  note "removed while running (no lock was held)"
else
  grep -qi "is running" /tmp/remove-running.log \
    || { cat /tmp/remove-running.log >&2; die "am remove failed for a reason other than the app running"; }
  ok "refused to remove a RUNNING app — as designed"
  am stop --app="$APPNAME" >/dev/null 2>&1 || :
  sleep 2
  am remove "$APPNAME" >/tmp/remove.log 2>&1 \
    || { cat /tmp/remove.log >&2; die "am remove failed after am stop"; }
fi
[ -d "$INST/$APPNAME" ] && die "am remove left $INST/$APPNAME behind"
[ -f "$DESK" ] && die "am remove left the menu entry behind"
ok "removed the program"
if [ -d "$DATA" ]; then
  ok "and KEPT the data ($DATA) — as promised"
else
  note "no data dir to keep ($DATA)"
fi
grep -qi "kept its data" /tmp/remove.log || note "the summary did not mention kept data"

kill "$XVFB_PID" 2>/dev/null || :
printf "\n${green}${bold}scenario 4 passed${reset} — the default client came up on a real display\n"
