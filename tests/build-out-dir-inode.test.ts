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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  emptyDir,
  moveDirContents,
  previousReleaseNote,
} from "../src/build/dist-staging.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { modeBitsAreMeaningful } from "../src/server/dir-permissions.ts";
import { linkFile } from "./symlink-helper.ts";

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

/** What `rename` answers between two filesystems. */
const crossDevice = () =>
  Promise.reject(new Error("Invalid cross-device link (os error 18)"));

/** `path → what it is` for everything under `dir`. */
function listing(dir: string, at = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of Deno.readDirSync(`${dir}/${at}`)) {
    const rel = at ? `${at}/${e.name}` : e.name;
    if (e.isSymlink) out[rel] = `-> ${Deno.readLinkSync(`${dir}/${rel}`)}`;
    else if (e.isDirectory) Object.assign(out, listing(dir, rel));
    else out[rel] = Deno.readTextFileSync(`${dir}/${rel}`);
  }
  return out;
}

Deno.test({
  name:
    "build out dir: on another filesystem its contents are still set aside, and put back whole",
  fn: async () => {
    // An out dir on its own mount (or a bind-mounted dist/): every rename out
    // of it is refused. The previous release used to stay where it was — said
    // on every build — so a failed build had nothing to put back.
    const tmp = await tempDir("out-move-exdev");
    const dist = `${tmp}/dist`;
    const aside = `${tmp}/staging/previous-out`;
    await Deno.mkdir(`${dist}/site-web/assets`, { recursive: true });
    await Deno.writeTextFile(`${dist}/manifest.json`, `{"app":"notes"}`);
    await Deno.writeTextFile(`${dist}/notes-1.2.3`, "binary");
    await Deno.chmod(`${dist}/notes-1.2.3`, 0o755);
    await Deno.writeTextFile(`${dist}/site-web/assets/app.js`, "js");
    await linkFile("assets/app.js", `${dist}/site-web/latest.js`);
    const release = listing(dist);
    assertEquals(Object.keys(release).length, 4);

    const before = await inode(dist);
    assert(await moveDirContents(dist, aside, crossDevice));
    assertEquals(await inode(dist), before, "the directory stayed put");
    assertEquals(listing(dist), {}, "nothing is left behind");
    assertEquals(listing(aside), release);
    // (The execute bit: where the OS keeps one.)
    if (modeBitsAreMeaningful()) {
      assertEquals(
        (await Deno.stat(`${aside}/notes-1.2.3`)).mode! & 0o111,
        0o111,
      );
    }

    // …and back, the way a build that produced nothing restores it.
    assert(await moveDirContents(aside, dist, crossDevice));
    assertEquals(await inode(dist), before);
    assertEquals(listing(dist), release);
    assertEquals(listing(aside), {});
    if (modeBitsAreMeaningful()) {
      assertEquals(
        (await Deno.stat(`${dist}/notes-1.2.3`)).mode! & 0o111,
        0o111,
      );
    }
  },
});

Deno.test("build out dir: a move that fails half way puts every entry back — never half a release in each place", async () => {
  const tmp = await tempDir("out-move-half");
  const dist = `${tmp}/dist`;
  const aside = `${tmp}/staging/previous-out`;
  await Deno.mkdir(dist);
  const all = ["a", "b", "c", "d", "e"];
  for (const n of all) await Deno.writeTextFile(`${dist}/${n}`, n);
  // Two entries go; the third cannot be moved at all.
  let calls = 0;
  const failsThird = (from: string, to: string) =>
    ++calls === 3
      ? Promise.reject(new Deno.errors.NotFound("gone under the move"))
      : Deno.rename(from, to);
  const names = (d: string) => [...Deno.readDirSync(d)].map((e) => e.name);
  await assertRejects(
    () => moveDirContents(dist, aside, failsThird),
    Deno.errors.NotFound,
  );
  assertEquals(calls, 5, "two moved, one refused, two moved back");
  assertEquals(names(dist).sort(), all);
  assertEquals(names(aside), []);
});

Deno.test("build out dir: what is said about the previous release is what happened to it", () => {
  const dist = { outIsStaging: true };
  const other = { outIsStaging: false };
  assertEquals(
    [
      previousReleaseNote("failed", "dist", { preserved: true, ...dist }),
      previousReleaseNote("failed", "release", { preserved: true, ...other }),
      // Not set aside: dist/ was emptied by the builds; another out dir is
      // only ever written when there are artifacts to place.
      previousReleaseNote("failed", "dist", { preserved: false, ...dist }),
      previousReleaseNote("failed", "release", { preserved: false, ...other }),
    ],
    [
      "the previous dist/ is intact",
      "the previous release/ is intact",
      "dist/ holds no release",
      "release/ is as it was",
    ],
  );
  const lost = previousReleaseNote("aside", "", { preserved: false, ...dist });
  const kept = previousReleaseNote("aside", "", { preserved: false, ...other });
  assertStringIncludes(lost, "there is no release to put back");
  assertStringIncludes(kept, "stays so until this build has artifacts");
  assert(!kept.includes("no release to put back"), kept);
});

Deno.test("build out dir: the fleet says it with its own out dir and what it set aside", async () => {
  const src = await Deno.readTextFile("src/build-all.ts");
  for (
    const wired of [
      `const outIsStaging = outDir === resolve(join(root, DIST_DIR));`,
      `previousReleaseNote("aside", "", { preserved: false, outIsStaging })`,
      `previousReleaseNote("failed", rel, { preserved, outIsStaging })`,
    ]
  ) assertStringIncludes(src, wired);
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
