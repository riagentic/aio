// tests/rejection-attribution-fuzz.test.ts — the D11 contract as a property,
// over random concurrent op interleavings.
//
// The contract the sync server owes every client, for EVERY op:
//
//     applied to server state  ⟺  acked, kept in the op log, no op-rejected
//     refused by the reducer   ⟺  op-rejected, row deleted, never acked
//
// Anything else is a silent divergence: an ack for a refused op leaves the
// change alive on every machine except the one that refused it, and an
// op-rejected for an applied one makes the origin roll back what the server
// kept. Both were reachable while the rejection lived in one process-wide
// slot keyed by cell — the reader is on the far side of an `await`, and the
// neighbouring op chain that resumes there runs its own reduce.
//
// Nothing here re-implements the reducer: "applied" is observed as "the
// dispatch of this action changed committed state" (every method bumps a seq,
// so an accepted reduce always moves state and a refused one never does).
import { assertEquals } from "@std/assert";
import { fuzzEnvInt } from "./fuzz-seed.ts";
import { cell } from "../src/state/cell-create.ts";
import { composeCells } from "../src/state/cell-compose.ts";
import { createDispatch } from "../src/state/dispatch.ts";
import type { Msg } from "../src/state/cell-types.ts";
import { createServerSyncHandler } from "../src/sync/server-handler.ts";
import { _resetServerTsForTest } from "../src/sync/server-store.ts";
import { createTestDb, recordingSocket } from "./sync/_test-db.ts";
import type { HLC } from "../src/sync/types.ts";

// Fixed by default so CI explores the same programs on every run; a sweep
// widens it without making the default nondeterministic:
//   for s in 1 7 31 99; do FUZZ_SEED=$s deno test -A tests/rejection-attribution-fuzz.test.ts; done
const SEED = fuzzEnvInt("FUZZ_SEED", 0x0d11f00d) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 40, 1);

const noop = { debug: () => {}, warn: () => {}, error: () => {} };

type Op = {
  id: string;
  cell: string;
  action: "set" | "poison";
  args: unknown[];
};

/** `k` cells that refuse negative values and refuse being poisoned. Cell i
 *  also LISTENS to its neighbour's `poison`, so one op's reduce can record a
 *  rejection for a cell that is not the op's own — the exact shape a
 *  cell-keyed global slot mis-attributes. */
function makeCells(k: number) {
  const defs = [];
  for (let i = 0; i < k; i++) {
    const neighbour = `c${(i + 1) % k}`;
    defs.push(cell(`c${i}`, {
      state: { n: 0, seq: 0, poisoned: false },
      methods: {
        // Every method bumps `seq`, so "committed" is observable as a state
        // change even when the value written equals the current one.
        set(s, _tag: string, v: number) {
          s.n = v;
          s.seq += 1;
        },
        poison(s, _tag: string) {
          s.poisoned = true;
          s.seq += 1;
        },
        onNeighbourPoison(s) {
          s.poisoned = true;
          s.seq += 1;
        },
      },
      listensTo: { onNeighbourPoison: `${neighbour}:poison` },
      validate: (s) =>
        s.n < 0 ? "n must be >= 0" : s.poisoned ? "poisoned" : true as const,
    }));
  }
  return defs;
}

