// What an install leaves behind is a fact about the OS, and `am remove` knew
// only Linux's: a `.desktop` file and `~/.local/bin`. On Windows `run.ps1`
// writes a Start-menu shortcut and the one-click `.exe` installs itself under
// `%LOCALAPPDATA%\aio-sfx\<name>\` with a shortcut of its own — `am remove`
// reported success and left all three.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { installedAppPaths, installFootprint } from "../src/server/app-dirs.ts";
import {
  insideParent,
  installedFootprint,
  lnkOpensInside,
  lnkTarget,
  shortcutsInto,
} from "../src/am/am-cmd-remove.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const utf16 = (s: string) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    b[i * 2] = s.charCodeAt(i) & 0xff;
    b[i * 2 + 1] = s.charCodeAt(i) >> 8;
  }
  return b;
};
const u16 = (n: number) => [n & 0xff, n >> 8];
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, 0];
const latin1 = (t: string) => [...t].map((c) => c.charCodeAt(0));

/** A `.lnk` built field by field, as MS-SHLLINK lays it out: header, the
 *  optional ID list, LinkInfo (where the TARGET is — ANSI, plus UTF-16 when
 *  `wide`), then the string data (working directory, arguments, icon). */
function lnk(target: string, o: {
  /** Write the Unicode offsets too (what IShellLinkW does for a path the
   *  ANSI code page cannot spell). */
  wide?: boolean;
  /** The ANSI spelling, when it is not `target` (a lossy `?` copy). */
  ansi?: string;
  /** Split point: the rest goes into CommonPathSuffix. */
  suffix?: string;
  idList?: boolean;
  workDir?: string;
  args?: string;
  icon?: string;
} = {}): Uint8Array {
  const flags = 0x2 | 0x80 | (o.idList ? 0x1 : 0) | (o.workDir ? 0x10 : 0) |
    (o.args ? 0x20 : 0) | (o.icon ? 0x40 : 0);
  const header = [...u32(0x4c), ...new Array(16).fill(7), ...u32(flags)];
  header.push(...new Array(76 - header.length).fill(0));
  const idList = o.idList ? [...u16(6), ...u16(4), 1, 2, ...u16(0)] : [];
  const head = o.wide ? 0x24 : 0x1c;
  const volume = [...u32(0x11), ...u32(3), ...u32(1), ...u32(0x10), 0];
  const base = [...latin1(o.ansi ?? target), 0];
  const rest = [...latin1(o.suffix ?? ""), 0];
  const baseW = [...utf16(target), 0, 0];
  const restW = [...utf16(o.suffix ?? ""), 0, 0];
  const at = {
    volume: head,
    base: head + volume.length,
    rest: head + volume.length + base.length,
    baseW: head + volume.length + base.length + rest.length,
    restW: head + volume.length + base.length + rest.length + baseW.length,
  };
  const body = [
    ...volume,
    ...base,
    ...rest,
    ...(o.wide ? [...baseW, ...restW] : []),
  ];
  const info = [
    ...u32(head + body.length),
    ...u32(head),
    ...u32(1),
    ...u32(at.volume),
    ...u32(at.base),
    ...u32(0),
    ...u32(at.rest),
    ...(o.wide ? [...u32(at.baseW), ...u32(at.restW)] : []),
    ...body,
  ];
  const strings = [o.workDir, o.args, o.icon].filter((t) => t !== undefined)
    .flatMap((t) => [...u16(t.length), ...utf16(t)]);
  return new Uint8Array([...header, ...idList, ...info, ...strings, ...u32(0)]);
}

Deno.test("install footprint: Linux and macOS are the three POSIX paths, unchanged", () => {
  for (const os of ["linux", "darwin"]) {
    const kinds = installFootprint("notes", os, () => "C:\\x").map((f) =>
      f.kind
    );
    assertEquals(kinds, [
      "the app and its versions",
      "menu entry",
      "PATH symlink",
    ]);
  }
});

Deno.test("install footprint: Windows adds the one-click install — and no shortcut by NAME", () => {
  const env: Record<string, string> = {
    APPDATA: join("W", "Roaming"),
    LOCALAPPDATA: join("W", "Local"),
  };
  const fp = installFootprint("notes", "windows", (n) => env[n]);
  assertEquals(fp.slice(3), [
    {
      path: join("W", "Local", "aio-sfx", "notes"),
      kind: "the one-click install",
      parent: join("W", "Local", "aio-sfx"),
    },
  ]);
  // `<Programs>\\<name>.lnk` is a name anything may have (`firefox.lnk`).
  assert(!fp.some((f) => f.path.endsWith(".lnk")), "a shortcut by name");
  // Every path is strictly inside the directory that owns it — the check
  // `am remove` makes before a recursive delete.
  for (const f of fp) assert(insideParent(f.path, f.parent), f.path);
  // An unset variable adds nothing: never a path that starts at "undefined".
  assertEquals(installFootprint("notes", "windows", () => undefined).length, 3);
});

