// A killed run must not leave its Electron main script behind.
//
// The generated main (~120 KB, carrying the app's launch URL) is written to
// the temp directory for Electron to load. It used to stay there for the
// whole run and be removed by the SERVER when the window exited — so a
// SIGKILLed run (the OOM killer, a crash, a forced stop) left it for good:
// measured on Linux and macOS, one `<hex>.cjs` more per crash.
//
// Now the script removes its own file as its first statement. Two rows:
//   • the line itself, RUN against a real file;
//   • the launch really writes it first — `$ELECTRON_PATH` points at a
//     stand-in that runs the script it is handed and then reports whether the
//     file is still there WHILE the "window" is alive, which is the moment a
//     kill used to strand it.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  electronProfileDir,
  electronStderrTail,
  launchElectron,
  MAIN_SCRIPT_DIR,
  MAIN_SCRIPT_SELF_REMOVE,
  writeMainScript,
} from "../src/electron/electron-spawn.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { permissiveUmask } from "./permissive-umask.ts";

/** Run `fn` with the window-profile base directories (and the temp
 *  directory) pointed into `dir` — no test writes into the real home. */
async function inHome<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const keys = [
    "HOME",
    "XDG_CONFIG_HOME",
    "APPDATA",
    "TMPDIR",
    "ELECTRON_PATH",
  ];
  const had = keys.map((k) => Deno.env.get(k));
  await Deno.mkdir(join(dir, "tmp"), { recursive: true });
  Deno.env.set("HOME", dir);
  Deno.env.set("XDG_CONFIG_HOME", join(dir, ".config"));
  Deno.env.set("APPDATA", join(dir, "AppData"));
  Deno.env.set("TMPDIR", join(dir, "tmp"));
  try {
    return await fn();
  } finally {
    keys.forEach((k, i) =>
      had[i] === undefined ? Deno.env.delete(k) : Deno.env.set(k, had[i]!)
    );
  }
}

/** Every file under `dir`, relative — what a launch left on disk. */
function filesUnder(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of Deno.readDirSync(join(dir, rel))) {
    const p = join(rel, e.name);
    if (e.isDirectory) out.push(...filesUnder(dir, p));
    else out.push(p);
  }
  return out;
}

const DENO_RUN = `"${Deno.execPath()}" run -A --quiet --no-config --no-lock`;

