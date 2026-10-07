// Convention guard: a child the framework starts for itself does not sit in
// the install folder.
//
// Windows refuses to move a folder that is some process's working directory.
// A desktop app's working directory IS its install folder, a child inherits
// it, and the in-app update moves that folder. Measured on Windows 11: one
// helper child (a `PING.EXE` left behind by the hidden-console start) held
// the folder for 30 s after every app start, and an update taken in that
// time failed — "the running version could not be moved aside".
//
// The rule has one home: `neutralCwd()` in src/server/no-console.ts. Every
// spawn site in the runtime folders either passes it as `cwd`, or is listed
// below with the reason it must not. A new spawn site that does neither turns
// this red — so the choice is made on purpose, not inherited by accident.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolve as winResolve } from "@std/path/windows";
import { _fromHere, _openSpec } from "../src/server/open-external.ts";
import {
  electronStderrTail,
  launchElectron,
  packagedCwd,
} from "../src/electron/electron-spawn.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { EXE, writeProgram } from "./fake-program-helper.ts";

const ROOTS = ["src/server", "src/electron", "src/media"];
const SPAWN = /new Deno\.Command\(|symbols\.CreateProcessW\(|child_process/g;

/** [file, how the site begins, sites expected, why it keeps its own cwd]. */
const KEEPS_ITS_CWD: [string, string, number, string][] = [
  // ── the cwd IS the contract ────────────────────────────────────────────
  [
    "src/server/spawn.ts",
    "new Deno.Command(spec.cmd",
    1,
    "the app's own spawn(): its cwd is `opts.cwd`, the caller's to choose",
  ],
  [
    "src/server/spawn.ts",
    "new Deno.Command(cmd",
    1,
    "the app's own spawn() on Windows: `opts.cwd`, the caller's to choose",
  ],
  [
    "src/media/ffmpeg.ts",
    "new Deno.Command(bin",
    1,
    "the app's encoder child: piped, and ended with the encode",
  ],
  [
    "src/server/updates-apply.ts",
    "new Deno.Command(cmd, o)",
    1,
    "the relaunch: the SUCCESSOR app keeps the working directory the app had",
  ],
  [
    "src/server/updates-apply.ts",
    "new Deno.Command(c, o)",
    1,
    "the swap helper: its cwd is the install's PARENT, from `_swapSpec` " +
    "(pinned by tests/updates-swap-windows.test.ts)",
  ],
  [
    "src/server/updates-apply.ts",
    "new Deno.Command(a.path",
    1,
    "the probe worker's text: `cwd: a.cwd`, and the caller posts " +
    "`cwd: neutralCwd()` (asserted below)",
  ],
  [
    "src/server/no-console.ts",
    "symbols.CreateProcessW(",
    2,
    "raw CreateProcessW: the hidden-console helper passes " +
    "`hiddenConsoleHelper().cwd`, the swap helper its caller's `cwd` " +
    "(both pinned by tests/no-console.test.ts)",
  ],
  [
    "src/server/pick-path.ts",
    "new Deno.Command(spec.cmd",
    1,
    "a native dialog with no start folder opens where the app is; awaited, " +
    "and ended with the app",
  ],
  // ── runs git where its caller says ─────────────────────────────────────
  [
    "src/server/updates-check.ts",
    'new Deno.Command("git"',
    2,
    "git for a repository source: `cwd` is the caller's (the config it reads)",
  ],
  [
    "src/server/updates-rebuild.ts",
    "new Deno.Command(cmd",
    1,
    "the rebuild's git/deno steps run IN the clone they build",
  ],
  [
    "src/server/app-version.ts",
    'new Deno.Command("git"',
    1,
    "the version stamp of a source checkout: `git -C <root>`, bounded",
  ],
  // ── never on a Windows desktop install ─────────────────────────────────
  [
    "src/server/nested-display.ts",
    'new Deno.Command("Xephyr"',
    1,
    "Linux only (a nested X server for tests)",
  ],
  [
    "src/server/dev-restart.ts",
    "new Deno.Command(Deno.execPath()",
    1,
    "the dev supervisor: a source run, never an installed app",
  ],
  [
    "src/server/lock-coverage.ts",
    "new Deno.Command(Deno.execPath()",
    1,
    "a build-time lockfile check, never an installed app",
  ],
  [
    "src/server/updates-apply.ts",
    'new Deno.Command("codesign"',
    1,
    "macOS only",
  ],
  ["src/server/updates-apply.ts", 'new Deno.Command("tar"', 1, "macOS only"],
  [
    "src/server/single-instance-lock.ts",
    'new Deno.Command("netstat"',
    1,
    "macOS only, synchronous",
  ],
  [
    "src/server/single-instance-lock.ts",
    "new Deno.Command(cmd",
    1,
    "macOS only (`ps`, bounded by perl), synchronous",
  ],
  [
    "src/server/single-instance-lock.ts",
    'new Deno.Command("pgrep"',
    1,
    "POSIX only: Windows has no pgrep, and the NotFound is the answer",
  ],
  [
    "src/electron/electron-spawn.ts",
    'new Deno.Command("unshare"',
    1,
    "Linux only (the user-namespace probe)",
  ],
  [
    "src/electron/electron-shared.ts",
    "child_process",
    1,
    "Linux only (a dbus-send from the window's main process)",
  ],
  // ── short, awaited, ended with the app ─────────────────────────────────
  [
    "src/server/spawn.ts",
    'new Deno.Command("taskkill"',
    1,
    "awaited to its end inside kill()",
  ],
  [
    "src/electron/electron-spawn.ts",
    "new Deno.Command(plan.cmd",
    1,
    "taskkill, synchronous",
  ],
  [
    "src/electron/electron-spawn.ts",
    "new Deno.Command(Deno.execPath()",
    1,
    "the Electron runtime installer: `cwd` is its caller's, awaited",
  ],
];

function* sourceFiles(dir: string): Generator<string> {
  for (const e of Deno.readDirSync(dir)) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) yield* sourceFiles(path);
    else if (e.isFile && path.endsWith(".ts")) yield path;
  }
}

