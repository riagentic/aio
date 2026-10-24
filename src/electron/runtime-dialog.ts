/**
 * @module
 * The window a shared-runtime app shows BEFORE it has a window: "Getting
 * <title> ready" with a progress bar and a Cancel while its Electron
 * downloads, and a Retry / Quit question when that fails — both in the
 * app's identity colours (light or dark, as the OS is). Electron cannot draw it — Electron
 * is the thing being downloaded — so each OS draws it with what it always
 * has:
 *
 *   Windows  PowerShell + Windows Forms (in every Windows since 7)
 *   macOS    osascript, JavaScript for Automation with the Cocoa bridge
 *   Linux    zenity, else yad; with neither, a page in the default browser
 *            (the splash: GTK 3 over FFI, gtk-splash.ts, before those)
 *
 * With no display at all (a service, an ssh session) there is nothing to
 * draw on: the log carries the progress and a failure ends the start.
 *
 * Every helper is a separate process, fed through a small PROGRESS FILE it
 * polls (`<pct>\t<text>`, or `close`) — one protocol for Windows and macOS,
 * and the only one a windowless Windows child can use (it has no pipes). The
 * helper exiting before it was told to close means the user closed it: the
 * start is cancelled. Each helper also watches the app's process id and
 * closes itself when the app is gone, so an app that died never leaves a
 * "Getting <title> ready" window behind — and a machine that slept is not
 * a death (the app's pid is still there when it wakes).
 *
 * All text reaches the helpers as environment variables or argv, never
 * spliced into script source, so a title with quotes in it is just a title.
 */
import { join } from "@std/path";
import { isProcessAlive } from "../server/single-instance-lock.ts";
import { neutralCwd, startWindowless } from "../server/no-console.ts";
import { mayOpenExternal, openExternal } from "../server/open-external.ts";
import {
  BAR_PT,
  helperLook,
  lookOf,
  type SplashColors,
  splashHasText,
  splashNotDrawn,
  type SplashSpec,
} from "./splash.ts";
import {
  type Bounds,
  centredOn,
  EDGE_MARGIN,
  windowRect,
} from "./splash-place.ts";
import type { WindowAt } from "./electron-renderer-log.ts";
import { gtkAsk, gtkProgress, gtkSplash } from "./gtk-splash.ts";

// ── where every window opens ───────────────────────────────────────────────

/** splash-place.ts in PowerShell, line for line: `windowRect` (where the
 *  app's window opens, on which screen) and `centredOn` (a W×H window
 *  centred on it, kept inside that screen). `$T`: `[x|null, y|null, width,
 *  height]`, or `$null` for `$p`'s centre. `$all` / `$p`: the screens' and
 *  the primary's work areas (`AioAll`, `AioPrimary`). Returns `@(x, y)`.
 *  JavaScript's Math.round is `Floor(v + 0.5)` here (.NET rounds to even).
 *  Pinned against the TS rule by tests/window-place.test.ts. */
export const PS_PLACE = `
function AioAll { @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $_.WorkingArea }) }
function AioPrimary { [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea }
function AioFit($v, $lo, $n, $span) { if ($n -ge $span) { $lo } else { [Math]::Max($lo, [Math]::Min($v, $lo + $span - $n)) } }
function AioM($n) { [Math]::Min(${EDGE_MARGIN}, [Math]::Floor($n / 8)) }
function AioPlace($T, $W, $H, $all, $p, $real = $false) {
  if (@($all).Count -eq 0) { $all = @($p) }
  if ($null -eq $T) { $s = $p; $rx = $p.X; $ry = $p.Y; $rw = $p.Width; $rh = $p.Height }
  else {
    $rw = [int]$T[2]; $rh = [int]$T[3]
    $placed = -not ($null -eq $T[0] -or $null -eq $T[1])
    if (-not $placed) { $s = $p } else {
      $x = [int]$T[0]; $y = [int]$T[1]; $s = $null
      foreach ($k in $all) { if ($x -ge $k.X -and $y -ge $k.Y -and $x + $rw -le $k.X + $k.Width -and $y + $rh -le $k.Y + $k.Height) { $s = $k; break } }
      if ($null -eq $s) {
        $best = -1
        foreach ($k in $all) {
          $ix = [Math]::Max(0, [Math]::Min($x + $rw, $k.X + $k.Width) - [Math]::Max($x, $k.X))
          $iy = [Math]::Max(0, [Math]::Min($y + $rh, $k.Y + $k.Height) - [Math]::Max($y, $k.Y))
          if ($ix * $iy -gt $best) { $best = $ix * $iy; $s = $k }
        }
      }
    }
    # Where the window REALLY is ($real): centred on it as it is, only its
    # screen chosen; else where it opens: EDGE_MARGIN inside that screen.
    if ($real -and $placed) { $rx = $x; $ry = $y } else {
      $mx = AioM $s.Width; $my = AioM $s.Height
      $iw = [Math]::Max(1, $s.Width - 2 * $mx); $ih = [Math]::Max(1, $s.Height - 2 * $my)
      $rw = [Math]::Min($rw, $iw); $rh = [Math]::Min($rh, $ih)
      if ($placed) {
        $rx = AioFit $x ($s.X + $mx) $rw $iw
        $ry = AioFit $y ($s.Y + $my) $rh $ih
      } else {
        $rx = $s.X + $mx + [Math]::Floor(($iw - $rw) / 2)
        $ry = $s.Y + $my + [Math]::Floor(($ih - $rh) / 2)
      }
    }
  }
  $mx = AioM $s.Width; $my = AioM $s.Height
  $cx = AioFit ([Math]::Floor($rx + $rw / 2 - $W / 2 + 0.5)) ($s.X + $mx) $W ($s.Width - 2 * $mx)
  $cy = AioFit ([Math]::Floor($ry + $rh / 2 - $H / 2 + 0.5)) ($s.Y + $my) $H ($s.Height - 2 * $my)
  return @([int]$cx, [int]$cy)
}
`;

/** splash-place.ts for the Cocoa helpers: `windowRect` and `centredOn` AS
 *  THEIR OWN SOURCE, and the screens in Electron's coordinates (origin at
 *  the primary's top-left; `NSScreen.screens[0]` is the primary, the one
 *  with the menu bar). `aioPlace(T, w, h, real)` — `T` as on Windows — is
 *  the Cocoa origin of a w×h frame centred where the app's window opens
 *  (`real`: where it really is, as `AioPlace -real`). */
export const MAC_PLACE_JS = `
const windowRect = ${windowRect.toString()};
const centredOn = ${centredOn.toString()};
function aioPlace(T, w, h, real) {
  const scr = $.NSScreen.screens;
  const PH = scr.objectAtIndex(0).frame.size.height;
  const areas = [];
  for (let i = 0; i < scr.count; i++) {
    const v = scr.objectAtIndex(i).visibleFrame;
    areas.push({ x: v.origin.x, y: PH - (v.origin.y + v.size.height), width: v.size.width, height: v.size.height });
  }
  const p = areas[0];
  const b = T && (T[0] === null ? { width: T[2], height: T[3] } : { x: T[0], y: T[1], width: T[2], height: T[3] });
  const r = b && windowRect(b, areas, p);
  // Where the window REALLY is (real): centred on it as it is, only its
  // screen chosen; else where it opens.
  const o = b ? centredOn(real && T[0] !== null ? { x: b.x, y: b.y, width: b.width, height: b.height, screen: r.screen } : r, w, h) : centredOn({ x: p.x, y: p.y, width: p.width, height: p.height, screen: p }, w, h);
  return $.NSMakePoint(o.x, PH - (o.y + h));
}
`;

/** Per-monitor DPI awareness for the Windows helpers, set before any
 *  window exists: their coordinates are then PHYSICAL screen pixels — the
 *  space the main process converts the app's window into
 *  (`screen.dipToScreenRect`, the window line's `screen`) and the space
 *  Windows Forms' `Screen` reports in. Without it Windows virtualises an
 *  unaware helper per monitor, and on mixed scales its rect and Electron's
 *  disagree. `AioScaleAt x y`: the effective scale (DPI / 96) of the monitor
 *  at that physical point — what a helper sizes its contents by, so it looks
 *  as large as before (crisp now, not bitmap-stretched). Windows 7/8 (no
 *  per-monitor API): system-aware, scale 1 apart from the system's. */
export const PS_DPI = `
Add-Type -WarningAction SilentlyContinue -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class AioDpi {
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(PT p, uint f);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr m, int t, out uint x, out uint y);
  public static double At(int x, int y) {
    try {
      PT p; p.X = x; p.Y = y;
      uint dx, dy;
      if (GetDpiForMonitor(MonitorFromPoint(p, 2), 0, out dx, out dy) == 0 && dx > 0) return dx / 96.0;
    } catch {}
    return 1.0;
  }
}
"@
$aioPm = $false
try { $aioPm = [AioDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}
if (-not $aioPm) { try { [void][AioDpi]::SetProcessDPIAware() } catch {} }
function AioScaleAt($x, $y) { if ($aioPm) { [AioDpi]::At([int]$x, [int]$y) } else { 1.0 } }
# The scale where a window centred on $T (PS_PLACE's [x|null,y|null,w,h])
# lands: its centre's monitor; no position, the primary's.
function AioScaleFor($T) {
  if ($T -and $null -ne $T[0]) { return AioScaleAt ($T[0] + $T[2] / 2) ($T[1] + $T[3] / 2) }
  $w = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  AioScaleAt ($w.X + $w.Width / 2) ($w.Y + $w.Height / 2)
}
`;

/** The app's look in PowerShell: `$bg $fg $barc $trk` from AIO_DLG_LIGHT /
 *  AIO_DLG_DARK (`"#bg #text #bar #track"`), as Windows' app mode is light
 *  or dark — or `$bg = $null` (the system's look) without them. */
export const PS_LOOK = `
$bg = $null
if ($env:AIO_DLG_LIGHT) {
  $dk = $false
  try {
    $dk = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' -Name AppsUseLightTheme).AppsUseLightTheme -eq 0
  } catch {}
  $cc = $(if ($dk) { $env:AIO_DLG_DARK } else { $env:AIO_DLG_LIGHT }).Split(' ')
  $bg = [System.Drawing.ColorTranslator]::FromHtml($cc[0])
  $fg = [System.Drawing.ColorTranslator]::FromHtml($cc[1])
  $barc = [System.Drawing.ColorTranslator]::FromHtml($cc[2])
  $trk = [System.Drawing.ColorTranslator]::FromHtml($cc[3])
}
function AioButton($b) {
  if ($bg) {
    $b.FlatStyle = 'Flat'
    $b.BackColor = $trk
    $b.ForeColor = $fg
    $b.FlatAppearance.BorderColor = $trk
  }
}
`;

/** The app's look for the Cocoa helpers: `aioLook(light, dark)` — each
 *  `"#bg #text #bar #track"`, "" for the system's look — as NSColors for the
 *  mode macOS is in, or null. */
