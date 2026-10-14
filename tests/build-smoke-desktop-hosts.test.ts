// `build --smoke` drove a desktop artifact on a Linux host only: on Windows
// and macOS the row read "not smoke-tested here: the desktop smoke drives a
// Linux AppImage", so the first person to start the package there was a
// user. Each host starts the artifact that runs WITHOUT installing: the
// AppImage, the Windows zip's program, the program inside the macOS bundle.
//
// On Windows and macOS that is a real window on the desktop, and a build with
// `--smoke` / `"smoke": true` that 1.0.19 passed there (the row was skipped)
// may not start opening one — or failing — because aio was upgraded. So there
// it is asked for by name: `--smoke=desktop` / `"smoke": "desktop"`
// (`--smoke=strict` includes it: a skipped row always failed a strict build).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  descendantsIn,
  desktopEnv,
  plistExecutable,
  processRows,
  smokeBuild,
  type SmokeMode,
  smokeMode,
  smokePlan,
  smokeWindow,
  unpackDesktop,
} from "../src/build/smoke.ts";
import { electronProfileDir } from "../src/electron/electron-spawn.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const plan = (hostOs: string, files: string[], window = true) =>
  smokePlan({
    kind: "electron",
    platform: "p",
    hostPlatform: "p",
    hostOs,
    files,
    window,
  });

const ELECTRON = {
  target: "electron",
  kind: "electron",
  platform: "p",
  entry: "src/app.ts",
} as const;
const PACKAGES: Record<string, string[]> = {
  linux: ["a-x86_64.AppImage"],
  windows: ["a-1.2.3-win-x64.exe", "a-1.2.3-win-x64.zip"],
  darwin: ["a-mac-arm64.dmg", "a-mac-arm64.app.tar.gz"],
};

Deno.test("smoke: plain --smoke / `smoke: true` on a Windows or macOS host lists the desktop artifact and does not start it, as on 1.0.19 — `desktop` and `strict` start it", async () => {
  assertEquals(smokeMode({ bare: false, value: "desktop" }, false), "desktop");
  assertEquals(smokeMode({ bare: false }, "desktop"), "desktop");
  assertEquals(smokeMode({ bare: true }, "desktop"), true, "the flag wins");
  assertEquals(
    [false, true, "desktop", "strict"].map((m) => smokeWindow(m as SmokeMode)),
    [false, false, true, true],
  );

  const root = await tempDir("aio-smoke-hosts-");
  const real = { log: console.log, warn: console.warn, error: console.error };
  const said: string[] = [];
  console.log = console.warn = console.error = (...a: unknown[]) => {
    said.push(a.map(String).join(" "));
  };
  /** Did the build start the desktop artifact, and its exit code. */
  const build = async (hostOs: string, mode: SmokeMode) => {
    said.length = 0;
    let started = false;
    const code = await smokeBuild({
      root,
      outDir: join(root, "dist"),
      mode,
      hostPlatform: "p",
      hostOs,
      targets: [{ ...ELECTRON, files: PACKAGES[hostOs]! }],
      // The window comes up broken: a build that STARTS it fails.
      run: () => {
        started = true;
        return Promise.resolve(["the window never opened"]);
      },
    });
    return { started, code, out: said.join("\n") };
  };
  try {
    for (const os of ["windows", "darwin"]) {
      // 1.0.19, measured on its tree: `smokePlan` answers a skip for an
      // electron target on any host but Linux, so nothing is started and
      // the build's exit code is 0.
      const plain = await build(os, true);
      assertEquals([plain.started, plain.code], [false, 0], os);
      assert(/– electron\s+not smoke-tested/.test(plain.out), plain.out);
      // …and the row names how to run it.
      assert(plain.out.includes("--smoke=desktop"), plain.out);
      assert(plain.out.includes('"smoke": "desktop"'), plain.out);
      for (const mode of ["desktop", "strict"] as const) {
        const asked = await build(os, mode);
        assertEquals([asked.started, asked.code], [true, 1], `${os} ${mode}`);
      }
    }
    // Linux has a nested display: every mode runs it there, as it did.
    assertEquals((await build("linux", true)).started, true);
  } finally {
    Object.assign(console, real);
    await dropTempDir(root);
  }
});

