// A download that was cut off does not stay beside the install for good.
//
// `downloadArtifact` removes its staging directory on every failure it lives
// to see. An app KILLED mid-download left `.aio-update-<8 hex>/artifact` — up
// to a whole release — and nothing ever looked for it: the name said neither
// whose it was nor whether somebody was still writing it.
//
// Now the staging directory and the finished file are written down in the
// app's data directory before they are made, and a later boot removes them
// by that record (tests/updates-orphaned-staged-trees.test.ts has the rule).
// A folder of the old name is on no record: it is taken onto it — once — only
// when it has the exact shape and nothing has written to it for an hour.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { basename, dirname, join } from "@std/path";
import { sha256Hex } from "../src/build/ship.ts";
import {
  abandonedOldStage,
  downloadArtifact,
} from "../src/server/updates-check.ts";
import {
  _ownedDeps,
  adoptOlder,
  assertNotInTheWay,
  identity,
  isOwn,
  moved,
  OLD_STAGE_AGE_MS,
  ownedPath,
  readOwned,
  setAsideChanged,
  sweepOwned,
} from "../src/server/updates-owned.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const names = (dir: string) =>
  [...Deno.readDirSync(dir)].map((e) => e.name).sort();
const BODY = new TextEncoder().encode("ARTIFACT-".repeat(500));

/** A host serving `BODY`, an install path `notes`, and the app's data dir. */
async function world() {
  const root = await tempDir("aio-dl-stages-");
  const data = await tempDir("aio-dl-stages-data-");
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    () => new Response(BODY.buffer as ArrayBuffer),
  );
  return {
    root,
    data,
    install: join(root, "notes"),
    get: async (dest: string, o: { keepStaged?: boolean; owner?: string }) =>
      await downloadArtifact({
        url: `http://127.0.0.1:${port}/app`,
        dest,
        expectSha256: await sha256Hex(BODY),
        expectSize: BODY.length,
        ...o,
      }),
    end: async () => {
      await server.shutdown();
      await dropTempDir(root);
      await dropTempDir(data);
    },
  };
}

// NTFS gives a file renamed to a name removed seconds ago that name's old
// creation time (measured on Windows 11). The download's identity is taken
// before its rename: made again right after its damaged copy was removed, it
// was "not made by this app's updater" and in the way of its release for good.
Deno.test("downloads: a download whose creation time changes in the rename to its name is still the updater's — by its bytes, and only by them", async () => {
  const w = await world();
  const real = _ownedDeps.lstat;
  try {
    const dest = `${w.install}.zip-0.1.6`;
    // The file system of the test: whatever is at `dest` was born earlier.
    _ownedDeps.lstat = (p) => {
      const s = real(p);
      return p === dest && s.birthtime
        ? { ...s, birthtime: new Date(s.birthtime.getTime() - 5_000) }
        : s;
    };
    const got = await w.get(dest, { owner: w.data });
    assert(got.ok, got.ok ? "" : got.error);
    assert(isOwn(w.data, dest), "the download is on the record as it is now");

    // Other bytes under the name, another identity: the record does not
    // follow — what is there stays unproven.
    const before = readOwned(w.data);
    await Deno.remove(dest);
    await Deno.writeTextFile(dest, "my archive");
    _ownedDeps.lstat = (p) => {
      const s = real(p);
      return p === dest && s.birthtime
        ? { ...s, birthtime: new Date(s.birthtime.getTime() - 9_000) }
        : s;
    };
    moved(w.data, dest);
    assertEquals(readOwned(w.data), before);
    assert(!isOwn(w.data, dest));
  } finally {
    _ownedDeps.lstat = real;
    await w.end();
  }
});

/** The record as a later run of the app reads it. */
function laterBoot(data: string): void {
  const file = JSON.parse(Deno.readTextFileSync(ownedPath(data)));
  Deno.writeTextFileSync(
    ownedPath(data),
    JSON.stringify({
      ...file,
      made: readOwned(data).map((e) => ({ ...e, boot: "an earlier run" })),
    }),
  );
}

Deno.test("downloads: the staging folder is on record as the very folder that was made, and a later boot removes it", async () => {
  const w = await world();
  try {
    // `keepStaged` leaves the folder as a kill mid-download does.
    const got = await w.get(`${w.install}.zip-0.1.6`, {
      keepStaged: true,
      owner: w.data,
    });
    assert(got.ok, got.ok ? "" : got.error);
    const stage = dirname(got.path);
    assertMatch(
      basename(stage),
      new RegExp(
        `^\\.aio-update-notes\\.zip-0\\.1\\.6-${Deno.pid}-[0-9a-f]{8}$`,
      ),
    );
    assertEquals(
      readOwned(w.data).map((e) => [e.path, e.kind, e.role, e.is, e.pid]),
      [[stage, "dir", "temp", identity(stage)!, Deno.pid]],
    );
    // This run's: in flight.
    assertEquals((await sweepOwned(w.data, w.install)).removed, []);
    assertEquals(names(w.root), [basename(stage)]);
    laterBoot(w.data);
    assertEquals((await sweepOwned(w.data, w.install)).removed, [
      basename(stage),
    ]);
    assertEquals(names(w.root), []);
  } finally {
    await w.end();
  }
});

