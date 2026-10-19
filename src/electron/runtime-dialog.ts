/**
 * @module
 * The window a shared-runtime app shows BEFORE it has a window: "Resolving
 * dependencies" with a progress bar while its Electron downloads, and a
 * Retry / Quit question when that fails. Electron cannot draw it — Electron
 * is the thing being downloaded — so each OS draws it with what it always
 * has:
 *
 *   Windows  PowerShell + Windows Forms (in every Windows since 7)
 *   macOS    osascript, JavaScript for Automation with the Cocoa bridge
 *   Linux    zenity, else yad; with neither, a page in the default browser
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
 * "Resolving dependencies" window behind — and a machine that slept is not
 * a death (the app's pid is still there when it wakes).
 *
 * All text reaches the helpers as environment variables or argv, never
 * spliced into script source, so a title with quotes in it is just a title.
 */
import { join } from "@std/path";
import { isProcessAlive } from "../server/single-instance-lock.ts";
import { neutralCwd, startWindowless } from "../server/no-console.ts";
import { mayOpenExternal, openExternal } from "../server/open-external.ts";
import { BAR_PT, type SplashSpec } from "./splash.ts";

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

/** The Windows MessageBox has no buttons of its own naming: with a third
 *  answer it is Yes / No / Cancel, and the text says which is which. Pure. */
export function windowsAskText(message: string, previous?: string): string {
  return previous
    ? `${message}\n\nYes: Retry   ·   No: ${previous}   ·   Cancel: Quit`
    : message;
}

