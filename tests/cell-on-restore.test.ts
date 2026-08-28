// `onRestore` on a CELL — boot-time repair beside the state it repairs.
//
// Distinct from `onMigrate`, which answers "the SHAPE changed" and only runs
// on a version bump. This answers "some of what was persisted does not survive
// a restart", which is a property of the DATA, not of the version.
//
// The case that asked for it: a fix log persisted with undo handles that are
// CLOSURES. They restore as dead references, so the UI offers Undo buttons
// that cannot work. Without a cell-level hook the repair had to be called from
// the app entry's `onStart` — another file, away from the cell that owns it.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { cell } from "aio";
import { aio } from "aio";

/** Boot an app on a real SQLite file, run `fn`, shut down. */
async function boot(
  // deno-lint-ignore no-explicit-any
  c: any,
  dbPath: string,
  // deno-lint-ignore no-explicit-any
  fn: (app: any) => void | Promise<void>,
) {
  const app = await aio.run({
    appId: `restore-${crypto.randomUUID().slice(0, 8)}`,
    cells: [c],
    dbPath,
    client: "server-only",
    libraryMode: true,
    port: 0,
  });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

Deno.test({
  name: "onRestore repairs the restored slice, on every boot",
  async fn() {
    const dir = await Deno.makeTempDir();
    const dbPath = join(dir, "state.db");
    let restoreRuns = 0;
    const log = cell("fixlog", {
      state: {
        entries: [] as Array<{ id: number; undoable: boolean }>,
      },
      // The repair: an undo handle is a closure, so nothing that came back
      // from disk can still be undone. Say so, rather than offering a button
      // that throws.
      onRestore(s) {
        restoreRuns++;
        for (const e of s.entries) e.undoable = false;
      },
      methods: {
        record(s, id: number) {
          s.entries.push({ id, undoable: true });
        },
      },
    });

    await boot(log, dbPath, async () => {
      await log.record(1);
      await log.record(2);
      assertEquals(
        log.entries.map((e) => e.undoable),
        [true, true],
        "a fresh entry IS undoable — the hook must not touch live state",
      );
      // Nothing was restored on a first boot, so the hook has nothing to do.
      assertEquals(restoreRuns, 0);
    });

    await boot(log, dbPath, () => {
      assertEquals(restoreRuns, 1, "the hook ran once at boot");
      assertEquals(log.entries.length, 2, "the data itself is intact");
      assertEquals(
        log.entries.map((e) => e.undoable),
        [false, false],
        "…and every restored entry was repaired",
      );
    });

    await Deno.remove(dir, { recursive: true });
  },
});

Deno.test({
  name: "onRestore may RETURN a replacement slice",
  async fn() {
    const dir = await Deno.makeTempDir();
    const dbPath = join(dir, "state.db");
    const c = cell("replacer", {
      state: { n: 0, seen: false },
      onRestore(s) {
        return { ...s, seen: true };
      },
      methods: {
        bump(s) {
          s.n++;
        },
      },
    });
    await boot(c, dbPath, async () => {
      await c.bump();
    });
    await boot(c, dbPath, () => {
      assertEquals(c.n, 1);
      assertEquals(c.seen, true);
    });
    await Deno.remove(dir, { recursive: true });
  },
});

Deno.test({
  name: "a throwing onRestore is contained — the app still boots",
  async fn() {
    const dir = await Deno.makeTempDir();
    const dbPath = join(dir, "state.db");
    const c = cell("thrower", {
      state: { n: 0 },
      onRestore() {
        throw new Error("repair blew up");
      },
      methods: {
        bump(s) {
          s.n++;
        },
      },
    });
    await boot(c, dbPath, async () => {
      await c.bump();
    });
    // Losing the app because a cosmetic repair failed is the worse trade: the
    // slice keeps its RESTORED value and boot continues.
    await boot(c, dbPath, () => {
      assertEquals(c.n, 1);
    });
    await Deno.remove(dir, { recursive: true });
  },
});
