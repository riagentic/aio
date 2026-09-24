// `am`'s git must address ITS OWN repo even when the environment names another.
//
// GIT_CEILING_DIRECTORIES stops git walking UP into an enclosing repo, but git
// never walks when GIT_DIR (or GIT_WORK_TREE / GIT_INDEX_FILE / …) is already
// set — and git sets exactly those inside a hook and under `git rebase --exec`
// in a linked worktree. An `am` run from there read (and, for `am update` /
// `am fix` / `am create`, WROTE) the outer repo: `knownTags(real)` returned
// the OUTER repo's tag. Every `am` git spawn now goes through `gitEnvFor`,
// which strips git's repo-locating variables and passes `clearEnv: true`.
//
// Sandbox: two throwaway repos in a temp dir; the probe runs in a child with
// a cleared environment, HOME in the temp dir, GIT_CEILING_DIRECTORIES at the
// temp root. The real HOME and this repo's .git are never touched.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { GIT_REPO_ENV_VARS } from "../src/am/am-versions.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const VERSIONS = new URL("../src/am/am-versions.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

async function git(cwd: string, env: Record<string, string>, ...a: string[]) {
  const o = await new Deno.Command("git", {
    args: a,
    cwd,
    clearEnv: true,
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  if (!o.success) throw new Error(`git ${a.join(" ")}: ${d.decode(o.stderr)}`);
  return d.decode(o.stdout).trim();
}

Deno.test("am git: an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE never redirects am to another repo", async () => {
  const base = await tempDir("aio-am-git-env-");
  try {
    const home = join(base, "home");
    await Deno.mkdir(home);
    const env: Record<string, string> = {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: home,
      GIT_CEILING_DIRECTORIES: base,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    const denoDir = Deno.env.get("DENO_DIR");
    if (denoDir) env.DENO_DIR = denoDir;
    const repo = async (dir: string, tag: string) => {
      await Deno.mkdir(dir, { recursive: true });
      await git(dir, env, "init", "-q", "-b", "main");
      await Deno.writeTextFile(join(dir, "mod.ts"), "export {};\n");
      await git(dir, env, "add", "-A");
      await git(dir, env, "commit", "-q", "-m", "x");
      await git(dir, env, "tag", tag);
    };
    const outer = join(base, "outer");
    const real = join(outer, "real");
    await repo(outer, "v9.9.9");
    await repo(real, "v1.0.0");

    const probe = `
      const { isClone, knownTags } = await import(${JSON.stringify(VERSIONS)});
      const r = ${JSON.stringify(real)};
      console.log(JSON.stringify({ tags: await knownTags(r), clone: await isClone(r) }));
    `;
    const run = async (extra: Record<string, string>) => {
      const o = await new Deno.Command(Deno.execPath(), {
        args: ["eval", "--config", CONFIG, probe],
        clearEnv: true,
        env: { ...env, ...extra },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const d = new TextDecoder();
      assert(o.success, d.decode(o.stderr));
      return JSON.parse(d.decode(o.stdout)) as {
        tags: string[];
        clone: boolean;
      };
    };
    const want = { tags: ["v1.0.0"], clone: true };
    assertEquals(await run({}), want, "baseline");
    // What git exports in a hook of the OUTER repo.
    assertEquals(
      await run({
        GIT_DIR: join(outer, ".git"),
        GIT_WORK_TREE: outer,
        GIT_INDEX_FILE: join(outer, ".git", "index"),
        GIT_PREFIX: "",
      }),
      want,
      "GIT_DIR of the outer repo leaked into am's git",
    );
    // A linked worktree's shared repo, alone.
    assertEquals(await run({ GIT_COMMON_DIR: join(outer, ".git") }), want);
  } finally {
    await dropTempDir(base);
  }
});

Deno.test("am git: GIT_REPO_ENV_VARS covers every variable git itself clears (rev-parse --local-env-vars)", async () => {
  const o = await new Deno.Command("git", {
    args: ["rev-parse", "--local-env-vars"],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  assert(o.success, "git rev-parse --local-env-vars failed");
  const gits = new TextDecoder().decode(o.stdout).split("\n").map((l) =>
    l.trim()
  ).filter(Boolean);
  assert(gits.includes("GIT_DIR"), gits.join(","));
  assertEquals(gits.filter((v) => !GIT_REPO_ENV_VARS.includes(v)), []);
});