Deno.test("a shortcut's target is read from its LinkInfo — ANSI, Unicode, split, behind an ID list", () => {
  const exe =
    "C:\\Users\\me\\AppData\\Local\\aio-sfx\\notes\\win-x64\\notes.exe";
  assertEquals(lnkTarget(lnk(exe)), exe);
  assertEquals(lnkTarget(lnk(exe, { idList: true, wide: true })), exe);
  assertEquals(
    lnkTarget(lnk("C:\\Users\\me\\", { suffix: "notes.exe", idList: true })),
    "C:\\Users\\me\\notes.exe",
  );
  // A profile the ANSI code page cannot spell: the Unicode path is the one.
  const cyr =
    "C:\\Users\\\u0414\u043c\u0438\u0442\\AppData\\Local\\aio-sfx\\notes\\n.exe";
  assertEquals(
    lnkTarget(lnk(cyr, { wide: true, ansi: "C:\\Users\\????\\n.exe" })),
    cyr,
  );
  // ANSI only, and not ASCII: WHICH code page is not in the file — unknown.
  assertEquals(lnkTarget(lnk("C:\\Users\\\u00e9\\n.exe")), null);
  // Not a shortcut, a cut-off one, one with no LinkInfo: unknown, no throw.
  assertEquals(lnkTarget(new TextEncoder().encode(exe)), null);
  assertEquals(lnkTarget(new Uint8Array(0)), null);
  for (const cut of [10, 77, 90, 120]) {
    assertEquals(lnkTarget(lnk(exe, { idList: true }).slice(0, cut)), null);
  }
  const noInfo = lnk(exe);
  noInfo[20] = 0x80;
  assertEquals(lnkTarget(noInfo), null);
});

Deno.test("a shortcut is this install's by what it OPENS, never by its name or by what it mentions", () => {
  const dir = "C:\\Users\\me\\AppData\\Local\\aio-sfx\\notes";
  assert(lnkOpensInside(lnk(`${dir}\\win-x64\\notes.exe`), dir));
  assert(
    lnkOpensInside(lnk(`${dir.toUpperCase()}\\win-x64\\N.EXE`), dir),
    "case",
  );
  assert(lnkOpensInside(lnk(`${dir}\\n.exe`), dir.replaceAll("\\", "/") + "/"));
  // Another app whose name merely STARTS the same is not this one.
  assert(!lnkOpensInside(lnk(`${dir}2\\win-x64\\notes.exe`), dir));
  assert(!lnkOpensInside(lnk("C:\\Program Files\\Notes\\n.exe"), dir));
  // Somebody else's shortcut that opens a file of ours with THEIR program,
  // starts in our folder and borrows our icon: it opens notepad.
  const foreign = lnk("C:\\Windows\\System32\\notepad.exe", {
    idList: true,
    workDir: dir,
    args: `"${dir}\\win-x64\\notes.txt"`,
    icon: `${dir}\\win-x64\\notes.exe`,
  });
  assert(
    new TextDecoder("utf-16le").decode(foreign.slice(76)).includes(dir),
    "the stand-in does not mention the folder",
  );
  assert(!lnkOpensInside(foreign, dir), "matched on a mention");
  // A non-Latin-1 profile.
  const cyr =
    "C:\\Users\\\u0414\u043c\u0438\u0442\\AppData\\Local\\aio-sfx\\notes";
  assert(lnkOpensInside(lnk(`${cyr}\\n.exe`, { wide: true, ansi: "?" }), cyr));
});

