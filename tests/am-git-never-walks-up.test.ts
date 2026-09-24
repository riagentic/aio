// `am upgrade` and `am fix` never run git in a repo that is not theirs.
//
// git WALKS UP: run in a folder that is not itself a repo, it finds the
// nearest enclosing one. `am upgrade` ran `git -C <install>` status → fetch →
// `checkout --force <tag>`, so an install that is a plain copy (a tarball, a
// folder with mod.ts) inside any enclosing repo — a dotfiles repo at `~` —
// fetched into THAT repo and force-checked-out a tag there. `am fix` ran
// `git submodule update --init` for an app folder with a `.gitmodules` that is
// not its own repo, and initialized the ENCLOSING repo's submodules.
//
// Throwaway repos, a sandboxed HOME/AIO_HOME/install roots, a cleared env —
// never the aio repo, never the real home, no network (origins are local).
import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join, relative } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const dec = new TextDecoder();

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await new Deno.Command("git", {
    args: ["-C", cwd, ...args],
    env: GIT_ENV,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!r.success) {
    throw new Error(`git ${args.join(" ")}: ${dec.decode(r.stderr)}`);
  }
  return dec.decode(r.stdout).trim();
}

/** Every entry under `.git`, path → bytes — what "untouched" means. */
async function snapshot(gitDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const visit = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name);
      const rel = relative(gitDir, p);
      if (e.isDirectory) {
        out.set(`${rel}/`, "");
        await visit(p);
      } else out.set(rel, await Deno.readTextFile(p));
    }
  };
  await visit(gitDir);
  return out;
}

/** The entries added, removed or rewritten between two snapshots. */
function changed(a: Map<string, string>, b: Map<string, string>): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort();
}

async function denoDir(): Promise<string> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return JSON.parse(dec.decode(o.stdout)).denoDir;
}

/** A cleared, sandboxed environment for an `am` child. */
async function sandboxEnv(
  base: string,
  own: Record<string, string>,
): Promise<Record<string, string>> {
  const home = join(base, "home");
  await Deno.mkdir(home, { recursive: true });
  return {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    DENO_DIR: await denoDir(),
    HOME: home,
    AIO_APPS_DIR: join(base, "apps"),
    AIO_INSTALL_ROOT: join(home, "app"),
    DENO_INSTALL_ROOT: join(home, ".deno"),
    AIO_VERSIONS_DIR: join(base, "versions"),
    XDG_RUNTIME_DIR: join(base, "run"),
    AIO_AM_NO_DELEGATE: "1",
    NO_COLOR: "1",
    ...GIT_ENV,
    ...own,
  };
}

/** An enclosing repo, DETACHED and clean (so an old `am upgrade` would pass
 *  its dirty/branch guard), whose origin has a newer tag to fetch. */
async function enclosing(base: string): Promise<string> {
  const upstream = join(base, "upstream");
  await Deno.mkdir(upstream);
  await git(upstream, "init", "-q", "-b", "main");
  await git(upstream, "commit", "-q", "--allow-empty", "-m", "one");
  await git(upstream, "tag", "v1.0.0");
  const outer = join(base, "outer");
  await git(base, "clone", "-q", upstream, outer);
  await git(outer, "checkout", "-q", "--detach");
  await git(upstream, "commit", "-q", "--allow-empty", "-m", "two");
  await git(upstream, "tag", "v9.9.9");
  return outer;
}

