import type { DiagEvent, VitalAlert } from "./types.ts";
import { formatDiagEvent } from "./diag-formatter.ts";

const THROTTLE_MS = 2000;

export type LoopSnapshot = {
  status: string;
  queueDepth: number;
  drainRate: number;
  lastReduceTime: number;
  lastReduceAction: string;
  lastReduceFeature: string;
  p95ReduceTime: number;
  effectBacklog: number;
  circuitBreakers: string[];
  firstDegradedAt: number | null;
};

export type TransportSnapshot = {
  clients: Array<{ id: string; status: string; frozenFor?: number }>;
  // Note: RTT is client-side only (transport-probe client). Server has no per-client RTT.
};

export type ServerDiagReporterConfig = {
  onDiagnostic?: (event: DiagEvent) => void;
  onConsole?: (lines: string[]) => void; // override for testing; defaults to console.warn
  getLoopSnapshot: () => LoopSnapshot;
  getTransportSnapshot: () => TransportSnapshot;
};

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

    if (alert.status === "healthy") return "recovered";

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
      detail.trigger = loop.lastReduceAction || loop.lastReduceFeature ||
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
      severity: hint?.severity ??
        (kind === "recovered" ? "speculative" : "possible"),
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

      // Always fire hook (no throttling)
      config.onDiagnostic?.(event);

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
