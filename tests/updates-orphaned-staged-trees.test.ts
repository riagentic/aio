// What an unfinished update left beside the install is removed — and nothing
// else is, whatever it is called.
//
// Measured on Windows 11: after two failed swaps the install's folder held
// `win-x64.staged-0.1.4` and `win-x64.staged-0.1.6`, 434 MB each, through two
// later successful updates. The first repair swept them at boot BY NAME — and
// a name proves nothing in a folder that is the user's: their own
// `notes.staged-1.2.3/`, a file `notes.zip-2024`, a folder `notes.swept-12-3/`
// went with the leftovers, and the older sweep after a confirmed update took
// `notes.zip-backup`, `notes.rollback-plan.txt`, `notes.failed-experiments/`.
//
// Now the updater writes down what it is about to make, in its own data
// directory, before it makes it, and removes a path only when that record
// names it and what is there is the very object it made
// (src/server/updates-owned.ts). A look-alike with no record is left, and
// named.
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { basename, join } from "@std/path";
import {
  firstBootPath,
  pendingPath,
  pruneOld,
  restoreArtifact,
  swapDirectoryDetached,
  writePending,
} from "../src/server/updates-apply.ts";
import {
  _ownedDeps,
  assertNotInTheWay,
  identity,
  isOwn,
  made,
  ownedPath,
  readOwned,
  record,
  sweepOwned,
} from "../src/server/updates-owned.ts";
import { startUpdates } from "../src/server/updates-boot.ts";
import type { UpdatesSlot } from "../src/state/updates-cell.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const POSIX = Deno.build.os !== "windows";
const LAUNCHER = POSIX ? "run.sh" : "run.bat";
const names = (dir: string) =>
  [...Deno.readDirSync(dir)].map((e) => e.name).sort();

/** Above any pid a kernel hands out: nobody. */
const NOBODY = 2147483647;

/** An install folder `notes` (an unpacked app) and the app's data directory. */
async function installed(): Promise<
  { root: string; install: string; data: string }
> {
  const root = await tempDir("aio-owned-");
  const install = join(root, "notes");
  await Deno.mkdir(join(install, "electron"), { recursive: true });
  await Deno.writeTextFile(join(install, LAUNCHER), "start notes");
  return { root, install, data: await tempDir("aio-owned-data-") };
}

/** Make `path` the way the updater does: on record first, then made. */
async function makeOwn(
  data: string,
  path: string,
  kind: "file" | "dir",
  role: "temp" | "kept" = "temp",
): Promise<void> {
  record(data, path, kind, { role });
  if (kind === "dir") {
    await Deno.mkdir(path);
    made(data, path);
    await Deno.writeTextFile(join(path, "app.bin"), "the update's");
    // A link in it, out of it: removing the tree must not go through.
    if (POSIX) {
      await Deno.symlink(join(path, "..", "elsewhere"), join(path, "out"));
    }
  } else {
    await Deno.writeTextFile(path, "the update's");
    made(data, path);
  }
}

/** The record as a LATER run of the app reads it: everything on it was made
 *  by `pid` in an earlier run. (A test's own entries are this run's, and a
 *  sweep leaves those alone.) */
function laterBoot(data: string, pid: number = Deno.pid): void {
  const file = JSON.parse(Deno.readTextFileSync(ownedPath(data)));
  Deno.writeTextFileSync(
    ownedPath(data),
    JSON.stringify({
      ...file,
      made: readOwned(data).map((e) => ({ ...e, pid, boot: "an earlier run" })),
    }),
  );
}

const OURS = [
  ["notes.staged-0.1.4", "dir"], // a staged tree whose swap was never made
  ["notes.zip-0.1.6", "file"], // a download, verified, never unpacked
  ["notes.new-0.1.7", "file"], // a single-file download never swapped in
  ["notes.failed-1759400000000", "dir"], // a rollback cut off half-way
  [".aio-update-notes.zip-0.1.6-41-0a1b2c3d", "dir"], // a download cut off
] as const;

/** What a user (or another app) may have beside the install. Every name here
 *  was deleted by a sweep that went by name. */
const BAIT_DIRS = [
  "notes.staged-1.2.3", // their folder, named like a version
  "notes.swept-12-3", // named like the sweep's own set-aside
  "notes.staged-notes",
  "notes.failed-experiments",
  "notesX.staged-1.0.0", // another install's
  ".aio-update-notes.zip-9.9.9-41-0a1b2c3d", // named like a download of ours
];
const BAIT_FILES = [
  "notes.zip-2024",
  "notes.zip-backup",
  "notes.rollback-plan.txt",
  "notes.new-thing",
  "notes.zip", // the archive the app was unpacked from
];
/** A link named like each pattern, pointing at something precious. */
const BAIT_LINKS = [
  "notes.staged-4.0.0",
  "notes.zip-4.0.0",
  "notes.new-4.0.0",
  "notes.failed-4",
  "notes.rollback",
  "notes.swept-1-0",
  ".aio-update-notes.zip-3.0.0-41-0a1b2c3d",
];
/** The baits that look like a leftover of THIS install: named, when left. */
const LOOK_ALIKE = (n: string) => !n.startsWith("notesX") && n !== "notes.zip";

async function bait(root: string): Promise<void> {
  await Deno.mkdir(join(root, "elsewhere"));
  await Deno.writeTextFile(join(root, "elsewhere", "precious.txt"), "mine");
  for (const d of BAIT_DIRS) {
    await Deno.mkdir(join(root, d));
    await Deno.writeTextFile(join(root, d, "user.txt"), "mine");
  }
  for (const f of BAIT_FILES) await Deno.writeTextFile(join(root, f), "mine");
  if (POSIX) {
    for (const l of BAIT_LINKS) {
      await Deno.symlink(join(root, "elsewhere"), join(root, l));
    }
  }
}

