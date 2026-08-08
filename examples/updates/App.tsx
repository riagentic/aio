// The update UI is yours — aio ships no component. `updates` is a cell, so
// this is an ordinary reactive read; copy this file and restyle it.
import { updates } from "aio/updates";
import { notes } from "./cell.ts";

const bar: Record<string, string> = {
  display: "flex",
  gap: "0.75rem",
  alignItems: "center",
  padding: "0.75rem 1rem",
  borderRadius: "8px",
  marginBottom: "1rem",
};

export default function App() {
  return (
    <div
      style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: "40rem" }}
    >
      {/* A release you can take. */}
      {updates.available && (
        <div
          style={{ ...bar, background: "#e7f5ff", border: "1px solid #74c0fc" }}
        >
          <span style={{ flex: "1" }}>
            <strong>Version {updates.available.version}</strong> is available
            {updates.available.notes ? ` — ${updates.available.notes}` : ""}.
            {/* Say it before they click, not after. */}
            {updates.available.migrates
              ? " Your data will be migrated (a backup is taken first)."
              : ""} The app will restart.
          </span>
          <button type="button" onClick={() => updates.apply()}>Update</button>
          <button type="button" onClick={() => updates.dismiss()}>
            Not now
          </button>
        </div>
      )}

      {
        /* A newer release that CANNOT be installed over this data. Shown, with
          the reason — hiding it would read as "you are up to date". There is
          no Update button here on purpose: apply() refuses it. */
      }
      {updates.blocked && (
        <div
          style={{ ...bar, background: "#fff4e6", border: "1px solid #ffa94d" }}
        >
          <span>
            <strong>Version {updates.blocked.version}</strong>{" "}
            exists but cannot be installed: {updates.blocked.blockers.join(" ")}
          </span>
        </div>
      )}

      {updates.status === "downloading" && (
        <div style={{ ...bar, background: "#f1f3f5" }}>
          Downloading… {Math.round(updates.progress * 100)}%
        </div>
      )}

      {updates.error && (
        <div
          style={{ ...bar, background: "#fff5f5", border: "1px solid #ff8787" }}
        >
          Update check failed: {updates.error}
        </div>
      )}

      <h1>Notes</h1>
      <ul>
        {notes.items.map((t) => <li>{t}</li>)}
      </ul>
      <button type="button" onClick={() => notes.add(`note ${Date.now()}`)}>
        Add a note
      </button>

      <p style={{ color: "#868e96", fontSize: "0.9rem", marginTop: "2rem" }}>
        Running {updates.current || "?"} on the{" "}
        <strong>{updates.channel || "?"}</strong> channel
        {updates.lastChecked ? ` · checked ${updates.lastChecked}` : ""}
        {" · "}
        {/* A manual check button is the whole feature. */}
        <button type="button" onClick={() => updates.check()}>Check now</button>
      </p>
    </div>
  );
}
