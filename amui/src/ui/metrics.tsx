// Metrics panel — mines the app's /__aio/vitals + /__aio/metrics + trojan
// history into one monitoring surface: trend charts, the dispatch-loop pulse,
// per-client transport + payload, per-cell state sizes, and the live action
// stream (how state is actually being processed). Pure/presentational — all
// data arrives as props (testable, SSR-safe).
import type { ActionEntry, AppVitals, ClientRow, MemInfo } from "../manager.ts";
import { AreaChart } from "./charts.tsx";
import { C, card, fmtBytes, label, mono } from "./style.ts";

const gaugeColor = (pct: number): string =>
  pct >= 80 ? C.red : pct >= 50 ? C.yellow : C.green;

/** A labeled horizontal gauge (current / capacity, colored by fill). */
function Gauge(
  { name, current, capacity, percent, unit }: {
    name: string;
    current: number;
    capacity: number;
    percent: number;
    unit?: string;
  },
) {
  // Defensive: a gauge object from a foreign/older aio version may be partial.
  const num = (x: unknown): number =>
    (typeof x === "number" && isFinite(x)) ? x : 0;
  const cur = num(current);
  const pct = Math.max(0, Math.min(100, num(percent)));
  const col = gaugeColor(pct);
  return (
    <div style={{ marginBottom: "8px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "11px",
          fontFamily: mono,
          marginBottom: "3px",
        }}
      >
        <span style={{ color: C.text2 }}>{name}</span>
        <span style={{ color: col }}>
          {cur.toFixed(cur < 10 ? 2 : 0)}
          {unit ? ` ${unit}` : ""}{" "}
          <span style={{ color: C.dim }}>/ {num(capacity)}</span>
        </span>
      </div>
      <div
        style={{
          height: "5px",
          borderRadius: "3px",
          background: C.panel2,
          overflow: "hidden",
        }}
      >
        <div
          style={{ width: `${pct}%`, height: "100%", background: col }}
        />
      </div>
    </div>
  );
}

function Stat({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "3px 0",
        fontSize: "12px",
        fontFamily: mono,
      }}
    >
      <span style={{ color: C.dim }}>{k}</span>
      <span style={{ color: color ?? C.text2, textAlign: "right" }}>{v}</span>
    </div>
  );
}

function Card(
  { title, right, children }: {
    title: string;
    right?: unknown;
    children: unknown;
  },
) {
  return (
    <div
      style={{ ...card, padding: "12px 14px", flex: "1", minWidth: "280px" }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: "8px",
        }}
      >
        <span style={label}>{title}</span>
        {right as never}
      </div>
      {children as never}
    </div>
  );
}

const readyStateName = (rs?: number): string =>
  rs === 1
    ? "open"
    : rs === 0
    ? "connecting"
    : rs === 2
    ? "closing"
    : rs === 3
    ? "closed"
    : "—";

const statusColor = (st: string): string =>
  st === "healthy" || st === "recovered"
    ? C.green
    : st === "frozen"
    ? C.red
    : st === "warning" || st === "degraded"
    ? C.yellow
    : C.text2;

