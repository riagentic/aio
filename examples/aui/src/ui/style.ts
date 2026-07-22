// Shared design tokens — one dark, modern system. Tuned for calm density and
// clear status semantics (green=up, red=down/danger, blue=action).
export const C = {
  bg: "#0b0e14",
  bg2: "#0f131b",
  panel: "#151a23",
  panel2: "#1a212c",
  border: "#232b38",
  borderSoft: "#1c2430",
  text: "#e6edf3",
  text2: "#9aa7b8",
  dim: "#66738a",
  green: "#3fb950",
  greenDim: "#238636",
  red: "#f85149",
  redDim: "#8b2c28",
  yellow: "#d29922",
  blue: "#58a6ff",
  blueDim: "#1f6feb",
  purple: "#bc8cff",
};

export const mono =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export const card: Record<string, string | number> = {
  background: C.panel,
  border: `1px solid ${C.border}`,
  borderRadius: "10px",
};

export const btn: Record<string, string | number> = {
  padding: "7px 12px",
  borderRadius: "7px",
  border: `1px solid ${C.border}`,
  background: C.panel2,
  color: C.text,
  cursor: "pointer",
  fontSize: "13px",
  fontFamily: "inherit",
  transition: "background 0.12s, border-color 0.12s",
};

export const btnGhost: Record<string, string | number> = {
  ...btn,
  background: "transparent",
};

export const chip: Record<string, string | number> = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "11px",
  fontWeight: 600,
  lineHeight: "16px",
};

export const label: Record<string, string | number> = {
  color: C.dim,
  fontSize: "10px",
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

export function fmtUptime(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