Deno.test({
  name:
    "am upgrade: an install that is a plain copy inside an enclosing repo is refused, exit 1, and that repo's .git is byte-identical",
  ignore: Deno.build.os === "windows",
  async fn() {
    const base = await tempDir("am-upgrade-no-walk-");
    try {
      const outer = await enclosing(base);
      // The "install": a plain copy of aio (no .git), am run from it.
      const copy = join(outer, "vendor", "aio");
      await Deno.mkdir(copy, { recursive: true });
      const cp = await new Deno.Command("cp", {
        args: [
          "-r",
          join(REPO, "src"),
          join(REPO, "mod.ts"),
          join(REPO, "deno.json"),
          join(REPO, "deno.lock"),
          copy,
        ],
      }).output();
      assertEquals(cp.code, 0, "copy the framework");
      const install = await Deno.realPath(copy);
      const before = await snapshot(join(outer, ".git"));
      const head = await git(outer, "rev-parse", "HEAD");

      const r = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", join(install, "src", "am.ts"), "upgrade", "--json"],
        cwd: install,
        clearEnv: true,
        env: await sandboxEnv(base, { AIO_HOME: install }),
        stdout: "piped",
        stderr: "piped",
      }).output();
      const said = dec.decode(r.stdout) + dec.decode(r.stderr);
      assertEquals(r.code, 1, said);
      assertStringIncludes(said, `AIO at ${install} is not a git clone of aio`);
      assertStringIncludes(said, "install.sh");
      assertEquals(await git(outer, "rev-parse", "HEAD"), head);
      assertEquals(changed(before, await snapshot(join(outer, ".git"))), []);
    } finally {
      await dropTempDir(base);
    }
  },
});

Deno.test({
  name:
    "am fix: a .gitmodules in an app folder that is not its own repo never initializes the enclosing repo's submodules",
  ignore: Deno.build.os === "windows",
  async fn() {
    const base = await tempDir("am-fix-submod-no-walk-");
    try {
      // An enclosing repo with an UNINITIALIZED submodule (a fresh clone).
      const lib = join(base, "lib");
      await Deno.mkdir(lib);
      await git(lib, "init", "-q", "-b", "main");
      await git(lib, "commit", "-q", "--allow-empty", "-m", "lib");
      const seed = join(base, "seed");
      await Deno.mkdir(seed);
      await git(seed, "init", "-q", "-b", "main");
      await git(
        seed,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        lib,
        "lib",
      );
      await git(seed, "commit", "-q", "-m", "with submodule");
      const outer = join(base, "outer");
      await git(base, "clone", "-q", seed, outer);

      // The app: a folder of the enclosing repo, with a .gitmodules of its own.
      const app = join(outer, "app");
      await Deno.mkdir(join(app, "src"), { recursive: true });
      await Deno.writeTextFile(
        join(app, ".gitmodules"),
        await Deno.readTextFile(join(outer, ".gitmodules")),
      );
      await Deno.writeTextFile(
        join(app, "deno.json"),
        JSON.stringify({
          name: "app",
          imports: { aio: "jsr:@riagentic/aio@1.0.0" },
          tasks: { dev: "deno run -A src/app.ts" },
        }),
      );
      await Deno.writeTextFile(
        join(app, "src", "app.ts"),
        `import { aio } from "aio";\nawait aio.run({ appId: "app" });\n`,
      );
      const fw = join(base, "fw");
      await Deno.mkdir(fw);
      await Deno.writeTextFile(join(fw, "mod.ts"), "export {};\n");
      const before = await snapshot(join(outer, ".git"));

      const r = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          join(REPO, "src", "am.ts"),
          "fix",
          "--no-download",
          "--json",
        ],
        cwd: app,
        clearEnv: true,
        env: await sandboxEnv(base, {
          AIO_HOME: fw,
          // Would let an old am's walked-up `submodule update` really clone.
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "protocol.file.allow",
          GIT_CONFIG_VALUE_0: "always",
        }),
        stdout: "piped",
        stderr: "piped",
      }).output();
      const text = dec.decode(r.stdout);
      const report = JSON.parse(text) as {
        results: { name: string; outcome: string; note: string }[];
      };
      const sub = report.results.find((x) =>
        x.name === "git submodules initialized"
      );
      assertEquals(sub?.outcome, "advise", text);
      assertStringIncludes(sub?.note ?? "", "not its own git repo");
      assertEquals(changed(before, await snapshot(join(outer, ".git"))), []);
    } finally {
      await dropTempDir(base);
    }
  },
});
