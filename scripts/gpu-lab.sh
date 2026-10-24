#!/bin/sh
# An isolated X server on an idle NVIDIA GPU — the real NVIDIA X driver, not
# a nested one — for reproducing window bugs that only the real driver hits.
#
# Why: Xephyr (scripts/xephyr.sh) draws through its OWN software path, so a
# window inside it never reaches nvidia_drv.so. A driver crash triggered by
# an app window (feedback/critical.md: Xid 69, 2D engine, dst X = -10 → Xorg
# segfault) is invisible to every test that uses it. This lab runs a second
# Xorg on a GPU with no monitor in use: if the bug fires, THIS server dies,
# the desktop does not.
#
#   scripts/gpu-lab.sh prep          # as you: write the lab (config, cookie, home)
#   sudo scripts/gpu-lab.sh up       # as root: start Xorg on the idle GPU
#   scripts/gpu-lab.sh desk          # as you: start the window manager in it
#   scripts/gpu-lab.sh run CMD...    # as you: run CMD on the lab display
#   scripts/gpu-lab.sh shot          # screenshot of the lab display
#   scripts/gpu-lab.sh xids          # NVIDIA Xid lines since `up`
#   scripts/gpu-lab.sh stop          # stop what desk/run started (server stays up)
#   scripts/gpu-lab.sh status
#   scripts/gpu-lab.sh down          # stop everything, the server too (no sudo)
#
# The screen is virtual (no monitor port is driven): the desktop's own X
# server already holds the idle GPU as a spare and watches its ports, and a
# fake monitor appearing there would disturb it. Size: AIO_GPU_LAB_SIZE.
# Everything lives in AIO_GPU_LAB (default untracked/gpu-lab, gitignored);
# `down` removes the run state and keeps only the config and the logs.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
LAB="${AIO_GPU_LAB:-$REPO/untracked/gpu-lab}"
NUM="${AIO_GPU_LAB_DISPLAY:-91}"
SIZE="${AIO_GPU_LAB_SIZE:-2560x1440}"
DPY=":$NUM"
SOCK="/tmp/.X11-unix/X$NUM"
AUTH="$LAB/Xauthority"
HOMEDIR="$LAB/home"

die() { echo "gpu-lab: $*" >&2; exit 1; }
is_up() { [ -e "$SOCK" ]; }

# The NVIDIA GPU that drives no display, as Xorg's decimal BusID.
idle_bus() {
  ids=$(nvidia-smi --query-gpu=pci.bus_id,display_active --format=csv,noheader 2>/dev/null |
    awk -F', ' '$2=="Disabled"{print $1}')
  [ -n "$ids" ] || die "no NVIDIA GPU without an active display — the lab needs a spare one"
  [ "$(echo "$ids" | wc -l)" -eq 1 ] || echo "gpu-lab: several idle GPUs, using the first" >&2
  # 00000000:02:00.0 (hex) → PCI:2:0:0 (decimal)
  set -- $(echo "$ids" | head -1 | tr ':.' '  ')
  printf 'PCI:%d:%d:%d\n' "0x$2" "0x$3" "0x$4"
}

labenv() {
  export DISPLAY="$DPY" XAUTHORITY="$AUTH" HOME="$HOMEDIR"
  export XDG_CONFIG_HOME="$HOMEDIR/.config" XDG_CACHE_HOME="$HOMEDIR/.cache"
  export XDG_DATA_HOME="$HOMEDIR/.local/share" XDG_RUNTIME_DIR="$LAB/run"
  unset WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS
}

remember() { echo "$1" >> "$LAB/run/pids"; }

