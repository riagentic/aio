// Expandable JSON tree — renders any value; objects/arrays collapse. A shared
// signal of expanded node paths drives it (click a node to toggle). Primitives
// are type-colored; large containers show a count when collapsed.
import { signal } from "aio/air";
import { C, mono } from "./style.ts";

const expanded = signal<Set<string>>(new Set([""]));

function toggle(path: string) {
  const next = new Set(expanded.value);
  next.has(path) ? next.delete(path) : next.add(path);
  expanded.set(next);
}

/** Reset expansion when switching to a fresh state root. */
export function resetTree() {
  expanded.set(new Set([""]));
}

function primitive(v: unknown) {
  if (v === null) return <span style={{ color: C.dim }}>null</span>;
  if (typeof v === "string") {
    return (
      <span style={{ color: C.green }}>
        "{v.length > 120 ? v.slice(0, 120) + "…" : v}"
      </span>
    );
  }
  if (typeof v === "number") {
    return <span style={{ color: C.blue }}>{String(v)}</span>;
  }
  if (typeof v === "boolean") {
    return <span style={{ color: C.purple }}>{String(v)}</span>;
  }
  return <span style={{ color: C.text2 }}>{String(v)}</span>;
}

function Node(
  { k, v, path, depth }: { k: string; v: unknown; path: string; depth: number },
) {
  const isObj = v !== null && typeof v === "object";
  const rowStyle: Record<string, string | number> = {
    fontFamily: mono,
    fontSize: "12px",
    lineHeight: "20px",
    paddingLeft: `${depth * 14}px`,
    whiteSpace: "nowrap",
  };
  if (!isObj) {
    return (
      <div style={rowStyle}>
        <span style={{ color: C.text2 }}>{k}</span>
        <span style={{ color: C.dim }}>:</span>
        {primitive(v)}
      </div>
    );
  }
  const allEntries = Array.isArray(v)
    ? (v as unknown[]).map((x, i) => [String(i), x] as [string, unknown])
    : Object.entries(v as Record<string, unknown>);
  // Breadth cap — a node with thousands of children would render thousands of
  // DOM rows and freeze the tab. Show the first CAP, then a "… N more" line.
  const CAP = 200;
  const entries = allEntries.slice(0, CAP);
  const hidden = allEntries.length - entries.length;
  const open = expanded.value.has(path);
  const brace = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
  return (
    <div>
      <div
        style={{ ...rowStyle, cursor: "pointer" }}
        onClick={() => toggle(path)}
      >
        <span style={{ color: C.dim, width: "12px", display: "inline-block" }}>
          {open ? "▾" : "▸"}
        </span>
        <span style={{ color: C.text2 }}>{k}</span>
        <span style={{ color: C.dim }}>
          : {brace[0]}
          {open ? "" : ` ${allEntries.length} ${brace[1]}`}
        </span>
      </div>
      {open &&
        entries.map(([ck, cv]) => (
          <Node
            key={ck}
            k={ck}
            v={cv}
            path={`${path}\u0000${ck}`}
            depth={depth + 1}
          />
        ))}
      {open && hidden > 0 && (
        <div
          style={{
            ...rowStyle,
            color: C.dim,
            paddingLeft: `${(depth + 1) * 14}px`,
          }}
        >
          … {hidden} more (capped)
        </div>
      )}
      {open && (
        <div style={{ ...rowStyle, color: C.dim, cursor: "default" }}>
          {brace[1]}
        </div>
      )}
    </div>
  );
}

export function JsonTree({ data }: { data: unknown }) {
  if (data === null || typeof data !== "object") {
    return (
      <div style={{ color: C.dim, fontFamily: mono, fontSize: "12px" }}>
        no state
      </div>
    );
  }
  const entries = Object.entries(data as Record<string, unknown>);
  return (
    <div style={{ overflowX: "auto" }}>
      {entries.map(([k, v]) => <Node key={k} k={k} v={v} path={k} depth={0} />)}
    </div>
  );
}
