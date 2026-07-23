// Merged State overview — every cell's live state on one page, each top-level
// field badged with whether it's PERSISTED (survives restart → SQLite) and
// whether it's exposed to the UI (synced to browser clients). Nested values
// expand into a JSON tree on click.
import { signal } from "aio/air";
import { C, mono } from "./style.ts";
import { JsonTree } from "./json-tree.tsx";
import type { CellFieldFlags } from "../manager.ts";

const expanded = signal<Set<string>>(new Set());
export function resetStateView() {
  expanded.set(new Set());
}
function toggle(p: string) {
  const n = new Set(expanded.value);
  n.has(p) ? n.delete(p) : n.add(p);
  expanded.set(n);
}

function Badge(
  { on, label, color, title }: {
    on: boolean;
    label: string;
    color: string;
    title: string;
  },
) {
  return (
    <span
      title={title}
      style={{
        fontFamily: mono,
        fontSize: "9px",
        lineHeight: "14px",
        padding: "0 5px",
        borderRadius: "4px",
        border: `1px solid ${on ? color : C.border}`,
        color: on ? color : C.dim,
        background: on ? `${color}1e` : "transparent",
        opacity: on ? 1 : 0.45,
        userSelect: "none",
      }}
    >
      {label}
    </span>
  );
}

function preview(v: unknown): string {
  if (Array.isArray(v)) return `[] ${v.length}`;
  if (v && typeof v === "object") {
    return `{} ${Object.keys(v as object).length}`;
  }
  if (typeof v === "string") {
    return `"${v.length > 60 ? v.slice(0, 60) + "…" : v}"`;
  }
  return String(v);
}

function primColor(v: unknown): string {
  if (v === null) return C.dim;
  if (typeof v === "string") return C.green;
  if (typeof v === "number") return C.blue;
  if (typeof v === "boolean") return C.purple;
  return C.text2;
}

function Field(
  { cellId, k, v, flags }: {
    cellId: string;
    k: string;
    v: unknown;
    flags?: { persisted: boolean; ui: boolean };
  },
) {
  const isObj = v !== null && typeof v === "object";
  const path = `${cellId}.${k}`;
  const open = isObj && expanded.value.has(path);
  const persisted = flags?.persisted ?? true;
  const ui = flags?.ui ?? true;
  return (
    <div style={{ borderTop: `1px solid ${C.border}` }}>
      <div
        onClick={() => isObj && toggle(path)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "5px 10px",
          cursor: isObj ? "pointer" : "default",
          fontFamily: mono,
          fontSize: "12px",
        }}
      >
        <span
          style={{ display: "inline-flex", gap: "3px", flexShrink: 0 }}
        >
          <Badge
            on={persisted}
            label="disk"
            color={C.green}
            title={persisted
              ? "persisted — survives restart"
              : "not persisted — in-memory only"}
          />
          <Badge
            on={ui}
            label="ui"
            color={C.blue}
            title={ui ? "exposed to the UI (synced to clients)" : "server-only"}
          />
        </span>
        <span style={{ color: C.dim, width: "10px", flexShrink: 0 }}>
          {isObj ? (open ? "▾" : "▸") : ""}
        </span>
        <span style={{ color: C.text, fontWeight: 600 }}>{k}</span>
        <span
          style={{
            color: isObj ? C.dim : primColor(v),
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {open ? "" : preview(v)}
        </span>
      </div>
      {open && (
        <div style={{ padding: "0 10px 8px 40px" }}>
          <JsonTree data={v} />
        </div>
      )}
    </div>
  );
}

export function StateOverview(
  { state, fields }: { state: unknown; fields: CellFieldFlags | null },
) {
  if (state === null || typeof state !== "object") {
    return (
      <div style={{ color: C.dim, fontFamily: mono, fontSize: "12px" }}>
        no state
      </div>
    );
  }
  const cells = Object.entries(state as Record<string, unknown>);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
        <span style={{ color: C.dim, fontSize: "11px" }}>legend:</span>
        <Badge on label="disk" color={C.green} title="persisted to SQLite" />
        <span style={{ color: C.dim, fontSize: "11px" }}>persisted</span>
        <Badge on label="ui" color={C.blue} title="synced to clients" />
        <span style={{ color: C.dim, fontSize: "11px" }}>exposed to UI</span>
      </div>
      {cells.map(([cellId, cellState]) => {
        const cf = fields?.[cellId] ?? {};
        const entries = cellState && typeof cellState === "object"
          ? Object.entries(cellState as Record<string, unknown>)
          : [];
        const nPersist =
          entries.filter(([k]) => (cf[k]?.persisted ?? true)).length;
        const nUi = entries.filter(([k]) => (cf[k]?.ui ?? true)).length;
        return (
          <div
            key={cellId}
            style={{
              border: `1px solid ${C.border}`,
              borderRadius: "10px",
              overflow: "hidden",
              background: C.panel,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                padding: "8px 12px",
                background: C.panel2,
              }}
            >
              <span
                style={{ fontWeight: 700, color: C.blue, fontFamily: mono }}
              >
                {cellId}
              </span>
              <span style={{ color: C.dim, fontSize: "11px" }}>
                {entries.length} fields · {nPersist} persisted · {nUi} in UI
              </span>
            </div>
            {entries.length === 0
              ? (
                <div
                  style={{
                    padding: "8px 12px",
                    color: C.dim,
                    fontSize: "12px",
                  }}
                >
                  (empty)
                </div>
              )
              : entries.map(([k, v]) => (
                <Field key={k} cellId={cellId} k={k} v={v} flags={cf[k]} />
              ))}
          </div>
        );
      })}
    </div>
  );
}
