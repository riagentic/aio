// `am` must never run git in a repo that is not aio's.
//
// `isClone(root)` asked `git -C root rev-parse --git-dir`, and git WALKS UP:
// a plain `AIO_HOME` (a tarball copy, a folder with mod.ts) that sits
// anywhere inside another repo — `~/tmp/.git`, a dotfiles repo at `~` — read
// as a clone, and `ensureVersion` then fetched into, pruned and cut worktrees
// from THAT repo (measured: a `FETCH_HEAD` appeared in `~/tmp/.git`). Every
// git call the version store makes is now pinned to its directory
// (GIT_CEILING_DIRECTORIES = its parent), and a clone is an aio checkout
// (`mod.ts`) whose own top level is `root`.
//
// Throwaway repos only — never the aio repo, never a real HOME.
import { assert, assertEquals } from "@std/assert";
import { join, relative } from "@std/path";
import {
  ensureVersion,
  isClone,
  knownTags,
  pruneStoreRegistrations,
  removeVersion,
} from "../src/am/am-versions.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  const r = await new Deno.Command("git", {
    args: ["-C", cwd, ...args],
    env: GIT_ENV,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!r.success) {
    throw new Error(
      `git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`,
    );
  }
}

/** Every file under `.git`, path + bytes — what "untouched" means. */
async function snapshot(gitDir: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name);
      const rel = relative(gitDir, p);
      if (e.isDirectory) {
        out.push(`${rel}/`);
        await visit(p);
      } else out.push(`${rel}:${await Deno.readTextFile(p)}`);
    }
  };
  await visit(gitDir);
  return out.sort();
}

/** An enclosing repo with a release tag and a fetchable origin that has a
 *  NEWER one — so a walked-up `fetch` would visibly write refs. */
async function enclosing(base: string): Promise<string> {
  const upstream = join(base, "upstream");
  await Deno.mkdir(upstream);
  await git(upstream, "init", "-q", "-b", "main");
  await git(upstream, "commit", "-q", "--allow-empty", "-m", "one");
  await git(upstream, "tag", "v1.0.0");
  const outer = join(base, "outer");
  await git(base, "clone", "-q", upstream, outer);
  await git(upstream, "commit", "-q", "--allow-empty", "-m", "two");
  await git(upstream, "tag", "v1.0.1");
  return outer;
}

Deno.test({
  name:
    "am versions: a plain AIO_HOME inside an enclosing repo is not a clone, and that repo's .git stays byte-identical",
  async fn() {
    const base = await tempDir("am-no-walk-up-");
    const prev = Deno.env.get("AIO_VERSIONS_DIR");
    try {
      const outer = await enclosing(base);
      const plain = join(outer, "vendor", "aio"); // an aio checkout, no .git
      await Deno.mkdir(plain, { recursive: true });
      await Deno.writeTextFile(join(plain, "mod.ts"), "export {};\n");
      Deno.env.set("AIO_VERSIONS_DIR", join(base, "versions"));
      const before = await snapshot(join(outer, ".git"));

      assertEquals(await isClone(plain), false);
      assertEquals(await knownTags(plain), [], "tags read from the outer repo");
      const r = await ensureVersion(plain, "v1.0.1");
      assertEquals(r.ok, false);
      await ensureVersion(plain, "main");
      await pruneStoreRegistrations(plain);
      await removeVersion(plain, "v1.0.0");

      assertEquals(await snapshot(join(outer, ".git")), before);
    } finally {
      if (prev === undefined) Deno.env.delete("AIO_VERSIONS_DIR");
      else Deno.env.set("AIO_VERSIONS_DIR", prev);
      await dropTempDir(base);
    }
  },
});

Deno.test({
  name:
    "am versions: a repo's own top level is a clone only when it is an aio checkout (mod.ts)",
  async fn() {
    const base = await tempDir("am-clone-identity-");
    try {
      const repo = join(base, "repo");
      await Deno.mkdir(repo);
      await git(repo, "init", "-q");
      assertEquals(await isClone(repo), false, "a repo that is not aio's");
      await Deno.writeTextFile(join(repo, "mod.ts"), "export {};\n");
      assert(await isClone(repo), "an aio checkout at its own top level");
    } finally {
      await dropTempDir(base);
    }
  },
});
