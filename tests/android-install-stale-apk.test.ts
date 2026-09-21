// android-install-stale-apk.test.ts — `install:android` never puts OLD code
// on a phone and calls it success.
//
// The field report: edit the app, run `deno task install:android`, watch it
// print ✓ — and the phone runs the previous build, under the same version
// number, so nothing on screen disagrees. The picker took the newest `.apk`
// by mtime and never asked whether the sources had moved since.
//
// Both halves are pure, so this needs no phone, no SDK and no build: the
// mtime comparison (`staleApkRefusal`) and the walk that finds the newest
// source (`newestSource`), the latter driven through injected readDir/stat.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { newestSource, staleApkRefusal } from "../src/android-install.ts";

const APK = { name: "app-0.1.8.apk", mtime: 1_000_000 };

Deno.test("an APK older than the sources is refused, loudly", () => {
  const why = staleApkRefusal(APK, {
    path: "src/cell.ts",
    mtime: APK.mtime + 120_000,
  });
  assert(why !== null, "a source edited after the build must refuse");
  // The refusal has to carry all four: what is stale, what changed, what
  // would have happened, and the command that fixes it. A wall with no door
  // is the failure mode this project gates against.
  assert(why!.includes("app-0.1.8.apk"), "name the APK");
  assert(why!.includes("src/cell.ts"), "name the file that changed");
  assert(
    why!.includes("PREVIOUS build") && why!.includes("report success"),
    "say what installing it would actually do",
  );
  assert(why!.includes("--build"), "name the command that fixes it");
  assert(why!.includes("--apk="), "name the deliberate-override escape hatch");
});

Deno.test("an APK newer than every source installs", () => {
  assertEquals(
    staleApkRefusal(APK, { path: "src/cell.ts", mtime: APK.mtime - 1 }),
    null,
  );
  // Same second counts as fresh: a build writes its APK after reading the
  // sources, and a filesystem with 1s mtime granularity would otherwise
  // refuse every single build it just made.
  assertEquals(
    staleApkRefusal(APK, { path: "src/cell.ts", mtime: APK.mtime }),
    null,
  );
});

Deno.test("no sources at all is not a refusal", () => {
  // `--apk=` pointing outside a project, a bare directory with one artifact:
  // nothing to compare against is not evidence of staleness.
  assertEquals(staleApkRefusal(APK, null), null);
});

Deno.test("newestSource: finds the newest file under a real app tree", async () => {
  const root = await Deno.makeTempDir({ prefix: "newest-source-" });
  try {
    await Deno.mkdir(join(root, "src", "ui"), { recursive: true });
    await Deno.mkdir(join(root, "dist"), { recursive: true });
    await Deno.writeTextFile(join(root, "deno.json"), "{}");
    await Deno.writeTextFile(join(root, "src", "cell.ts"), "");
    await Deno.writeTextFile(join(root, "src", "ui", "App.tsx"), "");

    const old = new Date(1_700_000_000_000);
    const recent = new Date(1_700_000_600_000);
    const future = new Date(1_800_000_000_000);
    await Deno.utime(join(root, "deno.json"), old, old);
    await Deno.utime(join(root, "src", "cell.ts"), old, old);
    await Deno.utime(join(root, "src", "ui", "App.tsx"), recent, recent);

    const found = newestSource(root);
    assert(found !== null);
    assertEquals(found!.path, join(root, "src", "ui", "App.tsx"));
    assertEquals(found!.mtime, recent.getTime());

    // dist/ is the build's OUTPUT. Counting it would compare the APK to
    // itself — always fresh, which is the bug with extra steps.
    await Deno.writeTextFile(join(root, "dist", "app-0.1.9.apk"), "");
    await Deno.utime(join(root, "dist", "app-0.1.9.apk"), future, future);
    assertEquals(newestSource(root)!.mtime, recent.getTime());

    // …and so is dep/, the pinned framework: a `dep/aio` symlink to a
    // checkout would make every app's sources look newer than every APK.
    await Deno.mkdir(join(root, "dep", "aio"), { recursive: true });
    await Deno.writeTextFile(join(root, "dep", "aio", "mod.ts"), "");
    await Deno.utime(join(root, "dep", "aio", "mod.ts"), future, future);
    assertEquals(newestSource(root)!.mtime, recent.getTime());
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("newestSource: an app with no sources at all answers null", async () => {
  const root = await Deno.makeTempDir({ prefix: "newest-source-empty-" });
  try {
    assertEquals(newestSource(root), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
