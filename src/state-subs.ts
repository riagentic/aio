/**
 * @module
 * Subscription path tracking for server-side state filtering.
 * Tracks accessed state paths and syncs them to the server via transport.
 */

// ── Module state ─────────────────────────────────────────────────────

/** Tracked state paths accessed by the current client — used for server subscription filtering. */
export const _accessedPaths: Set<string> = new Set<string>();
let _subsTimer: ReturnType<typeof setTimeout> | null = null;
let _currentSubs: string[] = [];

// Transport send function — injected to avoid circular dependency
let _sendFn: ((msg: string) => void) | null = null;

/** Inject the transport send function (called by state-transport.ts on setTransport). */
export function _setSubsSendFn(fn: ((msg: string) => void) | null): void {
  _sendFn = fn;
}

// ── Path collapsing ──────────────────────────────────────────────────

/** Collapse paths: if "a.b" and "a.b.c.d" both tracked, keep only "a.b" */
export function collapsePaths(paths: Set<string> | string[]): string[] {
  const arr = Array.isArray(paths) ? paths : [...paths];
  const sorted = [...arr].sort();
  const result: string[] = [];
  for (const path of sorted) {
    if (result.length > 0) {
      const last = result[result.length - 1];
      if (last === "*" || path.startsWith(last + ".")) continue;
    }
    result.push(path);
  }
  return result;
}

// ── Internal ─────────────────────────────────────────────────────────

function _sendSubsMessage(subs: string[]): void {
  if (!_sendFn) return;
  const msg = "__subs:" + JSON.stringify(subs);
  _sendFn(msg);
}

function _scheduleSyncSubs(): void {
  if (_subsTimer !== null) return;
  _subsTimer = setTimeout(() => {
    _subsTimer = null;
    if (_accessedPaths.size === 0) return;
    const collapsed = collapsePaths(_accessedPaths);
    if (
      collapsed.length !== _currentSubs.length ||
      collapsed.some((s, i) => s !== _currentSubs[i])
    ) {
      _currentSubs = collapsed;
      _sendSubsMessage(collapsed);
    }
  }, 16);
}

// ── Public API ───────────────────────────────────────────────────────

/** Cancel the pending subscription update timer. */
export function cancelSubsTimer(): void {
  if (_subsTimer !== null) {
    clearTimeout(_subsTimer);
    _subsTimer = null;
  }
}

/** Track a path for subscription syncing. */
export function trackPath(path: string): void {
  if (_accessedPaths.has(path)) return;
  _accessedPaths.add(path);
  _scheduleSyncSubs();
}

/** Re-send current subscription paths (call after reconnect). */
export function resendSubscriptions(): void {
  if (_currentSubs.length > 0) _sendSubsMessage(_currentSubs);
}

/** Reset subscription state (for test isolation). */
export function _resetSubs(): void {
  _accessedPaths.clear();
  _currentSubs = [];
  cancelSubsTimer();
}
