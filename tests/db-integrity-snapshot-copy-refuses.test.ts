// A VERIFIED snapshot whose copy fails (a full disk) used to fall through to
// "starting EMPTY" — beside the snapshot it had just verified, with the
// damaged database moved aside, and the app's first rolling db.snapshot()
// then wrote the empty state over the good one. Nothing has moved at that
// point, so the boot is refused instead, and the next one redoes the recovery.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DB } from "../src/db/types.ts";
import {
  checkAndRecover,
  restoringPathFor,
  snapshotPathFor,
} from "../src/server/db-integrity.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const quiet = { info() {}, warn() {}, error() {} };
const damaged = () =>
  ({
    checkIntegrity: () =>
      Promise.resolve({ ok: false, problems: ["page 3: torn"] }),
    close: () => Promise.resolve(),
  }) as unknown as DB;
const read = (p: string) => Deno.readTextFile(p).catch(() => null);

async function seed(dir: string) {
  const dbPath = join(dir, "state.db");
  await Deno.writeTextFile(dbPath, "DAMAGED");
  await Deno.writeTextFile(dbPath + "-wal", "WAL");
  await Deno.writeTextFile(snapshotPathFor(dbPath), "SNAP");
  return dbPath;
}

async function names(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) out.push(e.name);
  return out;
}

Deno.test("checkAndRecover: a verified snapshot that cannot be COPIED refuses the boot — nothing moved, nothing lost", async () => {
  const dir = await tempDir("aio-quarantine-copy-fails-");
  try {
    const dbPath = await seed(dir);
    const err = await assertRejects(() =>
      checkAndRecover({
        db: damaged(),
        dbPath,
        log: quiet,
        checkSnapshot: () => Promise.resolve(null),
        fs: {
          rename: (a, b) => Deno.rename(a, b),
          copyFile: () =>
            Promise.reject(new Error("No space left on device (injected)")),
          stat: async (p) => ({ size: (await Deno.stat(p)).size }),
          remove: (p) => Deno.remove(p),
        },
      })
    );
    assert(String(err).includes("No space left"), String(err));
    assertEquals(
      await read(dbPath),
      "DAMAGED",
      "the damaged file is not moved",
    );
    assertEquals(await read(dbPath + "-wal"), "WAL");
    assertEquals(await read(snapshotPathFor(dbPath)), "SNAP");
    assertEquals(await read(restoringPathFor(dbPath)), null);
    const left = await names(dir);
    assert(
      !left.some((n) => n.includes(".corrupt-")),
      `nothing quarantined: ${left}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});
