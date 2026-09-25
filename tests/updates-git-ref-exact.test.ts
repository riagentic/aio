// `git ls-remote <src> main` matches ref-name TAILS: it lists
// `refs/heads/feature/main` as well as `refs/heads/main`, and the former sorts
// first. The checker took the first line, so a repository with any branch
// ending in `/main` was followed at the WRONG branch — while the rebuild clones
// `--branch main`. The recorded commit could then never equal the "head", and
// every check offered the same update again: with `auto`, an endless rebuild
// loop.
import { assert, assertEquals } from "@std/assert";
import { gitLsRemote } from "../src/server/updates-check.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "null",
    env: {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    },
  }).output();
  assert(out.success, args.join(" "));
  return new TextDecoder().decode(out.stdout).trim();
}

Deno.test("updates: a git source follows EXACTLY the named branch, not one whose name ends with it", async () => {
  const dir = await tempDir("aio-upd-git-exact-");
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "commit", "-q", "--allow-empty", "-m", "on main");
  const main = await git(dir, "rev-parse", "HEAD");
  await git(dir, "checkout", "-q", "-b", "feature/main");
  await git(dir, "commit", "-q", "--allow-empty", "-m", "on feature/main");
  // An annotated tag whose name also ends in `main` — its `^{}` line must not
  // outrank the branch either.
  await git(dir, "tag", "-a", "release/main", "-m", "t");
  await git(dir, "checkout", "-q", "main");

  const got = await gitLsRemote(dir, "main");
  assert(got.ok, got.ok ? "" : got.error);
  assertEquals(
    got.head.sha,
    main,
    "refs/heads/main, not refs/heads/feature/main",
  );
});

Deno.test("updates: a git ref that only matches as a suffix is refused, naming what matched", async () => {
  const dir = await tempDir("aio-upd-git-exact-");
  await git(dir, "init", "-q", "-b", "trunk");
  await git(dir, "commit", "-q", "--allow-empty", "-m", "one");
  await git(dir, "branch", "team/main");
  const got = await gitLsRemote(dir, "main");
  assertEquals(got.ok, false, "there is no branch or tag named `main`");
  if (!got.ok) assert(got.error.includes("refs/heads/team/main"), got.error);
});
