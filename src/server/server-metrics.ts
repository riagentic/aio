// server-metrics.ts — GET /__aio/metrics in Prometheus/OpenMetrics text
// format. Production monitoring for supervised deployments: uptime, memory,
// connected clients, per-cell health, and broadcast payload stats — assembled
// from data the server already tracks (zero new bookkeeping).

/** Input snapshot for {@linkcode formatPrometheus} — everything optional so
 *  the endpoint degrades gracefully when a subsystem is off. */
export interface MetricsInput {
  /** Seconds since server start */
  uptimeSeconds: number;
  /** Deno.memoryUsage() snapshot */
  memory?: { rss: number; heapTotal: number; heapUsed: number };
  /** Connected WS client count */
  clients?: number;
  /** Per-cell health: errors + enabled flag */
  cells?: Record<string, { errors: number; enabled: boolean }>;
  /** Broadcast payload stats per kind */
  payloads?: Map<
    string,
    { lastPayloadBytes: number; totalBytes: number; count: number }
  >;
}

function esc(label: string): string {
  return label.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "");
}

/** Render a metrics snapshot as Prometheus text exposition format. Pure —
 *  unit-testable without a server. */
export function formatPrometheus(m: MetricsInput): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, value: number, labels = "") => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name}${labels} ${value}`);
  };

  gauge(
    "aio_uptime_seconds",
    "Seconds since the server started",
    m.uptimeSeconds,
  );

  if (m.memory) {
    gauge("aio_memory_rss_bytes", "Resident set size", m.memory.rss);
    gauge("aio_memory_heap_total_bytes", "V8 heap total", m.memory.heapTotal);
    gauge("aio_memory_heap_used_bytes", "V8 heap used", m.memory.heapUsed);
  }

  if (m.clients !== undefined) {
    gauge("aio_clients_connected", "Connected WebSocket clients", m.clients);
  }

  if (m.cells && Object.keys(m.cells).length > 0) {
    lines.push("# HELP aio_cell_errors_total Errors observed per cell");
    lines.push("# TYPE aio_cell_errors_total counter");
    for (const [cell, h] of Object.entries(m.cells)) {
      lines.push(`aio_cell_errors_total{cell="${esc(cell)}"} ${h.errors}`);
    }
    lines.push("# HELP aio_cell_enabled Cell enabled flag (1 = enabled)");
    lines.push("# TYPE aio_cell_enabled gauge");
    for (const [cell, h] of Object.entries(m.cells)) {
      lines.push(`aio_cell_enabled{cell="${esc(cell)}"} ${h.enabled ? 1 : 0}`);
    }
  }

  if (m.payloads && m.payloads.size > 0) {
    lines.push(
      "# HELP aio_broadcast_bytes_total Total broadcast payload bytes per kind",
    );
    lines.push("# TYPE aio_broadcast_bytes_total counter");
    for (const [kind, p] of m.payloads) {
      lines.push(
        `aio_broadcast_bytes_total{kind="${esc(kind)}"} ${p.totalBytes}`,
      );
    }
    lines.push(
      "# HELP aio_broadcast_messages_total Broadcast message count per kind",
    );
    lines.push("# TYPE aio_broadcast_messages_total counter");
    for (const [kind, p] of m.payloads) {
      lines.push(
        `aio_broadcast_messages_total{kind="${esc(kind)}"} ${p.count}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}
