// An app installed by the Windows one-click `.exe` lives in a tree the SFX
// stub stamped with its payload's hash. The updater replaces that tree, and a
// tree without the stamp is overwritten with the OLD version the next time the
// user opens the `.exe` they downloaded. So every directory swap carries it.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  carrySfxStamp,
  claimFirstBoot,
  firstBootPath,
  type PendingUpdate,
  SFX_STAMP_FILE,
  SFX_VERSION_FILE,
  stampSfxVersion,
  swapDirectoryDetached,
} from "../src/server/updates-apply.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const quiet = {
  warn() {},
  info() {},
  error() {},
  debug() {},
} as unknown as Log;

/** A stand-in install directory, stamped or not. */
async function install(dir: string, stamp?: string): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "run.bat"), "");
  if (stamp) await Deno.writeTextFile(join(dir, SFX_STAMP_FILE), stamp);
  return dir;
}

/** A spawn stand-in: starts nothing, and drops the helper script the swap
 *  wrote for it (unix). */
const noSpawn = (_cmd: string, args: string[]) => {
  if (Deno.build.os !== "windows") Deno.removeSync(args[0]!);
};

const stampOf = (dir: string) =>
  Deno.readTextFile(join(dir, SFX_STAMP_FILE)).catch(() => null);

Deno.test("a directory swap carries the SFX stamp into the tree going in", async () => {
  const tmp = await tempDir("sfx-stamp-");
  try {
    const current = await install(join(tmp, "win-x64"), "sha-of-v1-exe\n");
    const staged = await install(join(tmp, "win-x64.staged-2.0.0"));
    swapDirectoryDetached({
      current,
      staged,
      fromVersion: "1.0.0",
      spawn: noSpawn,
    });
    // Before the helper moves anything: the new tree answers to the old exe.
    assertEquals(await stampOf(staged), "sha-of-v1-exe\n");
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("a rollback swap re-stamps the old tree with the CURRENT stamp", async () => {
  // v1 (stamp A) was updated in place, then a newer exe (stamp B) installed
  // over it. Rolling back to the kept v1 tree must leave stamp B: the exe the
  // user now has is B, and a tree stamped A would be extracted over.
  const tmp = await tempDir("sfx-stamp-");
  try {
    const current = await install(join(tmp, "win-x64"), "B\n");
    const previous = await install(join(tmp, "win-x64.old-1.0.0"), "A\n");
    swapDirectoryDetached({
      current,
      staged: previous,
      fromVersion: "3.0.0",
      spawn: noSpawn,
    });
    assertEquals(await stampOf(previous), "B\n");
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("an install with no SFX stamp swaps without one (zip, Linux, macOS)", async () => {
  const tmp = await tempDir("sfx-stamp-");
  try {
    const current = await install(join(tmp, "app"));
    const staged = await install(join(tmp, "app.staged-2.0.0"));
    swapDirectoryDetached({
      current,
      staged,
      fromVersion: "1.0.0",
      spawn: noSpawn,
    });
    assertEquals(await stampOf(staged), null);
    assert(!carrySfxStamp(join(current, "run.bat"), staged, quiet)); // a file
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("first boot after a swap made by aio 1.0.16-beta takes the stamp from the replaced version", async () => {
  const tmp = await tempDir("sfx-stamp-");
  try {
    const dataDir = join(tmp, "data");
    await Deno.mkdir(dataDir);
    // The old updater swapped the trees and carried nothing.
    const artifact = await install(join(tmp, "win-x64"));
    const previous = await install(join(tmp, "win-x64.old-1.0.0"), "A\n");
    const pending: PendingUpdate = {
      from: "1.0.0",
      to: "2.0.0",
      artifact,
      previous,
      attempts: 0,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    await Deno.writeTextFile(firstBootPath(dataDir), JSON.stringify(pending));
    assertEquals(claimFirstBoot(dataDir, pending, quiet), "won");
    assertEquals(await stampOf(artifact), "A\n");

    // A tree that already has one keeps it (a swap made by this aio).
    await Deno.writeTextFile(join(artifact, SFX_STAMP_FILE), "B\n");
    await Deno.writeTextFile(firstBootPath(dataDir), JSON.stringify(pending));
    assertEquals(claimFirstBoot(dataDir, pending, quiet), "won");
    assertEquals(await stampOf(artifact), "B\n");
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("a stamp that cannot be written or read is said, and never stops the swap", async () => {
  const tmp = await tempDir("sfx-stamp-");
  try {
    const from = await install(join(tmp, "win-x64"), "A\n");
    const warned: string[] = [];
    const log = {
      ...quiet,
      warn: (_tag: string, msg: string) => void warned.push(msg),
    } as unknown as Log;
    assert(!carrySfxStamp(from, join(tmp, "no-such-dir"), log));
    assertEquals(warned.length, 1);
    assert(warned[0]!.includes("re-installs the version it carries"));

    // A stamp that is there and cannot be READ is said too (a folder stands in
    // for an unreadable file); one that is simply absent is every non-SFX
    // install, and silent.
    const to = await install(join(tmp, "win-x64.staged-2.0.0"));
    const broken = await install(join(tmp, "broken"));
    await Deno.mkdir(join(broken, SFX_STAMP_FILE));
    assert(!carrySfxStamp(broken, to, log));
    assertEquals(warned.length, 2);
    assert(warned[1]!.includes("could not read"), warned[1]);
    assert(warned[1]!.includes(join(broken, SFX_STAMP_FILE)), warned[1]);
    assert(!carrySfxStamp(to, join(tmp, "elsewhere"), log)); // no stamp at all
    assertEquals(warned.length, 2);
    // A single-file install is a file, not a folder: no stamp either, silent.
    await Deno.writeTextFile(join(tmp, "app.exe"), "MZ");
    assert(!carrySfxStamp(join(tmp, "app.exe"), to, log));
    assertEquals(warned.length, 2);
    assertEquals(await stampOf(to), null);
  } finally {
    await dropTempDir(tmp);
  }
});

// The stub keeps an install that is NEWER than the `.exe` being opened, and
// knows how new the install is from this file. The app rewrites it with its
// own version at every start, so it is right after an update — which is the
// case that matters: an old download opened over an updated app.
Deno.test("a one-click install records the version that runs from it; any other install is left alone", async () => {
  const tmp = await tempDir("sfx-version-");
  try {
    const sfx = await install(join(tmp, "aio-sfx", "notes", "win-x64"));
    const versionOf = (dir: string) =>
      Deno.readTextFile(join(dir, SFX_VERSION_FILE)).catch(() => null);
    stampSfxVersion(sfx, "1.2.0", quiet);
    assertEquals(await versionOf(sfx), "1.2.0\n");
    // The same version again writes nothing (the file keeps its time).
    const before = (await Deno.stat(join(sfx, SFX_VERSION_FILE))).mtime;
    stampSfxVersion(sfx, "1.2.0", quiet);
    assertEquals((await Deno.stat(join(sfx, SFX_VERSION_FILE))).mtime, before);
    // After an update, and after a rollback: whatever runs now.
    stampSfxVersion(sfx, "1.3.0-beta", quiet);
    assertEquals(await versionOf(sfx), "1.3.0-beta\n");
    stampSfxVersion(sfx, "1.2.0", quiet);
    assertEquals(await versionOf(sfx), "1.2.0\n");
    // An unzipped install, an AppImage's folder: not the stub's, nothing written.
    const zip = await install(join(tmp, "Apps", "notes"));
    stampSfxVersion(zip, "1.2.0", quiet);
    assertEquals(await versionOf(zip), null);
    // A file that cannot be written is said, and the start goes on.
    await Deno.remove(join(sfx, SFX_VERSION_FILE));
    await Deno.mkdir(join(sfx, SFX_VERSION_FILE));
    const said: string[] = [];
    stampSfxVersion(
      sfx,
      "1.4.0",
      {
        ...quiet,
        warn: (_s: string, m: string) => said.push(m),
      } as unknown as Log,
    );
    assertEquals(said.length, 1);
    assert(said[0]!.includes(".aio-sfx-version"), said[0]);
  } finally {
    await dropTempDir(tmp);
  }
});
