// src/sync/rebase.ts — Replay unconfirmed ops on confirmed state (CRDT rebase)
import type { SyncOp } from "./types.ts";

/** The reducer COULD NOT apply the op — it threw, or the op is not
 *  applicable at all.
 *
 *  Deliberately not `null`. `null` is the contract's "applied, changed
 *  nothing", and the engine acts on it: the op counts as folded, its id goes
 *  into the applied set and the cursor moves past it. The browser reducer used
 *  to map a reducer THROW onto that same `null`, so a crashing reducer
 *  reported success — the op was marked applied, the cursor advanced, and it
 *  could never be re-delivered: the server had it, the client never would, and
 *  nothing on either side could see the difference. Two different facts need
 *  two different values. */
export const REDUCER_FAILED: unique symbol = Symbol.for(
  "aio.sync.reducerFailed",
);

/** What a {@linkcode SyncReducer} may answer: the next state, `null` (applied,
 *  no change) or {@linkcode REDUCER_FAILED} (could not apply).
 *  @internal Engine/framework wiring — not public API. */
export type SyncReducerResult =
  | Record<string, unknown>
  | null
  | typeof REDUCER_FAILED;

/** Reducer that applies a sync action to state, returning null if the op
 *  changed nothing and {@linkcode REDUCER_FAILED} if it could not be applied.
 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export type SyncReducer = (
  state: Record<string, unknown>,
  action: string,
  payload: unknown,
  /** Cell the op belongs to — lets one reducer serve many cells. */
  cell?: string,
) => SyncReducerResult;

/**
 * Result of replaying unconfirmed ops: optimistic state, dropped and surviving ops.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export interface RebaseResult {
  optimistic: Record<string, unknown>;
  dropped: SyncOp[];
  surviving: SyncOp[];
}

/** Replay unconfirmed ops through reducer on top of confirmed state.
 *  Ops returning null are dropped (invalid after rebase). */
/**
 * Replay unconfirmed local ops on top of freshly confirmed server state.

 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export function rebase(
  confirmed: Record<string, unknown>,
  unconfirmed: SyncOp[],
  reducer: SyncReducer,
): RebaseResult {
  if (unconfirmed.length === 0) {
    return { optimistic: confirmed, dropped: [], surviving: [] };
  }

  // Deep-clone to prevent reducer from corrupting the confirmed ground truth
  let state = structuredClone(confirmed);
  const dropped: SyncOp[] = [];
  const surviving: SyncOp[] = [];

  for (const op of unconfirmed) {
    const next = reducer(state, op.action, op.payload, op.cell);
    // `null` is the contract's "no-op, drop it". `undefined` is a buggy
    // reducer — and treating it as state poisoned the fold: `state` became
    // undefined, the NEXT op's reducer got undefined as its input and crashed
    // on the first property read, and the offending op counted as SURVIVING,
    // so it was replayed on every subsequent rebase. Drop it instead:
    // one bad op cannot take the whole cell down with it.
    if (next === null || next === undefined || next === REDUCER_FAILED) {
      // REDUCER_FAILED lands here for the same reason `undefined` does: an op
      // the reducer cannot apply must not become the fold's state, and must
      // not count as surviving (it would be replayed on every later rebase).
      dropped.push(op);
    } else {
      state = next;
      surviving.push(op);
    }
  }

  return { optimistic: state, dropped, surviving };
}
