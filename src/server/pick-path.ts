// pick-path.ts — the native "choose a file / choose a folder" dialog, once.
//
// THE most-requested missing API across the field reports (ayd at alpha54,
// bw2col at alpha57, and a third app before them): aio shipped `openExternal`
// — "show this path to the desktop" — and nothing for the opposite direction,
// so every desktop app that needs "pick a video" wrote the same zenity
// wrapper. Three independent apps writing the same wrapper is a missing API,
// not a coincidence.
//
// What they got wrong, every time, is the part that is easy to get wrong: a
// dialog binary that is NOT INSTALLED and a user who pressed Cancel both come
// back as "exit 1, no output". bw2col conflated them and shipped a broken
// Browse button that looked like an indecisive user. So the contract here is
// explicit and it is the whole point of the module:
//
//   • cancelled            → `null`  (a normal outcome an app must handle)
//   • no dialog available  → THROWS, naming what to install
//   • no desktop session   → THROWS, before spawning anything
//   • dialog failed        → THROWS, with the tool's own stderr
//
// Server-only, like `openExternal`: it spawns a desktop binary and reads the
// environment. Available from a cell method or a serverFn via `aio/server`.

import { log } from "../diagnostics/logger-api.ts";

/** A named extension group for the dialog's filter dropdown.
 *  `{ name: "Video", extensions: ["mp4", "mkv"] }` — extensions carry no dot. */
export type PickFilter = { name: string; extensions: string[] };

/** How the dialog opens: its title, where it starts, and what it filters. */
export type PickOptions = {
  /** Dialog title. Defaults to the OS wording for the operation. */
  title?: string;
  /** Directory the dialog opens in. A file path is accepted — its directory is
   *  used — because "start where the last pick landed" is the common case. */
  startIn?: string;
  /** Extension groups. Ignored by pickDirectory (there is nothing to filter). */
  filters?: PickFilter[];
};

/** The tool a platform uses, and what to tell the developer when it is absent.
 *  Linux is the only platform with a real choice, so it is the only one with a
 *  list; macOS `osascript` and Windows PowerShell always exist. */
type Provider = { cmd: string; install: string };

const LINUX_PROVIDERS: Provider[] = [
  { cmd: "zenity", install: "apt install zenity (GNOME/most desktops)" },
  { cmd: "kdialog", install: "apt install kdialog (KDE)" },
];

/** Choose ONE file. Resolves to an absolute path, or `null` when the user
 *  cancelled.
 *
 *  ```ts
 *  const path = await pickFile({ filters: [{ name: "Video", extensions: ["mp4"] }] });
 *  if (path === null) return;          // cancelled — not an error
 *  s.input = path;
 *  ```
 *
 *  Throws when no dialog is available, rather than returning `null`: a missing
 *  `zenity` and a pressed Cancel are indistinguishable at the exit code, and an
 *  app that cannot tell them apart ships a Browse button that silently does
 *  nothing. */
export function pickFile(opts?: PickOptions): Promise<string | null>;
/** Choose one or more files. Resolves to a non-empty array, or `null` when the
 *  user cancelled — never `[]`, so "cancelled" stays one check. */
export function pickFile(
  opts: PickOptions & { multiple: true },
): Promise<string[] | null>;
export function pickFile(
  opts: PickOptions & { multiple?: boolean } = {},
): Promise<string | string[] | null> {
  return opts.multiple
    ? _pick("files", opts) as Promise<string[] | null>
    : _pick("file", opts) as Promise<string | null>;
}

/** Choose a directory (the "where should I write 250 GB of scratch files"
 *  dialog). Resolves to an absolute path, or `null` when cancelled. */
export function pickDirectory(opts: PickOptions = {}): Promise<string | null> {
  return _pick("directory", opts) as Promise<string | null>;
}

// ── The one implementation ──────────────────────────────────────────────

type PickKind = "file" | "files" | "directory";

async function _pick(
  kind: PickKind,
  opts: PickOptions,
): Promise<string | string[] | null> {
  const os = Deno.build.os;
  _assertDesktopSession(os);

  const providers = os === "linux" ? LINUX_PROVIDERS : [{
    cmd: os === "darwin" ? "osascript" : "powershell",
    install: "",
  }];

  const missing: string[] = [];
  for (const p of providers) {
    const spec = pickSpec(os, p.cmd, kind, opts);
    if (!spec) continue;
    let out: Deno.CommandOutput;
    try {
      out = await new Deno.Command(spec.cmd, {
        args: spec.args,
        stdout: "piped",
        stderr: "piped",
      }).output();
    } catch (e) {
      // The BINARY is absent — the case every hand-rolled wrapper reported as
      // "user cancelled". Try the next provider; if none is left, the throw
      // below names all of them.
      if (e instanceof Deno.errors.NotFound) {
        missing.push(p.cmd);
        continue;
      }
      throw e;
    }
    return _interpret(kind, p.cmd, out);
  }

  throw new Error(
    `pickFile/pickDirectory: no file dialog available on ${os} — tried ${
      missing.join(", ") || "none"
    }. Install one: ${
      providers.map((p) => p.install).filter(Boolean).join(" · ") ||
      "no known provider for this platform"
    }. (This is NOT the same as the user cancelling — that returns null.)`,
  );
}

