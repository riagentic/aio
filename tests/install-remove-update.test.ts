// The installed layout, and the two things that operate on it.
//
// `run.sh` installs a built app as:
//
//     ~/app/<name>/<name>-<version>.AppImage    the artifact
//     ~/app/<name>/<name>.AppImage → that       the stable name
//
// The stable name is what the menu entry, a shell alias and muscle memory
// point at. Two operations have to respect that and neither did:
//
//   • an UPDATE renamed the new artifact straight over `current`. When
//     `current` is the symlink, that replaces the link WITH A FILE: after one
//     update the versioning is gone, the previous version is unrecoverable,
//     and every launcher now points at a plain file the next update
//     overwrites in place.
//   • an UNINSTALL did not exist at all, so the only way back was to remember
//     three locations and delete them by hand.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  restoreArtifact,
  swapArtifact,
  versionedInstall,
} from "../src/server/updates-apply.ts";
import { installedAppPaths, installRoot } from "../src/server/app-dirs.ts";
import { installedFootprint } from "../src/am/am-cmd-remove.ts";

/** A believable install: versioned artifact + stable symlink. */
async function install(
  root: string,
  name: string,
  version: string,
  ext = ".AppImage",
): Promise<{ dir: string; link: string; target: string }> {
  const dir = join(root, name);
  const vdir = join(dir, "versions", version);
  await Deno.mkdir(vdir, { recursive: true });
  // The file keeps the APP's name; the VERSION is the directory. A compiled
  // binary takes its identity from its own file name, so a versioned FILE
  // renames the app (and moves its data) on every update.
  const target = join(vdir, `${name}${ext}`);
  await Deno.writeTextFile(target, `#!/bin/sh\necho ${version}\n`);
  await Deno.chmod(target, 0o755);
  const link = join(dir, `${name}${ext}`);
  await Deno.symlink(target, link);
  return { dir, link, target };
}

