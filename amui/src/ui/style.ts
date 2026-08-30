import { bytes, dur } from "aio";

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
  boxShadow: "0 1px 2px rgba(0,0,0,0.28)",
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

/** Uptime for a tile — the framework's ONE duration spelling (`aio`),
 *  with the UI's own answer for "not known yet". The arithmetic used to live
 *  here as a fourth private copy that disagreed with the logger's. */
export function fmtUptime(sec: number | null): string {
  return sec === null ? "—" : dur(sec * 1000);
}

/** A byte size for a tile — the framework's ONE spelling (`aio`), with
 *  the UI's own answer for "not known yet". */
export function fmtBytes(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : bytes(n);
}
