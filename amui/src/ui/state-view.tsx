// Merged State overview — every cell's live state on one page, each top-level
// field badged with whether it's PERSISTED (survives restart → SQLite) and
// whether it's exposed to the UI (synced to browser clients). Nested values
// expand into a JSON tree on click.
import { signal } from "aio/air";
import { C, fmtBytes, mono, press } from "./style.ts";
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

/** The JSON-encoded size of a value — the bytes the wire carries and SQLite
 *  stores for it, not V8's in-memory footprint. `-1` when it cannot be
 *  encoded at all (a BigInt, a cycle): that is a fact worth showing, since
 *  the framework refuses to persist or sync exactly those values. */
export function sizeOf(v: unknown): number {
  try {
    const json = JSON.stringify(v);
    return json === undefined ? 0 : new TextEncoder().encode(json).length;
  } catch {
    return -1;
  }
}

/** A slim bar plus the number, right-aligned — the bar is relative to `max`
 *  (the largest sibling), so within one cell the eye finds the heavy field
 *  without reading every number. */
function SizeBar(
  { bytes, max, color, what }: {
    bytes: number;
    max: number;
    color: string;
    what: string;
  },
) {
  const pct = bytes < 0 || max <= 0
    ? 0
    : Math.max(2, Math.round((bytes / max) * 100));
  const text = bytes < 0 ? "unserializable" : fmtBytes(bytes);
  return (
    <span
      title={`${what}: ${text} as JSON — what the wire and SQLite carry`}
      style={{
        marginLeft: "auto",
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: "64px",
          height: "4px",
          borderRadius: "2px",
          background: C.panel2,
          overflow: "hidden",
        }}
      >
        <span
          style={{
            display: "block",
            width: `${pct}%`,
            height: "100%",
            background: bytes < 0 ? C.red : color,
          }}
        />
      </span>
      <span
        style={{
          color: bytes < 0 ? C.red : C.dim,
          fontSize: "11px",
          fontFamily: mono,
          minWidth: "60px",
          textAlign: "right",
        }}
      >
        {text}
      </span>
    </span>
  );
}

function primColor(v: unknown): string {
  if (v === null) return C.dim;
  if (typeof v === "string") return C.green;
  if (typeof v === "number") return C.blue;
  if (typeof v === "boolean") return C.purple;
  return C.text2;
}

function Field(
  { cellId, k, v, flags, bytes, max }: {
    cellId: string;
    k: string;
    v: unknown;
    flags?: { persisted: boolean; ui: boolean };
    /** JSON size of `v`, and the largest field in the same cell. */
    bytes: number;
    max: number;
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
        {...(isObj ? press(() => toggle(path)) : {})}
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
            flex: "1",
            minWidth: "0",
          }}
        >
          {open ? "" : preview(v)}
        </span>
        <SizeBar bytes={bytes} max={max} color={C.blueDim} what={k} />
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
  // Per-field sizes, once per render: a field's JSON is encoded a single
  // time and each bar is scaled against its siblings in the same cell, so the
  // heavy field in a cell is found by eye. (Per-CELL totals live on the
  // Metrics tab already — not repeated here.)
  const sized = cells.map(([cellId, cellState]) => {
    const entries = cellState && typeof cellState === "object"
      ? Object.entries(cellState as Record<string, unknown>)
      : [];
    const fieldBytes = entries.map(([, v]) => sizeOf(v));
    return {
      cellId,
      entries,
      fieldBytes,
      maxField: Math.max(0, ...fieldBytes),
    };
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
        <span style={{ color: C.dim, fontSize: "11px" }}>legend:</span>
        <Badge on label="disk" color={C.green} title="persisted to SQLite" />
        <span style={{ color: C.dim, fontSize: "11px" }}>persisted</span>
        <Badge on label="ui" color={C.blue} title="synced to clients" />
        <span style={{ color: C.dim, fontSize: "11px" }}>exposed to UI</span>
      </div>
      {sized.map(({ cellId, entries, fieldBytes, maxField }) => {
        const cf = fields?.[cellId] ?? {};
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
              : entries.map(([k, v], i) => (
                <Field
                  key={k}
                  cellId={cellId}
                  k={k}
                  v={v}
                  flags={cf[k]}
                  bytes={fieldBytes[i] ?? 0}
                  max={maxField}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}