/** A desktop dialog on a box with no desktop is a hang or a lie, so it is
 *  refused up front — the same check `am start` makes before launching a GUI
 *  client. Without it, `zenity` exits 1 with "cannot open display", which is
 *  byte-identical to a cancel. */
function _assertDesktopSession(os: typeof Deno.build.os): void {
  if (os !== "linux") return;
  if (Deno.env.get("DISPLAY") || Deno.env.get("WAYLAND_DISPLAY")) return;
  throw new Error(
    "pickFile/pickDirectory: no desktop session (no DISPLAY or " +
      "WAYLAND_DISPLAY) — a native dialog cannot open here. Take the path as " +
      "an argument, or run the app on a desktop.",
  );
}

/** Turn a provider's exit into the contract. Cancel is exit≠0 with NOTHING on
 *  stdout; anything else that failed is an error carrying the tool's stderr.
 *
 *  stderr is deliberately NOT used to detect failure — GTK prints module
 *  warnings on healthy systems, and a wrapper that treated stderr as failure
 *  would refuse to work on half the desktops it runs on. */
function _interpret(
  kind: PickKind,
  cmd: string,
  out: Deno.CommandOutput,
): string | string[] | null {
  const stdout = new TextDecoder().decode(out.stdout).trim();
  const stderr = new TextDecoder().decode(out.stderr).trim();
  if (stdout.length === 0) {
    if (_isCancel(cmd, out.code, stderr)) return null; // cancelled
    throw new Error(
      `pickFile/pickDirectory: ${cmd} failed (exit ${out.code})${
        stderr ? `: ${stderr.split("\n").slice(-3).join(" ")}` : ""
      }`,
    );
  }
  const paths = stdout.split(/\r?\n|\|/).map((p) => p.trim()).filter((p) =>
    p.length > 0
  );
  if (paths.length === 0) return null;
  return kind === "files" ? paths : paths[0]!;
}

/** Is this exit a CANCEL? Provider-aware, because the providers disagree — and
 *  guessing one rule for all of them is how a broken dialog gets reported as an
 *  indecisive user.
 *
 *  - zenity / kdialog: cancel is exit **1** with no output. Anything higher is
 *    a real failure.
 *  - osascript: cancel is exit 1 that SAYS so (`User canceled. (-128)`); a
 *    script error also exits 1, so the words are the only separator.
 *  - powershell: the dialog returning anything but OK leaves stdout empty at
 *    exit 0.
 *
 *  A display that cannot be opened overrides all of it: zenity reports that as
 *  exit 1 — byte-identical to a cancel — and an app told "the user cancelled"
 *  when the truth is "there is no X server" never finds the bug. */
function _isCancel(cmd: string, code: number, stderr: string): boolean {
  if (
    /cannot open display|unable to init server|no protocol specified/i.test(
      stderr,
    )
  ) {
    return false;
  }
  if (cmd === "zenity" || cmd === "kdialog") return code === 1;
  if (cmd === "osascript") {
    return code === 1 && /user cancel+ed/i.test(stderr);
  }
  return code === 0; // powershell, and any provider that exits clean
}

/** The per-OS command, as a PURE function — the shape of every launcher in
 *  this repo (`detachedSpawnSpec`, `openExternal`), so the quoting can be
 *  tested on every platform from any platform. */