Deno.test("smoke plan: each host OS starts its own desktop package", () => {
  assertEquals(plan("linux", ["a-x86_64.AppImage"]), {
    run: "electron",
    file: "a-x86_64.AppImage",
    page: true,
  });
  // Windows: the zip — never the one-click .exe beside it, which installs
  // itself and exits once the app is started.
  assertEquals(
    plan("windows", ["a-1.2.3-win-x64.exe", "a-1.2.3-win-x64.zip"]),
    { run: "electron", file: "a-1.2.3-win-x64.zip", page: true },
  );
  // macOS: the bundle tarball — never the disk image.
  assertEquals(
    plan("darwin", ["a-mac-arm64.dmg", "a-mac-arm64.app.tar.gz"]),
    { run: "electron", file: "a-mac-arm64.app.tar.gz", page: true },
  );
});

Deno.test("smoke plan: a host whose package is missing is NAMED with what it looked for", () => {
  const skip = (p: ReturnType<typeof plan>) => "skip" in p ? p.skip : "";
  assert(
    skip(plan("windows", ["a-win-x64.exe"])).includes("no Windows .zip"),
  );
  assert(skip(plan("darwin", ["a-mac-arm64.dmg"])).includes("no .app.tar.gz"));
  // Another OS's package on this host is not this host's.
  assert(skip(plan("darwin", ["a.AppImage", "a-win-x64.zip"])) !== "");
  assert(skip(plan("windows", ["a-mac-arm64.app.tar.gz"])) !== "");
  // Linux, and an OS with no desktop package at all: the old sentence.
  for (const os of ["linux", "freebsd"]) {
    assertEquals(
      skip(plan(os, ["a-win-x64.zip"])),
      "not smoke-tested here: the desktop smoke drives a Linux AppImage " +
        `(this host: ${os})`,
    );
  }
});

Deno.test("desktop env: the window's profile never lands in the developer's own", () => {
  const box = join("/b", "x");
  const cfg = join(box, "config");
  assertEquals(desktopEnv("linux", box), { APPIMAGE_EXTRACT_AND_RUN: "1" });
  // Windows: the profile ROOT moves. `%APPDATA%` alone leaves a real window's
  // `userData` in the developer's roaming folder (measured, Electron 44).
  const win = desktopEnv("windows", box);
  assertEquals(win, {
    USERPROFILE: cfg,
    APPDATA: join(cfg, "AppData", "Roaming"),
    LOCALAPPDATA: join(cfg, "AppData", "Local"),
  });
  // …and where aio itself looks for that profile (`%APPDATA%`) is where the
  // shell puts it (`%USERPROFILE%\AppData\Roaming`): the two only part when
  // someone overrides `APPDATA` alone — which is why this never does.
  assertEquals(
    electronProfileDir("p", "windows", (k) => win[k]),
    join(win.USERPROFILE!, "AppData", "Roaming", "p"),
  );
  // …and a bundle outside /Applications must not offer to move itself there.
  assertEquals(desktopEnv("darwin", box), {
    HOME: cfg,
    CFFIXED_USER_HOME: cfg,
    AIO_MOVE_TO_APPLICATIONS: "never",
  });
});

Deno.test("process tree: every descendant, shallowest first — and only this tree's", () => {
  // [pid, parent, born]
  const table = [
    [10, 1, 100],
    [11, 10, 110],
    [12, 10, 120],
    [13, 11, 130],
    [20, 1, 100],
    [21, 20, 140],
  ] as const;
  assertEquals(descendantsIn(10, table), [11, 12, 13]);
  assertEquals(descendantsIn(13, table), []);
  // A pid table can hold a cycle (a reused parent pid): it ends.
  assertEquals(descendantsIn(1, [[2, 1, 5], [1, 2, 5]]), [2]);
});

// Windows never re-parents and hands pids out again: a process whose parent
// DIED keeps that parent's pid, and the next process to get the number is no
// relation. Counted by parent pid alone, such a stranger "was left running"
// by the smoked app — and was killed.
Deno.test("process tree: a process OLDER than the one holding its parent's pid is not its child", () => {
  const table = [
    [500, 4, 1000], // the smoked app, started at 1000 — pid 500 was reused
    [77, 500, 200], // the user's program: its long-dead parent was pid 500
    [78, 77, 250], // …and that program's own child
    [501, 500, 1010], // the app's real child
    [502, 501, 1020],
    [503, 500, 1000], // created in the same tick as its parent: a child
    [90, 500, NaN], // no creation time: proves nothing
  ] as const;
  assertEquals(descendantsIn(500, table), [501, 503, 502]);
  // The rule holds at every level, not only under the root.
  assertEquals(
    descendantsIn(500, [[500, 4, 1000], [501, 500, 1010], [60, 501, 900]]),
    [501],
  );
  // The root itself unknown (already gone, or unreadable): nobody is tied.
  assertEquals(descendantsIn(500, [[501, 500, 1010]]), []);
});

