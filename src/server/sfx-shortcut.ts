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
  CoTaskMemFree: { parameters: ["pointer"], result: "void" },
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

/** The AppUserModelID of an app's window — its title, the controls made
 *  spaces, trimmed, at most 128 UTF-16 units (the shell's limit) — or `""`
 *  for no title. ONE decider: the window sets it (`mainScriptAumid`) and the
 *  Start-menu shortcut carries it ({@link alignShortcutAumid}). Pure. */
export function appUserModelId(title: string | undefined): string {
  return (title ?? "")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 128);
}

/** `{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}`, pid 5: PKEY_AppUserModel_ID. */
function aumidKey(): Uint8Array<ArrayBuffer> {
  const k = new Uint8Array(20);
  const v = new DataView(k.buffer);
  v.setUint32(0, 0x9f4c2855, true);
  v.setUint16(4, 0x9f79, true);
  v.setUint16(6, 0x4b39, true);
  k.set([0xa8, 0xd0, 0xe1, 0xd4, 0x2d, 0xe1, 0xd5, 0xf3], 8);
  v.setUint32(16, 5, true);
  return k;
}

/** IID_IPropertyStore, `{886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99}`. */
function propertyStoreIid(): Uint8Array<ArrayBuffer> {
  const g = new Uint8Array(16);
  const v = new DataView(g.buffer);
  v.setUint32(0, 0x886d8eeb, true);
  v.setUint16(4, 0x8cf2, true);
  v.setUint16(6, 0x4446, true);
  g.set([0x8d, 0x02, 0xcd, 0xba, 0x1d, 0xbd, 0xcf, 0x99], 8);
  return g;
}

/** One `.lnk` through the shell's own `IShellLinkW`, in this process: no
 *  program is started (so no window, and nothing parses a title), and the
 *  paths go in as UTF-16. `load`: open the existing file first. `target` /
 *  `dir`: what it opens and where. `aumid`: the AppUserModelID it carries.
 *  Saved only when something was set and differs. Returns the id it carried
 *  before. Throws with the call that failed. */
