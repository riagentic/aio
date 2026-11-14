// install.sh said "✓ am works in a new shell too" after checking with
// `sh -lc 'command -v am'` — a login shell that INHERITED the installer's own
// PATH, which it had just extended with $AM_ROOT/bin. On any system whose
// /etc/profile does not reset PATH the check passed whatever was persisted.
// And persist_path wrote a constant `$HOME/.deno/bin`: with DENO_INSTALL_ROOT
// set, `am` lands in $DENO_INSTALL_ROOT/bin, the profile never named it, and
// the user's next terminal had no `am` — after being told it did. A failed
// append to a profile was listed as written all the same.
//
// Driven with the REAL script and the REAL deno, a HOME of its own, and this
// checkout as the repo: no network.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { DENO_DIR, ownHome } from "./deno-dir-helper.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const ON_WINDOWS = Deno.build.os === "windows"; // install.sh is ON_WINDOWS sh; Windows has install.ps1

/** Runs install.sh with `ownHome(root)` — HOME is `<root>/home`. */
async function install(root: string, env: Record<string, string>) {
  const p = await new Deno.Command("sh", {
    args: [join(REPO, "install.sh")],
    env: {
      PATH: `${join(Deno.execPath(), "..")}:/usr/bin:/bin`,
      SHELL: "/bin/bash",
      ...await ownHome(root),
      ...env,
      AIO_REPO: REPO,
    },
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

/** A NEW terminal: a login shell from the system PATH, not the installer's. */
async function freshShellFindsAm(home: string): Promise<boolean> {
  const p = await new Deno.Command("sh", {
    args: ["-lc", "command -v am >/dev/null && am version >/dev/null"],
    env: { HOME: home, PATH: "/usr/bin:/bin", DENO_DIR },
    clearEnv: true,
    stdout: "null",
    stderr: "null",
  }).output();
  return p.success;
}

Deno.test({
  name:
    "install.sh: with DENO_INSTALL_ROOT set, a fresh login shell finds am — the dir it is in is persisted",
  ignore: ON_WINDOWS,
  fn: async () => {
    const dir = await tempDir("aio-install-newshell-");
    try {
      const home = join(dir, "home");
      await Deno.mkdir(home);
      const root = join(dir, "tools");
      const r = await install(dir, {
        AIO_HOME: join(home, "aio"),
        DENO_INSTALL_ROOT: root,
      });
      assertEquals(r.code, 0, r.out);
      const profile = await Deno.readTextFile(join(home, ".profile"));
      assertStringIncludes(profile, join(root, "bin"), profile);
      assert(
        await freshShellFindsAm(home),
        `a new terminal has no am:\n${profile}`,
      );
      assertStringIncludes(r.out, "am works in a new shell too");
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "install.sh: a profile it could not write is never reported as working — the line to add is printed",
  ignore: ON_WINDOWS,
  fn: async () => {
    const dir = await tempDir("aio-install-newshell-");
    try {
      const home = join(dir, "home");
      // ~/.profile a DIRECTORY: the append fails, as a root-owned one would.
      await Deno.mkdir(join(home, ".profile"), { recursive: true });
      const r = await install(dir, { AIO_HOME: join(home, "aio") });
      assertEquals(r.code, 0, r.out);
      assert(
        !await freshShellFindsAm(home),
        "precondition: no profile names am",
      );
      assert(
        !r.out.includes("am works in a new shell too"),
        `claimed a new shell works:\n${r.out}`,
      );
      assertStringIncludes(r.out, "could NOT write");
      assertStringIncludes(r.out, 'export PATH="$HOME/.deno/bin:$PATH"');
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "install.sh: persist_path writes AM_ROOT/bin and a separate DENO_INSTALL/bin, escaped",
  ignore: ON_WINDOWS,
  fn: async () => {
    const sh = await Deno.readTextFile(join(REPO, "install.sh"));
    const fn = sh.match(/^persist_path\(\) \{[\s\S]*?^\}/m)?.[0];
    assert(fn, "persist_path() not found — did it move?");
    const home = await tempDir("persist-root-");
    try {
      const run = (env: Record<string, string>) =>
        new Deno.Command("sh", {
          args: ["-c", `${fn}\npersist_path`],
          env: {
            SHELL: "/bin/bash",
            HOME: home,
            PATH: "/usr/bin:/bin",
            ...env,
          },
          clearEnv: true,
          stdout: "null",
          stderr: "piped",
        }).output();
      const amRoot = join(home, "tools $x");
      const p = await run({ AM_ROOT: amRoot, DENO_INSTALL: "/opt/deno" });
      assertEquals(p.code, 0, new TextDecoder().decode(p.stderr));
      const profile = await Deno.readTextFile(join(home, ".profile"));
      assertStringIncludes(
        profile,
        'export PATH="$HOME/tools \\$x/bin:/opt/deno/bin:$PATH"  # aio',
      );
      // …and the line does what it says in a real shell.
      const q = await new Deno.Command("sh", {
        args: ["-c", `. "${join(home, ".profile")}"; printf %s "$PATH"`],
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        clearEnv: true,
        stdout: "piped",
      }).output();
      assertEquals(
        new TextDecoder().decode(q.stdout),
        `${amRoot}/bin:/opt/deno/bin:/usr/bin:/bin`,
      );
      // Idempotent: a second run adds nothing.
      await run({ AM_ROOT: amRoot, DENO_INSTALL: "/opt/deno" });
      assertEquals(await Deno.readTextFile(join(home, ".profile")), profile);
    } finally {
      await dropTempDir(home);
    }
  },
});
