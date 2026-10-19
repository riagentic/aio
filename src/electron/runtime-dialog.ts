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
}

/** What the failure question answered. */
export type RetryAnswer = "retry" | "quit";

/** How dialogs are drawn on this machine — or `null` for none. */
export interface DialogBackend {
  readonly name: string;
  progress(title: string, heading: string): Promise<ProgressDialog>;
  ask(title: string, message: string): Promise<RetryAnswer>;
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
  return {
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

/** The Retry / Quit box. Writes its answer to AIO_DLG_FILE. */
export const WINDOWS_ASK_PS = `
Add-Type -AssemblyName System.Windows.Forms
$r = [System.Windows.Forms.MessageBox]::Show($env:AIO_DLG_TEXT, $env:AIO_DLG_TITLE, 'RetryCancel', 'Error')
[IO.File]::WriteAllText($env:AIO_DLG_FILE, [string]$r)
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
  async ask(title, message) {
    const dir = await tempDir();
    const file = join(dir, "answer");
    try {
      const pid = startPowershell(WINDOWS_ASK_PS, {
        AIO_DLG_TITLE: title,
        AIO_DLG_TEXT: message,
        AIO_DLG_FILE: file,
      });
      await waitWhile(() => isProcessAlive(pid), 24 * 3600_000);
      const answer = await Deno.readTextFile(file).catch(() => "");
      return answer.trim() === "Retry" ? "retry" : "quit";
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
  ObjC.registerSubclass({
    name: 'AioDialogTick',
    methods: {
      'tick:': {
        types: ['void', ['id']],
        implementation: function (_t) {
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
        },
      },
    },
  });
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(
    0.2, $.AioDialogTick.alloc.init, 'tick:', null, true);
  app.run;
}
`;

/** The Retry / Quit question. argv: title, message. Prints the button. */
export const MAC_ASK_APPLESCRIPT = `
on run argv
  set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Quit", "Retry"} default button "Retry" with icon caution
  return button returned of r
end run
`;

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
  async ask(title, message) {
    const dir = await tempDir();
    const script = join(dir, "ask.applescript");
    try {
      await Deno.writeTextFile(script, MAC_ASK_APPLESCRIPT);
      const r = await new Deno.Command("/usr/bin/osascript", {
        cwd: neutralCwd(),
        args: [script, title, message],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      }).output();
      return new TextDecoder().decode(r.stdout).trim() === "Retry"
        ? "retry"
        : "quit";
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

/** zenity and yad share the progress protocol: `N` lines set the bar,
 *  `# text` lines set the label. */
const zenityLike = (bin: "zenity" | "yad"): DialogBackend => ({
  name: bin,
  progress(title, heading) {
    const child = new Deno.Command(bin, {
      cwd: neutralCwd(),
      args: [
        "--progress",
        `--title=${title}`,
        `--text=${pangoText(heading)}`,
        "--percentage=0",
        "--width=460",
        "--auto-close",
      ],
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
    return Promise.resolve({
      update(fraction, detail) {
        if (fraction !== null) say(`${Math.floor(fraction * 99)}\n`);
        say(
          `# ${pangoText(heading)}\\n${
            pangoText(detail.replace(/[\r\n]+/g, " "))
          }\n`,
        );
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
    });
  },
  async ask(title, message) {
    const args = bin === "zenity"
      ? [
        "--question",
        `--title=${title}`,
        `--text=${pangoText(message)}`,
        "--ok-label=Retry",
        "--cancel-label=Quit",
        "--width=460",
      ]
      : [
        `--title=${title}`,
        `--text=${pangoText(message)}`,
        "--button=Quit:1",
        "--button=Retry:0",
        "--width=460",
      ];
    const r = await new Deno.Command(bin, {
      cwd: neutralCwd(),
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    return r.code === 0 ? "retry" : "quit";
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
<h2 id="h"></h2><p id="d"></p><progress id="p"></progress><p id="q" hidden><button id="r">Retry</button><button id="x">Quit</button></p>
<script>
const $=(i)=>document.getElementById(i);
async function tick(){let s;try{s=await (await fetch('/state')).json()}catch{ $('d').textContent='The app has closed — you can close this tab.';return}
$('h').textContent=s.heading;$('d').textContent=s.detail;
if(s.fraction===null)$('p').removeAttribute('value');else $('p').value=s.fraction;
$('q').hidden=!s.asking;if(s.done){$('p').value=1;$('d').textContent='Done — you can close this tab.';return}
setTimeout(tick,300)}
$('r').onclick=()=>fetch('/answer?retry',{method:'POST'});$('x').onclick=()=>fetch('/answer?quit',{method:'POST'});
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
    done: boolean;
  };
  const state: State = {
    heading: "",
    detail: "",
    fraction: null,
    asking: false,
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
        answer?.(u.search === "?retry" ? "retry" : "quit");
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
    async ask(t, message) {
      title = t;
      Object.assign(state, {
        heading: t,
        detail: message,
        asking: true,
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
      if (a === "quit") {
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
