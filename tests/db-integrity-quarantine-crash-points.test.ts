// Quarantine moves a damaged database AND its `-wal`/`-shm` — three renames,
// and a process can die between any two of them.
//
// They were moved sidecars FIRST: a death after the `-wal` moved and before
// the database did left `state.db` at the live path WITHOUT its WAL — every
// frame committed since the last checkpoint gone from it, and the WAL parked
// beside a quarantine copy that does not exist. The next boot opened the
// WAL-less file as if it were whole.
//
// Every crash point is injected here: the Nth rename never returns (the
// process "died" there), the next boot runs exactly what boot runs before it
// opens the database, and the damaged set must be whole in ONE place — the
// live path or the quarantine — never split.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { DB } from "../src/db/types.ts";
import {
  checkAndRecover,
  finishInterruptedRestore,
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

/** Where each byte of the damaged set is, by content. */
async function locate(dir: string): Promise<Map<string, string[]>> {
  const at = new Map<string, string[]>();
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile) continue;
    const text = await read(join(dir, e.name));
    if (text === null) continue;
    const list = at.get(text) ?? [];
    list.push(e.name);
    at.set(text, list);
  }
  return at;
}

async function seed(dir: string, withSnapshot: boolean) {
  const dbPath = join(dir, "state.db");
  await Deno.writeTextFile(dbPath, "DAMAGED");
  await Deno.writeTextFile(dbPath + "-wal", "WAL");
  await Deno.writeTextFile(dbPath + "-shm", "SHM");
  if (withSnapshot) await Deno.writeTextFile(snapshotPathFor(dbPath), "SNAP");
  return dbPath;
}

/** Run the recovery until its `n`th rename, which never returns. Resolves
 *  true when the crash point was reached, false when the recovery finished
 *  with fewer renames. */
async function crashAt(dbPath: string, n: number): Promise<boolean> {
  let renames = 0;
  let reached!: () => void;
  const hung = new Promise<void>((r) => (reached = r));
  const run = checkAndRecover({
    db: damaged(),
    dbPath,
    log: quiet,
    checkSnapshot: () => Promise.resolve(null),
    fs: {
      rename: (a, b) => {
        if (++renames === n) {
          reached();
          return new Promise<void>(() => {}); // the process died here
        }
        return Deno.rename(a, b);
      },
      copyFile: (a, b) => Deno.copyFile(a, b),
      stat: async (p) => ({ size: (await Deno.stat(p)).size }),
      remove: (p) => Deno.remove(p),
      sync: () => Promise.resolve(),
    },
  }).then(() => false, () => false);
  return await Promise.race([hung.then(() => true), run]);
}

for (const withSnapshot of [true, false]) {
  Deno.test(
    `quarantine: a death at ANY rename never splits the damaged database from its WAL (${
      withSnapshot ? "snapshot" : "no snapshot"
    })`,
    async () => {
      for (let n = 1;; n++) {
        const dir = await tempDir(`aio-quarantine-crash-${n}-`);
        try {
          const dbPath = await seed(dir, withSnapshot);
          const crashed = await crashAt(dbPath, n);
          if (!crashed) break; // past the last rename: every point was covered
          // The next boot, up to the open.
          await finishInterruptedRestore({ dbPath, log: quiet });
          const at = await locate(dir);
          const db = at.get("DAMAGED") ?? [];
          assertEquals(db.length, 1, `crash at rename ${n}: ${[...at]}`);
          assertEquals(
            at.get("WAL"),
            [`${db[0]}-wal`],
            `crash at rename ${n}: the WAL must sit beside its database — ${[
              ...at,
            ]}`,
          );
          assertEquals(at.get("SHM"), [`${db[0]}-shm`], `crash at rename ${n}`);
          const live = await read(dbPath);
          if (db[0] !== "state.db") {
            // Moved aside: the live path is the snapshot (or nothing), and no
            // stray sidecar of the damaged file is left to be replayed there.
            assert(
              live === null || live === "SNAP",
              `crash at rename ${n}: live is ${live}`,
            );
            assertEquals(await read(dbPath + "-wal"), null);
          }
        } finally {
          await dropTempDir(dir);
        }
      }
    },
  );
}
