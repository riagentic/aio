// The legacy migration moves a journal WITH its `.wm` watermark side file.
//
// Builds from before the watermark moved into the store recorded it in
// `data.db.journal.wm`. The migration moved `data.db.journal` but left the
// `.wm` in the project dir, so the moved journal read as wholly unapplied and
// every action already in the snapshot was replayed a second time on boot
// (a bank balance of 300 came back as 600).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { appDirs } from "../src/server/app-dirs.ts";
import { migrateLegacyLayout } from "../src/server/app-dirs-migrate.ts";
import { createJournal } from "../src/server/journal.ts";

const exists = (p: string) => {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

Deno.test("migrate: the journal's .wm watermark travels with it — nothing already applied replays", async () => {
  const root = await Deno.makeTempDir({ prefix: "aio-migrate-wm-" });
  try {
    const cwd = join(root, "project");
    await Deno.mkdir(cwd, { recursive: true });
    await Deno.writeTextFile(join(cwd, "data.db"), "STATE");
    // three deposits, all already in the snapshot (watermark = 3)
    const lines = [1, 2, 3].map((seq) =>
      JSON.stringify({
        seq,
        type: "bank:deposit",
        payload: { args: [100] },
        ts: 1,
      })
    ).join("\n") + "\n";
    await Deno.writeTextFile(join(cwd, "data.db.journal"), lines);
    await Deno.writeTextFile(join(cwd, "data.db.journal.wm"), "3");
    const dirs = appDirs("bank", join(root, ".bank"));

    const r = migrateLegacyLayout({
      appId: `bank-migrate-wm-${crypto.randomUUID().slice(0, 8)}`,
      dirs,
      cwd,
      legacyXdgDir: join(root, "xdg"),
    });
    assertEquals(r.refused, undefined);
    assert(
      !exists(join(cwd, "data.db.journal.wm")),
      "the watermark must not be stranded in the old dir",
    );
    assertEquals(await Deno.readTextFile(dirs.journal + ".wm"), "3");
    assert(
      r.moves.some((m) =>
        m.to === dirs.journal + ".wm" && m.outcome === "moved"
      ),
      "the move is reported",
    );

    // The consequence that mattered: the moved journal has nothing to replay.
    const j = createJournal(dirs.journal);
    assertEquals(j.watermark(), 3);
    assertEquals(j.readSince(j.watermark()).length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