Deno.test("main script: its first line removes the file it was loaded from, and the rest still runs", async () => {
  const dir = await tempDir("el-main-self-");
  try {
    const file = join(dir, "main.cjs");
    await Deno.writeTextFile(
      file,
      MAIN_SCRIPT_SELF_REMOVE +
        "console.log('ran ' + require('fs').existsSync(__filename));\n",
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--quiet", "--no-config", "--no-lock", file],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      new TextDecoder().decode(out.stdout).trim(),
      "ran false",
      new TextDecoder().decode(out.stderr),
    );
    assertEquals(
      await Deno.stat(file).then(() => true, () => false),
      false,
      "the script's file is still on disk after it ran",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test({
  name:
    "main script: a launched window's script is gone from disk while the window is still running",
  ignore: Deno.build.os === "windows", // the stand-in is a shell script
  fn: async () => {
    const dir = await tempDir("el-main-litter-");
    try {
      await inHome(dir, async () => {
        const report = join(dir, "report");
        // Stands in for Electron: loads the main script (it dies at
        // require('electron') — after its first line), then says what is on
        // disk BEFORE exiting, i.e. before the server's own after-exit removal.
        const fake = join(dir, "fake-electron");
        await Deno.writeTextFile(
          fake,
          `#!/bin/sh\ncd "${dir}"\n${DENO_RUN} "$1" >/dev/null 2>&1\n` +
            `if [ -e "$1" ]; then echo "present $1" > "${report}.tmp"; ` +
            `else echo "gone $1" > "${report}.tmp"; fi\n` +
            `mv "${report}.tmp" "${report}"\n`,
        );
        await Deno.chmod(fake, 0o755);
        Deno.env.set("ELECTRON_PATH", fake);
        const lines: string[] = [];
        const log = {
          info: (m: string) => lines.push(m),
          error: (m: string) => lines.push(m),
        };
        const proc = await launchElectron("http://127.0.0.1:1/", log, {
          title: "litter",
        });
        assert(proc, `no window was launched: ${lines.join(" | ")}`);
        await proc.status;
        await electronStderrTail(proc, 5000);
        const [state, path] = (await Deno.readTextFile(report)).trim().split(
          " ",
        );
        assert(
          path?.endsWith(".cjs"),
          `the stand-in got no main script: ${path}`,
        );
        assertEquals(
          state,
          "gone",
          `${path} was still on disk while the window ran — a kill strands it`,
        );
        // It was written into the window's own profile, not the temp directory…
        assertEquals(
          path,
          join(
            electronProfileDir("litter")!,
            MAIN_SCRIPT_DIR,
            path!.split(/[\\/]/).pop()!,
          ),
        );
        assert(path!.split(/[\\/]/).pop()!.startsWith(`${Deno.pid}-`), path);
        // …and a window that never became a real one leaves no profile behind.
        assertEquals(
          await Deno.stat(electronProfileDir("litter")!).then(() => 1, () => 0),
          0,
          "an empty profile directory was left by a launch that made it",
        );
        assertEquals(filesUnder(join(dir, "tmp")), []);
      });
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "main script: a window that cannot be SPAWNED leaves no script behind either",
  ignore: Deno.build.os === "windows", // no execute bit to take away
  fn: async () => {
    // Measured on macOS (a bundle whose runtime could not be executed): the
    // spawn threw PermissionDenied and one `<hex>.cjs` — the launch URL in
    // it — stayed in the temp directory. The cleanup was registered only
    // after a spawn that worked.
    const dir = await tempDir("el-main-nospawn-");
    try {
      await inHome(dir, async () => {
        const bin = join(dir, "bin");
        await Deno.mkdir(bin);
        const notRunnable = join(bin, "electron");
        await Deno.writeTextFile(notRunnable, "not a program");
        await Deno.chmod(notRunnable, 0o644);
        Deno.env.set("ELECTRON_PATH", notRunnable);
        const log = { info: () => {}, error: () => {} };
        let threw = "";
        try {
          await launchElectron("http://127.0.0.1:1/", log, {
            title: "nospawn",
          });
        } catch (e) {
          threw = String(e);
        }
        assert(/PermissionDenied|denied/i.test(threw), `spawn: ${threw}`);
        assertEquals(
          filesUnder(dir).filter((f) => f !== join("bin", "electron")),
          [],
          "the failed launch left its main script behind",
        );
      });
    } finally {
      await dropTempDir(dir);
    }
  },
});

// ── What a kill before the load leaves is taken away by the next launch ─────
//
// The one case nothing running can clean up: the server AND the window are
// both SIGKILLed before Electron has loaded the script (measured: 2 in 60
// random kills, both at ~0.3 s after launch). The file — the launch URL in
// it — stayed in the temp directory under a random name, and nothing ever
// came back for it. It is written into the window's own profile now, named
// by the launcher's pid, and every launch removes the ones whose process is
// gone: the same home and the same rule as the preload.

Deno.test("main script: Electron's profile directory, per platform — and none where the environment does not say", () => {
  const env = (o: Record<string, string>) => (k: string) => o[k];
  assertEquals(
    electronProfileDir("my-app", "linux", env({ HOME: "/home/u" })),
    join("/home/u", ".config", "my-app"),
  );
  assertEquals(
    electronProfileDir(
      "my-app",
      "linux",
      env({ HOME: "/home/u", XDG_CONFIG_HOME: "/x/cfg" }),
    ),
    join("/x/cfg", "my-app"),
  );
  assertEquals(
    electronProfileDir("my-app", "darwin", env({ HOME: "/Users/u" })),
    join("/Users/u", "Library", "Application Support", "my-app"),
  );
  assertEquals(
    electronProfileDir("my-app", "windows", env({ APPDATA: "C:\\Roaming" })),
    join("C:\\Roaming", "my-app"),
  );
  for (const os of ["linux", "darwin", "windows"]) {
    assertEquals(electronProfileDir("my-app", os, env({})), null, os);
  }
});

Deno.test({
  name:
    "main script: written 0600 into the profile's 0700 aio-main/, named by this pid — and a launch removes what dead launchers left, never a live one's",
  ignore: Deno.build.os === "windows", // modes
  fn: () =>
    permissiveUmask(async () => {
      const dir = await tempDir("el-main-home-");
      try {
        await inHome(dir, async () => {
          const home = join(electronProfileDir("sweep")!, MAIN_SCRIPT_DIR);
          // Created by the code under test (the modes are its own)…
          await Deno.remove(await writeMainScript("sweep", "first"));
          const gone = new Deno.Command(Deno.execPath(), {
            args: ["-V"],
            stdout: "null",
          }).spawn();
          await gone.status;
          await Deno.writeTextFile(join(home, `${gone.pid}-aaaaaaaa.cjs`), "x");
          await Deno.writeTextFile(
            join(home, `${Deno.ppid}-bbbbbbbb.cjs`),
            "x",
          );
          await Deno.writeTextFile(join(home, "junk"), "x");
          const file = await writeMainScript("sweep", "// the script\n");
          assertEquals(
            [...Deno.readDirSync(home)].map((e) => e.name).sort(),
            [file.split("/").pop()!, `${Deno.ppid}-bbbbbbbb.cjs`].sort(),
          );
          assert(file.split("/").pop()!.startsWith(`${Deno.pid}-`), file);
          assertEquals(await Deno.readTextFile(file), "// the script\n");
          assertEquals(((await Deno.stat(file)).mode ?? 0) & 0o777, 0o600);
          assertEquals(((await Deno.stat(home)).mode ?? 0) & 0o777, 0o700);
          // Two launches of one process never share a file.
          assert(await writeMainScript("sweep", "x") !== file);
          assertEquals(filesUnder(join(dir, "tmp")), []);
        });
      } finally {
        await dropTempDir(dir);
      }
    }),
});

Deno.test({
  name:
    "main script: where the profile cannot be written the temp directory is used, as before",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await tempDir("el-main-nohome-");
    try {
      await inHome(dir, async () => {
        // The profile's parent is a FILE: nothing can be created under it.
        await Deno.writeTextFile(join(dir, ".config"), "");
        await Deno.mkdir(join(dir, "Library"));
        await Deno.writeTextFile(
          join(dir, "Library", "Application Support"),
          "",
        );
        const file = await writeMainScript("blocked", "// s\n");
        assert(file.startsWith(join(dir, "tmp")), file);
        assertEquals(await Deno.readTextFile(file), "// s\n");
        // No profile name at all (a caller that has none): the same.
        const anon = await writeMainScript(undefined, "// s\n");
        assert(anon.startsWith(join(dir, "tmp")), anon);
      });
    } finally {
      await dropTempDir(dir);
    }
  },
});
