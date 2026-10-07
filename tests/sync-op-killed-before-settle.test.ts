// A sync op's row is stored BEFORE its dispatch, and a refusal deletes it
// after. A server killed in between leaves the row of an op it refused (or
// never decided), and the next boot folded it as any other: the method's own
// guard threw, and the app REFUSED TO BOOT (dev) or quarantined the cell
// (prod) — after nothing but an unlucky kill. Seen as
// journal-upgrade-sweep's seed 2576 on a loaded Windows laptop.
//
// The kill is made deterministic here: the method kills the process from
// inside its own reduce — the row is stored, the server has not answered.
//
// What tells that row from an op that was accepted, acknowledged, and no
// longer folds (a changed method — that one MUST still refuse) is the row's
// `settled` mark (server-store.ts `settleOp`), written before anyone is told
// the op landed. An older build wrote no mark: its row is not removed, and
// the refusal says how to.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP = fromFileUrl(
  new URL("./fixtures/unsettled-op/app.js", import.meta.url),
);
const TREE = fromFileUrl(new URL("..", import.meta.url));

async function run(
  dir: string,
  phase: string,
  env: Record<string, string> = {},
  tree = TREE,
): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(tree, "deno.json"), APP],
    env: {
      ...env,
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      XDG_RUNTIME_DIR: dir,
      PHASE: phase,
      MOD: new URL(`file://${join(tree, "mod.ts")}`).href,
      AIO_NO_OPEN: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const log = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  assert(out.code !== 3, `the kill never came (${phase})\n${log}`);
  return log;
}

function sql<T>(dir: string, q: string): T[] {
  const d = new DatabaseSync(join(dir, "data", "state.db"));
  try {
    return d.prepare(q).all() as T[];
  } finally {
    d.close();
  }
}
const rows = (dir: string) =>
  sql<{ id: string; settled: number | null }>(
    dir,
    "SELECT id, settled FROM sync_ops ORDER BY server_ts",
  );
const recovered = async (dir: string, log: string): Promise<string[]> =>
  JSON.parse(
    await Deno.readTextFile(join(dir, "recovered.json")).catch(() => {
      throw new Error(`this build did not boot\n${log}`);
    }),
  );

for (const journal of ["0", "1"]) {
  for (const listen of ["0", "1"]) {
    const env = { JOURNAL: journal, LISTEN: listen };
    Deno.test(`sync op killed between its row and its refusal (journal ${journal}, listened ${listen}): the next boot removes it, by name, and boots`, async () => {
      const dir = await tempDir("aio-unsettled-");
      try {
        await run(dir, "kill-refused", env);
        // Premise: the kill left the refused op's row, unsettled, last.
        assertEquals(rows(dir), [
          { id: "op-1", settled: 1 },
          { id: "op-2", settled: 0 },
        ]);
        const log = await run(dir, "read", env);
        assertEquals(await recovered(dir, log), ["n1"], log);
        assertMatch(
          log,
          /"notes"'s op op-2 was persisted but not yet (settled|committed) when the server stopped, and its reduce is refused \(Error: dup n1\) — removed from the op-log and not acknowledged/,
        );
        assert(!/refusing to boot|QUARANTINED/.test(log), log);
        assertEquals(rows(dir), [{ id: "op-1", settled: 1 }]);
        // Said once: the second boot has nothing to say, and holds the same.
        const log2 = await run(dir, "read", env);
        assertEquals(await recovered(dir, log2), ["n1"], log2);
        assert(!/op-2|refusing to boot/.test(log2), log2);
      } finally {
        await dropTempDir(dir);
      }
    });
  }
}