export function pickSpec(
  os: typeof Deno.build.os,
  provider: string,
  kind: PickKind,
  opts: PickOptions,
): { cmd: string; args: string[] } | null {
  const dir = opts.startIn ? _asDirectory(opts.startIn, os) : undefined;
  const title = opts.title ??
    (kind === "directory" ? "Choose a folder" : "Choose a file");

  if (provider === "zenity") {
    const args = ["--file-selection", `--title=${title}`];
    if (kind === "directory") args.push("--directory");
    if (kind === "files") args.push("--multiple", "--separator=\n");
    // zenity opens IN a directory only when the filename ends with a
    // separator; without it the last segment is pre-filled as a name instead.
    if (dir) args.push(`--filename=${dir.endsWith("/") ? dir : dir + "/"}`);
    for (const f of opts.filters ?? []) {
      if (kind === "directory") break;
      args.push(
        `--file-filter=${f.name} | ${
          f.extensions.map((e) => `*.${_bareExt(e)}`).join(" ")
        }`,
      );
    }
    return { cmd: "zenity", args };
  }

  if (provider === "kdialog") {
    if (kind === "directory") {
      return {
        cmd: "kdialog",
        args: ["--title", title, "--getexistingdirectory", dir ?? "."],
      };
    }
    // kdialog's filter is the mirror image of zenity's: patterns first, label
    // after a pipe, all groups in ONE argument.
    const filter = (opts.filters ?? []).map((f) =>
      `${f.extensions.map((e) => `*.${_bareExt(e)}`).join(" ")}|${f.name}`
    ).join("\n");
    const args = ["--title", title, "--getopenfilename", dir ?? "."];
    if (filter) args.push(filter);
    if (kind === "files") args.push("--multiple", "--separate-output");
    return { cmd: "kdialog", args };
  }

  if (provider === "osascript") {
    // `POSIX path of` is what turns AppleScript's alias into a real path; the
    // repeat loop is the only way to get it for a multiple selection.
    const prompt = _asEscape(title);
    const loc = dir ? ` default location POSIX file ${_asEscape(dir)}` : "";
    const ofType = (opts.filters ?? []).flatMap((f) => f.extensions).map((e) =>
      _asEscape(_bareExt(e))
    );
    const typeClause = kind !== "directory" && ofType.length > 0
      ? ` of type {${ofType.join(", ")}}`
      : "";
    const chooser = kind === "directory" ? "choose folder" : "choose file";
    const script = kind === "files"
      ? `set fs to (${chooser} with prompt ${prompt}${typeClause}${loc} with multiple selections allowed)\n` +
        `set out to ""\n` +
        `repeat with f in fs\n  set out to out & POSIX path of f & linefeed\nend repeat\n` +
        `return out`
      : `return POSIX path of (${chooser} with prompt ${prompt}${typeClause}${loc})`;
    return { cmd: "osascript", args: ["-e", script] };
  }

  if (provider === "powershell") {
    // -STA is REQUIRED: the Windows common dialogs are single-threaded
    // apartment COM objects and silently fail to open without it.
    const ps = kind === "directory"
      ? `Add-Type -AssemblyName System.Windows.Forms;` +
        `$d = New-Object System.Windows.Forms.FolderBrowserDialog;` +
        `$d.Description = ${_psEscape(title)};` +
        (dir ? `$d.SelectedPath = ${_psEscape(dir)};` : "") +
        `if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }`
      : `Add-Type -AssemblyName System.Windows.Forms;` +
        `$d = New-Object System.Windows.Forms.OpenFileDialog;` +
        `$d.Title = ${_psEscape(title)};` +
        `$d.Multiselect = $${kind === "files"};` +
        (dir ? `$d.InitialDirectory = ${_psEscape(dir)};` : "") +
        (opts.filters?.length
          ? `$d.Filter = ${
            _psEscape(
              opts.filters.map((f) =>
                `${f.name}|${
                  f.extensions.map((e) => `*.${_bareExt(e)}`).join(";")
                }`
              ).join("|"),
            )
          };`
          : "") +
        `if ($d.ShowDialog() -eq 'OK') { $d.FileNames | ForEach-Object { Write-Output $_ } }`;
    return {
      cmd: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", ps],
    };
  }
  return null;
}

/** `startIn` accepts a file because "reopen where the last pick landed" is the
 *  common call, and a dialog handed a file path opens its directory anyway on
 *  some providers and refuses on others. One answer here instead. */
function _asDirectory(p: string, os: typeof Deno.build.os): string {
  try {
    if (Deno.statSync(p).isDirectory) return p;
  } catch {
    // Does not exist (yet) — fall through and treat it as a file path, which
    // is the only reading left that can help.
  }
  const cut = p.replace(/[/\\]+$/, "").lastIndexOf(
    os === "windows" ? "\\" : "/",
  );
  return cut > 0 ? p.slice(0, cut) : p;
}

const _bareExt = (e: string) => e.replace(/^[.*]+/, "");
const _asEscape = (s: string) =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const _psEscape = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Framework-internal: the pick a dev tool wants when a missing dialog should
 *  degrade rather than throw (amui's "browse" affordances). Apps get the
 *  throwing version — a silent null there is the bug this module exists for. */
export async function pickPathBestEffort(
  kind: "file" | "directory",
): Promise<string | null> {
  try {
    return kind === "file" ? await pickFile() : await pickDirectory();
  } catch (e) {
    log.info(`no file dialog available: ${(e as Error).message}`);
    return null;
  }
}
