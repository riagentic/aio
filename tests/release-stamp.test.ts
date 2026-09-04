// The release stamp: a tag is cut only from the tree check:release ran on.
// Four gates were red at the alpha76 tag while every note since said "green"
// — each a run on some EARLIER tree. The stamp is keyed by the working-tree
// hash, so it survives the release squash (same content, same hash) and dies
// on the first edit after the check.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  STAMP_PATH,
  verifyStamp,
  workingTreeHash,
  writeStamp,
} from "../scripts/release-stamp.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = await new Deno.Command("git", {
    args: ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (p.code !== 0) throw new Error(new TextDecoder().decode(p.stderr));
}

async function repo(): Promise<string> {
  const dir = await tempDir("aio-release-stamp-");
  await git(dir, "init", "-q");
  await Deno.writeTextFile(join(dir, ".gitignore"), ".aio/\n");
  await Deno.writeTextFile(join(dir, "deno.json"), '{"version":"1.0.0-x"}\n');
  await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 1;\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", "base");
  return dir;
}

Deno.test("release stamp: the working-tree hash survives a commit and a squash, not an edit", async () => {
  const dir = await repo();
  try {
    await Deno.writeTextFile(join(dir, "b.ts"), "export const b = 2;\n");
    const dirty = await workingTreeHash(dir); // untracked file counts
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "wip");
    assertEquals(await workingTreeHash(dir), dirty, "commit: same content");
    await Deno.writeTextFile(join(dir, "c.ts"), "export const c = 3;\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "wip2");
    const two = await workingTreeHash(dir);
    // The release squash: same files, one commit.
    await git(dir, "reset", "-q", "--soft", "HEAD~2");
    await git(dir, "commit", "-qm", "release");
    assertEquals(await workingTreeHash(dir), two, "squash: same content");
    await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 2;\n");
    assert(await workingTreeHash(dir) !== two, "an edit changes it");
    // The real index was never touched by the throwaway one.
    const st = await new Deno.Command("git", {
      args: ["status", "--porcelain"],
      cwd: dir,
      stdout: "piped",
    }).output();
    assertEquals(new TextDecoder().decode(st.stdout).trimEnd(), " M a.ts");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("release stamp: verify refuses without a stamp, after an edit, and on a version mismatch", async () => {
  const dir = await repo();
  try {
    const none = await verifyStamp("1.0.0-x", dir);
    assert(!none.ok);
    assertStringIncludes(none.reason, "no release stamp");

    await writeStamp("1.0.0-x", dir);
    assert((await Deno.stat(join(dir, STAMP_PATH))).isFile);
    const ok = await verifyStamp("1.0.0-x", dir);
    assert(ok.ok, ok.reason);

    // The squash keeps the stamp valid …
    await Deno.writeTextFile(join(dir, "b.ts"), "export const b = 2;\n");
    await writeStamp("1.0.0-x", dir);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "release");
    assert((await verifyStamp("1.0.0-x", dir)).ok, "commit keeps it valid");

    // … an edit after the check does not.
    await Deno.writeTextFile(join(dir, "b.ts"), "export const b = 3;\n");
    const edited = await verifyStamp("1.0.0-x", dir);
    assert(!edited.ok);
    assertStringIncludes(edited.reason, "tree changed");

    await writeStamp("1.0.0-x", dir);
    const wrongVersion = await verifyStamp("1.0.0-y", dir);
    assert(!wrongVersion.ok);
    assertStringIncludes(wrongVersion.reason, "deno.json says 1.0.0-y");
  } finally {
    await dropTempDir(dir);
  }
});
