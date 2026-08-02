// UI — reads cell state reactively, calls cell methods. No transport code,
// no loading-state plumbing: `disk.scanning` IS the spinner.
import { disk, type Entry } from "./cell.ts";

const KB = 1024;
function human(bytes: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes, i = 0;
  while (n >= KB && i < u.length - 1) (n /= KB, i++);
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

const row: Record<string, string> = {
  display: "grid",
  gridTemplateColumns: "1fr 6rem 5rem",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.4rem 0.6rem",
  borderRadius: "6px",
};

function Row({ entry, largest }: { entry: Entry; largest: number }) {
  const pct = largest > 0 ? Math.max(2, (entry.bytes / largest) * 100) : 0;
  return (
    <div style={row}>
      <div style={{ minWidth: 0 }}>
        <div
          t={`open-${entry.name}`}
          onClick={() => disk.open(entry.path)}
          style={{
            cursor: "pointer",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {entry.name}
        </div>
        <div
          style={{ height: "4px", background: "#e6eef2", borderRadius: "2px" }}
        >
          <div
            style={{
              height: "4px",
              width: `${pct}%`,
              background: "#00a6cc",
              borderRadius: "2px",
            }}
          />
        </div>
      </div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {human(entry.bytes)}
      </div>
      <button type="button" t="reveal" onClick={() => disk.reveal(entry.path)}>
        Open
      </button>
    </div>
  );
}

/** Breadcrumb + the button that changes meaning while work is running. */
function Trail() {
  return (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
      <button type="button" t="up" onClick={() => disk.up()}>↑ Up</button>
      <code style={{ flex: 1 }}>{disk.path || "…"}</code>
      {disk.scanning
        ? (
          <button type="button" t="cancel" onClick={() => disk.stop()}>
            Cancel
          </button>
        )
        : (
          <button type="button" t="rescan" onClick={() => disk.open(disk.path)}>
            Rescan
          </button>
        )}
    </div>
  );
}

/** The list. A real component, not a styled div — that is what makes it
 *  addressable as `ui.Folders` in a test and `am surface --component=Folders`
 *  against the running app. */
function Folders() {
  const largest = disk.largest();
  return (
    <div>
      {disk.entries.map((e: Entry) => (
        <Row key={e.path} entry={e} largest={largest} />
      ))}
    </div>
  );
}

export default function App() {
  return (
    <div
      style={{
        maxWidth: 720,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ color: "#00a6cc" }}>Disk</h1>

      <Trail />

      {disk.error && <p style={{ color: "#c33" }}>{disk.error}</p>}
      {disk.scanning && disk.entries.length === 0 && (
        <p t="status">
          scanning…
        </p>
      )}

      <Folders />
    </div>
  );
}
