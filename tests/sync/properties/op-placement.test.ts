// The boot's placement of sync ops on a listened action (src/server/journal.ts
// J1–J7, src/server/op-placement.ts `placeOps` / `inFlightVerdict`),
// checked against a model of every record a run leaves: the op-log rows, the
// journal's lines (INTENT, one line per reduce holding its reaction lines and
// COMMIT), the store's save (with its journal watermark) and the sync
// listener's fold (with its snapshot value and journal watermark).
//
// Histories: several runs of this build, and of v1.0.9 (no intents, no
// commits, a boot that re-derives any logged op's reactions — over-counting,
// its own bug — a clean stop that saves the store and never folds a sync
// listener for them); each run ends in a clean stop or a kill at any step,
// tearing its last line; between runs the journal may lose a suffix, or all
// of it; ops are refused (validate) after their value is issued.
//
// Properties, at this build's boot:
//  P1  a reaction the boot applies (an in-flight op's) is in NO record the
//      boot restored for that listener — never counted twice;
//  P2  an in-flight op is its cell's last row, and none of its reaction
//      lines is readable;
//  P3  every logged op's reaction is in the restored state, applied, or
//      NAMED (held or uncovered) by this boot or the earlier one that placed
//      it — never silently missing.
import { assert } from "@std/assert";
import {
  inFlightVerdict,
  opKey,
  placeOps,
} from "../../../src/server/op-placement.ts";
import { forAllSeeds, type Rng } from "./_prop.ts";

const FILE = "tests/sync/properties/op-placement.test.ts";

type Bag = Map<string, number>;
const bag = (b?: Bag): Bag => new Map(b ?? []);
const add = (b: Bag, id: string) => b.set(id, (b.get(id) ?? 0) + 1);
type L = "S" | "M"; // S: store-persisted listener, M: sync listener
type Entry =
  | { seq: number; t: "intent"; id: string; ts: number }
  | { seq: number; t: "react"; cell: L; state: Bag }
  | { seq: number; t: "commit"; id: string; ts: number };
type Row = { id: string; ts: number };

function world(rng: Rng): World {
  let issued = 0;
  let seq = 0;
  let nId = 0;
  const rows: Row[] = [];
  let lines: Entry[][] = [];
  let store = { wm: 0, S: bag() };
  let snap = { ts: 0, wm: 0, M: bag() };
  /** `cell id` pairs an earlier boot of this build named. */
  const named = new Set<string>();
  const runs = 1 + rng.int(4);
  for (let r = 0; r < runs; r++) {
    const ours = rng.chance(0.6);
    // Boot: live state from the records — this build's boot restores its
    // reaction lines past each watermark; v1.0.9's ignores them and
    // re-derives any logged op's reactions, whatever the records hold.
    const live = ours
      ? { S: bag(restored("S")), M: bag(restored("M")) }
      : { S: bag(store.S), M: bag(snap.M) };
    if (!ours) {
      for (const row of rows) {
        if (rng.chance(0.5)) add(live.S, row.id);
        if (rng.chance(0.5)) add(live.M, row.id);
      }
    } else if (r > 0) {
      // This build's boot places every op (the rules under test) and
      // commits each placed one in ONE line with what it re-applied.
      const b = bootOf({ rows, lines, store, snap });
      const line: Entry[] = [];
      for (const d of b.decisions) {
        if (d.applyS) add(live.S, d.row.id);
        if (d.applyM) add(live.M, d.row.id);
        // Named in this boot's log — once; committed below, never again.
        if (d.p === "uncovered" || d.vS === "held") named.add(`S ${d.row.id}`);
        if (d.p === "uncovered" || d.vM === "held") named.add(`M ${d.row.id}`);
      }
      if (b.decisions.some((d) => d.applyS || d.applyM)) {
        line.push({ seq: ++seq, t: "react", cell: "S", state: bag(live.S) });
        line.push({ seq: ++seq, t: "react", cell: "M", state: bag(live.M) });
      }
      for (const d of b.decisions) {
        if (d.p !== "covered") line.push({ seq: ++seq, t: "commit", ...d.row });
      }
      if (line.length > 0 && !rng.chance(0.05)) lines.push(line);
    }
    const save = () => {
      store = { wm: seq, S: bag(live.S) };
      // v1.0.9 compacts by the app-wide watermark alone: every line.
      if (!ours) lines = [];
    };
    const fold = () => {
      snap = { ts: ++issued, wm: ours ? seq : snap.wm, M: bag(live.M) };
    };
    /** Other cells' work between an op's persist and its reduce. */
    const meanwhile = () => {
      if (rng.chance(0.15)) save();
      if (rng.chance(0.15)) fold();
    };
    const steps = 3 + rng.int(20);
    let killed = false;
    for (let s = 0; s < steps && !killed; s++) {
      const k = rng.int(10);
      if (k < 5) {
        const row = { id: `o${++nId}`, ts: ++issued };
        if (ours) lines.push([{ seq: ++seq, t: "intent", ...row }]);
        if (rng.chance(0.05)) killed = true; // before the INSERT
        else {
          rows.push(row);
          meanwhile();
          if (rng.chance(0.1)) killed = true; // before the reduce
          else if (rng.chance(0.15)) {
            rows.splice(rows.indexOf(row), 1); // refused: no reactions
          } else {
            add(live.S, row.id);
            add(live.M, row.id);
            if (ours) {
              lines.push([
                { seq: ++seq, t: "react", cell: "S", state: bag(live.S) },
                { seq: ++seq, t: "react", cell: "M", state: bag(live.M) },
                { seq: ++seq, t: "commit", ...row },
              ]);
              // Killed mid-write: the torn line reads as nothing (J1).
              if (rng.chance(0.1)) {
                lines.pop();
                killed = true;
              }
            }
          }
        }
      } else if (k < 7) fold();
      else if (k < 8) {
        const cut = ++issued; // a fold of the source: its ops leave the log
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]!.ts <= cut) rows.splice(i, 1);
        }
      } else save();
    }
    if (!killed && rng.chance(0.5)) {
      // A clean stop: the store saved; this build also folds its sync
      // listener (its reactions were pending) — v1.0.9 never does.
      save();
      if (ours) fold();
    }
    // Between runs: the journal loses a suffix (J2), or all of it.
    if (rng.chance(0.15)) lines = lines.slice(0, rng.int(lines.length + 1));
    if (rng.chance(0.05)) lines = [];
  }
  return { rows, lines, store, snap, named };

  function restored(cell: L): Bag {
    return restoredOf({ lines, store, snap }, cell);
  }
}