Deno.test("process tree: the Windows listing is read with its creation time", () => {
  assertEquals(
    processRows(
      "0 0 \r\n4 0 638000000000000000\r\n500 4 638000000000001000\r\n" +
        "501 500 638000000000002000\r\n88 4 \r\njunk\r\n",
    ).map(([p, parent, born]) => [p, parent, Number.isNaN(born)]),
    [[500, 4, false], [501, 500, false], [88, 4, true]],
  );
});

Deno.test("bundle: the program is the one its Info.plist names", () => {
  assertEquals(
    plistExecutable(
      "<dict>\n<key>CFBundleExecutable</key>\n  <string>my-app</string>\n</dict>",
    ),
    "my-app",
  );
  assertEquals(plistExecutable("<dict></dict>"), null);
});

async function tarGz(dir: string, out: string, ...names: string[]) {
  const o = await new Deno.Command("tar", {
    args: ["-czf", out, "-C", dir, ...names],
    stderr: "piped",
  }).output();
  assert(o.success, new TextDecoder().decode(o.stderr));
}

Deno.test("macOS package: unpacked beside nothing of the user's, started from Contents/MacOS", async () => {
  const dir = await tempDir("smoke-mac-pkg-");
  try {
    const app = join(dir, "src", "My App.app", "Contents");
    await Deno.mkdir(join(app, "MacOS"), { recursive: true });
    await Deno.writeTextFile(
      join(app, "Info.plist"),
      "<plist><dict><key>CFBundleExecutable</key><string>myapp</string></dict></plist>",
    );
    await Deno.writeTextFile(join(app, "MacOS", "myapp"), "#!/bin/sh\n");
    const pkg = join(dir, "myapp-mac-arm64.app.tar.gz");
    await tarGz(join(dir, "src"), pkg, "My App.app");
    const into = join(dir, "box", "app");
    assertEquals(
      await unpackDesktop(pkg, into, "darwin"),
      join(into, "My App.app", "Contents", "MacOS", "myapp"),
    );
    assert(
      Deno.statSync(join(into, "My App.app", "Contents", "MacOS", "myapp"))
        .isFile,
    );

    // Not that shape: refused with what was found, never a guess.
    await Deno.mkdir(join(dir, "two", "A.app"), { recursive: true });
    await Deno.mkdir(join(dir, "two", "B.app"), { recursive: true });
    const two = join(dir, "two.app.tar.gz");
    await tarGz(join(dir, "two"), two, "A.app", "B.app");
    await assertRejects(
      () => unpackDesktop(two, join(dir, "box2"), "darwin"),
      Error,
      "holds 2 .app bundle(s)",
    );
    await assertRejects(
      () =>
        unpackDesktop(join(dir, "absent.tar.gz"), join(dir, "box3"), "darwin"),
      Error,
      "could not unpack",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("Windows package: the one program at the top of the unpacked zip", async () => {
  // The archive format is the host's concern (bsdtar reads a zip on Windows
  // and macOS; this test packs a tarball so it runs everywhere) — what is
  // under test is which file is the program.
  const dir = await tempDir("smoke-win-pkg-");
  try {
    const src = join(dir, "src");
    await Deno.mkdir(join(src, "electron"), { recursive: true });
    for (const f of ["myapp.exe", "run.bat", "README.txt"]) {
      await Deno.writeTextFile(join(src, f), "x");
    }
    await Deno.writeTextFile(join(src, "electron", "electron.exe"), "x");
    const pkg = join(dir, "pkg.tar.gz");
    await tarGz(src, pkg, "myapp.exe", "run.bat", "README.txt", "electron");
    const into = join(dir, "app");
    assertEquals(
      await unpackDesktop(pkg, into, "windows"),
      join(into, "myapp.exe"),
    );
    // No program at the top: refused, listing what is there.
    const none = join(dir, "none.tar.gz");
    await tarGz(src, none, "run.bat");
    await assertRejects(
      () => unpackDesktop(none, join(dir, "app2"), "windows"),
      Error,
      "holds 0 .exe file(s) at its top (run.bat)",
    );
  } finally {
    await dropTempDir(dir);
  }
});