/** The MessageBox's answer (`[string]` of its DialogResult). Pure. */
export function windowsAnswer(r: string): RetryAnswer {
  const a = r.trim();
  return a === "Retry" || a === "Yes"
    ? "retry"
    : a === "No"
    ? "previous"
    : "quit";
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

/** "Downloading Electron 44.7.0 — 45 / 110 MB". Pure. */
export function downloadDetail(
  version: string,
  got: number,
  total: number,
): string {
  const mb = (n: number) => (n / 1e6).toFixed(0);
  return total > 0
    ? `Downloading Electron ${version} — ${mb(got)} / ${mb(total)} MB`
    : `Downloading Electron ${version} — ${mb(got)} MB`;
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
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object System.Windows.Forms.Form
$f.Text = $env:AIO_DLG_TITLE
$f.ClientSize = New-Object System.Drawing.Size(460, 116)
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.StartPosition = 'CenterScreen'
$f.ShowInTaskbar = $true
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
$b = New-Object System.Windows.Forms.ProgressBar
$b.Location = New-Object System.Drawing.Point(18, 72)
$b.Size = New-Object System.Drawing.Size(424, 24)
$b.Style = 'Marquee'
$b.MarqueeAnimationSpeed = 30
$f.Controls.AddRange(@($h, $d, $b))
$t = New-Object System.Windows.Forms.Timer
$t.Interval = 200
$script:n = 0
$t.Add_Tick({
  # The app that opened this window is gone: nobody will close it.
  $script:n++
  if ($script:n % 10 -eq 0 -and -not (Get-Process -Id ([int]$env:AIO_DLG_PARENT) -ErrorAction SilentlyContinue)) {
    $t.Stop(); $f.Tag = 'done'; $f.Close(); return
  }
  $s = $null
  try { $s = [IO.File]::ReadAllText($env:AIO_DLG_FILE) } catch { return }
  if ($s -eq 'close') { $t.Stop(); $f.Tag = 'done'; $f.Close(); return }
  $p = $s.Split([char]9, 2)
  if ($p.Length -lt 2) { return }
  $n = 0
  if ([int]::TryParse($p[0], [ref]$n) -and $n -ge 0) {
    $b.Style = 'Continuous'; $b.Value = [Math]::Min(100, $n)
  } else { $b.Style = 'Marquee' }
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

/** The Retry / Quit box (AIO_DLG_BUTTONS: RetryCancel, or YesNoCancel with a
 *  third answer). Writes its answer to AIO_DLG_FILE. */
export const WINDOWS_ASK_PS = `
Add-Type -AssemblyName System.Windows.Forms
$r = [System.Windows.Forms.MessageBox]::Show($env:AIO_DLG_TEXT, $env:AIO_DLG_TITLE, $env:AIO_DLG_BUTTONS, 'Error')
[IO.File]::WriteAllText($env:AIO_DLG_FILE, [string]$r)
`;

/** The splash (`build.splash`): borderless, the image IS the window (its
 *  size, centred), on top, no taskbar entry; the text and a small bar drawn
 *  over its lower part. Reads AIO_SPL_* and the progress file: a percent of
 *  0..100 shows the bar (and a ✕ that cancels the download), below 0 hides
 *  it; `close` fades it out. The ack says what was drawn. */
export const WINDOWS_SPLASH_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$dark = $false
try {
  $dark = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' -Name AppsUseLightTheme).AppsUseLightTheme -eq 0
} catch {}
$c = $(if ($dark) { $env:AIO_SPL_DARK } else { $env:AIO_SPL_LIGHT }).Split(' ')
$fg = [System.Drawing.ColorTranslator]::FromHtml($c[1])
$clear = [System.Drawing.Color]::Transparent
$img = [System.Drawing.Image]::FromFile($env:AIO_SPL_IMAGE)
$sc = [int]$env:AIO_SPL_SCALE
$FW = [int]($img.Width / $sc)
$FH = [int]($img.Height / $sc)
$f = New-Object System.Windows.Forms.Form
$f.Text = $env:AIO_SPL_TITLE
$f.FormBorderStyle = 'None'
$f.StartPosition = 'CenterScreen'
$f.ShowInTaskbar = $false
$f.TopMost = $true
$f.BackColor = [System.Drawing.ColorTranslator]::FromHtml($c[0])
$f.ClientSize = New-Object System.Drawing.Size($FW, $FH)
$f.BackgroundImage = $img
$f.BackgroundImageLayout = 'Stretch'
$bp = 0
if ([single]$env:AIO_SPL_BAR -gt 0) {
  $g = $f.CreateGraphics()
  $bp = [int][Math]::Max(2, [Math]::Round([single]$env:AIO_SPL_BAR * $g.DpiY / 72))
  $g.Dispose()
}
$yb = $FH - 18 - $bp
$d = $null
if ($env:AIO_SPL_HASTEXT -eq '1') {
  $fam = $(if ($env:AIO_SPL_FONT) { $env:AIO_SPL_FONT } else { [System.Drawing.SystemFonts]::MessageBoxFont.FontFamily.Name })
  $st = $(if ($env:AIO_SPL_BOLD -eq '1') { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular })
  $d = New-Object System.Windows.Forms.Label
  $d.Font = New-Object System.Drawing.Font($fam, [single]$env:AIO_SPL_SIZE, $st)
  $d.ForeColor = $fg
  $d.BackColor = $clear
  $d.Text = $env:AIO_SPL_TEXT
  $dh = $d.Font.Height + 4
  $d.Size = New-Object System.Drawing.Size(($FW - 48), $dh)
  $d.Location = New-Object System.Drawing.Point(24, ($(if ($bp -gt 0) { $yb - 8 } else { $FH - 18 }) - $dh))
  $f.Controls.Add($d)
}
$tr = $null
if ($bp -gt 0) {
  $tr = New-Object System.Windows.Forms.Panel
  $tr.BackColor = [System.Drawing.ColorTranslator]::FromHtml($c[3])
  $tr.Location = New-Object System.Drawing.Point(24, $yb)
  $tr.Size = New-Object System.Drawing.Size(($FW - 48), $bp)
  $tr.Visible = $false
  $fl = New-Object System.Windows.Forms.Panel
  $fl.BackColor = [System.Drawing.ColorTranslator]::FromHtml($c[2])
  $fl.Size = New-Object System.Drawing.Size(0, $bp)
  $tr.Controls.Add($fl)
  $f.Controls.Add($tr)
  # During a download, this cancels it (as a dialog's close button does).
  $xb = New-Object System.Windows.Forms.Label
  $xb.Text = [string][char]0x2715
  $xb.ForeColor = $fg
  $xb.BackColor = $clear
  $xb.AutoSize = $true
  $xb.Cursor = [System.Windows.Forms.Cursors]::Hand
  $xb.Location = New-Object System.Drawing.Point(($FW - 26), 6)
  $xb.Visible = $false
  $xb.Add_Click({ $f.Close() })
  $f.Controls.Add($xb)
}
function Fade {
  for ($o = 0.85; $o -gt 0.05; $o -= 0.15) {
    $f.Opacity = $o
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 16
  }
}
$script:n = 0
$t = New-Object System.Windows.Forms.Timer
$t.Interval = 100
$t.Add_Tick({
  $script:n++
  # The app that opened this window is gone: nobody will close it.
  if ($script:n % 30 -eq 0 -and -not (Get-Process -Id ([int]$env:AIO_SPL_PARENT) -ErrorAction SilentlyContinue)) {
    $t.Stop(); $f.Tag = 'done'; $f.Close(); return
  }
  $s = $null
  try { $s = [IO.File]::ReadAllText($env:AIO_SPL_FILE) } catch { return }
  if ($s -eq 'close') { $t.Stop(); Fade; $f.Tag = 'done'; $f.Close(); return }
  $p = $s.Split([char]9, 2)
  if ($p.Length -lt 2) { return }
  if ($d) { $d.Text = $p[1] }
  if ($tr) {
    $k = -1
    [void][int]::TryParse($p[0], [ref]$k)
    if ($k -ge 0) {
      $fl.Width = [int]($tr.Width * [Math]::Min(100, $k) / 100)
      $tr.Visible = $true; $xb.Visible = $true
    } else { $tr.Visible = $false; $xb.Visible = $false }
  }
})
$t.Start()
$f.Add_Shown({
  $what = "shown splash size=$($FW)x$($FH) scale=$sc dark=$([int]$dark) text=$([int][bool]$d) barpx=$bp colors=$($c -join ',')"
  try { [IO.File]::WriteAllText($env:AIO_SPL_ACK, $what) } catch {}
})
# Closed while PowerShell was starting (the app stopped, or its start failed —
# a ready app waits for this window): never shown.
try { if ([IO.File]::ReadAllText($env:AIO_SPL_FILE) -eq 'close') { exit 0 } } catch {}
[void]$f.ShowDialog()
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

function startPowershell(
  script: string,
  env: Record<string, string>,
): number {
  const exe = powershellExe();
  const cmd = `"${exe}" -NoProfile -NonInteractive -ExecutionPolicy Bypass ` +
    `-WindowStyle Hidden -EncodedCommand ${encodedCommand(script)}`;
  const pid = startWindowless(cmd, { ...Deno.env.toObject(), ...env });
  if (typeof pid === "string") {
    throw new Error(`could not start PowerShell for the dialog: ${pid}`);
  }
  return pid;
}

const windowsBackend: DialogBackend = {
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
    });
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
        AIO_DLG_TEXT: windowsAskText(message, previous),
        AIO_DLG_BUTTONS: previous ? "YesNoCancel" : "RetryCancel",
        AIO_DLG_FILE: file,
      });
      await waitWhile(() => isProcessAlive(pid), 24 * 3600_000);
      return windowsAnswer(await Deno.readTextFile(file).catch(() => ""));
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {
        // aio-ok: a leftover temp folder is all this costs; never the real outcome
      });
    }
  },
};

