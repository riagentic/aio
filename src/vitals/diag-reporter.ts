import type { DiagEvent, VitalAlert } from "./types.ts";
import { formatDiagEvent } from "./diag-formatter.ts";

const THROTTLE_MS = 2000;

/** Point-in-time snapshot of the dispatch loop for diagnostic reporting. */
export type LoopSnapshot = {
  status: string;
  queueDepth: number;
  drainRate: number;
  lastReduceTime: number;
  lastReduceAction: string;
  lastReduceCell: string;
  p95ReduceTime: number;
  effectBacklog: number;
  circuitBreakers: string[];
  firstDegradedAt: number | null;
};

/** Point-in-time snapshot of connected client statuses for diagnostic reporting. */
export type TransportSnapshot = {
  clients: Array<{ id: string; status: string; frozenFor?: number }>;
  // Note: RTT is client-side only (transport-probe client). Server has no per-client RTT.
};

/** Configuration for the server-side diagnostic reporter — snapshot providers and output hooks. */
export type ServerDiagReporterConfig = {
  onDiagnostic?: (event: DiagEvent) => void;
  onConsole?: (lines: string[]) => void; // override for testing; defaults to console.warn
  getLoopSnapshot: () => LoopSnapshot;
  getTransportSnapshot: () => TransportSnapshot;
};

/** Create a server-side diagnostic reporter that maps vitals alerts to structured DiagEvents. */
export function createServerDiagReporter(config: ServerDiagReporterConfig) {
  const lastStatus = new Map<string, DiagEvent["kind"]>();
  const lastConsoleEmit = new Map<string, number>();

  const log = config.onConsole ?? ((lines: string[]) => {
    if (lines.length === 1) {
      console.warn(lines[0]);
    } else {
      console.group(lines[0]);
      for (let i = 1; i < lines.length; i++) console.warn(lines[i]);
      console.groupEnd();
    }
  });

  function mapAlertToKind(
    alert: VitalAlert,
    _loop: LoopSnapshot,
    transport: TransportSnapshot,
  ): DiagEvent["kind"] | null {
    // Priority (server): disconnect > stale > slow > recovered
    // (freeze is client-side only — not handled here)
    const frozenClients = transport.clients.filter((c) =>
      c.status === "frozen"
    );
    if (alert.layer === "transport" && frozenClients.length > 0) {
      return "disconnect";
    }

    // Stale: transport degraded/warning with clients behind.
    // Skip count enforcement happens upstream in the probe — by the time an alert fires,
    // the transport probe has already detected the degradation condition.
    const degradedClients = transport.clients.filter(
      (c) => c.status === "degraded" || c.status === "warning",
    );
    if (alert.layer === "transport" && degradedClients.length > 0) {
      return "stale";
    }

    if (
      alert.layer === "loop" &&
      (alert.status === "warning" || alert.status === "degraded" ||
        alert.status === "frozen")
    ) return "slow";

    // BOTH spellings. `VitalStatus` has "healthy" and "recovered", and the one
    // place that fires a recovery (`vitals/mod.ts` onClientRecovered) uses
    // "recovered" — so matching only "healthy" meant every recovery event fell
    // through to `null` and never reached the console or `onDiagnostic`. The
    // reporter has a recovered branch and dedup logic for events it could not
    // receive. Recovery is the event the fail-loud ethos most needs to surface,
    // and it was the one that went quiet.
    if (alert.status === "healthy" || alert.status === "recovered") {
      return "recovered";
    }

    return null;
  }

  function buildEvent(
    kind: DiagEvent["kind"],
    alert: VitalAlert,
    loop: LoopSnapshot,
    transport: TransportSnapshot,
  ): DiagEvent {
    const detail: DiagEvent["detail"] = {};
    const hint = alert.hint;

    if (kind === "slow") {
      detail.trigger = loop.lastReduceAction || loop.lastReduceCell ||
        undefined;
      detail.reduceMs = loop.lastReduceTime;
      detail.p95Ms = loop.p95ReduceTime;
      detail.queueDepth = loop.queueDepth;
      detail.drainRate = loop.drainRate;
      detail.hint = hint?.suggestion;
    } else if (kind === "disconnect") {
      const frozen = transport.clients.find((c) => c.status === "frozen");
      detail.frozenFor = frozen?.frozenFor;
      detail.hint = hint?.suggestion ??
        "client unreachable — check network or process";
    } else if (kind === "stale") {
      // RTT not available server-side — only transport status
      detail.p95Ms = loop.p95ReduceTime;
      detail.hint = hint?.suggestion ??
        "network latency spike — check connection";
    } else if (kind === "recovered") {
      detail.hint = undefined;
    }

    const summaries: Record<string, string> = {
      slow: `SLOW DISPATCH — ${detail.trigger ?? "unknown"} took ${
        detail.reduceMs ?? "?"
      }ms (budget: ${alert.threshold}ms)`,
      disconnect: `DISCONNECTED — client unreachable for ${
        ((detail.frozenFor ?? 0) / 1000).toFixed(1)
      }s`,
      stale: `STALE STATE — client degraded, dispatch p95 ${
        detail.p95Ms ?? "?"
      }ms`,
      recovered: `${alert.layer} recovered`,
    };

    return {
      kind,
      // Recovery events are always speculative — they must not inherit the
      // original alert's severity (e.g. "likely") via the hint fallback.
      severity: kind === "recovered"
        ? "speculative"
        : (hint?.severity ?? "possible"),
      summary: summaries[kind] ?? kind,
      detail,
      timestamp: alert.ts,
    };
  }

  return {
    onAlert(alert: VitalAlert) {
      const loop = config.getLoopSnapshot();
      const transport = config.getTransportSnapshot();
      const kind = mapAlertToKind(alert, loop, transport);
      if (!kind) return;

      // Recovery deduplication
      const key = alert.layer;
      const prevKind = lastStatus.get(key);
      if (kind === "recovered") {
        if (!prevKind || prevKind === "recovered") return; // no prior degradation
        lastStatus.set(key, "recovered");
      } else {
        lastStatus.set(key, kind);
      }

      const event = buildEvent(kind, alert, loop, transport);

      // Always fire hook (no throttling). Guarded: this runs from a timer,
      // so a throwing user hook would otherwise take the process down.
      try {
        config.onDiagnostic?.(event);
      } catch (e) {
        console.error(`[aio:vitals] onDiagnostic hook threw — ${e}`);
      }

      // Console throttling
      const throttleKey = `${kind}:${event.detail.trigger ?? ""}`;
      const now = Date.now();
      const lastEmit = lastConsoleEmit.get(throttleKey) ?? 0;
      if (now - lastEmit >= THROTTLE_MS) {
        lastConsoleEmit.set(throttleKey, now);
        log(formatDiagEvent(event));
      }
    },
    /** Expose for testing */
    _lastStatus: lastStatus,
  };
}
