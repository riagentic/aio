// rejection-tracker.ts — D11 (perfect-aio): every rejected change is
// explainable. The composed reduce records WHY a dispatch was refused
// (validate hook failure, method throw); the sync server handler reads it
// synchronously right after dispatching an op and tells the op's origin
// client instead of leaving its optimistic view to silently snap back.

export interface DispatchRejection {
  cell: string;
  reason: string;
}

let _last: DispatchRejection | null = null;

/** Record why the current dispatch was refused (called by the reducer). */
export function setLastRejection(r: DispatchRejection): void {
  _last = r;
}

/** Clear at the start of every dispatch — a rejection belongs to exactly one. */
export function clearLastRejection(): void {
  _last = null;
}

/** Read-and-clear: the rejection of the dispatch that just ran, if any. */
export function takeLastRejection(): DispatchRejection | null {
  const r = _last;
  _last = null;
  return r;
}
