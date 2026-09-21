// The build EMPTIES its output directory. It never replaces it.
//
// A field report: `am lab windows` bind-mounts the app's `dist/` into the
// container and serves it to the guest over HTTP. Rebuild, and the guest gets
// a 404 for a file the hand-off just told it to fetch — for the life of the
// lab. A bind mount follows the INODE, and the fleet build renamed `dist/`
// aside and `mkdir`ed a fresh one, so the container was left holding an
// orphaned directory while every host-side reading stayed correct.
//
// A bind mount is the loudest victim, not the only one: an open `cd dist`, a
// file watcher and an editor's tree all hold the inode too. Nothing ever
// wanted the directory replaced — the build wants it EMPTY.
//
// Two tests, because one alone is not enough:
//   1. the helpers keep the inode (the behaviour), measured with `stat().ino`;
//   2. no build module goes back to remove-then-mkdir (the regression), since
//      the behaviour test only covers the paths that call the helpers.

import { assert, assertEquals } from "@std/assert";
import { emptyDir, moveDirContents } from "../src/build/dist-staging.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

/** The identity of a directory as a bind mount sees it. */
async function inode(path: string): Promise<number | null> {
  return (await Deno.stat(path)).ino;
}

Deno.test("build out dir: emptying it keeps the SAME directory", async () => {
  const tmp = await tempDir("out-inode");
  const dist = `${tmp}/dist`;
  await Deno.mkdir(dist);
  await Deno.writeTextFile(`${dist}/app-1.2.345.exe`, "old");
  await Deno.mkdir(`${dist}/nested`);
  await Deno.writeTextFile(`${dist}/nested/keep`, "x");

  const before = await inode(dist);
  await emptyDir(dist);

  assertEquals(await inode(dist), before, "the directory must not be replaced");
  assertEquals([...Deno.readDirSync(dist)].length, 0, "…and must be empty");

  // A missing directory is not an error: the build calls this before it knows
  // whether anything is there.
  await emptyDir(`${tmp}/never-existed`);
});

Deno.test("build out dir: its contents move aside and back, it does not", async () => {
  const tmp = await tempDir("out-move");
  const dist = `${tmp}/dist`;
  const aside = `${tmp}/staging/previous-out`;
  await Deno.mkdir(dist);
  await Deno.writeTextFile(`${dist}/manifest.json`, `{"app":"notes"}`);
  await Deno.mkdir(`${dist}/ios-client`);
  await Deno.writeTextFile(`${dist}/ios-client/project.pbxproj`, "x");

  const before = await inode(dist);
  assert(await moveDirContents(dist, aside), "it had contents to protect");
  assertEquals(await inode(dist), before, "the directory stayed put");
  assertEquals([...Deno.readDirSync(dist)].length, 0);
  assertEquals(
    await Deno.readTextFile(`${aside}/manifest.json`),
    `{"app":"notes"}`,
  );

  // …and the failure path puts the previous release back, still in the same
  // directory the lab is watching.
  await emptyDir(dist);
  assert(await moveDirContents(aside, dist));
  assertEquals(await inode(dist), before);
  assertEquals(
    await Deno.readTextFile(`${dist}/ios-client/project.pbxproj`),
    "x",
  );

  // Nothing to protect is a VALUE, not an exception — the caller says
  // "there was no previous release" with it.
  assertEquals(await moveDirContents(`${tmp}/nope`, aside), false);
});

Deno.test("build out dir: no build module replaces a directory it owns", async () => {
  // The regression guard. The behaviour test above can only see the call sites
  // that already use the helpers; this one sees the next `Deno.remove(dir,
  // {recursive:true})` followed by a `mkdir` of the same directory, which is
  // the exact shape that shipped the bug.
  const files: string[] = ["src/build.ts", "src/build-all.ts"];
  for await (const e of Deno.readDir("src/build")) {
    if (e.isFile && e.name.endsWith(".ts")) files.push(`src/build/${e.name}`);
  }
  assert(files.length > 10, "the build modules were not found");

  // Only the directory the build HANDS OUT. A scratch tree under `.aio/` is
  // nobody's mount point, and `freshElectronStaging` wants its tree gone on
  // purpose — a kept one shipped the previous platform's Electron inside the
  // next package. The rule is about what the outside world can be holding.
  const PUBLISHED = new Set(["outDir", "dist", "distDir", "out"]);

  const offenders: string[] = [];
  for (const f of files) {
    const src = await Deno.readTextFile(f);
    // `remove(X, { recursive: true })` and, within the next few lines, a
    // `mkdir(X` — the same expression text on both sides.
    for (
      const m of src.matchAll(
        /Deno\.remove\(\s*([A-Za-z_$][\w$.]*)\s*,\s*\{\s*recursive:\s*true\s*\}\s*\)[\s\S]{0,400}?Deno\.mkdir\(\s*([A-Za-z_$][\w$.]*)/g,
      )
    ) {
      if (m[1] === m[2] && PUBLISHED.has(m[1]!)) {
        offenders.push(`${f}: ${m[1]} is removed and re-created`);
      }
    }
    // …and the shape the field report was actually about: MOVING the
    // directory aside. That is what the fleet build did — `rename(outDir,
    // preservedOut)` — and a guard that only knew remove-then-mkdir stayed
    // green with the original bug put back. A verifier proved exactly that by
    // reverting the preserve step alone.
    for (
      const m of src.matchAll(
        /Deno\.rename(?:Sync)?\(\s*([A-Za-z_$][\w$.]*)\s*,/g,
      )
    ) {
      if (PUBLISHED.has(m[1]!)) {
        offenders.push(`${f}: ${m[1]} is renamed away — move its CONTENTS`);
      }
    }
  }
  assert(
    PUBLISHED.size > 0 && files.some((f) => f.endsWith("build-all.ts")),
    "the guard is looking at nothing",
  );
  assertEquals(
    offenders,
    [],
    "a directory the build owns is being REPLACED rather than emptied — " +
      "every bind mount, watcher and open shell holding it is silently " +
      "stranded. Use emptyDir() from src/build/dist-staging.ts:\n  " +
      offenders.join("\n  "),
  );
});
