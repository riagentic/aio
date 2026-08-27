// ─── Vital Signs — Hint Engine ──────────────────────────────────────────────
// Pure functions: snapshot in → diagnostic hint out. No side effects.

import type { VitalHint, VitalsSnapshot, VitalThresholds } from "./types.ts";

/**
 * Classify hint severity based on evidence strength.
 */
export function classifySeverity(
  probeCount: number,
  hasDirectMeasurement: boolean,
  hasCrossProbeCorrelation: boolean,
): "likely" | "possible" | "speculative" {
  if (probeCount >= 2 && hasDirectMeasurement && hasCrossProbeCorrelation) {
    return "likely";
  }
  if (probeCount >= 1 && hasDirectMeasurement) return "possible";
  return "speculative";
}

/**
 * Evaluate a vitals snapshot against 7 pattern rules.
 * Returns a diagnostic hint or null (healthy / hidden window).
 *
 * WHICH RULES CAN FIRE WHERE. Every rule reading `snap.render` is CLIENT-side
 * only: the render probe is a browser measurement (`render-meter.ts`) and the
 * server's snapshot reports render as healthy because it has nothing to say,
 * not because it measured anything. So the server reaches rules 2 and 3; the
 * browser reaches all of them. (The comment here used to say "server-side:
 * rules 1-6", and the server's snapshot hardcoded transport healthy as well,
 * which left rule 2 alone reachable — including for the client-freeze alert
 * rule 3 was written for.)
 *
 * Rule priority (first match wins):
 *   #6  Visibility filter       → null (discard)
 *   #5  Recovery death spiral   → repeated freeze-recover
 *   #1  Slow reduce freeze      → reducer blocked main thread
 *   #2  Queue saturation        → dispatch backlog
 *   #3  Transport stall         → network issue, app healthy
 *   #4  Client-only freeze      → non-AIO code blocking
 *   #7  Re-render storm         → client-side only (>30 subscribe/sec, checked in browser.ts)
 */
export function evaluateHints(
  snap: VitalsSnapshot,
  thresholds: VitalThresholds,
): VitalHint | null {
  // Rule 6: Visibility filter — hidden tabs aren't real freezes
  if (snap.render.status === "frozen" && snap.render.visible === false) {
    return null;
  }

  // Rule 5: Recovery death spiral — repeated freeze-recover cycles
  if (
    snap.render.status === "recovered" &&
    (snap.render.previousFreezeCount ?? 0) > 1
  ) {
    return {
      cause:
        `Repeated freeze-recover cycle (${snap.render.previousFreezeCount} times)`,
      evidence: [
        `${snap.render.previousFreezeCount} freezes in last 30s`,
      ],
      suggestion:
        "If backpressure is off, enable it. If on, check for expensive onVitalAlert handlers or post-recovery reconciliation.",
      severity: "likely",
    };
  }

  // Rule 1: Slow reduce → render freeze
  if (
    snap.render.status === "frozen" &&
    snap.loop.lastReduceTime > thresholds.loop.degraded &&
    snap.loop.lastReduceAction === snap.render.lastActionBefore
  ) {
    return {
      cause:
        `Reducer for '${snap.loop.lastReduceCell}/${snap.loop.lastReduceAction}' took ${
          Math.round(snap.loop.lastReduceTime)
        }ms`,
      evidence: [
        `reduce took ${
          Math.round(snap.loop.lastReduceTime)
        }ms (budget: ${thresholds.loop.degraded}ms)`,
        `render frozen for ${Math.round(snap.render.measured)}ms`,
      ],
      suggestion: "Optimize the reduce, or split into smaller actions.",
      severity: classifySeverity(2, true, true),
    };
  }

  // Rule 2: Queue saturation — dispatch backlog overwhelming drain
  if (
    snap.loop.queueDepth > thresholds.queue.frozen &&
    snap.loop.firstDegradedAt !== null &&
    (snap.transport.firstDegradedAt === null ||
      snap.loop.firstDegradedAt < snap.transport.firstDegradedAt)
  ) {
    return {
      cause:
        `Dispatch queue backed up to ${snap.loop.queueDepth} actions, drain rate: ${snap.loop.drainRate}/s`,
      evidence: [
        `queue depth: ${snap.loop.queueDepth} (threshold: ${thresholds.queue.frozen})`,
        `top contributor: ${snap.loop.lastReduceCell}/${snap.loop.lastReduceAction}`,
      ],
      suggestion: "Debounce rapid-fire dispatches, or batch related actions.",
      severity: classifySeverity(2, true, true),
    };
  }

  // Rule 3: Transport stall — network issue, both app layers healthy
  if (
    snap.transport.status === "frozen" &&
    snap.render.status === "healthy" &&
    snap.loop.status === "healthy"
  ) {
    return {
      cause: `Network connection stalled. No pong in ${
        Math.round(snap.transport.measured)
      }ms`,
      evidence: [
        `transport frozen: ${
          Math.round(snap.transport.measured)
        }ms (threshold: ${thresholds.transport.frozen}ms)`,
      ],
      suggestion: "Check network stability. Auto-reconnect will trigger.",
      severity: classifySeverity(1, true, false),
    };
  }

  // Rule 4: Client-only freeze — no AIO action correlated
  if (
    snap.render.status === "frozen" &&
    snap.transport.status === "healthy" &&
    snap.loop.status === "healthy" &&
    snap.render.lastActionBefore === null
  ) {
    return {
      cause: "Main thread blocked by non-AIO code",
      evidence: [
        `render frozen: ${Math.round(snap.render.measured)}ms`,
        "no recent AIO action before freeze",
      ],
      suggestion:
        "Check third-party libraries, large DOM operations, synchronous I/O.",
      severity: "possible",
    };
  }

  // All healthy — no hint
  return null;
}