export const MAC_LOOK_JS = `
function aioLook(light, dark) {
  if (!light) return null;
  const st = $.NSUserDefaults.standardUserDefaults.stringForKey('AppleInterfaceStyle');
  const isDark = !!st && !st.isNil() && st.js === 'Dark';
  const hex = (h) => $.NSColor.colorWithSRGBRedGreenBlueAlpha(
    parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255, 1);
  const c = (isDark ? dark : light).split(' ');
  return { bg: hex(c[0]), fg: hex(c[1]), bar: hex(c[2]), track: hex(c[3]), isDark };
}
function aioBox(x, y, w, h, col) {
  const b = $.NSBox.alloc.initWithFrame($.NSMakeRect(x, y, w, h));
  b.boxType = 4; // NSBoxCustom
  b.titlePosition = 0; // NSNoTitle
  b.borderWidth = 0;
  b.cornerRadius = h / 2;
  b.fillColor = col;
  return b;
}
`;

/** `"#bg #text #bar #track"` — one mode as a helper reads it. Pure. */
export const lookArg = (c: SplashColors | undefined) =>
  c ? `${c.background} ${c.text} ${c.bar} ${c.track}` : "";

/** The app's identity colours, light and dark (the splash's own). */
export type DialogColors = { light: SplashColors; dark: SplashColors };

/** The `[x|null, y|null, width, height]` a helper places by: where the
 *  app's window opens (`windowRect`'s input). Pure. */
export function placeArg(t: Bounds | null | undefined): string {
  return t ? JSON.stringify([t.x ?? null, t.y ?? null, t.width, t.height]) : "";
}

/** A progress window that is showing. */
export interface ProgressDialog {
  /** `fraction` 0..1, or null while the size is unknown (an animated bar). */
  update(fraction: number | null, detail: string): void;
  /** Resolves when the user closed the window (the start is cancelled). */
  readonly cancelled: Promise<void>;
  /** Resolves, with why, when the window could not be shown at all (no
   *  interactive desktop, PowerShell blocked, a crash) — NOT a cancel: the
   *  start goes on without a window. */
  readonly lost: Promise<string>;
  /** Take the window down. */
  close(): Promise<void>;
  /** Resolves once the window is on screen, where the helper says so. */
  readonly shown?: Promise<void>;
  /** Re-centre on where the app's window really is (the splash's
   *  `followWindow`). Absent: this helper cannot move (yad, zenity). */
  move?(at: WindowAt): void;
}

/** What the failure question answered. `"previous"`: the third button,
 *  shown only when `ask` was given its label. */
export type RetryAnswer = "retry" | "quit" | "previous";

/** How dialogs are drawn on this machine — or `null` for none. */
export interface DialogBackend {
  readonly name: string;
  progress(title: string, heading: string): Promise<ProgressDialog>;
  /** Retry / Quit — and, given `previous` (its label), a third button. */
  ask(title: string, message: string, previous?: string): Promise<RetryAnswer>;
}

/** The Windows question's answer (what WINDOWS_ASK_PS wrote). Pure. */
export function windowsAnswer(r: string): RetryAnswer {
  const a = r.trim();
  return a === "retry" ? "retry" : a === "previous" ? "previous" : "quit";
}

/** zenity / yad's question: Retry, Quit, and the third button when given.
 *  Pure. */
export function zenityAskArgs(
  bin: "zenity" | "yad",
  title: string,
  message: string,
  previous?: string,
): string[] {
  return bin === "zenity"
    ? [
      "--question",
      `--title=${title}`,
      `--text=${pangoText(message)}`,
      "--ok-label=Retry",
      "--cancel-label=Quit",
      ...(previous ? [`--extra-button=${previous}`] : []),
      "--width=460",
    ]
    : [
      `--title=${title}`,
      `--text=${pangoText(message)}`,
      "--button=Quit:1",
      ...(previous ? [`--button=${previous}:2`] : []),
      "--button=Retry:0",
      "--width=460",
    ];
}

/** What zenity / yad answered: zenity prints an extra button's label and
 *  exits 1; yad exits with the button's code. Pure. */
export function zenityAnswer(
  bin: "zenity" | "yad",
  code: number,
  stdout: string,
  previous?: string,
): RetryAnswer {
  if (code === 0) return "retry";
  if (!previous) return "quit";
  const third = bin === "zenity" ? stdout.trim() === previous : code === 2;
  return third ? "previous" : "quit";
}

/** The line a progress file holds. Pure. */
export function progressLine(fraction: number | null, detail: string): string {
  const pct = fraction === null || !Number.isFinite(fraction)
    ? -1
    : Math.max(0, Math.min(100, Math.floor(fraction * 100)));
  return `${pct}\t${detail.replace(/[\r\n\t]+/g, " ")}`;
}

/** "Downloading Electron 44.9.3 — first start only · 45 / 110 MB": what
 *  comes down, that later starts skip it, and how far it is. Pure. */
export function downloadDetail(
  version: string,
  got: number,
  total: number,
): string {
  const mb = (n: number) => (n / 1e6).toFixed(0);
  return total > 0
    ? `Downloading Electron ${version} — first start only · ${mb(got)} / ${
      mb(total)
    } MB`
    : `Downloading Electron ${version} — first start only · ${mb(got)} MB`;
}

// ── shared plumbing ────────────────────────────────────────────────────────

async function tempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "aio-dialog-" });
}

/** A dialog process watched by pid (Windows) or by its own status. It
 *  writes `ack` once its window is on screen: gone AFTER that is the user
 *  closing it (a cancel); gone BEFORE is a window that never showed.
 *  Exported for tests. @internal */
