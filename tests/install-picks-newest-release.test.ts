// install.sh picked the release to install with `git describe --tags` — the
// NEAREST tag by ancestry, any name. A maintenance `v1.2.1` merged into main
// after `v2.0.0` installed 1.2.1 (a silent downgrade), and a non-release tag
// on main (`proof-ci`) was checked out as a release. `am upgrade` had already
// moved to the newest `v*` tag by semver (latestTag); the installers now use
// the same rule. The awk port in install.sh is held to updates-core's
// compareVersions here, pair by pair, so the two cannot drift apart.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { compareVersions } from "../src/server/updates-core.ts";
import { MIN_DENO } from "../src/server/deno-version.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { ownHome } from "./deno-dir-helper.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const posix = Deno.build.os !== "windows"; // install.sh is POSIX sh; Windows has install.ps1

/** The exact `newest_version` function text from install.sh. */
async function newestVersionFn(): Promise<string> {
  const sh = await Deno.readTextFile(join(REPO, "install.sh"));
  const m = /^newest_version\(\) \{\n[\s\S]*?\n\}\n/m.exec(sh);
  assert(m, "install.sh has no newest_version() function");
  return m[0];
}

async function shNewest(fn: string, tags: string[]): Promise<string> {
  const p = new Deno.Command("sh", {
    args: ["-c", `${fn}\nnewest_version`],
    env: { PATH: "/usr/bin:/bin" },
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode(tags.join("\n") + "\n"));
  await w.close();
  const o = await p.output();
  assertEquals(o.code, 0, new TextDecoder().decode(o.stderr));
  return new TextDecoder().decode(o.stdout).trim();
}

const SAMPLE = [
  "v1.0.0",
  "v1.0.0-alpha9",
  "v1.0.0-alpha62",
  "v1.0.0-alpha.62",
  "v1.0.0-alpha77.1",
  "v1.0.0-beta",
  "v1.0.0-beta.2",
  "v1.0.0-beta.11",
  "v1.0.0-rc1",
  "v1.0.0-RC1",
  "v1.0.24-beta",
  "v1.0.9-beta",
  "v1.2.3+build1",
  "v1.2.3",
  "v1.2.3-rc.1+abc",
  "v1.2",
  "v2",
  "v2.0.0-rc-1",
  "v10.0.0",
];

Deno.test({
  name: "install.sh newest_version agrees with compareVersions on every pair",
  ignore: !posix,
  fn: async () => {
    const fn = await newestVersionFn();
    for (const a of SAMPLE) {
      for (const b of SAMPLE) {
        if (a === b) continue;
        const want = compareVersions(a, b) >= 0 ? a : b;
        const got = await shNewest(fn, [b, a]);
        // A tie (1.2.3 vs 1.2.3+build1) keeps the first seen — either is right.
        if (compareVersions(a, b) === 0) assert(got === a || got === b);
        else assertEquals(got, want, `newest of ${a} / ${b}`);
      }
    }
  },
});

Deno.test({
  name: "install.sh newest_version skips tags it cannot order",
  ignore: !posix,
  fn: async () => {
    const fn = await newestVersionFn();
    assertEquals(
      await shNewest(fn, ["vnext", "v1.0.0-alpha9", "v9.x"]),
      "v1.0.0-alpha9",
    );
    assertEquals(await shNewest(fn, ["vnext", "proof-ci"]), "");
    assertEquals(await shNewest(fn, []), "");
  },
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const o = await new Deno.Command("git", {
    args: ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(o.stdout).trim();
  assertEquals(
    o.code,
    0,
    `git ${args.join(" ")}: ${new TextDecoder().decode(o.stderr)}`,
  );
  return out;
}

Deno.test({
  name:
    "install.sh installs the newest v* release on the branch, not the nearest tag",
  ignore: !posix,
  fn: async () => {
    const dir = await tempDir("aio-install-newest-");
    try {
      // A source repo whose NEAREST tags are exactly the wrong answers.
      const src = join(dir, "src");
      await Deno.mkdir(src);
      await git(src, "init", "-q", "-b", "main");
      const commit = async (msg: string) => {
        await Deno.writeTextFile(join(src, "f"), msg);
        await git(src, "add", "f");
        await git(src, "commit", "-q", "-m", msg);
        return await git(src, "rev-parse", "HEAD");
      };
      await commit("a");
      await git(src, "tag", "v1.0.0-alpha62");
      const release = await commit("b");
      await git(src, "tag", "v2.0.0");
      await commit("c");
      await git(src, "tag", "v1.2.1"); // maintenance tag merged later
      await commit("d");
      await git(src, "tag", "proof-ci"); // non-release, nearest of all
      // Never released: a newer version on a branch main does not contain.
      await git(src, "checkout", "-q", "-b", "side", "HEAD~3");
      await commit("e");
      await git(src, "tag", "v9.0.0");
      await git(src, "checkout", "-q", "main");

      const bin = join(dir, "bin");
      await Deno.mkdir(bin);
      await Deno.writeTextFile(
        join(bin, "deno"),
        `#!/bin/sh\ncase "$1" in --version) echo "deno ${MIN_DENO} (release)" ;; *) exit 0 ;; esac\n`,
      );
      await Deno.writeTextFile(
        join(bin, "curl"),
        `#!/bin/sh\necho "no network" >&2; exit 7\n`,
      );
      await Deno.chmod(join(bin, "deno"), 0o755);
      await Deno.chmod(join(bin, "curl"), 0o755);

      const own = await ownHome(dir);
      const home = own.HOME!;
      const aioHome = join(dir, "aio");
      const o = await new Deno.Command("sh", {
        args: [join(REPO, "install.sh")],
        env: {
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin`,
          AIO_HOME: aioHome,
          AIO_REPO: src,
          AIO_BRANCH: "main",
          DENO_INSTALL: join(home, ".deno"),
          DENO_INSTALL_ROOT: join(home, ".deno"),
          ...own,
        },
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(o.stdout) +
        new TextDecoder().decode(o.stderr);
      assertStringIncludes(out, "✓ aio v2.0.0", out);
      assertEquals(await git(aioHome, "rev-parse", "HEAD"), release);
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  // The PowerShell port, held to the same comparator. Runs where install.ps1
  // runs (the Windows native suite); no pwsh on the POSIX boxes.
  name:
    "install.ps1 Get-NewestVersion agrees with compareVersions on every pair",
  ignore: posix,
  fn: async () => {
    const ps = await Deno.readTextFile(join(REPO, "install.ps1"));
    const a = ps.indexOf("function Get-VersionPieces");
    const b = ps.indexOf("function Get-DenoVersion");
    assert(
      a > 0 && b > a,
      "install.ps1 has no Get-VersionPieces..Get-NewestVersion block",
    );
    const pairs = SAMPLE.flatMap((x) =>
      SAMPLE.filter((y) => y !== x).map((y) => [y, x])
    );
    const script = ps.slice(a, b) + "\n$ErrorActionPreference = 'Stop'\n" +
      pairs.map(([x, y]) =>
        `Write-Output (Get-NewestVersion @('${x}', '${y}'))`
      ).join("\n");
    const o = await new Deno.Command("powershell", {
      args: ["-NoProfile", "-NonInteractive", "-Command", "-"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const w = o.stdin.getWriter();
    await w.write(new TextEncoder().encode(script));
    await w.close();
    const r = await o.output();
    assertEquals(r.code, 0, new TextDecoder().decode(r.stderr));
    const got = new TextDecoder().decode(r.stdout).split(/\r?\n/).filter(
      Boolean,
    );
    assertEquals(got.length, pairs.length);
    pairs.forEach(([x, y], i) => {
      const c = compareVersions(y!, x!);
      if (c !== 0) assertEquals(got[i], c > 0 ? y : x, `newest of ${x} / ${y}`);
    });
  },
});
