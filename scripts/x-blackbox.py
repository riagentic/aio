#!/usr/bin/env python3
"""Black box for an X crash: logs every window create/map/configure/unmap on
the display (top-level frames AND the client windows inside them) with its
geometry, override-redirect flag, class, pid, frame extents and state. One
line per event, fsync'd, so the last lines before Xorg died are on disk.
Read-only: it only listens (no window, no drawing). Usage: x-blackbox.py OUT
Used by scripts/x-blackbox.sh (a manual crash recording) and the GPU-lab
lane (tests/gpu-lab-window-bounds.test.ts)."""
import os, sys, time
from Xlib import X, display, error

out = open(sys.argv[1], "a", buffering=1)
d = display.Display()
root = d.screen().root
A = {n: d.intern_atom(n) for n in ("WM_CLASS", "_NET_WM_PID", "_NET_FRAME_EXTENTS",
     "_GTK_FRAME_EXTENTS", "_NET_WM_STATE", "_NET_WM_WINDOW_TYPE", "_NET_WM_BYPASS_COMPOSITOR")}
NAMES = {}
for k in ("_NET_WM_STATE_MAXIMIZED_HORZ", "_NET_WM_STATE_MAXIMIZED_VERT", "_NET_WM_STATE_FULLSCREEN",
          "_NET_WM_STATE_HIDDEN", "_NET_WM_STATE_ABOVE", "_NET_WM_WINDOW_TYPE_NORMAL",
          "_NET_WM_WINDOW_TYPE_SPLASH", "_NET_WM_WINDOW_TYPE_TOOLTIP", "_NET_WM_WINDOW_TYPE_POPUP_MENU",
          "_NET_WM_WINDOW_TYPE_DROPDOWN_MENU", "_NET_WM_WINDOW_TYPE_DIALOG", "_NET_WM_WINDOW_TYPE_DND"):
    NAMES[d.intern_atom(k)] = k.replace("_NET_WM_STATE_", "").replace("_NET_WM_WINDOW_TYPE_", "type:")
MASK = X.SubstructureNotifyMask | X.StructureNotifyMask | X.PropertyChangeMask

def log(s):
    out.write(f"{time.time():.3f} {s}\n"); os.fsync(out.fileno())

def prop(w, name):
    try:
        p = w.get_full_property(A[name], X.AnyPropertyType)
        return None if p is None else p.value
    except error.XError:
        return None

def info(w):
    parts = []
    c = prop(w, "WM_CLASS")
    if c is not None: parts.append("class=" + (c.decode(errors="replace") if isinstance(c, bytes) else str(c)).replace("\0", "/").strip("/"))
    for n in ("_NET_WM_PID", "_NET_FRAME_EXTENTS", "_GTK_FRAME_EXTENTS", "_NET_WM_BYPASS_COMPOSITOR"):
        v = prop(w, n)
        if v is not None: parts.append(f"{n.strip('_').lower()}={list(v)}")
    for n in ("_NET_WM_STATE", "_NET_WM_WINDOW_TYPE"):
        v = prop(w, n)
        if v is not None: parts.append(f"{n.strip('_').lower()}=" + ",".join(NAMES.get(a, str(a)) for a in v))
    return " ".join(parts)

def watch(w, depth=0):
    try:
        w.change_attributes(event_mask=MASK)
        g = w.get_geometry(); a = w.get_attributes()
        log(f"have 0x{w.id:x} d{depth} {g.x},{g.y} {g.width}x{g.height} or={a.override_redirect} mapped={a.map_state} {info(w)}")
        if depth < 2:
            for c in w.query_tree().children: watch(c, depth + 1)
    except error.XError:
        pass

root.change_attributes(event_mask=X.SubstructureNotifyMask)
log(f"start screen {d.screen().width_in_pixels}x{d.screen().height_in_pixels}")
for c in root.query_tree().children: watch(c, 1)
d.flush()
while True:
    e = d.next_event()
    t = e.type
    try:
        if t == X.CreateNotify:
            log(f"create 0x{e.window.id:x} parent=0x{e.parent.id:x} {e.x},{e.y} {e.width}x{e.height} or={e.override}")
            watch(e.window, 1 if e.parent.id == root.id else 2)
        elif t == X.ConfigureNotify:
            log(f"config 0x{e.window.id:x} {e.x},{e.y} {e.width}x{e.height} bw={e.border_width} or={e.override}")
        elif t == X.MapNotify:
            log(f"map 0x{e.window.id:x} or={e.override} {info(e.window)}")
        elif t == X.UnmapNotify:
            log(f"unmap 0x{e.window.id:x}")
        elif t == X.ReparentNotify:
            log(f"reparent 0x{e.window.id:x} -> 0x{e.parent.id:x} at {e.x},{e.y}")
            watch(e.window, 2)
        elif t == X.DestroyNotify:
            log(f"destroy 0x{e.window.id:x}")
        elif t == X.PropertyNotify and e.atom in (A["_NET_WM_STATE"], A["_NET_FRAME_EXTENTS"], A["_GTK_FRAME_EXTENTS"], A["_NET_WM_BYPASS_COMPOSITOR"]):
            log(f"prop 0x{e.window.id:x} {d.get_atom_name(e.atom)} {info(e.window)}")
    except error.XError:
        pass
