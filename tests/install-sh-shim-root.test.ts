// Where `am` lands is deno's install ROOT, not where the deno binary lives.
//
// install.sh exported `DENO_INSTALL_ROOT` derived from `DENO_INSTALL`. The two
// are different directories: `DENO_INSTALL` holds a deno binary, and
// `DENO_INSTALL_ROOT` is where `deno install -g` writes shims — by default
// `$HOME/.deno`, the one bin dir the installer puts on PATH. Tying them
// together sent the `am` shim into the deno binary's dir:
//
//   • `DENO_INSTALL=/opt/deno` (a system deno, read-only) → "failed creating
//     '/opt/deno/bin/.am' … Permission denied", and no am at all;
//   • anywhere writable, am landed outside `~/.deno/bin` — the dir PATH gets.
//
// Driven with the REAL script and the REAL deno (the rule under test is
// deno's own), a HOME of its own, and this checkout as the repo: no network.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** deno's module cache — a sandboxed HOME would otherwise mean an empty one,
 *  and a download of every dependency. */
async function denoDir(): Promise<string> {
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return JSON.parse(new TextDecoder().decode(p.stdout)).denoDir;
}

async function install(
  env: Record<string, string>,
): Promise<{ code: number; out: string }> {
  const p = await new Deno.Command("sh", {
    args: [join(REPO, "install.sh")],
    env: { ...env, AIO_REPO: REPO, DENO_DIR: await denoDir() },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: p.code,
    out: new TextDecoder().decode(p.stdout) +
      new TextDecoder().decode(p.stderr),
  };
}

const exists = (p: string) => Deno.lstat(p).then(() => true, () => false);

Deno.test({
  name:
    "install.sh: a read-only DENO_INSTALL (a system deno) still installs am — into ~/.deno/bin",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await tempDir("aio-install-shim-");
    const opt = join(dir, "opt");
    try {
      const home = join(dir, "home");
      await Deno.mkdir(home);
      await Deno.mkdir(join(opt, "bin"), { recursive: true });
      await Deno.symlink(Deno.execPath(), join(opt, "bin", "deno"));
      await Deno.chmod(join(opt, "bin"), 0o555);
      await Deno.chmod(opt, 0o555);

      const r = await install({
        HOME: home,
        AIO_HOME: join(home, "aio"),
        DENO_INSTALL: opt,
        PATH: "/usr/bin:/bin", // deno is reachable ONLY through DENO_INSTALL
      });
      assertEquals(r.code, 0, r.out);
      assert(
        await exists(join(home, ".deno", "bin", "am")),
        `no am in ~/.deno/bin:\n${r.out}`,
      );
      assertEquals(
        [...Deno.readDirSync(join(opt, "bin"))].map((e) => e.name),
        ["deno"],
        "the deno binary's dir was written to",
      );
    } finally {
      await Deno.chmod(opt, 0o755).catch(() => {});
      await Deno.chmod(join(opt, "bin"), 0o755).catch(() => {});
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "install.sh: a DENO_INSTALL_ROOT the user set is where am goes, and where it is looked for",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await tempDir("aio-install-shim-");
    try {
      const home = join(dir, "home");
      const root = join(dir, "my root");
      await Deno.mkdir(home);
      const r = await install({
        HOME: home,
        AIO_HOME: join(home, "aio"),
        DENO_INSTALL_ROOT: root,
        PATH: `${join(Deno.execPath(), "..")}:/usr/bin:/bin`,
      });
      assertEquals(r.code, 0, r.out);
      assert(await exists(join(root, "bin", "am")), r.out);
      assert(
        !await exists(join(home, ".deno", "bin", "am")),
        "am was ALSO written to ~/.deno/bin",
      );
      // The shim it pinned to an absolute deno is the one that landed: the
      // post-install check looked in the same place deno wrote to.
      const shim = await Deno.readTextFile(join(root, "bin", "am"));
      assert(/^exec "\/[^"]+deno" /m.test(shim), shim);
    } finally {
      await dropTempDir(dir);
    }
  },
});
