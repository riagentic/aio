// Metric charts — dependency-free inline SVG. AreaChart draws a filled
// sparkline-style trend; current value + peak surface as text. SVG-specific
// attributes are passed via a spread cast (AIO's JSX types cover HTML, not SVG).
import { C, label, mono } from "./style.ts";

// deno-lint-ignore no-explicit-any
const svgAttrs = (o: Record<string, string | number>): any => o;

export function AreaChart(
  { title, values, unit, color }: {
    title: string;
    values: number[];
    unit: string;
    color: string;
  },
) {
  const W = 420, H = 90, P = 4;
  const n = values.length;
  const cur = n ? values[n - 1]! : 0;
  const peak = n ? Math.max(...values) : 0;
  const avg = n ? values.reduce((a, b) => a + b, 0) / n : 0;
  const ceil = Math.max(peak * 1.15, unit === "%" ? 10 : 1);
  const toX = (i: number) => n <= 1 ? W - P : P + (i / (n - 1)) * (W - 2 * P);
  const toY = (v: number) => H - P - (v / ceil) * (H - 2 * P);

  const pts = values.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`);
  const line = pts.length ? `M${pts.join(" L")}` : "";
  const area = pts.length
    ? `${line} L${toX(n - 1).toFixed(1)},${H - P} L${toX(0).toFixed(1)},${
      H - P
    } Z`
    : "";
  const fmt = (v: number) => v.toFixed(unit === "%" ? 1 : 0);
  // 3 horizontal gridlines (25/50/75% of the ceiling) for scale.
  const grid = [0.25, 0.5, 0.75].map((f) => toY(ceil * f));

  return (
    <div
      style={{
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: "10px",
        padding: "12px 14px",
        flex: "1",
        minWidth: "0",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <span style={label}>{title}</span>
        <span
          style={{ fontFamily: mono, fontSize: "18px", color, fontWeight: 700 }}
        >
          {n ? cur.toFixed(unit === "%" ? 1 : 0) : "—"}
          <span style={{ fontSize: "11px", color: C.dim }}>{` ${unit}`}</span>
        </span>
      </div>
      <svg
        {...svgAttrs({ viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" })}
        style={{
          width: "100%",
          height: "70px",
          marginTop: "6px",
          display: "block",
        }}
      >
        {grid.map((y, i) => (
          <line
            key={i}
            {...svgAttrs({
              x1: P,
              y1: y,
              x2: W - P,
              y2: y,
              stroke: C.border,
              "stroke-width": "0.5",
              "stroke-dasharray": "2 3",
            })}
          />
        ))}
        {area && (
          <path
            {...svgAttrs({ d: area, fill: color, "fill-opacity": "0.16" })}
          />
        )}
        {line && (
          <path
            {...svgAttrs({
              d: line,
              fill: "none",
              stroke: color,
              "stroke-width": "1.6",
              "stroke-linejoin": "round",
            })}
          />
        )}
        {n > 0 && (
          <circle
            {...svgAttrs({
              cx: toX(n - 1),
              cy: toY(cur),
              r: 2.4,
              fill: color,
            })}
          />
        )}
      </svg>
      <div style={{ fontSize: "10px", color: C.dim, fontFamily: mono }}>
        {n ? `peak ${fmt(peak)} · avg ${fmt(avg)} ${unit} · ${n} samples` : "—"}
      </div>
    </div>
  );
}
