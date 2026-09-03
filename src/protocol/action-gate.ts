// action-gate.ts — THE rule for "may a network peer name this action?"
//
// Framework-internal action types (`__setX`, `__exec`, `__error`, `__flow`,
// `cell:__…`) are dispatched only by server-side machinery: `__set*` writes
// arbitrary paths straight through `applyMutations`, so a client that can name
// one can write any field of any cell. Every network entry point refuses them
// — WS `action`, WS `op`, UDS `action`, UDS `op`, the trojan POST — and the
// sync path refuses them INSIDE its op validator (`isValidSyncOp`), so the
// `sync-req.pendingOps` door, which carries a reconnect's whole offline queue
// and is reached from WS AND UDS, cannot fall through. That door did: the ws
// and uds routers gated `op` frames but forwarded `pendingOps` unchecked, and
// a `cell:__setRefresh` in the queue was applied, persisted, acked, broadcast
// and replayed at boot.
//
// It lives in protocol/ (a leaf the boundary matrix lets every folder read)
// so there is ONE spelling: a second copy of this predicate is a second
// decider, and two deciders disagree exactly where it matters.

/** Action types that may only be dispatched from server-internal code paths.
 *  Match either a top-level `__name` or a cell-prefixed `cell:__name` form. */
export function _isFrameworkInternalActionType(type: string): boolean {
  if (type.startsWith("__")) return true;
  const colon = type.indexOf(":");
  if (colon === -1) return false;
  return type.charCodeAt(colon + 1) === 0x5f /* "_" */ &&
    type.charCodeAt(colon + 2) === 0x5f;
}