// ── macOS ──────────────────────────────────────────────────────────────────

/** The progress window, JavaScript for Automation over Cocoa. argv: title,
 *  heading, progress file, icon (may be ""), ack file (written once shown),
 *  the app's pid (the window closes itself once that process is gone). */
export const MAC_PROGRESS_JXA = `
ObjC.import('Cocoa');
ObjC.import('stdlib');
function run(argv) {
  const title = argv[0], heading = argv[1], file = argv[2], icon = argv[3], ack = argv[4];
  const parent = argv[5];
  let ticks = 0;
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyRegular);
  if (icon) {
    const img = $.NSImage.alloc.initWithContentsOfFile(icon);
    if (img && !img.isNil()) app.applicationIconImage = img;
  }
  const W = 460, H = 124;
  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, W, H),
    $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable,
    $.NSBackingStoreBuffered, false);
  win.title = title;
  win.releasedWhenClosed = false;
  const head = $.NSTextField.labelWithString(heading);
  head.font = $.NSFont.boldSystemFontOfSize(13);
  head.frame = $.NSMakeRect(20, H - 40, W - 40, 20);
  const det = $.NSTextField.labelWithString('');
  det.frame = $.NSMakeRect(20, H - 66, W - 40, 18);
  const bar = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(20, 22, W - 40, 20));
  bar.indeterminate = true;
  bar.minValue = 0;
  bar.maxValue = 100;
  bar.startAnimation(null);
  win.contentView.addSubview(head);
  win.contentView.addSubview(det);
  win.contentView.addSubview(bar);
  win.center;
  win.makeKeyAndOrderFront(null);
  app.activateIgnoringOtherApps(true);
  $('shown').writeToFileAtomicallyEncodingError(ack, true, $.NSUTF8StringEncoding, null);
  function tick() {
    // Minimized or hidden (Cmd+H) is not closed.
    if (!win.isVisible && !win.isMiniaturized && !app.isHidden) $.exit(3);
    // The app that opened this window is gone: nobody will close it.
    if (++ticks % 25 === 0 && parent) {
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
    if (n >= 0) { bar.indeterminate = false; bar.doubleValue = Math.min(100, n); }
    else { bar.indeterminate = true; bar.startAnimation(null); }
    det.stringValue = str.slice(i + 1);
  }
  // The event loop, by hand: each turn waits up to 200 ms for an event, then
  // ticks. (An NSTimer needs a target from ObjC.registerSubclass, which never
  // returned on macOS 14 — measured: the window showed and never updated,
  // closed or noticed a Cancel.)
  app.finishLaunching;
  for (;;) {
    const ev = app.nextEventMatchingMaskUntilDateInModeDequeue(
      $.NSEventMaskAny, $.NSDate.dateWithTimeIntervalSinceNow(0.2),
      $.NSDefaultRunLoopMode, true);
    if (ev && !ev.isNil()) app.sendEvent(ev);
    tick();
  }
}
`;

