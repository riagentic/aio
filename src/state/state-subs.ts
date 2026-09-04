import { enc } from "../protocol/envelope.ts";
import { log } from "../diagnostics/logger-api.ts";
/**
 * @module
 * Subscription path tracking for server-side state filtering.
 * Tracks accessed state paths and syncs them to the server via transport.
 */

// ── Module state ─────────────────────────────────────────────────────

/**
 * Tracked state paths accessed by the current client — used for server subscription filtering.
 * @internal Cross-module wiring — not public API, stripped from the snapshot.
 */
export const _accessedPaths: Set<string> = new Set<string>();
let _subsTimer: ReturnType<typeof setTimeout> | null = null;
let _currentSubs: string[] = [];

// Transport send function — injected to avoid circular dependency
let _sendFn: ((msg: string) => void) | null = null;

/** Failure-episode bookkeeping for {@linkcode _sendSubsMessage}: when the
 *  current run of refused writes began, and how many have been suppressed
 *  since the last line. Reset by the first send that succeeds. */
let _sendFailedAt = 0;
let _sendFailures = 0;
const SUBS_WARN_MS = 5000;

/** Inject the transport send function (called by state-transport.ts on setTransport). */
export function _setSubsSendFn(fn: ((msg: string) => void) | null): void {
  _sendFn = fn;
}

// ── Path collapsing ──────────────────────────────────────────────────

/** Collapse paths: if "a.b" and "a.b.c.d" both tracked, keep only "a.b"
 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
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

/** Write the `subs` frame. Returns whether it actually went out.
 *
 *  The transport here is the RAW socket send (`state-transport.ts` wires it to
 *  `transport.send`), and a WebSocket throws `InvalidStateError` on a send
 *  while it is CLOSING — the same "says OPEN and refuses the write" case the
 *  action path in `browser-air-transport.ts` already queues for. Reporting
 *  that honestly is what lets the caller avoid advancing `_currentSubs` past a
 *  frame the server never saw. */
type SubsSend = "sent" | "no-transport" | "refused";

function _sendSubsMessage(subs: string[]): SubsSend {
  // NOT the same as a refusal. With no transport installed there is nothing to
  // retry against and nothing wrong: `setTransport` → the reconnect path calls
  // `resendSubscriptions()`, which is exactly how a set collected before the
  // socket existed reaches the server. Collapsing the two cases would both
  // spin a 16 ms timer forever on a page that has not connected yet AND leave
  // `_currentSubs` empty, so that resend would have had nothing to send and
  // the connection would sit on the wildcard.
  if (!_sendFn) return "no-transport";
  try {
    _sendFn(enc("subs", { subs }));
    // A send that worked ends the episode — the next failure is news again.
    _sendFailedAt = 0;
    _sendFailures = 0;
    return "sent";
  } catch (e) {
    // Loud on the first, then at most one line every SUBS_WARN_MS with the
    // count. The retry below runs on the 16 ms timer, so warning on every
    // attempt would write ~60 lines a second, and a console nobody can read is
    // as silent as no console at all.
    const now = Date.now();
    if (_sendFailedAt === 0) {
      _sendFailedAt = now;
      _sendFailures = 1;
      log.warn(
        "subs",
        `the subscription frame could not be written (${e}) — this client is ` +
          `still subscribed to what the server last accepted, so cells ` +
          `outside it will not update. Retrying.`,
      );
    } else {
      _sendFailures++;
      if (now - _sendFailedAt >= SUBS_WARN_MS) {
        log.warn(
          "subs",
          `the subscription frame is still being refused after ` +
            `${_sendFailures} attempts over ${
              Math.round((now - _sendFailedAt) / 1000)
            }s — cells outside the server's last accepted subscription are ` +
            `not updating. Latest: ${e}`,
        );
        _sendFailedAt = now;
        _sendFailures = 0;
      }
    }
    return "refused";
  }
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
      // ADVANCE ONLY ON A SEND THAT HAPPENED.
      //
      // `_currentSubs` was assigned before the write, so a refused frame left
      // the client believing it had subscribed to a set the server never
      // received. Every later comparison then found "no change" and never
      // re-sent it: the server kept the OLD, narrower subscription, and every
      // cell outside it silently stopped updating for the life of that
      // connection — a UI that renders confidently stale data with nothing
      // logged. (Reconnect calls `resendSubscriptions`, so it healed if the
      // socket closed; a socket that refuses a write and stays open never
      // healed at all.)
      const outcome = _sendSubsMessage(collapsed);
      if (outcome === "refused") {
        // Do NOT advance: the server never saw this set. Nothing else will
        // re-trigger the send on its own — `_accessedPaths` is unchanged, so
        // no `trackPath` follows — so ask again.
        _scheduleSyncSubs();
      } else {
        // "sent" — the server has it. "no-transport" — record it anyway, so
        // the `resendSubscriptions()` that runs on connect has something to
        // send; that is the whole mechanism for a set collected before the
        // socket existed.
        _currentSubs = collapsed;
      }
    }
  }, 16);
}

// ── Public API ───────────────────────────────────────────────────────

/** Cancel the pending subscription update timer.
 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export function cancelSubsTimer(): void {
  if (_subsTimer !== null) {
    clearTimeout(_subsTimer);
    _subsTimer = null;
  }
}

/** Track a path for subscription syncing.
 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export function trackPath(path: string): void {
  if (_accessedPaths.has(path)) return;
  _accessedPaths.add(path);
  _scheduleSyncSubs();
}

/** Re-send current subscription paths (call after reconnect).
 *  @internal Engine/framework wiring (alpha52 sweep) — not public API.
 */
export function resendSubscriptions(): void {
  if (_currentSubs.length === 0) return;
  // A refusal here is retried on the shared timer, exactly as a first send is:
  // a reconnect that races the socket's readiness must not leave the server on
  // the wildcard forever.
  //
  // `_currentSubs` is cleared first, and it has to be: it means "what the
  // server last ACCEPTED", the timer only sends when the collapsed set differs
  // from it, and leaving it populated would make that comparison find no
  // change and retry nothing.
  if (_sendSubsMessage(_currentSubs) === "refused") {
    _currentSubs = [];
    _scheduleSyncSubs();
  }
}

/** Reset subscription state (for test isolation). */
export function _resetSubs(): void {
  _accessedPaths.clear();
  _currentSubs = [];
  _sendFailedAt = 0;
  _sendFailures = 0;
  cancelSubsTimer();
}
