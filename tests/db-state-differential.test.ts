// Randomized differential: THE property of the `db:` feature is that the SQL
// table and the cell array it mirrors never disagree — not after any sequence
// of inserts/updates/deletes/reorders/whole-array replacements, and not across
// a restart (close → reopen → loadTables).
//
// The model is the array itself. `planTables` is the only thing that builds
// writes — the persistence manager calls it and commits the result — and `prev`
// is maintained exactly as `createPersistenceManager` maintains `prevDbState`
// (a clone advanced only after a successful commit), so a divergence here is a
// divergence in the shipped path.
//
// What is asserted, every window, is the FULL contract: the same rows, in the
// same order, with the same values AND the same JS types — not a multiset, not
// a sorted comparison. What is asserted about writes is that they are minimal:
// an array that was only reordered, or copied, is not a change.
//
// The schema is deliberately awkward in the ways real ones are: three tables in
// one transaction, one with no pk at all (the other branch of the diff), a
// nullable FK pointing at a table declared AFTER it, nullable/real columns, and
// a restart that can happen at any step rather than only at the end.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import {
  _resetDbReports,
  initSchema,
  loadTables,
  planTables,
} from "../src/db/state-sync.ts";
import { integer, pk, real, ref, table, text } from "../src/server/sql.ts";
import type { TableDef } from "../src/server/sql.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

type Item = {
  id: number;
  title: string;
  n: number;
  score: number | null;
  tag: string | null;
};
type Note = { id: number; itemId: number | null; body: string };
type LogRow = { at: number; msg: string };

// `notes` is declared BEFORE the table it references — a persist window writes
// the tables in this order, so this is the arrangement that used to make every
// FK-carrying schema silently unwritable. `items` exercises the keyed diff;
// `log` has no pk at all and takes the OTHER branch (full replacement), so
// every window is a three-table transaction carrying both branches and a
// deferred constraint.
const SCHEMA: Record<string, TableDef> = {
  notes: table({
    id: pk(),
    itemId: ref("items", { nullable: true }),
    body: text(),
  }),
  items: table({
    id: pk(),
    title: text(),
    n: integer(),
    score: real({ nullable: true }),
    tag: text({ nullable: true }),
  }),
  log: table({ at: integer(), msg: text() }),
};

// Deterministic PRNG (mulberry32) — a failure prints its seed and replays.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: T[]): T =>
  xs[Math.floor(r() * xs.length)]!;

/** Values that are type-correct for their column but awkward: empty string,
 *  zero, negatives, nulls in the nullable columns, non-integral reals. */
const mkItem = (r: () => number, id: number): Item => ({
  id,
  title: pick(r, ["", "t", "ünïcødé", "a'b", String(Math.floor(r() * 1000))]),
  n: pick(r, [0, -1, 7, 2 ** 31, Math.floor(r() * 100)]),
  score: r() > 0.3 ? Math.round(r() * 1e4) / 100 : null,
  tag: r() > 0.5 ? `g${Math.floor(r() * 5)}` : null,
});

