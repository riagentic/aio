// install.ps1, RUN — the whole file, under Windows PowerShell, on Windows.
//
// It never had been: `git clone … 2>&1` under `$ErrorActionPreference =
// 'Stop'` ended the script on git's own "Cloning into …" line (Windows
// PowerShell 5.1 turns a redirected stderr line into a terminating error),
// and nothing in the suite could see it. Here it installs for real — into a
// throwaway home, from a local repository, with the one step that reaches
// outside those folders (the user's PATH) observed instead of applied.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = join(import.meta.dirname!, "..");

const userPath = async () =>
  new TextDecoder().decode(
    (await new Deno.Command("powershell", {
      args: [
        "-NoProfile",
        "-Command",
        "[Environment]::GetEnvironmentVariable('Path', 'User')",
      ],
      stdout: "piped",
    }).output()).stdout,
  ).trim();

Deno.test({
  name:
    "install.ps1 (run under Windows PowerShell): clones, checks out the last tag, installs am that runs — and a second run updates",
  ignore: Deno.build.os !== "windows", // the Windows installer is the subject
  async fn() {
    const dir = await tempDir("install-ps1-e2e-");
    try {
      // The framework as a local git repository with one tag: what the
      // installer clones instead of GitHub.
      const origin = join(dir, "origin");
      await Deno.mkdir(origin);
      // (`proof-matrix.json`: `src/build-all.ts` imports it — `am` does not
      // load without it)
      for (
        const part of [
          "src",
          "mod.ts",
          "deno.json",
          "deno.lock",
          "proof-matrix.json",
        ]
      ) {
        await copy(join(ROOT, part), join(origin, part));
      }
      const git = async (...args: string[]) => {
        const o = await new Deno.Command("git", {
          args: [
            "-C",
            origin,
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.invalid",
            "-c",
            "core.autocrlf=false",
            ...args,
          ],
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(o.success, new TextDecoder().decode(o.stderr));
      };
      await git("init", "-q", "-b", "main");
      await git("add", "-A");
      await git("commit", "-q", "-m", "framework");
      await git("tag", "v0.0.1-lab");

      const home = join(dir, "home");
      // With `AppData\Local`, as every real profile has it. A PowerShell
      // started with a USERPROFILE that lacks it resolves "local app data" to
      // the EMPTY string and writes its module cache RELATIVE to its working
      // directory: `Microsoft\Windows\PowerShell\ModuleAnalysisCache` appeared
      // in the repository after every suite run (measured on Windows 11).
      await Deno.mkdir(join(home, "AppData", "Local"), { recursive: true });
      const install = async () => {
        const o = await new Deno.Command("powershell", {
          args: [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(ROOT, "install.ps1"),
          ],
          cwd: dir, // …and whatever else is written relatively stays here
          clearEnv: true,
          env: {
            ...Object.fromEntries(
              Object.entries(Deno.env.toObject()).filter(([k]) =>
                !/^AIO_/i.test(k)
              ),
            ),
            HOME: home,
            USERPROFILE: home,
            APPDATA: join(home, "Roaming"),
            LOCALAPPDATA: join(home, "Local"),
            DENO_INSTALL: join(home, ".deno"),
            DENO_INSTALL_ROOT: join(home, ".deno"),
            AIO_REPO: origin,
            AIO_NO_PATH_WRITE: "1",
            NO_COLOR: "1",
          },
          stdout: "piped",
          stderr: "piped",
        }).output();
        return {
          code: o.code,
          said: new TextDecoder().decode(o.stdout) +
            new TextDecoder().decode(o.stderr),
        };
      };

      const before = await userPath();
      const first = await install();
      assertEquals(first.code, 0, first.said);
      const aio = join(home, ".local", "lib", "aio");
      assertStringIncludes(first.said, `cloning aio -> ${aio}`);
      assertStringIncludes(first.said, "aio v0.0.1-lab");
      assertStringIncludes(first.said, "am installed: ");
      assertStringIncludes(first.said, "PATH not changed");
      assert((await Deno.stat(join(aio, ".git"))).isDirectory);
      assert((await Deno.stat(join(home, ".deno", "bin", "am.cmd"))).isFile);

      // Again, as every `run.ps1` does: the update path.
      await Deno.writeTextFile(join(origin, "NEW"), "x");
      await git("add", "-A");
      await git("commit", "-q", "-m", "next");
      await git("tag", "v0.0.2-lab");
      const second = await install();
      assertEquals(second.code, 0, second.said);
      assertStringIncludes(second.said, `updating aio in ${aio}`);
      assertStringIncludes(second.said, "aio v0.0.2-lab");
      assert((await Deno.stat(join(aio, "NEW"))).isFile);

      assertEquals(await userPath(), before, "the user's PATH was written");
    } finally {
      await dropTempDir(dir);
    }
  },
});