Deno.test("leftovers: what the record names goes — a look-alike with no record is left, whatever it is called", async () => {
  const { root, install, data } = await installed();
  try {
    for (const [n, kind] of OURS) await makeOwn(data, join(root, n), kind);
    // The version set aside for a rollback is on the record too — and is not
    // a leftover.
    await makeOwn(data, `${install}.old-0.1.3`, "dir", "kept");
    await bait(root);
    const untouched = [
      "elsewhere",
      "notes",
      "notes.old-0.1.3",
      ...BAIT_DIRS,
      ...BAIT_FILES,
      ...(POSIX ? BAIT_LINKS : []),
    ].sort();
    laterBoot(data);

    const { removed, left } = await sweepOwned(data, install);
    assertEquals(removed.sort(), OURS.map(([n]) => n).sort());
    assertEquals(names(root), untouched);
    assertEquals(
      left.sort(),
      untouched.filter((n) =>
        ![...BAIT_DIRS, ...BAIT_FILES, ...BAIT_LINKS].includes(n)
          ? false
          : LOOK_ALIKE(n)
      ),
    );
    // Nothing of the user's was looked into, followed or changed.
    assertEquals(names(join(root, "elsewhere")), ["precious.txt"]);
    for (const d of BAIT_DIRS) {
      assertEquals(await Deno.readTextFile(join(root, d, "user.txt")), "mine");
    }
    // The record holds what is still there: the kept-aside version.
    assertEquals(
      readOwned(data).filter((e) => e.role === "kept").map((e) => e.path),
      [`${install}.old-0.1.3`],
    );
    // A second boot has nothing more to remove, and names the same things.
    laterBoot(data);
    const again = await sweepOwned(data, install);
    assertEquals([again.removed, again.left.sort()], [[], left]);
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

Deno.test("leftovers: the record alone is not enough — what has the name now must be the very thing that was made", async () => {
  const { root, install, data } = await installed();
  try {
    // Ours was removed by hand, and the user put their own under the name.
    const tree = `${install}.staged-0.2.0`, file = `${install}.zip-0.2.0`;
    await makeOwn(data, tree, "dir");
    await makeOwn(data, file, "file");
    const was = [identity(tree), identity(file)];
    await Deno.remove(tree, { recursive: true });
    await Deno.remove(file);
    // (Something made in between: a filesystem may hand the next object the
    // number the removed one had.)
    await Deno.mkdir(join(root, "between"));
    await Deno.mkdir(tree);
    await Deno.writeTextFile(join(tree, "user.txt"), "mine");
    await Deno.writeTextFile(file, "mine");
    assert(
      identity(tree) !== was[0] && identity(file) !== was[1],
      "this filesystem gives a new object the identity of the removed one",
    );
    // …and a FOLDER where a file was made, a FILE where a folder was.
    await makeOwn(data, `${install}.new-0.2.1`, "file");
    await Deno.remove(`${install}.new-0.2.1`);
    await Deno.mkdir(`${install}.new-0.2.1`);
    // …and theirs where a version the updater kept used to be.
    await makeOwn(data, `${install}.old-0.1.9`, "dir", "kept");
    await Deno.remove(`${install}.old-0.1.9`, { recursive: true });
    await Deno.mkdir(`${install}.old-0.1.9`);
    laterBoot(data);

    const { removed, left, dropped } = await sweepOwned(data, install);
    assertEquals(removed, []);
    // The kept version's entry is void as well: off the record, named once.
    assertEquals(dropped, ["notes.old-0.1.9"]);
    assertEquals(left.sort(), [
      "notes.new-0.2.1",
      "notes.old-0.1.9",
      "notes.staged-0.2.0",
      "notes.zip-0.2.0",
    ]);
    assertEquals(await Deno.readTextFile(join(tree, "user.txt")), "mine");
    assertEquals(await Deno.readTextFile(file), "mine");
    assertEquals(
      readOwned(data).map((e) => basename(e.path)),
      [],
      "a void record is dropped",
    );
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

Deno.test("leftovers: one somebody is still working on is left — this run's, another live process's — and an earlier run of the SAME pid is not somebody", async () => {
  const { root, install, data } = await installed();
  try {
    const tree = `${install}.staged-0.1.4`;
    await makeOwn(data, tree, "dir");
    // Made by THIS run: an update in flight — one thing made, one written
    // down and half made. Neither is removed, neither is called a stranger.
    record(data, `${install}.zip-0.1.4`, "file");
    await Deno.writeTextFile(`${install}.zip-0.1.4`, "half a download");
    assertEquals(await sweepOwned(data, install), {
      removed: [],
      left: [],
      unproven: [],
      dropped: [],
      unreadable: [],
    });
    await Deno.remove(`${install}.zip-0.1.4`);
    // Made by another process that is alive (a second copy of the app).
    laterBoot(data, 4242);
    assertEquals(
      (await sweepOwned(data, install, { alive: (p) => p === 4242 })).removed,
      [],
    );
    assertEquals(names(root), ["notes", "notes.staged-0.1.4"]);
    // The same pid, an earlier run — where the app is pid 1 at every boot,
    // "is that pid alive" is always yes.
    laterBoot(data, Deno.pid);
    assertEquals(
      (await sweepOwned(data, install, { alive: () => true })).removed,
      ["notes.staged-0.1.4"],
    );
    assertEquals(names(root), ["notes"]);
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

Deno.test("leftovers: a second copy of the app with its own data directory removes nothing the first one made", async () => {
  const { root, install, data } = await installed();
  const other = await tempDir("aio-owned-data-b-");
  try {
    // The first copy is between its download and its swap.
    await makeOwn(data, `${install}.zip-2.0.0`, "file");
    await makeOwn(data, `${install}.staged-2.0.0`, "dir");
    // The second boots: nothing is on ITS record.
    const said = await boot({ installDir: install }, other, "left alone");
    assertEquals(said.filter((m) => m.includes("removed")), []);
    assertEquals(names(root), [
      "notes",
      "notes.staged-2.0.0",
      "notes.zip-2.0.0",
    ]);
    // Its record has no mark yet, so it looks once — and takes nothing: both
    // are too young to be anyone's leftovers.
    assertEquals(said.length, 2, said.join(" | "));
    assertEquals(
      said[0],
      `looked for what an earlier version's updater left beside ${install} ` +
        `(the record of what it made has no mark of that yet): nothing to ` +
        `take over`,
    );
    assert(
      said[1]!.includes("not made by this app's updater") &&
        said[1]!.includes("notes.staged-2.0.0") &&
        said[1]!.includes("notes.zip-2.0.0"),
      said[1],
    );
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
    await dropTempDir(other);
  }
});

Deno.test("leftovers: written down before it is made — a record with nothing made yet proves an empty folder, and nothing more", async () => {
  const { root, install, data } = await installed();
  try {
    // Cut off between the record and the making.
    record(data, `${install}.staged-0.3.0`, "dir");
    record(data, `${install}.staged-0.3.1`, "dir");
    record(data, `${install}.zip-0.3.1`, "file");
    record(data, `${install}.zip-0.3.2`, "file");
    assertEquals(readOwned(data).map((e) => e.is), Array(4).fill(undefined));
    await Deno.mkdir(`${install}.staged-0.3.0`); // made, and cut off here
    await Deno.mkdir(`${install}.staged-0.3.1`);
    await Deno.writeTextFile(join(`${install}.staged-0.3.1`, "f"), "whose?");
    await Deno.writeTextFile(`${install}.zip-0.3.1`, "whose?");
    // A LINK to an empty folder is not an empty folder.
    const link = POSIX ? ["notes.staged-0.3.3"] : [];
    if (POSIX) {
      record(data, `${install}.staged-0.3.3`, "dir");
      await Deno.mkdir(join(root, "empty"));
      await Deno.symlink(join(root, "empty"), `${install}.staged-0.3.3`);
    }
    laterBoot(data);
    const { removed, left } = await sweepOwned(data, install);
    assertEquals(removed, ["notes.staged-0.3.0"]);
    assertEquals(left.sort(), [
      "notes.staged-0.3.1",
      ...link,
      "notes.zip-0.3.1",
    ]);
    assertEquals(names(root), [
      ...(POSIX ? ["empty"] : []),
      "notes",
      "notes.staged-0.3.1",
      ...link,
      "notes.zip-0.3.1",
    ]);
    // The record keeps nothing that has nothing behind it, or something
    // else: only the set-aside it made just now.
    assertEquals(readOwned(data).map((e) => basename(e.path)), [
      `notes.swept-${Deno.pid}-0`,
    ]);
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

Deno.test("leftovers: something that is not ours under a name the update needs refuses the update — it is not removed", async () => {
  const { root, install, data } = await installed();
  try {
    const tree = `${install}.staged-2.0.0`;
    await Deno.mkdir(tree);
    await Deno.writeTextFile(join(tree, "user.txt"), "mine");
    assertThrows(
      () => record(data, tree, "dir"),
      Error,
      "is in the way of the update, and it was not made by this app's updater",
    );
    assertEquals(readOwned(data), []);
    assertEquals(await Deno.readTextFile(join(tree, "user.txt")), "mine");
    if (POSIX) {
      await Deno.symlink(tree, `${install}.zip-2.0.0`);
      assertThrows(
        () => record(data, `${install}.zip-2.0.0`, "file"),
        Error,
        "in the way",
      );
    }
    // Its own leftover is not in the way.
    await makeOwn(data, `${install}.staged-2.0.1`, "dir");
    record(data, `${install}.staged-2.0.1`, "dir");
    assertEquals(names(root).includes("notes.staged-2.0.1"), true);
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

Deno.test({
  name:
    "leftovers: one is moved out of its name before anything is deleted — under a name that is on record",
  // A tree that can be moved and not deleted: POSIX modes (root ignores them).
  ignore: !POSIX || Deno.uid() === 0,
  fn: async () => {
    const { root, install, data } = await installed();
    const staged = `${install}.staged-0.1.4`;
    const aside = `notes.swept-${Deno.pid}-0`;
    try {
      await makeOwn(data, staged, "dir");
      await Deno.mkdir(join(staged, "held"));
      await Deno.writeTextFile(join(staged, "held", "f"), "x");
      await Deno.chmod(join(staged, "held"), 0o500);
      laterBoot(data);
      const sweeping = sweepOwned(data, install);
      // Before anything is awaited: the name is free for the next install,
      // and the set-aside is on record.
      assertEquals(names(root), ["notes", aside]);
      assertEquals(readOwned(data).map((e) => e.path), [join(root, aside)]);
      // It could not be deleted, so it is not reported — and it waits.
      assertEquals((await sweeping).removed, []);
      assertEquals(names(root), ["notes", aside]);
      // A later boot removes it: it is ours by the record.
      await Deno.chmod(join(root, aside, "held"), 0o700);
      laterBoot(data);
      assertEquals((await sweepOwned(data, install)).removed, [aside]);
      assertEquals(names(root), ["notes"]);
    } finally {
      for (const n of names(root)) {
        await Deno.chmod(join(root, n, "held"), 0o700).catch(() => {});
      }
      await dropTempDir(root);
      await dropTempDir(data);
    }
  },
});

Deno.test({
  name:
    "leftovers: nothing is moved that could not be written down first under its new name",
  ignore: !POSIX || Deno.uid() === 0, // POSIX modes; root ignores them
  fn: async () => {
    const { root, install, data } = await installed();
    try {
      await makeOwn(data, `${install}.staged-0.1.4`, "dir");
      laterBoot(data);
      await Deno.chmod(data, 0o500);
      const { removed, left } = await sweepOwned(data, install);
      assertEquals([removed, left], [[], []]);
      assertEquals(names(root), ["notes", "notes.staged-0.1.4"]);
    } finally {
      await Deno.chmod(data, 0o700);
      await dropTempDir(root);
      await dropTempDir(data);
    }
  },
});

Deno.test("leftovers: the name one is set aside under is a free one — a file of the user's with that name is not replaced", async () => {
  const { root, install, data } = await installed();
  try {
    const theirs = `${install}.swept-${Deno.pid}-0`;
    await Deno.writeTextFile(theirs, "mine");
    await makeOwn(data, `${install}.zip-0.1.6`, "file");
    laterBoot(data);
    const { removed, left } = await sweepOwned(data, install);
    assertEquals([removed, left], [["notes.zip-0.1.6"], [basename(theirs)]]);
    assertEquals(await Deno.readTextFile(theirs), "mine");
    assertEquals(names(root), ["notes", basename(theirs)]);
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

// ── what builds older than the record left ─────────────────────────────────
//
// Up to 1.0.16 nothing was written down. A look at such a thing can say "this
// is a copy of the app" — and so can a copy somebody made by hand — so the
// look is taken ONCE, for the exact names those builds used, and what passes
// goes on the record. A hand copy named `notes.staged-mycopy` was removed at
// any boot, `notes.old-mybackup` was pruned as an old version, and a copy at
// `notes.old-<running version>` was replaced by the next update.

const HOURS = 3_600_000;
/** An unpacked copy of the app `notes`, last touched `hours` ago. */
async function appCopy(path: string, hours = 2, own?: string): Promise<void> {
  await Deno.mkdir(join(path, "electron"), { recursive: true });
  await Deno.writeTextFile(join(path, LAUNCHER), "start notes");
  if (own) await Deno.writeTextFile(join(path, own), "mine");
  await aged(path, hours);
}
async function aged(path: string, hours = 2): Promise<void> {
  const t = new Date(Date.now() - hours * HOURS);
  await Deno.utime(path, t, t);
}
const adopted = (data: string): unknown =>
  JSON.parse(Deno.readTextFileSync(ownedPath(data))).adopted;
const line = (said: string[], what: string) =>
  said.find((m) => m.includes(what)) ?? "";

Deno.test("older builds: what 1.0.16 left beside a directory install is taken onto the record ONCE — then swept and pruned as before", async () => {
  const { root, install, data } = await installed();
  try {
    // As those builds made them: kept-aside versions, a tree never swapped
    // in, its download, a build a rollback set aside, a cut-off download.
    const olds = ["0.1.0", "0.1.1", "0.1.2", "0.1.3"];
    // (The newest was set aside a moment ago, by the update that brought
    // this build.)
    for (const [i, v] of olds.entries()) {
      await appCopy(`${install}.old-${v}`, i === 3 ? 0 : 100 - i);
    }
    await appCopy(`${install}.staged-0.1.4`);
    await Deno.writeFile(
      `${install}.zip-0.1.4`,
      new Uint8Array([80, 75, 3, 4, 1, 2, 3]),
    );
    await aged(`${install}.zip-0.1.4`);
    // (A macOS download under the same name is a gzip.)
    await Deno.writeFile(
      `${install}.zip-0.1.3`,
      new Uint8Array([31, 139, 8, 0, 0]),
    );
    await aged(`${install}.zip-0.1.3`);
    await appCopy(`${install}.failed-1759400000000`);
    await Deno.mkdir(join(root, ".aio-update-0a1b2c3d"));
    await Deno.writeTextFile(
      join(root, ".aio-update-0a1b2c3d", "artifact"),
      "",
    );
    await aged(join(root, ".aio-update-0a1b2c3d", "artifact"));
    await aged(join(root, ".aio-update-0a1b2c3d"));
    const theirs = [
      "notes.staged-mycopy", // a hand copy of the app, a free name
      "notes.old-mybackup",
      "notes.staged-0.1.5", // another app's tree under an exact name
      "notes.zip-0.1.5", // not an archive
      "notes.staged-0.1.6", // an archive where a tree belongs
      "notes.zip-0.1.6", // a tree where an archive belongs
      "notes.old-0.1.7", // a file where a folder install keeps folders
      "notes.staged-0.1.8", // our launcher in a folder that is no unpacked app
      ".aio-update-1a1b2c3d", // a download folder somebody is writing to
    ];
    await appCopy(`${install}.staged-mycopy`, 2, "my-notes.txt");
    await appCopy(`${install}.old-mybackup`, 200, "my-config.json");
    await appCopy(`${install}.staged-0.1.5`);
    await Deno.writeTextFile(
      join(`${install}.staged-0.1.5`, LAUNCHER),
      "start something else",
    );
    await aged(`${install}.staged-0.1.5`);
    await Deno.writeTextFile(`${install}.zip-0.1.5`, "my archive notes");
    await Deno.writeTextFile(`${install}.staged-0.1.6`, "PK\x03\x04..");
    await appCopy(`${install}.zip-0.1.6`);
    await Deno.writeTextFile(`${install}.old-0.1.7`, "PK\x03\x04..");
    await Deno.mkdir(`${install}.staged-0.1.8`);
    await Deno.writeTextFile(
      join(`${install}.staged-0.1.8`, LAUNCHER),
      "start notes",
    );
    for (
      const n of ["zip-0.1.5", "staged-0.1.6", "old-0.1.7", "staged-0.1.8"]
    ) {
      await aged(`${install}.${n}`);
    }
    await Deno.mkdir(join(root, ".aio-update-1a1b2c3d"));
    await Deno.writeTextFile(
      join(root, ".aio-update-1a1b2c3d", "artifact"),
      "",
    );

    const said = await boot({ installDir: install }, data, "left alone");
    const took = line(said, "took over");
    for (
      const n of [
        ...olds.map((v) => `notes.old-${v}`),
        "notes.staged-0.1.4",
        "notes.zip-0.1.4",
        "notes.zip-0.1.3",
        "notes.failed-1759400000000",
        ".aio-update-0a1b2c3d",
      ]
    ) assert(took.includes(n), `${n} not taken over: ${said.join(" | ")}`);
    assert(theirs.length > 0);
    for (const n of theirs) {
      assert(!took.includes(n), `${n} taken over`);
      assert(line(said, "left alone").includes(n), `${n} not named`);
    }
    const kept = olds.map((v) => `notes.old-${v}`);
    assertEquals(names(root), ["notes", ...kept, ...theirs].sort());
    assertEquals(
      await Deno.readTextFile(join(`${install}.staged-mycopy`, "my-notes.txt")),
      "mine",
    );
    assertEquals(typeof adopted(data), "string");
    assertEquals(
      // By name: the record lists them in the order the folder was read.
      readOwned(data).filter((e) => e.role === "kept").map((e) => [
        basename(e.path),
        e.is,
      ]).sort(([a], [b]) => a! < b! ? -1 : 1),
      kept.map((n) => [n, identity(join(root, n))!]),
    );
    // Counted now: the oldest goes, a hand copy older still does not.
    await pruneOld(install, 3, data);
    assertEquals(
      names(root),
      ["notes", ...kept.slice(1), ...theirs].sort(),
    );

    // The look was taken. What turns up under those names LATER is on no
    // record: left, named, not counted.
    await appCopy(`${install}.staged-0.1.9`);
    await appCopy(`${install}.old-0.0.9`, 300, "my-config.json");
    const again = await boot({ installDir: install }, data, "left alone");
    assertEquals(line(again, "took over"), "", again.join(" | "));
    assertEquals(line(again, "removed"), "", again.join(" | "));
    for (const n of ["notes.staged-0.1.9", "notes.old-0.0.9"]) {
      assert(line(again, "left alone").includes(n), again.join(" | "));
    }
    await pruneOld(install, 1, data);
    assertEquals(
      names(root),
      [
        "notes",
        "notes.old-0.0.9",
        "notes.old-0.1.3",
        "notes.staged-0.1.9",
        ...theirs,
      ].sort(),
    );
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

Deno.test("older builds: beside a single-file install — its kept-aside versions and a download never swapped in, and nothing of another format", async () => {
  const root = await tempDir("aio-owned-");
  const data = await tempDir("aio-owned-data-");
  try {
    const artifact = join(root, "notes");
    const exe = (p: string, magic = "\x7fELF") =>
      Deno.writeTextFile(p, `${magic} ${basename(p)}`);
    await exe(artifact);
    await exe(`${artifact}.old-0.1.0`);
    await exe(`${artifact}.old-0.1.1`);
    await exe(`${artifact}.new-0.1.4`);
    await exe(`${artifact}.old-0.1.2`, "#!sh"); // a script of the user's
    await exe(`${artifact}.new-0.1.5`, "MZ\x90\x00");
    await appCopy(`${artifact}.old-0.1.3`); // a folder where files are kept
    for (const n of ["new-0.1.4", "new-0.1.5"]) await aged(`${artifact}.${n}`);

    const said = await boot(
      { installDir: null, artifact },
      data,
      "left alone",
    );
    assertEquals(names(root), [
      "notes",
      "notes.new-0.1.5",
      "notes.old-0.1.0",
      "notes.old-0.1.1",
      "notes.old-0.1.2",
      "notes.old-0.1.3",
    ]);
    assert(line(said, "removed").includes("notes.new-0.1.4"), said.join("|"));
    assertEquals(
      readOwned(data).filter((e) => e.role === "kept").map((e) =>
        basename(e.path)
      ).sort(),
      ["notes.old-0.1.0", "notes.old-0.1.1"],
    );
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

Deno.test("older builds: a leftover younger than an hour is not taken yet — somebody may be making it — and the look stays open until it can be", async () => {
  const { root, install, data } = await installed();
  try {
    // Another copy of the app, with its own data directory, is unpacking.
    await appCopy(`${install}.staged-0.1.4`, 0);
    const first = await boot({ installDir: install }, data, "left alone");
    assertEquals(line(first, "took over"), "", first.join(" | "));
    assertEquals(names(root), ["notes", "notes.staged-0.1.4"]);
    assertEquals(adopted(data), undefined);
    // An hour on, nobody has touched it.
    await aged(`${install}.staged-0.1.4`);
    const later = await boot({ installDir: install }, data, "removed");
    assert(line(later, "took over").includes("notes.staged-0.1.4"));
    assertEquals(names(root), ["notes"]);
    assertEquals(typeof adopted(data), "string");
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

Deno.test("older builds: the look is said, naming what it took — and taken again when the record is lost or its mark is gone", async () => {
  const root = await tempDir("aio-owned-");
  const data = await tempDir("aio-owned-data-");
  try {
    const artifact = join(root, "notes");
    await Deno.writeTextFile(artifact, "\x7fELF notes 0.1.2");
    await Deno.writeTextFile(`${artifact}.old-0.1.0`, "\x7fELF notes 0.1.0");
    const where = { installDir: null, artifact };
    const looks = (said: string[]) => said.filter((m) => m.includes("looked"));
    const head = `looked for what an earlier version's updater left beside ` +
      `${artifact} (the record of what it made has no mark of that yet): `;

    const first = await boot(where, data, "looked for");
    assertEquals(looks(first), [`${head}took over notes.old-0.1.0`]);
    // Taken: later starts do not look, and do not say so.
    assertEquals(looks(await boot(where, data, null)), []);

    // A hand edit took the mark off: it looks again, and says what it found.
    const rec = JSON.parse(Deno.readTextFileSync(ownedPath(data)));
    delete rec.adopted;
    Deno.writeTextFileSync(ownedPath(data), JSON.stringify(rec));
    await Deno.writeTextFile(`${artifact}.old-0.1.1`, "\x7fELF notes 0.1.1");
    const unmarked = await boot(where, data, "looked for");
    // What is on the record already is not taken twice.
    assertEquals(looks(unmarked), [`${head}took over notes.old-0.1.1`]);
    assertEquals(readOwned(data).length, 2);
    assertEquals(typeof adopted(data), "string");

    // The record is lost (a data directory restored from before it): all of
    // them again, by their exact names.
    Deno.removeSync(ownedPath(data));
    const lost = await boot(where, data, "looked for");
    assertEquals(looks(lost), [
      `${head}took over notes.old-0.1.0, notes.old-0.1.1`,
    ]);
    assertEquals(names(root), ["notes", "notes.old-0.1.0", "notes.old-0.1.1"]);
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

Deno.test("older builds: a run from source does not look beside the `deno` it runs on — no update is ever applied there", async () => {
  const root = await tempDir("aio-owned-");
  const data = await tempDir("aio-owned-data-");
  try {
    const deno = join(root, POSIX ? "deno" : "deno.exe");
    // Exactly what a kept copy of a single-file install looks like.
    await Deno.writeTextFile(deno, "\x7fELF deno 2.9");
    await Deno.writeTextFile(`${deno}.old-2.8.0`, "\x7fELF deno 2.8");
    await aged(`${deno}.old-2.8.0`);
    const said = await boot({ installDir: null, artifact: deno }, data, null);
    assertEquals(said, []);
    assertEquals(names(root).length, 2);
    assertThrows(() => Deno.lstatSync(ownedPath(data)), Deno.errors.NotFound);
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

Deno.test("kept copies: one cut off while it was being written is no version — prune does not count it, a rollback refuses it, the next start removes it", async () => {
  const root = await tempDir("aio-owned-");
  const data = await tempDir("aio-owned-data-");
  try {
    const artifact = join(root, "notes");
    await Deno.writeTextFile(artifact, "\x7fELF notes 0.1.4");
    // Three whole copies an earlier update kept. An entry with no state is one
    // written after its copy was whole — the shape every older record has.
    const whole = ["0.1.0", "0.1.1", "0.1.2"].map((v) =>
      `${artifact}.old-${v}`
    );
    for (const [i, p] of whole.entries()) {
      record(data, p, "file", { role: "kept" });
      await Deno.writeTextFile(p, `\x7fELF notes ${basename(p)}`);
      // Aged BEFORE it is written down: on macOS setting a file's time to
      // before its creation moves its creation time too — and that is half
      // of the identity the record keeps.
      await aged(p, 10 - i);
      made(data, p);
    }
    assertEquals(readOwned(data).map((e) => e.state), Array(3).fill(undefined));
    // The update to 0.1.4 was killed half-way through copying 0.1.3 aside:
    // recorded as filling, made, never finished.
    const cut = `${artifact}.old-0.1.3`;
    record(data, cut, "file", { role: "kept" });
    await Deno.writeTextFile(cut, "\x7fELF no");
    made(data, cut, { filling: true });
    const entry = readOwned(data).find((e) => e.path === cut)!;
    assertEquals([entry.state, entry.is], ["filling", identity(cut)!]);

    // Not one of the 3 kept: no whole copy goes to make room for it, and
    // pruning does not remove it either (the next start does).
    await pruneOld(artifact, 3, data);
    assertEquals(names(root), [
      "notes",
      "notes.old-0.1.0",
      "notes.old-0.1.1",
      "notes.old-0.1.2",
      "notes.old-0.1.3",
    ]);
    await assertRejects(
      () => restoreArtifact(artifact, cut, data),
      Error,
      `the copy to roll back to (${cut}) was cut off while it was being ` +
        `written — it is not a whole build, and nothing was changed.`,
    );
    assertEquals(await Deno.readTextFile(artifact), "\x7fELF notes 0.1.4");

    // The next start, nobody filling it any more: it is ours, and it goes.
    laterBoot(data, NOBODY);
    const said = await boot({ installDir: null, artifact }, data, "removed");
    assertEquals(
      line(said, "removed"),
      `removed what an unfinished update left beside ${artifact}: ` +
        `notes.old-0.1.3`,
    );
    assertEquals(names(root), [
      "notes",
      "notes.old-0.1.0",
      "notes.old-0.1.1",
      "notes.old-0.1.2",
    ]);
    assert(!readOwned(data).some((e) => e.path === cut), "still on record");

    // A whole copy is unchanged: counted (keep 2 takes the oldest), and
    // rolled back to.
    await pruneOld(artifact, 2, data);
    assertEquals(names(root), ["notes", "notes.old-0.1.1", "notes.old-0.1.2"]);
    await restoreArtifact(artifact, whole[2]!, data);
    assertEquals(
      await Deno.readTextFile(artifact),
      "\x7fELF notes notes.old-0.1.2",
    );
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

Deno.test("leftovers: a file with the same identity but other bytes is not ours — NTFS gives a file made again under a deleted one's name its creation time, and Deno rounds its file number", async () => {
  const { root, install, data } = await installed();
  const real = _ownedDeps.lstat;
  try {
    const zip = `${install}.zip-0.1.6`, old = `${install}.old-0.1.2`;
    await makeOwn(data, zip, "file");
    await makeOwn(data, old, "file", "kept");
    for (const e of readOwned(data)) assertMatch(e.sum!, /^12:[0-9a-f]{64}$/);
    // Rewritten in place: the same file number and creation time, the same
    // size — another file's bytes.
    await Deno.writeTextFile(old, "the user's!!");
    // Deleted and made again by somebody else; the stat says what NTFS can
    // say of it — the dead one's creation time, a file number rounded onto
    // the dead one's.
    const was = real(zip);
    await Deno.remove(zip);
    await Deno.writeTextFile(zip, "the user's!!");
    _ownedDeps.lstat = (p) =>
      p === zip
        ? new Proxy(real(p), {
          get: (t, k) =>
            k === "ino" || k === "birthtime" || k === "dev"
              ? Reflect.get(was, k)
              : Reflect.get(t, k),
        })
        : real(p);
    assertEquals(identity(zip), readOwned(data)[0]!.is);
    assertEquals(identity(old), readOwned(data)[1]!.is);
    assertEquals([isOwn(data, zip), isOwn(data, old)], [false, false]);
    // A file entry without its bytes (a hand edit) proves nothing either.
    const bare = `${install}.new-0.1.7`;
    await makeOwn(data, bare, "file");
    assert(isOwn(data, bare));
    const rec = JSON.parse(Deno.readTextFileSync(ownedPath(data)));
    for (const e of rec.made) if (e.path === bare) delete e.sum;
    Deno.writeTextFileSync(ownedPath(data), JSON.stringify(rec));
    assertEquals(isOwn(data, bare), false);
    await Deno.remove(bare);

    laterBoot(data, NOBODY);
    const said = await boot({ installDir: install }, data, "left alone");
    assertEquals(line(said, "removed"), "", said.join(" | "));
    assert(
      line(said, "left alone").includes("notes.zip-0.1.6"),
      said.join("|"),
    );
    await pruneOld(install, 0, data);
    assertEquals(names(root), ["notes", "notes.old-0.1.2", "notes.zip-0.1.6"]);
    for (const p of [zip, old]) {
      assertEquals(await Deno.readTextFile(p), "the user's!!");
    }
  } finally {
    _ownedDeps.lstat = real;
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

Deno.test("leftovers: a name the update needs that cannot even be looked at is in the way — refused before anything is downloaded", () => {
  const real = _ownedDeps.lstat;
  try {
    _ownedDeps.lstat = (p) => {
      if (p.endsWith(".old-1.0.0")) {
        throw new Deno.errors.PermissionDenied(
          "Access is denied. (os error 5)",
        );
      }
      return real(p);
    };
    assertThrows(
      () => assertNotInTheWay("/nonexistent-data", "/apps/notes.old-1.0.0"),
      Error,
      "/apps/notes.old-1.0.0 is in the way of the update: it cannot be " +
        "looked at (PermissionDenied: Access is denied. (os error 5)) — " +
        "nothing was changed.",
    );
    // Nothing there at all is no obstacle.
    assertNotInTheWay("/nonexistent-data", "/apps/notes.old-0.9.0");
  } finally {
    _ownedDeps.lstat = real;
  }
});

Deno.test("leftovers: the copy a directory update keeps aside is an intent until it is moved — a held file that stops the helper leaves the old copy ours, and the next try goes ahead", async () => {
  const { root, install, data } = await installed();
  try {
    const old = `${install}.old-0.1.35`, staged = `${install}.staged-0.1.36`;
    await makeOwn(data, old, "dir", "kept");
    await Deno.writeTextFile(join(old, "run.bat"), "held");
    const theOld = identity(old)!, theInstall = identity(install)!;
    const swap = (helper: () => void) =>
      swapDirectoryDetached({
        current: install,
        staged,
        fromVersion: "0.1.35",
        pending: { dataDir: data, from: "0.1.35", to: "0.1.36" },
        // The stub stands in for the helper, which removes its own script.
        spawn: (_c, args) => {
          if (Deno.build.os !== "windows") Deno.removeSync(args[0]!);
          helper();
        },
      });
    const noUpdateInFlight = async () => {
      await Deno.remove(pendingPath(data));
      await Deno.remove(firstBootPath(data));
    };
    await appCopy(staged, 0);
    // (The one-time look at older builds' things was taken long ago.)
    const rec = JSON.parse(Deno.readTextFileSync(ownedPath(data)));
    Deno.writeTextFileSync(
      ownedPath(data),
      JSON.stringify({ ...rec, adopted: "2026-01-01T00:00:00.000Z" }),
    );

    // Try 1: the helper deletes part of the old copy, then a held file stops
    // it — the install never moves.
    swap(() => Deno.removeSync(join(old, "app.bin")));
    assertEquals(isOwn(data, old), true);
    assertEquals(
      readOwned(data).filter((e) => e.path === old).map((e) => [e.is, e.state]),
      [[theOld, undefined], [theInstall, "moving"]],
    );
    await noUpdateInFlight();
    laterBoot(data, NOBODY);
    const said = await boot({ installDir: install }, data, "left alone");
    // (The staged tree here is the test's own, on no record.)
    assertEquals(
      line(said, "left alone"),
      `left alone beside ${install}: not made by this app's updater — ` +
        `notes.staged-0.1.36`,
    );
    assertEquals(
      readOwned(data).filter((e) => e.path === old).map((e) => e.is),
      [theOld],
    );
    assertNotInTheWay(data, old); // the next try is not refused

    // Try 2, the holder gone: the helper moves the install there.
    swap(() => {
      Deno.removeSync(old, { recursive: true });
      Deno.renameSync(install, old);
      Deno.renameSync(staged, install);
    });
    assert(isOwn(data, old), "the moved copy is ours before any start");
    await noUpdateInFlight();
    laterBoot(data, NOBODY);
    // The old entry is replaced by the updater's own copy: not "something
    // else has the name".
    const after = await boot({ installDir: install }, data, null);
    assertEquals(line(after, "off the record"), "", after.join(" | "));
    assertEquals(
      readOwned(data).filter((e) => e.path === old).map((e) => [e.is, e.state]),
      [[theInstall, undefined]],
    );
    assert(isOwn(data, old));
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

/** An install where the one-click `.exe` extracts it:
 *  `<LOCALAPPDATA>/aio-sfx/notes/win-x64`, and kept copies beside it. */
async function sfxInstalled(): Promise<
  { root: string; install: string; data: string }
> {
  const root = await tempDir("aio-owned-");
  const install = join(root, "aio-sfx", "notes", "win-x64");
  await Deno.mkdir(join(install, "electron"), { recursive: true });
  await Deno.writeTextFile(join(install, LAUNCHER), "start notes");
  const data = await tempDir("aio-owned-data-");
  // (The one-time look at older builds' things was taken long ago.)
  Deno.writeTextFileSync(
    ownedPath(data),
    JSON.stringify({ adopted: "2026-01-01T00:00:00.000Z", made: [] }),
  );
  return { root, install, data };
}
const STAMP = ".aio-sfx-stamp";
async function stamped(dir: string, sha: string, hours: number) {
  await Deno.writeTextFile(join(dir, STAMP), `${sha}\n`);
  await aged(join(dir, STAMP), hours);
}

Deno.test("sfx stamp: an install whose stamp an older updater dropped takes it from the newest kept copy on record that has one — at a start, and at a swap", async () => {
  const { root, install, data } = await sfxInstalled();
  try {
    // 0.1.32 extracted by the one-click .exe; 0.1.33 swapped in by 1.0.16,
    // which dropped the stamp; a copy NOT on the record, stamped later.
    for (const v of ["0.1.31", "0.1.32", "0.1.33"]) {
      await makeOwn(data, `${install}.old-${v}`, "dir", "kept");
    }
    await stamped(`${install}.old-0.1.31`, "sha31", 30);
    await stamped(`${install}.old-0.1.32`, "sha32", 20);
    await Deno.mkdir(`${install}.old-0.1.30`);
    await stamped(`${install}.old-0.1.30`, "theirs", 1);
    laterBoot(data, NOBODY);

    const said = await boot({ installDir: install }, data, "lost the stamp");
    assertEquals(await Deno.readTextFile(join(install, STAMP)), "sha32\n");
    assertEquals(
      line(said, "lost the stamp"),
      `${install} had lost the stamp of the one-click notes-win-x64.exe (an ` +
        `update by aio 1.0.16 or older dropped it) — taken from ` +
        `win-x64.old-0.1.32, so opening that .exe starts this version ` +
        `instead of reinstalling its own`,
    );
    // Once there, it is kept and nothing more is said.
    const again = await boot({ installDir: install }, data, null);
    assertEquals(line(again, "stamp"), "", again.join(" | "));

    // At a swap: the tree going in gets it even when the running one has
    // lost it again.
    await Deno.remove(join(install, STAMP));
    // …and a kept copy on the record was replaced by hand since: its stamp,
    // the newest, is not one the updater can vouch for.
    await Deno.remove(`${install}.old-0.1.31`, { recursive: true });
    await Deno.mkdir(`${install}.old-0.1.31`);
    await stamped(`${install}.old-0.1.31`, "theirs too", 0);
    const staged = `${install}.staged-0.1.36`;
    await Deno.mkdir(staged);
    swapDirectoryDetached({
      current: install,
      staged,
      fromVersion: "0.1.35",
      pending: { dataDir: data, from: "0.1.35", to: "0.1.36" },
      spawn: (_c, args) =>
        Deno.build.os !== "windows" && Deno.removeSync(args[0]!),
    });
    assertEquals(await Deno.readTextFile(join(staged, STAMP)), "sha32\n");
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

Deno.test("sfx stamp: none anywhere is said, with what it costs — and an install the .exe did not make is not asked", async () => {
  const { root, install, data } = await sfxInstalled();
  const plain = await installed();
  try {
    await makeOwn(data, `${install}.old-0.1.33`, "dir", "kept");
    const said = await boot({ installDir: install }, data, "no stamp");
    assertEquals(
      line(said, "no stamp"),
      `${install} has no stamp of the one-click notes-win-x64.exe that ` +
        `installed it, and no copy this updater kept has one — opening that ` +
        `.exe reinstalls the version it carries, over this one. Start the ` +
        `app from its own shortcut, or download the current notes-win-x64.exe.`,
    );
    const other = await boot({ installDir: plain.install }, plain.data, null);
    assertEquals(line(other, "stamp"), "", other.join(" | "));
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
    await dropTempDir(plain.root);
    await dropTempDir(plain.data);
  }
});

Deno.test("leftovers: one that cannot be looked at (access denied) is said as that, never as not made by this app's updater, and stays on the record", async () => {
  const { root, install, data } = await installed();
  const real = _ownedDeps.lstat;
  try {
    const old = `${install}.old-0.1.2`;
    await makeOwn(data, old, "dir", "kept");
    await appCopy(`${install}.staged-0.1.4`);
    const denied = [old, `${install}.staged-0.1.4`];
    _ownedDeps.lstat = (p) => {
      if (denied.includes(p)) {
        throw new Deno.errors.PermissionDenied("Access is denied.");
      }
      return real(p);
    };
    const was = readOwned(data);
    laterBoot(data, NOBODY);
    const said = await boot({ installDir: install }, data, "cannot be looked");
    assertEquals(
      line(said, "cannot be looked"),
      `left alone beside ${install}: cannot be looked at — ` +
        `notes.old-0.1.2 (PermissionDenied: Access is denied.), ` +
        `notes.staged-0.1.4 (PermissionDenied: Access is denied.)`,
    );
    assertEquals(line(said, "not made by"), "", said.join(" | "));
    assertEquals(readOwned(data).map((e) => [e.path, e.is]), [
      [was[0]!.path, was[0]!.is],
    ]);
  } finally {
    _ownedDeps.lstat = real;
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

Deno.test("leftovers: on a file system that gives no creation time nothing is removed on the record's word — it is kept, and said with its size", async () => {
  const { root, install, data } = await installed();
  const real = _ownedDeps.lstat;
  try {
    _ownedDeps.lstat = (p) =>
      new Proxy(real(p), {
        get: (t, k) => k === "birthtime" ? null : Reflect.get(t, k),
      });
    const staged = `${install}.staged-0.1.4`, old = `${install}.old-0.1.2`;
    await makeOwn(data, staged, "dir");
    await makeOwn(data, old, "file", "kept");
    assertEquals([identity(staged), identity(old)], [null, null]);
    assertEquals(readOwned(data).map((e) => e.is), [undefined, undefined]);
    // An older build's things are not taken over either.
    await appCopy(`${install}.staged-0.1.3`);
    laterBoot(data, NOBODY);
    const said = await boot({ installDir: install }, data, "left alone");
    assertEquals(names(root), [
      "notes",
      "notes.old-0.1.2",
      "notes.staged-0.1.3",
      "notes.staged-0.1.4",
    ]);
    const warned = said.filter((m) => m.includes("no creation time"));
    assertEquals(warned.length, 2, said.join(" | "));
    assert(warned.some((m) => m.startsWith(`${staged} (1 MB)`)), warned[0]);
    assert(warned.some((m) => m.startsWith(`${old} (1 MB)`)), warned[1]);
    assert(warned[0]!.includes("old versions are not pruned"), warned[0]);
    assertEquals(
      line(said, "left alone").includes("notes.staged-0.1.3") &&
        !line(said, "left alone").includes("notes.staged-0.1.4"),
      true,
      said.join(" | "),
    );
    await pruneOld(install, 0, data);
    assertEquals(names(root).includes("notes.old-0.1.2"), true);
  } finally {
    _ownedDeps.lstat = real;
    await dropTempDir(root);
    await dropTempDir(data);
  }
});

/** One boot; resolves with the info and warn lines about leftovers once one
 *  contains `until` (the boot does not await the removal), or after 5 s. */
async function boot(
  where: { installDir: string | null; artifact?: string },
  data: string,
  until: string | null,
): Promise<string[]> {
  const said: string[] = [];
  const keep = (_c: string, m: string) => said.push(m);
  startUpdates({
    updates: { source: "https://example.invalid/rel", check: false },
    dataDir: data,
    appName: "notes",
    appVersion: "0.1.3",
    local: { schema: 1, cells: {} },
    exposed: false,
    log: { debug() {}, error() {}, warn: keep, info: keep } as unknown as Log,
    argv: [],
    slot: { runtime: null, cell: null } as unknown as UpdatesSlot,
    ...where,
  }).stop();
  const lines = () =>
    said.filter((m) =>
      /unfinished update|left alone|record of what the updater made|looked for|no creation time|stamp/
        .test(m)
    );
  const deadline = Date.now() + (until === null ? 300 : 5000);
  while (
    !(until !== null && lines().some((m) => m.includes(until))) &&
    Date.now() < deadline
  ) await new Promise((r) => setTimeout(r, 10));
  return lines();
}

for (
  const [layout, where] of [
    ["a directory install", (p: string) => ({ installDir: p })],
    ["a single-file install", (p: string) => ({
      installDir: null,
      artifact: p,
    })],
  ] as const
) {
  Deno.test(`leftovers: a boot of ${layout} with no update in flight removes them, and says which — and which it left`, async () => {
    const { root, install, data } = await installed();
    try {
      for (const [n, kind] of OURS) await makeOwn(data, join(root, n), kind);
      await Deno.writeTextFile(`${install}.zip-backup`, "mine");
      // Made by nobody who is still there.
      laterBoot(data, NOBODY);
      const said = await boot(where(install), data, "left alone");
      assertEquals(said.length, 3, said.join(" | "));
      assert(said[0]!.endsWith("nothing to take over"), said[0]);
      for (const [n] of OURS) assert(said[1]!.includes(n), said[1]);
      assert(said[1]!.includes(`left beside ${install}`), said[1]);
      assertEquals(
        said[2],
        `left alone beside ${install}: not made by this app's updater — ` +
          `notes.zip-backup`,
      );
      assertEquals(names(root), ["notes", "notes.zip-backup"]);
    } finally {
      await dropTempDir(root);
      await dropTempDir(data);
    }
  });
}

Deno.test("leftovers: while an update is in flight nothing is removed", async () => {
  for (const inFlight of ["pending marker", "first-boot token"]) {
    const { root, install, data } = await installed();
    try {
      await makeOwn(data, `${install}.staged-0.1.4`, "dir");
      laterBoot(data, NOBODY);
      if (inFlight === "pending marker") {
        // This boot is another executable than the one being replaced: the
        // new build's first boot.
        writePending(data, {
          from: "0.1.3",
          to: "0.1.4",
          artifact: install,
          previous: `${install}.old-0.1.3`,
          attempts: 1,
          startedAt: "2026-10-02T18:00:00.000Z",
        });
      } else await Deno.writeTextFile(firstBootPath(data), "{}");
      // A leftover is renamed aside before the boot returns: a wrong sweep
      // shows at once.
      assertEquals(await boot({ installDir: install }, data, null), []);
      assertEquals(names(root), ["notes", "notes.staged-0.1.4"], inFlight);
    } finally {
      await dropTempDir(root);
      await dropTempDir(data);
    }
  }
});

Deno.test("leftovers: a record that cannot be read removes nothing, and says so", async () => {
  const { root, install, data } = await installed();
  try {
    await makeOwn(data, `${install}.staged-0.1.4`, "dir");
    for (const broken of ["{ not JSON", '{ "not": "a list" }']) {
      await Deno.writeTextFile(ownedPath(data), broken);
      const said = await boot({ installDir: install }, data, "record of what");
      assertEquals(said.length, 1, said.join(" | "));
      assert(
        said[0]!.includes(ownedPath(data)) &&
          said[0]!.includes(`nothing beside ${install} is removed`),
        said[0],
      );
      assertEquals(names(root), ["notes", "notes.staged-0.1.4"]);
    }
  } finally {
    await dropTempDir(root);
    await dropTempDir(data);
  }
});
