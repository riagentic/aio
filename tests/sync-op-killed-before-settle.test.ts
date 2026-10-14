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
import { fromFileUrl, join, resolve } from "@std/path";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { dropOpHow } from "../src/server/aio-boot.ts";
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
    // PROD: the boot quarantines where dev refuses (`isDevBoot`).
    args: [
      "run",
      "-A",
      "--config",
      join(tree, "deno.json"),
      APP,
      ...(env.PROD === "1" ? ["--prod"] : []),
    ],
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
    // The row is kept — and MARKED: the commit line is the proof it was
    // accepted, and that proof does not outlive a clean stop (below).
    assertEquals(rows(dir), [{ id: "op-1", settled: 1 }]);
    sql(dir, "UPDATE sync_ops SET settled = 0 WHERE id = 'op-1'");
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

/** A released tree, exported from its tag (or the directory `env` names). */
async function oldTree(
  tag: string,
  env: string,
): Promise<{ tree: string; drop: () => Promise<void> }> {
  const given = Deno.env.get(env);
  if (given !== undefined) return { tree: given, drop: async () => {} };
  const tree = await tempDir("aio-old-tree-");
  const tar = join(tree, "tree.tar");
  const a = await new Deno.Command("git", {
    args: ["-C", TREE, "archive", "--format=tar", "-o", tar, tag],
    stderr: "piped",
  }).output();
  assert(a.success, new TextDecoder().decode(a.stderr));
  const x = await new Deno.Command("tar", {
    args: ["-xf", tar, "-C", tree],
    stderr: "piped",
  }).output();
  assert(x.success, new TextDecoder().decode(x.stderr));
  return { tree, drop: () => dropTempDir(tree) };
}

// A rollback: this build leaves an unsettled last row, v1.0.18-beta (which
// knows no mark, and writes none) runs on the data, then this build again.
// Needs the `v1.0.18-beta` tag, or `AIO_V1018_TREE` naming an export of it.
Deno.test("rollback — this build → v1.0.18 → this build — over an unsettled last row: a refused one is still removed, an accepted one folds under both and is never removed", async () => {
  const old = await oldTree("v1.0.18-beta", "AIO_V1018_TREE");
  const refused = await tempDir("aio-unsettled-");
  const accepted = await tempDir("aio-unsettled-");
  try {
    // Refused: v1.0.18 cannot boot over the row (the defect 1.0.19 fixed) —
    // and leaves it as it found it; this build then removes it.
    await run(refused, "kill-refused");
    const o1 = await run(refused, "read", {}, old.tree);
    assertMatch(o1, /refusing to boot[^\n]*op op-2 \(notes:add\) threw/);
    assertEquals(rows(refused).at(-1), { id: "op-2", settled: 0 });
    const log = await run(refused, "read");
    assertEquals(await recovered(refused, log), ["n1"], log);
    assertEquals(rows(refused), [{ id: "op-1", settled: 1 }]);

    // Accepted: v1.0.18 folds it, serves it, and takes an op after it —
    // unmarked (NULL). The 0 row is no longer last: folded as any other.
    await run(accepted, "kill-accepted");
    await run(accepted, "acked", { NBASE: "2", FIRST: "n3" }, old.tree);
    assertEquals(rows(accepted), [
      { id: "op-1", settled: 1 },
      { id: "op-2", settled: 0 },
      { id: "op-3", settled: null },
    ]);
    const log2 = await run(accepted, "read");
    assertEquals(await recovered(accepted, log2), ["n1", "n2", "n3"], log2);
    assert(!/removed from the op-log/.test(log2), log2);
    assertEquals(rows(accepted).length, 3);
    // …and this build's next op lands after them, marked.
    await run(accepted, "acked", { NBASE: "3", FIRST: "n4" });
    assertEquals(rows(accepted).at(-1), { id: "op-4", settled: 1 });
    const log3 = await run(accepted, "read");
    assertEquals(
      await recovered(accepted, log3),
      ["n1", "n2", "n3", "n4"],
      log3,
    );
  } finally {
    await dropTempDir(refused);
    await dropTempDir(accepted);
    await old.drop();
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
    // The same repair for a machine with no `sqlite3`: the line as printed,
    // run as printed (a shell splits it into exactly these arguments).
    const line = /`deno eval "([^"]+)" "([^"]+)" "([^"]+)"`/.exec(log);
    assert(line, log);
    assertEquals(line[2], join(dir, "data", "state.db"));
    assertEquals(line[3], remedy);
    const ran = await new Deno.Command(Deno.execPath(), {
      args: ["eval", line[1]!, line[2]!, line[3]!],
      stderr: "piped",
    }).output();
    assert(ran.success, new TextDecoder().decode(ran.stderr));
    assertEquals(rows(dir), [{ id: "op-1", settled: null }]);
    const log2 = await run(dir, "read");
    assertEquals(await recovered(dir, log2), ["n1"], log2);
  } finally {
    await dropTempDir(dir);
    if (given === undefined) await dropTempDir(old);
  }
});

