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
      </svg>
      <div style={{ fontSize: "10px", color: C.dim, fontFamily: mono }}>
        peak {n ? peak.toFixed(unit === "%" ? 1 : 0) : "—"} {unit} · {n} samples
      </div>
    </div>
  );
}