export { fileProgress as _fileProgress };
function fileProgress(
  file: string,
  dir: string,
  ack: string,
  alive: () => boolean,
  stop: () => void,
  exited?: Promise<unknown>,
  /** The splash's MOVE file: `[x,y,w,h]` of the app's window, read by the
   *  helper each tick (`move`). Absent: the helper cannot move. */
  moveFile?: { path: string; physical: boolean },
): ProgressDialog {
  let closing = false;
  let resolveCancel!: () => void;
  let resolveLost!: (why: string) => void;
  const cancelled = new Promise<void>((r) => (resolveCancel = r));
  const lost = new Promise<string>((r) => (resolveLost = r));
  let settled = false;
  const gone = () => {
    if (closing || settled) return;
    settled = true;
    clearInterval(watch);
    clearInterval(ackPoll);
    let shown = false;
    try {
      shown = Deno.statSync(ack).isFile;
    } catch {
      shown = false; // aio-ok: no ack — the window never came up
    }
    if (shown) resolveCancel();
    else resolveLost("the dialog helper exited before its window showed");
  };
  const watch = setInterval(() => {
    if (!alive()) gone();
  }, 250);
  exited?.then(gone);
  // The helper writes the ack once its window is on screen: polled finely,
  // so the time it took is known (the splash's minMs counts from it).
  let resolveShown!: () => void;
  const shown = new Promise<void>((r) => (resolveShown = r));
  const ackPoll = setInterval(() => {
    let there = false;
    try {
      there = Deno.statSync(ack).isFile;
    } catch {
      there = false; // aio-ok: not yet
    }
    if (there) resolveShown();
    if (there) clearInterval(ackPoll);
  }, 25);
  return {
    shown,
    ...(moveFile
      ? {
        move(at: WindowAt) {
          try {
            Deno.writeTextFileSync(
              moveFile.path,
              moveArg(at, moveFile.physical),
            );
          } catch {
            // aio-ok: a skipped move — the window's next one writes again
          }
        },
      }
      : {}),
    update(fraction, detail) {
      try {
        Deno.writeTextFileSync(file, progressLine(fraction, detail));
      } catch {
        // aio-ok: a skipped frame — the next update writes again
      }
    },
    cancelled,
    lost,
    async close() {
      closing = true;
      clearInterval(watch);
      clearInterval(ackPoll);
      try {
        Deno.writeTextFileSync(file, "close");
      } catch {
        // aio-ok: the stop below takes it down either way
      }
      for (let i = 0; i < 20 && alive(); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (alive()) stop();
      await Deno.remove(dir, { recursive: true }).catch(() => {
        // aio-ok: a leftover temp folder is all this costs; never the real outcome
      });
    },
  };
}

async function waitWhile(alive: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (alive() && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ── Windows ────────────────────────────────────────────────────────────────

/** The progress form. Reads AIO_DLG_* from its environment. */
export const WINDOWS_PROGRESS_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${PS_DPI}
[System.Windows.Forms.Application]::EnableVisualStyles()
${PS_LOOK}
$f = New-Object System.Windows.Forms.Form
$f.Text = $env:AIO_DLG_TITLE
$f.ClientSize = New-Object System.Drawing.Size(460, 138)
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.ShowInTaskbar = $true
if ($bg) { $f.BackColor = $bg; $f.ForeColor = $fg }
if ($env:AIO_DLG_ICON) {
  try { $f.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:AIO_DLG_ICON) } catch {}
}
$h = New-Object System.Windows.Forms.Label
$h.Text = $env:AIO_DLG_HEADING
$h.Location = New-Object System.Drawing.Point(18, 14)
$h.AutoSize = $true
$h.Font = New-Object System.Drawing.Font($h.Font.FontFamily, 10, [System.Drawing.FontStyle]::Bold)
$d = New-Object System.Windows.Forms.Label
$d.Location = New-Object System.Drawing.Point(18, 42)
$d.Size = New-Object System.Drawing.Size(424, 20)
# The bar: a track and its fill (Windows Forms' own bar takes no colours).
$tr = New-Object System.Windows.Forms.Panel
$tr.Location = New-Object System.Drawing.Point(18, 74)
$tr.Size = New-Object System.Drawing.Size(424, 6)
$tr.BackColor = $(if ($bg) { $trk } else { [System.Drawing.SystemColors]::ControlLight })
$fl = New-Object System.Windows.Forms.Panel
$fl.Size = New-Object System.Drawing.Size(127, 6)
$fl.BackColor = $(if ($bg) { $barc } else { [System.Drawing.SystemColors]::Highlight })
$tr.Controls.Add($fl)
# Cancel, the one button: it ends the download, as the window's close does.
$c = New-Object System.Windows.Forms.Button
$c.Text = 'Cancel'
$c.Location = New-Object System.Drawing.Point(354, 96)
$c.Size = New-Object System.Drawing.Size(88, 26)
AioButton $c
$c.Add_Click({ $f.Close() })
$f.CancelButton = $c
# electron.downloadWindow.cancel false: no button (the close still cancels).
$c.Visible = $env:AIO_DLG_CANCEL -ne '0'
$f.Controls.AddRange(@($h, $d, $tr, $c))
# Centred where the app's window opens (splash-place.ts: PS_PLACE), at that
# monitor's scale.
${PS_PLACE}
$T = $null
if ($env:AIO_DLG_TARGET) { $T = $env:AIO_DLG_TARGET | ConvertFrom-Json }
$K = AioScaleFor $T
if ($K -ne 1) { $f.Scale((New-Object System.Drawing.SizeF([single]$K, [single]$K))) }
$TW = $tr.Width
$o = AioPlace $T $f.Width $f.Height (AioAll) (AioPrimary)
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point($o[0], $o[1])
$script:pulse = $true
$t = New-Object System.Windows.Forms.Timer
$t.Interval = 50
$script:n = 0
$t.Add_Tick({
  $script:n++
  # Unknown size: a segment runs along the track.
  if ($script:pulse) { $fl.Left = (($script:n * 12 * $K) % ($TW + $fl.Width)) - $fl.Width }
  if ($script:n % 4 -ne 0) { return }
  # The app that opened this window is gone: nobody will close it.
  if ($script:n % 40 -eq 0 -and -not (Get-Process -Id ([int]$env:AIO_DLG_PARENT) -ErrorAction SilentlyContinue)) {
    $t.Stop(); $f.Tag = 'done'; $f.Close(); return
  }
  $s = $null
  try { $s = [IO.File]::ReadAllText($env:AIO_DLG_FILE) } catch { return }
  if ($s -eq 'close') { $t.Stop(); $f.Tag = 'done'; $f.Close(); return }
  $p = $s.Split([char]9, 2)
  if ($p.Length -lt 2) { return }
  $k = 0
  if ([int]::TryParse($p[0], [ref]$k) -and $k -ge 0) {
    $script:pulse = $false
    $fl.Left = 0
    $fl.Width = [int]($TW * [Math]::Min(100, $k) / 100)
  } elseif (-not $script:pulse) { $script:pulse = $true; $fl.Width = [int]($TW * 0.3) }
  $d.Text = $p[1]
})
$t.Start()
$f.Add_Shown({
  $f.Activate()
  try { [IO.File]::WriteAllText($env:AIO_DLG_ACK, 'shown') } catch {}
})
[void]$f.ShowDialog()
if ($f.Tag -eq 'done') { exit 0 } else { exit 3 }
`;

/** The Retry / Quit question: the message and its buttons (Quit, the
 *  third answer when AIO_DLG_PREVIOUS names it, Retry), centred where the
 *  app's window opens (AIO_DLG_TARGET, PS_PLACE). Writes `retry`,
 *  `previous` or `quit` (also for its close button) to AIO_DLG_FILE. */
export const WINDOWS_ASK_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${PS_DPI}
[System.Windows.Forms.Application]::EnableVisualStyles()
${PS_PLACE}
${PS_LOOK}
$f = New-Object System.Windows.Forms.Form
$f.Text = $env:AIO_DLG_TITLE
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.ShowInTaskbar = $true
if ($bg) { $f.BackColor = $bg; $f.ForeColor = $fg }
$m = New-Object System.Windows.Forms.Label
$m.Text = $env:AIO_DLG_TEXT
$m.Location = New-Object System.Drawing.Point(18, 18)
$m.MaximumSize = New-Object System.Drawing.Size(424, 0)
$m.AutoSize = $true
$f.Controls.Add($m)
$by = $m.Location.Y + $m.PreferredSize.Height + 18
$names = @(,@('Quit', 'quit'))
if ($env:AIO_DLG_PREVIOUS) { $names += ,@($env:AIO_DLG_PREVIOUS, 'previous') }
$names += ,@('Retry', 'retry')
$x = 442
for ($i = $names.Count - 1; $i -ge 0; $i--) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $names[$i][0]
  $b.Tag = $names[$i][1]
  $b.AutoSize = $true
  $b.MinimumSize = New-Object System.Drawing.Size(88, 26)
  $w = [Math]::Max(88, $b.PreferredSize.Width)
  $x -= $w
  $b.Location = New-Object System.Drawing.Point($x, $by)
  $x -= 8
  AioButton $b
  $b.Add_Click({ $f.Tag = $this.Tag; $f.Close() })
  $f.Controls.Add($b)
  if ($b.Tag -eq 'retry') { $f.AcceptButton = $b }
  if ($b.Tag -eq 'quit') { $f.CancelButton = $b }
}
$f.ClientSize = New-Object System.Drawing.Size(460, ($by + 26 + 18))
$T = $null
if ($env:AIO_DLG_TARGET) { $T = $env:AIO_DLG_TARGET | ConvertFrom-Json }
# At the scale of the monitor it opens on.
$K = AioScaleFor $T
if ($K -ne 1) { $f.Scale((New-Object System.Drawing.SizeF([single]$K, [single]$K))) }
$o = AioPlace $T $f.Width $f.Height (AioAll) (AioPrimary)
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point($o[0], $o[1])
$f.Add_Shown({ $f.Activate() })
[void]$f.ShowDialog()
$a = $(if ($f.Tag) { [string]$f.Tag } else { 'quit' })
[IO.File]::WriteAllText($env:AIO_DLG_FILE, $a)
`;

/** The splash (`build.splash`): borderless, the image IS the window (its
 *  size, or `size` with the image fitted), placed where the app's window
 *  will open (`position`), on top, no taskbar entry; the text and a small
 *  bar over its lower part (or in a strip below the image). Reads AIO_SPL_*
 *  (AIO_SPL_LOOK: `helperLook`, JSON) and the progress file: a percent of
 *  0..100 shows the bar (and a ✕ that cancels the download), below 0 hides
 *  it; `close` fades it out. The ack says what was drawn. */
export const WINDOWS_SPLASH_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${PS_DPI}
$L = $env:AIO_SPL_LOOK | ConvertFrom-Json
# Every logical size at the scale of the monitor it opens on (the pointer's
# for position "pointer").
$K = $(if ($L.mode -eq 'window') { AioScaleFor $L.target } elseif ($L.mode -eq 'pointer') { $q = [System.Windows.Forms.Cursor]::Position; AioScaleAt $q.X $q.Y } else { AioScaleFor $null })
$dark = $false
try {
  $dark = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' -Name AppsUseLightTheme).AppsUseLightTheme -eq 0
} catch {}
$c = $(if ($dark) { $env:AIO_SPL_DARK } else { $env:AIO_SPL_LIGHT }).Split(' ')
$fg = [System.Drawing.ColorTranslator]::FromHtml($c[1])
$bg = [System.Drawing.ColorTranslator]::FromHtml($c[0])
$clear = [System.Drawing.Color]::Transparent
$img = [System.Drawing.Image]::FromFile($env:AIO_SPL_IMAGE)
$sc = [int]$env:AIO_SPL_SCALE
$FW = [int]($img.Width / $sc * $K)
$FH = [int]($img.Height / $sc * $K)
if ($L.sized) { $FW = [int]($L.w * $K); $FH = [int]($L.h * $K) }
function RoundPath($x, $y, $w, $h, $r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [Math]::Min([Math]::Min($w, $h), 2 * $r)
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}
# Above every normal window (the app's, shown under it) and never activated:
# the focus stays where it is and goes to the app's window when it shows.
Add-Type -WarningAction SilentlyContinue -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
public class AioSplashForm : System.Windows.Forms.Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override System.Windows.Forms.CreateParams CreateParams {
    get { var p = base.CreateParams; p.ExStyle |= 0x08000008; return p; }
  }
}
"@
$f = New-Object AioSplashForm
$f.Text = $env:AIO_SPL_TITLE
$f.FormBorderStyle = 'None'
$f.StartPosition = 'Manual'
$f.ShowInTaskbar = $false
$f.TopMost = $true
$f.BackColor = $bg
$bp = 0
if ([single]$env:AIO_SPL_BAR -gt 0) {
  if ($L.barHeight) { $bp = [int]($L.barHeight * $K) } else {
    $bp = [int][Math]::Max(2, [Math]::Round([single]$env:AIO_SPL_BAR * 96 * $K / 72))
  }
}
$side = [int]($L.side * $K)
$bottom = [int]($L.bottom * $K)
$rad = [int]($L.radius * $K)
$d = $null
$dh = 0
if ($env:AIO_SPL_HASTEXT -eq '1') {
  $fam = $(if ($env:AIO_SPL_FONT) { $env:AIO_SPL_FONT } else { [System.Drawing.SystemFonts]::MessageBoxFont.FontFamily.Name })
  $st = $(if ($env:AIO_SPL_BOLD -eq '1') { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular })
  $d = New-Object System.Windows.Forms.Label
  # Points at the monitor's scale, in pixels: the process's own DPI is not
  # the monitor's on a mixed-scale desktop.
  $d.Font = New-Object System.Drawing.Font($fam, [single]([single]$env:AIO_SPL_SIZE * 96 / 72 * $K), $st, [System.Drawing.GraphicsUnit]::Pixel)
  $d.ForeColor = $fg
  $d.BackColor = $clear
  $d.Text = $env:AIO_SPL_TEXT
  $d.TextAlign = $(if ($L.align -eq 'center') { 'TopCenter' } elseif ($L.align -eq 'right') { 'TopRight' } else { 'TopLeft' })
  $dh = $d.Font.Height + 4
}
# Below the image: a strip as tall as what it holds.
$TH = $FH
if ($L.below -and $d) {
  $TH = $FH + 8 + $dh + $bottom + $(if ($bp -gt 0 -and -not $L.barEdge) { 8 + $bp } else { 0 })
}
$f.ClientSize = New-Object System.Drawing.Size($FW, $TH)
if ($L.sized -or $TH -ne $FH) {
  # The image fitted into its box (cover: cropped; contain: whole, on the
  # background), the box at the window's top.
  $bm = New-Object System.Drawing.Bitmap($FW, $TH)
  $gr = [System.Drawing.Graphics]::FromImage($bm)
  $gr.Clear($bg)
  $gr.InterpolationMode = 'HighQualityBicubic'
  $iw = $img.Width / $sc * $K
  $ih = $img.Height / $sc * $K
  $k = $(if (-not $L.sized) { 1 } elseif ($L.fit -eq 'contain') { [Math]::Min($FW / $iw, $FH / $ih) } else { [Math]::Max($FW / $iw, $FH / $ih) })
  $dw = $iw * $k
  $dhh = $ih * $k
  $gr.SetClip((New-Object System.Drawing.RectangleF(0, 0, $FW, $FH)))
  $gr.DrawImage($img, (New-Object System.Drawing.RectangleF((($FW - $dw) / 2), (($FH - $dhh) / 2), $dw, $dhh)))
  $gr.Dispose()
  $f.BackgroundImage = $bm
  $f.BackgroundImageLayout = 'None'
} else {
  $f.BackgroundImage = $img
  $f.BackgroundImageLayout = 'Stretch'
}
$yb = $(if ($L.barEdge) { $TH - $bp } else { $TH - $bottom - $bp })
$bx = $(if ($L.barEdge) { 0 } else { $side })
$bw = $(if ($L.barEdge) { $FW } else { $FW - 2 * $side })
if ($d) {
  $d.Size = New-Object System.Drawing.Size(($FW - 2 * $side), $dh)
  $d.Location = New-Object System.Drawing.Point($side, ($(if ($bp -gt 0 -and -not $L.barEdge) { $yb - 8 } else { $TH - $bottom }) - $dh))
  $f.Controls.Add($d)
}
if ($rad -gt 0) { $f.Region = New-Object System.Drawing.Region((RoundPath 0 0 $FW $TH $rad)) }
if ($L.border) {
  $bpen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml($L.border), 1)
  $f.Add_Paint({
    param($s, $e)
    if ($rad -gt 0) { $e.Graphics.SmoothingMode = 'AntiAlias'; $e.Graphics.DrawPath($bpen, (RoundPath 0 0 ($FW - 1) ($TH - 1) $rad)) }
    else { $e.Graphics.DrawRectangle($bpen, 0, 0, $FW - 1, $TH - 1) }
  })
}
$br = $(if ($null -ne $L.barRadius) { [int]($L.barRadius * $K) } else { [int]($bp / 2) })
function Rounded($ctl) {
  if ($br -gt 0 -and $ctl.Width -gt 0) { $ctl.Region = New-Object System.Drawing.Region((RoundPath 0 0 $ctl.Width $ctl.Height $br)) }
}
$tr = $null
$xb = $null
if ($bp -gt 0) {
  $tr = New-Object System.Windows.Forms.Panel
  $tr.BackColor = [System.Drawing.ColorTranslator]::FromHtml($c[3])
  $tr.Location = New-Object System.Drawing.Point($bx, $yb)
  $tr.Size = New-Object System.Drawing.Size($bw, $bp)
  $tr.Visible = $false
  Rounded $tr
  $fl = New-Object System.Windows.Forms.Panel
  $fl.BackColor = [System.Drawing.ColorTranslator]::FromHtml($c[2])
  $fl.Size = New-Object System.Drawing.Size(0, $bp)
  $tr.Controls.Add($fl)
  $f.Controls.Add($tr)
  if ($L.cancel) {
    # During a download, this cancels it (as a dialog's close button does).
    $xb = New-Object System.Windows.Forms.Label
    $xb.Text = [string][char]0x2715
    $xb.ForeColor = $fg
    $xb.BackColor = $clear
    $xb.AutoSize = $true
    $xb.Cursor = [System.Windows.Forms.Cursors]::Hand
    $xb.Location = New-Object System.Drawing.Point(($FW - [int](26 * $K)), [int](6 * $K))
    $xb.Visible = $false
    $xb.Add_Click({ $f.Close() })
    $f.Controls.Add($xb)
  }
}
# Where the app's window opens (splash-place.ts, the same rule: PS_PLACE);
# pointer: the centre of the screen under it.
${PS_PLACE}
$p = AioPrimary
$T = $null
if ($L.mode -eq 'window') { $T = $L.target }
elseif ($L.mode -eq 'pointer') { $p = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).WorkingArea }
$o = AioPlace $T $FW $TH (AioAll) $p
$x = $o[0]
$y = $o[1]
$f.Location = New-Object System.Drawing.Point($x, $y)
function Fade {
  $n = [int][Math]::Round([int]$L.fadeMs / 16)
  for ($j = 0; $j -lt $n; $j++) {
    $f.Opacity = 0.85 * ($n - $j) / $n
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 16
  }
}
$script:n = 0
$t2 = New-Object System.Windows.Forms.Timer
$t2.Interval = 100
$t2.Add_Tick({
  $script:n++
  # The app that opened this window is gone: nobody will close it.
  if ($script:n % 30 -eq 0 -and -not (Get-Process -Id ([int]$env:AIO_SPL_PARENT) -ErrorAction SilentlyContinue)) {
    $t2.Stop(); $f.Tag = 'done'; $f.Close(); return
  }
  # The app's window, where it really is: the splash moves onto it.
  if ($env:AIO_SPL_AT) {
    $a2 = $null
    try { $a2 = [IO.File]::ReadAllText($env:AIO_SPL_AT) } catch {}
    if ($a2 -and $a2 -ne $script:at) {
      $script:at = $a2
      $o2 = AioPlace ($a2 | ConvertFrom-Json) $f.Width $f.Height (AioAll) (AioPrimary) $true
      $f.Location = New-Object System.Drawing.Point($o2[0], $o2[1])
    }
  }
  $s2 = $null
  try { $s2 = [IO.File]::ReadAllText($env:AIO_SPL_FILE) } catch { return }
  if ($s2 -eq 'close') { $t2.Stop(); Fade; $f.Tag = 'done'; $f.Close(); return }
  $p = $s2.Split([char]9, 2)
  if ($p.Length -lt 2) { return }
  if ($d) { $d.Text = $p[1] }
  if ($tr) {
    $k = -1
    [void][int]::TryParse($p[0], [ref]$k)
    if ($k -ge 0) {
      $fl.Width = [int]($tr.Width * [Math]::Min(100, $k) / 100)
      Rounded $fl
      $tr.Visible = $true; if ($xb) { $xb.Visible = $true }
    } else { $tr.Visible = $false; if ($xb) { $xb.Visible = $false } }
  }
})
$t2.Start()
$f.Add_Shown({
  $what = "shown splash size=$($FW)x$($TH) scale=$sc dark=$([int]$dark) text=$([int][bool]$d) barpx=$bp at=$($f.Left),$($f.Top) colors=$($c -join ',')"
  try { [IO.File]::WriteAllText($env:AIO_SPL_ACK, $what) } catch {}
})
# Closed while PowerShell was starting (the app stopped, or its start failed —
# a ready app waits for this window): never shown.
try { if ([IO.File]::ReadAllText($env:AIO_SPL_FILE) -eq 'close') { exit 0 } } catch {}
# A message loop, not a modal show: that activates the window, whatever it asks.
[System.Windows.Forms.Application]::Run($f)
if ($f.Tag -eq 'done') { exit 0 } else { exit 3 }
`;

/** PowerShell's `-EncodedCommand` form of a script (UTF-16LE, base64). Pure. */
export function encodedCommand(script: string): string {
  const units = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    units[i * 2] = c & 0xff;
    units[i * 2 + 1] = c >> 8;
  }
  let bin = "";
  for (const b of units) bin += String.fromCharCode(b);
  return btoa(bin);
}

function powershellExe(): string {
  const root = Deno.env.get("SystemRoot") ?? "C:\\Windows";
  return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** What PowerShell is started with: a bootstrap that reads the script from
 *  `$env:AIO_PS_SCRIPT` and runs it as a script block. Never the script
 *  itself: `-EncodedCommand` is 2.7× a script's length and Windows ends a
 *  command line at 32767 characters (CreateProcessW error 206 — the splash's
 *  script crossed it in 1.0.23's development, and no splash showed). A script
 *  block, not `-File`, so the execution policy treats it as it treated
 *  `-EncodedCommand`. The same length whatever the script. Pure. */
export function powershellCommand(exe: string): string {
  return `"${exe}" -NoProfile -NonInteractive -ExecutionPolicy Bypass ` +
    `-WindowStyle Hidden -EncodedCommand ${
      encodedCommand(
        "& ([ScriptBlock]::Create([IO.File]::ReadAllText($env:AIO_PS_SCRIPT)))",
      )
    }`;
}

/** Starts `script` (written to `dir`, which its caller owns and removes). */
function startPowershell(
  script: string,
  env: Record<string, string>,
  dir: string,
): number {
  const path = join(dir, "dialog.ps1");
  Deno.writeTextFileSync(path, script);
  const pid = startWindowless(powershellCommand(powershellExe()), {
    ...Deno.env.toObject(),
    ...env,
    AIO_PS_SCRIPT: path,
  });
  if (typeof pid === "string") {
    throw new Error(`could not start PowerShell for the dialog: ${pid}`);
  }
  return pid;
}

const windowsBackend = (
  target: Bounds | null,
  colors: DialogColors | null,
  cancel = true,
): DialogBackend => ({
  name: "windows-forms",
  async progress(title, heading) {
    const dir = await tempDir();
    const file = join(dir, "progress");
    await Deno.writeTextFile(file, progressLine(null, ""));
    const ack = join(dir, "shown");
    const pid = startPowershell(WINDOWS_PROGRESS_PS, {
      AIO_DLG_TITLE: title,
      AIO_DLG_HEADING: heading,
      AIO_DLG_FILE: file,
      AIO_DLG_ACK: ack,
      AIO_DLG_ICON: Deno.execPath(),
      AIO_DLG_PARENT: String(Deno.pid),
      AIO_DLG_TARGET: placeArg(target),
      AIO_DLG_LIGHT: lookArg(colors?.light),
      AIO_DLG_DARK: lookArg(colors?.dark),
      AIO_DLG_CANCEL: cancel ? "1" : "0",
    }, dir);
    return fileProgress(file, dir, ack, () => isProcessAlive(pid), () => {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch {
        // aio-ok: already gone
      }
    });
  },
  async ask(title, message, previous) {
    const dir = await tempDir();
    const file = join(dir, "answer");
    try {
      const pid = startPowershell(WINDOWS_ASK_PS, {
        AIO_DLG_TITLE: title,
        AIO_DLG_TEXT: message,
        AIO_DLG_PREVIOUS: previous ?? "",
        AIO_DLG_FILE: file,
        AIO_DLG_TARGET: placeArg(target),
        AIO_DLG_LIGHT: lookArg(colors?.light),
        AIO_DLG_DARK: lookArg(colors?.dark),
      }, dir);
      await waitWhile(() => isProcessAlive(pid), 24 * 3600_000);
      return windowsAnswer(await Deno.readTextFile(file).catch(() => ""));
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {
        // aio-ok: a leftover temp folder is all this costs; never the real outcome
      });
    }
  },
});

// ── macOS ──────────────────────────────────────────────────────────────────

/** The progress window, JavaScript for Automation over Cocoa. argv: title,
 *  heading, progress file, icon (may be ""), ack file (written once shown),
 *  the app's pid (the window closes itself once that process is gone), where
 *  the app's window opens (`placeArg`; "" — the primary's centre). */
export const MAC_PROGRESS_JXA = `
ObjC.import('Cocoa');
ObjC.import('stdlib');
${MAC_PLACE_JS}
${MAC_LOOK_JS}
function run(argv) {
  const title = argv[0], heading = argv[1], file = argv[2], icon = argv[3], ack = argv[4];
  const parent = argv[5];
  const look = aioLook(argv[7] || '', argv[8] || '');
  const withCancel = argv[9] !== '0';
  let ticks = 0;
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyRegular);
  if (icon) {
    const img = $.NSImage.alloc.initWithContentsOfFile(icon);
    if (img && !img.isNil()) app.applicationIconImage = img;
  }
  const W = 460, H = 150, BW = W - 40;
  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, W, H),
    $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable,
    $.NSBackingStoreBuffered, false);
  win.title = title;
  win.releasedWhenClosed = false;
  if (look) win.backgroundColor = look.bg;
  const head = $.NSTextField.labelWithString(heading);
  head.font = $.NSFont.boldSystemFontOfSize(13);
  head.frame = $.NSMakeRect(20, H - 40, BW, 20);
  const det = $.NSTextField.labelWithString('');
  det.frame = $.NSMakeRect(20, H - 66, BW, 18);
  if (look) { head.textColor = look.fg; det.textColor = look.fg; }
  // The bar: a track and its fill, in the app's colours.
  const track = aioBox(20, 64, BW, 6, look ? look.track : $.NSColor.quaternaryLabelColor);
  const fill = aioBox(20, 64, BW * 0.3, 6, look ? look.bar : $.NSColor.controlAccentColor);
  // Cancel — the one button: it ends the download, as the window's close does.
  const cancel = $.NSButton.alloc.initWithFrame($.NSMakeRect(W - 20 - 88, 14, 88, 32));
  cancel.title = 'Cancel';
  cancel.bezelStyle = $.NSBezelStyleRounded;
  cancel.setButtonType($.NSButtonTypePushOnPushOff);
  cancel.keyEquivalent = '\\u001b';
  // electron.downloadWindow.cancel false: no button (the close still cancels).
  cancel.hidden = !withCancel;
  for (const v of [head, det, track, fill, cancel]) win.contentView.addSubview(v);
  // Centred where the app's window opens (splash-place.ts, the same source).
  win.setFrameOrigin(aioPlace(argv[6] ? JSON.parse(argv[6]) : null, win.frame.size.width, win.frame.size.height));
  win.makeKeyAndOrderFront(null);
  app.activateIgnoringOtherApps(true);
  $('shown').writeToFileAtomicallyEncodingError(ack, true, $.NSUTF8StringEncoding, null);
  let pulse = true;
  function tick() {
    // Minimized or hidden (Cmd+H) is not closed. Cancel is the close.
    if (!win.isVisible && !win.isMiniaturized && !app.isHidden) $.exit(3);
    // JXA hands NSInteger back as a string ("1"), measured on macOS 14.
    if (Number(cancel.state) === 1) $.exit(3);
    ticks++;
    // Unknown size: a segment runs along the track.
    if (pulse) fill.frame = $.NSMakeRect(20 + ((ticks * 9) % (BW + BW * 0.3)) - BW * 0.3, 64, BW * 0.3, 6);
    if (ticks % 4 !== 0) return;
    // The app that opened this window is gone: nobody will close it.
    if (ticks % 100 === 0 && parent) {
      const k = $.NSTask.launchedTaskWithLaunchPathArguments('/bin/kill', ['-0', parent]);
      k.waitUntilExit;
      if (k.terminationStatus !== 0) $.exit(0);
    }
    const s = $.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null);
    if (!s || s.isNil()) return;
    const str = s.js;
    if (str === 'close') $.exit(0);
    const i = str.indexOf('\\t');
    if (i < 0) return;
    const n = parseInt(str.slice(0, i), 10);
    pulse = !(n >= 0);
    if (!pulse) fill.frame = $.NSMakeRect(20, 64, Math.max(1, BW * Math.min(100, n) / 100), 6);
    det.stringValue = str.slice(i + 1);
  }
  // The event loop, by hand: each turn waits up to 50 ms for an event, then
  // ticks. (An NSTimer needs a target from ObjC.registerSubclass, which never
  // returned on macOS 14 — measured: the window showed and never updated,
  // closed or noticed a Cancel.)
  app.finishLaunching;
  for (;;) {
    const ev = app.nextEventMatchingMaskUntilDateInModeDequeue(
      $.NSEventMaskAny, $.NSDate.dateWithTimeIntervalSinceNow(0.05),
      $.NSDefaultRunLoopMode, true);
    if (ev && !ev.isNil()) app.sendEvent(ev);
    tick();
  }
}
`;

/** The splash (`build.splash`) over Cocoa: borderless, the image IS the
 *  window (its point size: an @2x image is crisp on a Retina screen; or
 *  `size`, the image fitted), placed where the app's window will open
 *  (`position`), floating above other windows without taking focus and
 *  without a Dock icon; the text (with a soft shadow) and a small bar over
 *  its lower part, or in a strip below the image. argv: title, text, has
 *  text (1/0), progress file, ack file, the app's pid, light colours, dark
 *  colours, image, scale, font family, size, bold (1/0), bar points (0 =
 *  none), the look (`helperLook`, JSON). Same file protocol as the Windows
 *  splash; `close` fades it out. */
export const MAC_SPLASH_JXA = `
ObjC.import('Cocoa');
ObjC.import('stdlib');
${MAC_PLACE_JS}
function run(argv) {
  const text = argv[1], hasText = argv[2] === '1', file = argv[3], ack = argv[4];
  const parent = argv[5], light = argv[6], dark = argv[7], image = argv[8];
  const scale = parseFloat(argv[9]), family = argv[10], size = parseFloat(argv[11]);
  const bold = argv[12] === '1', barPt = parseFloat(argv[13]);
  const L = JSON.parse(argv[14]);
  const atFile = argv[15] || '';
  let lastAt = '';
  let ticks = 0;
  const app = $.NSApplication.sharedApplication;
  // An accessory: no Dock icon, no menu bar, and it never becomes active.
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  const st = $.NSUserDefaults.standardUserDefaults.stringForKey('AppleInterfaceStyle');
  const isDark = !!st && !st.isNil() && st.js === 'Dark';
  const hex = (h) => $.NSColor.colorWithSRGBRedGreenBlueAlpha(
    parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255, 1);
  const cs = (isDark ? dark : light).split(' ');
  const img = $.NSImage.alloc.initWithContentsOfFile(image);
  if (!img || img.isNil()) $.exit(4);
  const rep = img.representations.objectAtIndex(0);
  const iw = Math.round(rep.pixelsWide / scale), ih = Math.round(rep.pixelsHigh / scale);
  img.size = $.NSMakeSize(iw, ih);
  const W = L.sized ? L.w : iw, H = L.sized ? L.h : ih;
  const bp = barPt > 0 ? (L.barHeight || barPt) : 0;
  const side = L.side, bottom = L.bottom, edge = L.barEdge;
  let label = null, lh = 0;
  if (hasText) {
    let f = family ? $.NSFont.fontWithNameSize(family, size) : null;
    if (!f || f.isNil()) f = $.NSFont.systemFontOfSize(size);
    if (bold) f = $.NSFontManager.sharedFontManager.convertFontToHaveTrait(f, 2); // NSBoldFontMask
    label = $.NSTextField.labelWithString(text);
    label.font = f;
    label.textColor = hex(cs[1]);
    label.alignment = L.align === 'center' ? 2 : L.align === 'right' ? 1 : 0;
    if (L.shadow) {
      const sh = $.NSShadow.alloc.init;
      sh.shadowColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0, 0, 0, 0.45);
      sh.shadowOffset = $.NSMakeSize(0, -1);
      sh.shadowBlurRadius = 2;
      label.shadow = sh;
    }
    lh = Math.ceil(label.fittingSize.height);
  }
  // Below the image: a strip as tall as what it holds.
  const TH = L.below && label ? H + 8 + lh + bottom + (bp > 0 && !edge ? 8 + bp : 0) : H;
  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, W, TH), $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
  win.releasedWhenClosed = false;
  win.backgroundColor = hex(cs[0]);
  win.hasShadow = !!L.windowShadow;
  win.level = 3; // NSFloatingWindowLevel: above the app windows
  const view = win.contentView;
  // Rounded corners and a border: no CGColor (a CGColorRef through the JXA
  // bridge crashed osascript — measured), so the background and the border
  // are NSBoxes, and the layer only clips.
  const frameBox = (fillCol, border) => {
    const b = $.NSBox.alloc.initWithFrame($.NSMakeRect(0, 0, W, TH));
    b.boxType = 4; // NSBoxCustom
    b.titlePosition = 0; // NSNoTitle
    b.cornerRadius = L.radius;
    b.fillColor = fillCol;
    b.borderWidth = border ? 1 : 0;
    if (border) b.borderColor = hex(border);
    view.addSubview(b);
  };
  if (L.radius > 0) {
    win.opaque = false;
    win.backgroundColor = $.NSColor.clearColor;
    view.wantsLayer = true;
    view.layer.cornerRadius = L.radius;
    view.layer.masksToBounds = true;
    frameBox(hex(cs[0]), null);
  }
  if (!L.sized && TH === H) {
    const iv = $.NSImageView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
    iv.imageScaling = 1; // NSImageScaleAxesIndependently: the window has its size
    iv.image = img;
    view.addSubview(iv);
  } else {
    // The image fitted into its box at the window's top.
    const pic = $.NSView.alloc.initWithFrame($.NSMakeRect(0, TH - H, W, H));
    pic.wantsLayer = true;
    pic.layer.contents = img;
    pic.layer.contentsGravity = !L.sized ? 'resize' : L.fit === 'contain' ? 'resizeAspect' : 'resizeAspectFill';
    pic.layer.masksToBounds = true;
    view.addSubview(pic);
  }
  const yb = edge ? 0 : bottom, bx = edge ? 0 : side, bw = edge ? W : W - 2 * side;
  const br = L.barRadius === null ? bp / 2 : L.barRadius;
  let track = null, fill = null, close = null;
  if (label) {
    label.frame = $.NSMakeRect(side, (bp > 0 && !edge ? yb + bp + 8 : bottom), W - 2 * side, lh);
    view.addSubview(label);
  }
  const box = (w, col) => {
    const b = $.NSBox.alloc.initWithFrame($.NSMakeRect(bx, yb, w, bp));
    b.boxType = 4; // NSBoxCustom
    b.titlePosition = 0; // NSNoTitle
    b.borderWidth = 0;
    b.cornerRadius = br;
    b.fillColor = col;
    b.hidden = true;
    view.addSubview(b);
    return b;
  };
  if (bp > 0) {
    track = box(bw, hex(cs[3]));
    fill = box(0, hex(cs[2]));
    if (L.cancel) {
      // During a download, this cancels it. No target: its state is read below.
      close = $.NSButton.alloc.initWithFrame($.NSMakeRect(W - 30, TH - 28, 22, 22));
      close.title = '\\u2715';
      close.bordered = false;
      close.setButtonType(1); // NSButtonTypePushOnPushOff: a click sets state 1
      close.hidden = true;
      view.addSubview(close);
    }
  }
  if (L.border) frameBox($.NSColor.clearColor, L.border); // over everything
  // Where the app's window opens (splash-place.ts, its own source:
  // MAC_PLACE_JS); pointer: the centre of the screen under it.
  if (L.mode === 'pointer') {
    const scr = $.NSScreen.screens;
    const PH = scr.objectAtIndex(0).frame.size.height;
    const m = $.NSEvent.mouseLocation;
    const p = { x: m.x, y: PH - m.y };
    let s = null, first = null;
    for (let i = 0; i < scr.count; i++) {
      const v = scr.objectAtIndex(i).visibleFrame;
      const a = { x: v.origin.x, y: PH - (v.origin.y + v.size.height), width: v.size.width, height: v.size.height };
      if (!first) first = a;
      if (!s && p.x >= a.x && p.y >= a.y && p.x < a.x + a.width && p.y < a.y + a.height) s = a;
    }
    s = s || first;
    const o = centredOn({ x: s.x, y: s.y, width: s.width, height: s.height, screen: s }, W, TH);
    win.setFrameOrigin($.NSMakePoint(o.x, PH - (o.y + TH)));
  } else win.setFrameOrigin(aioPlace(L.mode === 'window' ? L.target : null, W, TH));
  // Where it landed, in Electron's coordinates (the ack says it).
  const PH0 = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
  const X = win.frame.origin.x, Y = PH0 - (win.frame.origin.y + win.frame.size.height);
  // Closed while the helper was starting (the app stopped, or its start
  // failed — a ready app waits for this window): never shown.
  const pre = $.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null);
  if (pre && !pre.isNil() && pre.js === 'close') $.exit(0);
  win.orderFrontRegardless; // shown, not activated: focus stays where it is
  $('shown splash size=' + W + 'x' + TH + ' scale=' + scale + ' dark=' + (isDark ? 1 : 0) +
    ' text=' + (hasText ? 1 : 0) + ' barpt=' + bp + ' at=' + X + ',' + Y + ' colors=' + cs.join(','))
    .writeToFileAtomicallyEncodingError(ack, true, $.NSUTF8StringEncoding, null);
  const turn = (sec) => {
    const ev = app.nextEventMatchingMaskUntilDateInModeDequeue(
      $.NSEventMaskAny, $.NSDate.dateWithTimeIntervalSinceNow(sec),
      $.NSDefaultRunLoopMode, true);
    if (ev && !ev.isNil()) app.sendEvent(ev);
  };
  const fade = () => {
    const n = Math.round(L.fadeMs / 16);
    for (let j = 0; j < n; j++) { win.alphaValue = 0.85 * (n - j) / n; win.displayIfNeeded; turn(0.016); }
    win.orderOut(null);
  };
  app.finishLaunching;
  // The event loop, by hand (ObjC.registerSubclass never returned on macOS
  // 14 — measured): each turn waits up to 100 ms for an event, then ticks.
  for (;;) {
    turn(0.1);
    // JXA hands NSInteger back as a string ("1"), measured on macOS 14.
    if (close && Number(close.state) === 1) $.exit(3);
    // The app's window, where it really is: the splash moves onto it.
    if (atFile) {
      const av = $.NSString.stringWithContentsOfFileEncodingError(atFile, $.NSUTF8StringEncoding, null);
      if (av && !av.isNil() && av.js !== lastAt) {
        lastAt = av.js;
        win.setFrameOrigin(aioPlace(JSON.parse(lastAt), win.frame.size.width, win.frame.size.height, true));
      }
    }
    // The app that opened this window is gone: nobody will close it.
    if (++ticks % 30 === 0 && parent) {
      const k = $.NSTask.launchedTaskWithLaunchPathArguments('/bin/kill', ['-0', parent]);
      k.waitUntilExit;
      if (k.terminationStatus !== 0) $.exit(0);
    }
    const sv = $.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null);
    if (!sv || sv.isNil()) continue;
    const str = sv.js;
    if (str === 'close') { fade(); $.exit(0); }
    const i = str.indexOf('\\t');
    if (i < 0) continue;
    if (label) label.stringValue = str.slice(i + 1);
    if (track) {
      const n = parseInt(str.slice(0, i), 10);
      const on = n >= 0;
      track.hidden = !on; fill.hidden = !on; if (close) close.hidden = !on;
      if (on) fill.frame = $.NSMakeRect(bx, yb, Math.round(bw * Math.min(100, n) / 100), bp);
    }
  }
}
`;

/** The Retry / Quit question over Cocoa: the message and its buttons
 *  (Quit, the third answer when given, Retry — the default), centred where
 *  the app's window opens. argv: title, message, where (`placeArg`; "" —
 *  the primary's centre), the third button's label (may be absent). Prints
 *  the button; its close button is Quit. The buttons toggle (on/off push
 *  buttons) and the loop reads which one is on: a button's action needs a
 *  target from ObjC.registerSubclass, which never returned on macOS 14 (see
 *  MAC_PROGRESS_JXA). */
export const MAC_ASK_JXA = `
ObjC.import('Cocoa');
ObjC.import('stdlib');
${MAC_PLACE_JS}
${MAC_LOOK_JS}
function run(argv) {
  const title = argv[0], message = argv[1], target = argv[2] ? JSON.parse(argv[2]) : null;
  const previous = argv[3] || '';
  const look = aioLook(argv[4] || '', argv[5] || '');
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyRegular);
  const W = 460;
  const msg = $.NSTextField.wrappingLabelWithString(message);
  msg.preferredMaxLayoutWidth = W - 40;
  const mh = Math.ceil(msg.fittingSize.height);
  const H = 20 + mh + 20 + 32 + 14;
  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, W, H),
    $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable,
    $.NSBackingStoreBuffered, false);
  win.title = title;
  win.releasedWhenClosed = false;
  if (look) { win.backgroundColor = look.bg; msg.textColor = look.fg; }
  msg.frame = $.NSMakeRect(20, H - 20 - mh, W - 40, mh);
  win.contentView.addSubview(msg);
  const names = ['Quit'].concat(previous ? [previous] : [], ['Retry']);
  const buttons = [];
  let x = W - 20;
  for (let i = names.length - 1; i >= 0; i--) {
    const b = $.NSButton.alloc.initWithFrame($.NSMakeRect(0, 0, 88, 32));
    b.title = names[i];
    b.bezelStyle = $.NSBezelStyleRounded;
    b.setButtonType($.NSButtonTypePushOnPushOff);
    if (names[i] === 'Retry') b.keyEquivalent = '\\r';
    const bw = Math.max(88, Math.ceil(b.fittingSize.width));
    x -= bw;
    b.frame = $.NSMakeRect(x, 14, bw, 32);
    x -= 8;
    win.contentView.addSubview(b);
    buttons.push([names[i], b]);
  }
  win.setFrameOrigin(aioPlace(target, win.frame.size.width, win.frame.size.height));
  win.makeKeyAndOrderFront(null);
  app.activateIgnoringOtherApps(true);
  app.finishLaunching;
  for (;;) {
    const ev = app.nextEventMatchingMaskUntilDateInModeDequeue(
      $.NSEventMaskAny, $.NSDate.dateWithTimeIntervalSinceNow(0.1),
      $.NSDefaultRunLoopMode, true);
    if (ev && !ev.isNil()) app.sendEvent(ev);
    // JXA hands NSInteger back as a string ("1"), measured on macOS 14.
    for (const [n, b] of buttons) if (Number(b.state) === 1) return n;
    if (!win.isVisible && !win.isMiniaturized) return 'Quit';
  }
}
`;

/** What the macOS question answered (the button it printed). Pure. */
export function macAnswer(button: string, previous?: string): RetryAnswer {
  const b = button.trim();
  return b === "Retry"
    ? "retry"
    : previous && b === previous
    ? "previous"
    : "quit";
}

const macBackend = (
  icon: string | null,
  target: Bounds | null,
  colors: DialogColors | null,
  cancel = true,
): DialogBackend => ({
  name: "cocoa",
  async progress(title, heading) {
    const dir = await tempDir();
    const file = join(dir, "progress");
    const script = join(dir, "progress.js");
    await Deno.writeTextFile(file, progressLine(null, ""));
    await Deno.writeTextFile(script, MAC_PROGRESS_JXA);
    const ack = join(dir, "shown");
    const child = new Deno.Command("/usr/bin/osascript", {
      cwd: neutralCwd(),
      args: [
        "-l",
        "JavaScript",
        script,
        title,
        heading,
        file,
        icon ?? "",
        ack,
        String(Deno.pid),
        placeArg(target),
        lookArg(colors?.light),
        lookArg(colors?.dark),
        cancel ? "1" : "0",
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    let done = false;
    const exited = child.status.then(() => (done = true));
    return fileProgress(file, dir, ack, () => !done, () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // aio-ok: already gone
      }
    }, exited);
  },
  async ask(title, message, previous) {
    const dir = await tempDir();
    const script = join(dir, "ask.js");
    try {
      await Deno.writeTextFile(script, MAC_ASK_JXA);
      const r = await new Deno.Command("/usr/bin/osascript", {
        cwd: neutralCwd(),
        args: [
          "-l",
          "JavaScript",
          script,
          title,
          message,
          placeArg(target),
          previous ?? "",
          lookArg(colors?.light),
          lookArg(colors?.dark),
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      }).output();
      return macAnswer(new TextDecoder().decode(r.stdout), previous);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {
        // aio-ok: a leftover temp folder is all this costs; never the real outcome
      });
    }
  },
});

// ── Linux ──────────────────────────────────────────────────────────────────

/** zenity/yad `--text` is Pango markup: `&`, `<`, `>` in a title or an error
 *  are text, not markup (an `&` made zenity drop the whole label). Pure. */
export function pangoText(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  );
}

/** How a zenity/yad progress helper ended, when it was not told to. Exit 1
 *  is Cancel or the window's close button; GTK prints warnings on stderr
 *  even then, so stderr alone says nothing. The window never showed when
 *  the display could not be opened, or the helper died some other way. Pure. */
export function zenityEnding(
  code: number,
  stderr: string,
): { cancelled: true } | { lost: string } {
  const display =
    /cannot open display|failed to open display|unable to init server|cannot connect to/i;
  if ((code === 0 || code === 1) && !display.test(stderr)) {
    return { cancelled: true };
  }
  const line = stderr.trim().split("\n").find((l) => display.test(l)) ??
    stderr.trim().split("\n")[0] ?? "";
  return { lost: line ? line : `exited ${code}` };
}

/** A zenity/yad `--progress` helper fed on stdin: `N` lines set the bar,
 *  `# text` lines set the label. `line` turns an update into those lines. */
