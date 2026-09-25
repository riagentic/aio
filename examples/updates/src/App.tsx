// The update UI is yours — aio ships no component. `updates` is a cell, so
// this is an ordinary reactive read; copy this file and restyle it.
import { updates } from "aio/updates";
import { feedback } from "aio/feedback";
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
            {
              /* `reason` says WHY, which matters when the version is the one
                already running: a re-published build of 1.2.3 is a real update
                with different bytes, and "1.2.3 is available" alone reads as a
                bug. */
            }
            {` (${updates.available.reason}.)`}
            {/* Say it before they click, not after. */}
            {updates.available.migrates
              ? " Your data will be migrated (a backup is taken first)."
              : ""} The app will restart.
            {
              /* Whether this release is authenticated, and by which key. An app
                running with allowUnsigned should say so where it is acted on. */
            }
            <small style={{ display: "block", color: "#495057" }}>
              {updates.available.signed
                ? `signed · key ${updates.available.keyFingerprint}`
                : "UNSIGNED — its contents are not authenticated"}
            </small>
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
          <span style={{ flex: "1" }}>
            <strong>Version {updates.blocked.version}</strong>{" "}
            exists but cannot be installed: {updates.blocked.blockers.join(" ")}
          </span>
          {
            /* A notice with no way to put it away is a notice people learn to
              ignore — `dismiss()` accepts a blocked release too. */
          }
          <button type="button" onClick={() => updates.dismiss()}>
            Hide
          </button>
        </div>
      )}

      {
        /* These render because the cell publishes mid-method (`s.$commit()`).
          Under a plain transactional method the whole write-set commits once at
          return, so this panel could never appear — the status went straight
          from "available" to gone. */
      }
      {updates.status === "checking" && (
        <div style={{ ...bar, background: "#f1f3f5" }}>Checking…</div>
      )}
      {updates.status === "downloading" && (
        <div style={{ ...bar, background: "#f1f3f5" }}>
          Downloading… {Math.round(updates.progress * 100)}%
        </div>
      )}
      {updates.status === "applying" && (
        <div style={{ ...bar, background: "#f1f3f5" }}>Installing…</div>
      )}
      {updates.status === "staged" && (
        <div style={{ ...bar, background: "#f1f3f5" }}>
          Installed — restarting…
        </div>
      )}

      {/* "Not now" is not "never". */}
      {updates.dismissed && !updates.available && (
        <div style={{ ...bar, background: "#f8f9fa" }}>
          <span style={{ flex: "1" }}>
            You said no to {updates.dismissed}.
          </span>
          {
            /* `undismiss()` forgets the "no"; the NEXT check offers it again.
              Check right away — otherwise this panel vanishes and nothing
              replaces it until the next poll (6h on prod), which reads as
              the button having thrown the update away. */
          }
          <button
            type="button"
            onClick={async () => {
              await updates.undismiss();
              await updates.check();
            }}
          >
            Show it again
          </button>
        </div>
      )}

      {updates.error && (
        <div
          style={{ ...bar, background: "#fff5f5", border: "1px solid #ff8787" }}
        >
          {
            /* Not "check failed": `error` is set by whichever step failed —
              a check, an install, a refused blocked release, a channel
              change — and the message itself says which. */
          }
          Updates: {updates.error}
        </div>
      )}

      <h1>Notes</h1>
      <ul>
        {notes.items.map((t, i) => <li key={i}>{t}</li>)}
      </ul>
      <button type="button" onClick={() => notes.add(`note ${Date.now()}`)}>
        Add a note
      </button>

      {
        /* The other half of reaching users: `feedback: true` in app.ts, and a
          button. The report — build, state (redacted), recent actions, logs —
          is captured server-side; the cell says where it went, or why not. */
      }
      <p>
        <button
          type="button"
          onClick={() => feedback.report("Problem reported from the app")}
        >
          Report a problem
        </button>
        {
          /* `report()` never throws: a refusal (not configured, rate-capped,
            a failed write) lands in `error`, so it is read, not caught. */
        }
        {feedback.status === "error"
          ? ` Not saved: ${feedback.error}`
          : feedback.last
          ? ` Thanks — saved to ${feedback.last.path}.`
          : ""}
      </p>

      <p style={{ color: "#6b7280", fontSize: "0.9rem", marginTop: "2rem" }}>
        {
          /* `current` is null when this build cannot say what version it is;
            `currentUnknown` says why. They used to be ONE string field, so
            this line printed the whole 200-character explanation where a
            version goes. */
        }
        Running {updates.current ?? "an unknown version"} on the{" "}
        <strong>{updates.channel || "?"}</strong> channel
        {updates.lastChecked ? ` · checked ${updates.lastChecked}` : ""}
        {updates.currentUnknown
          ? (
            <span title={updates.currentUnknown}>
              {" · why: "}
              {updates.currentUnknown}
            </span>
          )
          : ""}
        {" · "}
        {/* A manual check button is the whole feature. */}
        <button type="button" onClick={() => updates.check()}>Check now</button>
      </p>
    </div>
  );
}
