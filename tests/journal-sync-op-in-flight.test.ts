// A sync op is persisted to the op-log BEFORE it is reduced (both under its
// cell's lock). A SIGKILL in between left an op that boot replayed into its
// own cell while its listeners' reactions happened nowhere — and the
// client's resend is deduped, so they never happened: `notes` held the op,
// `tally` and `mirror` did not, nothing said (re-verify of the legacy
// redesign: 4 of 35 random crash runs). Every reduced op on a listened
// action is now marked in the journal, in the same write as its reaction
// lines, and boot reduces an unmarked last op whole, once.
//
// The window is microseconds wide, so it is built here: a run of this build
// stops cleanly, and the op-log then gets the row the persist wrote before a
// kill took the reduce (the random sweep over real kills is
// tests/journal-crash-sweep.test.ts).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parseJournal } from "../src/server/journal.ts";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP = new URL("./fixtures/v1.0.9-sweep/app.js", import.meta.url)
  .pathname;
const TREE = new URL("..", import.meta.url).pathname;

type Snap = {
  notes: string[];
  tally: number;
  mirror: string[];
  shaped: number;
};

async function run(
  dir: string,
  phase: string,
  env: Record<string, string> = {},
): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(TREE, "deno.json"), APP],
    env: {
      ...env,
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      XDG_RUNTIME_DIR: dir,
      PHASE: phase,
      MOD: new URL(`file://${join(TREE, "mod.ts")}`).href,
      AIO_NO_OPEN: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
}
const readSnap = async (f: string): Promise<Snap> =>
  JSON.parse(await Deno.readTextFile(f));

/** What `persistOp` wrote for an op whose reduce (or commit) a kill then
 *  took: the op's intent line in the journal (journal.ts J3), then its row.
 *  `intent: false` — the row alone, as a run that journals no intents (an
 *  older build, or the journal off) leaves it. */
function persistedNotReduced(
  dir: string,
  id: string,
  text: string,
  { intent = true, savedAfter = false, intentId = id } = {},
): void {
  const d = new DatabaseSync(join(dir, "data", "state.db"));
  try {
    const { m } = d.prepare(
      "SELECT MAX(v) AS m FROM (SELECT MAX(server_ts) AS v FROM sync_ops " +
        "UNION ALL SELECT MAX(compacted_ts) FROM sync_meta)",
    ).get() as { m: number };
    const ts = m + 1;
    if (intent) {
      const path = join(dir, "data", "journal");
      let text = "";
      try {
        text = Deno.readTextFileSync(path);
      } catch { /* compacted away: no file */ }
      let seq = 0;
      try {
        const b = JSON.parse(Deno.readTextFileSync(path + ".base"));
        seq = Math.max(
          b.wm,
          ...Object.values(b.cells as Record<string, number>),
        );
      } catch { /* no base */ }
      for (const m of text.matchAll(/"seq":(\d+)/g)) {
        seq = Math.max(seq, Number(m[1]));
      }
      // `savedAfter`: the store's last save is at or past the intent — a
      // save between the op's persist and the kill.
      let wm = 0;
      try {
        wm = JSON.parse(Deno.readTextFileSync(path + ".base")).wm;
      } catch { /* no base */ }
      Deno.writeTextFileSync(
        path,
        JSON.stringify({
          seq: savedAfter ? wm : seq + 1,
          fmt: 2,
          type: "__aioSyncIntent",
          payload: { cell: "notes", id: intentId, ts },
          ts: Date.now(),
          only: ["notes"],
        }) + "\n",
        { append: true, mode: 0o600 },
      );
    }
    d.prepare(
      `INSERT INTO sync_ops (id, cell, action, payload, hlc_phys, hlc_cnt, hlc_node, server_ts, version)
         VALUES (?, 'notes', 'add', ?, ?, 0, 'c1', ?, 1)`,
    ).run(id, JSON.stringify({ args: [text] }), ts, ts);
  } finally {
    d.close();
  }
}
const rows = (dir: string, id: string): number => {
  const d = new DatabaseSync(join(dir, "data", "state.db"));
  try {
    return (d.prepare("SELECT COUNT(*) AS n FROM sync_ops WHERE id = ?").get(
      id,
    ) as { n: number }).n;
  } finally {
    d.close();
  }
};