function stdinProgress(
  bin: "zenity" | "yad",
  args: string[],
  line: (fraction: number | null, detail: string) => string,
): ProgressDialog {
  const child = new Deno.Command(bin, {
    cwd: neutralCwd(),
    args,
    stdin: "piped",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  const w = child.stdin.getWriter();
  const enc = new TextEncoder();
  let closing = false;
  let done = false;
  const ended = (async () => {
    const [st, err] = await Promise.all([
      child.status,
      new Response(child.stderr).text().catch(() => ""),
    ]);
    done = true;
    return zenityEnding(st.code, err);
  })();
  const never = new Promise<never>(() => {});
  const cancelled = ended.then((e) =>
    closing || !("cancelled" in e) ? never : undefined
  );
  const lost = ended.then((e) =>
    closing || !("lost" in e) ? never : `${bin}: ${e.lost}`
  );
  const say = (s: string) =>
    w.write(enc.encode(s)).catch(() => {
      // aio-ok: the helper is gone — its exit is what reports that
    });
  return {
    update(fraction, detail) {
      say(line(fraction, detail));
    },
    cancelled,
    lost,
    async close() {
      closing = true;
      await say("100\n");
      await w.close().catch(() => {
        // aio-ok: the helper already closed its end
      });
      for (let i = 0; i < 20 && !done; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!done) {
        try {
          child.kill("SIGKILL");
        } catch {
          // aio-ok: gone
        }
      }
    },
  };
}

/** The zenity/yad download window's argv. yad: Cancel is its one button
 *  (exit 1, as the close). zenity has no way to drop its OK — greyed until
 *  the window closes — nor to take the app's colours. Pure. */
export function zenityProgressArgs(
  bin: "zenity" | "yad",
  title: string,
  heading: string,
  /** `electron.downloadWindow.cancel`: yad then has no button at all. */
  cancel = true,
): string[] {
  return [
    "--progress",
    `--title=${title}`,
    `--text=${pangoText(heading)}`,
    "--percentage=0",
    "--width=460",
    "--auto-close",
    ...(bin === "yad" ? [cancel ? "--button=Cancel:1" : "--no-buttons"] : []),
  ];
}

/** zenity and yad share the progress protocol (see `stdinProgress`). */
const zenityLike = (bin: "zenity" | "yad", cancel = true): DialogBackend => ({
  name: bin,
  progress(title, heading) {
    return Promise.resolve(stdinProgress(
      bin,
      zenityProgressArgs(bin, title, heading, cancel),
      (fraction, detail) =>
        (fraction !== null ? `${Math.floor(fraction * 99)}\n` : "") +
        `# ${pangoText(heading)}\\n${
          pangoText(detail.replace(/[\r\n]+/g, " "))
        }\n`,
    ));
  },
  async ask(title, message, previous) {
    const r = await new Deno.Command(bin, {
      cwd: neutralCwd(),
      args: zenityAskArgs(bin, title, message, previous),
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    return zenityAnswer(
      bin,
      r.code,
      new TextDecoder().decode(r.stdout),
      previous,
    );
  },
});

/** The page the browser fallback serves. Polls `/state`. Pure. */
export function browserPage(title: string): string {
  const esc = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:15px system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;color:#222;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#1d1d1f}}
progress{width:100%;height:22px}button{font:inherit;padding:6px 16px;margin-right:8px}</style>
<h2 id="h"></h2><p id="d"></p><progress id="p"></progress><p id="q" hidden><button id="r">Retry</button><button id="v" hidden></button><button id="x">Quit</button></p>
<script>
const $=(i)=>document.getElementById(i);
async function tick(){let s;try{s=await (await fetch('/state')).json()}catch{ $('d').textContent='The app has closed — you can close this tab.';return}
$('h').textContent=s.heading;$('d').textContent=s.detail;
if(s.fraction===null)$('p').removeAttribute('value');else $('p').value=s.fraction;
$('q').hidden=!s.asking;$('v').hidden=!s.previous;$('v').textContent=s.previous||'';if(s.done){$('p').value=1;$('d').textContent='Done — you can close this tab.';return}
setTimeout(tick,300)}
$('r').onclick=()=>fetch('/answer?retry',{method:'POST'});$('x').onclick=()=>fetch('/answer?quit',{method:'POST'});$('v').onclick=()=>fetch('/answer?previous',{method:'POST'});
window.addEventListener('beforeunload',()=>navigator.sendBeacon('/closed'));tick();
</script>`;
}

/** How long the browser page has to make its first request before it counts
 *  as never opened. */
export const PAGE_OPEN_MS = 30_000;

/** The last resort on a Linux desktop with neither zenity nor yad: a page in
 *  the default browser. A page that could not be opened (refused, no
 *  browser, never loaded) is a LOST window — the download goes on, and a
 *  failure question nobody can see answers Quit. @internal (`open` injected
 *  in tests) */
export function browserBackend(
  open: (url: string) => Promise<void> = async (url) => {
    const may = mayOpenExternal();
    if (!may.ok) throw new Error(may.why);
    await openExternal(url);
  },
  openMs = PAGE_OPEN_MS,
): DialogBackend {
  type State = {
    heading: string;
    detail: string;
    fraction: number | null;
    asking: boolean;
    /** The third answer's label, while it is offered. */
    previous: string | null;
    done: boolean;
  };
  const state: State = {
    heading: "",
    detail: "",
    fraction: null,
    asking: false,
    previous: null,
    done: false,
  };
  let server: Deno.HttpServer | null = null;
  let answer: ((a: RetryAnswer) => void) | null = null;
  let closedTab: (() => void) | null = null;
  let title = "";
  // Resolves with null once the page asked for its state, or with why it
  // never will. One per server: a page that loaded stays loaded.
  let opened: Promise<string | null> | null = null;
  let seen: (() => void) | null = null;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  const ensure = (): Promise<string | null> => {
    if (server && opened) return opened;
    server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
    }, (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/state") {
        seen?.();
        return Response.json(state);
      }
      if (u.pathname === "/answer" && req.method === "POST") {
        answer?.(
          u.search === "?retry"
            ? "retry"
            : u.search === "?previous" && state.previous
            ? "previous"
            : "quit",
        );
        return new Response(null, { status: 204 });
      }
      if (u.pathname === "/closed") {
        closedTab?.();
        return new Response(null, { status: 204 });
      }
      return new Response(browserPage(title), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    const port = (server.addr as Deno.NetAddr).port;
    opened = new Promise<string | null>((resolve) => {
      seen = () => {
        clearTimeout(openTimer);
        seen = null;
        resolve(null);
      };
      // The one opener aio has (it refuses in a test, `$AIO_NO_OPEN`).
      open(`http://127.0.0.1:${port}/`).then(
        () => {
          if (!seen) return; // already loaded
          openTimer = setTimeout(() => {
            seen = null;
            resolve(`the page did not load within ${openMs / 1000}s`);
          }, openMs);
        },
        (e) => {
          seen = null;
          resolve(
            `the browser could not be opened (${
              e instanceof Error ? e.message : e
            })`,
          );
        },
      );
    });
    return opened;
  };
  const shutdown = async () => {
    const s = server;
    server = null;
    opened = null;
    seen = null;
    clearTimeout(openTimer);
    // Give the page one poll to see "done" before the socket goes.
    await new Promise((r) => setTimeout(r, 700));
    await s?.shutdown().catch(() => {
      // aio-ok: the page server is going away either way
    });
  };
  return {
    name: "browser",
    progress(t, heading) {
      title = t;
      Object.assign(state, {
        heading,
        detail: "",
        fraction: null,
        asking: false,
        done: false,
      });
      const lost = ensure().then((why) => why ?? new Promise<string>(() => {}));
      const cancelled = new Promise<void>((r) => (closedTab = r));
      return Promise.resolve({
        update(fraction: number | null, detail: string) {
          state.fraction = fraction;
          state.detail = detail;
        },
        cancelled,
        lost,
        async close() {
          closedTab = null;
          state.done = true;
          await shutdown();
        },
      });
    },
    async ask(t, message, previous) {
      title = t;
      Object.assign(state, {
        heading: t,
        detail: message,
        asking: true,
        previous: previous ?? null,
        done: false,
      });
      const a = await new Promise<RetryAnswer>((r) => {
        answer = r;
        closedTab = () => r("quit");
        // Nobody can see the question: it answers itself, Quit.
        ensure().then((why) => why !== null && r("quit"));
      });
      answer = null;
      state.asking = false;
      state.previous = null;
      if (a !== "retry") {
        state.done = true;
        await shutdown();
      }
      return a;
    },
  };
}

