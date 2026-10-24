// `am upgrade` checks the framework out at THE latest release — the newest
// `v*` tag by semver on origin/main, the same answer `am create` / `am pin`
// give — never the nearest tag by ancestry. `git describe --tags origin/main`
// was the rule: a maintenance `v1.2.1` merged into main after `v2.0.0` checked
// out 1.2.1 (a silent framework downgrade), and any tag on main (`proof-ci`)
// was checked out as if it were a release.
import "./store-sandbox.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { upgradeTarget } from "../src/am/am-cmd-meta.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const o = await new Deno.Command("git", {
    args: [
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "user.name=t",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!o.success) {
    throw new Error(
      `git ${args.join(" ")}: ${new TextDecoder().decode(o.stderr)}`,
    );
  }
}

Deno.test("am upgrade: the target is the newest release on origin/main, never the nearest tag", async () => {
  const root = await tempDir("am-upgrade-target-");
  try {
    const up = join(root, "upstream");
    await Deno.mkdir(up);
    const commit = (m: string) =>
      git(up, "commit", "-q", "--allow-empty", "-m", m);
    await git(up, "init", "-q");
    await commit("base");
    await git(up, "tag", "v1.2.0");
    await git(up, "checkout", "-q", "-b", "maint");
    await commit("fix");
    await git(up, "tag", "v1.2.1");
    await git(up, "checkout", "-q", "main");
    await commit("feature");
    await git(up, "tag", "v2.0.0");
    await commit("after");
    await git(up, "merge", "-q", "--no-edit", "maint");
    await commit("ci");
    await git(up, "tag", "proof-ci");
    // An orphaned release-looking tag: not on main, never "latest".
    await git(up, "checkout", "-q", "-b", "abandoned");
    await commit("wip");
    await git(up, "tag", "v9.0.0");
    await git(up, "checkout", "-q", "main");

    const clone = join(root, "clone");
    await git(root, "clone", "-q", up, clone);
    assertEquals(await upgradeTarget(clone), "v2.0.0");
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("am upgrade: a clone with no release tag targets origin/main", async () => {
  const root = await tempDir("am-upgrade-target-");
  try {
    const up = join(root, "upstream");
    await Deno.mkdir(up);
    await git(up, "init", "-q");
    await git(up, "commit", "-q", "--allow-empty", "-m", "base");
    await git(up, "tag", "proof-ci");
    const clone = join(root, "clone");
    await git(root, "clone", "-q", up, clone);
    assertEquals(await upgradeTarget(clone), "origin/main");
  } finally {
    await dropTempDir(root);
  }
});