case "${1:-}" in
  prep)
    [ "$(id -u)" -ne 0 ] || die "prep runs as you, not root"
    bus=$(idle_bus)
    w=${SIZE%x*} h=${SIZE#*x}
    mkdir -p "$LAB/confdir" "$LAB/logs" "$LAB/shots" "$HOMEDIR/.config/dconf" "$HOMEDIR/.local/share/aio"
    chmod 700 "$LAB"
    cat > "$LAB/xorg.conf" <<EOF
# Written by scripts/gpu-lab.sh prep — the lab X server on $bus.
Section "ServerFlags"
  # No keyboard or mouse: the lab must never take input from the desktop.
  Option "AutoAddDevices" "false"
  Option "AutoEnableDevices" "false"
  # Only the GPU named below: never the desktop's GPUs.
  Option "AutoAddGPU" "false"
  Option "AutoBindGPU" "false"
  Option "DontVTSwitch" "true"
  Option "BlankTime" "0"
EndSection
Section "Device"
  Identifier "lab"
  Driver "nvidia"
  BusID "$bus"
  Option "ProbeAllGpus" "false"
  Option "UseDisplayDevice" "None"
  Option "AllowEmptyInitialConfiguration" "true"
EndSection
Section "Screen"
  Identifier "lab"
  Device "lab"
  DefaultDepth 24
  SubSection "Display"
    Virtual $w $h
  EndSubSection
EndSection
Section "ServerLayout"
  Identifier "lab"
  Screen "lab"
EndSection
EOF
    rm -f "$AUTH"; touch "$AUTH"; chmod 600 "$AUTH"
    xauth -q -f "$AUTH" add "$DPY" . "$(mcookie)"
    # The desktop's settings (Cinnamon/muffin behave as on the desktop), as a
    # COPY: nothing the lab changes reaches the real ones.
    [ -f "$HOME/.config/dconf/user" ] && cp "$HOME/.config/dconf/user" "$HOMEDIR/.config/dconf/user"
    # The shared Electron runtimes, read in place (no second download).
    [ -d "$HOME/.local/share/aio/electron" ] && ln -sfn "$HOME/.local/share/aio/electron" "$HOMEDIR/.local/share/aio/electron"
    echo "prepared $LAB for $bus ($SIZE) — next: sudo $0 up"
    ;;
  up)
    [ "$(id -u)" -eq 0 ] || die "up starts Xorg and needs root: sudo $0 up"
    [ -n "${SUDO_USER:-}" ] || die "run it through sudo from your own account"
    [ -f "$LAB/xorg.conf" ] || die "no lab yet — run: $0 prep (as you)"
    # Root reads only files the invoking user owns and nobody else can write.
    for f in "$LAB" "$LAB/xorg.conf" "$AUTH"; do
      [ "$(stat -c %U "$f")" = "$SUDO_USER" ] || die "$f is not owned by $SUDO_USER"
      [ -z "$(find "$f" -maxdepth 0 -perm /022)" ] || die "$f is writable by others"
    done
    is_up && die "$DPY is already up"
    rm -rf "$LAB/run"
    install -d -m 700 -o "$SUDO_USER" "$LAB/run"
    date +%s > "$LAB/run/up.ts"; chown "$SUDO_USER" "$LAB/run/up.ts"
    # -terminate: the server exits when its last client leaves, so `down`
    # (as the user, no sudo) ends it by stopping the clients.
    setsid /usr/lib/xorg/Xorg "$DPY" -config "$LAB/xorg.conf" -configdir "$LAB/confdir" \
      -sharevts -novtswitch -nolisten tcp -auth "$AUTH" -terminate \
      -logfile "$LAB/logs/Xorg.$NUM.log" </dev/null >/dev/null 2>&1 &
    i=0; while ! is_up && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
    is_up || die "Xorg did not come up — see $LAB/logs/Xorg.$NUM.log"
    chown "$SUDO_USER" "$LAB/logs/Xorg.$NUM.log"
    # The client that holds the server open until `down`.
    runuser -u "$SUDO_USER" -- env DISPLAY="$DPY" XAUTHORITY="$AUTH" \
      setsid xprop -root -spy </dev/null >/dev/null 2>&1 &
    echo $! > "$LAB/run/pids"; chown "$SUDO_USER" "$LAB/run/pids"
    echo "up: $DPY on the idle GPU — next: $0 desk (as you)"
    ;;
  desk)
    [ "$(id -u)" -ne 0 ] || die "desk runs as you, not root"
    is_up || die "$DPY is down — sudo $0 up"
    labenv
    wm="${2:-cinnamon}"
    case "$wm" in cinnamon) cmd="cinnamon --replace" ;; muffin) cmd="muffin --replace" ;; *) die "desk: cinnamon|muffin" ;; esac
    setsid dbus-run-session -- $cmd </dev/null >"$LAB/logs/$wm.log" 2>&1 &
    remember $!
    echo "$wm started on $DPY (log: $LAB/logs/$wm.log)"
    ;;
  run)
    [ "$(id -u)" -ne 0 ] || die "run as you, not root"
    is_up || die "$DPY is down — sudo $0 up"
    shift; [ $# -gt 0 ] || die "run: give a command"
    labenv
    setsid "$@" </dev/null >>"$LAB/logs/run.log" 2>&1 &
    remember $!
    echo "started pid $! on $DPY (log: $LAB/logs/run.log)"
    ;;
  shot)
    is_up || die "$DPY is down"
    f="$LAB/shots/$(date +%H%M%S).xwd"
    XAUTHORITY="$AUTH" xwd -root -silent -display "$DPY" > "$f"
    if command -v convert >/dev/null 2>&1; then convert "$f" "${f%.xwd}.png" && rm -f "$f" && f="${f%.xwd}.png"; fi
    echo "$f"
    ;;
  xids)
    since=$(cat "$LAB/run/up.ts" 2>/dev/null || echo 0)
    journalctl -k --since "@$since" --no-pager 2>/dev/null | grep -E "Xid|segfault" || echo "no Xid since up"
    ;;
  status)
    if is_up; then echo "up: $DPY"; else echo "down: $DPY"; fi
    [ -f "$LAB/run/pids" ] && while read -r p; do
      kill -0 "$p" 2>/dev/null && echo "  pid $p: $(tr '\0' ' ' < /proc/$p/cmdline | cut -c1-80)"
    done < "$LAB/run/pids"
    true
    ;;
  stop)
    # Everything `desk`/`run` started; the server (and its holder, the first
    # pid) stays up for the next experiment.
    [ -f "$LAB/run/pids" ] || die "nothing started"
    keep=$(head -1 "$LAB/run/pids")
    tail -n +2 "$LAB/run/pids" | while read -r p; do kill -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null || true; done
    echo "$keep" > "$LAB/run/pids"
    echo "stopped the lab's programs; $DPY stays up"
    ;;
  down)
    [ "$(id -u)" -ne 0 ] || die "down runs as you (the server ends with its last client)"
    if [ -f "$LAB/run/pids" ]; then
      while read -r p; do kill -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null || true; done < "$LAB/run/pids"
    fi
    # Any other client still on the lab display.
    for p in $(pgrep -u "$(id -u)" -f . 2>/dev/null); do
      grep -qz "^DISPLAY=$DPY\$" "/proc/$p/environ" 2>/dev/null && kill "$p" 2>/dev/null || true
    done
    i=0; while is_up && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
    if is_up; then echo "gpu-lab: $DPY still up — a client is holding it (xlsclients -display $DPY)" >&2; exit 1; fi
    rm -rf "$LAB/run"
    echo "down: $DPY stopped; config and logs kept in $LAB"
    ;;
  *)
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