async function onPath(bin: string): Promise<boolean> {
  for (const dir of (Deno.env.get("PATH") ?? "").split(":")) {
    if (!dir) continue;
    try {
      if ((await Deno.stat(join(dir, bin))).isFile) return true;
    } catch {
      // aio-ok: not here
    }
  }
  return false;
}

/** Is there a desktop to draw on? Linux needs a display server; Windows and
 *  macOS always have one for an app a person started. Pure over env. */
export function hasDesktop(
  os: string,
  env: (k: string) => string | undefined,
): boolean {
  if (os !== "linux") return true;
  return !!(env("DISPLAY") || env("WAYLAND_DISPLAY"));
}

/** The backend for this machine, or null when there is nothing to draw on.
 *  `$AIO_DIALOG=none` turns dialogs off (logs only); `$AIO_DIALOG=browser`
 *  forces the browser page on Linux. */
export function dialogBackend(
  opts: {
    icon?: string | null;
    /** Where the app's window opens (`windowBoundsOf`): every window is
     *  centred on it, on its screen. */
    target?: Bounds | null;
    /** Where a GTK that cannot draw is said (once). */
    log?: (m: string) => void;
    /** The app's identity colours, light and dark: every window takes them
     *  (as the OS is light or dark); absent, the OS's own look. */
    colors?: DialogColors | null;
    /** The download window's Cancel button (`electron.downloadWindow`);
     *  its close cancels either way. Default: true. */
    cancel?: boolean;
  } = {},
): Promise<DialogBackend | null> {
  const forced = Deno.env.get("AIO_DIALOG");
  const os = Deno.build.os;
  const target = opts.target ?? null;
  const colors = opts.colors ?? null;
  const cancel = opts.cancel !== false;
  const fallback = async () =>
    (await onPath("zenity"))
      ? zenityLike("zenity", cancel)
      : (await onPath("yad"))
      ? zenityLike("yad", cancel)
      : browserBackend();
  return Promise.resolve(
    forced === "none" || !hasDesktop(os, (k) => Deno.env.get(k))
      ? null
      : os === "windows"
      ? windowsBackend(target, colors, cancel)
      : os === "darwin"
      ? macBackend(opts.icon ?? null, target, colors, cancel)
      : forced === "browser"
      ? browserBackend()
      : gtkBackend(target, fallback, opts.log ?? (() => {}), colors, cancel),
  );
}