function shellLink(lnk: string, o: {
  load?: boolean;
  target?: string;
  dir?: string;
  aumid?: string;
}): { before: string; saved: boolean } {
  const ole = Deno.dlopen("ole32.dll", OLE32);
  // Slots of the interfaces' method tables (shobjidl_core.h, objidl.h,
  // propsys.h).
  const RELEASE = 2,
    SET_WORKING_DIRECTORY = 9,
    SET_PATH = 20,
    SAVE = 6,
    LOAD = 5,
    GET_VALUE = 5,
    SET_VALUE = 6,
    COMMIT = 7;
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
  const query = (self: Deno.PointerValue, iid: Uint8Array, what: string) => {
    const r = out();
    check(
      `QueryInterface(${what})`,
      call(self, 0, ["buffer", "buffer"], iid, new Uint8Array(r.buffer)),
    );
    return ptr(r);
  };
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
        const file = query(ptr(link), shellGuid(0x0000010b), "IPersistFile");
        try {
          let dirty = !o.load;
          if (o.load) {
            check("Load", call(file, LOAD, ["buffer", "u32"], utf16z(lnk), 2));
          }
          if (o.target !== undefined) {
            check(
              "SetPath",
              call(ptr(link), SET_PATH, ["buffer"], utf16z(o.target)),
            );
          }
          if (o.dir !== undefined) {
            check(
              "SetWorkingDirectory",
              call(ptr(link), SET_WORKING_DIRECTORY, ["buffer"], utf16z(o.dir)),
            );
          }
          let before = "";
          const store = query(ptr(link), propertyStoreIid(), "IPropertyStore");
          try {
            // PROPVARIANT, x64: vt at 0, the value at 8.
            const pv = new Uint8Array(24);
            check(
              "GetValue",
              call(store, GET_VALUE, ["buffer", "buffer"], aumidKey(), pv),
            );
            const dv = new DataView(pv.buffer);
            const at = dv.getBigUint64(8, true);
            if (dv.getUint16(0, true) === 31 /* VT_LPWSTR */ && at) {
              before = readUtf16(Deno.UnsafePointer.create(at)!);
              ole.symbols.CoTaskMemFree(Deno.UnsafePointer.create(at));
            }
            if (o.aumid !== undefined && o.aumid !== before) {
              const text = utf16z(o.aumid);
              const set = new Uint8Array(24);
              const sv = new DataView(set.buffer);
              sv.setUint16(0, 31, true);
              sv.setBigUint64(
                8,
                BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(text))),
                true,
              );
              check(
                "SetValue",
                call(store, SET_VALUE, ["buffer", "buffer"], aumidKey(), set),
              );
              check("Commit", call(store, COMMIT, []));
              dirty = true;
            }
          } finally {
            call(store, RELEASE, []);
          }
          if (dirty) {
            check("Save", call(file, SAVE, ["buffer", "i32"], utf16z(lnk), 1));
          }
          return { before, saved: dirty };
        } finally {
          call(file, RELEASE, []);
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

/** SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW, path). */
function changed(path: string): void {
  const shell = Deno.dlopen("shell32.dll", {
    SHChangeNotify: {
      parameters: ["i32", "u32", "buffer", "pointer"],
      result: "void",
    },
  });
  try {
    shell.symbols.SHChangeNotify(0x2000, 0x0005, utf16z(path), null);
  } finally {
    shell.close();
  }
}

/** NUL-terminated UTF-16 at `p`. */
function readUtf16(p: Deno.PointerObject): string {
  const view = new Deno.UnsafePointerView(p);
  let n = 0;
  while (view.getUint16(n * 2) !== 0 && n < 4096) n++;
  return new TextDecoder("utf-16le").decode(
    new Uint8Array(view.getArrayBuffer(n * 2)),
  );
}

/** Write the `.lnk` through the shell's own `IShellLinkW` — the stub's way,
 *  in this process. Measured on Windows 11 against PowerShell's
 *  `WScript.Shell`: ~10 ms here, ~250 ms there, and that one refuses a `.lnk`
 *  path outside the ANSI code page ("Unable to save shortcut" for a title in
 *  Japanese). Throws with the call that failed. Needs --allow-ffi (a compiled
 *  app has it). Windows only. */
export function writeLnk(lnk: string, target: string, dir: string): void {
  shellLink(lnk, { target, dir });
}

/** Give a one-click install's Start-menu shortcut the AppUserModelID its
 *  window runs under, before the window starts.
 *
 *  The window sets one (its title, `mainScriptAumid`); a shortcut without the
 *  same one is a different app to the shell. Measured on Windows 11
 *  (2026-10-24): the running window's taskbar button read "Electron - 1
 *  running window" (the runtime's own name, and a pin of it starts bare
 *  Electron); with the id on the shortcut, "r9hwapp - 1 running window".
 *  Every `.exe` and app before this one wrote the shortcut without it.
 *
 *  The shortcut is the one on record beside the install, else where the
 *  `.exe` puts it. A missing shortcut stays missing (the user's word). A
 *  no-op off Windows and outside a one-click install. Never throws: returns
 *  `"set"`, `"kept"` (already right / nothing to do), or why it could not. */
export function alignShortcutAumid(o: {
  install: string;
  title: string | undefined;
  os?: string;
  appData?: string;
  /** Test seam: the shell. */
  link?: typeof shellLink;
}): "set" | "kept" | string {
  const os = o.os ?? Deno.build.os;
  const id = appUserModelId(o.title);
  if (os !== "windows" || !id || !sfxInstall(o.install)) return "kept";
  let lnk = "the Start-menu shortcut";
  try {
    const record = o.install + SFX_SHORTCUT_RECORD;
    if (isThere(record)) {
      lnk = Deno.readTextFileSync(record).trim();
    } else {
      const appData = o.appData ?? Deno.env.get("APPDATA");
      if (!appData) return "kept";
      lnk = sfxShortcutPaths(o.install, appData, o.title).lnk;
    }
    if (!lnk || !isThere(lnk)) return "kept";
    const r = (o.link ?? shellLink)(lnk, { load: true, aumid: id });
    if (!r.saved) return "kept";
    // Told, not left for the shell to notice: a window opened right after
    // (the first start of an install) is otherwise filed under the old
    // entry it had cached for the shortcut.
    if (!o.link) changed(lnk);
    return "set";
  } catch (e) {
    return `${lnk}: ${e instanceof Error ? e.message : e}`;
  }
}

/** Give a one-click install the Start-menu shortcut its `.exe` did not add —
 *  once ({@link sfxShortcutAction}). A no-op anywhere else. Never throws: a
 *  start must not stop over a shortcut, so a failure is said, with the path
 *  and why, and — nothing being recorded — the next start tries again.
 *
 *  Returns the shortcut's path on the ONE start that created it — the fact an
 *  app can word for its user ("added to Start; the download can be deleted",
 *  `updates.shortcutAdded`) — and undefined on every other. */
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
}): string | undefined {
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
      return lnk;
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
