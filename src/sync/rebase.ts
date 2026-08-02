// src/sync/rebase.ts — Replay unconfirmed ops on confirmed state (CRDT rebase)
import type { SyncOp } from "./types.ts";

/** Reducer that applies a sync action to state, returning null if the op is invalid. */
export type SyncReducer = (
  state: Record<string, unknown>,
  action: string,
  payload: unknown,
  /** Cell the op belongs to — lets one reducer serve many cells. */
  cell?: string,
) => Record<string, unknown> | null;

/**
 * Result of replaying unconfirmed ops: optimistic state, dropped and surviving ops.
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
    if (next === null || next === undefined) {
      dropped.push(op);
    } else {
      state = next;
      surviving.push(op);
    }
  }

  return { optimistic: state, dropped, surviving };
}