Deno.test("am remove on Windows finds both installs' shortcuts by target — a same-named stranger is not one", async () => {
  const root = await tempDir("rm-win-");
  try {
    const env: Record<string, string> = {
      APPDATA: join(root, "Roaming"),
      LOCALAPPDATA: join(root, "Local"),
    };
    const menu = join(
      root,
      "Roaming",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
    );
    const sfx = join(root, "Local", "aio-sfx", "notes");
    // Where run.ps1 put the program (the runner's install root, here).
    const programs = installedAppPaths("notes").dir;
    await Deno.mkdir(menu, { recursive: true });
    await Deno.mkdir(join(sfx, "win-x64"), { recursive: true });
    await Deno.mkdir(join(menu, "Folder"), { recursive: true });
    // The one-click install's shortcut is named after the TITLE…
    await Deno.writeFile(
      join(menu, "My Notes.lnk"),
      lnk(join(sfx, "win-x64", "notes.exe")),
    );
    // …run.ps1's after the name, and it opens the installed program.
    await Deno.writeFile(
      join(menu, "notes.lnk"),
      lnk(join(programs, "notes.exe")),
    );
    // These are somebody else's: another program, another aio app, a
    // shortcut in a subfolder, one that only MENTIONS the install.
    await Deno.writeFile(
      join(menu, "Browser.lnk"),
      lnk("C:\\Program Files\\B\\b.exe"),
    );
    await Deno.writeFile(
      join(menu, "Other.lnk"),
      lnk(join(sfx + "-two", "win-x64", "x.exe")),
    );
    await Deno.writeFile(
      join(menu, "Folder", "Deep.lnk"),
      lnk(join(sfx, "win-x64", "notes.exe")),
    );
    await Deno.writeFile(
      join(menu, "Mention.lnk"),
      lnk("C:\\Windows\\notepad.exe", { workDir: sfx, args: sfx }),
    );

    assertEquals(await shortcutsInto(menu, sfx), [join(menu, "My Notes.lnk")]);

    const fp = await installedFootprint("notes", "windows", (n) => env[n]);
    const present = fp.filter((f) => f.present).map((f) => f.path).sort();
    assertEquals(
      present.filter((p) => p !== programs),
      [
        sfx,
        join(menu, "My Notes.lnk"),
        join(menu, "notes.lnk"),
      ].sort(),
    );
    assertEquals(fp.length, 6, "three POSIX paths, the install, two shortcuts");
    for (const f of fp) assert(insideParent(f.path, f.parent), f.path);

    // `am remove browser`: no aio app of that name, and a `Browser.lnk` that
    // is the user's own program. By name it was "present" — and deleted.
    const stranger = await installedFootprint(
      "browser",
      "windows",
      (n) => env[n],
    );
    assertEquals(
      stranger.filter((f) => f.path.toLowerCase().endsWith(".lnk")),
      [],
    );
    assertEquals(
      stranger.filter((f) => f.present && f.path.startsWith(root)),
      [],
    );
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("am remove off Windows never looks for a Start menu", async () => {
  const fp = await installedFootprint("notes", "linux", () => "/nonexistent");
  assertEquals(fp.length, 3);
});

// The real thing, where it exists: a `.lnk` written by the product's own
// `writeLnk` (the shell's IShellLinkW, as the one-click `.exe` writes it), a
// real `am remove` in a child, and a Start menu that also holds a stranger's
// shortcut.
Deno.test({
  name:
    "am remove (Windows, real .lnk files): the one-click install, its shortcut and run.ps1's go; a stranger's stays",
  ignore: Deno.build.os !== "windows", // .lnk files and a Start menu exist only there
  async fn() {
    const { writeLnk } = await import("../src/server/sfx-shortcut.ts");
    const root = await tempDir("rm-win-real-");
    try {
      const appData = join(root, "Roaming");
      const local = join(root, "Local");
      const menu = join(
        appData,
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
      );
      const install = join(local, "aio-sfx", "zznotes", "win-x64");
      const other = join(local, "aio-sfx", "zznotes2", "win-x64");
      const programs = join(local, "Programs", "zznotes");
      // run.ps1's layout: versions/<version>/<name>.exe and a stable copy.
      const versioned = join(programs, "versions", "1.0.0");
      for (const d of [menu, install, other, versioned]) {
        await Deno.mkdir(d, { recursive: true });
      }
      await Deno.writeTextFile(join(install, "zznotes.exe"), "x");
      await Deno.writeTextFile(join(other, "zznotes2.exe"), "x");
      await Deno.writeTextFile(join(versioned, "zznotes.exe"), "x");
      await Deno.writeTextFile(join(programs, "zznotes.exe"), "x");
      writeLnk(
        join(menu, "ZZ Notes.lnk"),
        join(install, "zznotes.exe"),
        install,
      );
      writeLnk(
        join(menu, "zznotes.lnk"),
        join(programs, "zznotes.exe"),
        programs,
      );
      writeLnk(
        join(menu, "ZZ Notes Two.lnk"),
        join(other, "zznotes2.exe"),
        other,
      );
      // A stranger NAMED like an app nobody installed with aio…
      const browser = join(root, "Browser", "zzbrowser.exe");
      await Deno.mkdir(join(root, "Browser"));
      await Deno.writeTextFile(browser, "x");
      writeLnk(join(menu, "ZZBrowser.lnk"), browser, join(root, "Browser"));
      // …one that only MENTIONS the install: it opens a file there with
      // notepad, starts in that folder and borrows its icon (written the way
      // a person's own shortcut is — the shell's scripting object)…
      const mention = join(menu, "ZZ Mention.lnk");
      const q = (t: string) => `'${t.replaceAll("'", "''")}'`;
      const made = await new Deno.Command("powershell", {
        args: [
          "-NoProfile",
          "-Command",
          `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${
            q(mention)
          }); $s.TargetPath = "$env:WINDIR\\System32\\notepad.exe"; ` +
          `$s.Arguments = ${q(`"${join(install, "notes.txt")}"`)}; ` +
          `$s.WorkingDirectory = ${q(install)}; ` +
          `$s.IconLocation = ${q(join(install, "zznotes.exe") + ",0")}; ` +
          `$s.Save()`,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(made.success, new TextDecoder().decode(made.stderr));
      // …and an install under a profile the ANSI code page cannot spell.
      const cyrLocal = join(root, "\u0414\u043c\u0438\u0442", "Local");
      const cyrInstall = join(cyrLocal, "aio-sfx", "zznotes", "win-x64");
      await Deno.mkdir(cyrInstall, { recursive: true });
      await Deno.writeTextFile(join(cyrInstall, "zznotes.exe"), "x");
      const cyrLnk = join(root, "cyr.lnk");
      writeLnk(cyrLnk, join(cyrInstall, "zznotes.exe"), cyrInstall);
      assert(
        lnkOpensInside(
          await Deno.readFile(cyrLnk),
          join(cyrLocal, "aio-sfx", "zznotes"),
        ),
        "a real shortcut into a non-Latin-1 folder was not read",
      );
      assertEquals(
        lnkTarget(await Deno.readFile(mention))?.toLowerCase().endsWith(
          "\\system32\\notepad.exe",
        ),
        true,
      );

      const am = (name: string) =>
        new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            "--config",
            join(import.meta.dirname!, "..", "deno.json"),
            join(import.meta.dirname!, "..", "src", "am.ts"),
            "remove",
            name,
            "--json",
          ],
          cwd: root,
          clearEnv: true,
          // The Windows DEFAULT install root (%LOCALAPPDATA%\\Programs) is
          // what is under test, so the runner's own override must not reach
          // it — and HOME / USERPROFILE are the temp root: the POSIX paths of
          // the footprint (`~/.local/bin/<name>`, the `.desktop` file) hang
          // off the home, and this command DELETES what it finds there.
          env: {
            ...Object.fromEntries(
              Object.entries(Deno.env.toObject()).filter(([k]) =>
                k.toUpperCase() !== "AIO_INSTALL_ROOT"
              ),
            ),
            HOME: root,
            USERPROFILE: root,
            APPDATA: appData,
            LOCALAPPDATA: local,
            AIO_APPS_DIR: join(root, "apps"),
            AIO_AM_NO_DELEGATE: "1",
            NO_COLOR: "1",
          },
          stdout: "piped",
          stderr: "piped",
        }).output();
      const there = (p: string) => {
        try {
          Deno.lstatSync(p);
          return true;
        } catch {
          return false;
        }
      };
      // `am remove zzbrowser`: nothing of aio's has that name. The shortcut
      // of that name is the user's — "nothing installed", and it stays.
      const none = await am("zzbrowser");
      const noneSaid = new TextDecoder().decode(none.stdout) +
        new TextDecoder().decode(none.stderr);
      assertEquals(none.code, 1, noneSaid);
      assertStringIncludes(noneSaid, "nothing installed");
      assert(there(join(menu, "ZZBrowser.lnk")), "a stranger's shortcut went");

      const o = await am("zznotes");
      const said = new TextDecoder().decode(o.stdout) +
        new TextDecoder().decode(o.stderr);
      assertEquals(o.code, 0, said);
      for (
        const gone of [
          programs,
          join(local, "aio-sfx", "zznotes"),
          join(menu, "ZZ Notes.lnk"),
          join(menu, "zznotes.lnk"),
        ]
      ) {
        assert(!there(gone), `left behind: ${gone}\n${said}`);
        assert(
          said.includes(JSON.stringify(gone).slice(1, -1)),
          `not listed: ${gone}\n${said}`,
        );
      }
      for (
        const kept of ["ZZ Notes Two.lnk", "ZZBrowser.lnk", "ZZ Mention.lnk"]
      ) {
        assert(there(join(menu, kept)), `a stranger's shortcut went: ${kept}`);
      }
      assert(there(other), "another app's install went");
    } finally {
      await dropTempDir(root);
    }
  },
});