Deno.test("sync op killed between its row and a `validate` refusal (no throw): removed at the next boot all the same", async () => {
  const dir = await tempDir("aio-unsettled-");
  try {
    await run(dir, "kill-invalid");
    assertEquals(rows(dir).at(-1), { id: "op-2", settled: 0 });
    const log = await run(dir, "read");
    assertEquals(await recovered(dir, log), ["n1"], log);
    assertMatch(log, /op op-2 was persisted but not yet settled[^\n]*no bad/);
    assertEquals(rows(dir), [{ id: "op-1", settled: 1 }]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("sync op killed between its row and its ACCEPTED dispatch: the next boot folds it and marks it settled", async () => {
  const dir = await tempDir("aio-unsettled-");
  try {
    await run(dir, "kill-accepted");
    assertEquals(rows(dir).at(-1), { id: "op-2", settled: 0 });
    const log = await run(dir, "read");
    assertEquals(await recovered(dir, log), ["n1", "n2"], log);
    assertEquals(rows(dir), [
      { id: "op-1", settled: 1 },
      { id: "op-2", settled: 1 },
    ]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("the same, journalled and listened to: the boot that reduces the in-flight op marks it settled", async () => {
  const dir = await tempDir("aio-unsettled-");
  const env = { JOURNAL: "1", LISTEN: "1" };
  try {
    await run(dir, "kill-accepted", env);
    assertEquals(rows(dir).at(-1), { id: "op-2", settled: 0 });
    const log = await run(dir, "read", env);
    assertEquals(await recovered(dir, log), ["n1", "n2"], log);
    assertMatch(log, /reduced 1 sync op the crash caught/);
    assertEquals(rows(dir), [
      { id: "op-1", settled: 1 },
      { id: "op-2", settled: 1 },
    ]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("an op accepted through a sync request's pending list (the reconnect door) is marked settled before its ack", async () => {
  const dir = await tempDir("aio-unsettled-");
  try {
    await run(dir, "acked", { PENDING: "1" });
    assertEquals(rows(dir), [{ id: "op-1", settled: 1 }]);
  } finally {
    await dropTempDir(dir);
  }
});

// Journal on, listened: the op's COMMIT is one journal line with its
// reactions, written before the mark. A kill between the two leaves the row
// unsettled and the journal saying it was reduced — its reactions are
// replayed from there. Removing the row (a build that now refuses it) would
// leave reactions to an op that is in no log: it is a failed fold instead.
Deno.test("an unsettled last row the journal holds the COMMIT of is never taken for in-flight: a refusal of it refuses the boot", async () => {
  const dir = await tempDir("aio-unsettled-");
  const env = { JOURNAL: "1", LISTEN: "1" };
  try {
    await run(dir, "acked", env);
    assertEquals(rows(dir), [{ id: "op-1", settled: 1 }]);
    // What a kill between the commit line and the mark leaves.
    sql(dir, "UPDATE sync_ops SET settled = 0 WHERE id = 'op-1'");
    const log = await run(dir, "read", { ...env, STRICT: "1" });
    assertMatch(
      log,
      /refusing to boot[^\n]*op op-1 \(notes:add\) threw: Error: strict n1/,
    );
    assertEquals(rows(dir), [{ id: "op-1", settled: 0 }], "nothing written");
    // The same build as wrote it: folded, and marked.
    const log2 = await run(dir, "read", env);
    assertEquals(await recovered(dir, log2), ["n1"], log2);
    assertEquals(rows(dir), [{ id: "op-1", settled: 1 }]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("a SETTLED op the method no longer accepts still refuses the boot — the last row too, after a kill", async () => {
  const dir = await tempDir("aio-unsettled-");
  try {
    await run(dir, "acked");
    assertEquals(rows(dir), [{ id: "op-1", settled: 1 }]);
    const log = await run(dir, "read", { STRICT: "1" });
    assertMatch(
      log,
      /refusing to boot — 1\/1 op could not be folded into "notes"[^\n]*op op-1 \(notes:add\) threw: Error: strict n1/,
    );
    // The remedy for an older build's row is not offered for a marked one.
    assert(!/DELETE FROM sync_ops/.test(log), log);
    assertMatch(log, /a method throws on an op it accepted/);
    assertEquals(rows(dir), [{ id: "op-1", settled: 1 }], "nothing written");
  } finally {
    await dropTempDir(dir);
  }
});

// The same kill under v1.0.9-beta, which marked nothing: no record tells its
// refused row from an accepted one, so this build removes nothing — and the
// refusal names the row and the one statement that removes it.
Deno.test("the same kill under v1.0.9: the row is unmarked, the boot refuses and says how to remove it — and boots once removed", async () => {
  const given = Deno.env.get("AIO_V109_TREE");
  const old = given ?? await tempDir("aio-old-tree-");
  const dir = await tempDir("aio-unsettled-");
  try {
    if (given === undefined) {
      const tar = join(old, "tree.tar");
      const a = await new Deno.Command("git", {
        args: ["-C", TREE, "archive", "--format=tar", "-o", tar, "v1.0.9-beta"],
        stderr: "piped",
      }).output();
      assert(a.success, new TextDecoder().decode(a.stderr));
      const x = await new Deno.Command("tar", {
        args: ["-xf", tar, "-C", old],
        stderr: "piped",
      }).output();
      assert(x.success, new TextDecoder().decode(x.stderr));
    }
    await run(dir, "kill-refused", {}, old);
    const log = await run(dir, "read");
    assertEquals(rows(dir), [
      { id: "op-1", settled: null },
      { id: "op-2", settled: null },
    ]);
    assertMatch(log, /refusing to boot[^\n]*op op-2 \(notes:add\) threw/);
    const remedy =
      /run `(DELETE FROM sync_ops WHERE id = 'op-2')` on its state\.db/
        .exec(log)?.[1];
    assert(remedy, log);
    sql(dir, remedy);
    const log2 = await run(dir, "read");
    assertEquals(await recovered(dir, log2), ["n1"], log2);
  } finally {
    await dropTempDir(dir);
    if (given === undefined) await dropTempDir(old);
  }
});