export function MetricsPanel(
  props: {
    vitals: AppVitals | null;
    mem: MemInfo | null;
    clients: ClientRow[] | null;
    history: ActionEntry[] | null;
    cpu: number[];
    memMb: number[];
    heap: number[];
    reduce: number[];
    queue: number[];
    connections: number | null;
  },
) {
  const { vitals, mem, clients, history } = props;
  const loop = vitals?.loop;
  const gauges = vitals?.gauges ?? {};
  const payload = vitals?.payloadStats ?? {};
  const backpressure = vitals?.clientBackpressure ?? {};
  // vitals reports per-client health (healthy/frozen/…), keyed by id — merge it
  // onto the richer trojan client rows (transport/user/readyState).
  const vHealth = new Map(
    (vitals?.clients ?? []).map((c) => [c.id, c]),
  );
  const cellSizes = Object.entries(vitals?.cellSizes ?? {})
    .sort((a, b) => b[1] - a[1]);
  const maxCell = cellSizes.length ? cellSizes[0]![1] : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {/* ── trend charts ── */}
      <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
        <AreaChart title="CPU" values={props.cpu} unit="%" color={C.green} />
        <AreaChart
          title="Memory (RSS)"
          values={props.memMb}
          unit="MB"
          color={C.blue}
        />
        <AreaChart
          title="Heap used"
          values={props.heap}
          unit="MB"
          color={C.purple}
        />
        <AreaChart
          title="Reduce p95"
          values={props.reduce}
          unit="ms"
          color={C.yellow}
        />
        <AreaChart
          title="Queue depth"
          values={props.queue}
          unit=""
          color={C.blue}
        />
      </div>

      <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
        {/* ── dispatch loop ── */}
        <Card title="dispatch loop">
          {loop
            ? (
              <>
                {gauges["server.queueDepth"] && (
                  <Gauge {...gauges["server.queueDepth"]} name="queue depth" />
                )}
                {gauges["server.reduceTime"] && (
                  <Gauge
                    {...gauges["server.reduceTime"]}
                    name="reduce time"
                    unit="ms"
                  />
                )}
                <Stat k="drain rate" v={`${loop.drainRate.toFixed(1)} /s`} />
                <Stat
                  k="p95 reduce"
                  v={`${loop.p95ReduceTime.toFixed(2)} ms`}
                />
                <Stat
                  k="last reduce"
                  v={`${loop.lastReduceTime.toFixed(2)} ms`}
                />
                <Stat
                  k="effect backlog"
                  v={String(loop.effectBacklog)}
                  color={loop.effectBacklog > 0 ? C.yellow : C.text2}
                />
                <Stat
                  k="last action"
                  v={loop.lastReduceAction ?? "—"}
                  color={C.blue}
                />
                <Stat
                  k="circuit breakers"
                  v={loop.circuitBreakers.length
                    ? loop.circuitBreakers.join(", ")
                    : "none"}
                  color={loop.circuitBreakers.length ? C.red : C.green}
                />
              </>
            )
            : <div style={{ color: C.dim, fontSize: "12px" }}>no vitals</div>}
        </Card>

        {/* ── memory ── */}
        <Card title="memory">
          {mem
            ? (
              <>
                <Stat k="rss" v={fmtBytes(mem.rss)} />
                <Stat
                  k="heap used"
                  v={fmtBytes(mem.heapUsed)}
                  color={C.purple}
                />
                <Stat k="heap total" v={fmtBytes(mem.heapTotal)} />
                <Stat
                  k="heap fill"
                  v={mem.heapTotal
                    ? `${((mem.heapUsed / mem.heapTotal) * 100).toFixed(0)}%`
                    : "—"}
                  color={gaugeColor(
                    mem.heapTotal ? (mem.heapUsed / mem.heapTotal) * 100 : 0,
                  )}
                />
                <Stat k="connections" v={String(props.connections ?? "—")} />
              </>
            )
            : (
              <div style={{ color: C.dim, fontSize: "12px" }}>
                no memory metrics
              </div>
            )}
        </Card>
      </div>

      {/* ── clients (transport + backpressure + payload) ── */}
      <Card
        title={`clients (${clients?.length ?? 0})`}
      >
        {clients && clients.length
          ? (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontFamily: mono,
                  fontSize: "11px",
                }}
              >
                <thead>
                  <tr style={{ color: C.dim, textAlign: "left" }}>
                    <th style={{ padding: "3px 8px 3px 0" }}>id</th>
                    <th style={{ padding: "3px 8px" }}>health</th>
                    <th style={{ padding: "3px 8px" }}>transport</th>
                    <th style={{ padding: "3px 8px" }}>state</th>
                    <th style={{ padding: "3px 8px" }}>user</th>
                    <th style={{ padding: "3px 8px" }}>bytes/s</th>
                    <th style={{ padding: "3px 8px" }}>total</th>
                    <th style={{ padding: "3px 0 3px 8px" }}>bp</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => {
                    const ps = payload[c.id];
                    const bp = backpressure[c.id] ?? 1;
                    const vh = vHealth.get(c.id);
                    return (
                      <tr
                        key={c.index}
                        style={{ borderTop: `1px solid ${C.borderSoft}` }}
                      >
                        <td
                          style={{ padding: "3px 8px 3px 0", color: C.text2 }}
                        >
                          {c.id}
                        </td>
                        <td
                          style={{
                            padding: "3px 8px",
                            color: vh ? statusColor(vh.status) : C.dim,
                          }}
                          title={vh?.frozenFor
                            ? `frozen ${(vh.frozenFor / 1000).toFixed(1)}s`
                            : undefined}
                        >
                          {vh ? vh.status : "—"}
                        </td>
                        <td style={{ padding: "3px 8px", color: C.text2 }}>
                          {c.transport}
                        </td>
                        <td style={{ padding: "3px 8px", color: C.text2 }}>
                          {readyStateName(c.readyState)}
                        </td>
                        <td style={{ padding: "3px 8px", color: C.dim }}>
                          {c.user ?? "—"}
                        </td>
                        <td style={{ padding: "3px 8px", color: C.text2 }}>
                          {ps ? `${fmtBytes(ps.bytesPerSec)}/s` : "—"}
                        </td>
                        <td style={{ padding: "3px 8px", color: C.dim }}>
                          {ps ? fmtBytes(ps.totalBytes) : "—"}
                        </td>
                        <td
                          style={{
                            padding: "3px 0 3px 8px",
                            color: bp > 1 ? C.yellow : C.dim,
                          }}
                        >
                          {bp > 1 ? `${bp.toFixed(1)}×` : "1×"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
          : (
            <div style={{ color: C.dim, fontSize: "12px" }}>
              no clients connected
            </div>
          )}
      </Card>

      <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
        {/* ── per-cell state sizes ── */}
        <Card title={`cell state sizes (${cellSizes.length})`}>
          {cellSizes.length
            ? cellSizes.map(([name, bytes]) => (
              <div key={name} style={{ marginBottom: "6px" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "11px",
                    fontFamily: mono,
                    marginBottom: "2px",
                  }}
                >
                  <span style={{ color: C.blue }}>{name}</span>
                  <span style={{ color: C.text2 }}>{fmtBytes(bytes)}</span>
                </div>
                <div
                  style={{
                    height: "4px",
                    borderRadius: "2px",
                    background: C.panel2,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${maxCell ? (bytes / maxCell) * 100 : 0}%`,
                      height: "100%",
                      background: C.blueDim,
                    }}
                  />
                </div>
              </div>
            ))
            : <div style={{ color: C.dim, fontSize: "12px" }}>no data</div>}
        </Card>

        {/* ── live action stream ── */}
        <Card title={`recent actions (${history?.length ?? 0})`}>
          {history && history.length
            ? (
              <div style={{ maxHeight: "260px", overflowY: "auto" }}>
                {[...history].reverse().map((a) => (
                  <div
                    key={a.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "8px",
                      padding: "2px 0",
                      fontSize: "11px",
                      fontFamily: mono,
                      borderBottom: `1px solid ${C.borderSoft}`,
                    }}
                  >
                    <span
                      style={{
                        color: a.error ? C.red : C.text2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={a.error ? a.error.message : a.type}
                    >
                      {a.error ? "✗ " : ""}
                      {a.type}
                    </span>
                    <span style={{ color: C.dim, flexShrink: 0 }}>
                      {a.perf?.reduce !== undefined
                        ? `${a.perf.reduce.toFixed(2)} ms`
                        : ""}
                    </span>
                  </div>
                ))}
              </div>
            )
            : (
              <div style={{ color: C.dim, fontSize: "12px" }}>
                no actions recorded yet
              </div>
            )}
        </Card>
      </div>

      <div style={{ color: C.dim, fontSize: "11px" }}>
        Sampled live every ~2.5s while this app is selected · charts keep the
        last 60 samples.
      </div>
    </div>
  );
}