/** Linux: the download window and the question drawn by aio over GTK
 *  (gtk-splash.ts), centred where the app's window opens — zenity, yad or
 *  the browser page only where GTK cannot draw, and that is said once, with
 *  why (they place themselves: the screen under the pointer). */
export function gtkBackend(
  target: Bounds | null,
  fallback: () => Promise<DialogBackend>,
  log: (m: string) => void,
  colors: DialogColors | null = null,
  cancel = true,
): DialogBackend {
  let other: DialogBackend | null = null;
  const instead = async (why: string) => {
    if (!other) {
      other = await fallback();
      log(
        `electron: the dialog is not drawn by aio (GTK: ${why}) — ` +
          `${other.name} draws it instead, on the screen it picks`,
      );
    }
    return other;
  };
  return {
    name: "gtk",
    async progress(title, heading) {
      const d = await gtkProgress(title, heading, { target, colors, cancel });
      return "why" in d ? (await instead(d.why)).progress(title, heading) : d;
    },
    async ask(title, message, previous) {
      const names = ["Quit", ...(previous ? [previous] : []), "Retry"];
      const q = await gtkAsk(title, message, names, { target, colors });
      if ("why" in q) {
        return (await instead(q.why)).ask(title, message, previous);
      }
      const lost = q.lost.then((why) => ({ why }));
      const i = await Promise.race([q.answer, lost]);
      if (typeof i !== "number") {
        return (await instead(i.why)).ask(title, message, previous);
      }
      return i === names.length - 1
        ? "retry"
        : previous && i === 1
        ? "previous"
        : "quit";
    },
  };
}

