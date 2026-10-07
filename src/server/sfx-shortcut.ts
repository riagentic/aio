// sfx-shortcut.ts — the Start-menu shortcut of a Windows one-click install
// whose `.exe` added none.
//
// The one-click `.exe` adds the shortcut when it installs the app (`shortcut`
// in build/windows-sfx-stub/src/main.rs) — since aio 1.0.18. An install made
// by an older `.exe` that then updates ITSELF never runs a newer stub, so it
// never got one, and its user keeps a download they could delete (from a
// field report). So the app adds it, ONCE per install: what was decided is
// recorded beside the install, where an update, a rollback and a reinstall by
// an old `.exe` all leave it, and a shortcut the user removes afterwards
// stays removed.
import { dirname } from "@std/path";
import * as win from "@std/path/windows";
import type { Log } from "../diagnostics/logger-api.ts";
import { type BuildStamp, readBuildStamp } from "./app-version.ts";
import { locateDenoJsonAbove } from "./deno-json.ts";
import { sfxInstall } from "./updates-apply.ts";

/** What the record of a decided shortcut is named: `<install>` plus this —
 *  `…\aio-sfx\<binary>\win-x64.shortcut`, beside the install, not in it. */
export const SFX_SHORTCUT_RECORD = ".shortcut";

/** The characters Windows refuses in a file name, besides the controls.
 *  Keep in sync with `file_name` in `build/windows-sfx-stub/src/main.rs`
 *  (`tests/sfx-shortcut.test.ts` compares the two). */
export const LNK_REFUSED = '\\/:*?"<>|';

/** A file name made of `title`: what Windows refuses in one becomes `_`, and
 *  the spaces and dots at either end go. The stub's `file_name`. Pure. */
export function shortcutFileName(title: string): string {
  return [...title]
    .map((c) => c < " " || LNK_REFUSED.includes(c) ? "_" : c)
    .join("")
    .replace(/^[ .]+|[ .]+$/g, "");
}

/** The three paths of an install's shortcut — the `.lnk`, what it opens and
 *  where it starts — exactly the stub's: `<APPDATA>\Microsoft\Windows\Start
 *  Menu\Programs\<title>.lnk` → `<install>\<binary>.exe`, in `<install>`. An
 *  empty `title` is the binary's name. Throws when the title leaves no file
 *  name. Pure. */
export function sfxShortcutPaths(
  install: string,
  appData: string,
  title: string | undefined,
): { lnk: string; target: string; dir: string } {
  const binary = win.basename(win.dirname(install));
  const name = shortcutFileName(title || binary);
  if (!name) throw new Error(`${JSON.stringify(title)} is not a file name`);
  return {
    // As the stub joins them: nothing is normalised.
    lnk: `${appData.replace(/[\\/]+$/, "")}\\Microsoft\\Windows\\Start Menu` +
      `\\Programs\\${name}.lnk`,
    target: `${install}\\${binary}.exe`,
    dir: install,
  };
}

/** What a start does about the shortcut. Pure.
 *
 *  - not Windows, not a one-click install, a build that opted out
 *    (`build.windows.shortcut: false`), or already decided once → `"none"`;
 *  - the shortcut is there (the `.exe` that installed the app made it) →
 *    `"record"`: it is decided, and removing it later is the user's word;
 *  - otherwise → `"create"`, then record.
 *
 *  The one install a removed shortcut comes back to, once: made by a
 *  1.0.18-beta `.exe` (the only one that added a shortcut and left no record),
 *  its shortcut removed, and then updated to a version that has this. */
export function sfxShortcutAction(o: {
  os: string;
  sfx: boolean;
  optOut: boolean;
  recorded: boolean;
  exists: boolean;
}): "none" | "record" | "create" {
  if (o.os !== "windows" || !o.sfx || o.optOut || o.recorded) return "none";
  return o.exists ? "record" : "create";
}

const OLE32 = {
  CoInitializeEx: { parameters: ["pointer", "u32"], result: "i32" },
  CoUninitialize: { parameters: [], result: "void" },
  CoCreateInstance: {
    parameters: ["buffer", "pointer", "u32", "buffer", "buffer"],
    result: "i32",
  },
} as const;

/** `{xxxxxxxx-0000-0000-C000-000000000046}` as COM lays a GUID out. */
function shellGuid(first: number): Uint8Array<ArrayBuffer> {
  const g = new Uint8Array(16);
  new DataView(g.buffer).setUint32(0, first, true);
  g[8] = 0xc0;
  g[15] = 0x46;
  return g;
}

function utf16z(s: string): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array((s.length + 1) * 2);
  const v = new DataView(b.buffer);
  for (let i = 0; i < s.length; i++) v.setUint16(i * 2, s.charCodeAt(i), true);
  return b;
}

/** Write the `.lnk` through the shell's own `IShellLinkW` — the stub's way,
 *  in this process: no program is started (so no window, and nothing parses a
 *  title), and the paths go in as UTF-16. Measured on Windows 11 against
 *  PowerShell's `WScript.Shell`: ~10 ms here, ~250 ms there, and that one
 *  refuses a `.lnk` path outside the ANSI code page ("Unable to save
 *  shortcut" for a title in Japanese). Throws with the call that failed. Needs --allow-ffi (a
 *  compiled app has it). Windows only. */