Deno.test("install layout: the stable name is recognised as a versioned install", async () => {
  const root = await Deno.makeTempDir({ prefix: "aio-install-" });
  try {
    const { link, target } = await install(root, "demo-electron", "1.2.3");
    const layout = await versionedInstall(link);
    assert(layout, "the stable symlink must be recognised");
    assertEquals(layout.target, target);
    assertEquals(
      layout.base,
      "demo-electron",
      "a hyphenated app name survives",
    );
    assertEquals(layout.ext, ".AppImage");

    // A plain file is NOT this layout — the old flat swap must still apply.
    const plain = join(root, "plain-binary");
    await Deno.writeTextFile(plain, "x");
    assertEquals(await versionedInstall(plain), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("update: adds a version and re-points the link — never flattens it", async () => {
  const root = await Deno.makeTempDir({ prefix: "aio-install-" });
  try {
    const { dir, link, target } = await install(root, "demo", "1.0.0");
    const staged = join(dir, "staged.new");
    await Deno.writeTextFile(staged, "#!/bin/sh\necho 2.0.0\n");

    const { previous } = await swapArtifact({
      current: link,
      staged,
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      // Stand-in files: this pins the rename/symlink mechanics, not whether a
      // downloaded program runs (smokeTestArtifact has its own tests).
      smoke: false,
    });

    // The link is STILL a link…
    assertEquals(
      (await Deno.lstat(link)).isSymlink,
      true,
      "the stable name must remain a symlink — a file here is the bug",
    );
    // …now pointing at the new version, beside the old one.
    assertEquals(
      await Deno.realPath(link),
      join(dir, "versions", "2.0.0", "demo.AppImage"),
    );
    assertEquals(previous, target, "the previous version is the rollback copy");
    assertEquals(
      (await Deno.stat(target)).isFile,
      true,
      "the old version must still be there — that IS the rollback",
    );
    assertEquals(
      (await Deno.readTextFile(link)).includes("2.0.0"),
      true,
      "reading through the link gives the NEW artifact",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rollback: re-points the link back, leaving both versions", async () => {
  const root = await Deno.makeTempDir({ prefix: "aio-install-" });
  try {
    const { dir, link } = await install(root, "demo", "1.0.0");
    const staged = join(dir, "staged.new");
    await Deno.writeTextFile(staged, "#!/bin/sh\necho 2.0.0\n");
    const { previous } = await swapArtifact({
      current: link,
      staged,
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      smoke: false, // stand-in files — see above
    });

    await restoreArtifact(link, previous);

    assertEquals((await Deno.lstat(link)).isSymlink, true);
    assertEquals(
      await Deno.realPath(link),
      join(dir, "versions", "1.0.0", "demo.AppImage"),
    );
    assertEquals(
      (await Deno.stat(join(dir, "versions", "2.0.0", "demo.AppImage"))).isFile,
      true,
      "the version we rolled back FROM stays on disk — rolling forward again " +
        "must not need a re-download",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("update: a plain (non-installed) artifact keeps the old flat behaviour", async () => {
  // A binary run straight out of dist/, or a downloaded file someone chmod'ed:
  // no symlink, no versions. The kept-aside copy is the only rollback there.
  const root = await Deno.makeTempDir({ prefix: "aio-install-" });
  try {
    const current = join(root, "app");
    await Deno.writeTextFile(current, "old");
    const staged = join(root, "app.new");
    await Deno.writeTextFile(staged, "new");

    const { previous } = await swapArtifact({
      current,
      staged,
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      smoke: false, // stand-in files — see above
    });
    assertEquals(await Deno.readTextFile(current), "new");
    assertEquals(await Deno.readTextFile(previous), "old");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("install paths: one decider, and `am remove` reads the same one", () => {
  // run.sh asks the framework for this (build.ts --print-install-root) instead
  // of hardcoding ~/app, so an installer and an uninstaller cannot disagree
  // about where an app lives — the second one to be wrong deletes nothing, or
  // the wrong thing.
  const p = installedAppPaths("demo");
  assertEquals(p.dir, join(installRoot(), "demo"));
  assertEquals(p.desktop.endsWith("/applications/demo.desktop"), true);
  assertEquals(p.binLink.endsWith("/.local/bin/demo"), true);
});

Deno.test("am remove: the footprint is the three things an install creates", async () => {
  const root = await Deno.makeTempDir({ prefix: "aio-install-root-" });
  const prev = Deno.env.get("AIO_INSTALL_ROOT");
  Deno.env.set("AIO_INSTALL_ROOT", root);
  try {
    await install(root, "footprint-app", "0.1.0");
    const fp = await installedFootprint("footprint-app");
    assertEquals(fp.length, 3, "app dir, menu entry, PATH symlink");
    const dirEntry = fp.find((f) => f.path === join(root, "footprint-app"));
    assert(dirEntry?.present, "the installed directory must be seen");
    // The menu entry and bin link were never created here — reported absent,
    // not invented.
    assertEquals(fp.filter((f) => f.present).length, 1);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_INSTALL_ROOT");
    else Deno.env.set("AIO_INSTALL_ROOT", prev);
    await Deno.remove(root, { recursive: true });
  }
});

// ── the four gaps found by reviewing the layout, one test each ───────────

import {
  conflictingSource,
  normalizeSource,
  pruneVersions,
  readRecord,
  writeRecord,
} from "../src/server/install-record.ts";

Deno.test("versions: the install directory does not grow forever", async () => {
  // One ~156MB artifact per update, kept indefinitely, is a disk leak with a
  // friendly name — the same unbounded-retention shape as a log directory with
  // no ceiling. Nothing fails; the disk fills, and it surfaces during something
  // unrelated.
  const root = await Deno.makeTempDir({ prefix: "aio-prune-" });
  try {
    const dir = join(root, "demo");
    let i = 0;
    for (const v of ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"]) {
      const vdir = join(dir, "versions", v);
      await Deno.mkdir(vdir, { recursive: true });
      await Deno.writeTextFile(join(vdir, "demo.AppImage"), v);
      const when = new Date(2020, 0, ++i);
      await Deno.utime(vdir, when, when);
    }
    const current = join(dir, "versions", "1.4.0");
    const removed = await pruneVersions({ dir, keep: 3, current });
    const left = [...Deno.readDirSync(join(dir, "versions"))].map((e) => e.name)
      .sort();
    assertEquals(left.length, 3, `kept 3, got ${left.join(", ")}`);
    assert(left.includes("1.4.0"), "the CURRENT version is never pruned");
    assertEquals(removed.sort(), ["1.0.0", "1.1.0"], "oldest first");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("record: an install says where it came from", async () => {
  const root = await Deno.makeTempDir({ prefix: "aio-record-" });
  const prev = Deno.env.get("AIO_INSTALL_ROOT");
  Deno.env.set("AIO_INSTALL_ROOT", root);
  try {
    await writeRecord({
      name: "demo",
      version: "1.0.0",
      source: "https://github.com/o/demo",
      commit: "abc1234",
      target: "electron",
      aioVersion: "v1.0.0-alpha58",
    });
    const rec = await readRecord("demo");
    assertEquals(rec?.source, "https://github.com/o/demo");
    assertEquals(rec?.version, "1.0.0");
    assert(rec?.installedAt, "the time is stamped even when not passed");
    assertEquals(await readRecord("never-installed"), null);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_INSTALL_ROOT");
    else Deno.env.set("AIO_INSTALL_ROOT", prev);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("record: a DIFFERENT repo with the same name is a conflict, not an overwrite", async () => {
  const root = await Deno.makeTempDir({ prefix: "aio-conflict-" });
  const prev = Deno.env.get("AIO_INSTALL_ROOT");
  Deno.env.set("AIO_INSTALL_ROOT", root);
  try {
    await writeRecord({
      name: "demo",
      source: "https://github.com/alice/demo",
    });

    // The same repo, spelled differently, is NOT a conflict — refusing there
    // would make the guard something people route around.
    for (
      const same of [
        "https://github.com/alice/demo",
        "https://github.com/alice/demo.git",
        "git@github.com:alice/demo.git",
        "https://github.com/Alice/Demo/",
      ]
    ) {
      assertEquals(
        await conflictingSource("demo", same),
        null,
        `${same} is the same source`,
      );
    }
    // A different owner is a different program that would inherit ~/.demo.
    assertEquals(
      await conflictingSource("demo", "https://github.com/bob/demo"),
      "https://github.com/alice/demo",
    );
    // No record (or no source) never blocks an install.
    assertEquals(await conflictingSource("unknown", "https://x/y"), null);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_INSTALL_ROOT");
    else Deno.env.set("AIO_INSTALL_ROOT", prev);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("normalizeSource: same repo, four spellings", () => {
  const want = "github.com/o/r";
  for (
    const s of [
      "https://github.com/o/r",
      "https://github.com/o/r.git",
      "git@github.com:o/r.git",
      "ssh://github.com/o/r/",
    ]
  ) assertEquals(normalizeSource(s), want, s);
  assert(normalizeSource("/home/me/proj") !== want);
});

Deno.test("update: the swap prunes, keeping the new one and its predecessor", async () => {
  const root = await Deno.makeTempDir({ prefix: "aio-swapprune-" });
  try {
    const dir = join(root, "demo");
    let i = 0;
    for (const v of ["0.1.0", "0.2.0", "0.3.0"]) {
      const vdir = join(dir, "versions", v);
      await Deno.mkdir(vdir, { recursive: true });
      await Deno.writeTextFile(join(vdir, "demo.AppImage"), v);
      const when = new Date(2020, 0, ++i);
      await Deno.utime(vdir, when, when);
    }
    const target = join(dir, "versions", "0.3.0", "demo.AppImage");
    const link = join(dir, "demo.AppImage");
    await Deno.symlink(target, link);
    const staged = join(dir, "staged.new");
    await Deno.writeTextFile(staged, "0.4.0");

    const { previous } = await swapArtifact({
      current: link,
      staged,
      fromVersion: "0.3.0",
      toVersion: "0.4.0",
      keepVersions: 2,
      smoke: false, // stand-in files — see above
    });

    const left = [...Deno.readDirSync(join(dir, "versions"))].map((e) => e.name)
      .sort();
    assertEquals(left, ["0.3.0", "0.4.0"]);
    assertEquals(
      previous,
      target,
      "the predecessor survives — it IS the rollback",
    );
    assertEquals(
      await Deno.realPath(link),
      join(dir, "versions", "0.4.0", "demo.AppImage"),
    );
    assertEquals(
      (await Deno.realPath(link)).endsWith("/demo.AppImage"),
      true,
      "the running file is still called demo.AppImage — the app's identity " +
        "must not change because it was updated",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
