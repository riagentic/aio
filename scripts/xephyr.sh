#!/bin/sh
# Start (and hold) the nested X display aio's GUI tests use.
#
# Why this is a script you run, and not something the test suite does:
# a harness that starts a window and kills it per run reproduces the very
# problem it is meant to solve — a window appearing and grabbing focus on
# every single invocation. So the display is long-lived and YOURS: start it
# once, leave it in a corner, close it when you are done for the day.
#
#   ./scripts/xephyr.sh            # start it, hold it (Ctrl-C or close = stop)
#   ./scripts/xephyr.sh --status   # is it up?
#   ./scripts/xephyr.sh --stop     # stop it
#
# The tests find it by themselves (src/testing/test-display.ts). If it is not
# running they start one detached and leave it up — same contract, less choice.
set -eu

DISPLAY_NUM="${AIO_TEST_DISPLAY:-:77}"
SCREEN="${AIO_TEST_SCREEN:-1280x900}"
SOCK="/tmp/.X11-unix/X${DISPLAY_NUM#:}"

is_up() { [ -e "$SOCK" ]; }

case "${1:-}" in
  --status)
    if is_up; then
      echo "up: $DISPLAY_NUM (tests will use it)"
    else
      echo "down: $DISPLAY_NUM — tests will start their own, or fall back to \$DISPLAY"
      exit 1
    fi
    ;;
  --stop)
    if ! is_up; then echo "already down: $DISPLAY_NUM"; exit 0; fi
    pkill -f "Xephyr.*${DISPLAY_NUM}\$" || pkill -f "Xephyr .*${DISPLAY_NUM}" || true
    echo "stopped $DISPLAY_NUM"
    ;;
  --help|-h)
    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  "")
    command -v Xephyr >/dev/null 2>&1 || {
      echo "Xephyr not installed." >&2
      echo "  Debian/Ubuntu: sudo apt install xserver-xephyr" >&2
      echo "  Fedora:        sudo dnf install xorg-x11-server-Xephyr" >&2
      echo "  Arch:          sudo pacman -S xorg-server-xephyr" >&2
      exit 1
    }
    if is_up; then
      echo "$DISPLAY_NUM is already up — nothing to do."
      exit 0
    fi
    echo "Xephyr on $DISPLAY_NUM ($SCREEN). Test windows open in here, not on"
    echo "your desktop. Leave it running; Ctrl-C or closing the window stops it."
    exec Xephyr -screen "$SCREEN" -resizeable -ac "$DISPLAY_NUM"
    ;;
  *)
    echo "unknown flag: $1 (try --status, --stop, --help)" >&2
    exit 1
    ;;
esac