// ── the splash (`build.splash`) ────────────────────────────────────────────

/** A splash window, opened with its first text. Its updates are the progress
 *  protocol: a fraction shows the download bar, null hides it. */
export interface SplashOpener {
  readonly name: string;
  open(title: string, text: string): Promise<ProgressDialog>;
  /** Frees what the opener holds (GTK's worker thread) when the splash
   *  ended before it was opened. */
  dispose?(): void;
}

/** `"#bg #text #bar #track"` — one mode's colours as a helper reads them. */
const colorArg = (c: SplashSpec["light"]) =>
  `${c.background} ${c.text} ${c.bar} ${c.track}`;

/** The bar's points as the helpers read them: 0 = no bar. */
const barArg = (spec: SplashSpec) =>
  String(spec.progress ? BAR_PT[spec.bar] : 0);

/** The move file's `[x,y,w,h]`: the window's rect in the helper's space —
 *  physical screen pixels for a per-monitor-aware Windows helper (when the
 *  main process could convert), else Electron's own. Pure. */
export function moveArg(at: WindowAt, physical: boolean): string {
  const r = physical && at.screen ? at.screen : at;
  return JSON.stringify([r.x, r.y, r.width, r.height]);
}

/** What a splash helper is handed beside the spec. */
type SplashArgs = {
  title: string;
  text: string;
  image: string;
  file: string;
  ack: string;
  /** The app window's saved bounds (splash-place.ts), or null. */
  target?: Bounds | null;
  /** The move file (`moveArg`), or none. */
  at?: string;
};

