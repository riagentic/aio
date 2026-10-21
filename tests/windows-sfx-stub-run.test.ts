// The committed Windows SFX stub, RUN: a one-click `.exe` made of the stub and
// a small payload, opened the three ways its first argument selects. Windows
// only — the stub is a PE. The app inside is a copy of `cmd.exe`, so its
// arguments decide what it does and what it exits with.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { existsSync } from "node:fs";
import {
  ensureWindowsSfxStub,
  packAppDirTarZstd,
  prebuiltStubPath,
  writeWindowsSfxExe,
} from "../src/build/build-windows-exe.ts";
import {
  SFX_STAMP_FILE,
  SFX_VERSION_FILE,
} from "../src/server/updates-apply.ts";
import { sha256Hex } from "../src/build/ship.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { readSfxTrailerOfFile } from "../src/build/sfx-trailer.ts";
import { fakeSigned } from "./sfx-sign-helper.ts";
import { pngFromRgba } from "../src/build/app-icon.ts";
import { icoFromLargePng } from "../src/build/png-scale.ts";
import { peWithIcon } from "../src/build/pe-icon.ts";
import { ownHome } from "./deno-dir-helper.ts";
import { holdUnshared } from "./proc-helper.ts";

const WINDOWS = Deno.build.os === "windows";
const NAME = "zzstub";

/** A one-click `.exe` of version `version` under `dir` — wearing `ico`, when
 *  given, the way the build writes an app's icon into its copy of the stub. */
async function oneClick(
  dir: string,
  version: string,
  ico?: Uint8Array,
): Promise<string> {
  const stage = join(dir, `app-${version}`);
  await Deno.mkdir(join(stage, "electron"), { recursive: true });
  await Deno.copyFile(
    join(Deno.env.get("WINDIR")!, "System32", "cmd.exe"),
    join(stage, `${NAME}.exe`),
  );
  await Deno.writeTextFile(join(stage, "electron", "electron.exe"), "e");
  await Deno.writeTextFile(join(stage, "holds.txt"), version);
  const payloadPath = join(dir, `${version}.tar.zst`);
  await packAppDirTarZstd(stage, payloadPath);
  const outPath = join(dir, `${NAME}-${version}.exe`);
  let stubPath = await ensureWindowsSfxStub();
  if (ico) {
    const made = peWithIcon(await Deno.readFile(stubPath), ico);
    if ("refused" in made) throw new Error(made.refused);
    stubPath = join(dir, `stub-${version}.exe`);
    await Deno.writeFile(stubPath, made.pe);
  }
  await writeWindowsSfxExe({
    stubPath,
    payloadPath,
    payloadFormat: "tar.zstd",
    outPath,
    binaryName: NAME,
    archStr: "x64",
    version,
  });
  return outPath;
}