/** The splash (`build.splash`) over Cocoa: borderless, the image IS the
 *  window (its point size: an @2x image is crisp on a Retina screen),
 *  centred, floating above other windows without taking focus and without
 *  a Dock icon; the text (with a soft shadow) and a small bar over its lower
 *  part. argv: title, text, has text (1/0), progress file, ack file, the
 *  app's pid, light colours, dark colours, image, scale, font family, size,
 *  bold (1/0), bar points (0 = none). Same file protocol as the Windows
 *  splash; `close` fades it out. */
export const MAC_SPLASH_JXA = `
ObjC.import('Cocoa');
ObjC.import('stdlib');
function run(argv) {
  const text = argv[1], hasText = argv[2] === '1', file = argv[3], ack = argv[4];
  const parent = argv[5], light = argv[6], dark = argv[7], image = argv[8];
  const scale = parseFloat(argv[9]), family = argv[10], size = parseFloat(argv[11]);
  const bold = argv[12] === '1', barPt = parseFloat(argv[13]);
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
  const W = Math.round(rep.pixelsWide / scale), H = Math.round(rep.pixelsHigh / scale);
  img.size = $.NSMakeSize(W, H);
  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, W, H), $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
  win.releasedWhenClosed = false;
  win.backgroundColor = hex(cs[0]);
  win.hasShadow = true;
  win.level = 3; // NSFloatingWindowLevel: above the app windows
  const view = win.contentView;
  const iv = $.NSImageView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
  iv.imageScaling = 1; // NSImageScaleAxesIndependently: the window has its size
  iv.image = img;
  view.addSubview(iv);
  const yb = 18;
  let label = null, track = null, fill = null, close = null;
  if (hasText) {
    let f = family ? $.NSFont.fontWithNameSize(family, size) : null;
    if (!f || f.isNil()) f = $.NSFont.systemFontOfSize(size);
    if (bold) f = $.NSFontManager.sharedFontManager.convertFontToHaveTrait(f, 2); // NSBoldFontMask
    label = $.NSTextField.labelWithString(text);
    label.font = f;
    label.textColor = hex(cs[1]);
    const sh = $.NSShadow.alloc.init;
    sh.shadowColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0, 0, 0, 0.45);
    sh.shadowOffset = $.NSMakeSize(0, -1);
    sh.shadowBlurRadius = 2;
    label.shadow = sh;
    const lh = Math.ceil(label.fittingSize.height);
    label.frame = $.NSMakeRect(24, (barPt > 0 ? yb + barPt + 8 : yb), W - 48, lh);
    view.addSubview(label);
  }
  const box = (w, col) => {
    const b = $.NSBox.alloc.initWithFrame($.NSMakeRect(24, yb, w, barPt));
    b.boxType = 4; // NSBoxCustom
    b.titlePosition = 0; // NSNoTitle
    b.borderWidth = 0;
    b.cornerRadius = barPt / 2;
    b.fillColor = col;
    b.hidden = true;
    view.addSubview(b);
    return b;
  };
  if (barPt > 0) {
    track = box(W - 48, hex(cs[3]));
    fill = box(0, hex(cs[2]));
    // During a download, this cancels it. No target: its state is read below.
    close = $.NSButton.alloc.initWithFrame($.NSMakeRect(W - 30, H - 28, 22, 22));
    close.title = '\\u2715';
    close.bordered = false;
    close.setButtonType(1); // NSButtonTypePushOnPushOff: a click sets state 1
    close.hidden = true;
    view.addSubview(close);
  }
  win.center;
  // Closed while the helper was starting (the app stopped, or its start
  // failed — a ready app waits for this window): never shown.
  const pre = $.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null);
  if (pre && !pre.isNil() && pre.js === 'close') $.exit(0);
  win.orderFrontRegardless; // shown, not activated: focus stays where it is
  $('shown splash size=' + W + 'x' + H + ' scale=' + scale + ' dark=' + (isDark ? 1 : 0) +
    ' text=' + (hasText ? 1 : 0) + ' barpt=' + barPt + ' colors=' + cs.join(','))
    .writeToFileAtomicallyEncodingError(ack, true, $.NSUTF8StringEncoding, null);
  const turn = (s) => {
    const ev = app.nextEventMatchingMaskUntilDateInModeDequeue(
      $.NSEventMaskAny, $.NSDate.dateWithTimeIntervalSinceNow(s),
      $.NSDefaultRunLoopMode, true);
    if (ev && !ev.isNil()) app.sendEvent(ev);
  };
  const fade = () => {
    for (let a = 0.85; a > 0.05; a -= 0.15) { win.alphaValue = a; win.displayIfNeeded; turn(0.016); }
    win.orderOut(null);
  };
  app.finishLaunching;
  // The event loop, by hand (ObjC.registerSubclass never returned on macOS
  // 14 — measured): each turn waits up to 100 ms for an event, then ticks.
  for (;;) {
    turn(0.1);
    if (close && close.state === 1) $.exit(3);
    // The app that opened this window is gone: nobody will close it.
    if (++ticks % 30 === 0 && parent) {
      const k = $.NSTask.launchedTaskWithLaunchPathArguments('/bin/kill', ['-0', parent]);
      k.waitUntilExit;
      if (k.terminationStatus !== 0) $.exit(0);
    }
    const s = $.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null);
    if (!s || s.isNil()) continue;
    const str = s.js;
    if (str === 'close') { fade(); $.exit(0); }
    const i = str.indexOf('\\t');
    if (i < 0) continue;
    if (label) label.stringValue = str.slice(i + 1);
    if (track) {
      const n = parseInt(str.slice(0, i), 10);
      const on = n >= 0;
      track.hidden = !on; fill.hidden = !on; close.hidden = !on;
      if (on) fill.frame = $.NSMakeRect(24, yb, Math.round((W - 48) * Math.min(100, n) / 100), barPt);
    }
  }
}
`;