/** A shuffled copy — same rows, new array, different order. */
function shuffled<T>(r: () => number, xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

Deno.test({
  name: "db differential: SQL table never disagrees with the bound array",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const rounds = fuzzEnvInt("AIO_DB_FUZZ_ROUNDS", 12, 1);
    const steps = fuzzEnvInt("AIO_DB_FUZZ_STEPS", 40, 1);
    const baseSeed = fuzzEnvInt("AIO_DB_FUZZ_SEED", 0xd1ffe4);
    let ops = 0, stmtsTotal = 0, restarts = 0, noopWindows = 0;

    for (let round = 0; round < rounds; round++) {
      const seed = baseSeed + round * 7919;
      const r = rng(seed);
      const dir = await Deno.makeTempDir({ prefix: "db-diff-" });
      const path = join(dir, "state.db");
      let db = createDB(path);
      try {
        _resetDbReports();
        await initSchema(db, SCHEMA);
        let items: Item[] = [];
        let notes: Note[] = [];
        let logModel: LogRow[] = [];
        let prev: Record<string, unknown> = { notes: [], items: [], log: [] };
        let nextId = 1, nextNote = 1;
        const log: string[] = [];

        /** One persist window, then the FULL comparison. `expectNoWrites`
         *  pins the other half of the contract: a table that only changed
         *  shape (a copy, a reorder) must produce no statements at all. */
        const sync = async (op: string, expectNoWrites = false) => {
          log.push(op);
          ops++;
          // The pk-less table churns on most steps too, and keeps its exact
          // reference on the others — which is what makes planTables' identity
          // pre-filter part of every run rather than a special case.
          logModel = r() > 0.5
            ? [...logModel, { at: log.length, msg: op.slice(0, 20) }].slice(-5)
            : logModel;
          const state = { notes, items, log: logModel };
          const stmts = planTables(SCHEMA, state, prev);
          const ctx = `seed ${seed} after [${log.join(" → ")}]`;
          if (expectNoWrites) {
            // Scoped to `items` — the other two tables are cloned into `prev`
            // on every window here, so they are always "changed" by identity.
            // (The shipped manager keeps the live reference and skips them;
            // that pre-filter is pinned in persist-store-atomicity.test.ts.)
            assertEquals(
              stmts.map((s) => s.sql).filter((s) => /\bitems\b/.test(s)),
              [],
              `${ctx}: an array with identical contents is not a change — ` +
                `rewriting it churns the table and, for a pk-less table, ` +
                `destroys and recreates every row`,
            );
            noopWindows++;
          }
          stmtsTotal += stmts.length;
          if (stmts.length) await db.transaction(stmts);
          prev = structuredClone(state);
          await assertStores(ctx);
        };

        /** Both stores, compared in full: same rows, same order, same values,
         *  same types. `SELECT *` on a `pk()` table walks the rowid — the pk —
         *  so the physical order is ascending pk, and that is what the next
         *  boot restores; the model is compared in exactly that order. */
        const assertStores = async (ctx: string) => {
          const sqlItems = (await db.query("SELECT * FROM items"))
            .rows as unknown as Item[];
          assertEquals(
            sqlItems,
            [...items].sort((a, b) => a.id - b.id),
            `${ctx}: items`,
          );
          const sqlNotes = (await db.query("SELECT * FROM notes"))
            .rows as unknown as Note[];
          assertEquals(
            sqlNotes,
            [...notes].sort((a, b) => a.id - b.id),
            `${ctx}: notes`,
          );
          // A table with no pk is rewritten wholesale, in array order — so
          // here the order IS the contract, unconditionally.
          assertEquals(
            (await db.query("SELECT * FROM log")).rows,
            logModel,
            `${ctx}: pk-less table`,
          );
        };

        /** Notes may only reference items that exist when the window ends —
         *  a dangling FK is a real error and must stay one. */
        const repoint = () => {
          const live = new Set(items.map((x) => x.id));
          notes = notes.map((nt) =>
            nt.itemId !== null && !live.has(nt.itemId)
              ? { ...nt, itemId: null }
              : nt
          );
        };

        for (let step = 0; step < steps; step++) {
          const kind = Math.floor(r() * 13);
          if (kind === 0 || items.length === 0) {
            items = [...items, mkItem(r, nextId++)];
            await sync(`insert#${items.at(-1)!.id}`);
          } else if (kind === 1) {
            const victim = pick(r, items);
            items = items.map((x) =>
              x.id === victim.id ? { ...mkItem(r, x.id) } : x
            );
            await sync(`update#${victim.id}`);
          } else if (kind === 2) {
            const victim = pick(r, items);
            items = items.filter((x) => x.id !== victim.id);
            repoint();
            await sync(`delete#${victim.id}`);
          } else if (kind === 3) {
            // Reorder in place — the rows are identical, only their order
            // moves. A keyed table must write NOTHING for that.
            const i = Math.floor(r() * items.length);
            const j = Math.floor(r() * items.length);
            const next = [...items];
            [next[i], next[j]] = [next[j]!, next[i]!];
            const moved = i !== j;
            items = next;
            await sync(`swap ${i}<->${j}`, moved);
          } else if (kind === 4) {
            const size = Math.floor(r() * 4);
            items = Array.from({ length: size }, () => mkItem(r, nextId++));
            repoint();
            await sync(`replace(${size})`);
          } else if (kind === 5) {
            items = [];
            repoint();
            await sync("clear");
          } else if (kind === 6) {
            // Delete a row and re-add its pk with different content, in ONE
            // window — the diff must not see it as an untouched row.
            const victim = pick(r, items);
            items = [
              ...items.filter((x) => x.id !== victim.id),
              { ...mkItem(r, victim.id), title: "reborn" },
            ];
            await sync(`readd#${victim.id}`);
          } else if (kind === 7) {
            // The pk itself changes, in place: same row, new identity. It is
            // a delete AND an insert inside one window, and any note pointing
            // at the old id has to follow it in the SAME transaction.
            const victim = pick(r, items);
            const fresh = nextId++;
            items = items.map((x) =>
              x.id === victim.id ? { ...x, id: fresh } : x
            );
            notes = notes.map((nt) =>
              nt.itemId === victim.id ? { ...nt, itemId: fresh } : nt
            );
            await sync(`repk#${victim.id}→${fresh}`);
          } else if (kind === 8) {
            // A differently-ordered copy of the array itself: every row is
            // reference-new and value-identical. Nothing may be written.
            items = shuffled(r, items.map((x) => ({ ...x })));
            await sync("shuffled-copy", items.length > 1);
          } else if (kind === 9) {
            // A structural no-op: new array, new row objects, same data.
            items = items.map((x) => ({ ...x }));
            await sync("copy", true);
          } else if (kind === 10) {
            // The other bound table moves on its own.
            const live = items.map((x) => x.id);
            if (notes.length && r() > 0.5) {
              const victim = pick(r, notes);
              notes = r() > 0.5
                ? notes.filter((x) => x.id !== victim.id)
                : notes.map((x) =>
                  x.id === victim.id
                    ? {
                      ...x,
                      itemId: live.length && r() > 0.3 ? pick(r, live) : null,
                    }
                    : x
                );
            } else {
              notes = [...notes, {
                id: nextNote++,
                itemId: live.length && r() > 0.3 ? pick(r, live) : null,
                body: `b${Math.floor(r() * 100)}`,
              }];
            }
            await sync("notes");
          } else if (kind === 11) {
            // Restart MID-RUN, exactly as boot does it: close, reopen, load,
            // and adopt what SQLite actually holds as both the state and the
            // diff baseline. The window right after a restore is where
            // "re-INSERT every restored row" hides.
            await db.close();
            db = createDB(path);
            await initSchema(db, SCHEMA);
            const loaded = await loadTables(db, SCHEMA);
            items = loaded.items as Item[];
            notes = loaded.notes as Note[];
            logModel = loaded.log as LogRow[];
            prev = structuredClone({ notes, items, log: logModel });
            restarts++;
            log.push("RESTART");
            await assertStores(`seed ${seed} after [${log.join(" → ")}]`);
          } else {
            // Batch: several changes inside a single persist window.
            const next = items.filter(() => r() > 0.3).map((x) =>
              r() > 0.5 ? { ...x, n: x.n + 1 } : x
            );
            next.push(mkItem(r, nextId++));
            items = next;
            repoint();
            await sync("batch");
          }
        }

        // ── Final restart: the restored arrays must equal what was in state,
        //    exactly — same rows, same order, same values, same types.
        const before = [...items].sort((a, b) => a.id - b.id);
        const beforeNotes = [...notes].sort((a, b) => a.id - b.id);
        await db.close();
        db = createDB(path);
        await initSchema(db, SCHEMA);
        const restored = await loadTables(db, SCHEMA);
        const ctx = `seed ${seed} after [${log.join(" → ")}]`;
        assertEquals(restored.items, before, `${ctx}: restart (items)`);
        assertEquals(restored.notes, beforeNotes, `${ctx}: restart (notes)`);
        assertEquals(restored.log, logModel, `${ctx}: restart (pk-less)`);
      } finally {
        await db.close().catch(() => {});
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
    }
    assert(ops > 0, "the fuzzer must actually run programs");
    assert(restarts > 0, "mid-run restarts must actually happen");
    assert(noopWindows > 0, "no-write windows must actually be exercised");
    console.log(
      `[db-differential] ${ops} sync ops (${stmtsTotal} statements, ` +
        `${noopWindows} proven no-write windows, ${restarts} mid-run ` +
        `restarts) across ${rounds} rounds`,
    );
  },
});

// ── The one divergence that is ACCEPTED, and therefore has to be reported ──
//
// SQLite does not reject a number in a TEXT column, it converts it — so state
// and the table hold different values, and the next boot adopts the converted
// one. That is a real divergence in the property above, and the only thing
// standing between it and silence is the once-per-column report. This pins it:
// if the value is rewritten, the developer is told which table and column did
// it. A report that stops firing turns this into exactly the class of silent
// corruption the rest of this file exists to rule out.
Deno.test({
  name: "db differential: a type the column rewrites is always reported",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "db-diff-affinity-" });
    const db = createDB(join(dir, "state.db"));
    const schema = { t: table({ id: pk(), s: text(), i: integer() }) };
    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (m: string) => warned.push(String(m));
    try {
      _resetDbReports();
      await initSchema(db, schema);
      // `s` is TEXT and gets a number; `i` is INTEGER and gets a string.
      const rows: Record<string, unknown>[] = [{ id: 1, s: 42, i: "7" }];
      const stmts = planTables(schema, { t: rows }, { t: [] });
      await db.transaction(stmts);
      const back = (await loadTables(db, schema)).t as Record<
        string,
        unknown
      >[];
      const diverged = ["s", "i"].filter((c) => back[0]![c] !== rows[0]![c]);
      assert(
        diverged.length > 0,
        "precondition: SQLite rewrites these — if it stopped, delete this test",
      );
      for (const col of diverged) {
        assert(
          warned.some((w) =>
            w.includes(`table "t"`) && w.includes(`column "${col}"`)
          ),
          `column "${col}" was rewritten by SQLite (${
            JSON.stringify(rows[0]![col])
          } → ${
            JSON.stringify(back[0]![col])
          }) and nothing said so. Reports were:\n${warned.join("\n")}`,
        );
      }
    } finally {
      console.warn = origWarn;
      await db.close().catch(() => {});
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
