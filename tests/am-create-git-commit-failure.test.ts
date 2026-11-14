// `am create` reported `"git": "initialized"` — "git initialized (first commit
// made)" — when the first commit had FAILED: tryGitInit never read the
// commit's exit status. A machine with `commit.gpgsign = true` and no working
// signer (or a global core.hooksPath hook that rejects) got a repo with no
// commit, every file staged-but-uncommitted, every build "-dirty", and a
// report that said the opposite. The state is now its own, carries git's
// words, and both reports say how to make the commit.
import "./store-sandbox.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { cmdCreate, gitSentence } from "../src/am/am-cmd-create.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url)).replace(/[\\/]$/, "");

const hasGit = await new Deno.Command("git", {
  args: ["--version"],
  stdout: "null",
  stderr: "null",
}).output().then((o) => o.success, () => false);

async function createJson(cwd: string, name: string) {
  const orig = Deno.cwd();
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    Deno.chdir(cwd);
    await cmdCreate([name, `--mirror=${ROOT}`], { json: true } as GlobalFlags);
  } finally {
    console.log = real;
    Deno.chdir(orig);
  }
  return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
}

Deno.test("gitSentence: a failed first commit is said, with git's reason and the command", () => {
  const s = gitSentence(
    "commit failed: error: gpg failed to sign the data\nfatal: failed to write commit object",
  );
  assertStringIncludes(s, "first commit FAILED");
  assertStringIncludes(s, "gpg failed to sign the data");
  assertStringIncludes(s, 'git commit -m "initial commit"');
  assert(!s.includes("first commit made"), s);
  assertEquals(
    gitSentence("initialized"),
    "git initialized (first commit made)",
  );
});

Deno.test({
  name:
    "am create: a commit git refuses (gpgsign, no signer) is never reported as made",
  ignore: !hasGit || Deno.build.os === "windows",
  fn: async () => {
    const root = await tempDir("aio-create-git-");
    const apps = await tempDir("aio-create-git-apps-");
    const prevCfg = Deno.env.get("GIT_CONFIG_GLOBAL");
    const prevApps = Deno.env.get("AIO_APPS_DIR");
    try {
      const gitcfg = join(root, "gitconfig");
      await Deno.writeTextFile(
        gitcfg,
        "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /bin/false\n",
      );
      Deno.env.set("GIT_CONFIG_GLOBAL", gitcfg);
      Deno.env.set("AIO_APPS_DIR", apps);
      const report = await createJson(root, "gitapp");
      const head = await new Deno.Command("git", {
        args: ["rev-parse", "--verify", "-q", "HEAD"],
        cwd: join(root, "gitapp"),
        stdout: "null",
        stderr: "null",
      }).output();
      assert(!head.success, "the commit succeeded — precondition not met");
      const git = String(report.git);
      assert(git.startsWith("commit failed: "), `git = ${git}`);
      assertStringIncludes(git, "gpg"); // git's own words, carried
      assertStringIncludes(
        String(report.gitWarning),
        'git commit -m "initial commit"',
      );
    } finally {
      if (prevCfg === undefined) Deno.env.delete("GIT_CONFIG_GLOBAL");
      else Deno.env.set("GIT_CONFIG_GLOBAL", prevCfg);
      if (prevApps === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prevApps);
      await dropTempDir(root);
      await dropTempDir(apps);
    }
  },
});
