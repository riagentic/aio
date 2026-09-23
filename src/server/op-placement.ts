/**
 * Where a sync op on an action some cell `listensTo` stands at boot, and
 * what the boot may do about its reactions — the rules of the records block
 * in journal.ts (J1–J7), as pure functions (aio.ts applies them).
 *
 * A silent double count is never acceptable; a named hold is. So a reaction
 * is re-applied only for the one op a crash can catch between its persist and
 * its commit, and only onto a listener whose record CERTAINLY lacks it. Every
 * other op no record covers — an older build's, a run's with the journal
 * off, one whose journal lines were lost — is named, never re-derived.
 *
 * What the rules below rest on besides J1–J7:
 *
 *  F1  One issuer hands out `server_ts` values in increasing order, and every
 *      restart resumes above the highest value stored.
 *  F3  A fold of a sync cell holds that cell's lock, issues its snapshot
 *      value and captures the cell's state in the same macrotask; an op
 *      issued after that value is reduced only after a database round trip,
 *      so after the capture.
 */

export type Verdict = "apply" | "held";

/** Where a sync op on a listened action stands at boot — the rules of
 *  journal.ts' block (J1–J7): its reactions are in the journal ("covered"),
 *  it is the one a crash caught between its persist and its commit
 *  ("in-flight"), or nothing this boot can read proves either way
 *  ("uncovered"). */
export type Placement = "covered" | "in-flight" | "uncovered";

/** The key an intent or commit names an op by: its id AND its value — an
 *  older build can re-issue a value this build issued to an op it then
 *  refused, but never with the same id. */
export const opKey = (id: string, ts: number): string => `${id}@${ts}`;

/** Place each listened op of ONE cell. `rows`: the cell's whole op-log in
 *  `server_ts` order (every action — a later row of any kind proves the
 *  op before it settled, J4). */
export function placeOps(
  rows: readonly { id: string; ts: number; listened: boolean }[],
  intents: ReadonlySet<string>,
  commits: ReadonlySet<string>,
): Map<string, Placement> {
  const out = new Map<string, Placement>();
  rows.forEach((r, i) => {
    if (!r.listened) return;
    const k = opKey(r.id, r.ts);
    out.set(
      r.id,
      commits.has(k)
        ? "covered"
        : intents.has(k) && i === rows.length - 1
        ? "in-flight"
        : "uncovered",
    );
  });
  return out;
}

/** A reaction of an in-flight op (value `ts`, intent at journal seq
 *  `intentSeq`) on one of its listeners: "apply" only where the listener's
 *  record certainly lacks it — a store-persisted listener whose store has
 *  not saved since the intent (`storeWm`, J6), a sync listener whose last
 *  fold predates the op (`snapshotTs`, J7). */
export function inFlightVerdict(
  listener: { storeWm: number } | { snapshotTs: number },
  op: { ts: number; intentSeq: number },
): Verdict {
  if ("storeWm" in listener) {
    return listener.storeWm < op.intentSeq ? "apply" : "held";
  }
  return listener.snapshotTs < op.ts ? "apply" : "held";
}