Deno.test("the by-hand repair names the file; the Deno line is offered only where one line is valid in every shell", () => {
  const stmt = `"DELETE FROM sync_ops WHERE id = 'o''1'"\``;
  // (resolved: on Windows `/srv/…` is `C:\\srv\\…`, and that is the file)
  const db = resolve("/srv/my app/data/state.db");
  const how = dropOpHow(db, "o'1");
  assert(how.includes(` "${db}" ${stmt}`), how);
  assertEquals(dropOpHow(undefined, "o1"), "");
  assertEquals(dropOpHow(":memory:", "o1"), "");
  // A `$` (sh, PowerShell), a `%` (cmd), a quote: the file is named, the
  // statement stays the one in the message.
  for (const [file, id] of [["/a/$HOME/state.db", "o1"], ["/a/s.db", 'o"1']]) {
    assertEquals(dropOpHow(file, id!), ` The file: ${resolve(file!)}`);
  }
});

/** Cut the journal after op `id`'s INTENT line: what a power cut that lost
 *  the (not yet synced) lines after it leaves — its COMMIT among them. */
function cutJournalAfterIntent(dir: string, id: string): void {
  const path = join(dir, "data", "journal");
  const lines = Deno.readTextFileSync(path).split("\n").filter(Boolean);
  const at = lines.findIndex((l) =>
    l.includes('"__aioSyncIntent"') && l.includes(`"id":"${id}"`)
  );
  assert(at >= 0, `no intent of ${id} in the journal:\n${lines.join("\n")}`);
  assert(
    lines.slice(at + 1).some((l) => l.includes('"__aioSyncApplied"')),
    `premise: ${id}'s commit follows its intent:\n${lines.join("\n")}`,
  );
  Deno.writeTextFileSync(path, lines.slice(0, at + 1).join("\n") + "\n");
}

// The op was accepted, journalled, marked, acknowledged and broadcast — and
// then the journal lost the COMMIT line and kept the INTENT. To the journal
// alone that is an op caught in flight, and a build whose method refuses it
// removed the row: "not acknowledged", while its author and every peer hold
// it. The row's mark says otherwise, and the mark wins.
for (const prod of ["0", "1"]) {
  Deno.test(
    `an ACKNOWLEDGED op whose commit line the journal lost is never removed as in flight (${
      prod === "1" ? "prod: the cell is quarantined" : "dev: the boot refuses"
    })`,
    async () => {
      const dir = await tempDir("aio-unsettled-");
      const env = { JOURNAL: "1", LISTEN: "1", PROD: prod };
      try {
        await run(dir, "acked", env);
        assertEquals(rows(dir), [{ id: "op-1", settled: 1 }]);
        cutJournalAfterIntent(dir, "op-1");
        const log = await run(dir, "read", { ...env, STRICT: "1" });
        assert(!/removed from the op-log/.test(log), log);
        assertEquals(rows(dir), [{ id: "op-1", settled: 1 }], log);
        assertMatch(
          log,
          prod === "1"
            ? /cell "notes" QUARANTINED[^\n]*op op-1 \(notes:add\) threw: Error: strict n1/
            : /refusing to boot[^\n]*op op-1 \(notes:add\) threw: Error: strict n1/,
        );
        // Its listener is NAMED (the reaction's line went with the commit),
        // never re-derived.
        assertMatch(
          log,
          /cannot tell whether "tally" holds its listensTo reactions to 1 "notes" op/,
        );
        // The build that accepted it: folded.
        const log2 = await run(dir, "read", env);
        assertEquals(await recovered(dir, log2), ["n1"], log2);
        assertEquals(rows(dir), [{ id: "op-1", settled: 1 }]);
      } finally {
        await dropTempDir(dir);
      }
    },
  );
}

