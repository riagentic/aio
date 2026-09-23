// A journalled `listensTo` reaction is a CHAIN: a keyframe (the whole slice),
// then per reaction only what changed since the line before it (aio.ts
// `_journalReaction`; review rev7 — a whole slice per reaction was 8× the op
// cost on a 2 MB listener). A store-persisted cell's chain restarts at every
// save's capture; a sync cell's re-bases on the snapshot its fold wrote
// (`baseSnapshotAt`), and a line written while that fold was in flight
// carries both deltas (`alsoSnapshot`) — modelled here as the host does it.
//
// Property: whatever interleaving of ops, reactions, captures and committed
// saves a run has, boot rebuilds EXACTLY the live state —
//  • a sync cell (`seedSyncReactions`): the newest chain resolved, then the
//    op-log above its `at`, even after the log below it was compacted away,
//    and whether the chain starts at a keyframe or on a fold's snapshot;
//  • a store-persisted cell (`replayJournal`, `keyframes` + `deltas`):
//    every line in journal order, a user's own jumps between them.
// And a chain that cannot resolve says so and keeps what it can prove.
import { assert, assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import type { DB, QueryResult } from "../../../src/db/types.ts";
import { SYNC_SCHEMA } from "../../../src/sync/compact.ts";
import { persistOp } from "../../../src/sync/server-store.ts";
import { diffState } from "../../../src/sync/state-patch.ts";
import { seedSyncReactions } from "../../../src/server/aio-boot.ts";
import {
  type JournalEntry,
  LISTENS_TO_CMD,
  replayJournal,
  SYNC_REACTION_TYPE,
  type SyncReaction,
  TT_RESTORE_TYPE,
} from "../../../src/server/journal.ts";
import { forAllSeeds, type Rng } from "./_prop.ts";

const FILE = "tests/sync/properties/reaction-chain.test.ts";

// deno-lint-ignore no-explicit-any
const _p = (v: unknown[]): any[] => v;
function memDb(): DB {
  const sqlite = new DatabaseSync(":memory:");
  for (const stmt of SYNC_SCHEMA) sqlite.exec(stmt);
  return {
    query: <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> =>
      Promise.resolve({
        rows: sqlite.prepare(sql).all(..._p(params ?? [])) as T[],
        changes: 0,
        lastInsertRowId: 0n,
      }),
    execute: (sql: string, params?: unknown[]): Promise<QueryResult> => {
      const r = sqlite.prepare(sql).run(..._p(params ?? []));
      return Promise.resolve({
        rows: [],
        changes: Number(r.changes),
        lastInsertRowId: BigInt(r.lastInsertRowid),
      });
    },
    transaction: (async (a: unknown) => {
      if (typeof a === "function") return await (a as () => unknown)();
      for (const st of a as Array<{ sql: string; params?: unknown[] }>) {
        sqlite.prepare(st.sql).run(..._p(st.params ?? []));
      }
    }) as DB["transaction"],
    close: () => sqlite.close(),
  } as unknown as DB;
}

type Slice = Record<string, unknown>;
type Root = { m: Slice };
/** The composed reducer's shape: `{ state, effects }`. */
const reduce = (s: Root, a: { type: string; payload?: unknown }) => {
  if (a.type !== "m:push") return { state: s, effects: [] };
  const v = (a.payload as { v: number }).v;
  const items = [...((s.m.items as number[]) ?? []), v];
  return { state: { ...s, m: { ...s.m, items } }, effects: [] };
};
/** Any error is a failed case: nothing here should break a chain. */
const quiet = {
  info() {},
  warn() {},
  error(m: string) {
    throw new Error(m);
  },
};

/** A reaction: an arbitrary change to the slice, the shapes a listener
 *  writes — a field set, added, deleted, an array grown, shrunk, rewritten,
 *  a nested record touched. Copy-on-write, like committed state. */
function react(rng: Rng, s: Slice): Slice {
  const next = structuredClone(s);
  switch (rng.int(6)) {
    case 0:
      next[`k${rng.int(5)}`] = rng.int(100);
      break;
    case 1:
      delete next[`k${rng.int(5)}`];
      break;
    case 2:
      (next.log as number[]).push(rng.int(1000));
      break;
    case 3:
      (next.log as number[]).splice(rng.int(4), 1);
      break;
    case 4:
      next.nested = {
        ...(next.nested as Slice),
        [`n${rng.int(3)}`]: [rng.int(9)],
      };
      break;
    default:
      next.items = [...(next.items as number[])].reverse();
  }
  return next;
}

const fresh = (): Slice => ({ items: [], log: [1, 2, 3], nested: {} });

/** Write the cell's sync snapshot the way a fold does (the whole slice). */
async function writeSnapshot(db: DB, state: Slice): Promise<void> {
  await db.execute(
    `INSERT INTO sync_snapshots (cell, version, state, hlc_phys, hlc_cnt, hlc_node, cell_version)
       VALUES ('m', 1, ?, 0, 0, 'n', 0)
       ON CONFLICT(cell) DO UPDATE SET state = excluded.state,
         version = sync_snapshots.version + 1`,
    [JSON.stringify(state)],
  );
}

Deno.test("sync reaction chain: boot rebuilds the live state from any interleaving of ops, reactions, fold captures and folds", async () => {
  let checked = 0;
  let onSnapshot = 0;
  const ran = await forAllSeeds(
    FILE,
    "sync chain",
    80,
    async (rng) => {
      const db = memDb();
      let live = fresh();
      let applied = 0; // the highest server_ts the live state holds
      let seq = 0;
      let wm = 0; // the cell's journal watermark (its last landed fold)
      // The host's model (aio.ts `_reactionChain` / `_captured`): the last
      // line of the chain — or the snapshot a landed fold wrote — and the
      // fold in flight between its capture and its landing.
      let link: { seq: number; state: Slice; snapshotAt?: number } | undefined;
      let inFlight:
        | { at: number; state: Slice; applied: number; lined: boolean }
        | null = null;
      const journal: JournalEntry[] = [];
      for (let step = 0; step < 40; step++) {
        const r = rng();
        if (r < 0.35) {
          const v = rng.int(1000);
          const ts = await persistOp(db, {
            id: `o${step}`,
            hlc: [1000 + step, 0, "c"],
            cell: "m",
            action: "push",
            payload: { v },
          });
          applied = ts!;
          live = reduce({ m: live }, { type: "m:push", payload: { v } }).state
            .m;
        } else if (r < 0.75) {
          live = react(rng, live);
          const payload: SyncReaction = link
            ? {
              cell: "m",
              at: applied,
              ops: diffState(link.state, live),
              ...(link.snapshotAt !== undefined
                ? { baseSnapshotAt: link.snapshotAt }
                : { base: link.seq }),
            }
            : { cell: "m", at: applied, state: live };
          if (inFlight !== null && !inFlight.lined) {
            inFlight.lined = true;
            if (link) {
              payload.alsoSnapshot = {
                at: inFlight.at,
                ops: diffState(inFlight.state, live),
              };
            }
          }
          const e = { seq: ++seq, ts: 0, type: SYNC_REACTION_TYPE, payload };
          // Through JSON, as the file holds it.
          journal.push(JSON.parse(JSON.stringify(e)));
          link = { seq, state: live };
        } else if (r < 0.87) {
          // A fold captures (one at a time — it holds the cell's lock).
          if (inFlight === null) {
            inFlight = { at: seq, state: live, applied, lined: false };
          }
        } else if (inFlight !== null) {
          // …and lands: snapshot, the ops it holds deleted, its watermark —
          // one transaction. The chain re-bases on it unless a line was
          // written meanwhile (that line resolves either way).
          await writeSnapshot(db, inFlight.state);
          await db.execute(
            "DELETE FROM sync_ops WHERE cell = ? AND server_ts <= ?",
            ["m", inFlight.applied],
          );
          wm = inFlight.at;
          if (!inFlight.lined) {
            link = { seq: 0, state: inFlight.state, snapshotAt: inFlight.at };
          }
          inFlight = null;
        }
      }
      // A crash here: a fold still in flight never landed.
      const tail = journal.filter((e) => e.seq > wm);
      if (!tail.some((e) => e.type === SYNC_REACTION_TYPE)) return;
      const { state } = await seedSyncReactions<Root>(
        db,
        ["m"],
        reduce,
        { m: { stale: true } },
        tail,
        () => 0,
        quiet,
        () => wm,
      );
      assertEquals(state.m, live);
      checked++;
      const newest = [...tail].reverse().find((e) => {
        const p = e.payload as SyncReaction;
        return p.state !== undefined || p.baseSnapshotAt === wm ||
          p.alsoSnapshot?.at === wm;
      })?.payload as SyncReaction | undefined;
      if (newest && newest.state === undefined) onSnapshot++;
    },
  );
  assert(ran >= 1, "the property ran");
  assert(checked * 2 >= ran, `${checked} of ${ran} cases had a tail to seed`);
  // Not vacuous: a good share of the chains started on a fold's snapshot.
  assert(
    onSnapshot * 4 >= checked,
    `${onSnapshot} of ${checked} on a snapshot`,
  );
});

Deno.test("store-persisted reaction chain: replay resolves every delta in journal order, a user's jumps between them", async () => {
  let withDeltas = 0;
  const ran = await forAllSeeds(FILE, "kv chain", 60, (rng) => {
    let stored = fresh();
    let seq = 0;
    let link: { seq: number; stored: Slice } | undefined;
    const lines: JournalEntry[] = [];
    let saved = 0;
    let captured: number | null = null;
    for (let step = 0; step < 30; step++) {
      const r = rng();
      if (r < 0.7) {
        stored = react(rng, stored);
        const payload = link
          ? {
            cmd: LISTENS_TO_CMD,
            cells: {},
            deltas: {
              t: { base: link.seq, ops: diffState(link.stored, stored) },
            },
          }
          // The shape the host writes: `cells` empty (an older reader must
          // find nothing to apply), the slice in `keyframes`.
          : { cmd: LISTENS_TO_CMD, cells: {}, keyframes: { t: stored } };
        lines.push(
          JSON.parse(
            JSON.stringify({
              seq: ++seq,
              ts: 0,
              type: TT_RESTORE_TYPE,
              payload,
            }),
          ),
        );
        link = { seq, stored };
      } else if (r < 0.85) {
        // A user's own jump: absolute, not part of the chain.
        stored = react(rng, stored);
        lines.push(JSON.parse(JSON.stringify({
          seq: ++seq,
          ts: 0,
          type: TT_RESTORE_TYPE,
          payload: { cmd: "undo", cells: { t: stored } },
        })));
      } else if (r < 0.93) {
        // A save captures (aio.ts `onCapture` → `_kvChain.clear()`): the
        // next line restarts the chain; lines until it commits stay above.
        captured = seq;
        link = undefined;
      } else if (captured !== null) {
        // …and commits: its watermark drops the lines it holds.
        saved = Math.max(saved, captured);
        captured = null;
      }
    }
    const tail = lines.filter((e) => e.seq > saved);
    if (tail.length === 0) return;
    const out = replayJournal(
      { t: { saved: "whatever the store held" } },
      tail,
      (s) => ({ state: s }),
      () => saved,
      undefined,
      undefined,
      (_cell, fields) => fields as Slice,
    );
    assertEquals(out.skipped, []);
    assertEquals(out.state.t, stored);
    if (tail.some((e) => (e.payload as { deltas?: unknown }).deltas)) {
      withDeltas++;
    }
  });
  assert(ran >= 1, "the property ran");
  assert(withDeltas * 2 >= ran, `${withDeltas} of ${ran} tails had deltas`);
});

Deno.test("sync reaction chain: a broken link keeps the chain up to it, said — never a guess", async () => {
  const db = memDb();
  const errors: string[] = [];
  const line = (seq: number, p: SyncReaction): JournalEntry => ({
    seq,
    ts: 0,
    type: SYNC_REACTION_TYPE,
    payload: p,
  });
  const a = { items: [], log: [1] };
  const b = { items: [], log: [1, 2] };
  const c = { items: [], log: [1, 2, 3] };
  const tail = [
    line(1, { cell: "m", at: 0, state: { items: [], log: [] } }), // older chain
    line(2, { cell: "m", at: 0, state: a }),
    line(3, { cell: "m", at: 0, ops: diffState(a, b), base: 2 }),
    line(5, { cell: "m", at: 0, ops: diffState(b, c), base: 4 }), // 4 is gone
  ];
  const { state, seededAt } = await seedSyncReactions<Root>(
    db,
    ["m"],
    reduce,
    { m: {} },
    tail,
    () => 0,
    { ...quiet, error: (m: string) => errors.push(m) },
  );
  assertEquals(
    state.m,
    b,
    "the newest keyframe, and every whole link after it",
  );
  assertEquals(seededAt.get("m"), 3);
  assert(errors.some((m) => m.includes("breaks at seq 5")), errors.join("\n"));

  const none = await seedSyncReactions<Root>(
    db,
    ["m"],
    reduce,
    { m: { kept: 1 } },
    [line(7, { cell: "m", at: 0, ops: [], base: 6 })],
    () => 0,
    { ...quiet, error: (m: string) => errors.push(m) },
  );
  assertEquals(none.state.m, { kept: 1 }, "no keyframe: the op-log result");
  assert(errors.some((m) => m.includes("no keyframe")), errors.join("\n"));
});

Deno.test("store-persisted reaction chain: a delta whose base is not the cell's last reaction line is skipped, said", () => {
  const tt = (seq: number, payload: unknown): JournalEntry => ({
    seq,
    ts: 0,
    type: TT_RESTORE_TYPE,
    payload,
  });
  const a = { log: [1] };
  const b = { log: [1, 2] };
  const c = { log: [1, 2, 3] };
  const out = replayJournal(
    { t: {} as Slice },
    [
      tt(1, { cmd: LISTENS_TO_CMD, cells: { t: a } }),
      tt(2, {
        cmd: LISTENS_TO_CMD,
        cells: {},
        deltas: { t: { base: 1, ops: diffState(a, b) } },
      }),
      tt(4, {
        cmd: LISTENS_TO_CMD,
        cells: {},
        deltas: { t: { base: 3, ops: diffState(b, c) } }, // 3 is gone
      }),
    ],
    (s) => ({ state: s }),
    () => 0,
    undefined,
    undefined,
    (_cell, fields) => fields as Slice,
  );
  assertEquals(out.state.t, b, "up to the last whole link");
  assertEquals(out.skipped.map((k) => [k.seq, k.reason]), [[4, "threw"]]);
});
