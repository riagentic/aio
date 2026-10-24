// run.sh on macOS, with a desktop (Electron) app.
//
// A macOS desktop build ships no executable FILE — a `.dmg` and the signed
// bundle as `<name>-mac-<arch>.app.tar.gz` — so run.sh's artifact search
// ("an AppImage, else anything executable") found nothing and the one-liner
// ended in "no runnable artifact appeared". And whenever it did install a GUI
// app there, it wrote a Linux `.desktop` entry into the Mac's home.
//
// Driven the way tests/run-sh.test.ts drives it: the real script, the real
// `deno` (so the REAL `--print-install-name` / install-record rules answer),
// and stand-ins for what must not really happen here — `uname` (so both OSes
// are tested on either host), the build, `am`, and `open`.
import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { ownHome } from "./deno-dir-helper.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO_ROOT = join(import.meta.dirname!, "..");
const NEEDS_SH = {
  ignore: Deno.build.os === "windows", // run.sh is a POSIX sh script; Windows has run.ps1
};
const dec = new TextDecoder();

const exists = (p: string) => {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** What the stand-in build leaves in dist/. */
const BUILDS = {
  // What `_packageMacos` ships on a Mac: the .dmg, and the bundle as a tarball
  // whose top entry is `<Title>.app` (the title has a space on purpose).
  macBundle: `mkdir -p dist stage/"Demo App.app"/Contents/MacOS
printf '#!/bin/sh\\necho demo\\n' > stage/"Demo App.app"/Contents/MacOS/demo
chmod +x stage/"Demo App.app"/Contents/MacOS/demo
tar -czf dist/demo-1.2.345-mac-arm64.app.tar.gz -C stage "Demo App.app"
: > dist/demo-1.2.345-mac-arm64.dmg
rm -rf stage`,
  // What a Linux desktop build ships.
  appImage: `mkdir -p dist
printf '#!/bin/sh\\nexit 0\\n' > dist/demo-1.2.345-x86_64.AppImage
chmod +x dist/demo-1.2.345-x86_64.AppImage`,
} as const;

async function runSh(
  os: "Darwin" | "Linux",
  build: keyof typeof BUILDS,
  args: string[],
  opts: {
    /** What the stand-in `pgrep` answers: is a copy of the app running? */
    running?: boolean;
    /** Version directories already installed, oldest first. */
    older?: string[];
    /** The version about to be built is installed already, with this file
     *  in its bundle. */
    installed?: string;
    /** Extra environment for run.sh. */
    env?: Record<string, string>;
    /** A copy of the user's own at `~/Applications/Demo App.app`. */
    ownCopy?: boolean;
    /** What the app's log holds, written where an app run here keeps it —
     *  by the app, during the open (as a real one does). */
    log?: string;
    /** The log was written BEFORE this open: an earlier run's. */
    staleLog?: boolean;
  } = {},
) {
  const tmp = await tempDir("run-sh-macos-");
  const bin = join(tmp, "bin");
  const app = join(tmp, "demo");
  await Deno.mkdir(bin);
  await Deno.mkdir(app);
  const opened = join(tmp, "opened");
  const sh = async (name: string, body: string) => {
    await Deno.writeTextFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await Deno.chmod(join(bin, name), 0o755);
  };
  // `uname -s` answers for the OS under test; anything else is the host's.
  await sh(
    "uname",
    `[ "$1" = "-s" ] && { echo ${os}; exit 0; }\nexec /usr/bin/uname "$@"`,
  );
  await sh("am", "exit 0");
  await sh("install.sh", "exit 0");
  const asked = join(tmp, "pgrep-asked");
  await sh(
    "pgrep",
    `printf '%s\\n' "$2" > "${asked}"\nexit ${opts.running ? 0 : 1}`,
  );
  await Deno.writeTextFile(
    join(app, "deno.json"),
    JSON.stringify({
      imports: { aio: "./aio.ts" },
      client: "electron",
      tasks: { compile: "sh build.sh" },
    }),
  );
  await Deno.writeTextFile(join(app, "aio.ts"), "export {};\n");
  // The build also notes what it finds in the app's root when it starts.
  const seen = join(tmp, "seen-by-build");
  await Deno.writeTextFile(
    join(app, "build.sh"),
    `ls -A > "${seen}"\n${BUILDS[build]}\n`,
  );
  const home = await ownHome(tmp);
  if (opts.installed) {
    const at = join(
      home.AIO_INSTALL_ROOT!,
      "demo/versions/1.2.345/Demo App.app",
      opts.installed,
    );
    await Deno.mkdir(dirname(at), { recursive: true });
    await Deno.writeTextFile(at, "");
  }
  if (opts.ownCopy) {
    const copy = join(home.HOME!, "Applications", "Demo App.app");
    await Deno.mkdir(copy, { recursive: true });
    await Deno.writeTextFile(join(copy, "mine"), "");
  }
  const logs = join(
    opts.env?.AIO_APPS_DIR
      ? join(opts.env.AIO_APPS_DIR, "demo")
      : join(home.HOME!, ".demo"),
    "logs",
  );
  if (opts.log !== undefined) {
    await Deno.mkdir(logs, { recursive: true });
    await Deno.writeTextFile(join(tmp, "log-src"), opts.log);
    if (opts.staleLog) {
      await Deno.copyFile(join(tmp, "log-src"), join(logs, "app.log"));
      // Older than any marker the run makes, at any mtime resolution.
      await Deno.utime(join(logs, "app.log"), 1_700_000_000, 1_700_000_000);
    }
  }
  // One argument per line, so a path with a space stays one argument. The
  // app writes its log while it runs, i.e. during the open.
  await sh(
    "open",
    `for a in "$@"; do printf '%s\\n' "$a"; done > "${opened}"` +
      (opts.log !== undefined && !opts.staleLog
        ? `\ncp "${join(tmp, "log-src")}" "${join(logs, "app.log")}"`
        : ""),
  );
  for (const [i, v] of (opts.older ?? []).entries()) {
    const dir = join(home.AIO_INSTALL_ROOT!, "demo", "versions", v);
    await Deno.mkdir(dir, { recursive: true });
    // Distinct ages: the prune keeps the newest.
    await Deno.utime(dir, 1_700_000_000 + i, 1_700_000_000 + i);
  }
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    ...home,
    PATH: `${bin}:${dirname(Deno.execPath())}:${Deno.env.get("PATH") ?? ""}`,
    AIO_HOME: REPO_ROOT,
    AIO_INSTALL: join(bin, "install.sh"),
    NO_COLOR: "1",
    // The stand-in `open` returns at once: not an early exit unless a test
    // asks for the real threshold.
    AIO_OPEN_EARLY_EXIT_S: "0",
    ...opts.env,
  };
  // Nothing the host's own session says may steer the run — the shard runner
  // exports an AIO_APPS_DIR of its own, which moved the app's home.
  for (
    const k of [
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "AIO_BUILD_COMMIT",
      "AIO_APPS_DIR",
    ]
  ) {
    if (!opts.env || !(k in opts.env)) delete env[k];
  }
  const p = await new Deno.Command("sh", {
    args: [join(REPO_ROOT, "run.sh"), ...args],
    cwd: app,
    clearEnv: true,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: p.code,
    out: dec.decode(p.stdout) + dec.decode(p.stderr),
    home: home.HOME!,
    root: home.AIO_INSTALL_ROOT!,
    opened: exists(opened)
      ? Deno.readTextFileSync(opened).split("\n").filter(Boolean)
      : null,
    /** The app root's entries as the build found them. */
    seen: Deno.readTextFileSync(seen).split("\n").filter(Boolean).sort(),
    /** The pattern `pgrep -f` was asked for, or null when it was not asked. */
    asked: exists(asked) ? Deno.readTextFileSync(asked).trimEnd() : null,
    done: () => dropTempDir(tmp),
  };
}

Deno.test(
  "run.sh on macOS: the desktop bundle is installed under the install root and opened — never a .desktop file, never /Applications",
  NEEDS_SH,
  async () => {
    const r = await runSh("Darwin", "macBundle", ["--", "--port=4321"]);
    try {
      assertEquals(r.code, 0, r.out);
      // versions/<version>/<Title>.app — the version in the DIRECTORY, the
      // app's name without the archive's `-mac-arm64`.
      const bundle = join(
        r.root,
        "demo",
        "versions",
        "1.2.345",
        "Demo App.app",
      );
      const exe = join(bundle, "Contents", "MacOS", "demo");
      assert(exists(exe), `no bundle at ${bundle}\n${r.out}`);
      assert((Deno.statSync(exe).mode! & 0o111) !== 0, "the exec bit was lost");
      // …and a stable link beside versions/, which is what gets opened.
      const stable = join(r.root, "demo", "Demo App.app");
      assert(Deno.lstatSync(stable).isSymlink, "no stable link");
      assertEquals(Deno.realPathSync(stable), Deno.realPathSync(bundle));
      assertEquals(r.opened, ["-W", stable, "--args", "--port=4321"]);
      // Nothing half-unpacked is left for a launcher to find.
      assertEquals(
        [...Deno.readDirSync(join(r.root, "demo", "versions"))].map((e) =>
          e.name
        ),
        ["1.2.345"],
      );
      // `am installed` / `am upgrade` / `am remove` know it.
      const rec = JSON.parse(
        Deno.readTextFileSync(join(r.root, "demo", "installed.json")),
      );
      assertEquals(rec.name, "demo");
      assertEquals(rec.version, "1.2.345");
      assertEquals(rec.artifact, "Demo App.app");
      // No Linux launcher in a Mac's home, and no Applications folder made.
      assert(
        !exists(join(r.home, ".local", "share", "applications")),
        "a .desktop directory was created on macOS",
      );
      assert(!exists(join(r.home, "Applications")));
      assert(!r.out.includes("menu entry"), r.out);
    } finally {
      await r.done();
    }
  },
);

Deno.test(
  "run.sh on macOS: an app that is already open is said — `open` starts nothing then",
  NEEDS_SH,
  async () => {
    const said = "Demo App is already open";
    const up = await runSh("Darwin", "macBundle", [], { running: true });
    try {
      assertEquals(up.code, 0, up.out);
      assertStringIncludes(up.out, said);
      // Any version under THIS app's install root, by its physical path.
      assertEquals(
        up.asked,
        `${
          Deno.realPathSync(join(up.root, "demo"))
        }/.*Demo App.app/Contents/MacOS/`,
      );
      // Still opened: that is what brings the running window forward.
      assertEquals(up.opened, [
        "-W",
        join(up.root, "demo", "Demo App.app"),
        "--args",
      ]);
    } finally {
      await up.done();
    }
    const down = await runSh("Darwin", "macBundle", []);
    try {
      assertEquals(down.code, 0, down.out);
      assert(down.asked !== null, "pgrep was not asked");
      assert(!down.out.includes(said), down.out);
    } finally {
      await down.done();
    }
    // --no-install: the copy beside the tarball is the one looked for.
    const beside = await runSh("Darwin", "macBundle", ["--no-install"], {
      running: true,
    });
    try {
      assertEquals(beside.code, 0, beside.out);
      assertStringIncludes(beside.out, said);
      assert(
        beside.asked!.endsWith("/dist/.*Demo App.app/Contents/MacOS/"),
        beside.asked!,
      );
    } finally {
      await beside.done();
    }
  },
);

Deno.test(
  "run.sh on macOS: while the app is open its bundle is not replaced and older versions are not pruned — it runs from one of them",
  NEEDS_SH,
  async () => {
    const older = ["1.2.1", "1.2.2", "1.2.3"];
    const versions = (root: string) =>
      [...Deno.readDirSync(join(root, "demo", "versions"))].map((e) => e.name)
        .sort();
    const open = await runSh("Darwin", "macBundle", ["--no-run"], {
      running: true,
      older,
    });
    try {
      assertEquals(open.code, 0, open.out);
      assertEquals(versions(open.root), [...older, "1.2.345"], open.out);
      assertStringIncludes(open.out, "older versions kept this time");
    } finally {
      await open.done();
    }
    // The same version again: the bundle the open app runs from stays as it
    // is, file for file; closed, it is replaced by what was built.
    const mark = "Contents/was-here";
    const kept = (root: string) =>
      exists(join(root, "demo/versions/1.2.345/Demo App.app", mark));
    const same = await runSh("Darwin", "macBundle", ["--no-run"], {
      running: true,
      installed: mark,
    });
    try {
      assertEquals(same.code, 0, same.out);
      assert(kept(same.root), same.out);
      assertStringIncludes(same.out, "that copy is left as it is");
    } finally {
      await same.done();
    }
    const again = await runSh("Darwin", "macBundle", ["--no-run"], {
      installed: mark,
    });
    try {
      assertEquals(again.code, 0, again.out);
      assert(!kept(again.root), again.out);
    } finally {
      await again.done();
    }
    // The control: closed, the rule is what it was — the newest three stay.
    const closed = await runSh("Darwin", "macBundle", ["--no-run"], { older });
    try {
      assertEquals(closed.code, 0, closed.out);
      assertEquals(versions(closed.root), ["1.2.2", "1.2.3", "1.2.345"]);
      assertStringIncludes(closed.out, "pruned older version(s)");
    } finally {
      await closed.done();
    }
  },
);

Deno.test(
  "run.sh on macOS: it waits for the app (`open -W`), and an app gone at once is a failure, said with its log — `open` answers 0 whatever the app did",
  NEEDS_SH,
  async () => {
    const r = await runSh("Darwin", "macBundle", [], {
      env: { AIO_OPEN_EARLY_EXIT_S: "3" },
      log: "boot: the port is taken\n",
    });
    try {
      assertEquals(r.code, 1, r.out);
      assertEquals(r.opened?.[0], "-W");
      // run.sh reads whole seconds (`date +%s`): an instant exit that straddles
      // a second boundary, or a loaded machine, reads 1s or 2s — any count
      // under AIO_OPEN_EARLY_EXIT_S (3) is the early-exit verdict.
      assertMatch(r.out, /Demo App exited [0-2]s after it was opened/);
      assertStringIncludes(r.out, "boot: the port is taken");
      assertStringIncludes(r.out, join(r.home, ".demo", "logs", "app.log"));
    } finally {
      await r.done();
    }
  },
);

// An app gone before it wrote a line (a bad argument): what it said went to
// the stderr `open` does not keep, and the log there is an EARLIER run's.
// Measured on macOS 14 (`--port=notaport`): run.sh printed that old log's tail
// as if it were this start's reason. Now it says the log is old and names the
// bundle's executable to run in a terminal, where the reason is printed.
Deno.test(
  "run.sh on macOS: an app gone before it logged is not explained by an earlier run's log — it names the executable to run instead",
  NEEDS_SH,
  async () => {
    const r = await runSh("Darwin", "macBundle", [], {
      env: { AIO_OPEN_EARLY_EXIT_S: "3" },
      log: "an earlier run: all fine\n",
      staleLog: true,
    });
    try {
      assertEquals(r.code, 1, r.out);
      assertEquals(r.out.includes("an earlier run: all fine"), false, r.out);
      assertStringIncludes(r.out, "before it wrote to its log");
      // The bundle's executable, not its title.
      assertStringIncludes(r.out, `Demo App.app/Contents/MacOS/demo"`);
      assertStringIncludes(
        r.out,
        `(its log, ${
          join(r.home, ".demo", "logs", "app.log")
        }, is from an earlier run)`,
      );
    } finally {
      await r.done();
    }
  },
);

// The log is where the app keeps it — `$AIO_APPS_DIR/<id>` when that is set —
// and a guessed path that holds no log is no pointer: an app with a data dir of
// its own (`aio.run({ appDir })`, a profile) or in library mode logs elsewhere,
// and "Its log: <a file that does not exist>" sent the user to nothing.
Deno.test(
  "run.sh on macOS: an app gone at once points at its log only where one is — AIO_APPS_DIR followed, a missing file never named",
  NEEDS_SH,
  async () => {
    const tmp = await tempDir("run-sh-macos-apps-");
    const apps = join(tmp, "apps");
    const moved = await runSh("Darwin", "macBundle", [], {
      env: { AIO_OPEN_EARLY_EXIT_S: "3", AIO_APPS_DIR: apps },
      log: "boot: moved home\n",
    });
    const none = await runSh("Darwin", "macBundle", [], {
      env: { AIO_OPEN_EARLY_EXIT_S: "3" },
    });
    try {
      assertEquals(moved.code, 1, moved.out);
      assertStringIncludes(moved.out, "boot: moved home");
      assertStringIncludes(
        moved.out,
        `Its log: ${join(apps, "demo", "logs", "app.log")}`,
      );
      assertEquals(none.code, 1, none.out);
      assertStringIncludes(none.out, "it stopped at start");
      assertEquals(none.out.includes("Its log"), false, none.out);
      assertEquals(none.out.includes("app.log"), false, none.out);
    } finally {
      await moved.done();
      await none.done();
      await dropTempDir(tmp);
    }
  },
);

Deno.test(
  "run.sh on macOS: AIO_APPLICATIONS_LINK=1 links the stable bundle into ~/Applications (Launchpad) — never over what is not its own link",
  NEEDS_SH,
  async () => {
    const link = (home: string) => join(home, "Applications", "Demo App.app");
    const r = await runSh("Darwin", "macBundle", ["--no-run"], {
      env: { AIO_APPLICATIONS_LINK: "1" },
    });
    try {
      assertEquals(r.code, 0, r.out);
      assert(Deno.lstatSync(link(r.home)).isSymlink, r.out);
      assertEquals(
        Deno.readLinkSync(link(r.home)),
        join(r.root, "demo", "Demo App.app"),
      );
      assertStringIncludes(r.out, "Launchpad");
    } finally {
      await r.done();
    }
    // Something of the user's at that name (the app's own "Move to
    // Applications" copy): left alone, and said.
    const own = await runSh("Darwin", "macBundle", ["--no-run"], {
      env: { AIO_APPLICATIONS_LINK: "1" },
      ownCopy: true,
    });
    try {
      assertEquals(own.code, 0, own.out);
      assert(!Deno.lstatSync(link(own.home)).isSymlink, own.out);
      assert(exists(join(link(own.home), "mine")), "the user's copy changed");
      assertStringIncludes(own.out, "not linked into ~/Applications");
    } finally {
      await own.done();
    }
  },
);

Deno.test(
  "run.sh on macOS: --no-run installs the bundle and opens nothing",
  NEEDS_SH,
  async () => {
    const r = await runSh("Darwin", "macBundle", ["--no-run"]);
    try {
      assertEquals(r.code, 0, r.out);
      assertEquals(r.opened, null, "open ran under --no-run");
      const stable = join(r.root, "demo", "Demo App.app");
      assert(exists(join(stable, "Contents", "MacOS", "demo")), r.out);
      assertStringIncludes(r.out, `Run it: open "${stable}"`);
    } finally {
      await r.done();
    }
  },
);

Deno.test(
  "run.sh on macOS: --no-install opens the bundle from beside its tarball",
  NEEDS_SH,
  async () => {
    const r = await runSh("Darwin", "macBundle", ["--no-install"]);
    try {
      assertEquals(r.code, 0, r.out);
      assertEquals(r.opened?.length, 3, r.out);
      assert(r.opened![1]!.endsWith("/dist/Demo App.app"), r.opened![1]);
      assert(!exists(join(r.root, "demo")), "installed under --no-install");
    } finally {
      await r.done();
    }
  },
);

Deno.test(
  "run.sh on macOS: a GUI app that IS an executable still gets no .desktop entry",
  NEEDS_SH,
  async () => {
    const r = await runSh("Darwin", "appImage", ["--no-run"]);
    try {
      assertEquals(r.code, 0, r.out);
      assert(exists(join(r.root, "demo", "demo.AppImage")), r.out);
      assert(
        !exists(join(r.home, ".local", "share", "applications")),
        "a .desktop entry was written on macOS",
      );
    } finally {
      await r.done();
    }
  },
);

Deno.test(
  "run.sh: the build finds the app's tree as the developer left it — a file of run.sh's there would stamp every build dirty",
  NEEDS_SH,
  async () => {
    for (
      const [os, build] of [["Linux", "appImage"], [
        "Darwin",
        "macBundle",
      ]] as const
    ) {
      const r = await runSh(os, build, ["--no-run"]);
      try {
        assertEquals(r.code, 0, r.out);
        assertEquals(r.seen, ["aio.ts", "build.sh", "deno.json"], os);
      } finally {
        await r.done();
      }
    }
  },
);

// One unpack dir per app: the menu entry's Exec named its own
// (`$XDG_CACHE_HOME/<name>`) while a terminal run used the framework's
// `~/.<appId>/app` — a double-click and a terminal run unpacked one app into
// two places. Both now take the build's `--print-app-tmpdir` answer.
Deno.test(
  "run.sh on Linux: the menu entry unpacks where a terminal run does",
  NEEDS_SH,
  async () => {
    const gui = await runSh("Linux", "appImage", ["--no-run"]);
    try {
      assertEquals(gui.code, 0, gui.out);
      const entry = Deno.readTextFileSync(
        join(gui.home, ".local", "share", "applications", "demo.desktop"),
      );
      assertStringIncludes(entry, `D="${join(gui.home, ".demo", "app")}"`);
      assert(!entry.includes(".cache"), entry);
    } finally {
      await gui.done();
    }
  },
);

// The controls: Linux is what it was.
Deno.test(
  "run.sh on Linux: unchanged — a GUI app gets its .desktop entry, and a macOS tarball is not an artifact",
  NEEDS_SH,
  async () => {
    const gui = await runSh("Linux", "appImage", ["--no-run"]);
    try {
      assertEquals(gui.code, 0, gui.out);
      const desktop = join(
        gui.home,
        ".local",
        "share",
        "applications",
        "demo.desktop",
      );
      assert(exists(desktop), gui.out);
      assertStringIncludes(
        Deno.readTextFileSync(desktop),
        join(gui.root, "demo", "demo.AppImage"),
      );
      assertEquals(gui.opened, null);
    } finally {
      await gui.done();
    }
    const mac = await runSh("Linux", "macBundle", ["--no-run"]);
    try {
      assertEquals(mac.code, 1, mac.out);
      assertStringIncludes(mac.out, "no runnable artifact appeared");
    } finally {
      await mac.done();
    }
  },
);
