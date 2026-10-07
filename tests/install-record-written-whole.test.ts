// `installed.json` is never there half-written.
//
// Both writers (the installer's `writeRecord`, the updater's
// `reconcileInstalledVersion`) truncated the record and then filled it. A
// reader in between got an empty or cut file, and every reader takes that for
// "no record": `am installed` drops the app, the next boot's check takes the
// install for one `am` does not manage — and a process killed in that instant
// left it so for good. Found on macOS, where a test reading the record while
// a boot corrected it got `Unexpected end of JSON input`.
//
// The record is replaced whole now (a temp beside it, renamed over it). Held
// here by watching the file's SIZE for the whole write: it is the old
// record's or the new one's, never anything between — with a record large
// enough that an in-place write takes many looks to finish.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  reconcileInstalledVersion,
  writeRecord,
} from "../src/server/install-record.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** Every size `path` had while `write` ran, the missing file as -1. */
async function sizesDuring(
  path: string,
  write: () => Promise<unknown>,
): Promise<Set<number>> {
  const seen = new Set<number>();
  const look = () => {
    try {
      seen.add(Deno.statSync(path).size);
    } catch {
      seen.add(-1);
    }
  };
  let done = false;
  const writing = write().finally(() => done = true);
  while (!done) {
    for (const until = performance.now() + 2; performance.now() < until;) {
      look();
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  await writing;
  look();
  return seen;
}

const BIG = "x".repeat(16 << 20);

Deno.test("installed.json: a version the updater puts on it replaces the record whole", async () => {
  const dir = await tempDir("aio-record-whole-");
  try {
    const path = join(dir, "installed.json");
    const before = JSON.stringify({
      name: "notes",
      version: "1.0.0",
      source: BIG,
    });
    await Deno.writeTextFile(path, before);
    const seen = await sizesDuring(
      path,
      async () =>
        assertEquals(
          await reconcileInstalledVersion(dir, { version: "2.0.0" }),
          true,
        ),
    );
    const after = await Deno.readTextFile(path);
    assertEquals(JSON.parse(after).version, "2.0.0");
    assertEquals(
      [...seen].filter((n) => n !== before.length && n !== after.length),
      [],
      "the record was seen cut short while it was being written",
    );
    assertEquals(
      [...Deno.readDirSync(dir)].map((e) => e.name),
      ["installed.json"],
      "the temp it was written through is gone",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("installed.json: an install over an install replaces the record whole", async () => {
  const apps = await tempDir("aio-record-whole-root-");
  const was = Deno.env.get("AIO_INSTALL_ROOT");
  Deno.env.set("AIO_INSTALL_ROOT", apps);
  try {
    const name = "record-whole";
    const path = await writeRecord({ name, version: "1.0.0", source: BIG });
    const before = Deno.statSync(path).size;
    const seen = await sizesDuring(
      path,
      () => writeRecord({ name, version: "1.0.10", source: BIG }),
    );
    const after = await Deno.readTextFile(path);
    assertEquals(JSON.parse(after).version, "1.0.10");
    assert(after.length !== before, "the two records differ in size");
    assertEquals(
      [...seen].filter((n) => n !== before && n !== after.length),
      [],
      "the record was seen cut short while it was being written",
    );
  } finally {
    if (was === undefined) Deno.env.delete("AIO_INSTALL_ROOT");
    else Deno.env.set("AIO_INSTALL_ROOT", was);
    await dropTempDir(apps);
  }
});

// Two writes of one record that overlap in a process shared one temp name
// (`.tmp-<pid>`, opened truncating): the second emptied what the first had
// filled, and the first renamed that into place — an EMPTY record, which
// every reader takes for none. A boot's un-awaited correction beside the
// updater's own write is that overlap.
Deno.test("installed.json: writes that overlap in one process each put a whole record", async () => {
  const dir = await tempDir("aio-record-overlap-");
  try {
    const path = join(dir, "installed.json");
    await Deno.writeTextFile(
      path,
      JSON.stringify({ name: "notes", version: "1.0.0", source: BIG }),
    );
    for (let round = 0; round < 5; round++) {
      const all = await Promise.all(
        Array.from(
          { length: 4 },
          (_, i) => reconcileInstalledVersion(dir, { version: `2.0.${i}` }),
        ),
      );
      assertEquals(all, [true, true, true, true], "a write was refused");
      const rec = JSON.parse(await Deno.readTextFile(path));
      assert(/^2\.0\.[0-3]$/.test(rec.version), `a cut record: ${rec.version}`);
      assertEquals(rec.source.length, BIG.length);
    }
    assertEquals(
      [...Deno.readDirSync(dir)].map((e) => e.name),
      ["installed.json"],
      "every temp is gone",
    );
  } finally {
    await dropTempDir(dir);
  }
});

// A writer killed between the temp and the rename left the temp for good.
Deno.test("installed.json: the next write removes a dead writer's temp, and no live one's", async () => {
  const dir = await tempDir("aio-record-sweep-");
  try {
    const path = join(dir, "installed.json");
    await Deno.writeTextFile(
      path,
      JSON.stringify({ name: "notes", version: "1.0.0" }),
    );
    // A pid that is certainly dead: a child that has exited.
    const child = new Deno.Command(Deno.execPath(), {
      args: ["eval", ""],
      stdout: "null",
      stderr: "null",
    }).spawn();
    const dead = child.pid;
    await child.status;
    const names = {
      deadOld: `installed.json.tmp-${dead}`, // the shape 1.0.19 wrote
      deadNew: `installed.json.tmp-${dead}-0a1b2c3d`,
      ownOld: `installed.json.tmp-${Deno.pid}`, // an earlier run's: reused pid
      ownNew: `installed.json.tmp-${Deno.pid}-0a1b2c3d`, // a write in flight
      live: `installed.json.tmp-${Deno.ppid}-0a1b2c3d`, // another live writer
      other: `installed.json.tmp-notes`, // not a temp of this writer's
    };
    for (const n of Object.values(names)) {
      await Deno.writeTextFile(join(dir, n), "{");
    }
    assertEquals(
      await reconcileInstalledVersion(dir, { version: "2.0.0" }),
      true,
    );
    assertEquals(
      [...Deno.readDirSync(dir)].map((e) => e.name).sort(),
      ["installed.json", names.ownNew, names.live, names.other].sort(),
    );
  } finally {
    await dropTempDir(dir);
  }
});
