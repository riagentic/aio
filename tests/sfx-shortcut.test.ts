// A Windows one-click install whose `.exe` added no Start-menu shortcut (one
// made by aio 1.0.17 or older, which then updated itself) gets it from the
// app, once. The app and the `.exe` must name, aim and place it identically —
// two shortcuts for one app, or one the user removed coming back, is the
// failure — so both sides are held to one table, and on Windows the real stub
// and the app are run against each other.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname, join, toFileUrl } from "@std/path";
import {
  alignShortcutAumid,
  appUserModelId,
  ensureSfxShortcut,
  LNK_REFUSED,
  SFX_SHORTCUT_RECORD,
  sfxShortcutAction,
  sfxShortcutPaths,
  shortcutFileName,
  writeLnk,
} from "../src/server/sfx-shortcut.ts";
import { readBuildStamp, writeBuildStamp } from "../src/server/app-version.ts";
import {
  ensureWindowsSfxStub,
  packAppDirTarZstd,
  windowsSfxStubDir,
  writeWindowsSfxExe,
} from "../src/build/build-windows-exe.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const NAMES: [string, string][] = JSON.parse(
  await Deno.readTextFile(join(windowsSfxStubDir(), "shortcut-names.json")),
).names;

/** A hostile title: every quote PowerShell and cmd know, a variable, and
 *  text outside the ANSI code page. */
const HOSTILE = "It's “$env:X” `q` %PATH% & Don’t — 日本語 ☃";

/** A log that keeps what it is told. */
function said(): { log: Log; lines: string[] } {
  const lines: string[] = [];
  const at = (level: string) => (_cat: string, msg: string) => {
    lines.push(`${level}: ${msg}`);
  };
  return {
    lines,
    log: {
      warn: at("warn"),
      info: at("info"),
      error: at("error"),
      debug: at("debug"),
    } as unknown as Log,
  };
}

/** A one-click install folder (`…/aio-sfx/<binary>/win-x64`) under `tmp`. */
async function sfxDir(tmp: string, binary = "my-app"): Promise<string> {
  const install = join(tmp, "local", "aio-sfx", binary, "win-x64");
  await Deno.mkdir(install, { recursive: true });
  await Deno.mkdir(join(tmp, "roaming"), { recursive: true });
  return install;
}

const exists = (p: string) =>
  Deno.lstat(p).then(() => true, (e) => {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  });

// `cargo test` holds the stub's `shortcut_file_name` to the same file
// (tests/build-windows-sfx-stub.test.ts runs it).
Deno.test("the app names a shortcut as the one-click .exe does: one table for both", async () => {
  assert(NAMES.length > 10);
  for (const [title, file] of NAMES) {
    assertEquals(shortcutFileName(title), file, JSON.stringify(title));
  }
  // The rule's two literals, as the stub's source spells them.
  const rs = await Deno.readTextFile(
    join(windowsSfxStubDir(), "src", "format.rs"),
  );
  assert(rs.includes(`r#"${LNK_REFUSED}"#.contains(c)`), "the refused set");
  assert(rs.includes(`.trim_matches([' ', '.'])`), "the trimmed ends");
});

Deno.test("the shortcut's three paths are the stub's, whatever the title holds", () => {
  const install =
    "C:\\Users\\Dan’s PC\\AppData\\Local\\aio-sfx\\my-app\\win-x64";
  const appData = "C:\\Users\\Dan’s PC\\AppData\\Roaming";
  const programs = `${appData}\\Microsoft\\Windows\\Start Menu\\Programs`;
  const target = `${install}\\my-app.exe`;
  for (
    const [title, lnk] of [
      [
        HOSTILE,
        `${programs}\\It's “$env_X” \`q\` %PATH% & Don’t — 日本語 ☃.lnk`,
      ],
      ['a"; calc; "', `${programs}\\a_; calc; _.lnk`],
      ["..\\..\\Startup\\x", `${programs}\\_.._Startup_x.lnk`],
      // No title: the binary's name, as the build writes into the `.exe`.
      [undefined, `${programs}\\my-app.lnk`],
      ["", `${programs}\\my-app.lnk`],
    ] as const
  ) {
    assertEquals(sfxShortcutPaths(install, appData, title), {
      lnk,
      target,
      dir: install,
    });
  }
  assertThrows(
    () => sfxShortcutPaths(install, appData, " . "),
    Error,
    "is not a file name",
  );
});