function harness(k: number) {
  _resetServerTsForTest();
  // onCellError is the path a real app wires (reportAioError) — refusals are
  // reported through it instead of the console, which is also what keeps this
  // fuzzer's output readable.
  const composed = composeCells(makeCells(k), { onCellError: () => {} });
  let state = composed.initialState;
  const app = { dispatch: (a: Msg) => dispatch(a), getState: () => state };
  const dispatch = createDispatch<Record<string, unknown>, Msg, Msg>({
    reduce: composed.reduce as never,
    execute: (e) => composed.execute(app, e as Msg),
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {},
    log: noop,
    debug: false,
  });
  // Ground truth for "did this op's reduce commit?" — the drain is
  // synchronous, so state right after the call reflects this action's reduce.
  const applied = new Map<string, boolean>();
  const { db, close } = createTestDb();
  const handler = createServerSyncHandler({
    dispatch: (a) => {
      const before = state;
      const p = dispatch(a as unknown as Msg);
      const tag = ((a.payload as { args?: unknown[] })?.args?.[0]) as string;
      applied.set(tag, state !== before);
      return p;
    },
    db,
    syncCellIds: Array.from({ length: k }, (_, i) => `c${i}`),
    getCellState: (c) => (state as Record<string, never>)[c] ?? {},
    getClientCellState: (c) => (state as Record<string, never>)[c] ?? {},
    broadcastRaw: { fn: () => {} },
    log: noop,
  });
  return { handler, db, close, applied };
}

Deno.test("D11 property: acked ⟺ applied, op-rejected ⟺ refused", async () => {
  let seed = SEED;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (n: number) => Math.floor(rnd() * n);
  // Relative to NOW — see STALE_OP_REASON: an epoch-era stamp would be
  // refused as older than the tombstone window before it reached dispatch.
  let clock = Date.now();
  const hlc = (): HLC => [clock++, 0, "c1"];

  for (let round = 0; round < ROUNDS; round++) {
    const k = 2 + pick(3);
    const h = harness(k);
    const sockets = new Map<string, ReturnType<typeof recordingSocket>>();
    const ops: Op[] = [];
    const n = 2 + pick(5);
    for (let i = 0; i < n; i++) {
      const id = `r${round}-o${i}`;
      const c = `c${pick(k)}`;
      ops.push(
        pick(4) === 0
          ? { id, cell: c, action: "poison", args: [id] }
          : { id, cell: c, action: "set", args: [id, pick(4) - 1] },
      );
    }
    // A warm-up op (or not) shifts the await parity between the concurrent
    // chains — which of them resumes inside another's dispatch→read window.
    const warm = pick(2) === 0;
    try {
      if (warm) {
        await h.handler.handleOp(
          {
            id: `r${round}-warm`,
            hlc: hlc(),
            cell: "c0",
            action: "set",
            args: [],
            payload: { args: [`r${round}-warm`, 1] },
          },
          { id: "warm" },
          recordingSocket().socket,
        );
      }
      // Fire them all without awaiting individually: the handler chains
      // interleave exactly as two clients' frames do.
      await Promise.all(ops.map((op) => {
        const s = recordingSocket();
        sockets.set(op.id, s);
        return h.handler.handleOp(
          {
            id: op.id,
            hlc: hlc(),
            cell: op.cell,
            action: op.action,
            payload: { args: op.args },
          },
          { id: op.id },
          s.socket,
        );
      }));

      for (const op of ops) {
        const frames = sockets.get(op.id)!.frames;
        const acked = frames.some((f) => f.t === "sync-ack");
        const rejected = frames.find((f) => f.t === "op-rejected");
        const applied = h.applied.get(op.id) ?? false;
        const { rows } = await h.db.query(
          "SELECT id FROM sync_ops WHERE id = ?",
          [op.id],
        );
        const where = `seed ${SEED} round ${round} op ${op.id} ` +
          `(${op.cell}:${op.action} ${JSON.stringify(op.args)}) — ` +
          `applied=${applied} acked=${acked} rejected=${!!rejected} ` +
          `row=${rows.length}`;
        assertEquals(
          acked,
          applied,
          `ack must mean applied and nothing else: ${where}`,
        );
        assertEquals(
          !!rejected,
          !applied,
          `op-rejected must mean refused and nothing else: ${where}`,
        );
        assertEquals(
          rows.length,
          applied ? 1 : 0,
          `the log must agree with live state: ${where}`,
        );
        if (rejected) {
          assertEquals(
            (rejected.d as { opId: string }).opId,
            op.id,
            `a rejection must name the op it belongs to: ${where}`,
          );
        }
      }
    } finally {
      h.close();
    }
  }
});