/** The Retry / Quit question. argv: title, message, and the third button's
 *  label when there is one. Prints the button. */
export const MAC_ASK_APPLESCRIPT = `
on run argv
  if (count of argv) > 2 then
    set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Quit", (item 3 of argv), "Retry"} default button "Retry" with icon caution
  else
    set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Quit", "Retry"} default button "Retry" with icon caution
  end if
  return button returned of r
end run
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

const macBackend = (icon: string | null): DialogBackend => ({
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
    const script = join(dir, "ask.applescript");
    try {
      await Deno.writeTextFile(script, MAC_ASK_APPLESCRIPT);
      const r = await new Deno.Command("/usr/bin/osascript", {
        cwd: neutralCwd(),
        args: [script, title, message, ...(previous ? [previous] : [])],
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

/** zenity and yad share the progress protocol (see `stdinProgress`). */
const zenityLike = (bin: "zenity" | "yad"): DialogBackend => ({
  name: bin,
  progress(title, heading) {
    return Promise.resolve(stdinProgress(
      bin,
      [
        "--progress",
        `--title=${title}`,
        `--text=${pangoText(heading)}`,
        "--percentage=0",
        "--width=460",
        "--auto-close",
      ],
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
export async function dialogBackend(
  opts: { icon?: string | null } = {},
): Promise<DialogBackend | null> {
  const forced = Deno.env.get("AIO_DIALOG");
  if (forced === "none") return null;
  const os = Deno.build.os;
  if (!hasDesktop(os, (k) => Deno.env.get(k))) return null;
  if (os === "windows") return windowsBackend;
  if (os === "darwin") return macBackend(opts.icon ?? null);
  if (forced !== "browser") {
    if (await onPath("zenity")) return zenityLike("zenity");
    if (await onPath("yad")) return zenityLike("yad");
  }
  return browserBackend();
}

// ── the splash (`build.splash`) ────────────────────────────────────────────

/** A splash window, opened with its first text. Its updates are the progress
 *  protocol: a fraction shows the download bar, null hides it. */
export interface SplashOpener {
  readonly name: string;
  open(title: string, text: string): Promise<ProgressDialog>;
}

/** `"#bg #text #bar #track"` — one mode's colours as a helper reads them. */
const colorArg = (c: SplashSpec["light"]) =>
  `${c.background} ${c.text} ${c.bar} ${c.track}`;

/** The bar's points as the helpers read them: 0 = no bar. */
const barArg = (spec: SplashSpec) =>
  String(spec.progress ? BAR_PT[spec.bar] : 0);

/** What a splash helper is handed beside the spec. */
type SplashArgs = {
  title: string;
  text: string;
  image: string;
  file: string;
  ack: string;
};

/** The Windows splash script's environment. Pure. */
export function windowsSplashEnv(
  spec: SplashSpec,
  a: SplashArgs,
): Record<string, string> {
  return {
    AIO_SPL_TITLE: a.title,
    AIO_SPL_TEXT: a.text,
    AIO_SPL_HASTEXT: spec.text === null ? "0" : "1",
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
  };
}

/** The macOS splash script's argv after its path. Pure. */
export function macSplashArgs(spec: SplashSpec, a: SplashArgs): string[] {
  return [
    a.title,
    a.text,
    spec.text === null ? "0" : "1",
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
  ];
}

/** yad's splash: the image with the bar under it, borderless, on top, no
 *  taskbar entry, no buttons. The text is the bar's own (plain text, in the
 *  GTK theme's font and colour: yad 0.40 draws a `--text` beside the image,
 *  not under it — measured). The bar is the download's with `progress`, else
 *  it pulses. Pure. */
export function yadSplash(
  spec: SplashSpec,
  a: { title: string; image: string },
): { args: string[]; line: (f: number | null, text: string) => string } {
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
      "--center",
      "--auto-close",
      ...(spec.progress ? ["--percentage=0"] : ["--pulsate"]),
    ],
    line: (f, t) =>
      (spec.progress && f !== null ? `${Math.floor(f * 99)}\n` : "") +
      (spec.text === null ? "" : `# ${t.replace(/[\r\n]+/g, " ")}\n`),
  };
}