Deno.test("what a start does about the shortcut: the whole table", () => {
  const base = {
    os: "windows",
    sfx: true,
    optOut: false,
    recorded: false,
    exists: false,
  };
  const rows: [Partial<typeof base>, ReturnType<typeof sfxShortcutAction>][] = [
    [{}, "create"],
    [{ exists: true }, "record"],
    [{ recorded: true }, "none"],
    [{ recorded: true, exists: true }, "none"],
    [{ optOut: true }, "none"],
    [{ optOut: true, exists: true }, "none"],
    [{ sfx: false }, "none"],
    [{ sfx: false, exists: true }, "none"],
    [{ os: "linux" }, "none"],
    [{ os: "darwin" }, "none"],
    [{ os: "linux", exists: true }, "none"],
  ];
  for (const [over, want] of rows) {
    assertEquals(sfxShortcutAction({ ...base, ...over }), want, `${over}`);
  }
});

Deno.test("an install without a shortcut gets one, once — a removed one stays removed", async () => {
  const tmp = await tempDir("sfx-shortcut-");
  try {
    const install = await sfxDir(tmp);
    const appData = join(tmp, "roaming");
    const { lnk, target } = sfxShortcutPaths(install, appData, HOSTILE);
    const wrote: string[][] = [];
    const { log, lines } = said();
    const start = () =>
      ensureSfxShortcut({
        install,
        log,
        build: { title: HOSTILE },
        os: "windows",
        appData,
        write: (...paths) => {
          wrote.push(paths);
          Deno.writeTextFileSync(paths[0], "");
        },
      });
    // The ONE start that adds it says which — what `updates.shortcutAdded`
    // carries to the app; every other start says nothing.
    assertEquals(start(), lnk);
    assertEquals(wrote, [[lnk, target, install]]);
    assertEquals(
      await Deno.readTextFile(install + SFX_SHORTCUT_RECORD),
      `${lnk}\n`,
    );
    assertEquals(lines.length, 1, lines.join("\n"));
    assert(lines[0]!.startsWith("info: "), lines[0]);
    assert(lines[0]!.includes(lnk) && lines[0]!.includes("can be deleted"));
    // The user removes it; the app updates (a new tree at the same path).
    await Deno.remove(lnk);
    await Deno.remove(install, { recursive: true });
    await Deno.mkdir(install);
    assertEquals(start(), undefined);
    assertEquals(start(), undefined);
    assertEquals(wrote.length, 1, "put back a shortcut the user removed");
    assertEquals(lines.length, 1, lines.join("\n"));
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("a shortcut the .exe already made is recorded, never rewritten or put back", async () => {
  const tmp = await tempDir("sfx-shortcut-");
  try {
    const install = await sfxDir(tmp);
    const appData = join(tmp, "roaming");
    const { lnk } = sfxShortcutPaths(install, appData, "My App");
    await Deno.mkdir(dirname(lnk), { recursive: true });
    await Deno.writeTextFile(lnk, "the stub's");
    const { log, lines } = said();
    const start = () =>
      ensureSfxShortcut({
        install,
        log,
        build: { title: "My App" },
        os: "windows",
        appData,
        write: () => {
          throw new Error("must not write");
        },
      });
    start();
    assertEquals(await Deno.readTextFile(lnk), "the stub's");
    assert(await exists(install + SFX_SHORTCUT_RECORD));
    await Deno.remove(lnk);
    start();
    assertEquals(lines, []);
    assert(!await exists(lnk));
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("no shortcut where none belongs: opted out, not a one-click install, not Windows", async () => {
  const tmp = await tempDir("sfx-shortcut-");
  try {
    const install = await sfxDir(tmp);
    const plain = join(tmp, "plain", "win-x64");
    await Deno.mkdir(plain, { recursive: true });
    const appData = join(tmp, "roaming");
    const { log, lines } = said();
    const never = () => {
      throw new Error("must not write");
    };
    const base = { log, appData, write: never, build: { title: "My App" } };
    ensureSfxShortcut({
      ...base,
      install,
      os: "windows",
      build: { title: "My App", windowsShortcut: false },
    });
    ensureSfxShortcut({ ...base, install: plain, os: "windows" });
    for (const os of ["linux", "darwin"]) {
      ensureSfxShortcut({ ...base, install, os });
    }
    assertEquals(lines, []);
    assert(!await exists(install + SFX_SHORTCUT_RECORD), "opt-out recorded");
    assert(!await exists(plain + SFX_SHORTCUT_RECORD));
    assertEquals(
      [...Deno.readDirSync(appData)].map((e) => e.name),
      [],
      "something was written under APPDATA",
    );
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("a shortcut that cannot be written is said once per start, with the path and why, and tried again", async () => {
  const tmp = await tempDir("sfx-shortcut-");
  try {
    const install = await sfxDir(tmp);
    const appData = join(tmp, "roaming");
    const { lnk } = sfxShortcutPaths(install, appData, "My App");
    const { log, lines } = said();
    let fail = true;
    const start = (over: { appData?: string } = {}) =>
      ensureSfxShortcut({
        install,
        log,
        build: { title: "My App" },
        os: "windows",
        appData,
        write: (path) => {
          if (fail) throw new Error("Save failed (0x80070005)");
          Deno.writeTextFileSync(path, "");
        },
        ...over,
      });
    start(); // returns: a start never stops over a shortcut
    assertEquals(lines.length, 1, lines.join("\n"));
    assert(lines[0]!.startsWith("warn: "), lines[0]);
    assert(lines[0]!.includes(lnk), lines[0]);
    assert(lines[0]!.includes("Save failed (0x80070005)"), lines[0]);
    assert(!await exists(install + SFX_SHORTCUT_RECORD), "recorded a failure");
    // A title no file can be named after, and no APPDATA: said the same way.
    ensureSfxShortcut({
      install,
      log,
      build: { title: "..." },
      os: "windows",
      appData,
    });
    assert(lines[1]!.includes("is not a file name"), lines[1]);
    start({ appData: "" });
    assert(lines[2]!.includes("APPDATA is not set"), lines[2]);
    assert(!await exists(install + SFX_SHORTCUT_RECORD));
    fail = false;
    start();
    assert(await exists(lnk), "the next start did not try again");
    assert(lines[3]!.startsWith("info: "), lines[3]);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("the build stamp carries the shortcut's title and an opt-out, and nothing when there is neither", async () => {
  const tmp = await tempDir("sfx-shortcut-");
  try {
    const bv = { version: "1.2.3" } as Parameters<typeof writeBuildStamp>[1];
    const dir = toFileUrl(tmp + "/");
    await writeBuildStamp(tmp, bv, "aio-test", {
      title: HOSTILE,
      windowsShortcut: false,
    });
    const stamp = readBuildStamp(dir)!;
    assertEquals([stamp.title, stamp.windowsShortcut], [HOSTILE, false]);
    await writeBuildStamp(tmp, bv, "aio-test", { windowsShortcut: true });
    const plain = readBuildStamp(dir)!;
    assert(!("title" in plain) && !("windowsShortcut" in plain));
  } finally {
    await dropTempDir(tmp);
  }
});

/** What a `.lnk` opens and where it starts, read by Explorer's own object
 *  model (`Shell.Application`) in another process — not by the code that
 *  wrote it. The path goes through the environment: nothing parses it. */
async function readLnk(lnk: string): Promise<{ target: string; dir: string }> {
  const out = await new Deno.Command("powershell", {
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
      "$f = Get-Item -LiteralPath $env:AIO_TEST_LNK; " +
      "$l = (New-Object -ComObject Shell.Application)" +
      ".NameSpace($f.DirectoryName).ParseName($f.Name).GetLink; " +
      "$l.Path; $l.WorkingDirectory",
    ],
    env: { AIO_TEST_LNK: lnk },
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  assert(out.success, text + new TextDecoder().decode(out.stderr));
  const [target, dir] = text.trim().split(/\r?\n/);
  return { target: target ?? "", dir: dir ?? "" };
}

Deno.test({
  name:
    "Windows: the app writes a real .lnk for a hostile title — inside the test's folder, read back by Explorer",
  ignore: Deno.build.os !== "windows", // a .lnk is written by the Windows shell (IShellLinkW in ole32)
  async fn() {
    const tmp = await tempDir("sfx-shortcut-");
    try {
      const install = await sfxDir(tmp);
      await Deno.writeTextFile(join(install, "my-app.exe"), "");
      const appData = join(tmp, "roaming");
      const { lnk } = sfxShortcutPaths(install, appData, HOSTILE);
      const { log, lines } = said();
      const start = () =>
        ensureSfxShortcut({ install, log, build: { title: HOSTILE }, appData });
      start();
      assertEquals(lines.map((l) => l.slice(0, 5)), ["info:"], lines.join());
      // Never the user's real Start menu: under this test's own folder.
      assert(lnk.startsWith(tmp + "\\"), lnk);
      assert(
        [...Deno.readDirSync(dirname(lnk))].some((e) =>
          e.name === `${shortcutFileName(HOSTILE)}.lnk`
        ),
        "the .lnk is not there under its own name",
      );
      assertEquals(await readLnk(lnk), {
        target: join(install, "my-app.exe"),
        dir: install,
      });
      await Deno.remove(lnk);
      start();
      assert(!await exists(lnk), "put back a shortcut the user removed");
      // An existing file is replaced, a folder that cannot hold one is said.
      writeLnk(join(tmp, "again.lnk"), join(install, "my-app.exe"), install);
      writeLnk(join(tmp, "again.lnk"), join(install, "my-app.exe"), install);
      assertThrows(
        () => writeLnk(join(tmp, "no", "such.lnk"), "C:\\x.exe", "C:\\"),
        Error,
        "Save failed (0x",
      );
    } finally {
      await dropTempDir(tmp);
    }
  },
});

Deno.test({
  name:
    "Windows: the real one-click .exe and the app agree — its shortcut is the one the app looks for, and is never made twice",
  ignore: Deno.build.os !== "windows", // runs the stub PE, a Windows program
  async fn() {
    const tmp = await tempDir("sfx-shortcut-");
    try {
      // An app whose program only exits: Windows' own `whoami.exe`.
      const stage = join(tmp, "app");
      await Deno.mkdir(join(stage, "electron"), { recursive: true });
      await Deno.copyFile(
        join(Deno.env.get("SystemRoot")!, "System32", "whoami.exe"),
        join(stage, "my-app.exe"),
      );
      await Deno.writeTextFile(join(stage, "electron", "electron.exe"), "e");
      const payloadPath = join(tmp, "payload.tar.zst");
      await packAppDirTarZstd(stage, payloadPath);
      const exe = join(tmp, "my-app-win-x64.exe");
      await writeWindowsSfxExe({
        stubPath: await ensureWindowsSfxStub(),
        payloadPath,
        payloadFormat: "tar.zstd",
        outPath: exe,
        binaryName: "my-app",
        archStr: "x64",
        version: "1.0.0",
        title: HOSTILE,
        shortcut: true,
      });
      // Its whole world is this test's folder.
      const appData = join(tmp, "roaming");
      const local = join(tmp, "local");
      await Deno.mkdir(appData);
      // Opened with `--aio-sfx-wait`: the stub then returns when the app it
      // started has EXITED. A plain open returns as soon as the app is
      // started, and the install that follows found it still running under
      // load — "my-app is running … Access is denied", refused as it must be.
      const open = async (file = exe, args = ["--aio-sfx-wait"]) => {
        const ran = await new Deno.Command(file, {
          args,
          env: { APPDATA: appData, LOCALAPPDATA: local },
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(ran.success, new TextDecoder().decode(ran.stderr));
      };
      await open();
      const install = join(local, "aio-sfx", "my-app", "win-x64");
      const paths = sfxShortcutPaths(install, appData, HOSTILE);
      assert(await exists(paths.target), "the stub installed elsewhere");
      // What the stub made is exactly what the app computes: name and place…
      assertEquals(
        [...Deno.readDirSync(dirname(paths.lnk))].map((e) => e.name),
        [`${shortcutFileName(HOSTILE)}.lnk`],
      );
      // …target and working directory.
      assertEquals(await readLnk(paths.lnk), {
        target: paths.target,
        dir: paths.dir,
      });
      // So the app finds it, records it and writes nothing…
      const { log, lines } = said();
      const start = () =>
        ensureSfxShortcut({
          install,
          log,
          build: { title: HOSTILE },
          appData,
          write: () => {
            throw new Error("a second shortcut for one app");
          },
        });
      // The `.exe` recorded the shortcut it made, as the app would have — an
      // app without `updates` never runs the app's side.
      assertEquals(
        await Deno.readTextFile(install + SFX_SHORTCUT_RECORD),
        `${paths.lnk}\n`,
      );
      start();
      // …and the user's removal holds.
      await Deno.remove(paths.lnk);
      start();
      assertEquals(lines, []);
      assert(!await exists(paths.lnk));
      // Opening the `.exe` again installs nothing, so it adds nothing…
      await open();
      assert(!await exists(paths.lnk), "the .exe put back a removed shortcut");
      // …and neither does an upgrade: another version's `.exe` installs over
      // this one (as `am upgrade` runs it) and leaves the removal alone.
      await Deno.writeTextFile(join(stage, "new-in-1.1.0"), "x");
      const nextPayload = join(tmp, "payload-next.tar.zst");
      await packAppDirTarZstd(stage, nextPayload);
      const next = join(tmp, "my-app-next-win-x64.exe");
      await writeWindowsSfxExe({
        stubPath: await ensureWindowsSfxStub(),
        payloadPath: nextPayload,
        payloadFormat: "tar.zstd",
        outPath: next,
        binaryName: "my-app",
        archStr: "x64",
        version: "1.1.0",
        title: HOSTILE,
        shortcut: true,
      });
      await open(next, ["--aio-sfx-install"]);
      assert(await exists(join(install, "new-in-1.1.0")), "nothing upgraded");
      assert(!await exists(paths.lnk), "an upgrade put back a removed one");
      await open(exe, ["--aio-sfx-install"]); // …nor does going back
      assert(!await exists(join(install, "new-in-1.1.0")), "did not go back");
      assert(!await exists(paths.lnk), "a downgrade put back a removed one");
      // …and the open that installs the app again is the one that adds it.
      await Deno.remove(install, { recursive: true });
      await open();
      assert(await exists(paths.lnk), "installing again added no shortcut");
    } finally {
      await dropTempDir(tmp);
    }
  },
});

// WHO adds the shortcut: the `.exe`, when it installs — opened or run with
// `--aio-sfx-install` (how `am upgrade` and `run.ps1 -NoRun` run it, with
// nothing started). The app adds one only to an install whose `.exe` did not.
// So an install-only into a fresh profile has its shortcut before any start —
// unless the build said `build.windows.shortcut: false`.
Deno.test({
  name:
    "Windows: --aio-sfx-install into a fresh profile leaves the Start-menu shortcut, starting nothing — none when the build opted out",
  ignore: Deno.build.os !== "windows", // runs the stub PE, a Windows program
  async fn() {
    const tmp = await tempDir("sfx-shortcut-");
    try {
      const stage = join(tmp, "app");
      await Deno.mkdir(join(stage, "electron"), { recursive: true });
      await Deno.copyFile(
        join(Deno.env.get("SystemRoot")!, "System32", "whoami.exe"),
        join(stage, "my-app.exe"),
      );
      await Deno.writeTextFile(join(stage, "electron", "electron.exe"), "e");
      const payloadPath = join(tmp, "payload.tar.zst");
      await packAppDirTarZstd(stage, payloadPath);
      for (const shortcut of [true, false]) {
        const exe = join(tmp, `my-app-${shortcut}.exe`);
        await writeWindowsSfxExe({
          stubPath: await ensureWindowsSfxStub(),
          payloadPath,
          payloadFormat: "tar.zstd",
          outPath: exe,
          binaryName: "my-app",
          archStr: "x64",
          version: "1.0.0",
          title: "My App",
          ...(shortcut ? { shortcut } : {}),
        });
        // A profile nothing was ever installed into: no Start Menu folder.
        const appData = join(tmp, `roaming-${shortcut}`);
        const local = join(tmp, `local-${shortcut}`);
        const ran = await new Deno.Command(exe, {
          args: ["--aio-sfx-install"],
          env: { APPDATA: appData, LOCALAPPDATA: local },
          stdout: "piped",
          stderr: "piped",
        }).output();
        const err = new TextDecoder().decode(ran.stderr);
        assertEquals(ran.code, 0, err);
        const install = join(local, "aio-sfx", "my-app", "win-x64");
        const paths = sfxShortcutPaths(install, appData, "My App");
        assert(await exists(paths.target), "nothing was installed");
        assertEquals(await exists(paths.lnk), shortcut, err);
        if (shortcut) {
          assertEquals(await readLnk(paths.lnk), {
            target: paths.target,
            dir: paths.dir,
          });
        }
      }
    } finally {
      await dropTempDir(tmp);
    }
  },
});

// A shortcut the `.exe` could not add is said where that run's failures are
// said (stderr under `--aio-sfx-install`; the message box of a plain open),
// the app is installed all the same, and nothing is recorded — so the app's
// own start still adds it.
Deno.test({
  name:
    "Windows: a shortcut the .exe cannot add is said, fails nothing and is left for the app to add",
  ignore: Deno.build.os !== "windows", // runs the stub PE, a Windows program
  async fn() {
    const tmp = await tempDir("sfx-shortcut-");
    try {
      const stage = join(tmp, "app");
      await Deno.mkdir(join(stage, "electron"), { recursive: true });
      await Deno.copyFile(
        join(Deno.env.get("SystemRoot")!, "System32", "whoami.exe"),
        join(stage, "my-app.exe"),
      );
      await Deno.writeTextFile(join(stage, "electron", "electron.exe"), "e");
      const payloadPath = join(tmp, "payload.tar.zst");
      await packAppDirTarZstd(stage, payloadPath);
      const exe = join(tmp, "my-app-win-x64.exe");
      await writeWindowsSfxExe({
        stubPath: await ensureWindowsSfxStub(),
        payloadPath,
        payloadFormat: "tar.zstd",
        outPath: exe,
        binaryName: "my-app",
        archStr: "x64",
        version: "1.0.0",
        title: "My App",
        shortcut: true,
      });
      // A Start Menu that cannot be made: its parent is a file.
      const blocked = join(tmp, "a-file");
      await Deno.writeTextFile(blocked, "");
      const local = join(tmp, "local");
      const ran = await new Deno.Command(exe, {
        args: ["--aio-sfx-install"],
        env: { APPDATA: blocked, LOCALAPPDATA: local },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const err = new TextDecoder().decode(ran.stderr);
      assertEquals(ran.code, 0, err);
      assert(err.includes("aio SFX: no Start-menu shortcut: "), err);
      const install = join(local, "aio-sfx", "my-app", "win-x64");
      assert(await exists(join(install, "my-app.exe")), "nothing installed");
      assert(!await exists(install + SFX_SHORTCUT_RECORD), "recorded a miss");
      const appData = join(tmp, "roaming");
      const { log } = said();
      const lnk = ensureSfxShortcut({
        install,
        log,
        build: { title: "My App" },
        appData,
      });
      assertEquals(lnk, sfxShortcutPaths(install, appData, "My App").lnk);
      assert(await exists(lnk!));
    } finally {
      await dropTempDir(tmp);
    }
  },
});

Deno.test("appUserModelId: the app and the one-click .exe give one title the same id (shortcut-names.json)", async () => {
  const ids: [string, string][] = JSON.parse(
    await Deno.readTextFile(join(windowsSfxStubDir(), "shortcut-names.json")),
  ).ids;
  assert(ids.length > 5);
  for (const [title, id] of ids) assertEquals(appUserModelId(title), id, title);
});

// The window runs under an AppUserModelID (its title); a Start-menu shortcut
// without the same one is another app to the shell. Measured on Windows 11
// (2026-10-24): the running window's taskbar button read "Electron - 1
// running window" — and a pin of it starts bare Electron; with the id on the
// shortcut, "<title> - 1 running window".
Deno.test("alignShortcutAumid: the recorded shortcut gets the window's id; nothing else is touched", async () => {
  const tmp = await tempDir("sfx-aumid-");
  try {
    const install = join(tmp, "aio-sfx", "my-app", "win-x64");
    await Deno.mkdir(install, { recursive: true });
    const seen: { lnk: string; o: unknown }[] = [];
    const link = ((lnk: string, o: unknown) => (
      seen.push({ lnk, o }), { before: "", saved: true }
    )) as never;
    const align = (title: string | undefined, os = "windows") =>
      alignShortcutAumid({ install, title, os, appData: tmp, link });
    // Off Windows, no title, or no shortcut there: nothing.
    assertEquals(align("My App", "linux"), "kept");
    assertEquals(align("  \n "), "kept");
    assertEquals(align("My App"), "kept");
    assertEquals(seen, []);
    // The shortcut where the `.exe` puts it.
    const { lnk } = sfxShortcutPaths(install, tmp, "My App");
    await Deno.mkdir(dirname(lnk), { recursive: true });
    await Deno.writeTextFile(lnk, "");
    assertEquals(align("My\tApp "), "kept", "named after another title");
    assertEquals(align("My App"), "set");
    assertEquals(seen, [{ lnk, o: { load: true, aumid: "My App" } }]);
    // The one on record wins over the default place.
    const moved = join(tmp, "elsewhere.lnk");
    await Deno.writeTextFile(moved, "");
    await Deno.writeTextFile(install + SFX_SHORTCUT_RECORD, `${moved}\n`);
    assertEquals(align("My App"), "set");
    assertEquals(seen[1]!.lnk, moved);
    // A failure is said, never thrown.
    const broken = alignShortcutAumid({
      install,
      title: "My App",
      os: "windows",
      link: (() => {
        throw new Error("Load failed (0x80070002)");
      }) as never,
    });
    assertEquals(broken, `${moved}: Load failed (0x80070002)`);
    // One id, the window's: mainScriptAumid's rule.
    assertEquals(appUserModelId(" a\u0001b "), "a b");
    assertEquals(appUserModelId("x".repeat(400)).length, 128);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test({
  name:
    "Windows: a shortcut written without an AppUserModelID is given the window's, keeping where it points",
  ignore: Deno.build.os !== "windows",
  async fn() {
    const tmp = await tempDir("sfx-aumid-real-");
    try {
      const install = join(tmp, "aio-sfx", "my-app", "win-x64");
      await Deno.mkdir(install, { recursive: true });
      const lnk = join(tmp, "Start", "My App.lnk");
      await Deno.mkdir(dirname(lnk));
      writeLnk(lnk, join(install, "my-app.exe"), install);
      await Deno.writeTextFile(install + SFX_SHORTCUT_RECORD, `${lnk}\n`);
      const align = () => alignShortcutAumid({ install, title: "My App" });
      assertEquals(align(), "set");
      // Read back by the shell: the second look finds it already there.
      assertEquals(align(), "kept");
      assertEquals(await readLnk(lnk), {
        target: join(install, "my-app.exe"),
        dir: install,
      });
      assertEquals(
        alignShortcutAumid({ install, title: "Renamed" }),
        "set",
        "a new title is a new id",
      );
    } finally {
      await dropTempDir(tmp);
    }
  },
});