/** The lab of one test: where the stub installs, and how to run an exe. */
async function lab() {
  const dir = await tempDir("sfx-stub-run-");
  // The stub is an installer (files, a Start Menu entry): every place it
  // writes is under this test's own directory.
  const env = await ownHome(dir);
  const local = env.LOCALAPPDATA!;
  const install = join(local, "aio-sfx", NAME, "win-x64");
  const runWith = async (
    extra: Record<string, string>,
    exe: string,
    ...args: string[]
  ) => {
    const o = await new Deno.Command(exe, {
      args,
      env: { ...env, ...extra },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return { code: o.code, err: new TextDecoder().decode(o.stderr) };
  };
  const run = (exe: string, ...args: string[]) => runWith({}, exe, ...args);
  const holds = () => Deno.readTextFileSync(join(install, "holds.txt"));
  return { dir, install, run, runWith, holds, env };
}

/** Is this process where somebody can see a window (a logged-on desktop)?
 *  Over ssh and in a service it is not — and only there can a test open a
 *  stub that fails: with a desktop the stub shows its message box, which
 *  waits for a click. */
const DESKTOP = WINDOWS &&
  new TextDecoder().decode(
      new Deno.Command("powershell", {
        args: ["-NoProfile", "-Command", "[Environment]::UserInteractive"],
      }).outputSync().stdout,
    ).trim() !== "False";

const REPO = join(import.meta.dirname!, "..");

/** Wait, bounded, for `path` to exist. */
async function appears(path: string): Promise<boolean> {
  for (let i = 0; i < 200 && !existsSync(path); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return existsSync(path);
}

// `am upgrade` runs the new `.exe` this way (run.ps1 looks for the same text
// in the stub before it does).
Deno.test("the stub PE knows --aio-sfx-install and --aio-sfx-wait", async () => {
  const text = new TextDecoder("latin1").decode(
    await Deno.readFile(prebuiltStubPath()),
  );
  assertStringIncludes(text, "--aio-sfx-install");
  assertStringIncludes(text, "--aio-sfx-wait");
  const ps1 = await Deno.readTextFile(
    new URL("../run.ps1", import.meta.url),
  );
  assertStringIncludes(ps1, "'--aio-sfx-install'");
});

Deno.test({
  name:
    "stub --aio-sfx-install: installs and replaces without starting the app, a newer install too (said); a running app is refused by exit code; opened, an older file keeps the newer install",
  ignore: !WINDOWS, // the stub is a Windows program
  async fn() {
    const { dir, install, run, holds } = await lab();
    try {
      const a = await oneClick(dir, "1.0.0");
      const b = await oneClick(dir, "1.1.0");
      const marker = join(dir, "started");
      // The app's arguments would start it and leave a file: it is not started.
      const first = await run(
        a,
        "--aio-sfx-install",
        "/c",
        "type",
        "nul",
        ">",
        marker,
      );
      assertEquals(first, { code: 0, err: "" });
      assertEquals(holds(), "1.0.0");
      assertEquals(
        Deno.readTextFileSync(join(install, SFX_VERSION_FILE)).trim(),
        "1.0.0",
      );
      assert(existsSync(join(install, SFX_STAMP_FILE)));
      // Again: already there, still 0.
      assertEquals((await run(a, "--aio-sfx-install")).code, 0);

      // While the app runs from the install: exit 3, nothing changed.
      const app = new Deno.Command(join(install, `${NAME}.exe`), {
        args: ["/k"],
        cwd: install,
        stdin: "piped",
        stdout: "null",
        stderr: "null",
      }).spawn();
      try {
        const busy = await run(b, "--aio-sfx-install");
        assertEquals(busy.code, 3, busy.err);
        assertStringIncludes(busy.err, `${NAME} is running`);
        assertEquals(holds(), "1.0.0");
      } finally {
        app.kill();
        await app.stdin.close().catch(() => {});
        await app.status;
      }

      // Closed: the upgrade goes in, the old tree leaves nothing beside it.
      const up = await run(b, "--aio-sfx-install");
      assertEquals(up, { code: 0, err: "" });
      assertEquals(holds(), "1.1.0");
      assertEquals(
        [...Deno.readDirSync(join(install, ".."))].map((e) => e.name),
        ["win-x64"],
      );

      // The older file, OPENED, opens the newer install…
      assertEquals((await run(a, "/c", "exit", "0")).code, 0);
      assertEquals(holds(), "1.1.0");
      assert(!existsSync(marker), "the app was started with the stub's args");
      // …and asked to install, it does (how `am upgrade` goes back), and says so.
      const down = await run(a, "--aio-sfx-install");
      assertEquals(down.code, 0, down.err);
      assertStringIncludes(
        down.err,
        `replaced the newer ${NAME} 1.1.0 with 1.0.0`,
      );
      assertEquals(holds(), "1.0.0");
      assertEquals(
        Deno.readTextFileSync(join(install, SFX_VERSION_FILE)).trim(),
        "1.0.0",
      );
      // An install that updated itself keeps the stamp of the payload it was
      // first extracted from: the same file, asked to install, still does.
      const versionFile = join(install, SFX_VERSION_FILE);
      Deno.writeTextFileSync(versionFile, "1.5.0\n");
      Deno.writeTextFileSync(join(install, "holds.txt"), "1.5.0");
      assertEquals((await run(a, "/c", "exit", "0")).code, 0);
      assertEquals(holds(), "1.5.0", "opened, it only opens what is there");
      const back = await run(a, "--aio-sfx-install");
      assertEquals(back.code, 0, back.err);
      assertStringIncludes(
        back.err,
        `replaced the newer ${NAME} 1.5.0 with 1.0.0`,
      );
      assertEquals(holds(), "1.0.0");
      assertEquals(Deno.readTextFileSync(versionFile).trim(), "1.0.0");
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "stub: opened, it starts the app and exits 0 at once; with --aio-sfx-wait it exits with the app's exit code",
  ignore: !WINDOWS, // the stub is a Windows program
  async fn() {
    const { dir, run } = await lab();
    try {
      const a = await oneClick(dir, "1.0.0");
      const marker = join(dir, "started");
      // Opened: the app's own exit code (7) is not the stub's.
      const opened = await run(
        a,
        "/c",
        "type",
        "nul",
        ">",
        marker,
        "&",
        "exit",
        "7",
      );
      assertEquals(opened.code, 0, opened.err);
      assert(await appears(marker), "the app was not started");
      const waited = await run(a, "--aio-sfx-wait", "/c", "exit", "7");
      assertEquals(waited.code, 7, waited.err);
      assertEquals((await run(a, "--aio-sfx-wait", "/c", "exit", "0")).code, 0);
    } finally {
      await dropTempDir(dir);
    }
  },
});

// A stub that died holding the install's mutex (killed mid-extraction) must
// not lock the app out: Windows hands the next waiter an ABANDONED mutex, and
// the stub takes it like a free one.
Deno.test({
  name:
    "stub: a mutex abandoned by a killed holder is taken, and the install goes on",
  ignore: !WINDOWS, // the stub is a Windows program
  async fn() {
    const { dir, install, run, holds } = await lab();
    try {
      const a = await oneClick(dir, "1.0.0");
      const mutex = "Global\\aio-sfx-" +
        (await sha256Hex(new TextEncoder().encode(install.toLowerCase())))
          .slice(0, 32);
      const holder = new Deno.Command("powershell", {
        args: [
          "-NoProfile",
          "-Command",
          `$m = New-Object Threading.Mutex($true, '${mutex}'); 'held'; Start-Sleep 600`,
        ],
        stdout: "piped",
        stderr: "null",
      }).spawn();
      const reader = holder.stdout.getReader();
      let stub: Promise<{ code: number; err: string }>;
      try {
        const { value } = await reader.read();
        assertStringIncludes(new TextDecoder().decode(value), "held");
        // Held: the stub waits (alone, this install takes well under a second).
        stub = run(a, "--aio-sfx-install");
        const waiting = await Promise.race([
          stub.then(() => false),
          new Promise<boolean>((r) => setTimeout(() => r(true), 2000)),
        ]);
        assert(waiting && !existsSync(install), "the stub did not wait");
      } finally {
        holder.kill();
        await reader.cancel();
        await holder.status;
      }
      assertEquals(await stub, { code: 0, err: "" });
      assertEquals(holds(), "1.0.0");
    } finally {
      await dropTempDir(dir);
    }
  },
});

// The other end of that wait: a holder that never lets go. The stub gives up
// and says who it waited for — after 10 minutes, or after the wait
// AIO_SFX_LOCK_WAIT_MS names, which is how this is tested. The reason is also
// left in the file AIO_SFX_REASON_FILE names, for a caller that does not read
// the stub's stderr (run.ps1) — and neither variable reaches the app.
Deno.test({
  name:
    "stub: a mutex that stays held is given up on with the reason — on stderr and in the reason file; the app sees neither variable",
  ignore: !WINDOWS, // the stub is a Windows program
  async fn() {
    const { dir, install, runWith, holds } = await lab();
    try {
      const a = await oneClick(dir, "1.0.0");
      const why = join(dir, "why.txt");
      const knobs = { AIO_SFX_REASON_FILE: why, AIO_SFX_LOCK_WAIT_MS: "300" };
      const mutex = "Global\\aio-sfx-" +
        (await sha256Hex(new TextEncoder().encode(install.toLowerCase())))
          .slice(0, 32);
      const holder = new Deno.Command("powershell", {
        args: [
          "-NoProfile",
          "-Command",
          `$m = New-Object Threading.Mutex($true, '${mutex}'); 'held'; Start-Sleep 600`,
        ],
        stdout: "piped",
        stderr: "null",
      }).spawn();
      const reader = holder.stdout.getReader();
      try {
        const { value } = await reader.read();
        assertStringIncludes(new TextDecoder().decode(value), "held");
        const gaveUp = await runWith(knobs, a, "--aio-sfx-install");
        assertEquals(gaveUp.code, 1, gaveUp.err);
        const reason =
          `another copy of this file is still installing ${NAME} — try again in a moment`;
        assertEquals(gaveUp.err.trim(), `aio SFX: ${reason}`);
        assertEquals(Deno.readTextFileSync(why).trim(), reason);
        assert(!existsSync(install), "installed without the lock");
      } finally {
        holder.kill();
        await reader.cancel();
        await holder.status;
      }
      // Free again: it installs, writes no reason, and the app it starts is
      // handed neither variable (cmd leaves an unset %NAME% as it is written).
      await Deno.remove(why);
      const seen = join(dir, "seen.txt");
      const ok = await runWith(
        knobs,
        a,
        "--aio-sfx-wait",
        "/c",
        `echo [%AIO_SFX_REASON_FILE%][%AIO_SFX_LOCK_WAIT_MS%]> ${seen}`,
      );
      assertEquals(ok, { code: 0, err: "" });
      assertEquals(holds(), "1.0.0");
      assert(!existsSync(why), "a reason was written for a success");
      assertEquals(
        Deno.readTextFileSync(seen).trim(),
        "[%AIO_SFX_REASON_FILE%][%AIO_SFX_LOCK_WAIT_MS%]",
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

// The move aside is what refuses a running app — and it is refused the same
// way while ANYTHING holds a file of the install: a virus scanner reading what
// was just extracted, an app on its way out. Under load an upgrade right after
// an install met that ("… is running … Access is denied"). Such a holder is
// gone in a moment, and the stub waits that moment.
Deno.test({
  name:
    "stub --aio-sfx-install: a file of the install held for a moment is waited out, not taken for the running app",
  ignore: !WINDOWS, // the stub is a Windows program
  async fn() {
    const { dir, install, run, holds } = await lab();
    try {
      const a = await oneClick(dir, "1.0.0");
      const b = await oneClick(dir, "1.1.0");
      assertEquals(await run(a, "--aio-sfx-install"), { code: 0, err: "" });
      const letGo = await holdUnshared(join(install, "holds.txt"));
      let released = false;
      try {
        const upgrade = run(b, "--aio-sfx-install");
        const early = await Promise.race([
          upgrade,
          new Promise<null>((r) => setTimeout(() => r(null), 1000)),
        ]);
        assertEquals(early, null, "the stub did not wait for the holder");
        await letGo();
        released = true;
        assertEquals(await upgrade, { code: 0, err: "" });
        assertEquals(holds(), "1.1.0");
      } finally {
        if (!released) await letGo();
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});

// The stamp alone does not make an install: one whose program is gone (an
// antivirus quarantine, half a delete) is extracted again, not started broken.
Deno.test({
  name:
    "stub: a stamped install that lost the app's program or its Electron is installed again",
  ignore: !WINDOWS, // the stub is a Windows program
  async fn() {
    const { dir, install, run, holds } = await lab();
    try {
      const a = await oneClick(dir, "1.0.0");
      assertEquals(await run(a, "--aio-sfx-install"), { code: 0, err: "" });
      for (
        const lost of [
          join(install, `${NAME}.exe`),
          join(install, "electron", "electron.exe"),
        ]
      ) {
        await Deno.remove(lost);
        await Deno.writeTextFile(join(install, "holds.txt"), "damaged");
        assert(existsSync(join(install, SFX_STAMP_FILE)));
        // Opened, as a double-click does: repaired, then started.
        assertEquals(
          (await run(a, "--aio-sfx-wait", "/c", "exit", "0")).code,
          0,
        );
        assert(existsSync(lost), `${lost} was not put back`);
        assertEquals(holds(), "1.0.0");
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});

// A signature appends the certificate table AFTER the trailer. The stub finds
// its payload before that table, by the PE's security directory.
Deno.test({
  name:
    "stub: an .exe with a certificate table after its trailer installs like the unsigned one",
  ignore: !WINDOWS, // the stub is a Windows program
  async fn() {
    const { dir, run, holds } = await lab();
    try {
      const plain = await oneClick(dir, "1.0.0");
      const signed = join(dir, "signed.exe");
      await Deno.writeFile(signed, fakeSigned(await Deno.readFile(plain)));
      assertEquals(
        await readSfxTrailerOfFile(signed),
        await readSfxTrailerOfFile(plain),
      );
      assertEquals(await run(signed, "--aio-sfx-install"), {
        code: 0,
        err: "",
      });
      assertEquals(holds(), "1.0.0");
    } finally {
      await dropTempDir(dir);
    }
  },
});

// The build writes the app's icon into its copy of the stub, so the stub of a
// one-click exe is no longer the same bytes for every app. Windows must show
// that icon, load the exe all the same, and install it over one that has none.
Deno.test({
  name:
    "a one-click exe wearing an icon: Windows shows that icon for it, it installs over an icon-less install, and run.ps1 reads its stub as before",
  ignore: !WINDOWS, // the stub is a Windows program; the icon is Windows' to read
  async fn() {
    const { dir, run, holds, env } = await lab();
    try {
      // Quadrants: red, green, blue, transparent.
      const N = 512;
      const px = new Uint8Array(N * N * 4);
      const colours = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]];
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const c = colours[(x < N / 2 ? 0 : 1) + (y < N / 2 ? 0 : 2)];
          if (c) px.set(c, (y * N + x) * 4);
        }
      }
      const ico = await icoFromLargePng(await pngFromRgba(px, N));
      assert(typeof ico !== "string", String(ico));
      const plain = await oneClick(dir, "1.0.0");
      const iconed = await oneClick(dir, "1.1.0", ico);

      const ps = async (script: string, e: Record<string, string> = {}) => {
        const o = await new Deno.Command("powershell", {
          args: [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
          ],
          env: { ...e, NO_COLOR: "1" },
          stdout: "piped",
          stderr: "piped",
        }).output();
        return new TextDecoder().decode(o.stdout).trim() +
          new TextDecoder().decode(o.stderr).trim();
      };
      // What Explorer draws: the 32 px icon Windows associates with the file.
      const shown = (exe: string) =>
        ps(
          `Add-Type -AssemblyName System.Drawing; ` +
            `$b = [System.Drawing.Icon]::ExtractAssociatedIcon('${exe}').ToBitmap(); ` +
            `(@(@(8,8),@(24,8),@(8,24),@(24,24)) | ForEach-Object { ` +
            `$c = $b.GetPixel($_[0], $_[1]); "$($c.R),$($c.G),$($c.B),$($c.A)" }) -join ' '`,
        );
      assertEquals(
        await shown(iconed),
        "255,0,0,255 0,255,0,255 0,0,255,255 0,0,0,0",
      );
      const generic = await shown(plain);
      assert(
        /^(\d+,){3}\d+( (\d+,){3}\d+){3}$/.test(generic) &&
          generic !== await shown(iconed),
        `an exe with no icon shows: ${generic}`,
      );

      // It loads and installs — over an install made by an exe with no icon.
      assertEquals(await run(plain, "--aio-sfx-install"), { code: 0, err: "" });
      assertEquals(holds(), "1.0.0");
      assertEquals(await run(iconed, "--aio-sfx-install"), {
        code: 0,
        err: "",
      });
      assertEquals(holds(), "1.1.0");

      // run.ps1 finds the trailer, and reads what the stub can do out of a
      // stub that is longer than the pinned one.
      assertEquals(
        await ps(
          `$env:AIO_RUN_LOAD_ONLY='1'; . '${join(REPO, "run.ps1")}'; ` +
            `"$(Test-OneClickExe '${iconed}') $(Test-OneClickInstallSwitch '${iconed}')"`,
          env,
        ),
        "True True",
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

// Opened where nobody can press OK, a stub that fails used to show its
// message box anyway and wait on it forever — an ssh session or a service
// that ran the .exe never came back.
Deno.test({
  name:
    "stub: opened with no desktop, a failure is a stderr line and exit 1 — no message box to wait on",
  // With a desktop the box is the right answer, and it waits for a click.
  ignore: !WINDOWS || DESKTOP,
  async fn() {
    const { dir, install, env } = await lab();
    try {
      const good = await Deno.readFile(await oneClick(dir, "1.0.0"));
      const trail =
        (await readSfxTrailerOfFile(join(dir, `${NAME}-1.0.0.exe`)))!;
      // One payload byte flipped: the stub refuses it before installing.
      good[trail.payloadOffset + 10]! ^= 0xff;
      const bad = join(dir, "damaged.exe");
      await Deno.writeFile(bad, good);
      const child = new Deno.Command(bad, {
        env,
        stdout: "null",
        stderr: "piped",
      }).spawn();
      let waited = false;
      const timer = setTimeout(() => {
        waited = true;
        child.kill();
      }, 60_000);
      const o = await child.output();
      clearTimeout(timer);
      assert(!waited, "the stub was still running after 60 s — a message box");
      assertEquals(o.code, 1);
      assertStringIncludes(
        new TextDecoder().decode(o.stderr),
        "aio SFX: payload checksum mismatch",
      );
      assert(!existsSync(install), "a damaged payload was installed");
    } finally {
      await dropTempDir(dir);
    }
  },
});

// run.ps1's last step. `& $exe` neither waits for a window program nor sets
// $LASTEXITCODE; the stub's own exit code is the true answer, and the app it
// started is never waited for.
Deno.test({
  name:
    "run.ps1 Start-OneClickExe: returns the stub's exit code once the app is started — while the app still runs",
  ignore: !WINDOWS, // Windows PowerShell and the stub exist only there
  async fn() {
    const { dir, env } = await lab();
    try {
      const exe = await oneClick(dir, "1.0.0");
      const started = join(dir, "started"), ended = join(dir, "ended");
      const call = async (path: string, args: string[]) => {
        const o = await new Deno.Command("powershell", {
          args: [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            `$env:AIO_RUN_LOAD_ONLY='1'; . '${
              join(REPO, "run.ps1")
            }'; $LASTEXITCODE = 42; ` +
            `Start-OneClickExe '${path}' @(${
              args.map((a) => `'${a}'`).join(", ")
            })`,
          ],
          env: { ...env, NO_COLOR: "1" },
          stdout: "piped",
          stderr: "piped",
        }).output();
        return new TextDecoder().decode(o.stdout).trim() +
          new TextDecoder().decode(o.stderr).trim();
      };
      // The app: leaves `started`, lives ~8 more seconds, leaves `ended`,
      // exits 7. An argument with a space reaches it as ONE argument.
      const out = await call(exe, [
        "/c",
        "type nul > " + started + " & ping -n 9 127.0.0.1 > nul & type nul > " +
        ended + " & exit 7",
      ]);
      assertEquals(
        out,
        "0",
        "the stub's exit code, not the app's 7 or a stale 42",
      );
      assert(await appears(started), "the app was not started");
      assert(!existsSync(ended), "the app was waited for");
      // …and it is let finish, so no process of this test is left behind.
      assert(await appears(ended), "the app did not finish");
      if (!DESKTOP) {
        const bytes = await Deno.readFile(exe);
        bytes[(await readSfxTrailerOfFile(exe))!.payloadOffset + 10]! ^= 0xff;
        const bad = join(dir, "damaged.exe");
        await Deno.writeFile(bad, bytes);
        // Why, too: the stub leaves its reason in a file this reads — its
        // stderr is not read, or the app would inherit the pipe.
        const said = await call(bad, []);
        assert(
          said.startsWith("1") &&
            said.includes("aio SFX: payload checksum mismatch (want "),
          said,
        );
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});