Deno.test("downloads: the finished file is on record before it has its name — killed before the swap, a later boot removes it", async () => {
  const w = await world();
  try {
    const dest = `${w.install}.new-2.0.0`;
    const got = await w.get(dest, { owner: w.data });
    assert(got.ok, got.ok ? "" : got.error);
    assertEquals(names(w.root), ["notes.new-2.0.0"]);
    const mine = readOwned(w.data).find((e) => e.path === dest);
    assertEquals([mine?.kind, mine?.is], ["file", identity(dest)!]);
    laterBoot(w.data);
    assertEquals((await sweepOwned(w.data, w.install)).removed, [
      "notes.new-2.0.0",
    ]);
    assertEquals(names(w.root), []);
  } finally {
    await w.end();
  }
});

Deno.test("downloads: nothing is made that could not be written down first", async () => {
  const w = await world();
  try {
    const got = await w.get(`${w.install}.zip-0.1.6`, {
      owner: join(w.data, "no-such-folder"),
    });
    assertEquals(got.ok, false);
    assertEquals(names(w.root), [], "a folder was made with no record of it");
  } finally {
    await w.end();
  }
});

Deno.test("downloads: a file of the user's where the download goes refuses it — the file stays", async () => {
  const w = await world();
  try {
    const dest = `${w.install}.zip-0.1.6`;
    await Deno.writeTextFile(dest, "my archive");
    const got = await w.get(dest, { owner: w.data });
    assert(!got.ok);
    assertMatch(got.error, /is in the way of the update/);
    assertEquals(await Deno.readTextFile(dest), "my archive");
    assertEquals(names(w.root), ["notes.zip-0.1.6"], "staging left behind");
  } finally {
    await w.end();
  }
});

// A kept download whose bytes changed where it lies refused its release as
// "in the way" until somebody removed it by hand. It is moved aside — only
// the very file on the record, only when its bytes are other ones, and never
// removed: on NTFS another file can carry the same identity.
Deno.test("downloads: a download of ours with other bytes is moved aside, whole — and nothing else under its name is touched", async () => {
  const w = await world();
  try {
    const dest = `${w.install}.zip-0.1.6`;
    const fresh = async () => {
      const got = await w.get(dest, { owner: w.data });
      assert(got.ok, got.ok ? "" : got.error);
    };
    await fresh();
    // As it was made: not moved.
    assertEquals(setAsideChanged(w.data, dest), null);
    assert(isOwn(w.data, dest));

    // Somebody's file under the name (another object): not ours to move.
    await Deno.remove(dest);
    await Deno.writeTextFile(dest, "my archive");
    if (Deno.build.os !== "windows") { // NTFS hands the new file the old identity
      assertEquals(setAsideChanged(w.data, dest), null);
      assertEquals(names(w.root), ["notes.zip-0.1.6"]);
    }
    await Deno.remove(dest);

    // The very file, other bytes: moved to a FREE name — one that is taken
    // is somebody's — with every byte, and off the record.
    await fresh();
    await Deno.writeTextFile(`${dest}~damaged`, "mine");
    await Deno.writeTextFile(dest, "damaged");
    assertEquals(setAsideChanged(w.data, dest), `${dest}~damaged-2`);
    assertEquals(await Deno.readTextFile(`${dest}~damaged`), "mine");
    assertEquals(await Deno.readTextFile(`${dest}~damaged-2`), "damaged");
    assertEquals(readOwned(w.data).filter((e) => e.path === dest), []);
    // …and the release downloads to its name again.
    await fresh();
    assertEquals(names(w.root), [
      "notes.zip-0.1.6",
      "notes.zip-0.1.6~damaged",
      "notes.zip-0.1.6~damaged-2",
    ]);
    // No later start takes the moved file for the updater's and removes it.
    laterBoot(w.data);
    // (Even the one look at older builds' things, with a proof that passes
    // everything: `~` is in none of their names.)
    assertEquals(adoptOlder(w.data, w.install, () => true), []);
    const swept = await sweepOwned(w.data, w.install);
    assertEquals(swept.removed, ["notes.zip-0.1.6"]);
    assertEquals(swept.left, [
      "notes.zip-0.1.6~damaged",
      "notes.zip-0.1.6~damaged-2",
    ]);
  } finally {
    await w.end();
  }
});