/** The call that starts at `at`, to its closing parenthesis. Strings are
 *  walked over, so a `)` inside one does not end the call. */
function callText(src: string, at: number): string {
  const open = src.indexOf("(", at);
  if (open < 0) return src.slice(at, at + 40);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

const isComment = (src: string, at: number) =>
  /^\s*(\/\/|\*|\/\*)/.test(src.slice(src.lastIndexOf("\n", at) + 1, at + 1));

Deno.test("spawn sites: every child takes neutralCwd(), or says why it keeps the app's working directory", () => {
  const seen = new Map<string, number>();
  const offenders: string[] = [];
  let neutral = 0, files = 0;
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      files++;
      const src = Deno.readTextFileSync(file);
      for (const m of src.matchAll(SPAWN)) {
        if (isComment(src, m.index!)) continue;
        const call = callText(src, m.index!);
        if (call.includes("neutralCwd(")) {
          neutral++;
          continue;
        }
        const i = KEEPS_ITS_CWD.findIndex(([f, starts]) =>
          f === file && call.startsWith(starts)
        );
        if (i < 0) {
          const line = src.slice(0, m.index!).split("\n").length;
          offenders.push(`${file}:${line}  ${call.split("\n")[0]}`);
        } else seen.set(String(i), (seen.get(String(i)) ?? 0) + 1);
      }
    }
  }
  // The walk must actually read the tree.
  assert(files > 100, `only ${files} files were read`);
  assertEquals(
    offenders,
    [],
    "a child started with the app's working directory holds the install " +
      "folder on Windows, and an update cannot move it — pass " +
      "`cwd: neutralCwd()` (src/server/no-console.ts), or list the site in " +
      "KEEPS_ITS_CWD with the reason it must not",
  );
  // An entry that matches nothing (or fewer sites than it names) is stale:
  // the site it excused moved or went, and the list must say what is there.
  assertEquals(
    KEEPS_ITS_CWD.map(([f, starts, n], i) =>
      [`${f}  ${starts}`, seen.get(String(i)) ?? 0, n] as const
    ).filter(([, got, want]) => got !== want),
    [],
  );
  // …and the walk recognises a site that takes the rule (the update's
  // unpack, the taskkill that ends a stalled git, openExternal, the window).
  assert(neutral >= 4, `${neutral} sites pass neutralCwd()`);
});

