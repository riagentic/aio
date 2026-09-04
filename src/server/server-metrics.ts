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
  /** Connected clients, BOTH transports — a desktop app's are all on the
   *  UDS socket, and this read 0 for that whole target. */
  clients?: number;
  /** Per-cell health: errors + enabled flag */
  cells?: Record<string, { errors: number; enabled: boolean }>;
  /** Broadcast payload stats, keyed by CONNECTION id. Summed into two
   *  unlabelled totals — the id is an identity, never a metric dimension. */
  /** Process-lifetime broadcast totals — see `formatPrometheus`'s use. */
  broadcastTotals?: { bytes: number; count: number };
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
/** The cells map inside whatever `getHealth` returned.
 *
 *  `ServerConfig.getHealth` is typed `() => unknown` and TWO shapes are
 *  accepted: the full health document (`{ status, version, pid, cells, … }`)
 *  and a bare cells map (a host that supplies its own). Telling them apart was
 *  a guess on a KEY NAME, and both spellings of that guess have been wrong:
 *
 *    • keyed on `cells` — a health document for an app with no composed cells
 *      has no `cells` key, so the document itself was read as the map and
 *      `status`/`version`/`pid` became cell rows;
 *    • keyed on `status` — a bare cells map for an app with a cell NAMED
 *      `status` (an entirely ordinary name) is read as a document, `doc.cells`
 *      is undefined, and EVERY cell row vanishes from the scrape. Silently: a
 *      Prometheus target with no cell series looks like an app with no cells.
 *
 *  So it is decided STRUCTURALLY instead, on the values rather than the names:
 *  a cells map's values are all cell rows (`{ enabled, errors }`), and a health
 *  document's top-level values — a string, a number, a nested object without
 *  those keys — never are. No cell name can fool it, because no cell name is
 *  consulted. */
export function healthCells(
  health: unknown,
): Record<string, { errors: number; enabled: boolean }> | undefined {
  if (!health || typeof health !== "object" || Array.isArray(health)) {
    return undefined;
  }
  const doc = health as Record<string, unknown>;
  // An explicit `cells` key is unambiguous — a cell may not be named `cells`
  // and hold a row at the same time, because a row is not a cells map.
  const inner = doc.cells;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, { errors: number; enabled: boolean }>;
  }
  const isRow = (v: unknown): boolean =>
    !!v && typeof v === "object" && !Array.isArray(v) &&
    "enabled" in (v as Record<string, unknown>) &&
    "errors" in (v as Record<string, unknown>);
  const entries = Object.entries(doc);
  // An EMPTY object is a document with no cells and a map with no cells at
  // once; both mean "no rows", so it needs no decision.
  if (entries.length > 0 && entries.every(([, v]) => isRow(v))) {
    return doc as Record<string, { errors: number; enabled: boolean }>;
  }
  return undefined;
}

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
    gauge("aio_clients_connected", "Connected clients (WS + UDS)", m.clients);
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

  if (m.broadcastTotals || (m.payloads && m.payloads.size > 0)) {
    // ONE unlabelled sum per metric.
    //
    // These carried `kind="<value>"`, and the value was `meta.id` — a
    // per-CONNECTION uuid, not a kind. Three things were wrong at once: the
    // label name and the HELP text described something the series did not
    // contain; every reconnect (including the dev reload socket's 2 s retry)
    // minted a brand-new Prometheus series, so a scraped `/__aio/metrics` grew
    // its time-series cardinality without bound; and the counter was unusable
    // anyway, because a series vanishes the moment its client disconnects —
    // a counter you cannot sum over time is not a counter.
    //
    // Per-client detail already exists, in `/__aio/vitals`, where it belongs:
    // it is a snapshot of who is connected right now, not a monotonic series.
    // …and MONOTONIC. Summing `payloads` was the fourth thing wrong: that map
    // is deleted per connection, so the counters reset to zero — and the whole
    // series disappeared — on every client disconnect. Every browser reload
    // and every dev-reload reconnect was a counter reset, which makes
    // `rate()`/`increase()` produce garbage. The process-lifetime accumulator
    // lives beside the per-connection map in `server-broadcast.ts`; the map
    // stays for `/__aio/vitals`, which asks a different question.
    let bytes = m.broadcastTotals?.bytes ?? 0;
    let count = m.broadcastTotals?.count ?? 0;
    if (!m.broadcastTotals && m.payloads) {
      for (const p of m.payloads.values()) {
        bytes += p.totalBytes;
        count += p.count;
      }
    }
    lines.push(
      "# HELP aio_broadcast_bytes_total Total broadcast payload bytes sent to clients",
    );
    lines.push("# TYPE aio_broadcast_bytes_total counter");
    lines.push(`aio_broadcast_bytes_total ${bytes}`);
    lines.push(
      "# HELP aio_broadcast_messages_total Total broadcast messages sent to clients",
    );
    lines.push("# TYPE aio_broadcast_messages_total counter");
    lines.push(`aio_broadcast_messages_total ${count}`);
  }

  return lines.join("\n") + "\n";
}
