// Log viewer — tails the selected app's .aio/log (framework + app lines) or the
// combined stdout capture. No streaming endpoint exists in aio, so the manager
// re-reads the file on demand + on the follow poll; this is the presentation:
// source selector, level + text filters, colored lines. Filters are module
// signals (survive re-render, reset on project switch via resetLogView()).
import { signal } from "aio/air";
import type { LogLine, LogSource } from "../manager.ts";
import { btn, C, chip, mono } from "./style.ts";

const minLevel = signal<"all" | "info" | "warn" | "error">("all");
const logQuery = signal("");

export function resetLogView() {
  minLevel.set("all");
  logQuery.set("");
}

const LEVEL_RANK: Record<string, number> = {
  trace: 0,
  debug: 1,
  perf: 1,
  info: 2,
  warn: 3,
  error: 4,
};

const levelColor = (lvl: string): string => {
  switch (lvl) {
    case "error":
      return C.red;
    case "warn":
      return C.yellow;
    case "perf":
      return C.purple;
    case "info":
      return C.text2;
    case "debug":
    case "trace":
      return C.dim;
    default:
      return C.text2; // raw (unparsed) lines
  }
};

const SOURCES: { id: LogSource; label: string }[] = [
  { id: "combined", label: "Combined" },
  { id: "app", label: "Framework" },
  { id: "error", label: "Errors" },
  { id: "client", label: "Client" },
];

const LEVELS: { id: "all" | "info" | "warn" | "error"; label: string }[] = [
  { id: "all", label: "all" },
  { id: "info", label: "info+" },
  { id: "warn", label: "warn+" },
  { id: "error", label: "error" },
];

export function LogView(
  props: {
    logs: LogLine[] | null;
    loading: boolean;
    error: string | null;
    source: LogSource;
    path: string | null;
    truncated: boolean;
    follow: boolean;
    onReload: () => void;
    onSource: (s: LogSource) => void;
    onToggleFollow: () => void;
  },
) {
  const q = logQuery.value.trim().toLowerCase();
  const floor = minLevel.value;
  const floorRank = floor === "all" ? -1 : LEVEL_RANK[floor] ?? -1;
  const all = props.logs ?? [];
  const shown = all.filter((l) => {
    // Raw (unparsed) lines have no level → keep them unless a floor is set.
    if (floorRank >= 0) {
      const r = l.level ? LEVEL_RANK[l.level] ?? 2 : 2;
      if (r < floorRank) return false;
    }
    if (q && !l.raw.toLowerCase().includes(q)) return false;
    return true;
  });

  const pill = (on: boolean) => ({
    ...chip,
    cursor: "pointer",
    border: `1px solid ${on ? C.blue : C.border}`,
    color: on ? C.blue : C.dim,
    background: on ? "rgba(88,166,255,0.10)" : C.panel,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {/* toolbar */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", gap: "5px" }}>
          {SOURCES.map((s) => (
            <span
              key={s.id}
              onClick={() => props.onSource(s.id)}
              style={pill(props.source === s.id)}
            >
              {s.label}
            </span>
          ))}
        </div>
        <div style={{ display: "flex", gap: "5px", marginLeft: "6px" }}>
          {LEVELS.map((l) => (
            <span
              key={l.id}
              onClick={() => minLevel.set(l.id)}
              style={pill(floor === l.id)}
            >
              {l.label}
            </span>
          ))}
        </div>
        <input
          value={logQuery.value}
          onInput={(e: Event) =>
            logQuery.set((e.currentTarget as HTMLInputElement).value)}
          placeholder="filter…"
          style={{
            padding: "5px 9px",
            borderRadius: "6px",
            border: `1px solid ${C.border}`,
            background: C.panel,
            color: C.text,
            fontSize: "12px",
            fontFamily: mono,
            minWidth: "120px",
          }}
        />
        <button
          type="button"
          style={btn}
          disabled={props.loading}
          onClick={props.onReload}
        >
          {props.loading ? "…" : "⟳"}
        </button>
        <span
          onClick={props.onToggleFollow}
          style={{
            ...chip,
            cursor: "pointer",
            border: `1px solid ${props.follow ? C.green : C.border}`,
            color: props.follow ? C.green : C.dim,
            background: props.follow ? "rgba(63,185,80,0.10)" : C.panel,
          }}
        >
          {props.follow ? "● following" : "○ follow"}
        </span>
        <span
          style={{ marginLeft: "auto", color: C.dim, fontSize: "11px" }}
        >
          {shown.length}/{all.length} lines
          {props.truncated ? " · tail" : ""}
        </span>
      </div>

      {props.path && (
        <div style={{ color: C.dim, fontSize: "10px", fontFamily: mono }}>
          {props.path}
        </div>
      )}

      {props.error
        ? (
          <div style={{ color: C.yellow, fontSize: "13px", padding: "8px 0" }}>
            ⓘ {props.error}
          </div>
        )
        : (
          <div
            style={{
              background: C.bg,
              border: `1px solid ${C.border}`,
              borderRadius: "8px",
              padding: "8px 10px",
              maxHeight: "68vh",
              overflow: "auto",
              fontFamily: mono,
              fontSize: "11.5px",
              lineHeight: "1.5",
            }}
          >
            {shown.length === 0
              ? (
                <div style={{ color: C.dim, padding: "8px" }}>
                  {all.length ? "no lines match the filter" : "no log lines"}
                </div>
              )
              : shown.map((l, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    gap: "8px",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    padding: "0.5px 0",
                  }}
                >
                  {l.ts
                    ? (
                      <>
                        <span style={{ color: C.dim, flexShrink: 0 }}>
                          {l.ts.slice(11)}
                        </span>
                        <span
                          style={{
                            color: levelColor(l.level),
                            flexShrink: 0,
                            width: "38px",
                            fontWeight: 600,
                          }}
                        >
                          {l.level.toUpperCase()}
                        </span>
                        <span style={{ color: C.blue, flexShrink: 0 }}>
                          {l.scope}
                        </span>
                        <span style={{ color: levelColor(l.level) }}>
                          {l.msg}
                        </span>
                      </>
                    )
                    : <span style={{ color: C.text2 }}>{l.raw}</span>}
                </div>
              ))}
          </div>
        )}
    </div>
  );
}