/** The Windows splash script's environment. Pure. */
export function windowsSplashEnv(
  spec: SplashSpec,
  a: SplashArgs,
): Record<string, string> {
  return {
    AIO_SPL_TITLE: a.title,
    AIO_SPL_TEXT: a.text,
    AIO_SPL_HASTEXT: splashHasText(spec) ? "1" : "0",
    AIO_SPL_FILE: a.file,
    AIO_SPL_ACK: a.ack,
    AIO_SPL_PARENT: String(Deno.pid),
    AIO_SPL_LIGHT: colorArg(spec.light),
    AIO_SPL_DARK: colorArg(spec.dark),
    AIO_SPL_IMAGE: a.image,
    AIO_SPL_SCALE: String(spec.image.scale),
    AIO_SPL_FONT: spec.font.family ?? "",
    AIO_SPL_SIZE: String(spec.font.size),
    AIO_SPL_BOLD: spec.font.weight === "bold" ? "1" : "0",
    AIO_SPL_BAR: barArg(spec),
    AIO_SPL_LOOK: JSON.stringify(helperLook(spec, "windows", a.target ?? null)),
    AIO_SPL_AT: a.at ?? "",
  };
}

/** The macOS splash script's argv after its path. Pure. */
export function macSplashArgs(spec: SplashSpec, a: SplashArgs): string[] {
  return [
    a.title,
    a.text,
    splashHasText(spec) ? "1" : "0",
    a.file,
    a.ack,
    String(Deno.pid),
    colorArg(spec.light),
    colorArg(spec.dark),
    a.image,
    String(spec.image.scale),
    spec.font.family ?? "",
    String(spec.font.size),
    spec.font.weight === "bold" ? "1" : "0",
    barArg(spec),
    JSON.stringify(helperLook(spec, "darwin", a.target ?? null)),
    a.at ?? "",
  ];
}

/** yad's splash: the image with the bar under it, borderless, on top, no
 *  taskbar entry, no buttons. The text is the bar's own (plain text, in the
 *  GTK theme's font and colour: yad 0.40 draws a `--text` beside the image,
 *  not under it — measured). The bar is the download's with `progress`, else
 *  it pulses. Pure. */
export function yadSplash(
  spec: SplashSpec,
  a: { title: string; image: string; target?: Bounds | null },
): { args: string[]; line: (f: number | null, text: string) => string } {
  // yad knows no screens: centred on the app window's saved bounds as they
  // are (not clamped), else its own --center (the screen under the pointer).
  const t = lookOf(spec).position === "window" ? a.target : null;
  const place = t && t.x !== undefined && t.y !== undefined
    ? `--geometry=${spec.image.w}x${spec.image.h}+${
      Math.round(t.x + t.width / 2 - spec.image.w / 2)
    }+${Math.round(t.y + t.height / 2 - spec.image.h / 2)}`
    : "--center";
  return {
    args: [
      "--progress",
      `--title=${a.title}`,
      `--image=${a.image}`,
      `--window-icon=${a.image}`,
      "--image-on-top",
      "--undecorated",
      "--no-buttons",
      "--skip-taskbar",
      "--on-top",
      place,
      "--auto-close",
      ...(spec.progress ? ["--percentage=0"] : ["--pulsate"]),
    ],
    line: (f, t) =>
      (spec.progress && f !== null ? `${Math.floor(f * 99)}\n` : "") +
      (splashHasText(spec) ? `# ${t.replace(/[\r\n]+/g, " ")}\n` : ""),
  };
}

/** Which Linux helper draws the splash, and the ONE line that says what was
 *  drawn: aio itself with GTK 3 (`gtk: true`); else — with why GTK could
 *  not — yad, the image and text; zenity, with no yad, a plain window with
 *  the text only (it cannot show an image); neither, none. Pure. */
export function linuxSplash(
  has: { gtk?: true | string; yad: boolean; zenity: boolean },
): { use: "gtk" | "yad" | "zenity" | null; note: string } {
  if (has.gtk === true) {
    return {
      use: "gtk",
      note: "electron: splash — drawn by GTK 3 (the image at its size, the " +
        "text and the bar over it, in the splash's font and colours)",
    };
  }
  const why = has.gtk === undefined
    ? ""
    : `GTK could not draw it (${has.gtk}); `;
  if (has.yad) {
    return {
      use: "yad",
      note: `electron: splash — ${why}drawn by yad (the image at its pixel ` +
        "size, the text in the bar under it; font and colours follow the GTK " +
        "theme)",
    };
  }
  if (has.zenity) {
    return {
      use: "zenity",
      note: `electron: splash — ${why}yad is not installed, so the image ` +
        "cannot be shown; drawn: a plain zenity window with the text",
    };
  }
  return {
    use: null,
    note: `electron: splash — not shown: ${why}this desktop has neither yad ` +
      "nor zenity to draw it",
  };
}

/** The splash's files in a fresh temp folder: the progress file holding the
 *  first text (bar hidden), the ack path, the image (what a helper process
 *  can open). */
async function splashFiles(spec: SplashSpec, text: string) {
  const dir = await tempDir();
  const file = join(dir, "progress");
  await Deno.writeTextFile(file, progressLine(null, text));
  const image = join(
    dir,
    spec.image.scale === 2 ? "splash@2x.png" : "splash.png",
  );
  await Deno.writeFile(
    image,
    Uint8Array.from(atob(spec.image.png), (ch) => ch.charCodeAt(0)),
  );
  return { dir, file, ack: join(dir, "shown"), image, at: join(dir, "at") };
}

/** The splash opener for this machine, or null when there is nothing to
 *  draw on (no desktop, `$AIO_DIALOG=none`, or Linux where GTK cannot draw
 *  and neither helper is installed). */
export async function splashBackend(
  spec: SplashSpec,
  opts: {
    log?: (m: string) => void;
    /** The app window's saved bounds (`position: "window"`). */
    target?: Bounds | null;
  } = {},
): Promise<SplashOpener | null> {
  if (Deno.env.get("AIO_DIALOG") === "none") return null;
  const os = Deno.build.os;
  if (!hasDesktop(os, (k) => Deno.env.get(k))) return null;
  const target = opts.target ?? null;
  // What the app set that this helper cannot draw: said once, by name.
  const notDrawn = (h: Parameters<typeof splashNotDrawn>[1], name: string) => {
    const n = splashNotDrawn(spec, h);
    if (n.length) {
      opts.log?.(
        `electron: splash — ${name} cannot draw ${n.join(", ")} ` +
          `(docs/build/targets.md, "What each OS draws")`,
      );
    }
  };
  if (os === "windows") {
    notDrawn("windows", "Windows Forms");
    return {
      name: "windows-forms splash",
      async open(title, text) {
        const f = await splashFiles(spec, text);
        const pid = startPowershell(
          WINDOWS_SPLASH_PS,
          windowsSplashEnv(spec, { title, text, ...f, target }),
          f.dir,
        );
        return fileProgress(
          f.file,
          f.dir,
          f.ack,
          () => isProcessAlive(pid),
          () => {
            try {
              Deno.kill(pid, "SIGKILL");
            } catch {
              // aio-ok: already gone
            }
          },
          undefined,
          { path: f.at, physical: true },
        );
      },
    };
  }
  if (os === "darwin") {
    notDrawn("cocoa", "Cocoa");
    return {
      name: "cocoa splash",
      async open(title, text) {
        const f = await splashFiles(spec, text);
        const script = join(f.dir, "splash.js");
        await Deno.writeTextFile(script, MAC_SPLASH_JXA);
        const child = new Deno.Command("/usr/bin/osascript", {
          cwd: neutralCwd(),
          args: [
            "-l",
            "JavaScript",
            script,
            ...macSplashArgs(spec, { title, text, ...f, target }),
          ],
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).spawn();
        let done = false;
        const exited = child.status.then(() => (done = true));
        return fileProgress(
          f.file,
          f.dir,
          f.ack,
          () => !done,
          () => {
            try {
              child.kill("SIGKILL");
            } catch {
              // aio-ok: already gone
            }
          },
          exited,
          { path: f.at, physical: false },
        );
      },
    };
  }
  // aio draws it itself (GTK over FFI); yad, then zenity, only when GTK
  // cannot — and the one line says why.
  const gtk = await gtkSplash(spec, { target });
  const pick = "why" in gtk
    ? linuxSplash({
      gtk: gtk.why,
      yad: await onPath("yad"),
      zenity: await onPath("zenity"),
    })
    : linuxSplash({ gtk: true, yad: false, zenity: false });
  opts.log?.(pick.note);
  if (pick.use) notDrawn(pick.use, pick.use === "gtk" ? "GTK" : pick.use);
  if (!("why" in gtk)) return gtk;
  if (pick.use === "yad") {
    return {
      name: "yad splash",
      async open(title, text) {
        const f = await splashFiles(spec, text);
        const y = yadSplash(spec, { title, image: f.image, target });
        const d = stdinProgress("yad", y.args, y.line);
        return {
          ...d,
          async close() {
            await d.close();
            await Deno.remove(f.dir, { recursive: true }).catch(() => {
              // aio-ok: a leftover temp folder is all this costs
            });
          },
        };
      },
    };
  }
  if (pick.use === "zenity") {
    return {
      name: "zenity splash",
      open(title, text) {
        return Promise.resolve(stdinProgress(
          "zenity",
          [
            "--progress",
            `--title=${title}`,
            `--text=${pangoText(splashHasText(spec) && text ? text : title)}`,
            "--pulsate",
            "--no-cancel",
            "--auto-close",
            "--width=360",
          ],
          (_f, t) =>
            splashHasText(spec) && t
              ? `# ${pangoText(t.replace(/[\r\n]+/g, " "))}\n`
              : "",
        ));
      },
    };
  }
  return null;
}