/** What this build's boot restores for a listener before placing anything:
 *  its last reaction line past the record's watermark, else the record. */
function restoredOf(
  w: {
    lines: Entry[][];
    store: { wm: number; S: Bag };
    snap: { wm: number; M: Bag };
  },
  cell: L,
): Bag {
  const wm = cell === "S" ? w.store.wm : w.snap.wm;
  const last = w.lines.flat().filter((e) =>
    e.t === "react" && e.cell === cell && e.seq > wm
  ).at(-1) as { state: Bag } | undefined;
  return last?.state ?? (cell === "S" ? w.store.S : w.snap.M);
}

type World = {
  named?: Set<string>;
  rows: Row[];
  lines: Entry[][];
  store: { wm: number; S: Bag };
  snap: { ts: number; wm: number; M: Bag };
};

/** This build's boot over the records, by the rules under test. */
function bootOf(w: World) {
  const flat = w.lines.flat();
  const intents = new Map<string, number>();
  const commits = new Set<string>();
  for (const e of flat) {
    if (e.t === "intent") intents.set(opKey(e.id, e.ts), e.seq);
    if (e.t === "commit") commits.add(opKey(e.id, e.ts));
  }
  const placed = placeOps(
    w.rows.map((r) => ({ ...r, listened: true })),
    new Set(intents.keys()),
    commits,
  );
  const decisions = w.rows.map((row, i) => {
    const p = placed.get(row.id)!;
    const v = (cell: L) =>
      p === "in-flight"
        ? inFlightVerdict(
          cell === "S" ? { storeWm: w.store.wm } : { snapshotTs: w.snap.ts },
          { ts: row.ts, intentSeq: intents.get(opKey(row.id, row.ts))! },
        )
        : undefined;
    return {
      row,
      i,
      p,
      vS: v("S"),
      vM: v("M"),
      applyS: v("S") === "apply",
      applyM: v("M") === "apply",
    };
  });
  return { flat, decisions };
}

Deno.test("op placement: no reaction applied twice, none missing unnamed", async () => {
  const tally = { covered: 0, "in-flight": 0, uncovered: 0, apply: 0, held: 0 };
  const ran = await forAllSeeds(FILE, "op placement", 4000, (rng) => {
    const w = world(rng);
    const { flat, decisions } = bootOf(w);
    const base = { S: restoredOf(w, "S"), M: restoredOf(w, "M") };
    for (const d of decisions) {
      tally[d.p]++;
      if (d.p === "in-flight") {
        // P2
        assert(d.i === w.rows.length - 1, "in flight, not last");
        for (const e of flat) {
          if (e.t === "react") {
            assert(!e.state.has(d.row.id), `in flight, ${d.row.id} journalled`);
          }
        }
      }
      for (const cell of ["S", "M"] as const) {
        const has = (base[cell].get(d.row.id) ?? 0) > 0;
        const v = cell === "S" ? d.vS : d.vM;
        if (v) tally[v]++;
        const applied = v === "apply";
        const named = d.p === "uncovered" || v === "held" ||
          !!w.named?.has(`${cell} ${d.row.id}`);
        // P1
        assert(!applied || !has, `${cell}: ${d.row.id} applied twice`);
        // P3
        assert(
          has || applied || named,
          `${cell}: ${d.row.id} missing, unnamed`,
        );
      }
    }
  });
  for (const [k, n] of Object.entries(tally)) {
    assert(n > ran / 20, `${k} reached only ${n}× in ${ran} runs`);
  }
});