export function writeLnk(lnk: string, target: string, dir: string): void {
  const ole = Deno.dlopen("ole32.dll", OLE32);
  // Slots of the two interfaces' method tables (shobjidl_core.h, objidl.h).
  const RELEASE = 2, SET_WORKING_DIRECTORY = 9, SET_PATH = 20, SAVE = 6;
  const check = (what: string, hr: number) => {
    if (hr < 0) {
      throw new Error(
        `${what} failed (0x${(hr >>> 0).toString(16).padStart(8, "0")})`,
      );
    }
  };
  const call = <const P extends readonly Deno.NativeType[]>(
    self: Deno.PointerValue,
    slot: number,
    parameters: P,
    ...args: unknown[]
  ): number => {
    const table = new Deno.UnsafePointerView(self!).getPointer(0)!;
    const fn = new Deno.UnsafeFnPointer(
      new Deno.UnsafePointerView(table).getPointer(slot * 8)!,
      { parameters: ["pointer", ...parameters], result: "i32" } as const,
    );
    return (fn.call as (...a: unknown[]) => number)(self, ...args);
  };
  const out = () => new BigUint64Array(1);
  const ptr = (o: BigUint64Array) => Deno.UnsafePointer.create(o[0]!);
  try {
    // S_FALSE: this thread has COM already, and owes one more uninitialize.
    // RPC_E_CHANGED_MODE: it has COM in the other model — usable, not ours.
    const init = ole.symbols.CoInitializeEx(null, 2 /* apartment-threaded */);
    if (init !== (0x80010106 | 0)) check("CoInitializeEx", init);
    try {
      const link = out();
      check(
        "CoCreateInstance",
        ole.symbols.CoCreateInstance(
          shellGuid(0x00021401), // CLSID_ShellLink
          null,
          1, // in-process server
          shellGuid(0x000214f9), // IID_IShellLinkW
          new Uint8Array(link.buffer),
        ),
      );
      try {
        check(
          "SetPath",
          call(ptr(link), SET_PATH, ["buffer"], utf16z(target)),
        );
        check(
          "SetWorkingDirectory",
          call(ptr(link), SET_WORKING_DIRECTORY, ["buffer"], utf16z(dir)),
        );
        const file = out();
        check(
          "QueryInterface",
          call(
            ptr(link),
            0,
            ["buffer", "buffer"],
            shellGuid(0x0000010b), // IID_IPersistFile
            new Uint8Array(file.buffer),
          ),
        );
        try {
          check(
            "Save",
            call(ptr(file), SAVE, ["buffer", "i32"], utf16z(lnk), 1),
          );
        } finally {
          call(ptr(file), RELEASE, []);
        }
      } finally {
        call(ptr(link), RELEASE, []);
      }
    } finally {
      if (init >= 0) ole.symbols.CoUninitialize();
    }
  } finally {
    ole.close();
  }
}

/** Give a one-click install the Start-menu shortcut its `.exe` did not add —
 *  once ({@link sfxShortcutAction}). A no-op anywhere else. Never throws: a
 *  start must not stop over a shortcut, so a failure is said, with the path
 *  and why, and — nothing being recorded — the next start tries again. */
export function ensureSfxShortcut(o: {
  install: string;
  log: Log;
  /** Test seams. `build`: what this app's build stamp says — the display
   *  name the build resolved (absent ⇒ the binary's name, as in the `.exe`)
   *  and `windowsShortcut: false` for `build.windows.shortcut: false`. */
  build?: Pick<BuildStamp, "title" | "windowsShortcut">;
  os?: string;
  appData?: string;
  write?: typeof writeLnk;
}): void {
  const os = o.os ?? Deno.build.os;
  if (os !== "windows" || !sfxInstall(o.install)) return;
  const record = o.install + SFX_SHORTCUT_RECORD;
  let lnk = "the Start-menu shortcut";
  try {
    if (isThere(record)) return;
    const found = o.build ? undefined : locateDenoJsonAbove(
      new URL(Deno.mainModule),
    );
    const stamp = o.build ?? (found && readBuildStamp(found.dir)) ?? {};
    if (stamp.windowsShortcut === false) return;
    const appData = o.appData ?? Deno.env.get("APPDATA");
    if (!appData) throw new Error("APPDATA is not set");
    const paths = sfxShortcutPaths(o.install, appData, stamp.title);
    lnk = paths.lnk;
    const action = sfxShortcutAction({
      os,
      sfx: true,
      optOut: false,
      recorded: false,
      exists: isThere(lnk),
    });
    if (action === "create") {
      Deno.mkdirSync(dirname(lnk), { recursive: true });
      (o.write ?? writeLnk)(lnk, paths.target, paths.dir);
    }
    Deno.writeTextFileSync(record, `${lnk}\n`);
    if (action === "create") {
      o.log.info(
        "updates",
        `added a Start-menu shortcut for this app (${lnk}) — the downloaded ` +
          `.exe it was installed from is no longer needed and can be deleted`,
      );
    }
  } catch (e) {
    o.log.warn(
      "updates",
      `could not add ${lnk} for ${o.install} (${
        e instanceof Error ? e.message : e
      }) — the app has no Start-menu shortcut; the next start tries again`,
    );
  }
}

function isThere(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}
