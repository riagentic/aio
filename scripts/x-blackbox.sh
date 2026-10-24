#!/bin/sh
# Black box for the X crash (feedback/critical.md). Records, until X dies:
#   x-events.log  every window create/map/configure (frames + clients), fsync'd
#   xid.log       kernel NVIDIA Xid/segfault lines, live
#   vram.log      VRAM per GPU every second
#   layout.txt    monitors + Cinnamon settings at start
# Read-only: it draws nothing. Run it from a terminal BEFORE testing:
#   scripts/x-blackbox.sh          # start (prints the run folder)
#   scripts/x-blackbox.sh stop
# Logs go to AIO_BLACKBOX_DIR (default untracked/blackbox, gitignored).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
BASE="${AIO_BLACKBOX_DIR:-$HERE/../untracked/blackbox}"
case "${1:-start}" in
  start)
    RUN="$BASE/$(date +%m%d-%H%M%S)"; mkdir -p "$RUN"
    { date; xrandr --current --listmonitors; gsettings list-recursively org.cinnamon.muffin;
      nvidia-smi --query-gpu=index,driver_version,memory.used,memory.total --format=csv; } > "$RUN/layout.txt" 2>&1
    setsid python3 -I "$HERE/x-blackbox.py" "$RUN/x-events.log" </dev/null >"$RUN/x-err.log" 2>&1 &
    echo $! > "$RUN/pids"
    # One process group, so `stop` ends journalctl and grep together.
    setsid sh -c 'journalctl -kf -n0 -o short-precise 2>/dev/null | grep --line-buffered -E "Xid|segfault|NVRM"' </dev/null >> "$RUN/xid.log" &
    echo $! >> "$RUN/pids"
    setsid nvidia-smi --query-gpu=timestamp,index,memory.used --format=csv,noheader -lms 1000 </dev/null >"$RUN/vram.log" 2>&1 &
    echo $! >> "$RUN/pids"
    ln -sfn "$RUN" "$BASE/latest"
    echo "recording into $RUN"
    ;;
  stop)
    [ -f "$BASE/latest/pids" ] || { echo "not recording"; exit 0; }
    while read -r p; do kill -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null || true; done < "$BASE/latest/pids"
    echo "stopped; logs in $(readlink -f "$BASE/latest")"
    ;;
esac
