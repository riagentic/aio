// The journal's records of a sync op on a listened action — INTENT, the
// reaction lines, COMMIT (src/server/journal.ts, J1–J7) — cut at EVERY byte.
//
// A kill tears the file at an arbitrary byte (a big reaction line took
// seconds to write in the reviewer's tear runs: the mark landed, the
// reaction did not, and boot read the op as reduced with its reactions
// lost). The property the boot rests on, for every cut: an op read as
// COVERED has every reaction line of its reduce readable, and an op read as
// IN FLIGHT has none — so journal replay restores it exactly once, or the
// boot's whole re-reduce does, never both and never half. And the next open
// (which seals the torn tail and appends after it) changes neither.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  BATCH_TYPE,
  createJournal,
  type JournalEntry,
  parseJournal,
  SYNC_APPLIED_TYPE,
  SYNC_INTENT_TYPE,
  SYNC_REACTION_TYPE,
} from "../src/server/journal.ts";
import { opKey, type Placement, placeOps } from "../src/server/op-placement.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type Op = { id: string; ts: number; reactions: number[] };

/** Write ops the way the live server does: INTENT, then (for all but the
 *  last) ONE atomic block of reaction lines closed by COMMIT. */
function write(path: string): Op[] {
  const j = createJournal(path);
  const ops: Op[] = [];
  const big = "x".repeat(3000); // a reaction line long enough to tear inside
  for (const [i, id] of ["a", "b", "c"].entries()) {
    const ts = 100 + i;
    j.append({
      type: SYNC_INTENT_TYPE,
      payload: { cell: "src", id, ts },
      only: ["src"],
    }, 0);
    const reactions: number[] = [];
    if (id !== "c") {
      j.atomic!(() => {
        for (const cell of ["L", "M"]) {
          reactions.push(j.append({
            type: SYNC_REACTION_TYPE,
            payload: { cell, at: ts, state: { big, n: i } },
            only: [cell],
          }, 0));
        }
        j.append({
          type: SYNC_APPLIED_TYPE,
          payload: { cell: "src", id, ts },
          only: ["src"],
        }, 0);
      });
    }
    ops.push({ id, ts, reactions });
  }
  return ops;
}

function place(entries: JournalEntry[], ops: Op[]): Map<string, Placement> {
  const intents = new Set<string>();
  const commits = new Set<string>();
  for (const e of entries) {
    const p = e.payload as { id: string; ts: number };
    if (e.type === SYNC_INTENT_TYPE) intents.add(opKey(p.id, p.ts));
    if (e.type === SYNC_APPLIED_TYPE) commits.add(opKey(p.id, p.ts));
  }
  return placeOps(
    ops.map((o) => ({ id: o.id, ts: o.ts, listened: true })),
    intents,
    commits,
  );
}

function check(entries: JournalEntry[], ops: Op[], where: string) {
  const placed = place(entries, ops);
  ops.forEach((o, i) => {
    // By content: a seq a torn line never landed with is issued again.
    const seen = entries.filter((e) =>
      e.type === SYNC_REACTION_TYPE && (e.payload as { at: number }).at === o.ts
    ).length;
    const p = placed.get(o.id)!;
    if (p === "covered") {
      assertEquals(seen, o.reactions.length, `${where}: ${o.id} half covered`);
    }
    if (p === "in-flight") {
      assertEquals(seen, 0, `${where}: ${o.id} in flight WITH reactions`);
      assertEquals(i, ops.length - 1, `${where}: in flight, not last`);
    }
  });
  return placed;
}

Deno.test("journal op records: a cut at every byte never reads an op half-committed", async () => {
  const dir = await tempDir("aio-op-records-");
  try {
    const path = join(dir, "journal");
    const ops = write(path);
    const bytes = await Deno.readFile(path);
    // Each reduce is ONE line (J1).
    const text = new TextDecoder().decode(bytes);
    assertEquals(
      text.split("\n").filter((l) => l.includes(`"type":"${BATCH_TYPE}"`))
        .length,
      2,
    );
    const seen = { covered: 0, "in-flight": 0, uncovered: 0 };
    for (let cut = 0; cut <= bytes.length; cut++) {
      const where = `cut at byte ${cut}/${bytes.length}`;
      const torn = join(dir, `t-${cut}`);
      await Deno.writeFile(torn, bytes.subarray(0, cut));
      const read = parseJournal(
        new TextDecoder().decode(bytes.subarray(0, cut)),
        { quiet: true },
      );
      // The op-log holds the first k ops (the kill came during op k's
      // persist, reduce or commit — or the journal lost a suffix the rows
      // outlived).
      const before = ops.map((_, k) =>
        check(read, ops.slice(0, k + 1), `${where}, ${k + 1} rows`)
      );
      for (const m of before) for (const p of m.values()) seen[p]++;
      // The next boot opens it (sealing a torn tail) and appends after it:
      // what the cut left is read the same, and nothing fuses.
      const j = createJournal(torn);
      j.append({ type: "x:after", payload: {} }, 0);
      const after = parseJournal(await Deno.readTextFile(torn), {
        quiet: true,
      });
      assertEquals(
        ops.map((_, k) =>
          check(after, ops.slice(0, k + 1), `${where}, reopened`)
        ),
        before,
        where,
      );
      assert(after.some((e) => e.type === "x:after"), where);
      await Deno.remove(torn);
    }
    // Non-vacuity: every placement was reached, at many cuts.
    for (const [k, n] of Object.entries(seen)) assert(n > 50, `${k}: ${n}`);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("journal op records: compaction keeps what it keeps of a batch as ONE line", async () => {
  const dir = await tempDir("aio-op-records-compact-");
  try {
    const path = join(dir, "journal");
    const j = createJournal(path);
    j.trackCells({ src: 0, L: 0 });
    let first = 0;
    j.atomic!(() => {
      first = j.append({ type: "k:call", payload: 1 }, 0); // store's clock
      j.append({
        type: SYNC_REACTION_TYPE,
        payload: { cell: "L", at: 1, state: {} },
        only: ["L"],
      }, 0);
      j.append({
        type: SYNC_APPLIED_TYPE,
        payload: { cell: "src", id: "a", ts: 1 },
        only: ["src"],
      }, 0);
    });
    // The store saved past the block: its call line goes; the two lines
    // governed by the sync cells' own watermarks stay — together.
    j.setWatermark(first + 10);
    const lines = (await Deno.readTextFile(path)).trim().split("\n");
    assertEquals(lines.length, 1, lines.join("\n"));
    const kept = parseJournal(lines[0]!, { quiet: true });
    assertEquals(kept.map((e) => e.type), [
      SYNC_REACTION_TYPE,
      SYNC_APPLIED_TYPE,
    ]);
    // …and a tear anywhere in it takes both.
    for (let cut = 1; cut < lines[0]!.length; cut++) {
      assertEquals(
        parseJournal(lines[0]!.slice(0, cut), { quiet: true }).length,
        0,
      );
    }
  } finally {
    await dropTempDir(dir);
  }
});
