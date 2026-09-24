// "latest" vs "available" (llama §2b): `am pin` printed
// `"latest": "v1.0.8-beta"` with `v1.0.9-beta` in `available`, and `am fix`
// sealed the older one, with no word why. `latest` is the newest tag MERGED
// into the clone's origin/main (an orphaned tag must never be latest); the
// versions store is shared by every clone on the machine, so a newer release
// can be provisioned while THIS clone's origin/main was never fetched. One
// decider (`latestRelease`) answers both, and says the disagreement.
//
// Throwaway git repos (a local "origin" and a clone of it) and a throwaway
// versions store — no network, no real HOME, never the aio repo.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { latestRelease, offMainNote } from "../src/am/am-versions.ts";
import { pinInfo } from "../src/am/am-cmd-pin.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const r = await new Deno.Command("git", {
    args: ["-C", cwd, ...args],
    env: {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!r.success) {
    throw new Error(
      `git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`,
    );
  }
}

Deno.test("offMainNote: silent when nothing disagrees; names the release and the fetch otherwise", () => {
  assertEquals(offMainNote("/r", []), null);
  const n = offMainNote("/r", ["v1.0.9-beta"])!;
  assertStringIncludes(n, "v1.0.9-beta provisioned but not on origin/main");
  assertStringIncludes(n, "git -C /r fetch origin main");
});

Deno.test({
  name:
    "latestRelease: a provisioned release newer than the clone's origin/main is reported, not silently passed over",
  async fn() {
    const base = await tempDir("am-latest-offmain-");
    const prev = Deno.env.get("AIO_VERSIONS_DIR");
    try {
      const origin = join(base, "origin");
      const clone = join(base, "clone");
      await Deno.mkdir(origin);
      await git(origin, "init", "-q", "-b", "main");
      await git(origin, "commit", "-q", "--allow-empty", "-m", "one");
      await git(origin, "tag", "v1.0.8-beta");
      await git(base, "clone", "-q", origin, clone);
      // Released upstream AFTER the clone last fetched.
      await git(origin, "commit", "-q", "--allow-empty", "-m", "two");
      await git(origin, "tag", "v1.0.9-beta");
      await git(origin, "tag", "v2.0.0-alpha1");

      // The shared store already holds the newer ones (another clone put them).
      const store = join(base, "versions");
      for (const v of ["v1.0.8-beta", "v1.0.9-beta", "v2.0.0-alpha1", "main"]) {
        await Deno.mkdir(join(store, v), { recursive: true });
      }
      Deno.env.set("AIO_VERSIONS_DIR", store);

      assertEquals(await latestRelease(clone), {
        latest: "v1.0.8-beta",
        offMain: ["v2.0.0-alpha1", "v1.0.9-beta"],
      });
      assertEquals(await latestRelease(clone, { major: 1 }), {
        latest: "v1.0.8-beta",
        offMain: ["v1.0.9-beta"],
      });

      // `am pin`'s report carries the same answer, and says why.
      const app = join(base, "app");
      await Deno.mkdir(app);
      await Deno.writeTextFile(
        join(app, "deno.json"),
        JSON.stringify({ aioVersion: "v1.0.8-beta" }),
      );
      const info = await pinInfo(app, clone);
      assertEquals(info.latest, "v1.0.8-beta");
      assert(info.available.includes("v1.0.9-beta"));
      assertStringIncludes(
        info.latestNote ?? "",
        "v1.0.9-beta provisioned but not on origin/main",
      );

      // Fetched: the disagreement is gone, and so is the note.
      await git(clone, "fetch", "-q", "--tags", "origin", "main");
      assertEquals(await latestRelease(clone, { major: 1 }), {
        latest: "v1.0.9-beta",
        offMain: [],
      });
    } finally {
      if (prev === undefined) Deno.env.delete("AIO_VERSIONS_DIR");
      else Deno.env.set("AIO_VERSIONS_DIR", prev);
      await dropTempDir(base);
    }
  },
});