// Every refusal above ran in dev, where a row that does not fold refuses
// the boot. In production the same decider quarantines — and the unsettled
// row is still removed, the settled one still kept.
Deno.test("production: an unsettled refused row is removed and the app serves; a SETTLED one the method now refuses quarantines the cell and stays", async () => {
  const dir = await tempDir("aio-unsettled-");
  const env = { PROD: "1" };
  try {
    await run(dir, "kill-refused", env);
    assertEquals(rows(dir).at(-1), { id: "op-2", settled: 0 });
    const log = await run(dir, "read", env);
    assertEquals(await recovered(dir, log), ["n1"], log);
    assertMatch(log, /op op-2 was persisted but not yet settled[^\n]*removed/);
    assert(!/QUARANTINED/.test(log), log);
    assertEquals(rows(dir), [{ id: "op-1", settled: 1 }]);
    const log2 = await run(dir, "read", { ...env, STRICT: "1" });
    assertMatch(log2, /cell "notes" QUARANTINED[^\n]*op op-1 \(notes:add\)/);
    // Quarantined at its defaults — and serving.
    assertEquals(await recovered(dir, log2), [], log2);
    assertEquals(rows(dir), [{ id: "op-1", settled: 1 }], "nothing written");
  } finally {
    await dropTempDir(dir);
  }
});

// A kill between the commit line and the mark (row 0, commit in the journal)
// → a production boot whose method refuses the op quarantines the cell —
// and that boot runs with the journal OFF, so it moves the journal aside,
// the commit line with it → the next boot read "unsettled last row, no
// commit" as in flight and REMOVED an accepted op. The boot that reads the
// commit writes the mark it proves.
Deno.test("an accepted op whose mark a kill took is still there two boots later — the commit line going away does not make it 'in flight'", async () => {
  const dir = await tempDir("aio-unsettled-");
  const env = { LISTEN: "1", PROD: "1" };
  try {
    await run(dir, "acked", { ...env, JOURNAL: "1" });
    sql(dir, "UPDATE sync_ops SET settled = 0 WHERE id = 'op-1'");
    const log = await run(dir, "read", { ...env, STRICT: "1" });
    assertMatch(log, /cell "notes" QUARANTINED/);
    assertEquals(rows(dir), [{ id: "op-1", settled: 1 }], log);
    // Premise: that boot took the commit line away.
    const journal = await Deno.readTextFile(join(dir, "data", "journal"))
      .catch(() => "");
    assert(!journal.includes("__aioSyncApplied"), journal);
    const log2 = await run(dir, "read", { ...env, STRICT: "1" });
    assert(!/removed from the op-log/.test(log2), log2);
    assertMatch(log2, /cell "notes" QUARANTINED/);
    assertEquals(rows(dir), [{ id: "op-1", settled: 1 }]);
    // The method fixed: the op is back.
    const log3 = await run(dir, "read", env);
    assertEquals(await recovered(dir, log3), ["n1"], log3);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("a reconnect's pending list killed mid-list: the ops before the kill are settled, the one in flight is removed, the rest were never stored", async () => {
  const dir = await tempDir("aio-unsettled-");
  try {
    await run(dir, "kill-pending-list");
    assertEquals(rows(dir), [
      { id: "op-1", settled: 1 },
      { id: "op-2", settled: 1 },
      { id: "op-3", settled: 0 },
    ]);
    const log = await run(dir, "read");
    assertEquals(await recovered(dir, log), ["n1", "n2"], log);
    assertMatch(log, /op op-3 was persisted but not yet settled[^\n]*dup n1/);
    assertEquals(rows(dir), [
      { id: "op-1", settled: 1 },
      { id: "op-2", settled: 1 },
    ]);
  } finally {
    await dropTempDir(dir);
  }
});