Deno.test("spawn sites: the update's probe worker is handed neutralCwd() and uses it", () => {
  const src = Deno.readTextFileSync("src/server/updates-apply.ts");
  assert(
    src.includes(
      "w.postMessage({ path, args, timeoutMs, cwd: neutralCwd() });",
    ),
    "probeOffThread no longer posts the neutral working directory",
  );
  assert(
    /new Deno\.Command\(a\.path, \{\s*args: a\.args, cwd: a\.cwd,/.test(src),
    "the probe worker no longer starts its child in the posted directory",
  );
});

// ── what the app OPENS ────────────────────────────────────────────────────
// A program opened for the user (a browser, a file's viewer) stays open after
// the app is gone, with the working directory of whatever started it.

Deno.test("openExternal: a path goes out absolute, decided in the app's working directory — anything else as given", () => {
  const HERE = "C:\\Apps\\Notes";
  const there = new Set([`${HERE}\\docs\\a b.txt`, HERE, "C:\\Apps"]);
  const fromHere = (t: string) =>
    _fromHere(t, (p) => winResolve(HERE, p), (p) => there.has(p));
  assertEquals(
    [
      "docs\\a b.txt", // a file beside the app
      ".\\docs/a b.txt",
      ".", // "show the app's folder"
      "..",
      "notepad", // a program the shell finds: nothing by that name is here
      "docs\\missing.txt",
      "C:\\Apps\\Notes\\docs\\a b.txt", // absolute already
      "https://example.com/?a=1&b=2",
      "mailto:someone@example.com",
      "ms-settings:display",
    ].map(fromHere),
    [
      `${HERE}\\docs\\a b.txt`,
      `${HERE}\\docs\\a b.txt`,
      HERE,
      "C:\\Apps",
      "notepad",
      "docs\\missing.txt",
      "C:\\Apps\\Notes\\docs\\a b.txt",
      "https://example.com/?a=1&b=2",
      "mailto:someone@example.com",
      "ms-settings:display",
    ],
  );
  // A URL is never looked for on disk, whatever is there.
  assertEquals(
    _fromHere("https://example.com/x", (p) => winResolve(HERE, p), () => true),
    "https://example.com/x",
  );
  // A name with a colon after ONE letter is a drive, not a scheme.
  assertEquals(
    _fromHere("D:docs", () => "D:\\work\\docs", () => true),
    "D:\\work\\docs",
  );
  // The Windows launcher is handed the absolute one; the others open
  // relative to the working directory they keep.
  assertEquals(
    _openSpec("windows", "docs\\a b.txt", fromHere).env,
    { AIO_OPEN_TARGET: `${HERE}\\docs\\a b.txt` },
  );
  for (const os of ["linux", "darwin"] as const) {
    assertEquals(_openSpec(os, "docs/a.txt", () => "/never").args, [
      "docs/a.txt",
    ]);
  }
});

Deno.test("the window: an installed app's runs outside the install, a source run's where it was started", () => {
  assertEquals(packagedCwd("C:\\Windows", true), "C:\\Windows");
  assertEquals(packagedCwd("C:\\Windows", false), undefined);
  // No neutral directory on this OS: nothing to move it to.
  assertEquals(packagedCwd(undefined, true), undefined);
});

Deno.test("the window: what it opens starts from the window's own working directory, and its script never reads that directory", () => {
  // Electron's shell starts a program with the main process's working
  // directory. Each site is in the window's main script — nowhere else.
  const opens = new Map<string, number>();
  let bare = 0, told = 0;
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      const src = Deno.readTextFileSync(file);
      const n = [...src.matchAll(/shell\.(openExternal|openPath)\(/g)]
        .filter((m) => !isComment(src, m.index!)).length;
      if (n > 0) opens.set(file, n);
      if (!file.startsWith("src/electron/")) continue;
      // …and with that directory neutral, the script asks for the APP's:
      // the one the launcher hands it.
      for (const m of src.matchAll(/process\.cwd\(\)/g)) {
        if (isComment(src, m.index!)) continue;
        const asked = "(process.env.AIO_APP_CWD || ";
        if (src.slice(m.index! - asked.length, m.index!) === asked) told++;
        else bare++;
      }
    }
  }
  assertEquals(Object.fromEntries(opens), {
    // The connect-mode window: an http(s) link a page opens, nothing else.
    "src/electron/electron-client-script.ts": 1,
    "src/electron/electron-shared.ts": 3,
    "src/electron/electron-uds.ts": 1,
  });
  assertEquals([bare, told], [0, 3]);
});

Deno.test({
  name:
    "the window: it is told the app's working directory, and a source run starts it there",
  fn: async () => {
    const dir = await tempDir("el-window-cwd-");
    const had = Deno.env.get("ELECTRON_PATH");
    try {
      const report = join(dir, "report");
      const fake = join(dir, "electron" + EXE);
      // What it was told, and where it was started — written by a program
      // every OS has (the fake itself has no `pwd`).
      await writeProgram(
        fake,
        `#!/bin/sh\nexec "${Deno.execPath()}" eval "Deno.writeTextFileSync(` +
          `Deno.args[0], Deno.env.get('AIO_APP_CWD') + String.fromCharCode(10)` +
          ` + Deno.cwd() + String.fromCharCode(10))" "${report}"\n`,
      );
      Deno.env.set("ELECTRON_PATH", fake);
      const lines: string[] = [];
      const log = {
        info: (m: string) => lines.push(m),
        error: (m: string) => lines.push(m),
      };
      const proc = await launchElectron("http://127.0.0.1:1/", log, {
        title: "cwd",
      });
      assert(proc, `no window was launched: ${lines.join(" | ")}`);
      await proc.status;
      await electronStderrTail(proc, 5000);
      assertEquals(
        (await Deno.readTextFile(report)).trim().split("\n"),
        [Deno.cwd(), Deno.cwd()],
      );
    } finally {
      if (had === undefined) Deno.env.delete("ELECTRON_PATH");
      else Deno.env.set("ELECTRON_PATH", had);
      await dropTempDir(dir);
    }
  },
});