Deno.test("sync op in flight at a kill: persisted, never reduced — boot reduces it whole, once, listeners included", async () => {
  const dir = await tempDir("aio-op-in-flight-");
  try {
    await run(dir, "before-fold", { CLEAN: "1" });
    const live = await readSnap(join(dir, "expected.json"));
    // The live run journalled each listened op's intent and its commit.
    const lines = parseJournal(
      await Deno.readTextFile(join(dir, "data", "journal")),
      { quiet: true },
    );
    const ids = (t: string) =>
      lines.filter((e) => e.type === t).map((e) =>
        (e.payload as { id: string }).id
      ).sort();
    assert(ids("__aioSyncApplied").length > 0, "commits written");
    assertEquals(ids("__aioSyncIntent"), ids("__aioSyncApplied"));
    persistedNotReduced(dir, "op-late", "late");
    const log = await run(dir, "read");
    const got = await readSnap(join(dir, "recovered.json"));
    assertEquals(got.notes, [...live.notes, "late"], log);
    assertEquals(got.tally, live.tally + 1, `tally takes it once\n${log}`);
    assertEquals(got.shaped, live.shaped + 1, log);
    assertEquals(got.mirror.filter((x) => x === "late"), ["late"], log);
    assert(/reduced 1 sync op the crash caught/.test(log), log);
    // Marked now: the next boot restores it as any reduced op, once.
    const again = await run(dir, "read");
    assertEquals(await readSnap(join(dir, "recovered.json")), got, again);
    assert(!/the crash caught/.test(again), again);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("sync op in flight at a kill, the store saved after its persist: its reaction there is held and named, never applied on a guess", async () => {
  const dir = await tempDir("aio-op-in-flight-saved-");
  try {
    await run(dir, "before-fold", { CLEAN: "1" });
    const live = await readSnap(join(dir, "expected.json"));
    persistedNotReduced(dir, "op-late", "late", { savedAfter: true });
    const log = await run(dir, "read");
    const got = await readSnap(join(dir, "recovered.json"));
    assertEquals(got.notes, [...live.notes, "late"], log);
    // The store may hold it: held (the save came after the persist).
    assertEquals(got.tally, live.tally, log);
    assertEquals(got.shaped, live.shaped, log);
    assert(
      /"tally": 1 listensTo reaction of the sync op a crash caught/.test(log),
      log,
    );
    // `mirror`'s fold predates the op: certainly not in it — applied.
    assertEquals(got.mirror.filter((x) => x === "late"), ["late"], log);
    const again = await run(dir, "read");
    assertEquals(await readSnap(join(dir, "recovered.json")), got, again);
    assert(!/crash caught/.test(again), again);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("sync op in flight at a kill whose reduce throws: refused and removed, as the live server does — never replayed into its cell", async () => {
  const dir = await tempDir("aio-op-in-flight-refused-");
  try {
    await run(dir, "before-fold", { CLEAN: "1" });
    const live = await readSnap(join(dir, "expected.json"));
    // `notes:add` throws on a duplicate (the app's idempotency guard).
    persistedNotReduced(dir, "op-dup", live.notes[0]!);
    const log = await run(dir, "read");
    const got = await readSnap(join(dir, "recovered.json"));
    assertEquals(
      [got.notes, got.tally, got.shaped],
      [live.notes, live.tally, live.shaped],
      log,
    );
    assert(/removed from the op-log and not acknowledged/.test(log), log);
    assertEquals(rows(dir, "op-dup"), 0);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("an op-log this build ran with persist off is stamped too — turning persist on is not an upgrade from an older build", async () => {
  const dir = await tempDir("aio-stamp-persist-off-");
  try {
    // (`journal: true` needs the store: off with it.)
    await run(dir, "before-fold", { CLEAN: "1", PERSIST: "0", JOURNAL: "0" });
    const live = await readSnap(join(dir, "expected.json"));
    const log = await run(dir, "read");
    assert(/sync: restored cell "notes"/.test(log), log);
    assert(!/this data was last run by an older aio build/.test(log), log);
    // That run journalled no op and SAVED nothing: no op of it is reduced
    // again (the app's guard would refuse a second add), and a stop with no
    // store save vouches for nothing — every listener is named.
    const got = await readSnap(join(dir, "recovered.json"));
    assertEquals(got.notes, live.notes, log);
    assert(!/the crash caught|not acknowledged/.test(log), log);
    for (const k of ["tally", "mirror", "shaped"]) {
      assert(
        new RegExp(`cannot tell whether "${k}" holds its listensTo`).test(log),
        `${k}\n${log}`,
      );
    }
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("a journal lost with the op-log kept proves nothing — no op is reduced again, and every listener is named (jl1)", async () => {
  const dir = await tempDir("aio-op-journal-lost-");
  try {
    // A kill, so the store holds nothing the journal did not: the one op's
    // reactions were in the journal alone.
    await run(dir, "synconly", { K: "1", KILLAT: "1" });
    const live = await readSnap(join(dir, "expected.json"));
    assertEquals(live.notes.length, 1);
    // A power cut before the journal reached the disk, a data dir restored
    // without it, a hand that deleted it: the op row stays.
    await Deno.remove(join(dir, "data", "journal"));
    const log = await run(dir, "read");
    const got = await readSnap(join(dir, "recovered.json"));
    assertEquals(got.notes, live.notes, log);
    assert(got.tally <= live.tally, `never counted twice\n${log}`);
    assert(got.mirror.length <= live.mirror.length, log);
    assert(!/the crash caught/.test(log), log);
    for (const k of ["tally", "mirror", "shaped"]) {
      assert(
        new RegExp(
          `cannot tell whether "${k}" holds its listensTo reactions to 1 "notes" op `,
        ).test(log),
        `${k} named\n${log}`,
      );
    }
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("an intent names its op by id AND value — an older build's op at a value this build issued (then refused) is never read as in flight", async () => {
  const dir = await tempDir("aio-op-intent-other-id-");
  try {
    await run(dir, "before-fold", { CLEAN: "1" });
    const live = await readSnap(join(dir, "expected.json"));
    // This build issued the value to an op it then refused (row deleted,
    // intent kept); 1.0.9 — which issues from the rows alone — gave the same
    // value to its own op, and reduced it, reactions and all.
    persistedNotReduced(dir, "op-foreign", "foreign", {
      intentId: "op-refused",
    });
    const log = await run(dir, "read");
    const got = await readSnap(join(dir, "recovered.json"));
    assertEquals(got.tally, live.tally, `never re-derived\n${log}`);
    assert(!/the crash caught/.test(log), log);
    assert(
      /cannot tell whether "tally" holds its listensTo reactions to 1 "notes" op /
        .test(log),
      log,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("an op row with no intent is never read as in flight — whatever the journal's other lines say", async () => {
  const dir = await tempDir("aio-op-no-intent-");
  try {
    await run(dir, "before-fold", { CLEAN: "1" });
    const live = await readSnap(join(dir, "expected.json"));
    // What an older build (or this one, journal off) leaves after a run of
    // this build: a row whose reduce it did — reactions and all — with no
    // record of either in the journal.
    persistedNotReduced(dir, "op-foreign", "foreign", { intent: false });
    const log = await run(dir, "read");
    const got = await readSnap(join(dir, "recovered.json"));
    assertEquals(got.notes, [...live.notes, "foreign"], log);
    assertEquals(got.tally, live.tally, `never re-derived\n${log}`);
    assert(!/the crash caught/.test(log), log);
    assert(
      /cannot tell whether "tally" holds its listensTo reactions to 1 "notes" op /
        .test(log),
      log,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("journal off, then on: after a clean stop nothing is named; after a kill, 'cannot tell' — never a re-reduce", async () => {
  for (const clean of [true, false]) {
    const dir = await tempDir("aio-op-journal-on-");
    try {
      await run(dir, "synconly", {
        JOURNAL: "0",
        K: "3",
        ...(clean ? { CLEAN: "1" } : {}),
      });
      const live = await readSnap(join(dir, "expected.json"));
      assertEquals(live.notes.length, 3);
      const log = await run(dir, "read");
      const got = await readSnap(join(dir, "recovered.json"));
      assertEquals(got.notes, live.notes, log);
      assert(got.tally <= live.tally, log);
      assert(!/the crash caught|not acknowledged/.test(log), log);
      // Every op the clean run issued is vouched for — its last one too.
      if (clean) assert(!/cannot tell/.test(log), log);
      else {
        assert(
          /cannot tell whether "tally" holds its listensTo reactions to 3 "notes" ops/
            .test(log),
          log,
        );
      }
      // Placed once: the next boot says nothing either way.
      const again = await run(dir, "read");
      assert(!/cannot tell/.test(again), again);
    } finally {
      await dropTempDir(dir);
    }
  }
});

Deno.test("journal off, then on: a stop whose sync listener's fold failed is not clean — named, not trusted", async () => {
  // A failed fold is not retried until the cell is written again, so the
  // listener's snapshot lacks its reactions: the SIGTERM exit is not a clean
  // stop and must not be recorded as one (server-handler.ts `_foldFailed`).
  // The fold fails at the shutdown flush (0), or earlier with nothing left
  // pending when the stop comes (800 ms: past the debounce).
  for (const killAt of ["0", "800"]) {
    const dir = await tempDir("aio-op-fold-fault-");
    try {
      const first = await run(dir, "synconly", {
        JOURNAL: "0",
        K: "3",
        CLEAN: "1",
        FOLDFAULT: "1",
        KILLAT: killAt,
      });
      assert(/fold fault/.test(first), first);
      const d = new DatabaseSync(join(dir, "data", "state.db"));
      try {
        d.exec(
          "DROP TRIGGER fold_fault_INSERT; DROP TRIGGER fold_fault_UPDATE",
        );
      } finally {
        d.close();
      }
      const log = await run(dir, "read");
      assert(
        /cannot tell whether "mirror" holds its listensTo reactions to 3 "notes" ops/
          .test(log),
        `killAt=${killAt}\n${log}`,
      );
    } finally {
      await dropTempDir(dir);
    }
  }
});

Deno.test("a clean stop vouches for the ops ITS run issued — not for ones an earlier crash left, and across clean runs in a row", async () => {
  for (const firstStop of ["kill", "clean"]) {
    const dir = await tempDir("aio-op-clean-range-");
    try {
      // Three ops by a journal-off run, then a second journal-off run that
      // issues none and stops cleanly.
      await run(dir, "synconly", {
        JOURNAL: "0",
        K: "3",
        ...(firstStop === "clean" ? { CLEAN: "1" } : { KILLAT: "1" }),
      });
      await run(dir, "synconly", { JOURNAL: "0", K: "0", CLEAN: "1" });
      const log = await run(dir, "read");
      const named =
        /cannot tell whether "tally" holds its listensTo reactions to 3 "notes" ops/
          .test(log);
      // Killed: the second run's clean stop says nothing about them. Clean
      // twice: the range carries over, nothing is named.
      assertEquals(named, firstStop === "kill", `${firstStop}\n${log}`);
      if (firstStop === "clean") assert(!/cannot tell/.test(log), log);
    } finally {
      await dropTempDir(dir);
    }
  }
});

Deno.test("journal off, then on: a stop whose FINAL store save was refused is not clean — named", async () => {
  // The marker says "the store saved" — a refused last save means the store
  // lacks what the run did since its previous save (server/aio.ts shutdown).
  const dir = await tempDir("aio-op-persist-fault-");
  try {
    const first = await run(dir, "synconly", {
      JOURNAL: "0",
      K: "3",
      CLEAN: "1",
      PERSISTFAULT: "1",
    });
    assert(/the FINAL persist was refused/.test(first), first);
    const d = new DatabaseSync(join(dir, "data", "state.db"));
    try {
      d.exec(
        "DROP TRIGGER persist_fault_INSERT; DROP TRIGGER persist_fault_UPDATE",
      );
    } finally {
      d.close();
    }
    const log = await run(dir, "read");
    assert(
      /cannot tell whether "tally" holds its listensTo reactions to 3 "notes" ops/
        .test(log),
      log,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("a reduced op's mark and its reaction lines land in ONE journal write — a kill cannot take one without the other", async () => {
  const dir = await tempDir("aio-op-atomic-");
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        join(TREE, "deno.json"),
        new URL("./fixtures/crash-sweep/app.js", import.meta.url).pathname,
      ],
      env: {
        DIR: dir,
        PORT: String(freePort()),
        AIO_APPS_DIR: dir,
        XDG_RUNTIME_DIR: dir,
        PHASE: "x",
        MOD: new URL(`file://${join(TREE, "mod.ts")}`).href,
        AIO_NO_OPEN: "1",
        CHECKATOMIC: "1",
        KILLMS: "1500",
        SEED: "7",
        BURST: "0",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    assert(/ATOMIC-OK/.test(text), text);
    assert(!/ATOMIC-SPLIT/.test(text), text);
  } finally {
    await dropTempDir(dir);
  }
});