// A start before the release was tried again voided the damaged download's
// entry ("something else has the name now"): with no entry it could not be
// moved aside, and it refused its release as "not made by this app's
// updater" for good. A start leaves it — unproven, so named — on the record.
Deno.test("downloads: a damaged download of ours that a start finds stays on the record — its release moves it aside later, not refused", async () => {
  const w = await world();
  try {
    const dest = `${w.install}.zip-0.1.6`;
    const got = await w.get(dest, { owner: w.data });
    assert(got.ok, got.ok ? "" : got.error);
    await Deno.writeTextFile(dest, "damaged");
    laterBoot(w.data);
    const swept = await sweepOwned(w.data, w.install);
    assertEquals([swept.removed, swept.left], [[], ["notes.zip-0.1.6"]]);
    assertEquals(await Deno.readTextFile(dest), "damaged");
    // The update of 0.1.6: moved aside, and its name is free for it.
    assertEquals(setAsideChanged(w.data, dest), `${dest}~damaged`);
    assertNotInTheWay(w.data, dest);
    const again = await w.get(dest, { owner: w.data });
    assert(again.ok, again.ok ? "" : again.error);
  } finally {
    await w.end();
  }
});

Deno.test("downloads: a folder of the old name goes only with the exact shape, untouched for an hour", async () => {
  const root = await tempDir("aio-dl-stages-");
  try {
    const at = (age: number) => new Date(Date.now() - age);
    const HOUR = OLD_STAGE_AGE_MS;
    /** `.aio-update-<n>a1b2c3d` holding `inside`, last written `age` ago
     *  (the files: `fileAge`). */
    const stage = async (
      n: number | string,
      o: { inside?: string[]; age: number; fileAge?: number },
    ) => {
      const dir = join(
        root,
        typeof n === "number" ? `.aio-update-${n}a1b2c3d` : n,
      );
      await Deno.mkdir(dir);
      for (const f of o.inside ?? ["artifact"]) {
        await Deno.writeTextFile(join(dir, f), "bytes");
        const t = at(o.fileAge ?? o.age);
        await Deno.utime(join(dir, f), t, t);
      }
      await Deno.utime(dir, at(o.age), at(o.age));
      return dir;
    };
    const yes = [
      await stage(0, { age: 2 * HOUR }),
      await stage(4, { inside: [], age: 2 * HOUR }), // cut off before the file
    ];
    const no = [
      await stage(1, { age: 0 }), // written a moment ago
      await stage(2, { inside: ["artifact", "notes"], age: 2 * HOUR }),
      await stage(5, { age: 2 * HOUR, fileAge: 0 }), // the file is fresh
      await stage(6, { age: 0, fileAge: 2 * HOUR }), // the folder is fresh
      await stage(".aio-update-notes", { age: 2 * HOUR }), // not the name
      // Its own digit: on a case-insensitive disk (macOS) `0A1B2C3D` IS
      // stage 0's folder.
      await stage(".aio-update-9A1B2C3D", { age: 2 * HOUR }),
    ];
    // `artifact` is a folder; the whole thing is a file; a link.
    const dirArtifact = join(root, ".aio-update-3a1b2c3d");
    await Deno.mkdir(join(dirArtifact, "artifact"), { recursive: true });
    await Deno.utime(join(dirArtifact, "artifact"), 0, 0);
    await Deno.utime(dirArtifact, 0, 0);
    const file = join(root, ".aio-update-7a1b2c3d");
    await Deno.writeTextFile(file, "x");
    await Deno.utime(file, 0, 0);
    no.push(dirArtifact, file);
    if (Deno.build.os !== "windows") {
      const link = join(root, ".aio-update-8a1b2c3d");
      await Deno.symlink(yes[0]!, link);
      // The link itself is old too: what refuses it is that it is a link.
      // `-t` with a local stamp: BSD touch has no `-d "3 hours ago"`.
      const t = at(3 * HOUR);
      const p2 = (n: number) => String(n).padStart(2, "0");
      await new Deno.Command("touch", {
        args: [
          "-h",
          "-t",
          `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}` +
          `${p2(t.getHours())}${p2(t.getMinutes())}`,
          link,
        ],
      })
        .output();
      assert(Deno.lstatSync(link).mtime!.getTime() < Date.now() - 2 * HOUR);
      no.push(link);
    }
    assertEquals(yes.map(abandonedOldStage), [true, true]);
    assertEquals(no.filter(abandonedOldStage), []);
    assert(no.length >= 8);
  } finally {
    await dropTempDir(root);
  }
});
