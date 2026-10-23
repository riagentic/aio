// An update's prune of `versions/` keeps the version it replaces — the
// running build and the marker's `previous`, the copy a rollback puts back.
// It sorted by age alone: after two updates that were rolled back (their
// failed versions stay in `versions/`, newer than the one that works), the
// third update's prune deleted the version that was RUNNING, and a failure of
// that third update had nothing left to roll back to.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { restoreArtifact, swapArtifact } from "../src/server/updates-apply.ts";

Deno.test("update prune: never removes the version being replaced, however old", async () => {
  const root = await Deno.makeTempDir({ prefix: "aio-prune-keep-" });
  try {
    const dir = join(root, "demo");
    const link = join(dir, "demo.AppImage");
    const put = async (v: string) => {
      await Deno.mkdir(join(dir, "versions", v), { recursive: true });
      const f = join(dir, "versions", v, "demo.AppImage");
      await Deno.writeTextFile(f, `#!/bin/sh\necho ${v}\n`);
      return f;
    };
    const good = await put("1.0.0");
    await Deno.symlink(good, link);
    // Two updates that failed and were rolled back: both stay in versions/.
    for (const v of ["2.0.0", "3.0.0"]) {
      await new Promise((r) => setTimeout(r, 20)); // distinct mtimes
      const staged = join(dir, `staged-${v}`);
      await Deno.writeTextFile(staged, `#!/bin/sh\necho ${v}\n`);
      const { previous } = await swapArtifact({
        current: link,
        staged,
        fromVersion: "1.0.0",
        toVersion: v,
        smoke: false,
      });
      assertEquals(previous, good);
      await restoreArtifact(link, previous);
      assertEquals(await Deno.realPath(link), good);
    }
    await new Promise((r) => setTimeout(r, 20));
    const staged = join(dir, "staged-4");
    await Deno.writeTextFile(staged, "#!/bin/sh\necho 4.0.0\n");
    const { previous } = await swapArtifact({
      current: link,
      staged,
      fromVersion: "1.0.0",
      toVersion: "4.0.0",
      smoke: false,
    });
    assertEquals(previous, good);
    assert(
      await Deno.stat(good).then(() => true, () => false),
      "the version this update replaced — its rollback — was pruned",
    );
    // …and the rollback still works.
    await restoreArtifact(link, previous);
    assertEquals(await Deno.realPath(link), good);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