/** Which Linux helper draws the splash, and the ONE line that says what was
 *  drawn: yad the image and text; zenity, with no yad, a plain window with
 *  the text only (it cannot show an image); neither, none. Pure. */
export function linuxSplash(
  has: { yad: boolean; zenity: boolean },
): { use: "yad" | "zenity" | null; note: string } {
  if (has.yad) {
    return {
      use: "yad",
      note: "electron: splash — drawn by yad (the image at its pixel size, " +
        "the text in the bar under it; font and colours follow the GTK theme)",
    };
  }
  if (has.zenity) {
    return {
      use: "zenity",
      note: "electron: splash — yad is not installed, so the image cannot " +
        "be shown; drawn: a plain zenity window with the text",
    };
  }
  return {
    use: null,
    note: "electron: splash — not shown: this desktop has neither yad nor " +
      "zenity to draw it",
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
  return { dir, file, ack: join(dir, "shown"), image };
}

/** The splash opener for this machine, or null when there is nothing to
 *  draw on (no desktop, `$AIO_DIALOG=none`, or Linux with neither helper). */
export async function splashBackend(
  spec: SplashSpec,
  opts: { log?: (m: string) => void } = {},
): Promise<SplashOpener | null> {
  if (Deno.env.get("AIO_DIALOG") === "none") return null;
  const os = Deno.build.os;
  if (!hasDesktop(os, (k) => Deno.env.get(k))) return null;
  if (os === "windows") {
    return {
      name: "windows-forms splash",
      async open(title, text) {
        const f = await splashFiles(spec, text);
        const pid = startPowershell(
          WINDOWS_SPLASH_PS,
          windowsSplashEnv(spec, { title, text, ...f }),
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
        );
      },
    };
  }
  if (os === "darwin") {
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
            ...macSplashArgs(spec, { title, text, ...f }),
          ],
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).spawn();
        let done = false;
        const exited = child.status.then(() => (done = true));
        return fileProgress(f.file, f.dir, f.ack, () => !done, () => {
          try {
            child.kill("SIGKILL");
          } catch {
            // aio-ok: already gone
          }
        }, exited);
      },
    };
  }
  const pick = linuxSplash({
    yad: await onPath("yad"),
    zenity: await onPath("zenity"),
  });
  opts.log?.(pick.note);
  if (pick.use === "yad") {
    return {
      name: "yad splash",
      async open(title, text) {
        const f = await splashFiles(spec, text);
        const y = yadSplash(spec, { title, image: f.image });
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
            `--text=${pangoText(spec.text === null ? title : text)}`,
            "--pulsate",
            "--no-cancel",
            "--auto-close",
            "--width=360",
          ],
          (_f, t) =>
            spec.text === null
              ? ""
              : `# ${pangoText(t.replace(/[\r\n]+/g, " "))}\n`,
        ));
      },
    };
  }
  return null;
}
